import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { exec } from 'child_process';
import WebSocket from 'ws';
import * as cookieLib from 'cookie';
import KickAuth = require('./auth');
import KickSessionAuth = require('./kick-session-auth');
import TelegramNotifier = require('./telegram-notifier');

// ---------------------------------------------------------------------------
// Local interfaces
// ---------------------------------------------------------------------------

interface OAuthSession {
  type: 'channel' | 'bot_reauth';
  codeVerifier: string;
  createdAt: number;
}

interface PendingEnrollment {
  username: string;
  userId: number | string;
  broadcasterUserId: number | null;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

const app = express();
const PORT = process.env.CHATROOM_FINDER_PORT || 3006;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/kick-bot-enroll', rateLimiter);

// Store pending OAuth sessions
const pendingSessions = new Map<string, OAuthSession>();

// Store partially-completed enrollments waiting for chatroom ID from browser
const pendingEnrollments = new Map<string, PendingEnrollment>();

// In-process IP rate limiter — no external dependency
// Limit: 10 requests per IP per minute across all /kick-bot-enroll/* routes
const rateLimitStore = new Map<string, number[]>(); // ip → [timestamps]
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 10;

function rateLimiter(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  // Get or initialise request history for this IP
  let timestamps = rateLimitStore.get(ip) || [];
  // Drop timestamps outside the current window
  timestamps = timestamps.filter(t => t > windowStart);

  if (timestamps.length >= RATE_LIMIT_MAX) {
    res.setHeader('Retry-After', '60');
    res.status(429).send('Too Many Requests');
    return;
  }

  timestamps.push(now);
  rateLimitStore.set(ip, timestamps);

  // Periodic cleanup: remove IPs with no recent requests
  if (rateLimitStore.size > 1000) {
    for (const [key, ts] of rateLimitStore) {
      if (!ts.some(t => t > windowStart)) rateLimitStore.delete(key);
    }
  }

  next();
}

// ---------------------------------------------------------------------------
// OAuth Configuration
// ---------------------------------------------------------------------------

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const oauthDomain = process.env.OAUTH_DOMAIN || 'localhost';
const protocol = oauthDomain.includes('localhost') ? 'http' : 'https';
const redirectUri = `${protocol}://${oauthDomain}/kick-bot-enroll/callback`;
const authServer = 'https://id.kick.com';
const KICK_BASE_PATH = path.resolve(__dirname, '..');

// Validate channel name: only lowercase alphanumeric and underscores, 1-30 chars
function validateChannelName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return /^[a-z0-9_]{1,30}$/.test(name);
}

