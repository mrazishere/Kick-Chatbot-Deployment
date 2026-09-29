import "server-only";

/**
 * Thin client for the bot enrollment service's internal management API
 * (Kick-Chatbot-Deployment/src/mr-ai-bot-enrollment.ts). That service owns pm2,
 * the ecosystem file and the channel configs; this dashboard never touches them
 * directly, so there is exactly one implementation of "add/remove/restart a bot".
 *
 * The API is loopback-only and requires the shared secret on mutating calls.
 */

const BOT_API_URL = process.env.BOT_API_URL ?? "http://127.0.0.1:3006";
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";
/** Long enough for a rewards reload, which makes several Kick calls with 10s timeouts each. */
const REQUEST_TIMEOUT_MS = 30_000;

export interface BotTokenHealth {
  hasChannelOAuth: boolean;
  accessTokenExpiresAt: number | null;
  grantExpiresAt: number | null;
  grantDaysLeft: number | null;
}

export interface LocationFields {
  country?: string;
  city?: string;
  state?: string;
  province?: string;
}

export interface ChannelLocation {
  home: LocationFields;
  current: LocationFields;
}

export interface AutoTranslateSettings {
  enabled?: boolean;
  minConfidence?: number;
  minLength?: number;
  rateLimitPerMinute?: number;
  logOnly?: boolean;
  /**
   * Source languages to translate, as ISO-639 codes. Empty or absent means every
   * language but English. A non-empty list also lets the bot pick up plain-ASCII
   * text (German without umlauts), which it otherwise cannot tell from English.
   */
  languages?: string[];
}

export interface KppSettings {
  enabled?: boolean;
  dollarPerScore?: number | null;
  chatNormalRate?: number;
  centsPerViewerHour?: number | null;
  centsPerAuthViewerHour?: number | null;
}

/** Every field this endpoint accepts is optional; omitted keys are left alone. */
export interface SettingsPatch {
  chatOnly?: boolean;
  location?: { home?: LocationFields; current?: LocationFields };
  autoTranslate?: AutoTranslateSettings;
  kpp?: KppSettings;
  claude?: ClaudeConfig;
  earnings?: EarningsSettings;
  points?: PointsSettingsPatch;
}

export interface PointsBonuses {
  /** Once per viewer, ever. */
  follow: number;
  subNew: number;
  subRenewal: number;
  /** To the gifter, per sub gifted. */
  giftSubGifterPerSub: number;
  /** To each viewer who received a gifted sub. */
  giftSubRecipient: number;
  pointsPerKick: number;
  onlyWhileLive: boolean;
  announce: boolean;
}

export interface PointsGive {
  enabled: boolean;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  cooldownSeconds: number;
}

/** A channel's loyalty points settings, with the bot's defaults already applied. */
export interface PointsConfig {
  enabled: boolean;
  currencyName: string;
  /** null means the command is derived from the currency name. */
  currencyCommand: string | null;
  /** The chat command the bot actually answers, without the "!". */
  effectiveCommand: string;
  pointsPerInterval: number;
  intervalMinutes: number;
  activeWindowMinutes: number;
  subscriberMultiplier: number;
  excludeBroadcaster: boolean;
  ignoreUsers: string[];
  bonuses: PointsBonuses;
  give: PointsGive;
  modMaxAdjust: number;
  publicLeaderboard: boolean;
  timeoutPenalty: PointsTimeoutPenalty;
  /** Absent from a bot service older than the gamble game. */
  gamble?: PointsGamble;
  /** Absent from a bot service older than duels. */
  duel?: PointsDuel;
  /** Absent from a bot service older than raffles. */
  raffle?: PointsRaffle;
  /** Absent from a bot service older than fishing. */
  games?: PointsGames;
}

/**
 * `$<cmd> fish`: supibot's fishing game played for the channel currency. Bait is
 * bought and selling the catch pays out in it. Defaults are supibot's numbers.
 */
