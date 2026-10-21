/**
 * Cheat signals: how people play the offline fishing games, and who plays it the way
 * a script or an AI agent would. The checks (trap-check.ts) stop simple macros; an
 * agent can answer them (a viewer said as much, 2026-10-14), so this watches for what
 * an agent can't easily hide: answering fast and right every time, collecting traps
 * the moment they fill, playing round the clock, casting like a metronome, and
 * giving their $DON away (to an alt) so a failed check's fine costs nothing.
 *
 * Alts (2026-10-20, chat suspected one person rotating accounts): a new or barely
 * watching account whose play sessions start when another account's do, far more often
 * than the chat's own rhythm explains (linked_account), and a new account that only
 * ever plays games and never watches (games_only), and one that sends what it wins
 * to the same account, in $DON or fish (funnel). The bot sees no IPs, so this is
 * timing and money only.
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
  | 'check_failed'
  /** Fish or junk given away; detail JSON { to, item, n, worth }. */
  | 'fish_give';

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

export type FlagCode = 'fast_answers' | 'instant_traps' | 'no_sleep' | 'clockwork_casts' | 'parked_don' | 'linked_account' | 'games_only' | 'funnel';

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
  parked: { minAmount: 1_000, minShare: 0.8, playWithinMs: 24 * 3600_000 },
  /**
   * An alt's sessions (actions with no 30-minute gap) start within 10 minutes of its
   * owner's actions. The chat plays together (after stream, raffles), so the chance is
   * measured against everyone's session starts, not the clock; only new or barely
   * watching accounts are checked, since an alt has no history of its own.
   */
  linked: { windowMs: 10 * 60_000, sessionGapMs: 30 * 60_000, minHits: 3, minShare: 0.6, maxChance: 0.005, newDays: 14, idleWatchHours: 3 },
  /** A new account that has won from games but hardly watched: a farm, not a viewer. */
  gamesOnly: { newDays: 14, maxWatchMinutes: 30, minWon: 1_000 },
  /**
   * $DON given and fish gifted (at their price) to one account: at least minWorth, and
   * at least minShareOfWon of what the sender won from games, or any amount from a new
   * or barely watching sender (linked's newDays and idleWatchHours). That account must
   * get most of what the sender gave away (minShareOfSent): handing $DON round to
   * several people is generosity, not funnelling. Repayments of a give from the day
   * before don't count, nor loans paid back within a day.
   */
  funnel: { minWorth: 1_000, minShareOfWon: 0.5, minShareOfSent: 0.7 }
} as const;

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const secs = (ms: number): string => (ms < 10_000 ? (ms / 1000).toFixed(1) : String(Math.round(ms / 1000))) + 's';
const day = (ms: number): string => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);

interface Row { ts: number; user_id: number; kind: SignalKind; delay_ms: number | null; live: number | null; detail: string | null }

/** Two accounts that play in step: `userId`'s sessions start near `otherId`'s actions. */
export interface Link {
  userId: number;
  otherId: number;
  /** userId's sessions that started near otherId, of all its sessions. */
  hits: number;
  sessions: number;
  /** The share of everyone's session starts that otherId is near: the chance for one. */
  base: number;
  /** The chance of `hits` or more by luck. */
  chance: number;
}

/** Accounts linked by links, each group with its members' names, biggest first. */
export interface LinkedGroup { members: Array<{ userId: number; username: string }> }

/** Actions someone chose to take: games (not their payouts), gives, raffle joins, casts and hauls. */
const ACTION_REASONS = ['game:gamble', 'game:fish_sell', 'game:fish_bait', 'game:fish_steal', 'game:fish_hook', 'give_out', 'game:duel_stake', 'game:fish_reel', 'game:fish_guard'];

/**
 * Who plays in step with whom in the last `days` (RULES.linked). Every pair whose
 * chance of lining up that often by luck is under maxChance, the checked account new
 * or barely watching.
 */
