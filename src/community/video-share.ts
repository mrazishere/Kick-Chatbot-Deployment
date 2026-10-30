/**
 * Video sharing: `$<cmd> video <youtube link>` pays to play a YouTube video, with
 * sound, on the channel's video overlay (its own browser source, apart from the
 * fishing one). Priced per second played (points.video), one at a time, in the order
 * paid for.
 *
 * The queue lives in the points database (video_queue) so the bot, which takes the
 * payments, and the enrollment service, which answers the overlay, share it. It moves
 * on as the overlay polls: the one playing ends `seconds` (plus a little for the player
 * to load) after it started, and the next starts on the poll after that. No overlay
 * open, nothing plays, so `video` turns viewers away until one is.
 */

import type { PointsDb } from '../points/db';
import { runWrite } from '../points/db';
import { creditTx } from '../points/store';

/** A row of video_queue. */
export interface QueuedVideo {
  id: number;
  ts: number;
  user_id: number;
  username: string;
  video_id: string;
  title: string;
  /** Where in the video it starts, in seconds. */
  start_s: number;
  /** How long it plays, in seconds. */
  seconds: number;
  cost: number;
  status: 'queued' | 'playing' | 'done' | 'skipped' | 'failed';
  started_at: number | null;
  ended_at: number | null;
}

/** Added to a video's slot for the player to load before it starts playing. */
export const LOAD_PAD_MS = 4_000;

// ─── Links ──────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** "90", "90s", "1m30s", "1h2m3s" as seconds; null if it's none of those. */
function parseStart(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return parseInt(raw, 10);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/**
 * The video and start time in a YouTube link: watch?v=, youtu.be/, shorts/, embed/
 * and live/ forms, from youtube.com, m., music. or www., with ?t= or ?start=.
 * Null for anything else.
 */
export function parseYouTubeLink(raw: string | undefined): { id: string; start: number } | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  }
  if (!id || !ID_RE.test(id)) return null;
  const start = parseStart(url.searchParams.get('t') ?? url.searchParams.get('start'));
  return { id, start: start ?? 0 };
}

// ─── YouTube lookup ─────────────────────────────────────────────────────────

export interface VideoInfo {
  title: string;
  /** Whole seconds; 0 for a livestream. */
  durationS: number;
  embeddable: boolean;
  ageRestricted: boolean;
  /** A livestream, live now or still to come. */
  live: boolean;
  /** Countries YouTube blocks it in (ISO codes); empty when none. */
  blockedIn: string[];
  /** The only countries it plays in, when its owner set such a list. */
  onlyIn: string[] | null;
}