export interface PointsGames {
  enabled: boolean;
  /** Casting and laying traps only while live; selling and stats work any time. */
  onlyWhileLive: boolean;
  /** 1 in this many unbaited casts lands a fish. */
  catchOdds: number;
  catchCooldownMinutes: number;
  trapMinutes: number;
  /** Sell prices as a percentage of supibot's (fish 50, junk 1–20). */
  sellPricePercent: number;
  /** Bait prices as a percentage of supibot's (worm 2, fly 5, cricket 8). */
  baitPricePercent: number;
  /** A short AI story on 1 in 3 catches. */
  stories: boolean;
  /** Cast results and trap hauls go to chat. They always go to the fishing overlay; other fishing replies always go to chat. Absent from an older bot service. */
  chatReplies?: boolean;
}

/**
 * `$<cmd> raffle <prize> [seconds]`: a moderator opens it, viewers enter free with
 * `$<cmd> join`, and the prize is paid when it closes. The prize is minted, not taken
 * from anyone, which is what the three caps are for.
 */
export interface PointsRaffle {
  enabled: boolean;
  minPrize: number;
  /** 0 means no maximum. */
  maxPrize: number;
  /** 0 means no limit. */
  maxPerStream: number;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  /** How many share a `raffle`; `sraffle` always draws one. */
  winners: number;
  onlyWhileLive: boolean;
}

/** `$<cmd> gamble <amount>`: even money at one win chance for the whole channel. */
export interface PointsGamble {
  enabled: boolean;
  /** 0–100, the same for every viewer; each gamble is its own roll. */
  winChancePercent: number;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  cooldownSeconds: number;
  onlyWhileLive: boolean;
}

/** Channel-wide gamble results from the ledger. `net` is what viewers gained (negative: lost) in total. */
export interface PointsGambleStats {
  gambles: number;
  wins: number;
  staked: number;
  net: number;
}

/** `$<cmd> duel @user <amount>`: viewer against viewer, 50/50, winner takes both stakes. */
export interface PointsDuel {
  enabled: boolean;
  minAmount: number;
  /** 0 means no maximum. */
  maxAmount: number;
  /** Per challenger. */
  cooldownSeconds: number;
  /** Time the opponent has to answer before the stake is refunded. */
  expirySeconds: number;
  onlyWhileLive: boolean;
}

/** Duels played, what both sides put in, and how many are waiting for an answer. */
export interface PointsDuelStats {
  duels: number;
  staked: number;
  pending: number;
}

/** What a timeout costs the viewer who got it, scaled per second. */
export interface PointsTimeoutPenalty {
  enabled: boolean;
  pointsPerSecond: number;
  /** 0 means no cap. */
  maxDeduction: number;
  /** Flat cost of a permanent ban, which has no duration. 0 ignores them. */
  permanentBanCost: number;
  announce: boolean;
}

/** Omitted keys are left alone; nested blocks merge rather than replace. */
export type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "timeoutPenalty" | "gamble" | "duel" | "raffle" | "games">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
  gamble?: Partial<PointsGamble>;
  duel?: Partial<PointsDuel>;
  raffle?: Partial<PointsRaffle>;
  games?: Partial<PointsGames>;
};

export interface PointsSubscriptionStatus {
  ok: boolean;
  error?: string;
  at: string;
}

export interface PointsSummary {
  enabled: boolean;
  currencyName: string;
  effectiveCommand: string;
  dbAvailable: boolean;
  users: number;
  totalPoints: number;
  lastTickAt: string | null;
  lastTickUsers: number | null;
  /** Keyed by Kick event name; empty until the bot service has subscribed. */
  subscriptions: Record<string, PointsSubscriptionStatus>;
  /** Absent from a bot service older than the gamble game. thisStream is null while offline. */
  gamble?: { allTime: PointsGambleStats; thisStream: PointsGambleStats | null };
  /** Absent from a bot service older than duels. thisStream is null while offline. */
  duel?: { allTime: PointsDuelStats; thisStream: PointsDuelStats | null };
}

export interface PointsUserRow {
  userId: number;
  username: string;
  balance: number;
  watchSeconds: number;
  rank: number;
  lastSeenAt: string | null;
}

