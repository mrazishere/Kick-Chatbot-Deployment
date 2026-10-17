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
 * A team battle (2v2 or 3v3) is the same fight in a row: each side's fish come in one
 * after another, Pokémon style; when one faints the next takes its place and strikes
 * next, and the side with a fish still standing wins. A one-fish duel is a team of one.
 *
 * The fight is rolled in one go when the challenge is accepted; the overlay plays
 * the turns back. Challenges wait in memory, so a restart drops the ones not yet
 * answered. Nothing is held while one waits: the stake is checked again, and
 * moved, when the duel is fought.
 */

import * as crypto from 'crypto';
import type { PointsGamesConfig } from '../types';
import { CatchItem, FishData, HeldFish, ITEMS, itemByWord, LEVEL_STATS, levelOf, rarityOf, sellPrice } from './fishing';

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

export const typeOf = (name: string): DuelType => TYPES[name] ?? ITEMS.find(i => i.name === name)?.duelType ?? 'Swift';

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
  /** Levels from feeding (0 for none): each adds LEVEL_STATS to hp and attack. */
  level: number;
}

export function fighterOf(g: PointsGamesConfig, item: CatchItem, held?: HeldFish): Fighter {
  const rarity = rarityOf(g, item.name) ?? 'Common';
  const level = LEVEL[rarity] ?? 1;
  const cm = Math.min(100, Math.max(1, held?.cm ?? UNSIZED_CM));
  const fed = levelOf(held);
  const boost = 1 + LEVEL_STATS * fed;
  return {
    fish: item.name,
    cm: held ? held.cm : null,
    type: typeOf(item.name),
    rarity,
    hp: Math.round((70 + cm * 0.3) * level * boost),
    // 0.3% more for each cm over 50, as much less for each under.
    attack: Math.round(BASE_ATTACK * (1 + (cm - UNSIZED_CM) * 0.003) * level * boost * 10) / 10,
    level: fed
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

/** That exact fish, by kind and length (no length: one without), or null when it's gone. Of several that long, the highest level. */
export const sameFish = (d: FishData | null | undefined, g: PointsGamesConfig, name: string, cm: number | undefined): Picked | null =>
  heldFish(d, g, name).filter(p => p.held?.cm === cm).sort((a, b) => b.fighter.level - a.fighter.level)[0] ?? null;

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
    // The strongest of the kind: length and level both count.
    let index = -1;
    for (let i = 0; i < sized.length; i++) if (index < 0 || might(fighterOf(g, item, sized[i])) > might(fighterOf(g, item, sized[index]))) index = i;
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

/** A team battle: every turn, who won, and the hit points each fish of each side has left. */
export interface TeamBattle {
  turns: Turn[];
  winner: 0 | 1;
  left: [number[], number[]];
}

/** The most fish a side may send. */
export const TEAM_MAX = 3;

/** "2v2" or "3v3" (also "1v1") → the team size, anything else null. */
export function teamSizeOf(word: string): number | null {
  const m = /^([1-9])v([1-9])$/i.exec(word);
  return m && m[1] === m[2] && Number(m[1]) <= TEAM_MAX ? Number(m[1]) : null;
}

const edgeOf = (attacker: Fighter, defender: Fighter): 1 | 0 | -1 =>
  BEATS[attacker.type] === defender.type ? 1 : BEATS[defender.type] === attacker.type ? -1 : 0;

/** Fight it out, one fish against one. A coin flip says who strikes first, then they alternate. */
export function fight(a: Fighter, b: Fighter, rng: Rng = cryptoRng): Battle {
  const t = teamFight([a], [b], rng);
  return { turns: t.turns, winner: t.winner, left: [t.left[0][0], t.left[1][0]] };
}

/**
 * Fight it out, team against team: each side's fish in order, the next coming in as
 * one faints (and striking next, as the turns alternate). A coin flip says who
 * strikes first. Each pairing gets MAX_TURNS, so a long fight is called on the share of
 * hit points each side has left, the challenger on a dead heat.
 */
export function teamFight(a: Fighter[], b: Fighter[], rng: Rng = cryptoRng): TeamBattle {
  const teams = [a, b] as const;
  const left: [number[], number[]] = [a.map(f => f.hp), b.map(f => f.hp)];
  const at: [number, number] = [0, 0];
  const standing = (side: 0 | 1): boolean => at[side] < teams[side].length;
  const turns: Turn[] = [];
  const maxTurns = MAX_TURNS * Math.max(a.length, b.length);
  let by: 0 | 1 = rng() < 0.5 ? 0 : 1;
  while (standing(0) && standing(1) && turns.length < maxTurns) {
    const other: 0 | 1 = by === 0 ? 1 : 0;
    const attacker = teams[by][at[by]];
    const defender = teams[other][at[other]];
    const edge = edgeOf(attacker, defender);
    if (rng() * 100 < EVADE_PERCENT) {
      turns.push({ by, damage: 0, hit: 'miss', edge });
    } else {
      const crit = rng() * 100 < CRIT_PERCENT;
      const swing = 1 - SWING + rng() * 2 * SWING;
      const damage = Math.max(1, Math.round(attacker.attack * swing * (edge > 0 ? STRONG : edge < 0 ? WEAK : 1) * (crit ? CRIT_MULTIPLIER : 1)));
      left[other][at[other]] = Math.max(0, left[other][at[other]] - damage);
      if (left[other][at[other]] <= 0) at[other]++;
      turns.push({ by, damage, hit: crit ? 'crit' : 'hit', edge });
    }
    by = other;
  }
  const share = (side: 0 | 1): number => left[side].reduce((x, y) => x + y, 0) / teams[side].reduce((x, f) => x + f.hp, 0);
  const winner: 0 | 1 = !standing(1) ? 0 : !standing(0) ? 1 : share(0) >= share(1) ? 0 : 1;
  return { turns, winner, left };
}

/**
 * Every fish held, one entry each (fish with no length too, one per fish), the way a
 * team is picked from. `index` is as in pickFighter.
 */
function fishUnits(d: FishData | null | undefined, g: PointsGamesConfig): Picked[] {
  if (!d) return [];
  const out: Picked[] = [];
  for (const item of ITEMS) {
    if (item.type !== 'fish') continue;
    const have = d.catch.types[item.name] ?? 0;
    if (have <= 0) continue;
    const sized = (d.catch.sizes?.[item.name] ?? []).slice(0, have);
    sized.forEach((held, index) => out.push({ item, index, held, fighter: fighterOf(g, item, held) }));
    for (let i = sized.length; i < have; i++) out.push({ item, index: -1, fighter: fighterOf(g, item) });
  }
  return out;
}

/**
 * A team of `n` fish, in the order they fight: the kinds named first (the strongest of each
 * not already in, or the very one for a kind named with its length), then the strongest left; with `random`, any fish held, each an equal
 * chance. For keeps (`values`), each place gets the fish closest in value to the one it
 * faces instead. null when fewer than `n` fish are held, or `missing` names a kind asked for
 * and not held.
 */
export function pickTeam(d: FishData | null | undefined, g: PointsGamesConfig, n: number, opts: { names?: Array<string | FishSpec>; random?: boolean; values?: number[]; rng?: Rng } = {}): { team: Picked[] } | { missing: string } | null {
  const pool = fishUnits(d, g);
  if (pool.length < n) return null;
  const take = (i: number): Picked => pool.splice(i, 1)[0];
  const fits = (p: Picked, spec?: FishSpec): boolean => !spec || (p.item.name === spec.fish && (spec.cm === undefined || p.held?.cm === spec.cm));
  const strongestOf = (spec?: FishSpec): number => {
    let best = -1;
    pool.forEach((p, i) => {
      if (!fits(p, spec)) return;
      if (best < 0 || might(p.fighter) > might(pool[best].fighter)) best = i;
    });
    return best;
  };
  const team: Picked[] = [];
  for (const named of (opts.names ?? []).slice(0, n)) {
    const spec: FishSpec = typeof named === 'string' ? { fish: named } : named;
    let i = -1;
    if (opts.values) {
      const value = opts.values[team.length];
      let gap = Infinity;
      pool.forEach((p, j) => {
        if (!fits(p, spec)) return;
        const x = Math.abs(Math.log(Math.max(1, fishValue(g, p)) / Math.max(1, value)));
        if (x < gap) { gap = x; i = j; }
      });
    } else {
      i = strongestOf(spec);
    }
    if (i < 0) return { missing: specText(spec) };
    team.push(take(i));
  }
  const rng = opts.rng ?? cryptoRng;
  while (team.length < n) {
    let i: number;
    if (opts.values) {
      const value = opts.values[team.length];
      let gap = Infinity;
      i = 0;
      pool.forEach((p, j) => {
        const x = Math.abs(Math.log(Math.max(1, fishValue(g, p)) / Math.max(1, value)));
        if (x < gap) { gap = x; i = j; }
      });
    } else {
      i = opts.random ? Math.floor(rng() * pool.length) : strongestOf();
    }
    team.push(take(i));
  }
  return { team };
}

/**
 * A team as the challenge named it, found again in what its owner holds now: each fish
 * by kind and length; with `exact` off, a fish gone is stood in for by the biggest
 * left of its kind (as a one-fish duel sends the biggest of the kind named). null when
 * one can't be found.
 */
export function findTeam(d: FishData | null | undefined, g: PointsGamesConfig, wanted: ReadonlyArray<{ fish: string; cm?: number }>, exact: boolean): Picked[] | null {
  const pool = fishUnits(d, g);
  const team: Picked[] = [];
  for (const w of wanted) {
    let i = pool.findIndex(p => p.item.name === w.fish && p.held?.cm === w.cm);
    if (i < 0 && !exact) {
      pool.forEach((p, j) => {
        if (p.item.name === w.fish && (i < 0 || might(p.fighter) > might(pool[i].fighter))) i = j;
      });
    }
    if (i < 0) return null;
    team.push(pool.splice(i, 1)[0]);
  }
  return team;
}

/** A fish asked for by kind and, when given, by length: "🦈 72cm" is that very shark. */
export interface FishSpec { fish: string; cm?: number }

/**
 * Words with every length written as one "72cm" word, on its own: "🦈72cm" and
 * "🦈 72 cm" both become "🦈", "72cm". Anything else is left as it is.
 */
export function splitLengths(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i].replace(/\uFE0F/g, '');
    const glued = /^(.+?)(\d{1,3})cm$/i.exec(word);
    if (glued && fishNamed([glued[1]])) {
      out.push(glued[1], `${glued[2]}cm`);
    } else if (/^\d{1,3}$/.test(word) && /^cm$/i.test(words[i + 1] ?? '')) {
      out.push(`${word}cm`);
      i++;
    } else {
      out.push(/^\d{1,3}cm$/i.test(word) ? word.toLowerCase() : words[i]);
    }
  }
  return out;
}

