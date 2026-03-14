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
