// Alerts for the leaderboard's Fishing tab: what happened to a viewer in the fishing game while
// they weren't looking at chat (a steal on their fish, a gift, a trade or duel for them, a big
// bite on their line). The bot writes them; the signed-in viewer's page polls for new ones
// through the enrollment service. Chat lines stay exactly as they were: this only adds.

import type { PointsDb } from '../points/db';

export type FishAlertKind = 'steal' | 'gift' | 'trade' | 'duel' | 'bite';

export interface FishAlert { id: number; ts: number; kind: FishAlertKind; text: string }

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most an alert list returns, newest last. */
export const ALERTS_MAX = 30;
let writes = 0;

/** One alert for this viewer. Never throws: an alert must not break the move that caused it. */
export function alertUser(db: PointsDb, userId: number, kind: FishAlertKind, text: string, now = Date.now()): void {
  try {
    db.prepare('INSERT INTO fish_alerts (ts, user_id, kind, text) VALUES (?, ?, ?, ?)').run(now, userId, kind, text);
    if (++writes % 50 === 1) db.prepare('DELETE FROM fish_alerts WHERE ts < ?').run(now - KEEP_MS);
  } catch (err) {
    console.error(`[FISH] alert for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * This viewer's alerts, oldest first: with `afterId` 0 the latest ones; otherwise the next ones
 * after it, so a page that fell behind catches up page by page and misses none.
 */
export function alertsFor(db: PointsDb, userId: number, afterId = 0, limit = ALERTS_MAX): FishAlert[] {
  if (afterId > 0) {
    return db.prepare('SELECT id, ts, kind, text FROM fish_alerts WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?').all(userId, afterId, limit) as FishAlert[];
  }
  const rows = db.prepare('SELECT id, ts, kind, text FROM fish_alerts WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as FishAlert[];
  return rows.reverse();
}
