/**
 * Channel-points reward redemptions → moderation actions.
 *
 * Kick delivers `channel.reward.redemption.updated` webhooks to the enrollment
 * service, which queues them per channel; WebhookPoller hands them here. The
 * only action implemented today is `timeout`: the redeemer names a victim in
 * the reward's user input and the bot times them out.
 *
 * Everything is driven by `rewardActions` in the channel config, so a channel
 * with no such entry never does anything.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { ChannelConfig, RewardAction, RewardRedemptionEvent, RawBadge } from '../types';
import { getBotIdentity } from '../bot-identity';
import TelegramNotifier = require('../telegram-notifier');

const API = 'https://api.kick.com/public/v1';

/** Kick's ban API caps a timeout at one week. */
const MAX_TIMEOUT_MINUTES = 10080;

/** Redemption ids already acted on. The webhook re-fires on every status change. */
const SEEN_LIMIT = 500;

/** Bots that carry a moderator badge but are not people. Kept out of the mod cache. */
const SYSTEM_BOTS = new Set(['kickbot', 'kickcx', 'botrix', 'streamelements', 'nightbot', 'moobot']);

/** How often the moderator cache is re-warmed from the channel log. */
const MOD_REFRESH_MS = 30 * 60 * 1000;

/** Scopes a `timeout` reward action cannot work without. */
const REQUIRED_SCOPES = ['moderation:ban', 'channel:rewards:write'];

export interface RewardHandlerDeps {
  channelName: string;
  /** Live config — read through a getter, since token refresh replaces the object. */
  getConfig: () => ChannelConfig;
  getBroadcasterUserId: () => number | null;
  /** Streamer-delegated token. `isChannelToken: false` means moderation is not authorized. */
  getToken: () => Promise<{ token: string; isChannelToken: boolean }>;
  /**
   * The bot's own token. Username lookups are channel-agnostic and only need
   * `channel:read`, which the bot always holds — so they keep working even on a
   * channel whose streamer grant predates the wider scope set.
   */
  getBotToken: () => Promise<string | null>;
  sendMessage: (message: string) => Promise<unknown>;
}

export class RewardRedemptionHandler {
  private deps: RewardHandlerDeps;
  private seen: string[] = [];
  /** Usernames (lowercase) known to hold a moderator/broadcaster badge here. */
  private mods = new Set<string>();
  private modRefreshTimer: NodeJS.Timeout | null = null;
  private pendingUnbans = new Set<NodeJS.Timeout>();
  /** Scopes actually granted on a given channel token, keyed by the token itself. */
  private scopeCache = new Map<string, string[]>();
  private scopeGapNotified = false;

