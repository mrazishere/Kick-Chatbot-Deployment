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
import { chatroomResolver } from './channels/chatroom-resolver';
import { clipSessionStatus, installClipToken } from './channels/clip-session';
import { resolveBotIdentity } from './bot-identity';
import { SYSTEM_BOTS } from './system-bots';
import { commandWordCollides, effectiveCommand, effectivePointsConfig, readSubscriptionStatus, validatePointsPatch } from './points/config';
import { adjustPoints, backupPoints, getPointsUserDetail, pointsLeaderboard, pointsSummary, searchPointsUsers } from './points/store';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

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
//
// /kick-webhook is deliberately excluded from the body parsers. Kick signs the
// exact bytes it sent, so that route must reach its own express.raw() handler
// with the request stream unconsumed. A global express.json() parses it first
// and leaves req.body as a plain object — every signature check then hashed the
// string "[object Object]" and failed, so no webhook was ever accepted.
const WEBHOOK_PATH = '/kick-webhook';
const skipWebhook = (parser: express.RequestHandler): express.RequestHandler =>
  (req, res, next) => (req.path === WEBHOOK_PATH ? next() : parser(req, res, next));

// nginx proxies the public routes in from loopback. Trusting only loopback proxies
// gives the rate limiter each visitor's own address — before, everyone shared
// 127.0.0.1 and one ten-a-minute budget — while internalGuard still checks the raw
// socket, so a forwarded header can't pass for a local caller.
app.set('trust proxy', 'loopback');
app.use(skipWebhook(express.json()));
app.use(skipWebhook(express.urlencoded({ extended: true })));
app.use('/kick-bot-enroll', rateLimiter);
// The bot re-auth flow is public too; unthrottled, anyone could grow pendingSessions without limit.
app.use('/kick-bot-reauth', rateLimiter);

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
// Webhook: public key + signature verification
// ---------------------------------------------------------------------------

const KICK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAq/+l1WnlRrGSolDMA+A8
6rAhMbQGmQ2SapVcGM3zq8ANXjnhDWocMqfWcTd95btDydITa10kDvHzw9WQOqp2
MZI7ZyrfzJuz5nhTPCiJwTwnEtWft7nV14BYRDHvlfqPUaZ+1KR4OCaO/wWIk/rQ
L/TjY0M70gse8rlBkbo2a8rKhu69RQTRsoaf4DVhDPEeSeI5jVrRDGAMGL3cGuyY
6CLKGdjVEM78g3JfYOvDU/RvfqD7L89TZ3iN94jrmWdGz34JNlEI5hqK8dd7C5EF
BEbZ5jgB8s8ReQV8H+MkuffjdAj3ajDDX3DOJMIut1lBrUVD1AaSrGCKHooWoL2e
twIDAQAB
-----END PUBLIC KEY-----`;

let cachedPublicKey: string = KICK_PUBLIC_KEY_PEM;
let publicKeyFetchedAt: number = 0;
const PUBLIC_KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getKickPublicKey(): Promise<string> {
  const now = Date.now();
  if (now - publicKeyFetchedAt < PUBLIC_KEY_TTL_MS) {
    return cachedPublicKey;
  }
  try {
    const response = await axios.get('https://api.kick.com/public/v1/public-key', { timeout: 5000 });
    // Kick wraps the key as { data: { public_key } }. Reading it from the top
    // level never found it, so the cache never filled and every webhook fetched
    // the key again — each Kick timeout stalled that event by five seconds.
    const body = response.data as { data?: { public_key?: unknown }; public_key?: unknown };
    const pem = body?.data?.public_key ?? body?.public_key;
    if (typeof pem === 'string' && pem.includes('BEGIN PUBLIC KEY')) {
      cachedPublicKey = pem;
      publicKeyFetchedAt = now;
      return cachedPublicKey;
    }
    console.error('[WEBHOOK] Public key response had no key, using cached:', JSON.stringify(body).slice(0, 200));
  } catch (e) {
    console.error('[WEBHOOK] Failed to refresh public key, using cached:', e instanceof Error ? e.message : String(e));
  }
  // Retry in ten minutes rather than on the very next webhook.
  publicKeyFetchedAt = now - PUBLIC_KEY_TTL_MS + 10 * 60 * 1000;
  return cachedPublicKey;
}

async function verifyWebhookSignature(
  messageId: string,
  timestamp: string,
  rawBody: Buffer,
  signatureB64: string
): Promise<boolean> {
  try {
    const pubKey = await getKickPublicKey();
    const signedData = `${messageId}.${timestamp}.${rawBody.toString('utf8')}`;
    const signature = Buffer.from(signatureB64, 'base64');
    return crypto.verify(
      'sha256',
      Buffer.from(signedData, 'utf8'),
      { key: pubKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      signature
    );
  } catch (e) {
    console.error('[WEBHOOK] Signature verification error:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Webhook: app access token (client_credentials) + subscription helpers
// ---------------------------------------------------------------------------

let _appToken: string | null = null;
let _appTokenExpiresAt = 0;

async function getWebhookAppToken(): Promise<string> {
  if (_appToken && Date.now() < _appTokenExpiresAt - 60_000) return _appToken;
  const res = await axios.post(
    'https://id.kick.com/oauth/token',
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.CLIENT_ID || '',
      client_secret: process.env.CLIENT_SECRET || '',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  const data = res.data as { access_token: string; expires_in: number };
  _appToken = data.access_token;
  _appTokenExpiresAt = Date.now() + data.expires_in * 1000;
  return _appToken;
}

/**
 * Every event a channel is subscribed to, and so every event the receiver queues.
 * Subscribing with the app token needs no scope beyond what the app already has,
 * so adding one here never makes a streamer re-authorize.
 */
const WEBHOOK_EVENTS = [
  'chat.message.sent',
  // Channel-points redemptions. Drives rewardActions in the channel
  // config (e.g. a reward that times someone out).
  'channel.reward.redemption.updated',
  // Lets the bot drop a timeout it gave out once a moderator bans the same
  // user, so its early unban or a pardon can't lift the moderator's ban.
  'moderation.banned',
  // Loyalty points bonuses (src/points/events.ts).
  'channel.followed',
  'channel.subscription.new',
  'channel.subscription.renewal',
  'channel.subscription.gifts',
  'kicks.gifted',
  // A hint for the points earner; its own live check is what decides.
  'livestream.status.updated'
];

/** The enrolled channel a broadcaster id belongs to, or null. */
function channelNameForBroadcaster(broadcasterUserId: number): string | null {
  const configDir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  if (!fs.existsSync(configDir)) return null;
  for (const file of fs.readdirSync(configDir).filter(f => f.endsWith('.json'))) {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8')) as {
        broadcasterUserId?: number;
        channelName?: string;
      };
      if (cfg.broadcasterUserId === broadcasterUserId) return cfg.channelName || file.replace('.json', '');
    } catch (_) { /* skip bad config */ }
  }
  return null;
}

/**
 * Record how each event's subscription went, in data/webhook-subscriptions/<channel>.json.
 * The bot falls back to chat-socket sub events only for an event recorded as failed,
 * and the dashboard shows the list.
 */
function recordSubscriptionStatus(channel: string | null, results: Record<string, { ok: boolean; error?: string }>): void {
  if (!channel) return;
  try {
    const dir = path.join(KICK_BASE_PATH, 'data', 'webhook-subscriptions');
    fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    writeJsonAtomic(
      path.join(dir, `${channel}.json`),
      Object.fromEntries(Object.entries(results).map(([name, r]) => [name, { ...r, at }]))
    );
  } catch (e) {
    console.error(`[WEBHOOK] Could not record subscription status for ${channel}:`, e instanceof Error ? e.message : String(e));
  }
}

async function subscribeChannelToWebhook(broadcasterUserId: number, channelName?: string): Promise<void> {
  const channel = channelName ?? channelNameForBroadcaster(broadcasterUserId);
  try {
    const appToken = await getWebhookAppToken();
    const res = await axios.post(
      'https://api.kick.com/public/v1/events/subscriptions',
      {
        events: WEBHOOK_EVENTS.map(name => ({ name, version: 1 })),
        broadcaster_user_id: broadcasterUserId,
        method: 'webhook'
      },
      {
        headers: {
          'Authorization': `Bearer ${appToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    // One entry per requested event — report them all, not just the first.
    const result = res.data as { data?: Array<{ name?: string; subscription_id?: string; error?: string }> };
    const results: Record<string, { ok: boolean; error?: string }> = {};
    for (const sub of result.data ?? []) {
      if (sub.error) {
        console.error(`[WEBHOOK] Subscription error for broadcaster ${broadcasterUserId} (${sub.name}):`, sub.error);
        if (sub.name) results[sub.name] = { ok: false, error: String(sub.error) };
      } else {
        console.log(`[WEBHOOK] Subscribed broadcaster ${broadcasterUserId} to ${sub.name} (id: ${sub.subscription_id})`);
        if (sub.name) results[sub.name] = { ok: true };
      }
    }
    for (const name of WEBHOOK_EVENTS) {
      if (!results[name]) results[name] = { ok: false, error: 'Kick did not report this subscription' };
    }
    recordSubscriptionStatus(channel, results);
  } catch (e) {
    const detail = axios.isAxiosError(e)
      ? (JSON.stringify(e.response?.data as unknown) || e.message)
      : (e instanceof Error ? e.message : String(e));
    console.error(`[WEBHOOK] Subscription failed for broadcaster ${broadcasterUserId}:`, detail);
    // Kick keeps subscriptions made earlier, so a failed retry says nothing about
    // them. Only a channel with no record at all is marked failed.
    if (channel && !readSubscriptionStatus(channel)) {
      recordSubscriptionStatus(channel, Object.fromEntries(WEBHOOK_EVENTS.map(name => [name, { ok: false, error: detail }])));
    }
  }
}

async function subscribeAllChannelsToWebhook(): Promise<void> {
  const configDir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  if (!fs.existsSync(configDir)) return;

  const files = fs.readdirSync(configDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8')) as {
        broadcasterUserId?: number;
        channelName?: string;
      };
      if (config.broadcasterUserId) {
        await subscribeChannelToWebhook(config.broadcasterUserId, config.channelName || file.replace('.json', ''));
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      console.error(`[WEBHOOK] Failed to subscribe channel from ${file}:`, e instanceof Error ? e.message : String(e));
    }
  }
}

// ---------------------------------------------------------------------------
// OAuth Configuration
// ---------------------------------------------------------------------------

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const oauthDomain = process.env.OAUTH_DOMAIN || 'localhost';
const protocol = oauthDomain.includes('localhost') ? 'http' : 'https';
const redirectUri = `${protocol}://${oauthDomain}/kick-bot-enroll/callback`;

// The bot dashboard replaced the standalone enrollment page. The OAuth routes
// below stay put — /kick-bot-enroll/callback is registered with Kick and must
// not move — but the human-facing landing page now lives in the dashboard.
const dashboardUrl = process.env.BOT_DASHBOARD_URL || `${protocol}://${oauthDomain}/kick`;

// The streamer-delegated scope set. The dashboard login requests the identical
// string so that signing in re-authorizes silently and resets the 30-day grant
// clock. If these ever diverge, every streamer gets an extra consent prompt.
// Keep in sync with kpp-dashboard/src/lib/kick-scopes.ts.
const SCOPES = [
  'user:read',
  'channel:read',
  'channel:write',
  'chat:write',
  'events:subscribe',
  'channel:rewards:write',
  'moderation:ban',
  'moderation:chat_message:manage'
].join(' ');
const authServer = 'https://id.kick.com';
const KICK_BASE_PATH = path.resolve(__dirname, '..');

/**
 * Names that can't be channels. Each channel's bot is dist/channels/<name>.js,
 * right beside the modules every bot shares, so enrolling a channel called
 * `moderation` overwrote moderation.js — breaking every bot at its next restart —
 * and removing it deleted the module. Shared modules with a hyphen in the name
 * are already out of reach. `channels` is the bot API's list route.
 */
const RESERVED_CHANNEL_NAMES = new Set(['channels', 'moderation']);

// Validate channel name: only lowercase alphanumeric and underscores, 1-30 chars
function validateChannelName(name: string): boolean {
  if (typeof name !== 'string') return false;
  return /^[a-z0-9_]{1,30}$/.test(name) && !RESERVED_CHANNEL_NAMES.has(name);
}

