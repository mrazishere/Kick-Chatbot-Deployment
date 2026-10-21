/**
 * Big bites: while the stream is live and a fishing overlay is showing, now and then
 * a random active chatter gets something big on their line. Chat says so; the
 * reel code appears only on the overlay, so a chat script can't copy it. Codes get
 * harder each pull: two digits, then three characters, then four; from the second
 * pull on they flash for a few seconds and hide while the time runs.
 * The chatter answers with `$<cmd> fish reel <code>` (bot-commands/fish.ts), and from
 * the second pull the code by itself counts too (an exact match only); each
 * right answer brings a new code for the next pull, and the last pull lands a
 * Mythic trophy by its land chance. A wrong code or too slow, and it gets away.
 *
 * Sniping: for about the last `snipeSeconds` of the first code (give or take up to
 * SNIPE_JITTER_MS, drawn per bite), anyone else chatting can take it with the snipe code:
 * two digits of its own, said only in the SNIPE OPEN chat line, so nobody can type it in
 * advance off the overlay. The first right answer takes the bite off the chatter it was
 * for and carries on from the next pull as theirs. Each sniper gets one try per bite.
 *
 * Chat gets two lines: the opening mention, so the chatter knows to look, and the
 * result; a snipe adds one between. The pulls play on the overlay only, to keep chat quiet.
 *
 * The points service calls tick() every half minute. Bites don't touch anyone's
 * casting or cooldowns: they aren't a cast.
 */

import * as crypto from 'crypto';
import { isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import type { PointsDb } from '../points/db';
import type { FishBigBiteSetting } from '../types';
import { overlayHealth, overlayShowing, pushOverlay, requestOverlayReload } from './fish-overlay';
import { wheelBusy } from './wheel-state';

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
  /**
   * When the first code opens to everyone else (ms); absent when sniping is off or the
   * first pull is over. Planned at first; at that time chat is told, and it becomes the
   * moment Kick has posted that line (SNIPE_PENDING while it's being posted).
   */
  snipeAt?: number;
  /**
   * The code snipers answer with: two digits, never the overlay's, said only in the SNIPE
   * OPEN line. Set when that line goes out. Snipers with a pre-typed overlay code always
   * won, the same fast few every time (asked for 2026-10-18).
   */
  snipeCode?: string;
  /** Who has used their one snipe try on this bite, lowercase. */
  tried: Set<string>;
  timer: NodeJS.Timeout;
  /** A reward bite (a sub, gifted subs, Kicks): theirs alone, never open to snipers, and it always lands once every code is right. */
  reward?: boolean;
}

/**
 * Waiting bites by channel and lowercase name, at most one per channel. Kept in
 * memory: a restart lets one that's waiting get away.
 */
const bites = new Map<string, Bite>();
/** When each channel's next big bite is due, and the everyMinutes that wait was drawn for. */
const dueAt = new Map<string, { at: number; every: number }>();

/**
 * The due time is also kept in the channel's points db while live, so a restart (a deploy
 * mid-stream) carries on with the same wait instead of starting it over: three restarts
 * in an hour once meant no bite for 50 minutes on a 20-minute timer.
 */
