/**
 * The fishing overlay's feed: each cast's result, trap haul and steal, kept a few minutes
 * in the channel's points database (overlay_feed, schema v7). The bot writes it;
 * the enrollment service reads it for the dashboard's browser-source page, which
 * polls. They go here whether or not they also go to chat (games.chatReplies);
 * every other fish reply only goes to chat.
 */

import { PointsDb, runWrite } from '../points/db';

/** How long a reply stays readable. The overlay polls every couple of seconds. */
const KEEP_MS = 5 * 60_000;
/** The most a poll returns. */
const READ_LIMIT = 50;

/**
 * catch: a fish landed by a cast. trap: traps collected. miss: a cast that came
 * back empty or with junk. steal: a fish taken from another viewer. caught: a
 * thief caught red-handed. info: any other reply, only in feeds from before replies
 * were split between chat and the overlay.
 */
export type OverlayKind = 'catch' | 'trap' | 'miss' | 'steal' | 'caught' | 'info';

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
}

let writes = 0;

/** Add a reply. Never throws: the overlay failing must not stop a chat reply. */
export function pushOverlay(db: PointsDb, event: Omit<OverlayEvent, 'id' | 'ts'>, now = Date.now()): void {
  try {
    runWrite(db, () => {
      db.prepare('INSERT INTO overlay_feed (ts, data) VALUES (?, ?)').run(now, JSON.stringify(event));
      // Prune now and then rather than on every write.
      if (++writes % 50 === 1) db.prepare('DELETE FROM overlay_feed WHERE ts < ?').run(now - KEEP_MS);
    });
  } catch (err) {
    console.error(`[FISH] Overlay write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
