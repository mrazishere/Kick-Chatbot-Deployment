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
import type { FishReelSetting, FishStealSetting, PointsGamesConfig } from '../types';
import type { TrapCheck } from './trap-check';

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
  /**
   * Our addition: a trophy, landed only by reeling in a big bite while live. Trophies
   * are fish (sold, shown, stolen like fish) with their own pool and weights, and the
   * Mythic rarity; casts and traps never roll them.
   */
  trophy?: boolean;
  /** A trophy's chance (%) that the last pull lands it rather than snapping the line: rarer, lower. */
  landPercent?: number;
  /**
   * The rarity a trophy fights as (community/fish-duel.ts): every trophy is Mythic, but only the
   * top one fights like it, so the common ones don't outclass sharks and whales. Absent: its rarity.
   */
  duelRarity?: 'Rare' | 'Epic' | 'Legendary' | 'Mythic';
  /**
   * A fish a channel added on its dashboard (games.customFish): an emoji or an emote's
   * name. Only the channels that list it catch it; anyone holding one can still sell it.
   */
  custom?: boolean;
  /** A custom fish's type in a duel; built-in fish have theirs in fish-duel.ts. */
  duelType?: 'Predator' | 'Swift' | 'Armored';
}

/**
 * Every catch item. The built-in ones, then each custom fish as a channel's settings are
 * first read (registerCustomFish): items are looked up by name from code that doesn't
 * know the channel, and one that's removed from the settings stays sellable.
 */
export const ITEMS: CatchItem[] = [
  { name: '🥫', type: 'junk', price: 8, weight: 25, size: false },
  { name: '💀', type: 'junk', price: 5, weight: 10, size: false },
  { name: '🥾', type: 'junk', price: 20, weight: 5, size: false },
  { name: '🌿', type: 'junk', price: 2, weight: 200, size: false },
  { name: '🍂', type: 'junk', price: 1, weight: 100, size: false },
  { name: '🧦', type: 'junk', price: 5, weight: 50, size: false },
  ...fishTier(['🐟', '🦐', '🦀', '🐸'], 10, 25),
  { name: '🐚', type: 'fish', price: 25, weight: 10, size: true },
  ...fishTier(['🐠', '🐡', '🦞', '🐢'], 4, 60),
  ...fishTier(['🦑', '🐙', '🦂', '🐬'], 1.5, 150),
  ...fishTier(['🐊', '🦈'], 0.5, 400),
  ...fishTier(['🐳', '🐋'], 0.1, 1500),
  // Big bite trophies. Weights are shares of big bites; prices are listed, not scaled
  // like supibot's fish, so a channel that triples fish prices sets these itself.
  // 2026-10-18: big bites flooded the market (18 landed a day, trophies 8-0 in duels against
  // fish), so prices halved, land chances lowered and fighting strength set by tier.
  // 2026-10-23: land chances up 10 points each, so a fully reeled bite lands 54% of the time on
  // average instead of 44%: chat read a run of snaps as rigged.
  { name: '🦭', type: 'fish', price: 500, weight: 30, size: true, trophy: true, landPercent: 70, duelRarity: 'Rare' },
  { name: '🦦', type: 'fish', price: 750, weight: 25, size: true, trophy: true, landPercent: 60, duelRarity: 'Rare' },
  { name: '🦕', type: 'fish', price: 1_250, weight: 20, size: true, trophy: true, landPercent: 50, duelRarity: 'Epic' },
  { name: '🦖', type: 'fish', price: 2_000, weight: 10, size: true, trophy: true, landPercent: 40, duelRarity: 'Epic' },
  { name: '🦄', type: 'fish', price: 3_000, weight: 10, size: true, trophy: true, landPercent: 30, duelRarity: 'Legendary' },
  { name: '🐉', type: 'fish', price: 12_500, weight: 5, size: true, trophy: true, landPercent: 20, duelRarity: 'Mythic' }
];

/** Custom fish by lowercase name, for typing an emote's name in any case. */
const CUSTOM_WORDS = new Map<string, string>();

/**
 * Add a channel's custom fish to ITEMS (or update their price and odds there): sized, like
 * every fish. A name already built in is skipped; the settings never allow one.
 */
export function registerCustomFish(list: ReadonlyArray<{ name: string; weight: number; price: number; type?: 'Predator' | 'Swift' | 'Armored' }>): void {
  for (const f of list) {
    const known = ITEMS.find(i => i.name === f.name);
    if (known && !known.custom) continue;
    if (known) {
      known.price = f.price;
      known.weight = f.weight;
      known.duelType = f.type;
    } else {
      ITEMS.push({ name: f.name, type: 'fish', price: f.price, weight: f.weight, size: true, custom: true, ...(f.type ? { duelType: f.type } : {}) });
    }
    if (/^\w+$/.test(f.name)) CUSTOM_WORDS.set(f.name.toLowerCase(), f.name);
  }
}

