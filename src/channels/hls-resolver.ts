/**
 * HlsResolver — resolves Kick channels' master HLS playlist URLs by intercepting
 * the network request from a stealth headless browser visiting kick.com/<slug>.
 *
 * Why a stealth browser:
 *   Kick's HTML page and v2 API endpoints that expose the playback URL are
 *   Cloudflare-blocked from this server (HTTP 403 with security policy reference).
 *   Puppeteer-extra-plugin-stealth bypasses that block when navigating like a
 *   real Chrome user. The intercepted m3u8 URL itself is hosted on AWS IVS
 *   (playback.live-video.net) which is NOT Cloudflare-fronted, so subsequent
 *   ffmpeg calls work directly without browser involvement.
 *
 * Caching:
 *   The intercepted URL contains a JWT token with an `exp` claim (typically
 *   ~2 weeks out). We cache per-channel and re-resolve only when the cached
 *   URL is within 60s of expiry, or when the caller explicitly invalidates
 *   after a 403 from the upstream (e.g. token rolled mid-stream).
 *
 * Concurrency:
 *   Multiple simultaneous mention requests for the same channel are coalesced
 *   into a single in-flight resolve to avoid spinning up multiple browsers.
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

interface CachedHls {
  url: string;
  exp: number; // unix seconds
  resolvedAt: number; // ms
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

    const p = this.doResolve(channel).finally(() => {
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
    console.log(`[HLS] Resolving ${channel} via stealth browser...`);
    const t0 = Date.now();
    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });
    try {
      const page = await browser.newPage();
      await page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      );

      const masters: string[] = [];
      page.on('request', (req: any) => {
        const u = req.url();
        // Master playlist is on playback.live-video.net (AWS IVS).
        // The aps12.playlist.live-video.net URLs are media playlists, not what we want.
        if (u.includes('.m3u8') && u.includes('playback.live-video.net')) {
          masters.push(u);
        }
      });

      await page.goto(`https://kick.com/${channel}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Poll for up to 12s for the player to request its m3u8
      const deadline = Date.now() + 12000;
      while (masters.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
      }

      if (masters.length === 0) {
        throw new Error(`No master m3u8 intercepted for ${channel} within 12s — channel may be offline`);
      }

      const url = masters[0];
      const tokenMatch = url.match(/[?&]token=([^&]+)/);
      const exp = tokenMatch ? decodeJwtExp(decodeURIComponent(tokenMatch[1])) : Math.floor(Date.now() / 1000) + 3600;

      this.cache.set(channel, { url, exp, resolvedAt: Date.now() });
      console.log(`[HLS] Resolved ${channel} in ${Date.now() - t0}ms (token exp in ${Math.floor((exp - Date.now() / 1000) / 60)}m)`);
      return url;
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

export const hlsResolver = new HlsResolver();
