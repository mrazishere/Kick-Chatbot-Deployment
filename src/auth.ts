import 'dotenv/config';
import axios from 'axios';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as http from 'http';
import TelegramNotifier = require('./telegram-notifier');
import { OAuthTokens } from './types';

class KickAuth {
  // Process-wide rate-limit for the reauth Telegram alert. Multiple KickAuth
  // instances (e.g. enrollment monitor + channel bots) all hitting invalid_grant
  // used to fan out into one Telegram message per failed refresh.
  private static lastReauthAlertAt = 0;
  private static readonly REAUTH_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

  private clientId: string | undefined;
  private clientSecret: string | undefined;
  private oauthDomain: string;
  private oauthPort: string;
  private redirectUri: string;
  private tokenFile: string;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number | null = null;
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

    this.tokenFile = tokenFilePath ?? path.join(__dirname, '.tokens.json');
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = null;
    this.codeVerifier = null;
    this.codeChallenge = null;
    this.authServer = 'https://id.kick.com';
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
          }
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.expiresAt = Date.now() + (response.data.expires_in * 1000);

      this.saveTokens();
      return this.accessToken;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('[AUTH ERROR] Failed to exchange code for token:', error.response?.data || error.message);
      }
      throw error;
    }
  }

  // Refresh access token using refresh token
  async refreshAccessToken(): Promise<string | null> {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post(`${this.authServer}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId!,          // non-null: required for token refresh
          client_secret: this.clientSecret!,  // non-null: required for token refresh
          refresh_token: this.refreshToken!   // non-null: checked above the try block
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );

      this.accessToken = response.data.access_token;
      this.refreshToken = response.data.refresh_token;
      this.expiresAt = Date.now() + (response.data.expires_in * 1000);

      this.saveTokens();
      return this.accessToken;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errData = error.response?.data as { error?: string } | undefined;
        console.error('[AUTH ERROR] Failed to refresh token:', errData || error.message);

        // Refresh token revoked/expired — cannot auto-recover. Rate-limit the
        // Telegram alert to once per hour per process so a fast-polling caller
        // (e.g. EarningsTracker every 5 min) can't fan out into a flood.
        if (errData?.error === 'invalid_grant') {
          const now = Date.now();
          if (now - KickAuth.lastReauthAlertAt > KickAuth.REAUTH_ALERT_COOLDOWN_MS) {
            KickAuth.lastReauthAlertAt = now;
            const telegram = new TelegramNotifier();
            await telegram.notifyReauthRequired('invalid_grant — refresh token was revoked or expired by Kick').catch(() => {});
          }
        }
      }
      throw error;
    }
  }

  // Proactively monitor and refresh the token on a schedule
  // Alerts via Telegram if refresh fails and manual action is needed
  startTokenMonitor(intervalMs = 30 * 60 * 1000): { timer: NodeJS.Timeout; ready: Promise<void> } {
    const ALERT_THRESHOLD_MS = 24 * 60 * 60 * 1000; // alert/refresh if < 24h left
    const telegram = new TelegramNotifier();
    let lastAlertedAt = 0;

    const check = async () => {
      try {
        this.loadTokens();

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
    // Load tokens from file if not in memory
    if (!this.accessToken) {
      this.loadTokens();
    }

    // Check if token is expired or about to expire (within 5 minutes)
    if (this.expiresAt && this.expiresAt < Date.now() + 300000) {
      console.log('[AUTH] Token expired or expiring soon, refreshing...');
      await this.refreshAccessToken();
    }

    return this.accessToken;
  }

  // Save tokens to file
  saveTokens(): void {
    const data = {
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
      expiresAt: this.expiresAt
    };
    const tmpFile = this.tokenFile + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, this.tokenFile);
    console.log('[AUTH] Tokens saved to file');
  }

  // Load tokens from file
  loadTokens(): boolean {
    try {
      if (fs.existsSync(this.tokenFile)) {
        const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')) as OAuthTokens;
        this.accessToken = data.accessToken;
        this.refreshToken = data.refreshToken;
        this.expiresAt = data.expiresAt;
        return true;
      }
    } catch (error) {
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