  constructor(deps: RewardHandlerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.modRefreshTimer) return;
    void this.warmModeratorCache();
    void this.preflightScopes();
    this.modRefreshTimer = setInterval(() => void this.warmModeratorCache(), MOD_REFRESH_MS);
  }

  /**
   * Report a scope gap at startup rather than at redemption time.
   *
   * A channel whose grant predates these scopes looks healthy — chat works,
   * the token refreshes — and the only symptom is redemptions quietly doing
   * nothing. Surface it while there is still time to act on it.
   */
  private async preflightScopes(): Promise<void> {
    const actions = this.deps.getConfig().rewardActions;
    if (!Array.isArray(actions) || actions.length === 0) return;

    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) {
      console.error(`[REWARD] ${this.deps.channelName} has rewardActions but no streamer token — redemptions will be ignored.`);
      return;
    }

    const granted = await this.grantedScopes(token);
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
      console.log(`[REWARD] ${actions.length} reward action(s) armed and authorized (${pinned} pinned by id).`);
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

  stop(): void {
    if (this.modRefreshTimer) {
      clearInterval(this.modRefreshTimer);
      this.modRefreshTimer = null;
    }
    for (const t of this.pendingUnbans) clearTimeout(t);
    this.pendingUnbans.clear();
  }

  /**
   * Feed live chat badges in. A moderator who has not spoken since the bot
   * started is still covered by the log warm-start, but this keeps freshly
   * promoted mods protected without waiting for the next refresh.
   */
  noteBadges(username: string, badges: RawBadge[] | undefined): void {
    if (!username || !badges?.length) return;
    const isMod = badges.some(b => b.type === 'moderator' || b.type === 'broadcaster' || b.type === 'owner');
    if (isMod) this.mods.add(username.toLowerCase());
  }

  /**
   * Seed the moderator set from the channel's own log.
   *
   * Kick's public API has no endpoint that lists moderators, so past chat is
   * the only signal. Without this, a mod who is lurking at bot-restart time
   * would be a legal timeout target.
   */
  private warmModeratorCache(): Promise<void> {
    const logPath = path.join(process.cwd(), 'logs', `kick-${this.deps.channelName}-out.log`);
    if (!fs.existsSync(logPath)) return Promise.resolve();

    // Filter in the shell: these logs reach tens of MB and buffering a raw tail
    // in Node blows past exec's maxBuffer, which fails silently.
    const cmd = `tail -n 200000 ${JSON.stringify(logPath)} | grep -oE '\\[[a-z_,]*moderator[a-z_,]*\\] [A-Za-z0-9_]+:' | sed -E 's/.*\\] //; s/:$//' | sort -u`;
    return new Promise<void>(resolve => {
      exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve();
        let added = 0;
        for (const line of stdout.split('\n')) {
          const name = line.trim().toLowerCase();
          if (!name || SYSTEM_BOTS.has(name)) continue;
          if (!this.mods.has(name)) added++;
          this.mods.add(name);
        }
        if (added) console.log(`[REWARD] Moderator cache warmed from log (+${added}, ${this.mods.size} total)`);
        resolve();
      });
    });
  }

  /**
   * Why `target` may not be timed out, or null if it may.
   *
   * Someone naming themselves is always allowed: a self-inflicted timeout
   * harms nobody else, and it's the only way a moderator can exercise the
   * reward at all. The broadcaster and the bot stay protected even from
   * themselves — gagging either one breaks the stream or the bot's own replies.
   */
  private protectionReason(target: string, redeemer: string): string | null {
    const name = target.toLowerCase();
    if (name === this.deps.channelName.toLowerCase()) return 'broadcaster';
    const bot = getBotIdentity();
    if (bot?.username && name === bot.username.toLowerCase()) return 'the bot';
    if (SYSTEM_BOTS.has(name)) return 'a system bot';

    if (name === redeemer.toLowerCase()) return null;   // self-inflicted

    if (name === (process.env.KICK_OWNER || '').toLowerCase()) return 'the bot owner';
    if (this.mods.has(name)) return 'a moderator';
    return null;
  }

  /**
   * Scopes actually present on the channel token.
   *
   * A grant made before a scope was added to the enrollment request keeps the
   * old, narrower set forever — refreshing never widens it. Acting without
   * checking means the ban call 403s and the redeemer gets told their points
   * were refunded when the refund 403'd too.
   */
  private async grantedScopes(token: string): Promise<string[]> {
    const cached = this.scopeCache.get(token);
    if (cached) return cached;
    try {
      const res = await axios.post(`${API}/token/introspect`, null, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const scope = (res.data as { data?: { scope?: string } })?.data?.scope ?? '';
      const scopes = scope.split(/\s+/).filter(Boolean);
      // Tokens rotate on refresh; keep the map from growing unbounded.
      if (this.scopeCache.size > 4) this.scopeCache.clear();
      this.scopeCache.set(token, scopes);
      return scopes;
    } catch {
      // Unknown rather than empty — assume capable and let the API be the judge.
      return [];
    }
  }

  private matchAction(reward: RewardRedemptionEvent['reward']): RewardAction | null {
    const actions = this.deps.getConfig().rewardActions;
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

    // Preflight the token BEFORE claiming the redemption. If the channel can't
    // authorize a ban there is nothing useful to do: stay silent and leave the
    // redemption pending so the streamer can resolve it by hand. Announcing a
    // failure and a refund we can't perform is worse than doing nothing.
    const { token, isChannelToken } = await this.deps.getToken();
    if (!isChannelToken || !token) {
      console.error(`[REWARD] "${event.reward.title}" ignored — no streamer token. Channel must re-authorize.`);
      return;
    }
    const scopes = await this.grantedScopes(token);
    if (scopes.length > 0 && !scopes.includes('moderation:ban')) {
      console.error(
        `[REWARD] "${event.reward.title}" ignored — ${this.deps.channelName}'s token lacks moderation:ban ` +
        `(granted: ${scopes.join(' ') || 'none'}). Redemption left pending; channel must re-authorize.`
      );
      return;
    }

    this.seen.push(event.id);
    if (this.seen.length > SEEN_LIMIT) this.seen.shift();

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

    const target = parseTargetUsername(event.user_input);
    if (!target) {
      return fail('I could not read a username in that redemption');
    }
    const blocked = this.protectionReason(target, redeemer);
    if (blocked) {
      return fail(`${target} cannot be timed out (${blocked})`);
    }

    const broadcasterUserId = this.deps.getBroadcasterUserId();
    if (!broadcasterUserId) {
      console.error('[REWARD] Broadcaster user id unknown — cannot time out.');
      return fail('the bot could not identify this channel');
    }

    const lookupToken = (await this.deps.getBotToken().catch(() => null)) || token;
    const targetUserId = await resolveUserId(target, lookupToken)
      ?? (lookupToken === token ? null : await resolveUserId(target, token));
    if (!targetUserId) {
      return fail(`I could not find a Kick user called "${target}"`);
    }
    if (targetUserId === broadcasterUserId) {
      return fail(`${target} cannot be timed out`);
    }

    const configured = isTest ? (action.testDurationSeconds ?? 5) : action.durationSeconds;
    const seconds = Math.max(1, Math.floor(configured));
    // Kick's ban API takes whole minutes. Round up so the punishment is never
    // shorter than configured, then lift it early at the exact second below.
    const minutes = Math.min(MAX_TIMEOUT_MINUTES, Math.ceil(seconds / 60));

    try {
      await axios.post(`${API}/moderation/bans`, {
        broadcaster_user_id: broadcasterUserId,
        user_id: targetUserId,
        duration: minutes,
        reason: truncate(`Reward "${event.reward.title}" redeemed by ${redeemer}`, 100)
      }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    } catch (err) {
      const detail = axios.isAxiosError(err)
        ? JSON.stringify(err.response?.data ?? err.message)
        : (err instanceof Error ? err.message : String(err));
      console.error(`[REWARD] Timeout of ${target} failed: ${detail}`);
      return fail(`I could not time out ${target}`);
    }

    console.log(`[REWARD]${isTest ? ' [TEST]' : ''} ${redeemer} timed out ${target} for ${seconds}s (API: ${minutes}m) via "${event.reward.title}"`);

    if (seconds % 60 !== 0) {
      this.scheduleUnban(target, targetUserId, broadcasterUserId, seconds);
    }

    // A test run rejects rather than accepts, which is what refunds the points.
    const resolved = canResolve ? await this.resolve(event.id, !isTest) : false;

    if (action.announce !== false) {
      const headline = `@${redeemer} ${isTest ? 'TEST — ' : `redeemed "${event.reward.title}" — `}` +
        `${target} is timed out for ${formatDuration(seconds)}`;
      const tail = isTest
        ? (resolved ? ', points refunded.' : ', but the refund failed — resolve it manually.')
        : '.';
      await this.deps.sendMessage(headline + tail).catch(() => {});
    }
  }

  /**
   * Lift the rounded-up ban at the exact configured second.
   *
   * Best-effort by design: if the bot dies before this fires, Kick expires the
   * timeout on its own within the next minute rather than leaving anyone stuck.
   */
  private scheduleUnban(target: string, userId: number, broadcasterUserId: number, seconds: number): void {
    const timer = setTimeout(() => {
      this.pendingUnbans.delete(timer);
      void (async () => {
        try {
          const { token, isChannelToken } = await this.deps.getToken();
          if (!isChannelToken || !token) return;
          await axios.delete(`${API}/moderation/bans`, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { broadcaster_user_id: broadcasterUserId, user_id: userId }
          });
          console.log(`[REWARD] Timeout on ${target} lifted at ${seconds}s`);
        } catch (err) {
          // Kick expires the rounded-up ban shortly anyway — log and move on.
          const detail = axios.isAxiosError(err)
            ? JSON.stringify(err.response?.data ?? err.message)
            : (err instanceof Error ? err.message : String(err));
          console.error(`[REWARD] Early unban of ${target} failed: ${detail}`);
        }
      })();
    }, seconds * 1000);
    this.pendingUnbans.add(timer);
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

/** Resolve a Kick username to its numeric user id via its channel slug. */
async function resolveUserId(username: string, token: string): Promise<number | null> {
  try {
    const res = await axios.get(`${API}/channels`, {
      params: { slug: username.toLowerCase() },
      headers: { Authorization: `Bearer ${token}`, Accept: '*/*' }
    });
    const rows = (res.data as { data?: Array<{ broadcaster_user_id?: number }> })?.data;
    const id = rows?.[0]?.broadcaster_user_id;
    return typeof id === 'number' ? id : null;
  } catch (err) {
    const detail = axios.isAxiosError(err)
      ? JSON.stringify(err.response?.data ?? err.message)
      : (err instanceof Error ? err.message : String(err));
    console.error(`[REWARD] Could not resolve user "${username}": ${detail}`);
    return null;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${mins}m ${rem}s` : `${mins} minute${mins === 1 ? '' : 's'}`;
}
