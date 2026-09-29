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
 *          $don fish top [fish|coins|junk|lucky|unlucky|traps|attempts|total-…|emoji]   (also leaderboard)
 *          $don fish trap [cancel|reset]                (also net, trawl)
 *          $don fish buy [reel|hook|guard]              (shows the shop; "buy reel" buys the next reel)
 *          $don fish steal @user                        (also rob; needs a hook, see games.steal)
 *              Reaches for one random fish the target has held a while; succeeds by
 *              its rarity. Every try uses one hook try and a fee on that fish's value;
 *              caught, a fine too, set from the odds so thieves lose games.steal.
 *              edgePercent on average. Nobody receives either. A thief who can't cover
 *              both for the target's costliest fish, or who meets a guard, loses one
 *              hook use and nothing else.
 *
 * Casting, laying traps and stealing follow games.onlyWhileLive and stay silent offline,
 * like $<cmd> gamble. Everything that changes a balance or a catch runs in one
 * points-database transaction keyed on the Kick message id.
 */

import fetch from 'node-fetch';
import { ChannelConfig, CommandFn, FishReelSetting } from '../types';
import { isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import { getPointsService } from '../points/service';
import { runWrite } from '../points/db';
import type { PointsDb } from '../points/db';
import { applyOnce, creditTx, debitTx, ensureUserTx, findUserByName, getUser, isApplied, isExcluded } from '../points/store';
import { makeCooldown, parseUsername, span } from '../community/format';
import { gameInvocation } from '../community/stakes';
import { addReminder, cancelSelfRemindersStartingWith, openCommunityDb } from '../community/store';
import { bestEmote, broadcasterIdFor, emoteImages } from '../community/emotes';
import { OverlayKind, pushOverlay } from '../community/fish-overlay';
import {
  addItem, baitPrice, baitRoll, currentReel, heldFishValue, landsFish, moveFish, pickHeld, stealableFish, stealChance, stealCharges, worstStealCharges, parseSellList, CatchItem, CatchType, FAILURE_EMOTES, FishData, findBait, hasFishedBefore, initialData, rarityOf, recordCatch,
  ITEMS, JUNK_MESSAGES, loadFish, MISS_DELAY_MS, pick, randomInt, rollCatch, saveFish, sellPrice, STORY_STYLES, SUCCESS_EMOTES,
  takeItems, TYPE_DESCRIPTIONS, weightedCatch
} from '../community/fishing';

const cooldown = makeCooldown(5000);
const pointer = makeCooldown(60_000);

const SUBCOMMANDS: Record<string, 'buy' | 'sell' | 'show' | 'stats' | 'top' | 'trap' | 'steal'> = {
  buy: 'buy', sell: 'sell',
  show: 'show', count: 'show', display: 'show', collection: 'show',
  stats: 'stats', top: 'top', leaderboard: 'top',
  trap: 'trap', net: 'trap', trawl: 'trap',
  steal: 'steal', rob: 'steal'
};

const STORY_MODEL = 'claude-haiku-4-5-20251001';
/** supibot asks for 150 characters; allow some overrun before trimming. */
const STORY_MAX = 220;
const groupDigits = (n: number): string => Math.round(n).toLocaleString('en-US');

// ─── Leaderboards ───────────────────────────────────────────────────────────

interface Board { path: string | null; name: string; value: (d: FishData, balance: number) => number | null }

const BOARDS = new Map<string, Board>([
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
  ...ITEMS.map(i => [i.name, { path: `$.catch.types."${i.name}"`, name: `${i.name} collectors`, value: (d: FishData) => d.catch.types[i.name] ?? null }] as [string, Board])
]);

type TopRow = { user_id: number; username: string; value: number };

function topRows(db: PointsDb, board: Board): TopRow[] {
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

export const fish: CommandFn = async function fish(client, message, channel, tags, config) {
  const call = gameInvocation(message, channel, 'fish');
  if (!call) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  if (call.form === 'redirect') return void (pointer(meLc) || client.say(channel, `@${me} it's ${call.usage} here`));
  if (SYSTEM_BOTS.has(meLc) || isBotSender(me, tags.senderId)) return;
  if (cooldown(meLc)) return;

  const chan = channel.replace(/^#/, '').toLowerCase();
  const svc = getPointsService(chan);
  const db = svc?.db();
  if (!svc || !db) return;
  const cfg = svc.config();
  const g = cfg.games;
  const cur = cfg.currencyName;
  const cmd = call.usage.replace(/ fish$/, '');

  /**
   * Reply in chat. A cast's result, a trap haul or a steal (meta.kind) also goes to
   * the overlay. Only cast results and trap hauls skip chat where the channel turned
   * chat replies off; every other reply, steals included, always goes to chat.
   */
  const say = (text: string, meta: { kind?: OverlayKind; item?: string } = {}) => {
    if (meta.kind) {
      const emotes = emoteImages(chan, text);
      const rarity = meta.item ? rarityOf(g, meta.item) : null;
      pushOverlay(db, {
        username: me, kind: meta.kind, text,
        ...(meta.item ? { item: meta.item } : {}), ...(rarity ? { rarity } : {}), ...(Object.keys(emotes).length ? { emotes } : {})
      });
      if (!g.chatReplies && (meta.kind === 'catch' || meta.kind === 'miss' || meta.kind === 'trap')) return;
    }
    return client.say(channel, `@${me} ${text}`);
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
  // Staging: named testers can try stealing anywhere, any time (debugStealTesters).
  const tester = cfg.debugStealTesters.includes(meLc);
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
  const liveOk = async (): Promise<boolean> => {
    if (!g.onlyWhileLive) return true;
    const live = await svc.isLiveNow();
    if (live !== true) ignore(live === null ? 'live state unknown' : 'offline');
    return live === true;
  };
  const emotesFor = (list: readonly string[], fallback: string) => bestEmote(chan, broadcasterIdFor(config as ChannelConfig), list, fallback);

  // ── cast ──
  async function cast(baitWord: string | undefined, uid: number): Promise<void> {
    if (!(await liveOk())) return;
    const bait = findBait(baitWord);
    type Outcome =
      | { kind: 'reply'; text: string }
      | { kind: 'miss'; text: string; delay: number; appendix: string; streak: string }
      | { kind: 'catch'; item: CatchItem; sizeString: string; appendix: string };

    const out = once<Outcome>(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
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
      addItem(d, item);
      d.catch.dryStreak = 0;
      d.catch.luckyStreak++;
      if (d.catch.luckyStreak > d.lifetime.luckyStreak) d.lifetime.luckyStreak = d.catch.luckyStreak;
      d.readyTimestamp = now + g.catchCooldownMinutes * 60_000;
      let sizeString = '';
      if (item.size) {
        const size = randomInt(1, 100);
        sizeString = `It is ${size} cm in length.`;
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
      } else {
        recordCatch(db!, uid, item.name, 'cast', null, now);
      }
      saveFish(db!, uid, d, now);
      return { kind: 'catch', item, sizeString, appendix };
    });
    if (!out) return;
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
   * The reminder that pings a viewer when their traps are full, posted through
   * !remind's timer so it survives a restart. It needs !remind on to be delivered.
   * Collecting, cancelling or re-laying the traps first clears the old one.
   */
  const TRAP_REMINDER = 'your fishing traps are ready';
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
  async function trap(operation: string, uid: number): Promise<void> {
    const before = loadFish(db!, uid) ?? initialData();
    // Laying traps is fishing, so it follows the live rule; collecting or cancelling doesn't.
    const laysTraps = operation !== 'cancel' && (!before.trap.active || operation === 'reset');
    if (laysTraps && !(await liveOk())) return;
    const waitEmote = await emotesFor(['PauseChamp'], '⌛');
    // What the traps are after this message: laid until a time, emptied, or untouched.
    let after: { laidUntil: number | null } | null = null;
    let collected = false;

    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if (d.readyTimestamp !== 0 && now < d.readyTimestamp) {
        return `Hol' up partner! You can go set up your fishing traps in ${span(d.readyTimestamp - now)}!`;
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
      if (operation === 'cancel') {
        if (!d.trap.active) return "You cannot cancel your fishing traps as you don't have them set up!";
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
        after = { laidUntil: null };
        d.lifetime.trap.cancelled++;
        reply = "You have successfully retrieved your traps before they filled up. You don't get any junk or fish.";
      } else if (!d.trap.active) {
        reply = setUp();
      } else if (now <= d.trap.end) {
        return `Your traps are not fully loaded yet! They will be ready to harvest in ${span(d.trap.end - now)}. If you wish to get rid of them immediately, use "${cmd} fish trap cancel", but you will not get any catch from your traps.`;
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
  }

  // ── sell ──
  function sell(parts: string[], uid: number): void {
    const [specifier] = parts;
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
        const types = [...new Set(parts.slice(1).map(w => w.toLowerCase()))];
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
    if (!tester && !(await liveOk())) return;
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
      const log = (outcome: string, item: string | null, cm: number | null) =>
        db!.prepare('INSERT INTO steals (ts, thief_id, victim_id, name, cm, outcome) VALUES (?, ?, ?, ?, ?, ?)').run(now, uid, victim.user_id, item, cm, outcome);

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

      if (randomInt(1, 100) <= chance) {
        moveFish(v, d, item, picked);
        d.lifetime.steal.stolen++;
        v.lifetime.steal.lost++;
        saveFish(db!, uid, d, now);
        saveFish(db!, victim.user_id, v, now);
        log('stolen', item.name, picked.held?.cm ?? null);
        overlay = { kind: 'steal', item: item.name };
        const size = picked.held ? ` (${picked.held.cm} cm)` : '';
        const left = d.hook > 0 ? `${tries(d.hook)} left on your hook` : 'your hook is used up';
        return `🪝 You snuck up on @${victim.username} and made off with their ✨${item.name}✨${size}, worth ${groupDigits(worth)} ${cur}! (${groupDigits(fee)} ${cur} fee, ${left}, ${cooldown})`;
      }

      if (fine > 0) debitTx(db!, { userId: uid, amount: fine, reason: 'game:fish_steal_fine', actor: `chat:${me}`, note: victim.username, now });
      d.lifetime.steal.caught++;
      saveFish(db!, uid, d, now);
      log('caught', item.name, picked.held?.cm ?? null);
      overlay = { kind: 'caught', item: item.name };
      const hookLeft = d.hook > 0 ? `${tries(d.hook)} left on your 🪝 hook` : 'your 🪝 hook is used up';
      return `🚨 @${victim.username} caught you red-handed reaching for their ✨${item.name}✨! You paid a ${groupDigits(fine)} ${cur} fine on top of the ${groupDigits(fee)} ${cur} fee. (${hookLeft}, ${cooldown})`;
    });
    const out = overlay as { kind: OverlayKind; item: string } | null;
    if (text) say(text, out ?? {});
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
         COALESCE(SUM(CAST(json_extract(data, '$.lifetime.attempts') AS INTEGER) > 0), 0) AS anglers
       FROM fish ${targetId === null ? '' : 'WHERE user_id = ?'}`
    ).get(...(targetId === null ? [] : [targetId])) as Record<string, number>;
    const prefix = targetId === null ? 'Global' : self ? 'Your' : 'Their';
    const anglers = targetId === null ? ` anglers: ${groupDigits(row.anglers)};` : '';
    say(`${prefix} fishing stats → attempts: ${groupDigits(row.attempts)};${anglers} caught fish: ${groupDigits(row.fish)}; caught junk: ${groupDigits(row.junk)}; traps set up: ${groupDigits(row.traps)}; bait used: ${groupDigits(row.bait)}; fish sold: ${groupDigits(row.sold)}; junk scrapped: ${groupDigits(row.scrapped)}; worst dry streak: ${groupDigits(row.dry)}; best lucky streak: ${groupDigits(row.lucky)}${g.steal.enabled ? `; fish stolen: ${groupDigits(row.stolen)}; caught stealing: ${groupDigits(row.caught)}` : ''}.`);
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
        return buy((rest[0] ?? '').toLowerCase(), userId);
      case 'show':
        return show(rest);
      case 'stats':
        return stats(rest[0]);
      case 'top':
        return top(rest[0]);
      case 'sell':
        if (userId === null || excluded) return ignore('no account or excluded');
        return sell(rest, userId);
      case 'trap':
        if (userId === null || excluded) return ignore('no account or excluded');
        return await trap((rest[0] ?? '').toLowerCase(), userId);
      case 'steal':
        if (userId === null || excluded) return ignore('no account or excluded');
        return await steal(rest[0], userId);
      default:
        if (userId === null || excluded) return ignore('no account or excluded');
        return await cast(rest[0], userId);
    }
  } catch (err) {
    console.error(`[FISH] ${me} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
