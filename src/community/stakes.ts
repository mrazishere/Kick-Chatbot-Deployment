/**
 * Playing a game for the channel's loyalty points.
 *
 * fish, slots and cookie are points games: they exist only where the channel
 * has points on and points.games.enabled set, and like everything else that
 * touches the currency they are played as `$<cmd> fish`. Bets also need the
 * stream live when games.onlyWhileLive is set; offline they stay silent, as
 * $<cmd> gamble does. Anywhere else the games aren't available at all.
 *
 * A round is one write transaction (stake off, winnings on) keyed on the Kick
 * message id, so a message the webhook queue replays after a restart can't play
 * twice.
 */

import * as crypto from 'crypto';
import { KickTags } from '../types';
import { effectiveCommand } from '../points/config';
import { SYSTEM_BOTS } from '../system-bots';
import { isBotSender } from '../bot-identity';
import { runWrite } from '../points/db';
import { getPointsService } from '../points/service';
import { applyOnce, creditTx, debitTx, findUserByName, getUser, isApplied, isExcluded, UserRecord } from '../points/store';
import type { PointsDb } from '../points/db';
import type { PointsConfig } from '../types';

/**
 * How a message invokes `game`, or null when it doesn't.
 *
 * - 'currency': `$<cmd> fish` where the channel has its points games on.
 * - 'redirect': `!fish` there; answer with a pointer to the `$` form.
 *
 * Where the games are off there is no form at all. `args` are the words after
 * the game's name; `usage` is how to call it.
 */
export function gameInvocation(
  message: string, channel: string, game: string
): { form: 'currency' | 'redirect'; args: string[]; usage: string } | null {
  const words = message.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  const svc = getPointsService(channel.replace(/^#/, '').toLowerCase());
  const cfg = svc?.config();
  const cmd = cfg && cfg.enabled && cfg.games.enabled ? effectiveCommand(cfg) : null;
  if (!cmd) return null;
  if (first === `$${cmd}` && (words[1] ?? '').toLowerCase() === game) {
    return { form: 'currency', args: words.slice(2), usage: `$${cmd} ${game}` };
  }
  return first === `!${game}` ? { form: 'redirect', args: words.slice(1), usage: `$${cmd} ${game}` } : null;
}

export interface Table {
  db: PointsDb;
  cfg: PointsConfig;
  /** The player's row as of now. Absent when they have never earned anything. */
  player: UserRecord | undefined;
  cur: string;
}

/**
 * The points table this viewer can play at, or null when they can't play now
 * (offline, excluded, database down), or 'replay' when this message already
 * played. Either way the game stays silent; the reason is logged.
 */
export async function openTable(channel: string, tags: KickTags, opts: { bet: boolean }): Promise<Table | null | 'replay'> {
  const name = channel.replace(/^#/, '').toLowerCase();
  const me = tags.username;
  const why = (reason: string) => { console.log(`[GAMES] ${me} can't play in ${name}: ${reason}`); return null; };

  const svc = getPointsService(name);
  if (!svc) return null;
  const cfg = svc.config();
  if (!cfg.enabled) return null;
  if (!cfg.games.enabled) return why('points games are off');
  if (SYSTEM_BOTS.has(me.toLowerCase()) || isBotSender(me, tags.senderId)) return why('bot');

  svc.flushPresence();
  const db = svc.db();
  if (!db) return why('database unavailable');
  if (tags.messageId && isApplied(db, `chat:${tags.messageId}`)) {
    console.log(`[GAMES] ${me}'s message was already handled in ${name}`);
    return 'replay';
  }

  const senderId = Number(tags.senderId);
  const lookup = () => Number.isInteger(senderId) && senderId > 0 ? getUser(db, senderId) : findUserByName(db, me.toLowerCase());
  if (isExcluded(svc.exclusions(), lookup()?.user_id ?? null, me.toLowerCase())) return why('excluded');

  if (opts.bet && cfg.games.onlyWhileLive) {
    const live = await svc.isLiveNow();
    if (live !== true) return why(live === null ? 'live state unknown' : 'offline');
  }
  // Read after the await: a tick or another bet may have changed the balance.
  return { db, cfg, player: lookup(), cur: cfg.currencyName };
}

/**
 * Take `stake` and pay `payout` as one round. `ok` is false when the balance no
 * longer covers the stake; `applied` is false when this message already played.
 */
export function playRound(
  t: Table,
  tags: KickTags,
  a: { game: string; stake: number; payout: number; note?: string }
): { applied: boolean; ok: boolean; balance: number } {
  const player = t.player;
  if (!player) return { applied: true, ok: false, balance: 0 };
  const ref = `${a.game}:${crypto.randomUUID()}`;
  const actor = `chat:${tags.username}`;
  const round = () => runWrite(t.db, () => {
    const now = Date.now();
    const stake = debitTx(t.db, { userId: player.user_id, amount: a.stake, reason: `game:${a.game}`, ref, actor, note: a.note ?? null, now });
    if (!stake.ok) return { ok: false, balance: stake.balance };
    if (a.payout <= 0) return { ok: true, balance: stake.balance };
    const balance = creditTx(t.db, { userId: player.user_id, amount: a.payout, reason: `game:${a.game}_win`, ref, actor, note: a.note ?? null, now });
    return { ok: true, balance };
  });
  const run = tags.messageId ? applyOnce(t.db, `chat:${tags.messageId}`, Date.now(), round) : { applied: true, result: round() };
  if (!run.applied) return { applied: false, ok: false, balance: player.balance };
  return { applied: true, ...run.result! };
}

/** Mint a bonus that isn't a bet, e.g. the daily cookie. Keyed on the message like a round. */
export function grant(t: Table, tags: KickTags, a: { reason: string; amount: number; note?: string }): { applied: boolean; balance: number } | null {
  const senderId = Number(tags.senderId);
  const userId = t.player?.user_id ?? (Number.isInteger(senderId) && senderId > 0 ? senderId : null);
  // A viewer the points table has never seen and whose id Kick didn't send can't be credited.
  if (userId === null) return null;
  const pay = () => runWrite(t.db, () => creditTx(t.db, {
    userId, username: tags.username, amount: a.amount, reason: a.reason, actor: `chat:${tags.username}`, note: a.note ?? null, now: Date.now()
  }));
  const run = tags.messageId ? applyOnce(t.db, `chat:${tags.messageId}`, Date.now(), pay) : { applied: true, result: pay() };
  return run.applied ? { applied: true, balance: run.result! } : { applied: false, balance: t.player?.balance ?? 0 };
}

/** Pick from a weighted table with a CSPRNG. */
export function weighted<T extends { weight: number }>(items: readonly T[]): T {
  const total = items.reduce((s, i) => s + i.weight, 0);
  let r = crypto.randomInt(0, total);
  for (const i of items) {
    if (r < i.weight) return i;
    r -= i.weight;
  }
  return items[items.length - 1];
}
