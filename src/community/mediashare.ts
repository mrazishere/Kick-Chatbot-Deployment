/**
 * Mirror a channel's StreamElements media share on its video overlay: whatever media
 * share is playing (on the streamer's phone, say) plays on the overlay too, at the same
 * point, pausing and moving on with it. points.video.mediashare turns it on.
 *
 * StreamElements' REST API says which video is loaded (/songrequest/:id/playing) and,
 * with the account's JWT, whether the player is playing or paused (/player). Neither
 * says how far into the video it is, so this keeps that itself: from when a video was
 * first seen playing, adding up the time it plays. The overlay asks the enrollment
 * service, which polls StreamElements about once a second while an overlay is asking.
 *
 * The JWT is the streamer's, from StreamElements' dashboard (Channels → Show secrets),
 * kept in data/streamelements/<channel>.json ({ channelId, jwt }), never in a channel's
 * settings or the API. It's only used to read.
 */

import * as fs from 'fs';
import * as path from 'path';

const API = 'https://api.streamelements.com/kappa/v2/songrequest';
/** How often StreamElements is asked, while an overlay is asking. */
const POLL_MS = 1_000;
/** No overlay has asked for this long: stop polling. */
const IDLE_MS = 30_000;

export interface MediaShareCredentials { channelId: string; jwt: string }

const dataRoot = (): string => process.env.POINTS_DATA_ROOT || path.join(__dirname, '..', '..', 'data');

/** The channel's StreamElements account and token, or null when none is set up. */
export function mediaShareCredentials(channel: string): MediaShareCredentials | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'streamelements', `${channel.toLowerCase()}.json`), 'utf8')) as Record<string, unknown>;
    const channelId = typeof raw.channelId === 'string' ? raw.channelId.trim() : '';
    const jwt = typeof raw.jwt === 'string' ? raw.jwt.trim() : '';
    return /^[a-f0-9]{24}$/i.test(channelId) && jwt ? { channelId, jwt } : null;
  } catch {
    return null;
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
}

interface Mirror {
  timer: ReturnType<typeof setTimeout> | null;
  askedAt: number;
  now: MediaShareNow | null;
  /** The last error, for the log once per kind. */
  lastError: string | null;
}

const mirrors = new Map<string, Mirror>();

type Song = { _id?: string; videoId?: string; title?: string; duration?: number; start?: number; end?: number; user?: { username?: string } };

async function getJson<T>(url: string, jwt: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}` }, signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`StreamElements answered ${res.status}`);
  return await res.json() as T;
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
    const t = Date.now();
    const playing = player.state === 'playing';
    if (!song?._id || !song.videoId) {
      m.now = null;
      return;
    }
    const prev = m.now;
    const end = Number(song.end) > 0 ? Number(song.end) : Number(song.duration) || 0;
    if (!prev || prev.key !== song._id) {
      // A video not seen before. Loaded but not playing: nothing on the overlay yet.
      m.now = playing ? {
        key: song._id, videoId: song.videoId, title: String(song.title ?? 'a video').slice(0, 100),
        username: String(song.user?.username ?? ''), end, position: Number(song.start) || 0, at: t, paused: false
      } : null;
      return;
    }
    // The same video: keep count of how far in it is, and follow play and pause.
    const position = prev.paused ? prev.position : prev.position + (t - prev.at) / 1000;
    m.now = { ...prev, position: Math.min(position, end || position), at: t, paused: !playing };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== m.lastError) console.error(`[MEDIASHARE] ${channel}: ${msg}`);
    m.lastError = msg;
  }
}

/**
 * What media share is playing for this channel now, as best known. Starts (or keeps)
 * the polling; it stops by itself once nothing has asked for a while.
 */
export function mediaShareNow(channel: string): MediaShareNow | null {
  let m = mirrors.get(channel);
  if (!m) {
    m = { timer: null, askedAt: 0, now: null, lastError: null };
    mirrors.set(channel, m);
  }
  m.askedAt = Date.now();
  if (!m.timer) {
    const mirror = m;
    const loop = async () => {
      if (Date.now() - mirror.askedAt > IDLE_MS) {
        mirror.timer = null;
        mirror.now = null;
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
