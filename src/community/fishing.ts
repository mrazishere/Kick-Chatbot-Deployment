/**
 * The fishing game's rules and data, ported from supibot's `$fish`
 * (github.com/supinic/supibot, commands/fish). The numbers, odds and messages
 * follow supibot; the code is our own. What differs: coins are the channel's
 * loyalty currency, so a viewer's purse is their points balance, and each
 * channel's anglers are kept in that channel's points database.
 */

import * as crypto from 'crypto';
import type { PointsDb } from '../points/db';
import type { PointsGamesConfig } from '../types';

export type CatchType = 'fish' | 'junk';

export interface CatchItem {
  name: string;
  type: CatchType;
  /** supibot's sell price; the channel's sellPricePercent scales it. */
  price: number;
  /** Chance weight within its type. */
  weight: number;
  /** Whether a catch gets a length in cm. */
  size: boolean;
}

export const ITEMS: readonly CatchItem[] = [
  { name: '🥫', type: 'junk', price: 8, weight: 25, size: false },
  { name: '💀', type: 'junk', price: 5, weight: 10, size: false },
  { name: '🥾', type: 'junk', price: 20, weight: 5, size: false },
  { name: '🌿', type: 'junk', price: 2, weight: 200, size: false },
  { name: '🍂', type: 'junk', price: 1, weight: 100, size: false },
  { name: '🧦', type: 'junk', price: 5, weight: 50, size: false },
  ...['🦂', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐸', '🐢', '🐙']
    .map(name => ({ name, type: 'fish' as const, price: 50, weight: 1, size: true })),
  { name: '🐚', type: 'fish', price: 50, weight: 1, size: false }
];

export const TYPE_DESCRIPTIONS: Record<CatchType, string> = { fish: 'fish', junk: 'pieces of junk' };

export interface Bait {
  emoji: string;
  name: string;
  /** supibot's price; the channel's baitPricePercent scales it. */
  price: number;
  /** 1 in this many lands a fish with this bait. */
  roll: number;
}

export const BAITS: readonly Bait[] = [
  { emoji: '🪱', name: 'worm', price: 2, roll: 16 },
  { emoji: '🪰', name: 'fly', price: 5, roll: 14 },
  { emoji: '🦗', name: 'cricket', price: 8, roll: 12 }
];

/** A miss waits this long, rounded to the second, plus one second. */
export const MISS_DELAY_MS: readonly [number, number] = [30_000, 90_000];

export const FAILURE_EMOTES = [
  'PoroSad', 'peepoSad', 'SadLain', 'Sadeg', 'Sadge', 'SadgeCry', 'SadCat', 'FeelsBadMan', 'RAGEY', 'docnotL',
  'ReallyMad', 'PunOko', 'SirMad', 'SirSad', 'KannaCry', 'RemCry', 'catCry', 'PepeHands', 'Madge', 'reeferSad',
  'sadE', 'NotLikeThis', 'NLT', 'FailFish', 'SAJ', 'SAJI'
];
export const SUCCESS_EMOTES = [
  'SUGOI', 'LETSGO', 'PagMan', 'PAGLADA', 'PAGGING', 'PagBounce', 'PagChomp', 'PogU', 'Pog', 'PogChamp',
  'WakuWaku', 'sheCrazy', 'heCrazy', 'WICKED', 'FeelsStrongMan', 'MUGA', 'Wowee', 'PogBones', 'peepoPog',
  'peepoPag', 'Shockisu'
];

export const JUNK_MESSAGES = [
  "Oops! You snagged something that's better off in the garbage.",
  "Oh dear, it looks like you've reeled in some unwanted clutter.",
  "It seems luck wasn't on your side this time. You caught a piece of junk.",
  "You've landed a piece of useless debris.",
  'You pull up something disappointing.',
  'Ah... just another item for the scrap heap.',
  "Wow! Would you look at that! ...nevermind, it's just junk.",
  'Your line gets tangled up in some junk.'
];

export const STORY_STYLES = ['exciting', 'spooky', 'smug', 'radical', 'mysterious', 'hilarious', 'enchanting', 'touching', 'intriguing'];

export interface FishData {
  catch: { fish: number; junk: number; dryStreak: number; luckyStreak: number; types: Record<string, number> };
  trap: { active: boolean; start: number; end: number; duration: number };
  readyTimestamp: number;
  lifetime: {
    fish: number;
    junk: number;
    /** Currency earned from selling, ever. */
    coins: number;
    sold: number;
    scrapped: number;
    baitUsed: number;
    attempts: number;
    dryStreak: number;
    luckyStreak: number;
    maxFishSize: number;
    maxFishType: string | null;
    trap: { times: number; timeSpent: number; bestFishCatch: number; cancelled: number };
  };
}

export function initialData(): FishData {
  return {
    catch: { fish: 0, junk: 0, dryStreak: 0, luckyStreak: 0, types: {} },
    trap: { active: false, start: 0, end: 0, duration: 0 },
    readyTimestamp: 0,
    lifetime: {
      fish: 0, junk: 0, coins: 0, sold: 0, scrapped: 0, baitUsed: 0, attempts: 0,
      dryStreak: 0, luckyStreak: 0, maxFishSize: 0, maxFishType: null,
      trap: { times: 0, timeSpent: 0, bestFishCatch: 0, cancelled: 0 }
    }
  };
}

export function hasFishedBefore(d: FishData | null | undefined): boolean {
  return !!d && (d.lifetime.attempts > 0 || d.lifetime.trap.times > 0);
}

/** Uniform integer in [min, max], both inclusive, like supibot's randomInt. */
export function randomInt(min: number, max: number): number {
  return crypto.randomInt(min, max + 1);
}

export function pick<T>(list: readonly T[]): T {
  return list[crypto.randomInt(0, list.length)];
}

export function weightedCatch(type: CatchType): CatchItem {
  const items = ITEMS.filter(i => i.type === type);
  const total = items.reduce((s, i) => s + i.weight, 0);
  let roll = randomInt(1, total);
  for (const item of items) {
    if (roll <= item.weight) return item;
    roll -= item.weight;
  }
  return items[items.length - 1];
}

/** One roll without bait, as traps make them: 1 in `odds` a fish, else 1 in 4 junk. */
export function rollCatch(odds: number): { item: CatchItem | null; type: CatchType | 'nothing' } {
  if (randomInt(1, Math.max(1, odds)) === 1) return { item: weightedCatch('fish'), type: 'fish' };
  if (randomInt(1, 4) === 1) return { item: weightedCatch('junk'), type: 'junk' };
  return { item: null, type: 'nothing' };
}

export function addItem(d: FishData, item: CatchItem): void {
  d.catch[item.type] = (d.catch[item.type] ?? 0) + 1;
  d.lifetime[item.type] = (d.lifetime[item.type] ?? 0) + 1;
  d.catch.types[item.name] = (d.catch.types[item.name] ?? 0) + 1;
}

export const sellPrice = (item: CatchItem, g: PointsGamesConfig): number => Math.round(item.price * g.sellPricePercent / 100);
export const baitPrice = (bait: Bait, g: PointsGamesConfig): number => Math.round(bait.price * g.baitPricePercent / 100);

/** The bait supibot's odds scale from 20; a channel with other odds scales them alike. */
export function baitRoll(bait: Bait, g: PointsGamesConfig): number {
  return Math.max(1, Math.round(bait.roll * g.catchOdds / 20));
}

export function findBait(word: string | undefined): Bait | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  return BAITS.find(b => b.name === w || b.emoji === word);
}

// ─── Storage (the channel's points database) ────────────────────────────────

/** Fill fields a stored document is missing, e.g. one saved by an older version. */
function withDefaults(raw: Partial<FishData>): FishData {
  const d = initialData();
  return {
    catch: { ...d.catch, ...(raw.catch ?? {}), types: { ...(raw.catch?.types ?? {}) } },
    trap: { ...d.trap, ...(raw.trap ?? {}) },
    readyTimestamp: raw.readyTimestamp ?? 0,
    lifetime: { ...d.lifetime, ...(raw.lifetime ?? {}), trap: { ...d.lifetime.trap, ...(raw.lifetime?.trap ?? {}) } }
  };
}

export function loadFish(db: PointsDb, userId: number): FishData | null {
  const row = db.prepare('SELECT data FROM fish WHERE user_id = ?').get(userId) as { data: string } | undefined;
  if (!row) return null;
  try {
    return withDefaults(JSON.parse(row.data) as Partial<FishData>);
  } catch {
    return null;
  }
}

/** Call inside a write transaction; the user row must exist (ensureUserTx). */
export function saveFish(db: PointsDb, userId: number, d: FishData, now: number): void {
  db.prepare('INSERT INTO fish (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(userId, JSON.stringify(d), now);
}