export interface PointsLedgerEntry {
  id: number;
  ts: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  actor: string | null;
  note: string | null;
  /**
   * The other side of the event, where there is one: who a give went to or came
   * from, who a duel was against. Null for a row that has no second party, and
   * absent from a bot service older than this field.
   */
  counterparty?: string | null;
}

export interface PointsUserDetail {
  user: PointsUserRow & {
    lifetimeEarned: number;
    isSub: boolean;
    followBonusAt: string | null;
    firstSeenAt: string;
  };
  /** Gamble results, all time. Absent from a bot service older than this field. */
  gamble?: { gambles: number; wins: number; staked: number; net: number };
  /** Newest first, at most 50. */
  ledger: PointsLedgerEntry[];
}

export type PointsAdjustMode = "add" | "remove" | "set";

export interface PointsAdjustInput {
  userId: number;
  mode: PointsAdjustMode;
  amount: number;
  reason: string;
  actor: { username: string; role: "owner" | "admin" | "manager" };
  /** Makes the change idempotent: a retry with the same id is not applied twice. */
  requestId: string;
}

export interface PointsLeaderboardEntry {
  rank: number;
  username: string;
  /** Points, or seconds of active time (chatting while live). */
  value: number;
  /** The fishing reel they hold, by name. Absent when they have none. */
  reel?: string;
}

export interface PointsLeaderboard {
  channel: string;
  currencyName: string;
  updatedAt: string;
  points: PointsLeaderboardEntry[];
  watchtime: PointsLeaderboardEntry[];
  /** The Fishing tab. Null or absent where fishing is off, or from an older bot service. */
  fishing?: PublicFishing | null;
}

export interface PublicCatch {
  emoji: string;
  /** Share of fish (or junk) catches, in percent. */
  chance: number;
  rarity: "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary" | "Never";
  price: number;
}

/** One kind of fish someone has landed, for the Fishing tab's rarest catches. */
export interface PublicRareCatch {
  emoji: string;
  chance: number;
  rarity: PublicCatch["rarity"];
  times: number;
  firstBy: string;
  firstAt: string;
  lastBy: string;
  lastAt: string;
}

export interface PublicFishing {
  /** 1 in this many plain casts lands a fish. */
  catchOdds: number;
  fish: PublicCatch[];
  junk: PublicCatch[];
  /** The rarest fish landed, rarest first. Empty from a bot service older than it. */
  rarest: PublicRareCatch[];
}

export interface EarningsSettings {
  enabled?: boolean;
  centsPerViewerHour?: number;
}

interface ClaudeSettings {
  rateLimit?: number;
  burstRequests?: number;
  cooldownMinutes?: number;
}

export interface ClaudeConfig {
  /** null means "use the bot's global default prompt". */
  systemPrompt?: string | null;
  context?: string;
  settings?: ClaudeSettings;
  vision?: { enabled?: boolean };
}

export interface BotChannel {
  channel: string;
  exists: boolean;
  deployed: boolean;
  status: string;
  uptimeMs: number | null;
  restarts: number | null;
  unstableRestarts: number | null;
  memoryBytes: number | null;
  cpu: number | null;
  broadcasterUserId: number | null;
  chatroomId: number | null;
  chatOnly: boolean;
  enrolledAt: string | null;
  lastUpdated: string | null;
  excludedCommands: string[];
  managers: string[];
  location: ChannelLocation;
  autoTranslate: AutoTranslateSettings | null;
  claude: ClaudeConfig | null;
  earnings: EarningsSettings | null;
  claudeDefaults?: ClaudeSettings;
  kpp: KppSettings | null;
  /** Loyalty points settings with defaults applied. Absent from bot services older than points. */
  points?: PointsConfig | null;
  /**
   * Set while a stop by the owner or an admin is in force — managers can't start
   * the bot until the broadcaster does. Absent from bot services older than this.
   */
  stopped?: { by: string | null; at: string } | null;
  token: BotTokenHealth;
  availableCommands?: string[];
}

export interface BotChannelList {
  channels: BotChannel[];
  availableCommands: string[];
  maxChannels: number;
}

