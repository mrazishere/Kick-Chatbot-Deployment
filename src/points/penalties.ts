/**
 * Charging a viewer points for being timed out.
 *
 * Kick's `moderation.banned` fires for every ban in the channel — a mod's, the
 * streamer's, and the bot's own — carrying the banned user and, for a timeout,
 * when it expires. The cost is the timeout's length in seconds times a rate, so
 * a two minute timeout at 1/second costs 120.
 *
 * Three things this has to get right:
 *
 *   - Kick re-delivers webhooks and the bot replays its queue after a restart,
 *     so every charge is claimed through store.applyOnce under a key built from
 *     the ban itself. A viewer is charged once per timeout however many times
 *     the event arrives.
 *   - Every timeout counts, whoever issued it: a moderator's, the streamer's,
 *     or the bot's own from a reward. Rewards spend Kick channel points, a
 *     separate currency from these, so a reward timeout is not a double charge.
 *   - A balance is never driven negative. Someone with 40 points who earns a
 *     120 point timeout loses the 40 they have, and the rest is not carried.
 */

import { ModerationBannedEvent } from '../types';
import { PointsDb, reportDbError } from './db';
import { Exclusions, applyOnce, debitTx, ensureUserTx, exclusionsFor, getUser, isExcluded } from './store';
import { BonusContext } from './events';

export interface PenaltyOutcome {
  status: 'charged' | 'skipped' | 'duplicate' | 'failed';
  detail?: string;
  username?: string;
  points?: number;
  balance?: number;
}

/** Seconds a ban lasts, or null when it is permanent or unreadable. */
export function timeoutSeconds(event: ModerationBannedEvent, now: number): number | null {
  const meta = event?.metadata;
  if (!meta || !('expires_at' in meta)) return null;
  if (meta.expires_at === null) return null; // permanent: charged a flat amount instead
  const expiresAt = typeof meta.expires_at === 'string' ? Date.parse(meta.expires_at) : NaN;
  if (!Number.isFinite(expiresAt)) return null;
  // Prefer Kick's own created_at: it dates the ban rather than the moment this
  // process happened to read it, so a replayed or delayed event costs the same.
  const createdAt = typeof meta.created_at === 'string' ? Date.parse(meta.created_at) : NaN;
  const from = Number.isFinite(createdAt) ? createdAt : now;
  const seconds = Math.round((expiresAt - from) / 1000);
  return seconds > 0 ? seconds : null;
}

/**
 * Charge for one ban. Returns what happened so the caller can log it; chat is
 * told here, in one line, only when the charge actually landed.
 */
export function onBan(
  ctx: BonusContext,
  event: ModerationBannedEvent
): PenaltyOutcome {
  const { cfg, broadcasterUserId } = ctx.config();
  const pen = cfg.timeoutPenalty;
  if (!cfg.enabled) return { status: 'skipped', detail: 'points disabled' };
  if (!pen.enabled) return { status: 'skipped', detail: 'timeout penalty off' };

  const victim = event?.banned_user;
  const userId = victim?.user_id;
  if (typeof userId !== 'number' || !Number.isFinite(userId) || userId <= 0) {
    return { status: 'skipped', detail: 'no banned user id' };
  }

  const now = ctx.now();
  const seconds = timeoutSeconds(event, now);
  const permanent = event?.metadata?.expires_at === null;

  let want: number;
  if (permanent) {
    want = Math.floor(pen.permanentBanCost);
  } else if (seconds === null) {
    return { status: 'skipped', detail: 'no readable expiry' };
  } else {
    want = Math.floor(seconds * pen.pointsPerSecond);
  }
  if (pen.maxDeduction > 0) want = Math.min(want, pen.maxDeduction);
  if (want <= 0) return { status: 'skipped', detail: 'nothing to charge' };

  const db = ctx.db();
  // Deliberately not spooled. A penalty replayed hours later, after the viewer
  // has earned points back, punishes them for a timeout nobody remembers; a
  // missed charge is the better failure.
  if (!db) return { status: 'failed', detail: 'database unavailable' };

  // The ban's own timestamp keys the charge, so Kick re-delivering it, or the
  // reconciler seeing it again, cannot charge twice.
  const stamp = event.metadata?.created_at ?? event.metadata?.expires_at ?? String(now);
  const key = `timeout-penalty:${userId}:${stamp}`;

  let res: { applied: boolean; result?: PenaltyOutcome };
  try {
    const ex: Exclusions = exclusionsFor(ctx.channel, cfg, broadcasterUserId);
    res = applyOnce(db, key, now, () => charge(db, now, key, ex, userId, victim.username, want));
  } catch (err) {
    reportDbError(ctx.channel, err);
    console.error(`[POINTS] timeout penalty failed for ${ctx.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'failed', detail: 'database error' };
  }
  if (!res.applied) return { status: 'duplicate', detail: key };

  const out = res.result ?? { status: 'skipped' as const };
  if (out.status === 'charged') {
    console.log(`[POINTS] -${out.points} ${cfg.currencyName} from ${out.username} (timeout ${permanent ? 'permanent' : `${seconds}s`})`);
    if (pen.announce) {
      ctx.announce(`${out.username} lost ${out.points} ${cfg.currencyName} for that timeout — ${out.balance} left`);
    }
  }
  return out;
}

/** Take up to `want`, never more than the viewer has. Runs inside applyOnce. */
function charge(
  db: PointsDb,
  now: number,
  key: string,
  ex: Exclusions,
  userId: number,
  username: string | undefined,
  want: number
): PenaltyOutcome {
  if (isExcluded(ex, userId, username)) return { status: 'skipped', detail: 'excluded from points' };

  // Someone who has never earned has no row and nothing to lose; creating one
  // keeps the ledger honest about the attempt rather than silently dropping it.
  ensureUserTx(db, userId, username ?? null, now);
  const before = getUser(db, userId);
  const balance = before?.balance ?? 0;
  if (balance <= 0) return { status: 'skipped', detail: 'nothing to take', username };

  // Clamped rather than refused: debitTx alone fails outright when the balance
  // is short, which would let the poorest viewers escape the penalty entirely.
  const take = Math.min(want, balance);
  const done = debitTx(db, { userId, amount: take, reason: 'timeout_penalty', ref: key, actor: 'system', now });
  if (!done.ok) return { status: 'failed', detail: 'debit refused', username };
  return { status: 'charged', username: username ?? String(userId), points: take, balance: done.balance };
}
