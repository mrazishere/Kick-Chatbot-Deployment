/**
 * HlsResolver — resolves Kick channels' master HLS playlist URLs.
 *
 * Mechanism (as of 2026-05-17):
 *   Kick's website and v2 API are Cloudflare-blocked from this server (HTTP 403).
 *   Stealth-plugin-style headless Chromium also fails the current Cloudflare
 *   challenge ("Just a moment..." interstitial). `puppeteer-real-browser` plus
 *   Xvfb + Chromium with the right flags clears the challenge.
 *
 *   Once on the page, Kick's player no longer fetches an m3u8 URL directly.
 *   It calls `web.kick.com/api/v1/stream/<stream-id>/playback` which returns
 *   JSON containing the playback URLs. We listen for that response and
 *   extract `playback_url.live`.
 *
 * Caching:
 *   The intercepted URL contains a JWT token with an `exp` claim. We cache
 *   per-channel and re-resolve only when within 60s of expiry, or when the
 *   caller explicitly invalidates after a 403 from the upstream.
 *
 * Concurrency:
 *   Multiple simultaneous mention requests for the same channel are coalesced
 *   into a single in-flight resolve, and only one browser runs per process.
 *
 * Shutdown:
 *   Every step that talks to the browser is time-limited, and the browser is
 *   shut down on every path. A hung Chromium or Xvfb would otherwise stay
 *   running and eat memory that every bot on this machine shares.
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';

// puppeteer-real-browser launches Chrome via chrome-launcher, which discovers
// the binary via the CHROME_PATH env var. PM2 won't set that for us, so we
// resolve the bundled Chromium that puppeteer downloads into the user cache.
function discoverBundledChrome(): string | null {
  try {
    const root = path.join(process.env.HOME || '', '.cache', 'puppeteer', 'chrome');
    const entries = fs.readdirSync(root).filter(d => d.startsWith('linux-'));
    if (entries.length === 0) return null;
    // Sort by version descending so we pick the newest installed Chromium.
    entries.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const e of entries) {
      const candidate = path.join(root, e, 'chrome-linux64', 'chrome');
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

if (!process.env.CHROME_PATH) {
  const bundled = discoverBundledChrome();
  if (bundled) {
    process.env.CHROME_PATH = bundled;
    console.log(`[HLS] Using bundled Chromium at ${bundled}`);
  } else {
    console.warn('[HLS] No bundled Chromium found and CHROME_PATH not set — resolver will likely fail');
  }
}

const { connect } = require('puppeteer-real-browser');
import TelegramNotifier = require('../telegram-notifier');
const telegram = new TelegramNotifier();

// Alert when the resolver has failed this many times in a row for the same
// channel. Avoids alerting on single transient failures.
const ALERT_AFTER_FAILURES = 3;
// Once we've alerted, wait this long before alerting again on the same channel
// even if failures continue (prevents spam during sustained outages).
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

// Browser time limits. A healthy resolve takes ~22s end to end, so these only
// fire on a hang, never on a merely slow resolve.
// connect() starts Xvfb, spawns Chromium and attaches over CDP — seconds when healthy.
const LAUNCH_TIMEOUT_MS = 45_000;
// Reading the page title is a single CDP call.
const TITLE_TIMEOUT_MS = 5_000;
// close() normally settles in under a second. Past this, force the shutdown.
const CLOSE_TIMEOUT_MS = 10_000;
// Backstop for the whole resolve: launch (45s) + navigation (45s) + poll (45s) +
// title (5s), plus slack. It sits above the sum so it can't cut in ahead of the
// more specific errors those steps report.
const RESOLVE_CEILING_MS = 150_000;

const failureStreak = new Map<string, number>();
const lastAlertAt = new Map<string, number>();
const alertingNow = new Set<string>();

interface CachedHls {
  url: string;
  exp: number; // unix seconds
  resolvedAt: number; // ms
}

interface PlaybackResponse {
  playback_url?: {
    live?: string;
    dvr?: string;
  };
}

/** What a resolve launched, kept so the browser can be shut down however the resolve ends. */
interface BrowserSession {
  /** connect() itself, so a launch that finishes after its timeout still gets closed. */
  launching?: Promise<{ browser: any; page: any }>;
  browser?: any;
}

function decodeJwtExp(jwt: string): number {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as { exp?: number };
    return payload.exp ?? 0;
  } catch {
    return 0;
  }
}

