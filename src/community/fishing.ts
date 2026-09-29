/**
 * The fishing game's rules and data, ported from supibot's `$fish`
 * (github.com/supinic/supibot, commands/fish). The numbers, odds and messages
 * follow supibot; the code is our own. What differs: coins are the channel's
 * loyalty currency, so a viewer's purse is their points balance, and each
 * channel's anglers are kept in that channel's points database. supibot's fish
 * all share one weight and one price; ours come in rarity tiers (below).
 */

import * as crypto from 'crypto';
import type { PointsDb } from '../points/db';
import type { FishReelSetting, PointsGamesConfig } from '../types';

export type CatchType = 'fish' | 'junk';

export interface CatchItem {
  name: string;
  type: CatchType;
  /** supibot's sell price; the channel's sellPricePercent scales it unless the dashboard sets one. */
  price: number;
  /** Chance weight within its type; decimals allowed, so lower is always rarer. */
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
  ...fishTier(['🐟', '🦐', '🦀', '🐸'], 10, 25),
  { name: '🐚', type: 'fish', price: 25, weight: 10, size: false },
  ...fishTier(['🐠', '🐡', '🦞', '🐢'], 4, 60),
  ...fishTier(['🦑', '🐙', '🦂', '🐬'], 1.5, 150),
  ...fishTier(['🐊', '🦈'], 0.5, 400),
  ...fishTier(['🐳', '🐋'], 0.1, 1500)
];

/**
 * Rarity tiers, where supibot has every fish at weight 1 and price 50: common
 * fish are caught often and sell cheap, rare ones seldom and dear. The shares of
 * fish catches are 68% / 22% / 8% / 1.4% / 0.3%, and a fish sells for about 52 on
 * average, near supibot's 50, so fishing earns what it did overall.
 */
function fishTier(names: string[], weight: number, price: number): CatchItem[] {
  return names.map(name => ({ name, type: 'fish' as const, price, weight, size: true }));
}

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

/** One sized fish still held: its length and whether it beat an earlier record. */
export interface HeldFish { cm: number; record: boolean }

export interface FishData {
  catch: {
    fish: number; junk: number; dryStreak: number; luckyStreak: number; types: Record<string, number>;
    /**
     * Our addition: the sized fish still held, oldest first, so a sale can price by
     * length. Fish from traps, or caught before sizes were kept, have no entry and
     * sell at the base price.
     */
    sizes?: Record<string, HeldFish[]>;
  };
  trap: { active: boolean; start: number; end: number; duration: number };
  readyTimestamp: number;
  /** Our addition: how many of the channel's reels have been bought, in order. */
  reel?: number;
  /** Our addition: tries left on the grappling hook stealing needs; 0 or absent is none. */
  hook?: number;
  /** Our addition: when the guard against stealing runs out (ms), 0 or absent for none. */
  guardUntil?: number;
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
    /** Our addition. As a thief: tries, fish taken, times caught, tries a guard stopped. As a target: fish lost. */
    steal: { attempts: number; stolen: number; caught: number; blocked: number; lost: number };
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
      trap: { times: 0, timeSpent: 0, bestFishCatch: 0, cancelled: 0 },
      steal: { attempts: 0, stolen: 0, caught: 0, blocked: 0, lost: 0 }
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

/** The channel's weight for an item: its dashboard override, else supibot's. */
function weightOf(item: CatchItem, g: PointsGamesConfig): number {
  return g.catches.find(c => c.name === item.name)?.weight ?? item.weight;
}

/** The reel a viewer fishes with: the last one bought, or null. */
export function currentReel(d: FishData | null | undefined, g: PointsGamesConfig): FishReelSetting | null {
  const level = Math.min(d?.reel ?? 0, g.reels.length);
  return level > 0 ? g.reels[level - 1] : null;
}

/** Whether a cast or trap roll lands a fish: 1 in `rollMaximum`, times the reel's odds. */
export function landsFish(rollMaximum: number, reel: FishReelSetting | null): boolean {
  const chance = Math.min(1, (reel?.oddsMultiplier ?? 1) / Math.max(1, rollMaximum));
  return crypto.randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1) < chance;
}

/**
 * Pick an item of `type` by the channel's weights. `rarity` multiplies the weight
 * of every fish rarer than the commonest, so a reel's rarity ×2 makes each of them
 * twice as likely against the common ones.
 */
