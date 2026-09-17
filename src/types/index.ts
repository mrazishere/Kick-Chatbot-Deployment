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
  /** What !kpp and !earnings call the streamer ("Don" for sukasblood). Defaults to channelName. */
  streamerName?: string;
  /** Loyalty points. Stored partially; read through points/config effectivePointsConfig. */
  points?: StoredPointsConfig;
  /**
   * The Blerp account !blerp files suggestions with. Set explicitly rather
   * than resolved from the Kick username: a streamer may hold several Blerp
   * accounts and the one their Kick name sits on can be dormant.
   */
  blerpStreamerId?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Loyalty points (see src/points/). Viewers earn a channel currency for chatting
// while live and for follows, subs, gifted subs and Kicks.
// ---------------------------------------------------------------------------

export interface PointsBonusesConfig {
  follow: number;
  subNew: number;
  subRenewal: number;
  /** Per sub gifted, to the gifter. */
  giftSubGifterPerSub: number;
  /** To each recipient of a gifted sub. */
  giftSubRecipient: number;
  /** Multiplied by the number of Kicks gifted, then floored. */
  pointsPerKick: number;
  onlyWhileLive: boolean;
  /** Thank the viewer in chat when a bonus lands. */
  announce: boolean;
}

export interface PointsGiveConfig {
  enabled: boolean;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  cooldownSeconds: number;
}

/** Effective points settings: every field present, defaults applied. */
/**
 * Deducting points when a viewer is timed out, so a punishment costs something.
 *
 * Scaled per second of the timeout: Kick's `moderation.banned` carries the
 * expiry, so a 120-second timeout at 1/second costs 120. A permanent ban has no
 * duration to scale from and is charged its own flat amount instead.
 */
export interface PointsTimeoutPenaltyConfig {
  enabled: boolean;
  /** Deducted per second of the timeout. */
  pointsPerSecond: number;
  /** Never take more than this in one timeout. 0 means no cap. */
  maxDeduction: number;
  /** Flat cost of a permanent ban, which has no duration. 0 ignores them. */
  permanentBanCost: number;
  /** Say in chat what was deducted. */
  announce: boolean;
}

/**
 * `$<cmd> gamble <amount>`: an even-money bet. A win adds the amount, a loss takes
 * it. One win chance for the whole channel; every gamble is its own roll.
 */
export interface PointsGambleConfig {
  enabled: boolean;
  /** Chance each gamble wins, 0–100. The same for every viewer in the channel. */
  winChancePercent: number;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  /** Per viewer. */
  cooldownSeconds: number;
  /** Ignore gambles while the stream is offline. */
  onlyWhileLive: boolean;
}

/**
 * `$<cmd> duel @user <amount>`: two viewers put in the same amount, 50/50, and the
 * winner takes both. The challenger's stake is held until the duel is answered or
 * expires, then paid out or refunded.
 */
export interface PointsDuelConfig {
  enabled: boolean;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  /** Per challenger, after a challenge is made. */
  cooldownSeconds: number;
  /** How long the opponent has to answer before the stake is refunded. */
  expirySeconds: number;
  /** Ignore challenges and accepts while the stream is offline. Refunds happen regardless. */
  onlyWhileLive: boolean;
}

export interface PointsConfig {
  enabled: boolean;
  currencyName: string;
  /** The chat command word. null derives it from currencyName ("$DON" → "don"). */
  currencyCommand: string | null;
  pointsPerInterval: number;
  intervalMinutes: number;
  /** A viewer counts as watching when they chatted within this many minutes. */
  activeWindowMinutes: number;
  subscriberMultiplier: number;
  excludeBroadcaster: boolean;
  /** Lowercase usernames that never earn. */
  ignoreUsers: string[];
  bonuses: PointsBonusesConfig;
  give: PointsGiveConfig;
  modMaxAdjust: number;
  publicLeaderboard: boolean;
  /** What a timeout costs the viewer who got it. */
  timeoutPenalty: PointsTimeoutPenaltyConfig;
  gamble: PointsGambleConfig;
  duel: PointsDuelConfig;
}

/** The `points` block as stored in a channel config: any subset of the fields. */
export type StoredPointsConfig = Partial<Omit<PointsConfig, 'bonuses' | 'give' | 'timeoutPenalty' | 'gamble' | 'duel'>> & {
  bonuses?: Partial<PointsBonusesConfig>;
  give?: Partial<PointsGiveConfig>;
  timeoutPenalty?: Partial<PointsTimeoutPenaltyConfig>;
  gamble?: Partial<PointsGambleConfig>;
  duel?: Partial<PointsDuelConfig>;
  /** Staging only, set by editing the file: treat the channel as live. Never exposed by the API. */
  debugForceLive?: boolean;
};