// Manage ecosystem.config.js
function addToEcosystem(username: string): boolean {
  const ecosystemPath = path.join(KICK_BASE_PATH, 'channels', 'ecosystem.config.js');

  try {
    let ecosystem: { apps: Array<Record<string, unknown>> } = { apps: [] };

    // Load existing ecosystem if it exists
    if (fs.existsSync(ecosystemPath)) {
      delete require.cache[require.resolve(ecosystemPath)];
      ecosystem = require(ecosystemPath) as { apps: Array<Record<string, unknown>> };
    }

    const pm2Name = `kick-${username}`;

    // Check if already exists
    const existingIndex = ecosystem.apps.findIndex((appEntry: Record<string, unknown>) => appEntry.name === pm2Name);

    const appConfig = {
      "name": pm2Name,
      "script": `${KICK_BASE_PATH}/dist/channels/${username}.js`,
      "cwd": KICK_BASE_PATH,
      "node_args": "--expose-gc",
      "log_date_format": "YYYY-MM-DD HH:mm:ss",
      "max_memory_restart": "150M",
      "out_file": `${KICK_BASE_PATH}/logs/${pm2Name}-out.log`,
      "error_file": `${KICK_BASE_PATH}/logs/${pm2Name}-err.log`,
      "watch": [
        `${KICK_BASE_PATH}/data/channel-configs/${username}.json`
      ],
      "watch_delay": 2000,
      "ignore_watch": [
        "node_modules",
        "logs",
        "*.log"
      ],
      "watch_options": {
        "followSymlinks": false
      }
    };

    if (existingIndex >= 0) {
      // Update existing entry
      ecosystem.apps[existingIndex] = appConfig;
      console.log(`[ECOSYSTEM] Updated ${pm2Name} in ecosystem.config.js`);
    } else {
      // Add new entry
      ecosystem.apps.push(appConfig);
      console.log(`[ECOSYSTEM] Added ${pm2Name} to ecosystem.config.js`);
    }

    // Write back to file
    const content = `module.exports = ${JSON.stringify(ecosystem, null, 2)}\n`;
    fs.writeFileSync(ecosystemPath, content);

    // Verify the written file is syntactically valid before callers execute pm2
    try {
      delete require.cache[require.resolve(ecosystemPath)];
      const verified = require(ecosystemPath) as { apps?: unknown };
      if (!verified || !Array.isArray(verified.apps)) {
        throw new Error('Ecosystem config missing apps array after write');
      }
    } catch (verifyErr) {
      if (verifyErr instanceof Error) {
        console.error(`[ECOSYSTEM ERROR] Written config failed validation: ${verifyErr.message}`);
      }
      return false;
    }

    return true;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[ECOSYSTEM ERROR] Failed to update ecosystem.config.js: ${error.message}`);
    }
    return false;
  }
}

// Remove from ecosystem.config.js
function removeFromEcosystem(username: string): boolean {
  const ecosystemPath = path.join(KICK_BASE_PATH, 'channels', 'ecosystem.config.js');

  try {
    if (!fs.existsSync(ecosystemPath)) return false;

    delete require.cache[require.resolve(ecosystemPath)];
    const ecosystem = require(ecosystemPath) as { apps: Array<Record<string, unknown>> };

    const pm2Name = `kick-${username}`;
    const index = ecosystem.apps.findIndex((appEntry: Record<string, unknown>) => appEntry.name === pm2Name);

    if (index >= 0) {
      ecosystem.apps.splice(index, 1);
      const content = `module.exports = ${JSON.stringify(ecosystem, null, 2)}\n`;
      fs.writeFileSync(ecosystemPath, content);
      console.log(`[ECOSYSTEM] Removed ${pm2Name} from ecosystem.config.js`);
      return true;
    }

    return false;
  } catch (error) {
    if (error instanceof Error) {
      console.error(`[ECOSYSTEM ERROR] Failed to remove from ecosystem.config.js: ${error.message}`);
    }
    return false;
  }
}

// Generate PKCE
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

// ---------------------------------------------------------------------------
// HTML helper functions
// ---------------------------------------------------------------------------

function successPage(username: string, chatroomId: number | string | null, broadcasterUserId: number | string | null, deployStatus = 'success', deployMessage = ''): string {
  const statusMessage = deployStatus === 'success'
    ? 'Bot has been deployed to your channel!'
    : deployMessage || 'There was an issue with deployment.';

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Enrollment Successful!</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: #1e1e1e;
            border-radius: 12px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid #2a2a2a;
            text-align: center;
        }
        .success-icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #53fc18 0%, #3dd612 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
        }
        .success-icon svg {
            width: 40px;
            height: 40px;
            color: #000;
        }
        h1 { color: #53fc18; font-size: 28px; margin-bottom: 10px; }
        .subtitle { color: #999; margin-bottom: 30px; font-size: 14px; }
        .info-box {
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 25px;
            text-align: left;
        }
        .info-row {
            display: flex;
            justify-content: space-between;
            padding: 10px 0;
            border-bottom: 1px solid #3a3a3a;
        }
        .info-row:last-child { border-bottom: none; }
        .info-label { color: #999; }
        .info-value { color: #53fc18; font-family: monospace; }
        .status-box {
            background: rgba(83, 252, 24, 0.1);
            border: 1px solid #53fc18;
            border-radius: 8px;
            padding: 20px;
            text-align: center;
        }
        .status-box.warning {
            background: rgba(255, 193, 7, 0.1);
            border-color: #ffc107;
        }
        .status-box h3 { color: #53fc18; margin-bottom: 10px; }
        .status-box.warning h3 { color: #ffc107; }
        .status-box p { color: #ccc; font-size: 14px; line-height: 1.6; }
        .channel-link {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 24px;
            background: #53fc18;
            color: #000;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
        }
        .channel-link:hover { background: #4ae016; }
        .commands-info {
            margin-top: 20px;
            padding: 15px;
            background: #2a2a2a;
            border-radius: 8px;
            text-align: left;
        }
        .commands-info h4 { color: #53fc18; margin-bottom: 10px; font-size: 14px; }
        .commands-info code {
            display: block;
            padding: 4px 0;
            color: #ccc;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="success-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
            </svg>
        </div>
        <h1>Enrollment Successful!</h1>
        <p class="subtitle">Your channel is now connected to Mr-AI-is-Here bot</p>

        <div class="info-box">
            <div class="info-row">
                <span class="info-label">Channel</span>
                <span class="info-value">${username}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Chatroom ID</span>
                <span class="info-value">${chatroomId}</span>
            </div>
            <div class="info-row">
                <span class="info-label">Status</span>
                <span class="info-value">${deployStatus === 'success' ? 'Active' : 'Pending'}</span>
            </div>
        </div>

        <div class="status-box ${deployStatus === 'warning' ? 'warning' : ''}">
            <h3>${deployStatus === 'success' ? 'Bot Deployed!' : 'Attention'}</h3>
            <p>${statusMessage}</p>
            <a href="https://kick.com/${username}" target="_blank" class="channel-link">Go to Your Channel</a>
        </div>

        <div class="commands-info">
            <h4>Available Commands:</h4>
            <code>!ping - Check if bot is online</code>
            <code>!help - Show all commands</code>
            <code>!uptime - Show bot uptime</code>
        </div>
    </div>
</body>
</html>`;
}

function errorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: #1e1e1e;
            border-radius: 12px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid #2a2a2a;
            text-align: center;
        }
        .error-icon {
            width: 80px;
            height: 80px;
            background: linear-gradient(135deg, #ff4d4d 0%, #cc0000 100%);
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            margin: 0 auto 20px;
        }
        .error-icon svg { width: 40px; height: 40px; color: #fff; }
        h1 { color: #ff4d4d; font-size: 28px; margin-bottom: 10px; }
        .message { color: #999; margin-bottom: 30px; }
        .retry-btn {
            display: inline-block;
            padding: 12px 24px;
            background: #53fc18;
            color: #000;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
        }
        .retry-btn:hover { background: #4ae016; }
    </style>
</head>
<body>
    <div class="container">
        <div class="error-icon">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/>
            </svg>
        </div>
        <h1>${title}</h1>
        <p class="message">${message}</p>
        <a href="/kick-bot-enroll" class="retry-btn">Try Again</a>
    </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes — enrollment flow
// ---------------------------------------------------------------------------

// Serve the main enrollment page
app.get('/kick-bot-enroll', (_req: express.Request, res: express.Response) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Mr-AI Bot Enrollment</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
            color: #e0e0e0;
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }

        .container {
            background: #1e1e1e;
            border-radius: 12px;
            padding: 40px;
            max-width: 500px;
            width: 100%;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
            border: 1px solid #2a2a2a;
        }

        h1 {
            color: #53fc18;
            font-size: 28px;
            margin-bottom: 10px;
            text-align: center;
        }

        .subtitle {
            color: #999;
            text-align: center;
            margin-bottom: 30px;
            font-size: 14px;
        }

        .info-box {
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            margin-bottom: 25px;
        }

        .info-box h3 {
            color: #53fc18;
            margin-bottom: 10px;
            font-size: 16px;
        }

        .info-box ul {
            list-style: none;
            padding: 0;
        }

        .info-box li {
            padding: 8px 0;
            border-bottom: 1px solid #3a3a3a;
            font-size: 14px;
            color: #ccc;
        }

        .info-box li:last-child {
            border-bottom: none;
        }

        .info-box li span {
            color: #53fc18;
            font-weight: bold;
        }

        .enroll-btn {
            width: 100%;
            padding: 16px 24px;
            background: linear-gradient(135deg, #53fc18 0%, #3dd612 100%);
            color: #000;
            border: none;
            border-radius: 8px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
            text-decoration: none;
        }

        .enroll-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 20px rgba(83, 252, 24, 0.3);
        }

        .enroll-btn svg {
            width: 24px;
            height: 24px;
        }

        .footer {
            margin-top: 25px;
            text-align: center;
            color: #666;
            font-size: 12px;
        }

        .footer a {
            color: #53fc18;
            text-decoration: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Mr-AI Bot Enrollment</h1>
        <p class="subtitle">Connect your Kick channel to Mr-AI-is-Here bot</p>

        <div class="info-box">
            <h3>What happens when you enroll:</h3>
            <ul>
                <li><span>1.</span> You authorize the bot to chat in your channel</li>
                <li><span>2.</span> Your channel IDs are automatically detected</li>
                <li><span>3.</span> Bot is deployed and ready to use</li>
                <li><span>4.</span> Messages appear from "Mr-AI-is-Here" bot</li>
            </ul>
        </div>

        <a href="/kick-bot-enroll/start" class="enroll-btn">
            <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
            </svg>
            Connect with Kick
        </a>

        <div class="footer">
            <p>By enrolling, you agree to let the bot send messages in your chat.</p>
            <p style="margin-top: 8px;">Need help? <a href="https://kick.com/mraiishere">Visit mraiishere</a></p>
        </div>
    </div>
</body>
</html>`;

  res.send(html);
});

// Start OAuth flow (channel enrollment)
app.get('/kick-bot-enroll/start', (_req: express.Request, res: express.Response) => {
  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  pendingSessions.set(state, {
    type: 'channel',
    codeVerifier: pkce.codeVerifier,
    createdAt: Date.now()
  });

  // Clean up old sessions (older than 10 minutes)
  for (const [key, session] of pendingSessions) {
    if (Date.now() - session.createdAt > 600000) {
      pendingSessions.delete(key);
    }
  }

  const authParams = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    scope: 'chat:write user:read'
  });

  const authUrl = `${authServer}/oauth/authorize?${authParams.toString()}`;
  res.redirect(authUrl);
});

// ==================== BOT RE-AUTH FLOW ====================

// Bot re-auth page (admin only — Kick OAuth itself gates access to the bot account)
app.get('/kick-bot-reauth', (_req: express.Request, res: express.Response) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Re-Authentication</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
            color: #e0e0e0; min-height: 100vh;
            display: flex; justify-content: center; align-items: center; padding: 20px;
        }
        .container {
            background: #1e1e1e; border-radius: 12px; padding: 40px;
            max-width: 480px; width: 100%;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid #2a2a2a; text-align: center;
        }
        h1 { color: #53fc18; margin-bottom: 10px; }
        p { color: #999; margin-bottom: 24px; font-size: 14px; line-height: 1.6; }
        .warn { background: rgba(255,193,7,0.1); border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin-bottom: 24px; color: #ffc107; font-size: 13px; }
        a.btn {
            display: inline-block; padding: 14px 28px;
            background: linear-gradient(135deg, #53fc18, #3dd612);
            color: #000; border-radius: 8px; font-size: 16px; font-weight: 600;
            text-decoration: none;
        }
        a.btn:hover { opacity: 0.9; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Bot Re-Authentication</h1>
        <p>The bot's OAuth token needs to be renewed. Click below and log in as the <strong>bot account</strong> (not your personal account).</p>
        <div class="warn">&#9888;&#65039; Make sure you are logged into Kick as <strong>${process.env.KICK_USERNAME || 'the bot account'}</strong> before proceeding.</div>
        <a href="/kick-bot-reauth/start" class="btn">Authorize Bot with Kick</a>
    </div>
</body>
</html>`);
});

// Start bot re-auth OAuth flow — reuses the same callback URI already registered in the Kick app
app.get('/kick-bot-reauth/start', (_req: express.Request, res: express.Response) => {
  const pkce = generatePKCE();
  const state = crypto.randomBytes(16).toString('hex');

  pendingSessions.set(state, {
    type: 'bot_reauth',
    codeVerifier: pkce.codeVerifier,
    createdAt: Date.now()
  });

  // Clean up old sessions
  for (const [key, session] of pendingSessions) {
    if (Date.now() - session.createdAt > 600000) {
      pendingSessions.delete(key);
    }
  }

  const authParams = new URLSearchParams({
    client_id: clientId!,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
    scope: 'chat:write user:read channel:read'  // channel:read needed for /channels API lookups
  });

  res.redirect(`${authServer}/oauth/authorize?${authParams.toString()}`);
});

// OAuth callback
app.get('/kick-bot-enroll/callback', async (req: express.Request, res: express.Response) => {
  const code      = typeof req.query.code  === 'string' ? req.query.code  : undefined;
  const state     = typeof req.query.state === 'string' ? req.query.state : undefined;
  const error     = typeof req.query.error === 'string' ? req.query.error : undefined;

  if (error) {
    return res.send(errorPage('Authentication Failed', error));
  }

  if (!code || !state) {
    return res.send(errorPage('Invalid Request', 'Missing authorization code or state'));
  }

  const session = pendingSessions.get(state);
  if (!session) {
    return res.send(errorPage('Session Expired', 'Please try again'));
  }

  pendingSessions.delete(state);

  const isBotReauth = session.type === 'bot_reauth';

  try {
    // Exchange code for token
    const tokenResponse = await axios.post(`${authServer}/oauth/token`,
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId!,
        client_secret: clientSecret!,
        redirect_uri: redirectUri,
        code: code,
        code_verifier: session.codeVerifier
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };

    // ── Bot re-auth: save tokens to .tokens.json and restart the service ──
    if (isBotReauth) {
      const tokenData = {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000)
      };
      const tmpFile = path.join(__dirname, '.tokens.json.tmp');
      fs.writeFileSync(tmpFile, JSON.stringify(tokenData, null, 2));
      fs.renameSync(tmpFile, path.join(__dirname, '.tokens.json'));
      console.log('[BOT REAUTH] Tokens saved to .tokens.json');

      // Notify via Telegram
      try {
        const telegram = new TelegramNotifier();
        await telegram.notifyRefreshRecovered();
      } catch (_e) {
        // Intentionally ignored
      }

      // Reload the enrollment service so the new tokens are picked up immediately
      setTimeout(() => exec('pm2 reload Kick-Bot-Enrollment'), 3000);

      return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Bot Re-authenticated!</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f, #1a1a1a);
            color: #e0e0e0; min-height: 100vh;
            display: flex; justify-content: center; align-items: center; padding: 20px;
        }
        .container {
            background: #1e1e1e; border-radius: 12px; padding: 40px;
            max-width: 480px; width: 100%; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid #2a2a2a;
        }
        h1 { color: #53fc18; margin-bottom: 16px; }
        p { color: #ccc; font-size: 14px; line-height: 1.6; }
    </style>
</head>
<body>
    <div class="container">
        <h1>&#10003; Bot Re-authenticated!</h1>
        <p>New tokens saved. The bot service will reload in a few seconds and resume operation automatically.</p>
    </div>
</body>
</html>`);
    }

    // Get user info to find their channel
    const userResponse = await axios.get('https://api.kick.com/public/v1/users', {
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    console.log('[DEBUG] User response:', JSON.stringify(userResponse.data));

    // Handle different response formats
    let userData: Record<string, unknown> | undefined;
    if (userResponse.data.data && Array.isArray(userResponse.data.data)) {
      userData = userResponse.data.data[0] as Record<string, unknown>;
    } else if (userResponse.data.data) {
      userData = userResponse.data.data as Record<string, unknown>;
    } else {
      userData = userResponse.data as Record<string, unknown>;
    }

    if (!userData) {
      throw new Error('Could not get user data from API');
    }

    const username = ((userData.username || userData.name || userData.slug || '') as string).toLowerCase();
    const userId = (userData.user_id || userData.id) as number | string;

    if (!username) {
      throw new Error('Could not get username from API response');
    }

    console.log(`[DEBUG] Username: ${username}, User ID: ${userId}`);

    // Get channel info for broadcaster ID using bot's token (user token doesn't have channel scope)
    const botAuth = new KickAuth();
    const botToken = await botAuth.getAccessToken();

    const channelResponse = await axios.get(`https://api.kick.com/public/v1/channels?slug=${username}`, {
      headers: {
        'Authorization': `Bearer ${botToken}`
      }
    });

    const channelData = channelResponse.data?.data?.[0] as { broadcaster_user_id?: number } | undefined;
    const broadcasterUserId: number | null = channelData?.broadcaster_user_id || null;

    // Store partial enrollment — chatroom ID will come from the browser on the next step
    const enrollToken = crypto.randomBytes(16).toString('hex');
    pendingEnrollments.set(enrollToken, {
      username,
      userId,
      broadcasterUserId,
      access_token,
      refresh_token,
      expires_in,
      createdAt: Date.now()
    });

    // Clean up stale pending enrollments (older than 10 minutes)
    for (const [key, enroll] of pendingEnrollments) {
      if (Date.now() - enroll.createdAt > 600000) pendingEnrollments.delete(key);
    }

    console.log(`[ENROLL] OAuth complete for ${username}, redirecting for chatroom ID fetch`);

    // Store token in HttpOnly cookie — not in URL (SEC-04)
    res.cookie('enrollSession', enrollToken, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: 600000 // 10 minutes, matches pendingEnrollments TTL
    });
    // Redirect to intermediate page — browser will fetch chatroom ID from kick.com
    res.redirect(`/kick-bot-enroll/fetch-chatroom?username=${encodeURIComponent(username)}`);

  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errData = error.response?.data as { message?: string } | undefined;
      console.error('[ERROR] Enrollment failed:', errData || error.message);
      return res.send(errorPage('Enrollment Failed', errData?.message || error.message));
    }
    if (error instanceof Error) {
      console.error('[ERROR] Enrollment failed:', error.message);
      return res.send(errorPage('Enrollment Failed', error.message));
    }
    res.send(errorPage('Enrollment Failed', 'Unknown error'));
  }
});

