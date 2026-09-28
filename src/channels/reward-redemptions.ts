/**
 * Channel-points reward redemptions → moderation actions.
 *
 * Kick delivers `channel.reward.redemption.updated` webhooks to the enrollment
 * service, which queues them per channel; WebhookPoller hands them here.
 *
 * Actions: `timeout` the user named in the redemption, `roulette` (50/50 the
 * named user or the redeemer), `pardon` a timeout the bot gave out, and
 * `shield` the redeemer from other viewers' timeout rewards, and `points` to
 * sell the channel's loyalty currency for channel points. The moderation
 * itself — who may be targeted, which token issues it, what's shielded — is
 * ChannelModerator's.
 *
 * Everything is driven by `rewardActions` in the channel config, so a channel
 * with no such entry never does anything.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ChannelConfig, RewardAction, RewardRedemptionEvent } from '../types';
import TelegramNotifier = require('../telegram-notifier');
import { ChannelModerator, formatDuration } from './moderation';

const API = 'https://api.kick.com/public/v1';

/** Redemption ids already acted on. The webhook re-fires on every status change. */
const SEEN_LIMIT = 500;

/**
 * A timeout or roulette only lands on someone who chatted this recently.
 *
 * On 2026-09-11 viewers aimed "Timeout someone" at a troll called BetterCaIISauI
 * (capital I's) but typed BetterCallSaul. That is a real, different account that
 * wasn't in chat, so it got muted while the troll kept chatting and mocked them
 * for 25,000 wasted points. A name that hasn't chatted is now refunded instead.
 */
const RECENT_CHAT_WINDOW_MS = 30 * 60 * 1000;
/** How much of the channel log to scan for recent chat. 30 minutes of a busy chat is a few hundred KB. */
const CHAT_LOG_TAIL_BYTES = 4 * 1024 * 1024;

/**
 * How often to check Kick for redemptions whose webhook never arrived.
 *
 * On 2026-09-12 Cyturn's "Timeout someone 120 seconds" sat pending for an hour:
 * follows and chat either side of it were delivered, that one redemption never
 * was, so the bot neither timed anyone out nor refunded, and 10,000 points were
 * stuck until it was rejected by hand.
 */
const RECONCILE_MS = 2 * 60 * 1000;
/** Past this age a missed redemption is refunded instead of carried out — the moment has passed. */
const RECONCILE_ACT_MAX_MS = 10 * 60 * 1000;
/** Redeemer names resolved by id, so a busy queue doesn't re-ask Kick for each one. */
const NAME_CACHE_LIMIT = 500;

/**
 * Rewards the bot acts on are paused on Kick while the channel is offline, so
 * viewers can't spend points on a timeout nobody will see (user, 2026-09-12).
 * Only rewards this bot paused are resumed; one the streamer paused by hand
 * stays paused.
 */
const PAUSE_STATE_DIR = 'reward-pause';

/**
 * Decisions made but not yet confirmed on Kick, per channel. On 2026-09-27 a
 * rush on "Buy 10,000 $DON" hit Kick's rate limit: 44 accepts failed, those paid
 * redemptions stayed pending, and after a restart the backstop took them for
 * undelivered ones and refunded 16 that had already been paid. A decision is now
 * written here before Kick is told, and the backstop retries it instead of
 * deciding again.
 */
const RESOLUTION_DIR = 'reward-resolutions';
/** Per channel: redemptions counted in the current stream window, and rewards paused for hitting maxPerStream. */
const LIMIT_DIR = 'reward-limits';
interface LimitState { key: string; counts: Record<string, number>; pausedForLimit: string[] }
/** A decision Kick still hasn't taken after this long is dropped; the redemption is someone's to resolve by hand. */
const RESOLUTION_KEEP_MS = 7 * 24 * 3_600_000;
/** Space between accept/reject calls, and retries when Kick answers 429. */
const RESOLVE_SPACING_MS = 400;
/** Kick's most ids per accept/reject request. */
const RESOLVE_BATCH = 25;
const RESOLVE_RETRY_MS = [1_500, 3_000, 6_000];
/** Pages of Kick's pending list the backstop reads per pass (25 per page). */
const RECONCILE_MAX_PAGES = 10;
/** Re-read Kick's reward list this often even when the live state hasn't changed, to catch drift. */
const PAUSE_DRIFT_CYCLES = 1;

/** What one redemption did, or why it didn't. A failure is refunded. */
type Outcome =
  /**
   * `quiet` marks an outcome Kick already announces itself — it posts its own
   * "X timed out Y for N minutes" notice — so repeating it puts the same
   * sentence in chat twice. Only set it where the bot adds nothing: a plain
   * timeout that landed on its target. A shield bounce, a roulette result or
   * a failure each explain something Kick's notice does not.
   */
  | { ok: true; announce: string; log: string; quiet?: boolean; purchase?: Purchase }
  | { ok: false; reason: string };

/** A `points` payout, announced as soon as it's paid and merged with the same viewer's others. */
interface Purchase { amount: number; balance: number | null; currency: string }

/**
 * Purchases by one viewer this close together share one chat line, so a rush
 * ("×9") is a message per viewer rather than a flood Kick's chat limit drops.
 */
const PURCHASE_MERGE_MS = 3_000;
/** A viewer who keeps buying still hears back this often. */
const PURCHASE_MERGE_MAX_MS = 10_000;

/** Scopes a reward action cannot work without. */
const REQUIRED_SCOPES = ['moderation:ban', 'channel:rewards:write'];

export interface RewardHandlerDeps {
  channelName: string;
  /** Live config — read through a getter, since token refresh replaces the object. */
  getConfig: () => ChannelConfig;
  /** Streamer-delegated token, for refunds and scope checks. `isChannelToken: false` means none. */
  getToken: () => Promise<{ token: string; isChannelToken: boolean }>;
  /** Issues the timeouts. Shared with custom commands. */
  moderator: ChannelModerator;
  sendMessage: (message: string) => Promise<unknown>;
  /** Whether a `points` redemption was already paid, so it is accepted rather than refunded. */
  alreadyPaid?: (redemptionId: string) => boolean;
  /** Identifies the current stream ("stream:<start>"), or the day when offline. Absent: the UTC day. */
  streamKey?: () => string;
  /** Pays the `points` action. Absent where the bot has no points service. */
  creditPoints?: (a: { userId: number; username: string; amount: number; redemptionId: string; rewardTitle: string }) =>
    { ok: true; balance: number | null; currency: string } | { ok: false; reason: string };
}

