/**
 * Mirror a channel's StreamElements media share on its video overlay: whatever media
 * share is playing (on the streamer's phone, say) plays on the overlay too, at the same
 * point, pausing and moving on with it. points.video.mediashare turns it on.
 *
 * StreamElements' REST API says which video is loaded (/songrequest/:id/playing) and,
 * with the account's JWT, whether the player is playing or paused (/player). Neither
 * says how far into the video it is, so this keeps that itself: from when a video was
 * first seen, adding up the time it plays (a video's start is when the one before it went
 * into the history). The overlay asks the enrollment
 * service, which polls StreamElements about once a second while an overlay is asking.
 *
 * The JWT is the streamer's, from StreamElements' dashboard (Channels → Show secrets),
 * kept in data/streamelements/<channel>.json ({ channelId, jwt }), never in a channel's
 * settings or the API. It's only used to read.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PointsDb, runWrite } from '../points/db';
import { clearAlert, raiseAlert } from '../health-alerts';

const API = 'https://api.streamelements.com/kappa/v2/songrequest';
/** How often StreamElements is asked, while an overlay is asking. */
const POLL_MS = 1_000;
/** No overlay has asked for this long: stop polling. */
const IDLE_MS = 30_000;

export interface MediaShareCredentials { channelId: string; jwt: string }

const dataRoot = (): string => process.env.POINTS_DATA_ROOT || path.join(__dirname, '..', '..', 'data');
const credsFile = (channel: string): string => path.join(dataRoot(), 'streamelements', `${channel.toLowerCase()}.json`);

/** The channel's StreamElements account and token, or null when none is set up. */
export function mediaShareCredentials(channel: string): MediaShareCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(credsFile(channel), 'utf8')) as Record<string, unknown>;
    const channelId = typeof raw.channelId === 'string' ? raw.channelId.trim() : '';
    const jwt = typeof raw.jwt === 'string' ? raw.jwt.trim() : '';
    return /^[a-f0-9]{24}$/i.test(channelId) && jwt ? { channelId, jwt } : null;
  } catch {
    return null;
  }
}

/** Whether a channel has a token saved, and for which StreamElements account (never the token). */
export function mediaShareStatus(channel: string): { configured: boolean; channelId: string | null; savedAt: string | null } {
  try {
    const raw = JSON.parse(fs.readFileSync(credsFile(channel), 'utf8')) as Record<string, unknown>;
    const ok = !!mediaShareCredentials(channel);
    return { configured: ok, channelId: typeof raw.channelId === 'string' ? raw.channelId : null, savedAt: ok && typeof raw.savedAt === 'string' ? raw.savedAt : null };
  } catch {
    return { configured: false, channelId: null, savedAt: null };
  }
}

/** The StreamElements account a JWT is for, from its payload ("channel"), or null. */
function accountOf(jwt: string): string | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    const id = payload.channel ?? payload.channelId;
    return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * Check a JWT the streamer pasted against StreamElements and keep it: it must name its
 * account and be able to read that account's media share player. The file is the
 * channel's own, readable only by this user.
 */
