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
  /** Absent from a bot service older than anti-spam. */
  antiSpam?: PointsAntiSpam;
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
  /** The reverse: only while offline. Never on together with onlyWhileLive. Absent from an older bot service. */
  onlyWhileOffline?: boolean;
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
  /** Fishing replies go to chat. They always go to the fishing overlay; off, chat only gets them offline or with no overlay showing. Absent from an older bot service. */
  chatReplies?: boolean;
  /** The fishing overlay's &demo=1 may play; off, overlays ignore it. Absent from an older bot service. */
  overlayDemo?: boolean;
  /** How big the fishing overlay draws, as a percentage (50–300). Absent from an older bot service. */
  overlaySizePercent?: number;
  /** The bottom-right corner the fishing overlay keeps clear, as shares of its width and height (0–80; both above 0 to apply). Absent from an older bot service. */
  overlayClearWidthPercent?: number;
  overlayClearHeightPercent?: number;
  /** How far the stream runs behind chat, in seconds (0–30): the overlay runs this far ahead, and big bite, wheel and duel timing allow for it. Absent from an older bot service. */
  streamDelaySeconds?: number;
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

/** What spamming a keyword costs: each keyword message past `threshold` inside `windowMinutes` costs `cost`. */
export interface PointsAntiSpam {
  enabled: boolean;
  /** Lowercase words or phrases, matched whole; an emote's name works too. */
  keywords: string[];
  threshold: number;
  windowMinutes: number;
  cost: number;
  /** A viewer who can't cover the cost is timed out this long; 0 only takes what they have. Absent from an older bot service. */
  timeoutMinutes?: number;
  announce: boolean;
}

/** Omitted keys are left alone; nested blocks merge rather than replace. */
export type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "timeoutPenalty" | "antiSpam" | "gamble" | "duel" | "raffle" | "games">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
  antiSpam?: Partial<PointsAntiSpam>;
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
  /** The Commands tab. Absent from an older bot service. */
  commands?: PublicCommands | null;
}

/** The currency commands a channel's viewers can use, for the features it has on. */
export interface PublicCommands {
  /** The command word with its $, e.g. "$don". */
  command: string;
  sections: PublicCommandSection[];
}

export interface PublicCommandSection {
  title: string;
  note?: string;
  rows: PublicCommandRow[];
}

export interface PublicCommandRow {
  usage: string;
  /** The same command typed short. */
  short?: string;
  does: string;
  /** Who may use it when it isn't everyone. */
  who?: "subs" | "vips" | "mods" | "streamer";
}

export interface PublicCatch {
  emoji: string;
  /** Share of fish (or junk) catches, in percent. */
  chance: number;
  rarity: "Common" | "Uncommon" | "Rare" | "Epic" | "Legendary" | "Mythic" | "Never";
  /** A big bite trophy: its chance is a share of big bites. */
  trophy?: boolean;
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
  trophy?: boolean;
}

export interface PublicDuels {
  totals: { duels: number; wagered: number; fishTaken: number };
  champions: Array<{ name: string; wins: number; losses: number }>;
  recent: Array<{ winner: string; loser: string; winnerFish: string; loserFish: string; stake: "friendly" | "wager" | "keeps"; amount: number | null; at: string }>;
}

export interface PublicFishing {
  /** 1 in this many plain casts lands a fish. */
  catchOdds: number;
  fish: PublicCatch[];
  junk: PublicCatch[];
  /** The rarest fish landed, rarest first. Empty from a bot service older than it. */
  rarest: PublicRareCatch[];
  /** The fish each viewer holds unsold, most valuable haul first. Absent from a bot service older than it. */
  holders?: PublicHolder[];
  /** Whether viewers can steal fish here. Absent from a bot service older than stealing. */
  steal?: boolean;
  /** Every steal ranked; null before the first one. Absent from a bot service older than it. */
  heists?: PublicHeists | null;
  /** Whether viewers can duel their fish here. Absent from a bot service older than duels. */
  duel?: boolean;
  /** Fish duels fought; null before the first one. Absent from a bot service older than them. */
  duels?: PublicDuels | null;
  /** Big bite trophies, chances as shares of big bites. Absent from a bot service older than them. */
  trophies?: PublicCatch[];
  /** About one big bite every this many live minutes; null where they're off. */
  bigBite?: { everyMinutes: number } | null;
}

/** One viewer's unsold fish: each kind with how many, rarest first, and what the lot would sell for. */
export interface PublicHolder {
  name: string;
  fish: Array<{ emoji: string; n: number; rarity: PublicCatch["rarity"] }>;
  count: number;
  worth: number;
}

/** The Fishing tab's heists. Names only, as everywhere on the public page. */
export interface PublicHeists {
  totals: { attempts: number; stolen: number; caught: number; guarded: number; burned: number };
  thieves: Array<{ name: string; stolen: number; attempts: number; loot: number }>;
  shame: Array<{ name: string; caught: number; fines: number }>;
  biggest: Array<{ thief: string; victim: string; fish: string; cm: number | null; worth: number; at: string }>;
  robbed: Array<{ name: string; lost: number; value: number }>;
  fortKnox: Array<{ name: string; turnedAway: number }>;
  blotter: Array<{ thief: string; victim: string; fish: string; outcome: "stolen" | "caught"; at: string }>;
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