export function weightedCatch(type: CatchType, g: PointsGamesConfig, rarity = 1): CatchItem {
  const items = ITEMS.filter(i => i.type === type);
  const base = items.map(i => weightOf(i, g));
  const commonest = Math.max(...base);
  const weights = type === 'fish' && rarity !== 1 ? base.map(w => (w < commonest ? w * rarity : w)) : base;
  const total = weights.reduce((s, w) => s + w, 0);
  // The config keeps at least one weight per type above 0; this is a last guard.
  if (total <= 0) return items[randomInt(0, items.length - 1)];
  // Weights can be decimals, so the roll is a fraction of the total.
  let roll = crypto.randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1) * total;
  for (let i = 0; i < items.length; i++) {
    if (roll < weights[i]) return items[i];
    roll -= weights[i];
  }
  return items.filter((_, i) => weights[i] > 0).pop() ?? items[items.length - 1];
}

/** A name for a share of catches. The default fish tiers land one per name. */
export function rarityName(chancePercent: number): string {
  if (chancePercent <= 0) return 'Never';
  if (chancePercent >= 10) return 'Common';
  if (chancePercent >= 4) return 'Uncommon';
  if (chancePercent >= 1) return 'Rare';
  if (chancePercent >= 0.4) return 'Epic';
  return 'Legendary';
}

/** A catch's rarity name from its share of its type (fish or junk) as the channel has the odds set. */
export function rarityOf(g: PointsGamesConfig, name: string): string | null {
  const item = g.catches.find(c => c.name === name);
  if (!item) return null;
  const total = g.catches.filter(c => c.type === item.type).reduce((sum, c) => sum + c.weight, 0);
  return rarityName(total > 0 ? (item.weight / total) * 100 : 0);
}

/** One roll without bait, as traps make them: 1 in `odds` a fish, else 1 in 4 junk. */
export function rollCatch(g: PointsGamesConfig, reel: FishReelSetting | null = null): { item: CatchItem | null; type: CatchType | 'nothing' } {
  if (landsFish(g.catchOdds, reel)) return { item: weightedCatch('fish', g, reel?.rarityMultiplier ?? 1), type: 'fish' };
  if (randomInt(1, 4) === 1) return { item: weightedCatch('junk', g), type: 'junk' };
  return { item: null, type: 'nothing' };
}

export function addItem(d: FishData, item: CatchItem): void {
  d.catch[item.type] = (d.catch[item.type] ?? 0) + 1;
  d.lifetime[item.type] = (d.lifetime[item.type] ?? 0) + 1;
  d.catch.types[item.name] = (d.catch.types[item.name] ?? 0) + 1;
}

/**
 * Our addition to supibot's flat prices: a fish's length scales its price, 0.5x at
 * 1 cm, 1x at 50 cm and 2x at 100 cm, linear in between; a fish that beat an earlier
 * record is worth 50% more. Junk, and fish without a size, keep the base price.
 */
export function sizeMultiplier(cm: number): number {
  const c = Math.min(100, Math.max(1, cm));
  return c <= 50 ? 0.5 + 0.5 * (c - 1) / 49 : 1 + (c - 50) / 50;
}

/** supibot's price scaled by the channel's sellPricePercent: an item's price with no override. */
export function defaultSellPrice(item: CatchItem, sellPricePercent: number): number {
  return Math.round(item.price * sellPricePercent / 100);
}

/** `value` is the seller's reel's value multiplier; it applies to fish only. */
export function sellPrice(item: CatchItem, g: PointsGamesConfig, held?: HeldFish, value = 1): number {
  const listed = g.catches.find(c => c.name === item.name)?.price ?? defaultSellPrice(item, g.sellPricePercent);
  const base = item.type === 'fish' ? listed * value : listed;
  if (!held) return Math.round(base);
  return Math.round(base * sizeMultiplier(held.cm) * (held.record ? 1.5 : 1));
}

/**
 * Remove `n` of a fish or junk item and price them: sized fish oldest first (or, with
 * keepBiggest, all but the largest), then any without a size. Returns what they sell for.
 */
