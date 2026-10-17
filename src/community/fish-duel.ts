/**
 * Fish duels: our addition. Two viewers each send one fish they hold and the bot
 * plays the fight out, turn by turn, the way a Pokémon battle goes: each fish has
 * hit points, an attack and a speed, a type that is strong against one type and
 * weak against another, and every hit can miss or land a critical.
 *
 *   - Rarity is the fish's level: it scales hit points and attack alike.
 *   - Length is its size: a longer fish has more hit points and hits harder, so of two
 *     fish of a kind the bigger is always the better. A fish with no length (traps, shells) fights at 50 cm.
 *   - Types: Predator beats Swift, Swift beats Armored, Armored beats Predator: a small edge.
 *
 * The stats decide it. Luck (who strikes first, how hard each hit lands, the odd critical
 * or miss) is kept small, enough for an upset between close fish and no more: a rarer or
 * bigger fish is the favourite every time, and the wider the gap the surer the win.
 *
 * The fight is rolled in one go when the challenge is accepted; the overlay plays
 * the turns back. Challenges wait in memory, so a restart drops the ones not yet
 * answered. Nothing is held while one waits: the stake is checked again, and
 * moved, when the duel is fought.
 */

import * as crypto from 'crypto';
import type { PointsGamesConfig } from '../types';
import { CatchItem, FishData, HeldFish, ITEMS, itemByWord, rarityOf, sellPrice } from './fishing';

export type DuelType = 'Predator' | 'Swift' | 'Armored';

export const TYPE_EMOJI: Record<DuelType, string> = { Predator: '🦷', Swift: '💨', Armored: '🪨' };

/** Each type's prey. */
const BEATS: Record<DuelType, DuelType> = { Predator: 'Swift', Swift: 'Armored', Armored: 'Predator' };

const TYPES: Record<string, DuelType> = {
  '🐟': 'Swift', '🦐': 'Swift', '🦀': 'Armored', '🐸': 'Predator', '🐚': 'Armored',
  '🐠': 'Swift', '🐡': 'Predator', '🦞': 'Armored', '🐢': 'Armored',
  '🦑': 'Predator', '🐙': 'Predator', '🦂': 'Armored', '🐬': 'Swift',
  '🐊': 'Armored', '🦈': 'Predator',
  '🐳': 'Swift', '🐋': 'Armored',
  '🦭': 'Swift', '🦦': 'Predator', '🦕': 'Armored', '💎': 'Armored', '👑': 'Swift', '🐉': 'Predator'
};

export const typeOf = (name: string): DuelType => TYPES[name] ?? 'Swift';

/** A fish's level, by its rarity as the channel's odds name it. */
const LEVEL: Record<string, number> = { Common: 1, Uncommon: 1.12, Rare: 1.25, Epic: 1.4, Legendary: 1.6, Mythic: 1.8 };

const UNSIZED_CM = 50;
const CRIT_PERCENT = 12;
const CRIT_MULTIPLIER = 1.6;
const STRONG = 1.08;
const WEAK = 0.94;
/** Each hit lands for its attack times a roll this far either side of 1. */
const SWING = 0.35;
const BASE_ATTACK = 17;
/** Any hit misses this often, whatever the fish. */
const EVADE_PERCENT = 6;
/** A fight that long is called on hit points left. */
export const MAX_TURNS = 40;

export interface Fighter {
  fish: string;
  /** null for a fish with no length. */
  cm: number | null;
  type: DuelType;
  rarity: string;
  hp: number;
  attack: number;
}

export function fighterOf(g: PointsGamesConfig, item: CatchItem, held?: HeldFish): Fighter {
  const rarity = rarityOf(g, item.name) ?? 'Common';
  const level = LEVEL[rarity] ?? 1;
  const cm = Math.min(100, Math.max(1, held?.cm ?? UNSIZED_CM));
  return {
    fish: item.name,
    cm: held ? held.cm : null,
    type: typeOf(item.name),
    rarity,
    hp: Math.round((70 + cm * 0.3) * level),
    // 0.3% more for each cm over 50, as much less for each under.
    attack: Math.round(BASE_ATTACK * (1 + (cm - UNSIZED_CM) * 0.003) * level * 10) / 10
  };
}

