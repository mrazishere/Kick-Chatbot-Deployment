/**
 * Mention spike — end-to-end test for the @-mention vision pipeline.
 *
 * Usage:
 *   npx tsx scripts/mention-spike.ts <channel-slug> "<user message>"
 *
 * Pipeline:
 *   1. Get HLS playback URL (from cache, or stealth-browser resolve if needed)
 *   2. ffmpeg pulls 3 frames spaced 2s apart at 720p
 *   3. Claude Sonnet vision: system prompt + frames + user message → reply
 *   4. Print
 *
 * Cache: scripts/.hls-cache.json — keyed by slug, includes JWT exp for staleness check
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

interface HlsCacheEntry { slug: string; url: string; resolvedAt: number; exp: number }
interface HlsCache { entries: Record<string, HlsCacheEntry> }

const CACHE_PATH = path.join(process.cwd(), 'scripts', '.hls-cache.json');
const FRAMES_DIR = path.join(process.cwd(), 'scripts', '.frames');

function loadCache(): HlsCache {
  if (!fs.existsSync(CACHE_PATH)) return { entries: {} };
  try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) as HlsCache; } catch { return { entries: {} }; }
}
function saveCache(c: HlsCache): void { fs.writeFileSync(CACHE_PATH, JSON.stringify(c, null, 2)); }

function decodeJwtExp(jwt: string): number {
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return 0;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as { exp?: number };
    return payload.exp ?? 0;
  } catch { return 0; }
}

async function resolveHls(slug: string): Promise<string> {
  console.log(`    [resolve] launching stealth browser for ${slug}...`);
  const t0 = Date.now();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36');

    const masters: string[] = [];
    page.on('request', (req: any) => {
      const u = req.url();
      // Master playlist is on playback.live-video.net (not aps12.playlist...). Pick the first.
      if (u.includes('.m3u8') && u.includes('playback.live-video.net')) {
        masters.push(u);
      }
    });

    await page.goto(`https://kick.com/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Poll for up to 12s for the master m3u8 to be requested
    const deadline = Date.now() + 12000;
    while (masters.length === 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }

    if (masters.length === 0) throw new Error('No master m3u8 intercepted within 12s');
    console.log(`    [resolve] got master m3u8 in ${Date.now() - t0}ms`);
    return masters[0];
  } finally {
    await browser.close();
  }
}

async function getHlsUrl(slug: string): Promise<string> {
  const cache = loadCache();
  const entry = cache.entries[slug];
  const nowSec = Math.floor(Date.now() / 1000);
  if (entry && entry.exp > nowSec + 60) {
    console.log(`    [cache] HIT for ${slug} (exp in ${Math.floor((entry.exp - nowSec) / 60)}m)`);
    return entry.url;
  }
  if (entry) {
    console.log(`    [cache] STALE for ${slug} — re-resolving`);
  } else {
    console.log(`    [cache] MISS for ${slug} — resolving fresh`);
  }
  const url = await resolveHls(slug);
  // Extract token JWT from query string
  const tokenMatch = url.match(/[?&]token=([^&]+)/);
  const exp = tokenMatch ? decodeJwtExp(decodeURIComponent(tokenMatch[1])) : nowSec + 3600;
  cache.entries[slug] = { slug, url, resolvedAt: Date.now(), exp };
  saveCache(cache);
  return url;
}

async function captureFrames(hlsUrl: string, count: number, spacingSec: number): Promise<string[]> {
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const totalDuration = (count - 1) * spacingSec + 1;

  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', hlsUrl,
      '-vf', `fps=1/${spacingSec},scale=1280:-1`,
      '-frames:v', String(count),
      '-t', String(totalDuration),
      '-y',
      path.join(FRAMES_DIR, 'frame_%02d.jpg')
    ];
    const t0 = Date.now();
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      const files = fs.readdirSync(FRAMES_DIR).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(FRAMES_DIR, f));
      console.log(`    [ffmpeg] ${files.length} frames in ${Date.now() - t0}ms`);
      resolve(files);
    });
    ff.on('error', reject);
  });
}

async function callClaude(framePaths: string[], userMessage: string, channel: string, displayName: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  // Load the per-channel reference photo if it exists. Used as the source of truth for
  // streamer identification — solves "is the on-camera person actually the streamer or a guest?"
  const refPath = path.join(process.cwd(), 'data', 'channel-refs', `${channel}.jpg`);
  const refExists = fs.existsSync(refPath);
  const refSection = refExists
    ? `IDENTIFICATION REFERENCE: The FIRST image attached is a known reference photo of ${displayName}, the streamer. Use it as the source of truth for who is the streamer. The remaining ${framePaths.length} images are the live video frames. If the streamer is visible in the live frames, you can confidently use their name. If the on-camera person clearly does NOT match the reference, they're a guest/collab partner — use "their friend" / "guest" / "the dude on screen" instead, and don't conflate them with the streamer.`
    : `No reference photo for the streamer. Use camera POV / persistent-subject cues to identify them.`;

  const system = `You are MrAIisHere, a sharp-tongued AI viewer hanging out in a Kick.com livestream chat. You have a savage, sarcastic edge but you're not mean for no reason — you're funny, observant, and chat-natural.

Visual context: the LAST user message includes ${refExists ? '1 reference photo + ' : ''}${framePaths.length} live video frames captured a few seconds apart from the channel "${channel}" (streamer: ${displayName}). Use them as YOUR view of what's currently on stream.

${refSection}

When you reply:
- ANSWER THE USER'S QUESTION using both their text and what you can see in the live frames. The frames give you visual grounding for the streamer's current activity, location, who's on screen, what's happening.
- Match chat tone: short, punchy, max ~250 characters. Lowercase fine. No emojis unless they really fit.
- If the user asks something specific (like "what's he doing", "what's that thing"), look at the frames and answer specifically.
- If the user asks something the frames don't address (like a general question), answer normally without forcing visual references.
- Don't say "I see..." or "in the reference photo..." — just answer naturally.
- Don't start with the user's @handle (the bot harness adds it).`;

  const content: Array<Record<string, unknown>> = [];
  if (refExists) {
    const refBuf = fs.readFileSync(refPath);
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refBuf.toString('base64') } });
    console.log(`    [ref] using ${refPath} (${refBuf.length} bytes)`);
  } else {
    console.log(`    [ref] none — no reference photo at ${refPath}`);
  }
  for (const p of framePaths) {
    const buf = fs.readFileSync(p);
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: buf.toString('base64') } });
  }
  content.push({ type: 'text', text: userMessage });

  const t0 = Date.now();
  const res = await axios.post<{ content?: Array<{ text?: string }> }>(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system,
      messages: [{ role: 'user', content }]
    },
    {
      timeout: 30000,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    }
  );
  console.log(`    [claude] reply in ${Date.now() - t0}ms`);
  return (res.data.content?.[0]?.text ?? '').trim();
}

async function main() {
  const slug = process.argv[2];
  const userMessage = process.argv[3];
  if (!slug || !userMessage) {
    console.error('Usage: npx tsx scripts/mention-spike.ts <slug> "<user message>"');
    process.exit(1);
  }

  console.log(`[1/4] Resolving HLS URL for "${slug}"...`);
  const hlsUrl = await getHlsUrl(slug);

  console.log(`[2/4] Capturing 3 frames (2s apart) via ffmpeg...`);
  const framePaths = await captureFrames(hlsUrl, 3, 2);

  console.log(`[3/4] Calling Claude Sonnet with frames + user message...`);
  console.log(`      user message: ${userMessage}`);
  const reply = await callClaude(framePaths, userMessage, slug, 'PeeguuTV');

  console.log(`[4/4] Done. Frames preserved in ${FRAMES_DIR}`);

  console.log(`\n=== USER MESSAGE ===\n${userMessage}`);
  console.log(`\n=== CLAUDE REPLY ===\n${reply}\n====================\n`);
}

main().catch(err => {
  if (axios.isAxiosError(err)) {
    console.error('[ERROR]', err.message, err.response?.status, JSON.stringify(err.response?.data).substring(0, 300));
  } else if (err instanceof Error) {
    console.error('[ERROR]', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 5).join('\n'));
  } else {
    console.error('[ERROR]', err);
  }
  process.exit(1);
});
