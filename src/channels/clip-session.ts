/**
 * Keeping !clip's Kick session working without a human.
 *
 * Clipping needs a site session token (see kick-clips.ts). There is no API to
 * mint one: Kick answers /mobile/login with 429 from this host — plain HTTP and
 * through the stealth browser alike — so the token is pasted by hand at least
 * once. Everything here exists to make that the rare case:
 *
 *   - an hourly check that the token still authenticates, before a viewer finds out
 *   - a re-login attempt when it doesn't, heavily throttled so retries can't
 *     deepen whatever limit Kick is applying (HTTP hourly at most, browser daily)
 *   - a Telegram alert with the paste steps only once the bot has given up
 *   - state shared through a file, because all four bots load this module and
 *     only one of them should be checking or logging in
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import TelegramNotifier = require('../telegram-notifier');
import { sessionToken } from './kick-clips';

const WEB = 'https://kick.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHECK_EVERY_MS = 60 * 60_000;
/** Only one process does the work per hour; the others see a recent check and skip. */
const VERIFY_GAP_MS = 55 * 60_000;
const HTTP_LOGIN_GAP_MS = 6 * 60 * 60_000;
const BROWSER_LOGIN_GAP_MS = 24 * 60 * 60_000;

interface State {
  lastVerifyAt?: number;
  lastHttpLoginAt?: number;
  lastBrowserLoginAt?: number;
  healthy?: boolean;
  lastReason?: string;
}

function statePath(): string {
  return path.join(process.cwd(), 'data', 'clip-session.json');
}

function readState(): State {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as State; } catch { return {}; }
}

function writeState(next: State): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  } catch { /* best effort: the check simply runs again next hour */ }
}

/** False once a check has found the token dead, so !clip can say so honestly. */
export function clipSessionHealthy(): boolean {
  return readState().healthy !== false;
}

function saveToken(token: string): void {
  const payload = JSON.stringify({ token, savedAt: Date.now() }, null, 2);
  for (const file of [path.join(process.cwd(), '.session.json'), path.join(__dirname, '..', '.session.json')]) {
    try { fs.writeFileSync(file, payload, { mode: 0o600 }); } catch { /* the other location may work */ }
  }
}

/** Does this token still authenticate? Kick answers an empty object when it doesn't. */
export async function tokenWorks(token: string): Promise<boolean> {
  try {
    const res = await axios.get(`${WEB}/api/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'x-app-platform': 'web', 'User-Agent': UA },
      timeout: 15_000
    });
    const body = res.data as { username?: unknown; id?: unknown };
    return typeof body?.username === 'string' || typeof body?.id === 'number';
  } catch {
    return false;
  }
}

async function httpLogin(): Promise<string | null> {
  const email = process.env.KICK_BOT_EMAIL;
  const password = process.env.KICK_BOT_PASSWORD;
  if (!email || !password) return null;
  try {
    const res = await axios.post(`${WEB}/mobile/login`, { email, password }, {
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      timeout: 25_000
    });
    const token = (res.data as { token?: unknown })?.token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  }
}

/**
 * Last resort: log in inside the stealth browser, which carries real TLS and
 * Cloudflare clearance. Tried at most daily — it costs a Chromium launch, and
 * on 2026-09-12 Kick answered 429 even here.
 */
async function browserLogin(): Promise<string | null> {
  const email = process.env.KICK_BOT_EMAIL;
  const password = process.env.KICK_BOT_PASSWORD;
  if (!email || !password) return null;
  if (!process.env.CHROME_PATH) {
    try {
      const root = path.join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
      const dirs = fs.readdirSync(root).filter(d => d.startsWith('linux-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const d of dirs) {
        const candidate = path.join(root, d, 'chrome-linux64', 'chrome');
        if (fs.existsSync(candidate)) { process.env.CHROME_PATH = candidate; break; }
      }
    } catch { /* connect() will complain below */ }
  }
  let browser: { close: () => Promise<void> } | null = null;
  try {
    // Required lazily: loading puppeteer at startup would cost every bot memory
    // for something that runs once a day at most.
     
    const { connect } = require('puppeteer-real-browser') as { connect: (o: unknown) => Promise<{ browser: { close: () => Promise<void> }; page: { goto: (u: string, o: unknown) => Promise<unknown>; evaluate: (fn: unknown, ...a: unknown[]) => Promise<unknown> } }> };
    const r = await connect({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'], turnstile: true, disableXvfb: false });
    browser = r.browser;
    await r.page.goto(`${WEB}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await new Promise(s => setTimeout(s, 5000));
    const out = await r.page.evaluate(async (mail: string, pass: string) => {
      const res = await fetch('/mobile/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ email: mail, password: pass }),
        credentials: 'include'
      });
      return await res.text();
    }, email, password) as string;
    const token = (JSON.parse(out) as { token?: unknown })?.token;
    return typeof token === 'string' && token ? token : null;
  } catch {
    return null;
  } finally {
    try { if (browser) await browser.close(); } catch { /* killed with the process otherwise */ }
  }
}

/**
 * One health cycle. Returns true when clipping can authenticate.
 * `force` skips the shared throttle — used when a clip has just been refused.
 */
export async function checkClipSession(force = false): Promise<boolean> {
  const state = readState();
  const now = Date.now();
  if (!force && state.lastVerifyAt && now - state.lastVerifyAt < VERIFY_GAP_MS) return state.healthy !== false;

  state.lastVerifyAt = now;
  const current = sessionToken();
  if (current && await tokenWorks(current)) {
    if (state.healthy === false) {
      await new TelegramNotifier().notifyClipSessionRestored('the existing token works again').catch(() => {});
    }
    writeState({ ...state, healthy: true, lastReason: undefined });
    return true;
  }

  const had = current ? 'the session token was rejected' : 'no session token is stored';
  console.warn(`[CLIP] ${had} — trying to renew it`);

  let renewed: string | null = null;
  let how = '';
  if (!state.lastHttpLoginAt || now - state.lastHttpLoginAt > HTTP_LOGIN_GAP_MS) {
    state.lastHttpLoginAt = now;
    renewed = await httpLogin();
    if (renewed) how = 'logged in over HTTP';
  }
  if (!renewed && (!state.lastBrowserLoginAt || now - state.lastBrowserLoginAt > BROWSER_LOGIN_GAP_MS)) {
    state.lastBrowserLoginAt = now;
    renewed = await browserLogin();
    if (renewed) how = 'logged in through the browser';
  }

  if (renewed && await tokenWorks(renewed)) {
    saveToken(renewed);
    console.log(`[CLIP] Session renewed — ${how}.`);
    writeState({ ...state, healthy: true, lastReason: undefined });
    await new TelegramNotifier().notifyClipSessionRestored(how).catch(() => {});
    return true;
  }

  const reason = `${had}; automatic login failed (Kick rate-limits logins from this host)`;
  console.error(`[CLIP] ${reason}. Paste a fresh session_token into .session.json.`);
  writeState({ ...state, healthy: false, lastReason: reason });
  await new TelegramNotifier().notifyClipSessionDown(reason).catch(() => {});
  return false;
}

let timer: NodeJS.Timeout | null = null;

/** Hourly check, jittered so four bots don't all wake at the same second. */
export function startClipSessionWatchdog(): void {
  if (timer) return;
  const jitter = Math.floor(Math.random() * 5 * 60_000);
  timer = setInterval(() => {
    checkClipSession().catch(err => console.error(`[CLIP] Session check failed: ${err instanceof Error ? err.message : String(err)}`));
  }, CHECK_EVERY_MS + jitter);
  timer.unref();
}
