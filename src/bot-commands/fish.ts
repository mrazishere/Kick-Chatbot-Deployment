/**
 * Fishing
 *
 * Description: Cast a line and see what bites. A points game (see
 *              community/stakes.ts): a cast costs games.fishCost and a catch pays
 *              its value times the cost over 10; the table returns about 92% of
 *              what is staked, so the pond wins slowly.
 *
 * Permission required: all users (1 cast per 30s each, or games.fishCooldownSeconds)
 *
 * Usage:   $don fish   - ($<currency command> fish) where points games are on
 *          !fish       - there, only points to the $ form
 */

import { CommandFn } from '../types';
import { makeCooldown } from '../community/format';
import { gameInvocation, openTable, playRound, weighted } from '../community/stakes';

// Values are for a cast costing 10 and scale with the channel's cost.
// Weights out of 1000. Expected payout per 10 staked: 9.22.
const POND = [
  { weight: 150, catch: '🥾 an old boot', value: 0 },
  { weight: 150, catch: '🌿 a clump of seaweed', value: 0 },
  { weight: 350, catch: '🐟 a small fish', value: 2 },
  { weight: 200, catch: '🐠 a tropical fish', value: 12 },
  { weight: 80, catch: '🐡 a pufferfish', value: 20 },
  { weight: 40, catch: '🦑 a squid', value: 35 },
  { weight: 12, catch: '🐙 an octopus', value: 60 },
  { weight: 15, catch: '🦈 a shark', value: 80 },
  { weight: 3, catch: '🐋 A WHALE', value: 400 }
] as const;

const lastCast = new Map<string, number>();
const pointer = makeCooldown(60_000);

export const fish: CommandFn = async function fish(client, message, channel, tags, _config) {
  const call = gameInvocation(message, channel, 'fish');
  if (!call) return;
  const me = tags.username;
  const say = (text: string) => client.say(channel, text);
  const meLc = me.toLowerCase();
  if (call.form === 'redirect') return void (pointer(meLc) || say(`@${me} it's ${call.usage} here`));

  const hit = weighted(POND);
  const table = await openTable(channel, tags, { bet: true });
  if (table === 'replay') return;
  if (!table) return;
  const now = Date.now();
  if (now - (lastCast.get(meLc) ?? 0) < table.cfg.games.fishCooldownSeconds * 1000) return;
  lastCast.set(meLc, now);
  if (lastCast.size > 5000) for (const [k, v] of lastCast) if (now - v > 3_600_000) lastCast.delete(k);

  const cost = table.cfg.games.fishCost;
  const value = Math.floor(hit.value * cost / 10);
  const have = table.player?.balance ?? 0;
  if (have < cost) return void say(`@${me} a cast costs ${cost} ${table.cur} and you have ${have}`);

  const res = playRound(table, tags, { game: 'fish', stake: cost, payout: value, note: hit.catch.replace(/^\S+ /, '') });
  if (!res.applied) return;
  if (!res.ok) return void say(`@${me} a cast costs ${cost} ${table.cur} and you have ${res.balance}`);
  console.log(`[GAMES] ${me} fished ${hit.catch} (${value}), now ${res.balance}`);
  return void say(value > 0
    ? `@${me} caught ${hit.catch} worth ${value} ${table.cur}, now has ${res.balance}`
    : `@${me} reeled in ${hit.catch}, now has ${res.balance} ${table.cur}`);
};
