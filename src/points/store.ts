/**
 * Loyalty points storage: balances, the ledger, watch-time ticks and event
 * idempotency, on top of the per-channel database in db.ts.
 *
 * Everything that changes a balance writes a ledger row in the same
 * transaction, except watch-time grants, which are totalled per stream in
 * watch_ledger (one row per viewer per tick would be millions of rows a year).
 * So a balance always equals its ledger deltas plus its watch points, and
 * invariantViolations() checks exactly that.
 *
 * The channel-level functions at the bottom are what the enrollment service
 * calls for the dashboard. They only ever open an existing database.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { PointsConfig } from '../types';
import { SYSTEM_BOTS } from '../system-bots';
import { getBotIdentity } from '../bot-identity';
import { readLivePointsConfig } from './config';
import { PointsDb, driverAvailable, openPointsDb, pointsDir, reportDbError, runWrite } from './db';

export interface UserRecord {
  user_id: number;
  username: string;
  username_lc: string;
  balance: number;
  lifetime_earned: number;
  watch_seconds: number;
  is_sub: number;
  last_chat_at: number | null;
  follow_bonus_at: number | null;
  first_seen_at: number;
  last_seen_at: number;
}

export interface ChatterRow {
  userId: number;
  username: string;
  isSub: boolean;
  at: number;
}

/** Accounts that never earn, rank or appear on leaderboards. */
export interface Exclusions {
  names: Set<string>;
  ids: Set<number>;
}

export interface PointsUserRow {
  userId: number;
  username: string;
  balance: number;
  watchSeconds: number;
  /** Position by balance among ranked viewers; 0 for an excluded account. */
  rank: number;
  lastSeenAt: string | null;
}

export interface PointsUserDetail {
  user: PointsUserRow & { lifetimeEarned: number; isSub: boolean; followBonusAt: string | null; firstSeenAt: string };
  ledger: Array<{ id: number; ts: string; delta: number; balanceAfter: number; reason: string; actor: string | null; note: string | null; counterparty: string | null }>;
}

const iso = (ms: number | null | undefined): string | null => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// ─── Exclusions ─────────────────────────────────────────────────────────────

function readBroadcasterId(channel: string): number | null {
  return readLivePointsConfig(channel).broadcasterUserId;
}

/**
 * Who is excluded in this channel: system bots, this bot's own account, the
 * ignore list, and the broadcaster when excludeBroadcaster is on (matched by id
 * and by the channel name, since a streamer's username is their channel slug).
 */
export function exclusionsFor(
  channel: string,
  cfg: Pick<PointsConfig, 'ignoreUsers' | 'excludeBroadcaster'>,
  broadcasterUserId?: number | null
): Exclusions {
  const names = new Set<string>(SYSTEM_BOTS);
  for (const name of cfg.ignoreUsers) names.add(name.toLowerCase());
  const ids = new Set<number>();

  const bot = getBotIdentity();
  if (bot?.username) names.add(bot.username.toLowerCase());
  if (bot && Number.isFinite(Number(bot.userId))) ids.add(Number(bot.userId));
  // The enrollment service never resolves the bot identity; the account name is in its env.
  const envBot = (process.env.KICK_USERNAME || '').toLowerCase();
  if (envBot) names.add(envBot);

  if (cfg.excludeBroadcaster) {
    names.add(channel.toLowerCase());
    const bid = broadcasterUserId ?? readBroadcasterId(channel);
    if (typeof bid === 'number' && Number.isFinite(bid)) ids.add(bid);
  }
  return { names, ids };
}

export function isExcluded(ex: Exclusions, userId: number | null | undefined, username: string | null | undefined): boolean {
  if (typeof userId === 'number' && ex.ids.has(userId)) return true;
  return !!username && ex.names.has(username.toLowerCase());
}

