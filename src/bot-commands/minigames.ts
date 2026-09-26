/**
 * Mini games
 *
 * Description: Small chance commands with no stakes.
 *
 * Permission required: all users (1 per 5s each)
 *
 * Usage:   !8ball <question>      - the magic 8-ball
 *          !roll                  - 1 to 100
 *          !roll 20 · !roll 5-10  - 1 to 20, or 5 to 10
 *          !roll 2d6              - dice notation, up to 20 dice
 *          !coinflip              - also !cf
 *          !pick a b c            - also takes "a, b, c" or "a or b"
 *          !percent [thing]       - also !%
 */

import * as crypto from 'crypto';
import { CommandFn } from '../types';
import { makeCooldown } from '../community/format';

const EIGHT_BALL = [
  'It is certain', 'It is decidedly so', 'Without a doubt', 'Yes, definitely', 'You may rely on it',
  'As I see it, yes', 'Most likely', 'Outlook good', 'Yes', 'Signs point to yes',
  'Reply hazy, try again', 'Ask again later', 'Better not tell you now', 'Cannot predict now', 'Concentrate and ask again',
  "Don't count on it", 'My reply is no', 'My sources say no', 'Outlook not so good', 'Very doubtful'
];

const cooldown = makeCooldown(5000);

/** Uniform integer in [min, max]. */
function between(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

function roll(arg: string | undefined): string | null {
  if (!arg) return `rolled ${between(1, 100)} (1-100)`;
  const dice = /^(\d{0,2})d(\d{1,4})$/i.exec(arg);
  if (dice) {
    const n = dice[1] ? Number(dice[1]) : 1;
    const sides = Number(dice[2]);
    if (n < 1 || n > 20 || sides < 2) return null;
    const rolls = Array.from({ length: n }, () => between(1, sides));
    const total = rolls.reduce((a, b) => a + b, 0);
    return n === 1 ? `rolled ${total} (d${sides})` : `rolled ${total} (${rolls.join(' ')})`;
  }
  const range = /^(-?\d{1,9})-(-?\d{1,9})$/.exec(arg);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])].sort((a, b) => a - b);
    return lo === hi ? null : `rolled ${between(lo, hi)} (${lo}-${hi})`;
  }
  if (/^\d{1,9}$/.test(arg) && Number(arg) >= 2) return `rolled ${between(1, Number(arg))} (1-${arg})`;
  return null;
}

function pickFrom(rest: string): string[] {
  // "a, b, c" and "a or b" keep multi-word options together; otherwise one word each.
  if (rest.includes(',')) return rest.split(',').map(s => s.trim()).filter(Boolean);
  if (/\s+or\s+/i.test(rest)) return rest.split(/\s+or\s+/i).map(s => s.trim()).filter(Boolean);
  return rest.split(/\s+/).filter(Boolean);
}

export const minigames: CommandFn = async function minigames(client, message, channel, tags, _config) {
  const words = message.trim().split(/\s+/);
  const cmd = words[0].toLowerCase();
  const games = ['!8ball', '!roll', '!dice', '!coinflip', '!cf', '!pick', '!percent', '!%'];
  if (!games.includes(cmd)) return;

  const me = tags.username;
  const say = (text: string) => client.say(channel, text);
  const rest = words.slice(1).join(' ').trim();
  if (cooldown(me.toLowerCase())) return;

  switch (cmd) {
    case '!8ball':
      if (!rest) return void say(`@${me} ask the 8-ball a question`);
      return void say(`@${me} 🎱 ${EIGHT_BALL[between(0, EIGHT_BALL.length - 1)]}`);
    case '!roll':
    case '!dice': {
      const out = roll(words[1]);
      return void say(out ? `@${me} ${out}` : `@${me} usage: !roll · !roll 20 · !roll 5-10 · !roll 2d6`);
    }
    case '!coinflip':
    case '!cf':
      return void say(`@${me} 🪙 ${between(0, 1) ? 'heads' : 'tails'}`);
    case '!pick': {
      const options = pickFrom(rest);
      if (options.length < 2) return void say(`@${me} give me at least two things to pick from`);
      return void say(`@${me} I pick ${options[between(0, options.length - 1)].slice(0, 100)}`);
    }
    default: {
      const n = between(0, 100);
      return void say(rest ? `@${me} ${rest.slice(0, 100)}: ${n}%` : `@${me} ${n}%`);
    }
  }
};