export function linkedAccounts(db: PointsDb, now: number, days = 7): Link[] {
  const lk = RULES.linked;
  const since = now - days * 24 * 3600_000;
  let acts: Array<{ ts: number; user_id: number }>;
  try {
    acts = db.prepare(
      `SELECT ts, user_id FROM ledger WHERE ts >= ? AND reason IN (${ACTION_REASONS.map(() => '?').join(', ')})
       UNION ALL SELECT joined_at, user_id FROM raffle_entries WHERE joined_at >= ?
       UNION ALL SELECT ts, user_id FROM fish_signals WHERE ts >= ? AND kind IN ('cast', 'trap_collect')
       ORDER BY 1`
    ).all(since, ...ACTION_REASONS, since, since) as typeof acts;
  } catch {
    return [];
  }
  const times = new Map<number, number[]>();
  for (const a of acts) {
    const list = times.get(a.user_id);
    if (list) list.push(a.ts);
    else times.set(a.user_id, [a.ts]);
  }
  const starts = new Map<number, number[]>();
  for (const [u, ts] of times) {
    const s: number[] = [];
    let last = -Infinity;
    for (const t of ts) {
      if (t - last > lk.sessionGapMs) s.push(t);
      last = t;
    }
    starts.set(u, s);
  }
  // Whether one of these sorted times is within the window of t.
  const near = (ts: number[], t: number): boolean => {
    let lo = 0;
    let hi = ts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (ts[m] < t - lk.windowMs) lo = m + 1;
      else hi = m;
    }
    return lo < ts.length && ts[lo] <= t + lk.windowMs;
  };
  const all = [...starts].flatMap(([u, s]) => s.map(t => ({ u, t })));
  const base = new Map<number, number>();
  for (const [a, ta] of times) {
    const others = all.filter(x => x.u !== a);
    base.set(a, Math.max(0.01, others.length ? others.filter(x => near(ta, x.t)).length / others.length : 0));
  }
  const info = db.prepare('SELECT watch_seconds, first_seen_at FROM users WHERE user_id = ?');
  const choose = (n: number, k: number): number => {
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  };
  const out: Link[] = [];
  for (const [b, sb] of starts) {
    if (sb.length < lk.minHits) continue;
    const u = info.get(b) as { watch_seconds: number; first_seen_at: number } | undefined;
    if (!u || (now - u.first_seen_at >= lk.newDays * 24 * 3600_000 && u.watch_seconds >= lk.idleWatchHours * 3600)) continue;
    for (const [a, ta] of times) {
      if (a === b) continue;
      const hits = sb.filter(t => near(ta, t)).length;
      if (hits < lk.minHits || hits / sb.length < lk.minShare) continue;
      const p = base.get(a)!;
      let chance = 0;
      for (let k = hits; k <= sb.length; k++) chance += choose(sb.length, k) * p ** k * (1 - p) ** (sb.length - k);
      if (chance < lk.maxChance) out.push({ userId: b, otherId: a, hits, sessions: sb.length, base: p, chance });
    }
  }
  return out.sort((x, y) => x.chance - y.chance);
}

/** Value one account sent another in the window: $DON gives and fish gifts. */
export interface Funnel { userId: number; toId: number; don: number; fishWorth: number; fishCount: number; won: number }

