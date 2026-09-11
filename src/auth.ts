import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import TelegramNotifier = require('./telegram-notifier');
import { withFileLock, writeJsonAtomic } from './file-lock';
import { OAuthTokens } from './types';

/**
 * Held across the refresh request, so stale must outlast its timeout by a wide
 * margin, and waiters must outlast stale so a dead holder never strands them.
 */
const TOKEN_LOCK = { staleMs: 60_000, waitMs: 90_000 };
const REFRESH_TIMEOUT_MS = 15_000;

const DEFAULT_TOKEN_FILE = path.join(__dirname, '.tokens.json');

class KickAuth {
  /**
   * Refreshes under way in this process, by token file. Several KickAuth
   * instances share a file (the enrollment service creates one per request),
   * and they should share one refresh rather than queue on the lock.
   */
  private static refreshes = new Map<string, Promise<string | null>>();

  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private oauthDomain: string;
  private oauthPort: string;
  private redirectUri: string;
  private tokenFile: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number | null = null;
  private grantedAt: number | null = null;
  /** Identity of the file version last loaded, so an unchanged file isn't parsed again. */
  private loadedStamp: string | null = null;
  private codeVerifier: string | null = null;
  private codeChallenge: string | null = null;
  private authServer: string;

  constructor(tokenFilePath?: string) {
    this.clientId = process.env.CLIENT_ID;
    this.clientSecret = process.env.CLIENT_SECRET;
    this.oauthDomain = process.env.OAUTH_DOMAIN || 'localhost';
    this.oauthPort = process.env.OAUTH_PORT || '3004';

    // Construct redirect URI: use https for domain, http for localhost
    // Path must match what's registered in the Kick developer app
    const protocol = this.oauthDomain.includes('localhost') ? 'http' : 'https';
    const portPart = this.oauthDomain.includes('localhost') ? `:${this.oauthPort}` : '';
    this.redirectUri = `${protocol}://${this.oauthDomain}${portPart}/kick-bot-enroll/callback`;

    this.tokenFile = tokenFilePath ?? DEFAULT_TOKEN_FILE;
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = null;
    this.codeVerifier = null;
    this.codeChallenge = null;
    this.authServer = 'https://id.kick.com';
  }

  /**
   * Store a grant in the shared token file under the refresh lock.
   *
   * For anything that writes tokens from outside this class, such as the bot
   * re-auth callback. Writing without the lock let a refresh already in flight
   * finish afterwards and put the old grant's tokens back over the new one.
   */
  static async storeTokens(tokens: OAuthTokens, tokenFile: string = DEFAULT_TOKEN_FILE): Promise<void> {
    await withFileLock(`${tokenFile}.lock`, async () => {
      writeJsonAtomic(tokenFile, tokens);
    }, TOKEN_LOCK);
    console.log('[AUTH] Tokens saved to file');
  }

  // Generate PKCE code verifier and challenge
  generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    // Code verifier: random string 43-128 characters
    this.codeVerifier = crypto.randomBytes(32).toString('base64url');

    // Code challenge: SHA256 hash of verifier, base64url encoded
    this.codeChallenge = crypto
      .createHash('sha256')
      .update(this.codeVerifier)
      .digest('base64url');

