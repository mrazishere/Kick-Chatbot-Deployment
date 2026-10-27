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
 *          $don fish trap [cancel|reset|lift] [time]    (also net, trawl; time: 90, 90m, 2h, 1h30m;
 *                                                         lift pulls them up early with what they caught so far)
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

import { anthropicFetch } from '../health-alerts';
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
import { bestEmote, broadcasterIdFor, emoteImages, withKickEmotes } from '../community/emotes';
import { OverlayKind, overlayHealth, overlayOff, overlayShowing, pushOverlay, requestOverlayReload, setOverlayOff } from '../community/fish-overlay';
import { addChallenge, challengeBy, challengeFor, closeInValue, describe, fighterOf, describeTeam, dropChallenge, fight, findTeam, fishSpecs, fishNamed, heldFish, TYPE_EMOJI, isLength, specText, splitLengths, fishValue, keepsRange, overlayDuel, overlayTeamDuel, pickByValue, pickFighter, pickForKeeps, pickTeam, sameFish, playMs, randomFish, switchesIn, teamFight, teamSizeOf, teamValue, wantsRandom, type Challenge, type DuelStake, type OverlayDuel, type Picked } from '../community/fish-duel';
import { parseBet } from './points';
import { answerMatches, makeTrapCheck, type TrapCheck } from '../community/trap-check';
import { wheelBusy } from '../community/wheel-state';
import { recordSignal } from '../community/cheat-signals';
import { addTrade, dropTrade, sideText, tradeBy, tradeFor, type TradeItem, type TradeOffer, type TradeSide } from '../community/fish-trade';
import { BITE_TOO_FAST_MS, STREAM_GRACE_MS, biteFor, canBite, channelBite, channelHasBite, codeMatches, getAway, nextPull, pickChatter, recordBite, rewardSnipeFails, snipeBite, snipeOpen, startBite, takeBite, type BiteContext } from '../community/big-bite';
import {
  addItem, itemByWord, giveItems, baitPrice, baitRoll, currentReel, heldFishValue, freshCatches, landsFish, moveFish, pickHeld, stealableFish, stealCharges, stealRollChance, worstStealCharges, parseSellList, takeSized, addXp, levelCost, levelOf, MAX_LEVEL, capOf, emoteWord, isWordName, nearCap, overflow, CatchItem, CatchType, FAILURE_EMOTES, FishData, findBait, hasFishedBefore, initialData, rarityOf, recordCatch,
  ITEMS, JUNK_MESSAGES, loadFish, MISS_DELAY_MS, pick, randomInt, rollCatch, saveFish, sellPrice, STORY_STYLES, SUCCESS_EMOTES,
  takeItems, TYPE_DESCRIPTIONS, weightedCatch, type HeldFish
} from '../community/fishing';

const cooldown = makeCooldown(5000);
/** When each viewer last gave fish, by "channel|name" (games.giveCooldownSeconds). */
const lastGive = new Map<string, number>();
/** When each viewer last challenged someone to a fish duel, by channel and name. */
const lastChallenge = new Map<string, number>();
const pointer = makeCooldown(60_000);
/** The timer that ends each waiting trap check when its time runs out, by channel and user id. */
const checkTimers = new Map<string, NodeJS.Timeout>();

export const SUBCOMMANDS: Record<string, 'buy' | 'sell' | 'show' | 'stats' | 'top' | 'trap' | 'steal' | 'give' | 'trade' | 'duel' | 'accept' | 'deny' | 'reel' | 'bigbite' | 'answer' | 'remove' | 'feed' | 'add' | 'overlay'> = {
  buy: 'buy', b: 'buy', sell: 'sell', s: 'sell',
  show: 'show', sh: 'show', count: 'show', display: 'show', collection: 'show',
  stats: 'stats', st: 'stats', top: 'top', tp: 'top', leaderboard: 'top',
  trap: 'trap', t: 'trap', net: 'trap', trawl: 'trap',
  steal: 'steal', sl: 'steal', rob: 'steal',
  give: 'give', gv: 'give', gift: 'give',
  trade: 'trade', tr: 'trade', swap: 'trade', offer: 'trade',
  // Level a fish up by feeding it others.
  feed: 'feed', fd: 'feed', eat: 'feed', evolve: 'feed',
  // The streamer or the bot owner: take fish off a viewer.
  remove: 'remove', rm: 'remove', confiscate: 'remove',
  // The streamer or the bot owner: hand a viewer fish or junk.
  add: 'add', ad: 'add', grant: 'add',
  duel: 'duel', d: 'duel', battle: 'duel', fight: 'duel', accept: 'accept', a: 'accept', deny: 'deny', dn: 'deny', decline: 'deny',
  reel: 'reel', r: 'reel',
  // A trap check's answer (community/trap-check.ts).
  answer: 'answer', ans: 'answer',
  // The streamer or the bot owner: a big bite now, on a random active chatter, the one named, or "me".
  // Testers (debugFishTesters): one on yourself.
  bigbite: 'bigbite', bb: 'bigbite',
  // Mods, the streamer and the bot owner: the overlay isn't on stream, so replies go to chat and big bites pause.
  overlay: 'overlay', ov: 'overlay'
};


/**
 * Fish asked for by kind, length and count, as sell and remove read them: "🦕 42cm 44cm 🦈
 * 72cm 🐟 3" is a 🦕 of each length, that 🦈, and three 🐟 (oldest first). A count after a
 * length is more of that length ("🦕 42cm 2").
 */
interface FishPick { item: CatchItem; n: number; cm?: number; counted: boolean }

function parsePicks(parts: string[]): { picks: FishPick[] } | { error: 'order' | 'length' | 'amount' | 'unknown' } {
  const picks: FishPick[] = [];
  // A length typed first ("1cm 🦈") goes with the fish named right after it.
  let leading: number | null = null;
  for (const w of splitLengths(parts)) {
    const last = picks[picks.length - 1];
    if (isLength(w)) {
      if (!last) {
        if (leading !== null) return { error: 'order' };
        leading = parseInt(w, 10);
        continue;
      }
      if (last.item.type !== 'fish') return { error: 'length' };
      const cm = parseInt(w, 10);
      // The kind's first length is that fish; each one after is another of the kind.
      if (last.cm === undefined && !last.counted && last.n === 1) last.cm = cm;
      else picks.push({ item: last.item, n: 1, cm, counted: false });
      continue;
    }
    const count = /^x?(\d+)x?$/i.exec(w);
    if (count) {
      if (!last || last.counted || Number(count[1]) < 1) return { error: 'amount' };
      last.n = Number(count[1]);
      last.counted = true;
      continue;
    }
    const one = parseSellList([w]);
    if ('error' in one) return { error: one.error };
    // A count typed onto it ("🐟3") is counted; a name that has digits ("sukasbl00dcat") isn't.
    const plain = !!itemByWord(w) || ITEMS.some(i => i.name === w.replace(/\uFE0F/g, ''));
    for (const x of one.items) picks.push({ item: x.item, n: x.n, counted: !plain && /\d/.test(w) });
    if (leading !== null) {
      const first = picks[0];
      if (picks.length !== 1 || first.n !== 1 || first.counted) return { error: 'order' };
      if (first.item.type !== 'fish') return { error: 'length' };
      first.cm = leading;
      leading = null;
    }
  }
  if (leading !== null) return { error: 'order' };
  return { picks };
}

/** The fish asked for by length, one entry per kind and length with how many. */
function lengthsWanted(picks: FishPick[]): Map<string, { item: CatchItem; cm: number; n: number }> {
  const want = new Map<string, { item: CatchItem; cm: number; n: number }>();
  for (const e of picks) {
    if (e.cm === undefined) continue;
    const k = `${e.item.name}|${e.cm}`;
    const w = want.get(k);
    if (w) w.n += e.n;
    else want.set(k, { item: e.item, cm: e.cm, n: e.n });
  }
  return want;
}

/** What's short of the lengths wanted: "no 🦕 43 cm", "only 1 🦈 40 cm". */
function shortOf(d: FishData, want: ReturnType<typeof lengthsWanted>): string[] {
  return [...want.values()].flatMap(w => {
    const k = (d.catch.sizes?.[w.item.name] ?? []).filter(h => h.cm === w.cm).length;
    return k < w.n ? [k ? `only ${k} ${w.item.name} ${w.cm} cm` : `no ${w.item.name} ${w.cm} cm`] : [];
  });
}

const STORY_MODEL = 'claude-haiku-4-5-20251001';
/** supibot asks for 150 characters; allow some overrun before trimming. */
const STORY_MAX = 220;
/** "✨🐟✨", or "✨ KEKLEO ✨" for an emote's name, which needs spaces to show as the emote. */
const sparkle = (name: string): string => isWordName(name) ? `✨ ${name} ✨` : `✨${name}✨`;
/** Names run together, as emoji read fine ("🐟🦐"); an emote's name gets spaces. */
const runOf = (names: string[]): string => names.map(n => /^[A-Za-z_]|[A-Za-z_]$/.test(n) ? ` ${n} ` : n).join('').replace(/ {2,}/g, ' ').trim();

const groupDigits = (n: number): string => Math.round(n).toLocaleString('en-US');

// ─── Leaderboards ───────────────────────────────────────────────────────────

interface Board { path: string | null; name: string; value: (d: FishData, balance: number) => number | null }

/** Short forms for the words after a fish subcommand: `t c` is `trap cancel`, `b h` is `buy hook`, `tp tf` is `top total-fish`. */
const TYPE_SHORT: Record<string, string> = { f: 'fish', j: 'junk' };
const TRAP_SHORT: Record<string, string> = { c: 'cancel', r: 'reset', l: 'lift' };

/** The shortest trap: each fish skips 30 rolls, so anything shorter could never catch one. */
const TRAP_MIN_MINUTES = 31;