function exclusionClause(ex: Exclusions): { sql: string; params: Array<string | number> } {
  const parts: string[] = [];
  const params: Array<string | number> = [];
  if (ex.names.size) {
    parts.push(`username_lc NOT IN (${Array.from(ex.names, () => '?').join(',')})`);
    params.push(...ex.names);
  }
  if (ex.ids.size) {
    parts.push(`user_id NOT IN (${Array.from(ex.ids, () => '?').join(',')})`);
    params.push(...ex.ids);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1=1', params };
}

// ─── Writes (callers inside a transaction) ──────────────────────────────────

export function getUser(db: PointsDb, userId: number): UserRecord | undefined {
  return db.prepare('SELECT * FROM users WHERE user_id = ?').get(userId) as UserRecord | undefined;
}

/**
 * The user's row, created if needed. A username from the event or message
 * replaces the stored one, so a rename shows up without splitting the balance.
 * Call inside a write transaction.
 */
export function ensureUserTx(db: PointsDb, userId: number, username: string | null, now: number): UserRecord {
  const name = (username && username.trim()) || String(userId);
  db.prepare(
    'INSERT OR IGNORE INTO users (user_id, username, username_lc, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, name, name.toLowerCase(), now, now);
  if (username && username.trim()) {
    db.prepare('UPDATE users SET username = ?, username_lc = ?, last_seen_at = MAX(last_seen_at, ?) WHERE user_id = ?')
      .run(name, name.toLowerCase(), now, userId);
  }
  return getUser(db, userId)!;
}

export interface CreditArgs {
  userId: number;
  username?: string | null;
  amount: number;
  reason: string;
  ref?: string | null;
  actor?: string | null;
  note?: string | null;
  now: number;
}

/** Add `amount` and write the ledger row. Returns the new balance. Call inside a write transaction. */
export function creditTx(db: PointsDb, a: CreditArgs): number {
  const amount = Math.max(0, Math.floor(a.amount));
  ensureUserTx(db, a.userId, a.username ?? null, a.now);
  // A transfer moves points that were already earned once, and game winnings are luck, not earnings.
  const earned = a.reason === 'give_in' || a.reason.startsWith('game:') ? 0 : amount;
  db.prepare('UPDATE users SET balance = balance + ?, lifetime_earned = lifetime_earned + ? WHERE user_id = ?').run(amount, earned, a.userId);
  const balance = (db.prepare('SELECT balance FROM users WHERE user_id = ?').get(a.userId) as { balance: number }).balance;
  db.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.now, a.userId, amount, balance, a.reason, a.ref ?? null, a.actor ?? null, a.note ?? null);
  return balance;
}

/**
 * Take `amount` only if the balance covers it, as one conditional UPDATE, so
 * two spends racing each other can't overdraw. Call inside a write transaction.
 */
export function debitTx(db: PointsDb, a: Omit<CreditArgs, 'username'>): { ok: boolean; balance: number } {
  const amount = Math.max(0, Math.floor(a.amount));
  const res = db.prepare('UPDATE users SET balance = balance - ? WHERE user_id = ? AND balance >= ?').run(amount, a.userId, amount);
  const row = db.prepare('SELECT balance FROM users WHERE user_id = ?').get(a.userId) as { balance: number } | undefined;
  if (res.changes !== 1 || !row) return { ok: false, balance: row?.balance ?? 0 };
  db.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.now, a.userId, -amount, row.balance, a.reason, a.ref ?? null, a.actor ?? null, a.note ?? null);
  return { ok: true, balance: row.balance };
}

/** Set the balance outright; the ledger records the difference. Call inside a write transaction. */
export function setTx(db: PointsDb, a: Omit<CreditArgs, 'amount' | 'username'> & { value: number }): { balance: number; delta: number } {
  const user = getUser(db, a.userId);
  if (!user) throw new Error(`user ${a.userId} not found`);
  const value = Math.max(0, Math.floor(a.value));
  const delta = value - user.balance;
  db.prepare('UPDATE users SET balance = ? WHERE user_id = ?').run(value, a.userId);
  db.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(a.now, a.userId, delta, value, a.reason, a.ref ?? null, a.actor ?? null, a.note ?? null);
  return { balance: value, delta };
}

/** Whether the user got a grant for any of `reasons` since `sinceMs`. */
export function recentGrant(db: PointsDb, userId: number, reasons: string[], sinceMs: number): boolean {
  if (!reasons.length) return false;
  const row = db.prepare(
    `SELECT 1 FROM ledger WHERE user_id = ? AND ts >= ? AND reason IN (${reasons.map(() => '?').join(',')}) LIMIT 1`
  ).get(userId, sinceMs, ...reasons);
  return !!row;
}

export function getMeta(db: PointsDb, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string | null } | undefined;
  return row?.value ?? null;
}

export function setMetaTx(db: PointsDb, key: string, value: string | null): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ─── Transactions ───────────────────────────────────────────────────────────

/** Record chat presence: last message time, badge-derived sub status and current username. */
export function noteChatters(db: PointsDb, rows: ChatterRow[]): void {
  if (!rows.length) return;
  const insert = db.prepare(
    'INSERT INTO users (user_id, username, username_lc, is_sub, last_chat_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, username_lc = excluded.username_lc, is_sub = excluded.is_sub, ' +
    'last_chat_at = MAX(COALESCE(users.last_chat_at, 0), excluded.last_chat_at), last_seen_at = MAX(users.last_seen_at, excluded.last_seen_at)'
  );
  runWrite(db, () => {
    for (const r of rows) insert.run(r.userId, r.username, r.username.toLowerCase(), r.isSub ? 1 : 0, r.at, r.at, r.at);
  });
}

/**
 * Run `fn` once per `key`, ever. The key is claimed in the same transaction as
 * whatever `fn` writes, so a replayed webhook or a crash between the two can't
 * grant twice or lose the grant.
 */
export function applyOnce<T>(db: PointsDb, key: string, now: number, fn: () => T): { applied: boolean; result?: T } {
  return runWrite(db, () => {
    const claim = db.prepare('INSERT OR IGNORE INTO applied (key, at) VALUES (?, ?)').run(key, now);
    if (claim.changes !== 1) return { applied: false };
    return { applied: true, result: fn() };
  });
}

/** Whether applyOnce already ran for `key`, e.g. a chat message handled from the other source. */
export function isApplied(db: PointsDb, key: string): boolean {
  return !!db.prepare('SELECT 1 FROM applied WHERE key = ?').get(key);
}

