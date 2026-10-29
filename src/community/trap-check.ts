/**
 * Trap checks: our addition against macros that collect and re-lay traps all night.
 * Now and then, collecting full traps while the stream is offline asks a question
 * first, and the haul waits for `fish answer <x>`: a few tries within a short
 * window, and running out of either counts as a wrong answer. Each question needs
 * working out (count, add, subtract, pick or place), so a macro that sends a fixed message
 * or copies text out of the question can't pass it, and each has enough possible
 * answers that the tries don't let a guesser through. Several kinds rotate so one
 * hard-coded rule doesn't cover them all. Answers are matched loosely (digits or
 * words, emoji or name, any case) so a slip of formatting never costs anything.
 */

import { randomInt } from 'crypto';

export interface TrapCheck {
  question: string;
  /** Every accepted answer, already normalized. */
  answers: string[];
  /** Whether the traps go back in once it's answered (the player used `trap reset`). */
  reset: boolean;
  /** How long they go back in for, when the reset named a time; else as long as before. */
  resetMinutes?: number;
  /** When it was asked, and the last moment an answer counts (ms). */
  askedAt: number;
  until: number;
  /** Wrong answers so far. */
  wrong: number;
  /** Asked on a cast rather than full traps: answering frees the line, there's no haul. */
  cast?: boolean;
  /**
   * The fine, set from the balance when it was asked: moving $DON away before failing
   * doesn't shrink it (failing takes at most what's left). Absent on older checks.
   */
  fine?: number;
  /**
   * Asked on the leaderboard's fishing page instead of chat: a drawn scene to tap in, not
   * a question to type. The scene (positions included) stays on the server; the page only
   * gets it as a picture, so a script has to look at it rather than read it.
   */
  tap?: TapScene;
}

/** A fish drawn in a tap check, in the scene's own units (0 to 1 across, 0 to 1 down). */
export interface TapFish { x: number; y: number; size: number; left: boolean; color: TapColor; /** Drawn with stripes: a colour question's target, so colour isn't the only cue. */ striped?: boolean }
export interface TapScene { fish: TapFish[]; target: number }

export const TAP_COLORS = { red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899' } as const;
export type TapColor = keyof typeof TAP_COLORS;

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th'];
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh'];

/**
 * Emojis the questions draw from, with the words also taken for each. Nothing is
 * taken as just "fish": that word is in the question that asks for one.
 */
const FISH: Record<string, string[]> = {
  '🐟': [], '🦐': ['shrimp', 'prawn'], '🦀': ['crab'], '🐠': ['tropical fish', 'clownfish', 'clown fish'], '🐡': ['blowfish', 'pufferfish', 'puffer', 'fugu'],
  '🦞': ['lobster', 'crayfish'], '🐙': ['octopus', 'octopuses', 'octopi'], '🦑': ['squid', 'calamari'], '🐬': ['dolphin'], '🦈': ['shark'], '🐳': ['whale'], '🐢': ['turtle', 'tortoise']
};
const JUNK: Record<string, string[]> = {
  '🥫': ['can', 'tin', 'tin can', 'canned food', 'soup'], '🥾': ['boot', 'shoe', 'hiking boot'], '🧦': ['sock', 'stocking'],
  '🌿': ['herb', 'leaf', 'weed', 'plant', 'seaweed', 'grass'], '🍂': ['leaves', 'leaf', 'autumn leaf', 'fall leaf'], '💀': ['skull', 'skeleton'], '🪣': ['bucket', 'pail']
};
const ALL = { ...FISH, ...JUNK };

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)];
const shuffle = <T>(list: T[]): T[] => {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
};
const numberAnswers = (n: number): string[] => [String(n), NUMBER_WORDS[n]];
const emojiAnswers = (emoji: string): string[] => [emoji, ...(ALL[emoji] ?? [])].map(normalizeAnswer);
/** A row with each emoji's number in front: "1.🐬 2.🧦 3.🦈". */
const numbered = (row: string[]): string => row.map((e, i) => `${i + 1}.${e}`).join(' ');
/** Either form, so a script can't count on one: "seven" or "7". */
const sayNumber = (n: number): string => (randomInt(2) ? NUMBER_WORDS[n] : String(n));

type Question = Pick<TrapCheck, 'question' | 'answers'>;

const KINDS: Array<() => Question> = [
  // Count one kind in a row of mixed ones: 2 to 9.
  () => {
    const [target, ...others] = shuffle(Object.keys(ALL)).slice(0, 3);
    const n = randomInt(2, 10);
    const row = shuffle([...Array(n).fill(target), ...Array.from({ length: randomInt(3, 7) }, () => pick(others))]);
    return { question: `How many ${target} are in ${row.join('')}?`, answers: numberAnswers(n) };
  },
  // A sum, one side in words: 2 to 19.
  () => {
    const a = randomInt(1, 11);
    const b = randomInt(1, 10);
    return { question: `What is ${NUMBER_WORDS[a]} plus ${sayNumber(b)}?`, answers: numberAnswers(a + b) };
  },
  // A difference, one side in words: 1 to 15.
  () => {
    const a = randomInt(6, 20);
    const b = randomInt(1, a - 1 > 9 ? 10 : a);
    return { question: `What is ${sayNumber(a)} minus ${NUMBER_WORDS[b]}?`, answers: numberAnswers(a - b) };
  },
  // The one fish among five pieces of junk. Numbered, so a phone can answer with a
  // digit instead of copying an emoji (feedback, 2026-10-14); the emoji and its names count too.
  () => {
    const fish = pick(Object.keys(FISH));
    const row = shuffle([fish, ...shuffle(Object.keys(JUNK)).slice(0, 5)]);
    return { question: `Which one of these is a fish: ${numbered(row)}?`, answers: [...emojiAnswers(fish), ...numberAnswers(row.indexOf(fish) + 1)] };
  },
  // The one piece of junk among five fish.
  () => {
    const junk = pick(Object.keys(JUNK));
    const row = shuffle([junk, ...shuffle(Object.keys(FISH)).slice(0, 5)]);
    return { question: `Which one of these is NOT a fish: ${numbered(row)}?`, answers: [...emojiAnswers(junk), ...numberAnswers(row.indexOf(junk) + 1)] };
  },
  // Where an emoji sits in a row of 6 or 7, counted from the left: answered with a number
  // (4, 4th, fourth), so nobody has to copy an emoji.
  () => {
    const row = shuffle(Object.keys(ALL)).slice(0, randomInt(6, 8));
    const i = randomInt(row.length);
    return { question: `Counting from the left, where is ${row[i]} in ${row.join('')}?`, answers: [...numberAnswers(i + 1), ORDINALS[i], ORDINAL_WORDS[i]] };
  }
];