/** Whether a word (after splitLengths) is a length, "72cm". */
export const isLength = (word: string): boolean => /^\d{1,3}cm$/i.test(word);

/** Every fish named in `words`, in order, each with the length after it if one is given ("🦈 72cm 🐢"). */
export function fishSpecs(words: readonly string[]): FishSpec[] {
  const out: FishSpec[] = [];
  for (const w of splitLengths(words)) {
    if (isLength(w)) {
      const last = out[out.length - 1];
      if (last && last.cm === undefined) last.cm = parseInt(w, 10);
      continue;
    }
    const fish = fishNamed([w]);
    if (fish) out.push({ fish });
  }
  return out;
}

/** "🦈 72 cm", or "🦈" for any shark. */
export const specText = (s: FishSpec): string => `${s.fish}${s.cm !== undefined ? ` ${s.cm} cm` : ''}`;

/** Every fish named in `words`, in order, by emoji or by word (🦈 🦈 is two sharks). */
export function fishesNamed(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const name = fishNamed([w]);
    if (name) out.push(name);
  }
  return out;
}

/** A team's fish together, for keeps: what it's worth. */
export const teamValue = (g: PointsGamesConfig, team: readonly Picked[]): number => team.reduce((sum, p) => sum + fishValue(g, p), 0);