/** Move points between viewers atomically. Fails without side effects when the sender is short. */
export function transfer(
  db: PointsDb,
  a: { fromId: number; toId: number; toName: string; amount: number; actor: string; now: number }
): { ok: boolean; fromBalance: number; toBalance?: number; ref: string } {
  const ref = `give:${crypto.randomUUID()}`;
  return runWrite(db, () => {
    const out = debitTx(db, { userId: a.fromId, amount: a.amount, reason: 'give_out', ref, actor: a.actor, now: a.now });
    if (!out.ok) return { ok: false, fromBalance: out.balance, ref };
    const toBalance = creditTx(db, { userId: a.toId, username: a.toName, amount: a.amount, reason: 'give_in', ref, actor: a.actor, now: a.now });
    return { ok: true, fromBalance: out.balance, toBalance, ref };
  });
}

/** Ledger reasons for the gamble game: every gamble writes a stake, and a win adds a payout. */
export const GAMBLE_STAKE = 'game:gamble';
export const GAMBLE_WIN = 'game:gamble_win';

/**
 * One even-money gamble, already rolled. The stake comes off with a conditional
 * debit, so a short balance fails without side effects; a win pays the stake back
 * doubled in the same transaction. Both rows share the ref.
 */
export function gamble(
  db: PointsDb,
  a: { userId: number; amount: number; win: boolean; actor: string; now: number }
): { ok: boolean; balance: number; ref: string } {
  const ref = `gamble:${crypto.randomUUID()}`;
  return runWrite(db, () => {
    const stake = debitTx(db, { userId: a.userId, amount: a.amount, reason: GAMBLE_STAKE, ref, actor: a.actor, now: a.now });
    if (!stake.ok || !a.win) return { ok: stake.ok, balance: stake.balance, ref };
    const balance = creditTx(db, { userId: a.userId, amount: a.amount * 2, reason: GAMBLE_WIN, ref, actor: a.actor, now: a.now });
    return { ok: true, balance, ref };
  });
}

/** Channel-wide gamble results. `net` is what viewers gained in total; negative means they lost. */
export interface GambleStats {
  gambles: number;
  wins: number;
  staked: number;
  net: number;
}

export function gambleStats(db: PointsDb, sinceMs = 0): GambleStats {
  return db.prepare(
    `SELECT COALESCE(SUM(reason = ?), 0) AS gambles, COALESCE(SUM(reason = ?), 0) AS wins,
       COALESCE(SUM(CASE WHEN reason = ? THEN -delta ELSE 0 END), 0) AS staked, COALESCE(SUM(delta), 0) AS net
     FROM ledger WHERE reason IN (?, ?) AND ts >= ?`
  ).get(GAMBLE_STAKE, GAMBLE_WIN, GAMBLE_STAKE, GAMBLE_STAKE, GAMBLE_WIN, sinceMs) as GambleStats;
}

/** Ledger reasons for duels. Every row of one duel has the duel id as its ref. */
export const DUEL_HOLD = 'game:duel_hold';
export const DUEL_STAKE = 'game:duel_stake';
export const DUEL_WIN = 'game:duel_win';
export const DUEL_REFUND = 'game:duel_refund';

export interface DuelRow {
  id: string;
  challenger_id: number;
  opponent_id: number;
  amount: number;
  created_at: number;
  expires_at: number;
  status: 'pending' | 'accepted' | 'denied' | 'cancelled' | 'expired';
  winner_id: number | null;
  resolved_at: number | null;
}

/** The challenger's pending duel, if any. There is at most one. */
export function outgoingDuel(db: PointsDb, challengerId: number): DuelRow | undefined {
  return db.prepare("SELECT * FROM duels WHERE challenger_id = ? AND status = 'pending'").get(challengerId) as DuelRow | undefined;
}

/** Pending duels waiting on this viewer, oldest first. */
export function incomingDuels(db: PointsDb, opponentId: number): DuelRow[] {
  return db.prepare("SELECT * FROM duels WHERE opponent_id = ? AND status = 'pending' ORDER BY created_at, rowid").all(opponentId) as DuelRow[];
}

/** Pending duels whose time to answer has run out. */
export function expiredDuels(db: PointsDb, now: number): DuelRow[] {
  return db.prepare("SELECT * FROM duels WHERE status = 'pending' AND expires_at <= ? ORDER BY expires_at").all(now) as DuelRow[];
}

export type CreateDuelResult =
  | { ok: true; duel: DuelRow }
  | { ok: false; reason: 'pending'; pending: DuelRow }
  | { ok: false; reason: 'short'; balance: number };

/**
 * A challenge: hold the challenger's stake and record the duel in one transaction.
 * Fails without side effects when they already have a pending duel or can't cover
 * the stake.
 */