export function makeTrapCheck(reset: boolean, now: number, seconds: number, cast = false): TrapCheck {
  return { ...pick(KINDS)(), reset, askedAt: now, until: now + seconds * 1000, wrong: 0, ...(cast ? { cast: true } : {}) };
}

/**
 * The fishing page's check: 6 to 8 fish scattered over the water, none touching, and one
 * to tap, picked out by its colour (the only one that colour) or by the way it swims (the
 * only one facing left). Same tries, window and fine as a typed one.
 */
export function makeTapCheck(reset: boolean, now: number, seconds: number, cast = false): TrapCheck {
  const colors = Object.keys(TAP_COLORS) as TapColor[];
  const n = randomInt(6, 9);
  const fish: TapFish[] = [];
  for (let tries = 0; fish.length < n && tries < 500; tries++) {
    const size = 0.1 + randomInt(0, 60) / 1000;
    const x = size / 2 + 0.03 + Math.random() * (1 - size - 0.06);
    const y = size * 0.8 + 0.05 + Math.random() * (1 - size * 1.6 - 0.1);
    // In units of the scene's height (it's 8:5, and a fish's size is a share of the width): far
    // enough apart that no tap meant for one lands on another.
    if (fish.some(f => Math.hypot((f.x - x) * 1.6, f.y - y) < (f.size + size) * 1.1)) continue;
    fish.push({ x, y, size, left: false, color: pick(colors) });
  }
  const target = randomInt(fish.length);
  let question: string;
  if (randomInt(2)) {
    // By colour and stripes: the target's colour is nobody else's, and it alone is striped.
    const color = pick(colors);
    const others = colors.filter(c => c !== color);
    // Stripes too, and only on it: someone who can't tell the colours apart still has a way to find it.
    fish.forEach((f, i) => { f.color = i === target ? color : pick(others); f.left = !!randomInt(2); if (i === target) f.striped = true; });
    question = `Tap the striped ${color} fish.`;
  } else {
    // By direction: the target alone swims left.
    fish.forEach((f, i) => { f.left = i === target; });
    question = 'Tap the fish swimming to the left.';
  }
  return { question, answers: [], reset, askedAt: now, until: now + seconds * 1000, wrong: 0, ...(cast ? { cast: true } : {}), tap: { fish, target } };
}

/** A tap's answer, "tap:<x>,<y>" in the scene's units: on the target fish, with a little slack. */
export function tapMatches(scene: TapScene, raw: string | undefined): boolean {
  const m = /^tap:(0(?:\.\d+)?|1(?:\.0+)?),(0(?:\.\d+)?|1(?:\.0+)?)$/.exec((raw ?? '').trim());
  const f = scene.fish[scene.target];
  if (!m || !f) return false;
  const x = Number(m[1]);
  const y = Number(m[2]);
  // An ellipse around the body, a fish being wider than it's tall, plus a margin for a finger.
  const rx = f.size * 0.6 + 0.02;
  const ry = f.size * 0.42 * 1.6 + 0.03;
  return ((x - f.x) / rx) ** 2 + ((y - f.y) / ry) ** 2 <= 1;
}

/**
 * Lower case, without what chat clients add or people type around an answer:
 * variation selectors, zero-width joiners, the invisible tag characters 7TV appends
 * to repeated messages, quotes, a trailing full stop, an @, a leading "a"/"the".
 */
export function normalizeAnswer(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/[\u{E0000}-\u{E007F}︎️​-‍⁠]/gu, '')
    .toLowerCase()
    .replace(/["'`.!?@,]/g, ' ')
    .replace(/^\s*(?:a|an|the)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The same answer whichever way a person types it: spaces dropped ("puffer fish" is
 * "pufferfish") and a plural ending taken off ("socks", "boots", "crabs" — 2026-10-14
 * "socks" was refused for 🧦). Both sides go through it, so "leaves" still meets "leaves".
 */
function loose(answer: string): string {
  const s = answer.replace(/\s+/g, '');
  if (/^\d+$/.test(s) || s.length < 4) return s;
  return s.replace(/(?:es|s)$/, '');
}

export function answerMatches(check: Pick<TrapCheck, 'answers'>, raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const given = normalizeAnswer(raw);
  return check.answers.some(a => a === given || loose(a) === loose(given));
}
