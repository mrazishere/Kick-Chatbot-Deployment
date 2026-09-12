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
}

/** What a timeout costs the viewer who got it, scaled per second. */
export interface PointsTimeoutPenalty {
  enabled: boolean;
  pointsPerSecond: number;
  /** 0 means no cap. */
  maxDeduction: number;
  includeBotTimeouts: boolean;
  /** Flat cost of a permanent ban, which has no duration. 0 ignores them. */
  permanentBanCost: number;
  announce: boolean;
}

/** Omitted keys are left alone; nested blocks merge rather than replace. */
export type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "timeoutPenalty">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
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
}

export interface PointsUserDetail {
  user: PointsUserRow & {
    lifetimeEarned: number;
    isSub: boolean;
    followBonusAt: string | null;
    firstSeenAt: string;
  };
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
}

export interface PointsLeaderboard {
  channel: string;
  currencyName: string;
  updatedAt: string;
  points: PointsLeaderboardEntry[];
  watchtime: PointsLeaderboardEntry[];
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

/**
 * The public top lists. No secret needed, and a short timeout: this backs a page
 * anyone can open, which should say "unavailable" quickly rather than hang.
 */
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
