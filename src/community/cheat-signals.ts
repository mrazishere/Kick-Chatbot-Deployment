/**
 * Cheat signals: how people play the offline fishing games, and who plays it the way
 * a script or an AI agent would. The checks (trap-check.ts) stop simple macros; an
 * agent can answer them (a viewer said as much, 2026-10-14), so this watches for what
 * an agent can't easily hide: answering fast and right every time, collecting traps
 * the moment they fill, playing round the clock, casting like a metronome, and
 * giving their $DON away (to an alt) so a failed check's fine costs nothing.
 *
 * Evidence for the streamer to judge, not a verdict: nothing here acts on its own.
 * The dashboard lists the flags with their numbers (Possible cheaters).
 *
 * Rows live in the channel's points database (fish_signals, schema v11), 30 days.
 */

import type { PointsDb } from '../points/db';

export type SignalKind =
  /** A cast command: delay is how long after its cooldown ended (negative: too early). */
  | 'cast'
  /** Full traps collected: delay is how long after they filled. */
  | 'trap_collect'
  /** A check asked; detail 'trap' or 'cast'. */
  | 'check_asked'
  /** A check answered right / a wrong try: delay is how long after it was asked. */
  | 'check_passed'
  | 'check_wrong'
  /** A check failed; detail 'time' or 'wrong'. */
  | 'check_failed';

const KEEP_MS = 30 * 24 * 3600_000;
let writes = 0;