/** Write JSON through a rename, so a process reading the file never sees half of it. */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * Write a channel config without discarding what is already there.
 *
 * Enrollment used to build a fresh object and write it straight over the file.
 * Re-authorizing — which every streamer must do monthly, because Kick grants
 * die 30 days after auth — therefore wiped managers, excludedCommands,
 * location, kpp/earnings settings and rewardActions. The bug was invisible
 * because a first-time enrollment has nothing to lose.
 *
 * Precedence: `forced` (this enrollment's identity and tokens) beats what is on
 * disk, which in turn beats `defaults` (only used for a genuinely new channel).
 */
function mergeChannelConfig(
  configPath: string,
  defaults: Record<string, unknown>,
  forced: Record<string, unknown>
): Record<string, unknown> {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    } catch (e) {
      console.error(`[CONFIG] ${configPath} unreadable, treating as new:`, e instanceof Error ? e.message : String(e));
    }
  }
  const merged = { ...defaults, ...existing, ...forced };
  writeJsonAtomic(configPath, merged);
  const kept = Object.keys(existing).filter(k => !(k in forced));
  if (kept.length) console.log(`[CONFIG] Preserved existing settings: ${kept.join(', ')}`);
  return merged;
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
      // Watch a sentinel file rather than the channel config JSON itself.
      // The bot writes its own JSON during token-refresh rotation; if PM2
      // watched the JSON directly, every successful refresh would trigger a
      // restart (slow-motion crash loop on OAuth channels). Deploy code and
      // admin manual edits explicitly `touch` the .reload sentinel after
      // their writes; the bot never touches it.
      "watch": [
        `${KICK_BASE_PATH}/data/channel-configs/${username}.reload`
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
            <a href="${dashboardUrl}/${username}/bot" class="channel-link">Open Bot Dashboard</a>
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

/**
 * Escape text for these HTML pages. errorPage shows query parameters and Kick's error
 * text; unescaped, `?error=<script>` ran script on the same origin as the dashboard.
 */
function escapeHtml(text: unknown): string {
  return String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
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
        <h1>${escapeHtml(title)}</h1>
        <p class="message">${escapeHtml(message)}</p>
        <a href="/kick-bot-enroll" class="retry-btn">Try Again</a>
    </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes — enrollment flow
// ---------------------------------------------------------------------------

// Serve the main enrollment page
// The enrollment landing page has been replaced by the bot dashboard. Keep the
// URL alive so existing links, chat messages and bookmarks still work.
app.get('/kick-bot-enroll', (_req: express.Request, res: express.Response) => {
  res.redirect(302, dashboardUrl);
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
    // Streamer-delegated scopes. Requested as one fixed set, because the
    // dashboard login re-authorizes with these same scopes: Kick only re-prompts
    // when the set CHANGES, so keeping it stable is what makes grant renewal
    // silent. Adding a scope later costs every streamer a fresh consent screen.
    //   chat:write                     — what the bot actually posts with
    //   channel:read                   — /channels lookups on the streamer token
    //   channel:write                  — update stream title/category
    //   events:subscribe               — subscribe this channel to webhooks
    //   channel:rewards:write          — create/edit rewards and accept or
    //                                    reject redemptions (implies read)
    //   moderation:ban                 — reward timeouts (rewardActions)
    //   moderation:chat_message:manage — delete messages (not used yet)
    // Deliberately NOT requested: streamkey:read (a leaked stream key lets
    // someone broadcast as the channel, and no chat feature needs it) and ads:*.
    scope: SCOPES
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
    // channel:read for /channels lookups; moderation:ban so reward timeouts are
    // credited to the bot on channels where it is a moderator.
    scope: 'chat:write user:read channel:read moderation:ban'
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
      // Any Kick user can finish this login, so check WHO signed in before replacing the
      // bot's token. Without this, any account could become the bot in every channel.
      const expected = (process.env.KICK_USERNAME || '').toLowerCase();
      let signedInAs = '';
      try {
        const who = await axios.get('https://api.kick.com/public/v1/users', {
          headers: { Authorization: `Bearer ${access_token}` },
          timeout: 10_000
        });
        const user = ((who.data as { data?: Array<{ name?: string; username?: string }> })?.data ?? [])[0];
        signedInAs = String(user?.name ?? user?.username ?? '');
      } catch (e) {
        console.error('[BOT REAUTH] Could not confirm which account signed in:', e instanceof Error ? e.message : String(e));
      }
      if (!expected || signedInAs.toLowerCase() !== expected) {
        console.warn(`[BOT REAUTH] Refused: signed in as "${signedInAs || 'unknown'}", bot account is "${expected || 'unset'}"`);
        return res.send(errorPage(
          'Wrong Kick Account',
          `You signed in as ${signedInAs || 'an account that could not be confirmed'}, but the bot account is ` +
          `${expected || '(KICK_USERNAME is not set)'}. Nothing was changed. Log in to Kick as the bot account and try again.`
        ));
      }

      const tokenData = {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000),
        // Kick grants die exactly 30 days after this exchange — the token
        // monitor uses grantedAt to warn at day 28.
        grantedAt: Date.now()
      };
      // Under the refresh lock: written bare, a refresh already in flight in another
      // process could finish afterwards and put the old grant's tokens back over this one.
      await KickAuth.storeTokens(tokenData, path.join(__dirname, '.tokens.json'));
      console.log('[BOT REAUTH] Tokens saved to .tokens.json');

      // Notify via Telegram
      try {
        const telegram = new TelegramNotifier();
        await telegram.notifyRefreshRecovered();
      } catch (_e) {
        // Intentionally ignored
      }

      // Restart every channel bot, then reload this service. The earnings/KPP
      // pollers re-read tokens from disk and self-heal, but each bot's KickAuth
      // caches tokens in memory — without a restart they keep using the revoked
      // grant and fail sends with invalid_grant.
      setTimeout(() => {
        let channelBots = '';
        try {
          const cfgDir = path.join(process.cwd(), 'data', 'channel-configs');
          channelBots = fs.readdirSync(cfgDir)
            .filter(f => f.endsWith('.json'))
            .map(f => `kick-${path.basename(f, '.json')}`)
            .join(' ');
        } catch (e) {
          console.error('[BOT REAUTH] Could not list channel configs for restart:', e instanceof Error ? e.message : e);
        }
        exec(`pm2 restart ${channelBots} ; pm2 reload Kick-Bot-Enrollment`);
      }, 3000);

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
        <p>New tokens saved. All channel bots and the enrollment service will restart in a few seconds and resume operation automatically.</p>
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
    // The same rule as every other path. A reserved name like "moderation" would put a
    // bot file on top of a module every bot shares.
    if (!validateChannelName(username)) {
      return res.send(errorPage('Enrollment Not Available', 'This Kick username cannot be used as a bot channel.'));
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
  if (!validateChannelName(username)) {
    return res.send(errorPage('Enrollment Not Available', 'This Kick username cannot be used as a bot channel.'));
  }
  // The chat command enforced MAX_CHANNELS but this path didn't, so any Kick user could
  // add bot processes without limit. An existing channel (monthly re-auth) is exempt.
  const alreadyEnrolled = fs.existsSync(path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${username}.json`));
  if (!alreadyEnrolled) {
    const running = (await pm2List()).filter(p => p.name?.startsWith('kick-')).length;
    if (running >= MAX_CHANNELS) {
      return res.send(errorPage('At Capacity', `The bot is at its limit of ${MAX_CHANNELS} channels right now.`));
    }
  }
  const resolvedChatroomId: number | null = parseInt(chatroomId, 10) || broadcasterUserId;

  console.log(`[ENROLL] Completing enrollment for ${username} - Chatroom: ${resolvedChatroomId}, Broadcaster: ${broadcasterUserId}`);

  // Save channel config with OAuth tokens
  const configDir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const configPath = path.join(configDir, `${username}.json`);
  mergeChannelConfig(
    configPath,
    {
      chatOnly: false,
      location: {
        home: { country: "", city: "", state: "", province: "" },
        current: { country: "", city: "", state: "", province: "" }
      }
    },
    {
      channelName: username,
      chatroomId: resolvedChatroomId,
      broadcasterUserId: broadcasterUserId,
      userId: userId,
      oauth: {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: Date.now() + (expires_in * 1000)
      },
      // Re-authorizing restarts Kick's 30-day grant clock, so this is
      // "last authorized at" and must move forward on every enrollment.
      enrolledAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString()
    }
  );
  // Bump the sentinel so PM2 file-watch (if active for this entry) restarts
  // the bot to pick up the new tokens. The explicit `pm2 restart` below also
  // covers this; the sentinel is here for symmetry with the chat-command path
  // and so admins editing the JSON manually can trigger restart via touch.
  fs.writeFileSync(path.join(configDir, `${username}.reload`), '');

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
          // No pm2 save needed — restart of an existing entry doesn't change
          // the process list, so dump.pm2 is already correct.
          resolve();
          return;
        }

        exec(`pm2 start "${botPath}" --name "${pm2Name}" --time`, (err) => {
          if (err) {
            console.error(`[DEPLOY ERROR] Failed to start bot: ${err.message}`);
            deployStatus = 'warning';
            deployMessage = 'Config saved but bot failed to start. Contact admin.';
            resolve();
            return;
          }
          console.log(`[DEPLOY] Started bot for ${username}`);
          // Persist new entry so it survives reboots.
          exec('pm2 save', (saveErr) => {
            if (saveErr) console.error(`[DEPLOY] pm2 save failed: ${saveErr.message}`);
            resolve();
          });
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

  // Subscribe the newly enrolled channel to webhook events (fire-and-forget)
  if (broadcasterUserId) {
    subscribeChannelToWebhook(broadcasterUserId).catch(e =>
      console.error('[WEBHOOK] Post-enrollment subscription error:', e)
    );
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

// ==================== VOD SCRAPER API ====================
// Internal-only endpoint (not exposed via nginx) — called by the kpp-dashboard
// on localhost. Uses stealth puppeteer to bypass Cloudflare on kick.com/api/v2.

const UUID_RE_VOD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Legacy video.uuid → current VOD id. Both are permanent, so entries never go stale. */
const vodIdByUuid = new Map<string, string>();

/**
 * Every scrape launches a headless Chromium, and the dashboard's public earnings
 * page can ask about any channel. Results are cached briefly and only a couple of
 * browsers run at once, so a burst of requests can't exhaust the memory that every
 * channel bot on this machine shares.
 */
const vodCache = new Map<string, { at: number; vods: unknown[] }>();
const VOD_CACHE_MS = 5 * 60 * 1000;
const VOD_MAX_CONCURRENT = 2;
let vodScrapesRunning = 0;

function findVodUuid(obj: Record<string, unknown>): string | null {
  for (const key of ['uuid', 'slug', 'video_uuid']) {
    const v = obj[key];
    if (typeof v === 'string' && UUID_RE_VOD.test(v)) return v;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && UUID_RE_VOD.test(v)) return v;
  }
  return null;
}

app.get('/internal/vods/:username', async (req: express.Request, res: express.Response) => {
  const usernameRaw = req.params['username'];
  const slug = (typeof usernameRaw === 'string' ? usernameRaw : '').toLowerCase();
  if (!validateChannelName(slug)) {
    return res.status(400).json({ error: 'Invalid channel name' });
  }

  const cached = vodCache.get(slug);
  if (cached && Date.now() - cached.at < VOD_CACHE_MS) {
    return res.json({ vods: cached.vods });
  }
  if (vodScrapesRunning >= VOD_MAX_CONCURRENT) {
    return res.status(503).json({ error: 'VOD lookups are busy — try again shortly' });
  }

  const t0 = Date.now();
  vodScrapesRunning++;
  let browser: Awaited<ReturnType<typeof puppeteer.launch>>;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
  } catch (err) {
    vodScrapesRunning--;
    // This used to sit outside any try, so a failed launch rejected the handler —
    // and an unhandled rejection takes the whole enrollment service down.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VOD] Browser launch failed for ${slug}:`, msg);
    return res.status(500).json({ error: msg });
  }

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );

    const resp = await page.goto(`https://kick.com/api/v2/channels/${slug}/videos`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!resp || resp.status() !== 200) {
      return res.status(502).json({ error: `Kick returned ${resp?.status() ?? 'no response'}` });
    }

    const body = await resp.text();
    const raw = JSON.parse(body) as unknown;
    const items: Record<string, unknown>[] = Array.isArray(raw)
      ? raw as Record<string, unknown>[]
      : ((raw as { data?: Record<string, unknown>[] }).data ?? []);

    // Each item is a stream/livestream record; item.video.uuid is the VOD's legacy id.
    // stream_title / session_title = stream name; start_time = when stream began.
    const listed = items.flatMap((v) => {
      const video = v['video'] as Record<string, unknown> | null;
      const uuid = video?.['uuid'];
      if (typeof uuid !== 'string' || !UUID_RE_VOD.test(uuid)) return [];
      if (video?.['is_pruned']) return []; // deleted VOD

      const title = typeof v['session_title'] === 'string'
        ? v['session_title']
        : (typeof v['stream_title'] === 'string' ? v['stream_title'] : '');
      const rawDate = typeof v['start_time'] === 'string' ? v['start_time'] as string : '';
      const createdAt = rawDate.replace(' ', 'T').replace(/(\d{2}:\d{2}:\d{2})$/, '$1Z');
      return [{
        uuid,
        title,
        createdAt,
        duration: typeof v['duration'] === 'number' ? v['duration'] : 0
      }];
    });

    // Kick's VOD pages moved to a new id: /videos/<video.uuid> now renders "Oops,
    // something went wrong". The new id isn't in this listing; it is
    // livestream.vod_id on the per-video endpoint, so look up whichever ids aren't
    // mapped yet. The fetches run inside the page so they share its Cloudflare
    // clearance. An id that can't be mapped links to the channel's videos page
    // instead of a page that errors.
    const missing = listed.map(l => l.uuid).filter(u => !vodIdByUuid.has(u));
    if (missing.length > 0) {
      const found = (await page.evaluate(async (uuids: string[]) => Promise.all(uuids.map(async (u) => {
        try {
          const r = await fetch(`/api/v1/video/${u}`, { headers: { Accept: 'application/json' } });
          if (!r.ok) return [u, null];
          const j = (await r.json()) as { livestream?: { vod_id?: unknown } };
          const id = j?.livestream?.vod_id;
          return [u, typeof id === 'string' ? id : null];
        } catch {
          return [u, null];
        }
      })), missing)) as Array<[string, string | null]>;
      for (const [u, id] of found) {
        if (id && UUID_RE_VOD.test(id)) vodIdByUuid.set(u, id);
      }
    }

    const vods = listed.map(l => {
      const vodId = vodIdByUuid.get(l.uuid) ?? null;
      return { ...l, vodId, url: vodId ? `https://kick.com/${slug}/videos/${vodId}` : `https://kick.com/${slug}/videos` };
    });
    const unmapped = vods.filter(v => !v.vodId).length;
    console.log(
      `[VOD] Scraped ${vods.length} VODs for ${slug} in ${Date.now() - t0}ms` +
      (missing.length ? `, looked up ${missing.length} new VOD id(s)` : '') +
      (unmapped ? ` — ${unmapped} without a current VOD id, linked to the videos page` : '')
    );
    if (vodCache.size > 100) vodCache.clear();
    vodCache.set(slug, { at: Date.now(), vods });
    return res.json({ vods });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[VOD] Scrape failed for ${slug}:`, msg);
    return res.status(500).json({ error: msg });
  } finally {
    // A close that never settles must not hold its slot for good: two of those and
    // every later lookup would be "busy" until the service restarts.
    await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 10_000))]);
    vodScrapesRunning--;
  }
});

// ==================== INTERNAL BOT MANAGEMENT API ====================
// Consumed by the dashboard (Next.js, localhost:3008). Not exposed via nginx.
// Same pattern as /internal/vods above: loopback-only, plus a shared secret on
// mutating routes so a compromised co-tenant process can't drive pm2.

const GRANT_LIFETIME_MS_API = 30 * 24 * 60 * 60 * 1000;

/**
 * Fallbacks the AI command applies when a channel config omits them
 * (DEFAULT_MAX_REQUESTS_PER_WINDOW / DEFAULT_MAX_BURST_REQUESTS /
 * DEFAULT_USER_COOLDOWN_MINUTES in bot-commands/claude.ts).
 *
 * Surfaced so the dashboard can show what an unset field actually does — an
 * empty box otherwise reads as "off" when it means "using the default".
 * Kept in sync by hand; a stale value here misleads the UI but breaks nothing.
 */
const CLAUDE_DEFAULTS = { rateLimit: 50, burstRequests: 5, cooldownMinutes: 5 };

function isLoopback(req: express.Request): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function internalGuard(mutating: boolean) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (!isLoopback(req)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    if (mutating) {
      const secret = process.env.INTERNAL_API_SECRET;
      if (!secret) {
        res.status(503).json({ error: 'INTERNAL_API_SECRET not configured' });
        return;
      }
      const supplied = req.get('x-internal-secret') || '';
      // Constant-time compare; mismatched lengths short-circuit to false.
      const a = Buffer.from(supplied);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        res.status(401).json({ error: 'Bad secret' });
        return;
      }
    }
    next();
  };
}

interface Pm2Proc {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; pm_uptime?: number; restart_time?: number; unstable_restarts?: number };
  monit?: { memory?: number; cpu?: number };
}

async function pm2List(): Promise<Pm2Proc[]> {
  return new Promise((resolve) => {
    exec('pm2 jlist', { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        resolve(JSON.parse(stdout) as Pm2Proc[]);
      } catch {
        resolve([]);
      }
    });
  });
}

function execAsync(cmd: string, maxLen = 500): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) resolve({ ok: false, message: (stderr || error.message).trim().slice(0, 500) });
      else resolve({ ok: true, message: (stdout || '').trim().slice(0, maxLen) });
    });
  });
}

/** Command names are the bot-commands module basenames the bot loads at runtime. */
function listAvailableCommands(): string[] {
  try {
    return fs.readdirSync(path.join(KICK_BASE_PATH, 'dist', 'bot-commands'))
      .filter(f => f.endsWith('.js'))
      .map(f => path.basename(f, '.js'))
      .sort();
  } catch {
    return [];
  }
}

function readChannelConfig(channel: string): Record<string, unknown> | null {
  const p = path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${channel}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function writeChannelConfig(channel: string, config: Record<string, unknown>): void {
  // Atomic: the channel's bot reads this file while it runs, and a read that
  // caught it half-written fell back to a stale copy the bot then saved over it.
  writeJsonAtomic(path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${channel}.json`), config);
}

