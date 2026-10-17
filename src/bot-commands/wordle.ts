/**
 * Wordle for the whole chat, played through the currency command.
 *
 * Description: a mod starts a game; anyone guesses the 5-letter word. The whole chat
 * shares points.wordle.maxGuesses (6, like Wordle); each guess is answered with its
 * squares, 🟩 right letter right place, 🟨 in the word elsewhere, ⬜ not in it, and the
 * letters so far: CRANE 🟨⬜🟩🟨⬜ | Guesses: 1/6 | Unused: B… | Wrong pos: CN | Not in word: ER. The first
 * right guess wins points.wordle.prize.
 *
 * Permission required: everyone guesses; the streamer, mods and the bot owner start and stop.
 *
 * Usage:   $don wordle <word>   - guess (also $don w <word>, $don w g <word>, $don w guess <word>)
 *          $don wordle          - the board so far
 *          $don wordle start    - start a game (mods; also $don w s)
 *          $don wordle stop     - end it and show the word (mods; also $don w x)
 *
 * A port of the original !wordle (removed in March): the same rules and answer list,
 * now with squares, which Kick shows now that the bot posts as the streamer. The game
 * is kept in the points database, so a restart carries on with it.
 */

import { CommandFn } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import { getPointsService } from '../points/service';
import { effectiveCommand } from '../points/config';
import { runWrite } from '../points/db';
import type { PointsDb } from '../points/db';
import { applyOnce, creditTx, isExcluded } from '../points/store';
import { ANSWERS, VALID_GUESSES } from '../community/wordle-words';

const GAME_KEY = 'wordle_game';
/** Short words for the game after the currency command. */
const NAMES = new Set(['wordle', 'w']);

interface Guess { by: string; word: string; marks: string }
interface Game {
  word: string;
  guesses: Guess[];
  startedBy: string;
  startedAt: number;
  /** Set once it's over: who won, or null when the guesses ran out or a mod stopped it. */
  over?: { winner: string | null; at: number };
}

/** Squares for a guess against the answer, Wordle's way: greens first, then yellows only for letters left over. */
export function marksFor(guess: string, answer: string): string {
  const out = Array<string>(5).fill('⬜');
  const left: Record<string, number> = {};
  for (let i = 0; i < 5; i++) {
    if (guess[i] === answer[i]) out[i] = '🟩';
    else left[answer[i]] = (left[answer[i]] ?? 0) + 1;
  }
  for (let i = 0; i < 5; i++) {
    if (out[i] === '🟩') continue;
    if ((left[guess[i]] ?? 0) > 0) {
      out[i] = '🟨';
      left[guess[i]]--;
    }
  }
  return out.join('');
}

/**
 * The alphabet so far, as the original !wordle showed it: letters nobody has guessed,
 * letters in the word but not yet placed (a green anywhere places one), and letters
 * ruled out. Placed letters are in none of them.
 */
function letterState(game: Game): { unused: string; wrongPos: string; notIn: string } {
  const placed = new Set<string>();
  const guessed = new Set<string>();
  for (const g of game.guesses) {
    [...g.word].forEach((ch, i) => {
      guessed.add(ch);
      if (game.word[i] === ch) placed.add(ch);
    });
  }
  const abc = 'abcdefghijklmnopqrstuvwxyz'.split('');
  const up = (xs: string[]) => xs.join('').toUpperCase();
  return {
    unused: up(abc.filter(ch => !guessed.has(ch))),
    wrongPos: up(abc.filter(ch => guessed.has(ch) && !placed.has(ch) && game.word.includes(ch))),
    notIn: up(abc.filter(ch => guessed.has(ch) && !game.word.includes(ch)))
  };
}

/** "| Guesses: 1/6 | Unused: … | Wrong pos: … | Not in word: …", empty parts left out. */
function status(game: Game, max: number): string {
  const s = letterState(game);
  return [`Guesses: ${game.guesses.length}/${max}`, s.unused && `Unused: ${s.unused}`, s.wrongPos && `Wrong pos: ${s.wrongPos}`, s.notIn && `Not in word: ${s.notIn}`]
    .filter(Boolean).join(' | ');
}