/** A Kick user as it appears in webhook payloads. */
export interface KickEventUser {
  user_id: number | null;
  username: string;
  is_anonymous?: boolean;
  is_verified?: boolean;
  profile_picture?: string;
  channel_slug?: string;
}

/** `channel.followed` (version 1). */
export interface FollowEvent {
  broadcaster: KickEventUser;
  follower: KickEventUser;
}

/** `channel.subscription.new` and `channel.subscription.renewal` (version 1). */
export interface SubscriptionEvent {
  broadcaster: KickEventUser;
  subscriber: KickEventUser;
  duration?: number;
  created_at?: string;
  expires_at?: string;
}

/** `channel.subscription.gifts` (version 1). The gifter may be anonymous. */
export interface SubscriptionGiftsEvent {
  broadcaster: KickEventUser;
  gifter: KickEventUser | null;
  giftees: KickEventUser[];
  created_at?: string;
  expires_at?: string;
}

/** `kicks.gifted` (version 1). */
export interface KicksGiftedEvent {
  broadcaster: KickEventUser;
  sender: KickEventUser;
  gift: { amount: number; name?: string; type?: string; tier?: string; message?: string };
  created_at?: string;
}

/** `livestream.status.updated` (version 1). */
export interface LivestreamStatusEvent {
  broadcaster: KickEventUser;
  is_live: boolean;
  title?: string;
  started_at?: string;
  ended_at?: string | null;
}

/** What the webhook queue knows about an event besides its payload. */
export interface QueueMeta {
  /** Milliseconds since the enrollment service queued it; null for unstamped lines. */
  ageMs: number | null;
  /** Kick's event message id, when the enrollment service recorded it. */
  messageId?: string;
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
  /**
   * timeout  — time out the user named in the redemption.
   * roulette — 50/50: time out the named user, or the redeemer.
   * pardon   — lift a timeout the bot gave out (reward or /timeout command) on the
   *            named user, or on the redeemer when nobody is named. Moderators'
   *            own timeouts and bans are never touched.
   * shield   — other viewers' timeout and roulette rewards can't hit the redeemer.
   */
  action: 'timeout' | 'roulette' | 'pardon' | 'shield';
  /**
   * Seconds: the timeout length (timeout, roulette) or how long the shield lasts.
   * Unused by pardon. Kick's ban API only accepts whole minutes, so a timeout
   * that isn't a multiple of 60 is issued as the next whole minute and then
   * lifted early at the exact second.
   */
  durationSeconds?: number;
  /** shield only: a timeout or roulette aimed at the holder lands on whoever redeemed it. */
  reflect?: boolean;
  /**
   * Pause this reward on Kick while the channel is offline, and resume it when
   * the stream starts (default true). Only rewards pinned by `rewardId` follow
   * the stream, and only a pause this bot made is ever undone.
   */
  pauseWhenOffline?: boolean;
  /** Post the outcome in chat. Defaults to true. */
  announce?: boolean;

  /**
   * Trial run. The action is really applied — a timeout or shield shortened to
   * `testDurationSeconds` — and the redemption is REJECTED afterwards so the
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

/** Kick's `moderation.banned` webhook payload. `expires_at` is null for a permanent ban. */
export interface ModerationBannedEvent {
  broadcaster: { user_id: number; username: string };
  moderator?: { user_id: number; username: string };
  banned_user: { user_id: number; username: string };
  metadata?: { reason?: string; created_at?: string; expires_at?: string | null };
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
  /** Kick's id for the chat message, the same whether it came by chat socket or webhook. */
  messageId?: string;
}

// ---------------------------------------------------------------------------
// ClientWrapper — the wrapper passed to every command plugin: chat output, plus
// timeouts issued through Kick's moderation API (see channels/moderation.ts).
// ---------------------------------------------------------------------------

/** A timeout a command asks the bot to issue. */
export interface TimeoutRequest {
  /** Kick username to time out; a leading @ is ignored. */
  target: string;
  seconds: number;
  /** Who triggered it. Naming yourself is always allowed. */
  invoker: string;
  /** Shown in Kick's moderation log, truncated to 100 characters. */
  reason: string;
}

/** `error` is a short sentence that is safe to post in chat. */
export type TimeoutResult =
  | { ok: true; target: string; seconds: number; actor: string }
  | { ok: false; error: string };

export interface ClientWrapper {
  say(channel: string, msg: string): Promise<void>;
  /** Time a user out through Kick's API. Absent where the bot cannot moderate. */
  timeout?(request: TimeoutRequest): Promise<TimeoutResult>;
  /** A Kick username's numeric user id, or null. Calls Kick's API; use sparingly. */
  lookupUser?(username: string): Promise<number | null>;
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