export class BotApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BotApiError";
  }
}

async function request<T>(
  path: string,
  init?: { method?: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const method = init?.method ?? "GET";
  const mutating = method !== "GET";

  if (mutating && !INTERNAL_SECRET) {
    throw new BotApiError("INTERNAL_API_SECRET is not configured on the dashboard", 503);
  }

  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (mutating) headers["x-internal-secret"] = INTERNAL_SECRET;

  let res: Response;
  try {
    res = await fetch(`${BOT_API_URL}${path}`, {
      method,
      headers,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      // Without a limit a hung service held every page render and auth check open
      // indefinitely; nginx gave up at 60s but the handlers kept waiting.
      signal: AbortSignal.timeout(init?.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    // The detail (including the internal address) goes to the server log, not the browser.
    console.error(`[bot-api] ${method} ${path} failed:`, e);
    throw new BotApiError(
      timedOut
        ? "The bot service took too long to answer — try again in a moment"
        : "Cannot reach the bot service — is Kick-Bot-Enrollment running?",
      timedOut ? 504 : 502,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // fall through — non-JSON body is reported as-is below
  }

  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text.slice(0, 200) || res.statusText;
    // Only the service's shared-secret check answers 401. Passed through as-is, the
    // browser showed a dashboard misconfiguration the same way as "Not signed in".
    if (res.status === 401) {
      console.error(`[bot-api] ${method} ${path} — the bot service rejected INTERNAL_API_SECRET: ${detail}`);
      throw new BotApiError("The dashboard can't authenticate to the bot service — check INTERNAL_API_SECRET", 502);
    }
    throw new BotApiError(detail, res.status);
  }

  return parsed as T;
}

export function listChannels(): Promise<BotChannelList> {
  return request<BotChannelList>("/internal/bot/channels");
}

export function getChannel(channel: string): Promise<BotChannel> {
  return request<BotChannel>(`/internal/bot/${encodeURIComponent(channel)}`);
}

/** `actor` lets the service record who stopped a bot and hold managers to the same rules. */
export function controlBot(
  channel: string,
  action: "start" | "stop" | "restart",
  actor: { username: string; role: "owner" | "admin" | "manager" },
): Promise<BotChannel & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/control`, {
    method: "POST",
    body: { action, actor },
  });
}

export function setExcludedCommands(
  channel: string,
  excludedCommands: string[],
): Promise<BotChannel & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/commands`, {
    method: "POST",
    body: { excludedCommands },
  });
}

export type CustomCommandAccess = "n" | "v" | "y";

export interface CustomCommand {
  name: string;
  /** n = everyone, v = VIPs and up, y = moderators and up. */
  access: CustomCommandAccess;
  response: string;
  counter: number;
}

export interface CustomCommandInput {
  name: string;
  access: CustomCommandAccess;
  response: string;
  /** Omit to keep the stored count. */
  counter?: number;
  /** The command's current name when editing; omit when adding. */
  originalName?: string;
}

export function getCustomCommands(channel: string): Promise<{ commands: CustomCommand[] }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/custom-commands`);
}

export function saveCustomCommand(
  channel: string,
  command: CustomCommandInput,
): Promise<{ ok: true; commands: CustomCommand[] }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/custom-commands`, {
    method: "POST",
    body: command,
  });
}

export function deleteCustomCommand(
  channel: string,
  name: string,
): Promise<{ ok: true; commands: CustomCommand[] }> {
  return request(
    `/internal/bot/${encodeURIComponent(channel)}/custom-commands/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export type RewardActionKind = "timeout" | "roulette" | "pardon" | "shield";

/** The bot action attached to a reward, as stored in the channel config. */
export interface RewardActionConfig {
  rewardId?: string;
  rewardTitle?: string;
  action: RewardActionKind;
  durationSeconds?: number;
  reflect?: boolean;
  announce?: boolean;
  testMode?: boolean;
  testDurationSeconds?: number;
  testRedeemers?: string[];
}

/** A reward as Kick has it, plus what the bot does with it. */
export interface ChannelRewardRow {
  id: string;
  title: string;
  cost: number;
  description: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
  /** false when Kick says another app owns the reward, so only its bot action can be changed here. */
  canManage: boolean;
  action: RewardActionConfig | null;
  /** false when the action only matches by title (older config). */
  actionPinned: boolean;
}

export interface ChannelRewards {
  rewards: ChannelRewardRow[];
  /** Actions for rewards that no longer exist on Kick. */
  orphaned: RewardActionConfig[];
  /** Scopes on the streamer's grant; empty when they couldn't be checked. */
  scopes: string[];
}

export function getRewards(channel: string): Promise<ChannelRewards> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/rewards`);
}

