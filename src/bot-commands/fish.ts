/**
 * Fishing — supibot's `$fish` minigame, played for the channel's loyalty points.
 *
 * Description: Cast a line (1 in 20 lands a fish, bait improves it), keep what you
 *              catch, sell it for points, lay traps, and compare on leaderboards.
 *              Rules, numbers and messages follow supibot (commands/fish); see
 *              community/fishing.ts. A points game: it exists only where the
 *              channel has points and `points.games.enabled`, as `$<cmd> fish`.
 *
 * Permission required: all users (5s between uses; cooldowns below)
 *
 * Usage:   $don fish [worm|fly|cricket] [skipStory:true]
 *              Cast. A miss waits 30–90s (1 in 4 misses snags junk); a catch waits
 *              games.catchCooldownMinutes (30). Bait is bought and used on the spot.
 *          $don fish sell <emoji> [n] [<emoji> [n] …] · sell all fish|junk|fish junk · sell duplicate (the same)
 *              Several items at once: "sell 🐟 🦐 🦀", "sell 🐟🦐🦀" or "sell 🐟 3 🦐 2".
 *          $don fish show [user] [fish|junk|emoji]      (also count, display, collection; no type shows both)
 *          $don fish stats [user|global]
 *          $don fish top [fish|coins|junk|lucky|unlucky|traps|attempts|thieves|caught|robbed|total-…|emoji]   (also leaderboard)
 *          $don fish trap [cancel|reset]                (also net, trawl)
 *          $don fish answer <x>                         (also ans: a trap check's answer; see games.trapCheck
 *                                                         and community/trap-check.ts)
 *          $don fish buy [reel|hook|guard]              (shows the shop; "buy reel" buys the next reel)
 *          $don fish duel @user [fish|random] [amount|keeps]   (also battle, fight; see games.duel and community/fish-duel.ts)
 *              Challenge someone to a fight between one fish each, played out turn by
 *              turn on the overlay. The challenger's fish is their strongest unless
 *              named, and sets the stake: nothing, a wager both put up, or "keeps",
 *              where the winner takes the loser's fish.
 *          $don fish accept [fish|random] | deny      (answer a duel; deny also withdraws your own challenge)
 *          $don fish reel <code>                        (answer a big bite with the code shown on the overlay;
 *                                                         bites come at random while live, community/big-bite.ts)
 *          $don fish steal @user                        (also rob; needs a hook, see games.steal)
 *              Reaches for one random fish the target has held a while; succeeds by
 *              its rarity. Every try uses one hook try and a fee on that fish's value;
 *              caught, a fine too, set from the odds so thieves lose games.steal.
 *              edgePercent on average. Nobody receives either. A thief who can't cover
 *              both for the target's costliest fish, or who meets a guard, loses one
 *              hook use and nothing else.
 *
 * Casting, laying traps and stealing follow games.onlyWhileLive and stay silent offline,
 * like $<cmd> gamble; games.onlyWhileOffline is the reverse, silent while live;
 * games.steal.onlyWhileLive keeps stealing to live streams whatever those two say. Everything that changes a balance or a catch runs in one
 * points-database transaction keyed on the Kick message id.
 */

import fetch from 'node-fetch';
import { ChannelConfig, CommandFn, FishReelSetting } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import { getPointsService } from '../points/service';
import { runWrite } from '../points/db';
import type { PointsDb } from '../points/db';
import { applyOnce, creditTx, debitTx, ensureUserTx, findUserByName, getUser, isApplied, isExcluded } from '../points/store';
import { makeCooldown, parseUsername, span } from '../community/format';
import { gameInvocation } from '../community/stakes';
import { addReminder, cancelSelfRemindersStartingWith, openCommunityDb } from '../community/store';
import { bestEmote, broadcasterIdFor, emoteImages } from '../community/emotes';
import { OverlayKind, overlayShowing, pushOverlay } from '../community/fish-overlay';
import { addChallenge, challengeBy, challengeFor, closeInValue, describe, dropChallenge, fight, fishNamed, fishValue, keepsRange, overlayDuel, pickByValue, pickFighter, pickForKeeps, sameFish, playMs, randomFish, wantsRandom, type DuelStake } from '../community/fish-duel';
import { parseBet } from './points';
import { answerMatches, makeTrapCheck, type TrapCheck } from '../community/trap-check';
import { wheelBusy } from '../community/wheel-state';
import { recordSignal } from '../community/cheat-signals';
import { BITE_TOO_FAST_MS, STREAM_GRACE_MS, biteFor, canBite, channelBite, channelHasBite, codeMatches, getAway, nextPull, pickChatter, snipeBite, snipeOpen, startBite, takeBite, type BiteContext } from '../community/big-bite';
import {
  addItem, giveItems, baitPrice, baitRoll, currentReel, heldFishValue, landsFish, moveFish, pickHeld, stealableFish, stealChance, stealCharges, stealRollChance, worstStealCharges, parseSellList, CatchItem, CatchType, FAILURE_EMOTES, FishData, findBait, hasFishedBefore, initialData, rarityOf, recordCatch,
  ITEMS, JUNK_MESSAGES, loadFish, MISS_DELAY_MS, pick, randomInt, rollCatch, saveFish, sellPrice, STORY_STYLES, SUCCESS_EMOTES,
  takeItems, TYPE_DESCRIPTIONS, weightedCatch
} from '../community/fishing';

const cooldown = makeCooldown(5000);
/** When each viewer last gave fish, by "channel|name" (games.giveCooldownSeconds). */
const lastGive = new Map<string, number>();
/** When each viewer last challenged someone to a fish duel, by channel and name. */
const lastChallenge = new Map<string, number>();
const pointer = makeCooldown(60_000);
/** The timer that ends each waiting trap check when its time runs out, by channel and user id. */
const checkTimers = new Map<string, NodeJS.Timeout>();

export const SUBCOMMANDS: Record<string, 'buy' | 'sell' | 'show' | 'stats' | 'top' | 'trap' | 'steal' | 'give' | 'duel' | 'accept' | 'deny' | 'reel' | 'bigbite' | 'answer'> = {
  buy: 'buy', b: 'buy', sell: 'sell', s: 'sell',
  show: 'show', sh: 'show', count: 'show', display: 'show', collection: 'show',
  stats: 'stats', st: 'stats', top: 'top', tp: 'top', leaderboard: 'top',
  trap: 'trap', t: 'trap', net: 'trap', trawl: 'trap',
  steal: 'steal', sl: 'steal', rob: 'steal',
  give: 'give', gv: 'give', gift: 'give',
  duel: 'duel', d: 'duel', battle: 'duel', fight: 'duel', accept: 'accept', a: 'accept', deny: 'deny', dn: 'deny', decline: 'deny',
  reel: 'reel', r: 'reel',
  // A trap check's answer (community/trap-check.ts).
  answer: 'answer', ans: 'answer',
  // The streamer or the bot owner: a big bite now, on a random active chatter, the one named, or "me".
  // Testers (debugFishTesters): one on yourself.
  bigbite: 'bigbite', bb: 'bigbite'
};


const STORY_MODEL = 'claude-haiku-4-5-20251001';
/** supibot asks for 150 characters; allow some overrun before trimming. */
const STORY_MAX = 220;
const groupDigits = (n: number): string => Math.round(n).toLocaleString('en-US');

// ─── Leaderboards ───────────────────────────────────────────────────────────

interface Board { path: string | null; name: string; value: (d: FishData, balance: number) => number | null }

/** Short forms for the words after a fish subcommand: `t c` is `trap cancel`, `b h` is `buy hook`, `tp tf` is `top total-fish`. */
const TYPE_SHORT: Record<string, string> = { f: 'fish', j: 'junk' };
const TRAP_SHORT: Record<string, string> = { c: 'cancel', r: 'reset' };
const BUY_SHORT: Record<string, string> = { r: 'reel', h: 'hook', g: 'guard' };
const BAIT_SHORT: Record<string, string> = { w: 'worm', f: 'fly', c: 'cricket' };
const SELL_SHORT: Record<string, string> = { a: 'all', d: 'duplicate' };
const STATS_SHORT: Record<string, string> = { g: 'global' };
export const BOARD_SHORT: Record<string, string> = {
  f: 'fish', c: 'coins', j: 'junk', l: 'lucky', u: 'unlucky', t: 'traps', a: 'attempts', th: 'thieves', ca: 'caught', r: 'robbed', d: 'duelists',
  tf: 'total-fish', tc: 'total-coins', tj: 'total-junk', tl: 'total-lucky', tu: 'total-unlucky'
};
/** `word` spelled out when it's one of `short`'s, else as typed. */
const long = <T extends string | undefined>(word: T, short: Record<string, string>): T | string =>
  (word !== undefined && short[word.toLowerCase()]) || word;

export const BOARDS = new Map<string, Board>([
  ['fish', { path: '$.catch.fish', name: 'anglers', value: d => d.catch.fish }],
  ['total-fish', { path: '$.lifetime.fish', name: 'all-time piscators', value: d => d.lifetime.fish }],
  // Coins are the currency itself: the purse is the points balance.
  ['coins', { path: null, name: 'coin collectors', value: (_d, balance) => balance }],
  ['total-coins', { path: '$.lifetime.coins', name: 'all-time scrooges', value: d => d.lifetime.coins }],
  ['junk', { path: '$.catch.junk', name: 'junkrats', value: d => d.catch.junk }],
  ['total-junk', { path: '$.lifetime.junk', name: 'all-time scraphounds', value: d => d.lifetime.junk }],
  ['lucky', { path: '$.catch.luckyStreak', name: 'lucky ducks', value: d => d.catch.luckyStreak }],
  ['total-lucky', { path: '$.lifetime.luckyStreak', name: 'all-time lucky ducks', value: d => d.lifetime.luckyStreak }],
  ['unlucky', { path: '$.catch.dryStreak', name: 'jinxed sphinxes', value: d => d.catch.dryStreak }],
  ['total-unlucky', { path: '$.lifetime.dryStreak', name: 'all-time unluckiest anglers', value: d => d.lifetime.dryStreak }],
  ['traps', { path: '$.lifetime.trap.times', name: 'most persistent trappers', value: d => d.lifetime.trap.times }],
  ['attempts', { path: '$.lifetime.attempts', name: 'most persistent trawlers', value: d => d.lifetime.attempts }],
  ['thieves', { path: '$.lifetime.steal.stolen', name: 'master thieves', value: d => d.lifetime.steal.stolen }],
  ['caught', { path: '$.lifetime.steal.caught', name: 'hall of shame (caught red-handed)', value: d => d.lifetime.steal.caught }],
  ['robbed', { path: '$.lifetime.steal.lost', name: 'easy pickings (fish lost to thieves)', value: d => d.lifetime.steal.lost }],
  ['duelists', { path: '$.lifetime.duel.wins', name: 'fish duelists (duels won)', value: d => d.lifetime.duel.wins }],
  ...ITEMS.map(i => [i.name, { path: `$.catch.types."${i.name}"`, name: `${i.name} collectors`, value: (d: FishData) => d.catch.types[i.name] ?? null }] as [string, Board])
]);

type TopRow = { user_id: number; username: string; value: number };