// Intermediate page: browser fetches chatroom ID from kick.com/api/v2 (not IP-blocked client-side)
app.get('/kick-bot-enroll/fetch-chatroom', (req: express.Request, res: express.Response) => {
  const username = typeof req.query.username === 'string' ? req.query.username : undefined;
  const cookies = cookieLib.parse(req.headers.cookie || '');
  const token = cookies['enrollSession'];
  if (!username || !validateChannelName(username)) {
    return res.send(errorPage('Invalid Request', 'Invalid channel name.'));
  }
  if (!token || !pendingEnrollments.has(token)) {
    return res.send(errorPage('Session Expired', 'Please start enrollment again.'));
  }

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Setting up your bot...</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: linear-gradient(135deg, #0f0f0f 0%, #1a1a1a 100%);
            color: #e0e0e0; min-height: 100vh;
            display: flex; justify-content: center; align-items: center; padding: 20px;
        }
        .container {
            background: #1e1e1e; border-radius: 12px; padding: 40px;
            max-width: 480px; width: 100%; text-align: center;
            box-shadow: 0 10px 40px rgba(0,0,0,0.5); border: 1px solid #2a2a2a;
        }
        h1 { color: #53fc18; margin-bottom: 16px; font-size: 24px; }
        .spinner {
            width: 48px; height: 48px; border: 4px solid #2a2a2a;
            border-top-color: #53fc18; border-radius: 50%;
            animation: spin 0.8s linear infinite; margin: 0 auto 20px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        p { color: #999; font-size: 14px; line-height: 1.6; }
        .error { color: #ff6b6b; margin-top: 12px; display: none; }
        .retry-btn {
            display: inline-block; margin-top: 16px; padding: 10px 20px;
            background: #53fc18; color: #000; text-decoration: none;
            border-radius: 6px; font-weight: 600; display: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="spinner" id="spinner"></div>
        <h1>Setting up your bot...</h1>
        <p id="status-msg">Detecting your channel info automatically...</p>
        <p class="error" id="error-msg"></p>
        <a href="/kick-bot-enroll" class="retry-btn" id="retry-btn">Try Again</a>
    </div>
    <script>
        (async function() {
            const username = ${JSON.stringify(username)};
            const statusMsg = document.getElementById('status-msg');
            const errorMsg = document.getElementById('error-msg');
            const retryBtn = document.getElementById('retry-btn');
            const spinner = document.getElementById('spinner');

            try {
                const res = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(username));
                if (!res.ok) throw new Error('Channel not found (HTTP ' + res.status + ')');
                const data = await res.json();
                const chatroomId = data && data.chatroom && data.chatroom.id;
                if (!chatroomId) throw new Error('Chatroom ID missing from Kick API response');

                statusMsg.textContent = 'Channel detected! Finishing setup...';
                window.location.href = '/kick-bot-enroll/complete?chatroomId=' + encodeURIComponent(chatroomId);
            } catch (e) {
                spinner.style.display = 'none';
                statusMsg.style.display = 'none';
                errorMsg.style.display = 'block';
                errorMsg.textContent = 'Could not detect channel info: ' + e.message;
                retryBtn.style.display = 'inline-block';
            }
        })();
    </script>
</body>
</html>`);
});

// Complete enrollment — called automatically by the browser after chatroom ID is fetched
app.get('/kick-bot-enroll/complete', async (req: express.Request, res: express.Response) => {
  const chatroomId = typeof req.query.chatroomId === 'string' ? req.query.chatroomId : undefined;
  const cookies = cookieLib.parse(req.headers.cookie || '');
  const token = cookies['enrollSession'];

  if (!token || !chatroomId || !pendingEnrollments.has(token)) {
    return res.send(errorPage('Session Expired', 'Please start enrollment again.'));
  }

  const enroll = pendingEnrollments.get(token)!;
  pendingEnrollments.delete(token);
  // Clear the session cookie — token is single-use
  res.clearCookie('enrollSession');

  const { username, userId, broadcasterUserId, access_token, refresh_token, expires_in } = enroll;
  const resolvedChatroomId: number | null = parseInt(chatroomId, 10) || broadcasterUserId;

  console.log(`[ENROLL] Completing enrollment for ${username} - Chatroom: ${resolvedChatroomId}, Broadcaster: ${broadcasterUserId}`);

  // Save channel config with OAuth tokens
  const configDir = path.join(KICK_BASE_PATH, 'src', 'channel-configs');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config = {
    channelName: username,
    chatroomId: resolvedChatroomId,
    broadcasterUserId: broadcasterUserId,
    userId: userId,
    chatOnly: false,
    oauth: {
      accessToken: access_token,
      refreshToken: refresh_token,
      expiresAt: Date.now() + (expires_in * 1000)
    },
    enrolledAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    location: {
      home: { country: "", city: "", state: "", province: "" },
      current: { country: "", city: "", state: "", province: "" }
    }
  };

  const configPath = path.join(configDir, `${username}.json`);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Deploy the bot automatically
  let deployStatus = 'success';
  let deployMessage = '';

  try {
    const pm2Name = `kick-${username}`;
    const channelsDir = path.join(__dirname, 'channels');
    const botPath = path.join(channelsDir, `${username}.js`);
    const templatePath = path.join(channelsDir, 'template-kick-bot.js');

    if (!fs.existsSync(channelsDir)) {
      fs.mkdirSync(channelsDir, { recursive: true });
    }

    if (!fs.existsSync(botPath) && fs.existsSync(templatePath)) {
      let botCode = fs.readFileSync(templatePath, 'utf8');
      botCode = botCode.replace(/\$\$UPDATEHERE\$\$/g, username);
      fs.writeFileSync(botPath, botCode);
      console.log(`[DEPLOY] Created bot file for ${username}`);
    }

    const ecosystemOk = addToEcosystem(username);
    if (!ecosystemOk) {
      deployStatus = 'warning';
      deployMessage = 'Generated PM2 config failed validation. Bot not started. Contact admin.';
      return res.send(successPage(username, resolvedChatroomId, broadcasterUserId, deployStatus, deployMessage));
    }

    await new Promise<void>((resolve) => {
      exec(`pm2 restart "${pm2Name}"`, (restartErr) => {
        if (!restartErr) {
          console.log(`[DEPLOY] Restarted bot for ${username}`);
          resolve();
          return;
        }

        exec(`pm2 start "${botPath}" --name "${pm2Name}" --time`, (err) => {
          if (err) {
            console.error(`[DEPLOY ERROR] Failed to start bot: ${err.message}`);
            deployStatus = 'warning';
            deployMessage = 'Config saved but bot failed to start. Contact admin.';
          } else {
            console.log(`[DEPLOY] Started bot for ${username}`);
          }
          resolve();
        });
      });
    });
  } catch (deployError) {
    if (deployError instanceof Error) {
      console.error('[DEPLOY ERROR]', deployError.message);
    }
    deployStatus = 'warning';
    deployMessage = 'Config saved but deployment had issues.';
  }

  res.send(successPage(username, resolvedChatroomId, broadcasterUserId, deployStatus, deployMessage));
});

// Check enrollment status API
app.get('/kick-bot-enroll/api/status/:username', (req: express.Request, res: express.Response) => {
  const usernameRaw = req.params['username'];
  const username = (typeof usernameRaw === 'string' ? usernameRaw : '').toLowerCase();
  if (!validateChannelName(username)) {
    return res.status(400).json({ error: 'Invalid channel name' });
  }
  const configPath = path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${username}.json`);

  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        channelName?: string;
        chatroomId?: number;
        broadcasterUserId?: number;
        oauth?: { accessToken?: string };
        enrolledAt?: string;
      };
      res.json({
        enrolled: true,
        username: config.channelName,
        chatroomId: config.chatroomId,
        broadcasterUserId: config.broadcasterUserId,
        hasOAuth: !!config.oauth?.accessToken,
        enrolledAt: config.enrolledAt
      });
    } catch (_e) {
      res.json({ enrolled: false, error: 'Failed to read config' });
    }
  } else {
    res.json({ enrolled: false });
  }
});