export function takeItems(d: FishData, item: CatchItem, n: number, g: PointsGamesConfig, keepBiggest = false, value = 1): number {
  const have = d.catch.types[item.name] ?? 0;
  n = Math.min(n, have);
  if (n <= 0) return 0;
  let total = 0;
  let taken = 0;
  if (item.type === 'fish') {
    d.catch.sizes ??= {};
    let list = [...(d.catch.sizes[item.name] ?? [])];
    // Unsized fish (traps, older catches) count toward `have` but have no entry.
    const unsized = have - list.length;
    if (keepBiggest) list.sort((a, b) => a.cm - b.cm);
    // Sell unsized ones first when keeping the biggest, so the kept one is a real size.
    let fromUnsized = keepBiggest ? Math.min(n, Math.max(0, unsized)) : 0;
    total += fromUnsized * sellPrice(item, g, undefined, value);
    taken += fromUnsized;
    while (taken < n && list.length) {
      total += sellPrice(item, g, list.shift(), value);
      taken++;
    }
    fromUnsized = n - taken;
    total += fromUnsized * sellPrice(item, g, undefined, value);
    taken += fromUnsized;
    d.catch.sizes[item.name] = list;
  } else {
    total = n * sellPrice(item, g, undefined, value);
    taken = n;
  }
  d.catch.types[item.name] = have - taken;
  d.catch[item.type] -= taken;
  if (item.type === 'fish') d.lifetime.sold += taken;
  else d.lifetime.scrapped += taken;
  return total;
}
/**
 * What `sell` was asked to sell: one or more item emojis, spaced or run together,
 * each optionally followed by a count ("🐟 3 🦐" or "🐟🦐🦀"). The same item named
 * twice adds up. Counts are checked here; whether the viewer has them is not.
 */
export function parseSellList(parts: string[]): { items: Array<{ item: CatchItem; n: number }> } | { error: 'unknown' | 'amount' } {
  const order: CatchItem[] = [];
  const counts = new Map<string, number>();
  // Longest names first, so a two-codepoint emoji isn't read as a shorter one.
  const names = [...ITEMS].sort((a, b) => b.name.length - a.name.length);
  let last: CatchItem | null = null;
  let lastCounted = true;
  for (const raw of parts) {
    // Emoji pickers add the variation selector; items are stored without it.
    const word = raw.replace(/\uFE0F/g, '');
    const count = /^x?(\d+)$/i.exec(word);
    if (count) {
      const n = Number(count[1]);
      if (!last || lastCounted || !Number.isInteger(n) || n < 1) return { error: 'amount' };
      counts.set(last.name, (counts.get(last.name) ?? 0) - 1 + n);
      lastCounted = true;
      continue;
    }
    let rest = word;
    while (rest) {
      const item = names.find(i => rest.startsWith(i.name));
      if (!item) return { error: 'unknown' };
      if (!counts.has(item.name)) order.push(item);
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
      rest = rest.slice(item.name.length);
      last = item;
      // A count may follow only a lone emoji: "🐟🦐 3" would be ambiguous.
      lastCounted = rest.length > 0 || word.length > item.name.length;
    }
  }
  return { items: order.map(item => ({ item, n: counts.get(item.name)! })) };
}

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
    catch: { ...d.catch, ...(raw.catch ?? {}), types: { ...(raw.catch?.types ?? {}) }, sizes: { ...(raw.catch?.sizes ?? {}) } },
    trap: { ...d.trap, ...(raw.trap ?? {}) },
    readyTimestamp: raw.readyTimestamp ?? 0,
    reel: raw.reel ?? 0,
    hook: raw.hook ?? 0,
    guardUntil: raw.guardUntil ?? 0,
    lifetime: {
      ...d.lifetime, ...(raw.lifetime ?? {}),
      trap: { ...d.lifetime.trap, ...(raw.lifetime?.trap ?? {}) },
      steal: { ...d.lifetime.steal, ...(raw.lifetime?.steal ?? {}) }
    }
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

/**
 * Record one fish landed, for the leaderboard's rarest catches. Call inside the
 * write transaction that adds it; the user row must exist (ensureUserTx).
 */
export function recordCatch(db: PointsDb, userId: number, name: string, source: 'cast' | 'trap', cm: number | null, now: number): void {
  db.prepare('INSERT INTO catches (ts, user_id, name, source, cm) VALUES (?, ?, ?, ?, ?)').run(now, userId, name, source, cm);
}

// ─── Stealing ───────────────────────────────────────────────────────────────

/** What every fish someone holds would sell for, before any reel bonus: what a guard is priced on. */
export function heldFishValue(d: FishData, g: PointsGamesConfig): number {
  let total = 0;
  for (const item of ITEMS) {
    if (item.type !== 'fish') continue;
    const have = d.catch.types[item.name] ?? 0;
    if (have <= 0) continue;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    for (const held of sized) total += sellPrice(item, g, held);
    total += (have - sized.length) * sellPrice(item, g);
  }
  return total;
}