/**
 * Command names as the modules spell them. Chat and the dashboard stored them
 * lowercased ("customc"), which matched no module, so the dashboard could never
 * save customC as disabled. Names with no module come back as null.
 */
function canonicalCommandNames(names: unknown[]): Array<string | null> {
  const byLower = new Map(listAvailableCommands().map(c => [c.toLowerCase(), c] as const));
  return names.map(n => byLower.get(String(n).toLowerCase()) ?? null);
}

/**
 * Touch the sentinel PM2 watches so the bot picks up a config change.
 * PM2 watches this file rather than the JSON, because the bot rewrites its own
 * JSON on every token refresh (see addToEcosystem).
 */
function touchReload(channel: string): void {
  const p = path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${channel}.reload`);
  try {
    fs.writeFileSync(p, new Date().toISOString());
  } catch (e) {
    console.error(`[INTERNAL] Failed to touch reload sentinel for ${channel}:`, e instanceof Error ? e.message : String(e));
  }
}

/**
 * A stop the owner or an admin chose that is still in force, or null.
 *
 * Managers may bring back a bot that crashed, but not one the broadcaster
 * switched off. A process started after the stop — by the owner, the pm2 CLI or
 * a resurrect on reboot — has a newer pm_uptime, which retires the record
 * without anything having to clear it.
 */
function deliberateStop(config: Record<string, unknown> | null, proc: Pm2Proc | undefined): { by: string | null; at: string } | null {
  const stop = config?.['stopped'] as { by?: unknown; at?: unknown } | undefined;
  if (!stop || typeof stop.at !== 'string') return null;
  const at = Date.parse(stop.at);
  if (!Number.isFinite(at)) return null;
  if (proc?.pm2_env?.status === 'online') return null;
  if ((proc?.pm2_env?.pm_uptime ?? 0) > at) return null;
  return { by: typeof stop.by === 'string' ? stop.by : null, at: stop.at };
}

function summariseChannel(channel: string, procs: Pm2Proc[]): Record<string, unknown> {
  const config = readChannelConfig(channel);
  const proc = procs.find(p => p.name === `kick-${channel}`);
  const oauth = config?.['oauth'] as { accessToken?: string; expiresAt?: number } | undefined;
  const enrolledAt = typeof config?.['enrolledAt'] === 'string' ? Date.parse(config['enrolledAt'] as string) : null;
  const grantExpiresAt = enrolledAt ? enrolledAt + GRANT_LIFETIME_MS_API : null;

  return {
    channel,
    exists: config !== null,
    deployed: !!proc,
    status: proc?.pm2_env?.status ?? 'not-deployed',
    uptimeMs: proc?.pm2_env?.status === 'online' && proc.pm2_env.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : null,
    restarts: proc?.pm2_env?.restart_time ?? null,
    unstableRestarts: proc?.pm2_env?.unstable_restarts ?? null,
    memoryBytes: proc?.monit?.memory ?? null,
    cpu: proc?.monit?.cpu ?? null,
    broadcasterUserId: config?.['broadcasterUserId'] ?? null,
    chatroomId: config?.['chatroomId'] ?? null,
    chatOnly: config?.['chatOnly'] === true,
    enrolledAt: config?.['enrolledAt'] ?? null,
    lastUpdated: config?.['lastUpdated'] ?? null,
    // As the modules spell them, so the dashboard's toggles match; names with no
    // module left are dropped rather than failing every later save as "unknown".
    excludedCommands: Array.isArray(config?.['excludedCommands'])
      ? canonicalCommandNames(config['excludedCommands'] as unknown[]).filter((c): c is string => c !== null)
      : [],
    managers: Array.isArray(config?.['managers']) ? config['managers'] : [],
    location: (config?.['location'] as unknown) ?? { home: {}, current: {} },
    autoTranslate: (config?.['autoTranslate'] as unknown) ?? null,
    claude: (config?.['claude'] as unknown) ?? null,
    claudeDefaults: CLAUDE_DEFAULTS,
    kpp: (config?.['kpp'] as unknown) ?? null,
    earnings: (config?.['earnings'] as unknown) ?? null,
    points: pointsView(config?.['points']),
    stopped: deliberateStop(config, proc),
    token: {
      hasChannelOAuth: !!oauth?.accessToken,
      accessTokenExpiresAt: oauth?.expiresAt ?? null,
      grantExpiresAt,
      grantDaysLeft: grantExpiresAt ? Math.max(0, (grantExpiresAt - Date.now()) / (24 * 60 * 60 * 1000)) : null
    }
  };
}

// List every enrolled channel with live pm2 state.
app.get('/internal/bot/channels', internalGuard(false), async (_req, res) => {
  const dir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  let channels: string[] = [];
  try {
    channels = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json')).sort();
  } catch {
    channels = [];
  }
  const procs = await pm2List();
  res.json({
    channels: channels.map(c => summariseChannel(c, procs)),
    availableCommands: listAvailableCommands(),
    maxChannels: MAX_CHANNELS
  });
});

// ── Clip session ────────────────────────────────────────────────────────────
// !clip drives Kick's internal API with a browser session token, which is not the
// same credential as the OAuth token the dashboard logs in with and cannot be
// derived from it. Kick rate-limits logins from this host, so the token is pasted
// by hand; these routes let that happen in the dashboard instead of over SSH.
// The token is write-only here: it is never read back to the browser.

app.get('/internal/clip-session', internalGuard(false), (_req, res) => {
  return res.json(clipSessionStatus());
});

app.post('/internal/clip-session', internalGuard(true), async (req, res) => {
  const body = (req.body ?? {}) as { token?: unknown };
  if (typeof body.token !== 'string' || !body.token.trim()) {
    return res.status(400).json({ error: 'A session token is required' });
  }
  const result = await installClipToken(body.token);
  if (!result.ok) {
    return res.status(400).json({
      error: result.reason === 'malformed'
        ? "That doesn't look like a session token. Paste the cookie value, or the whole session_token:\"…\" line — either works."
        : 'Kick rejected that token. Copy a fresh one and close the window without logging out.',
      reason: result.reason
    });
  }
  console.log('[CLIP] a new session token was installed from the dashboard');
  return res.json({ ok: true, ...result.status });
});

// One channel's detail.
app.get('/internal/bot/:channel', internalGuard(false), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const procs = await pm2List();
  const summary = summariseChannel(channel, procs);
  if (!summary.exists) return res.status(404).json({ error: 'Not enrolled' });
  return res.json({ ...summary, availableCommands: listAvailableCommands() });
});

// start | stop | restart the channel's bot process.
// Body: { action, actor?: { username, role: 'owner' | 'admin' | 'manager' } }
app.post('/internal/bot/:channel/control', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const body = (req.body ?? {}) as { action?: string; actor?: { username?: unknown; role?: unknown } };
  const action = body.action;
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return res.status(400).json({ error: 'action must be start, stop or restart' });
  }
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  // The dashboard authorizes the user and says who it is. A caller that doesn't
  // say is treated as the owner, which is what every call was before managers.
  const actorName = typeof body.actor?.username === 'string' ? body.actor.username.slice(0, 25) : null;
  const isManager = body.actor?.role === 'manager';

  const pm2Name = `kick-${channel}`;
  const stop = deliberateStop(config, (await pm2List()).find(p => p.name === pm2Name));
  if (isManager && action === 'stop') {
    return res.status(403).json({ error: 'Only the broadcaster can stop the bot' });
  }
  if (isManager && stop) {
    return res.status(403).json({ error: `${stop.by ?? 'The broadcaster'} stopped this bot — only the broadcaster can start it again` });
  }

  if (stop) {
    // Cleared before starting, while the process is down: once the bot runs it
    // rewrites this file on token refresh, and a write racing that can lose a token.
    const fresh = readChannelConfig(channel);
    if (fresh) {
      delete fresh['stopped'];
      writeChannelConfig(channel, fresh);
    }
  }

  const result = await execAsync(`pm2 ${action} "${pm2Name}"`);
  if (!result.ok) {
    console.error(`[INTERNAL] pm2 ${action} ${pm2Name} failed: ${result.message}`);
    if (stop) {
      // The bot didn't come back, so the owner's stop still stands. Without the record
      // put back, a failed start left managers able to start what the broadcaster switched off.
      const fresh = readChannelConfig(channel);
      if (fresh && !fresh['stopped']) {
        fresh['stopped'] = { by: stop.by, at: stop.at };
        writeChannelConfig(channel, fresh);
      }
    }
    return res.status(500).json({ error: `pm2 ${action} failed`, details: result.message });
  }
  if (action === 'stop') {
    // Written once the process is down, for the same reason.
    const fresh = readChannelConfig(channel);
    if (fresh) {
      fresh['stopped'] = { by: actorName, at: new Date().toISOString() };
      writeChannelConfig(channel, fresh);
    }
  }
  console.log(`[INTERNAL] pm2 ${action} ${pm2Name} OK${actorName ? ` (by ${actorName})` : ''}`);
  const procs = await pm2List();
  return res.json({ ok: true, action, ...summariseChannel(channel, procs) });
});

// Replace the excluded-command list. Body: { excludedCommands: string[] }
app.post('/internal/bot/:channel/commands', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const body = req.body as { excludedCommands?: unknown };
  if (!Array.isArray(body?.excludedCommands)) {
    return res.status(400).json({ error: 'excludedCommands must be an array' });
  }

  // Only accept names that correspond to real command modules — a typo here
  // would otherwise sit in the config forever doing nothing. Matched ignoring
  // case and stored as the module spells it: lowercased, customC matched nothing.
  const canonical = canonicalCommandNames(body.excludedCommands);
  const unknown = body.excludedCommands.filter((_, i) => canonical[i] === null).map(c => String(c));
  if (unknown.length > 0) {
    return res.status(400).json({ error: `Unknown commands: ${unknown.join(', ')}` });
  }
  const requested = Array.from(new Set(canonical as string[])).sort();

  config['excludedCommands'] = requested;
  config['lastUpdated'] = new Date().toISOString();
  writeChannelConfig(channel, config);
  touchReload(channel);
  console.log(`[INTERNAL] ${channel} excludedCommands set to [${requested.join(', ')}] — reload triggered`);

  const procs = await pm2List();
  return res.json({ ok: true, ...summariseChannel(channel, procs) });
});

// ---- Custom commands --------------------------------------------------------
// The same data !acomm / !ecomm / !dcomm manage from chat:
// data/custom-commands/<channel>.json, a map of name → [access, response, counter].
// The bot reads that file on every chat message, so edits apply without a
// restart. Validation mirrors bot-commands/customC.ts so a command made here
// behaves exactly like one made in chat.

type CustomCommandTuple = [string, string, number];

/** n = everyone, v = VIPs and up, y = moderators and up. */
const CUSTOM_COMMAND_ACCESS = ['n', 'v', 'y'];

function customCommandsPath(channel: string): string {
  return path.join(KICK_BASE_PATH, 'data', 'custom-commands', `${channel}.json`);
}

/**
 * A missing file is an empty set; a file that fails to parse throws. The bot
 * rewrites this file non-atomically every time a command runs, and reading a
 * half-written file as "no commands" would let the next save wipe them all.
 */
function readCustomCommands(channel: string): Record<string, CustomCommandTuple> {
  let raw: string;
  try {
    raw = fs.readFileSync(customCommandsPath(channel), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('custom commands file is not a JSON object');
  }
  return parsed as Record<string, CustomCommandTuple>;
}

function writeCustomCommands(channel: string, commands: Record<string, CustomCommandTuple>): void {
  const p = customCommandsPath(channel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(commands, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function listCustomCommands(commands: Record<string, CustomCommandTuple>) {
  return Object.keys(commands).sort().map(name => {
    const [access, response, counter] = commands[name];
    return { name, access, response, counter: Number.isFinite(counter) ? counter : 0 };
  });
}

function hasCustomCommand(commands: Record<string, CustomCommandTuple>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(commands, name);
}

function customCommandsUnreadable(res: express.Response, channel: string, e: unknown): express.Response {
  console.error(`[INTERNAL] ${channel} custom commands unreadable:`, e instanceof Error ? e.message : String(e));
  return res.status(500).json({ error: 'Could not read the custom commands file — try again in a moment' });
}

app.get('/internal/bot/:channel/custom-commands', internalGuard(false), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  try {
    return res.json({ commands: listCustomCommands(readCustomCommands(channel)) });
  } catch (e) {
    return customCommandsUnreadable(res, channel, e);
  }
});

/**
 * Add, edit or rename one command.
 *
 * Body: { name, access, response, counter?, originalName? }
 * `originalName` marks an edit (and a rename when it differs from `name`).
 * Omitting `counter` keeps the stored count, so saving from a page loaded an
 * hour ago doesn't roll back the uses chat has racked up since.
 */
app.post('/internal/bot/:channel/custom-commands', internalGuard(true), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const name = typeof body['name'] === 'string' ? body['name'].trim().replace(/^!/, '').toLowerCase() : '';
  if (!/^[a-z0-9]{3,25}$/.test(name)) {
    return res.status(400).json({ error: 'Command name must be 3–25 letters or digits' });
  }
  const access = typeof body['access'] === 'string' ? body['access'] : '';
  if (!CUSTOM_COMMAND_ACCESS.includes(access)) {
    return res.status(400).json({ error: 'access must be n (everyone), v (VIPs and up) or y (mods and up)' });
  }
  // customC strips angle brackets from responses; do the same so what's saved is what chat sees.
  const response = typeof body['response'] === 'string' ? body['response'].replace(/[<>]/g, '').trim() : '';
  if (!response) return res.status(400).json({ error: 'Response cannot be empty' });
  if (response.length > 500) return res.status(400).json({ error: 'Response must be 500 characters or fewer' });
  // A /timeout response is carried out by the bot through Kick's API (see customC).
  // Reject a malformed one here, where the author can fix it, not later in chat.
  if (/^\/timeout\b/i.test(response)) {
    const m = /^\/timeout\s+@*(\$user1|\$user2|[A-Za-z0-9_]{2,25})\s+(\d{1,6})([smhd]?)(\s|$)/i.exec(response);
    if (!m) {
      return res.status(400).json({ error: 'A /timeout response needs a user and a duration, e.g. /timeout $user1 1m' });
    }
    // The limits customC enforces in chat. Without them a 0 or an 8d saved fine
    // here and then failed every time someone used the command.
    const unit = (m[3] || 'm').toLowerCase();
    const seconds = Number(m[2]) * (unit === 's' ? 1 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 60);
    if (seconds < 1 || seconds > 7 * 24 * 60 * 60) {
      return res.status(400).json({ error: 'A /timeout duration must be between 1 second and 7 days' });
    }
  }

  let counter: number | undefined;
  if (body['counter'] !== undefined && body['counter'] !== null) {
    const c = body['counter'];
    if (typeof c !== 'number' || !Number.isInteger(c) || c < 0) {
      return res.status(400).json({ error: 'Counter must be a whole number, 0 or more' });
    }
    counter = c;
  }
  const originalName = typeof body['originalName'] === 'string' ? body['originalName'].toLowerCase() : null;

  let commands: Record<string, CustomCommandTuple>;
  try {
    commands = readCustomCommands(channel);
  } catch (e) {
    return customCommandsUnreadable(res, channel, e);
  }

  if (originalName && !hasCustomCommand(commands, originalName)) {
    return res.status(404).json({ error: `!${originalName} no longer exists — it may have been deleted from chat` });
  }
  const renaming = originalName !== null && originalName !== name;
  if ((originalName === null || renaming) && hasCustomCommand(commands, name)) {
    return res.status(409).json({ error: `!${name} already exists` });
  }

  const previous = originalName ? commands[originalName] : undefined;
  const keptCounter = counter ?? (previous && Number.isFinite(previous[2]) ? previous[2] : 0);
  if (renaming) delete commands[originalName];
  commands[name] = [access, response, keptCounter];

  try {
    writeCustomCommands(channel, commands);
  } catch (e) {
    console.error(`[INTERNAL] ${channel} custom command save failed:`, e instanceof Error ? e.message : String(e));
    return res.status(500).json({ error: 'Could not save the command' });
  }
  const verb = originalName === null ? 'added' : renaming ? `renamed from !${originalName}` : 'updated';
  console.log(`[INTERNAL] ${channel} custom command !${name} ${verb}`);
  return res.json({ ok: true, commands: listCustomCommands(commands) });
});

app.delete('/internal/bot/:channel/custom-commands/:name', internalGuard(true), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  const nameRaw = req.params['name'];
  const name = (typeof nameRaw === 'string' ? nameRaw : '').toLowerCase();

  let commands: Record<string, CustomCommandTuple>;
  try {
    commands = readCustomCommands(channel);
  } catch (e) {
    return customCommandsUnreadable(res, channel, e);
  }
  if (!hasCustomCommand(commands, name)) {
    return res.status(404).json({ error: `!${name} does not exist` });
  }

  delete commands[name];
  try {
    writeCustomCommands(channel, commands);
  } catch (e) {
    console.error(`[INTERNAL] ${channel} custom command delete failed:`, e instanceof Error ? e.message : String(e));
    return res.status(500).json({ error: 'Could not delete the command' });
  }
  console.log(`[INTERNAL] ${channel} custom command !${name} deleted`);
  return res.json({ ok: true, commands: listCustomCommands(commands) });
});

// ---- Channel point rewards ----------------------------------------------------
// Backs the dashboard's rewards card: the channel's rewards as Kick has them,
// each with the bot action attached (`rewardActions` in the channel config).
// The bot reads rewardActions on every redemption, so a change here applies to
// the next one without a restart.

const KICK_API = 'https://api.kick.com/public/v1';
const REWARD_ACTION_KINDS = ['timeout', 'roulette', 'pardon', 'shield'];
const MAX_REWARD_ACTION_SECONDS = 7 * 24 * 60 * 60;

interface KickReward {
  id: string;
  title: string;
  cost: number;
  description: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
}

type RewardActionEntry = Record<string, unknown> & { rewardId?: string; rewardTitle?: string };

class KickCallError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Call Kick as the channel's streamer.
 *
 * Deliberately never refreshes the token: Kick rotates refresh tokens, so a
 * refresh from this process would leave the channel's bot holding a dead one.
 * The bot refreshes well before expiry; a token about to lapse is reported as
 * a short wait instead.
 */
async function kickAsStreamer<T>(channel: string, method: 'get' | 'post' | 'patch' | 'delete', urlPath: string, body?: unknown): Promise<T> {
  const oauth = readChannelConfig(channel)?.['oauth'] as { accessToken?: string; expiresAt?: number } | undefined;
  if (!oauth?.accessToken) {
    throw new KickCallError(`${channel} has not authorized the bot with Kick, so its rewards can't be managed`, 409);
  }
  if (oauth.expiresAt && oauth.expiresAt < Date.now() + 60_000) {
    // Well past expiry means nothing is refreshing it, and "try again in a minute"
    // would repeat forever for a stopped bot or a dead grant.
    if (oauth.expiresAt < Date.now() - 5 * 60_000) {
      throw new KickCallError(
        `${channel}'s Kick token expired and hasn't been refreshed — start the bot if it's stopped, or have the streamer re-authorize`,
        503
      );
    }
    throw new KickCallError(`${channel}'s Kick token is being refreshed by the bot — try again in a minute`, 503);
  }
  try {
    const res = await axios.request({
      method,
      url: `${KICK_API}${urlPath}`,
      data: body,
      timeout: 10_000,
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' }
    });
    return res.data as T;
  } catch (e) {
    if (!axios.isAxiosError(e)) throw e;
    const status = e.response?.status;
    const detail = (e.response?.data as { message?: string } | undefined)?.message || e.message;
    if (status === 401) throw new KickCallError(`Kick rejected ${channel}'s token (${detail}) — the streamer may need to re-authorize`, 401);
    if (status === 403) throw new KickCallError(`Kick refused: ${detail}. That reward belongs to another app, and Kick only lets that app change it`, 403);
    if (status === 400 || status === 404) throw new KickCallError(`Kick: ${detail}`, status);
    throw new KickCallError(`Kick is not responding properly (${status ?? 'no response'}: ${detail})`, 502);
  }
}

