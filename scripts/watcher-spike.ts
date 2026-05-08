/**
 * Stream-watcher spike — throwaway, not wired into the bot.
 *
 * Usage: npx tsx scripts/watcher-spike.ts <channel-slug>
 *
 * Pipeline:
 *   1. Read bot OAuth token from dist/.tokens.json
 *   2. GET api.kick.com/public/v1/channels?slug=<slug>
 *   3. If is_live, fetch stream.thumbnail (CDN, no auth)
 *   4. Send frame to Claude vision with a "co-viewer" prompt
 *   5. Print reply (or [skip])
 *
 * No chat post, no loop, no state — just prove the pipeline works end-to-end.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

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

interface KickChannelsResponse {
  data?: KickChannelData[];
}

interface AnthropicTextBlock { type: 'text'; text: string }
interface AnthropicResponse { content?: AnthropicTextBlock[] }

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
    {
      timeout: 15000,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    }
  );
  return res.data?.data?.[0] ?? null;
}

async function fetchThumbnail(url: string): Promise<{ buffer: Buffer; mediaType: string; url: string }> {
  // Kick exposes the same thumbnail at 360/480/720/1080 .webp by swapping the trailing path segment.
  // Use 720 — clearer than 480 (helps reduce vision model misreads) without the bandwidth of 1080.
  const upgraded = url.replace(/\/\d+\.webp$/, '/720.webp');
  const res = await axios.get<ArrayBuffer>(upgraded, {
    responseType: 'arraybuffer',
    timeout: 15000
  });
  const ct = (res.headers['content-type'] as string | undefined) ?? '';
  let mediaType = 'image/webp';
  if (ct.includes('png')) mediaType = 'image/png';
  else if (ct.includes('jpeg') || ct.includes('jpg')) mediaType = 'image/jpeg';
  return { buffer: Buffer.from(res.data), mediaType, url: upgraded };
}

async function callClaudeVision(
  imageBase64: string,
  mediaType: string,
  meta: { slug: string; title: string; category: string; viewers: number }
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const system = `You are a co-viewer in a Kick livestream's chat. You see what's on screen and chime in casually — like another person in chat — about whatever a real viewer would naturally focus on. Match the energy of an interested viewer, not a narrator or cinematographer.

What to focus on (priority order):
1. The PRIMARY SUBJECT — usually the streamer or another person on camera: what they're doing, holding, wearing, expression, reactions
2. The current ACTION or activity (gameplay moment, what they're cooking, who they're talking to, etc.)
3. Notable objects/things they're directly interacting with
4. Background or environment ONLY if that's clearly the point of the frame (e.g., a stunning view, a dramatic location reveal). Otherwise, ignore it.

Hard rules:
- 1 short message, max ~120 chars. Lowercase is fine. No emojis unless they're earned.
- Anchor your comment on the primary subject. Do NOT comment on lighting, floor reflections, color grading, or other purely visual/cinematographic details — that's not how viewers chat.
- Use the stream title and category as a sanity check. If your guess about what's happening contradicts the title/category, you're probably wrong — re-look or skip.
- DO NOT confidently name objects you can't clearly identify. Vague-but-correct beats specific-but-wrong. If you're not sure what something is, either describe it generically ("that thing she's holding", "what they're doing") or reply <skip>.
- DO NOT comment on text/usernames/messages visible inside the frame's chat overlay — those are stale by the time your message posts.
- If the frame is unclear, mostly UI/text, a loading screen, idle menu, transition, or nothing notable is happening, reply with exactly: <skip>
- Don't address the streamer by name. Don't say "I see..." — just say the thing.
- Don't repeat well-worn phrases. Sound like a person, not a bot.`;

  const userText = `Channel: ${meta.slug}
Title: ${meta.title || '(none)'}
Category: ${meta.category || '(none)'}
Viewers: ${meta.viewers}

Frame attached. Either chime in with one short message about something specific you can see, or reply <skip> if there's nothing worth saying.`;

  const res = await axios.post<AnthropicResponse>(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      system,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: userText }
          ]
        }
      ]
    },
    {
      timeout: 30000,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
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

  console.log(`[2/4] Fetching channel state for "${slug}"...`);
  const ch = await fetchChannel(slug, token);
  if (!ch) {
    console.error('Channel not found');
    process.exit(1);
  }
  const stream = ch.stream;
  console.log(`      is_live=${stream?.is_live} viewers=${stream?.viewer_count ?? 0} title="${ch.stream_title ?? ''}"`);
  console.log(`      category="${ch.category?.name ?? ''}"`);
  console.log(`      thumbnail=${stream?.thumbnail ?? '(none)'}`);

  if (!stream?.is_live) {
    console.log('Channel is offline. Spike requires a live channel.');
    process.exit(0);
  }
  if (!stream.thumbnail) {
    console.error('Live but no thumbnail URL. Bailing.');
    process.exit(1);
  }

  console.log(`[3/4] Fetching thumbnail...`);
  const t0 = Date.now();
  const { buffer, mediaType, url: fetched } = await fetchThumbnail(stream.thumbnail);
  console.log(`      ${buffer.length} bytes, ${mediaType}, ${Date.now() - t0}ms`);
  console.log(`      fetched=${fetched}`);

  console.log(`[4/4] Calling Claude vision...`);
  const t1 = Date.now();
  const reply = await callClaudeVision(buffer.toString('base64'), mediaType, {
    slug,
    title: ch.stream_title ?? '',
    category: ch.category?.name ?? '',
    viewers: stream.viewer_count ?? 0
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