export class RewardRedemptionHandler {
  private deps: RewardHandlerDeps;
  private seen: string[] = [];
  /** Pending chat lines for points purchases, by viewer and reward. */
  private purchaseLines = new Map<string, { redeemer: string; title: string; count: number; total: number; balance: number | null; currency: string; firstAt: number; timer: NodeJS.Timeout | null }>();
  /** Redemptions whose accept/reject is queued or in flight, so the backstop doesn't queue it again. */
  private settling = new Set<string>();
  /** Accept/reject calls waiting to go to Kick, sent in batches by pumpResolves. */
  private resolveQueue: Array<{ id: string; accept: boolean; done: (ok: boolean) => void }> = [];
  private resolvePumping = false;
  private started = false;
  private scopeGapNotified = false;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private reconcileErrorNotified = false;
  private reconcileFirstPass = true;
  private nameCache = new Map<number, string>();
  /** Last known live state: null until a webhook or a live check says. */
  private isLive: boolean | null = null;
  private lastSyncedLive: boolean | null = null;
  private syncCycles = 0;
  private syncing = false;

  constructor(deps: RewardHandlerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.preflightScopes();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => {
        this.reconcilePending().catch(err =>
          console.error(`[REWARD] Reconcile failed: ${err instanceof Error ? err.message : String(err)}`));
        this.syncPauseState().catch(err =>
          console.error(`[REWARD] Pause sync failed: ${err instanceof Error ? err.message : String(err)}`));
        this.limitWindow().catch(err =>
          console.error(`[REWARD] Limit window check failed: ${err instanceof Error ? err.message : String(err)}`));
      }, RECONCILE_MS);
      this.reconcileTimer.unref();
    }
  }

  /** Pending unbans belong to the moderator; only the reconcile loop is ours. */
  stop(): void {
    this.started = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  /** Give up a claim whose checks then failed, so a later event for the redemption can still act. */
  private release(redemptionId: string): void {
    const i = this.seen.lastIndexOf(redemptionId);
    if (i !== -1) this.seen.splice(i, 1);
  }

  /**
   * Report a scope gap at startup rather than at redemption time.
   *
   * A channel whose grant predates these scopes looks healthy — chat works,
   * the token refreshes — and the only symptom is redemptions quietly doing
   * nothing. Surface it while there is still time to act on it.
   */
  private async preflightScopes(): Promise<void> {
    const actions = this.currentActions();
    if (!Array.isArray(actions) || actions.length === 0) return;

    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) {
      console.error(`[REWARD] ${this.deps.channelName} has rewardActions but no streamer token — redemptions will be ignored.`);
      return;
    }

    const granted = await this.deps.moderator.grantedScopes(token);
    if (granted.length === 0) return;   // introspection failed; don't cry wolf

    // A live action matched only by title is a loose match: two rewards whose
    // titles both contain the substring resolve to whichever is listed first.
    // Tolerable while testMode contains the blast radius, not in production.
    for (const a of actions) {
      if (!a.rewardId && !a.testMode) {
        console.error(
          `[REWARD] ${this.deps.channelName}: action for title "${a.rewardTitle ?? '(none)'}" is LIVE but has no rewardId. ` +
          `Pin the exact id (node dist/tools/kick-rewards.js ${this.deps.channelName}) — a title substring can match the wrong reward.`
        );
      }
    }

    const missing = REQUIRED_SCOPES.filter(scope => !granted.includes(scope));
    if (missing.length === 0) {
      const pinned = actions.filter(a => a.rewardId).length;
      const asBot = (await this.deps.moderator.issuers()).some(a => a.isBot);
      console.log(
        `[REWARD] ${actions.length} reward action(s) armed and authorized (${pinned} pinned by id). ` +
        (asBot
          ? `Timeouts issued as the bot, falling back to ${this.deps.channelName} where it is not a moderator.`
          : `Timeouts issued as ${this.deps.channelName} — the bot's own token lacks moderation:ban.`)
      );
      return;
    }

    console.error(
      `[REWARD] ${this.deps.channelName} has rewardActions but its grant is missing: ${missing.join(', ')}. ` +
      `Redemptions will be left pending until the streamer re-authorizes.`
    );
    if (!this.scopeGapNotified) {
      this.scopeGapNotified = true;
      await new TelegramNotifier()
        .notifyRewardScopeMissing(this.deps.channelName, missing, granted)
        .catch(() => {});
    }
  }

  /**
   * The channel's reward actions, read from disk so a dashboard edit applies to
   * the very next redemption without restarting the bot. Falls back to the
   * bot's in-memory config when the file is missing, mid-write or unreadable.
   */
  private currentActions(): RewardAction[] {
    try {
      const file = path.join(process.cwd(), 'data', 'channel-configs', `${this.deps.channelName}.json`);
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as ChannelConfig;
      return Array.isArray(onDisk.rewardActions) ? onDisk.rewardActions : [];
    } catch {
      const inMemory = this.deps.getConfig().rewardActions;
      return Array.isArray(inMemory) ? inMemory : [];
    }
  }

  private matchAction(reward: RewardRedemptionEvent['reward']): RewardAction | null {
    const actions = this.currentActions();
    if (!Array.isArray(actions) || actions.length === 0) return null;

    // Reward id is exact and survives a rename, so it wins over the title.
    const byId = actions.find(a => a.rewardId && a.rewardId === reward.id);
    if (byId) return byId;

    const title = (reward.title || '').toLowerCase();
    return actions.find(a => a.rewardTitle && title.includes(a.rewardTitle.toLowerCase())) ?? null;
  }

  async handle(event: RewardRedemptionEvent): Promise<void> {
    if (!event?.id || !event.reward) return;

    // The webhook re-fires on every status change of the same redemption.
    if (this.seen.includes(event.id)) return;

    const action = this.matchAction(event.reward);
    if (!action) return;

    // Only a fresh redemption is actionable. 'rejected' means someone (possibly
    // this bot, moments ago) already refunded it.
    const status = (event.status || '').toLowerCase();
    if (status !== 'pending' && status !== 'accepted') return;

    // Claim it before the first await. Kick sends a follow-up event for the same
    // redemption a second or two later, and claiming only after the checks below
    // let both copies through: a double timeout, or two shields for one purchase.
    this.seen.push(event.id);
    if (this.seen.length > SEEN_LIMIT) this.seen.shift();

    // If the channel can't authorize a ban there is nothing useful to do: stay
    // silent and leave the redemption pending so the streamer can resolve it by
    // hand. Announcing a failure and a refund we can't perform is worse than doing
    // nothing. The claim is released so a later event can still act once fixed.
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) {
      console.error(`[REWARD] "${event.reward.title}" ignored — no streamer token. Channel must re-authorize.`);
      this.release(event.id);
      return;
    }
    const scopes = await this.deps.moderator.grantedScopes(token);
    // Paying out currency needs no moderation rights; everything else is a timeout or lifts one.
    if (action.action !== 'points' && (await this.deps.moderator.issuers()).length === 0) {
      console.error(
        `[REWARD] "${event.reward.title}" ignored — neither the bot nor ${this.deps.channelName}'s token carries moderation:ban ` +
        `(channel granted: ${scopes.join(' ') || 'none'}). Redemption left pending; channel must re-authorize.`
      );
      this.release(event.id);
      return;
    }

    // A redemption that arrives already accepted skipped the request queue —
    // there is no queue entry left to resolve, so accept/reject is a no-op.
    // Refunding also needs the rewards scope, which is granted separately.
    const canResolve = status === 'pending' && (scopes.length === 0 || scopes.includes('channel:rewards:write'));
    const redeemer = event.redeemer?.username || 'someone';

    const fail = async (reason: string): Promise<void> => {
      console.log(`[REWARD] "${event.reward.title}" by ${redeemer} failed: ${reason}`);
      // Only promise a refund that actually went through.
      const refunded = canResolve ? await this.settle(event.id, false) : false;
      if (action.announce !== false) {
        const suffix = refunded ? ' — your points have been refunded.' : '.';
        await this.deps.sendMessage(`@${redeemer} ${reason}${suffix}`).catch(() => {});
      }
    };

    // Paused-while-offline rewards are unpaused on Kick a moment after the stream
    // starts and paused again after it ends, so a redemption can still land in the
    // gap. Acting on it would time someone out for an empty channel.
    const availability = availabilityOf(action);
    // Redeemable when it shouldn't be (a save unpaused it, or the stream just changed):
    // refund it and close the reward on Kick now rather than at the next sync.
    if (this.isLive === false && availability === 'live') {
      if (action.rewardId) void this.closeNow(action.rewardId, event.reward.title);
      await fail(`that reward is paused while ${this.deps.channelName} is offline`);
      return;
    }
    if (this.isLive === true && availability === 'offline') {
      if (action.rewardId) void this.closeNow(action.rewardId, event.reward.title);
      await fail(`that reward is only available while ${this.deps.channelName} is offline`);
      return;
    }

    // Trial run: shortened, refunded, and optionally limited to named testers
    // so a reward that has never fired in production can't catch real viewers.
    const isTest = action.testMode === true;
    const testers = (action.testRedeemers ?? []).map(n => n.toLowerCase());
    if (isTest && testers.length > 0 && !testers.includes(redeemer.toLowerCase())) {
      console.log(`[REWARD] "${event.reward.title}" by ${redeemer} skipped — test mode limited to: ${testers.join(', ')}`);
      const refunded = canResolve ? await this.settle(event.id, false) : false;
      if (action.announce !== false) {
        await this.deps.sendMessage(
          `@${redeemer} this reward is being tested right now, so nobody was timed out` +
          (refunded ? ' — your points have been refunded.' : '.')
        ).catch(() => {});
      }
      return;
    }

    // A points redemption paid before (a redelivery after a restart) is only accepted,
    // and must not count against the limit a second time.
    if (action.action === 'points' && this.deps.alreadyPaid?.(event.id)) {
      if (canResolve) await this.settle(event.id, true);
      return;
    }

    // Per-stream limit. Counted before acting, so a burst can't all squeeze in.
    const limit = action.rewardId && (action.maxPerStream ?? 0) > 0 && !isTest ? action.maxPerStream! : 0;
    if (limit > 0) {
      await this.limitWindow();
      // Re-read with no await before the save, so two redemptions at once can't both take the last slot.
      const state = this.loadLimitState();
      const used = state.counts[action.rewardId!] ?? 0;
      if (used >= limit) {
        void this.pauseForLimit(action.rewardId!, event.reward.title, false);
        return fail(`"${event.reward.title}" has sold out for this stream (${limit} max)`);
      }
      state.counts[action.rewardId!] = used + 1;
      this.saveLimitState(state);
    }

    const outcome = await this.perform(action, event, redeemer, isTest);
    if (!outcome.ok) {
      if (limit > 0) {
        const state = this.loadLimitState();
        state.counts[action.rewardId!] = Math.max(0, (state.counts[action.rewardId!] ?? 1) - 1);
        this.saveLimitState(state);
      }
      return fail(outcome.reason);
    }
    if (limit > 0 && (this.loadLimitState().counts[action.rewardId!] ?? 0) >= limit) {
      void this.pauseForLimit(action.rewardId!, event.reward.title, action.announce !== false);
    }

    console.log(`[REWARD]${isTest ? ' [TEST]' : ''} ${outcome.log} via "${event.reward.title}"`);

    // A purchase is final once paid, so say so now rather than after Kick's queue.
    const purchaseAnnounced = !!outcome.purchase && !isTest && action.announce !== false;
    if (purchaseAnnounced) this.announcePurchase(redeemer, event.reward.title, outcome.purchase!);

    // A test run rejects rather than accepts, which is what refunds the points.
    const resolved = canResolve ? await this.settle(event.id, !isTest) : false;
    if (purchaseAnnounced) return;

    // A test still speaks up even when quiet: its line carries the refund result,
    // which Kick's own notice says nothing about.
    if (action.announce !== false && !(outcome.quiet && !isTest)) {
      const lead = `@${redeemer} ${isTest ? 'TEST — ' : `redeemed "${event.reward.title}" — `}`;
      const tail = isTest
        ? (resolved ? ', points refunded.' : ', but the refund failed — resolve it manually.')
        : '.';
      await this.deps.sendMessage(lead + outcome.announce + tail).catch(() => {});
    }
  }

  /** Carry out one redemption. The caller refunds a failure and announces a success. */
  private async perform(action: RewardAction, event: RewardRedemptionEvent, redeemer: string, isTest: boolean): Promise<Outcome> {
    const { moderator } = this.deps;
    const reason = `${event.reward.title} redeemed by ${redeemer}`;
    const seconds = (isTest ? (action.testDurationSeconds ?? 5) : action.durationSeconds) ?? 0;
    if (action.action !== 'pardon' && action.action !== 'points' && !(seconds > 0)) {
      console.error(`[REWARD] "${event.reward.title}" is a ${action.action} action with no durationSeconds — fix the channel config.`);
      return { ok: false, reason: 'this reward is not set up correctly' };
    }

    switch (action.action) {
      case 'timeout': {
        const target = parseTargetUsername(event.user_input);
        if (!target) return { ok: false, reason: 'I could not read a username in that redemption' };

        const blocked = moderator.protectionReason(target, redeemer);
        if (blocked) return { ok: false, reason: `${target} cannot be timed out (${blocked})` };
        // Checked before the shield: an absent name must not bounce a timeout back onto the redeemer.
        if (!sameUser(target, redeemer) && (await chattedRecently(this.deps.channelName, target)) === false) {
          return { ok: false, reason: absentReason(target) };
        }
        const shield = sameUser(target, redeemer) ? null : moderator.shieldOf(target);
        if (shield && !shield.reflect) return { ok: false, reason: `${target} is shielded` };

        const result = await moderator.timeout({ target: shield ? redeemer : target, seconds, invoker: redeemer, reason });
        if (!result.ok) return { ok: false, reason: result.error };
        const dur = formatDuration(result.seconds);
        return shield
          ? {
              ok: true,
              announce: `${target}'s shield bounced it back, so you're timed out for ${dur}`,
              log: `${redeemer}'s timeout on ${target} bounced off a shield — ${redeemer} timed out for ${result.seconds}s (as ${result.actor})`
            }
          : {
              ok: true,
              quiet: true,
              announce: `${result.target} is timed out for ${dur}`,
              log: `${redeemer} timed out ${result.target} for ${result.seconds}s (as ${result.actor})`
            };
      }

      case 'roulette': {
        const target = parseTargetUsername(event.user_input);
        if (!target) return { ok: false, reason: 'I could not read a username in that redemption' };

        // Settle everything that could void the spin BEFORE rolling, so a typo or a
        // protected name is refunded rather than becoming a coin flip on the redeemer.
        // That includes the redeemer: Kick won't time out a moderator, so a mod's
        // backfire would fail and refund, a spin they could never lose.
        const immune = moderator.protectionReason(redeemer, '');
        if (immune) {
          const who = immune === 'broadcaster' ? 'the streamer' : immune;
          return { ok: false, reason: `you're ${who}, so a backfire can't time you out. No free spins` };
        }
        const blocked = moderator.protectionReason(target, redeemer);
        if (blocked) return { ok: false, reason: `${target} cannot be timed out (${blocked})` };
        // Before the spin, so an absent name is refunded rather than a coin flip on the redeemer.
        if (!sameUser(target, redeemer) && (await chattedRecently(this.deps.channelName, target)) === false) {
          return { ok: false, reason: absentReason(target) };
        }
        if (!(await moderator.lookupUser(target))) {
          return { ok: false, reason: `I could not find a Kick user called "${target}"` };
        }
        const shield = sameUser(target, redeemer) ? null : moderator.shieldOf(target);
        if (shield && !shield.reflect) return { ok: false, reason: `${target} is shielded` };

        const backfired = shield !== null || Math.random() < 0.5;
        console.log(`[REWARD] ${redeemer}'s roulette on ${target}: ${shield ? 'bounced off a shield' : backfired ? 'backfired' : 'landed'}`);
        const result = await moderator.timeout({ target: backfired ? redeemer : target, seconds, invoker: redeemer, reason });
        if (!result.ok) return { ok: false, reason: result.error };
        const dur = formatDuration(result.seconds);
        if (shield) {
          return {
            ok: true,
            announce: `${target}'s shield bounced the roulette back, so you're timed out for ${dur}`,
            log: `${redeemer}'s roulette on ${target} bounced off a shield — ${redeemer} timed out for ${result.seconds}s (as ${result.actor})`
          };
        }
        return backfired
          ? {
              ok: true,
              announce: `the roulette on ${target} backfired, so you're timed out for ${dur}`,
              log: `${redeemer}'s roulette on ${target} backfired — ${redeemer} timed out for ${result.seconds}s (as ${result.actor})`
            }
          : {
              ok: true,
              announce: `the roulette landed on ${result.target}, timed out for ${dur}`,
              log: `${redeemer}'s roulette landed on ${result.target} — timed out for ${result.seconds}s (as ${result.actor})`
            };
      }

      case 'pardon': {
        // No name means "get me out". A name that can't be read is an error, not a self-pardon.
        const input = (event.user_input ?? '').trim();
        const target = input ? parseTargetUsername(input) : redeemer;
        if (!target) return { ok: false, reason: 'I could not read a username in that redemption' };

        const result = await moderator.pardon(target);
        if (!result.ok) return { ok: false, reason: result.error };
        return {
          ok: true,
          announce: sameUser(result.target, redeemer) ? 'your timeout is lifted' : `${result.target} is out of timeout`,
          log: `${redeemer} pardoned ${result.target}`
        };
      }

      case 'shield': {
        const shield = moderator.grantShield(redeemer, seconds, action.reflect === true);
        const left = formatDuration(Math.round((shield.expiresAt - Date.now()) / 1000));
        return {
          ok: true,
          announce: `you're shielded from timeout rewards for ${left}` +
            (shield.reflect ? ', and any aimed at you bounce back' : ''),
          log: `${redeemer} is shielded for ${left}${shield.reflect ? ' (reflect)' : ''}`
        };
      }

      case 'points': {
        const amount = action.amount ?? 0;
        if (!Number.isInteger(amount) || amount < 1 || !this.deps.creditPoints) {
          console.error(`[REWARD] "${event.reward.title}" is a points action with no amount — fix the channel config.`);
          return { ok: false, reason: 'this reward is not set up correctly' };
        }
        const shown = amount.toLocaleString('en-US');
        // A test run is refunded, so paying out too would make it free money.
        if (isTest) return { ok: true, announce: `you would get ${shown}`, log: `${redeemer} would get ${shown} (test)` };
        const paid = this.deps.creditPoints({
          userId: event.redeemer.user_id, username: redeemer, amount, redemptionId: event.id, rewardTitle: event.reward.title
        });
        if (!paid.ok) return { ok: false, reason: paid.reason };
        const now = paid.balance === null ? '' : `, you now have ${paid.balance.toLocaleString('en-US')} ${paid.currency}`;
        return {
          ok: true,
          purchase: { amount, balance: paid.balance, currency: paid.currency },
          announce: `you got ${shown} ${paid.currency}${now}`,
          log: `${redeemer} bought ${amount} ${paid.currency}${paid.balance === null ? ' (already paid)' : ''}`
        };
      }

      default: {
        const unknown = (action as { action?: unknown }).action;
        console.error(`[REWARD] "${event.reward.title}" has unknown action "${String(unknown)}" — fix the channel config.`);
        return { ok: false, reason: 'this reward is not set up correctly' };
      }
    }
  }

  /**
   * Handle redemptions Kick never sent a webhook for.
   *
   * Kick's pending queue is the backstop: anything matching a configured action
   * that this process has not already seen is carried out when it is still
   * recent, and refunded when it is not. Redemptions for rewards with no action
   * are left alone — they are the streamer's to resolve.
   */
  private async reconcilePending(): Promise<void> {
    if (this.reconciling || !this.started) return;
    if (this.currentActions().length === 0) return;
    this.reconciling = true;
    try {
      const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
      if (!isChannelToken || !token) return;

      let pending: PendingRedemption[] = [];
      try {
        let cursor: string | null = null;
        for (let page = 0; page < RECONCILE_MAX_PAGES; page++) {
          const res: { data: unknown } = await axios.get(`${API}/channels/rewards/redemptions`, {
            headers: { Authorization: `Bearer ${token}` },
            params: cursor ? { status: 'pending', cursor } : { status: 'pending' },
            timeout: 15_000
          });
          pending.push(...pendingRedemptionsFromApi(res.data));
          // Kick pages 25 at a time; reading only the first left the rest for ever.
          const next: string | null = (res.data as { pagination?: { next_cursor?: string } } | null)?.pagination?.next_cursor || null;
          if (!next || next === cursor) break;
          cursor = next;
        }
        this.reconcileErrorNotified = false;
        if (this.reconcileFirstPass) {
          // Success is otherwise silent, so there is no way to tell a healthy
          // backstop from one that never ran. Say so once per start.
          this.reconcileFirstPass = false;
          console.log(`[REWARD] Reconcile: watching Kick's pending queue for ${this.deps.channelName} (${pending.length} pending now).`);
        }
      } catch (err) {
        // Every two minutes forever: say it once, then again only after a success.
        if (!this.reconcileErrorNotified) {
          this.reconcileErrorNotified = true;
          const detail = axios.isAxiosError(err)
            ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
            : (err instanceof Error ? err.message : String(err));
          console.error(`[REWARD] Could not list ${this.deps.channelName}'s pending redemptions: ${detail}`);
        }
        return;
      }

      const decisions = this.loadResolutions();
      for (const row of pending) {
        // Decided before but Kick never took it: tell Kick again, never decide twice.
        const decided = decisions[row.id];
        // Already waiting in the accept queue: a second call would only lengthen it.
        if (decided && this.settling.has(row.id)) continue;
        if (decided) {
          const ok = await this.settle(row.id, decided.accept);
          console.log(`[REWARD] Reconcile: "${row.rewardTitle}" was already ${decided.accept ? 'accepted' : 'refunded'} by the bot — ${ok ? 'Kick has it now' : 'Kick still refused, will retry'}.`);
          continue;
        }
        if (this.seen.includes(row.id)) continue;
        const action = this.matchAction({ id: row.rewardId, title: row.rewardTitle });
        if (!action) continue;

        // Paid already (the accept was lost): accept it. Refunding would pay twice.
        if (action.action === 'points' && this.deps.alreadyPaid?.(row.id)) {
          this.seen.push(row.id);
          if (this.seen.length > SEEN_LIMIT) this.seen.shift();
          const ok = await this.settle(row.id, true);
          console.log(`[REWARD] Reconcile: "${row.rewardTitle}" (${row.id}) was already paid — ${ok ? 'accepted' : 'accept failed, will retry'}.`);
          continue;
        }

        const username = await this.usernameFor(row.redeemerId, token);
        // Paying out late is harmless, unlike a late timeout, so a points reward is never too old.
        if (action.action === 'points' || pendingVerdict(row.redeemedAt, Date.now(), RECONCILE_ACT_MAX_MS) === 'act') {
          // Acting on "someone" would aim a shield or a roulette backfire at nobody;
          // leave it pending and try again on the next pass instead.
          if (!username) continue;
          console.log(`[REWARD] Reconcile: "${row.rewardTitle}" by ${username} arrived with no webhook — handling it now.`);
          await this.handle({
            id: row.id,
            user_input: row.userInput,
            status: 'pending',
            redeemed_at: row.redeemedAt ?? undefined,
            reward: { id: row.rewardId, title: row.rewardTitle, cost: row.rewardCost },
            redeemer: { user_id: row.redeemerId, username },
            // Never read by the handler; the real webhook carries the channel here.
            broadcaster: { user_id: 0, username: this.deps.channelName }
          });
          continue;
        }

        this.seen.push(row.id);
        if (this.seen.length > SEEN_LIMIT) this.seen.shift();
        const refunded = await this.settle(row.id, false);
        console.log(
          `[REWARD] Reconcile: "${row.rewardTitle}" by ${username ?? row.redeemerId} was never delivered and is too old to act on ` +
          `(redeemed ${row.redeemedAt ?? 'at an unknown time'}) — ${refunded ? 'points refunded' : 'REFUND FAILED, resolve it by hand'}.`
        );
        if (!refunded) {
          this.release(row.id);
        } else if (username && action.announce !== false) {
          await this.deps.sendMessage(
            `@${username} your "${row.rewardTitle}" never reached the bot, so nobody was timed out — your points have been refunded.`
          ).catch(() => {});
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  /** Told by the livestream webhook; also refreshed from Kick on each sync. */
  setLive(isLive: boolean): void {
    if (this.isLive === isLive) return;
    this.isLive = isLive;
    this.syncPauseState().catch(err =>
      console.error(`[REWARD] Pause sync failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private pauseStatePath(): string {
    return path.join(process.cwd(), 'data', PAUSE_STATE_DIR, `${this.deps.channelName}.json`);
  }

  private loadPausedByBot(): string[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.pauseStatePath(), 'utf8')) as { pausedByBot?: unknown };
      return Array.isArray(raw.pausedByBot) ? raw.pausedByBot.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  private savePausedByBot(ids: string[]): void {
    try {
      const file = this.pauseStatePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ pausedByBot: ids }, null, 2));
    } catch (err) {
      console.error(`[REWARD] Could not save the paused-reward list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Kick's own view of whether the channel is live, for restarts and missed webhooks. */
  private async liveFromApi(token: string): Promise<boolean | null> {
    try {
      const res = await axios.get(`${API}/channels`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { slug: this.deps.channelName },
        timeout: 15_000
      });
      const rows = (res.data as { data?: Array<{ stream?: { is_live?: unknown } | null }> })?.data ?? [];
      const isLive = rows[0]?.stream?.is_live;
      return typeof isLive === 'boolean' ? isLive : null;
    } catch {
      return null;
    }
  }

  /**
   * Pause the configured rewards while the channel is offline and resume them
   * when it is live again. Rewards the streamer paused are never resumed here:
   * only ids this bot paused, recorded on disk, are undone.
   */
  private async syncPauseState(): Promise<void> {
    if (this.syncing || !this.started) return;
    const targets = availabilityTargets(this.currentActions());
    if (targets.length === 0) return;
    this.syncing = true;
    try {
      const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
      if (!isChannelToken || !token) return;

      const live = await this.liveFromApi(token);
      if (live !== null) this.isLive = live;
      if (this.isLive === null) return;

      // Kick's list is only re-read when the state changed, or occasionally to catch drift.
      this.syncCycles++;
      const drift = this.syncCycles % PAUSE_DRIFT_CYCLES === 0;
      if (this.isLive === this.lastSyncedLive && !drift) return;

      const res = await axios.get(`${API}/channels/rewards`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000
      });
      const rewards = rewardsFromApi(res.data);
      const pausedByBot = this.loadPausedByBot();
      const { toPause, toResume } = pauseDecisions({ targets, rewards, pausedByBot, isLive: this.isLive });

      let state = pausedByBot.slice();
      for (const id of toPause) {
        if (await this.setPaused(token, id, true)) {
          if (!state.includes(id)) state.push(id);
          console.log(`[REWARD] Paused "${titleOf(rewards, id)}" — ${this.deps.channelName} is ${this.isLive ? 'live' : 'offline'}.`);
        }
      }
      for (const id of toResume) {
        if (await this.setPaused(token, id, false)) {
          state = state.filter(x => x !== id);
          console.log(`[REWARD] Resumed "${titleOf(rewards, id)}" — ${this.deps.channelName} is ${this.isLive ? 'live' : 'offline'}.`);
        }
      }
      if (state.length !== pausedByBot.length || state.some((x, i) => x !== pausedByBot[i])) this.savePausedByBot(state);
      this.lastSyncedLive = this.isLive;
    } finally {
      this.syncing = false;
    }
  }

  /** Pause a reward that should be closed right now, and remember to reopen it later. */
  private async closeNow(rewardId: string, title: string): Promise<void> {
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) return;
    if (await this.setPaused(token, rewardId, true)) {
      const paused = this.loadPausedByBot();
      if (!paused.includes(rewardId)) this.savePausedByBot([...paused, rewardId]);
      console.log(`[REWARD] Paused "${title}" — it was redeemable while it should be closed.`);
    }
  }

  private async setPaused(token: string, rewardId: string, paused: boolean): Promise<boolean> {
    try {
      await axios.patch(`${API}/channels/rewards/${rewardId}`, { is_paused: paused }, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15_000
      });
      return true;
    } catch (err) {
      const detail = axios.isAxiosError(err)
        ? `${err.response?.status ?? ''} ${JSON.stringify(err.response?.data ?? err.message)}`
        : (err instanceof Error ? err.message : String(err));
      console.error(`[REWARD] Could not ${paused ? 'pause' : 'resume'} reward ${rewardId}: ${detail}`);
      return false;
    }
  }

  /** Kick's pending list carries the redeemer's id but no name, and the handler needs the name. */
  private async usernameFor(userId: number, token: string): Promise<string | null> {
    if (!userId) return null;
    const cached = this.nameCache.get(userId);
    if (cached) return cached;
    try {
      const res = await axios.get(`${API}/users`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { id: userId },
        timeout: 15_000
      });
      const rows = (res.data as { data?: Array<Record<string, unknown>> })?.data ?? [];
      const first = rows[0] ?? {};
      const name = typeof first['name'] === 'string' && first['name']
        ? first['name']
        : (typeof first['username'] === 'string' ? first['username'] : '');
      if (!name) return null;
      this.nameCache.set(userId, name);
      if (this.nameCache.size > NAME_CACHE_LIMIT) {
        const oldest = this.nameCache.keys().next().value;
        if (oldest !== undefined) this.nameCache.delete(oldest);
      }
      return name;
    } catch {
      return null;
    }
  }

  /** Accept (fulfil) or reject (refund) the queued redemption. Returns success. */
  private limitPath(): string {
    return path.join(process.cwd(), 'data', LIMIT_DIR, `${this.deps.channelName}.json`);
  }

  private currentWindowKey(): string {
    try {
      const key = this.deps.streamKey?.();
      if (key) return key;
    } catch {
      // Fall back to the day below.
    }
    return `day:${new Date().toISOString().slice(0, 10)}`;
  }

  private loadLimitState(): LimitState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.limitPath(), 'utf8')) as Partial<LimitState>;
      return {
        key: typeof raw.key === 'string' ? raw.key : '',
        counts: raw.counts && typeof raw.counts === 'object' ? raw.counts : {},
        pausedForLimit: Array.isArray(raw.pausedForLimit) ? raw.pausedForLimit.filter((x): x is string => typeof x === 'string') : []
      };
    } catch {
      return { key: '', counts: {}, pausedForLimit: [] };
    }
  }

  private saveLimitState(state: LimitState): void {
    try {
      const file = this.limitPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[REWARD] Could not save redemption counts: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * The counts for the current window. When a new stream (or offline day) has
   * begun, they start from zero and rewards paused for their limit are unpaused.
   */
  private async limitWindow(): Promise<LimitState> {
    const key = this.currentWindowKey();
    const state = this.loadLimitState();
    if (state.key === key) return state;
    const reopen = state.pausedForLimit;
    const fresh: LimitState = { key, counts: {}, pausedForLimit: [] };
    this.saveLimitState(fresh);
    if (reopen.length === 0) return fresh;
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) return fresh;
    const actions = this.currentActions();
    const handOver: string[] = [];
    for (const id of reopen) {
      // Offline, a reward that pauses while offline stays paused; the offline
      // pausing takes it over and resumes it when the stream starts.
      const a = actions.find(x => x.rewardId === id);
      if (a && this.isLive !== null && !openNow(availabilityOf(a), this.isLive)) {
        handOver.push(id);
        continue;
      }
      if (await this.setPaused(token, id, false)) console.log(`[REWARD] Reopened reward ${id} — a new stream window began (${key}).`);
    }
    if (handOver.length) {
      const paused = this.loadPausedByBot();
      this.savePausedByBot([...new Set([...paused, ...handOver])]);
    }
    return fresh;
  }

  /** Pause a reward on Kick because it reached its limit, remembering it so the next window reopens it. */
  private async pauseForLimit(rewardId: string, title: string, announce: boolean): Promise<void> {
    const state = this.loadLimitState();
    if (state.pausedForLimit.includes(rewardId)) return;
    state.pausedForLimit.push(rewardId);
    this.saveLimitState(state);
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) return;
    if (await this.setPaused(token, rewardId, true)) {
      console.log(`[REWARD] Paused "${title}" — it reached its limit for this stream.`);
      if (announce) await this.deps.sendMessage(`"${title}" has sold out for this stream.`).catch(() => {});
    }
  }

  private announcePurchase(redeemer: string, title: string, p: Purchase): void {
    const key = `${redeemer.toLowerCase()}|${title}`;
    const line = this.purchaseLines.get(key) ?? { redeemer, title, count: 0, total: 0, balance: null, currency: p.currency, firstAt: Date.now(), timer: null };
    line.count++;
    line.total += p.amount;
    if (p.balance !== null) line.balance = p.balance;
    if (line.timer) clearTimeout(line.timer);
    this.purchaseLines.set(key, line);
    const wait = Date.now() - line.firstAt >= PURCHASE_MERGE_MAX_MS ? 0 : PURCHASE_MERGE_MS;
    line.timer = setTimeout(() => {
      this.purchaseLines.delete(key);
      const times = line.count > 1 ? ` ×${line.count}` : '';
      const now = line.balance === null ? '' : `, you now have ${line.balance.toLocaleString('en-US')} ${line.currency}`;
      void this.deps.sendMessage(
        `@${line.redeemer} redeemed "${line.title}"${times} — you got ${line.total.toLocaleString('en-US')} ${line.currency}${now}.`
      ).catch(() => {});
    }, wait);
  }

  private resolutionPath(): string {
    return path.join(process.cwd(), 'data', RESOLUTION_DIR, `${this.deps.channelName}.json`);
  }

  private loadResolutions(): Record<string, { accept: boolean; at: number }> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.resolutionPath(), 'utf8')) as Record<string, { accept?: unknown; at?: unknown }>;
      const now = Date.now();
      const out: Record<string, { accept: boolean; at: number }> = {};
      for (const [id, v] of Object.entries(raw)) {
        if (typeof v?.accept === 'boolean' && typeof v.at === 'number' && now - v.at < RESOLUTION_KEEP_MS) out[id] = { accept: v.accept, at: v.at };
      }
      return out;
    } catch {
      return {};
    }
  }

  private saveResolutions(all: Record<string, { accept: boolean; at: number }>): void {
    try {
      const file = this.resolutionPath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(all));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.error(`[REWARD] Could not save pending decisions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Accept or refund a redemption on Kick, remembering the decision on disk until
   * Kick has taken it, so a lost call is retried with the same answer.
   */
  private async settle(redemptionId: string, accept: boolean): Promise<boolean> {
    const before = this.loadResolutions();
    before[redemptionId] = { accept, at: before[redemptionId]?.at ?? Date.now() };
    this.saveResolutions(before);
    this.settling.add(redemptionId);
    const ok = await this.resolve(redemptionId, accept).finally(() => this.settling.delete(redemptionId));
    if (ok) {
      const after = this.loadResolutions();
      delete after[redemptionId];
      this.saveResolutions(after);
    }
    return ok;
  }

  /**
   * Accept or reject on Kick. Calls wait in one queue; whatever is waiting with the
   * same answer goes in a single request (Kick takes up to 25 ids), so a rush of
   * 100 redemptions is a handful of calls rather than 100 against the rate limit.
   */
  private resolve(redemptionId: string, accept: boolean): Promise<boolean> {
    return new Promise(done => {
      this.resolveQueue.push({ id: redemptionId, accept, done });
      if (!this.resolvePumping) void this.pumpResolves();
    });
  }

  private async pumpResolves(): Promise<void> {
    this.resolvePumping = true;
    try {
      while (this.resolveQueue.length > 0) {
        const accept = this.resolveQueue[0].accept;
        const batch: typeof this.resolveQueue = [];
        this.resolveQueue = this.resolveQueue.filter(item => {
          if (item.accept !== accept || batch.length >= RESOLVE_BATCH || batch.some(b => b.id === item.id)) return true;
          batch.push(item);
          return false;
        });
        const results = await this.resolveBatch(batch.map(b => b.id), accept);
        for (const b of batch) b.done(results.get(b.id) ?? false);
        await new Promise(r => setTimeout(r, RESOLVE_SPACING_MS));
      }
    } finally {
      this.resolvePumping = false;
    }
  }

  /** One request for up to 25 ids, retried while Kick rate-limits. Returns each id's success. */
  private async resolveBatch(ids: string[], accept: boolean): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>(ids.map(id => [id, false]));
    for (let attempt = 0; ; attempt++) {
      try {
        const { token, isChannelToken } = await this.deps.getToken();
        if (!isChannelToken || !token) return out;
        const res = await axios.post(
          `${API}/channels/rewards/redemptions/${accept ? 'accept' : 'reject'}`,
          { ids },
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );
        // Kick lists only the ids that failed. NOT_PENDING means it was already
        // resolved (a retry after a lost reply), which is what we wanted.
        const failed = new Map<string, string>();
        const rows = (res.data as { data?: unknown } | null)?.data;
        if (Array.isArray(rows)) {
          for (const row of rows as Array<{ id?: unknown; reason?: unknown }>) {
            if (typeof row?.id === 'string') failed.set(row.id, String(row.reason ?? 'UNKNOWN'));
          }
        }
        for (const id of ids) {
          const reason = failed.get(id);
          out.set(id, !reason || reason === 'NOT_PENDING');
          if (reason && reason !== 'NOT_PENDING') {
            console.error(`[REWARD] Kick would not ${accept ? 'accept' : 'reject'} redemption ${id}: ${reason}`);
          }
        }
        return out;
      } catch (err) {
        const limited = axios.isAxiosError(err) && err.response?.status === 429;
        if (limited && attempt < RESOLVE_RETRY_MS.length) {
          await new Promise(r => setTimeout(r, RESOLVE_RETRY_MS[attempt]));
          continue;
        }
        const detail = axios.isAxiosError(err)
          ? JSON.stringify(err.response?.data ?? err.message)
          : (err instanceof Error ? err.message : String(err));
        console.error(`[REWARD] Failed to ${accept ? 'accept' : 'reject'} ${ids.length} redemption(s) (${ids.join(', ')}): ${detail}`);
        return out;
      }
    }
  }
}

/**
 * Pull a username out of the reward's free-text user input.
 *
 * Accepts "victim", "@victim", "@victim please" and "kick.com/victim".
 */
export function parseTargetUsername(userInput: string | undefined): string | null {
  if (typeof userInput !== 'string') return null;
  const first = userInput.trim().split(/\s+/)[0];
  if (!first) return null;
  const cleaned = first
    .replace(/^https?:\/\/(www\.)?kick\.com\//i, '')
    .replace(/^@/, '')
    .replace(/[^A-Za-z0-9_]+$/, '');
  // Kick usernames: letters, digits and underscores.
  return /^[A-Za-z0-9_]{2,25}$/.test(cleaned) ? cleaned : null;
}

/** One redemption sitting in Kick's pending queue. */
export interface PendingRedemption {
  id: string;
  rewardId: string;
  rewardTitle: string;
  rewardCost?: number;
  userInput: string;
  redeemerId: number;
  redeemedAt: string | null;
}

/**
 * Rows out of `GET /channels/rewards/redemptions?status=pending`, which nests
 * redemptions under their reward rather than repeating the webhook's shape.
 * Anything unrecognisable is dropped rather than guessed at.
 */
export function pendingRedemptionsFromApi(payload: unknown): PendingRedemption[] {
  const groups = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(groups)) return [];
  const out: PendingRedemption[] = [];
  for (const g of groups) {
    const reward = (g as { reward?: Record<string, unknown> } | null)?.reward ?? {};
    const rewardId = typeof reward['id'] === 'string' ? reward['id'] : '';
    const rewardTitle = typeof reward['title'] === 'string' ? reward['title'] : '';
    if (!rewardId && !rewardTitle) continue;
    const rows = (g as { redemptions?: unknown }).redemptions;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      const row = (r ?? {}) as Record<string, unknown>;
      if (typeof row['id'] !== 'string' || !row['id']) continue;
      if (typeof row['status'] === 'string' && row['status'].toLowerCase() !== 'pending') continue;
      const redeemer = (row['redeemer'] ?? {}) as Record<string, unknown>;
      const redeemerId = Number(redeemer['user_id']);
      out.push({
        id: row['id'],
        rewardId,
        rewardTitle,
        rewardCost: typeof reward['cost'] === 'number' ? reward['cost'] : undefined,
        userInput: typeof row['user_input'] === 'string' ? row['user_input'] : '',
        redeemerId: Number.isInteger(redeemerId) && redeemerId > 0 ? redeemerId : 0,
        redeemedAt: typeof row['redeemed_at'] === 'string' ? row['redeemed_at'] : null
      });
    }
  }
  return out;
}

/**
 * Whether a redemption the bot never saw is still worth carrying out.
 *
 * A missing or unreadable timestamp counts as too old: a refund costs the
 * viewer nothing, while a timeout fired blind lands on a third party.
 */
export function pendingVerdict(redeemedAt: string | null, now: number, maxAgeMs: number): 'act' | 'refund' {
  const at = redeemedAt ? Date.parse(redeemedAt) : NaN;
  if (!Number.isFinite(at)) return 'refund';
  return now - at <= maxAgeMs ? 'act' : 'refund';
}

/** One reward as Kick lists it. */
export interface RewardState {
  id: string;
  title: string;
  isEnabled: boolean;
  isPaused: boolean;
}

/** Rows out of `GET /channels/rewards`. Anything without an id is dropped. */
export function rewardsFromApi(payload: unknown): RewardState[] {
  const rows = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(rows)) return [];
  const out: RewardState[] = [];
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || !row['id']) continue;
    out.push({
      id: row['id'],
      title: typeof row['title'] === 'string' ? row['title'] : '',
      isEnabled: row['is_enabled'] !== false,
      isPaused: row['is_paused'] === true
    });
  }
  return out;
}

function titleOf(rewards: RewardState[], id: string): string {
  return rewards.find(r => r.id === id)?.title || id;
}

/**
 * Which rewards follow the stream: those pinned by id, unless the action opts
 * out with `pauseWhenOffline: false`. An action matched only by title is left
 * alone — a title substring can match the wrong reward, and pausing the wrong
 * one is the streamer's problem, not a redemption that can be refunded.
 */
export function pauseTargetIds(actions: RewardAction[]): string[] {
  return availabilityTargets(actions).filter(t => t.mode === 'live').map(t => t.id);
}

export type Availability = 'always' | 'live' | 'offline';

/** When an action's reward may be redeemed, reading the older pauseWhenOffline flag too. */
export function availabilityOf(a: RewardAction): Availability {
  if (a.availability === 'always' || a.availability === 'live' || a.availability === 'offline') return a.availability;
  return a.pauseWhenOffline === false ? 'always' : 'live';
}

function openNow(mode: Availability, isLive: boolean): boolean {
  return mode === 'always' || (mode === 'live') === isLive;
}

/** Rewards the bot pauses and resumes with the stream, each with when it should be open. */
export function availabilityTargets(actions: RewardAction[]): Array<{ id: string; mode: 'live' | 'offline' }> {
  const out: Array<{ id: string; mode: 'live' | 'offline' }> = [];
  for (const a of actions) {
    const mode = availabilityOf(a);
    if (!a.rewardId || mode === 'always' || out.some(t => t.id === a.rewardId)) continue;
    out.push({ id: a.rewardId, mode });
  }
  return out;
}

/**
 * What to pause and what to resume.
 *
 * Offline: pause targets that are enabled and not already paused. Live: resume
 * only ids this bot paused — a reward the streamer paused stays paused, and one
 * they disabled entirely is never touched.
 */
export function pauseDecisions(args: {
  /** Plain ids are live-only rewards, as before offline-only ones existed. */
  targets: Array<string | { id: string; mode: 'live' | 'offline' }>;
  rewards: RewardState[];
  pausedByBot: string[];
  isLive: boolean;
}): { toPause: string[]; toResume: string[] } {
  const byId = new Map(args.rewards.map(r => [r.id, r]));
  const toPause: string[] = [];
  const toResume: string[] = [];
  for (const t of args.targets) {
    const { id, mode } = typeof t === 'string' ? { id: t, mode: 'live' as const } : t;
    const r = byId.get(id);
    if (!r) continue;
    if (!openNow(mode, args.isLive)) {
      // Open when it should be closed is re-paused, even if the bot paused it before
      // and someone unpaused it since: the availability setting is the one control.
      if (r.isEnabled && !r.isPaused) toPause.push(id);
    } else if (args.pausedByBot.includes(id) && r.isPaused) {
      toResume.push(id);
    }
  }
  // A reward the bot paused whose action has since gone: don't leave it paused for ever.
  const managed = new Set(args.targets.map(t => (typeof t === 'string' ? t : t.id)));
  for (const id of args.pausedByBot) {
    if (!managed.has(id) && byId.get(id)?.isPaused && !toResume.includes(id)) toResume.push(id);
  }
  return { toPause, toResume };
}

function sameUser(a: string, b: string): boolean {
  return a.replace(/^@+/, '').toLowerCase() === b.replace(/^@+/, '').toLowerCase();
}

function absentReason(target: string): string {
  return `${target} hasn't chatted in the last ${Math.round(RECENT_CHAT_WINDOW_MS / 60000)} minutes, so nobody was timed out`;
}

/** "2026-09-11 22:08:41: [vip,founder] BetterCaIISauI: text" — the badge list is absent for badgeless viewers. */
const CHAT_LOG_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}): (?:\[[a-z0-9_]+(?:,[a-z0-9_]+)*\] )?([A-Za-z0-9_]{2,25}): /;

