/**
 * The loyalty points database: one SQLite file per channel.
 *
 * Two processes write it: the channel's bot (ticks, bonuses, chat commands) and
 * the enrollment service (dashboard adjustments). WAL lets the enrollment
 * service read while the bot writes, and every write takes the lock up front
 * (BEGIN IMMEDIATE) so two writers queue instead of deadlocking on an upgrade.
 *
 * better-sqlite3 is a native module, so it is required lazily. If it can't load,
 * points switch off with one log line and the load is retried every five
 * minutes. Nothing here may crash a channel's bot.
 */

import * as fs from 'fs';
import * as path from 'path';
import type BetterSqlite3 from 'better-sqlite3';
import { dataRoot } from './config';

export type PointsDb = BetterSqlite3.Database;
type Driver = typeof BetterSqlite3;

/** How long a failed driver load or database open waits before trying again. */
const RETRY_MS = 5 * 60_000;
const CHANNEL_RE = /^[a-z0-9_]{1,30}$/;

let driver: Driver | null = null;
let driverFailedAt = 0;

function loadDriver(): Driver | null {
  if (driver) return driver;
  if (driverFailedAt && Date.now() - driverFailedAt < RETRY_MS) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    driver = require('better-sqlite3') as Driver;
    if (driverFailedAt) console.log('[POINTS] SQLite driver loaded after an earlier failure');
    driverFailedAt = 0;
    return driver;
  } catch (err) {
    driverFailedAt = Date.now();
    console.error(`[POINTS] SQLite driver unavailable, points are off until it loads (retrying in 5 min): ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Whether better-sqlite3 loads in this process. */
export function driverAvailable(): boolean {
  return loadDriver() !== null;
}

const SCHEMA_V1 = `
CREATE TABLE users (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  username_lc TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  lifetime_earned INTEGER NOT NULL DEFAULT 0,
  watch_seconds INTEGER NOT NULL DEFAULT 0,
  is_sub INTEGER NOT NULL DEFAULT 0,
  last_chat_at INTEGER,
  follow_bonus_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX users_name ON users(username_lc, last_seen_at DESC);
CREATE INDEX users_balance ON users(balance DESC, user_id);
CREATE INDEX users_watch ON users(watch_seconds DESC, user_id);
CREATE INDEX users_active ON users(last_chat_at);

CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  delta INTEGER NOT NULL,
  balance_after INTEGER NOT NULL,
  reason TEXT NOT NULL,
  ref TEXT,
  actor TEXT,
  note TEXT
);
CREATE INDEX ledger_user_ts ON ledger(user_id, ts DESC);
CREATE INDEX ledger_reason_user_ts ON ledger(reason, user_id, ts);

CREATE TABLE watch_ledger (
  stream_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  points INTEGER NOT NULL,
  seconds INTEGER NOT NULL,
  ticks INTEGER NOT NULL,
  PRIMARY KEY (stream_key, user_id)
);
CREATE INDEX watch_ledger_user ON watch_ledger(user_id);

CREATE TABLE ticks (
  slot_key TEXT PRIMARY KEY,
  stream_key TEXT,
  at INTEGER NOT NULL,
  users INTEGER NOT NULL DEFAULT 0,
  subs INTEGER NOT NULL DEFAULT 0,
  points INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE applied (
  key TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX applied_at ON applied(at);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

/**
 * v2: duels. A challenger's stake is held until the duel is answered, so pending
 * duels live here rather than in a bot's memory, where a restart would strand the
 * stake. The partial unique index allows one pending challenge per challenger.
 */
const SCHEMA_V2 = `
CREATE TABLE duels (
  id TEXT PRIMARY KEY,
  challenger_id INTEGER NOT NULL REFERENCES users(user_id),
  opponent_id INTEGER NOT NULL REFERENCES users(user_id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  winner_id INTEGER,
  resolved_at INTEGER
);
CREATE INDEX duels_pending ON duels(status, expires_at);
CREATE INDEX duels_opponent ON duels(opponent_id, status);
CREATE UNIQUE INDEX duels_one_outgoing ON duels(challenger_id) WHERE status = 'pending';
`;

/**
 * v3: raffles. A raffle outlives the message that opened it and must survive a
 * restart mid-draw, so the open raffle and its entries live here rather than in
 * memory. The partial unique index allows one open raffle per channel at a time.
 * Entries are keyed by raffle and user, which makes a second join a no-op rather
 * than a second ticket.
 */
const SCHEMA_V3 = `
CREATE TABLE raffles (
  id TEXT PRIMARY KEY,
  prize INTEGER NOT NULL CHECK (prize > 0),
  winners INTEGER NOT NULL CHECK (winners > 0),
  stream_key TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX raffles_open ON raffles(status, closes_at);
CREATE INDEX raffles_stream ON raffles(stream_key);
CREATE UNIQUE INDEX raffles_one_open ON raffles(status) WHERE status = 'open';

CREATE TABLE raffle_entries (
  raffle_id TEXT NOT NULL REFERENCES raffles(id),
  user_id INTEGER NOT NULL REFERENCES users(user_id),
  username TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (raffle_id, user_id)
);
`;

/**
 * v4: an index on the ledger's ref. Rows that belong to one event share a ref —
 * both halves of a give, every row of a duel — so the log can name the other side
 * of a transfer. Without this each lookup scans the ledger. Partial: most rows
 * (ticks, bonuses, penalties) have no ref and don't belong in the index.
 */
const SCHEMA_V4 = `
CREATE INDEX ledger_ref ON ledger(ref) WHERE ref IS NOT NULL;
`;

const SCHEMA_VERSION = 4;

export function migrate(db: PointsDb): void {
  if ((db.pragma('user_version', { simple: true }) as number) >= SCHEMA_VERSION) return;
  db.transaction(() => {
    // Read again under the write lock. The bot and the enrollment service can open a
    // database at the same moment; whichever gets here second must not create the
    // tables again ("table users already exists"). Each step is additive.
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version < 1) db.exec(SCHEMA_V1);
    if (version < 2) db.exec(SCHEMA_V2);
    if (version < 3) db.exec(SCHEMA_V3);
    if (version < 4) db.exec(SCHEMA_V4);
    if (version < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }).immediate();
}

interface Handle {
  db: PointsDb;
  file: string;
}

const handles = new Map<string, Handle>();
const openFailedAt = new Map<string, number>();
/** Channels whose database was quarantined as corrupt. Stays off until the process restarts. */
const quarantined = new Set<string>();

/**
 * How long a write waits for the other process before giving up. The bot's event
 * loop stops while it waits (chat handling and the socket ping stall with it), so
 * the bot uses a short wait; the enrollment service keeps the longer default.
 */
let busyTimeoutMs = Number(process.env.POINTS_BUSY_TIMEOUT_MS) || 5000;
let busyRetries = 3;

export function configurePointsDb(opts: { busyTimeoutMs?: number; busyRetries?: number }): void {
  if (opts.busyTimeoutMs !== undefined) busyTimeoutMs = opts.busyTimeoutMs;
  if (opts.busyRetries !== undefined) busyRetries = opts.busyRetries;
  for (const h of handles.values()) {
    try { h.db.pragma(`busy_timeout = ${busyTimeoutMs}`); } catch { /* closed */ }
  }
}

/**
 * Written next to a quarantined database. Every process refuses the channel's
 * database while it exists, so none of them quietly starts a fresh, empty ledger
 * in place of the corrupt one.
 *
 * Recovery: copy a good file from backups/ over points.sqlite, delete this
 * marker, then restart the channel's bot and the enrollment service.
 */
export function quarantineMarkerPath(channel: string): string {
  return `${pointsDbPath(channel)}.quarantined`;
}

export function pointsDir(channel: string): string {
  return path.join(dataRoot(), 'points', channel);
}

export function pointsDbPath(channel: string): string {
  return path.join(pointsDir(channel), 'points.sqlite');
}

function errorCode(err: unknown): string {
  return String((err as { code?: unknown })?.code ?? '');
}

export function isCorruption(err: unknown): boolean {
  const code = errorCode(err);
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB';
}

/**
 * The channel's database, opened and migrated on first use, or null when it
 * can't be used. `create: false` never makes a file: read paths in the
 * enrollment service must not litter channels that never enabled points.
 */
export function openPointsDb(channel: string, opts: { create: boolean }): PointsDb | null {
  if (!CHANNEL_RE.test(channel) || quarantined.has(channel)) return null;
  const file = pointsDbPath(channel);
  if (fs.existsSync(quarantineMarkerPath(channel))) {
    // Quarantined by the other process, or by this one before a restart.
    quarantined.add(channel);
    closePointsDb(channel);
    console.error(`[POINTS] ${channel} points database is quarantined (${quarantineMarkerPath(channel)}); points stay off until it is restored`);
    return null;
  }

  const existing = handles.get(channel);
  if (existing) {
    // Only the selftest moves the data root; a handle for another root is stale.
    if (existing.file === file) return existing.db;
    closePointsDb(channel);
  }

  if (!opts.create && !fs.existsSync(file)) return null;
  const failedAt = openFailedAt.get(channel);
  if (failedAt && Date.now() - failedAt < RETRY_MS) return null;

  const Driver = loadDriver();
  if (!Driver) return null;

  let db: PointsDb | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    db = new Driver(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma(`busy_timeout = ${busyTimeoutMs}`);
    db.pragma('foreign_keys = ON');
    db.pragma('cache_size = -4000');
    migrate(db);
    handles.set(channel, { db, file });
    openFailedAt.delete(channel);
    return db;
  } catch (err) {
    try { db?.close(); } catch { /* already unusable */ }
    if (isCorruption(err)) {
      quarantine(channel, err);
    } else {
      openFailedAt.set(channel, Date.now());
      console.error(`[POINTS] Could not open the ${channel} points database (retrying in 5 min): ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
  }
}

export function closePointsDb(channel: string): void {
  const h = handles.get(channel);
  if (!h) return;
  handles.delete(channel);
  try { h.db.close(); } catch { /* already closed */ }
}

export function closeAllPointsDbs(): void {
  for (const channel of Array.from(handles.keys())) closePointsDb(channel);
}

/**
 * Move a corrupt database aside and switch the channel's points off.
 *
 * No automatic restore: a daily backup exists, but picking one means deciding
 * which balances are lost, and that is the owner's call. The alert says so.
 */
function quarantine(channel: string, err: unknown): void {
  closePointsDb(channel);
  quarantined.add(channel);
  const file = pointsDbPath(channel);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.renameSync(file + suffix, `${file}${suffix}.corrupt-${stamp}`); } catch { /* not present */ }
  }
  const detail = err instanceof Error ? err.message : String(err);
  try {
    fs.writeFileSync(quarantineMarkerPath(channel), JSON.stringify({ at: new Date().toISOString(), reason: detail, pid: process.pid }) + '\n');
  } catch { /* the in-process flag still holds; the other process will meet the corruption itself */ }
  console.error(`[POINTS] ${channel} points database is corrupt (${detail}); moved aside as .corrupt-${stamp}, points are off until it is restored and the marker removed`);
  if (process.env.POINTS_SELFTEST === '1') return;
  try {
    // Loaded here, not at the top: the selftest must never reach Telegram.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TelegramNotifier = require('../telegram-notifier') as new () => { sendMessage(message: string, silent?: boolean): Promise<boolean> };
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    void new TelegramNotifier().sendMessage(
      `🚨 <b>Kick Bot - Points Database Corrupt</b>\n\n<b>Channel:</b> ${esc(channel)}\n<b>Error:</b> <code>${esc(detail.slice(0, 200))}</code>\n\n` +
      `Moved aside as <code>points.sqlite.corrupt-${esc(stamp)}</code>. Points are off for this channel. ` +
      `Restore a copy from <code>data/points/${esc(channel)}/backups/</code> , delete <code>points.sqlite.quarantined</code>, then restart the bot and the enrollment service.`,
      false
    ).catch(() => {});
  } catch { /* alerting must not make it worse */ }
}

/** Call with any error from a points query: corruption is quarantined, anything else is left to the caller. */
export function reportDbError(channel: string, err: unknown): void {
  if (isCorruption(err)) quarantine(channel, err);
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` in a BEGIN IMMEDIATE transaction. busy_timeout waits for the other
 * process first; a still-busy database gets a few short, jittered retries
 * (configurePointsDb). Callers keep `fn` short, since it blocks the event loop.
 */
export function runWrite<T>(db: PointsDb, fn: () => T): T {
  for (let attempt = 0; ; attempt++) {
    try {
      return db.transaction(fn).immediate();
    } catch (err) {
      if (errorCode(err).startsWith('SQLITE_BUSY') && attempt < busyRetries) {
        sleepSync(20 + Math.floor(Math.random() * 80));
        continue;
      }
      throw err;
    }
  }
}
