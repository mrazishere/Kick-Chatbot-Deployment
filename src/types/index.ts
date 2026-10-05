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
  // Allowlist of source languages to translate, as ISO-639 codes (e.g. ["de"]).
  // Empty or absent means every language but English. A non-empty list also
  // admits plain-ASCII text — see the header of bot-commands/autotranslate.ts.
  languages?: string[];
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
  /**
   * Appended to a winning gamble, e.g. a channel's hype emote. Emote names are
   * sent as plain text: Kick renders its own, and a 7TV or BTTV one renders for
   * viewers running the extension. Empty means nothing is added.
   */
  winEmote: string;
  /** The same, for a losing gamble. Empty means nothing is added. */
  loseEmote: string;
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

/**
 * `$<cmd> raffle <prize> [seconds]` and `$<cmd> sraffle <prize> [seconds]`: a
 * moderator opens a raffle, viewers enter free with `$<cmd> join`, one entry each,
 * and the prize is paid when it closes. `raffle` splits between `winners` people,
 * `sraffle` gives it all to one. The prize is minted, not taken from anyone, which
 * is why the caps below exist.
 */
export interface PointsRaffleConfig {
  enabled: boolean;
  minPrize: number;
  /** Most a single raffle can pay out in total. 0 means no maximum. */
  maxPrize: number;
  /** How many raffles may be opened per stream. 0 means no limit. */
  maxPerStream: number;
  /** Used when the opener names no duration. */
  defaultDurationSeconds: number;
  /** Longest a raffle may stay open, so one can't be left running all stream. */
  maxDurationSeconds: number;
  /** How many win a multi-winner `raffle`. `sraffle` always draws one. */
  winners: number;
  /** Ignore opening and joining while the stream is offline. A draw still happens. */
  onlyWhileLive: boolean;
}

/**
 * `$<cmd> fish`: supibot's fishing game played for the channel currency. Bait is
 * bought and selling the catch pays out in it. Defaults are supibot's numbers.
 * Switching the game off entirely is the command toggle (excludedCommands).
 */
export interface PointsGamesConfig {
  /** Fishing exists in this channel at all. */
  enabled: boolean;
  /** Casting and laying traps only while live. Selling, show, stats and top work any time. */
  onlyWhileLive: boolean;
  /** The reverse: casting and laying traps only while offline. Can't be on together with onlyWhileLive. */
  onlyWhileOffline: boolean;
  /** 1 in this many casts without bait lands a fish (supibot: 20). Bait lowers it. */
  catchOdds: number;
  /** The wait after a catch (supibot: 30). A miss waits 30–90 seconds. */
  catchCooldownMinutes: number;
  /** How long traps take to fill (supibot: 60). */
  trapMinutes: number;
  /** Sell prices as a percentage of supibot's (fish 50, junk 1–20). */
  sellPricePercent: number;
  /** Bait prices as a percentage of supibot's (worm 2, fly 5, cricket 8). */
  baitPricePercent: number;
  /** A short AI story on 1 in 3 catches. */
  stories: boolean;
  /**
   * Post cast results and trap hauls in chat. They always go to the fishing
   * overlay (a browser source), so a channel can turn this off and show them on
   * stream only. Every other fishing reply always goes to chat.
   */
  chatReplies: boolean;
  /**
   * Every fish and junk item with its odds and price as they apply. Stored as
   * overrides only (StoredFishCatches); an item without one keeps supibot's weight
   * and its price scaled by sellPricePercent.
   */
  catches: FishCatchSetting[];
  /** Reels in the order they're bought with `fish buy reel`. Empty: nothing to buy. */
  reels: FishReelSetting[];
  /** `fish steal`: taking a fish from another viewer, and guards against it. */
  steal: FishStealSetting;
  /** Big bites: now and then while live, a random active chatter can reel in a trophy with the code shown on the overlay. */
  bigBite: FishBigBiteSetting;
}

/**
 * Our addition. While the stream is live and a fishing overlay is showing, a random
 * chatter from the last `activeMinutes` gets a big bite about every `everyMinutes`
 * (never within 10 minutes of the last): chat says something big is on their line,
 * and the overlay alone shows a two-digit reel code. Reeling it in takes `pulls`
 * codes in a row: `windowSeconds` for the first, `pullSeconds` for each after. The
 * last pull lands a trophy (Mythic) by that trophy's land chance, or it snaps free.
 */
export interface FishBigBiteSetting {
  enabled: boolean;
  everyMinutes: number;
  activeMinutes: number;
  windowSeconds: number;
  pulls: number;
  pullSeconds: number;
  /** From the second pull, the overlay shows the code this long, then hides it; 0 keeps it shown. */
  flashSeconds: number;
}

