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
  const body = await res.json() as { items?: Array<{ snippet?: { title?: string; liveBroadcastContent?: string }; contentDetails?: { duration?: string; contentRating?: { ytRating?: string } }; status?: { embeddable?: boolean; privacyStatus?: string } }> };
  const v = body.items?.[0];
  if (!v || v.status?.privacyStatus === 'private') return null;
  return {
    title: (v.snippet?.title ?? 'a video').replace(/[@<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'a video',
    durationS: isoDurationSeconds(v.contentDetails?.duration ?? ''),
    embeddable: v.status?.embeddable !== false,
    ageRestricted: v.contentDetails?.contentRating?.ytRating === 'ytAgeRestricted',
    live: (v.snippet?.liveBroadcastContent ?? 'none') !== 'none'
  };
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