/** Kick returns text HTML-escaped: "T's" arrives as "T&#39;s". */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function rewardActionsOf(config: Record<string, unknown>): RewardActionEntry[] {
  return Array.isArray(config['rewardActions']) ? (config['rewardActions'] as RewardActionEntry[]) : [];
}

/**
 * Which rewards this channel's token may edit, as far as Kick has said.
 *
 * Kick's docs say only the app that created a reward can change it. In practice
 * that means another third-party app: rewards made in Kick's own settings accept
 * edits from the streamer's token (verified 2026-09-10). The reward list doesn't
 * carry the flag, but redemption history does (`reward.can_manage`), so it is read
 * from there and a reward with no history is assumed editable. Kick still has the
 * final say: a refused edit comes back as a 403.
 */
async function rewardManageability(channel: string): Promise<Map<string, boolean>> {
  const flags = new Map<string, boolean>();
  const pages = await Promise.allSettled(['pending', 'accepted', 'rejected'].map(status =>
    kickAsStreamer<{ data?: Array<{ reward?: { id?: string; can_manage?: boolean } }> }>(
      channel, 'get', `/channels/rewards/redemptions?status=${status}`
    )
  ));
  for (const page of pages) {
    if (page.status !== 'fulfilled') continue;
    for (const group of page.value.data ?? []) {
      if (group.reward?.id && typeof group.reward.can_manage === 'boolean') {
        flags.set(group.reward.id, group.reward.can_manage);
      }
    }
  }
  return flags;
}

/** Whether a config entry applies to a reward: pinned by id, or the legacy title match the bot also honours. */
function actionMatchesReward(entry: RewardActionEntry, reward: { id: string; title: string }): boolean {
  if (entry.rewardId) return entry.rewardId === reward.id;
  return !!entry.rewardTitle && !!reward.title && reward.title.toLowerCase().includes(entry.rewardTitle.toLowerCase());
}

/**
 * Replace whatever the bot would match to this reward with `entry`, or with nothing.
 *
 * The bot prefers an entry pinned by id over any title match, so saving one only
 * clears legacy title-only entries whose title is exactly this reward's. Clearing
 * by substring deleted unrelated ones: configuring "Timeout roulette" removed a
 * legacy entry meant for a reward titled "Timeout". Removing the action still
 * clears every entry that matches, or the reward would keep acting.
 */
function putRewardAction(channel: string, reward: { id: string; title: string }, entry: RewardActionEntry | null): void {
  const config = readChannelConfig(channel);
  if (!config) return;
  const title = reward.title.toLowerCase();
  const kept = rewardActionsOf(config).filter(a => {
    if (a.rewardId) return a.rewardId !== reward.id;
    if (!entry) return !actionMatchesReward(a, reward);
    return !a.rewardTitle || !title || a.rewardTitle.toLowerCase() !== title;
  });
  if (entry) kept.push(entry);
  config['rewardActions'] = kept;
  writeChannelConfig(channel, config);
}

/** Validate a bot action from the dashboard into the shape the bot reads. */
function validateRewardAction(input: unknown, rewardId: string): { entry?: RewardActionEntry; error?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'action must be an object or null' };
  const a = input as Record<string, unknown>;
  const kind = a['action'];
  if (typeof kind !== 'string' || !REWARD_ACTION_KINDS.includes(kind)) {
    return { error: `action must be one of ${REWARD_ACTION_KINDS.join(', ')}` };
  }
  const entry: RewardActionEntry = { rewardId, action: kind };
  if (kind !== 'pardon') {
    const d = a['durationSeconds'];
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > MAX_REWARD_ACTION_SECONDS) {
      return { error: 'Duration must be a whole number of seconds, up to 7 days' };
    }
    entry['durationSeconds'] = d;
  }
  if (kind === 'shield' && a['reflect'] === true) entry['reflect'] = true;
  entry['announce'] = a['announce'] !== false;
  if (a['testMode'] === true) {
    entry['testMode'] = true;
    const td = a['testDurationSeconds'];
    if (td !== undefined && td !== null) {
      if (typeof td !== 'number' || !Number.isInteger(td) || td < 1 || td > 3600) {
        return { error: 'Test length must be 1–3600 seconds' };
      }
      entry['testDurationSeconds'] = td;
    }
    const testers = a['testRedeemers'];
    if (testers !== undefined && testers !== null) {
      if (!Array.isArray(testers) || testers.length > 20 ||
          testers.some(t => typeof t !== 'string' || !/^@?[A-Za-z0-9_]{2,25}$/.test(t))) {
        return { error: 'Testers must be up to 20 Kick usernames' };
      }
      entry['testRedeemers'] = (testers as string[]).map(t => t.replace(/^@/, '').toLowerCase());
    }
  }
  return { entry };
}

