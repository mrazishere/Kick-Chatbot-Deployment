/**
 * AI Hall of Shame — leaderboard data layer
 *
 * Shared store used by the `!hallofshame` command (src/bot-commands/hallofshame.ts)
 * and the `!claude` handler (src/bot-commands/claude.ts). Lives outside the
 * bot-commands/ directory so the command loader does not try to load it as a
 * plugin.
 *
 * Data lives under data/leaderboard/<channel>/:
 *   - events.jsonl : one line per AI reply {seq, ts, user, prompt, response}
 *   - state.json   : running per-user tallies + scoredCursor (which seqs the
 *                    LLM scorer has already folded in)
 *
 * Scoring is lazy and asynchronous: the command triggers scoreBacklog() as a
 * fire-and-forget task, which batches unscored events to the Anthropic API,
 * asks for a dumb/trolled score per item, and folds the results into state.json.
 * Nothing runs on the !claude hot path except a best-effort appendFileSync.
 */

import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ShameEvent {
  seq: number;
  ts: string;
  user: string;
  prompt: string;
  response: string;
}

export interface UserStats {
  count: number;        // AI replies received
  dumbSum: number;      // cumulative dumb score
  trolledSum: number;   // cumulative trolled score
  dumbMax: number;      // single dumbest question score
  trolledMax: number;   // single hardest roast score
  topDumbPrompt: string;      // the question behind dumbMax
  topTrolledPrompt: string;   // the question behind trolledMax
  topTrolledResponse: string; // the bot reply behind trolledMax
}

export interface ShameState {
  scoredCursor: number;                 // highest seq already scored
  users: Record<string, UserStats>;
  generatedAt: string;
}

interface ItemScore {
  dumb: number;
  trolled: number;
}

// ─── Config ───────────────────────────────────────────────────────────────

const EVENTS_FILE = 'events.jsonl';
const STATE_FILE = 'state.json';

// Retain at most this many already-scored events on disk (quotes are kept in
// state.json, so scored raw events are only useful for debugging).
const SCORED_KEEP = 200;
// Hard ceiling on unscored events kept on disk if the command is never used —
// beyond this the oldest unscored events are dropped (never scored).
const MAX_UNSCORED = 5000;

// Scoring batch sizing
const SCORE_MODEL = 'claude-haiku-4-5-20251001';
const SCORE_BATCH = 12;          // items per Anthropic call
const SCORE_MAX_PER_RUN = 60;    // items scored per scoreBacklog() invocation

// ─── Paths ────────────────────────────────────────────────────────────────

function cleanChannel(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

function channelDir(channel: string): string {
  // Compiled location: dist/leaderboard-store.js -> ../data/leaderboard/<channel>
  return path.join(__dirname, '..', 'data', 'leaderboard', cleanChannel(channel));
}

function eventsPath(channel: string): string {
  return path.join(channelDir(channel), EVENTS_FILE);
}

function statePath(channel: string): string {
  return path.join(channelDir(channel), STATE_FILE);
}

function ensureDir(channel: string): void {
  const dir = channelDir(channel);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Event log ──────────────────────────────────────────────────────────────

// In-memory next-seq cache per channel (one bot process per channel).
const seqCache = new Map<string, number>();

function readEvents(channel: string): ShameEvent[] {
  const p = eventsPath(channel);
  if (!fs.existsSync(p)) return [];
  const out: ShameEvent[] = [];
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ShameEvent);
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function nextSeq(channel: string, events?: ShameEvent[]): number {
  const key = cleanChannel(channel);
  if (!seqCache.has(key)) {
    const evs = events ?? readEvents(channel);
    const max = evs.reduce((m, e) => Math.max(m, e.seq || 0), 0);
    seqCache.set(key, max);
  }
  const n = (seqCache.get(key) as number) + 1;
  seqCache.set(key, n);
  return n;
}

/**
 * Record an AI reply for the leaderboard. Best-effort — never throws.
 * Truncates prompt/response so the log stays lean.
 */
export function recordLeaderboardEvent(
  channel: string,
  user: string,
  prompt: string,
  response: string
): void {
  try {
    if (!user || !prompt || !response) return;
    ensureDir(channel);
    const seq = nextSeq(channel);
    const entry: ShameEvent = {
      seq,
      ts: new Date().toISOString(),
      user,
      prompt: prompt.slice(0, 500),
      response: response.slice(0, 500)
    };
    fs.appendFileSync(eventsPath(channel), JSON.stringify(entry) + '\n');
  } catch {
    // best-effort logging; swallow
  }
}

/**
 * Trim the event log: keep every unscored event plus the newest SCORED_KEEP
 * scored ones. If unscored events exceed MAX_UNSCORED (command never used),
 * drop the oldest unscored too. Atomic write.
 */
function trimEvents(channel: string, scoredCursor: number): void {
  try {
    const events = readEvents(channel);
    if (events.length === 0) return;

    let unscored = events.filter(e => e.seq > scoredCursor);
    const scored = events.filter(e => e.seq <= scoredCursor);

    if (unscored.length > MAX_UNSCORED) {
      unscored = unscored.slice(-MAX_UNSCORED);
    }
    const keptScored = scored.slice(-SCORED_KEEP);

    const kept = [...keptScored, ...unscored].sort((a, b) => a.seq - b.seq);
    if (kept.length === events.length) return; // nothing to drop

    const p = eventsPath(channel);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, kept.map(e => JSON.stringify(e)).join('\n') + '\n');
    fs.renameSync(tmp, p);
  } catch {
    // best-effort
  }
}

// ─── State ──────────────────────────────────────────────────────────────────

function emptyState(): ShameState {
  return { scoredCursor: 0, users: {}, generatedAt: new Date().toISOString() };
}

export function readState(channel: string): ShameState {
  const p = statePath(channel);
  if (!fs.existsSync(p)) return emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ShameState;
    if (!parsed.users) parsed.users = {};
    if (typeof parsed.scoredCursor !== 'number') parsed.scoredCursor = 0;
    return parsed;
  } catch {
    return emptyState();
  }
}