export function createDuel(
  db: PointsDb,
  a: { challengerId: number; opponentId: number; amount: number; expiresAt: number; actor: string; now: number }
): CreateDuelResult {
  return runWrite<CreateDuelResult>(db, () => {
    const pending = outgoingDuel(db, a.challengerId);
    if (pending) return { ok: false, reason: 'pending', pending };
    const id = `duel:${crypto.randomUUID()}`;
    const hold = debitTx(db, { userId: a.challengerId, amount: a.amount, reason: DUEL_HOLD, ref: id, actor: a.actor, now: a.now });
    if (!hold.ok) return { ok: false, reason: 'short', balance: hold.balance };
    db.prepare("INSERT INTO duels (id, challenger_id, opponent_id, amount, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')")
      .run(id, a.challengerId, a.opponentId, a.amount, a.now, a.expiresAt);
    return { ok: true, duel: db.prepare('SELECT * FROM duels WHERE id = ?').get(id) as DuelRow };
  });
}

export type AcceptDuelResult =
  | { ok: true; duel: DuelRow; winnerId: number; loserId: number; winnerBalance: number }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'short'; balance: number };

/**
 * Accept a duel, already rolled: take the opponent's stake and pay the winner both.
 * Only a duel still pending and not yet expired can be accepted, so an accept racing
 * a deny, a cancel or the expiry sweep resolves once. An opponent who can't cover
 * the stake leaves the duel pending.
 */
export function acceptDuel(db: PointsDb, a: { id: string; challengerWins: boolean; actor: string; now: number }): AcceptDuelResult {
  return runWrite<AcceptDuelResult>(db, () => {
    const d = db.prepare("SELECT * FROM duels WHERE id = ? AND status = 'pending'").get(a.id) as DuelRow | undefined;
    if (!d || d.expires_at <= a.now) return { ok: false, reason: 'gone' };
    const stake = debitTx(db, { userId: d.opponent_id, amount: d.amount, reason: DUEL_STAKE, ref: d.id, actor: a.actor, now: a.now });
    if (!stake.ok) return { ok: false, reason: 'short', balance: stake.balance };
    const winnerId = a.challengerWins ? d.challenger_id : d.opponent_id;
    const loserId = a.challengerWins ? d.opponent_id : d.challenger_id;
    const winnerBalance = creditTx(db, { userId: winnerId, amount: d.amount * 2, reason: DUEL_WIN, ref: d.id, actor: a.actor, now: a.now });
    db.prepare("UPDATE duels SET status = 'accepted', winner_id = ?, resolved_at = ? WHERE id = ?").run(winnerId, a.now, d.id);
    return { ok: true, duel: { ...d, status: 'accepted', winner_id: winnerId, resolved_at: a.now }, winnerId, loserId, winnerBalance };
  });
}

/** Deny, cancel or expire a pending duel and refund the held stake. null when it was no longer pending. */
export function refundDuel(db: PointsDb, a: { id: string; status: 'denied' | 'cancelled' | 'expired'; actor: string; now: number }): DuelRow | null {
  return runWrite(db, () => {
    const res = db.prepare("UPDATE duels SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'").run(a.status, a.now, a.id);
    if (res.changes !== 1) return null;
    const d = db.prepare('SELECT * FROM duels WHERE id = ?').get(a.id) as DuelRow;
    creditTx(db, { userId: d.challenger_id, amount: d.amount, reason: DUEL_REFUND, ref: d.id, actor: a.actor, now: a.now });
    return d;
  });
}

/** Duels made since `sinceMs`: how many were played, what both sides put in, and how many still wait. */
export interface DuelStats {
  duels: number;
  staked: number;
  pending: number;
}

export function duelStats(db: PointsDb, sinceMs = 0): DuelStats {
  return db.prepare(
    `SELECT COALESCE(SUM(status = 'accepted'), 0) AS duels,
       COALESCE(SUM(CASE WHEN status = 'accepted' THEN amount * 2 ELSE 0 END), 0) AS staked,
       COALESCE(SUM(status = 'pending'), 0) AS pending
     FROM duels WHERE created_at >= ?`
  ).get(sinceMs) as DuelStats;
}

/** A raffle prize is minted when it is drawn, so it has one ledger reason and no stake. */
export const RAFFLE_WIN = 'game:raffle_win';

export interface RaffleRow {
  id: string;
  prize: number;
  winners: number;
  stream_key: string;
  opened_by: string;
  created_at: number;
  closes_at: number;
  status: 'open' | 'drawn' | 'cancelled';
  resolved_at: number | null;
}

export interface RaffleEntryRow {
  raffle_id: string;
  user_id: number;
  username: string;
  joined_at: number;
}

/** The channel's open raffle, if any. There is at most one. */
export function openRaffle(db: PointsDb): RaffleRow | undefined {
  return db.prepare("SELECT * FROM raffles WHERE status = 'open'").get() as RaffleRow | undefined;
}

/** Open raffles whose time is up, oldest first. */
export function dueRaffles(db: PointsDb, now: number): RaffleRow[] {
  return db.prepare("SELECT * FROM raffles WHERE status = 'open' AND closes_at <= ? ORDER BY closes_at").all(now) as RaffleRow[];
}