/**
 * Stealing is our addition. A thief needs a grappling hook; every try uses one of
 * its tries. A try reaches for one random fish the target has held a while and works
 * by that fish's rarity. It burns a fee on that fish's value and the fishing
 * cooldown; a caught thief also pays a fine, set from the odds so the average try
 * loses edgePercent of what it could expect to win, whatever the fish. Nobody
 * receives either. The thief must hold the fee and fine for the target's costliest
 * fish, or the try only costs a hook use. A guard, priced on what the owner holds,
 * turns every try away for a while and also costs the thief only a hook use.
 */
export interface FishStealSetting {
  enabled: boolean;
  hookPrice: number;
  /** Tries one hook gives. */
  hookUses: number;
  /** Paid per try that goes ahead, win or lose: this share of the grabbed fish's value, at least feeMinimum. */
  feePercent: number;
  feeMinimum: number;
  /**
   * The thief's average loss, as a share of what a try could expect to win (chance x
   * value). A caught thief's fine is set so fee and fine together come to that,
   * at least fineMinimum.
   */
  edgePercent: number;
  fineMinimum: number;
  /** Success chance in percent by the fish's rarity, as the channel's odds name it. */
  oddsCommon: number;
  oddsUncommon: number;
  oddsRare: number;
  oddsEpic: number;
  oddsLegendary: number;
  /** A fish can't be stolen until its owner has held it this long. */
  graceMinutes: number;
  /** After a try that went ahead (stolen or caught), the target is left alone this long. */
  protectMinutes: number;
  /** A guard costs this share of the owner's held fish value, at least guardMinimum. */
  guardPercent: number;
  guardMinimum: number;
  guardHours: number;
}

/** A fishing reel: a one-off purchase that improves casts and traps from then on. */
export interface FishReelSetting {
  name: string;
  price: number;
  /** Multiplies the chance a cast or a trap roll lands a fish. */
  oddsMultiplier: number;
  /** Multiplies the odds of every fish rarer than the most common ones. */
  rarityMultiplier: number;
  /** Multiplies what fish sell for. Junk is unaffected. */
  valueMultiplier: number;
}

export interface FishCatchSetting {
  /** The emoji, which is also the item's name in chat. */
  name: string;
  type: 'fish' | 'junk';
  /** Chance weight within its type, up to two decimals: lower is rarer, 0 is never caught. */
  weight: number;
  /** What one sells for. A sized fish's length and a record still scale it. */
  price: number;
  defaultWeight: number;
  defaultPrice: number;
  /** A big bite trophy: its weight is a share of big bites, not of casts. */
  trophy?: boolean;
}

/** Per-item overrides by emoji. */
export type StoredFishCatches = Record<string, { weight?: number; price?: number }>;

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
  raffle: PointsRaffleConfig;
  games: PointsGamesConfig;
}

/** The `points` block as stored in a channel config: any subset of the fields. */
export type StoredPointsConfig = Partial<Omit<PointsConfig, 'bonuses' | 'give' | 'timeoutPenalty' | 'gamble' | 'duel' | 'raffle' | 'games'>> & {
  bonuses?: Partial<PointsBonusesConfig>;
  give?: Partial<PointsGiveConfig>;
  timeoutPenalty?: Partial<PointsTimeoutPenaltyConfig>;
  gamble?: Partial<PointsGambleConfig>;
  duel?: Partial<PointsDuelConfig>;
  raffle?: Partial<PointsRaffleConfig>;
  games?: Partial<Omit<PointsGamesConfig, 'catches' | 'steal' | 'bigBite'>> & { catches?: StoredFishCatches; steal?: Partial<FishStealSetting>; bigBite?: Partial<FishBigBiteSetting> };
  /** Staging only, set by editing the file: treat the channel as live. Never exposed by the API. */
  debugForceLive?: boolean;
  /** Staging only, set by editing the file: who can test stealing and big bites (see InternalPointsConfig). */
  debugFishTesters?: string[];
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
   * points   — give the redeemer `amount` of the channel's loyalty currency.
   */
  action: 'timeout' | 'roulette' | 'pardon' | 'shield' | 'points';
  /** points only: how much of the channel currency the redeemer gets. */
  amount?: number;
  /**
   * Most redemptions per stream (offline time counts as its own window per day).
   * Kick has no limits of its own, so the bot pauses the reward on Kick once it's
   * reached, refunds any that slip in first, and unpauses it when a new window
   * starts. 0 or absent is no limit.
   */
  maxPerStream?: number;
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
  /**
   * When the reward can be redeemed; the bot pauses it on Kick the rest of the
   * time and refunds any redemption that lands then. Absent: 'live', or 'always'
   * where pauseWhenOffline is false (the older setting).
   */
  availability?: 'always' | 'live' | 'offline';
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

export type VanishResult =
  | { ok: true; deleted: number }
  | { ok: false; error: string };

export interface ClientWrapper {
  say(channel: string, msg: string): Promise<void>;
  /** Time a user out through Kick's API. Absent where the bot cannot moderate. */
  timeout?(request: TimeoutRequest): Promise<TimeoutResult>;
  /** Delete a chatter's own recent messages, for everyone. Absent where the bot cannot moderate. */
  vanish?(username: string): Promise<VanishResult>;
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