/** Kick's emote picker sends "[emote:123:NAME]": that's NAME. Anything else is as it is. */
export const emoteWord = (word: string): string => /^\[emote:\d+:([^\]\s]+)\]$/.exec(word)?.[1] ?? word;

/** Whether a name is already a built-in item's, or a word that names one ("shark", "boots"). */
export function builtInName(name: string): boolean {
  if (ITEMS.some(i => !i.custom && i.name === name)) return true;
  const w = name.toLowerCase();
  return w in ITEM_WORDS || w.replace(/es$/, '') in ITEM_WORDS || w.replace(/s$/, '') in ITEM_WORDS;
}

/** Whether a name is a word (an emote's name), not an emoji: it needs spaces around it in chat. */
export const isWordName = (name: string): boolean => /^\w+$/.test(name);

/** Casts and traps roll from these; trophies come only from big bites. */
export const isTrophy = (name: string): boolean => ITEMS.some(i => i.name === name && i.trophy);

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

/** The shortest trap: each fish skips 30 rolls, so anything shorter could never catch one. */
export const TRAP_MIN_MINUTES = 31;

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
/**
 * `stolen`: taken with `fish steal`. A stolen fish sells at its plain price, never
 * with the holder's reel bonus (the owner, 2026-10-14: reels have no effect on
 * stealing), whoever holds it after.
 */
export interface HeldFish {
  cm: number;
  record: boolean;
  stolen?: boolean;
  /** Our addition: levels from feeding it other fish (fish feed), 0 to MAX_LEVEL; absent is 0. */
  level?: number;
  /** XP toward the next level; absent is 0. */
  xp?: number;
  /**
   * Keeps the levelling rules from before 2026-10-22: LEGACY_LEVEL_STATS a level and no ceiling.
   * Given by the owner as a reward (anothercull's 🐟, for finding how cheap fish out-levelled rare
   * ones; their 🦐 had it too until 2026-10-22, taken off as too strong). It goes with the fish
   * wherever it goes.
   */
  legacyLevels?: true;
}

/** Feeding: the highest level, and what each level adds to a fish's duel stats and its value. */
export const MAX_LEVEL = 10;
/**
 * Duel health and attack per feeding level. Was 0.1 until 2026-10-22: a level's cost follows the
 * fish's value, so a cheap 🐟 maxed for ~380 XP doubled and out-fought a Lv0 🐋 worth 100,000.
 * At 3% a Lv10 fish is +30%: worth levelling, but no common fish beats the top tiers.
 */
export const LEVEL_STATS = 0.03;
/** The old rate, for fish marked legacyLevels. */
export const LEGACY_LEVEL_STATS = 0.1;
export const LEVEL_VALUE = 0.25;

/** A held fish's level, 0 for none. */
export const levelOf = (held: HeldFish | undefined): number => Math.min(MAX_LEVEL, Math.max(0, Math.floor(held?.level ?? 0)));

