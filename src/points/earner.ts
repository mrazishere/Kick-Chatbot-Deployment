/**
 * The watch-time loop: every interval while live, viewers who chatted recently
 * earn points and watch time.
 *
 * Ticks line up with the wall clock (10:00, 10:10, ...), and each boundary is a
 * slot granted at most once, enforced by the database, not by timers. A restart
 * or a second process running the same slot therefore can't double-pay. A tick
 * whose live state can't be determined grants nothing.
 */

import { LivePointsConfig } from './config';
import { PointsDb, reportDbError, runWrite } from './db';
import { LiveState } from './live';
import { Exclusions, getMeta, grantTick, isExcluded, setMetaTx, tickExists } from './store';

/** Run this long after the boundary, so presence noted right before it is written. */
const TICK_DELAY_MS = 5_000;
/** On start, a boundary this recent with no tick yet is granted immediately. */
const CATCH_UP_MS = 3 * 60_000;

export interface EarnerContext {
  channel: string;
  config(): LivePointsConfig;
  /** null when points are disabled or the database is unavailable. */
  db(): PointsDb | null;
  flushPresence(): void;
  exclusions(): Exclusions;
  checkLive(): Promise<LiveState | null>;
  onLiveState(isLive: boolean): void;
  now(): number;
}

export interface TickOutcome {
  status: 'granted' | 'duplicate' | 'skipped';
  reason?: string;
  users?: number;
  subs?: number;
  points?: number;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class Earner {
  private ctx: EarnerContext;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSkipReason = '';

  constructor(ctx: EarnerContext) {
    this.ctx = ctx;
  }

  private intervalMs(): number {
    return this.ctx.config().cfg.intervalMinutes * 60_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = this.intervalMs();
    const now = this.ctx.now();
    const last = Math.floor(now / intervalMs) * intervalMs;
    // A deploy restart that straddles a boundary shouldn't cost viewers that interval.
    try {
      if (now - last < CATCH_UP_MS && this.ctx.config().cfg.enabled) {
        const db = this.ctx.db();
        if (db && !tickExists(db, `watch:${last}`)) {
          this.runTick(last).catch(err => console.error(`[POINTS] Catch-up tick failed: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } catch (err) {
      // A missed catch-up costs one interval; the regular schedule below must still start.
      console.error(`[POINTS] Catch-up check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (!this.running) return;
    const intervalMs = this.intervalMs();
    const now = this.ctx.now();
    const next = (Math.floor(now / intervalMs) + 1) * intervalMs;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick(next)
        .catch(err => console.error(`[POINTS] Tick failed for ${this.ctx.channel}: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => this.schedule());
    }, Math.max(0, next + TICK_DELAY_MS - now));
    this.timer.unref();
  }

  private skip(reason: string, boundaryMs: number, log = true): TickOutcome {
    // One line per change of reason, not one every ten minutes of a long offline stretch.
    if (log && reason !== this.lastSkipReason) {
      console.log(`[POINTS] tick ${hhmm(boundaryMs)} skipped for ${this.ctx.channel}: ${reason}`);
    }
    this.lastSkipReason = reason;
    return { status: 'skipped', reason };
  }

  /** Grant the slot ending at `boundaryMs`. Public for the selftest. */
  async runTick(boundaryMs: number): Promise<TickOutcome> {
    const { cfg } = this.ctx.config();
    if (!cfg.enabled) return this.skip('points disabled', boundaryMs, false);
    const intervalMs = cfg.intervalMinutes * 60_000;
    const slotKey = `watch:${boundaryMs}`;

    let db = this.ctx.db();
    if (!db) return this.skip('database unavailable', boundaryMs);
    if (tickExists(db, slotKey)) return { status: 'duplicate', reason: slotKey };
    const lastBoundary = Number(getMeta(db, 'last_tick_at') ?? 0);
    // Shortening the interval mid-stream mustn't pay two slots a few minutes apart.
    if (lastBoundary && boundaryMs > lastBoundary && boundaryMs - lastBoundary < intervalMs / 2) {
      return this.skip('too soon after the last tick', boundaryMs);
    }

    const live = cfg.debugForceLive ? { isLive: true, startedAt: null } : await this.ctx.checkLive();
    if (!live) return this.skip('live status unknown', boundaryMs);
    this.ctx.onLiveState(live.isLive);

    db = this.ctx.db();
    if (!db) return this.skip('database unavailable', boundaryMs);
    if (!live.isLive) {
      if (getMeta(db, 'live_since') !== null) runWrite(db, () => setMetaTx(db!, 'live_since', null));
      return this.skip('offline', boundaryMs);
    }

    this.ctx.flushPresence();
    try {
      const recorded = Number(getMeta(db, 'live_since'));
      const streamStart = live.startedAt ?? (Number.isFinite(recorded) && recorded > 0 ? recorded : null);
      if (!recorded && streamStart === null) runWrite(db, () => setMetaTx(db!, 'live_since', String(boundaryMs)));
      else if (streamStart !== null && recorded !== streamStart) runWrite(db, () => setMetaTx(db!, 'live_since', String(streamStart)));

      let windowStart = boundaryMs - cfg.activeWindowMinutes * 60_000;
      // Chat from before the stream only counts for the first interval.
      if (streamStart !== null) windowStart = Math.max(windowStart, streamStart - intervalMs);

      const ex = this.ctx.exclusions();
      const candidates = db.prepare('SELECT user_id, username_lc, is_sub FROM users WHERE last_chat_at > ?').all(windowStart) as Array<{ user_id: number; username_lc: string; is_sub: number }>;
      const rows = candidates
        .filter(c => !isExcluded(ex, c.user_id, c.username_lc))
        .map(c => ({
          userId: c.user_id,
          isSub: c.is_sub === 1,
          points: Math.round(cfg.pointsPerInterval * (c.is_sub === 1 ? cfg.subscriberMultiplier : 1))
        }));

      const streamKey = streamStart !== null ? `stream:${streamStart}` : `day:${new Date(boundaryMs).toISOString().slice(0, 10)}`;
      const res = grantTick(db, { slotKey, streamKey, now: this.ctx.now(), boundaryMs, seconds: cfg.intervalMinutes * 60, rows });
      if (!res.granted) return { status: 'duplicate', reason: slotKey };
      this.lastSkipReason = '';
      console.log(`[POINTS] tick ${hhmm(boundaryMs)} live ${res.users} users ${res.subs} subs +${res.points} ${cfg.currencyName}`);
      return { status: 'granted', users: res.users, subs: res.subs, points: res.points };
    } catch (err) {
      reportDbError(this.ctx.channel, err);
      throw err;
    }
  }
}