export async function saveMediaShareToken(channel: string, jwtRaw: string): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
  const jwt = jwtRaw.trim().replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt) || jwt.length > 4096) {
    return { ok: false, error: "That doesn't look like a StreamElements JWT token (three parts separated by dots)" };
  }
  const channelId = accountOf(jwt);
  if (!channelId) return { ok: false, error: "That token doesn't name a StreamElements account. Copy the JWT token, not the overlay token" };
  try {
    const res = await fetch(`${API}/${channelId}/player`, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(8_000) });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'StreamElements turned that token down. Copy it again (it changes if you regenerate it)' };
    if (!res.ok) return { ok: false, error: `StreamElements answered ${res.status}; try again in a minute` };
  } catch {
    return { ok: false, error: "Couldn't reach StreamElements to check the token; try again in a minute" };
  }
  fs.mkdirSync(path.dirname(credsFile(channel)), { recursive: true, mode: 0o700 });
  const tmp = `${credsFile(channel)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ channelId, jwt, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, credsFile(channel));
  return { ok: true, channelId };
}

/** Forget the channel's token. */
export function removeMediaShareToken(channel: string): void {
  try {
    fs.unlinkSync(credsFile(channel));
  } catch {
    // already gone
  }
}

/** What the overlay plays: a video at a point in it, playing or paused. */
export interface MediaShareNow {
  /** StreamElements' id for this play of it: a new one is a new video. */
  key: string;
  videoId: string;
  title: string;
  username: string;
  /** Where in the video it ends, in seconds. */
  end: number;
  /** How far into the video it was at `at` (ms), in seconds. */
  position: number;
  at: number;
  paused: boolean;
  /** The phone player has the overlay hidden for this one (audio only, say): it still follows along. */
  hidden?: boolean;
  /** From the phone player's own report, not guessed from StreamElements: the overlay can keep tight to it. */
  exact?: boolean;
}

/** StreamElements failing this long while the overlay asks: worth a message. */
const SE_ALERT_MS = 10 * 60_000;

interface Mirror {
  timer: ReturnType<typeof setTimeout> | null;
  askedAt: number;
  now: MediaShareNow | null;
  /** The last error, for the log once per kind. */
  lastError: string | null;
  /** Since when every poll has failed; alerted past SE_ALERT_MS. */
  failingSince?: number;
  /** The player's state at the last poll: only a change of it says the video was paused or played. */
  lastState: string | null;
  /** The video that played to its end: StreamElements keeps it as playing until the next one. */
  doneKey: string | null;
  /** StreamElements' own pause (a change of its player state), apart from `held`. */
  sePaused: boolean;
  /** Held by a mod (!media pause): hidden and stopped where it is until !media play. */
  held: boolean;
}

const mirrors = new Map<string, Mirror>();

type Song = { _id?: string; videoId?: string; title?: string; duration?: number; start?: number; end?: number; user?: { username?: string }; amount?: number; source?: string };

async function getJson<T>(url: string, jwt: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`StreamElements answered ${res.status}`);
  // /playing answers an empty body when nothing is up.
  const text = await res.text();
  return (text.trim() ? JSON.parse(text) : null) as T;
}

/** Ask StreamElements once and move this channel's mirror on. */
async function step(channel: string, m: Mirror): Promise<void> {
  const creds = mediaShareCredentials(channel);
  if (!creds) {
    m.now = null;
    return;
  }
  try {
    const [player, song] = await Promise.all([
      getJson<{ state?: string }>(`${API}/${creds.channelId}/player`, creds.jwt),
      getJson<Song>(`${API}/${creds.channelId}/playing`, creds.jwt)
    ]);
    m.lastError = null;
    if (m.failingSince !== undefined) {
      m.failingSince = undefined;
      clearAlert(`mediashare:${channel}`, 'Media Share Back', `StreamElements answers ${channel}'s media share again: the video overlay follows it.`);
    }
    const t = Date.now();
    // The player's state can sit at "paused" while media share plays (on 2026-10-18 it said so
    // through two videos sukasblood's stream played in full), so the video up is taken as
    // playing, and the state only counts when it changes: a pause or a play pressed meanwhile.
    const state = typeof player?.state === 'string' ? player.state : null;
    const changed = m.lastState !== null && state !== m.lastState;
    m.lastState = state;
    if (!song?._id || !song.videoId) {
      m.now = null;
      return;
    }
    const prev = m.now;
    const end = Number(song.end) > 0 ? Number(song.end) : Number(song.duration) || 0;
    if (song._id === m.doneKey) {
      m.now = null;
      return;
    }
    if (!prev || prev.key !== song._id) {
      // A video not seen before. It started when the one before it went into the history, so an
      // overlay that opens (or a mirror that restarts) partway through joins it where it is.
      const start = Number(song.start) || 0;
      let position = start;
      try {
        const h = await getJson<{ history?: Array<{ createdAt?: string }> }>(`${API}/${creds.channelId}/history?limit=1`, creds.jwt);
        const since = (t - Date.parse(h?.history?.[0]?.createdAt ?? '')) / 1000;
        if (since > 0) position = start + since;
      } catch {
        // from its start, then
      }
      // Already played out (StreamElements still shows the last one): nothing to show.
      if (end > 0 && position >= end) {
        m.now = null;
        m.doneKey = song._id;
        return;
      }
      m.sePaused = false;
      m.now = {
        key: song._id, videoId: song.videoId, title: String(song.title ?? 'a video').slice(0, 100),
        username: String(song.user?.username ?? ''), end, position, at: t, paused: m.held
      };
      return;
    }
    // The same video: keep count of how far in it is (not while paused or held), and follow a pause or play.
    const position = prev.paused ? prev.position : prev.position + (t - prev.at) / 1000;
    if (changed) m.sePaused = state === 'paused';
    const paused = m.held || m.sePaused;
    if (end > 0 && position >= end) {
      m.now = null;
      m.doneKey = song._id;
      return;
    }
    m.now = { ...prev, position, at: t, paused };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== m.lastError) console.error(`[MEDIASHARE] ${channel}: ${msg}`);
    m.lastError = msg;
    m.failingSince ??= Date.now();
    if (Date.now() - m.failingSince >= SE_ALERT_MS) {
      raiseAlert(`mediashare:${channel}`, 'Media Share Not Answering', `StreamElements hasn't answered ${channel}'s media share for ${Math.round((Date.now() - m.failingSince) / 60_000)} min, so the video overlay can't follow it. If it says 401 or 403, the StreamElements connection needs setting up again on the dashboard (Overlays).\n\n${msg}`);
    }
  }
}

