/**
 * Big bites: while the stream is live and a fishing overlay is showing, now and then
 * a random active chatter gets something big on their line. Chat says so; the
 * reel code appears only on the overlay, so a chat script can't copy it. Codes get
 * harder each pull: two digits, then three characters, then four; from the second
 * pull on they flash for a few seconds and hide while the time runs.
 * The chatter answers with `$<cmd> fish reel <code>` (bot-commands/fish.ts); each
 * right answer brings a new code for the next pull, and the last pull lands a
 * Mythic trophy by its land chance. A wrong code or too slow, and it gets away.
 *
 * Chat gets two lines: the opening mention, so the chatter knows to look, and the
 * result. The pulls in between play on the overlay only, to keep chat quiet.
 *
 * The points service calls tick() every half minute. Bites don't touch anyone's
 * casting or cooldowns: they aren't a cast.
 */

import * as crypto from 'crypto';
import { isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import type { PointsDb } from '../points/db';
import type { FishBigBiteSetting } from '../types';
import { overlayShowing, pushOverlay } from './fish-overlay';

/** A big bite waiting for its reel code. */
export interface Bite {
  username: string;
  userId: number;
  /** The code for the current pull (upper case), and when it was shown and runs out. */
  code: string;
  startedAt: number;
  until: number;
  /** The pull this code is for, 1-based, of `pulls`. */
  pull: number;
  pulls: number;
  timer: NodeJS.Timeout;
}

/**
 * Waiting bites by channel and lowercase name, at most one per channel. Kept in
 * memory: a restart lets one that's waiting get away.
 */
const bites = new Map<string, Bite>();
/** When each channel's next big bite is due, and the everyMinutes that wait was drawn for. */
const dueAt = new Map<string, { at: number; every: number }>();
/** Who got the last one per channel, so the same chatter doesn't get two in a row. */
const lastChatter = new Map<string, string>();

/** The stream runs a few seconds behind chat: an answer this soon can't have come from watching it. */
export const BITE_TOO_FAST_MS = 2_000;
/**
 * The same delay the other way: a viewer sees the overlay's countdown a few seconds
 * late, so an answer still counts this long after a code's time runs out.
 */
export const STREAM_GRACE_MS = 4_000;
/** A wait is `everyMinutes`, give or take up to this: close to the setting, but not to the second. */
export const BITE_JITTER_MS = 2 * 60_000;
/** How often the points service calls tick(). */
export const TICK_MS = 30_000;

const key = (channel: string, name: string) => `${channel}|${name.toLowerCase()}`;

/** The bite waiting for this chatter, if any. */
export function biteFor(channel: string, name: string): Bite | undefined {
  return bites.get(key(channel, name));
}

/** Take a chatter's bite off the line, to settle it. */
export function takeBite(channel: string, name: string): Bite | undefined {
  const k = key(channel, name);
  const bite = bites.get(k);
  if (!bite) return undefined;
  bites.delete(k);
  clearTimeout(bite.timer);
  return bite;
}

export function channelHasBite(channel: string): boolean {
  for (const k of bites.keys()) if (k.startsWith(`${channel}|`)) return true;
  return false;
}

export interface BiteContext {
  channel: string;
  db: PointsDb;
  bigBite: FishBigBiteSetting;
  /** The chat command word, e.g. "don". */
  command: string;
  sendMessage: (message: string) => Promise<unknown>;
  now?: number;
}

/** A big bite lost: the overlay and chat say so (chat's result line). Nothing else changes. */
export function getAway(ctx: BiteContext, name: string, why: string): void {
  console.log(`[FISH] ${name}'s big bite got away in ${ctx.channel}: ${why}`);
  const text = `The big one got away... ${why}`;
  pushOverlay(ctx.db, { username: name, kind: 'miss', text });
  void ctx.sendMessage(`@${name} ${text}`).catch(() => {});
}

/** Characters that can't be mistaken for another on a blurry stream: no 0/O, 1/I/L, 5/S, 8/B, 6/G, Z/2, Q. */
const CLEAR = 'ACDEFHJKMNPRTUVWXY3479';

/** The code for a pull: two digits first, then a character longer each pull (up to 6), from CLEAR. */
export function pullCode(pull: number): string {
  if (pull <= 1) return String(crypto.randomInt(10, 100));
  const len = Math.min(6, pull + 1);
  return Array.from({ length: len }, () => CLEAR[crypto.randomInt(0, CLEAR.length)]).join('');
}

/** Whether an answer matches a code: case and surrounding spaces don't matter. */
export const codeMatches = (answer: string | undefined, code: string): boolean => (answer ?? '').trim().toUpperCase() === code;

/** A fresh code for this pull: armed to get away if it isn't answered in time, and shown only on the overlay. */
function arm(ctx: BiteContext, bite: Bite, windowMs: number, text: string, now: number): void {
  const k = key(ctx.channel, bite.username);
  clearTimeout(bite.timer);
  let code = pullCode(bite.pull);
  while (code === bite.code) code = pullCode(bite.pull); // a new pull always has a new code
  bite.code = code;
  bite.startedAt = now;
  bite.until = now + windowMs;
  bite.timer = setTimeout(() => {
    if (bites.get(k) !== bite || bite.code !== code) return;
    bites.delete(k);
    getAway(ctx, bite.username, bite.pull > 1 ? 'It pulled too hard and swam off!' : 'It was too strong and swam off!');
  }, windowMs + STREAM_GRACE_MS + 500);
  bite.timer.unref?.();
  // From the second pull the code flashes: the overlay hides it flashSeconds after it first
  // draws it (not after now: the overlay only sees it on its next poll), the clock keeps running.
  const flash = bite.pull > 1 && ctx.bigBite.flashSeconds > 0 ? { flashMs: ctx.bigBite.flashSeconds * 1000 } : {};
  pushOverlay(ctx.db, { username: bite.username, kind: 'bite', text, code, until: bite.until, pull: bite.pull, pulls: bite.pulls, ...flash }, now);
}

/** Put a big bite on this chatter's line: chat says so, and only the overlay gets the code. */
export function startBite(ctx: BiteContext, name: string, userId: number): Bite {
  const now = ctx.now ?? Date.now();
  const bite: Bite = { username: name, userId, code: '', startedAt: now, until: now, pull: 1, pulls: ctx.bigBite.pulls, timer: setTimeout(() => {}, 0) };
  bites.set(key(ctx.channel, name), bite);
  // Whoever started it, the wait for the next one begins again.
  dueAt.delete(ctx.channel);
  lastChatter.set(ctx.channel, name.toLowerCase());
  console.log(`[FISH] big bite for ${name} in ${ctx.channel}`);
  const pulls = bite.pulls > 1 ? ` (${bite.pulls} pulls)` : '';
  arm(ctx, bite, ctx.bigBite.windowSeconds * 1000,
    `🎣 Something BIG is tugging at your line! Reel it in with $${ctx.command} fish reel <code> within ${ctx.bigBite.windowSeconds}s!${pulls}`, now);
  // The one chat line: who, and where to look. The code and everything after are on stream.
  void ctx.sendMessage(`@${name} 🎣 Something BIG is on your line! A code is showing on stream now: type $${ctx.command} fish reel and that code within ${ctx.bigBite.windowSeconds}s to reel it in!`).catch(() => {});
  return bite;
}

/** A right answer before the last pull: the fish fights back, and a new code shows. */
export function nextPull(ctx: BiteContext, bite: Bite): void {
  const now = ctx.now ?? Date.now();
  bite.pull++;
  arm(ctx, bite, ctx.bigBite.pullSeconds * 1000,
    `💪 Got it! It's pulling back hard! Quick, the new code flashes on stream: reel again within ${ctx.bigBite.pullSeconds}s! (pull ${bite.pull}/${bite.pulls})`, now);
}

export interface TickContext extends BiteContext {
  live: boolean;
  /** Whether an account is left out of points (the streamer, bots, the ignore list). */
  excluded: (userId: number, name: string) => boolean;
  /** 0 ≤ random() < 1; for tests. */
  random?: () => number;
}

/**
 * Maybe start a big bite. Called every TICK_MS. While the stream is live each wait is
 * `everyMinutes`, give or take up to two minutes (BITE_JITTER_MS), counted from the
 * last bite (or from going live, a restart, or the setting changing). One that comes due with no overlay
 * showing, nobody chatting or another still on a line is held until it can go out.
 * The chatter is picked from those who chatted in the last `activeMinutes`.
 * Returns who got it, or null.
 */
export function tick(ctx: TickContext): string | null {
  const now = ctx.now ?? Date.now();
  const b = ctx.bigBite;
  if (!b.enabled || !ctx.live) {
    dueAt.delete(ctx.channel);
    return null;
  }
  if (channelHasBite(ctx.channel)) return null;
  let due = dueAt.get(ctx.channel);
  if (!due || due.every !== b.everyMinutes) {
    due = { at: now + b.everyMinutes * 60_000 + ((ctx.random ?? Math.random)() * 2 - 1) * BITE_JITTER_MS, every: b.everyMinutes };
    dueAt.set(ctx.channel, due);
  }
  if (now < due.at || !overlayShowing(ctx.db, now)) return null;

  const pick = pickChatter(ctx);
  if (!pick) return null;
  startBite(ctx, pick.username, pick.userId);
  return pick.username;
}

/** Whether this account can get a big bite: not the streamer, a bot, or anyone left out of points. */
export function canBite(ctx: Pick<TickContext, 'channel' | 'excluded'>, userId: number, name: string): boolean {
  const lc = name.toLowerCase();
  return lc !== ctx.channel && !SYSTEM_BOTS.has(lc) && !isBotSender(name) && !ctx.excluded(userId, lc);
}

/**
 * A random chatter from the last `activeMinutes` who can get a big bite, not the
 * one who got the last when there's anyone else. Null when nobody qualifies.
 */
export function pickChatter(ctx: Pick<TickContext, 'channel' | 'db' | 'bigBite' | 'excluded' | 'random' | 'now'>): { username: string; userId: number } | null {
  const now = ctx.now ?? Date.now();
  const random = ctx.random ?? Math.random;
  const rows = ctx.db.prepare('SELECT user_id, username, username_lc FROM users WHERE last_chat_at > ?')
    .all(now - ctx.bigBite.activeMinutes * 60_000) as Array<{ user_id: number; username: string; username_lc: string }>;
  let pool = rows.filter(r => canBite(ctx, r.user_id, r.username));
  if (pool.length > 1) pool = pool.filter(r => r.username_lc !== lastChatter.get(ctx.channel));
  if (!pool.length) return null;
  const pick = pool[Math.floor(random() * pool.length) % pool.length];
  return { username: pick.username, userId: pick.user_id };
}

/** Forget a channel's bites and history; for tests. */
export function resetBites(channel: string): void {
  for (const k of [...bites.keys()]) if (k.startsWith(`${channel}|`)) takeBite(channel, k.slice(channel.length + 1));
  dueAt.delete(channel);
  lastChatter.delete(channel);
}