/** Kick's own reward fields from a request body. Creating requires a title and cost. */
function kickRewardFields(input: unknown, creating: boolean): { fields?: Record<string, unknown>; error?: string } {
  const src = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  if (creating || src['title'] !== undefined) {
    const title = typeof src['title'] === 'string' ? src['title'].trim() : '';
    if (!title || title.length > 50) return { error: 'Title must be 1–50 characters' };
    fields['title'] = title;
  }
  if (creating || src['cost'] !== undefined) {
    const cost = src['cost'];
    if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 1) {
      return { error: 'Cost must be a whole number of points, 1 or more' };
    }
    fields['cost'] = cost;
  }
  if (src['description'] !== undefined) {
    if (typeof src['description'] !== 'string' || src['description'].length > 200) {
      return { error: 'Description must be 200 characters or fewer' };
    }
    fields['description'] = src['description'];
  }
  if (src['background_color'] !== undefined) {
    if (typeof src['background_color'] !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(src['background_color'])) {
      return { error: 'Colour must look like #53FC18' };
    }
    fields['background_color'] = src['background_color'];
  }
  for (const key of ['is_enabled', 'is_paused', 'is_user_input_required', 'should_redemptions_skip_request_queue']) {
    if (src[key] === undefined) continue;
    if (typeof src[key] !== 'boolean') return { error: `${key} must be true or false` };
    if (creating && key === 'is_paused') continue;   // Kick's create call has no pause flag
    fields[key] = src[key];
  }
  return { fields };
}

/** Everything the rewards card shows: Kick's rewards with their bot actions, plus granted scopes. */
async function rewardsPayload(channel: string): Promise<Record<string, unknown>> {
  const [kick, manageable] = await Promise.all([
    kickAsStreamer<{ data?: KickReward[] }>(channel, 'get', '/channels/rewards'),
    rewardManageability(channel)
  ]);
  const config = readChannelConfig(channel) ?? {};
  const actions = rewardActionsOf(config);
  const rewards = (kick.data ?? []).map(r => {
    const title = decodeHtmlEntities(r.title ?? '');
    const pinned = actions.find(a => a.rewardId === r.id);
    const byTitle = pinned ? undefined : actions.find(a => !a.rewardId && actionMatchesReward(a, { id: r.id, title }));
    return {
      ...r,
      title,
      description: decodeHtmlEntities(r.description ?? ''),
      canManage: manageable.get(r.id) ?? true,
      action: pinned ?? byTitle ?? null,
      actionPinned: !!pinned
    };
  });
  // Actions pointing at a reward that's gone from Kick, so the card can offer to clean them up.
  const orphaned = actions.filter(a => a.rewardId && !rewards.some(r => r.id === a.rewardId));

  let scopes: string[] = [];
  try {
    const intro = await kickAsStreamer<{ data?: { scope?: string } }>(channel, 'post', '/token/introspect');
    scopes = String(intro.data?.scope ?? '').split(/\s+/).filter(Boolean);
  } catch {
    // Unknown scopes just mean the card can't warn about missing ones.
  }
  return { rewards, orphaned, scopes };
}

function rewardsError(res: express.Response, channel: string, e: unknown): express.Response {
  if (e instanceof KickCallError) return res.status(e.status).json({ error: e.message });
  console.error(`[INTERNAL] ${channel} rewards request failed:`, e instanceof Error ? e.message : String(e));
  return res.status(500).json({ error: 'Rewards request failed' });
}

/**
 * Answer a reward change Kick has already accepted. Reloading the list afterwards
 * can still fail, and reporting that as an error invited a retry — which created
 * a second copy of a reward that was made the first time. The change stands, so
 * say it did and let the card reload.
 */
async function rewardsChangedResponse(res: express.Response, channel: string, extra: Record<string, unknown> = {}): Promise<express.Response> {
  try {
    return res.json({ ok: true, ...extra, ...(await rewardsPayload(channel)) });
  } catch (e) {
    console.error(`[INTERNAL] ${channel} reward change saved, but reloading the list failed:`, e instanceof Error ? e.message : String(e));
    return res.json({ ok: true, ...extra, reloadFailed: true });
  }
}

function validRewardId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9]{10,40}$/.test(id);
}

app.get('/internal/bot/:channel/rewards', internalGuard(false), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });
  try {
    return res.json(await rewardsPayload(channel));
  } catch (e) {
    return rewardsError(res, channel, e);
  }
});

// Create a reward on Kick, optionally with a bot action. Body: { reward: {Kick fields}, action?: {...} | null }
app.post('/internal/bot/:channel/rewards', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const { fields, error } = kickRewardFields(body['reward'], true);
  if (error || !fields) return res.status(400).json({ error });
  // Validate the action before touching Kick, so a bad one can't leave a half-made reward.
  let entry: RewardActionEntry | null = null;
  if (body['action'] !== undefined && body['action'] !== null) {
    const v = validateRewardAction(body['action'], 'pending');
    if (v.error || !v.entry) return res.status(400).json({ error: v.error });
    entry = v.entry;
  }

  try {
    const created = await kickAsStreamer<{ data?: KickReward }>(channel, 'post', '/channels/rewards', fields);
    const reward = created.data;
    if (!reward?.id) return res.status(502).json({ error: 'Kick did not return the new reward' });

    if (entry) {
      entry.rewardId = reward.id;
      putRewardAction(channel, { id: reward.id, title: decodeHtmlEntities(reward.title ?? '') }, entry);
    }
    console.log(`[INTERNAL] ${channel} reward "${reward.title}" (${reward.id}) created${entry ? ` with ${String(entry['action'])} action` : ''}`);
    return rewardsChangedResponse(res, channel, { id: reward.id });
  } catch (e) {
    return rewardsError(res, channel, e);
  }
});

// Update a reward on Kick and/or its bot action. Body: { reward?: {Kick fields}, action?: {...} | null }
app.patch('/internal/bot/:channel/rewards/:rewardId', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });
  const rewardId = req.params['rewardId'];
  if (!validRewardId(rewardId)) return res.status(400).json({ error: 'Invalid reward id' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  let fields: Record<string, unknown> = {};
  if (body['reward'] !== undefined && body['reward'] !== null) {
    const r = kickRewardFields(body['reward'], false);
    if (r.error || !r.fields) return res.status(400).json({ error: r.error });
    fields = r.fields;
  }
  const changesAction = Object.prototype.hasOwnProperty.call(body, 'action');
  let entry: RewardActionEntry | null = null;
  if (changesAction && body['action'] !== null) {
    const v = validateRewardAction(body['action'], rewardId);
    if (v.error || !v.entry) return res.status(400).json({ error: v.error });
    entry = v.entry;
  }
  if (Object.keys(fields).length === 0 && !changesAction) {
    return res.status(400).json({ error: 'Nothing to change' });
  }

  try {
    if (Object.keys(fields).length > 0) {
      await kickAsStreamer(channel, 'patch', `/channels/rewards/${rewardId}`, fields);
    }
    if (changesAction) {
      const list = await kickAsStreamer<{ data?: KickReward[] }>(channel, 'get', '/channels/rewards');
      const reward = (list.data ?? []).find(r => r.id === rewardId);
      if (!reward && entry) return res.status(404).json({ error: 'That reward no longer exists on Kick' });
      putRewardAction(channel, { id: rewardId, title: reward ? decodeHtmlEntities(reward.title ?? '') : '' }, entry);
    }
    const what = [Object.keys(fields).length ? `fields ${Object.keys(fields).join(',')}` : '', changesAction ? `action ${entry ? String(entry['action']) : 'removed'}` : '']
      .filter(Boolean).join('; ');
    console.log(`[INTERNAL] ${channel} reward ${rewardId} updated: ${what}`);
    return rewardsChangedResponse(res, channel);
  } catch (e) {
    return rewardsError(res, channel, e);
  }
});

// Delete a reward from Kick, along with its bot action.
app.delete('/internal/bot/:channel/rewards/:rewardId', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });
  const rewardId = req.params['rewardId'];
  if (!validRewardId(rewardId)) return res.status(400).json({ error: 'Invalid reward id' });

  try {
    await kickAsStreamer(channel, 'delete', `/channels/rewards/${rewardId}`);
    const config = readChannelConfig(channel);
    if (config) {
      config['rewardActions'] = rewardActionsOf(config).filter(a => a.rewardId !== rewardId);
      writeChannelConfig(channel, config);
    }
    console.log(`[INTERNAL] ${channel} reward ${rewardId} deleted`);
    return rewardsChangedResponse(res, channel);
  } catch (e) {
    return rewardsError(res, channel, e);
  }
});

// ---- Loyalty points -----------------------------------------------------------
// Backs the dashboard's Points card and the public leaderboard. Balances live in
// data/points/<channel>/points.sqlite, written by the channel's bot; these routes
// read it and apply dashboard adjustments through src/points/store.ts. None of
// them create a database for a channel that has never earned anything.

/** Points settings as the API reports them: defaults applied, plus the chat command word. */
function pointsView(raw: unknown): Record<string, unknown> {
  const cfg = effectivePointsConfig(raw);
  return { ...cfg, effectiveCommand: effectiveCommand(cfg) };
}

function broadcasterIdOf(config: Record<string, unknown>): number | null {
  const id = config['broadcasterUserId'];
  return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

/**
 * Words a currency command can't take in a channel: command modules, the inline
 * !location and !config, and the channel's custom commands. The points module is
 * left out, since its trigger is the currency command itself.
 */
function pointsReservedWords(channel: string): string[] {
  const words = listAvailableCommands().filter(c => c.toLowerCase() !== 'points');
  words.push('location', 'config');
  try {
    words.push(...Object.keys(readCustomCommands(channel)));
  } catch {
    // Unreadable custom commands: the module names are still checked.
  }
  return words;
}

function pointsUnavailable(res: express.Response, channel: string, e: unknown): express.Response {
  console.error(`[INTERNAL] ${channel} points request failed:`, e instanceof Error ? e.message : String(e));
  return res.status(500).json({ error: 'Points data is unavailable right now — try again in a moment' });
}

const POINTS_REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

app.get('/internal/bot/:channel/points', internalGuard(false), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const cfg = effectivePointsConfig(config['points']);
  try {
    return res.json({
      enabled: cfg.enabled,
      currencyName: cfg.currencyName,
      effectiveCommand: effectiveCommand(cfg),
      ...pointsSummary(channel),
      subscriptions: readSubscriptionStatus(channel) ?? {}
    });
  } catch (e) {
    return pointsUnavailable(res, channel, e);
  }
});

// Prefix search by username; no q lists the top balances. ?q=&limit=1-50
app.get('/internal/bot/:channel/points/users', internalGuard(false), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const q = (typeof req.query['q'] === 'string' ? req.query['q'] : '').trim().replace(/^@+/, '').toLowerCase();
  if (q && !/^[a-z0-9_]{1,25}$/.test(q)) return res.status(400).json({ error: 'q must be the start of a Kick username' });
  const limitRaw = Number(req.query['limit'] ?? 20);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 50 ? limitRaw : 20;

  try {
    const cfg = effectivePointsConfig(config['points']);
    return res.json({ users: searchPointsUsers(channel, cfg, q, limit, broadcasterIdOf(config)) });
  } catch (e) {
    return pointsUnavailable(res, channel, e);
  }
});

app.get('/internal/bot/:channel/points/users/:userId', internalGuard(false), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const userIdRaw = req.params['userId'];
  const userId = typeof userIdRaw === 'string' && /^\d{1,15}$/.test(userIdRaw) ? Number(userIdRaw) : 0;
  if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ error: 'Invalid user id' });

  try {
    const cfg = effectivePointsConfig(config['points']);
    const detail = getPointsUserDetail(channel, cfg, userId, broadcasterIdOf(config));
    if (!detail) return res.status(404).json({ error: `No viewer with id ${userId}` });
    return res.json(detail);
  } catch (e) {
    return pointsUnavailable(res, channel, e);
  }
});

/**
 * Add, remove or set a viewer's balance from the dashboard.
 *
 * Body: { userId, mode: add|remove|set, amount, reason (3–200), actor: {username, role}, requestId (uuid) }
 * The dashboard authorizes the user and names them in `actor`. `requestId` makes a
 * double-submit, or a retry after a timeout, apply once (`applied: false` on repeats).
 */
app.post('/internal/bot/:channel/points/adjust', internalGuard(true), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const actor = body['actor'] as { username?: unknown; role?: unknown } | undefined;
  const actorName = typeof actor?.username === 'string' ? actor.username.trim() : '';
  const role = actor?.role;
  if (!/^[A-Za-z0-9_]{1,25}$/.test(actorName) || (role !== 'owner' && role !== 'admin' && role !== 'manager')) {
    return res.status(400).json({ error: 'actor must be { username, role: owner, admin or manager }' });
  }
  const requestId = body['requestId'];
  if (typeof requestId !== 'string' || !POINTS_REQUEST_ID_RE.test(requestId)) {
    return res.status(400).json({ error: 'requestId must be a UUID' });
  }
  const mode = body['mode'];
  if (mode !== 'add' && mode !== 'remove' && mode !== 'set') {
    return res.status(400).json({ error: 'mode must be add, remove or set' });
  }

  try {
    const cfg = effectivePointsConfig(config['points']);
    const result = adjustPoints(channel, cfg, {
      // adjustPoints checks these are whole numbers and the reason's length.
      userId: body['userId'] as number,
      mode,
      amount: body['amount'] as number,
      reason: typeof body['reason'] === 'string' ? body['reason'] : '',
      actor: `dashboard:${actorName.toLowerCase()}:${role}`,
      requestId
    }, broadcasterIdOf(config));
    if ('error' in result) return res.status(result.status).json({ error: result.error });
    console.log(
      `[INTERNAL] ${channel} points ${mode} ${String(body['amount'])} for ${result.user.username} (${result.user.userId}) ` +
      `by ${actorName} (${role})${result.applied ? '' : ' — repeat of an applied request, nothing changed'}`
    );
    return res.json({ ok: true, applied: result.applied, user: result.user });
  } catch (e) {
    return pointsUnavailable(res, channel, e);
  }
});