  // Every call carries the secret: the bot service wants it on reads too (2026-10-16 audit).
  if (!INTERNAL_SECRET) {
    throw new BotApiError("INTERNAL_API_SECRET is not configured on the dashboard", 503);
  }

  const headers: Record<string, string> = { "x-internal-secret": INTERNAL_SECRET };
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";

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

/** A channel's prize wheel (the bot's data/wheel/<channel>.json). */
export interface WheelConfig {
  items: WheelItem[];
  spinSeconds: number;
  removeWinner: boolean;
  /** Bumped on every change, chat's included: a save names the one it loaded. */
  version: number;
  limits?: { maxItems: number; maxLabel: number; spinSeconds: { min: number; max: number } };
}

export function getWheel(channel: string): Promise<WheelConfig> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/wheel`);
}

/** Refused with 409 when chat changed the wheel since `version` was loaded. */
export function saveWheel(
  channel: string,
  wheel: Pick<WheelConfig, "items" | "spinSeconds" | "removeWinner" | "version">,
): Promise<WheelConfig & { ok: true }> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/wheel`, { method: "PUT", body: wheel });
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

/** One flag on a possible cheater, with the numbers behind it (the bot's community/cheat-signals.ts). */
export interface CheatFlag {
  code: "fast_answers" | "instant_traps" | "no_sleep" | "clockwork_casts" | "parked_don";
  label: string;
  evidence: string;
}

export interface CheatSuspect {
  userId: number;
  username: string;
  flags: CheatFlag[];
  casts: number;
  trapHauls: number;
  checks: { asked: number; passed: number; wrongTries: number; failed: number };
  lastSeen: number;
}

export interface CheatSuspects {
  days: number;
  suspects: CheatSuspect[];
}

export function getCheatSuspects(channel: string, days: number): Promise<CheatSuspects> {
  return request(`/internal/bot/${encodeURIComponent(channel)}/points/suspects?days=${days}`);
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
  kind: "catch" | "trap" | "miss" | "steal" | "caught" | "bite" | "duel" | "wheel" | "info";
  text: string;
  item?: string;
  rarity?: string;
  emotes?: Record<string, string>;
  /** A big bite's reel code, shown only on the overlay. */
  code?: string;
  /** How long the overlay shows a flashing code after first drawing it (ms); absent, it stays shown. */
  flashMs?: number;
  /** When a big bite gets away (ms since epoch, the bot's clock). */
  until?: number;
  /** When a big bite's first code opens to snipers (ms since epoch, the bot's clock). */
  snipeAt?: number;
  /** Which pull of a big bite this code is for, of how many. */
  pull?: number;
  pulls?: number;
  /** A fish duel, for the overlay to play back. */
  duel?: FishDuel;
  /** A spin of the prize wheel. */
  wheel?: FishOverlayWheel;
}

/** One slice of the prize wheel. `color` is #rrggbb; absent, the overlay picks one. */
export interface WheelItem {
  label: string;
  color?: string;
}

/** A wheel spin as the bot rolled it: the slices, the winning index, how long it spins (ms). */
export interface FishOverlayWheel {
  items: WheelItem[];
  winner: number;
  spinMs: number;
}

export type FishDuelType = "Predator" | "Swift" | "Armored";

export interface FishDuelSide {
  user: string;
  fish: string;
  /** null for a fish with no length. */
  cm: number | null;
  type: FishDuelType;
  rarity: string;
  hp: number;
}

/** A fish duel as the bot rolled it: a is the challenger, b the one who accepted. */
export interface FishDuel {
  a: FishDuelSide;
  b: FishDuelSide;
  /** Each hit: who struck (0 is a), the damage, 0 a miss / 1 a hit / 2 a critical, and 1 / 0 / -1 for a type advantage, none, or a disadvantage. */
  turns: Array<[by: 0 | 1, damage: number, hit: 0 | 1 | 2, edge: 1 | 0 | -1]>;
  winner: 0 | 1;
  stake: "friendly" | "wager" | "keeps";
  /** A wager's size and the channel's currency name. */
  amount?: number;
  currency?: string;
}

export interface FishOverlayFeed {
  lastId: number;
  events: FishOverlayEvent[];
  /** The bot's clock when it answered (ms), so a big bite's countdown runs on the bot's time. */
  now?: number;
  /** False when the channel has shut the overlay's demo out (games.overlayDemo). */
  demo?: boolean;
  /** How big the channel wants the overlay drawn, as a percentage (games.overlaySizePercent); absent means 100. */
  size?: number;
  /** The bottom-right corner the overlay keeps clear, as percentages of its width and height; absent means none. */
  clear?: { w: number; h: number };
  /** How far ahead to run the overlay's clock (ms): the stream's delay (games.streamDelaySeconds); absent means 0. */
  leadMs?: number;
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
  grant: { accessToken: string; refreshToken: string; expiresIn: number; userId: number },
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
