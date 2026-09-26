/**
 * Slots
 *
 * Description: Three reels of six symbols. Two alike pays 1.5x the bet, three
 *              alike 8x, three diamonds 25x: about 93% returned over time. Bets
 *              follow the points `games` settings (see community/stakes.ts);
 *              without a bet, or where betting isn't possible, the reels spin
 *              for fun.
 *
 * Permission required: all users (1 free spin per 10s each; bets per games.slotsCooldownSeconds)
 *
 * Usage:   $don slots 100|5k|50%|all  - where the channel plays games for points
 *          !slots                     - elsewhere, a spin for fun; where points apply
 *                                       it points to the $ form
 */

import * as crypto from 'crypto';
import { CommandFn } from '../types';
import { makeCooldown } from '../community/format';
import { gameInvocation, openTable, playRound } from '../community/stakes';
import { parseBet } from './points';

const REELS = ['🍒', '🍋', '🍇', '🔔', '⭐', '💎'];

const spinCooldown = makeCooldown(10_000);
const lastBet = new Map<string, number>();
const pointer = makeCooldown(60_000);

function spin(): { reels: string[]; multiplier: number } {
  const reels = [0, 1, 2].map(() => REELS[crypto.randomInt(0, REELS.length)]);
  const [a, b, c] = reels;
  if (a === b && b === c) return { reels, multiplier: a === '💎' ? 25 : 8 };
  if (a === b || b === c || a === c) return { reels, multiplier: 1.5 };
  return { reels, multiplier: 0 };
}

export const slots: CommandFn = async function slots(client, message, channel, tags, _config) {
  const call = gameInvocation(message, channel, 'slots');
  if (!call) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  const say = (text: string) => client.say(channel, text);
  if (call.form === 'redirect') return void (pointer(meLc) || say(`@${me} it's ${call.usage} amount here`));
  const raw = call.args[0];

  // !slots is always a free spin: it only exists where games don't use points.
  if (call.form === 'bang') {
    if (spinCooldown(meLc)) return;
    const s = spin();
    return void say(`@${me} ${s.reels.join(' ')} ${s.multiplier >= 8 ? 'JACKPOT' : s.multiplier > 0 ? 'so close' : 'nothing'}`);
  }
  if (raw === undefined) return void say(`@${me} usage: ${call.usage} amount`);

  const table = await openTable(channel, tags, { bet: true });
  if (table === 'replay') return;
  if (!table) {
    if (spinCooldown(meLc)) return;
    const s = spin();
    return void say(`@${me} ${s.reels.join(' ')} (just for fun, no bets right now)`);
  }

  const g = table.cfg.games;
  const have = table.player?.balance ?? 0;
  if (have <= 0) return void say(`@${me} you have no ${table.cur} to bet`);
  const bet = parseBet(raw, have);
  if (bet === null) return void say(`@${me} usage: ${call.usage} amount`);
  if (bet < g.slotsMinBet) return void say(`@${me} the minimum is ${g.slotsMinBet}`);
  if (g.slotsMaxBet > 0 && bet > g.slotsMaxBet) return void say(`@${me} the maximum is ${g.slotsMaxBet}`);
  if (bet > have) return void say(`@${me} you only have ${have} ${table.cur}`);
  const now = Date.now();
  const wait = Math.ceil((g.slotsCooldownSeconds * 1000 - (now - (lastBet.get(meLc) ?? 0))) / 1000);
  if (wait > 0) return void say(`@${me} wait ${wait}s before betting again`);
  lastBet.set(meLc, now);
  if (lastBet.size > 5000) for (const [k, v] of lastBet) if (now - v > 3_600_000) lastBet.delete(k);

  const s = spin();
  const payout = Math.floor(bet * s.multiplier);
  const res = playRound(table, tags, { game: 'slots', stake: bet, payout, note: s.reels.join('') });
  if (!res.applied) return;
  if (!res.ok) return void say(`@${me} you only have ${res.balance} ${table.cur}`);
  console.log(`[GAMES] ${me} bet ${bet} on slots: ${s.reels.join('')} x${s.multiplier}, now ${res.balance}`);
  const reels = s.reels.join(' ');
  if (s.multiplier >= 8) return void say(`@${me} ${reels} JACKPOT won ${payout} ${table.cur}, now has ${res.balance}`);
  if (s.multiplier > 0) return void say(`@${me} ${reels} two alike, got ${payout} back, now has ${res.balance} ${table.cur}`);
  return void say(`@${me} ${reels} lost ${bet} ${table.cur}, now has ${res.balance}`);
};