// ==================== COMMAND-BASED DEPLOYMENT BOT ====================

const DEPLOYMENT_CHANNEL = process.env.KICK_DEPLOYMENT_CHANNEL || 'mraiishere';
const DEPLOYMENT_CHATROOM_ID = process.env.KICK_DEPLOYMENT_CHATROOM_ID;
const DEPLOYMENT_PROFILE_CHATROOM_ID = process.env.KICK_DEPLOYMENT_PROFILE_CHATROOM_ID;
const MAX_CHANNELS = parseInt(process.env.MAX_KICK_CHANNELS || '10') || 10;
const KICK_OWNER = process.env.KICK_OWNER;

let deploymentWs: WebSocket | null = null;
let deploymentPingInterval: NodeJS.Timeout | null = null;
let deploymentBroadcasterId: number | null = null;

async function startDeploymentBot(): Promise<void> {
  if (!DEPLOYMENT_CHATROOM_ID) {
    console.log('[DEPLOY BOT] KICK_DEPLOYMENT_CHATROOM_ID not set, skipping command-based deployment');
    return;
  }

  try {
    // Get bot auth
    const botAuth = new KickAuth();

    if (!botAuth.isAuthenticated()) {
      console.log('[DEPLOY BOT] Not authenticated, skipping');
      return;
    }

    // Get broadcaster ID for sending messages
    const botToken = await botAuth.getAccessToken();
    const channelResponse = await axios.get(`https://api.kick.com/public/v1/channels?slug=${DEPLOYMENT_CHANNEL}`, {
      headers: { 'Authorization': `Bearer ${botToken}` }
    });
    deploymentBroadcasterId = (channelResponse.data.data[0] as { broadcaster_user_id?: number } | undefined)?.broadcaster_user_id ?? null;

    // Connect to WebSocket
    connectDeploymentWebSocket();

  } catch (err) {
    if (err instanceof Error) {
      console.error('[DEPLOY BOT] Failed to start:', err.message);
    }
  }
}