/**
 * The public leaderboard's data: top balances and watch time, usernames only.
 * A 404 unless the channel is enrolled with points and the public page on. Kept
 * clear of summariseChannel, which lists pm2, because anyone can load the page.
 */
app.get('/internal/bot/:channel/points/leaderboard', internalGuard(false), (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const cfg = effectivePointsConfig(config['points']);
  if (!cfg.enabled || !cfg.publicLeaderboard) {
    return res.status(404).json({ error: 'This channel has no public leaderboard' });
  }
  const limitRaw = Number(req.query['limit'] ?? 100);
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 100 ? limitRaw : 100;

  try {
    const board = pointsLeaderboard(channel, cfg, limit, broadcasterIdOf(config));
    return res.json({ channel, currencyName: cfg.currencyName, updatedAt: new Date().toISOString(), ...board });
  } catch (e) {
    return pointsUnavailable(res, channel, e);
  }
});

/**
 * Patch channel settings. Every key is optional; only what's present is written,
 * and nested blocks merge rather than replace so fields this endpoint doesn't
 * expose (autoTranslate's shadow/debug options, for instance) survive an edit
 * made from the dashboard.
 *
 * Body: { chatOnly?, location?: {home?, current?}, autoTranslate?, kpp?, earnings?, claude?, points? }
 */