/**
 * What media share is playing for this channel now, as best known. Starts (or keeps)
 * the polling; it stops by itself once nothing has asked for a while.
 */
export function mediaShareNow(channel: string, held = false): MediaShareNow | null {
  // The phone player plays it: what it reports is exact, pauses included.
  const played = playerReport(channel);
  if (played) return held ? { ...played, paused: true } : played;
  let m = mirrors.get(channel);
  if (!m) {
    m = { timer: null, askedAt: 0, now: null, lastError: null, lastState: null, doneKey: null, sePaused: false, held: false };
    mirrors.set(channel, m);
  }
  m.askedAt = Date.now();
  if (held !== m.held) {
    // Held or let go now, not at the next poll: the position counts up to this moment.
    m.held = held;
    const t = Date.now();
    if (m.now) {
      const position = m.now.paused ? m.now.position : m.now.position + (t - m.now.at) / 1000;
      m.now = { ...m.now, position, at: t, paused: held || m.sePaused };
    }
  }
  if (!m.timer) {
    const mirror = m;
    const loop = async () => {
      if (Date.now() - mirror.askedAt > IDLE_MS) {
        mirror.timer = null;
        mirror.now = null;
        mirror.lastState = null;
        return;
      }
      await step(channel, mirror);
      mirror.timer = setTimeout(() => void loop(), POLL_MS);
      mirror.timer.unref?.();
    };
    m.timer = setTimeout(() => void loop(), 0);
  }
  return m.now;
}

// ─── The phone player ───────────────────────────────────────────────────────
//
// The dashboard's player page (/<channel>/player) plays the media share queue itself, on
// the streamer's phone, in place of an app's player: it asks for the song up and reports
// every second where it is in it and whether it's paused. While it reports, the video
// overlay follows that instead of guessing from StreamElements, so the two stay together
// and a pause on the phone pauses (and hides) the overlay. It moves the queue on the way
// StreamElements' own web player does: POST /next when a video ends, /skip to skip, and
// /player/play|pause, so chat's !pause and !play reach it through the player state.

/** A song as the player page gets it. */
export interface PlayerSong {
  key: string; videoId: string; title: string; username: string; start: number; end: number; amount: number | null; tip: boolean;
  /** The whole video's length in seconds (end may be a cap, start an offset). */
  duration: number;
  /** History rows only: the song's own id (key is the history entry's), which failures are recorded under. */
  songKey?: string;
}

/** The player stops counting as playing this long after its last report. */
const REPORT_FRESH_MS = 5_000;
/** How long a video's last position is kept, for a player page that's reopened. */
const RESUME_MS = 30 * 60_000;

