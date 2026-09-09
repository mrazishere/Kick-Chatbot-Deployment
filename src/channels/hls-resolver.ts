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
 *   into a single in-flight resolve.
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
        // when the streamer ends their broadcast.
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
    console.log(`[HLS] Resolving ${channel} via real browser...`);
    const t0 = Date.now();

    let browser: any;
    let page: any;
    try {
      const r = await connect({
        headless: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        turnstile: true,
        disableXvfb: false
      });
      browser = r.browser;
      page = r.page;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Browser launch failed: ${msg}`);
    }

    try {
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
        try { title = await page.title(); } catch { /* ignore */ }
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
    } finally {
      await browser.close().catch(() => { /* ignore */ });
    }
  }
}

export const hlsResolver = new HlsResolver();