    return { codeVerifier: this.codeVerifier, codeChallenge: this.codeChallenge };
  }

  // Generate state for CSRF protection
  generateState(): string {
    return crypto.randomBytes(16).toString('hex');
  }

  // Generate authorization URL for OAuth flow with PKCE
  getAuthUrl(scopes: string[] = []): string {
    const pkce = this.generatePKCE();
    const state = this.generateState();

    const authParams: Record<string, string> = {
      client_id: this.clientId!,       // non-null: CLIENT_ID must be set for OAuth flow
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state: state,
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256'
    };

    // Only add scope if provided
    if (scopes.length > 0) {
      authParams.scope = scopes.join(' ');
    }

    const params = new URLSearchParams(authParams);

    return `${this.authServer}/oauth/authorize?${params.toString()}`;
  }

  // Exchange authorization code for access token
  async exchangeCodeForToken(code: string): Promise<string | null> {
    try {
      const response = await axios.post(`${this.authServer}/oauth/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId!,          // non-null: required for OAuth token exchange
          client_secret: this.clientSecret!,  // non-null: required for OAuth token exchange
          redirect_uri: this.redirectUri,
          code: code,
          code_verifier: this.codeVerifier!   // non-null: generatePKCE() always called first
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          timeout: REFRESH_TIMEOUT_MS
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.expiresAt = Date.now() + (response.data.expires_in * 1000);
      this.grantedAt = Date.now();

      await KickAuth.storeTokens(this.currentTokens(), this.tokenFile);
      return this.accessToken;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('[AUTH ERROR] Failed to exchange code for token:', error.response?.data || error.message);
      }
      throw error;
    }
  }

  /**
   * Refresh the access token, once across every process sharing the file.
   *
   * Kick rotates the refresh token on every use. Processes refreshing together
   * all sent the same one, and every loser's rejection read as a revoked grant —
   * which alerted for a re-auth nobody needed.
   */
  async refreshAccessToken(): Promise<string | null> {
    const pending = KickAuth.refreshes.get(this.tokenFile);
    if (pending) {
      await pending;
      this.loadTokens();
      return this.accessToken;
    }
    const run = this.refreshUnderLock().finally(() => KickAuth.refreshes.delete(this.tokenFile));
    KickAuth.refreshes.set(this.tokenFile, run);
    return run;
  }

  private async refreshUnderLock(): Promise<string | null> {
    // The newest refresh token on disk, never a cached one: another process may have rotated it.
    this.loadTokens();
    const seen = this.refreshToken;
    if (!seen) {
      throw new Error('No refresh token available');
    }

    return withFileLock(`${this.tokenFile}.lock`, async () => {
      // Whoever held the lock before may have refreshed already. Its tokens are
      // current and ours is now spent, so use them instead of refreshing again.
      this.loadTokens();
      if (!this.refreshToken) {
        throw new Error('No refresh token available');
      }
      if (this.refreshToken !== seen) {
        console.log('[AUTH] Token was refreshed by another process — using it');
        return this.accessToken;
      }
      const used = this.refreshToken;

      let response;
      try {
        response = await axios.post(`${this.authServer}/oauth/token`,
          new URLSearchParams({
            grant_type: 'refresh_token',
            client_id: this.clientId!,          // non-null: required for token refresh
            client_secret: this.clientSecret!,  // non-null: required for token refresh
            refresh_token: used
          }).toString(),
          {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            // The lock is held across this call; a stalled connection must not hold it for good.
            timeout: REFRESH_TIMEOUT_MS
          }
        );
      } catch (error) {
        // Rejected because the file changed underneath — a re-auth stored a new
        // grant meanwhile — says nothing about the grant now in use.
        if (this.adoptNewerGrant(used)) return this.accessToken;

        if (axios.isAxiosError(error)) {
          const errData = error.response?.data as { error?: string } | undefined;
          console.error('[AUTH ERROR] Failed to refresh token:', errData || error.message);

          // Refresh token revoked/expired — cannot auto-recover. The notifier sends
          // this once an hour across all processes, however many hit it.
          if (errData?.error === 'invalid_grant') {
            const telegram = new TelegramNotifier();
            await telegram.notifyReauthRequired('invalid_grant — refresh token was revoked or expired by Kick').catch(() => {});
          }
        }
        throw error;
      }

      const data = response.data as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
      if (typeof data.access_token !== 'string' || !data.access_token) {
        throw new Error('Token refresh response had no access token');
      }

      // A grant stored while this request was in flight is the newer authorization; keep it.
      if (this.adoptNewerGrant(used)) return this.accessToken;

      this.accessToken = data.access_token;
      // Only replace the refresh token if the response carried one.
      this.refreshToken = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : used;
      this.expiresAt = Date.now() + ((typeof data.expires_in === 'number' ? data.expires_in : 3600) * 1000);

      this.saveTokens();
      // A refresh that works means any standing re-auth alert is over; the next failure should alert again.
      void new TelegramNotifier().clearAlert('reauth-required').catch(() => {});
      return this.accessToken;
    }, TOKEN_LOCK);
  }

  /**
   * Switch to the tokens on disk if they're no longer the grant `used` came from.
   * Returns whether it did.
   */
  private adoptNewerGrant(used: string): boolean {
    this.loadTokens();
    if (!this.refreshToken || this.refreshToken === used) return false;
    console.log('[AUTH] Token file changed during the refresh — using the newer tokens');
    return true;
  }

  // Proactively monitor and refresh the token on a schedule
  // Alerts via Telegram if refresh fails and manual action is needed
  startTokenMonitor(intervalMs = 30 * 60 * 1000): { timer: NodeJS.Timeout; ready: Promise<void> } {
    const ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // alert/refresh if < 24h left
    // Kick grants have a hard 30-day lifetime that refreshing does NOT extend.
    // Warn daily once the grant is within 2 days of dying so re-auth can
    // happen on the user's schedule instead of at failure time.
    const GRANT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
    const GRANT_WARN_BEFORE_MS = 2 * 24 * 60 * 60 * 1000;
    const telegram = new TelegramNotifier();
    let lastAlertedAt = 0;
    let lastGrantWarnAt = 0;

    const check = async () => {
      try {
        this.loadTokens();

        if (this.grantedAt) {
          const grantMsLeft = this.grantedAt + GRANT_LIFETIME_MS - Date.now();
          if (grantMsLeft < GRANT_WARN_BEFORE_MS && Date.now() - lastGrantWarnAt > 24 * 60 * 60 * 1000) {
            lastGrantWarnAt = Date.now();
            const daysLeft = Math.max(0, grantMsLeft / (24 * 60 * 60 * 1000));
            console.warn(`[AUTH MONITOR] Grant reaches Kick's 30-day lifetime in ~${daysLeft.toFixed(1)} day(s)`);
            await telegram.notifyGrantExpiringSoon(daysLeft).catch(() => {});
          }
        }

        if (!this.refreshToken) {
          console.warn('[AUTH MONITOR] No tokens on file — bot needs authentication');
          if (Date.now() - lastAlertedAt > 60 * 60 * 1000) {
            await telegram.notifyReauthRequired('No tokens found on disk').catch(() => {});
            lastAlertedAt = Date.now();
          }
          return;
        }

        const msLeft = (this.expiresAt || 0) - Date.now();
        const hoursLeft = Math.max(0, Math.floor(msLeft / (1000 * 60 * 60)));

        if (msLeft < ALERT_THRESHOLD_MS) {
          console.log(`[AUTH MONITOR] Token expires in ~${hoursLeft}h, attempting proactive refresh...`);
          try {
            await this.refreshAccessToken();
            console.log('[AUTH MONITOR] Proactive refresh succeeded');
          } catch (refreshError) {
            // Telegram alert already sent inside refreshAccessToken() for invalid_grant
            if (refreshError instanceof Error) {
              console.error('[AUTH MONITOR] Proactive refresh failed:', refreshError.message);
            }
          }
        } else {
          console.log(`[AUTH MONITOR] Token healthy, expires in ~${hoursLeft}h`);
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error('[AUTH MONITOR] Unexpected error during token check:', error.message);
        }
      }
    };

    // Run immediately on start, then on the interval
    // Return a promise that resolves after the first check so callers can await it
    const firstCheck = check();
    const timer: NodeJS.Timeout = setInterval(check, intervalMs);
    console.log(`[AUTH MONITOR] Token monitor started (interval: ${intervalMs / 60000} min)`);
    return { timer, ready: firstCheck };
  }

  // Read current access token from disk without refreshing. Use this from
  // callers that share a token file with another process responsible for
  // refreshing (e.g. EarningsTracker reads the bot token kept fresh by the
  // enrollment service). Avoids racing on refresh-token rotation.
  loadAccessToken(): string | null {
    this.loadTokens();
    return this.accessToken;
  }

  // Get valid access token (refreshes if expired)
  async getAccessToken(): Promise<string | null> {
    // Always re-read from disk: the file is shared with the enrollment
    // service, which rotates it every 30 minutes. Caching tokens in memory
    // left long-lived bot processes holding a revoked grant after re-auth.
    this.loadTokens();

    // Check if token is expired or about to expire (within 5 minutes)
    if (this.expiresAt && this.expiresAt < Date.now() + 300000) {
      console.log('[AUTH] Token expired or expiring soon, refreshing...');
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  private currentTokens(): OAuthTokens {
    return {
      accessToken: this.accessToken as string,
      refreshToken: this.refreshToken as string,
      expiresAt: this.expiresAt as number,
      grantedAt: this.grantedAt ?? undefined
    };
  }

  // Save tokens to file. Callers that can race a refresh hold the token lock.
  saveTokens(): void {
    writeJsonAtomic(this.tokenFile, this.currentTokens());
    console.log('[AUTH] Tokens saved to file');
  }

  /**
   * Load tokens from file, re-parsing only when the file has changed.
   *
   * Every write replaces the file through a rename, so a new inode, size or
   * mtime marks a new version — a re-auth or another process's refresh is
   * picked up on the next call, without restarting this process.
   */
  loadTokens(): boolean {
    try {
      const st = fs.statSync(this.tokenFile);
      const stamp = `${st.ino}:${st.size}:${st.mtimeMs}`;
      if (stamp === this.loadedStamp) return true;
      const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as OAuthTokens;
      this.accessToken = data.accessToken;
      this.refreshToken = data.refreshToken;
      this.expiresAt = data.expiresAt;
      this.grantedAt = data.grantedAt ?? null;
      this.loadedStamp = stamp;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      if (error instanceof Error) {
        console.error('[AUTH ERROR] Failed to load tokens:', error.message);
      }
    }
    return false;
  }

  // Check if we have valid authentication
  isAuthenticated(): boolean {
    this.loadTokens();
    return !!(this.accessToken && this.refreshToken);
  }

  // Start OAuth flow with local server
  async startOAuthFlow(scopes: string[] = ['chat:write', 'user:read', 'channel:read']): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const app = express();
      let server!: http.Server;  // definite assignment assertion: assigned synchronously by app.listen before any callback fires

      app.get('/kick-bot-enroll/callback', async (req, res) => {
        const code = req.query.code as string | undefined;
        const error = req.query.error as string | undefined;
        const state = req.query.state as string | undefined;

        if (error) {
          res.send('<h1>Authentication Failed</h1><p>Error: ' + error + '</p><p>You can close this window.</p>');
          server.close();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code) {
          res.send('<h1>No authorization code received</h1><p>You can close this window.</p>');
          server.close();
          reject(new Error('No authorization code received'));
          return;
        }

        // code is now confirmed non-empty string
        try {
          await this.exchangeCodeForToken(code as string);
          res.send('<h1>Authentication Successful!</h1><p>You can close this window and return to your terminal.</p>');
          console.log('[AUTH] Authentication successful!');
          server.close();
          resolve(this.accessToken);
        } catch (error) {
          res.send('<h1>Authentication Failed</h1><p>Error exchanging code. Check console for details.</p>');
          server.close();
          reject(error);
        }
      });

      const port = this.oauthPort;
      server = app.listen(port, () => {
        const authUrl = this.getAuthUrl(scopes);
        console.log('\n[AUTH] Please authenticate your bot:');
        console.log('[AUTH] Open this URL in your browser:\n');
        console.log(`    ${authUrl}\n`);
        console.log(`[AUTH] Waiting for callback on ${this.redirectUri}...\n`);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('OAuth flow timed out'));
      }, 300000);
    });
  }
}

export = KickAuth;