/** "🦈 87 cm, 🐢, 🐬 66 cm": a team in chat. */
export const describeTeam = (team: readonly Fighter[]): string => team.map(f => `${f.fish}${f.cm !== null ? ` ${f.cm} cm` : ''}${f.level ? ` Lv${f.level}` : ''}`).join(', ');

/** "🦈 87 cm · 🦷 Predator · Epic", for a challenge and the result. */
export function describe(f: Fighter): string {
  return `${f.fish}${f.cm !== null ? ` ${f.cm} cm` : ''}${f.level ? ` Lv${f.level}` : ''} · ${TYPE_EMOJI[f.type]} ${f.type} · ${f.rarity}`;
}

// ─── What the overlay plays ─────────────────────────────────────────────────

export type DuelStake = { kind: 'friendly' } | { kind: 'wager'; amount: number } | { kind: 'keeps' };

export interface OverlaySide { user: string; fish: string; cm: number | null; type: DuelType; rarity: string; hp: number }

/** A duel as the overlay gets it: both sides, every turn, who won and what for. */
export interface OverlayDuel {
  a: OverlaySide;
  b: OverlaySide;
  /** A team battle: each side's fish in the order they fight (a and b are the first of each). */
  teams?: [OverlaySide[], OverlaySide[]];
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

/** A team battle as the overlay gets it. */
export function overlayTeamDuel(users: [string, string], teams: [Fighter[], Fighter[]], battle: TeamBattle, stake: DuelStake, currency: string): OverlayDuel {
  const side = (i: 0 | 1, f: Fighter): OverlaySide => ({ user: users[i], fish: f.fish, cm: f.cm, type: f.type, rarity: f.rarity, hp: f.hp });
  return {
    a: side(0, teams[0][0]), b: side(1, teams[1][0]),
    teams: [teams[0].map(f => side(0, f)), teams[1].map(f => side(1, f))],
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
export function playMs(turns: number, switches = 0): number {
  const perTurn = turns > 16 ? 550 : turns > 10 ? 750 : 950;
  return 2_500 + turns * perTurn + switches * SWITCH_MS + 800;
}

/** A team battle: the overlay's pause for a fish knocked out and the next coming in (FAINT_MS + ENTER_MS there). */
export const SWITCH_MS = 1_700;

/** How many times a fish comes in during a team battle: every one knocked out but the last of its side. */
export const switchesIn = (battle: TeamBattle): number =>
  battle.left.reduce((n, side) => n + Math.min(side.filter(hp => hp <= 0).length, side.length - 1), 0);

// ─── Challenges waiting for an answer ───────────────────────────────────────

export interface Challenge {
  challengerId: number;
  challenger: string;
  targetId: number;
  target: string;
  /** The fish the challenger named or, with none named, their strongest when they asked. */
  fish: string;
  /**
   * For keeps, or when the challenger named it by length (`exact`), the length of that very
   * fish (absent: one with no length). For keeps it's picked to match one the target holds.
   */
  cm?: number;
  /** The challenger named this fish by its length: it fights, not the biggest of its kind. */
  exact?: boolean;
  /** A team battle: the challenger's fish in fighting order, each by kind and length (absent: one with no length). `fish` is the first. */
  team?: Array<{ fish: string; cm?: number }>;
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
