/**
 * Stream-watcher spike — throwaway, not wired into the bot.
 *
 * Usage: npx tsx scripts/watcher-spike.ts <channel-slug>
 *
 * Pipeline:
 *   1. Read bot OAuth token from dist/.tokens.json
 *   2. GET api.kick.com/public/v1/channels?slug=<slug> — fetch channel state.
 *      Repeat N times spaced K seconds apart to capture a sequence of frames
 *      across ~30s of stream content. Dedupe by thumbnail URL.
 *   3. GET api.kick.com/public/v1/users?id=<broadcaster_id> for display name
 *   4. Fetch each unique thumbnail at 720p (CDN, no auth)
 *   5. Send all frames in time-order to Claude Sonnet with a "co-viewer" prompt
 *      that asks it to comment on what's HAPPENING across the sequence, or skip
 *   6. Print reply (or [skip])
 *
 * No chat post, no loop, no state — just prove the pipeline works end-to-end.
 *
 * Why multi-frame:
 *   IRL streams flip scenes constantly; a single thumbnail might be a close-up
 *   of a friend's face or a transition. Multiple frames let the model see what's
 *   actually happening across time, identify the streamer as the persistent
 *   subject, and skip cleanly when nothing coherent is going on.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const FRAME_COUNT = 3;
const FRAME_INTERVAL_MS = 15000;

interface KickStream {
  is_live?: boolean;
  thumbnail?: string;
  viewer_count?: number;
  start_time?: string;
}

interface KickChannelData {
  broadcaster_user_id?: number;
  slug?: string;
  stream?: KickStream | null;
  stream_title?: string;
  category?: { id?: number; name?: string };
}

interface KickChannelsResponse { data?: KickChannelData[] }

interface KickUserData {
  user_id?: number;
  name?: string;
  profile_picture?: string;
}

interface KickUsersResponse { data?: KickUserData[] }

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicResponse { content?: AnthropicTextBlock[] }

interface ImageBlob { buffer: Buffer; mediaType: string; url: string; capturedAt: number }

function readBotToken(): string {
  const candidates = [
    path.join(process.cwd(), 'dist', '.tokens.json'),
    path.join(process.cwd(), '.tokens.json')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const tok = (raw.access_token ?? raw.accessToken) as string | undefined;
      if (tok) return tok;
    }
  }
  throw new Error('No bot token found in dist/.tokens.json or .tokens.json');
}

async function fetchChannel(slug: string, token: string): Promise<KickChannelData | null> {
  const res = await axios.get<KickChannelsResponse>(
    `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(slug)}`,
    { timeout: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  return res.data?.data?.[0] ?? null;
}

async function fetchUser(broadcasterUserId: number, token: string): Promise<KickUserData | null> {
  const res = await axios.get<KickUsersResponse>(
    `https://api.kick.com/public/v1/users?id=${broadcasterUserId}`,
    { timeout: 15000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
  );
  return res.data?.data?.[0] ?? null;
}

async function fetchThumbnail(url: string): Promise<ImageBlob> {
  const upgraded = url.replace(/\/\d+\.webp$/, '/720.webp');
  const res = await axios.get<ArrayBuffer>(upgraded, { responseType: 'arraybuffer', timeout: 15000 });
  const ct = (res.headers['content-type'] as string | undefined) ?? '';
  let mediaType = 'image/webp';
  if (ct.includes('png')) mediaType = 'image/png';
  else if (ct.includes('jpeg') || ct.includes('jpg')) mediaType = 'image/jpeg';
  return { buffer: Buffer.from(res.data), mediaType, url: upgraded, capturedAt: Date.now() };
}

async function captureFrameSequence(slug: string, token: string): Promise<ImageBlob[]> {
  const seenUrls = new Set<string>();
  const frames: ImageBlob[] = [];

  for (let i = 0; i < FRAME_COUNT; i++) {
    if (i > 0) {
      await new Promise(r => setTimeout(r, FRAME_INTERVAL_MS));
    }
    const ch = await fetchChannel(slug, token);
    const thumbUrl = ch?.stream?.thumbnail;
    if (!thumbUrl) {
      console.log(`      frame ${i + 1}/${FRAME_COUNT}: no thumbnail (offline?)`);
      continue;
    }
    if (seenUrls.has(thumbUrl)) {
      console.log(`      frame ${i + 1}/${FRAME_COUNT}: same URL as previous capture, skipping`);
      continue;
    }
    seenUrls.add(thumbUrl);
    try {
      const frame = await fetchThumbnail(thumbUrl);
      frames.push(frame);
      console.log(`      frame ${i + 1}/${FRAME_COUNT}: ${frame.buffer.length} bytes (${frame.url.match(/\/([^/]+\/[^/]+)\/720/)?.[1]})`);
    } catch (e) {
      if (e instanceof Error) console.warn(`      frame ${i + 1} fetch failed: ${e.message}`);
    }
  }
  return frames;
}

async function callClaudeVision(
  frames: ImageBlob[],
  meta: { slug: string; displayName: string; title: string; category: string; viewers: number }
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const system = `You are a co-viewer in a Kick livestream's chat. You see what's on screen and chime in casually — like another person in chat — about whatever a real viewer would naturally focus on. Match the energy of an interested viewer, not a narrator or cinematographer.

You will receive a SEQUENCE of ${frames.length} frames captured across roughly ${(frames.length - 1) * (FRAME_INTERVAL_MS / 1000)} seconds of the live stream. Use the sequence to understand what's actually happening — motion, continuity, who's persistently on camera — instead of treating each frame as an isolated still.

Streamer identification:
- The streamer's display name is "${meta.displayName}" (channel slug: "${meta.slug}").
- The streamer is the PERSISTENT subject across the frames — the camera follows them. Look for who shows up consistently, who's holding the camera/phone-rig, who chat is addressing.
- If you can confidently identify the streamer (e.g., the same person walking through multiple frames with consistent clothes/hair), you MAY reference them by name (use a casual short form like "${meta.displayName.toLowerCase()}" or pronouns — chat-natural). If unsure, use "she" / "he" / "they" / generic descriptions.

What to focus on (priority order):
1. The PRIMARY ACTION across frames — what is the streamer (or main subject) doing? Walking somewhere, eating, fighting in a game, talking to someone?
2. A NOTABLE CHANGE between frames — entered a new place, picked something up, reacted to something, scene shift worth calling out.
3. A SPECIFIC interesting moment in one frame that stands out — what they're holding, expression, who they're with.
4. Background/environment ONLY if it's clearly the point (a stunning view, a wild reveal). Otherwise, ignore.

DEFAULT TO SKIP. Most cycles should reply <skip>. Only post when there's something genuinely worth a chat viewer commenting on. Reply <skip> if:
- Frames are mostly transitions, close-ups of unidentifiable faces, idle UI, loading screens.
- You can't tell what the streamer is doing or even if they're visible.
- Your best comment would be vague ("some place", "looks busy") — that's not worth posting.
- The frames look basically the same (no motion / nothing happening).
- You'd be guessing about object/place identity.

Hard rules when you DO post:
- 1 short message, max ~120 chars. Lowercase is fine. No emojis unless earned.
- Anchor on the primary action or subject. Do NOT comment on lighting, reflections, color grading.
- Use the stream title and category as a sanity check. If your guess contradicts them, reconsider or skip.
- DO NOT confidently name objects/places you can't clearly identify. Vague-but-correct beats specific-but-wrong.
- DO NOT comment on text/usernames/chat-overlay messages visible in the frames — those are stale.
- Don't say "I see..." — just say the thing. Sound like a person, not a bot.`;

  const userText = `Channel: ${meta.slug}
Streamer: ${meta.displayName}
Title: ${meta.title || '(none)'}
Category: ${meta.category || '(none)'}
Viewers: ${meta.viewers}

${frames.length} frames attached in time order (oldest first, newest last; ~${FRAME_INTERVAL_MS / 1000}s between captures).

Either chime in with one short message about what's actually happening across the sequence, or reply <skip>. Default to <skip> if you're not genuinely sure what's worth commenting on.`;

  const content: Array<Record<string, unknown>> = [];
  for (const f of frames) {
    content.push({ type: 'image', source: { type: 'base64', media_type: f.mediaType, data: f.buffer.toString('base64') } });
  }
  content.push({ type: 'text', text: userText });

  const res = await axios.post<AnthropicResponse>(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content }]
    },
    {
      timeout: 30000,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
    }
  );

  const text = res.data.content?.[0]?.text ?? '';
  return text.trim();
}

async function main(): Promise<void> {
  const slug = process.argv[2];
  if (!slug) {
    console.error('Usage: npx tsx scripts/watcher-spike.ts <channel-slug>');
    process.exit(1);
  }

  console.log(`[1/4] Reading bot token...`);
  const token = readBotToken();

  console.log(`[2/4] Fetching initial channel state for "${slug}"...`);
  const ch = await fetchChannel(slug, token);
  if (!ch) { console.error('Channel not found'); process.exit(1); }
  if (!ch.stream?.is_live) { console.log('Channel is offline. Spike requires a live channel.'); process.exit(0); }
  console.log(`      is_live=true viewers=${ch.stream.viewer_count ?? 0} title="${ch.stream_title ?? ''}"`);
  console.log(`      category="${ch.category?.name ?? ''}"`);

  let displayName = slug;
  if (ch.broadcaster_user_id) {
    const user = await fetchUser(ch.broadcaster_user_id, token);
    if (user?.name) {
      displayName = user.name;
      console.log(`      displayName=${displayName}`);
    }
  }

  console.log(`[3/4] Capturing ${FRAME_COUNT} frames over ~${(FRAME_COUNT - 1) * FRAME_INTERVAL_MS / 1000}s...`);
  const frames = await captureFrameSequence(slug, token);
  if (frames.length === 0) {
    console.error('No frames captured. Bailing.');
    process.exit(1);
  }

  // Save frames for visual inspection
  frames.forEach((f, i) => {
    const out = path.join(process.cwd(), 'scripts', `seq-frame-${i + 1}.webp`);
    fs.writeFileSync(out, f.buffer);
  });
  console.log(`      saved ${frames.length} frame(s) to scripts/seq-frame-*.webp`);

  console.log(`[4/4] Calling Claude Sonnet with ${frames.length} frames...`);
  const t1 = Date.now();
  const reply = await callClaudeVision(frames, {
    slug,
    displayName,
    title: ch.stream_title ?? '',
    category: ch.category?.name ?? '',
    viewers: ch.stream.viewer_count ?? 0
  });
  console.log(`      ${Date.now() - t1}ms`);

  console.log('\n=== CLAUDE REPLY ===');
  console.log(reply);
  console.log('====================');
}

main().catch(err => {
  if (axios.isAxiosError(err)) {
    console.error('[ERROR]', err.message, err.response?.status, JSON.stringify(err.response?.data).substring(0, 300));
  } else if (err instanceof Error) {
    console.error('[ERROR]', err.message);
  } else {
    console.error('[ERROR]', err);
  }
  process.exit(1);
});