export function topRows(db: PointsDb, board: Board): TopRow[] {
  if (board.path === null) {
    return db.prepare(
      `SELECT u.user_id, u.username, u.balance AS value FROM fish f JOIN users u ON u.user_id = f.user_id
       ORDER BY value DESC LIMIT 10`
    ).all() as TopRow[];
  }
  return db.prepare(
    `SELECT u.user_id, u.username, CAST(json_extract(f.data, ?) AS INTEGER) AS value FROM fish f JOIN users u ON u.user_id = f.user_id
     WHERE json_extract(f.data, ?) IS NOT NULL ORDER BY value DESC LIMIT 10`
  ).all(board.path, board.path) as TopRow[];
}

function rankOf(db: PointsDb, board: Board, value: number): number {
  if (board.path === null) {
    return (db.prepare('SELECT COUNT(*) + 1 AS r FROM fish f JOIN users u ON u.user_id = f.user_id WHERE u.balance > ?').get(value) as { r: number }).r;
  }
  return (db.prepare('SELECT COUNT(*) + 1 AS r FROM fish WHERE json_extract(data, ?) IS NOT NULL AND CAST(json_extract(data, ?) AS INTEGER) > ?')
    .get(board.path, board.path, value) as { r: number }).r;
}

// ─── Story ──────────────────────────────────────────────────────────────────

