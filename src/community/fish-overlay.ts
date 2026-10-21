/**
 * The fishing overlay's feed: each cast's result, trap haul and steal, kept a few minutes
 * in the channel's points database (overlay_feed, schema v7). The bot writes it;
 * the enrollment service reads it for the dashboard's browser-source page, which
 * polls. Every fish reply goes here, whether or not it also goes to chat
 * (games.chatReplies).
 */

import { PointsDb, runWrite } from '../points/db';
import { clearAlert, raiseAlert } from '../health-alerts';
import type { OverlayDuel } from './fish-duel';
import type { WheelItem } from './wheel';

/** How long a reply stays readable. The overlay polls every couple of seconds. */
const KEEP_MS = 5 * 60_000;
/** The most a poll returns. */
const READ_LIMIT = 50;

/**
 * catch: a fish landed by a cast. trap: traps collected. miss: a cast that came
 * back empty or with junk. bite: a big bite, carrying the reel code the chat reply
 * never shows. steal: a fish taken from another viewer. caught: a
 * thief caught red-handed. duel: a fish duel, carrying every turn for the overlay
 * to play back. wheel: a spin of the prize wheel, carrying its slices and where it
 * lands; fishing alerts wait while it plays. info: any other reply, only in feeds
 * from before replies were split between chat and the overlay.
 */
export type OverlayKind = 'catch' | 'trap' | 'miss' | 'steal' | 'caught' | 'bite' | 'duel' | 'wheel' | 'info';

/** A wheel spin: the slices as they were, the winning slice's index, and how long it spins (ms). */
export interface OverlayWheel {
  items: WheelItem[];
  winner: number;
  spinMs: number;
}

export interface OverlayEvent {
  id: number;
  ts: number;
  username: string;
  kind: OverlayKind;
  text: string;
  /** The fish, for a catch. */
  item?: string;
  /** Its rarity name as the channel has the odds set. */
  rarity?: string;
  /** Emote name to image URL, for emotes in the text. */
  emotes?: Record<string, string>;
  /** A big bite's reel code: only the overlay shows it, never chat. */
  code?: string;
  /** How long the overlay shows a flashing code after it first draws it (ms); absent, it stays shown. */
  flashMs?: number;
  /** When a big bite gets away (ms). */
  until?: number;
  /** When a big bite's first code opens to snipers (ms). */
  snipeAt?: number;
  /** Which pull of a big bite this code is for, of how many. */
  pull?: number;
  pulls?: number;
  /** A fish duel: both sides and every turn. */
  duel?: OverlayDuel;
  /** A wheel spin. */
  wheel?: OverlayWheel;
}

let writes = 0;

/** Add a reply. Never throws: the overlay failing must not stop a chat reply. */
export function pushOverlay(db: PointsDb, event: Omit<OverlayEvent, 'id' | 'ts'>, now = Date.now()): number | null {
  let id: number | null = null;
  try {
    runWrite(db, () => {
      id = Number(db.prepare('INSERT INTO overlay_feed (ts, data) VALUES (?, ?)').run(now, JSON.stringify(event)).lastInsertRowid);
      // Prune now and then rather than on every write.
      if (++writes % 50 === 1) db.prepare('DELETE FROM overlay_feed WHERE ts < ?').run(now - KEEP_MS);
    });
  } catch (err) {
    console.error(`[FISH] Overlay write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return id;
}

// ─── Is an overlay showing? ──────────────────────────────────────────────────

const SEEN_KEY = 'overlay_seen_at';
/** An overlay polls every 1.5s; this long without one and it's taken as closed. */
const SEEN_FRESH_MS = 15_000;
/** When each channel's db was last marked: the enrollment service serves every channel's overlay. */
const lastMarked = new WeakMap<PointsDb, number>();

/**
 * The enrollment service calls this on every overlay poll, so the bot knows a code it
 * shows will be seen. Written at most every 5 seconds; never throws.
 */
export function markOverlaySeen(db: PointsDb, now = Date.now()): void {
  // Per channel: one shared time let one channel's polls starve another's.
  if (now - (lastMarked.get(db) ?? 0) < 5_000) return;
  lastMarked.set(db, now);
  try {
    runWrite(db, () => {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SEEN_KEY, String(now));
    });
  } catch (err) {
    console.error(`[FISH] Overlay seen write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Switched off ($<cmd> fish overlay off) ────────────────────────────────

/**
 * A mod switches the overlay off when it isn't on stream (a polling copy still counts
 * as showing): fishing replies go to chat and big bites pause until it's back on. The
 * switch holds the stream it was set in (live_since, or "offline"), so the next stream
 * starts with it on again.
 */
const OFF_KEY = 'overlay_off';

const streamMark = (db: PointsDb): string =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get('live_since') as { value: string } | undefined)?.value ?? 'offline';

/** Whether a mod has switched the overlay off for this stream. */
export function overlayOff(db: PointsDb): boolean {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(OFF_KEY) as { value: string } | undefined;
    return !!row && row.value === streamMark(db);
  } catch {
    return false;
  }
}

/** Switch the overlay off for this stream, or back on. */
export function setOverlayOff(db: PointsDb, off: boolean): void {
  runWrite(db, () => {
    if (off) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(OFF_KEY, streamMark(db));
    else db.prepare('DELETE FROM meta WHERE key = ?').run(OFF_KEY);
  });
}

/** Whether a fishing overlay polled in the last few seconds, and isn't switched off. */
export function overlayShowing(db: PointsDb, now = Date.now()): boolean {
  if (overlayOff(db)) return false;
  // Polling but not drawing (a streaming tool's browser source froze): nothing it shows is seen.
  const health = overlayHealth(db, now);
  if (health && health.stallMs >= STALL_PAUSE_MS) return false;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SEEN_KEY) as { value: string } | undefined;
    return !!row && now - Number(row.value) < SEEN_FRESH_MS;
  } catch {
    return false;
  }
}

