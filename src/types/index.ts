/**
 * src/types/index.ts
 * Shared TypeScript type definitions for the Kick chatbot ecosystem.
 * All subsequent source files import from here.
 *
 * Catch block pattern (useUnknownInCatchVariables is active via strict: true):
 *
 *   Standard (all catch blocks):
 *     catch (err) {
 *       if (err instanceof Error) {
 *         console.error('[TAG] Something failed:', err.message);
 *       }
 *     }
 *
 *   FxError (fx.ts catch block only):
 *     catch (err) {
 *       if (err instanceof FxError) {
 *         client.say(channel, `@${username}, ${err.fxFromCode} is not a supported currency code.`);
 *         return;
 *       }
 *       if (err instanceof Error) {
 *         console.error('[FX] Unhandled error:', err.message);
 *       }
 *     }
 *
 * Note: Always use dot notation (config.channelName) not bracket notation
 * (config['channelName']) for declared ChannelConfig properties — the index
 * signature causes bracket access to return `unknown`.
 */

// ---------------------------------------------------------------------------
// OAuth / token shape
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  // Epoch ms of the authorization_code exchange that created this grant.
  // Kick grants have a hard 30-day lifetime regardless of refresh activity;
  // this lets the token monitor warn before the grant dies.
  grantedAt?: number;
}

// ---------------------------------------------------------------------------
// Location shape (nested inside ChannelConfig)
// ---------------------------------------------------------------------------

export interface LocationSubfields {
  country?: string;
  city?: string;
  state?: string;
  province?: string;
}

export interface ChannelLocation {
  home: LocationSubfields;
  current: LocationSubfields;
}

// ---------------------------------------------------------------------------
// Channel JSON config shape — covers all three live channel configs.
// Index signature required: sukasblood.json has a top-level `claude` key and
// future plugins may add similar blocks. Without [key: string]: unknown,
// `JSON.parse(...) as ChannelConfig` would fail when extra keys are present.
// ---------------------------------------------------------------------------

export interface AutoTranslateConfig {
  enabled: boolean;
  minConfidence?: number;
  minLength?: number;
  // Optional per-channel cap; if absent or 0, no internal rate limit is applied
  // (Google's own scraper-level throttling becomes the only ceiling).
  rateLimitPerMinute?: number;
  // Shadow mode: read messages from this channel's chatroom but POST the
  // translated output to a DIFFERENT broadcaster. Used for debugging where
  // we want to monitor a noisy channel's translations in our own channel
  // without polluting the source channel's chat.
  shadowTargetBroadcasterId?: number;
  // Label prepended to shadowed output (typically the source channel name)
  shadowSourceLabel?: string;
  // Dry-run mode: detect + translate as usual but log the would-be output
  // instead of sending it. Useful to evaluate translation quality on a live
  // channel without spamming chat.
  logOnly?: boolean;
}

export interface EarningsConfig {
  // Master switch for earnings recording. When false or absent the tracker is
  // constructed but never polls, and !earnings stays silent in the channel.
  enabled?: boolean;
  // ¢ per viewer-hour. Falls back to the tracker's built-in rate when unset.
  centsPerViewerHour?: number;
}

export interface KPPConfig {
  // Master switch. When false (or block missing), tracker stays constructed
  // but no-ops on polls and chat events. Matches autoTranslate.enabled idiom.
  enabled?: boolean;
  // Calibration: $ per engagement-score point. Set this from a real KPP payout.
  // null/undefined = pending calibration → !kpp displays score-only, no $ figure.
  dollarPerScore?: number | null;
  // Baseline chat-activity rate (unique chatters / avg viewers). Per the KPP
  // explainer reel, normal is 4–14%; midpoint 0.09 used as default.
  chatNormalRate?: number;
  // Simple viewer-hour model: ¢ per total viewer-hour (mirrors !earnings math).
  // Set to ~50% of the earnings rate (e.g. 5) to reflect KPP ≈ 50% of earnings.
  // Takes priority over centsPerAuthViewerHour and dollarPerScore when set.
  centsPerViewerHour?: number | null;
  // Authenticated-viewer-hour model: ¢ per authenticated viewer-hour.
  // Authenticated VH = sum of per-user active polling windows × window duration.
  // When set (and centsPerViewerHour is absent), used instead of dollarPerScore.
  centsPerAuthViewerHour?: number | null;
}