/** How strong a fighter is overall, to pick someone's best. */
const might = (f: Fighter): number => f.hp * f.attack;

export interface Picked { item: CatchItem; index: number; held?: HeldFish; fighter: Fighter }

/**
 * Keeps duels are only between fish close in value. Strength comes from rarity and
 * length, not price, so a cheap strong fish could win an expensive one (a 90 cm 🐙
 * worth 810 beat a 🦈 worth 18,000 about 43% of the time, 2026-10-14 audit).
 */
export const KEEPS_RATIO = 1.25;

/** A fish's plain sell price: no reel bonus, as the steal fee and fine price it. */
export const fishValue = (g: PointsGamesConfig, p: Pick<Picked, 'item' | 'held'>): number => sellPrice(p.item, g, p.held);

export const closeInValue = (a: number, b: number): boolean => Math.max(a, b) <= Math.min(a, b) * KEEPS_RATIO;

/** The values a fish may have to fight one worth `value` for keeps. */
export const keepsRange = (value: number): [number, number] => [Math.ceil(value / KEEPS_RATIO), Math.floor(value * KEEPS_RATIO)];

/**
 * Every fish held, one by one (only of `name`, when given): each one with a length, and one
 * with no length where any are held. `index` is as in pickFighter.
 */
export function heldFish(d: FishData | null | undefined, g: PointsGamesConfig, name?: string): Picked[] {
  if (!d) return [];
  const out: Picked[] = [];
  for (const item of ITEMS) {
    if (item.type !== 'fish' || (name !== undefined && item.name !== name)) continue;
    const have = d.catch.types[item.name] ?? 0;
    if (have <= 0) continue;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    sized.forEach((held, index) => out.push({ item, index, held, fighter: fighterOf(g, item, held) }));
    if (have > sized.length) out.push({ item, index: -1, fighter: fighterOf(g, item) });
  }
  return out;
}

/** The one fish held (of `name`, when given) closest in value to `value`, whatever its length. */
export function pickByValue(d: FishData | null | undefined, g: PointsGamesConfig, value: number, name?: string): Picked | null {
  let best: Picked | null = null;
  let bestGap = Infinity;
  for (const p of heldFish(d, g, name)) {
    const gap = Math.abs(Math.log(Math.max(1, fishValue(g, p)) / Math.max(1, value)));
    if (gap < bestGap) { best = p; bestGap = gap; }
  }
  return best;
}

/**
 * The challenger's fish for keeps: of the ones (of `name`, when given) that the rival holds a
 * fish close in value to, the strongest. null when there's no such pair.
 */
export function pickForKeeps(mine: FishData | null | undefined, theirs: FishData | null | undefined, g: PointsGamesConfig, name?: string): Picked | null {
  const values = heldFish(theirs, g).map(p => fishValue(g, p));
  let best: Picked | null = null;
  for (const p of heldFish(mine, g, name)) {
    const v = fishValue(g, p);
    if (values.some(w => closeInValue(v, w)) && (!best || might(p.fighter) > might(best.fighter))) best = p;
  }
  return best;
}

/** That exact fish, by kind and length (no length: one without), or null when it's gone. */
export const sameFish = (d: FishData | null | undefined, g: PointsGamesConfig, name: string, cm: number | undefined): Picked | null =>
  heldFish(d, g, name).find(p => p.held?.cm === cm) ?? null;

/**
 * The fish someone sends: their biggest of `name`, or with no name their strongest
 * fish of all. null when they hold none. `index` is its place among their sized
 * fish of that kind (-1 for one with no length), as moveFish takes it.
 */