export interface FishData {
  catch: {
    fish: number; junk: number; dryStreak: number; luckyStreak: number; types: Record<string, number>;
    /**
     * Our addition: the sized fish still held, oldest first, so a sale can price by
     * length. Every fish gets one (since 2026-10-18 traps, 🐚 and the trophies then called 💎 and 👑 too, and the
     * fish held without one were given 50 cm, their old price and strength), so each
     * can be picked by length. Only junk has none.
     */
    sizes?: Record<string, HeldFish[]>;
    /** Our addition: how many of the unsized fish held of each kind were stolen (see HeldFish). */
    stolen?: Record<string, number>;
  };
  trap: { active: boolean; start: number; end: number; duration: number };
  /** Our addition: the question full traps wait on (community/trap-check.ts), until it's answered. */
  trapCheck?: TrapCheck;
  readyTimestamp: number;
  /** Our addition: when the thief can try another steal (ms). Its own cooldown: fishing and stealing never hold each other up. */
  stealReady?: number;
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
    /** checksPassed/checksFailed are our addition: trap check answers, right and wrong. */
    trap: { times: number; timeSpent: number; bestFishCatch: number; cancelled: number; checksPassed: number; checksFailed: number };
    /** Our addition. As a thief: tries, fish taken, times caught, tries a guard stopped. As a target: fish lost. */
    steal: { attempts: number; stolen: number; caught: number; blocked: number; lost: number };
    /** Our addition: fish duels fought, and what changed hands in them. */
    duel: { wins: number; losses: number; fishWon: number; fishLost: number; coinsWon: number; coinsLost: number };
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
      trap: { times: 0, timeSpent: 0, bestFishCatch: 0, cancelled: 0, checksPassed: 0, checksFailed: 0 },
      steal: { attempts: 0, stolen: 0, caught: 0, blocked: 0, lost: 0 },
      duel: { wins: 0, losses: 0, fishWon: 0, fishLost: 0, coinsWon: 0, coinsLost: 0 }
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
  // Another channel's custom fish is never caught here.
  return g.catches.find(c => c.name === item.name)?.weight ?? (item.custom ? 0 : item.weight);
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
export function weightedCatch(type: CatchType | 'trophy', g: PointsGamesConfig, rarity = 1): CatchItem {
  const items = type === 'trophy' ? ITEMS.filter(i => i.trophy) : ITEMS.filter(i => i.type === type && !i.trophy);
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

/** A catch's share (%) of its type (fish or junk) as the channel has the odds set; null for a trophy or one not caught here. */
export function catchShare(g: PointsGamesConfig, name: string): number | null {
  const item = g.catches.find(c => c.name === name);
  if (!item || item.trophy) return null;
  const total = g.catches.filter(c => c.type === item.type && !c.trophy).reduce((sum, c) => sum + c.weight, 0);
  return total > 0 ? (item.weight / total) * 100 : 0;
}

/** A catch's rarity name from its share of its type (fish or junk) as the channel has the odds set. */
export function rarityOf(g: PointsGamesConfig, name: string): string | null {
  const item = g.catches.find(c => c.name === name);
  if (!item) return null;
  if (item.trophy) return 'Mythic';
  return rarityName(catchShare(g, name) ?? 0);
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
  if (item.trophy) return item.price;
  return Math.round(item.price * sellPricePercent / 100);
}

/** `value` is the seller's reel's value multiplier; it applies to fish only. */
export function sellPrice(item: CatchItem, g: PointsGamesConfig, held?: HeldFish, value = 1): number {
  const listed = g.catches.find(c => c.name === item.name)?.price ?? defaultSellPrice(item, g.sellPricePercent);
  const base = item.type === 'fish' ? listed * value : listed;
  if (!held) return Math.round(base);
  return Math.round(base * sizeMultiplier(held.cm) * (held.record ? 1.5 : 1) * (1 + LEVEL_VALUE * levelOf(held)));
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
    // Fed fish (a level) go last, after the unsized ones too, so taking "the oldest" never
    // takes one by surprise; keeping the biggest keeps the highest level, then the longest.
    const fed = keepBiggest ? [] : list.filter(h => levelOf(h));
    if (keepBiggest) list.sort((a, b) => levelOf(a) - levelOf(b) || a.cm - b.cm);
    else list = list.filter(h => !levelOf(h));
    // Sell unsized ones first when keeping the biggest, so the kept one is a real size.
    // Unsized ones that weren't stolen sell first, at the reel's value; stolen ones at the plain price.
    let ownUnsized = Math.max(0, unsized - stolenUnsized(d, item.name));
    let hotUnsized = Math.max(0, unsized) - ownUnsized;
    const sellUnsized = (k: number) => {
      const own = Math.min(k, ownUnsized);
      const hot = Math.min(k - own, hotUnsized);
      ownUnsized -= own;
      hotUnsized -= hot;
      total += own * sellPrice(item, g, undefined, value) + hot * sellPrice(item, g, undefined, 1);
      taken += own + hot;
    };
    if (keepBiggest) sellUnsized(Math.min(n, Math.max(0, unsized)));
    while (taken < n && list.length) {
      const held = list.shift()!;
      total += sellPrice(item, g, held, held.stolen ? 1 : value);
      taken++;
    }
    sellUnsized(n - taken);
    while (taken < n && fed.length) {
      const held = fed.shift()!;
      total += sellPrice(item, g, held, held.stolen ? 1 : value);
      taken++;
    }
    d.catch.sizes[item.name] = [...list, ...fed];
    setStolenUnsized(d, item.name, hotUnsized);
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
 * Remove `n` fish of this kind that are `cm` long and price them, as takeItems would
 * (a stolen one at the plain price). Returns null when fewer than `n` are that long.
 */
export function takeSized(d: FishData, item: CatchItem, cm: number, n: number, g: PointsGamesConfig, value = 1, only: { level?: number; record?: boolean } = {}): number | null {
  const list = d.catch.sizes?.[item.name] ?? [];
  // A sale can name the very fish: its level, and 🏅 for a size record (only.record).
  const fits = (h: HeldFish) => h.cm === cm && (only.level === undefined || levelOf(h) === only.level) && (!only.record || h.record);
  if (item.type !== 'fish' || list.filter(fits).length < n) return null;
  let total = 0;
  for (let i = 0; i < n; i++) {
    // Of the fish that fit, the lowest level goes first: a fed one is kept unless it's the only
    // one. At the same level a plain one goes before a 🏅 one, which is worth more.
    let at = -1;
    const rank = (h: HeldFish) => levelOf(h) * 2 + (h.record ? 1 : 0);
    list.forEach((h, j) => { if (fits(h) && (at < 0 || rank(h) < rank(list[at]))) at = j; });
    const [held] = list.splice(at, 1);
    total += sellPrice(item, g, held, held.stolen ? 1 : value);
  }
  d.catch.types[item.name] = (d.catch.types[item.name] ?? 0) - n;
  d.catch.fish -= n;
  d.lifetime.sold += n;
  return total;
}

/**
 * XP a fish needs to go from `level` to the next: what a level adds to its value, LEVEL_VALUE
 * of its own value at level 0 (its length and kind, no record bonus), the same for every level.
 * An even trade: the food's worth goes into the fish's worth, and the duel stats come on top.
 * (Until 2026-10-19 it was the whole value times the level it went to: 55× its value for Lv10,
 * and in a week one fish on sukasblood had been fed.) `level` is kept for callers.
 */
export function levelCost(item: CatchItem, g: PointsGamesConfig, held: HeldFish, _level: number): number {
  return Math.max(1, Math.round(sellPrice(item, g, { cm: held.cm, record: false }) * LEVEL_VALUE));
}

/** Add XP to a held fish, levelling it up as far as it reaches; past MAX_LEVEL it's lost. Returns the levels gained. */
export function addXp(item: CatchItem, g: PointsGamesConfig, held: HeldFish, xp: number): number {
  let level = levelOf(held);
  let have = (held.xp ?? 0) + Math.max(0, Math.floor(xp));
  const from = level;
  while (level < MAX_LEVEL && have >= levelCost(item, g, held, level)) {
    have -= levelCost(item, g, held, level);
    level++;
  }
  if (level >= MAX_LEVEL) have = 0;
  if (level > 0) held.level = level; else delete held.level;
  if (have > 0) held.xp = have; else delete held.xp;
  return level - from;
}

/** The most of a kind of catch one viewer can hold (games.maxFish, maxJunk); 0 is no cap. */
export const capOf = (g: PointsGamesConfig, type: CatchType): number => type === 'fish' ? g.maxFish : g.maxJunk;

/** Whether holding `count` of this kind of catch calls for a warning: from 90% of the cap. */
export const nearCap = (g: PointsGamesConfig, type: CatchType, count: number): boolean => {
  const cap = capOf(g, type);
  return cap > 0 && count >= Math.ceil(cap * 0.9);
};

/**
 * Call right after adding `item`: past the cap for its kind, the newest one goes again. A
 * fish is sold (at its price, the reel's `value` unless it was stolen; the caller pays the
 * coins), junk thrown away. Returns the coins (0 for junk), or null when it fits. What's
 * held over the cap from before stays: only the one just added can go.
 */
export function overflow(d: FishData, item: CatchItem, g: PointsGamesConfig, value = 1): number | null {
  const cap = capOf(g, item.type);
  if (cap <= 0 || (d.catch[item.type] ?? 0) <= cap) return null;
  const have = d.catch.types[item.name] ?? 0;
  if (have <= 0) return null;
  d.catch.types[item.name] = have - 1;
  d.catch[item.type] -= 1;
  if (item.type === 'junk') {
    d.lifetime.scrapped++;
    return 0;
  }
  const list = d.catch.sizes?.[item.name] ?? [];
  let price: number;
  if (list.length >= have) {
    // Sized fish are kept oldest first: the newest is the last.
    const held = list.pop()!;
    price = sellPrice(item, g, held, held.stolen ? 1 : value);
  } else {
    // One with no length (none are made any more, but a gift or a duel can still move one).
    const hot = stolenUnsized(d, item.name);
    const unsized = have - list.length;
    price = sellPrice(item, g, undefined, hot >= unsized ? 1 : value);
    setStolenUnsized(d, item.name, Math.min(hot, unsized - 1));
  }
  d.lifetime.sold++;
  d.lifetime.coins += price;
  return price;
}

/** Words for the items, so chat can type "shark" or "boot" instead of the emoji. */
const ITEM_WORDS: Record<string, string> = {
  fish: '🐟', shrimp: '🦐', prawn: '🦐', crab: '🦀', frog: '🐸', shell: '🐚', seashell: '🐚',
  tropical: '🐠', tropicalfish: '🐠', puffer: '🐡', pufferfish: '🐡', blowfish: '🐡', lobster: '🦞', turtle: '🐢',
  squid: '🦑', octopus: '🐙', scorpion: '🦂', dolphin: '🐬',
  crocodile: '🐊', croc: '🐊', shark: '🦈',
  whale: '🐳', bluewhale: '🐋',
  seal: '🦭', otter: '🦦', dinosaur: '🦕', dino: '🦕', trex: '🦖', rex: '🦖', tyrannosaurus: '🦖', unicorn: '🦄', dragon: '🐉',
  can: '🥫', tin: '🥫', skull: '💀', boot: '🥾', shoe: '🥾', weed: '🌿', seaweed: '🌿', herb: '🌿', leaf: '🍂', leaves: '🍂', sock: '🧦'
};

/** The item a word names, any case, singular or plural ("Sharks", "dinos"); undefined if none. */
export function itemByWord(word: string): CatchItem | undefined {
  const w = emoteWord(word).toLowerCase();
  const custom = CUSTOM_WORDS.get(w);
  if (custom) return ITEMS.find(i => i.name === custom);
  const name = ITEM_WORDS[w] ?? ITEM_WORDS[w.replace(/es$/, '')] ?? ITEM_WORDS[w.replace(/s$/, '')];
  return name ? ITEMS.find(i => i.name === name) : undefined;
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
  let last = null as CatchItem | null;
  let lastCounted = true;
  // A count before anything is named ("2 sharks") is for the item that comes next.
  let ahead: number | null = null;
  const add = (item: CatchItem, n: number) => {
    if (!counts.has(item.name)) order.push(item);
    counts.set(item.name, (counts.get(item.name) ?? 0) + n);
    last = item;
  };
  for (const raw of parts) {
    // Emoji pickers add the variation selector; items are stored without it.
    const word = raw.replace(/\uFE0F/g, '');
    const count = /^x?(\d+)x?$/i.exec(word);
    if (count) {
      const n = Number(count[1]);
      if (!Number.isInteger(n) || n < 1) return { error: 'amount' };
      // After an uncounted item it counts that one ("🐟 3"); otherwise the next one ("2 sharks").
      if (last && !lastCounted) {
        counts.set(last.name, (counts.get(last.name) ?? 0) - 1 + n);
        lastCounted = true;
        continue;
      }
      if (ahead !== null) return { error: 'amount' };
      ahead = n;
      continue;
    }
    // A word for an item: "shark", "Boots".
    const named = itemByWord(word);
    if (named) {
      add(named, ahead ?? 1);
      lastCounted = ahead !== null;
      ahead = null;
      continue;
    }
    // A count typed onto a lone emoji, no space: "🦕1" or "🦕x2".
    const glued = /^(\D+?)x?(\d+)$/i.exec(word);
    const gluedItem = glued ? names.find(i => i.name === glued[1]) : undefined;
    if (glued && gluedItem) {
      const n = Number(glued[2]);
      if (n < 1 || ahead !== null) return { error: 'amount' };
      add(gluedItem, n);
      lastCounted = true;
      continue;
    }
    let rest = word;
    let first = true;
    while (rest) {
      const item = names.find(i => rest.startsWith(i.name));
      if (!item) return { error: 'unknown' };
      // A count typed before ("2 🦈") is for the first emoji after it.
      add(item, first && ahead !== null ? ahead : 1);
      rest = rest.slice(item.name.length);
      // A count may follow only a lone emoji: "🐟🦐 3" would be ambiguous.
      lastCounted = (first && ahead !== null) || rest.length > 0 || word.length > item.name.length;
      first = false;
    }
    ahead = null;
  }
  // A number with nothing after it to count.
  if (ahead !== null) return { error: 'amount' };
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
    catch: { ...d.catch, ...(raw.catch ?? {}), types: { ...(raw.catch?.types ?? {}) }, sizes: { ...(raw.catch?.sizes ?? {}) }, ...(raw.catch?.stolen ? { stolen: { ...raw.catch.stolen } } : {}) },
    trap: { ...d.trap, ...(raw.trap ?? {}) },
    ...(raw.trapCheck ? { trapCheck: raw.trapCheck } : {}),
    readyTimestamp: raw.readyTimestamp ?? 0,
    stealReady: raw.stealReady ?? 0,
    reel: raw.reel ?? 0,
    hook: raw.hook ?? 0,
    guardUntil: raw.guardUntil ?? 0,
    lifetime: {
      ...d.lifetime, ...(raw.lifetime ?? {}),
      trap: { ...d.lifetime.trap, ...(raw.lifetime?.trap ?? {}) },
      steal: { ...d.lifetime.steal, ...(raw.lifetime?.steal ?? {}) },
      duel: { ...d.lifetime.duel, ...(raw.lifetime?.duel ?? {}) }
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

/**
 * What every fish someone holds would fetch if they sold it now: heldFishValue with their
 * reel's bonus, which (as in a sale) stolen fish don't get.
 */
export function heldSaleValue(d: FishData, g: PointsGamesConfig): number {
  const value = currentReel(d, g)?.valueMultiplier ?? 1;
  let total = 0;
  for (const item of ITEMS) {
    if (item.type !== 'fish') continue;
    const have = d.catch.types[item.name] ?? 0;
    if (have <= 0) continue;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    for (const held of sized) total += sellPrice(item, g, held, held.stolen ? 1 : value);
    const hot = stolenUnsized(d, item.name);
    total += (have - sized.length - hot) * sellPrice(item, g, undefined, value) + hot * sellPrice(item, g);
  }
  return total;
}

/**
 * A steal's chance of working on this fish, in percent. By its rarity as the channel's odds
 * name it; given what the fish is worth, by its value too (valueStealChance), the two
 * counting equally: thieves steal for value, not just rarity (owner, 2026-10-29). A fish
 * worth what its tier's standard fish lists at keeps its rarity odds; a cheap trophy is
 * easier to take than its tier, a fed or long fish harder than its kind.
 */
export function stealChance(g: PointsGamesConfig, name: string, worth?: number): number {
  const rarity = rarityStealChance(g, name);
  if (worth === undefined) return rarity;
  const value = valueStealChance(g, worth);
  // At the floor either way (a tier set to 0%) it stays there: the other side mustn't lift it to rollable.
  return rarity <= 0.01 || value <= 0.01 ? 0.01 : roundOdds(Math.sqrt(rarity * value));
}

/** Tenths above 1% (the tiers' own odds come out exact), hundredths below, never below 0.01%. */
const roundOdds = (x: number): number => Math.max(0.01, x >= 1 ? Math.round(x * 10) / 10 : Math.round(x * 100) / 100);

/** A steal's chance by rarity alone: the fish's share of catches on the tier curve, a trophy its tier's. */
function rarityStealChance(g: PointsGamesConfig, name: string): number {
  const st = g.steal;
  const item = ITEMS.find(i => i.name === name);
  // A trophy has no share of casts: it's as hard to take as the tier it fights as, the
  // dragon (Mythic) half again as hard as a Legendary fish.
  if (item?.trophy) {
    const tier = item.duelRarity ?? 'Mythic';
    return tier === 'Rare' ? st.oddsRare : tier === 'Epic' ? st.oddsEpic : tier === 'Legendary' ? st.oddsLegendary : st.oddsLegendary / 2;
  }
  const share = catchShare(g, name);
  if (share === null) return st.oddsLegendary;
  return stealCurve(st, share, stealAnchors(g));
}

/**
 * A steal's chance by value alone, on the same curve as rarity: each tier's standard fish
 * (STEAL_ANCHOR_FISH) at its list price gets the tier's odds, values between slide on a log
 * scale, and past the 🐳's price the odds fall with the value: ten times dearer, ten times harder.
 */
export function valueStealChance(g: PointsGamesConfig, worth: number): number {
  let prev = 0;
  const prices = STEAL_ANCHOR_FISH.map(([fish]) => {
    const item = ITEMS.find(i => i.name === fish);
    // Each anchor dearer than the last, or the curve would fold back.
    const at = Math.max(item ? sellPrice(item, g) : 0, prev * 1.1, 1);
    prev = at;
    return at;
  });
  // The curve runs on shares, rarer = smaller; a price's inverse runs the same way.
  return stealCurve(g.steal, 1 / Math.max(worth, 1e-9), prices.map(p => 1 / p));
}

/**
 * Where each tier's odds sit: the share of catches its standard fish has in this channel
 * (STEAL_ANCHOR_FISH), so those fish steal at exactly the tier's odds whatever the table.
 * One the channel has turned off falls back to the default table's share.
 */
export function stealAnchors(g: PointsGamesConfig): number[] {
  let prev = Infinity;
  return STEAL_ANCHOR_FISH.map(([fish, fallback]) => {
    const share = catchShare(g, fish);
    // Each anchor rarer than the last, or the curve would fold back.
    const at = share && share > 0 && share < prev ? share : Math.min(fallback, prev * 0.9);
    prev = at;
    return at;
  });
}

/**
 * Steal odds follow how rare a fish is to catch, with no steps: each tier's odds sit at
 * its standard fish's share of catches (stealAnchors) and slide between them on a log
 * scale, so a fish rarer than its tier's usual is harder to take. Past the rarest
 * anchor the odds fall with the share itself: ten times rarer, ten times harder.
 * Never below 0.01%.
 */
export function stealCurve(st: Pick<FishStealSetting, 'oddsCommon' | 'oddsUncommon' | 'oddsRare' | 'oddsEpic' | 'oddsLegendary'>, share: number, anchors: number[] = STEAL_ANCHOR_FISH.map(([, s]) => s)): number {
  const odds = [st.oddsCommon, st.oddsUncommon, st.oddsRare, st.oddsEpic, st.oddsLegendary];
  const points = anchors.map((a, i): [number, number] => [a, odds[i]]);
  if (share >= points[0][0]) return roundOdds(points[0][1]);
  for (let i = 1; i < points.length; i++) {
    const [hi, oddsHi] = points[i - 1];
    const [lo, oddsLo] = points[i];
    if (share >= lo) {
      const t = Math.log(hi / share) / Math.log(hi / lo);
      return roundOdds(oddsHi + (oddsLo - oddsHi) * t);
    }
  }
  const [last, oddsLast] = points[points.length - 1];
  return roundOdds(oddsLast * Math.max(0, share) / last);
}

/** Duel strength (hit points and attack ×) by tier, Common to Mythic. */
export const TIER_STRENGTH: Readonly<Record<string, number>> = { Common: 1, Uncommon: 1.12, Rare: 1.25, Epic: 1.4, Legendary: 1.6, Mythic: 1.8 };
/** The strongest a fish can be from rarity alone, however rare. */
export const MAX_STRENGTH = 2;

/**
 * A fish's duel strength from its rarity, on the same curve as its steal odds: each
 * tier's standard fish at the tier's strength, others between on a log scale, and one
 * rarer than the 🐳 keeps gaining at the Epic-to-Legendary rate per tenfold rarity, up
 * to MAX_STRENGTH. A trophy fights as its tier (duelRarity).
 */
export function duelStrength(g: PointsGamesConfig, name: string): number {
  const item = ITEMS.find(i => i.name === name);
  if (item?.trophy) return TIER_STRENGTH[item.duelRarity ?? 'Mythic'];
  const share = catchShare(g, name);
  if (share === null) return TIER_STRENGTH[rarityOf(g, name) ?? 'Common'] ?? 1;
  const anchors = stealAnchors(g);
  const values = [TIER_STRENGTH.Common, TIER_STRENGTH.Uncommon, TIER_STRENGTH.Rare, TIER_STRENGTH.Epic, TIER_STRENGTH.Legendary];
  const round = (x: number) => Math.round(Math.min(MAX_STRENGTH, x) * 1000) / 1000;
  if (share >= anchors[0]) return values[0];
  for (let i = 1; i < anchors.length; i++) {
    if (share >= anchors[i]) {
      const t = Math.log(anchors[i - 1] / share) / Math.log(anchors[i - 1] / anchors[i]);
      return round(values[i - 1] + (values[i] - values[i - 1]) * t);
    }
  }
  const n = anchors.length - 1;
  const perTenfold = (values[n] - values[n - 1]) / Math.log10(anchors[n - 1] / anchors[n]);
  return round(values[n] + perTenfold * Math.log10(anchors[n] / Math.max(share, 1e-9)));
}

/** Each tier's standard fish, Common to Legendary, with its share (%) of fish caught in the default table. */
export const STEAL_ANCHOR_FISH: ReadonlyArray<readonly [string, number]> = [['🐟', 14.14], ['🐠', 5.66], ['🦑', 2.12], ['🐊', 0.71], ['🐳', 0.14]];

/**
 * The chance a steal try on this fish works: its odds (by value too, given its worth) raised by luckPercent. Fines are priced
 * from this too (until 2026-10-24 they used stealChance, so luck outweighed the edge and
 * steals paid thieves a little on average).
 */
export const stealRollChance = (g: PointsGamesConfig, name: string, worth?: number): number =>
  Math.min(100, stealChance(g, name, worth) * (100 + g.steal.luckPercent) / 100);

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
    for (const worth of values) {
      const { fee, fine } = stealCharges(g, worth, stealRollChance(g, item.name, worth));
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
 * The lengths of `name` the owner landed or stole in the last `graceMs`, one entry per
 * fish (null for an unsized one): the ones a thief aiming at a length can't reach yet.
 */
export function freshLengths(db: PointsDb, userId: number, name: string, now: number, graceMs: number): Array<number | null> {
  return freshCatches(db, userId, name, now, graceMs).map(r => r.cm);
}

/** freshLengths with when each one was landed or stolen, oldest first. */
export function freshCatches(db: PointsDb, userId: number, name: string, now: number, graceMs: number): Array<{ cm: number | null; ts: number }> {
  const since = now - graceMs;
  return db.prepare(
    `SELECT cm, ts FROM catches WHERE user_id = ? AND name = ? AND ts > ?
     UNION ALL SELECT cm, ts FROM steals WHERE thief_id = ? AND name = ? AND ts > ? AND outcome = 'stolen'
     ORDER BY ts`
  ).all(userId, name, since, userId, name, since) as Array<{ cm: number | null; ts: number }>;
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
/** How many of the unsized `name` fish held were stolen, never more than are unsized. */
function stolenUnsized(d: FishData, name: string): number {
  const unsized = (d.catch.types[name] ?? 0) - (d.catch.sizes?.[name]?.length ?? 0);
  return Math.max(0, Math.min(unsized, d.catch.stolen?.[name] ?? 0));
}

function setStolenUnsized(d: FishData, name: string, n: number): void {
  if (n > 0) (d.catch.stolen ??= {})[name] = n;
  else if (d.catch.stolen) {
    delete d.catch.stolen[name];
    if (!Object.keys(d.catch.stolen).length) delete d.catch.stolen;
  }
}

/**
 * Hand one fish over: a steal (`stolen`) or a duel for keeps. A stolen fish stays
 * marked stolen wherever it goes after, so it never sells with a reel bonus. An
 * unsized one leaving counts as stolen only when every unsized one of its kind was.
 */
export function moveFish(from: FishData, to: FishData, item: CatchItem, picked: { index: number; held?: HeldFish }, stolen = false): void {
  const unsizedBefore = (from.catch.types[item.name] ?? 0) - (from.catch.sizes?.[item.name]?.length ?? 0);
  const fromHot = stolenUnsized(from, item.name);
  from.catch.types[item.name] = Math.max(0, (from.catch.types[item.name] ?? 0) - 1);
  from.catch.fish = Math.max(0, from.catch.fish - 1);
  if (picked.held && picked.index >= 0) from.catch.sizes?.[item.name]?.splice(picked.index, 1);
  to.catch.types[item.name] = (to.catch.types[item.name] ?? 0) + 1;
  to.catch.fish++;
  if (picked.held) {
    to.catch.sizes ??= {};
    // Its levels and XP go with it: they're the fish's, not its owner's.
    const lv = levelOf(picked.held);
    (to.catch.sizes[item.name] ??= []).push({
      cm: picked.held.cm, record: false, ...(stolen || picked.held.stolen ? { stolen: true } : {}),
      ...(lv > 0 ? { level: lv } : {}), ...(picked.held.xp ? { xp: picked.held.xp } : {}),
      ...(picked.held.legacyLevels ? { legacyLevels: true as const } : {})
    });
  } else {
    const hot = stolen || (unsizedBefore > 0 && fromHot >= unsizedBefore);
    setStolenUnsized(from, item.name, Math.min(fromHot, Math.max(0, unsizedBefore - 1)));
    if (hot) setStolenUnsized(to, item.name, stolenUnsized(to, item.name) + 1);
  }
}

/**
 * Hand `n` of a fish or junk item to another viewer as a gift: sized fish oldest
 * first, then unsized ones, each as moveFish moves it (a stolen one stays stolen).
 * Returns how many moved: never more than `from` holds.
 */
export function giveItems(from: FishData, to: FishData, item: CatchItem, n: number): number {
  n = Math.min(n, from.catch.types[item.name] ?? 0);
  for (let i = 0; i < n; i++) {
    if (item.type === 'fish') {
      const sized = from.catch.sizes?.[item.name] ?? [];
      // The oldest without a level: a fed fish goes only when it's all that's left.
      const index = Math.max(0, sized.findIndex(h => !levelOf(h)));
      moveFish(from, to, item, sized.length ? { index, held: sized[index] } : { index: -1 });
    } else {
      from.catch.types[item.name] = (from.catch.types[item.name] ?? 0) - 1;
      from.catch.junk = Math.max(0, from.catch.junk - 1);
      to.catch.types[item.name] = (to.catch.types[item.name] ?? 0) + 1;
      to.catch.junk++;
    }
  }
  return Math.max(0, n);
}

/** Call inside a write transaction; the user row must exist (ensureUserTx). */
export function saveFish(db: PointsDb, userId: number, d: FishData, now: number): void {
  db.prepare('INSERT INTO fish (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
    .run(userId, JSON.stringify(d), now);
}