/** Everyone entered in a raffle, in the order they joined. */
export function raffleEntries(db: PointsDb, raffleId: string): RaffleEntryRow[] {
  return db.prepare('SELECT * FROM raffle_entries WHERE raffle_id = ? ORDER BY joined_at, rowid').all(raffleId) as RaffleEntryRow[];
}

/** How many raffles have been opened during this stream, drawn or not. Cancelled ones don't count. */
export function rafflesThisStream(db: PointsDb, streamKey: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM raffles WHERE stream_key = ? AND status <> 'cancelled'").get(streamKey) as { n: number }).n;
}

export type OpenRaffleResult =
  | { ok: true; raffle: RaffleRow }
  | { ok: false; reason: 'already'; raffle: RaffleRow }
  | { ok: false; reason: 'per_stream'; opened: number };

/**
 * Open a raffle. Fails without side effects when one is already open or the
 * per-stream allowance is used up. Nothing is debited: the prize is minted at the
 * draw, so an abandoned raffle costs nobody anything.
 */
export function createRaffle(
  db: PointsDb,
  a: { prize: number; winners: number; streamKey: string; openedBy: string; closesAt: number; maxPerStream: number; now: number }
): OpenRaffleResult {
  return runWrite<OpenRaffleResult>(db, () => {
    const live = openRaffle(db);
    if (live) return { ok: false, reason: 'already', raffle: live };
    if (a.maxPerStream > 0) {
      const opened = rafflesThisStream(db, a.streamKey);
      if (opened >= a.maxPerStream) return { ok: false, reason: 'per_stream', opened };
    }
    const id = `raffle:${crypto.randomUUID()}`;
    db.prepare(
      "INSERT INTO raffles (id, prize, winners, stream_key, opened_by, created_at, closes_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')"
    ).run(id, a.prize, a.winners, a.streamKey, a.openedBy, a.now, a.closesAt);
    return { ok: true, raffle: db.prepare('SELECT * FROM raffles WHERE id = ?').get(id) as RaffleRow };
  });
}

export type JoinRaffleResult = 'joined' | 'already' | 'closed';

/**
 * Enter the open raffle. Entry is free and one per viewer: a second join is
 * reported rather than adding a ticket. Joining a raffle whose time has passed is
 * refused, so a message that arrives during the draw doesn't slip in.
 */
export function joinRaffle(db: PointsDb, a: { userId: number; username: string; now: number }): JoinRaffleResult {
  return runWrite<JoinRaffleResult>(db, () => {
    const r = openRaffle(db);
    if (!r || r.closes_at <= a.now) return 'closed';
    // A viewer who has never earned has no row yet, and entry is free, so the row
    // is made here rather than turning them away from a raffle they can win.
    const user = ensureUserTx(db, a.userId, a.username, a.now);
    const res = db.prepare('INSERT OR IGNORE INTO raffle_entries (raffle_id, user_id, username, joined_at) VALUES (?, ?, ?, ?)')
      .run(r.id, user.user_id, user.username, a.now);
    return res.changes === 1 ? 'joined' : 'already';
  });
}

export interface RaffleDrawResult {
  raffle: RaffleRow;
  paid: Array<{ userId: number; username: string; amount: number; balance: number }>;
}

/**
 * Pay the winners and close the raffle, in one transaction. The winners are chosen
 * by the caller so the pick can be seeded in tests. An uneven prize goes to the
 * earlier winners first, a $DON at a time, so the whole prize is always paid out.
 * Returns null when the raffle was already drawn or cancelled, which is what makes
 * a sweep racing a manual draw resolve once.
 */
export function drawRaffle(
  db: PointsDb,
  a: { id: string; winners: Array<{ userId: number; username: string }>; actor: string; now: number }
): RaffleDrawResult | null {
  return runWrite<RaffleDrawResult | null>(db, () => {
    const claim = db.prepare("UPDATE raffles SET status = 'drawn', resolved_at = ? WHERE id = ? AND status = 'open'").run(a.now, a.id);
    if (claim.changes !== 1) return null;
    const r = db.prepare('SELECT * FROM raffles WHERE id = ?').get(a.id) as RaffleRow;
    const paid: RaffleDrawResult['paid'] = [];
    const n = a.winners.length;
    if (n > 0) {
      const each = Math.floor(r.prize / n);
      let extra = r.prize - each * n;
      for (const w of a.winners) {
        const amount = each + (extra > 0 ? 1 : 0);
        if (extra > 0) extra--;
        if (amount <= 0) continue;
        const balance = creditTx(db, { userId: w.userId, amount, reason: RAFFLE_WIN, ref: r.id, actor: a.actor, now: a.now });
        paid.push({ userId: w.userId, username: w.username, amount, balance });
      }
    }
    return { raffle: { ...r, status: 'drawn', resolved_at: a.now }, paid };
  });
}

/** Close a raffle without drawing. null when it was no longer open. Nothing to refund: entry was free. */
export function cancelRaffle(db: PointsDb, a: { id: string; now: number }): RaffleRow | null {
  return runWrite(db, () => {
    const res = db.prepare("UPDATE raffles SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status = 'open'").run(a.now, a.id);
    if (res.changes !== 1) return null;
    return db.prepare('SELECT * FROM raffles WHERE id = ?').get(a.id) as RaffleRow;
  });
}