/**
 * Reward writes get longer: a Kick call plus a list reload, each with 10s timeouts.
 * Timing out at 30s after Kick had already created a reward invited a retry that
 * created a second. Stays under nginx's 60s proxy timeout.
 */
const REWARD_WRITE_TIMEOUT_MS = 55_000;

export function createReward(
  channel: string,
  payload: { reward: Record<string, unknown>; action: Record<string, unknown> | null },
): Promise<ChannelRewards & { ok: true; id: string }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/rewards`, {
    method: "POST",
    body: payload,
    timeoutMs: REWARD_WRITE_TIMEOUT_MS,
  });
}

export function updateReward(
  channel: string,
  rewardId: string,
  payload: { reward?: Record<string, unknown>; action?: Record<string, unknown> | null },
): Promise<ChannelRewards & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/rewards/${encodeURIComponent(rewardId)}`, {
    method: "PATCH",
    body: payload,
    timeoutMs: REWARD_WRITE_TIMEOUT_MS,
  });
}

export function deleteReward(channel: string, rewardId: string): Promise<ChannelRewards & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/rewards/${encodeURIComponent(rewardId)}`, {
    method: "DELETE",
    timeoutMs: REWARD_WRITE_TIMEOUT_MS,
  });
}

export function getPointsSummary(channel: string): Promise<PointsSummary> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points`);
}

/** Prefix search on username; an empty query returns the top balances. */
export function searchPointsUsers(
  channel: string,
  q: string,
  limit = 20,
): Promise<{ users: PointsUserRow[] }> {
  const query = new URLSearchParams({ q, limit: String(limit) });
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/users?${query.toString()}`);
}

export function getPointsUser(channel: string, userId: number): Promise<PointsUserDetail> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/users/${userId}`);
}

export function adjustPoints(
  channel: string,
  input: PointsAdjustInput,
): Promise<{ ok: true; applied: boolean; user: PointsUserRow }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/adjust`, {
    method: "POST",
    body: input,
  });
}

export interface PointsResetResult {
  ok: true;
  /** false when this requestId was already applied and nothing changed. */
  applied: boolean;
  users: number;
  total: number;
  duelsCancelled: number;
  /** File name of the backup taken just before the reset. */
  backup: string;
}

/** Zero every balance in the channel. The bot backs the database up first. */
export function resetPoints(
  channel: string,
  input: { reason: string; actor: { username: string; role: string }; requestId: string },
): Promise<PointsResetResult> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/reset`, {
    method: "POST",
    body: input,
  });
}

/**
 * The public top lists. No secret needed, and a short timeout: this backs a page
 * anyone can open, which should say "unavailable" quickly rather than hang.
 */
export interface PublicHistoryEntry {
  id: number;
  ts: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  actor: string | null;
  note: string | null;
  counterparty: string | null;
}

/** One viewer's $DON history for the public leaderboard. */
export interface PublicHistory {
  channel: string;
  currencyName: string;
  username: string;
  balance: number;
  rank: number | null;
  watchSeconds: number;
  /** $DON from chatting while live, which the ledger doesn't list. It plus every entry equals the balance. */
  activeTimeEarned: number;
  totals: { reason: string; total: number; count: number }[];
  ledgerCount: number;
  ledger: PublicHistoryEntry[];
  lifetimeEarned: number;
  isSub: boolean;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  gamble: { gambles: number; wins: number; staked: number; net: number } | null;
}