/** Record one. Inside the caller's write transaction; never throws, a lost signal is fine. */
export function recordSignal(db: PointsDb, s: { userId: number; kind: SignalKind; now: number; delayMs?: number | null; live?: boolean | null; detail?: string }): void {
  try {
    db.prepare('INSERT INTO fish_signals (ts, user_id, kind, delay_ms, live, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.now, s.userId, s.kind, s.delayMs ?? null, s.live === undefined || s.live === null ? null : s.live ? 1 : 0, s.detail ?? null);
    if (++writes % 200 === 1) db.prepare('DELETE FROM fish_signals WHERE ts < ?').run(s.now - KEEP_MS);
  } catch (err) {
    console.error(`[FISH] Signal write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Reading them ────────────────────────────────────────────────────────────

export type FlagCode = 'fast_answers' | 'instant_traps' | 'no_sleep' | 'clockwork_casts' | 'parked_don';

export interface Flag {
  code: FlagCode;
  label: string;
  /** The numbers behind it, in a sentence. */
  evidence: string;
}

export interface Suspect {
  userId: number;
  username: string;
  flags: Flag[];
  /** Offline casts, trap hauls and checks in the window, for context. */
  casts: number;
  trapHauls: number;
  checks: { asked: number; passed: number; wrongTries: number; failed: number };
  lastSeen: number;
}

/** The thresholds, in one place so they're easy to read and to tune. */
export const RULES = {
  /** People take 10–60s to read a question, work it out and type; an agent a few. */
  fastAnswer: { minPassed: 3, medianUnderMs: 7_000, maxWrongTries: 1 },
  /** The "traps ready" ping lands; a person sees it some time later. */
  instantTraps: { minHauls: 8, medianUnderMs: 30_000 },
  /** Offline play across most of a day with no break long enough to sleep. */
  noSleep: { minHours: 18, maxGapMs: 4 * 3600_000 },
  /** Back-to-back casts whose gaps barely vary. */
  clockwork: { minGaps: 10, runGapUnderMs: 5 * 60_000, cvUnder: 0.15 },
  /**
   * Giving most of a balance away (to an alt, say) and fishing on: a check's fine is a
   * share of the balance, so an empty account fails checks for free (a viewer's idea,
   * 2026-10-14). Ordinary gives are a few percent at most.
   */
  parked: { minAmount: 1_000, minShare: 0.8, playWithinMs: 24 * 3600_000 }
} as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const secs = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + 's';
const day = (ms: number): string => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

interface Row { ts: number; user_id: number; kind: SignalKind; delay_ms: number | null; live: number | null; detail: string | null }

/**
 * Everyone with at least one flag in the last `days`, most flags first. Offline play
 * only (`live` 0 or unknown): live, the stream is watching anyway.
 */
export function suspects(db: PointsDb, now: number, days = 7): Suspect[] {
  let rows: Row[];
  try {
    rows = db.prepare('SELECT ts, user_id, kind, delay_ms, live, detail FROM fish_signals WHERE ts >= ? AND (live IS NULL OR live = 0) ORDER BY ts')
      .all(now - days * 24 * 3600_000) as Row[];
  } catch {
    return []; // a database from before v11
  }
  const byUser = new Map<number, Row[]>();
  for (const r of rows) {
    const list = byUser.get(r.user_id);
    if (list) list.push(r);
    else byUser.set(r.user_id, [r]);
  }
  const names = db.prepare('SELECT username FROM users WHERE user_id = ?');
  // Gives in the window, each with who got it (the two ledger rows share a ref).
  let gives: Array<{ ts: number; user_id: number; amount: number; balance_after: number; to_name: string | null }> = [];
  try {
    gives = db.prepare(
      `SELECT o.ts, o.user_id, -o.delta AS amount, o.balance_after, ui.username AS to_name
       FROM ledger o LEFT JOIN ledger i ON i.ref = o.ref AND i.reason = 'give_in' LEFT JOIN users ui ON ui.user_id = i.user_id
       WHERE o.reason = 'give_out' AND o.ts >= ?`
    ).all(now - days * 24 * 3600_000) as typeof gives;
  } catch { /* no ledger: nothing to add */ }
  const out: Suspect[] = [];
  for (const [userId, rs] of byUser) {
    const of = (k: SignalKind) => rs.filter(r => r.kind === k);
    const passed = of('check_passed');
    const wrong = of('check_wrong');
    const hauls = of('trap_collect');
    const casts = of('cast');
    const flags: Flag[] = [];

    const passMs = passed.map(r => r.delay_ms).filter((d): d is number => d !== null && d >= 0);
    const fa = RULES.fastAnswer;
    if (passMs.length >= fa.minPassed && median(passMs) < fa.medianUnderMs && wrong.length <= fa.maxWrongTries) {
      flags.push({ code: 'fast_answers', label: 'Fast, flawless answers', evidence: `${passMs.length} checks passed in a median ${secs(median(passMs))} (fastest ${secs(Math.min(...passMs))}), ${wrong.length} wrong ${wrong.length === 1 ? 'try' : 'tries'}` });
    }

    const haulMs = hauls.map(r => r.delay_ms).filter((d): d is number => d !== null && d >= 0);
    const it = RULES.instantTraps;
    if (haulMs.length >= it.minHauls && median(haulMs) < it.medianUnderMs) {
      const quick = haulMs.filter(d => d < 60_000).length;
      flags.push({ code: 'instant_traps', label: 'Instant trap hauls', evidence: `${haulMs.length} hauls collected a median ${secs(median(haulMs))} after the traps filled; ${quick} within a minute` });
    }

    // No sleep: any 24 hours, from one action, with actions in 18+ different hours and no gap over 4h.
    const ns = RULES.noSleep;
    const acts = rs.map(r => r.ts);
    for (let i = 0; i < acts.length; i++) {
      const end = acts[i] + 24 * 3600_000;
      if (end > (acts[acts.length - 1] ?? 0) + 1) break; // needs a full day after it
      const span = acts.filter(t => t >= acts[i] && t <= end);
      const hours = new Set(span.map(t => Math.floor(t / 3600_000))).size;
      let maxGap = 0;
      for (let j = 1; j < span.length; j++) maxGap = Math.max(maxGap, span[j] - span[j - 1]);
      if (hours >= ns.minHours && maxGap <= ns.maxGapMs) {
        flags.push({ code: 'no_sleep', label: 'No sleep', evidence: `played offline in ${hours} different hours of the 24 from ${day(acts[i])}, never stopping for more than ${(maxGap / 3600_000).toFixed(1)}h` });
        break;
      }
    }

    // Clockwork: the longest run of casts each within 5 minutes of the last, and how much its gaps vary.
    const ck = RULES.clockwork;
    let run: number[] = [];
    let best: number[] = [];
    for (let i = 1; i < casts.length; i++) {
      const gap = casts[i].ts - casts[i - 1].ts;
      if (gap < ck.runGapUnderMs) run.push(gap);
      else run = [];
      if (run.length > best.length) best = [...run];
    }
    if (best.length >= ck.minGaps) {
      const mean = best.reduce((a, b) => a + b, 0) / best.length;
      const sd = Math.sqrt(best.reduce((a, b) => a + (b - mean) ** 2, 0) / best.length);
      if (sd / mean < ck.cvUnder) {
        flags.push({ code: 'clockwork_casts', label: 'Clockwork casting', evidence: `${best.length + 1} casts in a row every ${secs(mean)} ± ${secs(sd)}` });
      }
    }

    // Parked $DON: most of the balance given away, then fishing offline within a day.
    const pk = RULES.parked;
    for (const g of gives) {
      if (g.user_id !== userId || g.amount < pk.minAmount || g.amount / (g.amount + g.balance_after) < pk.minShare) continue;
      const after = rs.filter(r => r.ts > g.ts && r.ts <= g.ts + pk.playWithinMs);
      if (!after.length) continue;
      const n = (k: SignalKind) => after.filter(r => r.kind === k).length;
      const share = Math.round((g.amount / (g.amount + g.balance_after)) * 100);
      flags.push({
        code: 'parked_don', label: 'Parked $DON',
        evidence: `gave ${g.amount.toLocaleString('en-US')} (${share}% of their balance) to ${g.to_name ?? 'someone'} on ${day(g.ts)}, keeping ${g.balance_after.toLocaleString('en-US')}, then played on: ${n('cast')} casts, ${n('trap_collect')} trap hauls, ${n('check_asked')} checks in the next 24h`
      });
      break;
    }

    if (!flags.length) continue;
    out.push({
      userId,
      username: (names.get(userId) as { username: string } | undefined)?.username ?? String(userId),
      flags,
      casts: casts.length,
      trapHauls: hauls.length,
      checks: { asked: of('check_asked').length, passed: passed.length, wrongTries: wrong.length, failed: of('check_failed').length },
      lastSeen: rs[rs.length - 1].ts
    });
  }
  return out.sort((a, b) => b.flags.length - a.flags.length || b.lastSeen - a.lastSeen);
}
