/**
 * Charging a viewer points for spamming a keyword.
 *
 * The streamer lists keywords (points.antiSpam). Each viewer may send
 * `threshold` messages containing one within `windowMinutes`; every such
 * message past that costs `cost`, until old ones age out of the window.
 *
 *   - Counting is per viewer and in memory. A restart forgets the counts, which
 *     at worst hands everyone their free messages again.
 *   - A keyword matches as a whole word or phrase, whatever its case, and also
 *     as an emote's name: Kick writes emotes into the text as `[emote:<id>:<name>]`.
 *   - A message counts once however many times it repeats the keyword, and once
 *     however many times Kick delivers it: the charge is claimed through
 *     store.applyOnce under the message id.
 *   - A balance is never driven negative, as with the timeout penalty. A viewer
 *     who can't cover the cost loses what they have and is timed out for
 *     `timeoutMinutes` (0 turns that off); chat is told why.
 *   - Chat hears about it as a board, not per message: every ten minutes, the
 *     five viewers who lost the most to spam in those ten minutes (announce).
 *   - The broadcaster and moderators are never counted; neither is anyone
 *     excluded from points (the caller's checks).
 */

import { PointsAntiSpamConfig, TimeoutRequest, TimeoutResult } from '../types';
import { PointsDb, reportDbError, runWrite } from './db';
import { BonusContext } from './events';
import { applyOnce, debitTx, ensureUserTx, getUser } from './store';

/** How often chat gets the board, and how far back it looks. */
export const BOARD_EVERY_MS = 10 * 60_000;
const BOARD_SIZE = 5;
const MAX_TRACKED = 20_000;
const MAX_SEEN_IDS = 5_000;

export interface SpamOutcome {
  status: 'clean' | 'counted' | 'charged' | 'skipped' | 'duplicate' | 'failed';
  detail?: string;
  keyword?: string;
  /** Messages with a keyword from this viewer inside the window, this one included. */
  count?: number;
  points?: number;
  balance?: number;
  /** The viewer couldn't cover the whole cost. */
  short?: boolean;
  /** A timeout was asked for, for this many minutes. */
  timeoutMinutes?: number;
}

/** Times a viewer out; the channel's moderator. Absent, nobody is timed out. */
export type SpamTimeout = (request: TimeoutRequest) => Promise<TimeoutResult>;

let compiled: { source: string; res: Array<{ keyword: string; re: RegExp }> } | null = null;