export function pickFighter(d: FishData | null | undefined, g: PointsGamesConfig, name?: string): Picked | null {
  if (!d) return null;
  let best: Picked | null = null;
  for (const item of ITEMS) {
    if (item.type !== 'fish' || (name !== undefined && item.name !== name)) continue;
    const have = d.catch.types[item.name] ?? 0;
    if (have <= 0) continue;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    let index = -1;
    for (let i = 0; i < sized.length; i++) if (index < 0 || sized[i].cm > sized[index].cm) index = i;
    // Only fish with no length left: that one fights at the middle length.
    const held = index >= 0 ? sized[index] : undefined;
    const fighter = fighterOf(g, item, held);
    if (!best || might(fighter) > might(best.fighter)) best = { item, index, ...(held ? { held } : {}), fighter };
  }
  return best;
}

/**
 * Fish by word, for when the emoji can't be typed or copied (while live, `show` may only be on the overlay).
 * 🐳 is the whale and 🐋 the blue whale.
 */
/** The first fish named in `words`, by emoji (pickers add a variation selector) or by word, or undefined. */
export function fishNamed(words: readonly string[]): string | undefined {
  for (const raw of words) {
    const word = raw.replace(/\uFE0F/g, '');
    const name = itemByWord(word)?.name ?? word;
    const item = ITEMS.find(i => i.type === 'fish' && i.name === name);
    if (item) return item.name;
  }
  return undefined;
}

/** A fraction in [0, 1). */
export type Rng = () => number;
const cryptoRng: Rng = () => crypto.randomInt(0, 2 ** 48 - 1) / (2 ** 48 - 1);

/** Whether `random` is among the words: send any fish held, not the strongest. */
export const wantsRandom = (words: readonly string[]): boolean => words.some(w => /^(random|rand|rng)$/i.test(w));

/**
 * A kind of fish picked at random from the ones held, each fish held an equal chance (so someone with
 * fifteen 🐟 and one 🦈 mostly sends a 🐟). The biggest of that kind fights, as when it's named. undefined with none.
 */
export function randomFish(d: FishData | null | undefined, rng: Rng = cryptoRng): string | undefined {
  if (!d) return undefined;
  const held = ITEMS.filter(i => i.type === 'fish' && (d.catch.types[i.name] ?? 0) > 0).map(i => ({ name: i.name, n: d.catch.types[i.name] }));
  let roll = rng() * held.reduce((sum, h) => sum + h.n, 0);
  for (const h of held) {
    roll -= h.n;
    if (roll < 0) return h.name;
  }
  return held[held.length - 1]?.name;
}

/** One hit: who struck (0 the challenger, 1 the opponent), for how much, and how. */
export interface Turn {
  by: 0 | 1;
  damage: number;
  hit: 'hit' | 'crit' | 'miss';
  /** 1 a type advantage, -1 a disadvantage, 0 neither. */
  edge: 1 | 0 | -1;
}

export interface Battle {
  turns: Turn[];
  winner: 0 | 1;
  /** Hit points each side has left. */
  left: [number, number];
}

const edgeOf = (attacker: Fighter, defender: Fighter): 1 | 0 | -1 =>
  BEATS[attacker.type] === defender.type ? 1 : BEATS[defender.type] === attacker.type ? -1 : 0;

/** Fight it out. A coin flip says who strikes first, then they alternate. */
export function fight(a: Fighter, b: Fighter, rng: Rng = cryptoRng): Battle {
  const sides = [a, b] as const;
  const left: [number, number] = [a.hp, b.hp];
  const turns: Turn[] = [];
  let by: 0 | 1 = rng() < 0.5 ? 0 : 1;
  while (left[0] > 0 && left[1] > 0 && turns.length < MAX_TURNS) {
    const other: 0 | 1 = by === 0 ? 1 : 0;
    const edge = edgeOf(sides[by], sides[other]);
    if (rng() * 100 < EVADE_PERCENT) {
      turns.push({ by, damage: 0, hit: 'miss', edge });
    } else {
      const crit = rng() * 100 < CRIT_PERCENT;
      const swing = 1 - SWING + rng() * 2 * SWING;
      const damage = Math.max(1, Math.round(sides[by].attack * swing * (edge > 0 ? STRONG : edge < 0 ? WEAK : 1) * (crit ? CRIT_MULTIPLIER : 1)));
      left[other] = Math.max(0, left[other] - damage);
      turns.push({ by, damage, hit: crit ? 'crit' : 'hit', edge });
    }
    by = other;
  }
  // Out of turns: whoever has more of their hit points left, the challenger on a dead heat.
  const winner: 0 | 1 = left[1] <= 0 ? 0 : left[0] <= 0 ? 1 : left[0] / a.hp >= left[1] / b.hp ? 0 : 1;
  return { turns, winner, left };
}