const reports = new Map<string, MediaShareNow & { seenAt: number }>();

const toSong = (s: Song | null | undefined): PlayerSong | null => {
  if (!s?._id || !s.videoId) return null;
  const start = Math.max(0, Number(s.start) || 0);
  const end = Number(s.end) > start ? Number(s.end) : Number(s.duration) || 0;
  return {
    key: s._id, videoId: s.videoId, title: String(s.title ?? 'a video').slice(0, 100), username: String(s.user?.username ?? '').slice(0, 40),
    start, end, duration: Number(s.duration) || end, amount: typeof s.amount === 'number' ? s.amount : null, tip: s.source === 'tip'
  };
};

/** The phone player's latest report, while it's reporting. */
export function playerReport(channel: string, now = Date.now()): MediaShareNow | null {
  const r = reports.get(channel);
  if (!r || now - r.seenAt > REPORT_FRESH_MS) return null;
  const { seenAt: _seen, ...rest } = r;
  return rest;
}

/** Keep what the player page says it's playing: where it is (seconds) and whether it's paused. */
export function reportPlayer(channel: string, song: PlayerSong, position: number, paused: boolean, hidden = false, now = Date.now(), latencyMs = 0): void {
  if (!Number.isFinite(position) || position < 0) return;
  // The position was read on the phone before the report travelled here: it was true that long ago.
  const at = now - Math.max(0, Math.min(1_000, Number.isFinite(latencyMs) ? latencyMs : 0));
  reports.set(channel, { key: song.key, videoId: song.videoId, title: song.title, username: song.username, end: song.end, position, at, paused, hidden, exact: true, seenAt: now });
}

/** Where the player last was in this video, for a page opened again partway through. */
function resumeAt(channel: string, key: string, now = Date.now()): number | null {
  const r = reports.get(channel);
  return r && r.key === key && now - r.seenAt < RESUME_MS ? r.position + (r.paused ? 0 : (now - r.seenAt) / 1000) : null;
}

export interface PlayerView {
  playing: PlayerSong | null;
  queue: PlayerSong[];
  /** The last few that played, newest first. */
  history: PlayerSong[];
  /** StreamElements' player state: chat's !pause and !play, and the page's own buttons. */
  state: 'playing' | 'paused';
  /** Where to pick the song up (seconds), when this player was already partway through it. */
  resume: number | null;
}

/** What the player should play: the song up, the next few, and play or pause. */
export async function playerView(channel: string): Promise<PlayerView | null> {
  const creds = mediaShareCredentials(channel);
  if (!creds) return null;
  const [song, queue, player, history] = await Promise.all([
    getJson<Song>(`${API}/${creds.channelId}/playing`, creds.jwt),
    getJson<Song[] | { list?: Song[] }>(`${API}/${creds.channelId}/queue`, creds.jwt),
    getJson<{ state?: string }>(`${API}/${creds.channelId}/player`, creds.jwt),
    getJson<{ history?: Array<{ _id?: string; song?: Song }> }>(`${API}/${creds.channelId}/history?limit=10`, creds.jwt).catch(() => ({ history: [] }))
  ]);
  const playing = toSong(song);
  const list = Array.isArray(queue) ? queue : queue?.list ?? [];
  return {
    playing,
    queue: list.slice(0, 10).map(toSong).filter((x): x is PlayerSong => x !== null),
    // Keyed by the history entry, which a replay names.
    history: (history?.history ?? []).map(h => { const s = toSong(h.song); return s && h._id ? { ...s, key: h._id, songKey: s.key } as PlayerSong : null; }).filter((x): x is PlayerSong => x !== null),
    state: player?.state === 'playing' ? 'playing' : 'paused',
    resume: playing ? resumeAt(channel, playing.key) : null
  };
}

/**
 * Move the queue on or set the player's state. `next` and `skip` name the song they're for
 * and do nothing once it isn't the one up any more, so a page asking twice moves on once.
 */