export function tickExists(db: PointsDb, slotKey: string): boolean {
  return !!db.prepare('SELECT 1 FROM ticks WHERE slot_key = ?').get(slotKey);
}

/**
 * Grant one watch interval. The tick row is inserted first in the same
 * transaction, so the same slot granted twice (a restart's catch-up, or two
 * processes) grants once.
 */
export function grantTick(
  db: PointsDb,
  a: { slotKey: string; streamKey: string; now: number; boundaryMs: number; seconds: number; rows: Array<{ userId: number; points: number; isSub: boolean }> }
): { granted: boolean; users: number; subs: number; points: number } {
  return runWrite(db, () => {
    const claim = db.prepare('INSERT OR IGNORE INTO ticks (slot_key, stream_key, at) VALUES (?, ?, ?)').run(a.slotKey, a.streamKey, a.now);
    if (claim.changes !== 1) return { granted: false, users: 0, subs: 0, points: 0 };

    const addUser = db.prepare('UPDATE users SET balance = balance + ?, lifetime_earned = lifetime_earned + ?, watch_seconds = watch_seconds + ? WHERE user_id = ?');
    const addWatch = db.prepare(
      'INSERT INTO watch_ledger (stream_key, user_id, points, seconds, ticks) VALUES (?, ?, ?, ?, 1) ' +
      'ON CONFLICT(stream_key, user_id) DO UPDATE SET points = points + excluded.points, seconds = seconds + excluded.seconds, ticks = ticks + 1'
    );
    let points = 0;
    let subs = 0;
    for (const r of a.rows) {
      const p = Math.max(0, Math.floor(r.points));
      addUser.run(p, p, a.seconds, r.userId);
      addWatch.run(a.streamKey, r.userId, p, a.seconds);
      points += p;
      if (r.isSub) subs++;
    }
    db.prepare('UPDATE ticks SET users = ?, subs = ?, points = ? WHERE slot_key = ?').run(a.rows.length, subs, points, a.slotKey);
    setMetaTx(db, 'last_tick_at', String(a.boundaryMs));
    setMetaTx(db, 'last_tick_users', String(a.rows.length));
    return { granted: true, users: a.rows.length, subs, points };
  });
}

/** Drop idempotency keys older than `olderThanMs`. Webhook re-deliveries arrive within days, not weeks. */
export function pruneApplied(db: PointsDb, olderThanMs: number): number {
  return runWrite(db, () => db.prepare('DELETE FROM applied WHERE at < ?').run(olderThanMs).changes);
}

// ─── Queries ────────────────────────────────────────────────────────────────

/** The most recently seen user with this lowercase name. A name can be reused after a rename. */
export function findUserByName(db: PointsDb, usernameLc: string): UserRecord | undefined {
  return db.prepare('SELECT * FROM users WHERE username_lc = ? ORDER BY last_seen_at DESC LIMIT 1').get(usernameLc) as UserRecord | undefined;
}

type RankColumn = 'balance' | 'watch_seconds';

