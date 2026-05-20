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
  [key: string]: unknown;
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
  lastPolledAt: string;       // ISO — last successful poll
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
