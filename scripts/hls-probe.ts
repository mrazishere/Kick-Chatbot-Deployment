/**
 * Probe — can we resolve a Kick channel's HLS playback URL via stealth browser?
 *
 * Goal: bypass the Cloudflare block on kick.com / api/v2 endpoints from this server.
 * Strategy: spin up puppeteer-extra with stealth, load kick.com/<slug>, intercept
 * network requests for .m3u8 URLs, return the first one.
 *
 * Throwaway. Not wired into anything.
 */

/* eslint-disable @typescript-eslint/no-var-requires */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function main() {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: npx tsx scripts/hls-probe.ts <channel-slug>');
    process.exit(1);
  }

  console.log(`[1] Launching headless stealth browser...`);
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');
  console.log(`    launched in ${Date.now() - t0}ms`);

  const m3u8Urls: string[] = [];
  const allUrls: string[] = [];
  page.on('request', (req: { url: () => string }) => {
    const u = req.url();
    allUrls.push(u);
    if (u.includes('.m3u8')) {
      m3u8Urls.push(u);
      console.log(`    >> intercepted m3u8: ${u}`);
    }
  });

  console.log(`[2] Navigating to kick.com/${slug}...`);
  const t1 = Date.now();
  try {
    await page.goto(`https://kick.com/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log(`    DOMContentLoaded in ${Date.now() - t1}ms`);
  } catch (err: any) {
    console.error(`    navigation failed: ${err.message}`);
  }

  console.log(`[3] Waiting 8s for player to initialize...`);
  await new Promise(r => setTimeout(r, 8000));

  await browser.close();

  console.log(`\n=== RESULTS ===`);
  console.log(`Total network requests: ${allUrls.length}`);
  console.log(`m3u8 URLs intercepted: ${m3u8Urls.length}`);
  if (m3u8Urls.length > 0) {
    console.log(`Master playlist (first):`);
    console.log(`  ${m3u8Urls[0]}`);
  } else {
    console.log(`No m3u8 URLs seen. Sample of last 10 requests for debugging:`);
    allUrls.slice(-10).forEach(u => console.log(`  ${u}`));
  }
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
