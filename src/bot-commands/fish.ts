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
 *          $don fish sell <emoji> [n] · sell all fish|junk · sell duplicate fish|junk
 *          $don fish show [user] [fish|junk|emoji]      (also count, display, collection)
 *          $don fish stats [user|global]
 *          $don fish top [fish|coins|junk|lucky|unlucky|traps|attempts|total-…|emoji]   (also leaderboard)
 *          $don fish trap [cancel|reset]                (also net, trawl)
 *          $don fish buy
 *
 * Casting and laying traps follow games.onlyWhileLive and stay silent offline,
 * like $<cmd> gamble. Everything that changes a balance or a catch runs in one
 * points-database transaction keyed on the Kick message id.
 */

import fetch from 'node-fetch';
import { ChannelConfig, CommandFn } from '../types';
import { isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import { getPointsService } from '../points/service';
import { runWrite } from '../points/db';
import type { PointsDb } from '../points/db';
import { applyOnce, creditTx, debitTx, ensureUserTx, findUserByName, getUser, isApplied, isExcluded } from '../points/store';
import { makeCooldown, parseUsername, span } from '../community/format';
import { gameInvocation } from '../community/stakes';
import { bestEmote, broadcasterIdFor } from '../community/emotes';
import {
  addItem, baitPrice, baitRoll, CatchItem, CatchType, FAILURE_EMOTES, FishData, findBait, hasFishedBefore, initialData,
  ITEMS, JUNK_MESSAGES, loadFish, MISS_DELAY_MS, pick, randomInt, rollCatch, saveFish, sellPrice, STORY_STYLES, SUCCESS_EMOTES,
  TYPE_DESCRIPTIONS, weightedCatch
} from '../community/fishing';

const cooldown = makeCooldown(5000);
const pointer = makeCooldown(60_000);

const SUBCOMMANDS: Record<string, 'buy' | 'sell' | 'show' | 'stats' | 'top' | 'trap'> = {
  buy: 'buy', sell: 'sell',
  show: 'show', count: 'show', display: 'show', collection: 'show',
  stats: 'stats', top: 'top', leaderboard: 'top',
  trap: 'trap', net: 'trap', trawl: 'trap'
};

const STORY_MODEL = 'claude-haiku-4-5-20251001';
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

async function story(user: string, fishType: string, sizeString: string): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const prompt = `Write a short, ${pick(STORY_STYLES)} fishing story about a user named "${user}" who catches a ${fishType} in the water and keeps it! ${sizeString} Make it very concise - a maximum of 150 characters.`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: STORY_MODEL,
      max_tokens: 120,
      system: 'Reply with the story only: plain text, one short paragraph, no title, no quotes, no markdown, no @ signs.',
      messages: [{ role: 'user', content: prompt }]
    }),
    timeout: 15_000
  });
  if (!resp.ok) throw new Error(`API returned ${resp.status}`);
  const data = await resp.json() as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join(' ').replace(/@/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > 220 ? `${text.slice(0, 219)}…` : text;
}

// ─── Command ────────────────────────────────────────────────────────────────