/** Who sends what they win to one account (RULES.funnel). */
export function funnels(db: PointsDb, now: number, days = 7): Funnel[] {
  const fu = RULES.funnel;
  const lk = RULES.linked;
  const since = now - days * 24 * 3600_000;
  const sent = new Map<string, Funnel>();
  const at = (userId: number, toId: number): Funnel => {
    const k = `${userId}>${toId}`;
    let f = sent.get(k);
    if (!f) sent.set(k, f = { userId, toId, don: 0, fishWorth: 0, fishCount: 0, won: 0 });
    return f;
  };
  try {
    const gives = db.prepare(
      `SELECT o.ts, o.user_id, -o.delta AS amount, i.user_id AS to_id FROM ledger o JOIN ledger i ON i.ref = o.ref AND i.reason = 'give_in'
       WHERE o.reason = 'give_out' AND o.ts >= ?`
    ).all(since - 24 * 3600_000) as Array<{ ts: number; user_id: number; amount: number; to_id: number }>;
    for (const g of gives) {
      if (g.ts < since) continue;
      // A loan or its repayment: the other sent as much back within a day, either way.
      if (gives.some(x => x.user_id === g.to_id && x.to_id === g.user_id && Math.abs(g.ts - x.ts) <= 24 * 3600_000 && x.amount >= g.amount * 0.9)) continue;
      at(g.user_id, g.to_id).don += g.amount;
    }
    for (const r of db.prepare("SELECT user_id, detail FROM fish_signals WHERE kind = 'fish_give' AND ts >= ?").all(since) as Array<{ user_id: number; detail: string | null }>) {
      try {
        const d = JSON.parse(r.detail ?? '{}') as { to?: number; n?: number; worth?: number };
        if (typeof d.to !== 'number') continue;
        const f = at(r.user_id, d.to);
        f.fishWorth += Math.max(0, d.worth ?? 0);
        f.fishCount += Math.max(0, d.n ?? 0);
      } catch { /* a bad row */ }
    }
  } catch {
    return [];
  }
  // Winnings: not currency a trade brought in, nor a refund.
  const won = db.prepare("SELECT COALESCE(SUM(delta), 0) AS w FROM ledger WHERE user_id = ? AND reason LIKE 'game:%' AND reason NOT IN ('game:fish_trade_in', 'game:fish_feed_refund') AND delta > 0 AND ts >= ?");
  const info = db.prepare('SELECT watch_seconds, first_seen_at FROM users WHERE user_id = ?');
  const sentBy = new Map<number, number>();
  for (const f of sent.values()) sentBy.set(f.userId, (sentBy.get(f.userId) ?? 0) + f.don + f.fishWorth);
  const out: Funnel[] = [];
  for (const f of sent.values()) {
    const total = f.don + f.fishWorth;
    if (total < fu.minWorth || total < sentBy.get(f.userId)! * fu.minShareOfSent) continue;
    f.won = (won.get(f.userId, since) as { w: number }).w;
    const u = info.get(f.userId) as { watch_seconds: number; first_seen_at: number } | undefined;
    const alt = !!u && (now - u.first_seen_at < lk.newDays * 24 * 3600_000 || u.watch_seconds < lk.idleWatchHours * 3600);
    // An established account funnels only what it won.
    if (alt || (f.won >= fu.minWorth && total >= f.won * fu.minShareOfWon)) out.push(f);
  }
  return out.sort((a, b) => b.don + b.fishWorth - (a.don + a.fishWorth));
}

/** The accounts the links join up, as groups: an alt of an alt is one group. */
export function linkedGroups(db: PointsDb, links: Array<Pick<Link, 'userId' | 'otherId'>>): LinkedGroup[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    while (parent.has(x) && parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const l of links) {
    if (!parent.has(l.userId)) parent.set(l.userId, l.userId);
    if (!parent.has(l.otherId)) parent.set(l.otherId, l.otherId);
    parent.set(find(l.userId), find(l.otherId));
  }
  const groups = new Map<number, number[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    groups.set(r, [...(groups.get(r) ?? []), x]);
  }
  const name = db.prepare('SELECT username FROM users WHERE user_id = ?');
  return [...groups.values()].sort((a, b) => b.length - a.length)
    .map(ids => ({ members: ids.map(userId => ({ userId, username: (name.get(userId) as { username: string } | undefined)?.username ?? String(userId) })) }));
}

