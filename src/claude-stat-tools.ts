/**
 * Read-only stats tools for !claude, so a question about balances, gambling,
 * fishing or the Hall of Shame is answered from the channel's data rather than
 * guessed from chat history.
 *
 * Only what chat commands and the public leaderboard already show: balances,
 * ranks, active time, gamble and fishing stats, Hall of Shame scores. Never the
 * ledger's private notes, cheat signals, trap-check answers, guards or hooks.
 * The model picks a tool and a username, never a query or a channel.
 */

import { openPointsDb, PointsDb } from './points/db';
import * as fs from 'fs';
import { channelConfigPath, effectiveCommand, readLivePointsConfig } from './points/config';
import type { PointsConfig, RewardAction } from './types';
import { exclusionsFor, findUserByName, getUser, gambleStatsFor, gambleTop, isExcluded, pointsSummary, rankBy, topBy, caughtFish } from './points/store';
import { loadFish, hasFishedBefore, currentReel, heldFishValue, ITEMS, levelOf, levelCost, MAX_LEVEL, BAITS, baitPrice, baitRoll, rarityName, stealRollChance } from './community/fishing';
import { fighterOf } from './community/fish-duel';
import { readWheel } from './community/wheel';
import { feedingGuide } from './points/public-commands';
import { BOARDS, topRows } from './bot-commands/fish';
import { readStats as readWordleStats } from './bot-commands/wordle';
import { readState, avgDumb, avgTrolled, topAskers, topDumb, topTrolled } from './leaderboard-store';

/** How many tool rounds one !claude reply may take. */
export const MAX_TOOL_ROUNDS = 3;

const RULE_TOPICS = ['bot-commands', 'earning', 'games', 'fishing', 'fish-table', 'fish-shop', 'stealing', 'fish-duels', 'big-bites', 'feeding', 'wheel'];
const FISH_BOARDS = ['fish', 'total-fish', 'total-coins', 'junk', 'lucky', 'unlucky', 'traps', 'attempts', 'thieves', 'caught', 'robbed', 'duelists'];
const BOARD_NAMES = ['balance', 'activetime', 'gamble', 'gamble-losers', 'wordle', 'shame-roasted', 'shame-dumb', 'shame-yap', ...FISH_BOARDS.map(b => `fishing-${b}`)];

export interface StatToolContext {
  /** Channel slug, no '#'. */
  channel: string;
  /** Who asked, for "me". */
  asker: string;
}

/** The tool definitions for a channel: shame-only when the channel has no points. */
export function statTools(channel: string): Array<Record<string, unknown>> {
  const points = readLivePointsConfig(channel).cfg.enabled;
  const boards = points ? BOARD_NAMES : BOARD_NAMES.filter(b => b.startsWith('shame-'));
  return [
    {
      name: 'viewer_stats',
      description: `A viewer's real stats in this channel: ${points ? 'currency balance and rank, active time, lifetime earned, first and last seen, gambling record, fishing record (catches, coins from selling, reel, fish held, fish levelled up by feeding with their XP, steals, duels), and ' : ''}their Hall of Shame scores (how often they ask the bot, how dumb their questions are and how hard they get roasted, each 0-10). Use it whenever someone asks about their own or another viewer's stats, money, rank or record. Pass "me" for the person asking.`,
      input_schema: {
        type: 'object',
        properties: { username: { type: 'string', description: 'Kick username without @, or "me"' } },
        required: ['username']
      }
    },
    {
      name: 'top_list',
      description: `The top 10 of one of this channel's leaderboards, with values. ${points ? 'balance: currency held; activetime: seconds watched while chatting; gamble: biggest net gambling winners; gamble-losers: biggest net gambling losers (most $<currency> lost gambling); wordle: Wordle wins, with games played and average guesses ($<currency> wordle stats); fishing-*: the $<currency> fish top boards (fish = fish held now, total-fish = ever caught, total-coins = earned selling, thieves = fish stolen, caught = caught stealing, robbed = fish lost to thieves, duelists = fish duels won). ' : ''}shame-roasted, shame-dumb: average Hall of Shame score (3+ questions to qualify); shame-yap: most questions asked.`,
      input_schema: {
        type: 'object',
        properties: { board: { type: 'string', enum: boards } },
        required: ['board']
      }
    },
    ...(points ? [{
      name: 'channel_rules',
      description: 'This channel\'s real game settings, as the bot uses them right now: prices, odds, limits, cooldowns and how things work. Use it for any question about how a $<currency> command, game or the !wheel works or what it costs: reel, bait, hook and guard prices, fish odds, rarities and sell prices, trap time, bucket caps, stealing chances and fines, fish duel types, big bites, feeding, gambling odds and limits, duels, raffles, wordle, video prices, earning rates and bonuses, timeout and spam costs, channel point rewards, the wheel.',
      input_schema: {
        type: 'object',
        properties: { topic: { type: 'string', enum: RULE_TOPICS, description: 'bot-commands: limits and cooldowns of the ! commands (!claude, !clip, !blerp, !remind, !catch, !cookie, !slots, translation, !chatsummary); earning: how currency is earned, bonuses, giving, timeout and spam costs, channel point rewards; games: gamble, duel, raffle, wordle, video; fishing: casting, traps, cooldowns, caps, selling, gifts; fish-table: every fish, junk and trophy with odds, rarity, price and duel type; fish-shop: reels, bait, hook and guard; stealing; fish-duels; big-bites; feeding; wheel' } },
        required: ['topic']
      }
    }, {
      name: 'channel_stats',
      description: 'Channel-wide totals: viewers with currency, all currency in circulation, gambling and duel totals all-time and this stream, and the rarest fish ever caught with who caught them first.',
      input_schema: { type: 'object', properties: {} }
    }] : [])
  ];
}

