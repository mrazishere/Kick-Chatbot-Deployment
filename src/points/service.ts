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
import * as antispam from './antispam';
import { LiveState, checkLive } from './live';
import * as bigBite from '../community/big-bite';
import { watchOverlay, watchOverlayOpen, type OverlayWatchAlerts } from '../community/fish-overlay';
import { syncGuardPause } from '../community/fish-shop';
import { PresenceTracker } from './presence';
import { LastMessages, presenceVerdict } from './presence-rules';
import { Exclusions, applyOnce, creditTx, isApplied, drawRaffle, dueRaffles, exclusionsFor, expiredDuels, findUserByName, getMeta, getUser, isExcluded, openRaffle, pruneApplied, raffleEntries, RaffleRow, refundDuel, setMetaTx } from './store';

/** The overlay watchdog's alerts, to the owner's Telegram. Loaded on first use: the selftest must never reach Telegram. */
const overlayAlerts: OverlayWatchAlerts = {
  frozen: (channel, minutes) => telegram()?.notifyOverlayFrozen(channel, minutes).catch(() => false),
  recovered: (channel, minutes) => telegram()?.notifyOverlayRecovered(channel, minutes).catch(() => false)
};
type OverlayNotifier = { notifyOverlayFrozen(c: string, m: number): Promise<boolean>; notifyOverlayRecovered(c: string, m: number): Promise<boolean> };
let notifier: OverlayNotifier | null | undefined;
function telegram(): OverlayNotifier | null {
  if (notifier !== undefined) return notifier;
  if (process.env.POINTS_SELFTEST === '1') return (notifier = null);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const TelegramNotifier = require('../telegram-notifier') as new () => OverlayNotifier;
  return (notifier = new TelegramNotifier());
}

const USERNAME_RE = /^[a-z0-9_]{2,25}$/;
/** Idempotency keys are kept this long; Kick re-delivers within hours, not weeks. */
const APPLIED_KEEP_MS = 30 * 24 * 60 * 60_000;
/** A livestream status webhook older than this says nothing about now. */
const STATUS_MAX_AGE_MS = 30 * 60_000;
/** How long a live check made for a command is trusted, so a burst of gambles asks Kick once. */
const LIVE_PROBE_MS = 60_000;
/**
 * How long a known live state is trusted before a command asks Kick again. The tick
 * only checks every interval and the offline webhook comes late or not at all
 * (2026-10-14: none for a stream that ended), so offline-only fishing stayed shut
 * for up to 10 minutes after a stream ended.
 */
const LIVE_FRESH_MS = 30_000;
/**
 * How long a !live / !offline from the streamer or a mod stands while Kick's API still
 * says otherwise (it lags a stream's start and end by minutes). Kick agreeing, or a
 * livestream webhook either way, ends it sooner.
 */
export const LIVE_OVERRIDE_MS = 20 * 60_000;

export interface PointsServiceDeps {
  channelName: string;
  getBroadcasterUserId: () => number | null;
  sendMessage: (message: string) => Promise<unknown>;
  /** Kick API lookup of a username's id, for give and mod commands. */
  lookupUser?: (username: string) => Promise<number | null>;
  /** The channel's moderator, for timing out a spammer who can't pay (points.antiSpam.timeoutMinutes). */
  timeout?: antispam.SpamTimeout;
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
  /** Each viewer's recent spam-keyword messages (points.antiSpam). */
  private spam = new antispam.SpamTracker();
  private earner: Earner;
  private started = false;
  private dbReady = false;
  private lastLive: boolean | null = null;
  /** When lastLive was last learned, from a tick, a webhook or a command's check. */
  private lastLiveAt = 0;
  /** A live check a command asked for, while nothing else knew; see isLiveNow. */
  private liveProbe: { at: number; value: boolean | null } | null = null;
  private liveProbeInFlight: Promise<boolean | null> | null = null;
  /** A !live or !offline (bot-commands/streamstatus.ts) standing in for Kick until Kick catches up. */
  private liveOverride: { value: boolean; until: number; by: string } | null = null;
  private duelTimer: NodeJS.Timeout | null = null;
  private raffleTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private biteTimer: NodeJS.Timeout | null = null;
  private spamBoardTimer: NodeJS.Timeout | null = null;
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
      onLiveState: isLive => { this.setLive(isLive, 'poll'); },
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

