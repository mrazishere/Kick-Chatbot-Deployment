/**
 * Fortune cookie — supibot's `$cookie`, on every channel.
 *
 * Description: One fortune cookie a day, reset at midnight UTC. A channel
 *              subscriber gets a second, golden one. You can give your daily
 *              cookie to someone who has already eaten theirs, and check how
 *              generous you are. Rules and messages follow supibot
 *              (commands/cookie); no points are involved.
 *
 * Permission required: all users (1 per 10s each)
 *
 * Usage:   !cookie                        - eat today's cookie (also !cookie eat)
 *          !cookie donate @user           - give your daily cookie away (also gift, give)
 *          !cookie stats [@user]          - eaten, gifted and received, with a karma check
 *          !cookie top                    - the biggest cookie eaters here (also leaders, leaderboard)
 */

import * as crypto from 'crypto';
import { CommandFn } from '../types';
import { isBotSender } from '../bot-identity';
import { CommunityDb, getSeen, loadCookieData, openCommunityDb, saveCookieData, topCookieEaters } from '../community/store';
import { makeCooldown, parseUsername, span } from '../community/format';
import { FORTUNES } from '../community/fortunes';

interface CookieData {
  lastTimestamp: { daily: number; received: number };
  today: { donated: number; received: number; eaten: { daily: number; received: number } };
  total: { donated: number; received: number; eaten: { daily: number; received: number } };
}

type CookieType = 'daily' | 'golden' | 'received';
type Result = { success: true } | { success: false; reply: string };

const SUBCOMMANDS: Record<string, 'eat' | 'donate' | 'stats' | 'top'> = {
  eat: 'eat',
  donate: 'donate', gift: 'donate', give: 'donate',
  stats: 'stats', statistics: 'stats',
  top: 'top', leaders: 'top', leaderboard: 'top'
};

const cooldown = makeCooldown(10_000);

function initial(): CookieData {
  return {
    lastTimestamp: { daily: 0, received: 0 },
    today: { donated: 0, received: 0, eaten: { daily: 0, received: 0 } },
    total: { donated: 0, received: 0, eaten: { daily: 0, received: 0 } }
  };
}

