/**
 * One channel's loyalty points, as the bot uses them: chat presence, the
 * watch-time loop, event bonuses, and what the chat command needs.
 *
 * Constructed by the channel bot. It registers itself by channel name so the
 * command module (loaded separately, with no reference to the bot) can reach
 * it. With points disabled it does no database work and makes no files; turning
 * points on in the dashboard takes effect at the next config check, without a
 * restart.
 */

import * as crypto from 'crypto';
import { isBotSender } from '../bot-identity';
import { FollowEvent, KicksGiftedEvent, LivestreamStatusEvent, QueueMeta, RawBadge, SubscriptionEvent, SubscriptionGiftsEvent, ModerationBannedEvent } from '../types';
import { InternalPointsConfig, LivePointsConfig, effectiveCommand, readLivePointsConfig } from './config';
import { PointsDb, closePointsDb, configurePointsDb, openPointsDb, reportDbError, runWrite } from './db';
import { Earner } from './earner';
import * as bonuses from './events';
import * as penalties from './penalties';
import { LiveState, checkLive } from './live';
import { PresenceTracker } from './presence';
import { LastMessages, presenceVerdict } from './presence-rules';
import { Exclusions, exclusionsFor, expiredDuels, findUserByName, getUser, isExcluded, pruneApplied, refundDuel, setMetaTx } from './store';

const USERNAME_RE = /^[a-z0-9_]{2,25}$/;
/** Idempotency keys are kept this long; Kick re-delivers within hours, not weeks. */
const APPLIED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** A livestream status webhook older than this says nothing about now. */
const STATUS_MAX_AGE_MS = 30 * 60_000;
/** How long a live check made for a command is trusted, so a burst of gambles asks Kick once. */
const LIVE_PROBE_MS = 60_000;

export interface PointsServiceDeps {
  channelName: string;
  getBroadcasterUserId: () => number | null;
  sendMessage: (message: string) => Promise<unknown>;
  /** Kick API lookup of a username's id, for give and mod commands. */
  lookupUser?: (username: string) => Promise<number | null>;
  /** The bot's shared token file, for live checks. */
  tokenFile: string;
  /** Replaces the Kick live check (selftest). */
  checkLive?: () => Promise<LiveState | null>;
  /** Replaces opening the channel's database (selftest: simulate it being unavailable). */
  dbProvider?: () => PointsDb | null;
  /** Replaces the gamble roll's randomness with a value in [0, 1) (selftest). */
  random?: () => number;
  now?: () => number;
  /** Write wait for the other process. Short by default: a waiting bot stalls its chat. */
  busyTimeoutMs?: number;
}

const registry = new Map<string, PointsService>();