/**
 * Whether `username` chatted in this channel within the window, read from the
 * channel's own log, where every chat message is written as it's handled.
 *
 * Returns null when the log can't be read. Callers treat that as "don't know" and
 * let the redemption through: refusing every redemption because a log rotated
 * would be worse than the occasional miss.
 */
export async function chattedRecently(channelName: string, username: string, windowMs = RECENT_CHAT_WINDOW_MS, now = Date.now()): Promise<boolean | null> {
  const logPath = path.join(process.cwd(), 'logs', `kick-${channelName}-out.log`);
  const wanted = username.replace(/^@+/, '').toLowerCase();
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(logPath, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, CHAT_LOG_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (length < size) lines.shift();   // started mid-line

    // Newest first, stopping at the first line older than the window.
    const cutoff = now - windowMs;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = CHAT_LOG_LINE.exec(lines[i]);
      if (!m) continue;
      // pm2 writes these stamps in the server's local time, which is how Date parses them.
      const at = new Date(`${m[1]}T${m[2]}`).getTime();
      if (at < cutoff) return false;
      if (m[3].toLowerCase() === wanted) return true;
    }
    // The whole log is newer than the window, so its start is the start of the
    // channel's history: the name really isn't there.
    if (length === size) return false;
    // The scanned tail never reached back past the window: a log busy enough that
    // the name could have chatted in the part not read. Don't refund on a guess.
    return null;
  } catch (err) {
    console.error(`[REWARD] Could not read ${logPath} to check recent chat — allowing the redemption:`, err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}