  /**
   * Pay a viewer for a channel-points reward that buys the currency. Keyed on the
   * redemption, so a redelivered webhook or a restart mid-way never pays twice.
   * Failures are short sentences for chat; the reward handler refunds them.
   */
  creditFromReward(a: { userId: number; username: string; amount: number; redemptionId: string; rewardTitle: string }):
    { ok: true; balance: number | null; currency: string } | { ok: false; reason: string } {
    const cfg = this.config();
    if (!cfg.enabled) return { ok: false, reason: 'loyalty points are switched off here' };
    const db = this.db();
    if (!db) return { ok: false, reason: `${cfg.currencyName} is unavailable right now` };
    if (isExcluded(this.exclusions(), a.userId, a.username)) return { ok: false, reason: `you don't collect ${cfg.currencyName} here` };
    const run = applyOnce(db, `reward:${a.redemptionId}`, this.now(), () => creditTx(db, {
      userId: a.userId, username: a.username, amount: a.amount, reason: 'channel_points',
      actor: `reward:${a.username}`, note: a.rewardTitle, now: this.now()
    }));
    // Already paid: report success so Kick's copy is accepted rather than refunded.
    return { ok: true, balance: run.applied ? (run.result ?? null) : null, currency: cfg.currencyName };
  }

  /** Whether a channel-points redemption was already paid by creditFromReward. */
  rewardAlreadyPaid(redemptionId: string): boolean {
    const db = this.db();
    return !!db && isApplied(db, `reward:${redemptionId}`);
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
   * `messageId` is Kick's id for the message, so a spam charge lands once per message.
   */
  noteChat(senderId: unknown, username: string, badges: RawBadge[], message?: string, messageId?: string): void {
    try {
      const cfg = this.config();
      if (!cfg.enabled) return;
      const userId = Number(senderId);
      if (!Number.isInteger(userId) || userId <= 0 || !username) return;
      if (isBotSender(username, userId) || isExcluded(this.exclusions(), userId, username)) return;
      // Keyword spam costs points; the broadcaster and mods are never counted.
      if (message !== undefined && cfg.antiSpam.enabled && !badges.some(b => b.type === 'moderator' || b.type === 'broadcaster' || b.type === 'owner')) {
        this.guard('spam check', () => antispam.onChat(this.bonusContext(), this.spam, { userId, username, message, messageId }, this.deps.timeout));
      }
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
   * What Kick says. A poll that agrees with a !live / !offline ends it (Kick has caught up);
   * one that disagrees is taken as Kick lagging. A webhook is news of a change, so it ends one either way.
   */
  private setLive(isLive: boolean, source: 'poll' | 'webhook'): void {
    this.lastLive = isLive;
    this.lastLiveAt = this.now();
    const o = this.liveOverride;
    if (o && (source === 'webhook' || o.value === isLive)) {
      this.liveOverride = null;
      console.log(`[POINTS] ${this.channel}: Kick ${o.value === isLive ? 'caught up with' : 'overrode'} ${o.by}'s !${o.value ? 'live' : 'offline'} (${source})`);
    }
  }

  /**
   * !live / !offline: commands treat the stream as live or offline now, until Kick says
   * the same, a livestream webhook arrives, or LIVE_OVERRIDE_MS passes. Payouts still
   * follow Kick's own check (the tick), so this can't mint currency. Returns what
   * commands saw before.
   */
  setLiveOverride(value: boolean, by: string): boolean | null {
    const before = this.liveOverrideNow() ?? this.lastLive;
    this.liveOverride = { value, until: this.now() + LIVE_OVERRIDE_MS, by };
    console.log(`[POINTS] ${this.channel} set ${value ? 'live' : 'offline'} by ${by} (Kick last said ${this.lastLive === null ? 'nothing' : this.lastLive ? 'live' : 'offline'})`);
    return before;
  }

  /** The standing !live / !offline, or null with none (or once it ran out). */
  liveOverrideNow(): boolean | null {
    const o = this.liveOverride;
    if (!o) return null;
    if (this.now() >= o.until) {
      this.liveOverride = null;
      console.log(`[POINTS] ${this.channel}: ${o.by}'s !${o.value ? 'live' : 'offline'} ran out; back to Kick's state`);
      return null;
    }
    return o.value;
  }

  /**
   * Whether the channel is live, for commands that only work while it is. A state
   * learned in the last LIVE_FRESH_MS (from a tick, a webhook, or an earlier ask)
   * is used as is (a standing !live / !offline before either); an older one is checked with Kick again, one ask at a time, so a
   * stream's end reaches offline-only commands within about half a minute of Kick
   * showing it. If the ask fails the last known state stands; with none at all
   * (just restarted), null, which callers treat as offline.
   */
  async isLiveNow(): Promise<boolean | null> {
    if (this.config().debugForceLive) return true;
    const override = this.liveOverrideNow();
    if (override !== null) return override;
    const now = this.now();
    if (this.lastLive !== null && now - this.lastLiveAt < LIVE_FRESH_MS) return this.lastLive;
    if (this.lastLive === null && this.liveProbe && now - this.liveProbe.at < LIVE_PROBE_MS) return this.liveProbe.value;
    if (!this.liveProbeInFlight) {
      const check = this.deps.checkLive ?? (() => checkLive(this.channel, this.deps.tokenFile, 1, 0));
      const askedAt = now;
      this.liveProbeInFlight = check()
        .catch(() => null)
        .then(state => {
          const value = state ? state.isLive : null;
          // A real answer is as good as a tick's; don't overwrite one that arrived meanwhile.
          if (value !== null && this.lastLiveAt <= askedAt) {
            if (this.lastLive !== null && this.lastLive !== value) console.log(`[POINTS] ${this.channel} is ${value ? 'live' : 'offline'} (checked for a command)`);
            this.setLive(value, 'poll');
          }
          this.liveProbe = { at: this.now(), value };
          return value ?? this.lastLive;
        })
        .finally(() => { this.liveProbeInFlight = null; });
    }
    return this.liveProbeInFlight;
  }

  /**
   * Maybe give a random active chatter a big bite (community/big-bite.ts). Only with
   * points and fishing on; the module checks live, the overlay and the timing.
   */
  async bigBiteTick(random?: () => number): Promise<string | null> {
    try {
      const cfg = this.config();
      if (!cfg.enabled || !cfg.games.enabled) return null;
      const db = this.db();
      if (!db) return null;
      const live = (await this.isLiveNow()) === true;
      // The fishing overlay, big bites or not: reload a source that stopped drawing, alert if it stays stuck.
      watchOverlay(db, this.channel, live, overlayAlerts);
      watchOverlayOpen(db, this.channel, live, cfg.games.bigBite.enabled);
      if (!cfg.games.bigBite.enabled) return null;
      const ex = this.exclusions();
      return bigBite.tick({
        channel: this.channel, db, bigBite: cfg.games.bigBite, delayMs: cfg.games.streamDelaySeconds * 1000, command: effectiveCommand(cfg), live, now: this.now(), random,
        excluded: (id, name) => isExcluded(ex, id, name),
        sendMessage: m => this.deps.sendMessage(m)
      });
    } catch (err) {
      console.error(`[FISH] Big bite check failed for ${this.channel}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** A duel's coin flip: true when the challenger wins. Always 50/50. */
  rollDuel(): boolean {
    return this.rollGamble(50).win;
  }

  /**
   * Which stream a raffle belongs to, for the per-stream allowance. Offline the
   * day is used, so raffles opened with the stream down still share a bucket
   * instead of every one counting as a fresh stream.
   */
  raffleStreamKey(): string {
    const db = this.db();
    const since = db ? Number(getMeta(db, 'live_since')) : NaN;
    if (Number.isFinite(since) && since > 0) return `stream:${since}`;
    return `day:${new Date(this.now()).toISOString().slice(0, 10)}`;
  }

  /**
   * Draw `count` distinct entrants at random. Uses the same seedable source as the
   * gamble roll so a test can fix the outcome. Fewer entrants than winners means
   * everyone wins, which is the sensible reading of a small raffle.
   */
  pickWinners<T>(entries: T[], count: number): T[] {
    const pool = entries.slice();
    const out: T[] = [];
    const want = Math.min(count, pool.length);
    for (let i = 0; i < want; i++) {
      const r = this.deps.random ? this.deps.random() : crypto.randomInt(0, 1_000_000) / 1_000_000;
      const idx = Math.min(pool.length - 1, Math.floor(r * pool.length));
      out.push(pool.splice(idx, 1)[0]);
    }
    return out;
  }

  /** Draw one raffle now and announce it. Returns the paid winners, or null when it was already resolved. */
  drawRaffleNow(r: RaffleRow): Array<{ username: string; amount: number }> | null {
    const db = this.db();
    if (!db) return null;
    const cur = this.config().currencyName;
    const ex = this.exclusions();
    const entries = raffleEntries(db, r.id).filter(e => !isExcluded(ex, e.user_id, e.username));
    if (!entries.length) {
      if (!drawRaffle(db, { id: r.id, winners: [], actor: 'raffle', now: this.now() })) return null;
      console.log(`[POINTS] ${r.id} closed with no entries, ${r.prize} ${cur} not paid`);
      this.deps.sendMessage(`Raffle closed with nobody entered, no ${cur} paid`).catch(() => {});
      return [];
    }
    const winners = this.pickWinners(entries, r.winners).map(e => ({ userId: e.user_id, username: e.username }));
    const res = drawRaffle(db, { id: r.id, winners, actor: 'raffle', now: this.now() });
    if (!res) return null;
    const names = res.paid.map(w => `${w.username} ${w.amount}`).join(' · ');
    console.log(`[POINTS] ${r.id} drawn from ${entries.length} entries: ${names || 'nobody'} (${cur})`);
    this.deps.sendMessage(
      res.paid.length === 1
        ? `Raffle won by ${res.paid[0].username}, ${res.paid[0].amount} ${cur} from ${entries.length} entries`
        : `Raffle drawn from ${entries.length} entries — ${names} ${cur}`
    ).catch(() => {});
    return res.paid.map(w => ({ username: w.username, amount: w.amount }));
  }

  /**
   * Draw the open raffle the moment it closes. The 15s sweep would get there too,
   * but up to 15s late, which chat notices on a one-minute raffle. This is the
   * precise path; the sweep stays as the backstop that covers a restart.
   */
  armRaffleTimer(): void {
    if (this.raffleTimer) {
      clearTimeout(this.raffleTimer);
      this.raffleTimer = null;
    }
    const db = this.db();
    if (!db) return;
    let open;
    try {
      open = openRaffle(db);
    } catch {
      return; // the sweep will cope
    }
    if (!open) return;
    const wait = Math.max(0, open.closes_at - this.now()) + 250;
    this.raffleTimer = setTimeout(() => {
      this.raffleTimer = null;
      this.sweepRaffles();
    }, wait);
    this.raffleTimer.unref();
  }

  /**
   * Draw every raffle whose time is up. Runs on a timer and before each raffle
   * command, so a raffle still resolves if nobody types anything again, and one
   * that closed while the bot was down is drawn on the next start. Never throws.
   */
  sweepRaffles(): number {
    const db = this.db();
    if (!db) return 0;
    try {
      let drawn = 0;
      for (const r of dueRaffles(db, this.now())) if (this.drawRaffleNow(r) !== null) drawn++;
      return drawn;
    } catch (err) {
      reportDbError(this.channel, err);
      console.error(`[POINTS] Raffle sweep failed for ${this.channel}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
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
    // Held a moment: a gifted sub's recipient gets this event too, and only the gifter earns the bite.
    this.guard('sub big bite', () => this.rewardBite('onSub', e?.subscriber, 'the sub', `sub:${meta.messageId ?? `${e?.subscriber?.user_id}:${e?.created_at}`}`, bigBite.SUB_HOLD_MS));
    return this.guard('sub bonus', () => bonuses.onSubscription(this.bonusContext(), 'new', e, meta));
  }

  onSubscriptionRenewal(e: SubscriptionEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    this.guard('resub big bite', () => this.rewardBite('onSub', e?.subscriber, 'the resub', `resub:${meta.messageId ?? `${e?.subscriber?.user_id}:${e?.created_at}`}`));
    return this.guard('resub bonus', () => bonuses.onSubscription(this.bonusContext(), 'renewal', e, meta));
  }

  onSubscriptionGifts(e: SubscriptionGiftsEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    this.guard('gift big bite', () => {
      const giftees = (Array.isArray(e?.giftees) ? e.giftees : []).flatMap(g => (typeof g?.user_id === 'number' ? [g.user_id] : []));
      // The recipients' own sub events don't earn a bite.
      bigBite.dropRewardBites(this.channel, giftees);
      if (e?.gifter && !e.gifter.is_anonymous && giftees.length) {
        this.rewardBite('onGift', e.gifter, `the ${giftees.length} gifted ${giftees.length === 1 ? 'sub' : 'subs'}`, `gifts:${meta.messageId ?? `${e.gifter.user_id}:${e.created_at}:${giftees.join(',')}`}`);
      }
    });
    return this.guard('gifted sub bonus', () => bonuses.onGifts(this.bonusContext(), e, meta));
  }

  onKicksGifted(e: KicksGiftedEvent, meta: QueueMeta): bonuses.BonusOutcome | undefined {
    this.guard('Kicks big bite', () => {
      const amount = Number(e?.gift?.amount);
      const min = this.config().games.bigBite.kicksMin;
      if (min > 0 && Number.isFinite(amount) && amount >= min) {
        this.rewardBite('kicks', e?.sender, `the ${amount.toLocaleString('en-US')} Kicks`, `kicks:${meta.messageId ?? `${e?.sender?.user_id}:${e?.created_at}:${amount}`}`);
      }
    });
    return this.guard('Kicks bonus', () => bonuses.onKicks(this.bonusContext(), e, meta));
  }

  /**
   * A big bite for a viewer who paid the channel (games.bigBite.onSub, onGift, kicksMin): queued
   * while live with fishing and big bites on, then started at once if nothing's on a line.
   * Never for the streamer, a bot or an excluded account.
   */
  private rewardBite(kind: 'onSub' | 'onGift' | 'kicks', who: { user_id: number | null; username: string } | null | undefined, why: string, eventKey: string, holdMs = 0): void {
    const cfg = this.config();
    const bb = cfg.games.bigBite;
    if (!cfg.enabled || !cfg.games.enabled || !bb.enabled || this.lastLive !== true) return;
    if (kind !== 'kicks' && !bb[kind]) return;
    if (!who || typeof who.user_id !== 'number' || !who.username) return;
    const ex = this.exclusions();
    if (!bigBite.canBite({ channel: this.channel, excluded: (id, name) => isExcluded(ex, id, name) }, who.user_id, who.username)) return;
    if (!bigBite.queueRewardBite(this.channel, { name: who.username, userId: who.user_id }, why, eventKey, this.now(), holdMs)) return;
    const go = () => void this.bigBiteTick();
    if (holdMs > 0) setTimeout(go, holdMs + 500).unref?.();
    else go();
  }

  /** A hint only: the tick's own live check decides whether anyone earns. */
  onLivestreamStatus(e: LivestreamStatusEvent, meta: QueueMeta): void {
    this.guard('livestream status', () => {
      if (meta.ageMs !== null && meta.ageMs > STATUS_MAX_AGE_MS) return;
      this.setLive(e?.is_live === true, 'webhook');
      console.log(`[POINTS] ${this.channel} is ${this.lastLive ? 'live' : 'offline'} (webhook)`);
      const db = this.db();
      if (!db) return;
      const started = e?.started_at ? Date.parse(e.started_at) : NaN;
      runWrite(db, () => setMetaTx(db, 'live_since', this.lastLive ? String(Number.isFinite(started) ? started : this.now()) : null));
      // Guards stand still while live with stealing closed; the webhook starts or ends that straight away.
      syncGuardPause(db, this.config().games, this.lastLive === true, this.now(), Number.isFinite(started) ? started : null);
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
        this.duelTimer = setInterval(() => { this.sweepDuels(); this.sweepRaffles(); }, 15_000);
        this.duelTimer.unref();
      }
      if (!this.biteTimer) {
        this.biteTimer = setInterval(() => { void this.bigBiteTick(); }, bigBite.TICK_MS);
        this.biteTimer.unref();
      }
      if (!this.spamBoardTimer) {
        this.spamBoardTimer = setInterval(() => { this.spamBoardTick(); }, antispam.BOARD_EVERY_MS);
        this.spamBoardTimer.unref();
      }
      // A raffle still open from before a restart draws at its own time, not up to a sweep late.
      this.armRaffleTimer();
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

  /** Every ten minutes: the spam penalty's top five in chat. Returns the line sent, if any. */
  spamBoardTick(): string | null {
    return this.guard('spam board', () => antispam.announceBoard(this.bonusContext())) ?? null;
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
    if (this.biteTimer) {
      clearInterval(this.biteTimer);
      this.biteTimer = null;
    }
    if (this.spamBoardTimer) {
      clearInterval(this.spamBoardTimer);
      this.spamBoardTimer = null;
    }
    if (this.raffleTimer) {
      clearTimeout(this.raffleTimer);
      this.raffleTimer = null;
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