export interface ChannelConfig {
  channelName: string;
  chatroomId?: number;
  broadcasterUserId?: number;
  userId?: number;
  chatOnly?: boolean;
  oauth?: OAuthTokens;
  enrolledAt?: string;
  lastUpdated?: string;
  location?: ChannelLocation;
  excludedCommands?: string[];
  autoTranslate?: AutoTranslateConfig;
  kpp?: KPPConfig;
  earnings?: EarningsConfig;
  rewardActions?: RewardAction[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Channel point reward redemptions.
// ---------------------------------------------------------------------------

/**
 * Maps one channel-points reward to an action the bot performs when it is
 * redeemed. Matched by `rewardId` when present (exact, survives renames),
 * otherwise by case-insensitive substring on `rewardTitle`.
 */
export interface RewardAction {
  rewardId?: string;
  rewardTitle?: string;
  action: 'timeout';
  /**
   * Timeout length in seconds. Kick's ban API only accepts whole minutes, so
   * anything not a multiple of 60 is issued as the next whole minute and then
   * lifted early with an unban scheduled at the exact second.
   */
  durationSeconds: number;
  /** Post the outcome in chat. Defaults to true. */
  announce?: boolean;

  /**
   * Trial run. The timeout is really applied, but shortened to
   * `testDurationSeconds` and the redemption is REJECTED afterwards so the
   * redeemer's points come back. Lets a live reward be proven end to end
   * without charging anyone.
   */
  testMode?: boolean;
  /** Timeout length while `testMode` is on. Defaults to 5 seconds. */
  testDurationSeconds?: number;
  /**
   * Usernames allowed to trigger the action while `testMode` is on. Anyone
   * else is refunded and nobody is timed out, so an unproven reward can't
   * catch real viewers. Empty or absent means everyone is allowed.
   */
  testRedeemers?: string[];
}

/** Payload of Kick's `channel.reward.redemption.updated` webhook (version 1). */
export interface RewardRedemptionEvent {
  id: string;
  user_input?: string;
  status: string;              // 'pending' | 'accepted' | 'rejected'
  redeemed_at?: string;
  reward: { id: string; title: string; cost?: number; description?: string };
  redeemer: { user_id: number; username: string; channel_slug?: string };
  broadcaster: { user_id: number; username: string };
}

// ---------------------------------------------------------------------------
// KickTags — chat message sender/identity shape from Pusher events.
// Derived from kickTags construction in template-kick-bot.js lines 381-395.
// ---------------------------------------------------------------------------

export interface BadgesMap {
  broadcaster?: string;
  moderator?: string;
  vip?: string;
  subscriber?: string;
  founder?: string;
  sub_gifter?: string;
  [key: string]: string | undefined;
}

export interface RawBadge {
  type: string;
  [key: string]: unknown;
}

export interface KickTags {
  username: string;
  'display-name': string;
  badges: BadgesMap;
  isBroadcaster: boolean;
  isModUp: boolean;
  isVIPUp: boolean;
  rawBadges: RawBadge[];
  senderId?: number | string;
}

// ---------------------------------------------------------------------------
// ClientWrapper — the say-capable wrapper passed to every command plugin.
// Derived from clientWrapper construction in template-kick-bot.js lines 398-403.
// ---------------------------------------------------------------------------

export interface ClientWrapper {
  say(channel: string, msg: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// CommandFn — the plugin function contract used by all 13 bot-commands plugins.
// Return type is void | Promise<void>: plugins are async but the call site
// does not await the return value.
// ---------------------------------------------------------------------------

export type CommandFn = (
  client: ClientWrapper,
  message: string,
  channel: string,
  tags: KickTags,
  config: ChannelConfig
) => void | Promise<void>;

// ---------------------------------------------------------------------------
// EarningsSession — shapes written by EarningsTracker and read by !earnings.
// Persisted as JSON under data/earnings/<channel>/{current,sessions}.json.
// Cents stored as integers to avoid float drift over long sessions.
// ---------------------------------------------------------------------------

export interface CurrentEarningsSession {
  startedAt: string;          // ISO — when stream went live (Kick's start_time, or first poll if absent)
  firstObservedAt: string;    // ISO — when our tracker first saw this stream; set once, never updated
  lastPolledAt: string;       // ISO — last poll that confirmed live (used as last-seen-live for end-time estimation)
  lastViewerCount: number;    // viewers at last poll (used to prorate the next interval)
  accumulatedCents: number;   // integer cents earned so far this session
  peakViewers: number;        // highest viewer count observed this session
}

export interface FinalizedEarningsSession {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  totalCents: number;
  peakViewers: number;
}

// ---------------------------------------------------------------------------
// KPP (Kick Partner Program) engagement tracking — see kpp-tracker.ts.
// KPP pays from a monthly pool weighted by engagement, not a flat CPM:
//
//   share = (your_score / total_platform_score) × monthly_pool
//   score = authentic_watch_time × chat_activity_weight × viewer_trust_factor
//
// We can only approximate the first two locally (viewer_trust_factor is
// server-side at Kick). Dollar estimate requires a one-shot calibration
// (kpp.dollarPerScore) derived from a real KPP statement.
// ---------------------------------------------------------------------------

export interface CurrentKPPSession {
  startedAt: string;
  firstObservedAt: string;
  lastPolledAt: string;
  lastViewerCount: number;
  viewerHoursSum: number;                       // Σ (avg_viewers × interval_hours)
  peakViewers: number;
  // Cumulative across the whole session — used for display only ("X unique chatters this stream").
  cumulativeChatters: Record<string, number>;   // lowercase username → message count
  // Per-poll-window chatters; resets each successful live poll.
  windowChatters: Record<string, number>;
  // Messages in the current poll window; resets alongside windowChatters.
  windowMessages?: number;
  // Per-user count of polling windows the user was active in. Accumulated
  // across the session — never reset. Used to compute authenticatedViewerHours.
  chatterActiveWindows?: Record<string, number>;
  // Running mean of per-window chat rates (windowChatters / viewer_count_at_poll).
  // This is what's compared to chatNormalRate. Concurrent participation, not cumulative.
  chatRateSum: number;
  chatRateSampleCount: number;
  totalMessages: number;
}

export interface FinalizedKPPSession {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  avgViewers: number;
  peakViewers: number;
  viewerHours: number;
  uniqueChatters: number;
  totalMessages: number;
  chatActivityRate: number;       // uniqueChatters / avgViewers
  chatActivityWeight: number;     // (chatActivityRate / chatNormalRate), clamped [0.2, 2.5]
  engagementScore: number;        // viewerHours × chatActivityWeight
  authenticatedViewerHours: number; // sum(per-user activeWindows) × windowDurationHours
  estimatedCents: number | null;  // auth model or score × dollarPerScore × 100; null = uncalibrated
}

// ---------------------------------------------------------------------------
// FxError — typed error class for the currency exchange plugin.
// MUST be a class (not interface): catch blocks use `instanceof FxError`.
// An interface cannot satisfy instanceof — a runtime constructor is required.
// Derived from fx.js throw pattern (lines 216-219) and catch site (lines 321-325).
// ---------------------------------------------------------------------------

export class FxError extends Error {
  fxErrorType: string;
  fxFromCode: string;

  constructor(message: string, fxErrorType: string, fxFromCode: string) {
    super(message);
    this.name = 'FxError';
    this.fxErrorType = fxErrorType;
    this.fxFromCode = fxFromCode;
  }
}