/** "PT1H2M3S" or "P1DT2H" as seconds. */
export function isoDurationSeconds(iso: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * A video's title, length and whether it can play on the overlay, from the YouTube
 * Data API (YOUTUBE_API_KEY). Null when YouTube has no such public video; throws when
 * the lookup itself fails.
 */
export async function lookupVideo(id: string, apiKey: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<VideoInfo | null> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status,snippet&id=${encodeURIComponent(id)}&key=${encodeURIComponent(apiKey)}`;
  const res = await fetchFn(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`YouTube API answered ${res.status}`);
  const body = await res.json() as { items?: Array<{ snippet?: { title?: string; liveBroadcastContent?: string }; contentDetails?: { duration?: string; contentRating?: { ytRating?: string }; regionRestriction?: { allowed?: string[]; blocked?: string[] } }; status?: { embeddable?: boolean; privacyStatus?: string } }> };
  const v = body.items?.[0];
  if (!v || v.status?.privacyStatus === 'private') return null;
  return {
    title: (v.snippet?.title ?? 'a video').replace(/[@<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'a video',
    durationS: isoDurationSeconds(v.contentDetails?.duration ?? ''),
    embeddable: v.status?.embeddable !== false,
    ageRestricted: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
    live: (v.snippet?.liveBroadcastContent ?? 'none') !== 'none',
    blockedIn: v.contentDetails?.regionRestriction?.blocked ?? [],
    onlyIn: v.contentDetails?.regionRestriction?.allowed ?? null
  };
}

export interface AltVideo { videoId: string; title: string; channel: string; durationS: number }

/** Search-noise in titles ("(Official Music Video)", "[Lyrics]"): dropped from an alternative search. */
const altQuery = (title: string): string => title.replace(/[([][^)\]]*[)\]]/g, ' ').replace(/\s+/g, ' ').trim() || title;

/**
 * YouTube videos for the media share player to queue: up to `max` that YouTube lets play outside
 * its site, not age-restricted, not live, no longer than `maxS`, and without "only in these
 * countries" lists (the phone's country isn't known). Unlocked ones first, then nearest to `wantS`
 * in length when given. One search (100 quota units) plus one lookup (1 unit).
 */
export async function searchPlayable(query: string, apiKey: string, opts: { max: number; maxS: number; excludeId?: string; wantS?: number }, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<AltVideo[]> {
  const q = encodeURIComponent(query.slice(0, 100));
  const found = await fetchFn(`https://www.googleapis.com/youtube/v3/search?part=id&type=video&maxResults=15&videoEmbeddable=true&videoSyndicated=true&q=${q}&key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(8_000) });
  if (!found.ok) throw new Error(`YouTube search answered ${found.status}`);
  const ids = ((await found.json() as { items?: Array<{ id?: { videoId?: string } }> }).items ?? [])
    .map(i => i.id?.videoId).filter((id): id is string => !!id && id !== opts.excludeId);
  if (!ids.length) return [];
  const res = await fetchFn(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails,status,snippet&id=${ids.map(encodeURIComponent).join(',')}&key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`YouTube API answered ${res.status}`);
  const body = await res.json() as { items?: Array<{ id?: string; snippet?: { title?: string; channelTitle?: string; liveBroadcastContent?: string }; contentDetails?: { duration?: string; contentRating?: { ytRating?: string }; regionRestriction?: { allowed?: string[]; blocked?: string[] } }; status?: { embeddable?: boolean; privacyStatus?: string } }> };
  const clean = (t: string | undefined, max: number) => (t ?? '').replace(/[@<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  const order = new Map(ids.map((id, i) => [id, i]));
  return (body.items ?? [])
    .filter(v => v.id && v.status?.embeddable !== false && v.status?.privacyStatus !== 'private'
      && v.contentDetails?.contentRating?.ytRating !== 'ytAgeRestricted' && (v.snippet?.liveBroadcastContent ?? 'none') === 'none'
      && !v.contentDetails?.regionRestriction?.allowed)
    .map(v => ({
      alt: { videoId: v.id as string, title: clean(v.snippet?.title, 100) || 'a video', channel: clean(v.snippet?.channelTitle, 60), durationS: isoDurationSeconds(v.contentDetails?.duration ?? '') },
      locked: (v.contentDetails?.regionRestriction?.blocked ?? []).length ? 1 : 0
    }))
    .filter(x => x.alt.durationS > 0 && x.alt.durationS <= opts.maxS)
    // Unlocked first; then nearest the wanted length, or YouTube's own order for a plain search.
    .sort((a, b) => a.locked - b.locked || (opts.wantS
      ? Math.abs(a.alt.durationS - opts.wantS) - Math.abs(b.alt.durationS - opts.wantS)
      : (order.get(a.alt.videoId) ?? 0) - (order.get(b.alt.videoId) ?? 0)))
    .slice(0, opts.max)
    .map(x => x.alt);
}

/**
 * Other uploads of a video that wouldn't play: up to 3, close to its length (never a 10-hour
 * loop for a 3-minute song), noise like "(Official Music Video)" dropped from the search.
 */
export function findAlternatives(title: string, excludeId: string, wantS: number, apiKey: string, fetchFn: FetchLike = fetch as unknown as FetchLike): Promise<AltVideo[]> {
  const maxS = wantS > 0 ? Math.max(wantS * 1.5, wantS + 120) : 20 * 60;
  return searchPlayable(altQuery(title), apiKey, { max: 3, maxS, excludeId, wantS }, fetchFn);
}

/** Country codes as a short list: all of them when few, else a count. */
const countries = (codes: string[]): string => codes.length <= 6 ? codes.join(', ') : `${codes.length} countries`;

/** Why YouTube's embedded player refused a video, from its error code alone. */
export function youTubeErrorReason(code: number): string {
  if (code === 2) return 'the link is broken';
  if (code === 5) return "this phone's browser can't play it";
  if (code === 100) return 'it was removed or made private';
  if (code === 101 || code === 150) return 'YouTube blocks it here: it may be blocked in your country, age-restricted, or its owner turned off playing it outside YouTube';
  if (code === 153) return 'YouTube rejected this player page';
  return `YouTube refused it (error ${code})`;
}

/**
 * Why a video won't play outside YouTube in any country (removed, embedding off, age-restricted,
 * blocked everywhere), or null. Region locks that depend on where the player is aren't counted.
 */
export function neverPlaysReason(info: VideoInfo | null): string | null {
  if (!info) return 'it was removed or made private';
  if (!info.embeddable) return 'its owner turned off playing it outside YouTube';
  if (info.ageRestricted) return 'it is age-restricted, and YouTube only plays those on its own site';
  if (info.onlyIn && !info.onlyIn.length) return 'it is blocked in every country';
  return null;
}

/** Why a looked-up video won't play outside YouTube, or null when YouTube shows no reason. */
export function unplayableReason(info: VideoInfo | null): string | null {
  if (!info) return 'it was removed or made private';
  // Every reason that applies: a region lock doesn't hide embedding being off, or the other way round.
  const reasons: string[] = [];
  if (!info.embeddable) reasons.push('its owner turned off playing it outside YouTube');
  if (info.ageRestricted) reasons.push('it is age-restricted, and YouTube only plays those on its own site');
  if (info.onlyIn) {
    reasons.push(!info.onlyIn.length ? 'it is blocked in every country'
      : info.onlyIn.length <= 6 ? `it only plays in ${info.onlyIn.join(', ')}`
        : `it is only licensed in some countries (${info.onlyIn.length}), probably not where this phone is`);
  }
  else if (info.blockedIn.length) reasons.push(`it is blocked in ${countries(info.blockedIn)}`);
  return reasons.length ? reasons.join('; and ') : null;
}

// ─── The queue ──────────────────────────────────────────────────────────────

const SEEN_KEY = 'video_overlay_seen';
/** An overlay that polled this recently is open. */
const SEEN_FRESH_MS = 60_000;

/** The video overlay asked for its feed: it's open. */
export function markVideoOverlaySeen(db: PointsDb, now = Date.now()): void {
  runWrite(db, () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SEEN_KEY, String(now));
  });
}

export function videoOverlayShowing(db: PointsDb, now = Date.now()): boolean {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SEEN_KEY) as { value: string } | undefined;
  return !!row && now - Number(row.value) < SEEN_FRESH_MS;
}