export async function story(user: string, fishType: string, sizeString: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = `Write a short, ${pick(STORY_STYLES)} fishing story about a user named "${user}" who catches a ${fishType} in the water and keeps it! ${sizeString} Make it very concise - a maximum of 150 characters.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: STORY_MODEL,
      max_tokens: 120,
      system: 'Reply with the story only: plain text, at most 150 characters (one or two short sentences), no title, no quotes, no markdown, no @ signs. ' +
        'Refer to the user by their name or as "they"; never assume their gender.',
      messages: [{ role: 'user', content: prompt }]
    }),
    timeout: 15_000
  });
  if (!resp.ok) throw new Error(`API returned ${resp.status}`);
  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').replace(/@/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= STORY_MAX) return text;
  // Over-long: end at the last full sentence that fits rather than mid-word.
  const cut = text.slice(0, STORY_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), /[.!?]$/.test(cut) ? cut.length - 1 : -1);
  return end >= 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// ─── Command ────────────────────────────────────────────────────────────────

/** A message that is just the code of the sender's big bite, past its first pull, as `fish reel <code>`; else null. */
function bareReel(message: string, channel: string, name: string): ReturnType<typeof gameInvocation> {
  const bite = biteFor(channel.replace(/^#/, '').toLowerCase(), name.toLowerCase());
  if (!bite || bite.pull < 2 || !codeMatches(message, bite.code)) return null;
  const usage = gameInvocation('!fish', channel, 'fish')?.usage;
  return usage ? { form: 'currency', args: ['reel', bite.code], usage } : null;
}

export const fish: CommandFn = async function fish(client, message, channel, tags, config) {
  // From a big bite's second pull the code counts by itself, for whoever is reeling: the
  // time is short and the prefix is most of the typing on a phone. Only an exact match
  // is an answer; anything else they say is chat, and loses nothing.
  const call = gameInvocation(message, channel, 'fish') ?? bareReel(message, channel, tags.username);
  if (!call) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  if (call.form === 'redirect') return void (pointer(meLc) || client.say(channel, `@${me} it's ${call.usage} here`));
  if (SYSTEM_BOTS.has(meLc) || isBotSender(me, tags.senderId)) return;
  const chan = channel.replace(/^#/, '').toLowerCase();
  // A reel answering a waiting big bite skips the 5s cooldown: there's one answer per
  // bite, so nothing to spam, and the cast that started it was seconds ago. The same
  // for a snipe at someone else's while it's open: one try each.
  const open = channelBite(chan);
  const answering = SUBCOMMANDS[String(call.args.find(a => !/^skipstory:/i.test(a)) ?? '').toLowerCase()] === 'reel'
    && (!!biteFor(chan, meLc) || (!!open && snipeOpen(open, Date.now()) && !open.tried.has(meLc)));
  // A trap check's answer skips it too: the answer window is short, a quick correction
  // after a typo should count, and the tries are limited anyway. Without a question
  // waiting, the cooldown applies as usual (case 'answer').
  const checkAnswer = SUBCOMMANDS[String(call.args.find(a => !/^skipstory:/i.test(a)) ?? '').toLowerCase()] === 'answer';
  if (!answering && !checkAnswer && cooldown(meLc)) return;

  const svc = getPointsService(chan);
  const db = svc?.db();
  if (!svc || !db) return;
  const cfg = svc.config();
  const g = cfg.games;
  const cur = cfg.currencyName;
  const cmd = call.usage.replace(/ fish$/, '');

  /**
   * Reply. Every fishing reply goes to the overlay. Chat gets it too, unless the
   * channel keeps fishing out of live chat (chat replies off, or fishing set to
   * offline only) and the overlay can stand in: the stream is live with one showing.
   * Offline, or with no overlay open, chat still gets it, so nobody is left without
   * an answer.
   */
  // A duel or a gift is between two viewers and works live, so its usage and error lines go to chat
  // too, whatever the reply settings say: on the overlay alone they're easy to miss.
  let duelReply = false;
  const say = async (text: string, meta: { kind?: OverlayKind; item?: string; code?: string; until?: number } = {}) => {
    const emotes = emoteImages(chan, text);
    const rarity = meta.item ? rarityOf(g, meta.item) : null;
    pushOverlay(db, {
      username: me, kind: meta.kind ?? 'info', text,
      ...(meta.item ? { item: meta.item } : {}), ...(rarity ? { rarity } : {}), ...(Object.keys(emotes).length ? { emotes } : {}),
      ...(meta.code !== undefined ? { code: meta.code, until: meta.until } : {})
    });
    try {
      if (!duelReply && (!g.chatReplies || g.onlyWhileOffline) && overlayShowing(db) && (await svc.isLiveNow()) === true) return;
      await client.say(channel, `@${me} ${text}`);
    } catch (err) {
      console.error(`[FISH] Reply to ${me} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  let skipStory = false;
  const args = call.args.filter(a => {
    const m = /^skipstory:(true|false)$/i.exec(a);
    if (m) skipStory = m[1].toLowerCase() === 'true';
    return !m;
  });
  const sub = SUBCOMMANDS[(args[0] ?? '').toLowerCase()];
  const rest = sub ? args.slice(1) : args;

  const senderId = Number(tags.senderId);
  const userId = Number.isInteger(senderId) && senderId > 0 ? senderId : findUserByName(db, meLc)?.user_id ?? null;
  // Staging: named testers can try stealing and big bites anywhere, any time (debugFishTesters).
  const tester = cfg.debugFishTesters.includes(meLc);
  const offLimits = (id: number | null, name: string) => isExcluded(svc.exclusions(), id, name);
  const excluded = offLimits(userId, meLc);
  const ignore = (why: string) => void console.log(`[FISH] ${me} ignored in ${chan}: ${why}`);

  /** Run a change once per chat message, in one transaction. A replay stays silent. */
  const once = <T>(fn: (now: number) => T): T | undefined => {
    if (tags.messageId && isApplied(db, `chat:${tags.messageId}`)) return undefined;
    const run = tags.messageId
      ? applyOnce(db, `chat:${tags.messageId}`, Date.now(), () => fn(Date.now()))
      : { applied: true, result: runWrite(db, () => fn(Date.now())) };
    return run.applied ? run.result : undefined;
  };
  /** `liveOnly` is a rule of the caller's own (games.steal.onlyWhileLive) that replaces the two for casting. */
  const liveOk = async (liveOnly = false): Promise<boolean> => {
    if (!liveOnly && !g.onlyWhileLive && !g.onlyWhileOffline) return true;
    const live = await svc.isLiveNow();
    // Both on can't be saved; a hand-edited file with both keeps the live rule.
    const want = liveOnly || g.onlyWhileLive;
    if (live !== want) ignore(live === null ? 'live state unknown' : want ? 'offline' : 'live');
    return live === want;
  };
  const emotesFor = (list: readonly string[], fallback: string) => bestEmote(chan, broadcasterIdFor(config as ChannelConfig), list, fallback);

  /**
   * Land one fish, from a cast or a reeled-in big bite: into the collection with its
   * length and record, the catch cooldown, and a catches row. Inside a write
   * transaction; the caller saves `d`. Returns the size and worth line.
   */
  function land(d: FishData, uid: number, item: CatchItem, reel: FishReelSetting | null, now: number, cooldown = true): string {
    addItem(d, item);
    d.catch.dryStreak = 0;
    d.catch.luckyStreak++;
    if (d.catch.luckyStreak > d.lifetime.luckyStreak) d.lifetime.luckyStreak = d.catch.luckyStreak;
    // A big bite isn't a cast, so it leaves casting alone.
    if (cooldown) d.readyTimestamp = now + g.catchCooldownMinutes * 60_000;
    if (!item.size) {
      recordCatch(db!, uid, item.name, 'cast', null, now);
      return item.trophy ? `Worth ${groupDigits(sellPrice(item, g, undefined, reel?.valueMultiplier ?? 1))} ${cur}.` : '';
    }
    const size = randomInt(1, 100);
    let sizeString = `It is ${size} cm in length.`;
    // A first catch always sets a record; only beating an earlier one earns the bonus.
    const beatRecord = d.lifetime.maxFishSize > 0 && size > d.lifetime.maxFishSize;
    if (size > d.lifetime.maxFishSize) {
      sizeString += ' This is a new record!';
      d.lifetime.maxFishSize = size;
      d.lifetime.maxFishType = item.name;
    }
    const held = { cm: size, record: beatRecord };
    d.catch.sizes ??= {};
    (d.catch.sizes[item.name] ??= []).push(held);
    sizeString += ` Worth ${sellPrice(item, g, held, reel?.valueMultiplier ?? 1)} ${cur}.`;
    recordCatch(db!, uid, item.name, 'cast', size, now);
    return sizeString;
  }

  // ── big bite ──
  const biteCtx = (): BiteContext => ({
    channel: chan, db: db!, bigBite: g.bigBite, delayMs: g.streamDelaySeconds * 1000, command: cmd.replace(/^\$/, ''),
    sendMessage: (m: string) => client.say(channel, m)
  });

  /**
   * `fish reel <code>`: one answer per pull, from the bite's chatter, after the stream
   * could show the code. A right answer before the last pull brings the next code; on
   * the last, the trophy is rolled and lands by its land chance or snaps the line.
   * Someone else's bite can be sniped while its first code is open to everyone: one
   * try each, and the first right answer takes the bite and reels on as its chatter.
   */
  function reelIn(codeRaw: string | undefined, uid: number): void {
    const at = Date.now();
    let bite = biteFor(chan, meLc);
    if (!bite) {
      const other = channelBite(chan);
      // Too early for someone else's first code: that was their one try (spamming the
      // code from the start used to cost nothing, so the ±3s on the window didn't help).
      if (other && other.pull === 1 && other.snipeAt !== undefined && at < other.snipeAt && !other.tried.has(meLc)
        && canBite({ channel: chan, excluded: (id, name) => offLimits(id, name) }, uid, me)) {
        other.tried.add(meLc);
        return void say(`Too early! You spooked it: no more snipes at ${other.username}'s big bite.`);
      }
      if (!other || !snipeOpen(other, at) || !canBite({ channel: chan, excluded: (id, name) => offLimits(id, name) }, uid, me)) {
        return void say("There's nothing big on your line right now.");
      }
      if (other.tried.has(meLc)) return ignore('snipe already tried');
      other.tried.add(meLc);
      if (!codeMatches(codeRaw, other.code)) return void say(`Wrong code! You missed your one shot at sniping ${other.username}'s big bite.`);
      snipeBite(biteCtx(), other, me, uid);
      bite = other;
    } else {
      const fail = (why: string) => { takeBite(chan, meLc); getAway(biteCtx(), me, why); };
      if (at > bite.until + STREAM_GRACE_MS) return fail('Too slow! It shook the hook and swam off.');
      if (at - bite.startedAt < BITE_TOO_FAST_MS) return fail('You yanked too early and snapped the line!');
      if (!codeMatches(codeRaw, bite.code)) return fail('Wrong move! The line snapped.');
    }
    if (bite.pull < bite.pulls) return nextPull(biteCtx(), bite);
    takeBite(chan, meLc);
    const item = weightedCatch('trophy', g);
    if (randomInt(1, 100) > (item.landPercent ?? 100)) {
      console.log(`[FISH] ${me}'s trophy ${item.name} snapped free in ${chan}`);
      const snapped = `So close! It was a ✨${item.name}✨! It thrashed free on the last pull and snapped the line! 😱`;
      pushOverlay(db!, { username: me, kind: 'miss', text: snapped, item: item.name, rarity: 'Mythic' });
      return void client.say(channel, `@${me} ${snapped}`);
    }
    const out = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      const sizeString = land(d, uid, item, currentReel(d, g), now, false);
      saveFish(db!, uid, d, now);
      return { item, sizeString };
    });
    if (!out) return;
    console.log(`[FISH] ${me} reeled in a trophy ${out.item.name} in ${chan}`);
    // The result line: to chat as well as the overlay, whatever the chat-replies setting.
    const text = `🏆 You reeled it in! A MYTHIC ✨${out.item.name}✨! ${out.sizeString}`;
    pushOverlay(db!, { username: me, kind: 'catch', text, item: out.item.name, rarity: 'Mythic' });
    void client.say(channel, `@${me} ${text}`);
  }

  /** Testers only: a big bite on yourself now, live or not (an overlay still has to be showing). */
  function testBite(uid: number): void {
    if (!tester) return;
    if (biteFor(chan, meLc)) return void say('You already have a big bite on your line.');
    if (wheelBusy(chan)) return void say('The wheel is spinning: try once it has landed.');
    if (!overlayShowing(db!)) return void say('Open the fishing overlay first: a big bite needs somewhere to show its code.');
    startBite(biteCtx(), me, uid);
  }

  // ── cast ──
  async function cast(baitWord: string | undefined, uid: number): Promise<void> {
    if (!tester && !(await liveOk())) return;
    const bait = findBait(baitWord);
    // Cast checks (games.trapCheck.castChancePercent): offline only, like trap checks.
    const tc = g.trapCheck;
    const liveNow = (await svc!.isLiveNow()) === true;
    const mayAsk = tc.enabled && tc.castChancePercent > 0 && !liveNow;
    let askedCheck: TrapCheck | null = null;
    type Outcome =
      | { kind: 'reply'; text: string }
      | { kind: 'miss'; text: string; delay: number; appendix: string; streak: string }
      | { kind: 'catch'; item: CatchItem; sizeString: string; appendix: string };

    const out = once<Outcome>(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      // Every cast command, early ones too: how soon after the cooldown people cast (cheat-signals.ts).
      recordSignal(db!, { userId: uid, kind: 'cast', now, delayMs: d.readyTimestamp ? now - d.readyTimestamp : null, live: liveNow });
      if (d.readyTimestamp !== 0 && now < d.readyTimestamp) {
        return { kind: 'reply', text: `Hol' up partner! You can go fishing again in ${span(d.readyTimestamp - now)}!` };
      }
      if (d.trap.active) {
        return {
          kind: 'reply',
          text: now > d.trap.end
            ? `You cannot go fishing while your traps are laid out - you would be disturbing the catch! Your traps are ready to be collected! Go ahead and use "${cmd} fish trap" to get your stuff.`
            : `You cannot go fishing while your traps are laid out - you would be disturbing the catch! If you wish to get rid of the traps immediately, use "${cmd} fish trap cancel", but you will not get any catch from them.`
        };
      }
      // A cast check waiting: answer it first. (A trap one can't be: the traps would be out.)
      if (d.trapCheck) {
        if (now > d.trapCheck.until) {
          const text = failCheck(d, uid, d.trapCheck, 'time', now);
          saveFish(db!, uid, d, now);
          return { kind: 'reply', text };
        }
        return { kind: 'reply', text: `Before you cast again: ${d.trapCheck.question} ${answerHowLine} (${span(d.trapCheck.until - now)} left)` };
      }
      if (mayAsk && randomInt(1, 100) <= tc.castChancePercent) {
        d.trapCheck = askedCheck = { ...makeTrapCheck(false, now, tc.answerSeconds, true), fine: Math.floor((getUser(db!, uid)?.balance ?? 0) * tc.finePercent / 100) };
        recordSignal(db!, { userId: uid, kind: 'check_asked', now, live: liveNow, detail: 'cast' });
        saveFish(db!, uid, d, now);
        console.log(`[FISH] ${me} got a cast check in ${chan}: ${d.trapCheck.question}`);
        const stake = tc.finePercent > 0 ? `costs ${tc.finePercent}% of your ${cur}` : 'just ends it';
        const tries = tc.tries === 1 ? 'one try' : `${tc.tries} tries`;
        return { kind: 'reply', text: `🎣 Your line snagged! Free it before you cast: ${d.trapCheck.question} ${answerHowLine} You have ${span(tc.answerSeconds * 1000)} and ${tries}; running out ${stake}.` };
      }

      let rollMaximum = g.catchOdds;
      let appendix = '';
      if (bait) {
        const price = baitPrice(bait, g);
        const balance = getUser(db!, uid)?.balance ?? 0;
        if (balance < price) return { kind: 'reply', text: `You need ${price} ${cur} for one ${baitWord}! (you have ${balance} ${cur})` };
        const after = price > 0
          ? debitTx(db!, { userId: uid, amount: price, reason: 'game:fish_bait', actor: `chat:${me}`, note: bait.name, now }).balance
          : balance;
        rollMaximum = baitRoll(bait, g);
        d.lifetime.baitUsed++;
        appendix = `, used ${baitWord}, ${after} ${cur} left`;
      }
      rollMaximum = Math.max(1, rollMaximum);
      d.lifetime.attempts++;
      const reel = currentReel(d, g);

      if (!landsFish(rollMaximum, reel)) {
        const delay = Math.round(randomInt(MISS_DELAY_MS[0], MISS_DELAY_MS[1]) / 1000) * 1000;
        d.catch.dryStreak++;
        d.catch.luckyStreak = 0;
        d.readyTimestamp = now + delay + 1000;
        if (d.catch.dryStreak > d.lifetime.dryStreak) d.lifetime.dryStreak = d.catch.dryStreak;
        let text: string;
        if (randomInt(1, 100) <= 25) {
          const item = weightedCatch('junk', g);
          addItem(d, item);
          text = `${pick(JUNK_MESSAGES)} You reel out a ${item.name}`;
        } else {
          text = `Your fishing line landed ${randomInt(1, 500)} cm away.`;
        }
        saveFish(db!, uid, d, now);
        const streak = d.catch.dryStreak >= 3
          ? ` This is your attempt #${d.catch.dryStreak} since ${d.lifetime.fish === 0 ? 'you started fishing' : 'your last catch'}.`
          : '';
        return { kind: 'miss', text, delay, appendix, streak };
      }

      const item = weightedCatch('fish', g, reel?.rarityMultiplier ?? 1);
      const sizeString = land(d, uid, item, reel, now);
      saveFish(db!, uid, d, now);
      return { kind: 'catch', item, sizeString, appendix };
    });
    if (!out) return;
    const asked = askedCheck as TrapCheck | null;
    if (asked) timeCheck(uid, asked);
    if (out.kind === 'reply') return void say(out.text);

    if (out.kind === 'miss') {
      const emote = await emotesFor(FAILURE_EMOTES, '😔');
      return void say(`No luck... ${emote} ${out.text} (${span(out.delay)} cooldown${out.appendix})${out.streak}`, { kind: 'miss' });
    }

    console.log(`[FISH] ${me} caught ${out.item.name} in ${chan}`);
    const minutes = g.catchCooldownMinutes;
    if (g.stories && !skipStory && randomInt(1, 3) === 1) {
      try {
        const text = await story(me, out.item.name, out.sizeString);
        if (text) return void say(`✨${out.item.name}✨ ${text} (${minutes}m cooldown${out.appendix})`, { kind: 'catch', item: out.item.name });
      } catch (err) {
        console.error(`[FISH] Story for ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const emote = await emotesFor(SUCCESS_EMOTES, '😃');
    const size = out.sizeString ? ` ${out.sizeString}` : '';
    return void say(`You caught a ✨${out.item.name}✨${size} ${emote} Now, go do something productive! (${minutes} minute fishing cooldown after a successful catch)`, { kind: 'catch', item: out.item.name });
  }

  /**
   * The streamer's and the bot owner's: a big bite now, on `target` or else a random active chatter, without
   * the dice or the gap since the last. Everything else holds: big bites on, one at
   * a time, an overlay showing, and never a bot or anyone left out of points.
   */
  function streamerBite(target: string | undefined): void {
    if (!g.bigBite.enabled) return void say('Big bites are off here.');
    if (channelHasBite(chan)) return void say('Someone already has a big bite on their line.');
    if (wheelBusy(chan)) return void say('The wheel is spinning: start a big bite once it has landed.');
    if (!overlayShowing(db!)) return void say('Open the fishing overlay first: a big bite needs somewhere to show its code.');
    const who = { channel: chan, db: db!, bigBite: g.bigBite, excluded: (id: number, name: string) => offLimits(id, name) };
    const nameLc = (target ?? '').replace(/^@+/, '').toLowerCase();
    if (!nameLc) {
      const pick = pickChatter(who);
      if (!pick) return void say(`Nobody has chatted in the last ${g.bigBite.activeMinutes} minutes to get a big bite.`);
      return void startBite(biteCtx(), pick.username, pick.userId);
    }
    // On themselves, to try it: the one bite the streamer can get.
    if (nameLc === 'me' || nameLc === meLc) {
      if (userId === null) return ignore('no account');
      return void startBite(biteCtx(), me, userId);
    }
    const viewer = findUserByName(db!, nameLc);
    if (!viewer) return void say(`I don't know ${nameLc} yet: they have to chat here first.`);
    if (!canBite(who, viewer.user_id, viewer.username)) return void say(`${viewer.username} can't get a big bite.`);
    startBite(biteCtx(), viewer.username, viewer.user_id);
  }

  /**
   * The reminder that pings a viewer when their traps are full, posted through
   * !remind's timer so it survives a restart. It needs !remind on to be delivered.
   * Collecting, cancelling or re-laying the traps first clears the old one.
   */
  const TRAP_REMINDER = 'your fishing traps are ready';
  // Kick chat drops anything in angle brackets: "<x>" came out as nothing.
  const answerHowLine = `Reply "${cmd} fish answer" followed by your answer.`;
  const remindsOn = !((config as ChannelConfig).excludedCommands as string[] | undefined ?? []).some(c => String(c).toLowerCase() === 'remind');
  function syncTrapReminder(trapEnd: number | null): void {
    const cdb = openCommunityDb(channel);
    if (!cdb) return;
    try {
      const now = Date.now();
      cancelSelfRemindersStartingWith(cdb, meLc, TRAP_REMINDER, now);
      if (trapEnd !== null && remindsOn) {
        addReminder(cdb, { from: me, to: me, text: `${TRAP_REMINDER} 🎣 collect them with ${cmd} fish trap`, now, dueAt: trapEnd });
      }
    } catch (err) {
      console.error(`[FISH] Trap reminder for ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── trap ──
  /**
   * `trap` lays traps, or collects full ones; `trap reset` collects and lays again;
   * `trap cancel` pulls them in empty. With trap checks on, collecting while the
   * stream is offline may ask a question first (community/trap-check.ts): the haul
   * waits for `answer`. A right one collects it; running out of tries or time fines
   * the player and empties the traps. A timer ends the window on time; after a
   * restart, the player's next trap command or answer does.
   */
  async function trap(operation: string, uid: number, answer?: string): Promise<void> {
    const before = loadFish(db!, uid) ?? initialData();
    const tc = g.trapCheck;
    if (operation === 'answer') {
      if (!before.trapCheck) return void say("There's no question waiting on your traps.");
      // Nothing after "answer" isn't a try: the question again, while there's time.
      const wait = before.trapCheck.until - Date.now();
      if (!answer && wait >= 0) return void say(`Your traps are waiting on this: ${before.trapCheck.question} Reply "${cmd} fish answer" followed by your answer (${span(wait)} left).`);
    }
    // Laying traps is fishing, so it follows the live rule; collecting or cancelling doesn't.
    // An answer to a reset lays them again too, but if it can't, it still collects.
    const laysTraps = operation === 'answer'
      ? before.trapCheck!.reset
      : operation !== 'cancel' && (!before.trap.active || operation === 'reset');
    const mayLay = laysTraps && (await liveOk());
    if (laysTraps && !mayLay && operation !== 'answer') return;
    // Checks only ask offline; an unknown live state counts as offline.
    const liveNow = (await svc!.isLiveNow()) === true;
    const mayAsk = tc.enabled && operation !== 'answer' && operation !== 'cancel' && before.trap.active && !before.trapCheck && !liveNow;
    const waitEmote = await emotesFor(['PauseChamp'], '⌛');
    // What the traps are after this message: laid until a time, emptied, or untouched.
    let after: { laidUntil: number | null } | null = null;
    let collected = false;
    const answerHow = answerHowLine;
    let askedCheck: TrapCheck | null = null;

    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if (operation !== 'answer' && d.readyTimestamp !== 0 && now < d.readyTimestamp) {
        return `Hol' up partner! You can go set up your fishing traps in ${span(d.readyTimestamp - now)}!`;
      }
      // A cast check waiting comes first, traps included.
      if (operation !== 'answer' && d.trapCheck?.cast) {
        if (now <= d.trapCheck.until) return `Free your line first: ${d.trapCheck.question} ${answerHow} (${span(d.trapCheck.until - now)} left)`;
        const text = failCheck(d, uid, d.trapCheck, 'time', now);
        saveFish(db!, uid, d, now);
        return text;
      }
      const setUp = (): string => {
        const duration = g.trapMinutes * 60_000;
        d.trap = { active: true, start: now, end: now + duration, duration };
        after = { laidUntil: d.trap.end };
        const ping = remindsOn ? " I'll ping you when they're ready." : '';
        return `You have laid your fishing traps. Now we wait... ${waitEmote} You can check them in about ${span(duration)}.${ping}`;
      };
      const collect = (): string => {
        collected = true;
        // How long after the traps filled they were collected (cheat-signals.ts).
        recordSignal(db!, { userId: uid, kind: 'trap_collect', now, delayMs: now - d.trap.end, live: liveNow });
        const rolls = Math.floor(d.trap.duration / 60_000 * randomInt(75, 90) / 100);
        const skip = g.catchCooldownMinutes;
        let fishAmount = 0;
        const results: string[] = [];
        const reel = currentReel(d, g);
        for (let i = 0; i < rolls; i++) {
          const r = rollCatch(g, reel);
          if (!r.item) continue;
          // A fish costs a catch cooldown of the trap's time, so only an early one counts.
          if (r.type === 'fish' && i < rolls - skip) {
            fishAmount++;
            i += skip;
            addItem(d, r.item);
            recordCatch(db!, uid, r.item.name, 'trap', null, now);
            results.push(r.item.name);
          } else if (r.type === 'junk') {
            addItem(d, r.item);
            results.push(r.item.name);
          }
        }
        d.lifetime.trap.times++;
        d.lifetime.trap.timeSpent += d.trap.duration;
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
        after = { laidUntil: null };
        if (fishAmount > d.lifetime.trap.bestFishCatch) d.lifetime.trap.bestFishCatch = fishAmount;
        if (!results.length) return 'You drag the traps out of the water... and find that there is nothing at all...!';
        if (fishAmount === 0) return `You drag the traps out of the water... and find a bunch of junk. ${results.join('')}`;
        return `You drag the traps out of the water... and you spot some fish! ${results.join('')}`;
      };

      let reply: string;
      if (operation === 'answer') {
        const check = d.trapCheck;
        if (!check) return "There's no question waiting on your traps.";
        if (now > check.until) {
          reply = failCheck(d, uid, check, 'time', now);
          after = { laidUntil: null };
        } else if (answerMatches(check, answer)) {
          recordSignal(db!, { userId: uid, kind: 'check_passed', now, delayMs: now - check.askedAt, live: liveNow, detail: check.cast ? 'cast' : 'trap' });
          delete d.trapCheck;
          d.lifetime.trap.checksPassed++;
          console.log(`[FISH] ${me} passed a trap check in ${chan}`);
          reply = check.cast ? 'Correct! Your line is free: cast away.' : check.reset && mayLay ? `Correct! ${collect()} ${setUp()}` : `Correct! ${collect()}`;
        } else {
          recordSignal(db!, { userId: uid, kind: 'check_wrong', now, delayMs: now - check.askedAt, live: liveNow });
          if (++check.wrong >= tc.tries) {
            console.log(`[FISH] ${me} answered "${answer}" to a trap check in ${chan}`);
            reply = failCheck(d, uid, check, 'wrong', now);
            after = { laidUntil: null };
          } else {
            const left = tc.tries - check.wrong;
            reply = `Not quite! ${left} ${left === 1 ? 'try' : 'tries'} left, ${span(check.until - now)} to go: ${check.question}`;
          }
        }
      } else if (operation === 'cancel' && d.trapCheck && !d.trapCheck.cast) {
        // Pulling the traps to dodge the question used to cost only the haul (2026-10-14 audit).
        d.lifetime.trap.cancelled++;
        reply = failCheck(d, uid, d.trapCheck, now > d.trapCheck.until ? 'time' : 'cancel', now);
        after = { laidUntil: null };
      } else if (operation === 'cancel') {
        if (!d.trap.active) return "You cannot cancel your fishing traps as you don't have them set up!";
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
        delete d.trapCheck;
        after = { laidUntil: null };
        d.lifetime.trap.cancelled++;
        reply = "You have successfully retrieved your traps before they filled up. You don't get any junk or fish.";
      } else if (!d.trap.active) {
        reply = setUp();
      } else if (now <= d.trap.end) {
        return `Your traps are not fully loaded yet! They will be ready to harvest in ${span(d.trap.end - now)}. If you wish to get rid of them immediately, use "${cmd} fish trap cancel", but you will not get any catch from your traps.`;
      } else if (d.trapCheck && now > d.trapCheck.until) {
        // Its timer didn't get to it (a restart): it ends now.
        reply = failCheck(d, uid, d.trapCheck, 'time', now);
        after = { laidUntil: null };
      } else if (d.trapCheck) {
        // Waiting: the same question, and a reset now counts for the answer.
        if (operation === 'reset' && !d.trapCheck.reset) {
          d.trapCheck.reset = true;
          saveFish(db!, uid, d, now);
        }
        return `Your traps are full, but first: ${d.trapCheck.question} ${answerHow} (${span(d.trapCheck.until - now)} left)`;
      } else if (mayAsk && randomInt(1, 100) <= tc.chancePercent) {
        d.trapCheck = askedCheck = { ...makeTrapCheck(operation === 'reset', now, tc.answerSeconds), fine: Math.floor((getUser(db!, uid)?.balance ?? 0) * tc.finePercent / 100) };
        recordSignal(db!, { userId: uid, kind: 'check_asked', now, live: liveNow, detail: 'trap' });
        console.log(`[FISH] ${me} got a trap check in ${chan}: ${d.trapCheck.question}`);
        const stake = tc.finePercent > 0 ? `costs ${tc.finePercent}% of your ${cur} and the catch` : 'loses the catch';
        const tries = tc.tries === 1 ? 'one try' : `${tc.tries} tries`;
        reply = `Your traps are full! Before you pull them up: ${d.trapCheck.question} ${answerHow} You have ${span(tc.answerSeconds * 1000)} and ${tries}; running out ${stake}.`;
      } else if (operation === 'reset') {
        reply = `${collect()} ${setUp()}`;
      } else {
        reply = collect();
      }
      saveFish(db!, uid, d, now);
      return reply;
    });
    // After the transaction, so a replayed or refused message leaves reminders alone.
    // "reset" collects then lays again, which leaves `after` holding the new traps.
    const settled = after as { laidUntil: number | null } | null;
    if (text && settled) syncTrapReminder(settled.laidUntil);
    if (text) say(text, collected ? { kind: 'trap' } : {});
    const asked = askedCheck as TrapCheck | null;
    if (text && asked) timeCheck(uid, asked);
  }

  /**
   * A trap check that ran out: tries or time. The traps come up empty and the player
   * pays the fine. Inside a write transaction; the caller saves `d` and clears the
   * reminder. Returns the reply.
   */
  function failCheck(d: FishData, uid: number, check: TrapCheck, why: 'wrong' | 'time' | 'cancel', now: number): string {
    const tc = g.trapCheck;
    delete d.trapCheck;
    d.lifetime.trap.checksFailed++;
    recordSignal(db!, { userId: uid, kind: 'check_failed', now, live: false, detail: why });
    // A cast check has no haul: the traps (not out, or it couldn't have been asked) stay as they are.
    if (!check.cast) d.trap = { active: false, start: 0, end: 0, duration: 0 };
    const balance = getUser(db!, uid)?.balance ?? 0;
    // Set when it was asked, so $DON moved away since doesn't shrink it; at most what's left.
    const fine = Math.min(balance, check.fine ?? Math.floor(balance * tc.finePercent / 100));
    const left = fine > 0
      ? debitTx(db!, { userId: uid, amount: fine, reason: 'game:fish_trap_check', actor: `chat:${me}`, note: `${why}: ${check.question}`, now }).balance
      : balance;
    console.log(`[FISH] ${me} failed a ${check.cast ? 'cast' : 'trap'} check in ${chan} (${why === 'time' ? 'out of time' : why === 'cancel' ? 'pulled the traps' : 'out of tries'}), fined ${fine}`);
    const head = why === 'time' ? "Time's up!" : why === 'cancel' ? 'Pulling your traps doesn\'t dodge the question!' : 'Wrong again!';
    const lost = check.cast ? 'Your line snaps' : 'Your traps come up empty';
    return fine > 0
      ? `${head} ${lost} and you pay a fine of ${groupDigits(fine)} ${cur} (${groupDigits(left)} ${cur} left).`
      : `${head} ${lost}.`;
  }

  /** End `check` when its time runs out, unless it's answered or ended first. */
  function timeCheck(uid: number, check: TrapCheck): void {
    const key = `${chan}:${uid}`;
    clearTimeout(checkTimers.get(key));
    const timer = setTimeout(() => {
      checkTimers.delete(key);
      try {
        const text = runWrite(db!, () => {
          const d = loadFish(db!, uid);
          if (!d?.trapCheck || d.trapCheck.askedAt !== check.askedAt) return null;
          const now = Date.now();
          const reply = failCheck(d, uid, d.trapCheck, 'time', now);
          saveFish(db!, uid, d, now);
          return reply;
        });
        if (!text) return;
        syncTrapReminder(null);
        void say(text);
      } catch (err) {
        console.error(`[FISH] Ending ${me}'s trap check in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, Math.max(0, check.until - Date.now()) + 1000);
    timer.unref?.();
    checkTimers.set(key, timer);
  }

  // ── sell ──
  function sell(parts: string[], uid: number): void {
    // Short forms: "s a f j" is "sell all fish junk", "s d f" is "sell duplicate fish".
    const specifier = long(parts[0], SELL_SHORT);
    const text = once(now => {
      const d = loadFish(db!, uid);
      if (!d || (d.catch.fish === 0 && d.catch.junk === 0)) return 'You have no items to sell!';
      // The seller's reel raises what their fish fetch, whenever they were caught.
      const value = currentReel(d, g)?.valueMultiplier ?? 1;
      const pay = (gained: number): number => gained > 0
        ? creditTx(db!, { userId: uid, username: me, amount: gained, reason: 'game:fish_sell', actor: `chat:${me}`, now })
        : getUser(db!, uid)?.balance ?? 0;

      if (specifier === 'all' || specifier === 'duplicate') {
        // Naming the type stays required, as in supibot, so nobody sells everything
        // by accident; naming both ("all fish junk") sells both.
        const types = [...new Set(parts.slice(1).map(w => w.toLowerCase()).map(w => long(w, TYPE_SHORT)))];
        if (types.length === 0 || !types.every(t => t === 'fish' || t === 'junk')) {
          return "When selling all, you must provide a type! You don't wanna sell all of your stuff by accident, right? Use fish, junk, or both: fish junk";
        }
        const threshold = specifier === 'all' ? 0 : 1;
        const prefix = specifier === 'duplicate' ? 'duplicate ' : '';
        let gained = 0;
        const soldByType: string[] = [];
        for (const type of types as CatchType[]) {
          let sold = 0;
          for (const item of ITEMS) {
            if (item.type !== type) continue;
            const have = d.catch.types[item.name] ?? 0;
            if (have <= threshold) continue;
            const n = have - threshold;
            sold += n;
            // "duplicate" keeps the biggest of each, the one worth showing off.
            gained += takeItems(d, item, n, g, specifier === 'duplicate', value);
          }
          if (sold > 0) soldByType.push(`${sold} ${prefix}${TYPE_DESCRIPTIONS[type]}`);
        }
        if (soldByType.length === 0) return `You have no ${prefix}${types.map(t => TYPE_DESCRIPTIONS[t as CatchType]).join(' or ')} to sell!`;
        d.lifetime.coins += gained;
        const balance = pay(gained);
        saveFish(db!, uid, d, now);
        return `You sold ${soldByType.join(' and ')} for a grand total of ${gained} ${cur} - now you have ${balance} ${cur}`;
      }

      // One or more items, each with an optional count: "🐟 3 🦐" or "🐟🦐🦀".
      const list = parseSellList(parts);
      if ('error' in list) {
        return list.error === 'unknown'
          ? `You provided an unknown item type! Use one of: ${ITEMS.map(i => i.name).join('')}`
          : 'You provided an invalid amount of items to sell! Put a whole number after a single emoji, like 🐟 3 🦐 2.';
      }
      if (list.items.length === 0) return `Tell me what to sell, like ${cmd} fish sell 🐟 🦐 or ${cmd} fish sell all fish`;
      let gained = 0;
      const soldParts: string[] = [];
      const missing: string[] = [];
      for (const { item, n: requested } of list.items) {
        const have = d.catch.types[item.name] ?? 0;
        if (have === 0) {
          missing.push(item.name);
          continue;
        }
        const n = Math.min(have, requested);
        gained += takeItems(d, item, n, g, false, value);
        soldParts.push(`${item.name}${n > 1 ? ` x${n}` : ''}`);
      }
      if (soldParts.length === 0) return `You have no ${missing.join('')} to sell!`;
      d.lifetime.coins += gained;
      const balance = pay(gained);
      saveFish(db!, uid, d, now);
      const skipped = missing.length ? ` (you have no ${missing.join('')})` : '';
      return `Sold your ${soldParts.join(', ')} for ${gained} ${cur} - now you have ${balance} ${cur}${skipped}`;
    });
    if (text) say(text);
  }

  // ── buy ──
  /** What a reel does, e.g. "fish odds ×1.25, rarer fish ×2, fish value ×1.25". */
  function reelEffects(r: FishReelSetting): string {
    const parts: string[] = [];
    if (r.oddsMultiplier !== 1) parts.push(`fish odds ×${r.oddsMultiplier}`);
    if (r.rarityMultiplier !== 1) parts.push(`rarer fish ×${r.rarityMultiplier}`);
    if (r.valueMultiplier !== 1) parts.push(`fish value ×${r.valueMultiplier}`);
    return parts.join(', ') || 'no bonus';
  }

  /**
   * Reels, bought in order. Plain "buy" only says what's next, so nobody spends a
   * fortune by mistake; "buy reel" buys it.
   */
  function buy(what: string, uid: number): void {
    if (what === 'hook' || what === 'guard') {
      if (!g.steal.enabled && !tester) return void say("Nobody steals fish here, so there's no need for that.");
      return what === 'hook' ? buyHook(uid) : buyGuard(uid);
    }
    const thieves = g.steal.enabled
      ? ` For thieves: a 🪝 grappling hook (${groupDigits(g.steal.hookPrice)} ${cur}, ${tries(g.steal.hookUses)}) with ${cmd} fish buy hook; against them, ${cmd} fish buy guard.`
      : '';
    if (what !== 'reel' && g.reels.length === 0) return void say(`There aren't any reels at the fishing gear shop... yet.${thieves}`);
    if (what !== 'reel') {
      const d = loadFish(db!, uid);
      const have = currentReel(d, g);
      const level = Math.min(d?.reel ?? 0, g.reels.length);
      const owned = have ? `You fish with the ${have.name} reel (${reelEffects(have)}). ` : '';
      if (level >= g.reels.length) return void say(`${owned}That's the best reel in the shop!${thieves}`);
      const next = g.reels[level];
      return void say(`${owned}Next up: the ${next.name} reel for ${groupDigits(next.price)} ${cur} (${reelEffects(next)}). Buy it with ${cmd} fish buy reel${thieves ? `.${thieves}` : ''}`);
    }
    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      const level = Math.min(d.reel ?? 0, g.reels.length);
      if (level >= g.reels.length) return "You already have the best reel in the shop!";
      const next = g.reels[level];
      const balance = getUser(db!, uid)?.balance ?? 0;
      if (balance < next.price) {
        return `The ${next.name} reel costs ${groupDigits(next.price)} ${cur} and you have ${groupDigits(balance)} ${cur}.`;
      }
      const after = next.price > 0
        ? debitTx(db!, { userId: uid, amount: next.price, reason: 'game:fish_reel', actor: `chat:${me}`, note: next.name, now }).balance
        : balance;
      d.reel = level + 1;
      saveFish(db!, uid, d, now);
      return `You bought the ${next.name} reel for ${groupDigits(next.price)} ${cur}! ${reelEffects(next)}. You have ${groupDigits(after)} ${cur} left.`;
    });
    if (text) say(text);
  }

  const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`;

  /** A grappling hook: stealing needs one. One at a time, used up a try at a time. */
  function buyHook(uid: number): void {
    const st = g.steal;
    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if ((d.hook ?? 0) > 0) return `You already have a 🪝 grappling hook with ${tries(d.hook!)} left.`;
      const balance = getUser(db!, uid)?.balance ?? 0;
      if (balance < st.hookPrice) return `A 🪝 grappling hook costs ${groupDigits(st.hookPrice)} ${cur} and you have ${groupDigits(balance)} ${cur}.`;
      const after = st.hookPrice > 0
        ? debitTx(db!, { userId: uid, amount: st.hookPrice, reason: 'game:fish_hook', actor: `chat:${me}`, now }).balance
        : balance;
      d.hook = st.hookUses;
      saveFish(db!, uid, d, now);
      return `You bought a 🪝 grappling hook for ${groupDigits(st.hookPrice)} ${cur}: ${tries(st.hookUses)} at ${cmd} fish steal @user. Every try uses one, caught or not. You have ${groupDigits(after)} ${cur} left.`;
    });
    if (text) say(text);
  }

  /**
   * A guard: priced on what the fish held right now are worth, and adds its hours
   * to any guard still running.
   */
  function buyGuard(uid: number): void {
    const st = g.steal;
    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      const worth = heldFishValue(d, g);
      if (worth <= 0) return "You don't have any fish to guard!";
      const price = Math.max(st.guardMinimum, Math.round(worth * st.guardPercent / 100));
      const balance = getUser(db!, uid)?.balance ?? 0;
      if (balance < price) return `Guarding your fish costs ${groupDigits(price)} ${cur} right now (${st.guardPercent}% of what they're worth) and you have ${groupDigits(balance)} ${cur}.`;
      const after = price > 0
        ? debitTx(db!, { userId: uid, amount: price, reason: 'game:fish_guard', actor: `chat:${me}`, now }).balance
        : balance;
      const extended = (d.guardUntil ?? 0) > now;
      d.guardUntil = Math.max(now, d.guardUntil ?? 0) + st.guardHours * 3_600_000;
      saveFish(db!, uid, d, now);
      // No time in the reply: chat is public, and a guard's time left is the owner's secret.
      return extended
        ? `You paid your guard ${groupDigits(price)} ${cur} to stay on longer. You have ${groupDigits(after)} ${cur} left.`
        : `You hired a guard for ${groupDigits(price)} ${cur}. Your fish are safe from thieves for now. You have ${groupDigits(after)} ${cur} left.`;
    });
    if (text) say(text);
  }

  // ── give ──
  /**
   * `fish give @user 🦭 [count]`: one kind of fish or junk to any other viewer the bot
   * knows, oldest sized ones first. Free; games.giveCooldownSeconds between gives.
   */
  function give(parts: string[], uid: number): void {
    if (!g.giveEnabled) return void say('Fish gifts are switched off here.');
    const usage = `Give what to whom? ${cmd} fish give @user shark (an emoji or a name, and a number for more than one)`;
    // The viewer anywhere: "@faye 2 sharks" or "🦈 2 @faye"; without an @, the first word.
    const at = parts.findIndex(p => p.startsWith('@'));
    const who = at >= 0 ? at : 0;
    const name = parseUsername(parts[who]);
    if (!name) return void say(usage);
    const list = parseSellList(parts.filter((_, i) => i !== who));
    if ('error' in list) {
      return void say(list.error === 'unknown'
        ? `That's not an item I know! Use its emoji or a name like fish, shark, dino or boot.`
        : `Name the fish and how many: ${cmd} fish give @user 2 sharks`);
    }
    if (list.items.length === 0) return void say(usage);
    if (list.items.length > 1) return void say('One kind at a time, like 🐟 3.');
    const { item, n } = list.items[0];
    const nameLc = name.toLowerCase();
    if (isBotSender(name) || SYSTEM_BOTS.has(nameLc)) return void say("Bots don't keep fish. Find a human!");
    const to = findUserByName(db!, nameLc);
    if (!to) return void say('No such user exists!');
    if (to.user_id === uid) return void say("You can't give fish to yourself!");
    if (offLimits(to.user_id, nameLc)) return void say(`${to.username} can't take fish.`);
    const wait = (lastGive.get(`${chan}|${meLc}`) ?? 0) + g.giveCooldownSeconds * 1000 - Date.now();
    if (wait > 0) return void say(`You can give fish again in ${span(wait)}.`);

    const text = once(now => {
      const d = loadFish(db!, uid);
      const have = d?.catch.types[item.name] ?? 0;
      if (!d || have === 0) return `You don't have any ${item.name} to give!`;
      if (have < n) return `You only have ${have} ${item.name}.`;
      // Anyone the bot knows can take a gift, fished before or not: their collection starts here.
      const r = loadFish(db!, to.user_id) ?? initialData();
      const moved = giveItems(d, r, item, n);
      saveFish(db!, uid, d, now);
      saveFish(db!, to.user_id, r, now);
      lastGive.set(`${chan}|${meLc}`, now);
      console.log(`[FISH] ${me} gave ${moved} ${item.name} to ${to.username} in ${chan}`);
      return `🎁 You gave @${to.username} ${moved > 1 ? `${moved} ` : ''}${item.name}! You have ${have - moved} left.`;
    });
    if (text) say(text);
  }

  // ── steal ──
  /**
   * Reach for one random fish the target has held past the grace time, weighted by
   * how many of each they hold. It works by that fish's rarity; otherwise the thief
   * is caught and fined on top of the fee (both go nowhere). Every try uses one hook
   * try. A guard, or a thief who couldn't pay for the target's costliest fish, costs
   * one hook use and nothing else.
   */
  async function steal(targetRaw: string | undefined, uid: number): Promise<void> {
    const st = g.steal;
    if (!st.enabled && !tester) return void say("Nobody steals fish here. Go catch your own!");
    if (!tester && !(await liveOk(st.onlyWhileLive))) return;
    const name = parseUsername(targetRaw);
    if (!name) return void say(`Steal from whom? ${cmd} fish steal @user`);
    const nameLc = name.toLowerCase();
    if (!tester && (isBotSender(name) || SYSTEM_BOTS.has(nameLc))) return void say("My fish are bolted down. Nice try!");
    const victim = findUserByName(db!, nameLc);
    if (!victim) return void say('No such user exists!');
    if (victim.user_id === uid) return void say("You can't steal from yourself!");
    if (nameLc === chan || (!tester && offLimits(victim.user_id, nameLc))) return void say(`${victim.username}'s fish are off limits.`);

    let overlay: { kind: OverlayKind; item: string } | null = null;
    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if (!hasFishedBefore(d)) return 'Go fishing at least once before you try stealing!';
      if ((d.hook ?? 0) <= 0) return `You need a 🪝 grappling hook to steal. Get one with ${cmd} fish buy hook (${groupDigits(st.hookPrice)} ${cur} for ${tries(st.hookUses)}).`;
      if (!tester && d.readyTimestamp !== 0 && now < d.readyTimestamp) return `Hol' up partner! You can go fishing or stealing again in ${span(d.readyTimestamp - now)}!`;
      const v = loadFish(db!, victim.user_id);
      const log = (outcome: string, item: string | null, cm: number | null, money: { worth: number; fee: number; fine: number } | null = null) =>
        db!.prepare('INSERT INTO steals (ts, thief_id, victim_id, name, cm, outcome, worth, fee, fine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(now, uid, victim.user_id, item, cm, outcome, money?.worth ?? null, money?.fee ?? null, money?.fine ?? null);

      if (v && (v.guardUntil ?? 0) > now) {
        d.hook = (d.hook ?? 1) - 1;
        d.lifetime.steal.blocked++;
        saveFish(db!, uid, d, now);
        log('guarded', null, null);
        const left = d.hook > 0 ? `${tries(d.hook)} left on it` : "that was its last try";
        return `@${victim.username} has a guard watching their fish! Your 🪝 hook bounced off (${left}).`;
      }
      const went = "outcome IN ('stolen', 'caught')";
      const lastOnVictim = (db!.prepare(`SELECT MAX(ts) AS t FROM steals WHERE victim_id = ? AND ${went}`).get(victim.user_id) as { t: number | null }).t;
      if (!tester && lastOnVictim !== null && now - lastOnVictim < st.protectMinutes * 60_000) {
        return `${victim.username} is still on alert after the last attempt. Try again in ${span(lastOnVictim + st.protectMinutes * 60_000 - now)}.`;
      }
      const lastPair = (db!.prepare(`SELECT MAX(ts) AS t FROM steals WHERE thief_id = ? AND victim_id = ? AND ${went}`).get(uid, victim.user_id) as { t: number | null }).t;
      if (!tester && lastPair !== null && now - lastPair < 86_400_000) {
        return `You already tried ${victim.username} today. You can try them again in ${span(lastPair + 86_400_000 - now)}.`;
      }
      const pool = v ? stealableFish(db!, v, victim.user_id, now, st.graceMinutes * 60_000) : [];
      if (!v || !pool.length) return `${victim.username} has no fish you can get your hook into right now.`;
      // The thief must be able to pay for the worst the hook could grab: the fee and the
      // fine on the target's most valuable fish. Short of that, the try costs a hook use.
      const balance = getUser(db!, uid)?.balance ?? 0;
      const needed = worstStealCharges(v, g, pool);
      if (balance < needed) {
        d.hook = (d.hook ?? 1) - 1;
        saveFish(db!, uid, d, now);
        log('short', null, null);
        const left = d.hook > 0 ? `${tries(d.hook)} left on it` : 'that was its last try';
        return `You fumbled your 🪝 hook (${left}). To try ${victim.username} you need ${groupDigits(needed)} ${cur} on hand: the fee and the fine for the costliest fish they hold.`;
      }

      // The attempt goes ahead: a hook use and the fishing cooldown are spent whatever happens, and the fee once the fish is known.
      d.hook = (d.hook ?? 1) - 1;
      d.readyTimestamp = now + g.catchCooldownMinutes * 60_000;
      d.lifetime.steal.attempts++;
      let r = randomInt(1, pool.reduce((sum, p) => sum + p.n, 0));
      const item = pool.find(p => (r -= p.n) <= 0)!.item;
      const picked = pickHeld(v, item);
      const worth = sellPrice(item, g, picked.held);
      const chance = stealChance(g, item.name);
      const { fee, fine } = stealCharges(g, worth, chance);
      if (fee > 0) debitTx(db!, { userId: uid, amount: fee, reason: 'game:fish_steal', actor: `chat:${me}`, note: `${victim.username} ${item.name}`, now });
      const cooldown = `${g.catchCooldownMinutes}m cooldown`;

      // Luck raises the roll's odds, not the fine's.
      if (randomInt(1, 1000) <= Math.round(stealRollChance(g, item.name) * 10)) {
        moveFish(v, d, item, picked, true);
        d.lifetime.steal.stolen++;
        v.lifetime.steal.lost++;
        saveFish(db!, uid, d, now);
        saveFish(db!, victim.user_id, v, now);
        log('stolen', item.name, picked.held?.cm ?? null, { worth, fee, fine: 0 });
        overlay = { kind: 'steal', item: item.name };
        const size = picked.held ? ` (${picked.held.cm} cm)` : '';
        const left = d.hook > 0 ? `${tries(d.hook)} left on your hook` : 'your hook is used up';
        return `🪝 You snuck up on @${victim.username} and made off with their ✨${item.name}✨${size}, worth ${groupDigits(worth)} ${cur}! (${groupDigits(fee)} ${cur} fee, ${left}, ${cooldown})`;
      }

      if (fine > 0) debitTx(db!, { userId: uid, amount: fine, reason: 'game:fish_steal_fine', actor: `chat:${me}`, note: victim.username, now });
      d.lifetime.steal.caught++;
      saveFish(db!, uid, d, now);
      log('caught', item.name, picked.held?.cm ?? null, { worth, fee, fine });
      overlay = { kind: 'caught', item: item.name };
      const hookLeft = d.hook > 0 ? `${tries(d.hook)} left on your 🪝 hook` : 'your 🪝 hook is used up';
      return `🚨 @${victim.username} caught you red-handed reaching for their ✨${item.name}✨! You paid a ${groupDigits(fine)} ${cur} fine on top of the ${groupDigits(fee)} ${cur} fee. (${hookLeft}, ${cooldown})`;
    });
    const out = overlay as { kind: OverlayKind; item: string } | null;
    if (text) say(text, out ?? {});
  }

  // ── duel ──
  /**
   * A duel's own chat line. The challenge has to reach the one challenged and the
   * result both of them, so these go to chat whatever the reply settings say.
   */
  const announce = async (text: string): Promise<void> => {
    try {
      await client.say(channel, text);
    } catch (err) {
      console.error(`[FISH] Duel line in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /** Whether duels are open here and now; says so, or stays silent like a cast at the wrong time. */
  const duelsOpen = async (): Promise<boolean> => {
    if (tester) return true;
    if (!g.duel.enabled) {
      say("There are no fish duels here.");
      return false;
    }
    return liveOk(g.duel.onlyWhileLive);
  };
  const stakeLine = (stake: DuelStake): string =>
    stake.kind === 'wager' ? `Stake: ${groupDigits(stake.amount)} ${cur} each.`
      : stake.kind === 'keeps' ? "For keeps: the winner takes the loser's fish!"
        : 'For glory only.';

  /** Challenge someone: `duel @user [fish | random] [amount | keeps]`. */
  async function duel(words: string[], uid: number): Promise<void> {
    const du = g.duel;
    if (!(await duelsOpen())) return;
    const usage = `Usage: ${cmd} fish duel @user [fish | random] [amount | keeps]`;
    const nameWord = words.find(w => w.startsWith('@')) ?? words[0];
    const name = parseUsername(nameWord);
    if (!name) return void say(usage);
    const nameLc = name.toLowerCase();
    if (isBotSender(name) || SYSTEM_BOTS.has(nameLc)) return void say("My fish don't fight. They're lovers.");
    const rival = findUserByName(db!, nameLc);
    if (!rival) return void say('No such user exists!');
    if (rival.user_id === uid) return void say("You can't duel yourself!");
    if (!tester && offLimits(rival.user_id, nameLc)) return void say(`${rival.username} doesn't duel.`);
    const now = Date.now();
    const mine = challengeBy(chan, uid, now);
    if (mine) return void say(`You already challenged ${mine.target}. Wait for their answer, or take it back with ${cmd} fish deny.`);
    if (challengeFor(chan, uid, now)) return void say(`You have a challenge to answer first: ${cmd} fish accept or ${cmd} fish deny.`);
    if (challengeFor(chan, rival.user_id, now) || challengeBy(chan, rival.user_id, now)) return void say(`${rival.username} is busy with another duel.`);
    const cdKey = `${chan}:${meLc}`;
    const wait = (lastChallenge.get(cdKey) ?? 0) + du.cooldownSeconds * 1000 - now;
    if (!tester && wait > 0) return void say(`You can challenge someone again in ${span(wait)}.`);

    const rest = words.filter(w => w !== nameWord);
    const others = rest.filter(w => fishNamed([w]) === undefined && !wantsRandom([w]));
    if (others.length > 1) return void say(usage);
    const word = others[0]?.toLowerCase();
    const keeps = word === 'keeps' || word === 'keep' || word === 'k';
    if (keeps && !du.allowKeeps) return void say('Duels for keeps are off here. Name an amount, or nothing at all.');
    const mineD = loadFish(db!, uid);
    const theirsD = loadFish(db!, rival.user_id);
    // `random` sends any fish held; the pick is made now and named in the challenge, like a fish asked for.
    const fishName = wantsRandom(rest) ? randomFish(mineD) : fishNamed(rest);
    const strongest = pickFighter(mineD, g, fishName);
    if (!strongest) return void say(fishName ? `You don't have a ${fishName} to send.` : 'You need a fish to duel with. Go catch one!');
    if (!pickFighter(theirsD, g)) return void say(`${rival.username} has no fish to fight with.`);
    // For keeps, the fish sent is one they hold a fish close in value to: the strongest such, of the kind named if one was.
    const fighter = keeps ? pickForKeeps(mineD, theirsD, g, fishName) : strongest;
    if (!fighter) {
      return void say(`For keeps, both fish must be close in value, and none of your ${fishName ?? 'fish'} is close to any fish ${rival.username} has.`);
    }

    let stake: DuelStake = { kind: 'friendly' };
    if (keeps) {
      stake = { kind: 'keeps' };
    } else if (word !== undefined) {
      const balance = getUser(db!, uid)?.balance ?? 0;
      const amount = parseBet(word, balance);
      if (amount === null || amount <= 0) return void say(usage);
      if (du.maxWager > 0 && amount > du.maxWager) return void say(`The most you can stake on a fish duel is ${groupDigits(du.maxWager)} ${cur}.`);
      if (amount > balance) return void say(`You only have ${groupDigits(balance)} ${cur}.`);
      if (rival.balance < amount) return void say(`${rival.username} only has ${groupDigits(rival.balance)} ${cur}.`);
      stake = { kind: 'wager', amount };
    }

    addChallenge(chan, {
      challengerId: uid, challenger: me, targetId: rival.user_id, target: rival.username,
      fish: fighter.item.name, ...(keeps && fighter.held ? { cm: fighter.held.cm } : {}), stake, expiresAt: now + du.expirySeconds * 1000
    }, now);
    lastChallenge.set(cdKey, now);
    console.log(`[FISH] ${me} challenged ${rival.username} to a duel in ${chan} with ${fighter.item.name} (${stake.kind}${stake.kind === 'wager' ? ` ${stake.amount}` : ''})`);
    const keepsNote = stake.kind === 'keeps'
      ? (() => { const w = fishValue(g, fighter); const [lo, hi] = keepsRange(w); return ` It's worth ${groupDigits(w)}: answer with a fish worth ${groupDigits(lo)}–${groupDigits(hi)} (a plain accept sends your closest).`; })()
      : '';
    const text = `⚔️ ${me} challenges you to a fish duel with their ${describe(fighter.fighter)}. ${stakeLine(stake)}${keepsNote} Answer within ${span(du.expirySeconds * 1000)}: ${cmd} fish accept [fish] or ${cmd} fish deny.`;
    pushOverlay(db!, { username: me, kind: 'info', text: `⚔️ challenges ${rival.username} to a fish duel with their ${describe(fighter.fighter)}. ${stakeLine(stake)}` });
    await announce(`@${rival.username} ${text}`);
  }

  /** Fight the duel waiting for this viewer, with their strongest fish or the one they name. */
  async function accept(words: string[], uid: number): Promise<void> {
    if (!(await duelsOpen())) return;
    const c = challengeFor(chan, uid);
    if (!c) return void say('Nobody has challenged you to a fish duel.');
    const random = wantsRandom(words);
    const fishName = random ? undefined : fishNamed(words);
    type Fought = { off: string } | { retry: string } | { text: string; shown: Parameters<typeof overlayDuel>; winner: string; turns: number };
    const fought = once((now): Fought => {
      ensureUserTx(db!, uid, me, now);
      const theirs = loadFish(db!, c.challengerId);
      const keeps = c.stake.kind === 'keeps';
      // For keeps, the very fish named in the challenge; otherwise the biggest of its kind.
      const a = keeps ? sameFish(theirs, g, c.fish, c.cm) : pickFighter(theirs, g, c.fish);
      if (!theirs || !a) return { off: `${c.challenger} no longer has their ${c.fish}, so the duel is off.` };
      const own = loadFish(db!, uid);
      const kind = random ? randomFish(own) : fishName;
      // For keeps, the fish closest in value to theirs, of the kind named if one was, whatever its length.
      const b = keeps ? pickByValue(own, g, fishValue(g, a), kind) : pickFighter(own, g, kind);
      if (!own || !b) return { retry: fishName ? `You don't have a ${fishName} to send.` : 'You have no fish to fight with.' };
      if (keeps && !closeInValue(fishValue(g, a), fishValue(g, b))) {
        const [lo, hi] = keepsRange(fishValue(g, a));
        return { retry: `For keeps, both fish must be close in value: their ${a.item.name} is worth ${groupDigits(fishValue(g, a))} and your closest ${kind ? b.item.name : 'fish'} ${groupDigits(fishValue(g, b))}. Send one worth ${groupDigits(lo)}–${groupDigits(hi)}, or ${cmd} fish deny.` };
      }
      const sides = [theirs, own] as const;
      if (c.stake.kind === 'wager') {
        if ((getUser(db!, c.challengerId)?.balance ?? 0) < c.stake.amount) return { off: `${c.challenger} can't cover the ${groupDigits(c.stake.amount)} ${cur} stake any more, so the duel is off.` };
        const balance = getUser(db!, uid)?.balance ?? 0;
        if (balance < c.stake.amount) return { retry: `The stake is ${groupDigits(c.stake.amount)} ${cur} and you have ${groupDigits(balance)} ${cur}.` };
      }

      const battle = fight(a.fighter, b.fighter);
      const w = battle.winner;
      const l = w === 0 ? 1 : 0;
      const ids = [c.challengerId, uid] as const;
      const names = [c.challenger, me] as const;
      const picks = [a, b] as const;
      sides[w].lifetime.duel.wins++;
      sides[l].lifetime.duel.losses++;
      const id = Number(db!.prepare(
        `INSERT INTO fish_duels (ts, challenger_id, opponent_id, winner_id, challenger_fish, challenger_cm, opponent_fish, opponent_cm, stake, amount, turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(now, ids[0], ids[1], ids[w], a.item.name, a.fighter.cm, b.item.name, b.fighter.cm, c.stake.kind, c.stake.kind === 'wager' ? c.stake.amount : null, battle.turns.length).lastInsertRowid);

      let prize = '';
      if (c.stake.kind === 'wager') {
        const ref = `fishduel:${id}`;
        debitTx(db!, { userId: ids[l], amount: c.stake.amount, reason: 'game:fish_duel', ref, actor: `chat:${me}`, note: names[w], now });
        const balance = creditTx(db!, { userId: ids[w], amount: c.stake.amount, reason: 'game:fish_duel_win', ref, actor: `chat:${me}`, note: names[l], now });
        sides[w].lifetime.duel.coinsWon += c.stake.amount;
        sides[l].lifetime.duel.coinsLost += c.stake.amount;
        prize = ` ${names[w]} takes ${groupDigits(c.stake.amount)} ${cur} and now has ${groupDigits(balance)}.`;
      } else if (c.stake.kind === 'keeps') {
        moveFish(sides[l], sides[w], picks[l].item, picks[l]);
        sides[w].lifetime.duel.fishWon++;
        sides[l].lifetime.duel.fishLost++;
        prize = ` ${names[w]} takes the ${picks[l].item.name}${picks[l].held ? ` (${picks[l].held!.cm} cm)` : ''} for keeps!`;
      }
      saveFish(db!, ids[0], sides[0], now);
      saveFish(db!, ids[1], sides[1], now);

      const left = Math.round(battle.left[w] / picks[w].fighter.hp * 100);
      const how = left >= 70 ? 'crushed' : left >= 30 ? 'beat' : 'barely survived';
      console.log(`[FISH] duel ${id} in ${chan}: ${names[w]} ${picks[w].item.name} beat ${names[l]} ${picks[l].item.name} in ${battle.turns.length} turns (${c.stake.kind}${c.stake.kind === 'wager' ? ` ${c.stake.amount}` : ''})`);
      return {
        text: `⚔️ @${names[w]}'s ${describe(picks[w].fighter)} ${how} @${names[l]}'s ${describe(picks[l].fighter)} in ${battle.turns.length} turns, with ${left}% health left.${prize}`,
        shown: [[names[0], names[1]], [a.fighter, b.fighter], battle, c.stake, cur],
        winner: names[w],
        turns: battle.turns.length
      };
    });
    if (!fought) return;
    if ('retry' in fought) return void say(fought.retry);
    dropChallenge(chan, c);
    if ('off' in fought) return void announce(`@${me} @${c.challenger} ${fought.off}`);
    // With an overlay showing the fight, chat hears who won as it ends there, not before it starts.
    const playing = overlayShowing(db!);
    pushOverlay(db!, { username: fought.winner, kind: 'duel', text: fought.text.replace(/@/g, ''), duel: overlayDuel(...fought.shown) });
    if (!playing) return void announce(fought.text);
    await announce(`⚔️ ${c.challenger} vs ${me}: the fish duel is on! Watch the stream.`);
    // The stream shows the fight streamDelaySeconds behind chat.
    setTimeout(() => void announce(fought.text), playMs(fought.turns) + g.streamDelaySeconds * 1000).unref();
  }

  /** Turn down the duel waiting for this viewer, or take back the one they asked for. */
  async function deny(uid: number): Promise<void> {
    if (!g.duel.enabled && !tester) return void say("There are no fish duels here.");
    const incoming = challengeFor(chan, uid);
    if (incoming) {
      dropChallenge(chan, incoming);
      return void announce(`@${incoming.challenger} ${me} turned down your fish duel.`);
    }
    const own = challengeBy(chan, uid);
    if (!own) return void say('You have no fish duel to turn down.');
    dropChallenge(chan, own);
    say(`You took back your challenge to ${own.target}.`);
  }

  // ── show ──
  function show(parts: string[]): void {
    const [userOrType, optionalType] = parts;
    let showType: CatchType = 'fish';
    // No type asked for shows both, where supibot shows fish only and junk looked missing.
    let bothTypes = true;
    let emojiItem: CatchItem | undefined;
    let targetId = userId;
    let self = true;
    if (userOrType) {
      if (userOrType === 'fish' || userOrType === 'junk') {
        showType = userOrType;
        bothTypes = false;
      } else {
        const name = parseUsername(userOrType);
        if (name && isBotSender(name) && !tester) return void say("I can't go fishing, if water splashed around it would damage my circuits! 😨");
        const found = name ? findUserByName(db!, name.toLowerCase()) : undefined;
        if (!found) return void say('No such user exists!');
        targetId = found.user_id;
        self = found.user_id === userId;
      }
      if (optionalType) {
        if (optionalType === 'fish' || optionalType === 'junk') {
          showType = optionalType;
          bothTypes = false;
        } else {
          emojiItem = ITEMS.find(i => i.name === optionalType);
          if (!emojiItem) return void say('You must provide a proper catch type (fish or junk) or a proper catch emoji!');
        }
      }
    }
    const d = targetId === null ? null : loadFish(db!, targetId);
    const [subject, possessive] = self ? ['You', 'your'] : ['They', 'their'];
    // Holding anything counts too: fish can arrive without a cast (a steal, or a tester's setup).
    if (!d || (!hasFishedBefore(d) && d.catch.fish + d.catch.junk === 0)) return void say(`${subject} have never gone fishing before.`);
    if (emojiItem) {
      const n = d.catch.types[emojiItem.name] ?? 0;
      const itemString = !n ? 'no' : n < 5 ? `${emojiItem.name} `.repeat(n).trim() : `${n}x ${emojiItem.name}`;
      return void say(`${subject} have ${itemString} in ${possessive} collection.`);
    }
    const purse = getUser(db!, targetId!)?.balance ?? 0;
    const listOf = (type: CatchType): string => {
      const list: string[] = [];
      for (const [emoji, count] of Object.entries(d.catch.types)) {
        if (count <= 0) continue;
        if (ITEMS.find(i => i.name === emoji)?.type !== type) continue;
        list.push(count < 5 ? emoji.repeat(count) : `${count}x ${emoji}`);
      }
      return list.join('');
    };
    if (bothTypes) {
      const fish = d.catch.fish ?? 0;
      const junk = d.catch.junk ?? 0;
      // Your own hook's tries. A guard's time is never shown: chat is public, so anyone could read it.
      const gear = self && (d.hook ?? 0) > 0 ? ` Your 🪝 hook has ${tries(d.hook!)} left.` : '';
      if (fish <= 0 && junk <= 0) {
        return void say(`${subject} have no fish or junk in ${possessive} collection, and ${possessive} purse contains ${purse} ${cur}.${gear}`);
      }
      const fishPart = fish > 0 ? `${fish} fish (${listOf('fish')})` : 'no fish';
      const junkPart = junk > 0 ? `${junk} ${junk === 1 ? 'piece' : 'pieces'} of junk (${listOf('junk')})` : 'no junk';
      const reel = currentReel(d, g);
      const reelPart = (reel ? ` ${subject} fish with the ${reel.name} reel.` : '') + gear;
      return void say(`${subject} have ${fishPart} and ${junkPart} in ${possessive} collection.${reelPart} ${subject} also have ${purse} ${cur} in ${possessive} purse.`);
    }
    const amount = d.catch[showType] ?? 0;
    if (amount <= 0) {
      return void say(`${subject} have no ${TYPE_DESCRIPTIONS[showType]} in ${possessive} collection, and ${possessive} purse contains ${purse} ${cur}.`);
    }
    return void say(`${subject} have ${amount} ${TYPE_DESCRIPTIONS[showType]} in ${possessive} collection. Here they are: ${listOf(showType)} ${subject} also have ${purse} ${cur} in ${possessive} purse.`);
  }

  // ── stats ──
  function stats(userOrGlobal: string | undefined): void {
    let targetId: number | null = null;
    let self = false;
    if (userOrGlobal !== 'global') {
      if (userOrGlobal) {
        const name = parseUsername(userOrGlobal);
        if (name && isBotSender(name) && !tester) return void say("I'm sitting on the streamer's table, there's no fish to catch here!");
        const found = name ? findUserByName(db!, name.toLowerCase()) : undefined;
        if (!found) return void say('No such user exists!');
        targetId = found.user_id;
        self = found.user_id === userId;
      } else {
        targetId = userId;
        self = true;
      }
      if (targetId === null || !hasFishedBefore(loadFish(db!, targetId))) {
        return void say(`${self ? 'You' : 'They'} have never gone fishing before.`);
      }
    }
    const j = (p: string, agg = 'SUM') => `COALESCE(${agg}(CAST(json_extract(data, '${p}') AS INTEGER)), 0)`;
    const row = db!.prepare(
      `SELECT ${j('$.lifetime.attempts')} AS attempts, ${j('$.lifetime.baitUsed')} AS bait, ${j('$.lifetime.fish')} AS fish,
         ${j('$.lifetime.junk')} AS junk, ${j('$.lifetime.sold')} AS sold, ${j('$.lifetime.scrapped')} AS scrapped,
         ${j('$.lifetime.trap.times')} AS traps, ${j('$.lifetime.dryStreak', 'MAX')} AS dry, ${j('$.lifetime.luckyStreak', 'MAX')} AS lucky,
         ${j('$.lifetime.steal.stolen')} AS stolen, ${j('$.lifetime.steal.caught')} AS caught,
         ${j('$.lifetime.duel.wins')} AS duelWins, ${j('$.lifetime.duel.losses')} AS duelLosses,
         COALESCE(SUM(CAST(json_extract(data, '$.lifetime.attempts') AS INTEGER) > 0), 0) AS anglers
       FROM fish ${targetId === null ? '' : 'WHERE user_id = ?'}`
    ).get(...(targetId === null ? [] : [targetId])) as Record<string, number>;
    const prefix = targetId === null ? 'Global' : self ? 'Your' : 'Their';
    const anglers = targetId === null ? ` anglers: ${groupDigits(row.anglers)};` : '';
    say(`${prefix} fishing stats → attempts: ${groupDigits(row.attempts)};${anglers} caught fish: ${groupDigits(row.fish)}; caught junk: ${groupDigits(row.junk)}; traps set up: ${groupDigits(row.traps)}; bait used: ${groupDigits(row.bait)}; fish sold: ${groupDigits(row.sold)}; junk scrapped: ${groupDigits(row.scrapped)}; worst dry streak: ${groupDigits(row.dry)}; best lucky streak: ${groupDigits(row.lucky)}${g.steal.enabled ? `; fish stolen: ${groupDigits(row.stolen)}; caught stealing: ${groupDigits(row.caught)}` : ''}${g.duel.enabled ? (targetId === null ? `; fish duels fought: ${groupDigits(row.duelWins)}` : `; fish duels won: ${groupDigits(row.duelWins)}, lost: ${groupDigits(row.duelLosses)}`) : ''}.`);
  }

  // ── top ──
  function top(type: string = 'fish'): void {
    const board = BOARDS.get(type);
    if (!board) return void say(`Invalid leaderboard type provided! Use one of: ${[...BOARDS.keys()].join(', ')}`);
    const rows = topRows(db!, board);
    const groups = new Map<number, { rank: number; names: string[] }>();
    rows.forEach((r, i) => {
      const grp = groups.get(r.value);
      if (grp) grp.names.push(r.username);
      else groups.set(r.value, { rank: i + 1, names: [r.username] });
    });
    const parts = [`Top 10 ${board.name}:`, ...[...groups.entries()].map(([value, grp]) => `Rank #${grp.rank} (${value}): ${grp.names.join(' ')}`)];
    if (userId !== null && !rows.some(r => r.user_id === userId)) {
      const d = loadFish(db!, userId);
      if (d) {
        const value = board.value(d, getUser(db!, userId)?.balance ?? 0);
        if (typeof value === 'number') parts.push(`Your rank is: #${rankOf(db!, board, value)} (${value})`);
      }
    }
    say(parts.join(' '));
  }

  try {
    switch (sub) {
      case 'buy':
        if (g.reels.length === 0 && !g.steal.enabled) return void say("There isn't anything you can buy at the fishing gear shop... yet.");
        if (userId === null || excluded) return ignore('no account or excluded');
        return buy(long((rest[0] ?? '').toLowerCase(), BUY_SHORT), userId);
      case 'show':
        return show([long(rest[0], TYPE_SHORT), long(rest[1], TYPE_SHORT), ...rest.slice(2)].filter((w): w is string => w !== undefined));
      case 'stats':
        return stats(long(rest[0], STATS_SHORT));
      case 'top':
        return top(long(rest[0], BOARD_SHORT));
      case 'sell':
        if (userId === null || excluded) return ignore('no account or excluded');
        return sell(rest, userId);
      case 'trap':
        if (userId === null || excluded) return ignore('no account or excluded');
        return await trap(long((rest[0] ?? '').toLowerCase(), TRAP_SHORT), userId);
      case 'answer':
        if (userId === null || excluded) return ignore('no account or excluded');
        // Only a waiting question skips the cooldown (checkAnswer, above).
        if (!loadFish(db, userId)?.trapCheck && cooldown(meLc)) return;
        return await trap('answer', userId, rest.join(' ').trim() || undefined);
      case 'steal':
        if (userId === null || excluded) return ignore('no account or excluded');
        return await steal(rest[0], userId);
      case 'give':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = true;
        return give(rest, userId);
      case 'duel':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = g.duel.enabled;
        return await duel(rest, userId);
      case 'accept':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = g.duel.enabled;
        return await accept(rest, userId);
      case 'deny':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = g.duel.enabled;
        return await deny(userId);
      case 'reel':
        if (userId === null || excluded) return ignore('no account or excluded');
        return reelIn(rest[0], userId);
      case 'bigbite':
        if (tags.isBroadcaster || isBotOwner(me)) return streamerBite(rest[0]);
        if (userId === null) return ignore('no account');
        return testBite(userId);
      default:
        if (userId === null || excluded) return ignore('no account or excluded');
        return await cast(long(rest[0], BAIT_SHORT), userId);
    }
  } catch (err) {
    console.error(`[FISH] ${me} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