function todayUTC(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A viewer's cookie data with yesterday's counters cleared, as supibot reads it. */
function load(db: CommunityDb, usernameLc: string): CookieData {
  const row = loadCookieData(db, usernameLc);
  let data = initial();
  if (row) {
    try {
      const raw = JSON.parse(row.data) as Partial<CookieData>;
      data = {
        lastTimestamp: { ...data.lastTimestamp, ...raw.lastTimestamp },
        today: { ...data.today, ...raw.today, eaten: { ...data.today.eaten, ...raw.today?.eaten } },
        total: { ...data.total, ...raw.total, eaten: { ...data.total.eaten, ...raw.total?.eaten } }
      };
    } catch { /* a damaged row starts over */ }
  }
  if (data.lastTimestamp.daily < todayUTC()) {
    data.lastTimestamp.daily = 0;
    data.today = { donated: 0, received: 0, eaten: { daily: 0, received: 0 } };
  }
  return data;
}

const canEatDaily = (d: CookieData, golden: boolean): boolean =>
  golden ? d.today.eaten.daily + d.today.donated < 2 : d.lastTimestamp.daily !== todayUTC();
const canEatReceived = (d: CookieData): boolean => d.lastTimestamp.received === todayUTC();
const hasExtraAvailable = (d: CookieData, golden: boolean): boolean => golden && d.today.eaten.daily + d.today.donated === 1;

function eat(d: CookieData, golden: boolean): { success: true; type: CookieType } | { success: false; reply: string } {
  if (canEatDaily(d, golden)) {
    d.lastTimestamp.daily = todayUTC();
    // Only the first cookie of the day counts, so the golden one doesn't pad the stats.
    if (d.today.eaten.daily === 0 && d.today.donated === 0) d.total.eaten.daily++;
    d.today.eaten.daily++;
    return { success: true, type: d.today.eaten.daily + d.today.donated >= 2 ? 'golden' : 'daily' };
  }
  if (canEatReceived(d)) {
    d.lastTimestamp.received = 0;
    d.today.eaten.received++;
    d.total.eaten.received++;
    return { success: true, type: 'received' };
  }
  const delta = span(todayUTC() + 86_400_000 - Date.now());
  return {
    success: false,
    reply: crypto.randomInt(1, 101) === 99
      ? `Stop stuffing your face so often! What are you doing, do you want to get fat? Get another cookie in ${delta}.`
      : `You already opened or gifted a fortune cookie today. You can get another one at midnight UTC, which is in ${delta}.`
  };
}

function donate(from: CookieData, to: CookieData, fromGolden: boolean, toGolden: boolean): Result {
  if (canEatReceived(from)) return { success: false, reply: "That cookie was donated to you! Eat it, don't give it away!" };
  if (canEatDaily(from, fromGolden) && hasExtraAvailable(from, fromGolden)) {
    return { success: false, reply: "You have a golden cookie available to you, but you can't gift those away!" };
  }
  if (!canEatDaily(from, fromGolden)) return { success: false, reply: "You already ate or donated your cookie today, so you can't gift it to someone else!" };
  if (canEatDaily(to, toGolden)) {
    return {
      success: false,
      reply: hasExtraAvailable(to, toGolden)
        ? "That user hasn't eaten their golden cookie today, so you would be wasting your donation even more than usual! Get them to eat it!"
        : "That user hasn't eaten their daily cookie today, so you would be wasting your donation! Get them to eat it!"
    };
  }
  if (canEatReceived(to)) return { success: false, reply: "That user hasn't eaten their donated cookie, so you would be wasting your donation! Get them to eat it!" };
  const today = todayUTC();
  from.lastTimestamp.daily = today;
  from.today.donated++;
  from.total.donated++;
  to.lastTimestamp.received = today;
  to.today.received++;
  to.total.received++;
  return { success: true };
}

export const cookie: CommandFn = async function cookie(client, message, channel, tags, _config) {
  const words = message.trim().split(/\s+/);
  if (words[0].toLowerCase() !== '!cookie') return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  const say = (text: string) => client.say(channel, `@${me} ${text}`);
  if (isBotSender(me, tags.senderId)) return;
  if (cooldown(meLc)) return;

  const db = openCommunityDb(channel);
  if (!db) return;

  const word = (words[1] ?? '').toLowerCase();
  const sub = word ? SUBCOMMANDS[word] : 'eat';
  if (!sub) return void say('Unrecognized subcommand! Use one of: eat, donate, stats, top; or just use !cookie with no text behind.');
  const golden = !!tags.badges.subscriber;

  try {
    if (sub === 'eat') {
      const data = load(db, meLc);
      const result = eat(data, golden);
      if (!result.success) return void say(result.reply);
      saveCookieData(db, me, JSON.stringify(data));
      return void say(`Your ${result.type} cookie: ${FORTUNES[crypto.randomInt(0, FORTUNES.length)]}`);
    }

    if (sub === 'donate') {
      if (!words[2]) return void say(`No user provided! Who do you want to ${word} the cookie to?`);
      const receiver = parseUsername(words[2]);
      if (receiver && isBotSender(receiver)) return void say("I appreciate the gesture, but thanks, I don't eat sweets :)");
      const seen = receiver ? getSeen(db, receiver.toLowerCase()) : undefined;
      if (!receiver || !seen) return void say("I haven't seen that user before, so you can't donate cookies to them!");
      const data = load(db, meLc);
      if (receiver.toLowerCase() === meLc) {
        return void say(!canEatDaily(data, golden) && !canEatReceived(data)
          ? "You already ate or donated your daily cookie today, so you can't donate it, not even to yourself!"
          : 'Okay...! So you passed the cookie from one hand to the other... Now what?');
      }
      const theirs = load(db, receiver.toLowerCase());
      const result = donate(data, theirs, golden, seen.is_sub === 1);
      if (!result.success) return void say(result.reply);
      db.transaction(() => {
        saveCookieData(db, me, JSON.stringify(data));
        saveCookieData(db, seen.username, JSON.stringify(theirs));
      })();
      return void say(`Successfully given your cookie for today to ${seen.username} 😊`);
    }

    if (sub === 'stats') {
      const name = words[2] ? parseUsername(words[2]) : me;
      if (words[2] && name && isBotSender(name)) return void say("I don't eat cookies 😐 sugar is bad for my circuits...");
      const lc = (name ?? '').toLowerCase();
      if (!name || (lc !== meLc && !getSeen(db, lc) && !loadCookieData(db, lc))) {
        return void say("I have never seen that user! That means they definitely didn't eat any of my cookies!");
      }
      const [who, target] = lc === meLc ? ['You have', 'you'] : ['That user has', 'them'];
      if (!loadCookieData(db, lc)) return void say(`${who} never eaten, donated or received a single cookie before 🙁`);
      const { total } = load(db, lc);
      const eaten = total.eaten.daily + total.eaten.received;
      const received = total.eaten.received;
      const donated = total.donated;
      if (eaten === 0 && received === 0 && donated === 0) return void say(`${who} never eaten, donated or received a single cookie before 🙁`);
      const eatenString = eaten === 0 ? `${who} never eaten a single cookie.` : `${who} eaten ${eaten} cookies so far.`;
      const donatedString = donated === 0 ? `${who} never given out a single cookie.` : `${who} gifted away ${donated} cookie(s).`;
      const pct = Math.round(donated / (eaten + donated) * 100);
      let reaction: string;
      if (pct <= 0) reaction = `😧 what a scrooge 😒${received > 100 ? ' and a glutton 😠🍔' : ''}`;
      else if (pct < 15) reaction = '🤔 a little frugal 😑';
      else if (pct < 40) reaction = '🙂 a fair person 👍';
      else if (pct < 75) reaction = '😮 a great samaritan 😃👌';
      else reaction = '😳 an absolutely selfless saint 😇';
      return void say(`${eatenString} ${received} were gifted to ${target}. ${donatedString} ${reaction}`);
    }

    // top: supibot links a web leaderboard; this channel's board goes straight to chat.
    const rows = topCookieEaters(db, 5).filter(r => r.eaten > 0);
    if (!rows.length) return void say('Nobody has eaten a cookie here yet.');
    return void say(`Top cookie eaters: ${rows.map((r, i) => `${i + 1} ${r.username} (${r.eaten})`).join(' · ')}`);
  } catch (err) {
    console.error(`[COOKIE] ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