const hours = (seconds: number) => Math.round(seconds / 360) / 10;
const day = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

function shameFor(channel: string, name: string): Record<string, unknown> | null {
  const state = readState(channel);
  const key = Object.keys(state.users).find(u => u.toLowerCase() === name.toLowerCase());
  const s = key ? state.users[key] : undefined;
  if (!s || !s.count) return null;
  return {
    questionsAsked: s.count,
    avgDumbness: Math.round(avgDumb(s) * 10) / 10,
    avgRoasted: Math.round(avgTrolled(s) * 10) / 10,
    dumbestQuestion: s.topDumbPrompt ? s.topDumbPrompt.slice(0, 160) : undefined
  };
}

function withDb<T>(channel: string, fn: (db: PointsDb) => T): T | { error: string } {
  const db = openPointsDb(channel, { create: false });
  if (!db) return { error: 'This channel has no currency data.' };
  return fn(db);
}

function viewerStats(ctx: StatToolContext, raw: unknown): unknown {
  let name = String(raw ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (!name || name === 'me' || name === 'myself') name = ctx.asker.toLowerCase();
  if (!/^[a-z0-9_]{1,30}$/.test(name)) return { error: 'Not a Kick username.' };
  const shame = shameFor(ctx.channel, name);
  const live = readLivePointsConfig(ctx.channel);
  if (!live.cfg.enabled) return shame ? { username: name, hallOfShame: shame } : { error: `No stats for ${name} here.` };

  return withDb(ctx.channel, db => {
    const found = findUserByName(db, name);
    const u = found ? getUser(db, found.user_id) : undefined;
    if (!u) return shame ? { username: name, hallOfShame: shame } : { error: `${name} has never been seen in this channel.` };
    const cfg = live.cfg;
    const ex = exclusionsFor(ctx.channel, cfg, live.broadcasterUserId);
    const excluded = isExcluded(ex, u.user_id, u.username);
    const out: Record<string, unknown> = {
      username: u.username,
      balance: u.balance,
      rank: excluded ? 'not ranked (excluded from the leaderboard)' : rankBy(db, u.user_id, 'balance', ex),
      activeTimeHours: hours(u.watch_seconds),
      activeTimeRank: excluded ? null : rankBy(db, u.user_id, 'watch_seconds', ex),
      lifetimeEarned: u.lifetime_earned,
      firstSeen: day(u.first_seen_at),
      lastSeen: day(u.last_seen_at)
    };
    if (cfg.gamble.enabled) out.gambling = gambleStatsFor(db, u.user_id);
    const d = cfg.games.enabled ? loadFish(db, u.user_id) : null;
    if (d && hasFishedBefore(d)) {
      const held = Object.fromEntries(Object.entries(d.catch.types).filter(([, n]) => n > 0));
      const L = d.lifetime;
      out.fishing = {
        reel: currentReel(d, cfg.games)?.name ?? 'none',
        fishHeld: d.catch.fish,
        junkHeld: d.catch.junk,
        heldByKind: held,
        heldValue: heldFishValue(d, cfg.games),
        // Fish levelled up by feeding ($ fish feed), with the XP toward their next level.
        fedFish: Object.entries(d.catch.sizes ?? {}).flatMap(([name, list]) => {
          const item = ITEMS.find(i => i.name === name);
          return item ? list.slice(0, d.catch.types[name] ?? 0).filter(h => levelOf(h) > 0 || (h.xp ?? 0) > 0).map(h => ({
            fish: name, cm: h.cm, level: levelOf(h),
            ...(levelOf(h) < MAX_LEVEL ? { xp: h.xp ?? 0, xpForNextLevel: levelCost(item, cfg.games, h, levelOf(h)) } : {})
          })) : [];
        }),
        casts: L.attempts,
        fishCaught: L.fish,
        junkCaught: L.junk,
        coinsFromSelling: L.coins,
        biggestFish: L.maxFishType ? `${L.maxFishType} ${L.maxFishSize}cm` : null,
        bestLuckyStreak: L.luckyStreak,
        worstDryStreak: L.dryStreak,
        trapsSet: L.trap.times,
        ...(cfg.games.steal.enabled ? { fishStolen: L.steal.stolen, caughtStealing: L.steal.caught, fishLostToThieves: L.steal.lost } : {}),
        ...(cfg.games.duel.enabled ? { duelsWon: L.duel.wins, duelsLost: L.duel.losses } : {})
      };
    }
    if (shame) out.hallOfShame = shame;
    return out;
  });
}

function topList(ctx: StatToolContext, raw: unknown): unknown {
  const board = String(raw ?? '');
  if (board.startsWith('shame-')) {
    const state = readState(ctx.channel);
    const rows = board === 'shame-roasted' ? topTrolled(state, 10) : board === 'shame-dumb' ? topDumb(state, 10) : board === 'shame-yap' ? topAskers(state, 10) : null;
    if (!rows) return { error: 'Unknown board.' };
    return rows.map((r, i) => ({ rank: i + 1, username: r.user, value: board === 'shame-yap' ? r.stats.count : Math.round(r.avg * 10) / 10 }));
  }
  const live = readLivePointsConfig(ctx.channel);
  if (!live.cfg.enabled) return { error: 'This channel has no currency.' };
  return withDb(ctx.channel, db => {
    const ex = exclusionsFor(ctx.channel, live.cfg, live.broadcasterUserId);
    if (board === 'balance') return topBy(db, 'balance', 10, ex).map((u, i) => ({ rank: i + 1, username: u.username, value: u.balance }));
    if (board === 'activetime') return topBy(db, 'watch_seconds', 10, ex).map((u, i) => ({ rank: i + 1, username: u.username, hours: hours(u.watch_seconds) }));
    if (board === 'gamble' || board === 'gamble-losers') {
      return gambleTop(db, 1, 10, ex, board === 'gamble' ? 'winners' : 'losers').map((g, i) => ({ rank: i + 1, ...g }));
    }
    if (board === 'wordle') {
      const st = readWordleStats(db);
      if (!st.gamesPlayed) return { gamesPlayed: 0, note: 'No Wordle game has finished here yet.' };
      return {
        gamesPlayed: st.gamesPlayed,
        averageGuesses: Math.round(st.totalGuesses / st.gamesPlayed * 10) / 10,
        winners: Object.entries(st.winners).sort(([, a], [, b]) => b - a).slice(0, 10).map(([username, wins], i) => ({ rank: i + 1, username, wins }))
      };
    }
    const fb = board.startsWith('fishing-') ? BOARDS.get(board.slice('fishing-'.length)) : undefined;
    if (!fb || !FISH_BOARDS.includes(board.slice('fishing-'.length))) return { error: 'Unknown board.' };
    return topRows(db, fb).filter(r => r.value > 0).map((r, i) => ({ rank: i + 1, username: r.username, value: r.value }));
  });
}

function channelStats(ctx: StatToolContext): unknown {
  const live = readLivePointsConfig(ctx.channel);
  if (!live.cfg.enabled) return { error: 'This channel has no currency.' };
  const s = pointsSummary(ctx.channel);
  const rarest = live.cfg.games.enabled
    ? caughtFish(ctx.channel, live.cfg, live.broadcasterUserId).sort((a, b) => a.times - b.times).slice(0, 8).map(c => ({ fish: c.name, timesCaught: c.times, firstBy: c.firstBy, firstAt: c.firstAt.slice(0, 10) }))
    : undefined;
  return {
    currency: live.cfg.currencyName,
    viewersWithCurrency: s.users,
    totalInCirculation: s.totalPoints,
    gambling: s.gamble,
    duels: s.duel,
    ...(rarest ? { leastCaughtFish: rarest } : {})
  };
}

/** The channel's reward actions (channel point rewards the bot acts on), without Kick's ids. */
function rewardRules(channel: string): unknown[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(channelConfigPath(channel), 'utf8')) as { rewardActions?: RewardAction[] };
    return (cfg.rewardActions ?? []).map(r => {
      const { rewardId: _id, ...rest } = r as RewardAction & Record<string, unknown>;
      return rest;
    });
  } catch {
    return [];
  }
}

