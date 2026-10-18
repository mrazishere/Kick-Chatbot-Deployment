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
import { readLivePointsConfig } from './points/config';
import { exclusionsFor, findUserByName, getUser, gambleStatsFor, gambleTop, isExcluded, pointsSummary, rankBy, topBy, caughtFish } from './points/store';
import { loadFish, hasFishedBefore, currentReel, heldFishValue, ITEMS, levelOf, levelCost, MAX_LEVEL } from './community/fishing';
import { BOARDS, topRows } from './bot-commands/fish';
import { readState, avgDumb, avgTrolled, topAskers, topDumb, topTrolled } from './leaderboard-store';

/** How many tool rounds one !claude reply may take. */
export const MAX_TOOL_ROUNDS = 3;

const FISH_BOARDS = ['fish', 'total-fish', 'total-coins', 'junk', 'lucky', 'unlucky', 'traps', 'attempts', 'thieves', 'caught', 'robbed', 'duelists'];
const BOARD_NAMES = ['balance', 'activetime', 'gamble', 'gamble-losers', 'shame-roasted', 'shame-dumb', 'shame-yap', ...FISH_BOARDS.map(b => `fishing-${b}`)];

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
      description: `The top 10 of one of this channel's leaderboards, with values. ${points ? 'balance: currency held; activetime: seconds watched while chatting; gamble: biggest net gambling winners; gamble-losers: biggest net gambling losers (most $<currency> lost gambling); fishing-*: the $<currency> fish top boards (fish = fish held now, total-fish = ever caught, total-coins = earned selling, thieves = fish stolen, caught = caught stealing, robbed = fish lost to thieves, duelists = fish duels won). ' : ''}shame-roasted, shame-dumb: average Hall of Shame score (3+ questions to qualify); shame-yap: most questions asked.`,
      input_schema: {
        type: 'object',
        properties: { board: { type: 'string', enum: boards } },
        required: ['board']
      }
    },
    ...(points ? [{
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

/** Run one tool call. Never throws: errors go back to the model as data. */
export function runStatTool(ctx: StatToolContext, name: string, input: unknown): string {
  try {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const result = name === 'viewer_stats' ? viewerStats(ctx, args.username)
      : name === 'top_list' ? topList(ctx, args.board)
      : name === 'channel_stats' ? channelStats(ctx)
      : { error: `No tool named ${name}.` };
    return JSON.stringify(result).slice(0, 6000);
  } catch (err) {
    console.error(`[CLAUDE] stat tool ${name} failed in ${ctx.channel}:`, err);
    return JSON.stringify({ error: 'The stats are unavailable right now.' });
  }
}
