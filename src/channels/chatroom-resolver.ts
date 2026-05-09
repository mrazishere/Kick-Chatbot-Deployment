/**
 * ChatroomResolver — resolves a Kick channel slug to its numeric chatroom_id by
 * fetching kick.com/api/v2/channels/<slug> through a stealth headless browser.
 *
 * Why a stealth browser:
 *   The v2 endpoint is Cloudflare-blocked from this server's IP (HTTP 403 with
 *   security policy reference). Public/v1 endpoints don't expose chatroom_id —
 *   only broadcaster_user_id and channel_id (both of which differ from
 *   chatroom_id). Stealth puppeteer makes the request look like a real Chrome
 *   user and gets through the WAF, same trick used by hls-resolver.
 *
 * Caching:
 *   chatroom_id is a permanent record per channel; cache for the process
 *   lifetime. The cost of a miss is ~3s (browser launch + nav + parse), so
 *   re-enrollments and noisy callers don't blow up.
 *
 * Concurrency:
 *   Multiple simultaneous resolves for the same channel are coalesced into a
 *   single in-flight browser launch.
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

export class ChatroomResolver {
  private cache: Map<string, number> = new Map();
  private inFlight: Map<string, Promise<number>> = new Map();

  async resolve(channel: string): Promise<number> {
    const slug = channel.toLowerCase();
    const cached = this.cache.get(slug);
    if (cached) return cached;

    const existing = this.inFlight.get(slug);
    if (existing) return existing;

    const p = this.doResolve(slug).finally(() => {
      this.inFlight.delete(slug);
    });
    this.inFlight.set(slug, p);
    return p;
  }

  private async doResolve(slug: string): Promise<number> {
    console.log(`[CHATROOM] Resolving ${slug} via stealth browser...`);
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

      const resp = await page.goto(`https://kick.com/api/v2/channels/${slug}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      if (!resp || resp.status() !== 200) {
        throw new Error(`Kick v2 returned HTTP ${resp ? resp.status() : 'no response'} for ${slug}`);
      }

      const body = await resp.text();
      const json = JSON.parse(body) as { chatroom?: { id?: number } };
      const id = json.chatroom?.id;

      if (!id || typeof id !== 'number') {
        throw new Error(`No chatroom.id in v2 response for ${slug}`);
      }

      this.cache.set(slug, id);
      console.log(`[CHATROOM] Resolved ${slug} → ${id} in ${Date.now() - t0}ms`);
      return id;
    } finally {
      await browser.close().catch(() => {});
    }
  }
}

export const chatroomResolver = new ChatroomResolver();