// ─── Is it drawing? ──────────────────────────────────────────────────────────

/**
 * A browser source can keep polling while it has stopped drawing the page: sukasblood's
 * cloud OBS (IRL Toolkit) froze that way most streams in October 2026, so big bite codes
 * went unseen. Pages from 2026-10-21 report on each poll the newest reply they have drawn
 * a frame of, and how long they've gone without drawing; the enrollment service keeps the
 * latest here (OBS sources' reports over other tabs'). Missing from older pages.
 */
const HEALTH_KEY = 'overlay_health';
/** Not drawing for this long and the overlay counts as not showing: big bites wait. */
const STALL_PAUSE_MS = 8_000;
/** Written at most this often, unless the page starts or stops drawing. */
const HEALTH_EVERY_MS = 2_000;
const lastHealth = new WeakMap<PointsDb, { at: number; stalled: boolean; hidden: boolean }>();

export interface OverlayHealth {
  /** The newest feed id the page has drawn. */
  painted: number;
  /** How long it has gone without drawing a frame. */
  stallMs: number;
  /** Every open page is hidden: its source is on a scene that isn't showing, so not drawing is expected. */
  hidden?: boolean;
}

/** The enrollment service, on a poll that carried a report. Never throws. */
export function noteOverlayHealth(db: PointsDb, health: OverlayHealth, now = Date.now()): void {
  const stalled = health.stallMs >= STALL_PAUSE_MS;
  const hidden = !!health.hidden;
  const was = lastHealth.get(db);
  if (was && now - was.at < HEALTH_EVERY_MS && was.stalled === stalled && was.hidden === hidden) return;
  lastHealth.set(db, { at: now, stalled, hidden });
  try {
    runWrite(db, () => {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(HEALTH_KEY, JSON.stringify({ at: now, painted: health.painted, stallMs: health.stallMs, ...(hidden ? { hidden } : {}) }));
    });
  } catch (err) {
    console.error(`[FISH] Overlay health write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The latest report, or null when no page has sent one lately (an older page, or none open). */
export function overlayHealth(db: PointsDb, now = Date.now()): OverlayHealth | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(HEALTH_KEY) as { value: string } | undefined;
    if (!row) return null;
    const h = JSON.parse(row.value) as { at?: unknown; painted?: unknown; stallMs?: unknown; hidden?: unknown };
    if (typeof h.at !== 'number' || typeof h.painted !== 'number' || typeof h.stallMs !== 'number') return null;
    if (now - h.at >= SEEN_FRESH_MS) return null;
    // The report's stall grows while no newer one comes.
    return { painted: h.painted, stallMs: h.stallMs > 0 ? h.stallMs + (now - h.at) : h.stallMs, hidden: h.hidden === true };
  } catch {
    return null;
  }
}

// ─── Reload ($<cmd> fish overlay reload, or the bot itself) ──────────────────

/**
 * Every open fishing overlay from 2026-10-21 on reloads when this token changes, busy
 * or not: the way to restart a stuck browser source without the streamer's OBS.
 */
const RELOAD_KEY = 'overlay_reload';
/** The bot asks at most this often on its own; a mod's command always goes through. */
const AUTO_RELOAD_GAP_MS = 2 * 60_000;

/** The current token: 0 before any reload was asked for. */
export function overlayReloadToken(db: PointsDb): number {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(RELOAD_KEY) as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Ask every open overlay to reload. `auto`: the bot's own ask, at most one per AUTO_RELOAD_GAP_MS. Whether it was sent. */
export function requestOverlayReload(db: PointsDb, auto: boolean, now = Date.now()): boolean {
  if (auto && now - overlayReloadToken(db) < AUTO_RELOAD_GAP_MS) return false;
  try {
    runWrite(db, () => {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(RELOAD_KEY, String(now));
    });
    return true;
  } catch (err) {
    console.error(`[FISH] Overlay reload write failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

// ─── Watchdog (the channel bot, every big bite tick) ─────────────────────────

/** A showing page that hasn't drawn for this long gets told to reload, code or no code. */
const WATCH_RELOAD_MS = 30_000;
/** Still not drawing this long after first noticed, reloads and all: the owner hears about it. */
const WATCH_ALERT_MS = 5 * 60_000;
const frozenSince = new Map<string, number>();
const alerted = new Set<string>();

export interface OverlayWatchAlerts {
  frozen(channel: string, minutes: number): void;
  recovered(channel: string, minutes: number): void;
}

/**
 * While the stream is live: a fishing overlay on a showing scene that has stopped drawing is
 * told to reload (at most every two minutes), and if that hasn't got it drawing in
 * WATCH_ALERT_MS the owner is alerted, and told again once it draws. Big bites already wait
 * for it (overlayShowing). A hidden page (its scene isn't on) is left alone.
 */
export function watchOverlay(db: PointsDb, channel: string, live: boolean, alerts: OverlayWatchAlerts, now = Date.now()): void {
  const health = live && !overlayOff(db) ? overlayHealth(db, now) : null;
  const since = frozenSince.get(channel);
  if (!health || health.hidden || health.stallMs < STALL_PAUSE_MS) {
    frozenSince.delete(channel);
    // Drawing again (not just hidden, closed or offline): close the alert.
    if (since !== undefined && alerted.delete(channel) && health && !health.hidden) alerts.recovered(channel, Math.round((now - since) / 60_000));
    if (!health && !live) alerted.delete(channel);
    return;
  }
  const from = since ?? now - health.stallMs;
  frozenSince.set(channel, from);
  if (health.stallMs >= WATCH_RELOAD_MS && requestOverlayReload(db, true, now)) {
    console.log(`[FISH] overlay in ${channel} hasn't drawn for ${Math.round(health.stallMs / 1000)}s on a showing scene: told it to reload`);
  }
  if (now - from >= WATCH_ALERT_MS && !alerted.has(channel)) {
    alerted.add(channel);
    alerts.frozen(channel, Math.round((now - from) / 60_000));
  }
}

/** Live this long with no fishing overlay polling, big bites on, and the owner hears. */
const MISSING_ALERT_MS = 10 * 60_000;

/**
 * While live with big bites on: no overlay page polling for MISSING_ALERT_MS (the source was
 * removed, or never loaded) means big bites pause the whole stream without a word. Alerts once
 * the stream's been up that long; an overlay polling again closes it. Switched off by a mod: fine.
 */
export function watchOverlayOpen(db: PointsDb, channel: string, live: boolean, bigBites: boolean, now = Date.now()): void {
  const key = `overlay-missing:${channel}`;
  let seenAt = 0;
  let liveSince = 0;
  try {
    seenAt = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get(SEEN_KEY) as { value: string } | undefined)?.value ?? 0);
    liveSince = Number((db.prepare('SELECT value FROM meta WHERE key = ?').get('live_since') as { value: string } | undefined)?.value ?? 0);
  } catch {
    return;
  }
  if (now - seenAt < SEEN_FRESH_MS) {
    clearAlert(key, 'Fishing Overlay Open Again', `${channel}'s fishing overlay is polling again: big bites can go out.`);
    return;
  }
  if (!live || !bigBites || overlayOff(db) || !liveSince || now - liveSince < MISSING_ALERT_MS || now - seenAt < MISSING_ALERT_MS) return;
  raiseAlert(key, 'No Fishing Overlay Open', `${channel} has been live ${Math.round((now - liveSince) / 60_000)} min with big bites on, but no fishing overlay has polled for ${seenAt ? `${Math.round((now - seenAt) / 60_000)} min` : 'this whole stream'}. Big bites wait for one, so none go out. The browser source may be missing or failing to load in the streaming software. If the overlay isn't meant to be on this stream, a mod can say ${'$'}<cmd> fish overlay off.`);
}

/** The latest replies, oldest first, and the newest id (0 when there are none). */
export function readOverlay(db: PointsDb, now = Date.now()): { lastId: number; events: OverlayEvent[] } {
  let rows: Array<{ id: number; ts: number; data: string }>;
  try {
    rows = db.prepare('SELECT id, ts, data FROM overlay_feed WHERE ts >= ? ORDER BY id DESC LIMIT ?').all(now - KEEP_MS, READ_LIMIT) as typeof rows;
  } catch {
    return { lastId: 0, events: [] }; // a database from before v7
  }
  const events = rows.reverse().flatMap(r => {
    try {
      return [{ ...(JSON.parse(r.data) as Omit<OverlayEvent, 'id' | 'ts'>), id: r.id, ts: r.ts }];
    } catch {
      return [];
    }
  });
  return { lastId: events.length ? events[events.length - 1].id : 0, events };
}