app.post('/internal/bot/:channel/settings', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const body = (req.body ?? {}) as Record<string, unknown>;
  const errors: string[] = [];
  const applied: string[] = [];

  const asBool = (v: unknown, name: string): boolean | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'boolean') { errors.push(`${name} must be a boolean`); return undefined; }
    return v;
  };
  /** Numbers accept null to mean "unset" where the bot treats null as uncalibrated. */
  const asNum = (v: unknown, name: string, min: number, max: number, nullable = false): number | null | undefined => {
    if (v === undefined) return undefined;
    if (v === null) {
      if (nullable) return null;
      errors.push(`${name} cannot be null`);
      return undefined;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${name} must be a number`); return undefined; }
    if (v < min || v > max) { errors.push(`${name} must be between ${min} and ${max}`); return undefined; }
    return v;
  };
  const asPlace = (v: unknown, name: string): string | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== 'string') { errors.push(`${name} must be a string`); return undefined; }
    const trimmed = v.trim();
    if (trimmed.length > 60) { errors.push(`${name} must be 60 characters or fewer`); return undefined; }
    return trimmed;
  };

  // ---- chatOnly -----------------------------------------------------------
  const chatOnly = asBool(body['chatOnly'], 'chatOnly');
  if (chatOnly !== undefined) { config['chatOnly'] = chatOnly; applied.push('chatOnly'); }

  // ---- location -----------------------------------------------------------
  if (body['location'] !== undefined) {
    const loc = body['location'];
    if (typeof loc !== 'object' || loc === null || Array.isArray(loc)) {
      errors.push('location must be an object');
    } else {
      const existing = (config['location'] ?? {}) as Record<string, Record<string, string>>;
      const next: Record<string, Record<string, string>> = {
        home: { ...(existing['home'] ?? {}) },
        current: { ...(existing['current'] ?? {}) }
      };
      for (const key of ['home', 'current'] as const) {
        const block = (loc as Record<string, unknown>)[key];
        if (block === undefined) continue;
        if (typeof block !== 'object' || block === null || Array.isArray(block)) {
          errors.push(`location.${key} must be an object`);
          continue;
        }
        for (const field of ['country', 'city', 'state', 'province'] as const) {
          const val = asPlace((block as Record<string, unknown>)[field], `location.${key}.${field}`);
          if (val !== undefined) next[key][field] = val;
        }
        applied.push(`location.${key}`);
      }
      config['location'] = next;
    }
  }

  // ---- autoTranslate ------------------------------------------------------
  if (body['autoTranslate'] !== undefined) {
    const at = body['autoTranslate'];
    if (typeof at !== 'object' || at === null || Array.isArray(at)) {
      errors.push('autoTranslate must be an object');
    } else {
      const src = at as Record<string, unknown>;
      const next = { ...((config['autoTranslate'] ?? {}) as Record<string, unknown>) };
      const enabled = asBool(src['enabled'], 'autoTranslate.enabled');
      if (enabled !== undefined) next['enabled'] = enabled;
      const logOnly = asBool(src['logOnly'], 'autoTranslate.logOnly');
      if (logOnly !== undefined) next['logOnly'] = logOnly;
      // Source-language allowlist. An empty array is meaningful: it clears the
      // restriction back to "every language but English". Codes are stored
      // normalised so the bot can compare them to Google's verdict directly.
      if (src['languages'] !== undefined) {
        const langs = src['languages'];
        if (langs === null) {
          next['languages'] = [];
        } else if (!Array.isArray(langs)) {
          errors.push('autoTranslate.languages must be an array of language codes');
        } else if (langs.length > 20) {
          errors.push('autoTranslate.languages must list 20 codes or fewer');
        } else {
          const cleaned: string[] = [];
          let bad = false;
          for (const raw of langs) {
            if (typeof raw !== 'string') { bad = true; break; }
            const code = raw.trim().toLowerCase().split('-')[0] ?? '';
            if (!/^[a-z]{2,3}$/.test(code)) { bad = true; break; }
            if (!cleaned.includes(code)) cleaned.push(code);
          }
          if (bad) {
            errors.push('autoTranslate.languages must contain 2- or 3-letter language codes, e.g. ["de"]');
          } else {
            next['languages'] = cleaned;
          }
        }
      }
      const minConfidence = asNum(src['minConfidence'], 'autoTranslate.minConfidence', 0, 1);
      if (minConfidence !== undefined && minConfidence !== null) next['minConfidence'] = minConfidence;
      const minLength = asNum(src['minLength'], 'autoTranslate.minLength', 0, 500);
      if (minLength !== undefined && minLength !== null) next['minLength'] = Math.round(minLength);
      const rate = asNum(src['rateLimitPerMinute'], 'autoTranslate.rateLimitPerMinute', 0, 600);
      if (rate !== undefined && rate !== null) next['rateLimitPerMinute'] = Math.round(rate);
      config['autoTranslate'] = next;
      applied.push('autoTranslate');
    }
  }

  // ---- kpp ----------------------------------------------------------------
  if (body['kpp'] !== undefined) {
    const k = body['kpp'];
    if (typeof k !== 'object' || k === null || Array.isArray(k)) {
      errors.push('kpp must be an object');
    } else {
      const src = k as Record<string, unknown>;
      const next = { ...((config['kpp'] ?? {}) as Record<string, unknown>) };
      const enabled = asBool(src['enabled'], 'kpp.enabled');
      if (enabled !== undefined) next['enabled'] = enabled;
      const dps = asNum(src['dollarPerScore'], 'kpp.dollarPerScore', 0, 1000, true);
      if (dps !== undefined) next['dollarPerScore'] = dps;
      const cnr = asNum(src['chatNormalRate'], 'kpp.chatNormalRate', 0.001, 1);
      if (cnr !== undefined && cnr !== null) next['chatNormalRate'] = cnr;
      const cvh = asNum(src['centsPerViewerHour'], 'kpp.centsPerViewerHour', 0, 10000, true);
      if (cvh !== undefined) next['centsPerViewerHour'] = cvh;
      const cavh = asNum(src['centsPerAuthViewerHour'], 'kpp.centsPerAuthViewerHour', 0, 10000, true);
      if (cavh !== undefined) next['centsPerAuthViewerHour'] = cavh;
      config['kpp'] = next;
      applied.push('kpp');
    }
  }

  // ---- earnings -----------------------------------------------------------
  if (body['earnings'] !== undefined) {
    const e = body['earnings'];
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      errors.push('earnings must be an object');
    } else {
      const src = e as Record<string, unknown>;
      const next = { ...((config['earnings'] ?? {}) as Record<string, unknown>) };
      const enabled = asBool(src['enabled'], 'earnings.enabled');
      if (enabled !== undefined) next['enabled'] = enabled;
      const cvh = asNum(src['centsPerViewerHour'], 'earnings.centsPerViewerHour', 0, 10000);
      if (cvh !== undefined && cvh !== null) next['centsPerViewerHour'] = cvh;
      config['earnings'] = next;
      applied.push('earnings');
    }
  }

  // ---- claude --------------------------------------------------------------
  if (body['claude'] !== undefined) {
    const c = body['claude'];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      errors.push('claude must be an object');
    } else {
      const src = c as Record<string, unknown>;
      const next = { ...((config['claude'] ?? {}) as Record<string, unknown>) };

      // null is meaningful: it means "fall back to the global default prompt".
      if (src['systemPrompt'] !== undefined) {
        const sp = src['systemPrompt'];
        if (sp === null) {
          next['systemPrompt'] = null;
        } else if (typeof sp !== 'string') {
          errors.push('claude.systemPrompt must be a string or null');
        } else if (sp.length > 6000) {
          errors.push('claude.systemPrompt must be 6000 characters or fewer');
        } else {
          next['systemPrompt'] = sp.trim() === '' ? null : sp;
        }
      }
      if (src['context'] !== undefined) {
        const ctx = src['context'];
        if (typeof ctx !== 'string') errors.push('claude.context must be a string');
        else if (ctx.length > 2000) errors.push('claude.context must be 2000 characters or fewer');
        else next['context'] = ctx;
      }
      if (src['settings'] !== undefined) {
        const st = src['settings'];
        if (typeof st !== 'object' || st === null || Array.isArray(st)) {
          errors.push('claude.settings must be an object');
        } else {
          const stSrc = st as Record<string, unknown>;
          const stNext = { ...((next['settings'] ?? {}) as Record<string, unknown>) };
          // null clears the override so the bot's default applies. Before, a field
          // emptied in the dashboard just went missing from the request and kept its value.
          const limits: Array<[string, number, number]> = [['rateLimit', 1, 500], ['burstRequests', 1, 50], ['cooldownMinutes', 0, 1440]];
          for (const [key, min, max] of limits) {
            const v = asNum(stSrc[key], `claude.settings.${key}`, min, max, true);
            if (v === null) delete stNext[key];
            else if (v !== undefined) stNext[key] = Math.round(v);
          }
          next['settings'] = stNext;
        }
      }
      if (src['vision'] !== undefined) {
        const v = src['vision'];
        if (typeof v !== 'object' || v === null || Array.isArray(v)) {
          errors.push('claude.vision must be an object');
        } else {
          const vNext = { ...((next['vision'] ?? {}) as Record<string, unknown>) };
          const en = asBool((v as Record<string, unknown>)['enabled'], 'claude.vision.enabled');
          if (en !== undefined) vNext['enabled'] = en;
          next['vision'] = vNext;
        }
      }

      config['claude'] = next;
      applied.push('claude');
    }
  }

  // ---- points -------------------------------------------------------------
  if (body['points'] !== undefined) {
    const { next, errors: pointsErrors } = validatePointsPatch(config['points'], body['points']);
    if (!next) {
      errors.push(...pointsErrors);
    } else {
      const word = effectiveCommand(effectivePointsConfig(next));
      // Only a changed command word is checked: a word saved before a custom command
      // of that name existed shouldn't block every later save, the toggle included.
      const unchanged = word === effectiveCommand(effectivePointsConfig(config['points']));
      if (!unchanged && commandWordCollides(word, pointsReservedWords(channel))) {
        errors.push(`!${word} is already a command in this channel — choose a different currency command`);
      } else {
        config['points'] = next;
        applied.push('points');
      }
    }
  }

  if (errors.length > 0) return res.status(400).json({ error: errors.join('; ') });
  if (applied.length === 0) return res.status(400).json({ error: 'No recognised settings in request' });

  config['lastUpdated'] = new Date().toISOString();
  writeChannelConfig(channel, config);

  // claude.ts re-reads the channel config on a 5-minute TTL and the points service
  // within 15 seconds, so those apply on their own. Everything else here is read
  // from the bot's in-memory config at startup and does need the restart.
  const restartKeys = applied.filter(k => k !== 'claude' && k !== 'points');
  if (restartKeys.length > 0) {
    touchReload(channel);
    console.log(`[INTERNAL] ${channel} settings updated: ${applied.join(', ')} — reload triggered`);
  } else {
    console.log(`[INTERNAL] ${channel} settings updated: ${applied.join(', ')} — no restart needed (the bot re-reads these)`);
  }

  const procs = await pm2List();
  return res.json({ ok: true, ...summariseChannel(channel, procs) });
});

/**
 * Store a freshly-issued streamer grant against an already-enrolled channel.
 *
 * This is what makes renewal automatic: the dashboard login requests the same
 * scope set as enrollment, so every sign-in yields a new token, and posting it
 * here resets the 30-day grant clock without the streamer doing anything beyond
 * logging in. Enrolling a brand-new channel still goes through the full
 * /kick-bot-enroll flow, which also needs the chatroom lookup and pm2 setup.
 */
app.post('/internal/bot/:channel/oauth', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const body = req.body as { accessToken?: unknown; refreshToken?: unknown; expiresIn?: unknown };
  if (typeof body?.accessToken !== 'string' || body.accessToken.length === 0) {
    return res.status(400).json({ error: 'accessToken required' });
  }
  if (typeof body.refreshToken !== 'string' || body.refreshToken.length === 0) {
    return res.status(400).json({ error: 'refreshToken required' });
  }
  const expiresIn = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 3600;

  const now = new Date();
  config['oauth'] = {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: now.getTime() + expiresIn * 1000
  };
  // enrolledAt drives the 30-day grant countdown shown in the dashboard, so a
  // new grant has to reset it — otherwise the UI keeps counting down the old one.
  config['enrolledAt'] = now.toISOString();
  config['lastUpdated'] = now.toISOString();
  writeChannelConfig(channel, config);
  touchReload(channel);
  console.log(`[INTERNAL] ${channel} streamer grant refreshed via dashboard login — 30-day clock reset`);

  const procs = await pm2List();
  return res.json({ ok: true, ...summariseChannel(channel, procs) });
});

/**
 * Accounts that are never offered as bot managers: Kick's own system bots and
 * this bot itself, all of which carry a moderator badge in channels they serve.
 */
const NEVER_SUGGEST = SYSTEM_BOTS;

/**
 * Usernames recently seen with a moderator badge in a channel's log.
 *
 * Kick's public API has no endpoint that lists moderators, so the chat log is
 * the only moderator signal available. It's used purely to SUGGEST names for
 * the broadcaster to pick from — never to grant access on its own.
 */
async function recentModerators(channel: string): Promise<string[]> {
  const logPath = path.join(KICK_BASE_PATH, 'logs', `kick-${channel}-out.log`);
  if (!fs.existsSync(logPath)) return [];

  // Filter inside the shell rather than buffering the tail in Node: these logs
  // reach tens of MB and a raw `tail -n 200000` blows past exec's maxBuffer,
  // which fails silently and looks like "this channel has no moderators".
  const cmd = `tail -n 200000 ${JSON.stringify(logPath)} | grep -oE '\\[[a-z_,]*moderator[a-z_,]*\\] [A-Za-z0-9_]+:' | sed -E 's/.*\\] //; s/:$//' | sort -u`;
  const result = await execAsync(cmd, 1024 * 1024);
  if (!result.ok || !result.message) return [];

  const seen = new Set<string>();
  for (const line of result.message.split('\n')) {
    const name = line.trim().toLowerCase();
    if (!name) continue;
    if (NEVER_SUGGEST.has(name)) continue;
    if (name === channel) continue;   // the broadcaster already has access
    seen.add(name);
  }

  const identity = await resolveBotIdentity().catch(() => null);
  if (identity?.username) seen.delete(identity.username.toLowerCase());

  return Array.from(seen).sort();
}

// Every bot this user can reach: their own channel (when enrolled) plus any
// channel that lists them as a manager. Drives the dashboard's channel switcher.
app.get('/internal/bot/reachable-by/:username', internalGuard(false), async (req, res) => {
  const rawName = req.params['username'];
  const username = (typeof rawName === 'string' ? rawName : '').toLowerCase();
  if (!validateChannelName(username)) return res.status(400).json({ error: 'Invalid username' });

  const dir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    files = [];
  }

  const channels: Array<{ channel: string; isSelf: boolean }> = [];
  for (const file of files) {
    const channel = path.basename(file, '.json');
    const config = readChannelConfig(channel);
    if (!config) continue;
    const managers = Array.isArray(config['managers']) ? (config['managers'] as string[]) : [];
    if (channel === username) channels.push({ channel, isSelf: true });
    else if (managers.includes(username)) channels.push({ channel, isSelf: false });
  }

  // Own channel first, then managed ones alphabetically.
  channels.sort((a, b) => (a.isSelf === b.isSelf ? a.channel.localeCompare(b.channel) : a.isSelf ? -1 : 1));
  return res.json({ username, channels });
});

// Channels that list this username as a manager. Without it a manager has no
// way to reach the channel they manage — the dashboard sends them to their own.
app.get('/internal/bot/managed-by/:username', internalGuard(false), async (req, res) => {
  const rawName = req.params['username'];
  const username = (typeof rawName === 'string' ? rawName : '').toLowerCase();
  if (!validateChannelName(username)) return res.status(400).json({ error: 'Invalid username' });

  const dir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    files = [];
  }

  const channels: string[] = [];
  for (const file of files) {
    const channel = path.basename(file, '.json');
    const config = readChannelConfig(channel);
    const managers = Array.isArray(config?.['managers']) ? (config!['managers'] as string[]) : [];
    if (managers.includes(username)) channels.push(channel);
  }

  return res.json({ username, channels: channels.sort() });
});

/**
 * Current managers plus moderators observed in chat.
 *
 * `seeded` distinguishes "never configured" (no `managers` key at all) from
 * "deliberately empty" (`[]`). The list is populated from observed moderators
 * ONCE, on first configuration; after that it is only ever changed by hand.
 * Re-seeding automatically would resurrect anyone the broadcaster removed.
 */
app.get('/internal/bot/:channel/managers', internalGuard(false), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const seeded = Array.isArray(config['managers']);
  const managers = seeded ? (config['managers'] as string[]) : [];
  const suggestions = (await recentModerators(channel)).filter(m => !managers.includes(m));
  return res.json({ channel, managers, suggestions, seeded });
});

/**
 * Merge observed moderators into the manager list.
 *
 * Additive only — it never drops an existing manager. Used for the one-time
 * seed when a channel has no list yet, and for an explicit "sync" the
 * broadcaster can trigger later to pick up moderators added since.
 */
app.post('/internal/bot/:channel/managers/sync', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  // Read the config only after the slow log scan. Read before it, the write below
  // put back whatever the file held a second earlier — including a refresh token
  // the bot had just rotated out, which kills the grant at the next refresh.
  const observed = await recentModerators(channel);
  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });
  const existing = Array.isArray(config['managers']) ? (config['managers'] as string[]) : [];
  const merged = Array.from(new Set([...existing, ...observed])).sort();
  const added = merged.filter(m => !existing.includes(m));

  config['managers'] = merged;
  config['lastUpdated'] = new Date().toISOString();
  writeChannelConfig(channel, config);
  console.log(`[INTERNAL] ${channel} managers synced from moderators — added ${added.length}: [${added.join(', ')}]`);

  const procs = await pm2List();
  return res.json({ ok: true, added, ...summariseChannel(channel, procs) });
});

// Replace the manager list. Body: { managers: string[] }
app.post('/internal/bot/:channel/managers', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const config = readChannelConfig(channel);
  if (!config) return res.status(404).json({ error: 'Not enrolled' });

  const body = req.body as { managers?: unknown };
  if (!Array.isArray(body?.managers)) {
    return res.status(400).json({ error: 'managers must be an array' });
  }
  if (body.managers.length > 50) {
    return res.status(400).json({ error: 'At most 50 managers' });
  }

  const cleaned: string[] = [];
  for (const raw of body.managers) {
    const name = String(raw).toLowerCase().trim();
    if (!validateChannelName(name)) {
      return res.status(400).json({ error: `Invalid username: ${String(raw).slice(0, 30)}` });
    }
    if (name === channel) continue;              // broadcaster access is implicit
    if (!cleaned.includes(name)) cleaned.push(name);
  }

  config['managers'] = cleaned.sort();
  config['lastUpdated'] = new Date().toISOString();
  writeChannelConfig(channel, config);
  // No reload needed: managers only affect dashboard authorization, not the bot.
  console.log(`[INTERNAL] ${channel} managers set to [${cleaned.join(', ')}]`);

  const procs = await pm2List();
  return res.json({ ok: true, ...summariseChannel(channel, procs) });
});

// Remove the bot from a channel entirely. Mirrors deployRemoveChannel.
app.delete('/internal/bot/:channel', internalGuard(true), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });
  if (!readChannelConfig(channel)) return res.status(404).json({ error: 'Not enrolled' });

  const pm2Name = `kick-${channel}`;
  // Tolerate a missing process — the config may exist without a live bot.
  await execAsync(`pm2 stop "${pm2Name}"`);
  await execAsync(`pm2 delete "${pm2Name}"`);

  for (const p of [
    path.join(KICK_BASE_PATH, 'dist', 'channels', `${channel}.js`),
    path.join(KICK_BASE_PATH, 'dist', 'channels', `${channel}.js.map`),
    path.join(KICK_BASE_PATH, 'src', 'channels', `${channel}.ts`),
    path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${channel}.json`),
    path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${channel}.reload`)
  ]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e) {
      console.error(`[INTERNAL] Failed to remove ${p}:`, e instanceof Error ? e.message : String(e));
    }
  }

  removeFromEcosystem(channel);
  await execAsync('pm2 save');
  console.log(`[INTERNAL] Removed bot for ${channel}`);
  return res.json({ ok: true, channel });
});

// Recent log lines for a channel, newest last.
app.get('/internal/bot/:channel/logs', internalGuard(false), async (req, res) => {
  const channelRaw = req.params['channel'];
  const channel = (typeof channelRaw === 'string' ? channelRaw : '').toLowerCase();
  if (!validateChannelName(channel)) return res.status(400).json({ error: 'Invalid channel name' });

  const linesRaw = parseInt(String(req.query['lines'] ?? '100'), 10);
  const lines = Number.isFinite(linesRaw) ? Math.min(Math.max(linesRaw, 1), 500) : 100;
  const logPath = path.join(KICK_BASE_PATH, 'logs', `kick-${channel}-out.log`);
  if (!fs.existsSync(logPath)) return res.json({ lines: [] });

  const result = await execAsync(`tail -n ${lines} ${JSON.stringify(logPath)}`, 2 * 1024 * 1024);
  if (!result.ok) return res.status(500).json({ error: 'Failed to read log' });
  return res.json({ lines: result.message ? result.message.split('\n') : [] });
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
let deploymentStartAttempts = 0;
let deploymentStartTimer: NodeJS.Timeout | null = null;

/**
 * Try the start again later. A failed start used to be final: one Kick API blip
 * or a token not yet refreshed at boot left !kickaddme dead until the next
 * service restart. Backs off to five minutes and never gives up.
 */
function retryDeploymentBot(reason: string): void {
  if (deploymentStartTimer) return;
  deploymentStartAttempts++;
  const delayMs = Math.min(5 * 60_000, 15_000 * 2 ** Math.min(deploymentStartAttempts - 1, 5));
  console.error(`[DEPLOY BOT] ${reason} — retrying in ${Math.round(delayMs / 1000)}s`);
  deploymentStartTimer = setTimeout(() => {
    deploymentStartTimer = null;
    void startDeploymentBot();
  }, delayMs);
}

async function startDeploymentBot(): Promise<void> {
  if (!DEPLOYMENT_CHATROOM_ID) {
    console.log('[DEPLOY BOT] KICK_DEPLOYMENT_CHATROOM_ID not set, skipping command-based deployment');
    return;
  }

  try {
    // Get bot auth
    const botAuth = new KickAuth();

    if (!botAuth.isAuthenticated()) {
      retryDeploymentBot('Not authenticated');
      return;
    }

    // Get broadcaster ID for sending messages
    const botToken = await botAuth.getAccessToken();
    const channelResponse = await axios.get(`https://api.kick.com/public/v1/channels?slug=${DEPLOYMENT_CHANNEL}`, {
      headers: { 'Authorization': `Bearer ${botToken}` },
      // Without a limit a stalled request holds the start, and so the retry, forever.
      timeout: 10_000
    });
    deploymentBroadcasterId = (channelResponse.data.data[0] as { broadcaster_user_id?: number } | undefined)?.broadcaster_user_id ?? null;

    // Connect to WebSocket. From here the socket's close handler does the reconnecting.
    deploymentStartAttempts = 0;
    connectDeploymentWebSocket();

  } catch (err) {
    retryDeploymentBot(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
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

  // Connect-timeout watchdog: if `open` doesn't fire within 15s, kill the socket
  // so the close handler can trigger the reconnect. Without this a TCP-level hang
  // leaves the listener deaf forever (Kick chat commands silently drop).
  const ws = deploymentWs;
  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error('[DEPLOY BOT] Connect timeout after 15s — terminating socket');
      ws.terminate();
    }
  }, 15000);

  // The watchdog above only covers connecting. Once open, a socket can go silent
  // with TCP none the wiser; Pusher answers every ping, so a long silence means dead.
  let lastFrameAt = Date.now();

  deploymentWs.on('open', () => {
    clearTimeout(connectTimeout);
    lastFrameAt = Date.now();
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
    lastFrameAt = Date.now();
    try {
      const message = JSON.parse(data.toString()) as { event?: string; data?: unknown; channel?: string };
      handleDeploymentMessage(message);
    } catch (err) {
      if (err instanceof Error) {
        console.error('[DEPLOY BOT] Failed to parse message:', err.message);
      }
    }
  });

  deploymentWs.on('error', (err: Error) => {
    console.error('[DEPLOY BOT] WebSocket error:', err.message);
    // `close` fires after `error`, so reconnect happens there.
  });

  deploymentWs.on('close', () => {
    clearTimeout(connectTimeout);
    console.log('[DEPLOY BOT] WebSocket disconnected, reconnecting...');
    if (deploymentPingInterval) {
      clearInterval(deploymentPingInterval);
      deploymentPingInterval = null;
    }
    setTimeout(connectDeploymentWebSocket, 5000);
  });

  deploymentPingInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    // Two and a half ping intervals without a frame. Terminating hands over to the
    // close handler, the one place a reconnect is scheduled.
    if (Date.now() - lastFrameAt > 75_000) {
      console.error('[DEPLOY BOT] No frames for 75s — terminating dead socket');
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
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
    // Nothing awaits this, and an unhandled rejection takes the whole service down.
    handleDeploymentCommand(eventData, sourceChatroomId as string).catch(err => {
      console.error('[DEPLOY BOT] Command failed:', err instanceof Error ? err.message : String(err));
    });
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
    await deployAddChannel(username, args, badges, sourceChatroomId);
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
  if (!sanitized || sanitized.length > 25 || !validateChannelName(sanitized)) {
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

      // Get chatroom ID via stealth browser (kick.com/api/v2 is Cloudflare-blocked
      // from this server's IP; ChatroomResolver bypasses that). Fall back to
      // broadcaster ID only if the resolver itself fails — broadcaster_user_id
      // is NOT a valid chatroom_id, but it lets enrollment limp along.
      let chatroomId: number | null = chatEnrollBroadcasterId;
      try {
        chatroomId = await chatroomResolver.resolve(sanitized);
        console.log(`[DEPLOY] Got chatroom ID via stealth resolver: ${chatroomId}`);
      } catch (e) {
        if (e instanceof Error) {
          console.error('[DEPLOY] Stealth chatroom resolve failed:', e.message);
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
      const configDir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Merge, never replace: this path also runs for channels that already
      // exist, and it must not drop their oauth block or their settings.
      const configPath = path.join(configDir, `${sanitized}.json`);
      mergeChannelConfig(
        configPath,
        {
          chatOnly: false,
          enrolledAt: new Date().toISOString(),
          location: {
            home: { country: "", city: "", state: "", province: "" },
            current: { country: "", city: "", state: "", province: "" }
          }
        },
        {
          channelName: sanitized,
          chatroomId: chatroomId,
          broadcasterUserId: broadcasterUserId,
          lastUpdated: new Date().toISOString()
        }
      );
      // Bump the .reload sentinel so PM2's file-watch picks up the new config.
      // Bot never touches this file, so refresh-token rotation won't trigger
      // spurious restarts.
      fs.writeFileSync(path.join(configDir, `${sanitized}.reload`), '');

      // Create bot file. MUST clone from dist/channels/ (compiled TS output) —
      // the legacy /channels/ dir at repo root contains pre-TS-migration files
      // that import the old auth.js + telegram-notifier.js (with stale "SSH +
      // node authenticate.js" wording that spams Telegram on token failures).
      const templatePath = path.join(__dirname, 'channels', 'template-kick-bot.js');
      const botPath = path.join(__dirname, 'channels', `${sanitized}.js`);

      let botCode = fs.readFileSync(templatePath, 'utf8');
      botCode = botCode.replace(/\$\$UPDATEHERE\$\$/g, sanitized);
      fs.writeFileSync(botPath, botCode);

      // Add to ecosystem
      addToEcosystem(sanitized);

      // Start with PM2, then save the process list so the bot auto-resurrects
      // on server reboot. Without `pm2 save`, the dump.pm2 stays stale and
      // newly-deployed channels are lost on reboot.
      exec(`pm2 start "${botPath}" --name "${pm2Name}" --time`, async (startError) => {
        if (startError) {
          await sendDeploymentMessage(`@${requester}, failed to start bot for ${sanitized}.`, sourceChatroomId);
          return;
        }
        exec('pm2 save', (saveErr) => {
          if (saveErr) console.error(`[DEPLOY] pm2 save failed: ${saveErr.message}`);
        });
        await sendDeploymentMessage(`@${requester}, bot deployed to ${sanitized}! (Chatroom: ${chatroomId})`, sourceChatroomId);
        if (broadcasterUserId) {
          subscribeChannelToWebhook(broadcasterUserId).catch(e =>
            console.error('[WEBHOOK] Post-deploy subscription error:', e instanceof Error ? e.message : String(e))
          );
        }
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
  if (!validateChannelName(sanitized)) {
    await sendDeploymentMessage(`@${requester}, invalid channel name.`, sourceChatroomId);
    return;
  }

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

    // A throw in this exec callback is uncaught and takes the whole enrollment
    // service down, and a bot process can exist without either file.
    for (const p of [
      path.join(KICK_BASE_PATH, 'dist', 'channels', `${sanitized}.js`),
      path.join(KICK_BASE_PATH, 'data', 'channel-configs', `${sanitized}.json`)
    ]) {
      try {
        fs.unlinkSync(p);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[DEPLOY] Failed to remove ${p}:`, e instanceof Error ? e.message : String(e));
        }
      }
    }
    removeFromEcosystem(sanitized);

    // Persist removal so the deleted entry doesn't resurrect on reboot.
    exec('pm2 save', (saveErr) => {
      if (saveErr) console.error(`[DEPLOY] pm2 save failed: ${saveErr.message}`);
    });

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

    let processList: Array<{ name?: string; pm2_env?: { status?: string } }>;
    try {
      processList = JSON.parse(stdout) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    } catch {
      // A throw in this exec callback is uncaught and would take the service down.
      await sendDeploymentMessage(`@${requester}, failed to get status.`, sourceChatroomId);
      return;
    }
    const kickBots = processList.filter(p => p.name && p.name.startsWith('kick-'));
    const activeCount = kickBots.filter(p => p.pm2_env?.status === 'online').length;

    await sendDeploymentMessage(`@${requester}, Kick bots: ${activeCount}/${kickBots.length} active, ${MAX_CHANNELS} max.`, sourceChatroomId);
  });
}

async function deployHelp(requester: string, sourceChatroomId: string): Promise<void> {
  await sendDeploymentMessage(`@${requester}, !kickaddme - Enroll | !kickremoveme - Remove | OAuth: https://${oauthDomain}/kick-bot-enroll`, sourceChatroomId);
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

// ==================== KICK WEBHOOK ====================

app.post('/kick-webhook', express.raw({ type: '*/*' }), async (req: express.Request, res: express.Response) => {
  // Acknowledge immediately — Kick expects a fast 2xx
  res.status(200).send('OK');

  const rawBody = req.body as Buffer;
  const signatureB64 = (req.headers['kick-event-signature'] as string | undefined) || '';
  const messageId    = (req.headers['kick-event-message-id'] as string | undefined) || '';
  const timestamp    = (req.headers['kick-event-message-timestamp'] as string | undefined) || '';

  const skipVerify = process.env.WEBHOOK_VERIFY === 'false';
  if (!skipVerify) {
    if (!signatureB64) {
      // No signature = likely a Kick ping/test with no body — log and ignore
      console.log(`[WEBHOOK] Received request with no signature (headers: ${JSON.stringify(req.headers).slice(0, 200)})`);
      return;
    }
    const valid = await verifyWebhookSignature(messageId, timestamp, rawBody, signatureB64);
    if (!valid) {
      const shown = Buffer.isBuffer(rawBody)
        ? rawBody.toString('utf8').slice(0, 200)
        : `NOT-RAW (${typeof rawBody}) ${JSON.stringify(rawBody).slice(0, 200)}`;
      console.error(`[WEBHOOK] Invalid signature for message ${messageId} — body: ${shown}`);
      return;
    }
  } else {
    console.warn('[WEBHOOK] Signature verification skipped (WEBHOOK_VERIFY=false)');
  }

  let event: Record<string, unknown>;
  try {
    event = (Buffer.isBuffer(rawBody)
      ? JSON.parse(rawBody.toString('utf8'))
      : rawBody) as Record<string, unknown>;
  } catch (e) {
    console.error('[WEBHOOK] Failed to parse body:', e instanceof Error ? e.message : String(e));
    return;
  }

  // Handle both { data: { ... } } envelope and direct payload
  const payload = (event['data'] as Record<string, unknown> | undefined) ?? event;

  // Kick names the event in a header; the body carries only the payload. Fall
  // back to the body's own hints for older/odd deliveries.
  const headerType = (req.headers['kick-event-type'] as string | undefined) || '';
  const bodyType = (event['type'] as string | undefined) || '';
  let eventType = headerType || bodyType;
  if (!eventType) {
    if (typeof payload['message_id'] === 'string') eventType = 'chat.message.sent';
    else if (payload['reward'] && payload['redeemer']) eventType = 'channel.reward.redemption.updated';
  }

  if (!WEBHOOK_EVENTS.includes(eventType)) return;

  const broadcaster = payload['broadcaster'] as { user_id?: number; username?: string } | undefined;
  if (!broadcaster?.user_id) {
    console.error('[WEBHOOK] Missing broadcaster.user_id in payload');
    return;
  }

  const channelName = channelNameForBroadcaster(broadcaster.user_id);
  if (!channelName) {
    console.warn(`[WEBHOOK] No enrolled channel found for broadcaster ${broadcaster.user_id}`);
    return;
  }

  const who = (u: unknown): string => (u as { username?: string } | undefined)?.username ?? '?';
  if (eventType === 'chat.message.sent') {
    console.log(`[WEBHOOK] chat.message.sent from ${who(payload['sender'])} in ${channelName}`);
  } else if (eventType === 'moderation.banned') {
    const meta = payload['metadata'] as { expires_at?: string | null } | undefined;
    console.log(
      `[WEBHOOK] moderation.banned ${who(payload['banned_user'])} by ${who(payload['moderator'])} in ${channelName} — ` +
      (meta?.expires_at ? `until ${meta.expires_at}` : 'permanent')
    );
  } else if (eventType === 'channel.followed') {
    console.log(`[WEBHOOK] channel.followed by ${who(payload['follower'])} in ${channelName}`);
  } else if (eventType === 'channel.subscription.new' || eventType === 'channel.subscription.renewal') {
    console.log(`[WEBHOOK] ${eventType} ${who(payload['subscriber'])} in ${channelName} — duration=${String(payload['duration'] ?? '?')}`);
  } else if (eventType === 'channel.subscription.gifts') {
    const giftees = Array.isArray(payload['giftees']) ? payload['giftees'].length : '?';
    console.log(`[WEBHOOK] channel.subscription.gifts ${giftees} sub(s) from ${payload['gifter'] ? who(payload['gifter']) : 'anonymous'} in ${channelName}`);
  } else if (eventType === 'kicks.gifted') {
    const gift = payload['gift'] as { amount?: number } | undefined;
    console.log(`[WEBHOOK] kicks.gifted ${String(gift?.amount ?? '?')} Kicks from ${who(payload['sender'])} in ${channelName}`);
  } else if (eventType === 'livestream.status.updated') {
    console.log(`[WEBHOOK] livestream.status.updated ${channelName} is_live=${String(payload['is_live'] ?? '?')}`);
  } else if (eventType === 'channel.reward.redemption.updated') {
    const reward = payload['reward'] as { id?: string; title?: string; cost?: number } | undefined;
    const redeemer = payload['redeemer'] as { username?: string } | undefined;
    console.log(
      `[WEBHOOK] ${eventType} "${reward?.title ?? '?'}" (reward_id=${reward?.id ?? '?'}, cost=${reward?.cost ?? '?'}) ` +
      `by ${redeemer?.username ?? '?'} in ${channelName} — status=${String(payload['status'] ?? '?')} ` +
      `input=${JSON.stringify(payload['user_input'] ?? '')}`
    );
    // Keep the raw payload of every redemption. It is the only ground truth for
    // a channel whose grant can't read its own reward list, and it is what
    // `rewardActions[].rewardId` gets pinned to.
    try {
      const samplePath = path.join(KICK_BASE_PATH, 'data', 'redemption-samples.jsonl');
      fs.appendFileSync(samplePath, JSON.stringify({ receivedAt: new Date().toISOString(), channelName, payload }) + '\n', 'utf8');
    } catch (e) {
      console.error('[WEBHOOK] Failed to record redemption sample:', e instanceof Error ? e.message : String(e));
    }
  } else {
    console.log(`[WEBHOOK] ${eventType} in ${channelName}`);
  }

  const eventsDir = path.join(KICK_BASE_PATH, 'data', 'webhook-events');
  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true });
  }
  const queueFile = path.join(eventsDir, `${channelName}.jsonl`);
  // A stopped bot doesn't drain its queue. Past this size it's hours of chat the
  // poller would skip as stale anyway, so drop the chat. Everything else stays:
  // a follow or sub waiting for the bot still earns its bonus when it comes back.
  const MAX_QUEUE_BYTES = 5 * 1024 * 1024;
  try {
    if (fs.statSync(queueFile).size > MAX_QUEUE_BYTES) {
      const kept = fs.readFileSync(queueFile, 'utf8').split('\n').filter(line => {
        if (!line.trim()) return false;
        try {
          const ev = (JSON.parse(line) as { __event?: unknown }).__event;
          // Bare lines from an older build are chat.
          return typeof ev === 'string' && ev !== 'chat.message.sent';
        } catch {
          return false;
        }
      });
      const tmp = `${queueFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8');
      fs.renameSync(tmp, queueFile);
      console.warn(
        `[WEBHOOK] ${channelName}'s queue passed 5 MB without being drained — is its bot running? ` +
        `Dropped its chat and kept ${kept.length} other event(s).`
      );
    }
  } catch {
    // No queue file yet, or the bot claimed it meanwhile.
  }
  // Wrapped so the channel-side poller can tell event types apart, and stamped
  // so it can skip what waited out a stopped bot. Kick's message id lets it
  // recognise a redelivery. Bare payloads written by an older build are still
  // read as chat messages.
  fs.appendFileSync(
    queueFile,
    JSON.stringify({ __event: eventType, receivedAt: Date.now(), messageId: messageId || undefined, payload }) + '\n',
    'utf8'
  );
});

// ==================== START SERVICES ====================

const POINTS_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Back up the points database of every channel with points on. Run from here
 * because this service is always up, unlike a channel bot that may be stopped.
 */
async function backupAllPoints(): Promise<void> {
  const configDir = path.join(KICK_BASE_PATH, 'data', 'channel-configs');
  let channels: string[] = [];
  try {
    channels = fs.readdirSync(configDir).filter(f => f.endsWith('.json')).map(f => path.basename(f, '.json'));
  } catch {
    return;
  }
  for (const channel of channels) {
    const config = readChannelConfig(channel);
    if (!config || !effectivePointsConfig(config['points']).enabled) continue;
    try {
      const file = await backupPoints(channel);
      if (file) console.log(`[POINTS] Backed up ${channel} to ${path.relative(KICK_BASE_PATH, file)}`);
    } catch (e) {
      console.error(`[POINTS] Backup of ${channel} failed:`, e instanceof Error ? e.message : String(e));
    }
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`[INFO] Mr-AI Bot Enrollment Service running on http://localhost:${PORT}`);
  console.log(`[INFO] Public URL: https://${oauthDomain}/kick-bot-enroll`);

  // A minute after start, then daily. Nothing awaits these, so failures are caught inside.
  setTimeout(() => { void backupAllPoints(); }, 60_000);
  setInterval(() => { void backupAllPoints(); }, POINTS_BACKUP_INTERVAL_MS);

  // Start token monitor first, wait for initial check to complete,
  // then start deployment bot so it always gets a fully refreshed token
  const botAuth = new KickAuth();
  const { ready } = botAuth.startTokenMonitor();
  ready.then(() => {
    startDeploymentBot();
    subscribeAllChannelsToWebhook().catch(e => console.error('[WEBHOOK] subscribeAllChannels error:', e));
  });
});

// Export deployAddChannel for use if needed (currently unused but defined in original)
export { deployAddChannel };