/** Rejects with "<label> timed out after Ns" if `promise` hasn't settled in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

/** True only if `run` fulfils within `ms`. A rejection or a timeout gives false. */
async function fulfilsWithin(run: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const outcome = Promise.resolve().then(run).then(() => true, () => false);
  const expired = new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); });
  try {
    return await Promise.race([outcome, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One browser at a time in this process. resolve() coalesces callers for each
 * channel, and this also keeps a new launch from starting while an earlier
 * browser is still being shut down. It is also what makes killBrowserChildren()
 * safe: every Chromium or Xvfb child it finds belongs to the resolve holding the slot.
 */
let browserSlot: Promise<void> = Promise.resolve();
function acquireBrowserSlot(): Promise<() => void> {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const acquired = browserSlot.then(() => release);
  browserSlot = browserSlot.then(() => held);
  return acquired;
}

/**
 * SIGKILL this process's Chromium and Xvfb children, found through /proc.
 *
 * connect() returns neither process handle. chrome-launcher spawns Chromium
 * detached, in its own process group, and the xvfb module spawns Xvfb. Both are
 * direct children of this process, so when the browser API is the thing that's
 * hung, this is the only way left to reach them.
 */
function killBrowserChildren(channel: string): void {
  let killed = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync('/proc'); } catch { /* not Linux */ }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let comm: string;
    let ppid: number;
    try {
      // "pid (comm) state ppid ...". comm can contain spaces, so split at the last ')'.
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      comm = stat.slice(stat.indexOf('(') + 1, end);
      ppid = Number(stat.slice(end + 2).split(' ')[1]);
    } catch {
      continue; // exited while we looked
    }
    if (ppid !== process.pid || !/^(chrome|Xvfb)$/.test(comm)) continue;
    const pid = Number(entry);
    // Chromium leads its own process group, so -pid takes its renderers with it.
    // Xvfb doesn't lead one, so fall back to the pid alone.
    try { process.kill(-pid, 'SIGKILL'); killed++; } catch {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
    }
  }
  if (killed > 0) {
    console.error(`[HLS] ${channel}: force-killed ${killed} browser process(es) that did not shut down`);
  }
}

/**
 * Close the browser. Returns false if close() didn't finish, in which case
 * disconnect() is called: it fires the 'disconnected' handler that
 * puppeteer-real-browser uses to kill its Chromium and stop its Xvfb.
 */
async function shutBrowser(browser: any): Promise<boolean> {
  if (await fulfilsWithin(() => browser.close(), CLOSE_TIMEOUT_MS)) return true;
  await fulfilsWithin(() => browser.disconnect(), 5_000);
  return false;
}

/** Shut down whatever the resolve launched. Runs on every path: success, error and ceiling. */
async function shutDown(channel: string, session: BrowserSession): Promise<void> {
  const { browser, launching } = session;
  if (browser) {
    if (!(await shutBrowser(browser))) killBrowserChildren(channel);
    return;
  }
  if (!launching) return;
  // The launch failed or timed out, so no handle can reach its processes. Kill
  // them now. If connect() still completes later, close what it made then.
  // That late close never sweeps, because by then the slot may belong to another resolve.
  launching.then(r => shutBrowser(r.browser), () => { /* launch failed */ });
  killBrowserChildren(channel);
}

export class HlsResolver {
  private cache: Map<string, CachedHls> = new Map();
  private inFlight: Map<string, Promise<string>> = new Map();

  /**
   * Returns a usable master HLS playlist URL for the channel.
   * Re-resolves if the cached URL is missing or near expiry.
   */
  async resolve(channel: string): Promise<string> {
    const cached = this.cache.get(channel);
    const nowSec = Math.floor(Date.now() / 1000);
    if (cached && cached.exp > nowSec + 60) {
      return cached.url;
    }

    // Coalesce concurrent calls
    const existing = this.inFlight.get(channel);
    if (existing) return existing;

    const p = this.doResolve(channel)
      .then(url => {
        // Success — if we'd been alerting, send the recovery message
        const prev = failureStreak.get(channel) || 0;
        if (alertingNow.has(channel)) {
          alertingNow.delete(channel);
          telegram.notifyVisionRecovered(channel).catch(() => { /* ignore */ });
        }
        if (prev > 0) {
          console.log(`[HLS] ${channel} recovered after ${prev} consecutive failures`);
        }
        failureStreak.set(channel, 0);
        return url;
      })
      .catch(err => {
        const reason = err instanceof Error ? err.message : String(err);
        // Don't count "channel is offline" as a real failure — it's expected
        // when the streamer ends their broadcast. Timeouts never match this:
        // a hung browser is a real failure.
        const isOffline = /channel may be offline|No playback URL extracted/i.test(reason);
        if (!isOffline) {
          const n = (failureStreak.get(channel) || 0) + 1;
          failureStreak.set(channel, n);
          const last = lastAlertAt.get(channel) || 0;
          if (n >= ALERT_AFTER_FAILURES && Date.now() - last > ALERT_COOLDOWN_MS) {
            alertingNow.add(channel);
            lastAlertAt.set(channel, Date.now());
            telegram.notifyVisionBroken(channel, reason, n).catch(() => { /* ignore */ });
            console.log(`[HLS] Sent vision-broken telegram for ${channel} (streak=${n})`);
          }
        }
        throw err;
      })
      .finally(() => {
        this.inFlight.delete(channel);
      });
    this.inFlight.set(channel, p);
    return p;
  }

  /**
   * Mark the cached URL as stale. Use this when ffmpeg returns 403/410
   * (token rolled or stream ended). Next resolve() will re-fetch.
   */
  invalidate(channel: string): void {
    this.cache.delete(channel);
  }

  private async doResolve(channel: string): Promise<string> {
    const release = await acquireBrowserSlot();
    const session: BrowserSession = {};
    const run = this.runResolve(channel, session);
    // If the ceiling wins the race below, this rejects later with nothing
    // listening, and Node exits on an unhandled rejection.
    run.catch(() => { /* reported through the race */ });

    let ceiling: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          ceiling = setTimeout(
            () => reject(new Error(`HLS resolve for ${channel} timed out after ${RESOLVE_CEILING_MS / 1000}s — browser hung`)),
            RESOLVE_CEILING_MS
          );
        })
      ]);
    } finally {
      clearTimeout(ceiling);
      // Waited for before releasing the slot, and bounded: close, then a forced kill.
      await shutDown(channel, session);
      release();
    }
  }

  private async runResolve(channel: string, session: BrowserSession): Promise<string> {
    console.log(`[HLS] Resolving ${channel} via real browser...`);
    const t0 = Date.now();

    let page: any;
    try {
      session.launching = connect({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        turnstile: true,
        disableXvfb: false
      }) as Promise<{ browser: any; page: any }>;
      const r = await withTimeout(session.launching, LAUNCH_TIMEOUT_MS, 'Browser launch');
      session.browser = r.browser;
      page = r.page;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Browser launch failed: ${msg}`);
    }

    let liveUrl: string | null = null;

    page.on('response', async (res: any) => {
      if (liveUrl) return;
      const u = res.url();
      if (!u.includes('/api/v1/stream/') || !u.includes('/playback')) return;
      try {
        const body = await res.text();
        const parsed = JSON.parse(body) as PlaybackResponse;
        const live = parsed.playback_url?.live;
        if (typeof live === 'string' && live.includes('playback.live-video.net')) {
          liveUrl = live;
        }
      } catch {
        // Body unavailable / not JSON — ignore.
      }
    });

    await page.goto(`https://kick.com/${channel}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    // Poll for the playback API response. A healthy resolve on a live channel
    // measures ~22s end to end, so the old 25s budget left barely two seconds
    // of headroom and any slowdown — busy box, slow Cloudflare pass, several
    // browsers launching at once — surfaced as a bogus "channel may be
    // offline". Budget generously; the caller's own path is already async.
    const POLL_MS = 45000;
    const deadline = Date.now() + POLL_MS;
    while (!liveUrl && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }

    if (!liveUrl) {
      // Diagnose: still on Cloudflare interstitial vs page loaded but offline?
      let title = '';
      try { title = await withTimeout<string>(page.title(), TITLE_TIMEOUT_MS, 'Page title'); } catch { /* ignore */ }
      console.error(`[HLS] ${channel}: no playback URL after ${Date.now() - t0}ms (page title: "${title || 'unknown'}")`);
      if (/just a moment|attention required|cloudflare/i.test(title)) {
        throw new Error(`Cloudflare challenge not cleared for ${channel} (title: "${title}")`);
      }
      // Don't assert "offline" — that was misleading every time the real
      // cause was a slow resolve on a live channel.
      throw new Error(`No playback URL extracted for ${channel} within ${POLL_MS / 1000}s (page loaded, title: "${title || 'unknown'}") — channel is offline or the player never requested playback`);
    }

    const url: string = liveUrl;
    const tokenMatch = url.match(/[?&]token=([^&]+)/);
    const exp = tokenMatch ? decodeJwtExp(decodeURIComponent(tokenMatch[1])) : Math.floor(Date.now() / 1000) + 3600;

    this.cache.set(channel, { url, exp, resolvedAt: Date.now() });
    console.log(`[HLS] Resolved ${channel} in ${Date.now() - t0}ms (token exp in ${Math.floor((exp - Date.now() / 1000) / 60)}m)`);
    return url;
  }
}

export const hlsResolver = new HlsResolver();