/** 1-based position by `column` among ranked viewers; ties share a rank. null for an excluded or unknown user. */
export function rankBy(db: PointsDb, userId: number, column: RankColumn, ex: Exclusions): number | null {
  const user = getUser(db, userId);
  if (!user || isExcluded(ex, user.user_id, user.username_lc)) return null;
  const clause = exclusionClause(ex);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${column} > ? AND ${clause.sql}`).get(user[column], ...clause.params) as { n: number };
  return row.n + 1;
}

export function countRanked(db: PointsDb, ex: Exclusions): number {
  const clause = exclusionClause(ex);
  return (db.prepare(`SELECT COUNT(*) AS n FROM users WHERE ${clause.sql}`).get(...clause.params) as { n: number }).n;
}

export function topBy(db: PointsDb, column: RankColumn, limit: number, ex: Exclusions): UserRecord[] {
  const clause = exclusionClause(ex);
  return db.prepare(`SELECT * FROM users WHERE ${column} > 0 AND ${clause.sql} ORDER BY ${column} DESC, user_id LIMIT ?`)
    .all(...clause.params, limit) as UserRecord[];
}

/**
 * One viewer's ledger, newest first, with the other side of the event named where
 * there is one. Rows belonging to a single event share a ref — a give writes
 * give_out and give_in, a duel writes the hold, the stake and the payout — so the
 * counterparty is the row with the same ref belonging to someone else. It stays
 * null for a row with no ref (ticks, bonuses, mod adjustments), for a gamble
 * (both rows are the viewer's own), and for a duel nobody has answered yet, which
 * has no second side to name.
 */
export function ledgerFor(db: PointsDb, userId: number, limit: number): Array<{ id: number; ts: number; delta: number; balance_after: number; reason: string; actor: string | null; note: string | null; counterparty: string | null }> {
  return db.prepare(
    `SELECT l.id, l.ts, l.delta, l.balance_after, l.reason, l.actor, l.note,
       (SELECT u.username FROM ledger o JOIN users u ON u.user_id = o.user_id
          WHERE o.ref = l.ref AND o.user_id <> l.user_id LIMIT 1) AS counterparty
     FROM ledger l WHERE l.user_id = ? ORDER BY l.ts DESC, l.id DESC LIMIT ?`)
    .all(userId, limit) as Array<{ id: number; ts: number; delta: number; balance_after: number; reason: string; actor: string | null; note: string | null; counterparty: string | null }>;
}

/** Balances that don't equal their ledger deltas plus their watch points. Should always be empty. */
export function invariantViolations(db: PointsDb): Array<{ user_id: number; balance: number; expected: number }> {
  return db.prepare(
    `SELECT u.user_id, u.balance, COALESCE(l.s, 0) + COALESCE(w.s, 0) AS expected FROM users u
     LEFT JOIN (SELECT user_id, SUM(delta) AS s FROM ledger GROUP BY user_id) l ON l.user_id = u.user_id
     LEFT JOIN (SELECT user_id, SUM(points) AS s FROM watch_ledger GROUP BY user_id) w ON w.user_id = u.user_id
     WHERE u.balance != COALESCE(l.s, 0) + COALESCE(w.s, 0)`
  ).all() as Array<{ user_id: number; balance: number; expected: number }>;
}

function toRow(db: PointsDb, u: UserRecord, ex: Exclusions): PointsUserRow {
  return {
    userId: u.user_id,
    username: u.username,
    balance: u.balance,
    watchSeconds: u.watch_seconds,
    rank: rankBy(db, u.user_id, 'balance', ex) ?? 0,
    lastSeenAt: iso(u.last_seen_at)
  };
}

// ─── Channel-level API (enrollment service) ─────────────────────────────────

function withReadDb<T>(channel: string, empty: T, fn: (db: PointsDb) => T): T {
  const db = openPointsDb(channel, { create: false });
  if (!db) return empty;
  try {
    return fn(db);
  } catch (err) {
    reportDbError(channel, err);
    throw err;
  }
}

export function pointsSummary(channel: string): {
  dbAvailable: boolean;
  users: number;
  totalPoints: number;
  lastTickAt: string | null;
  lastTickUsers: number | null;
  /** thisStream is null while the channel isn't known to be live. */
  gamble: { allTime: GambleStats; thisStream: GambleStats | null };
  duel: { allTime: DuelStats; thisStream: DuelStats | null };
} {
  const dbAvailable = driverAvailable();
  const none: GambleStats = { gambles: 0, wins: 0, staked: 0, net: 0 };
  const noDuels: DuelStats = { duels: 0, staked: 0, pending: 0 };
  const empty = {
    dbAvailable, users: 0, totalPoints: 0, lastTickAt: null, lastTickUsers: null,
    gamble: { allTime: none, thisStream: null }, duel: { allTime: noDuels, thisStream: null }
  };
  return withReadDb(channel, empty, db => {
    const row = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(balance), 0) AS total FROM users').get() as { n: number; total: number };
    const lastTick = getMeta(db, 'last_tick_at');
    const lastUsers = getMeta(db, 'last_tick_users');
    const liveSince = Number(getMeta(db, 'live_since'));
    return {
      dbAvailable,
      users: row.n,
      totalPoints: row.total,
      lastTickAt: lastTick ? iso(Number(lastTick)) : null,
      lastTickUsers: lastUsers === null ? null : Number(lastUsers),
      gamble: {
        allTime: gambleStats(db),
        thisStream: Number.isFinite(liveSince) && liveSince > 0 ? gambleStats(db, liveSince) : null
      },
      duel: {
        allTime: duelStats(db),
        thisStream: Number.isFinite(liveSince) && liveSince > 0 ? duelStats(db, liveSince) : null
      }
    };
  });
}

/** Viewers whose name starts with `q`, or the top balances when `q` is empty. Includes excluded accounts (rank 0). */
export function searchPointsUsers(channel: string, cfg: PointsConfig, q: string, limit: number, broadcasterUserId?: number | null): PointsUserRow[] {
  const n = Math.min(50, Math.max(1, Math.floor(limit) || 20));
  return withReadDb(channel, [] as PointsUserRow[], db => {
    const ex = exclusionsFor(channel, cfg, broadcasterUserId);
    const prefix = String(q ?? '').trim().replace(/^@+/, '').toLowerCase();
    const users = prefix
      // Usernames are [a-z0-9_]; DEL sorts after all of them, so this is a prefix range on the index.
      ? db.prepare('SELECT * FROM users WHERE username_lc >= ? AND username_lc < ? ORDER BY username_lc, last_seen_at DESC LIMIT ?')
          .all(prefix, prefix + '\x7f', n) as UserRecord[]
      : db.prepare('SELECT * FROM users ORDER BY balance DESC, user_id LIMIT ?').all(n) as UserRecord[];
    return users.map(u => toRow(db, u, ex));
  });
}

export function getPointsUserDetail(channel: string, cfg: PointsConfig, userId: number, broadcasterUserId?: number | null): PointsUserDetail | null {
  return withReadDb(channel, null as PointsUserDetail | null, db => {
    const u = getUser(db, userId);
    if (!u) return null;
    const ex = exclusionsFor(channel, cfg, broadcasterUserId);
    return {
      user: {
        ...toRow(db, u, ex),
        lifetimeEarned: u.lifetime_earned,
        isSub: u.is_sub === 1,
        followBonusAt: iso(u.follow_bonus_at),
        firstSeenAt: iso(u.first_seen_at) ?? new Date(0).toISOString()
      },
      ledger: ledgerFor(db, userId, 50).map(l => ({
        id: l.id,
        ts: iso(l.ts)!,
        delta: l.delta,
        balanceAfter: l.balance_after,
        reason: l.reason,
        actor: l.actor,
        note: l.note,
        counterparty: l.counterparty
      }))
    };
  });
}

export interface AdjustRequest {
  userId: number;
  mode: 'add' | 'remove' | 'set';
  amount: number;
  reason: string;
  /** Who did it, e.g. "dashboard:alice:manager". */
  actor: string;
  /** Makes a double-submit or a retry after a timeout apply once. */
  requestId: string;
}

/**
 * A dashboard balance change. Removing more than the balance takes it to 0 and
 * the ledger records what was actually removed.
 */
export function adjustPoints(
  channel: string,
  cfg: PointsConfig,
  req: AdjustRequest,
  broadcasterUserId?: number | null
): { applied: boolean; user: PointsUserRow } | { error: string; status: 400 | 404 } {
  const { userId, mode, amount, requestId } = req;
  const reason = String(req.reason ?? '').trim();
  if (!Number.isInteger(userId) || userId <= 0) return { error: 'userId must be a positive whole number', status: 400 };
  if (mode !== 'add' && mode !== 'remove' && mode !== 'set') return { error: 'mode must be add, remove or set', status: 400 };
  if (!Number.isInteger(amount) || amount < (mode === 'set' ? 0 : 1)) {
    return { error: mode === 'set' ? 'amount must be a whole number, 0 or more' : 'amount must be a whole number, 1 or more', status: 400 };
  }
  if (amount > cfg.modMaxAdjust) return { error: `amount can't be more than ${cfg.modMaxAdjust}`, status: 400 };
  if (reason.length < 3 || reason.length > 200) return { error: 'reason must be 3–200 characters', status: 400 };
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 100) return { error: 'requestId is required', status: 400 };

  const db = openPointsDb(channel, { create: false });
  if (!db) return { error: `No viewer with id ${userId}`, status: 404 };
  try {
    if (!getUser(db, userId)) return { error: `No viewer with id ${userId}`, status: 404 };
    const now = Date.now();
    const key = `dash:${requestId.trim()}`;
    const res = applyOnce(db, key, now, () => {
      const common = { userId, ref: key, actor: req.actor, note: reason, now };
      if (mode === 'add') creditTx(db, { ...common, amount, reason: 'dash_add' });
      else if (mode === 'remove') {
        const have = getUser(db, userId)!.balance;
        debitTx(db, { ...common, amount: Math.min(have, amount), reason: 'dash_remove' });
      } else setTx(db, { ...common, value: amount, reason: 'dash_set' });
    });
    const ex = exclusionsFor(channel, cfg, broadcasterUserId);
    return { applied: res.applied, user: toRow(db, getUser(db, userId)!, ex) };
  } catch (err) {
    reportDbError(channel, err);
    throw err;
  }
}

