// Alerts for the leaderboard's Fishing tab: what happened to a viewer in the fishing game while
// they weren't looking at chat (a steal on their fish, a gift, a trade or duel for them, a big
// bite on their line, their traps filling). The bot writes them; the signed-in viewer's page polls for new ones
// through the enrollment service. Chat lines stay exactly as they were: this only adds.

import { runWrite, type PointsDb } from '../points/db';
import { loadFish } from './fishing';

export type FishAlertKind = 'steal' | 'gift' | 'trade' | 'duel' | 'bite' | 'trap';

export interface FishAlert { id: number; ts: number; kind: FishAlertKind; text: string }

const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** The most an alert list returns, newest last. */
export const ALERTS_MAX = 30;
let writes = 0;

/** One alert for this viewer. Never throws: an alert must not break the move that caused it. */
export function alertUser(db: PointsDb, userId: number, kind: FishAlertKind, text: string, now = Date.now()): void {
  try {
    db.prepare('INSERT INTO fish_alerts (ts, user_id, kind, text) VALUES (?, ?, ?, ?)').run(now, userId, kind, text);
    // Not one still waiting on traps out longer than a week.
    if (++writes % 50 === 1) db.prepare("DELETE FROM fish_alerts WHERE ts < ? AND kind != 'trap_due'").run(now - KEEP_MS);
  } catch (err) {
    console.error(`[FISH] alert for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * "Your traps are full", ahead of time: a row due when the traps fill (kind trap_due, ts the
 * time they fill), which alertsFor turns into a trap alert once that time comes. No timer, so
 * it survives a restart, and works with !remind off. null (collected, cancelled, failed) drops
 * it; laying them again moves it. Never throws, like alertUser.
 */
const TRAP_DUE = 'trap_due';
export function scheduleTrapAlert(db: PointsDb, userId: number, dueAt: number | null, text: string): void {
  try {
    runWrite(db, () => {
      db.prepare('DELETE FROM fish_alerts WHERE user_id = ? AND kind = ?').run(userId, TRAP_DUE);
      if (dueAt !== null) db.prepare('INSERT INTO fish_alerts (ts, user_id, kind, text) VALUES (?, ?, ?, ?)').run(dueAt, userId, TRAP_DUE, text);
    });
  } catch (err) {
    console.error(`[FISH] trap alert for ${userId} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * This viewer's alerts, oldest first: with `afterId` 0 the latest ones; otherwise the next ones
 * after it, so a page that fell behind catches up page by page and misses none. A trap alert
 * that has come due is written out first, as a new row, so a page already past its old id sees it,
 * if those traps are still out: the bot drops the row after the move that collects them commits,
 * so a poll in between (or a crash) would otherwise announce traps already gone.
 */
export function alertsFor(db: PointsDb, userId: number, afterId = 0, limit = ALERTS_MAX, now = Date.now()): FishAlert[] {
  const due = db.prepare('SELECT id, ts, text FROM fish_alerts WHERE user_id = ? AND kind = ? AND ts <= ?').all(userId, TRAP_DUE, now) as Array<{ id: number; ts: number; text: string }>;
  if (due.length) {
    runWrite(db, () => {
      const trap = loadFish(db, userId)?.trap;
      for (const d of due) {
        // Only if it's still there: the bot may have dropped it, or another poll written it out.
        if (db.prepare('DELETE FROM fish_alerts WHERE id = ? AND kind = ?').run(d.id, TRAP_DUE).changes && trap?.active && trap.end === d.ts) {
          db.prepare("INSERT INTO fish_alerts (ts, user_id, kind, text) VALUES (?, ?, 'trap', ?)").run(d.ts, userId, d.text);
        }
      }
    });
  }
  if (afterId > 0) {
    return db.prepare('SELECT id, ts, kind, text FROM fish_alerts WHERE user_id = ? AND id > ? AND kind != ? ORDER BY id LIMIT ?').all(userId, afterId, TRAP_DUE, limit) as FishAlert[];
  }
  const rows = db.prepare('SELECT id, ts, kind, text FROM fish_alerts WHERE user_id = ? AND kind != ? ORDER BY id DESC LIMIT ?').all(userId, TRAP_DUE, limit) as FishAlert[];
  return rows.reverse();
}
