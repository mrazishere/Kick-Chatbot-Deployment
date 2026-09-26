/**
 * Slots — supibot's `$slots`, on every channel.
 *
 * Description: Rolls three items from the words you give, or from a pattern of
 *              the channel's emotes, and celebrates a flush (all three alike)
 *              with the odds you beat. No stakes. Rules and messages follow
 *              supibot (commands/slots); supibot's winners page is a chat
 *              leaderboard here.
 *
 * Permission required: all users (1 per 5s each)
 *
 * Usage:   !slots a b c ...             - roll from your own words or emotes
 *          !slots pattern:7tv           - the channel's 7TV emotes
 *          !slots pattern:kick          - the channel's own Kick emotes
 *          !slots pattern:gachi         - every emote whose name starts with gachi
 *          !slots pattern:numbers 100   - three numbers from 1 to 100
 *          !slots winners               - the flushes that beat the longest odds (also leader, leaders, leaderboard)
 */

import * as crypto from 'crypto';
import { ChannelConfig, CommandFn } from '../types';
import { isBotSender } from '../bot-identity';
import { makeCooldown } from '../community/format';
import { bestEmote, broadcasterIdFor, channelEmotes, Emote } from '../community/emotes';
import { logSlotsWin, openCommunityDb, topSlotsWins } from '../community/store';

const ROLLED_ITEMS = 3;
const LEADERBOARD_WORDS = ['leader', 'leaders', 'leaderboard', 'winners'];

type PatternResult =
  | { success: true; list: string[] }
  | { success: true; roll: string[]; rolledItems: number }
  | { success: false; reply: string };

const PATTERNS: Record<string, (emotes: Emote[], args: string[]) => PatternResult> = {
  gachi: emotes => ({ success: true, list: [...new Set(emotes.filter(e => /^[gG]achi/.test(e.name)).map(e => e.name))] }),
  '7tv': emotes => ({ success: true, list: emotes.filter(e => e.source === '7tv').map(e => e.name) }),
  kick: emotes => ({ success: true, list: emotes.filter(e => e.source === 'kick').map(e => e.name) }),
  numbers: (_emotes, args) => {
    const target = Number(args[0]);
    if (!Number.isInteger(target)) return { success: false, reply: 'You must provide a proper number to roll the number slots!' };
    if (target < 2 || target > Number.MAX_SAFE_INTEGER) {
      return { success: false, reply: `The number must be an integer in the <2..${Number.MAX_SAFE_INTEGER}> range!` };
    }
    const roll = () => String(Math.floor(Math.random() * target) + 1);
    return { success: true, roll: [roll(), roll(), roll()], rolledItems: target };
  }
};

const cooldown = makeCooldown(5000);

function pick<T>(list: readonly T[]): T {
  return list[crypto.randomInt(0, list.length)];
}

/** Round to `places` decimals, dropping trailing zeros. */
function round(n: number, places: number): number {
  return Number(n.toFixed(places));
}

export const slots: CommandFn = async function slots(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  if (words[0].toLowerCase() !== '!slots') return;
  const me = tags.username;
  const say = (text: string) => client.say(channel, `@${me} ${text}`);
  if (isBotSender(me, tags.senderId)) return;
  if (cooldown(me.toLowerCase())) return;

  const chan = channel.replace(/^#/, '').toLowerCase();
  const bid = broadcasterIdFor(config as ChannelConfig);
  let pattern: string | null = null;
  const args = words.slice(1).filter(w => {
    const m = /^pattern:(\S+)$/i.exec(w);
    if (m) pattern = m[1].toLowerCase();
    return !m;
  });

  if (!args.length && !pattern) return void say('No input provided! You should use a couple of words to roll or use one of existing patterns.');

  if (LEADERBOARD_WORDS.includes((args[0] ?? '').toLowerCase()) && !pattern) {
    const db = openCommunityDb(channel);
    const wins = db ? topSlotsWins(db, 5) : [];
    if (!wins.length) return void say('Nobody has hit a flush here yet.');
    return void say(`Best flushes: ${wins.map((w, i) => `${i + 1} ${w.username} [ ${w.result} ] 1 in ${round(w.odds, 3)}`).join(' · ')}`);
  }

  let rolled: string[];
  let itemAmount: number;
  let source: string;
  if (pattern) {
    const run = PATTERNS[pattern];
    if (!run) return void say('Provided slots preset does not exist!');
    const result = run(await channelEmotes(chan, bid), args);
    if (!result.success) return void say(result.reply);
    if ('list' in result) {
      if (!result.list.length) return void say(`This channel has no emotes for the ${pattern} pattern.`);
      itemAmount = result.list.length;
      source = `pattern:${pattern}`;
      rolled = Array.from({ length: ROLLED_ITEMS }, () => pick(result.list));
    } else {
      rolled = result.roll;
      itemAmount = result.rolledItems;
      source = `Number roll: 1 to ${itemAmount}`;
    }
  } else {
    const unique = [...new Set(args)];
    itemAmount = unique.length;
    source = unique.join(' ');
    rolled = Array.from({ length: ROLLED_ITEMS }, () => pick(unique));
  }

  if (new Set(rolled).size !== 1) return void say(`[ ${rolled.join(' ')} ]`);
  if (itemAmount === 1) {
    const dank = await bestEmote(chan, bid, ['FeelsDankMan', 'FeelsDonkMan'], '🤡');
    return void say(`[ ${rolled.join(' ')} ] ${dank} You won and beat the odds of 100%.`);
  }

  const odds = (1 / itemAmount) ** (ROLLED_ITEMS - 1);
  const oneIn = round(1 / odds, 3);
  try {
    const db = openCommunityDb(channel);
    if (db) logSlotsWin(db, { username: me, source: source.slice(0, 500), result: rolled.join(' '), odds: oneIn, at: Date.now() });
  } catch (err) {
    console.error(`[SLOTS] Could not log ${me}'s flush: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pog = await bestEmote(chan, bid, ['PagChomp', 'Pog', 'PogChamp'], '🎉');
  return void say(`[ ${rolled.join(' ')} ] ${pog} A flush! Congratulations, you beat the odds of ${round(odds * 100, 3)}% (that is 1 in ${oneIn})`);
};
