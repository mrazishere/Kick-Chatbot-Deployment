require('dotenv').config();
const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const TelegramNotifier = require('./telegram-notifier');

class KickAuth {
  constructor() {
    this.clientId = process.env.CLIENT_ID;
    this.clientSecret = process.env.CLIENT_SECRET;
    this.oauthDomain = process.env.OAUTH_DOMAIN || 'localhost';
    this.oauthPort = process.env.OAUTH_PORT || '3004';

    // Construct redirect URI: use https for domain, http for localhost
    // Don't include port in URL (handled by reverse proxy/nginx)
    const protocol = this.oauthDomain.includes('localhost') ? 'http' : 'https';
    const portPart = this.oauthDomain.includes('localhost') ? `:${this.oauthPort}` : '';
    this.redirectUri = `${protocol}://${this.oauthDomain}${portPart}/callback`;

    this.tokenFile = path.join(__dirname, '.tokens.json');
    this.accessToken = null;
    this.refreshToken = null;
    this.expiresAt = null;
    this.codeVerifier = null;
    this.codeChallenge = null;
    this.authServer = 'https://id.kick.com';
  }

  // Generate PKCE code verifier and challenge
  generatePKCE() {
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
  generateState() {
    return crypto.randomBytes(16).toString('hex');
  }

  // Generate authorization URL for OAuth flow with PKCE
  getAuthUrl(scopes = []) {
    const pkce = this.generatePKCE();
    const state = this.generateState();

    const authParams = {
      client_id: this.clientId,
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
  async exchangeCodeForToken(code) {
    try {
      const response = await axios.post(`${this.authServer}/oauth/token`,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: this.redirectUri,
          code: code,
          code_verifier: this.codeVerifier
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
      console.error('[AUTH ERROR] Failed to exchange code for token:', error.response?.data || error.message);
      throw error;
    }
  }

  // Refresh access token using refresh token
  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await axios.post(`${this.authServer}/oauth/token`,
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken
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
      const errData = error.response?.data;
      console.error('[AUTH ERROR] Failed to refresh token:', errData || error.message);

      // Refresh token revoked/expired — cannot auto-recover, alert immediately
      if (errData?.error === 'invalid_grant') {
        const telegram = new TelegramNotifier();
        await telegram.notifyReauthRequired('invalid_grant — refresh token was revoked or expired by Kick').catch(() => {});
      }

      throw error;
    }
  }

  // Proactively monitor and refresh the token on a schedule
  // Alerts via Telegram if refresh fails and manual action is needed
  startTokenMonitor(intervalMs = 30 * 60 * 1000) {
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
            console.error('[AUTH MONITOR] Proactive refresh failed:', refreshError.message);
          }
        } else {
          console.log(`[AUTH MONITOR] Token healthy, expires in ~${hoursLeft}h`);
        }
      } catch (error) {
        console.error('[AUTH MONITOR] Unexpected error during token check:', error.message);
      }
    };

    // Run immediately on start, then on the interval
    // Return a promise that resolves after the first check so callers can await it
    const firstCheck = check();
    const timer = setInterval(check, intervalMs);
    console.log(`[AUTH MONITOR] Token monitor started (interval: ${intervalMs / 60000} min)`);
    return { timer, ready: firstCheck };
  }

  // Get valid access token (refreshes if expired)
  async getAccessToken() {
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
  saveTokens() {
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
  loadTokens() {
    try {
      if (fs.existsSync(this.tokenFile)) {
        const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
        this.accessToken = data.accessToken;
        this.refreshToken = data.refreshToken;
        this.expiresAt = data.expiresAt;
        console.log('[AUTH] Tokens loaded from file');
        return true;
      }
    } catch (error) {
      console.error('[AUTH ERROR] Failed to load tokens:', error.message);
    }
    return false;
  }

  // Check if we have valid authentication
  isAuthenticated() {
    this.loadTokens();
    return this.accessToken && this.refreshToken;
  }

  // Start OAuth flow with local server
  async startOAuthFlow() {
    return new Promise((resolve, reject) => {
      const app = express();
      let server;

      app.get('/callback', async (req, res) => {
        const code = req.query.code;
        const error = req.query.error;
        const state = req.query.state;

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

        try {
          await this.exchangeCodeForToken(code);
          res.send('<h1>Authentication Successful!</h1><p>You can close this window and return to your terminal.</p>');
          console.log('[AUTH] ✓ Authentication successful!');
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
        const authUrl = this.getAuthUrl();
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

module.exports = KickAuth;