/** A viewer in the public leaderboard's list; no ids. */
export interface PublicViewer {
  rank: number | null;
  username: string;
  balance: number;
  watchSeconds: number;
  reel?: string;
}

export function getPublicViewers(channel: string, q: string): Promise<{ currencyName: string; viewers: PublicViewer[] }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/public-viewers?q=${encodeURIComponent(q)}`, {
    timeoutMs: 10_000,
  });
}

export function getPublicHistory(channel: string, name: string): Promise<PublicHistory> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/public-history?name=${encodeURIComponent(name)}`, {
    timeoutMs: 10_000,
  });
}

/** One fish reply on the overlay. */
export interface FishOverlayEvent {
  id: number;
  ts: number;
  username: string;
  kind: "catch" | "trap" | "miss" | "info";
  text: string;
  item?: string;
  rarity?: string;
  emotes?: Record<string, string>;
}

export interface FishOverlayFeed {
  lastId: number;
  events: FishOverlayEvent[];
}

export function getFishOverlay(channel: string): Promise<FishOverlayFeed> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/overlay/fishing`, { timeoutMs: 5_000 });
}

export function getPointsLeaderboard(channel: string, limit = 100): Promise<PointsLeaderboard> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/leaderboard?limit=${limit}`, {
    timeoutMs: 10_000,
  });
}

export function updateSettings(
  channel: string,
  patch: SettingsPatch,
): Promise<BotChannel & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/settings`, {
    method: "POST",
    body: patch,
  });
}

/**
 * Hand a freshly-issued streamer grant to the bot service for an already-enrolled
 * channel. Resets that channel's 30-day grant clock. Throws BotApiError with
 * status 404 when the channel isn't enrolled — callers treat that as "nothing to
 * refresh" rather than an error.
 */
export function storeChannelGrant(
  channel: string,
  grant: { accessToken: string; refreshToken: string; expiresIn: number },
): Promise<BotChannel & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/oauth`, {
    method: "POST",
    body: grant,
  });
}

export function getManagers(
  channel: string,
): Promise<{ channel: string; managers: string[]; suggestions: string[]; seeded: boolean }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/managers`);
}

/** Additive merge of observed moderators into the manager list. */
export function syncManagers(
  channel: string,
): Promise<BotChannel & { ok: true; added: string[] }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/managers/sync`, {
    method: "POST",
  });
}

export function setManagers(
  channel: string,
  managers: string[],
): Promise<BotChannel & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/managers`, {
    method: "POST",
    body: { managers },
  });
}

export function channelsManagedBy(
  username: string,
): Promise<{ username: string; channels: string[] }> {
  return request(`/internal/bot/managed-by/${encodeURIComponent(username)}`);
}

export interface ReachableChannel {
  channel: string;
  isSelf: boolean;
}

/** Own channel plus any channel that lists this user as a manager. */
export function channelsReachableBy(
  username: string,
): Promise<{ username: string; channels: ReachableChannel[] }> {
  return request(`/internal/bot/reachable-by/${encodeURIComponent(username)}`);
}

export function removeBot(channel: string): Promise<{ ok: true; channel: string }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}`, { method: "DELETE" });
}

export function getLogs(channel: string, lines = 100): Promise<{ lines: string[] }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/logs?lines=${lines}`);
}

/**
 * The clip session's health. !clip drives Kick's internal API with a browser
 * session token, which is a different credential from the OAuth token the
 * dashboard logs in with and can't be derived from it — so it is pasted by hand.
 * The token itself is never sent back to the browser.
 */
export interface ClipSessionStatus {
  healthy: boolean;
  hasToken: boolean;
  lastVerifyAt: number | null;
  lastReason: string | null;
  tokenSavedAt: number | null;
}

export async function getClipSession(): Promise<ClipSessionStatus> {
  return request<ClipSessionStatus>("/internal/clip-session");
}

export async function setClipToken(token: string): Promise<ClipSessionStatus & { ok: true }> {
  return request<ClipSessionStatus & { ok: true }>("/internal/clip-session", { method: "POST", body: { token } });
}