function connectDeploymentWebSocket(): void {
  const wsUrl = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

  console.log('[DEPLOY BOT] Connecting to Kick deployment chat...');
  deploymentWs = new WebSocket(wsUrl);

  if (deploymentPingInterval) {
    clearInterval(deploymentPingInterval);
    deploymentPingInterval = null;
  }

  deploymentWs.on('open', () => {
    console.log('[DEPLOY BOT] WebSocket connected!');

    const channels = [
      `chatrooms.${DEPLOYMENT_CHATROOM_ID}.v2`,
      `chatrooms.${DEPLOYMENT_CHATROOM_ID}`,
      `channel.${DEPLOYMENT_CHATROOM_ID}`
    ];

    // Also subscribe to the profile page chatroom (@mraiishere) if configured
    if (DEPLOYMENT_PROFILE_CHATROOM_ID) {
      channels.push(
        `chatrooms.${DEPLOYMENT_PROFILE_CHATROOM_ID}.v2`,
        `chatrooms.${DEPLOYMENT_PROFILE_CHATROOM_ID}`
      );
    }

    channels.forEach(channelName => {
      const subscribeMsg = {
        event: 'pusher:subscribe',
        data: { auth: '', channel: channelName }
      };
      deploymentWs!.send(JSON.stringify(subscribeMsg));
    });
  });

  deploymentWs.on('message', (data: WebSocket.RawData) => {
    try {
      const message = JSON.parse(data.toString()) as { event?: string; data?: unknown; channel?: string };
      handleDeploymentMessage(message);
    } catch (err) {
      if (err instanceof Error) {
        console.error('[DEPLOY BOT] Failed to parse message:', err.message);
      }
    }
  });

  deploymentWs.on('close', () => {
    console.log('[DEPLOY BOT] WebSocket disconnected, reconnecting...');
    if (deploymentPingInterval) {
      clearInterval(deploymentPingInterval);
      deploymentPingInterval = null;
    }
    setTimeout(connectDeploymentWebSocket, 5000);
  });

  deploymentPingInterval = setInterval(() => {
    if (deploymentWs && deploymentWs.readyState === WebSocket.OPEN) {
      deploymentWs.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
    }
  }, 30000);
}