const odds = (p: number): string => {
  const n = Math.round(1 / Math.max(p, 1e-12));
  return n >= 1_000_000 ? 'under 1 in a million' : `about 1 in ${n.toLocaleString('en-US')}`;
};

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
  // From a day before the window, so a give can be told apart from paying one back.
  let gives: Array<{ ts: number; user_id: number; amount: number; balance_after: number; to_id: number | null; to_name: string | null }> = [];
  try {
    gives = db.prepare(
      `SELECT o.ts, o.user_id, -o.delta AS amount, o.balance_after, i.user_id AS to_id, ui.username AS to_name
       FROM ledger o LEFT JOIN ledger i ON i.ref = o.ref AND i.reason = 'give_in' LEFT JOIN users ui ON ui.user_id = i.user_id
       WHERE o.reason = 'give_out' AND o.ts >= ?`
    ).all(now - (days + 1) * 24 * 3600_000) as typeof gives;
  } catch { /* no ledger: nothing to add */ }
  // Paying back what the other gave in the day before isn't parking it (2026-10-20: a 10,000 loan, returned 8 minutes later).
  const repays = (g: (typeof gives)[number]): boolean =>
    gives.some(x => x.user_id === g.to_id && x.to_id === g.user_id && x.ts < g.ts && g.ts - x.ts <= 24 * 3600_000 && x.amount >= g.amount * 0.9);
  const links = linkedAccounts(db, now, days);
  const extra = new Map<number, Flag[]>();
  const addFlag = (userId: number, f: Flag) => extra.set(userId, [...(extra.get(userId) ?? []), f]);
  for (const l of links) {
    const other = (names.get(l.otherId) as { username: string } | undefined)?.username ?? String(l.otherId);
    addFlag(l.userId, {
      code: 'linked_account', label: 'Plays in step with another account',
      evidence: `${l.hits} of their ${l.sessions} play sessions started within ${RULES.linked.windowMs / 60_000} minutes of ${other} playing; ${other} is that close to ${Math.round(l.base * 100)}% of anyone's sessions, so ${odds(l.chance)} by chance`
    });
  }
  for (const f of funnels(db, now, days)) {
    const to = (names.get(f.toId) as { username: string } | undefined)?.username ?? String(f.toId);
    const parts = [f.don > 0 ? `${f.don.toLocaleString('en-US')} $DON in gives` : '', f.fishCount > 0 ? `${f.fishCount} fish and junk worth ${f.fishWorth.toLocaleString('en-US')}` : ''].filter(Boolean).join(' and ');
    addFlag(f.userId, {
      code: 'funnel', label: 'Funnels to one account',
      evidence: `sent ${to} ${parts}, against ${f.won.toLocaleString('en-US')} won from games in the same days`
    });
  }
  const go = RULES.gamesOnly;
  try {
    const rowsGo = db.prepare(
      `SELECT u.user_id, u.watch_seconds, u.first_seen_at,
         (SELECT COALESCE(SUM(delta), 0) FROM ledger l WHERE l.user_id = u.user_id AND l.reason LIKE 'game:%' AND l.delta > 0) AS won
       FROM users u WHERE u.first_seen_at >= ? AND u.watch_seconds < ?`
    ).all(now - go.newDays * 24 * 3600_000, go.maxWatchMinutes * 60) as Array<{ user_id: number; watch_seconds: number; first_seen_at: number; won: number }>;
    for (const u of rowsGo) {
      if (u.won < go.minWon) continue;
      addFlag(u.user_id, {
        code: 'games_only', label: 'New, games only',
        evidence: `first seen ${day(u.first_seen_at)}, ${Math.round(u.watch_seconds / 60)} minutes watched, yet ${u.won.toLocaleString('en-US')} won from games`
      });
    }
  } catch { /* an older database */ }
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
      if (g.user_id !== userId || g.ts < now - days * 24 * 3600_000 || g.amount < pk.minAmount || g.amount / (g.amount + g.balance_after) < pk.minShare || repays(g)) continue;
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

    flags.push(...(extra.get(userId) ?? []));
    extra.delete(userId);
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
  // Flagged only as an account, with no offline fishing in the window.
  const lastAct = db.prepare(`SELECT MAX(ts) AS t FROM ledger WHERE user_id = ? AND reason IN (${ACTION_REASONS.map(() => '?').join(', ')})`);
  for (const [userId, flags] of extra) {
    out.push({
      userId,
      username: (names.get(userId) as { username: string } | undefined)?.username ?? String(userId),
      flags,
      casts: 0,
      trapHauls: 0,
      checks: { asked: 0, passed: 0, wrongTries: 0, failed: 0 },
      lastSeen: (lastAct.get(userId, ...ACTION_REASONS) as { t: number | null }).t ?? 0
    });
  }
  return out.sort((a, b) => b.flags.length - a.flags.length || b.lastSeen - a.lastSeen);
}