/** A steal's chance of working on this fish, in percent, by its rarity as the channel's odds name it. */
export function stealChance(g: PointsGamesConfig, name: string): number {
  const st = g.steal;
  const byRarity: Record<string, number> = {
    Common: st.oddsCommon, Uncommon: st.oddsUncommon, Rare: st.oddsRare, Epic: st.oddsEpic, Legendary: st.oddsLegendary
  };
  return byRarity[rarityOf(g, name) ?? 'Common'] ?? 0;
}

/**
 * What a steal try on a fish costs: the fee every time, and the fine on top when
 * caught. The fine is set from the odds so that, on average, a try loses edgePercent
 * of what it could expect to win (chance x value), whether it's a frog or a whale.
 */
export function stealCharges(g: PointsGamesConfig, worth: number, chancePercent: number): { fee: number; fine: number } {
  const st = g.steal;
  const p = Math.min(1, Math.max(0, chancePercent / 100));
  const fee = Math.max(st.feeMinimum, Math.round(worth * st.feePercent / 100));
  const balanced = p < 1 ? (p * worth * (1 + st.edgePercent / 100) - fee) / (1 - p) : 0;
  return { fee, fine: Math.max(st.fineMinimum, Math.round(balanced)) };
}

/** The most a single try on any of these fish could cost (fee and fine), by each one's own length and odds. */
export function worstStealCharges(d: FishData, g: PointsGamesConfig, pool: Array<{ item: CatchItem }>): number {
  let max = 0;
  for (const { item } of pool) {
    const have = d.catch.types[item.name] ?? 0;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    const values = sized.map(held => sellPrice(item, g, held));
    if (have > sized.length) values.push(sellPrice(item, g));
    const chance = stealChance(g, item.name);
    for (const worth of values) {
      const { fee, fine } = stealCharges(g, worth, chance);
      max = Math.max(max, fee + fine);
    }
  }
  return max;
}

/**
 * The fish a thief can reach for: everything held except what the owner landed
 * or stole in the last `graceMs`, so a fresh catch can still be sold first.
 */
export function stealableFish(db: PointsDb, d: FishData, userId: number, now: number, graceMs: number): Array<{ item: CatchItem; n: number }> {
  const since = now - graceMs;
  const fresh = new Map<string, number>();
  const rows = db.prepare(
    `SELECT name, COUNT(*) AS n FROM (
       SELECT name FROM catches WHERE user_id = ? AND ts > ?
       UNION ALL SELECT name FROM steals WHERE thief_id = ? AND ts > ? AND outcome = 'stolen'
     ) GROUP BY name`
  ).all(userId, since, userId, since) as Array<{ name: string; n: number }>;
  for (const r of rows) fresh.set(r.name, r.n);
  const out: Array<{ item: CatchItem; n: number }> = [];
  for (const item of ITEMS) {
    if (item.type !== 'fish') continue;
    const n = (d.catch.types[item.name] ?? 0) - (fresh.get(item.name) ?? 0);
    if (n > 0) out.push({ item, n });
  }
  return out;
}

/**
 * One of `item` the owner holds, at random: a sized one (with its length) or, among
 * fish from traps and older catches, an unsized one. Doesn't remove it.
 */
export function pickHeld(d: FishData, item: CatchItem): { index: number; held?: HeldFish } {
  const have = d.catch.types[item.name] ?? 0;
  const sized = d.catch.sizes?.[item.name] ?? [];
  const index = crypto.randomInt(0, Math.max(1, have));
  return index < sized.length ? { index, held: sized[index] } : { index: -1 };
}

/** Move one fish picked by pickHeld from `from` to `to`. It keeps its length but not a record bonus, which was the catcher's. */
export function moveFish(from: FishData, to: FishData, item: CatchItem, picked: { index: number; held?: HeldFish }): void {
  from.catch.types[item.name] = Math.max(0, (from.catch.types[item.name] ?? 0) - 1);
  from.catch.fish = Math.max(0, from.catch.fish - 1);
  if (picked.held && picked.index >= 0) from.catch.sizes?.[item.name]?.splice(picked.index, 1);
  to.catch.types[item.name] = (to.catch.types[item.name] ?? 0) + 1;
  to.catch.fish++;
  if (picked.held) {
    to.catch.sizes ??= {};
    (to.catch.sizes[item.name] ??= []).push({ cm: picked.held.cm, record: false });
  }
}

/** Call inside a write transaction; the user row must exist (ensureUserTx). */
export function saveFish(db: PointsDb, userId: number, d: FishData, now: number): void {
  db.prepare('INSERT INTO fish (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(userId, JSON.stringify(d), now);
}