function writeState(channel: string, state: ShameState): void {
  ensureDir(channel);
  state.generatedAt = new Date().toISOString();
  const p = statePath(channel);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, p);
}

/** Wipe all leaderboard data for a channel (mods only, via the command). */
export function resetChannel(channel: string): void {
  try {
    writeState(channel, emptyState());
    const p = eventsPath(channel);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    seqCache.delete(cleanChannel(channel));
  } catch {
    // best-effort
  }
}

function foldIn(state: ShameState, ev: ShameEvent, score: ItemScore): void {
  const u = state.users[ev.user] || {
    count: 0,
    dumbSum: 0,
    trolledSum: 0,
    dumbMax: -1,
    trolledMax: -1,
    topDumbPrompt: '',
    topTrolledPrompt: '',
    topTrolledResponse: ''
  };
  const dumb = clamp(score.dumb);
  const trolled = clamp(score.trolled);
  u.count += 1;
  u.dumbSum += dumb;
  u.trolledSum += trolled;
  if (dumb > u.dumbMax) {
    u.dumbMax = dumb;
    u.topDumbPrompt = ev.prompt;
  }
  if (trolled > u.trolledMax) {
    u.trolledMax = trolled;
    u.topTrolledPrompt = ev.prompt;
    u.topTrolledResponse = ev.response;
  }
  state.users[ev.user] = u;
}

function clamp(n: number): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(10, Math.round(n)));
}

// ─── Scoring ──────────────────────────────────────────────────────────────

// Per-channel in-process lock so overlapping command invocations don't
// double-score. One bot process per channel, so an in-memory flag suffices.
const scoring = new Set<string>();

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Ask the model to score a batch of question/reply pairs. Returns an array of
 * scores aligned to the input order. Missing/garbled entries default to zero.
 */
async function scoreGroup(group: ShameEvent[], apiKey: string): Promise<ItemScore[]> {
  const items = group
    .map((e, i) => `Item ${i + 1}\nQuestion: ${e.prompt}\nBot reply: ${e.response}`)
    .join('\n\n');

  const system =
    'You are scoring interactions in a Kick.com chat where viewers ask a savage roast-bot AI questions. ' +
    'For each item, rate two things on a 0-10 integer scale:\n' +
    '- "dumb": how dumb, low-effort, absurd, or clueless the viewer\'s QUESTION is (0 = smart/reasonable, 10 = peak clown).\n' +
    '- "trolled": how hard the BOT REPLY roasts, trolls, mocks, or dunks on the viewer (0 = helpful/neutral, 10 = brutally roasted).\n' +
    'Judge with humor but consistency. Return ONLY a JSON array, one object per item, like ' +
    '[{"i":1,"dumb":7,"trolled":5},{"i":2,"dumb":2,"trolled":9}]. No prose, no code fences.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: SCORE_MODEL,
      max_tokens: 900,
      system,
      messages: [{ role: 'user', content: items }]
    })
  });

  if (!resp.ok) {
    throw new Error(`scoreGroup API returned ${resp.status}`);
  }

  const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
  let text = '';
  for (const block of data.content || []) {
    if (block.type === 'text') text += block.text ?? '';
  }

  const scores: ItemScore[] = group.map(() => ({ dumb: 0, trolled: 0 }));
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return scores;

  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Array<{ i?: number; dumb?: number; trolled?: number }>;
    for (const row of parsed) {
      const idx = (typeof row.i === 'number' ? row.i : 0) - 1;
      if (idx >= 0 && idx < scores.length) {
        scores[idx] = { dumb: clamp(row.dumb ?? 0), trolled: clamp(row.trolled ?? 0) };
      }
    }
  } catch {
    // leave defaults
  }
  return scores;
}

