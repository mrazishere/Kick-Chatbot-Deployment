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
}

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