/** The running service for a channel in this process, if its bot constructed one. */
export function getPointsService(channel: string): PointsService | undefined {
  return registry.get(channel.replace(/^#/, '').toLowerCase());
}

export class PointsService {
  readonly channel: string;
  private deps: PointsServiceDeps;
  private presence: PresenceTracker;
  /** Each viewer's previous message, for the back-to-back repeat rule. */
  private lastMessages = new LastMessages();
  private earner: Earner;
  private started = false;
  private dbReady = false;
  private lastLive: boolean | null = null;
  /** A live check a command asked for, while nothing else knew; see isLiveNow. */
  private liveProbe: { at: number; value: boolean | null } | null = null;
  private liveProbeInFlight: Promise<boolean | null> | null = null;
  private duelTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private startRetry: NodeJS.Timeout | null = null;
  private exclusionCache: { source: LivePointsConfig; broadcasterUserId: number | null; value: Exclusions } | null = null;

  constructor(deps: PointsServiceDeps) {
    this.deps = deps;
    this.channel = deps.channelName.toLowerCase();
    // Only the bot constructs a service; the enrollment service keeps the longer wait.
    configurePointsDb({ busyTimeoutMs: deps.busyTimeoutMs ?? 1000, busyRetries: 1 });
    this.presence = new PresenceTracker(this.channel, () => this.db());
    this.earner = new Earner({
      channel: this.channel,
      config: () => this.liveConfig(),
      db: () => this.db(),
      flushPresence: () => this.flushPresence(),
      exclusions: () => this.exclusions(),
      checkLive: deps.checkLive ?? (() => checkLive(this.channel, deps.tokenFile)),
      onLiveState: isLive => { this.lastLive = isLive; },
      now: () => this.now()
    });
    registry.set(this.channel, this);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Settings as on disk, with the broadcaster id the bot already knows preferred over the file's. */
  liveConfig(): LivePointsConfig {
    const live = readLivePointsConfig(this.channel, this.now());
    const bid = this.deps.getBroadcasterUserId();
    return bid !== null && bid !== live.broadcasterUserId ? { cfg: live.cfg, broadcasterUserId: bid } : live;
  }

  config(): InternalPointsConfig {
    return this.liveConfig().cfg;
  }

  broadcasterUserId(): number | null {
    return this.liveConfig().broadcasterUserId;
  }

  exclusions(): Exclusions {
    const live = this.liveConfig();
    const c = this.exclusionCache;
    // Rebuilt when the settings object changes (a new file read) or the broadcaster id arrives.
    if (c && c.source.cfg === live.cfg && c.broadcasterUserId === live.broadcasterUserId) return c.value;
    const value = exclusionsFor(this.channel, live.cfg, live.broadcasterUserId);
    this.exclusionCache = { source: live, broadcasterUserId: live.broadcasterUserId, value };
    return value;
  }

  /** The database, or null while points are disabled or it can't be opened. */
  db(): PointsDb | null {
    if (!this.config().enabled) return null;
    const db = this.deps.dbProvider ? this.deps.dbProvider() : openPointsDb(this.channel, { create: true });
    if (db && !this.dbReady) {
      this.dbReady = true;
      // Deferred: this can be called from inside a transaction.
      setImmediate(() => {
        try { bonuses.replaySpool(this.bonusContext()); } catch (err) {
          console.error(`[POINTS] Replaying saved bonuses failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
    if (!db) this.dbReady = false;
    return db;
  }

  flushPresence(): void {
    this.presence.flush();
  }

  /** Called for every human chat message; commands count as activity too. Never throws. */
  /**
   * `message` is the chat text. Commands, low-effort messages and back-to-back
   * repeats don't refresh presence (see presence-rules.ts); their sender stays
   * resolvable by name. Callers that pass no text (internal tests) always count.
   */
  noteChat(senderId: unknown, username: string, badges: RawBadge[], message?: string): void {
    try {
      const cfg = this.config();
      if (!cfg.enabled) return;
      const userId = Number(senderId);
      if (!Number.isInteger(userId) || userId <= 0 || !username) return;
      if (isBotSender(username, userId) || isExcluded(this.exclusions(), userId, username)) return;
      const now = this.now();
      if (message !== undefined) {
        const verdict = presenceVerdict(message, this.lastMessages.previous(userId, now), effectiveCommand(cfg));
        this.lastMessages.remember(userId, verdict.normalized, now);
        if (!verdict.counts) {
          this.presence.rememberName(userId, username);
          return;
        }
      }
      // Sub status comes only from counted messages, alongside the presence they refresh.
      this.presence.note({ userId, username, isSub: badges.some(b => b.type === 'subscriber'), at: now });
    } catch (err) {
      console.error(`[POINTS] noteChat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A username to a Kick user id: recent chatters first, then the database, then
   * (only when allowed, since it calls Kick) the API.
   */
  async resolveUser(name: string, allowLookup: boolean): Promise<{ userId: number; username: string } | null> {
    const typed = name.replace(/^@+/, '');
    const lc = typed.toLowerCase();
    if (!USERNAME_RE.test(lc)) return null;
    const db = this.db();
    const recent = this.presence.idForName(lc);
    if (recent) return { userId: recent, username: (db && getUser(db, recent)?.username) || typed };
    if (db) {
      const u = findUserByName(db, lc);
      if (u) return { userId: u.user_id, username: u.username };
    }
    if (allowLookup && this.deps.lookupUser) {
      const id = await this.deps.lookupUser(lc).catch(() => null);
      if (id) return { userId: id, username: typed };
    }
    return null;
  }

  /**
   * Roll one gamble at the channel's win chance: a whole number from 0 to 9999,
   * winning below chance × 100. Every gamble is independent.
   */
  rollGamble(winChancePercent: number): { win: boolean; roll: number; threshold: number } {
    const roll = this.deps.random ? Math.min(9999, Math.floor(this.deps.random() * 10_000)) : crypto.randomInt(0, 10_000);
    const threshold = Math.round(Math.min(100, Math.max(0, winChancePercent)) * 100);
    return { win: roll < threshold, roll, threshold };
  }

  /**
   * Whether the channel is live, for commands that only work while it is. The
   * last tick or livestream webhook usually knows. Right after a restart nothing
   * does for up to one interval, so Kick is asked once, and the answer kept for
   * a minute. null when that fails too; callers treat it as offline.
   */
  async isLiveNow(): Promise<boolean | null> {
    if (this.config().debugForceLive) return true;
    if (this.lastLive !== null) return this.lastLive;
    const now = this.now();
    if (this.liveProbe && now - this.liveProbe.at < LIVE_PROBE_MS) return this.liveProbe.value;
    if (!this.liveProbeInFlight) {
      const check = this.deps.checkLive ?? (() => checkLive(this.channel, this.deps.tokenFile, 1, 0));
      this.liveProbeInFlight = check()
        .catch(() => null)
        .then(state => {
          const value = state ? state.isLive : null;
          // A real answer is as good as a tick's; don't overwrite one that arrived meanwhile.
          if (value !== null && this.lastLive === null) this.lastLive = value;
          this.liveProbe = { at: this.now(), value };
          return value;
        })
        .finally(() => { this.liveProbeInFlight = null; });
    }
    return this.liveProbeInFlight;
  }

  /** A duel's coin flip: true when the challenger wins. Always 50/50. */
  rollDuel(): boolean {
    return this.rollGamble(50).win;
  }

  /**
   * Refund every pending duel past its time to answer, and say so in chat. Runs on
   * a timer and before each duel command; after a restart the first run refunds
   * duels that expired while the bot was down. Returns how many. Never throws.
   */
  sweepDuels(): number {
    const db = this.db();
    if (!db) return 0;
    try {
      const now = this.now();
      const cur = this.config().currencyName;
      let refunded = 0;
      for (const d of expiredDuels(db, now)) {
        if (!refundDuel(db, { id: d.id, status: 'expired', actor: 'expiry', now })) continue;
        refunded++;
        const challenger = getUser(db, d.challenger_id)?.username ?? String(d.challenger_id);
        const opponent = getUser(db, d.opponent_id)?.username ?? String(d.opponent_id);
        console.log(`[POINTS] ${d.id} expired unanswered by ${opponent}: ${d.amount} ${cur} refunded to ${challenger}`);
        this.deps.sendMessage(`@${challenger} ${opponent} didn't answer, ${d.amount} ${cur} refunded`).catch(() => {});
      }
      return refunded;
    } catch (err) {
      reportDbError(this.channel, err);
      console.error(`[POINTS] Duel expiry sweep failed for ${this.channel}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  private bonusContext(): bonuses.BonusContext {
    return {
      channel: this.channel,
      config: () => this.liveConfig(),
      db: () => this.db(),
      isLive: () => this.lastLive,
      announce: message => { this.deps.sendMessage(message).catch(() => {}); },
      now: () => this.now()
    };
  }

  private guard<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.error(`[POINTS] ${what} failed for ${this.channel}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  /** Charge the banned viewer for a timeout, whoever issued it. */
  onBan(e: ModerationBannedEvent): penalties.PenaltyOutcome | undefined {
    return this.guard('timeout penalty', () => penalties.onBan(this.bonusContext(), e));
  }

  onFollow(e: FollowEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    return this.guard('follow bonus', () => bonuses.onFollow(this.bonusContext(), e, meta));
  }

  onSubscriptionNew(e: SubscriptionEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    return this.guard('sub bonus', () => bonuses.onSubscription(this.bonusContext(), 'new', e, meta));
  }

  onSubscriptionRenewal(e: SubscriptionEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    return this.guard('resub bonus', () => bonuses.onSubscription(this.bonusContext(), 'renewal', e, meta));
  }

  onSubscriptionGifts(e: SubscriptionGiftsEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    return this.guard('gifted sub bonus', () => bonuses.onGifts(this.bonusContext(), e, meta));
  }

  onKicksGifted(e: KicksGiftedEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    return this.guard('Kicks bonus', () => bonuses.onKicks(this.bonusContext(), e, meta));
  }

  /** A hint only: the tick's own live check decides whether anyone earns. */
  onLivestreamStatus(e: LivestreamStatusEvent, meta: QueueMeta): void {
    this.guard('livestream status', () => {
      if (meta.ageMs !== null && meta.ageMs > STATUS_MAX_AGE_MS) return;
      this.lastLive = e?.is_live === true;
      console.log(`[POINTS] ${this.channel} is ${this.lastLive ? 'live' : 'offline'} (webhook)`);
      const db = this.db();
      if (!db) return;
      const started = e?.started_at ? Date.parse(e.started_at) : NaN;
      runWrite(db, () => setMetaTx(db, 'live_since', this.lastLive ? String(Number.isFinite(started) ? started : this.now()) : null));
    });
  }

  /** The chat socket's sub event. Only pays when the sub webhooks couldn't be subscribed. */
  onPusherSubscription(data: Record<string, unknown>): void {
    bonuses.onPusherSubscription(this.bonusContext(), data, name => this.resolveUser(name, true))
      .catch(err => console.error(`[POINTS] Chat-socket sub bonus failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  /**
   * The chat socket's gifted-subs event. Deliberately unused: its payload has
   * never been seen in our logs, and the webhook carries gift ids reliably.
   */
  onPusherGifts(_data: Record<string, unknown>): void {
    // Intentionally empty.
  }

  /**
   * Never throws: the bot calls this from connect(), whose retry loop would
   * otherwise redo authentication and the socket for a points problem. A failed
   * start is retried in a minute rather than left half-started with no earner.
   */
  start(): void {
    if (this.started) return;
    try {
      const cfg = this.config();
      console.log(cfg.enabled
        ? `[POINTS] enabled for ${this.channel}: ${cfg.currencyName}, command $${effectiveCommand(cfg)}`
        : `[POINTS] disabled for ${this.channel}`);
      this.presence.start();
      this.earner.start();
      if (!this.pruneTimer) {
        this.pruneTimer = setInterval(() => {
          const db = this.db();
          if (!db) return;
          try { pruneApplied(db, this.now() - APPLIED_KEEP_MS); } catch (err) { reportDbError(this.channel, err); }
        }, 6 * 60 * 60_000);
        this.pruneTimer.unref();
      }
      if (!this.duelTimer) {
        // Holds must come back even if nobody types a duel command again.
        this.duelTimer = setInterval(() => { this.sweepDuels(); }, 15_000);
        this.duelTimer.unref();
      }
      this.started = true;
    } catch (err) {
      console.error(`[POINTS] Could not start points for ${this.channel}, retrying in a minute: ${err instanceof Error ? err.message : String(err)}`);
      try { this.earner.stop(); this.presence.stop(); } catch { /* best effort */ }
      if (!this.startRetry) {
        this.startRetry = setTimeout(() => { this.startRetry = null; this.start(); }, 60_000);
        this.startRetry.unref();
      }
    }
  }

  stop(): void {
    this.started = false;
    if (this.startRetry) {
      clearTimeout(this.startRetry);
      this.startRetry = null;
    }
    this.earner.stop();
    this.presence.stop();
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.duelTimer) {
      clearInterval(this.duelTimer);
      this.duelTimer = null;
    }
    closePointsDb(this.channel);
    this.dbReady = false;
  }

  /** Test hook: run one tick for a boundary. */
  runTick(boundaryMs: number) {
    return this.earner.runTick(boundaryMs);
  }
}
