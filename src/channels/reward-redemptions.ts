/**
 * Channel-points reward redemptions → moderation actions.
 *
 * Kick delivers `channel.reward.redemption.updated` webhooks to the enrollment
 * service, which queues them per channel; WebhookPoller hands them here.
 *
 * Actions: `timeout` the user named in the redemption, `roulette` (50/50 the
 * named user or the redeemer), `pardon` a timeout the bot gave out, and
 * `shield` the redeemer from other viewers' timeout rewards. The moderation
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

/** What one redemption did, or why it didn't. A failure is refunded. */
type Outcome =
  | { ok: true; announce: string; log: string }
  | { ok: false; reason: string };

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
}

export class RewardRedemptionHandler {
  private deps: RewardHandlerDeps;
  private seen: string[] = [];
  private started = false;
  private scopeGapNotified = false;

  constructor(deps: RewardHandlerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.preflightScopes();
  }

  /** Nothing to tear down here — pending unbans belong to the moderator. */
  stop(): void {
    this.started = false;
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
    if ((await this.deps.moderator.issuers()).length === 0) {
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
      const refunded = canResolve ? await this.resolve(event.id, false) : false;
      if (action.announce !== false) {
        const suffix = refunded ? ' — your points have been refunded.' : '.';
        await this.deps.sendMessage(`@${redeemer} ${reason}${suffix}`).catch(() => {});
      }
    };

    // Trial run: shortened, refunded, and optionally limited to named testers
    // so a reward that has never fired in production can't catch real viewers.
    const isTest = action.testMode === true;
    const testers = (action.testRedeemers ?? []).map(n => n.toLowerCase());
    if (isTest && testers.length > 0 && !testers.includes(redeemer.toLowerCase())) {
      console.log(`[REWARD] "${event.reward.title}" by ${redeemer} skipped — test mode limited to: ${testers.join(', ')}`);
      const refunded = canResolve ? await this.resolve(event.id, false) : false;
      if (action.announce !== false) {
        await this.deps.sendMessage(
          `@${redeemer} this reward is being tested right now, so nobody was timed out` +
          (refunded ? ' — your points have been refunded.' : '.')
        ).catch(() => {});
      }
      return;
    }

    const outcome = await this.perform(action, event, redeemer, isTest);
    if (!outcome.ok) {
      return fail(outcome.reason);
    }

    console.log(`[REWARD]${isTest ? ' [TEST]' : ''} ${outcome.log} via "${event.reward.title}"`);

    // A test run rejects rather than accepts, which is what refunds the points.
    const resolved = canResolve ? await this.resolve(event.id, !isTest) : false;

    if (action.announce !== false) {
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
    if (action.action !== 'pardon' && !(seconds > 0)) {
      console.error(`[REWARD] "${event.reward.title}" is a ${action.action} action with no durationSeconds — fix the channel config.`);
      return { ok: false, reason: 'this reward is not set up correctly' };
    }

    switch (action.action) {
      case 'timeout': {
        const target = parseTargetUsername(event.user_input);
        if (!target) return { ok: false, reason: 'I could not read a username in that redemption' };

        const blocked = moderator.protectionReason(target, redeemer);
        if (blocked) return { ok: false, reason: `${target} cannot be timed out (${blocked})` };
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

      default: {
        const unknown = (action as { action?: unknown }).action;
        console.error(`[REWARD] "${event.reward.title}" has unknown action "${String(unknown)}" — fix the channel config.`);
        return { ok: false, reason: 'this reward is not set up correctly' };
      }
    }
  }

  /** Accept (fulfil) or reject (refund) the queued redemption. Returns success. */
  private async resolve(redemptionId: string, accept: boolean): Promise<boolean> {
    try {
      const { token, isChannelToken } = await this.deps.getToken();
      if (!isChannelToken || !token) return false;
      await axios.post(
        `${API}/channels/rewards/redemptions/${accept ? 'accept' : 'reject'}`,
        { ids: [redemptionId] },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
      );
      return true;
    } catch (err) {
      const detail = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data ?? err.message)
        : (err instanceof Error ? err.message : String(err));
      console.error(`[REWARD] Failed to ${accept ? 'accept' : 'reject'} redemption ${redemptionId}: ${detail}`);
      return false;
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

function sameUser(a: string, b: string): boolean {
  return a.replace(/^@+/, '').toLowerCase() === b.replace(/^@+/, '').toLowerCase();
}