function matchers(keywords: readonly string[]): Array<{ keyword: string; re: RegExp }> {
  const source = keywords.join('\n');
  if (compiled?.source !== source) {
    compiled = {
      source,
      res: keywords.map(keyword => ({
        keyword,
        re: new RegExp(`(?<![\\p{L}\\p{N}])${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'iu')
      }))
    };
  }
  return compiled.res;
}

/** The first of `keywords` that `message` contains, or null. */
export function spamKeyword(message: string, keywords: readonly string[]): string | null {
  for (const m of matchers(keywords)) if (m.re.test(message)) return m.keyword;
  return null;
}

/** Each viewer's recent keyword messages. */
export class SpamTracker {
  private hits = new Map<number, number[]>();
  private seen = new Set<string>();

  /** False for a message id counted before (Kick delivered it twice). */
  firstSight(messageId: string | undefined): boolean {
    if (!messageId) return true;
    if (this.seen.has(messageId)) return false;
    this.seen.add(messageId);
    if (this.seen.size > MAX_SEEN_IDS) this.seen.delete(this.seen.values().next().value as string);
    return true;
  }

  /** Record a keyword message; returns how many this viewer has inside the window. */
  hit(userId: number, now: number, windowMs: number): number {
    const recent = (this.hits.get(userId) ?? []).filter(at => now - at < windowMs);
    recent.push(now);
    // Delete first so the map's insertion order stays oldest-first for eviction.
    this.hits.delete(userId);
    this.hits.set(userId, recent);
    while (this.hits.size > MAX_TRACKED) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
    return recent.length;
  }
}

export interface SpamMessage {
  userId: number;
  username: string;
  message: string;
  messageId?: string;
}

/**
 * Count one chat message against the keywords and charge it when it is over the line.
 * A viewer without enough to pay is timed out through `timeout` instead (as well as losing what they had).
 */
export function onChat(ctx: BonusContext, tracker: SpamTracker, m: SpamMessage, timeout?: SpamTimeout): SpamOutcome {
  const { cfg } = ctx.config();
  const spam: PointsAntiSpamConfig = cfg.antiSpam;
  if (!cfg.enabled || !spam.enabled || !spam.keywords.length) return { status: 'clean' };
  const keyword = spamKeyword(m.message, spam.keywords);
  if (!keyword) return { status: 'clean' };
  if (!tracker.firstSight(m.messageId)) return { status: 'duplicate', keyword };

  const now = ctx.now();
  const count = tracker.hit(m.userId, now, spam.windowMinutes * 60_000);
  if (count <= spam.threshold) return { status: 'counted', keyword, count };

  const db = ctx.db();
  if (!db) return { status: 'failed', detail: 'database unavailable', keyword, count };
  const key = m.messageId ? `antispam:${m.messageId}` : null;
  let out: SpamOutcome;
  try {
    const charge = () => chargeTx(db, now, key, m, keyword, spam.cost);
    if (key) {
      const res = applyOnce(db, key, now, charge);
      if (!res.applied) return { status: 'duplicate', keyword, count };
      out = res.result ?? { status: 'skipped' };
    } else {
      out = runWrite(db, charge);
    }
  } catch (err) {
    reportDbError(ctx.channel, err);
    console.error(`[POINTS] spam charge failed for ${ctx.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'failed', detail: 'database error', keyword, count };
  }
  out = { ...out, keyword, count };
  if (out.status === 'charged') {
    console.log(`[POINTS] -${out.points} ${cfg.currencyName} from ${m.username} (spam "${keyword}", ${count} in ${spam.windowMinutes}m)`);
  }
  if (out.short && spam.timeoutMinutes > 0 && timeout) {
    out.timeoutMinutes = spam.timeoutMinutes;
    const minutes = spam.timeoutMinutes;
    const cost = `${spam.cost.toLocaleString('en-US')} ${cfg.currencyName}`;
    timeout({ target: m.username, seconds: minutes * 60, invoker: 'spam penalty', reason: `Spam "${keyword}" without ${cost} to pay for it` })
      .then(res => {
        if (!res.ok) return void console.log(`[POINTS] spam timeout of ${m.username} in ${ctx.channel} not issued: ${res.error}`);
        console.log(`[POINTS] ${m.username} timed out ${minutes}m in ${ctx.channel} (spam "${keyword}", can't pay ${cost})`);
        ctx.announce(`@${m.username} can't pay the ${cost} spam tax: timed out for ${minutes} min.`);
      })
      .catch(err => console.error(`[POINTS] spam timeout failed for ${ctx.channel}: ${err instanceof Error ? err.message : String(err)}`));
  }
  return out;
}

/** Take up to `want`, never more than the viewer has. Runs inside a write transaction. */
function chargeTx(db: PointsDb, now: number, key: string | null, m: SpamMessage, keyword: string, want: number): SpamOutcome {
  ensureUserTx(db, m.userId, m.username, now);
  const balance = getUser(db, m.userId)?.balance ?? 0;
  if (balance <= 0) return { status: 'skipped', detail: 'nothing to take', short: true };
  const take = Math.min(want, balance);
  const done = debitTx(db, { userId: m.userId, amount: take, reason: 'spam_penalty', ref: key, actor: 'system', note: keyword, now });
  if (!done.ok) return { status: 'failed', detail: 'debit refused' };
  return { status: 'charged', points: take, balance: done.balance, ...(take < want ? { short: true } : {}) };
}

/**
 * Tell chat who lost the most to spam in the last ten minutes: the top five, from
 * the ledger, so a restart in between loses nothing. Silent when nobody was charged.
 * Returns the line it sent, or null.
 */
export function announceBoard(ctx: BonusContext): string | null {
  const { cfg } = ctx.config();
  if (!cfg.enabled || !cfg.antiSpam.enabled || !cfg.antiSpam.announce) return null;
  const db = ctx.db();
  if (!db) return null;
  const rows = db.prepare(
    `SELECT COALESCE(u.username, CAST(l.user_id AS TEXT)) AS username, -SUM(l.delta) AS lost
       FROM ledger l LEFT JOIN users u ON u.user_id = l.user_id
      WHERE l.reason = 'spam_penalty' AND l.ts > ?
      GROUP BY l.user_id ORDER BY lost DESC, MIN(l.ts) LIMIT ?`
  ).all(ctx.now() - BOARD_EVERY_MS, BOARD_SIZE) as Array<{ username: string; lost: number }>;
  if (!rows.length) return null;
  const line = `Spam tax, last 10 min: ${rows.map((r, i) => `${i + 1}. ${r.username} -${r.lost.toLocaleString('en-US')} ${cfg.currencyName}`).join(', ')}`;
  ctx.announce(line);
  return line;
}