function readGame(db: PointsDb): Game | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GAME_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as Game;
  } catch {
    return null;
  }
}

/** Call inside a write transaction. */
function writeGame(db: PointsDb, game: Game): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(GAME_KEY, JSON.stringify(game));
}

const board = (game: Game): string => game.guesses.map(g => `${g.word.toUpperCase()} ${g.marks}`).join(' | ');

/** When each channel last said no game is on, so `$don w` can't be spammed. */
const lastNoGame = new Map<string, number>();
/** When each viewer last guessed, by "channel|name". */
const lastGuess = new Map<string, number>();

export const wordle: CommandFn = async function wordle(client, message, channel, tags) {
  const words = message.trim().split(/\s+/);
  const chan = channel.replace(/^#/, '').toLowerCase();
  const svc = getPointsService(chan);
  const cfg = svc?.config();
  if (!svc || !cfg?.enabled || !cfg.wordle.enabled) return;
  const cmd = effectiveCommand(cfg);
  if ((words[0] ?? '').toLowerCase() !== `$${cmd}` || !NAMES.has((words[1] ?? '').toLowerCase())) return;
  const me = tags.username;
  const meLc = me.toLowerCase();
  if (SYSTEM_BOTS.has(meLc) || isBotSender(me, tags.senderId)) return;
  const db = svc.db();
  if (!db) return;
  const w = cfg.wordle;
  const cur = cfg.currencyName;
  const say = (text: string) => client.say(channel, text).catch(err => console.error(`[WORDLE] Reply in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`));
  const isMod = tags.isBroadcaster || tags.isModUp || isBotOwner(me);
  const first = (words[2] ?? '').toLowerCase();
  // "guess" or "g" says the next word is a guess, whatever it is: $don w g start guesses START.
  const explicit = first === 'guess' || first === 'g';
  const arg = explicit ? (words[3] ?? '').toLowerCase() : first;
  // Short words for the mod commands: s starts, x stops.
  const command = explicit ? null : first === 's' ? 'start' : first === 'x' ? 'stop' : first === 'start' || first === 'stop' ? first : null;
  const prize = w.prize > 0 ? ` First to get it wins ${w.prize.toLocaleString('en-US')} ${cur}.` : '';

  // START is a word too: while a game is on it's a guess, from anyone (a new game needs
  // the current one stopped first anyway). Only with none on does it start one.
  const gameOn = (() => {
    const g = readGame(db);
    return !!g && !g.over;
  })();
  if (command === 'start' && (first === 's' || !gameOn)) {
    if (!isMod) return;
    const word = ANSWERS[Math.floor(Math.random() * ANSWERS.length)];
    const started = runWrite(db, () => {
      const g = readGame(db);
      if (g && !g.over) return g;
      writeGame(db, { word, guesses: [], startedBy: me, startedAt: Date.now() });
      return null;
    });
    if (started) return void say(`@${me} a Wordle is already on (${started.guesses.length}/${w.maxGuesses}): $${cmd} w shows the board.`);
    console.log(`[WORDLE] ${me} started a game in ${chan}`);
    return void say(`🟩🟨⬛ Wordle! Guess the 5-letter word with $${cmd} w WORD. ${w.maxGuesses} guesses for the whole chat.${prize}`);
  }

  if (command === 'stop') {
    if (!isMod) return;
    const stopped = runWrite(db, () => {
      const g = readGame(db);
      if (!g || g.over) return null;
      g.over = { winner: null, at: Date.now() };
      writeGame(db, g);
      return g;
    });
    if (!stopped) return void say(`@${me} no Wordle is on.`);
    console.log(`[WORDLE] ${me} stopped the game in ${chan}`);
    return void say(`Wordle stopped. The word was ${stopped.word.toUpperCase()}.`);
  }

  if (!arg && !explicit) {
    const g = readGame(db);
    // With none on, say so at most every 30s per channel: it's easy to spam.
    if ((!g || g.over) && Date.now() - (lastNoGame.get(chan) ?? 0) < 30_000) return;
    if (!g || g.over) lastNoGame.set(chan, Date.now());
    if (!g || g.over) return void say(`No Wordle is on.${isMod ? ` Start one with $${cmd} w s.` : ' A mod can start one.'}`);
    if (!g.guesses.length) return void say(`Wordle: no guesses yet, ${w.maxGuesses} for the whole chat. $${cmd} w WORD`);
    return void say(`${board(g)} | ${status(g, w.maxGuesses)}`);
  }

  // A guess. With no game on there's nothing to answer: stay quiet rather than fill chat.
  if (!gameOn) return;
  if (isExcluded(svc.exclusions(), Number(tags.senderId) || null, meLc)) return;
  if (!/^[a-z]{5}$/.test(arg)) return void say(`@${me} guesses are 5 letters: $${cmd} w WORD`);
  const now = Date.now();
  const cdKey = `${chan}|${meLc}`;
  if (now - (lastGuess.get(cdKey) ?? 0) < w.guessCooldownSeconds * 1000) return;
  // An unknown word costs the wait too, so trying random letters can't flood chat.
  lastGuess.set(cdKey, now);
  if (!VALID_GUESSES.has(arg)) return void say(`@${me} ${arg.toUpperCase()} isn't in my word list.`);

  type Outcome = { kind: 'none' } | { kind: 'dup' } | { kind: 'guess'; game: Game; marks: string } | { kind: 'won' | 'lost'; game: Game; marks: string; balance?: number };
  const play = (): Outcome => {
    const g = readGame(db);
    if (!g || g.over) return { kind: 'none' };
    if (g.guesses.some(x => x.word === arg)) return { kind: 'dup' };
    const marks = marksFor(arg, g.word);
    g.guesses.push({ by: me, word: arg, marks });
    if (arg === g.word) {
      g.over = { winner: me, at: now };
      writeGame(db, g);
      const senderId = Number(tags.senderId);
      const balance = w.prize > 0 && Number.isInteger(senderId) && senderId > 0
        ? creditTx(db, { userId: senderId, username: me, amount: w.prize, reason: 'game:wordle_win', actor: 'wordle', note: g.word, now })
        : undefined;
      return { kind: 'won', game: g, marks, balance };
    }
    if (g.guesses.length >= w.maxGuesses) g.over = { winner: null, at: now };
    writeGame(db, g);
    return { kind: g.over ? 'lost' : 'guess', game: g, marks };
  };
  // Once per chat message: a replayed message (the webhook after the socket) changes nothing.
  const run = tags.messageId ? applyOnce(db, `chat:${tags.messageId}`, now, play) : { applied: true, result: runWrite(db, play) };
  if (!run.applied) return;
  const r = run.result!;
  if (r.kind === 'none') return void say(`@${me} no Wordle is on.${isMod ? ` Start one with $${cmd} w s.` : ''}`);
  if (r.kind === 'dup') return void say(`@${me} ${arg.toUpperCase()} was guessed already.`);
  const n = `${r.game.guesses.length}/${w.maxGuesses}`;
  if (r.kind === 'won') {
    console.log(`[WORDLE] ${me} won in ${chan} with ${arg} (${n})`);
    const paid = r.balance !== undefined ? ` +${w.prize.toLocaleString('en-US')} ${cur}!` : '';
    return void say(`🎉 @${me} got it in ${n}: ${arg.toUpperCase()} ${r.marks}${paid}`);
  }
  if (r.kind === 'lost') {
    console.log(`[WORDLE] game in ${chan} ran out of guesses (${r.game.word})`);
    return void say(`${arg.toUpperCase()} ${r.marks} | Guesses: ${n} | Out of guesses! The word was ${r.game.word.toUpperCase()}.`);
  }
  return void say(`${arg.toUpperCase()} ${r.marks} | ${status(r.game, w.maxGuesses)}`);
};
