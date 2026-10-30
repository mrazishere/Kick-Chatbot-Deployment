// The fishing game played on the public leaderboard's Fishing tab. A move made there
// reaches the channel's bot as a `web.fish` event on its webhook queue (webhook-poller.ts)
// and runs the chat command itself (bot-commands/fish.ts), with every rule, timer and
// check as in chat. Only the replies differ: they go here, under the move's request id,
// for the page to read, and never to chat or the overlay. Web moves don't count as
// chatting, so they earn no watch time and can't make anyone a big bite's pick.

import * as fs from 'fs';
import * as path from 'path';
import type { PointsDb } from '../points/db';
import { runWrite } from '../points/db';

/**
 * logs/web-fishing.log: one line per thing a viewer does on the fishing page (moves with their full
 * replies, shop buys, refusals, sign-ins from the dashboard), so a tester's session reads top to bottom.
 * The dashboard writes the same file (dashboard/src/lib/web-fishing-log.ts). Kept to two 5 MB files.
 */
const WEB_LOG = path.join(__dirname, '..', '..', 'logs', 'web-fishing.log');
const WEB_LOG_MAX = 5 * 1024 * 1024;

/** Local time as the pm2 logs print it: 2026-10-30 08:27:37. */
function stamp(d = new Date()): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One line in logs/web-fishing.log. Never throws: logging must not break a move. */
export function logWebFishing(channel: string, username: string, what: string, detail: string): void {
  try {
    try {
      if (fs.statSync(WEB_LOG).size > WEB_LOG_MAX) fs.renameSync(WEB_LOG, `${WEB_LOG}.1`);
    } catch {
      // No file yet.
    }
    fs.mkdirSync(path.dirname(WEB_LOG), { recursive: true });
    fs.appendFileSync(WEB_LOG, `${stamp()} [${channel}] ${username} ${what}: ${detail.replace(/\s+/g, ' ').trim()}\n`, 'utf8');
  } catch (err) {
    console.error(`[FISH PAGE] web-fishing.log write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The queue event the enrollment service writes for a move. */
export const WEB_FISH_EVENT = 'web.fish';

export interface WebFishMove {
  requestId: string;
  userId: number;
  username: string;
  /** The words after `fish`: [] for a cast, ['worm'] with bait, ['trap', 'reset', '2h'], ['answer', 'tap:0.41,0.62']. */
  args: string[];
}

export interface WebReply { ts: number; text: string; kind: string | null; item: string | null }

const KEEP_MS = 24 * 60 * 60 * 1000;
let writes = 0;

/** Store one reply. Never throws: a failed write must not break the move. */
export function recordWebReply(db: PointsDb, move: Pick<WebFishMove, 'requestId' | 'userId'>, text: string, meta: { kind?: string; item?: string } = {}, now = Date.now()): void {
  try {
    runWrite(db, () => {
      db.prepare('INSERT INTO web_replies (ts, request_id, user_id, text, kind, item) VALUES (?, ?, ?, ?, ?, ?)')
        .run(now, move.requestId, move.userId, text, meta.kind ?? null, meta.item ?? null);
      if (++writes % 50 === 1) db.prepare('DELETE FROM web_replies WHERE ts < ?').run(now - KEEP_MS);
    });
  } catch (err) {
    console.error(`[FISH] Web reply write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The replies to one move, oldest first. */
export function repliesFor(db: PointsDb, requestId: string): WebReply[] {
  try {
    return db.prepare('SELECT ts, text, kind, item FROM web_replies WHERE request_id = ? ORDER BY id').all(requestId) as WebReply[];
  } catch {
    return []; // a database from before v16
  }
}

/** A viewer's latest replies, newest first: the page's log, a timed-out check's line included. */
export function recentReplies(db: PointsDb, userId: number, limit = 12): WebReply[] {
  try {
    return db.prepare('SELECT ts, text, kind, item FROM web_replies WHERE user_id = ? AND ts >= ? ORDER BY id DESC LIMIT ?')
      .all(userId, Date.now() - KEEP_MS, limit) as WebReply[];
  } catch {
    return [];
  }
}
