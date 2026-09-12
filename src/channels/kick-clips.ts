/**
 * Creating Kick clips.
 *
 * Kick's public API has no clips at all — no endpoint, no scope, no event. The
 * site's own client uses an internal API, and this mirrors exactly what it does
 * when a viewer presses the clip button on a live stream:
 *
 *   POST /api/internal/v1/livestreams/{livestream}/clips        (empty body)
 *        -> { id, url, source_duration }  — Kick grabs a ~90s buffer
 *   POST /api/internal/v1/livestreams/{livestream}/clips/{clipId}/finalize
 *        { duration, start_time, title }  — SECONDS, a window inside that buffer
 *
 * So "the last 30 seconds" is start_time = source_duration - 30, duration = 30.
 * Verified live on 2026-09-12: an empty initiate body is required (sending
 * {duration} returns 400), and finalize returns the finished clip.
 *
 * The bearer token creates clips but cannot delete them — DELETE /api/v2/clips
 * answers 401 for it, and cookie auth needs more than the session cookie. A clip
 * made by mistake has to be removed from Kick's own UI.
 *
 * `{livestream}` binds a LiveStream model, NOT the channel: passing a channel
 * slug returns "No query results for model [App\Models\LiveStream]". The id and
 * slug both come from api/v2/channels/<slug>.livestream.
 *
 * Auth is the bot account's session token as a bearer, with the same headers the
 * site sends. Being unofficial, any of this can change without notice; every
 * failure is reported rather than retried blindly.
 */

import axios, { AxiosError } from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const WEB = 'https://kick.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
/** Kick's own clip creator defaults to 30 seconds. */
export const DEFAULT_CLIP_SECONDS = 30;
/** Titles are validated client-side as 1–50 characters. */
export const MAX_TITLE = 50;
const TIMEOUT_MS = 20_000;

export interface LiveStreamRef {
  id: number;
  slug: string;
  sessionTitle: string;
}

export interface CreatedClip {
  id: string;
  title: string;
  durationSeconds: number;
  /** What to post in chat. */
  url: string;
}

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-app-platform': 'web',
    Referer: `${WEB}/`,
    'User-Agent': UA
  };
}

function detail(err: unknown): string {
  const e = err as AxiosError;
  if (e?.isAxiosError) {
    const body = typeof e.response?.data === 'string' ? e.response.data : JSON.stringify(e.response?.data ?? '');
    return `HTTP ${e.response?.status ?? '?'} ${body.slice(0, 200)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * The Kick session token used to create clips.
 *
 * Deliberately never logs in: Kick rate-limits /mobile/login hard from this
 * server (429 for hours, even through the stealth browser), and retrying would
 * only deepen it. The token is supplied by hand — the `session_token` cookie
 * from a logged-in kick.com browser — and whichever account it belongs to is
 * the account clips are created by.
 *
 * Order: KICK_SESSION_TOKEN in the environment, then .session.json.
 */
export function sessionToken(): string | null {
  const fromEnv = (process.env.KICK_SESSION_TOKEN || '').trim();
  if (fromEnv) return decodeURIComponent(fromEnv);
  for (const file of [path.join(process.cwd(), '.session.json'), path.join(__dirname, '..', '.session.json')]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown };
      if (typeof raw.token === 'string' && raw.token.trim()) return decodeURIComponent(raw.token.trim());
    } catch { /* try the next location */ }
  }
  return null;
}

/** The channel's current livestream, or null when it isn't live. Needs no auth. */
export async function currentLivestream(channelSlug: string): Promise<LiveStreamRef | null> {
  const res = await axios.get(`${WEB}/api/v2/channels/${encodeURIComponent(channelSlug)}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    timeout: TIMEOUT_MS
  });
  const ls = (res.data as { livestream?: { id?: number; slug?: string; session_title?: string; is_live?: boolean } | null })?.livestream;
  if (!ls || ls.is_live !== true || !ls.id) return null;
  return { id: ls.id, slug: typeof ls.slug === 'string' ? ls.slug : String(ls.id), sessionTitle: ls.session_title ?? '' };
}