/**
 * Score any unscored events for a channel and fold them into state.json.
 * Fire-and-forget from the command. Batched, capped per run, checkpoints after
 * each batch, and self-guards against concurrent runs. Returns number scored.
 */
export async function scoreBacklog(channel: string, apiKey: string): Promise<number> {
  const key = cleanChannel(channel);
  if (scoring.has(key)) return 0;
  if (!apiKey) return 0;
  scoring.add(key);
  try {
    const state = readState(channel);
    const pending = readEvents(channel)
      .filter(e => e.seq > state.scoredCursor)
      .sort((a, b) => a.seq - b.seq);
    if (pending.length === 0) return 0;

    const toScore = pending.slice(0, SCORE_MAX_PER_RUN);
    let scoredCount = 0;

    for (const group of chunk(toScore, SCORE_BATCH)) {
      let groupScores: ItemScore[];
      try {
        groupScores = await scoreGroup(group, apiKey);
      } catch {
        // Skip this batch on API failure; leave cursor so it retries next time.
        break;
      }
      for (let i = 0; i < group.length; i++) {
        foldIn(state, group[i], groupScores[i]);
      }
      state.scoredCursor = Math.max(state.scoredCursor, group[group.length - 1].seq);
      scoredCount += group.length;
      writeState(channel, state); // checkpoint each batch
    }

    if (scoredCount > 0) {
      trimEvents(channel, state.scoredCursor);
    }
    return scoredCount;
  } finally {
    scoring.delete(key);
  }
}

/** True if there are events waiting to be scored. */
export function hasPending(channel: string): boolean {
  const state = readState(channel);
  return readEvents(channel).some(e => e.seq > state.scoredCursor);
}

// ─── Leaderboard queries ────────────────────────────────────────────────────

export interface Ranked {
  user: string;
  stats: UserStats;
  avg: number; // the average score this ranking sorted on (0 for count-based)
}

// Minimum questions asked before a user qualifies for an average-based board —
// keeps a single lucky/unlucky question from topping the grinders while still
// letting a consistently-savage low-volume user pull an upset.
const MIN_QUALIFY = 3;

export function avgTrolled(s: UserStats): number {
  return s.count ? s.trolledSum / s.count : 0;
}

export function avgDumb(s: UserStats): number {
  return s.count ? s.dumbSum / s.count : 0;
}

/** Rank qualifying users (>= MIN_QUALIFY questions) by an average score. */
function rankAvg(state: ShameState, key: (s: UserStats) => number, n: number): Ranked[] {
  return Object.entries(state.users)
    .map(([user, stats]) => ({ user, stats, avg: key(stats) }))
    .filter(r => r.stats.count >= MIN_QUALIFY && r.avg > 0)
    .sort((a, b) => b.avg - a.avg)
    .slice(0, n);
}

/** Most roasted by AVERAGE savagery per question (quality, not volume). */
export function topTrolled(state: ShameState, n = 5): Ranked[] {
  return rankAvg(state, avgTrolled, n);
}

/** Biggest clowns by AVERAGE dumbness per question (quality, not volume). */
export function topDumb(state: ShameState, n = 5): Ranked[] {
  return rankAvg(state, avgDumb, n);
}

/** Most active askers — the one intentionally volume-based board. */
export function topAskers(state: ShameState, n = 5): Ranked[] {
  return Object.entries(state.users)
    .map(([user, stats]) => ({ user, stats, avg: 0 }))
    .filter(r => r.stats.count > 0)
    .sort((a, b) => b.stats.count - a.stats.count)
    .slice(0, n);
}

/** The single hardest roast ever landed (any user), for the Hall of Fame. */
export function hardestRoast(state: ShameState): Ranked | null {
  let best: Ranked | null = null;
  for (const [user, stats] of Object.entries(state.users)) {
    if (stats.trolledMax > (best?.stats.trolledMax ?? -1)) best = { user, stats, avg: stats.trolledMax };
  }
  return best && best.stats.trolledMax > 0 ? best : null;
}

/** The single dumbest question ever asked (any user), for the Hall of Fame. */
export function dumbestQuestion(state: ShameState): Ranked | null {
  let best: Ranked | null = null;
  for (const [user, stats] of Object.entries(state.users)) {
    if (stats.dumbMax > (best?.stats.dumbMax ?? -1)) best = { user, stats, avg: stats.dumbMax };
  }
  return best && best.stats.dumbMax > 0 ? best : null;
}