/** Public-safe leaderboards: usernames and values only, excluded accounts left out. */
export function pointsLeaderboard(
  channel: string,
  cfg: PointsConfig,
  limit: number,
  broadcasterUserId?: number | null
): { points: Array<{ rank: number; username: string; value: number }>; watchtime: Array<{ rank: number; username: string; value: number }> } {
  const n = Math.min(100, Math.max(1, Math.floor(limit) || 100));
  return withReadDb(channel, { points: [], watchtime: [] }, db => {
    const ex = exclusionsFor(channel, cfg, broadcasterUserId);
    return {
      points: topBy(db, 'balance', n, ex).map((u, i) => ({ rank: i + 1, username: u.username, value: u.balance })),
      watchtime: topBy(db, 'watch_seconds', n, ex).map((u, i) => ({ rank: i + 1, username: u.username, value: u.watch_seconds }))
    };
  });
}

/** Keep this many daily backups per channel. */
const BACKUPS_KEPT = 7;

/**
 * Copy the database to backups/points-YYYYMMDD.sqlite with SQLite's online
 * backup, which is safe while the bot writes. Returns the file, or null when
 * the channel has no database.
 */
export async function backupPoints(channel: string): Promise<string | null> {
  const db = openPointsDb(channel, { create: false });
  if (!db) return null;
  const dir = path.join(pointsDir(channel), 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(dir, `points-${day}.sqlite`);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await db.backup(tmp);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never written */ }
    reportDbError(channel, err);
    throw err;
  }
  const old = fs.readdirSync(dir).filter(f => /^points-\d{8}\.sqlite$/.test(f)).sort().reverse().slice(BACKUPS_KEPT);
  for (const f of old) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* already gone */ }
  }
  return file;
}