/** A clip title Kick will accept: trimmed, single-spaced and never longer than 50 characters. */
export function cleanTitle(raw: string, fallback: string): string {
  const text = (raw || '').replace(/\s+/g, ' ').trim() || fallback.replace(/\s+/g, ' ').trim() || 'Clip';
  return Array.from(text).slice(0, MAX_TITLE).join('').trim() || 'Clip';
}

/**
 * The title for a clip nobody named: the stream title plus who clipped it.
 *
 * Kick caps titles at 50 characters, so the stream title is what gets cut (on a
 * word boundary) — the credit is the part worth keeping.
 */
export function fallbackTitle(sessionTitle: string, username: string): string {
  const suffix = ` - clipped by ${username}`.replace(/\s+/g, ' ');
  const stream = (sessionTitle || '').replace(/\s+/g, ' ').trim();
  const room = MAX_TITLE - suffix.length;
  if (!stream || room < 8) return cleanTitle(`Clipped by ${username}`, 'Clip');
  let head = Array.from(stream).slice(0, room).join('').trim();
  // Don't end on half a word unless trimming would leave almost nothing.
  if (head.length < stream.length) {
    const cut = head.replace(/\s+\S*$/, '');
    if (cut.length >= 8) head = cut;
  }
  return cleanTitle(head + suffix, `Clipped by ${username}`);
}

/**
 * Clip the last `durationMs` of a live stream.
 *
 * Two calls, as the site does: initiate reserves a clip against the livestream,
 * finalize commits the window and the title. `start_time` is an offset inside
 * the clip's own buffer, and 0 with a 30s duration is what the site sends for
 * "the last 30 seconds".
 */
export async function clipLiveStream(args: {
  channelSlug: string;
  token: string;
  title: string;
  seconds?: number;
}): Promise<CreatedClip> {
  const want = Math.max(1, Math.round(args.seconds ?? DEFAULT_CLIP_SECONDS));
  const live = await currentLivestream(args.channelSlug);
  if (!live) throw new Error(`${args.channelSlug} is not live`);

  // Initiate takes no body: Kick decides how much of the stream it can offer.
  let clipId = '';
  let sourceSeconds = want;
  try {
    const res = await axios.post(
      `${WEB}/api/internal/v1/livestreams/${encodeURIComponent(live.slug)}/clips`,
      {},
      { headers: headers(args.token), timeout: TIMEOUT_MS }
    );
    const data = res.data as { id?: string; source_duration?: number };
    clipId = typeof data?.id === 'string' ? data.id : '';
    if (typeof data?.source_duration === 'number' && data.source_duration > 0) sourceSeconds = data.source_duration;
  } catch (err) {
    throw new Error(`starting the clip: ${detail(err)}`);
  }
  if (!clipId) throw new Error('Kick returned no clip id');

  // Take the END of the buffer: that is what just happened on stream.
  const duration = Math.min(want, sourceSeconds);
  const startTime = Math.max(0, Math.round(sourceSeconds - duration));
  const title = cleanTitle(args.title, live.sessionTitle);
  try {
    const res = await axios.post(
      `${WEB}/api/internal/v1/livestreams/${encodeURIComponent(live.slug)}/clips/${encodeURIComponent(clipId)}/finalize`,
      { duration, start_time: startTime, title },
      { headers: headers(args.token), timeout: 30_000 }
    );
    const body = res.data as { id?: string };
    const finalId = typeof body?.id === 'string' ? body.id : clipId;
    return { id: finalId, title, durationSeconds: duration, url: `${WEB}/${args.channelSlug}?clip=${finalId}` };
  } catch (err) {
    throw new Error(`finalizing the clip: ${detail(err)}`);
  }
}