const DUE_KEY = 'big_bite_due';
function storedDue(db: PointsDb): { at: number; every: number } | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(DUE_KEY) as { value: string } | undefined;
    const v = row ? JSON.parse(row.value) as { at?: unknown; every?: unknown } : null;
    return v && typeof v.at === 'number' && typeof v.every === 'number' ? { at: v.at, every: v.every } : null;
  } catch {
    return null;
  }
}
function storeDue(db: PointsDb, due: { at: number; every: number } | null): void {
  try {
    if (due) db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(DUE_KEY, JSON.stringify(due));
    else db.prepare('DELETE FROM meta WHERE key = ?').run(DUE_KEY);
  } catch (err) {
    console.error(`[FISH] Saving the next big bite's time failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
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

/** The bite waiting in this channel, whoever it's for. */
export function channelBite(channel: string): Bite | undefined {
  for (const [k, bite] of bites) if (k.startsWith(`${channel}|`)) return bite;
  return undefined;
}

export const channelHasBite = (channel: string): boolean => !!channelBite(channel);

/**
 * How long before the first code runs out it opens to snipers: `snipeSeconds`, but
 * never more than half the window, so the chatter it's for always has it alone first. 0 is off.
 */
export const snipeWindowMs = (b: FishBigBiteSetting): number => Math.min(b.snipeSeconds, Math.floor(b.windowSeconds / 2)) * 1000;

/**
 * How far a bite's snipe window may run from snipeSeconds, either way. With it fixed,
 * snipers learned the moment it opened (the countdown showed it) and fired a pre-typed
 * code on the dot: 139 of 183 bites from 2026-10-11 to 10-14 were sniped, most within
 * two seconds of opening. The owner asked for ±3s around the dashboard's value.
 */
export const SNIPE_JITTER_MS = 3_000;

/**
 * This bite's snipe window: snipeWindowMs moved by a random amount within
 * SNIPE_JITTER_MS, never under a second or over half the window. 0 stays off.
 */
export function drawSnipeMs(b: FishBigBiteSetting): number {
  const base = snipeWindowMs(b);
  if (base <= 0) return 0;
  const jittered = base + crypto.randomInt(-SNIPE_JITTER_MS, SNIPE_JITTER_MS + 1);
  return Math.max(1000, Math.min(Math.floor(b.windowSeconds / 2) * 1000, jittered));
}

/** Whether this bite's first code is open to everyone else right now. */
export const snipeOpen = (bite: Bite, now: number): boolean => bite.pull === 1 && bite.snipeAt !== undefined && bite.snipeCode !== undefined && now >= bite.snipeAt && now <= bite.until + STREAM_GRACE_MS;

/**
 * A sniper answered the first code right, before the chatter it was for: the bite is
 * theirs now, at the same pull, for the caller to carry on with. Chat says who took it.
 */
export function snipeBite(ctx: BiteContext, bite: Bite, name: string, userId: number): void {
  const from = bite.username;
  bites.delete(key(ctx.channel, from));
  clearTimeout(bite.timer);
  bite.username = name;
  bite.userId = userId;
  delete bite.snipeAt;
  delete bite.snipeCode;
  bites.set(key(ctx.channel, name), bite);
  console.log(`[FISH] ${name} sniped ${from}'s big bite in ${ctx.channel}`);
  pushOverlay(ctx.db, { username: from, kind: 'miss', text: `🪝 ${name} sniped your big bite!` });
  void ctx.sendMessage(`@${from} too slow! 🪝 @${name} sniped your big bite and is reeling it in!`).catch(() => {});
}

export interface BiteContext {
  channel: string;
  db: PointsDb;
  bigBite: FishBigBiteSetting;
  /** The chat command word, e.g. "don". */
  command: string;
  sendMessage: (message: string) => Promise<unknown>;
  now?: number;
  /** games.streamDelaySeconds, in ms: a code's time starts once viewers can see it. */
  delayMs?: number;
}

/** snipeAt while the "SNIPE OPEN" line is being posted: answers then are too early, nobody can have seen it. */
export const SNIPE_PENDING = Number.MAX_SAFE_INTEGER;

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

/**
 * Time's up for the chatter alone: chat posts the SNIPE OPEN line with a snipe code of its
 * own, and snipes open once Kick has it. Nothing if the bite was settled, sniped or moved
 * on first. Exported for the self-test, which can't wait for the timer.
 */
export function openSnipes(ctx: BiteContext, bite: Bite): void {
  const k = key(ctx.channel, bite.username);
  const code = bite.code;
  const still = () => bites.get(k) === bite && bite.code === code && bite.pull === 1 && bite.snipeAt !== undefined;
  if (!still()) return;
  bite.snipeAt = SNIPE_PENDING;
  let snipeCode = pullCode(1);
  while (snipeCode === code) snipeCode = pullCode(1);
  bite.snipeCode = snipeCode;
  const open = () => {
    if (!still()) return;
    bite.snipeAt = Date.now();
    console.log(`[FISH] snipes open on ${bite.username}'s big bite in ${ctx.channel}`);
  };
  ctx.sendMessage(`🪝 SNIPE OPEN! @${bite.username}'s big bite is up for grabs: first to type $${ctx.command} fish reel ${snipeCode} takes it!`).then(open, open);
}

/** A fresh code for this pull: armed to get away if it isn't answered in time, and shown only on the overlay. */
function arm(ctx: BiteContext, bite: Bite, windowMs: number, text: string, now: number): void {
  const k = key(ctx.channel, bite.username);
  clearTimeout(bite.timer);
  let code = pullCode(bite.pull);
  while (code === bite.code) code = pullCode(bite.pull); // a new pull always has a new code
  bite.code = code;
  bite.startedAt = now;
  // The stream shows the code this much later, so its time runs from then.
  const delayMs = ctx.delayMs ?? 0;
  bite.until = now + delayMs + windowMs;
  const snipeMs = bite.pull === 1 && !bite.reward ? drawSnipeMs(ctx.bigBite) : 0;
  if (snipeMs > 0) bite.snipeAt = bite.until - snipeMs;
  else delete bite.snipeAt;
  delete bite.snipeCode;
  // Chat is the one signal that snipes are open: it has no stream delay, so everyone sees it
  // at once however far behind their stream runs. Snipes open once Kick has posted the line
  // (about a second after asking); an answer before that can't have come from seeing it.
  // Nothing if the bite was settled, sniped or moved on first.
  if (bite.snipeAt !== undefined) {
    const t = setTimeout(() => openSnipes(ctx, bite), Math.max(0, bite.snipeAt - Date.now()));
    t.unref?.();
  }
  bite.timer = setTimeout(() => {
    if (bites.get(k) !== bite || bite.code !== code) return;
    bites.delete(k);
    getAway(ctx, bite.username, bite.pull > 1 ? 'It pulled too hard and swam off!' : 'It was too strong and swam off!');
  }, delayMs + windowMs + STREAM_GRACE_MS + 500);
  bite.timer.unref?.();
  // From the second pull the code flashes: the overlay hides it flashSeconds after it first
  // draws it (not after now: the overlay only sees it on its next poll), the clock keeps running.
  const flash = bite.pull > 1 && ctx.bigBite.flashSeconds > 0 ? { flashMs: ctx.bigBite.flashSeconds * 1000 } : {};
  // The overlay gets no snipe time: its "Anyone can snipe!" would reach viewers with a short
  // stream delay before the chat line, and chat is the signal.
  const snipe = {};
  const id = pushOverlay(ctx.db, { username: bite.username, kind: 'bite', text, code, until: bite.until, pull: bite.pull, pulls: bite.pulls, ...flash, ...snipe }, now);
  if (id !== null) {
    const t = setTimeout(() => checkCodeDrawn(ctx, id), DRAW_WAIT_MS);
    t.unref?.();
  }
}

/** How long a page has to draw a code before the bot reloads it: a poll or two and a frame. */
const DRAW_WAIT_MS = 8_000;

/**
 * A code the overlay still hasn't drawn DRAW_WAIT_MS on (by its own report, so only pages
 * from 2026-10-21 on): the browser source is stuck, so every open overlay is told to reload.
 * The reload picks the feed up where it was, code included.
 */
function checkCodeDrawn(ctx: BiteContext, id: number): void {
  const health = overlayHealth(ctx.db);
  if (!health || health.painted >= id) return;
  if (requestOverlayReload(ctx.db, true)) console.log(`[FISH] overlay in ${ctx.channel} hadn't drawn big bite code #${id} after ${DRAW_WAIT_MS / 1000}s: told it to reload`);
}

/** Put a big bite on this chatter's line: chat says so, and only the overlay gets the code. */
export function startBite(ctx: BiteContext, name: string, userId: number, reward?: string): Bite {
  const now = ctx.now ?? Date.now();
  const bite: Bite = { username: name, userId, code: '', startedAt: now, until: now, pull: 1, pulls: ctx.bigBite.pulls, tried: new Set(), timer: setTimeout(() => {}, 0), ...(reward ? { reward: true } : {}) };
  bites.set(key(ctx.channel, name), bite);
  // Whoever started it, the wait for the next one begins again; a reward bite is extra and leaves it be.
  if (!reward) {
    dueAt.delete(ctx.channel);
    storeDue(ctx.db, null);
    lastChatter.set(ctx.channel, name.toLowerCase());
  }
  console.log(`[FISH] big bite for ${name} in ${ctx.channel}${reward ? ` (${reward})` : ''}`);
  const pulls = bite.pulls > 1 ? ` (${bite.pulls} pulls)` : '';
  arm(ctx, bite, ctx.bigBite.windowSeconds * 1000,
    `🎣 Something BIG is tugging at your line! Reel it in with $${ctx.command} fish reel <code> within ${ctx.bigBite.windowSeconds}s!${pulls}`, now);
  // The one chat line: who, and where to look. The code and everything after are on stream.
  const snipeS = reward ? 0 : snipeWindowMs(ctx.bigBite) / 1000;
  const snipers = snipeS > 0 ? ` For about the last ${snipeS}s anyone can snipe it: I'll post a snipe code in chat, and the first to type it takes it!` : reward ? ' Nobody can snipe this one, and get every code right and it\'s guaranteed to land!' : '';
  void ctx.sendMessage(`@${name} 🎣 ${reward ? `Thanks for ${reward}! 🎁 ` : ''}Something BIG is on your line! A code is showing on stream now: type $${ctx.command} fish reel and that code within ${ctx.bigBite.windowSeconds}s to reel it in!${snipers}`).catch(() => {});
  return bite;
}

/** A right answer before the last pull: the fish fights back, and a new code shows. */
export function nextPull(ctx: BiteContext, bite: Bite): void {
  const now = ctx.now ?? Date.now();
  bite.pull++;
  arm(ctx, bite, ctx.bigBite.pullSeconds * 1000,
    `💪 Got it! It's pulling back hard! Quick, a new code flashes on stream: type just the code within ${ctx.bigBite.pullSeconds}s! (pull ${bite.pull}/${bite.pulls})`, now);
}

export interface TickContext extends BiteContext {
  live: boolean;
  /** Whether an account is left out of points (the streamer, bots, the ignore list). */
  excluded: (userId: number, name: string) => boolean;
  /** 0 ≤ random() < 1; for tests. */
  random?: () => number;
}

// ─── Reward bites ────────────────────────────────────────────────────────────

/** A reward bite waits at most this long for the overlay and any bite on a line. */
export const REWARD_WAIT_MS = 15 * 60_000;
/** A sub's bite waits this long first: a gifted sub's recipient also gets a sub event, and only the gifter earns one. */
export const SUB_HOLD_MS = 15_000;
/** The most reward bites waiting per channel; past it the oldest go. */
const REWARD_QUEUE_MAX = 20;
interface RewardBite { name: string; userId: number; why: string; at: number; notBefore: number }
const rewardQueue = new Map<string, RewardBite[]>();
/** Events already turned into a reward bite, so a redelivered one doesn't make a second. */
const rewardSeen = new Map<string, number>();

/**
 * Queue a reward bite for a viewer (community/big-bite.ts tick starts it): `eventKey`
 * names the event, so the same one delivered twice queues once. Returns whether it queued.
 */
export function queueRewardBite(channel: string, who: { name: string; userId: number }, why: string, eventKey: string, now = Date.now(), holdMs = 0): boolean {
  for (const [k, at] of rewardSeen) if (now - at > REWARD_WAIT_MS * 4) rewardSeen.delete(k);
  const seen = `${channel}|${eventKey}`;
  if (rewardSeen.has(seen)) return false;
  rewardSeen.set(seen, now);
  const q = rewardQueue.get(channel) ?? [];
  q.push({ name: who.name, userId: who.userId, why, at: now, notBefore: now + holdMs });
  while (q.length > REWARD_QUEUE_MAX) q.shift();
  rewardQueue.set(channel, q);
  console.log(`[FISH] reward big bite queued for ${who.name} in ${channel} (${why})`);
  return true;
}

/** Drop the waiting sub bites of these viewers: their sub was a gift, and the gifter earns the bite. */
export function dropRewardBites(channel: string, userIds: number[]): void {
  const q = rewardQueue.get(channel);
  if (!q) return;
  const ids = new Set(userIds);
  rewardQueue.set(channel, q.filter(r => !(ids.has(r.userId) && r.why === 'the sub')));
}

/** Reward bites waiting, for tests. */
export const rewardBitesWaiting = (channel: string): number => rewardQueue.get(channel)?.length ?? 0;

/**
 * Maybe start a big bite. Called every TICK_MS. While the stream is live each wait is
 * `everyMinutes`, give or take up to two minutes (BITE_JITTER_MS), counted from the
 * last bite (or from going live, or the setting changing; a restart keeps the wait). One that comes due with no overlay
 * showing, nobody chatting or another still on a line is held until it can go out.
 * The chatter is picked from those who chatted in the last `activeMinutes`.
 * Returns who got it, or null.
 */
export function tick(ctx: TickContext): string | null {
  const now = ctx.now ?? Date.now();
  const b = ctx.bigBite;
  if (!b.enabled || !ctx.live) {
    if (dueAt.delete(ctx.channel) || storedDue(ctx.db)) storeDue(ctx.db, null);
    rewardQueue.delete(ctx.channel);
    return null;
  }
  // Nor while the prize wheel is on the overlay: its code would show behind the wheel.
  if (channelHasBite(ctx.channel) || wheelBusy(ctx.channel, now)) return null;
  // Reward bites first, oldest first: they don't wait for the timer.
  const q = (rewardQueue.get(ctx.channel) ?? []).filter(r => now - r.at <= REWARD_WAIT_MS);
  rewardQueue.set(ctx.channel, q);
  const ready = q.findIndex(r => r.notBefore <= now);
  if (ready >= 0 && overlayShowing(ctx.db, now)) {
    const [r] = q.splice(ready, 1);
    startBite(ctx, r.name, r.userId, r.why);
    return r.name;
  }
  // After a restart, the wait from before it.
  let due = dueAt.get(ctx.channel) ?? storedDue(ctx.db) ?? undefined;
  if (!due || due.every !== b.everyMinutes) {
    due = { at: now + b.everyMinutes * 60_000 + ((ctx.random ?? Math.random)() * 2 - 1) * BITE_JITTER_MS, every: b.everyMinutes };
    storeDue(ctx.db, due);
  }
  dueAt.set(ctx.channel, due);
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

/** Forget a channel's bites and history, as a restart does; with its db, the saved wait too. For tests. */
export function resetBites(channel: string, db?: PointsDb): void {
  if (db) storeDue(db, null);
  rewardQueue.delete(channel);
  for (const k of [...rewardSeen.keys()]) if (k.startsWith(`${channel}|`)) rewardSeen.delete(k);
  for (const k of [...bites.keys()]) if (k.startsWith(`${channel}|`)) takeBite(channel, k.slice(channel.length + 1));
  dueAt.delete(channel);
  lastChatter.delete(channel);
}
