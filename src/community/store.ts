/**
 * Community features' storage: one SQLite file per channel at
 * data/community/<channel>.sqlite, holding when each chatter was first and last
 * seen, pending !remind reminders, each viewer's !cookie data, and !slots flushes.
 *
 * Only the channel's own bot writes it. It is separate from the points database
 * because every channel has these features, points or not. better-sqlite3 is
 * required lazily like points/db.ts: if it can't load, these commands go quiet
 * and nothing else is affected.
 */

import * as fs from 'fs';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { dataRoot } from '../points/config';
import { scanChat } from './chatlog';
import { resolveBotIdentity } from '../bot-identity';

export type CommunityDb = BetterSqlite3.Database;

const CHANNEL_RE = /^[a-z0-9_]{1,30}$/;
const RETRY_MS = 5 * 60_000;

const handles = new Map<string, CommunityDb>();
const failedAt = new Map<string, number>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS seen (
  username_lc TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user TEXT NOT NULL,
  from_lc TEXT NOT NULL,
  to_user TEXT NOT NULL,
  to_lc TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- NULL: delivered the next time the target chats. Otherwise posted at this time.
  due_at INTEGER,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS reminders_on_chat ON reminders(to_lc) WHERE done_at IS NULL AND due_at IS NULL;
CREATE INDEX IF NOT EXISTS reminders_due ON reminders(due_at) WHERE done_at IS NULL AND due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS reminders_from ON reminders(from_lc) WHERE done_at IS NULL;
DROP TABLE IF EXISTS cookies;
CREATE TABLE IF NOT EXISTS cookie_data (
  username_lc TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS slots_winners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  source TEXT NOT NULL,
  result TEXT NOT NULL,
  odds REAL NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openCommunityDb(channel: string): CommunityDb | null {
  const ch = channel.replace(/^#/, '').toLowerCase();
  if (!CHANNEL_RE.test(ch)) return null;
  const open = handles.get(ch);
  if (open) return open;
  const failed = failedAt.get(ch);
  if (failed && Date.now() - failed < RETRY_MS) return null;

  let db: CommunityDb | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Driver = require('better-sqlite3') as typeof BetterSqlite3;
    const file = path.join(dataRoot(), 'community', `${ch}.sqlite`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Driver(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    db.exec(SCHEMA);
    // Added after the table first shipped: whether the chatter showed a subscriber badge last time.
    const seenCols = db.prepare('PRAGMA table_info(seen)').all() as Array<{ name: string }>;
    if (!seenCols.some(c => c.name === 'is_sub')) db.exec('ALTER TABLE seen ADD COLUMN is_sub INTEGER NOT NULL DEFAULT 0');
    handles.set(ch, db);
    failedAt.delete(ch);
    startBackfill(ch, db);
    return db;
  } catch (err) {
    try { db?.close(); } catch { /* already unusable */ }
    failedAt.set(ch, Date.now());
    console.error(`[COMMUNITY] Could not open the ${ch} database (retrying in 5 min): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ─── Seen ───────────────────────────────────────────────────────────────────

export interface SeenRow {
  username: string;
  first_at: number;
  last_at: number;
  is_sub: number;
}

export function noteSeen(db: CommunityDb, username: string, at: number, isSub = false): void {
  db.prepare(
    'INSERT INTO seen (username_lc, username, first_at, last_at, is_sub) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(username_lc) DO UPDATE SET username = excluded.username, is_sub = excluded.is_sub, ' +
    'first_at = MIN(seen.first_at, excluded.first_at), last_at = MAX(seen.last_at, excluded.last_at)'
  ).run(username.toLowerCase(), username, at, at, isSub ? 1 : 0);
}

export function getSeen(db: CommunityDb, usernameLc: string): SeenRow | undefined {
  return db.prepare('SELECT username, first_at, last_at, is_sub FROM seen WHERE username_lc = ?').get(usernameLc) as SeenRow | undefined;
}

const backfilling = new Set<string>();

/**
 * Fill `seen` from the whole channel log, once per database. Runs in the
 * background on first open; live chat is recorded meanwhile, and the MIN/MAX
 * upsert means the two can land in any order. Marked done only when it finishes,
 * so a restart mid-way simply runs it again.
 */
function startBackfill(channel: string, db: CommunityDb): void {
  if (backfilling.has(channel)) return;
  if (db.prepare("SELECT 1 FROM meta WHERE key = 'seen_backfilled'").get()) return;
  backfilling.add(channel);
  const started = Date.now();
  // Collapse in memory first: the log holds millions of lines but only thousands of names.
  const acc = new Map<string, { username: string; first: number; last: number }>();
  // The bot's own lines are only recognisable once its identity is known.
  resolveBotIdentity().catch(() => null).then(() => scanChat(channel, c => {
    const lc = c.username.toLowerCase();
    const e = acc.get(lc);
    if (!e) acc.set(lc, { username: c.username, first: c.at, last: c.at });
    else {
      if (c.at < e.first) e.first = c.at;
      if (c.at >= e.last) { e.last = c.at; e.username = c.username; }
    }
  }))
    .then(lines => {
      const upsert = db.prepare(
        'INSERT INTO seen (username_lc, username, first_at, last_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(username_lc) DO UPDATE SET first_at = MIN(seen.first_at, excluded.first_at), last_at = MAX(seen.last_at, excluded.last_at)'
      );
      db.transaction(() => {
        for (const [lc, e] of acc) upsert.run(lc, e.username, e.first, e.last);
        db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('seen_backfilled', ?)").run(String(Date.now()));
      })();
      console.log(`[COMMUNITY] ${channel}: backfilled last-seen for ${acc.size} chatters from ${lines} log lines in ${Date.now() - started}ms`);
    })
    .catch(err => console.error(`[COMMUNITY] ${channel}: last-seen backfill failed, will retry on restart: ${err instanceof Error ? err.message : String(err)}`))
    .finally(() => backfilling.delete(channel));
}

// ─── Reminders ──────────────────────────────────────────────────────────────

export interface Reminder {
  id: number;
  from_user: string;
  to_user: string;
  to_lc: string;
  text: string;
  created_at: number;
  due_at: number | null;
}

export function addReminder(
  db: CommunityDb,
  r: { from: string; to: string; text: string; now: number; dueAt: number | null }
): number {
  const res = db.prepare(
    'INSERT INTO reminders (from_user, from_lc, to_user, to_lc, text, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(r.from, r.from.toLowerCase(), r.to, r.to.toLowerCase(), r.text, r.now, r.dueAt);
  return Number(res.lastInsertRowid);
}

export function pendingFrom(db: CommunityDb, fromLc: string): Reminder[] {
  return db.prepare(
    'SELECT id, from_user, to_user, to_lc, text, created_at, due_at FROM reminders WHERE from_lc = ? AND done_at IS NULL ORDER BY id'
  ).all(fromLc) as Reminder[];
}

/** Reminders waiting for this user to chat, oldest first. */
export function pendingOnChat(db: CommunityDb, toLc: string, limit: number): Reminder[] {
  return db.prepare(
    'SELECT id, from_user, to_user, to_lc, text, created_at, due_at FROM reminders WHERE to_lc = ? AND due_at IS NULL AND done_at IS NULL ORDER BY id LIMIT ?'
  ).all(toLc, limit) as Reminder[];
}

export function dueReminders(db: CommunityDb, now: number, limit: number): Reminder[] {
  return db.prepare(
    'SELECT id, from_user, to_user, to_lc, text, created_at, due_at FROM reminders WHERE due_at IS NOT NULL AND due_at <= ? AND done_at IS NULL ORDER BY due_at LIMIT ?'
  ).all(now, limit) as Reminder[];
}

/**
 * Mark a reminder done. Returns false when it already was, so two paths racing
 * for the same reminder deliver it once.
 */
export function finishReminder(db: CommunityDb, id: number, now: number): boolean {
  return db.prepare('UPDATE reminders SET done_at = ? WHERE id = ? AND done_at IS NULL').run(now, id).changes === 1;
}

/** Cancel a pending reminder, only by the viewer who set it. */
export function cancelReminder(db: CommunityDb, id: number, fromLc: string, now: number): boolean {
  return db.prepare('UPDATE reminders SET done_at = ? WHERE id = ? AND from_lc = ? AND done_at IS NULL').run(now, id, fromLc).changes === 1;
}

// ─── Cookies ────────────────────────────────────────────────────────────────

export function loadCookieData(db: CommunityDb, usernameLc: string): { username: string; data: string } | undefined {
  return db.prepare('SELECT username, data FROM cookie_data WHERE username_lc = ?').get(usernameLc) as { username: string; data: string } | undefined;
}

export function saveCookieData(db: CommunityDb, username: string, data: string): void {
  db.prepare('INSERT INTO cookie_data (username_lc, username, data) VALUES (?, ?, ?) ON CONFLICT(username_lc) DO UPDATE SET username = excluded.username, data = excluded.data')
    .run(username.toLowerCase(), username, data);
}

/** Most cookies eaten, all time. */
export function topCookieEaters(db: CommunityDb, limit: number): Array<{ username: string; eaten: number }> {
  return db.prepare(
    `SELECT username, CAST(json_extract(data, '$.total.eaten.daily') AS INTEGER) + CAST(json_extract(data, '$.total.eaten.received') AS INTEGER) AS eaten
     FROM cookie_data ORDER BY eaten DESC LIMIT ?`
  ).all(limit) as Array<{ username: string; eaten: number }>;
}

// ─── Slots ──────────────────────────────────────────────────────────────────

export function logSlotsWin(db: CommunityDb, w: { username: string; source: string; result: string; odds: number; at: number }): void {
  db.prepare('INSERT INTO slots_winners (username, source, result, odds, at) VALUES (?, ?, ?, ?, ?)').run(w.username, w.source, w.result, w.odds, w.at);
}

/** The flushes that beat the longest odds. */
export function topSlotsWins(db: CommunityDb, limit: number): Array<{ username: string; result: string; odds: number }> {
  return db.prepare('SELECT username, result, odds FROM slots_winners ORDER BY odds DESC, at ASC LIMIT ?').all(limit) as Array<{ username: string; result: string; odds: number }>;
}
