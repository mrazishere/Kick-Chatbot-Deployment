/**
 * Who has chatted recently, in memory first and in the database every few seconds.
 *
 * Every chat message notes its sender, and writing each one would mean a
 * database transaction per message on a busy stream. Notes collect here and
 * are written together every 10 seconds, before each tick, and on stop, so a
 * crash loses at most a few seconds of presence. The 30-minute active window
 * lives in the database and survives restarts.
 */

import { PointsDb, reportDbError } from './db';
import { ChatterRow, noteChatters } from './store';

const FLUSH_MS = 10_000;
/** Stop holding presence past this many viewers while the database is away. */
const MAX_PENDING = 20_000;
/** Remember this many recent names for username lookups. */
const MAX_NAMES = 5_000;

export class PresenceTracker {
  private channel: string;
  private getDb: () => PointsDb | null;
  private pending = new Map<number, ChatterRow>();
  private names = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(channel: string, getDb: () => PointsDb | null) {
    this.channel = channel;
    this.getDb = getDb;
  }

  note(row: ChatterRow): void {
    this.pending.delete(row.userId);
    this.pending.set(row.userId, row);
    if (this.pending.size > MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest !== undefined) this.pending.delete(oldest);
    }
    this.rememberName(row.userId, row.username);
  }

  /**
   * Keep a name resolvable without noting presence. A message that doesn't count
   * toward earning (a repeat, an emote, a command) still identifies its sender,
   * and `$don add @name` should find them.
   */
  rememberName(userId: number, username: string): void {
    const lc = username.toLowerCase();
    this.names.delete(lc);
    this.names.set(lc, userId);
    if (this.names.size > MAX_NAMES) {
      const oldest = this.names.keys().next().value;
      if (oldest !== undefined) this.names.delete(oldest);
    }
  }

  /** The id of a viewer who chatted recently under this name, or null. */
  idForName(usernameLc: string): number | null {
    return this.names.get(usernameLc) ?? null;
  }

  /** Write pending presence. Returns false when it couldn't, and keeps it for the next try. */
  flush(): boolean {
    if (!this.pending.size) return true;
    const db = this.getDb();
    if (!db) return false;
    const rows = Array.from(this.pending.values());
    try {
      noteChatters(db, rows);
      for (const r of rows) {
        // A newer message from the same viewer may have arrived during the write.
        if (this.pending.get(r.userId) === r) this.pending.delete(r.userId);
      }
      return true;
    } catch (err) {
      reportDbError(this.channel, err);
      console.error(`[POINTS] Could not save chat presence for ${this.channel}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}