/** A trap time as a chatter types it: 90 or 90m (minutes), 2h, 1.5h, 1h30m or 1h30. Whole minutes, or null when it isn't one. */
export function parseTrapMinutes(raw: string): number | null {
  const t = raw.trim().toLowerCase();
  let m = /^(\d{1,5})(?:m|min|mins)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d{1,3}(?:\.\d+)?)(?:h|hr|hrs)$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60);
  m = /^(\d{1,3})h(\d{1,2})(?:m|min|mins)?$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
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
  const resp = await anthropicFetch({
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
  // Kick emotes in a reply (a custom fish named after one, say) go to chat as Kick's
  // [emote:<id>:<name>] codes, so they show as the emote and not its name.
  const raw = client;
  client = Object.assign(Object.create(raw) as typeof raw, {
    say: (to: string, text: string) => raw.say(to, withKickEmotes(chan, text, broadcasterIdFor(config as ChannelConfig)))
  });
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
  // An emote from Kick's picker arrives as "[emote:123:NAME]": a custom fish named NAME.
  const args = call.args.map(emoteWord).filter(a => {
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
    if (cooldown) {
      d.readyTimestamp = now + g.catchCooldownMinutes * 60_000;
    }
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

  /**
   * After a catch is added: past the cap for its kind (games.maxFish, maxJunk) it goes again,
   * a fish sold on the spot (paid here) and junk binned; from 90% of the cap, a warning.
   * Returns the line to add to the reply, or ''. Inside a write transaction, the user row there.
   */
  function fitCatch(d: FishData, uid: number, item: CatchItem, value: number, now: number): string {
    const cap = capOf(g, item.type);
    const coins = overflow(d, item, g, value);
    if (coins !== null) {
      if (coins > 0) creditTx(db!, { userId: uid, username: me, amount: coins, reason: 'game:fish_sell', actor: `chat:${me}`, note: 'bucket full', now });
      console.log(`[FISH] ${me}'s ${item.type} is at the cap of ${cap} in ${chan}: ${item.name} ${item.type === 'fish' ? `sold for ${coins}` : 'binned'}`);
      return item.type === 'fish'
        ? ` 🪣 Your bucket is full (${cap} fish), so it sold on the spot for ${groupDigits(coins)} ${cur}.`
        : ` 🪣 Your junk pile is full (${cap}), so it went straight in the bin.`;
    }
    return capWarning(d, item.type);
  }

  /**
   * Fish won for keeps that don't fit the winner's bucket sell on the spot, at their plain
   * price, paid to the winner. Returns the line for the result, or ''.
   */
  function keptOver(d: FishData, items: CatchItem[], winnerId: number, winner: string, now: number): string {
    let coins = 0;
    let n = 0;
    // Newest first: the ones just won, last in.
    for (const item of [...items].reverse()) {
      const c = overflow(d, item, g);
      if (c === null) continue;
      coins += c;
      n++;
    }
    if (!n) return '';
    if (coins > 0) creditTx(db!, { userId: winnerId, username: winner, amount: coins, reason: 'game:fish_sell', actor: `chat:${me}`, note: 'bucket full', now });
    return ` Their bucket is full, so ${n === 1 ? 'it' : `${n} of them`} sold on the spot for ${groupDigits(coins)} ${cur}.`;
  }

  /** From 90% of a cap: how close, and what happens at it. '' below that, or with no cap. */
  function capWarning(d: FishData, type: CatchType): string {
    const n = d.catch[type] ?? 0;
    if (!nearCap(g, type, n)) return '';
    const cap = capOf(g, type);
    return type === 'fish'
      ? ` ⚠️ Your bucket holds ${n}/${cap} fish: sell some (${cmd} fish sell) or from ${cap} new fish sell on the spot.`
      : ` ⚠️ Your junk pile is at ${n}/${cap}: sell it (${cmd} fish sell all junk) or from ${cap} new junk is binned.`;
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
   * Someone else's bite can be sniped while its first code is open to everyone, with the
   * snipe code from chat (not the overlay's): one try each, and the first right answer
   * takes the bite and reels on as its chatter.
   */
  function reelIn(codeRaw: string | undefined, uid: number): void {
    const at = Date.now();
    let bite = biteFor(chan, meLc);
    if (!bite) {
      const other = channelBite(chan);
      // Too early for someone else's first code: that was their one try (spamming the
      // code from the start used to cost nothing, so the ±3s on the window didn't help).
      if (other && other.pull === 1 && other.snipeAt !== undefined && (at < other.snipeAt || !other.snipeCode) && !other.tried.has(meLc)
        && canBite({ channel: chan, excluded: (id, name) => offLimits(id, name) }, uid, me)) {
        other.tried.add(meLc);
        return void say(`Too early! You spooked it: no more snipes at ${other.username}'s big bite.`);
      }
      if (!other || !snipeOpen(other, at) || !canBite({ channel: chan, excluded: (id, name) => offLimits(id, name) }, uid, me)) {
        return void say("There's nothing big on your line right now.");
      }
      if (other.tried.has(meLc)) return ignore('snipe already tried');
      other.tried.add(meLc);
      // Snipers answer with the code from the SNIPE OPEN line, not the overlay's.
      if (!codeMatches(codeRaw, other.snipeCode!)) return void say(`Wrong code! You missed your one shot at sniping ${other.username}'s big bite.${codeMatches(codeRaw, other.code) ? ' Snipes take the code from the SNIPE OPEN line in chat.' : ''}`);
      if (other.reward) return rewardSnipeFails(biteCtx(), other, me);
      snipeBite(biteCtx(), other, me, uid);
      bite = other;
    } else {
      const fail = (why: string) => { takeBite(chan, meLc); getAway(biteCtx(), bite!, why); };
      if (at > bite.until + STREAM_GRACE_MS) return fail('Too slow! It shook the hook and swam off.');
      if (at - bite.startedAt < BITE_TOO_FAST_MS) return fail('You yanked too early and snapped the line!');
      if (!codeMatches(codeRaw, bite.code)) return fail('Wrong move! The line snapped.');
    }
    if (bite.pull < bite.pulls) return nextPull(biteCtx(), bite);
    takeBite(chan, meLc);
    const item = weightedCatch('trophy', g);
    // A paid (reward) bite always lands once every code is right: only the trophy is left to chance.
    if (!bite.reward && randomInt(1, 100) > (item.landPercent ?? 100)) {
      console.log(`[FISH] ${me}'s trophy ${item.name} snapped free in ${chan}`);
      recordBite(db!, bite, 'snapped', { trophy: item.name, landPercent: item.landPercent });
      const snapped = `So close! It was a ${sparkle(item.name)}! It thrashed free on the last pull and snapped the line! 😱`;
      pushOverlay(db!, { username: me, kind: 'miss', text: snapped, item: item.name, rarity: 'Mythic' });
      return void client.say(channel, `@${me} ${snapped}`);
    }
    const out = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      const sizeString = land(d, uid, item, currentReel(d, g), now, false);
      const cm = item.size ? d.catch.sizes?.[item.name]?.at(-1)?.cm ?? null : null;
      const bucket = fitCatch(d, uid, item, currentReel(d, g)?.valueMultiplier ?? 1, now);
      saveFish(db!, uid, d, now);
      return { item, cm, sizeString: sizeString + bucket };
    });
    if (!out) return;
    console.log(`[FISH] ${me} reeled in a trophy ${out.item.name} in ${chan}`);
    recordBite(db!, bite, 'landed', { trophy: out.item.name, cm: out.cm, landPercent: bite.reward ? 100 : item.landPercent });
    // The result line: to chat as well as the overlay, whatever the chat-replies setting.
    const text = `🏆 You reeled it in! A MYTHIC ${sparkle(out.item.name)}! ${out.sizeString}`;
    pushOverlay(db!, { username: me, kind: 'catch', text, item: out.item.name, rarity: 'Mythic' });
    void client.say(channel, `@${me} ${text}`);
  }

  const noOverlay = () => overlayOff(db!)
    ? `The fishing overlay is switched off, so big bites are paused: ${cmd} fish overlay on brings them back.`
    : 'Open the fishing overlay first: a big bite needs somewhere to show its code.';

  /** The overlay isn't on stream (a polling copy still counts as showing): off sends every reply to chat and pauses big bites, until on or the next stream. */
  function overlaySwitch(word: string | undefined): void {
    const w = (word ?? '').toLowerCase();
    // reload: every open overlay reloads on its next poll, stuck or busy (pages from 2026-10-21 on).
    if (w === 'reload') {
      requestOverlayReload(db!, false);
      console.log(`[FISH] ${me} asked the fishing overlay to reload in ${chan}`);
      return void say(overlayHealth(db!)
        ? '🔄 Told the fishing overlay to reload: it should be back in a couple of seconds.'
        : "🔄 Told the fishing overlay to reload, but the one that's open is from before reloading could be asked for: it needs refreshing in OBS once.");
    }
    if (w !== 'on' && w !== 'off') {
      return void say(overlayOff(db!)
        ? `The fishing overlay is switched off: replies go to chat and big bites are paused. ${cmd} fish overlay on brings it back.`
        : `The fishing overlay is on${overlayShowing(db!) ? ' and showing' : ', but none is open right now'}. If it isn't on stream, ${cmd} fish overlay off sends replies to chat and pauses big bites until it's back.`);
    }
    const off = w === 'off';
    if (off === overlayOff(db!)) return void say(`The fishing overlay is already switched ${w}.`);
    setOverlayOff(db!, off);
    console.log(`[FISH] ${me} switched the fishing overlay ${w} in ${chan}`);
    say(off
      ? `🎣 Fishing overlay switched off: replies go to chat and big bites are paused until ${cmd} fish overlay on (or the next stream).`
      : '🎣 Fishing overlay back on: replies show on stream and big bites are back.');
  }

  /** Testers only: a big bite on yourself now, live or not (an overlay still has to be showing). */
  function testBite(uid: number): void {
    if (!tester) return;
    if (biteFor(chan, meLc)) return void say('You already have a big bite on your line.');
    if (wheelBusy(chan)) return void say('The wheel is spinning: try once it has landed.');
    if (!overlayShowing(db!)) return void say(noOverlay());
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
      | { kind: 'catch'; item: CatchItem; sizeString: string; appendix: string; bucket: string };

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
            : `You cannot go fishing while your traps are laid out - you would be disturbing the catch! Use "${cmd} fish trap lift" to pull them up early with what they've caught so far, or "${cmd} fish trap cancel" to get rid of them with no catch.`
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
          text = `${pick(JUNK_MESSAGES)} You reel out a ${item.name}${fitCatch(d, uid, item, 1, now)}`;
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
      const bucket = fitCatch(d, uid, item, reel?.valueMultiplier ?? 1, now);
      saveFish(db!, uid, d, now);
      return { kind: 'catch', item, sizeString, appendix, bucket };
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
        if (text) return void say(`${sparkle(out.item.name)} ${text} (${minutes}m cooldown${out.appendix})${out.bucket}`, { kind: 'catch', item: out.item.name });
      } catch (err) {
        console.error(`[FISH] Story for ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const emote = await emotesFor(SUCCESS_EMOTES, '😃');
    const size = out.sizeString ? ` ${out.sizeString}` : '';
    return void say(`You caught a ${sparkle(out.item.name)}${size} ${emote} Now, go do something productive! (${minutes} minute fishing cooldown after a successful catch)${out.bucket}`, { kind: 'catch', item: out.item.name });
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
    if (!overlayShowing(db!)) return void say(noOverlay());
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
   * `trap cancel` pulls them in empty; `trap lift` pulls them up early with a haul for
   * the time they were out, as if they'd been laid that long. With trap checks on, collecting while the
   * stream is offline may ask a question first (community/trap-check.ts): the haul
   * waits for `answer`. A right one collects it; running out of tries or time fines
   * the player and empties the traps. A timer ends the window on time; after a
   * restart, the player's next trap command or answer does.
   */
  async function trap(operation: string, uid: number, answer?: string, minutes?: number | null): Promise<void> {
    const before = loadFish(db!, uid) ?? initialData();
    const tc = g.trapCheck;
    // A time the chatter named (null: one that didn't read as a time): only within the range.
    if (minutes !== undefined && (minutes === null || minutes < TRAP_MIN_MINUTES || minutes > g.trapMaxMinutes)) {
      return void say(`Traps can be laid for ${span(TRAP_MIN_MINUTES * 60_000)} up to ${span(g.trapMaxMinutes * 60_000)}, like ${cmd} fish trap ${g.trapMaxMinutes >= 120 ? '2h' : '45m'}.`);
    }
    if (operation === 'answer') {
      if (!before.trapCheck) return void say("There's no question waiting on your traps.");
      // Nothing after "answer" isn't a try: the question again, while there's time.
      const wait = before.trapCheck.until - Date.now();
      if (!answer && wait >= 0) return void say(`Your traps are waiting on this: ${before.trapCheck.question} Reply "${cmd} fish answer" followed by your answer (${span(wait)} left).`);
    }
    // Laying, collecting and lifting are fishing, so they follow the live rule (collecting
    // live also skipped the offline-only trap check, 2026-10-20); cancelling gives nothing, so it doesn't.
    // An answer to a check asked offline still counts; to a reset it lays them again, but if it can't, it still collects.
    const laysTraps = operation === 'answer'
      ? before.trapCheck!.reset
      : operation !== 'cancel' && operation !== 'lift' && (!before.trap.active || operation === 'reset');
    const ruled = operation !== 'cancel' && operation !== 'answer';
    const mayLay = (ruled || laysTraps) && (await liveOk());
    if (ruled && !mayLay) return;
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
      // Lifted before they're full: they end now, and the haul is for the time they were out.
      const lifting = operation === 'lift' && d.trap.active && now <= d.trap.end && !d.trapCheck;
      if (lifting) {
        d.trap.duration = now - d.trap.start;
        d.trap.end = now;
      }
      /** Lay the traps for `mins`, kept within today's range: a reset's earlier length may be outside it now. */
      const setUp = (mins: number): string => {
        const duration = Math.min(g.trapMaxMinutes, Math.max(TRAP_MIN_MINUTES, mins)) * 60_000;
        d.trap = { active: true, start: now, end: now + duration, duration };
        after = { laidUntil: d.trap.end };
        const ping = remindsOn ? " I'll ping you when they're ready." : '';
        return `You have laid your fishing traps. Now we wait... ${waitEmote} You can check them in about ${span(duration)}.${ping}`;
      };
      const collect = (): string => {
        collected = true;
        // How long after the traps filled they were collected (cheat-signals.ts).
        // A lift has no wait to measure: it would read as an instant haul.
        recordSignal(db!, { userId: uid, kind: 'trap_collect', now, delayMs: lifting ? null : now - d.trap.end, live: liveNow, ...(lifting ? { detail: 'lift' } : {}) });
        const rolls = Math.floor(d.trap.duration / 60_000 * randomInt(75, 90) / 100);
        const skip = g.catchCooldownMinutes;
        let fishAmount = 0;
        const results: string[] = [];
        const reel = currentReel(d, g);
        let soldFor = 0;
        let dumped = 0;
        for (let i = 0; i < rolls; i++) {
          const r = rollCatch(g, reel);
          if (!r.item) continue;
          // A fish costs a catch cooldown of the trap's time, so only an early one counts.
          if (r.type === 'fish' && i < rolls - skip) {
            fishAmount++;
            i += skip;
            addItem(d, r.item);
            // Every fish gets a length, as a cast's does, so each can be told apart (picked by
            // length to sell, give or duel). A trap's never sets a size record.
            const cm = r.item.size ? randomInt(1, 100) : null;
            if (cm !== null) (((d.catch.sizes ??= {})[r.item.name]) ??= []).push({ cm, record: false });
            recordCatch(db!, uid, r.item.name, 'trap', cm, now);
            // Past the cap it sells on the spot.
            const sold = overflow(d, r.item, g, reel?.valueMultiplier ?? 1);
            if (sold !== null) soldFor += sold;
            results.push(`${r.item.name}${cm !== null ? ` (${cm} cm${sold !== null ? ', sold' : ''})` : sold !== null ? ' (sold)' : ''}`);
          } else if (r.type === 'junk') {
            addItem(d, r.item);
            const binned = overflow(d, r.item, g) !== null;
            if (binned) dumped++;
            results.push(binned ? `${r.item.name} (binned)` : r.item.name);
          }
        }
        d.lifetime.trap.times++;
        d.lifetime.trap.timeSpent += d.trap.duration;
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
        after = { laidUntil: null };
        if (fishAmount > d.lifetime.trap.bestFishCatch) d.lifetime.trap.bestFishCatch = fishAmount;
        if (soldFor > 0) creditTx(db!, { userId: uid, username: me, amount: soldFor, reason: 'game:fish_sell', actor: `chat:${me}`, note: 'bucket full', now });
        const full = (soldFor > 0 || results.some(x => x.includes('(sold') || x.includes(', sold')) ? ` 🪣 Your bucket is full (${capOf(g, 'fish')} fish): sold for ${groupDigits(soldFor)} ${cur}.` : '')
          + (dumped ? ` 🪣 Your junk pile is full (${capOf(g, 'junk')}): ${dumped} binned.` : '');
        const warn = (full.includes('bucket') ? '' : capWarning(d, 'fish')) + (dumped ? '' : capWarning(d, 'junk'));
        if (!results.length) return 'You drag the traps out of the water... and find that there is nothing at all...!';
        if (fishAmount === 0) return `You drag the traps out of the water... and find a bunch of junk. ${results.join(' ')}${full}${warn}`;
        return `You drag the traps out of the water... and you spot some fish! ${results.join(' ')}${full}${warn}`;
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
          const again = check.resetMinutes ?? d.trap.duration / 60_000;
          reply = check.cast ? 'Correct! Your line is free: cast away.' : check.reset && mayLay ? `Correct! ${collect()} ${setUp(again)}` : `Correct! ${collect()}`;
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
      } else if (operation === 'lift' && !d.trap.active) {
        return "You don't have any traps out to lift!";
      } else if (!d.trap.active) {
        reply = setUp(minutes ?? g.trapMinutes);
      } else if (now <= d.trap.end && !lifting) {
        return `Your traps are not fully loaded yet! They will be ready to harvest in ${span(d.trap.end - now)}. Use "${cmd} fish trap lift" to pull them up now with whatever they've caught so far, or "${cmd} fish trap cancel" to get rid of them with no catch.`;
      } else if (d.trapCheck && now > d.trapCheck.until) {
        // Its timer didn't get to it (a restart): it ends now.
        reply = failCheck(d, uid, d.trapCheck, 'time', now);
        after = { laidUntil: null };
      } else if (d.trapCheck) {
        // Waiting: the same question, and a reset now counts for the answer.
        if (operation === 'reset' && (!d.trapCheck.reset || (minutes != null && d.trapCheck.resetMinutes !== minutes))) {
          d.trapCheck.reset = true;
          if (minutes != null) d.trapCheck.resetMinutes = minutes;
          saveFish(db!, uid, d, now);
        }
        return `Your traps are full, but first: ${d.trapCheck.question} ${answerHow} (${span(d.trapCheck.until - now)} left)`;
      } else if (mayAsk && randomInt(1, 100) <= tc.chancePercent) {
        d.trapCheck = askedCheck = { ...makeTrapCheck(operation === 'reset', now, tc.answerSeconds), ...(operation === 'reset' && minutes != null ? { resetMinutes: minutes } : {}), fine: Math.floor((getUser(db!, uid)?.balance ?? 0) * tc.finePercent / 100) };
        recordSignal(db!, { userId: uid, kind: 'check_asked', now, live: liveNow, detail: 'trap' });
        console.log(`[FISH] ${me} got a trap check in ${chan}: ${d.trapCheck.question}`);
        const stake = tc.finePercent > 0 ? `costs ${tc.finePercent}% of your ${cur} and the catch` : 'loses the catch';
        const tries = tc.tries === 1 ? 'one try' : `${tc.tries} tries`;
        reply = `Your traps are full! Before you pull them up: ${d.trapCheck.question} ${answerHow} You have ${span(tc.answerSeconds * 1000)} and ${tries}; running out ${stake}.`;
      } else if (operation === 'reset') {
        // Without a time, as long as the traps just collected.
        const again = minutes ?? d.trap.duration / 60_000;
        reply = `${collect()} ${setUp(again)}`;
      } else {
        reply = lifting ? `You lift your traps early, ${span(d.trap.duration)} in. ${collect()}` : collect();
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
      // The note says what went ("20 pieces of junk"): the one reason covers fish and junk alike.
      const pay = (gained: number, what: string): number => gained > 0
        ? creditTx(db!, { userId: uid, username: me, amount: gained, reason: 'game:fish_sell', actor: `chat:${me}`, note: what.slice(0, 200), now })
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
            // Duplicates never include a fed fish: those are kept, however many.
            const fed = specifier === 'duplicate' ? (d.catch.sizes?.[item.name] ?? []).filter(h => levelOf(h)).length : 0;
            const keep = Math.max(threshold, fed);
            if (have <= keep) continue;
            const n = have - keep;
            sold += n;
            // "duplicate" keeps the biggest of each, the one worth showing off.
            gained += takeItems(d, item, n, g, specifier === 'duplicate', value);
          }
          if (sold > 0) soldByType.push(`${sold} ${prefix}${TYPE_DESCRIPTIONS[type]}`);
        }
        if (soldByType.length === 0) return `You have no ${prefix}${types.map(t => TYPE_DESCRIPTIONS[t as CatchType]).join(' or ')} to sell!`;
        d.lifetime.coins += gained;
        const balance = pay(gained, soldByType.join(' and '));
        saveFish(db!, uid, d, now);
        return `You sold ${soldByType.join(' and ')} for a grand total of ${gained} ${cur} - now you have ${balance} ${cur}`;
      }

      // Lengths sell those very fish: "🦕 42cm 44cm 🦈 72cm 🐟" sells a 🦕 of each length, that
      // 🦈, and the oldest 🐟. A count after a length is more of that length ("🦕 42cm 2").
      const words = splitLengths(parts);
      if (words.some(isLength)) {
        const parsed = parsePicks(words);
        if ('error' in parsed) return pickError(parsed.error, 'sell');
        const entries = parsed.picks;
        const want = lengthsWanted(entries);
        const short = shortOf(d, want);
        if (short.length) return `Nothing sold: you have ${short.join(', ')}. ${cmd} fish show ${[...want.values()][0].item.name} lists yours.`;
        let gained = 0;
        const soldParts: string[] = [];
        for (const w of want.values()) {
          gained += takeSized(d, w.item, w.cm, w.n, g, value)!;
          soldParts.push(`${w.item.name} ${w.cm} cm${w.n > 1 ? ` x${w.n}` : ''}`);
        }
        // Then the kinds named without a length, oldest first, as many as are left.
        const missing: string[] = [];
        for (const e of entries) {
          if (e.cm !== undefined) continue;
          const n = Math.min(d.catch.types[e.item.name] ?? 0, e.n);
          if (n <= 0) { missing.push(e.item.name); continue; }
          gained += takeItems(d, e.item, n, g, false, value);
          soldParts.push(`${e.item.name}${n > 1 ? ` x${n}` : ''}`);
        }
        d.lifetime.coins += gained;
        const balance = pay(gained, soldParts.join(', '));
        saveFish(db!, uid, d, now);
        const skipped = missing.length ? ` (you have no ${runOf(missing)})` : '';
        return `Sold your ${soldParts.join(', ')} for ${groupDigits(gained)} ${cur} - now you have ${groupDigits(balance)} ${cur}${skipped}`;
      }

      // One or more items, each with an optional count: "🐟 3 🦐" or "🐟🦐🦀".
      const list = parseSellList(parts);
      if ('error' in list) {
        return list.error === 'unknown'
          ? `You provided an unknown item type! Use one of: ${runOf(ITEMS.filter(i => !i.custom || g.catches.some(c => c.name === i.name)).map(i => i.name))}`
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
      if (soldParts.length === 0) return `You have no ${runOf(missing)} to sell!`;
      d.lifetime.coins += gained;
      const balance = pay(gained, soldParts.join(', '));
      saveFish(db!, uid, d, now);
      const skipped = missing.length ? ` (you have no ${runOf(missing)})` : '';
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
    const usage = `Give what to whom? ${cmd} fish give @user shark (an emoji or a name, a number for more than one, a length like 72cm for a certain one)`;
    // The viewer anywhere: "@faye 2 sharks" or "🦈 2 @faye"; without an @, the first word.
    const at = parts.findIndex(p => p.startsWith('@'));
    const who = at >= 0 ? at : 0;
    const name = parseUsername(parts[who]);
    if (!name) return void say(usage);
    // A length gives that very fish ("🦈 72cm"), not the oldest of its kind.
    const words = splitLengths(parts.filter((_, i) => i !== who));
    const lengths = words.filter(isLength);
    if (lengths.length > 1) return void say('One length at a time, like 🦈 72cm.');
    const cm = lengths.length ? parseInt(lengths[0], 10) : undefined;
    const list = parseSellList(words.filter(w => !isLength(w)));
    if ('error' in list) {
      return void say(list.error === 'unknown'
        ? `That's not an item I know! Use its emoji or a name like fish, shark, dino or boot.`
        : `Name the fish and how many: ${cmd} fish give @user 2 sharks`);
    }
    if (list.items.length === 0) return void say(usage);
    if (list.items.length > 1) return void say('One kind at a time, like 🐟 3.');
    const { item, n } = list.items[0];
    if (cm !== undefined && item.type !== 'fish') return void say('Only fish have a length.');
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
      const ofLength = cm === undefined ? 0 : (d.catch.sizes?.[item.name] ?? []).filter(h => h.cm === cm).length;
      if (cm !== undefined && ofLength === 0) return `You don't have a ${item.name} ${cm} cm. ${cmd} fish show ${item.name} lists yours.`;
      if (cm !== undefined && ofLength < n) return `You only have ${ofLength} ${item.name} ${cm} cm.`;
      // Anyone the bot knows can take a gift, fished before or not: their collection starts here.
      const r = loadFish(db!, to.user_id) ?? initialData();
      // A gift never goes past their cap: it's refused, and stays the giver's.
      const cap = capOf(g, item.type);
      const room = cap > 0 ? Math.max(0, cap - (r.catch[item.type] ?? 0)) : Infinity;
      if (room < n) return room === 0 ? `@${to.username}'s ${item.type === 'fish' ? 'bucket' : 'junk pile'} is full (${cap}), so they can't take it.` : `@${to.username} only has room for ${room} more ${item.type}.`;
      // What it's worth, for the cheat signals: that length's price, or an average 50 cm one's.
      const each = cm !== undefined ? sellPrice(item, g, { cm, record: false }) : sellPrice(item, g);
      let moved: number;
      if (cm === undefined) moved = giveItems(d, r, item, n);
      else {
        for (let i = 0; i < n; i++) {
          const sized = d.catch.sizes![item.name];
          const index = sized.findIndex(h => h.cm === cm);
          moveFish(d, r, item, { index, held: sized[index] });
        }
        moved = n;
      }
      saveFish(db!, uid, d, now);
      saveFish(db!, to.user_id, r, now);
      recordSignal(db!, { userId: uid, kind: 'fish_give', now, detail: JSON.stringify({ to: to.user_id, item: item.name, n: moved, worth: each * moved }) });
      lastGive.set(`${chan}|${meLc}`, now);
      const size = cm !== undefined ? ` (${cm} cm)` : '';
      console.log(`[FISH] ${me} gave ${moved} ${item.name}${size} to ${to.username} in ${chan}`);
      return `🎁 You gave @${to.username} ${moved > 1 ? `${moved} ` : ''}${item.name}${size}! You have ${have - moved} left.`;
    });
    if (text) say(text);
  }

  // ── trade ──
  /**
   * `fish trade 🦈 72cm 500 @user 🐋`: offer fish and/or currency for theirs, what you give before
   * the name and what you want after it (`fish trade @user 🦈 for 🐋`, the first form, also works). A number first on a side, over 100, or with $, k or
   * the currency's name after it is currency; otherwise, after a fish, it's how many. They answer with
   * `fish accept` / `fish decline` (or `fish trade accept|decline`); `fish trade cancel` takes it
   * back; `fish trade` alone shows what's waiting. The proposer pays games.trade's fee, burned.
   * Fish named by kind alone go oldest first, unlevelled ones before any fed one; the offer names
   * the very fish, and only those change hands.
   */
  const coinWord = (w: string): boolean => {
    const x = w.toLowerCase().replace(/^\$/, '');
    return x === cmd.toLowerCase().replace(/^\$/, '') || x === cur.toLowerCase().replace(/^\$/, '') || /^(coins?|points?|pts)$/.test(x);
  };
  /** One side's words: currency apart, the rest read as for sell. */
  function tradeSideOf(words: string[]): { coins: number; picks: FishPick[] } | { error: string } {
    let coins = 0;
    const rest: string[] = [];
    words.forEach((w, i) => {
      const m = /^\$?(\d[\d,]*)(k|m)?\$?$/i.exec(w);
      // After a fish a small number is how many; nobody holds more than 100 of a kind, so more is currency.
      const isCoins = m && (rest.length === 0 || /[$km]/i.test(w) || (words[i + 1] !== undefined && coinWord(words[i + 1])) || Number(m[1].replace(/,/g, '')) > 100);
      if (isCoins) {
        coins += Number(m![1].replace(/,/g, '')) * (m![2]?.toLowerCase() === 'k' ? 1_000 : m![2]?.toLowerCase() === 'm' ? 1_000_000 : 1);
        return;
      }
      if (coinWord(w)) return;
      rest.push(w);
    });
    if (!Number.isSafeInteger(coins)) return { error: 'That amount is too big.' };
    if (!rest.length) return { coins, picks: [] };
    const parsed = parsePicks(rest);
    if ('error' in parsed) return { error: pickError(parsed.error, 'sell') };
    return { coins, picks: parsed.picks };
  }
  /** The very fish (and junk) a side's picks come to from what's held, or what's short. */
  function resolveSide(d: FishData | null, picks: FishPick[]): { items: TradeItem[] } | { short: string } {
    const items: TradeItem[] = [];
    const taken = new Map<string, number[]>();
    const used = (name: string) => taken.get(name) ?? (taken.set(name, []), taken.get(name)!);
    // Lengths first, then kinds from what's left: like sell.
    for (const p of [...picks.filter(x => x.cm !== undefined), ...picks.filter(x => x.cm === undefined)]) {
      const name = p.item.name;
      if (p.item.type !== 'fish') {
        const have = (d?.catch.types[name] ?? 0) - used(name).length;
        if (have < p.n) return { short: have > 0 ? `only ${have} ${name}` : `no ${name}` };
        for (let i = 0; i < p.n; i++) { used(name).push(-1); items.push({ name, cm: null }); }
        continue;
      }
      const sized = d?.catch.sizes?.[name] ?? [];
      const unsized = Math.max(0, (d?.catch.types[name] ?? 0) - sized.length);
      for (let k = 0; k < p.n; k++) {
        const free = sized.map((h, i) => ({ h, i })).filter(({ h, i }) => !used(name).includes(i) && (p.cm === undefined || h.cm === p.cm));
        // By kind: the oldest without a level, a fed one only when nothing else is left.
        const pick = p.cm !== undefined ? free[0] : free.find(({ h }) => !levelOf(h)) ?? free[0];
        if (pick) {
          used(name).push(pick.i);
          items.push({ name, cm: pick.h.cm, ...(levelOf(pick.h) ? { level: levelOf(pick.h) } : {}) });
        } else if (p.cm === undefined && used(name).filter(i => i === -2).length < unsized) {
          used(name).push(-2);
          items.push({ name, cm: null });
        } else {
          const total = d?.catch.types[name] ?? 0;
          return { short: p.cm !== undefined ? `no ${name} ${p.cm} cm` : total ? `only ${total} ${name}` : `no ${name}` };
        }
      }
    }
    return { items };
  }
  const itemWorth = (d: FishData | null, i: TradeItem): number => {
    const item = ITEMS.find(x => x.name === i.name)!;
    const held = i.cm !== null ? d?.catch.sizes?.[i.name]?.find(h => h.cm === i.cm) : undefined;
    return sellPrice(item, g, held ?? (i.cm !== null ? { cm: i.cm, record: false } : undefined));
  };
  const sideWorth = (d: FishData | null, side: TradeSide): number => side.items.reduce((sum, i) => sum + itemWorth(d, i), 0) + side.coins;
  /** Move a side's items from one collection to another; false (nothing moved) if any is gone. */
  function moveSide(from: FishData, to: FishData, side: TradeSide): boolean {
    for (const i of side.items) {
      const item = ITEMS.find(x => x.name === i.name)!;
      if (i.cm === null) {
        const unsized = item.type === 'fish' ? (from.catch.types[i.name] ?? 0) - (from.catch.sizes?.[i.name]?.length ?? 0) : (from.catch.types[i.name] ?? 0);
        if (unsized < 1) return false;
        if (item.type === 'fish') moveFish(from, to, item, { index: -1 });
        else giveItems(from, to, item, 1);
        continue;
      }
      const sized = from.catch.sizes?.[i.name] ?? [];
      // That very fish: its length, and its level as offered when there's a choice.
      let index = sized.findIndex(h => h.cm === i.cm && levelOf(h) === (i.level ?? 0));
      if (index < 0) index = sized.findIndex(h => h.cm === i.cm);
      if (index < 0) return false;
      moveFish(from, to, item, { index, held: sized[index] });
    }
    return true;
  }
  /** Room left for a side's fish and junk in a collection, or what's over. */
  function roomFor(d: FishData, side: TradeSide, whose: string): string | null {
    for (const type of ['fish', 'junk'] as const) {
      const n = side.items.filter(i => ITEMS.find(x => x.name === i.name)?.type === type).length;
      const cap = capOf(g, type);
      if (n && cap > 0 && (d.catch[type] ?? 0) + n > cap) return `${whose} ${type === 'fish' ? 'bucket' : 'junk pile'} would be over its ${cap}`;
    }
    return null;
  }

  async function trade(parts: string[], uid: number): Promise<void> {
    const t = g.trade;
    if (!t.enabled && !tester) return void say('Fish trading is off here.');
    const op = (parts[0] ?? '').toLowerCase();
    if (!parts.length) {
      const mine = tradeBy(chan, uid);
      const theirs = tradeFor(chan, uid);
      if (!mine && !theirs) return void say(`No trades waiting. Offer one: ${cmd} fish trade 🦈 72cm @user 🐋 (what you give, who, what you want).`);
      return void say([
        theirs ? `@${theirs.from} offers ${sideText(theirs.give, cur)} for your ${sideText(theirs.get, cur)} (${span(theirs.expiresAt - Date.now())} left: ${cmd} fish accept or decline).` : '',
        mine ? `Your offer to @${mine.to}: ${sideText(mine.give, cur)} for ${sideText(mine.get, cur)} (${span(mine.expiresAt - Date.now())} left, ${cmd} fish trade cancel takes it back).` : ''
      ].filter(Boolean).join(' '));
    }
    if (/^(accept|a|yes|y)$/.test(op)) return void acceptTrade(uid);
    if (/^(decline|deny|no|n|dn)$/.test(op)) return void declineTrade(uid);
    if (/^(cancel|c|back|withdraw)$/.test(op)) {
      const mine = tradeBy(chan, uid);
      if (!mine) return void say('You have no trade offer waiting.');
      dropTrade(chan, mine);
      return void say(`You took back your trade offer to @${mine.to}.`);
    }

    const usage = `Trade what for what? ${cmd} fish trade 🦈 72cm @user 🐋: what you give, then who, then what you want (${cmd} fish trade 5000 @user 🦦 buys their 🦦)`;
    // "🦈 72cm @bob 🐋": yours before the name, theirs after it ("for" between is optional).
    // "@bob 🦈 72cm for 🐋", the first form, still works: then "for" splits the sides.
    const at = parts.findIndex(p => p.startsWith('@'));
    const who = at >= 0 ? at : 0;
    const name = parseUsername(parts[who]);
    if (!name) return void say(usage);
    let giveWords: string[];
    let wantWords: string[];
    if (who > 0) {
      giveWords = parts.slice(0, who);
      wantWords = parts.slice(who + 1);
      if (/^for$/i.test(wantWords[0] ?? '')) wantWords = wantWords.slice(1);
    } else {
      const words = parts.slice(1);
      const split = words.findIndex(w => /^for$/i.test(w));
      if (split < 0) return void say(usage);
      giveWords = words.slice(0, split);
      wantWords = words.slice(split + 1);
    }
    const mineSide = tradeSideOf(giveWords);
    const theirSide = tradeSideOf(wantWords);
    if ('error' in mineSide) return void say(mineSide.error);
    if ('error' in theirSide) return void say(theirSide.error);
    if ((!mineSide.picks.length && !mineSide.coins) || (!theirSide.picks.length && !theirSide.coins)) {
      return void say(`Both sides need something. To hand fish over for nothing, use ${cmd} fish give.`);
    }
    if (!mineSide.picks.length && !theirSide.picks.length) return void say(`There's no fish in that. Trades are for fish: ${cmd} give sends ${cur}.`);
    const nameLc = name.toLowerCase();
    if (isBotSender(name) || SYSTEM_BOTS.has(nameLc)) return void say("Bots don't trade fish. Find a human!");
    const to = findUserByName(db!, nameLc);
    if (!to) return void say('No such user exists!');
    if (to.user_id === uid) return void say("You can't trade with yourself!");
    if (offLimits(to.user_id, nameLc)) return void say(`${to.username} can't trade fish.`);
    const already = tradeBy(chan, uid);
    if (already) return void say(`You already have an offer waiting for @${already.to}: ${cmd} fish trade cancel to take it back first.`);
    if (tradeFor(chan, to.user_id)) return void say(`@${to.username} already has a trade offer waiting. Try again in a bit.`);

    const mine = loadFish(db!, uid);
    const theirs = loadFish(db!, to.user_id);
    const give = resolveSide(mine, mineSide.picks);
    if ('short' in give) return void say(`You can't offer that: you have ${give.short}.`);
    const get = resolveSide(theirs, theirSide.picks);
    if ('short' in get) return void say(`@${to.username} has ${get.short}. ${cmd} fish show @${to.username} lists theirs.`);
    const giveSide: TradeSide = { items: give.items, coins: mineSide.coins };
    const getSide: TradeSide = { items: get.items, coins: theirSide.coins };
    const value = sideWorth(mine, giveSide) + sideWorth(theirs, getSide);
    const fee = Math.max(t.feeMinimum, Math.round(value * t.feePercent / 100));
    const balance = getUser(db!, uid)?.balance ?? 0;
    if (balance < giveSide.coins + fee) return void say(`You need ${groupDigits(giveSide.coins + fee)} ${cur} on hand for that: ${giveSide.coins ? `the ${groupDigits(giveSide.coins)} you offer and ` : ''}a ${groupDigits(fee)} ${cur} fee.`);
    if (getSide.coins > (getUser(db!, to.user_id)?.balance ?? 0)) return void say(`@${to.username} doesn't have ${groupDigits(getSide.coins)} ${cur}.`);
    const now = Date.now();
    const offer: TradeOffer = { fromId: uid, from: me, toId: to.user_id, to: to.username, give: giveSide, get: getSide, value, fee, at: now, expiresAt: now + t.expirySeconds * 1000 };
    addTrade(chan, offer);
    console.log(`[FISH] ${me} offered ${to.username} a trade in ${chan}: ${sideText(giveSide, cur)} for ${sideText(getSide, cur)} (fee ${fee})`);
    await announce(`🤝 @${to.username}, ${me} offers ${sideText(giveSide, cur)} for your ${sideText(getSide, cur)}. ${cmd} fish accept or ${cmd} fish decline (${span(t.expirySeconds * 1000)}). ${me} pays a ${groupDigits(fee)} ${cur} fee.`);
  }

  function declineTrade(uid: number): void {
    const offer = tradeFor(chan, uid);
    if (!offer) return void say('Nobody has offered you a trade.');
    dropTrade(chan, offer);
    void announce(`@${offer.from} ${me} turned down your trade.`);
  }

  function acceptTrade(uid: number): void {
    const offer = tradeFor(chan, uid);
    if (!offer) return void say('Nobody has offered you a trade.');
    const text = once((now): { off: string } | { done: true } => {
      ensureUserTx(db!, uid, me, now);
      const a = loadFish(db!, offer.fromId) ?? initialData();
      const b = loadFish(db!, uid) ?? initialData();
      // Everything again, as it is now: either side may have sold, fed or lost something since.
      const balA = getUser(db!, offer.fromId)?.balance ?? 0;
      const balB = getUser(db!, uid)?.balance ?? 0;
      if (balA < offer.give.coins + offer.fee) return { off: `${offer.from} no longer has the ${groupDigits(offer.give.coins + offer.fee)} ${cur} it takes, so the trade is off.` };
      if (balB < offer.get.coins) return { off: `You don't have the ${groupDigits(offer.get.coins)} ${cur} anymore, so the trade is off.` };
      const full = roomFor(b, offer.give, 'Your') ?? roomFor(a, offer.get, `${offer.from}'s`);
      if (full) return { off: `${full}, so the trade is off.` };
      const worthA = sideWorth(a, offer.give);
      const worthB = sideWorth(b, offer.get);
      if (!moveSide(a, b, offer.give)) return { off: `${offer.from} no longer has everything they offered, so the trade is off.` };
      if (!moveSide(b, a, offer.get)) return { off: `You no longer have everything they asked for, so the trade is off.` };
      saveFish(db!, offer.fromId, a, now);
      saveFish(db!, uid, b, now);
      const ref = `trade:${offer.fromId}:${uid}:${offer.at}`;
      if (offer.give.coins) {
        debitTx(db!, { userId: offer.fromId, amount: offer.give.coins, reason: 'game:fish_trade_out', ref, actor: `chat:${offer.from}`, note: offer.to, now });
        creditTx(db!, { userId: uid, username: me, amount: offer.give.coins, reason: 'game:fish_trade_in', ref, actor: `chat:${offer.from}`, note: offer.from, now });
      }
      if (offer.get.coins) {
        debitTx(db!, { userId: uid, amount: offer.get.coins, reason: 'game:fish_trade_out', ref, actor: `chat:${me}`, note: offer.from, now });
        creditTx(db!, { userId: offer.fromId, username: offer.from, amount: offer.get.coins, reason: 'game:fish_trade_in', ref, actor: `chat:${me}`, note: offer.to, now });
      }
      if (offer.fee) debitTx(db!, { userId: offer.fromId, amount: offer.fee, reason: 'game:fish_trade_fee', ref, actor: `chat:${offer.from}`, note: offer.to, now });
      db!.prepare('INSERT INTO fish_trades (ts, from_id, to_id, from_items, from_coins, to_items, to_coins, value, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(now, offer.fromId, uid, JSON.stringify(offer.give.items), offer.give.coins, JSON.stringify(offer.get.items), offer.get.coins, Math.round(worthA + worthB), offer.fee);
      // A lopsided trade is a gift of the difference, for the cheat signals' funnel check.
      const lean = worthA - worthB;
      if (Math.abs(lean) >= 1) {
        const [giver, taker, items] = lean > 0 ? [offer.fromId, uid, offer.give.items] : [uid, offer.fromId, offer.get.items];
        recordSignal(db!, { userId: giver, kind: 'fish_give', now, detail: JSON.stringify({ to: taker, item: 'trade', n: items.length, worth: Math.round(Math.abs(lean)) }) });
      }
      return { done: true };
    });
    if (!text) return;
    dropTrade(chan, offer);
    if ('off' in text) return void say(text.off);
    console.log(`[FISH] trade in ${chan}: ${offer.from} gave ${sideText(offer.give, cur)}, ${offer.to} gave ${sideText(offer.get, cur)}, fee ${offer.fee}`);
    void announce(`🤝 Trade done! @${offer.from} got ${sideText(offer.get, cur)}, @${offer.to} got ${sideText(offer.give, cur)}. ${offer.from} paid a ${groupDigits(offer.fee)} ${cur} fee.`);
  }

  // ── steal ──
  /**
   * Reach for one random fish the target has held past the grace time, weighted by
   * how many of each they hold, or the kind (`steal @user 🦈`) or the very fish
   * (`steal @user 🦈 72cm`) the thief names. It works by that fish's rarity, aimed or not; otherwise the thief
   * is caught and fined on top of the fee (both go nowhere). Every try uses one hook
   * try. A thief who couldn't pay for the costliest fish the hook could grab (the one
   * aimed at, or any) loses just that. A guard catches the thief like a failed roll:
   * the fee and fine on the fish the hook went for, the cooldown and the day's try on
   * that viewer (since 2026-10-24; before, it cost a hook try and nothing else).
   */
  type StealAim = { item: CatchItem; cm?: number };
  /** The fish named after a steal's target: one fish, a kind or a length. A string says what's wrong. */
  const parseAim = (words: string[], victimName: string): StealAim | string => {
    const parsed = parsePicks(words);
    const usage = `Name one fish to aim for, like ${cmd} fish steal @${victimName} 🦈 or 🦈 72cm`;
    if ('error' in parsed) return parsed.error === 'unknown' ? pickError('unknown', 'sell') : usage;
    const [p] = parsed.picks;
    if (parsed.picks.length !== 1 || p.counted || p.n !== 1) return usage;
    if (p.item.type !== 'fish') return 'Your hook only grabs fish, not junk.';
    return { item: p.item, cm: p.cm };
  };
  const WENT = "outcome IN ('stolen', 'caught', 'guarded')";
  /** How long the target stays on alert after the last try on them; 0 when they aren't. */
  const alertLeft = (victimId: number, now: number): number => {
    const t = (db!.prepare(`SELECT MAX(ts) AS t FROM steals WHERE victim_id = ? AND ${WENT}`).get(victimId) as { t: number | null }).t;
    return t === null ? 0 : Math.max(0, t + g.steal.protectMinutes * 60_000 - now);
  };
  /** How long until this thief may try this target again (once a day); 0 when they may. */
  const pairLeft = (uid: number, victimId: number, now: number): number => {
    const t = (db!.prepare(`SELECT MAX(ts) AS t FROM steals WHERE thief_id = ? AND victim_id = ? AND ${WENT}`).get(uid, victimId) as { t: number | null }).t;
    return t === null ? 0 : Math.max(0, t + 86_400_000 - now);
  };
  /**
   * Whether the fish aimed at is within reach: held, and held past the grace time. A
   * kind alone leaves which one to chance (aimed null); a length is that very fish.
   * Otherwise why not, with when a fresh one comes within reach.
   */
  function aimAt(v: FishData | null, victim: { user_id: number; username: string }, aim: StealAim, now: number, they = false): { aimed: { index: number; held?: HeldFish } | null } | { blocked: string } {
    const label = `${aim.item.name}${aim.cm !== undefined ? ` ${aim.cm} cm` : ''}`;
    const have = v?.catch.types[aim.item.name] ?? 0;
    const sized = (v?.catch.sizes?.[aim.item.name] ?? []).slice(0, have);
    const held = aim.cm === undefined ? have : sized.filter(h => h.cm === aim.cm).length;
    if (!held) return { blocked: they ? `they don't have a ${label}` : `${victim.username} doesn't have a ${label}.` };
    const graceMs = g.steal.graceMinutes * 60_000;
    const fresh = freshCatches(db!, victim.user_id, aim.item.name, now, graceMs).filter(f => aim.cm === undefined || f.cm === aim.cm);
    if (held <= fresh.length) {
      // The first comes within reach once enough fresh ones age past the grace time.
      const left = span(fresh[fresh.length - held].ts + graceMs - now);
      return { blocked: they ? `they only just caught their ${label} (safe for another ${left})` : `${victim.username} only just caught their ${label}. It's safe from thieves for another ${left}.` };
    }
    if (aim.cm === undefined) return { aimed: null };
    const index = sized.findIndex(h => h.cm === aim.cm);
    return { aimed: { index, held: sized[index] } };
  }
  /** Steals are open now (games.steal.onlyWhileLive, else the casting rule)? Unlike liveOk, says nothing. */
  const stealHours = async (): Promise<string | null> => {
    const st = g.steal;
    if (tester || (!st.onlyWhileLive && !g.onlyWhileLive && !g.onlyWhileOffline)) return null;
    const want = st.onlyWhileLive || g.onlyWhileLive;
    return (await svc.isLiveNow()) === want ? null : `stealing is only open while the stream is ${want ? 'live' : 'offline'}`;
  };

  /** `fish steal` alone: the thief's hook, cooldown and who they've tried today. Changes nothing. */
  async function stealStatus(uid: number): Promise<void> {
    const st = g.steal;
    if (!st.enabled && !tester) return void say("Nobody steals fish here. Go catch your own!");
    const now = Date.now();
    const d = loadFish(db!, uid) ?? initialData();
    const parts: string[] = [];
    const closed = await stealHours();
    if (closed) parts.push(closed);
    parts.push((d.hook ?? 0) > 0 ? `🪝 ${tries(d.hook!)} left on your hook` : `no 🪝 hook (${cmd} fish buy hook, ${groupDigits(st.hookPrice)} ${cur} for ${tries(st.hookUses)})`);
    if (!tester && now < (d.stealReady ?? 0)) parts.push(`next steal in ${span(d.stealReady! - now)}`);
    const tried = db!.prepare(
      `SELECT u.username, MAX(s.ts) AS t FROM steals s JOIN users u ON u.user_id = s.victim_id
       WHERE s.thief_id = ? AND s.ts > ? AND s.${WENT} GROUP BY s.victim_id ORDER BY t`
    ).all(uid, now - 86_400_000) as Array<{ username: string; t: number }>;
    if (tried.length) {
      const shown = tried.slice(0, 6).map(r => `${r.username} (${span(r.t + 86_400_000 - now)})`);
      parts.push(`tried today: ${shown.join(', ')}${tried.length > shown.length ? ` +${tried.length - shown.length} more` : ''}`);
    }
    parts.push(`scout a target free with ${cmd} fish steal check @user [fish]`);
    say(parts.join(' · '));
  }

  /**
   * `fish steal check @user [fish]`: everything a steal would run into, without trying,
   * bar a guard. Nothing is spent and no cooldown starts.
   */
  async function stealCheck(targetRaw: string, uid: number, aimWords: string[]): Promise<void> {
    const st = g.steal;
    if (!st.enabled && !tester) return void say("Nobody steals fish here. Go catch your own!");
    const name = parseUsername(targetRaw);
    if (!name) return void say(`Check whom? ${cmd} fish steal check @user [fish]`);
    const nameLc = name.toLowerCase();
    if (isBotSender(name) || SYSTEM_BOTS.has(nameLc)) return void say("My fish are bolted down. Nice try!");
    const victim = findUserByName(db!, nameLc);
    if (!victim) return void say('No such user exists!');
    if (victim.user_id === uid) return void say("You can't steal from yourself!");
    if (nameLc === chan || (!tester && offLimits(victim.user_id, nameLc))) return void say(`${victim.username}'s fish are off limits.`);
    const aim = aimWords.length ? parseAim(aimWords, victim.username) : null;
    if (typeof aim === 'string') return void say(aim);

    const now = Date.now();
    const d = loadFish(db!, uid) ?? initialData();
    const v = loadFish(db!, victim.user_id);
    const no: string[] = [];
    const closed = await stealHours();
    if (closed) no.push(closed);
    if (!hasFishedBefore(d)) no.push('you need to go fishing once first');
    if ((d.hook ?? 0) <= 0) no.push(`you need a 🪝 hook (${cmd} fish buy hook)`);
    if (capOf(g, 'fish') > 0 && d.catch.fish >= capOf(g, 'fish')) no.push('your bucket is full');
    if (!tester && now < (d.stealReady ?? 0)) no.push(`your steal cooldown has ${span(d.stealReady! - now)} left`);
    // A guard stays secret, as everywhere: finding one out costs a hook try.
    const alert = tester ? 0 : alertLeft(victim.user_id, now);
    if (alert > 0) no.push(`they're on alert for ${span(alert)}`);
    const pair = tester ? 0 : pairLeft(uid, victim.user_id, now);
    if (pair > 0) no.push(`you tried them today (${span(pair)} left)`);

    // What a try would cost, and its odds: on the fish aimed at, else the worst they hold.
    const pool = v ? stealableFish(db!, v, victim.user_id, now, st.graceMinutes * 60_000) : [];
    let odds = '';
    let needed = 0;
    if (aim) {
      const reach = aimAt(v, victim, aim, now, true);
      if ('blocked' in reach) no.push(reach.blocked);
      const chance = Math.round(stealRollChance(g, aim.item.name) * 10) / 10;
      if (!('blocked' in reach) && reach.aimed) {
        const { fee, fine } = stealCharges(g, sellPrice(aim.item, g, reach.aimed.held), stealRollChance(g, aim.item.name));
        needed = fee + fine;
        odds = `${chance}% chance · ${groupDigits(fee)} ${cur} fee, ${groupDigits(fine)} ${cur} fine if caught`;
      } else if (v && !('blocked' in reach)) {
        needed = worstStealCharges(v, g, pool.filter(p => p.item.name === aim.item.name));
        odds = `${chance}% chance · up to ${groupDigits(needed)} ${cur} in fee and fine, by which one you grab`;
      }
    } else if (!v || !pool.length) {
      no.push('they have no fish in reach');
    } else {
      needed = worstStealCharges(v, g, pool);
      const n = pool.reduce((sum, p) => sum + p.n, 0);
      odds = `${n} fish in reach · a random grab costs up to ${groupDigits(needed)} ${cur} in fee and fine · aim with ${cmd} fish steal @${victim.username} 🦈 72cm`;
    }
    const balance = getUser(db!, uid)?.balance ?? 0;
    if (needed > balance) no.push(`you need ${groupDigits(needed)} ${cur} on hand to cover it, you have ${groupDigits(balance)}`);

    const label = `${victim.username}${aim ? ` ${aim.item.name}${aim.cm !== undefined ? ` ${aim.cm} cm` : ''}` : ''}`;
    say(`${label}: ${no.length ? `❌ ${no.join(' · ')}` : '✅ you can try now'}${odds ? ` | ${odds}` : ''}`);
  }

  async function steal(targetRaw: string | undefined, uid: number, aimWords: string[] = []): Promise<void> {
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
    const aim = aimWords.length ? parseAim(aimWords, victim.username) : null;
    if (typeof aim === 'string') return void say(aim);

    let overlay: { kind: OverlayKind; item: string } | null = null;
    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if (!hasFishedBefore(d)) return 'Go fishing at least once before you try stealing!';
      // A full bucket can't take a stolen fish: nothing is spent.
      if (capOf(g, 'fish') > 0 && d.catch.fish >= capOf(g, 'fish')) return `Your bucket is full (${capOf(g, 'fish')} fish): sell some before you steal more.`;
      if ((d.hook ?? 0) <= 0) return `You need a 🪝 grappling hook to steal. Get one with ${cmd} fish buy hook (${groupDigits(st.hookPrice)} ${cur} for ${tries(st.hookUses)}).`;
      if (!tester && now < (d.stealReady ?? 0)) return `Hol' up partner! You can try another steal in ${span(d.stealReady! - now)}. Fishing isn't held up by it.`;
      const v = loadFish(db!, victim.user_id);
      const log = (outcome: string, item: string | null, cm: number | null, money: { worth: number; fee: number; fine: number } | null = null) =>
        db!.prepare('INSERT INTO steals (ts, thief_id, victim_id, name, cm, outcome, worth, fee, fine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(now, uid, victim.user_id, item, cm, outcome, money?.worth ?? null, money?.fee ?? null, money?.fine ?? null);

      const alert = alertLeft(victim.user_id, now);
      if (!tester && alert > 0) return `${victim.username} is still on alert after the last attempt. Try again in ${span(alert)}.`;
      const pair = pairLeft(uid, victim.user_id, now);
      if (!tester && pair > 0) return `You already tried ${victim.username} today. You can try them again in ${span(pair)}.`;
      const pool = v ? stealableFish(db!, v, victim.user_id, now, st.graceMinutes * 60_000) : [];
      if (!v || !pool.length) return `${victim.username} has no fish you can get your hook into right now.`;
      let aimed: { index: number; held?: HeldFish } | null = null;
      if (aim) {
        const reach = aimAt(v, victim, aim, now);
        if ('blocked' in reach) return reach.blocked;
        aimed = reach.aimed;
      }
      // The thief must be able to pay for the worst the hook could grab: the fee and the
      // fine on the fish aimed at, or on the target's most valuable one. Short of that,
      // the try costs a hook use.
      const balance = getUser(db!, uid)?.balance ?? 0;
      const needed = aimed
        ? (({ fee, fine }) => fee + fine)(stealCharges(g, sellPrice(aim!.item, g, aimed.held), stealRollChance(g, aim!.item.name)))
        : worstStealCharges(v, g, aim ? pool.filter(p => p.item.name === aim!.item.name) : pool);
      if (balance < needed) {
        d.hook = (d.hook ?? 1) - 1;
        saveFish(db!, uid, d, now);
        log('short', null, null);
        const left = d.hook > 0 ? `${tries(d.hook)} left on it` : 'that was its last try';
        return `You fumbled your 🪝 hook (${left}). To try ${victim.username} you need ${groupDigits(needed)} ${cur} on hand: the fee and the fine for ${aimed ? 'that fish' : aim ? `their costliest ${aim.item.name}` : 'the costliest fish they hold'}.`;
      }

      // The attempt goes ahead: a hook use and the steal cooldown are spent whatever happens, and the fee once the fish is known.
      // The steal cooldown is its own: a thief can still fish, and a fish never holds up a steal (owner, 2026-10-21).
      d.hook = (d.hook ?? 1) - 1;
      d.stealReady = now + g.catchCooldownMinutes * 60_000;
      d.lifetime.steal.attempts++;
      let r = randomInt(1, pool.reduce((sum, p) => sum + p.n, 0));
      const item = aim ? aim.item : pool.find(p => (r -= p.n) <= 0)!.item;
      const picked = aimed ?? pickHeld(v, item);
      const worth = sellPrice(item, g, picked.held);
      // Luck included: the fine balances the odds the roll really has.
      const chance = stealRollChance(g, item.name);
      const { fee, fine } = stealCharges(g, worth, chance);
      if (fee > 0) debitTx(db!, { userId: uid, amount: fee, reason: 'game:fish_steal', actor: `chat:${me}`, note: `${victim.username} ${item.name}`, now });
      const cooldown = `next steal in ${g.catchCooldownMinutes}m`;
      const hookLeft = d.hook > 0 ? `${tries(d.hook)} left on your 🪝 hook` : 'your 🪝 hook is used up';

      // A guard catches every try, with no roll: the fine as if caught. A guard's time stays secret.
      if ((v.guardUntil ?? 0) > now) {
        if (fine > 0) debitTx(db!, { userId: uid, amount: fine, reason: 'game:fish_steal_fine', actor: `chat:${me}`, note: `${victim.username} (guard)`, now });
        d.lifetime.steal.blocked++;
        saveFish(db!, uid, d, now);
        log('guarded', item.name, picked.held?.cm ?? null, { worth, fee, fine });
        return `🛡️ @${victim.username} has a guard watching their fish! It caught you reaching for their ${sparkle(item.name)}: you paid a ${groupDigits(fine)} ${cur} fine on top of the ${groupDigits(fee)} ${cur} fee. (${hookLeft}, ${cooldown})`;
      }

      if (randomInt(1, 1000) <= Math.round(chance * 10)) {
        moveFish(v, d, item, picked, true);
        d.lifetime.steal.stolen++;
        v.lifetime.steal.lost++;
        saveFish(db!, uid, d, now);
        saveFish(db!, victim.user_id, v, now);
        log('stolen', item.name, picked.held?.cm ?? null, { worth, fee, fine: 0 });
        overlay = { kind: 'steal', item: item.name };
        const size = picked.held ? ` (${picked.held.cm} cm)` : '';
        const left = d.hook > 0 ? `${tries(d.hook)} left on your hook` : 'your hook is used up';
        return `🪝 You snuck up on @${victim.username} and made off with their ${sparkle(item.name)}${size}, worth ${groupDigits(worth)} ${cur}! (${groupDigits(fee)} ${cur} fee, ${left}, ${cooldown})`;
      }

      if (fine > 0) debitTx(db!, { userId: uid, amount: fine, reason: 'game:fish_steal_fine', actor: `chat:${me}`, note: victim.username, now });
      d.lifetime.steal.caught++;
      saveFish(db!, uid, d, now);
      log('caught', item.name, picked.held?.cm ?? null, { worth, fee, fine });
      overlay = { kind: 'caught', item: item.name };
      return `🚨 @${victim.username} caught you red-handed reaching for their ${sparkle(item.name)}! You paid a ${groupDigits(fine)} ${cur} fine on top of the ${groupDigits(fee)} ${cur} fee. (${hookLeft}, ${cooldown})`;
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
  /** The reply for words parsePicks couldn't read. */
  const pickError = (error: 'order' | 'length' | 'amount' | 'unknown', verb: 'sell' | 'remove @user' | 'add @user' | 'feed'): string =>
    error === 'order' ? `Name the fish before its length, like ${cmd} fish ${verb} 🦈 72cm`
      : error === 'length' ? 'Only fish have a length.'
        : error === 'unknown' ? `You provided an unknown item type! Use one of: ${runOf(ITEMS.filter(i => !i.custom || g.catches.some(c => c.name === i.name)).map(i => i.name))}`
          : `You provided an invalid amount of items to ${verb.split(' ')[0]}! Put a whole number after a single fish or length, like 🦈 72cm 2.`;

  // ── feed ──
  /**
   * `fish feed 🦈 72cm 🐟 🐟 🦀`: the first fish named eats the rest and gains what they're
   * worth as XP, levelling up (community/fishing.ts addXp): stronger in duels and worth
   * more. Named without a length, it's the highest-level, then longest, of its kind. Food
   * is named as for sell, all or nothing; it can't be the fish itself. A feeding can fail
   * (games.feedFailPercent): the food is gone and no XP is gained.
   */
  function feed(parts: string[], uid: number): void {
    if (!g.feedEnabled) return void say('Feeding fish is off here.');
    const usage = `Usage: ${cmd} fish feed 🦈 72cm 🐟 🐟 🦀 (the first fish eats the rest and levels up)`;
    const parsed = parsePicks(parts);
    if ('error' in parsed) return void say(pickError(parsed.error, 'feed'));
    const [head, ...food] = parsed.picks;
    if (!head || !food.length || head.counted) return void say(usage);
    if (head.item.type !== 'fish') return void say('Only a fish can eat. Name it first, like 🦈 72cm.');
    if (food.some(p => p.item.type !== 'fish')) return void say('Fish only eat fish, not junk.');
    const text = once(now => {
      const d = loadFish(db!, uid);
      const name = head.item.name;
      const list = d?.catch.sizes?.[name] ?? [];
      // The one that eats: of those that long (or any), the highest level, then the longest.
      // Named without a length, not one named as food by its length when another will do:
      // "feed 🦦 🦦57cm" means another 🦦 eats the 57 cm one, not that it eats itself.
      const asFood = new Set(food.filter(p => p.item.name === name && p.cm !== undefined).map(p => p.cm));
      const held = list.slice(0, d?.catch.types[name] ?? 0);
      const spareOne = head.cm === undefined && held.some(h => !asFood.has(h.cm));
      let at = -1;
      held.forEach((h, i) => {
        if (head.cm !== undefined && h.cm !== head.cm) return;
        if (spareOne && asFood.has(h.cm)) return;
        if (at < 0 || levelOf(h) > levelOf(list[at]) || (levelOf(h) === levelOf(list[at]) && h.cm > list[at].cm)) at = i;
      });
      if (!d || at < 0) return `You don't have a ${name}${head.cm !== undefined ? ` ${head.cm} cm` : ''}. ${cmd} fish show ${name} lists yours.`;
      if (levelOf(list[at]) >= MAX_LEVEL) return `Your ${name} ${list[at].cm} cm is already Lv${MAX_LEVEL}, the top level.`;
      // Out of the way while the food is taken, so it can't eat itself.
      const [eater] = list.splice(at, 1);
      d.catch.types[name]--;
      d.catch.fish--;
      const putBack = () => {
        ((d.catch.sizes ??= {})[name] ??= []).splice(at, 0, eater);
        d.catch.types[name] = (d.catch.types[name] ?? 0) + 1;
        d.catch.fish++;
      };
      const want = lengthsWanted(food);
      const short = shortOf(d, want);
      const kinds = food.filter(p => p.cm === undefined);
      // Kinds named without a length come from what's left once the lengths named are taken.
      const byKind = new Map<string, number>();
      for (const p of kinds) byKind.set(p.item.name, (byKind.get(p.item.name) ?? 0) + p.n);
      const shortKinds = [...byKind].flatMap(([n, k]) => {
        const spare = (d.catch.types[n] ?? 0) - [...want.values()].filter(w => w.item.name === n).reduce((sum, w) => sum + w.n, 0);
        return spare < k ? [spare > 0 ? `only ${spare} ${n}` : `no ${n}`] : [];
      });
      if (short.length || shortKinds.length) {
        putBack();
        return `Nothing eaten: you have ${[...short, ...shortKinds].join(', ')}${food.some(p => p.item.name === name) ? ` besides the ${name} ${eater.cm} cm eating` : ''}.`;
      }
      // Its food is worth what it would sell for, before any reel bonus. It eats one at a time
      // and stops once it's full (Lv10): XP past that was lost, so the rest stays in the bucket.
      let toFull = -(eater.xp ?? 0);
      for (let l = levelOf(eater); l < MAX_LEVEL; l++) toFull += levelCost(head.item, g, eater, l);
      const sold = d.lifetime.sold;
      let xp = 0;
      // Labels with how many of each, in the order first eaten. A fed fish eaten is named with
      // its level, so two the same length can be told apart: "🦈 72 cm Lv3".
      const eatenN = new Map<string, number>();
      const leftOverN = new Map<string, number>();
      const tally = (into: Map<string, number>, label: string, k = 1) => { if (k > 0) into.set(label, (into.get(label) ?? 0) + k); };
      const lvTag = (h?: HeldFish) => h && levelOf(h) ? ` Lv${levelOf(h)}` : '';
      for (const w of want.values()) {
        let ate = 0;
        while (ate < w.n && xp < toFull) {
          // The one takeSized takes: the lowest level of that length.
          const next = (d.catch.sizes?.[w.item.name] ?? []).filter(h => h.cm === w.cm).reduce((a, h) => levelOf(h) < levelOf(a) ? h : a);
          xp += takeSized(d, w.item, w.cm, 1, g)!;
          ate++;
          tally(eatenN, `${w.item.name} ${w.cm} cm${lvTag(next)}`);
        }
        tally(leftOverN, `${w.item.name} ${w.cm} cm`, w.n - ate);
      }
      for (const [n, k] of byKind) {
        let ate = 0;
        while (ate < k && xp < toFull) {
          // The one takeItems takes: an unfed one, then an unsized one, then a fed one.
          const list = d.catch.sizes?.[n] ?? [];
          const next = list.find(h => !levelOf(h)) ?? ((d.catch.types[n] ?? 0) > list.length ? undefined : list[0]);
          xp += takeItems(d, ITEMS.find(i => i.name === n)!, 1, g);
          ate++;
          tally(eatenN, next && levelOf(next) ? `${n} ${next.cm} cm${lvTag(next)}` : n);
        }
        tally(leftOverN, n, k - ate);
      }
      const labels = (m: Map<string, number>) => [...m].map(([label, k]) => `${label}${k > 1 ? ` x${k}` : ''}`);
      const eaten = labels(eatenN);
      const leftOver = labels(leftOverN);
      d.lifetime.sold = sold;
      putBack();
      const full = leftOver.length ? ` It was full: ${leftOver.join(', ')} went back to your bucket.` : '';
      const label = `${name} ${eater.cm} cm${lvTag(eater)}`;
      if (randomInt(1, 100) <= g.feedFailPercent) {
        saveFish(db!, uid, d, now);
        console.log(`[FISH] ${me}'s ${label} failed to eat ${eaten.join(' ')} in ${chan}`);
        const kept = leftOver.length ? ` ${leftOver.join(', ')} stayed in your bucket.` : '';
        return `💥 Your ${label} choked on ${eaten.join(', ')}! The food is gone and it gained nothing.${kept}`;
      }
      const gained = addXp(head.item, g, eater, xp);
      saveFish(db!, uid, d, now);
      const lv = levelOf(eater);
      const f = fighterOf(g, head.item, eater);
      console.log(`[FISH] ${me}'s ${label} ate ${eaten.join(' ')} in ${chan}: +${xp} XP, Lv${lv}`);
      const next = lv < MAX_LEVEL ? ` ${groupDigits(eater.xp ?? 0)}/${groupDigits(levelCost(head.item, g, eater, lv))} XP to Lv${lv + 1}.` : ' That\'s the top level!';
      return `🍽️ Your ${label} ate ${eaten.join(', ')} (+${groupDigits(xp)} XP)${gained ? ` and grew to Lv${lv}! 🎉` : `. It's Lv${lv}.`}${next}${full} ❤️${f.hp} ⚔️${f.attack} 💰${groupDigits(sellPrice(head.item, g, eater, eater.stolen ? 1 : currentReel(d, g)?.valueMultiplier ?? 1))}`;
    });
    if (text) say(text);
  }

  // ── remove ──
  /**
   * The streamer or the bot owner takes fish off a viewer, for nothing: a cheater's haul, a
   * test's leftovers. The same words as sell ("🦈 72cm 🐟 3"), or "all" for every fish ("all
   * junk" for junk too). Nothing goes if any of it isn't held. Not a sale: no stats change.
   */
  function remove(parts: string[]): void {
    const usage = `Usage: ${cmd} fish remove @user 🦈 72cm 🐟 3 (fish, lengths, counts) or ${cmd} fish remove @user all`;
    const at = parts.findIndex(p => p.startsWith('@'));
    const name = parseUsername(parts[at >= 0 ? at : 0]);
    const words = parts.filter((_, i) => i !== (at >= 0 ? at : 0));
    if (!name || !words.length) return void say(usage);
    const target = findUserByName(db!, name.toLowerCase());
    if (!target) return void say('No such user exists!');
    const all = words.some(w => /^all$/i.test(w));
    const parsed = all ? null : parsePicks(words);
    if (parsed && 'error' in parsed) return void say(pickError(parsed.error, 'remove @user'));
    const text = once(now => {
      const d = loadFish(db!, target.user_id);
      if (!d || d.catch.fish + d.catch.junk === 0) return `${target.username} has no fish or junk.`;
      const before = { sold: d.lifetime.sold, scrapped: d.lifetime.scrapped };
      const gone: string[] = [];
      if (all) {
        const junkToo = words.some(w => /^junk$/i.test(w));
        for (const item of ITEMS) {
          if (item.type === 'junk' && !junkToo) continue;
          const n = d.catch.types[item.name] ?? 0;
          if (n <= 0) continue;
          takeItems(d, item, n, g);
          gone.push(`${item.name}${n > 1 ? ` x${n}` : ''}`);
        }
      } else {
        const picks = parsed!.picks;
        const want = lengthsWanted(picks);
        const short = shortOf(d, want);
        const kinds = picks.filter(p => p.cm === undefined);
        const shortKinds = kinds.filter(p => (d.catch.types[p.item.name] ?? 0) < p.n).map(p => `${p.n > 1 ? `only ${d.catch.types[p.item.name] ?? 0} ` : 'no '}${p.item.name}`);
        if (short.length || shortKinds.length) return `Nothing removed: ${target.username} has ${[...short, ...shortKinds].join(', ')}.`;
        for (const w of want.values()) {
          takeSized(d, w.item, w.cm, w.n, g);
          gone.push(`${w.item.name} ${w.cm} cm${w.n > 1 ? ` x${w.n}` : ''}`);
        }
        for (const p of kinds) {
          takeItems(d, p.item, p.n, g);
          gone.push(`${p.item.name}${p.n > 1 ? ` x${p.n}` : ''}`);
        }
      }
      if (!gone.length) return `${target.username} has no fish to remove.`;
      // Taken, not sold: their selling stats stay as they were.
      d.lifetime.sold = before.sold;
      d.lifetime.scrapped = before.scrapped;
      saveFish(db!, target.user_id, d, now);
      console.log(`[FISH] ${me} removed ${gone.join(' ')} from ${target.username} in ${chan}`);
      return `🗑️ Removed ${gone.join(', ')} from @${target.username}. They have ${d.catch.fish} fish and ${d.catch.junk} junk left.`;
    });
    if (text) say(text);
  }

  // ── add ──
  /**
   * The streamer or the bot owner hands a viewer fish or junk, from nothing: a prize, a
   * refund for a bug. The same words as sell ("🦈 72cm 🐟 3"); a fish named without a length
   * gets a random one, as a trap's does. Not a catch: no stats, records or history change.
   * Nothing is added past the viewer's bucket caps.
   */
  function add(parts: string[]): void {
    const usage = `Usage: ${cmd} fish add @user 🦈 72cm 🐟 3 (fish or junk, lengths, counts)`;
    const at = parts.findIndex(p => p.startsWith('@'));
    const name = parseUsername(parts[at >= 0 ? at : 0]);
    const words = parts.filter((_, i) => i !== (at >= 0 ? at : 0));
    if (!name || !words.length) return void say(usage);
    const target = findUserByName(db!, name.toLowerCase());
    if (!target) return void say('No such user exists!');
    const parsed = parsePicks(words);
    if ('error' in parsed) return void say(pickError(parsed.error, 'add @user'));
    // Another channel's custom fish isn't one here.
    const foreign = parsed.picks.find(p => p.item.custom && !g.catches.some(c => c.name === p.item.name));
    if (foreign) return void say(pickError('unknown', 'add @user'));
    if (parsed.picks.some(p => p.cm !== undefined && (p.cm < 1 || p.cm > 100))) return void say('A fish is 1 to 100 cm long.');
    const text = once(now => {
      const d = loadFish(db!, target.user_id) ?? initialData();
      const want = { fish: 0, junk: 0 };
      for (const p of parsed.picks) want[p.item.type] += p.n;
      for (const type of ['fish', 'junk'] as const) {
        const cap = capOf(g, type);
        if (cap > 0 && want[type] > 0 && d.catch[type] + want[type] > cap) {
          return `Nothing added: @${target.username} has ${d.catch[type]}/${cap} ${type}, room for ${Math.max(0, cap - d.catch[type])} more.`;
        }
      }
      // A gift from the streamer, not a catch: lifetime counts stay as they were.
      const lifetime = { fish: d.lifetime.fish, junk: d.lifetime.junk };
      const added: string[] = [];
      for (const p of parsed.picks) {
        const cms: number[] = [];
        for (let i = 0; i < p.n; i++) {
          addItem(d, p.item);
          if (p.item.type !== 'fish') continue;
          const cm = p.cm ?? randomInt(1, 100);
          ((d.catch.sizes ??= {})[p.item.name] ??= []).push({ cm, record: false });
          cms.push(cm);
        }
        added.push(p.item.type === 'fish'
          ? (p.cm !== undefined ? `${p.item.name} ${p.cm} cm${p.n > 1 ? ` x${p.n}` : ''}` : `${p.item.name} (${cms.join(', ')} cm)`)
          : `${p.item.name}${p.n > 1 ? ` x${p.n}` : ''}`);
      }
      d.lifetime.fish = lifetime.fish;
      d.lifetime.junk = lifetime.junk;
      saveFish(db!, target.user_id, d, now);
      console.log(`[FISH] ${me} added ${added.join(' ')} to ${target.username} in ${chan}`);
      return `🎁 Added ${added.join(', ')} to @${target.username}. They have ${d.catch.fish} fish and ${d.catch.junk} junk now.`;
    });
    if (text) say(text);
  }

  /** A fish asked for and not held: "🦈" (more than are held) or "🦈 72 cm" (that one). */
  const missingText = (missing: string): string => / cm$/.test(missing)
    ? `You don't have a ${missing} to send (or not that many). ${cmd} fish show ${missing.split(' ')[0]} lists yours.`
    : `You don't have that many ${missing} to send.`;

  async function duel(words: string[], uid: number): Promise<void> {
    const du = g.duel;
    if (!(await duelsOpen())) return;
    const usage = `Usage: ${cmd} fish duel @user [2v2 | 3v3] [fish | random] [amount | keeps]`;
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

    const withSize = splitLengths(words.filter(w => w !== nameWord));
    // 2v2 or 3v3: a team battle, each side's fish one after another.
    const sizeWord = withSize.find(w => teamSizeOf(w) !== null);
    const size = sizeWord ? teamSizeOf(sizeWord)! : 1;
    const rest = withSize.filter(w => w !== sizeWord);
    const others = rest.filter(w => fishNamed([w]) === undefined && !wantsRandom([w]) && !isLength(w));
    if (others.length > 1) return void say(usage);
    const word = others[0]?.toLowerCase();
    const keeps = word === 'keeps' || word === 'keep' || word === 'k';
    if (keeps && !du.allowKeeps) return void say('Duels for keeps are off here. Name an amount, or nothing at all.');
    const stakeOf = (): DuelStake | string => {
      if (keeps) return { kind: 'keeps' };
      if (word === undefined) return { kind: 'friendly' };
      const balance = getUser(db!, uid)?.balance ?? 0;
      const amount = parseBet(word, balance);
      if (amount === null || amount <= 0) return usage;
      if (du.maxWager > 0 && amount > du.maxWager) return `The most you can stake on a fish duel is ${groupDigits(du.maxWager)} ${cur}.`;
      if (amount > balance) return `You only have ${groupDigits(balance)} ${cur}.`;
      if (rival.balance < amount) return `${rival.username} only has ${groupDigits(rival.balance)} ${cur}.`;
      return { kind: 'wager', amount };
    };
    const mineD = loadFish(db!, uid);
    if (size > 1) {
      const theirsD = loadFish(db!, rival.user_id);
      const mine = pickTeam(mineD, g, size, { names: fishSpecs(rest), random: wantsRandom(rest) });
      if (!mine) return void say(`You need ${size} fish for a ${size}v${size} battle.`);
      if ('missing' in mine) return void say(missingText(mine.missing));
      const theirs = pickTeam(theirsD, g, size, keeps ? { values: mine.team.map(p => fishValue(g, p)) } : {});
      if (!theirs || 'missing' in theirs) return void say(`${rival.username} doesn't have ${size} fish to fight with.`);
      const worth = teamValue(g, mine.team);
      if (keeps && !closeInValue(worth, teamValue(g, theirs.team))) {
        return void say(`For keeps, both teams must be close in value: yours is worth ${groupDigits(worth)} and the closest team ${rival.username} has is worth ${groupDigits(teamValue(g, theirs.team))}.`);
      }
      const stake = stakeOf();
      if (typeof stake === 'string') return void say(stake);
      addChallenge(chan, {
        challengerId: uid, challenger: me, targetId: rival.user_id, target: rival.username,
        fish: mine.team[0].item.name, team: mine.team.map(p => ({ fish: p.item.name, ...(p.held ? { cm: p.held.cm } : {}) })),
        stake, expiresAt: now + du.expirySeconds * 1000
      }, now);
      lastChallenge.set(cdKey, now);
      const lineup = describeTeam(mine.team.map(p => p.fighter));
      console.log(`[FISH] ${me} challenged ${rival.username} to a ${size}v${size} battle in ${chan} with ${lineup} (${stake.kind}${stake.kind === 'wager' ? ` ${stake.amount}` : ''})`);
      const keepsNote = stake.kind === 'keeps'
        ? (() => { const [lo, hi] = keepsRange(worth); return ` Their team is worth ${groupDigits(worth)}: yours must be worth ${groupDigits(lo)}–${groupDigits(hi)} (a plain accept sends your closest).`; })()
        : '';
      const text = `⚔️ ${me} challenges you to a ${size}v${size} fish battle with ${lineup}. ${stakeLine(stake)}${keepsNote} Answer within ${span(du.expirySeconds * 1000)}: ${cmd} fish accept [fish…] or ${cmd} fish deny.`;
      pushOverlay(db!, { username: me, kind: 'info', text: `⚔️ challenges ${rival.username} to a ${size}v${size} fish battle with ${lineup}. ${stakeLine(stake)}` });
      return void (await announce(`@${rival.username} ${text}`));
    }
    const theirsD = loadFish(db!, rival.user_id);
    // `random` sends any fish held; the pick is made now and named in the challenge, like a fish asked for.
    // A fish named with its length ("🦈 72cm") is that very one.
    const spec = wantsRandom(rest) ? undefined : fishSpecs(rest)[0];
    const fishName = wantsRandom(rest) ? randomFish(mineD) : spec?.fish;
    const exact = spec?.cm !== undefined ? sameFish(mineD, g, spec.fish, spec.cm) : null;
    if (spec?.cm !== undefined && !exact) return void say(`You don't have a ${specText(spec)}. ${cmd} fish show ${spec.fish} lists yours.`);
    const strongest = exact ?? pickFighter(mineD, g, fishName);
    if (!strongest) return void say(fishName ? `You don't have a ${fishName} to send.` : 'You need a fish to duel with. Go catch one!');
    if (!pickFighter(theirsD, g)) return void say(`${rival.username} has no fish to fight with.`);
    // For keeps, the fish sent is one they hold a fish close in value to: the strongest such, of the kind named if one was.
    const keepsFish = (): Picked | null => {
      if (!exact) return pickForKeeps(mineD, theirsD, g, fishName);
      const v = fishValue(g, exact);
      return heldFish(theirsD, g).some(p => closeInValue(v, fishValue(g, p))) ? exact : null;
    };
    const fighter = keeps ? keepsFish() : strongest;
    if (!fighter) {
      return void say(`For keeps, both fish must be close in value, and ${exact ? `your ${specText(spec!)} isn't` : `none of your ${fishName ?? 'fish'} is`} close to any fish ${rival.username} has.`);
    }

    const stake = stakeOf();
    if (typeof stake === 'string') return void say(stake);

    addChallenge(chan, {
      challengerId: uid, challenger: me, targetId: rival.user_id, target: rival.username,
      fish: fighter.item.name, ...((keeps || exact) && fighter.held ? { cm: fighter.held.cm } : {}), ...(exact ? { exact: true } : {}), stake, expiresAt: now + du.expirySeconds * 1000
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
    const spec = random ? undefined : fishSpecs(words)[0];
    const fishName = spec?.fish;
    type Fought = { off: string } | { retry: string } | { text: string; duel: OverlayDuel; winner: string; turns: number; switches?: number };
    const fought = once((now): Fought => {
      if (c.team) return teamBattle(c, words, uid, now);
      ensureUserTx(db!, uid, me, now);
      const theirs = loadFish(db!, c.challengerId);
      const keeps = c.stake.kind === 'keeps';
      // For keeps, the very fish named in the challenge; one named by length, that one while
      // they still have it; otherwise the biggest of its kind.
      const a = keeps ? sameFish(theirs, g, c.fish, c.cm)
        : (c.exact ? sameFish(theirs, g, c.fish, c.cm) : null) ?? pickFighter(theirs, g, c.fish);
      if (!theirs || !a) return { off: `${c.challenger} no longer has their ${c.fish}, so the duel is off.` };
      const own = loadFish(db!, uid);
      const kind = random ? randomFish(own) : fishName;
      // For keeps, the fish closest in value to theirs, of the kind named if one was, whatever its length.
      // A fish named with its length is that very one.
      const b = spec?.cm !== undefined ? sameFish(own, g, spec.fish, spec.cm)
        : keeps ? pickByValue(own, g, fishValue(g, a), kind) : pickFighter(own, g, kind);
      if (!own || !b) return { retry: spec ? `You don't have a ${specText(spec)} to send.` : 'You have no fish to fight with.' };
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
        const sold = keptOver(sides[w], [picks[l].item], ids[w], names[w], now);
        prize = ` ${names[w]} takes the ${picks[l].item.name}${picks[l].held ? ` (${picks[l].held!.cm} cm)` : ''} for keeps!${sold}`;
      }
      saveFish(db!, ids[0], sides[0], now);
      saveFish(db!, ids[1], sides[1], now);

      const left = Math.round(battle.left[w] / picks[w].fighter.hp * 100);
      const how = left >= 70 ? 'crushed' : left >= 30 ? 'beat' : 'barely survived';
      console.log(`[FISH] duel ${id} in ${chan}: ${names[w]} ${picks[w].item.name} beat ${names[l]} ${picks[l].item.name} in ${battle.turns.length} turns (${c.stake.kind}${c.stake.kind === 'wager' ? ` ${c.stake.amount}` : ''})`);
      return {
        text: `⚔️ @${names[w]}'s ${describe(picks[w].fighter)} ${how} @${names[l]}'s ${describe(picks[l].fighter)} in ${battle.turns.length} turns, with ${left}% health left.${prize}`,
        duel: overlayDuel([names[0], names[1]], [a.fighter, b.fighter], battle, c.stake, cur),
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
    // Fish named after emotes (custom fish) show as the emote on the stage.
    const d0 = fought.duel;
    const duelEmotes = emoteImages(chan, [d0.a.fish, d0.b.fish, ...(d0.teams ?? []).flat().map(f => f.fish)].join(' '));
    pushOverlay(db!, { username: fought.winner, kind: 'duel', text: fought.text.replace(/@/g, ''), duel: d0, ...(Object.keys(duelEmotes).length ? { emotes: duelEmotes } : {}) });
    if (!playing) return void announce(fought.text);
    await announce(`⚔️ ${c.challenger} vs ${me}: the fish ${c.team ? `battle (${c.team.length}v${c.team.length})` : 'duel'} is on! Watch the stream.`);
    // The stream shows the fight streamDelaySeconds behind chat.
    setTimeout(() => void announce(fought.text), playMs(fought.turns, fought.switches ?? 0) + g.streamDelaySeconds * 1000).unref();
  }

  /**
   * Fight a team battle the viewer accepted, inside the accept's write: their team is
   * the fish they name (the rest their strongest), or for keeps each the closest in value
   * to the fish it faces.
   */
  function teamBattle(c: Challenge, words: string[], uid: number, now: number): { off: string } | { retry: string } | { text: string; duel: OverlayDuel; winner: string; turns: number; switches: number } {
    const size = c.team!.length;
    const keeps = c.stake.kind === 'keeps';
    ensureUserTx(db!, uid, me, now);
    const theirs = loadFish(db!, c.challengerId);
    // For keeps, the very fish named in the challenge; otherwise the biggest of each kind.
    const a = findTeam(theirs, g, c.team!, keeps);
    if (!theirs || !a) return { off: `${c.challenger} no longer has the fish they named, so the battle is off.` };
    const own = loadFish(db!, uid);
    const picked = pickTeam(own, g, size, { names: fishSpecs(words), random: wantsRandom(words), ...(keeps ? { values: a.map(p => fishValue(g, p)) } : {}) });
    if (!own || !picked) return { retry: `You need ${size} fish for a ${size}v${size} battle.` };
    if ('missing' in picked) return { retry: missingText(picked.missing) };
    const b = picked.team;
    if (keeps && !closeInValue(teamValue(g, a), teamValue(g, b))) {
      const [lo, hi] = keepsRange(teamValue(g, a));
      return { retry: `For keeps, both teams must be close in value: theirs is worth ${groupDigits(teamValue(g, a))} and yours ${groupDigits(teamValue(g, b))}. Send fish worth ${groupDigits(lo)}–${groupDigits(hi)} together, or ${cmd} fish deny.` };
    }
    if (c.stake.kind === 'wager') {
      if ((getUser(db!, c.challengerId)?.balance ?? 0) < c.stake.amount) return { off: `${c.challenger} can't cover the ${groupDigits(c.stake.amount)} ${cur} stake any more, so the battle is off.` };
      const balance = getUser(db!, uid)?.balance ?? 0;
      if (balance < c.stake.amount) return { retry: `The stake is ${groupDigits(c.stake.amount)} ${cur} and you have ${groupDigits(balance)} ${cur}.` };
    }

    const battle = teamFight(a.map(p => p.fighter), b.map(p => p.fighter));
    const w = battle.winner;
    const l = w === 0 ? 1 : 0;
    const sides = [theirs, own] as const;
    const ids = [c.challengerId, uid] as const;
    const names = [c.challenger, me] as const;
    const teams = [a, b] as const;
    sides[w].lifetime.duel.wins++;
    sides[l].lifetime.duel.losses++;
    const id = Number(db!.prepare(
      `INSERT INTO fish_duels (ts, challenger_id, opponent_id, winner_id, challenger_fish, challenger_cm, opponent_fish, opponent_cm, stake, amount, turns)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(now, ids[0], ids[1], ids[w], a.map(p => p.item.name).join(' '), a[0].fighter.cm, b.map(p => p.item.name).join(' '), b[0].fighter.cm,
      c.stake.kind, c.stake.kind === 'wager' ? c.stake.amount : null, battle.turns.length).lastInsertRowid);

    let prize = '';
    if (c.stake.kind === 'wager') {
      const ref = `fishduel:${id}`;
      debitTx(db!, { userId: ids[l], amount: c.stake.amount, reason: 'game:fish_duel', ref, actor: `chat:${me}`, note: names[w], now });
      const balance = creditTx(db!, { userId: ids[w], amount: c.stake.amount, reason: 'game:fish_duel_win', ref, actor: `chat:${me}`, note: names[l], now });
      sides[w].lifetime.duel.coinsWon += c.stake.amount;
      sides[l].lifetime.duel.coinsLost += c.stake.amount;
      prize = ` ${names[w]} takes ${groupDigits(c.stake.amount)} ${cur} and now has ${groupDigits(balance)}.`;
    } else if (keeps) {
      // One at a time, each found again: moving one shifts where the next of its kind sits.
      for (const p of teams[l]) {
        const now2 = sameFish(sides[l], g, p.item.name, p.held?.cm);
        if (!now2) continue;
        moveFish(sides[l], sides[w], now2.item, now2);
        sides[w].lifetime.duel.fishWon++;
        sides[l].lifetime.duel.fishLost++;
      }
      const sold = keptOver(sides[w], teams[l].map(p => p.item), ids[w], names[w], now);
      prize = ` ${names[w]} takes ${describeTeam(teams[l].map(p => p.fighter))} for keeps!${sold}`;
    }
    saveFish(db!, ids[0], sides[0], now);
    saveFish(db!, ids[1], sides[1], now);

    const standing = battle.left[w].filter(hp => hp > 0).length;
    console.log(`[FISH] battle ${id} in ${chan} (${size}v${size}): ${names[w]} beat ${names[l]} in ${battle.turns.length} turns, ${standing} standing (${c.stake.kind}${c.stake.kind === 'wager' ? ` ${c.stake.amount}` : ''})`);
    return {
      text: `⚔️ @${names[w]}'s team (${describeTeam(teams[w].map(p => p.fighter))}) beat @${names[l]}'s (${describeTeam(teams[l].map(p => p.fighter))}) in ${battle.turns.length} turns, with ${standing} of ${size} fish still standing.${prize}`,
      duel: overlayTeamDuel([names[0], names[1]], [a.map(p => p.fighter), b.map(p => p.fighter)], battle, c.stake, cur),
      winner: names[w],
      turns: battle.turns.length,
      switches: switchesIn(battle)
    };
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
    // A fish or junk by itself is your own: "show 🦈" (or "show shark") lists your sharks.
    const itemWord = (w: string | undefined): CatchItem | undefined => {
      // "fish" and "junk" are the kinds of catch here, not 🐟.
      if (!w || /^(fish|junk)$/i.test(w)) return undefined;
      const bare = w.replace(/\uFE0F/g, '');
      const fish = fishNamed([bare]);
      return ITEMS.find(i => i.name === (fish ?? bare));
    };
    const [userOrType, optionalType] = parts.length === 1 && itemWord(parts[0]) ? [undefined, parts[0]] : parts;
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
          emojiItem = itemWord(optionalType);
          if (!emojiItem) return void say('You must provide a proper catch type (fish or junk) or a proper catch emoji!');
        }
      }
    } else if (optionalType) {
      emojiItem = itemWord(optionalType);
    }
    const d = targetId === null ? null : loadFish(db!, targetId);
    const [subject, possessive] = self ? ['You', 'your'] : ['They', 'their'];
    // Holding anything counts too: fish can arrive without a cast (a steal, or a tester's setup).
    if (!d || (!hasFishedBefore(d) && d.catch.fish + d.catch.junk === 0)) return void say(`${subject} have never gone fishing before.`);
    if (emojiItem?.type === 'fish' && (d.catch.types[emojiItem.name] ?? 0) > 0) return void say(`${subject} have ${fishList(d, emojiItem)}`);
    if (emojiItem) {
      const n = d.catch.types[emojiItem.name] ?? 0;
      const itemString = !n ? `no ${emojiItem.name}` : n < 5 ? `${emojiItem.name} `.repeat(n).trim() : `${n}x ${emojiItem.name}`;
      return void say(`${subject} have ${itemString} in ${possessive} collection.`);
    }
    const purse = getUser(db!, targetId!)?.balance ?? 0;
    const listOf = (type: CatchType): string => {
      const list: string[] = [];
      for (const [emoji, count] of Object.entries(d.catch.types)) {
        if (count <= 0) continue;
        if (ITEMS.find(i => i.name === emoji)?.type !== type) continue;
        list.push(count < 5 && !isWordName(emoji) ? emoji.repeat(count) : count < 5 ? Array(count).fill(emoji).join(' ') : `${count}x ${emoji}`);
      }
      return runOf(list);
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

  /**
   * Every fish of a kind held, biggest first, each with its fighting stats and price, so
   * one can be picked by length: "3 🦈 (🦷 Predator · Epic): 87 cm ❤️104 ⚔️19.7 💰2,610 | …".
   * Fish of the same length are the same in a fight, so they're shown once with a count.
   */
  function fishList(d: FishData, item: CatchItem): string {
    const all = heldFish(d, g, item.name);
    // heldFish gives one entry for all the fish with no length: count them back in.
    const have = d.catch.types[item.name] ?? 0;
    const unsized = have - all.filter(p => p.held).length;
    const groups: Array<{ p: Picked; n: number }> = [];
    for (const p of [...all].sort((a, b) => (b.held?.cm ?? -1) - (a.held?.cm ?? -1) || fishValue(g, b) - fishValue(g, a))) {
      const same = groups.find(x => x.p.held?.cm === p.held?.cm && fishValue(g, x.p) === fishValue(g, p));
      if (same) same.n++;
      else groups.push({ p, n: p.held ? 1 : unsized });
    }
    const MAX = 10;
    const f = all[0].fighter;
    const line = groups.slice(0, MAX).map(({ p, n }) =>
      `${p.held ? `${p.held.cm} cm${p.fighter.level ? ` Lv${p.fighter.level}` : ''}` : 'no size'}${n > 1 ? ` ×${n}` : ''} ❤️${p.fighter.hp} ⚔️${p.fighter.attack} 💰${groupDigits(fishValue(g, p))}`).join(' | ');
    const more = groups.length > MAX ? ` | +${groups.slice(MAX).reduce((x, y) => x + y.n, 0)} more` : '';
    const pick = g.duel.enabled && groups.some(x => x.p.held) ? ` Duel a certain one with ${cmd} fish duel @user ${item.name} ${groups.find(x => x.p.held)!.p.held!.cm}cm` : '';
    return `${have} ${item.name} (${TYPE_EMOJI[f.type]} ${f.type} · ${f.rarity}): ${line}${more}.${pick}`;
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
      {
        // A time: `trap 2h` lays them for that long, `trap reset 2h` lays them again for it.
        const op = long((rest[0] ?? '').toLowerCase(), TRAP_SHORT);
        if (op === 'reset') return await trap(op, userId, undefined, rest[1] === undefined ? undefined : parseTrapMinutes(rest[1]));
        const mins = rest[0] === undefined ? null : parseTrapMinutes(rest[0]);
        return await trap(mins === null ? op : '', userId, undefined, mins ?? undefined);
      }
      case 'answer':
        if (userId === null || excluded) return ignore('no account or excluded');
        // Only a waiting question skips the cooldown (checkAnswer, above).
        if (!loadFish(db, userId)?.trapCheck && cooldown(meLc)) return;
        return await trap('answer', userId, rest.join(' ').trim() || undefined);
      case 'steal':
        if (userId === null || excluded) return ignore('no account or excluded');
        // Alone, the thief's own status; `check @user [fish]` scouts a target. Neither spends anything.
        if (rest[0] === undefined) return await stealStatus(userId);
        if (/^(check|c)$/i.test(rest[0]) && rest[1] !== undefined) return await stealCheck(rest[1], userId, rest.slice(2));
        return await steal(rest[0], userId, rest.slice(1));
      case 'give':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = true;
        return give(rest, userId);
      case 'trade':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = true;
        return await trade(rest, userId);
      case 'feed':
        if (userId === null || excluded) return ignore('no account or excluded');
        return feed(rest, userId);
      case 'remove':
        // The streamer and the bot owner only; the answer goes to chat, whatever the reply settings.
        if (!(tags.isBroadcaster || isBotOwner(me))) return ignore('remove is for the streamer and the bot owner');
        duelReply = true;
        return remove(rest);
      case 'add':
        // The streamer and the bot owner only, like remove.
        if (!(tags.isBroadcaster || isBotOwner(me))) return ignore('add is for the streamer and the bot owner');
        duelReply = true;
        return add(rest);
      case 'duel':
        if (userId === null || excluded) return ignore('no account or excluded');
        duelReply = g.duel.enabled;
        return await duel(rest, userId);
      case 'accept':
        if (userId === null || excluded) return ignore('no account or excluded');
        // A trade offer answers to accept/decline too, when no duel challenge is waiting.
        if (!challengeFor(chan, userId) && tradeFor(chan, userId)) {
          duelReply = true;
          return acceptTrade(userId);
        }
        duelReply = g.duel.enabled;
        return await accept(rest, userId);
      case 'deny':
        if (userId === null || excluded) return ignore('no account or excluded');
        if (!challengeFor(chan, userId) && tradeFor(chan, userId)) {
          duelReply = true;
          return declineTrade(userId);
        }
        duelReply = g.duel.enabled;
        return await deny(userId);
      case 'reel':
        if (userId === null || excluded) return ignore('no account or excluded');
        return reelIn(rest[0], userId);
      case 'overlay':
        if (!(tags.isBroadcaster || tags.isModUp || isBotOwner(me))) return ignore('overlay is for mods, the streamer and the bot owner');
        duelReply = true;
        return overlaySwitch(rest[0]);
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