export async function playerAction(channel: string, action: 'next' | 'skip' | 'play' | 'pause' | 'replay', key?: string): Promise<boolean> {
  const creds = mediaShareCredentials(channel);
  if (!creds) return false;
  const post = async (path: string) => {
    const res = await fetch(`${API}/${creds.channelId}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${creds.jwt}`, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) throw new Error(`StreamElements answered ${res.status}`);
  };
  if (action === 'play' || action === 'pause') {
    await post(`/player/${action}`);
    return true;
  }
  if (action === 'replay') {
    // As StreamElements' own dashboard does it: the history entry, its song with the entry's id.
    if (!key) return false;
    const h = await getJson<{ history?: Array<{ _id?: string; song?: Song }> }>(`${API}/${creds.channelId}/history?limit=50`, creds.jwt);
    const entry = (h?.history ?? []).find(e => e._id === key);
    if (!entry?.song) return false;
    // A Kick tip's user has providerId "", which the history hands out but /replay refuses (400,
    // "user.providerId too small"): every tipped song failed to replay until 2026-10-22.
    const song: Record<string, unknown> = { ...entry.song, _id: entry._id };
    if (entry.song.user) song.user = Object.fromEntries(Object.entries(entry.song.user).filter(([, v]) => v !== ''));
    const res = await fetch(`${API}/${creds.channelId}/replay`, {
      method: 'POST', headers: { Authorization: `Bearer ${creds.jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(song), signal: AbortSignal.timeout(5_000)
    });
    if (!res.ok) {
      // Told to the page as "couldn't replay", not as the whole sync failing.
      console.log(`[MEDIASHARE] ${channel} replay refused: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
      return false;
    }
    return true;
  }
  const up = toSong(await getJson<Song>(`${API}/${creds.channelId}/playing`, creds.jwt));
  // Nothing up yet with the queue waiting: `next` without a song takes the first one in.
  if (!up) {
    if (action !== 'next' || key) return false;
    await post('/next');
    return true;
  }
  if (key && up.key !== key) return false;
  await post(`/${action}`);
  reports.delete(channel);
  return true;
}

/**
 * Take one song out of the queue, or play it now keeping its requester. StreamElements has no
 * reorder, so this is: delete it, then replay its own record. Replay plays a song at once (the
 * one it cuts off goes back to the front of the queue) and ignores one that's still queued. If the replay is refused it's tried again, then the
 * video is added back at the end as the channel, so a move never loses a song. Tested on the
 * test channel 2026-10-31. Answers what happened, or null when the song isn't queued any more.
 */
export async function queueEdit(channel: string, action: 'front' | 'remove', key: string): Promise<'moved' | 'removed' | 'readded' | null> {
  const creds = mediaShareCredentials(channel);
  if (!creds) return null;
  const q = await getJson<Song[] | { list?: Song[] }>(`${API}/${creds.channelId}/queue`, creds.jwt);
  const list = Array.isArray(q) ? q : q?.list ?? [];
  const song = list.find(x => x._id === key);
  if (!song?._id || !song.videoId) return null;
  const headers = { Authorization: `Bearer ${creds.jwt}`, 'Content-Type': 'application/json' };
  const del = await fetch(`${API}/${creds.channelId}/queue/${encodeURIComponent(song._id)}`, { method: 'DELETE', headers, signal: AbortSignal.timeout(5_000) });
  if (!del.ok) throw new Error(`StreamElements answered ${del.status}`);
  if (action === 'remove') return 'removed';
  // As in replays from the history: Kick tips' empty providerId is refused, so blanks go.
  const record: Record<string, unknown> = { ...song };
  if (song.user) record.user = Object.fromEntries(Object.entries(song.user).filter(([, v]) => v !== ''));
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${API}/${creds.channelId}/replay`, { method: 'POST', headers, body: JSON.stringify(record), signal: AbortSignal.timeout(5_000) }).catch(() => null);
    if (res?.ok) return 'moved';
    console.log(`[MEDIASHARE] ${channel} move to front: replay refused (${res?.status ?? 'no answer'})`);
  }
  await addToQueue(channel, song.videoId);
  return 'readded';
}

/** Add a YouTube video to the end of the media share queue, as the channel. False without a token. */
export async function addToQueue(channel: string, videoId: string): Promise<boolean> {
  const creds = mediaShareCredentials(channel);
  if (!creds) return false;
  const res = await fetch(`${API}/${creds.channelId}/queue`, {
    method: 'POST', headers: { Authorization: `Bearer ${creds.jwt}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video: videoId }), signal: AbortSignal.timeout(8_000)
  });
  if (!res.ok) {
    console.log(`[MEDIASHARE] ${channel} add ${videoId} refused: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return false;
  }
  return true;
}

// ─── Held by a mod (!media pause / !media play) ────────────────────────────────────

/**
 * A media share player that keeps its pause to itself (an app on the streamer's phone)
 * can't be followed, so a mod holds the overlay instead: hidden, and stopped where it is
 * until it's let go, when it carries on from there. In the points meta table (the bot's
 * command writes it, the enrollment service's overlay feed reads it), holding the stream
 * it was set in (live_since), so the next stream starts with it let go.
 */
const HOLD_KEY = 'mediashare_held';

const streamMark = (db: PointsDb): string =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get('live_since') as { value: string | null } | undefined)?.value ?? 'offline';

/** Whether a mod has the media share overlay held. */
export function mediaShareHeld(db: PointsDb): boolean {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(HOLD_KEY) as { value: string } | undefined;
    return !!row && row.value === streamMark(db);
  } catch {
    return false;
  }
}

/** Hold the media share overlay, or let it go. */
export function setMediaShareHeld(db: PointsDb, held: boolean): void {
  runWrite(db, () => {
    if (held) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(HOLD_KEY, streamMark(db));
    else db.prepare('DELETE FROM meta WHERE key = ?').run(HOLD_KEY);
  });
}

// ─── Hidden for one video (!media hide / !media show) ────────────────────────

/**
 * An audio-only request doesn't need the overlay: a mod hides it for the video that's up,
 * and it shows again for the next one. Kept as that video's StreamElements id, with the
 * stream it was set in, in the points meta table (the command writes, the overlay feed reads).
 */
const HIDE_KEY = 'mediashare_hidden';

/** The video a mod has hidden the overlay for, in this stream, or null. */
export function mediaShareHiddenKey(db: PointsDb): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(HIDE_KEY) as { value: string } | undefined;
    if (!row) return null;
    const v = JSON.parse(row.value) as { key?: unknown; mark?: unknown };
    return typeof v.key === 'string' && v.mark === streamMark(db) ? v.key : null;
  } catch {
    return null;
  }
}

/** Hide the overlay for this video (its StreamElements id), or show it again (null). */
export function setMediaShareHiddenKey(db: PointsDb, key: string | null): void {
  runWrite(db, () => {
    if (key) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(HIDE_KEY, JSON.stringify({ key, mark: streamMark(db) }));
    else db.prepare('DELETE FROM meta WHERE key = ?').run(HIDE_KEY);
  });
}

/** The video up now on media share, or null (none, or no token). */
export async function mediaShareUp(channel: string): Promise<PlayerSong | null> {
  const creds = mediaShareCredentials(channel);
  if (!creds) return null;
  return toSong(await getJson<Song>(`${API}/${creds.channelId}/playing`, creds.jwt));
}

// ─── Subtitles on the overlay (the phone player's switch) ────────────────────

/** YouTube's captions over the overlay's video: off unless the channel turns them on. */
const CAPTIONS_KEY = 'mediashare_captions';

export function mediaShareCaptions(db: PointsDb): boolean {
  try {
    return (db.prepare('SELECT value FROM meta WHERE key = ?').get(CAPTIONS_KEY) as { value: string } | undefined)?.value === 'on';
  } catch {
    return false;
  }
}

export function setMediaShareCaptions(db: PointsDb, on: boolean): void {
  runWrite(db, () => {
    if (on) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CAPTIONS_KEY, 'on');
    else db.prepare('DELETE FROM meta WHERE key = ?').run(CAPTIONS_KEY);
  });
}