/**
 * What a topic's settings are, from the channel's live config: the numbers the
 * commands themselves use, so !claude can say what a reel costs or how stealing
 * works instead of guessing. Only what the commands and the public leaderboard
 * show: never trap-check answers, cheat signals, test settings or anyone's data.
 */
function channelRules(ctx: StatToolContext, raw: unknown): unknown {
  const topic = String(raw ?? '');
  // The ! commands' limits are set in their files (bot-commands/*.ts); keep these in step.
  if (topic === 'bot-commands') {
    let claudeMinutes = 5;
    try {
      const raw = JSON.parse(fs.readFileSync(channelConfigPath(ctx.channel), 'utf8')) as { claude?: { settings?: { cooldownMinutes?: number } } };
      claudeMinutes = raw.claude?.settings?.cooldownMinutes || 5;
    } catch { /* the default */ }
    return {
      '!claude and !research': `${claudeMinutes} min between questions per viewer (the streamer has none); it remembers recent chat with it until !claudeclear`,
      '!clip': 'clips 5 to 90 seconds (30 by default); 60s per viewer, 15s for the channel between clips',
      '!blerp': 'clips 5 to 30 seconds; 5 min per viewer, 1 min for the channel',
      '!remind': 'up to 5 pending per viewer, 200 characters, delivered when they next chat or at a set time up to a year ahead',
      '!catch': 'up to 3 every 30 seconds per viewer',
      '!cookie': 'one fortune cookie per viewer per day (subscribers get a second, golden one), which can be donated instead',
      '!slots and the fun commands': 'a few seconds between uses per viewer',
      translation: 'up to 5 translations a minute per viewer',
      '!chatsummary': 'the last 30 minutes of chat; once a minute for the channel',
      commandsTurnedOff: 'the streamer can turn any command off with !config exclude; the command list only shows those that are on'
    };
  }
  const cfg: PointsConfig = readLivePointsConfig(ctx.channel).cfg;
  if (!cfg.enabled) return { error: 'This channel has no currency.' };
  const cur = cfg.currencyName;
  const c = `$${effectiveCommand(cfg)}`;
  const g = cfg.games;
  const off = (what: string) => ({ error: `${what} is off in this channel.` });
  const minutes = (s: number) => Math.round(s / 6) / 10;
  if (topic === 'earning') {
    return {
      currency: cur, command: c,
      watching: `${cfg.pointsPerInterval} ${cur} every ${cfg.intervalMinutes} min for viewers who chatted in the last ${cfg.activeWindowMinutes} min, while live; subscribers earn x${cfg.subscriberMultiplier}`,
      bonuses: cfg.bonuses,
      give: cfg.give.enabled ? cfg.give : 'off',
      timeoutPenalty: cfg.timeoutPenalty.enabled ? { perSecondOfTimeout: cfg.timeoutPenalty.pointsPerSecond, maxPerTimeout: cfg.timeoutPenalty.maxDeduction || 'no cap', permanentBan: cfg.timeoutPenalty.permanentBanCost } : 'off',
      antiSpam: cfg.antiSpam.enabled ? { keywords: cfg.antiSpam.keywords, freePerWindow: cfg.antiSpam.threshold, windowMinutes: cfg.antiSpam.windowMinutes, costEachAfter: cfg.antiSpam.cost, timeoutMinutesWhenBroke: cfg.antiSpam.timeoutMinutes } : 'off',
      channelPointRewards: rewardRules(ctx.channel)
    };
  }
  if (topic === 'games') {
    return {
      gamble: cfg.gamble.enabled ? { winChancePercent: cfg.gamble.winChancePercent, pays: 'even money: a win adds the bet, a loss takes it', min: cfg.gamble.minAmount, max: cfg.gamble.maxAmount || 'no max', cooldownSeconds: cfg.gamble.cooldownSeconds, onlyWhileLive: cfg.gamble.onlyWhileLive } : 'off',
      duel: cfg.duel.enabled ? { how: '50/50, both put in the same amount, the winner takes both', min: cfg.duel.minAmount, max: cfg.duel.maxAmount || 'no max', cooldownSeconds: cfg.duel.cooldownSeconds, answerWithinSeconds: cfg.duel.expirySeconds, onlyWhileLive: cfg.duel.onlyWhileLive } : 'off',
      raffle: cfg.raffle.enabled ? { opens: 'mods only', minPrize: cfg.raffle.minPrize, maxPrize: cfg.raffle.maxPrize || 'no max', winners: cfg.raffle.winners, perStream: cfg.raffle.maxPerStream || 'no limit', defaultSeconds: cfg.raffle.defaultDurationSeconds, maxSeconds: cfg.raffle.maxDurationSeconds, onlyWhileLive: cfg.raffle.onlyWhileLive } : 'off',
      wordle: cfg.wordle.enabled ? cfg.wordle : 'off',
      video: cfg.video.enabled && !cfg.video.ownerOnly ? { pricePerSecond: cfg.video.pricePerSecond, maxSeconds: cfg.video.maxSeconds, queueMax: cfg.video.queueMax, onlyWhileLive: cfg.video.onlyWhileLive } : 'off'
    };
  }
  if (!g.enabled) return off('Fishing');
  if (topic === 'fishing') {
    return {
      castOdds: `a cast without bait lands a fish 1 in ${g.catchOdds} (a reel multiplies it); a missed cast pulls up junk 25% of the time, and waits 30-90s before the next cast`,
      trapRolls: `collecting full traps rolls about 0.75-0.9 rolls per minute they were laid (${Math.floor(g.trapMinutes * 0.75)}-${Math.floor(g.trapMinutes * 0.9)} rolls for ${g.trapMinutes} min); each roll is like a cast without bait (1 in ${g.catchOdds} a fish, times the reel), and each fish caught uses up the next ${g.catchCooldownMinutes} rolls. Collecting late changes nothing`,
      cooldownAfterAFishMinutes: g.catchCooldownMinutes,
      trapMinutes: g.trapMinutes,
      trapTimes: `a plain $<cmd> fish trap lays them for ${g.trapMinutes} min; a chatter can name a time from 31 min to ${g.trapMaxMinutes} min ($<cmd> fish trap 2h, 90m, 1h30m), and trap reset lays them again for as long as before or the time named. trap lift pulls them up early with a haul for the minutes they were out (as if laid that long; under about ${g.catchCooldownMinutes + 5} min it can only be junk); trap cancel pulls them up with nothing. A longer trap catches more, and a little more per minute, since each fish uses up the next rolls`,
      when: g.onlyWhileOffline ? 'casting and traps only while the stream is offline' : g.onlyWhileLive ? 'casting and traps only while live' : 'any time',
      sellPricePercent: g.sellPricePercent,
      sizes: 'fish are 1-100 cm: 1 cm sells for half the base price, 50 cm for the base price, 100 cm for double; a size record sells for 1.5x',
      bucketCaps: { fish: g.maxFish || 'no cap', junk: g.maxJunk || 'no cap', past: 'new fish sell on the spot, new junk is binned; warned from 90%' },
      gifts: g.giveEnabled ? { cooldownSeconds: g.giveCooldownSeconds } : 'off',
      customFish: g.customFish.map(f => ({ name: f.name, price: f.price, duelType: f.type })),
      trapChecks: g.trapCheck.enabled ? { when: 'collecting full traps while offline can ask a question', tries: g.trapCheck.tries, answerSeconds: g.trapCheck.answerSeconds, finePercentOfBalance: g.trapCheck.finePercent, failing: 'loses the catch' } : 'off'
    };
  }
  if (topic === 'fish-table') {
    const pool = (pick: (x: typeof g.catches[number]) => boolean, trophy = false) => {
      const items = g.catches.filter(pick);
      const total = items.reduce((sum, x) => sum + x.weight, 0);
      return items.filter(x => x.weight > 0).map(x => {
        const chance = total > 0 ? Math.round(x.weight / total * 10000) / 100 : 0;
        const item = ITEMS.find(i => i.name === x.name);
        const f = item && x.type === 'fish' ? fighterOf(g, item) : null;
        return {
          item: x.name, chancePercent: chance, rarity: trophy ? 'Mythic' : rarityName(chance), price: x.price,
          ...(f ? { duelType: f.type, hpAt50cm: f.hp, attackAt50cm: f.attack } : {}),
          ...(trophy && item?.landPercent !== undefined ? { landPercent: item.landPercent } : {})
        };
      }).sort((a, b) => b.chancePercent - a.chancePercent);
    };
    return {
      note: 'chancePercent is the share within its group: fish of the fish caught, junk of the junk, trophies of big bites. Prices are for a 50 cm fish before reel bonuses.',
      fish: pool(x => x.type === 'fish' && !x.trophy), junk: pool(x => x.type === 'junk'), trophies: pool(x => !!x.trophy, true)
    };
  }
  if (topic === 'fish-shop') {
    return {
      reels: g.reels.map((r, i) => ({ level: i + 1, name: r.name, price: r.price, catchOddsX: r.oddsMultiplier, rarerFishX: r.rarityMultiplier, sellValueX: r.valueMultiplier })),
      reelsNote: `bought in order with ${c} fish buy reel, once each, kept for good; they apply to casts and traps`,
      bait: BAITS.map(b => ({ bait: `${b.emoji} ${b.name}`, pricePerCast: baitPrice(b, g), castOdds: `1 in ${baitRoll(b, g)} instead of 1 in ${g.catchOdds}` })),
      ...(g.steal.enabled ? {
        hook: { price: g.steal.hookPrice, tries: g.steal.hookUses, use: 'needed to steal' },
        guard: { price: `${g.steal.guardPercent}% of the fish value you hold, at least ${g.steal.guardMinimum}`, hours: g.steal.guardHours, use: 'blocks every steal try on you' }
      } : {})
    };
  }
  if (topic === 'stealing') {
    if (!g.steal.enabled) return off('Stealing');
    const st = g.steal;
    return {
      needs: `a grappling hook (${st.hookPrice} ${cur}, ${st.hookUses} tries)`,
      aiming: '$<cmd> fish steal @user grabs a random fish they hold; $<cmd> fish steal @user 🦈 aims at that kind, and 🦈 72cm at that very fish. Aimed or not, the chance, fee and fine are that fish\'s own',
      when: st.onlyWhileLive ? 'only while live' : g.onlyWhileOffline ? 'only while offline, like casting' : 'any time',
      successPercentByRarity: { Common: st.oddsCommon, Uncommon: st.oddsUncommon, Rare: st.oddsRare, Epic: st.oddsEpic, Legendary: st.oddsLegendary },
      oddsFollowRarity: 'each fish\'s chance follows how rare it is to catch, with no steps: the tiers\' standard fish get the tier odds above, rarer ones less, down to a fraction of a percent for the rarest; trophies use the tier they fight as (the 🐉 half a Legendary\'s)',
      successPercentByFishWithLuck: Object.fromEntries(g.catches.filter(x => x.type === 'fish' && x.weight > 0).map(x => [x.name, Math.round(stealRollChance(g, x.name) * 100) / 100])),
      luck: st.luckPercent > 0 ? `every success chance by rarity above is raised by ${st.luckPercent}% of itself (so ${st.oddsCommon}% becomes ${Math.round(st.oddsCommon * (1 + st.luckPercent / 100) * 100) / 100}%, ${st.oddsLegendary}% becomes ${Math.round(st.oddsLegendary * (1 + st.luckPercent / 100) * 100) / 100}%), while fines stay priced from the lower odds, so stealing pays a little on average` : 'none: the odds above are the real ones',
      fee: `every try that goes ahead costs ${st.feePercent}% of the grabbed fish's value, at least ${st.feeMinimum}`,
      fine: `a caught thief also pays a fine, at least ${st.fineMinimum}, priced so the average try loses ${st.edgePercent}% before luck`,
      graceMinutes: `a fish can't be stolen until held ${st.graceMinutes} min`,
      protectMinutes: `after a try, the target is safe ${st.protectMinutes} min`,
      guard: `${st.guardPercent}% of the fish value held, at least ${st.guardMinimum}, lasts ${st.guardHours}h; a try on a guarded viewer only uses a hook try`,
      cooldown: `a try costs the fishing cooldown (${g.catchCooldownMinutes} min)`
    };
  }
  if (topic === 'fish-duels') {
    if (!g.duel.enabled) return off('Fish duels');
    return {
      types: 'Predator beats Swift, Swift beats Armored, Armored beats Predator: a small edge',
      stats: 'rarer and longer fish have more health and attack; each feeding level adds 10%; luck is small',
      teams: '1v1, 2v2 or 3v3',
      allowKeeps: g.duel.allowKeeps, answerWithinSeconds: g.duel.expirySeconds, cooldownSeconds: g.duel.cooldownSeconds, maxWager: g.duel.maxWager || 'no max',
      onlyWhileLive: g.duel.onlyWhileLive
    };
  }
  if (topic === 'big-bites') {
    if (!g.bigBite.enabled) return off('Big bites');
    const b = g.bigBite;
    return {
      how: `while live with the fishing overlay up, now and then a random active chatter gets a big bite; they type the code shown on the overlay with ${c} fish reel <code> (from the second pull the code alone works too), ${b.pulls} pulls, each a new and harder code (from the second pull it flashes for codeShownSeconds and then hides); the last pull lands a trophy by its land chance or it snaps. A wrong code or too slow and it gets away`,
      everyMinutes: b.everyMinutes, pulls: b.pulls, firstCodeSeconds: b.windowSeconds, eachPullSeconds: b.pullSeconds,
      codeShownSeconds: b.flashSeconds || 'stays shown',
      rewardBites: [b.kicksMin > 0 ? `sending ${b.kicksMin}+ Kicks at once` : '', b.onSub ? 'subscribing or resubscribing' : '', b.onGift ? 'gifting subs (the gifter)' : ''].filter(Boolean).join(', ') || 'off',
      rewardBitesNote: 'a reward bite goes to that viewer right away (or after a bite already on a line), can\'t be sniped, always lands if every code is right (which trophy is still random) and doesn\'t move the timer; live with the overlay up only',
      overlaySwitch: `when the overlay isn't on stream, mods can type ${c} fish overlay off: fishing replies go to chat and big bites pause until ${c} fish overlay on or the next stream`,
      sniping: b.snipeSeconds > 0 ? `in the first code's last ${b.snipeSeconds}s anyone may take the bite by typing the different code posted in chat` : 'off'
    };
  }
  if (topic === 'feeding') return g.feedEnabled ? { rules: feedingGuide(cfg) } : off('Feeding');
  if (topic === 'wheel') {
    const w = readWheel(ctx.channel);
    return { spunBy: 'the streamer and mods (!wheel spin)', items: w.items.map(i => i.label), spinSeconds: w.spinSeconds, removeWinner: w.removeWinner };
  }
  return { error: 'Unknown topic.' };
}

/** Run one tool call. Never throws: errors go back to the model as data. */
export function runStatTool(ctx: StatToolContext, name: string, input: unknown): string {
  try {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const result = name === 'viewer_stats' ? viewerStats(ctx, args.username)
      : name === 'top_list' ? topList(ctx, args.board)
      : name === 'channel_stats' ? channelStats(ctx)
      : name === 'channel_rules' ? channelRules(ctx, args.topic)
      : { error: `No tool named ${name}.` };
    return JSON.stringify(result).slice(0, 6000);
  } catch (err) {
    console.error(`[CLAUDE] stat tool ${name} failed in ${ctx.channel}:`, err);
    return JSON.stringify({ error: 'The stats are unavailable right now.' });
  }
}