export const fish: CommandFn = async function fish(client, message, channel, tags, config) {
  const call = gameInvocation(message, channel, 'fish');
  if (!call) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  const say = (text: string) => client.say(channel, `@${me} ${text}`);
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
  const excluded = isExcluded(svc.exclusions(), userId, meLc);
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

      if (randomInt(1, rollMaximum) !== 1) {
        const delay = Math.round(randomInt(MISS_DELAY_MS[0], MISS_DELAY_MS[1]) / 1000) * 1000;
        d.catch.dryStreak++;
        d.catch.luckyStreak = 0;
        d.readyTimestamp = now + delay + 1000;
        if (d.catch.dryStreak > d.lifetime.dryStreak) d.lifetime.dryStreak = d.catch.dryStreak;
        let text: string;
        if (randomInt(1, 100) <= 25) {
          const item = weightedCatch('junk');
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

      const item = weightedCatch('fish');
      addItem(d, item);
      d.catch.dryStreak = 0;
      d.catch.luckyStreak++;
      if (d.catch.luckyStreak > d.lifetime.luckyStreak) d.lifetime.luckyStreak = d.catch.luckyStreak;
      d.readyTimestamp = now + g.catchCooldownMinutes * 60_000;
      let sizeString = '';
      if (item.size) {
        const size = randomInt(1, 100);
        sizeString = `It is ${size} cm in length.`;
        if (size > d.lifetime.maxFishSize) {
          sizeString += ' This is a new record!';
          d.lifetime.maxFishSize = size;
          d.lifetime.maxFishType = item.name;
        }
      }
      saveFish(db!, uid, d, now);
      return { kind: 'catch', item, sizeString, appendix };
    });
    if (!out) return;
    if (out.kind === 'reply') return void say(out.text);

    if (out.kind === 'miss') {
      const emote = await emotesFor(FAILURE_EMOTES, '😔');
      return void say(`No luck... ${emote} ${out.text} (${span(out.delay)} cooldown${out.appendix})${out.streak}`);
    }

    console.log(`[FISH] ${me} caught ${out.item.name} in ${chan}`);
    const minutes = g.catchCooldownMinutes;
    if (g.stories && !skipStory && randomInt(1, 3) === 1) {
      try {
        const text = await story(me, out.item.name, out.sizeString);
        if (text) return void say(`✨${out.item.name}✨ ${text} (${minutes}m cooldown${out.appendix})`);
      } catch (err) {
        console.error(`[FISH] Story for ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const emote = await emotesFor(SUCCESS_EMOTES, '😃');
    const size = out.sizeString ? ` ${out.sizeString}` : '';
    return void say(`You caught a ✨${out.item.name}✨${size} ${emote} Now, go do something productive! (${minutes} minute fishing cooldown after a successful catch)`);
  }

  // ── trap ──
  async function trap(operation: string, uid: number): Promise<void> {
    const before = loadFish(db!, uid) ?? initialData();
    // Laying traps is fishing, so it follows the live rule; collecting or cancelling doesn't.
    const laysTraps = operation !== 'cancel' && (!before.trap.active || operation === 'reset');
    if (laysTraps && !(await liveOk())) return;
    const waitEmote = await emotesFor(['PauseChamp'], '⌛');

    const text = once(now => {
      ensureUserTx(db!, uid, me, now);
      const d = loadFish(db!, uid) ?? initialData();
      if (d.readyTimestamp !== 0 && now < d.readyTimestamp) {
        return `Hol' up partner! You can go set up your fishing traps in ${span(d.readyTimestamp - now)}!`;
      }
      const setUp = (): string => {
        const duration = g.trapMinutes * 60_000;
        d.trap = { active: true, start: now, end: now + duration, duration };
        return `You have laid your fishing traps. Now we wait... ${waitEmote} You can check them in about ${span(duration)}.`;
      };
      const collect = (): string => {
        const rolls = Math.floor(d.trap.duration / 60_000 * randomInt(75, 90) / 100);
        const skip = g.catchCooldownMinutes;
        let fishAmount = 0;
        const results: string[] = [];
        for (let i = 0; i < rolls; i++) {
          const r = rollCatch(g.catchOdds);
          if (!r.item) continue;
          // A fish costs a catch cooldown of the trap's time, so only an early one counts.
          if (r.type === 'fish' && i < rolls - skip) {
            fishAmount++;
            i += skip;
            addItem(d, r.item);
            results.push(r.item.name);
          } else if (r.type === 'junk') {
            addItem(d, r.item);
            results.push(r.item.name);
          }
        }
        d.lifetime.trap.times++;
        d.lifetime.trap.timeSpent += d.trap.duration;
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
        if (fishAmount > d.lifetime.trap.bestFishCatch) d.lifetime.trap.bestFishCatch = fishAmount;
        if (!results.length) return 'You drag the traps out of the water... and find that there is nothing at all...!';
        if (fishAmount === 0) return `You drag the traps out of the water... and find a bunch of junk. ${results.join('')}`;
        return `You drag the traps out of the water... and you spot some fish! ${results.join('')}`;
      };

      let reply: string;
      if (operation === 'cancel') {
        if (!d.trap.active) return "You cannot cancel your fishing traps as you don't have them set up!";
        d.trap = { active: false, start: 0, end: 0, duration: 0 };
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
    if (text) say(text);
  }

  // ── sell ──
  function sell(parts: string[], uid: number): void {
    const [specifier, modifier] = parts;
    const text = once(now => {
      const d = loadFish(db!, uid);
      if (!d || (d.catch.fish === 0 && d.catch.junk === 0)) return 'You have no items to sell!';
      const pay = (gained: number): number => gained > 0
        ? creditTx(db!, { userId: uid, username: me, amount: gained, reason: 'game:fish_sell', actor: `chat:${me}`, now })
        : getUser(db!, uid)?.balance ?? 0;

      if (specifier === 'all' || specifier === 'duplicate') {
        const type = modifier === 'fish' || modifier === 'junk' ? modifier as CatchType : null;
        if (!type) {
          return "When selling all, you must provide a type! You don't wanna sell all of your stuff by accident, right? Use one of: fish, junk";
        }
        const threshold = specifier === 'all' ? 0 : 1;
        let gained = 0;
        let sold = 0;
        for (const item of ITEMS) {
          if (item.type !== type) continue;
          const have = d.catch.types[item.name] ?? 0;
          if (have <= threshold) continue;
          const n = have - threshold;
          sold += n;
          gained += n * sellPrice(item, g);
          d.catch.types[item.name] = threshold;
          d.catch[type] -= n;
          if (type === 'fish') d.lifetime.sold += n;
          else d.lifetime.scrapped += n;
        }
        const prefix = specifier === 'duplicate' ? 'duplicate ' : '';
        if (sold === 0) return `You have no ${prefix}${TYPE_DESCRIPTIONS[type]} to sell!`;
        d.lifetime.coins += gained;
        const balance = pay(gained);
        saveFish(db!, uid, d, now);
        return `You sold ${sold} ${prefix}${TYPE_DESCRIPTIONS[type]} for a grand total of ${gained} ${cur} - now you have ${balance} ${cur}`;
      }

      const item = ITEMS.find(i => i.name === specifier);
      if (!item) return `You provided an unknown item type! Use one of: ${ITEMS.map(i => i.name).join('')}`;
      const have = d.catch.types[item.name] ?? 0;
      if (have === 0) return `You have no ${item.name} to sell!`;
      let requested = Number(modifier);
      if (modifier === undefined || Number.isNaN(requested)) requested = 1;
      else if (!Number.isInteger(requested) || requested < 1) {
        return 'You provided an invalid amount of items to sell! You need to use a positive integer (a whole number).';
      }
      const n = Math.min(have, requested);
      d.catch.types[item.name] = have - n;
      d.catch[item.type] -= n;
      if (item.type === 'fish') d.lifetime.sold += n;
      else d.lifetime.scrapped += n;
      const gained = n * sellPrice(item, g);
      d.lifetime.coins += gained;
      const balance = pay(gained);
      saveFish(db!, uid, d, now);
      return `Sold your ${item.name}${n > 1 ? ` x${n}` : ''} for ${gained} ${cur} - now you have ${balance} ${cur}`;
    });
    if (text) say(text);
  }

  // ── show ──
  function show(parts: string[]): void {
    const [userOrType, optionalType] = parts;
    let showType: CatchType = 'fish';
    let emojiItem: CatchItem | undefined;
    let targetId = userId;
    let self = true;
    if (userOrType) {
      if (userOrType === 'fish' || userOrType === 'junk') {
        showType = userOrType;
      } else {
        const name = parseUsername(userOrType);
        if (name && isBotSender(name)) return void say("I can't go fishing, if water splashed around it would damage my circuits! 😨");
        const found = name ? findUserByName(db!, name.toLowerCase()) : undefined;
        if (!found) return void say('No such user exists!');
        targetId = found.user_id;
        self = found.user_id === userId;
      }
      if (optionalType) {
        if (optionalType === 'fish' || optionalType === 'junk') showType = optionalType;
        else {
          emojiItem = ITEMS.find(i => i.name === optionalType);
          if (!emojiItem) return void say('You must provide a proper catch type (fish or junk) or a proper catch emoji!');
        }
      }
    }
    const d = targetId === null ? null : loadFish(db!, targetId);
    const [subject, possessive] = self ? ['You', 'your'] : ['They', 'their'];
    if (!d || !hasFishedBefore(d)) return void say(`${subject} have never gone fishing before.`);
    if (emojiItem) {
      const n = d.catch.types[emojiItem.name] ?? 0;
      const itemString = !n ? 'no' : n < 5 ? `${emojiItem.name} `.repeat(n).trim() : `${n}x ${emojiItem.name}`;
      return void say(`${subject} have ${itemString} in ${possessive} collection.`);
    }
    const purse = getUser(db!, targetId!)?.balance ?? 0;
    const amount = d.catch[showType] ?? 0;
    if (amount <= 0) {
      return void say(`${subject} have no ${TYPE_DESCRIPTIONS[showType]} in ${possessive} collection, and ${possessive} purse contains ${purse} ${cur}.`);
    }
    const list: string[] = [];
    for (const [emoji, count] of Object.entries(d.catch.types)) {
      if (count <= 0) continue;
      if (ITEMS.find(i => i.name === emoji)?.type !== showType) continue;
      list.push(count < 5 ? emoji.repeat(count) : `${count}x ${emoji}`);
    }
    return void say(`${subject} have ${amount} ${TYPE_DESCRIPTIONS[showType]} in ${possessive} collection. Here they are: ${list.join('')} ${subject} also have ${purse} ${cur} in ${possessive} purse.`);
  }

  // ── stats ──
  function stats(userOrGlobal: string | undefined): void {
    let targetId: number | null = null;
    let self = false;
    if (userOrGlobal !== 'global') {
      if (userOrGlobal) {
        const name = parseUsername(userOrGlobal);
        if (name && isBotSender(name)) return void say("I'm sitting on the streamer's table, there's no fish to catch here!");
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
         COALESCE(SUM(CAST(json_extract(data, '$.lifetime.attempts') AS INTEGER) > 0), 0) AS anglers
       FROM fish ${targetId === null ? '' : 'WHERE user_id = ?'}`
    ).get(...(targetId === null ? [] : [targetId])) as Record<string, number>;
    const prefix = targetId === null ? 'Global' : self ? 'Your' : 'Their';
    const anglers = targetId === null ? ` anglers: ${groupDigits(row.anglers)};` : '';
    say(`${prefix} fishing stats → attempts: ${groupDigits(row.attempts)};${anglers} caught fish: ${groupDigits(row.fish)}; caught junk: ${groupDigits(row.junk)}; traps set up: ${groupDigits(row.traps)}; bait used: ${groupDigits(row.bait)}; fish sold: ${groupDigits(row.sold)}; junk scrapped: ${groupDigits(row.scrapped)}; worst dry streak: ${groupDigits(row.dry)}; best lucky streak: ${groupDigits(row.lucky)}.`);
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
        return void say("There isn't anything you can buy at the fishing gear shop... yet.");
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
      default:
        if (userId === null || excluded) return ignore('no account or excluded');
        return await cast(rest[0], userId);
    }
  } catch (err) {
    console.error(`[FISH] ${me} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};