function handleDeploymentMessage(message: { event?: string; data?: unknown; channel?: string }): void {
  if (!message.event) return;

  if (message.event === 'pusher_internal:subscription_succeeded') {
    console.log('[DEPLOY BOT] Successfully subscribed! Listening for !kickaddme commands...');
    return;
  }

  if (message.event === 'App\\Events\\ChatMessageEvent') {
    const eventData = typeof message.data === 'string'
      ? JSON.parse(message.data) as Record<string, unknown>
      : message.data as Record<string, unknown>;
    // Extract chatroom ID from Pusher channel name (e.g. "chatrooms.84265270.v2")
    const chatroomMatch = message.channel?.match(/chatrooms\.(\d+)/);
    const sourceChatroomId = chatroomMatch ? chatroomMatch[1] : DEPLOYMENT_CHATROOM_ID;
    handleDeploymentCommand(eventData, sourceChatroomId as string);
  }
}

async function handleDeploymentCommand(data: Record<string, unknown>, sourceChatroomId: string): Promise<void> {
  const sender = data.sender as { username?: string; identity?: { badges?: Array<{ type: string }> } } | undefined;
  const username = sender?.username ?? '';
  const message = data.content as string | undefined;
  const badges = sender?.identity?.badges || [];

  if (!message || !message.startsWith('!')) return;

  const args = message.slice(1).trim().split(/\s+/);
  const command = (args.shift() ?? '').toLowerCase();

  if (command === 'kickaddme') {
    await sendDeploymentMessage(`@${username}, chat enrollment is disabled. Use the web form: https://mr-ai.dev/kick-bot-enroll`, sourceChatroomId);
  } else if (command === 'kickremoveme') {
    await deployRemoveChannel(username, args, badges, sourceChatroomId);
  } else if (command === 'kickstatus') {
    await deployStatus(username, badges, sourceChatroomId);
  } else if (command === 'kickhelp') {
    await deployHelp(username, sourceChatroomId);
  }
}

