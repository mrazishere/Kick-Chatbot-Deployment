/**
 * Fortune cookie
 *
 * Description: One fortune cookie per viewer per day (the day turns at midnight
 *              UTC). Where the channel plays games for points, each cookie also
 *              holds a bonus between games.cookieMin and games.cookieMax. It
 *              isn't a bet, so it pays online or off.
 *
 * Permission required: all users (once a day each)
 *
 * Usage:   $don cookie   - where the channel plays games for points
 *          !cookie       - elsewhere; where points apply it points to the $ form
 */

import * as crypto from 'crypto';
import { CommandFn } from '../types';
import { claimCookie, openCommunityDb, unclaimCookie } from '../community/store';
import { isoDay, makeCooldown } from '../community/format';
import { gameInvocation, grant, openTable } from '../community/stakes';

const FORTUNES = [
  'A pleasant surprise is waiting for you.',
  'Your hard work is about to pay off.',
  'Now is a good time to try something new.',
  'Someone in this chat is thinking about you.',
  'You will soon be the main character.',
  'The best time to touch grass was yesterday. The next best is today.',
  'A small act of kindness will come back to you.',
  'Do not trust the next person who says trust me.',
  'Your luck changes when you stop checking it.',
  'An old friend will reach out soon.',
  'Good things come to those who lurk.',
  'You will laugh until it hurts this week.',
  'The answer you seek is in the VOD.',
  'Fortune favours the bold, not the all-in.',
  'You are one decision away from a better day.',
  'Beware of free Kicks from strangers.',
  'Today is a good day to say thank you.',
  'You will make someone smile without trying.',
  'A new adventure starts with a single message.',
  'The chat believes in you, mostly.',
  'Rest is productive too.',
  'Your next idea is better than your last.',
  'Patience now, rewards later.',
  'What you give away comes back doubled.',
  'You already know what to do.',
  'Hydrate. The cookie insists.',
  'Your streak of bad luck ends today.',
  'Something you lost will turn up.',
  'Someone admires your chat game.',
  'Big plans need small first steps.'
];

const cooldown = makeCooldown(5000);
const pointer = makeCooldown(60_000);

export const cookie: CommandFn = async function cookie(client, message, channel, tags, _config) {
  const call = gameInvocation(message, channel, 'cookie');
  if (!call) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  const say = (text: string) => client.say(channel, text);
  if (call.form === 'redirect') return void (pointer(meLc) || say(`@${me} it's ${call.usage} here`));
  if (cooldown(meLc)) return;

  const db = openCommunityDb(channel);
  if (!db) return;
  if (!claimCookie(db, meLc, isoDay(Date.now()))) return void say(`@${me} you've had today's cookie, come back after midnight UTC`);

  const fortune = FORTUNES[crypto.randomInt(0, FORTUNES.length)];
  try {
    const table = await openTable(channel, tags, { bet: false });
    if (table === 'replay') return;
    if (!table || table.cfg.games.cookieMax <= 0) return void say(`@${me} 🥠 ${fortune}`);
    const { cookieMin, cookieMax } = table.cfg.games;
    const bonus = crypto.randomInt(cookieMin, cookieMax + 1);
    if (bonus <= 0) return void say(`@${me} 🥠 ${fortune}`);
    const res = grant(table, tags, { reason: 'cookie', amount: bonus, note: 'daily cookie' });
    if (!res) return void say(`@${me} 🥠 ${fortune}`);
    if (!res.applied) return;
    console.log(`[GAMES] ${me} opened a cookie worth ${bonus}, now ${res.balance}`);
    return void say(`@${me} 🥠 ${fortune} (+${bonus} ${table.cur})`);
  } catch (err) {
    // Hand the cookie back so a database hiccup doesn't cost them the day.
    unclaimCookie(db, meLc);
    console.error(`[GAMES] Cookie for ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
    return void say(`@${me} the cookie crumbled, try again in a bit`);
  }
};