/** The videos waiting, first in line first. */
export function waitingVideos(db: PointsDb): QueuedVideo[] {
  return db.prepare("SELECT * FROM video_queue WHERE status = 'queued' ORDER BY id").all() as QueuedVideo[];
}

/** The video playing, if any (it may be past its end until the next poll moves the queue on). */
export function playingVideo(db: PointsDb): QueuedVideo | undefined {
  return db.prepare("SELECT * FROM video_queue WHERE status = 'playing' ORDER BY id LIMIT 1").get() as QueuedVideo | undefined;
}

/** Whether this viewer has a video waiting or playing. */
export function hasVideoInLine(db: PointsDb, userId: number): boolean {
  return !!db.prepare("SELECT 1 FROM video_queue WHERE user_id = ? AND status IN ('queued', 'playing') LIMIT 1").get(userId);
}

/** Call inside a write transaction, after the payment. */
export function enqueueVideo(db: PointsDb, v: Omit<QueuedVideo, 'id' | 'status' | 'started_at' | 'ended_at'>): number {
  return Number(db.prepare(`INSERT INTO video_queue (ts, user_id, username, video_id, title, start_s, seconds, cost, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued')`).run(v.ts, v.user_id, v.username, v.video_id, v.title, v.start_s, v.seconds, v.cost).lastInsertRowid);
}

const endsAt = (v: QueuedVideo): number => (v.started_at ?? 0) + v.seconds * 1000 + LOAD_PAD_MS;

/**
 * What the overlay should play now: the one playing while its slot lasts; past it, that
 * one is done and the next in line starts now. Moves the queue on, so only the overlay
 * feed calls it.
 */
export function advanceVideos(db: PointsDb, now = Date.now()): QueuedVideo | null {
  return runWrite(db, () => {
    const cur = playingVideo(db);
    if (cur && now < endsAt(cur)) return cur;
    if (cur) db.prepare("UPDATE video_queue SET status = 'done', ended_at = ? WHERE id = ?").run(endsAt(cur), cur.id);
    const next = db.prepare("SELECT * FROM video_queue WHERE status = 'queued' ORDER BY id LIMIT 1").get() as QueuedVideo | undefined;
    if (!next) return null;
    db.prepare("UPDATE video_queue SET status = 'playing', started_at = ? WHERE id = ?").run(now, next.id);
    return { ...next, status: 'playing', started_at: now };
  });
}

/** The video overlay pauses the one playing (for a wheel spin): its slot ends this much later. */
export function extendVideo(db: PointsDb, ms: number): void {
  runWrite(db, () => {
    db.prepare("UPDATE video_queue SET started_at = started_at + ? WHERE status = 'playing'").run(Math.max(0, Math.round(ms)));
  });
}

/** A mod skipped the one playing: it ends now, unrefunded. Returns it, or undefined if nothing was playing. */
export function skipVideo(db: PointsDb, now = Date.now()): QueuedVideo | undefined {
  return runWrite(db, () => {
    const cur = playingVideo(db);
    if (!cur || now >= endsAt(cur)) return undefined;
    db.prepare("UPDATE video_queue SET status = 'skipped', ended_at = ? WHERE id = ?").run(now, cur.id);
    return cur;
  });
}

/**
 * The overlay couldn't play this one (removed, or its owner stopped embedding after it
 * was queued): it ends and its viewer gets their payment back. False if it had already
 * ended or failed.
 */
export function failVideo(db: PointsDb, id: number, now = Date.now()): boolean {
  return runWrite(db, () => {
    const v = db.prepare("SELECT * FROM video_queue WHERE id = ? AND status IN ('queued', 'playing')").get(id) as QueuedVideo | undefined;
    if (!v) return false;
    db.prepare("UPDATE video_queue SET status = 'failed', ended_at = ? WHERE id = ?").run(now, id);
    if (v.cost > 0) creditTx(db, { userId: v.user_id, username: v.username, amount: v.cost, reason: 'game:video_refund', ref: `video:${id}`, actor: 'overlay', now });
    return true;
  });
}

/** "2:05" from seconds. */
export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