async function deployAddChannel(requester: string, args: string[], badges: Array<{ type: string }>, sourceChatroomId: string): Promise<void> {
  let targetChannel = requester.toLowerCase();

  const isModUp = badges.some(b => ['moderator', 'broadcaster', 'owner'].includes(b.type)) ||
                  requester.toLowerCase() === KICK_OWNER?.toLowerCase();

  if (isModUp && args.length >= 1) {
    targetChannel = args[0].toLowerCase();
  }

  const sanitized = targetChannel.replace(/[^a-z0-9_]/g, '');
  if (!sanitized || sanitized.length < 1 || sanitized.length > 25) {
    await sendDeploymentMessage(`@${requester}, invalid channel name.`, sourceChatroomId);
    return;
  }

  exec('pm2 jlist', async (error, stdout) => {
    if (error) {
      await sendDeploymentMessage(`@${requester}, failed to check bot capacity.`, sourceChatroomId);
      return;
    }

    try {
      const processList = JSON.parse(stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
      const kickBots = processList.filter(p => p.name && p.name.startsWith('kick-'));

      if (kickBots.length >= MAX_CHANNELS) {
        await sendDeploymentMessage(`@${requester}, maximum capacity reached (${MAX_CHANNELS} channels).`, sourceChatroomId);
        return;
      }

      const pm2Name = `kick-${sanitized}`;
      if (kickBots.find(p => p.name === pm2Name)) {
        await sendDeploymentMessage(`@${requester}, ${sanitized} is already enrolled!`, sourceChatroomId);
        return;
      }

      await sendDeploymentMessage(`@${requester}, enrolling ${sanitized}... (this may take a moment)`, sourceChatroomId);

      // Get broadcaster ID first (needed as chatroom fallback)
      let chatEnrollBroadcasterId: number | null = null;
      try {
        const botAuth = new KickAuth();
        const botToken = await botAuth.getAccessToken();
        const chResponse = await axios.get(`https://api.kick.com/public/v1/channels?slug=${sanitized}`, {
          headers: { 'Authorization': `Bearer ${botToken}` }
        });
        chatEnrollBroadcasterId = (chResponse.data?.data?.[0] as { broadcaster_user_id?: number } | undefined)?.broadcaster_user_id ?? null;
      } catch (e) {
        if (e instanceof Error) {
          console.error('[DEPLOY] Could not get broadcaster ID:', e.message);
        }
      }

      // Get chatroom ID using Kick v2 API, fall back to broadcaster ID
      let chatroomId: number | null = chatEnrollBroadcasterId;
      try {
        const v2Response = await axios.get(`https://kick.com/api/v2/channels/${sanitized}`);
        chatroomId = (v2Response.data?.chatroom as { id?: number } | undefined)?.id ?? chatEnrollBroadcasterId;
        console.log(`[DEPLOY] Got chatroom ID via v2 API: ${chatroomId}`);
      } catch (e) {
        if (e instanceof Error) {
          console.error('[DEPLOY] Could not get chatroom ID via v2 API:', e.message);
        }
        console.log(`[DEPLOY] Falling back to broadcaster ID: ${chatroomId}`);
      }

      if (!chatroomId) {
        await sendDeploymentMessage(`@${requester}, failed to detect channel info for ${sanitized}.`, sourceChatroomId);
        return;
      }

      // Get broadcaster ID
      let broadcasterUserId: number | null = chatroomId;
      try {
        const botAuth2 = new KickAuth();
        const botToken2 = await botAuth2.getAccessToken();
        const channelResponse = await axios.get(`https://api.kick.com/public/v1/channels?slug=${sanitized}`, {
          headers: { 'Authorization': `Bearer ${botToken2}` }
        });
        broadcasterUserId = (channelResponse.data.data[0] as { broadcaster_user_id?: number } | undefined)?.broadcaster_user_id ?? chatroomId;
      } catch (err) {
        if (err instanceof Error) {
          console.error('[DEPLOY] Could not get broadcaster ID (second attempt):', err.message);
        }
      }

      // Create config WITHOUT OAuth
      const configDir = path.join(KICK_BASE_PATH, 'src', 'channel-configs');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const config = {
        channelName: sanitized,
        chatroomId: chatroomId,
        broadcasterUserId: broadcasterUserId,
        chatOnly: false,
        enrolledAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        location: {
          home: { country: "", city: "", state: "", province: "" },
          current: { country: "", city: "", state: "", province: "" }
        }
      };

      const configPath = path.join(configDir, `${sanitized}.json`);
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

      // Create bot file
      const templatePath = path.join(KICK_BASE_PATH, 'channels', 'template-kick-bot.js');
      const botPath = path.join(KICK_BASE_PATH, 'channels', `${sanitized}.js`);

      let botCode = fs.readFileSync(templatePath, 'utf8');
      botCode = botCode.replace(/\$\$UPDATEHERE\$\$/g, sanitized);
      fs.writeFileSync(botPath, botCode);

      // Add to ecosystem
      addToEcosystem(sanitized);

      // Start with PM2
      exec(`pm2 start "${botPath}" --name "${pm2Name}" --time`, async (startError) => {
        if (startError) {
          await sendDeploymentMessage(`@${requester}, failed to start bot for ${sanitized}.`, sourceChatroomId);
          return;
        }
        await sendDeploymentMessage(`@${requester}, bot deployed to ${sanitized}! (Chatroom: ${chatroomId})`, sourceChatroomId);
      });

    } catch (err) {
      if (err instanceof Error) {
        console.error('[DEPLOY] deployAddChannel failed:', err.message);
      }
      await sendDeploymentMessage(`@${requester}, enrollment failed.`, sourceChatroomId);
    }
  });
}

async function deployRemoveChannel(requester: string, args: string[], badges: Array<{ type: string }>, sourceChatroomId: string): Promise<void> {
  let targetChannel = requester.toLowerCase();

  const isModUp = badges.some(b => ['moderator', 'broadcaster', 'owner'].includes(b.type)) ||
                  requester.toLowerCase() === KICK_OWNER?.toLowerCase();

  if (isModUp && args.length >= 1) {
    targetChannel = args[0].toLowerCase();
  }

  const sanitized = targetChannel.replace(/[^a-z0-9_]/g, '');

  if (sanitized !== requester.toLowerCase() && !isModUp) {
    await sendDeploymentMessage(`@${requester}, you can only remove your own channel.`, sourceChatroomId);
    return;
  }

  const pm2Name = `kick-${sanitized}`;

  exec(`pm2 stop "${pm2Name}" && pm2 delete "${pm2Name}"`, async (error) => {
    if (error) {
      await sendDeploymentMessage(`@${requester}, bot for ${sanitized} not found.`, sourceChatroomId);
      return;
    }

    fs.unlinkSync(path.join(KICK_BASE_PATH, 'dist', 'channels', `${sanitized}.js`));
    fs.unlinkSync(path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${sanitized}.json`));
    removeFromEcosystem(sanitized);

    await sendDeploymentMessage(`@${requester}, bot removed from ${sanitized}.`, sourceChatroomId);
  });
}

async function deployStatus(requester: string, badges: Array<{ type: string }>, sourceChatroomId: string): Promise<void> {
  const isModUp = badges.some(b => ['moderator', 'broadcaster', 'owner'].includes(b.type)) ||
                  requester.toLowerCase() === KICK_OWNER?.toLowerCase();

  if (!isModUp) {
    await sendDeploymentMessage(`@${requester}, this command is for moderators only.`, sourceChatroomId);
    return;
  }

  exec('pm2 jlist', async (error, stdout) => {
    if (error) {
      await sendDeploymentMessage(`@${requester}, failed to get status.`, sourceChatroomId);
      return;
    }

    const processList = JSON.parse(stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    const kickBots = processList.filter(p => p.name && p.name.startsWith('kick-'));
    const activeCount = kickBots.filter(p => p.pm2_env?.status === 'online').length;

    await sendDeploymentMessage(`@${requester}, Kick bots: ${activeCount}/${kickBots.length} active, ${MAX_CHANNELS} max.`, sourceChatroomId);
  });
}

async function deployHelp(requester: string, sourceChatroomId: string): Promise<void> {
  await sendDeploymentMessage(`@${requester}, !kickaddme - Enroll | !kickremoveme - Remove | OAuth: https://mr-ai.dev/kick-bot-enroll`, sourceChatroomId);
}

async function sendDeploymentMessage(message: string, sourceChatroomId: string): Promise<void> {
  try {
    // If the command came from the profile chatroom, reply there directly via session API
    if (sourceChatroomId && String(sourceChatroomId) !== String(DEPLOYMENT_CHATROOM_ID)) {
      const session = new KickSessionAuth();
      await session.sendMessage(sourceChatroomId, message);
      console.log(`[DEPLOY BOT] (profile chatroom ${sourceChatroomId}) ${message}`);
      return;
    }

    // Default: send to deployment channel via public API
    const botAuth = new KickAuth();
    const botToken = await botAuth.getAccessToken();

    await axios.post('https://api.kick.com/public/v1/chat', {
      broadcaster_user_id: deploymentBroadcasterId,
      content: message,
      type: 'bot'
    }, {
      headers: {
        'Authorization': `Bearer ${botToken}`,
        'Content-Type': 'application/json'
      }
    });

    console.log(`[DEPLOY BOT] ${message}`);
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const errData = error.response?.data as { message?: string } | undefined;
      console.error('[DEPLOY] Send message failed:', errData?.message || error.message);
      return;
    }
    if (error instanceof Error) {
      console.error('[DEPLOY] Send message failed:', error.message);
    }
  }
}

// ==================== START SERVICES ====================

// Start server
app.listen(PORT, () => {
  console.log(`[INFO] Mr-AI Bot Enrollment Service running on http://localhost:${PORT}`);
  console.log(`[INFO] Public URL: https://${oauthDomain}/kick-bot-enroll`);

  // Start token monitor first, wait for initial check to complete,
  // then start deployment bot so it always gets a fully refreshed token
  const botAuth = new KickAuth();
  const { ready } = botAuth.startTokenMonitor();
  ready.then(() => startDeploymentBot());
});

// Export deployAddChannel for use if needed (currently unused but defined in original)
export { deployAddChannel };