/** "🦈 87 cm · 🦷 Predator · Epic", for a challenge and the result. */
export function describe(f: Fighter): string {
  return `${f.fish}${f.cm !== null ? ` ${f.cm} cm` : ''} · ${TYPE_EMOJI[f.type]} ${f.type} · ${f.rarity}`;
}

// ─── What the overlay plays ─────────────────────────────────────────────────

export type DuelStake = { kind: 'friendly' } | { kind: 'wager'; amount: number } | { kind: 'keeps' };

export interface OverlaySide { user: string; fish: string; cm: number | null; type: DuelType; rarity: string; hp: number }

/** A duel as the overlay gets it: both sides, every turn, who won and what for. */
export interface OverlayDuel {
  a: OverlaySide;
  b: OverlaySide;
  turns: Array<[by: 0 | 1, damage: number, hit: 0 | 1 | 2, edge: 1 | 0 | -1]>;
  winner: 0 | 1;
  stake: 'friendly' | 'wager' | 'keeps';
  /** A wager's size, and the channel's currency name to show it in. */
  amount?: number;
  currency?: string;
}

export function overlayDuel(users: [string, string], fighters: [Fighter, Fighter], battle: Battle, stake: DuelStake, currency: string): OverlayDuel {
  const side = (i: 0 | 1): OverlaySide => {
    const f = fighters[i];
    return { user: users[i], fish: f.fish, cm: f.cm, type: f.type, rarity: f.rarity, hp: f.hp };
  };
  return {
    a: side(0), b: side(1),
    turns: battle.turns.map(t => [t.by, t.damage, t.hit === 'miss' ? 0 : t.hit === 'crit' ? 2 : 1, t.edge]),
    winner: battle.winner,
    stake: stake.kind,
    ...(stake.kind === 'wager' ? { amount: stake.amount, currency } : {})
  };
}

/**
 * How long the overlay takes to play a duel: the same sums the overlay does, so
 * chat hears who won as the fight ends on stream rather than before it starts.
 */
export function playMs(turns: number): number {
  const perTurn = turns > 16 ? 550 : turns > 10 ? 750 : 950;
  return 2_500 + turns * perTurn + 800;
}

// ─── Challenges waiting for an answer ───────────────────────────────────────

export interface Challenge {
  challengerId: number;
  challenger: string;
  targetId: number;
  target: string;
  /** The fish the challenger named or, with none named, their strongest when they asked. */
  fish: string;
  /** For keeps, the length of that very fish (absent: one with no length), picked to match one the target holds. */
  cm?: number;
  stake: DuelStake;
  expiresAt: number;
}

const waiting = new Map<string, Challenge[]>();

function open(channel: string, now: number): Challenge[] {
  const list = (waiting.get(channel) ?? []).filter(c => c.expiresAt > now);
  waiting.set(channel, list);
  return list;
}

/** The challenge waiting for this viewer's answer. */
export const challengeFor = (channel: string, userId: number, now = Date.now()): Challenge | undefined =>
  open(channel, now).find(c => c.targetId === userId);

/** The challenge this viewer made that hasn't been answered. */
export const challengeBy = (channel: string, userId: number, now = Date.now()): Challenge | undefined =>
  open(channel, now).find(c => c.challengerId === userId);

export function addChallenge(channel: string, c: Challenge, now = Date.now()): void {
  open(channel, now).push(c);
}

export function dropChallenge(channel: string, c: Challenge): void {
  waiting.set(channel, (waiting.get(channel) ?? []).filter(x => x !== c));
}
