"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertTriangle, Check, ChevronDown, KeyRound,
  Gift, MapPin, Pencil, Play, Plus, Power, RefreshCw, ScrollText, ShieldCheck, Sparkles, Terminal, Trash2, Users, X,
} from "lucide-react";
import SiteHeader from "./SiteHeader";
import PointsCard, { type PointsConfig } from "./PointsCard";
import ClipSessionCard from "./ClipSessionCard";
import { Button, Card, Checkbox, Stat, Toggle } from "./ui";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const ENROLL_URL = "/kick-bot-enroll/start";
const KICK_GREEN = "#53FC18";

interface LocationFields {
  country?: string;
  city?: string;
  state?: string;
  province?: string;
}

export interface ChannelLocation {
  home: LocationFields;
  current: LocationFields;
}

interface AutoTranslateSettings {
  enabled?: boolean;
  minConfidence?: number;
  minLength?: number;
  rateLimitPerMinute?: number;
  logOnly?: boolean;
  languages?: string[];
}

interface KppSettings {
  enabled?: boolean;
  dollarPerScore?: number | null;
  chatNormalRate?: number;
  centsPerViewerHour?: number | null;
  centsPerAuthViewerHour?: number | null;
}

interface EarningsSettings {
  enabled?: boolean;
  centsPerViewerHour?: number;
}

interface ClaudeSettings {
  rateLimit?: number;
  burstRequests?: number;
  cooldownMinutes?: number;
}

interface ClaudeConfig {
  /** null means "use the bot's global default prompt". */
  systemPrompt?: string | null;
  context?: string;
  settings?: ClaudeSettings;
  vision?: { enabled?: boolean };
}

interface TokenHealth {
  hasChannelOAuth: boolean;
  accessTokenExpiresAt: number | null;
  grantExpiresAt: number | null;
  grantDaysLeft: number | null;
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
  /** Loyalty points settings with defaults applied; absent from bot services older than points. */
  points?: PointsConfig | null;
  /** A stop by the owner or an admin still in force; absent from older bot services. */
  stopped?: { by: string | null; at: string } | null;
  token: TokenHealth;
}

type CustomCommandAccess = "n" | "v" | "y";

interface CustomCommand {
  name: string;
  access: CustomCommandAccess;
  response: string;
  counter: number;
}

const ACCESS_LABEL: Record<CustomCommandAccess, string> = {
  n: "Everyone",
  v: "VIPs & mods",
  y: "Mods only",
};

/** The add/edit form. `originalName` is null while adding a new command. */
interface CustomCommandDraft {
  originalName: string | null;
  name: string;
  access: CustomCommandAccess;
  response: string;
  counter: string;
}

type RewardActionKind = "timeout" | "roulette" | "pardon" | "shield" | "points";

interface RewardActionConfig {
  rewardId?: string;
  rewardTitle?: string;
  action: RewardActionKind;
  durationSeconds?: number;
  /** points only. */
  amount?: number;
  reflect?: boolean;
  announce?: boolean;
  testMode?: boolean;
  testDurationSeconds?: number;
  testRedeemers?: string[];
}

interface ChannelRewardRow {
  id: string;
  title: string;
  cost: number;
  description: string;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_user_input_required: boolean;
  should_redemptions_skip_request_queue: boolean;
  canManage: boolean;
  action: RewardActionConfig | null;
  actionPinned: boolean;
}

interface ChannelRewards {
  rewards: ChannelRewardRow[];
  orphaned: RewardActionConfig[];
  scopes: string[];
}

const REWARD_ACTION_META: Record<RewardActionKind, { label: string; description: string }> = {
  timeout: { label: "Timeout", description: "Times out the username the viewer types." },
  roulette: { label: "Roulette", description: "50/50: times out the username typed, or the viewer who redeemed it." },
  pardon: {
    label: "Get out of jail",
    description:
      "Lifts a timeout the bot gave out, on the username typed, or on the redeemer if left blank. Never lifts a moderator's own timeout or ban.",
  },
  shield: { label: "Shield", description: "Other viewers' timeout and roulette rewards can't hit the redeemer while it lasts." },
  points: {
    label: "Give loyalty points",
    description:
      "Gives the redeemer this much of the channel's loyalty currency (e.g. $DON). It stays available while the stream is offline, and a redemption is only ever paid once.",
  },
};

type DurationUnit = "s" | "m" | "h";
const UNIT_SECONDS: Record<DurationUnit, number> = { s: 1, m: 60, h: 3600 };

/** The reward form. `id` is null while creating a new reward on Kick. */
interface RewardDraft {
  id: string | null;
  canManage: boolean;
  title: string;
  cost: string;
  description: string;
  color: string;
  enabled: boolean;
  paused: boolean;
  inputRequired: boolean;
  skipQueue: boolean;
  actionKind: RewardActionKind | "";
  duration: string;
  unit: DurationUnit;
  amount: string;
  reflect: boolean;
  announce: boolean;
  testMode: boolean;
  testDuration: string;
  testRedeemers: string;
}

function formatSeconds(s: number): string {
  if (s >= 3600 && s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60 && s % 60 === 0) return `${s / 60}m`;
  if (s > 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}

function describeRewardAction(a: RewardActionConfig): string {
  const meta = REWARD_ACTION_META[a.action];
  if (!meta) return String(a.action);
  if (a.action === "points") return `${meta.label} · ${(a.amount ?? 0).toLocaleString("en-US")}`;
  const length = a.action !== "pardon" && a.durationSeconds ? ` · ${formatSeconds(a.durationSeconds)}` : "";
  const reflect = a.action === "shield" && a.reflect ? " · bounces back" : "";
  return `${meta.label}${length}${reflect}`;
}

function draftFromReward(r: ChannelRewardRow | null): RewardDraft {
  const a = r?.action ?? null;
  const secs = a?.durationSeconds ?? 0;
  const unit: DurationUnit = !secs ? "m" : secs % 3600 === 0 ? "h" : secs % 60 === 0 ? "m" : "s";
  return {
    id: r?.id ?? null,
    canManage: r ? r.canManage : true,
    title: r?.title ?? "",
    cost: r ? String(r.cost) : "1000",
    description: r?.description ?? "",
    color: r?.background_color || KICK_GREEN,
    enabled: r ? r.is_enabled : true,
    paused: r ? r.is_paused : false,
    inputRequired: r ? r.is_user_input_required : true,
    skipQueue: r ? r.should_redemptions_skip_request_queue : false,
    actionKind: a?.action ?? "",
    duration: secs ? String(secs / UNIT_SECONDS[unit]) : "",
    unit,
    amount: a?.amount ? String(a.amount) : "",
    reflect: a?.reflect ?? false,
    announce: a ? a.announce !== false : true,
    testMode: a?.testMode ?? false,
    testDuration: a?.testDurationSeconds ? String(a.testDurationSeconds) : "",
    testRedeemers: (a?.testRedeemers ?? []).join(", "),
  };
}

interface CommandMeta {
  label: string;
  trigger: string;
  description: string;
}

// Kept in sync with src/lib/command-meta.ts — duplicated rather than imported so
// this stays a pure client component with no server-only dependency chain.
const COMMAND_META: Record<string, CommandMeta> = {
  autotranslate: { label: "Auto Translate", trigger: "automatic", description: "Translates non-English chat automatically." },
  blerp: { label: "Blerp", trigger: "!blerp", description: "Clips the stream and suggests it as a sound for the streamer's Blerp soundboard. Mods and above." },
  catfacts: { label: "Cat Facts", trigger: "!catfacts", description: "Random cat fact." },
  chatsummary: { label: "Chat Summary", trigger: "!chatsummary / !catchup", description: "Summarises the last 30 minutes of chat with AI for people who just arrived. Once a minute per channel." },
  claude: { label: "Claude AI", trigger: "!claude", description: "Ask the AI. Uses chat history and channel lore." },
  clip: { label: "Clip", trigger: "!clip [45s]", description: "Clips the last 30 seconds of the stream, or 5–90 with e.g. !clip 45s, and posts the link." },
  cookie: { label: "Fortune Cookie", trigger: "!cookie", description: "supibot's cookie: one fortune a day (a golden second one for subscribers), gift it with !cookie donate, !cookie stats and top." },
  countd: { label: "Countdown", trigger: "!countd", description: "Countdown timer overlay." },
  customC: { label: "Custom Commands", trigger: "!acomm / !dcomm / !counter", description: "Channel-defined text commands. !counter name shows a command's count without adding to it." },
  dad: { label: "Dad Jokes", trigger: "!dad", description: "Random dad joke." },
  dictionary: { label: "Dictionary", trigger: "!define", description: "Word definitions." },
  dogfacts: { label: "Dog Facts", trigger: "!dogfacts", description: "Random dog fact." },
  earnings: { label: "Earnings", trigger: "!earnings", description: "Estimated stream earnings." },
  fish: { label: "Fishing", trigger: "$<currency> fish", description: "supibot's fishing game for points: cast, sell, show, stats, top, trap. Needs points and Fishing on (Points settings)." },
  followage: { label: "Followage", trigger: "!followage / !subage / !accountage", description: "How long someone has followed or subscribed here, and how old their Kick account is." },
  fx: { label: "Currency", trigger: "!fx", description: "Live currency conversion." },
  hallofshame: { label: "Hall of Shame", trigger: "!hallofshame", description: "Most-trolled AI users leaderboard." },
  jokes: { label: "Jokes", trigger: "!jokes", description: "Random joke." },
  kpp: { label: "KPP Estimate", trigger: "!kpp", description: "Kick Partner Program earnings estimate." },
  lastseen: { label: "Last Seen", trigger: "!lastseen / !firstseen", description: "When someone last or first chatted in this channel. Switching it off also stops recording." },
  minigames: { label: "Mini Games", trigger: "!8ball !roll !coinflip !pick !percent", description: "Small chance commands with no stakes." },
  numfacts: { label: "Number Facts", trigger: "!numfacts", description: "Trivia about a number." },
  ping: { label: "Ping", trigger: "!ping", description: "Health check — confirms the bot is alive." },
  points: { label: "Loyalty Points", trigger: "$<currency>, e.g. $don", description: "Balances, active time, top 5, and broadcaster adjustments." },
  pokecatch: { label: "Pokécatch", trigger: "!catch", description: "Pokémon catching mini-game." },
  remind: { label: "Remind", trigger: "!remind / !unremind", description: "Leave someone a message for when they next chat, or set a timed reminder." },
  slots: { label: "Slots", trigger: "!slots", description: "supibot's slots: roll your words or the channel's emotes (pattern:7tv, pattern:kick) for a flush. No stakes." },
  topc: { label: "Top Chatters", trigger: "!topc", description: "Most active chatters." },
  translate: { label: "Translate", trigger: "!translate", description: "On-demand translation." },
  weather: { label: "Weather", trigger: "!weather", description: "Current weather for a location." },
};

// Offered under the auto-translate toggle. Codes are what Google reports as the
// detected source, so they have to be plain ISO-639 — the bot compares them
// literally. Kept to the languages this bot's channels actually see.
const LANGUAGE_CHOICES: Array<{ code: string; label: string }> = [
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pt", label: "Portuguese" },
  { code: "tr", label: "Turkish" },
  { code: "ru", label: "Russian" },
  { code: "ar", label: "Arabic" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "th", label: "Thai" },
  { code: "vi", label: "Vietnamese" },
  { code: "ms", label: "Malay" },
  { code: "id", label: "Indonesian" },
];

function languageLabel(code: string): string {
  return LANGUAGE_CHOICES.find((l) => l.code === code)?.label ?? code.toUpperCase();
}

function meta(name: string): CommandMeta {
  return COMMAND_META[name] ?? { label: name, trigger: `!${name.toLowerCase()}`, description: "No description available." };
}

function formatUptime(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatMemory(bytes: number | null): string {
  if (bytes === null) return "—";
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------------------------------------------------------- primitives */
// Card, Stat, Button, Checkbox and Toggle live in ./ui so other cards can share them.

function LivePill({ isLive, viewers }: { isLive: boolean; viewers: number }) {
  if (!isLive) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-3 py-1 text-xs font-medium text-neutral-400">
        <span className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
        Stream offline
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-[#53FC18]/30 bg-[#53FC18]/10 px-3 py-1 text-xs font-medium text-[#53FC18]">
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#53FC18] opacity-75" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#53FC18]" />
      </span>
      LIVE
      {viewers > 0 ? <span className="font-normal opacity-80">{viewers.toLocaleString()}</span> : null}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; dot: string }> = {
    online: { label: "Bot online", className: "border-[#53FC18]/30 bg-[#53FC18]/10 text-[#53FC18]", dot: "bg-[#53FC18]" },
    stopped: { label: "Bot stopped", className: "border-amber-700/40 bg-amber-950/40 text-amber-400", dot: "bg-amber-400" },
    errored: { label: "Bot errored", className: "border-red-800/50 bg-red-950/40 text-red-400", dot: "bg-red-400" },
    "not-deployed": { label: "Bot not deployed", className: "border-neutral-700 bg-neutral-900 text-neutral-400", dot: "bg-neutral-500" },
  };
  const s = map[status] ?? { label: status, className: "border-neutral-700 bg-neutral-900 text-neutral-400", dot: "bg-neutral-500" };
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${s.className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

/* ------------------------------------------------------------------- main UI */

export default function BotManager({
  channel, username, avatarUrl, channelAvatarUrl, isAdmin, role, canAdminister,
  initialBot, availableCommands, initialManagers, managerSuggestions, managersError, switcher,
  isLive, viewerCount, loadError, initialCustomCommands, customCommandsError,
}: {
  channel: string;
  username: string;
  avatarUrl: string | null;
  /** The channel's own photo, for the header. */
  channelAvatarUrl: string | null;
  isAdmin: boolean;
  role: "owner" | "admin" | "manager";
  /** Owner/admin only: remove, stop, re-authorize, and edit the manager list. */
  canAdminister: boolean;
  initialBot: BotChannel | null;
  availableCommands: string[];
  initialManagers: string[];
  managerSuggestions: string[];
  /** Set when the manager list couldn't be loaded. Editing is then off, since a save replaces the whole list. */
  managersError: string | null;
  /** Every bot this user can reach, own channel included — shown in the header. */
  switcher: { channel: string; isSelf: boolean }[];
  /** Whether the CHANNEL is streaming — not whether the bot process is up. */
  isLive: boolean;
  viewerCount: number;
  loadError: string | null;
  initialCustomCommands: CustomCommand[];
  customCommandsError: string | null;
}) {
  const [bot, setBot] = useState<BotChannel | null>(initialBot);
  const [error, setError] = useState<string | null>(loadError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Command toggles are staged locally so a channel can flip several at once
  // and apply them in one restart, rather than bouncing the bot per toggle.
  const [excluded, setExcluded] = useState<Set<string>>(new Set(initialBot?.excludedCommands ?? []));
  // Auto-translate's language list is edited as a draft: picking three languages
  // should cost one save, and one bot restart, not three.
  const [langDraft, setLangDraft] = useState<string[]>(initialBot?.autoTranslate?.languages ?? []);
  // Location is a form rather than a toggle, so it stages locally until saved.
  const [location, setLocation] = useState<ChannelLocation>(
    initialBot?.location ?? { home: {}, current: {} },
  );
  const [managers, setManagers] = useState<string[]>(initialManagers);
  const [managerInput, setManagerInput] = useState("");
  // Shown inside the managers card: the page-level banner is at the top and this
  // card sits near the bottom, so a top-only notice reads as "nothing happened".
  const [managerNotice, setManagerNotice] = useState<string | null>(null);
  const [managersLoadError, setManagersLoadError] = useState<string | null>(managersError);
  const [claude, setClaude] = useState<ClaudeConfig>(initialBot?.claude ?? {});
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [live, setLive] = useState({ isLive, viewers: viewerCount });
  const [commandsOpen, setCommandsOpen] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>(initialCustomCommands);
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<CustomCommandDraft | null>(null);
  const [confirmDeleteCommand, setConfirmDeleteCommand] = useState<string | null>(null);
  // Kept in the card for the same reason as managerNotice: the page banner is off-screen from here.
  const [customError, setCustomError] = useState<string | null>(customCommandsError);
  // Rewards load from Kick after the page renders, so a slow Kick never holds the page up.
  const [rewards, setRewards] = useState<ChannelRewards | null>(null);
  const [rewardsError, setRewardsError] = useState<string | null>(null);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [rewardDraft, setRewardDraft] = useState<RewardDraft | null>(null);
  const [confirmDeleteReward, setConfirmDeleteReward] = useState<string | null>(null);

  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);

  // autotranslate has no trigger — it runs on every message and is controlled by
  // the Settings toggle. Listing it here too gave two controls for one feature.
  // Except once it's excluded: then this list is the only place to turn it back on.
  const SETTINGS_MANAGED = useMemo(() => new Set(["autotranslate"]), []);
  const listedCommands = useMemo(
    () => availableCommands.filter((c) => !SETTINGS_MANAGED.has(c) || (bot?.excludedCommands ?? []).includes(c)),
    [availableCommands, SETTINGS_MANAGED, bot],
  );

  const savedLangKey = useMemo(
    () => (bot?.autoTranslate?.languages ?? []).map((l) => l.toLowerCase()).sort().join(","),
    [bot],
  );
  // Adopt the server's list when it actually changes — a save, or a switch to
  // another channel. The status poll re-renders with an equal list, which no-ops.
  useEffect(() => {
    setLangDraft(savedLangKey ? savedLangKey.split(",") : []);
  }, [savedLangKey]);
  const langDirty = useMemo(
    () => [...langDraft].sort().join(",") !== savedLangKey,
    [langDraft, savedLangKey],
  );

  const commandsDirty = useMemo(() => {
    const saved = new Set(bot?.excludedCommands ?? []);
    if (saved.size !== excluded.size) return true;
    for (const c of excluded) if (!saved.has(c)) return true;
    return false;
  }, [bot, excluded]);

  const locationDirty = useMemo(() => {
    const saved = bot?.location ?? { home: {}, current: {} };
    for (const which of ["home", "current"] as const) {
      for (const field of ["country", "city", "state", "province"] as const) {
        if ((location[which]?.[field] ?? "") !== (saved[which]?.[field] ?? "")) return true;
      }
    }
    return false;
  }, [bot, location]);

  const claudeDirty = useMemo(() => {
    const saved = bot?.claude ?? {};
    return (
      (claude.systemPrompt ?? "") !== (saved.systemPrompt ?? "") ||
      (claude.context ?? "") !== (saved.context ?? "") ||
      (claude.settings?.rateLimit ?? "") !== (saved.settings?.rateLimit ?? "") ||
      (claude.settings?.burstRequests ?? "") !== (saved.settings?.burstRequests ?? "") ||
      (claude.settings?.cooldownMinutes ?? "") !== (saved.settings?.cooldownMinutes ?? "")
    );
  }, [bot, claude]);

  // Bumped as each request starts and finishes, so a background poll already in
  // flight can tell its answer is older than what's on screen.
  const requestSeq = useRef(0);

  const call = useCallback(
    async (
      key: string,
      path: string,
      init?: RequestInit,
      /** Where a failure is shown instead of the page banner, for cards far down the page. */
      onError: (message: string) => void = setError,
    ): Promise<unknown | null> => {
      setBusy(key);
      setError(null);
      requestSeq.current++;
      try {
        const res = await fetch(`${BASE_PATH}/api/bot/${channel}${path}`, {
          headers: { "Content-Type": "application/json" },
          ...init,
        });
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (!res.ok) {
          onError(body?.error ?? `Request failed (${res.status})`);
          return null;
        }
        return body;
      } catch (e) {
        onError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        requestSeq.current++;
        setBusy(null);
      }
    },
    [channel],
  );

  const refresh = useCallback(async () => {
    const data = (await call("refresh", "")) as
      | (BotChannel & { live?: { isLive: boolean; viewers: number } })
      | null;
    if (data) {
      setBot(data);
      setExcluded(new Set(data.excludedCommands));
      if (data.live) setLive(data.live);
    }
  }, [call]);

  // Poll status quietly in the background so the pills stay honest without the
  // user reloading. Deliberately silent: no spinner, and errors are swallowed,
  // because a transient blip shouldn't throw a banner over whatever they're editing.
  useEffect(() => {
    const tick = async () => {
      const seq = requestSeq.current;
      try {
        const res = await fetch(`${BASE_PATH}/api/bot/${channel}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as BotChannel & {
          live?: { isLive: boolean; viewers: number };
        };
        // A Start or Restart that finished while this poll was out already showed
        // fresher status; this answer would put the old one back for a minute.
        if (seq !== requestSeq.current) return;
        if (data.live) setLive(data.live);
        // Only the read-only status fields — never clobber a form being edited.
        setBot((prev) =>
          prev
            ? {
                ...prev,
                status: data.status,
                uptimeMs: data.uptimeMs,
                restarts: data.restarts,
                unstableRestarts: data.unstableRestarts,
                memoryBytes: data.memoryBytes,
                cpu: data.cpu,
                token: data.token,
              }
            : prev,
        );
      } catch {
        // Offline or a restart in progress — try again next tick.
      }
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [channel]);

  const control = useCallback(
    async (action: "start" | "stop" | "restart") => {
      const data = (await call(action, "/control", {
        method: "POST",
        body: JSON.stringify({ action }),
      })) as BotChannel | null;
      if (data) {
        setBot(data);
        flash(`Bot ${action === "stop" ? "stopped" : action === "start" ? "started" : "restarted"}.`);
      }
    },
    [call, flash],
  );

  // Custom commands save one at a time and apply immediately — the bot reads the
  // file on every chat message — so there's nothing to stage and no restart.
  const customCall = useCallback(
    async (key: string, query: string, init?: RequestInit): Promise<CustomCommand[] | null> => {
      setBusy(key);
      setCustomError(null);
      try {
        const res = await fetch(`${BASE_PATH}/api/bot/${channel}/custom-commands${query}`, {
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          ...init,
        });
        const body = (await res.json().catch(() => null)) as
          | { error?: string; commands?: CustomCommand[] }
          | null;
        if (!res.ok || !body?.commands) {
          setCustomError(body?.error ?? `Request failed (${res.status})`);
          return null;
        }
        setCustomCommands(body.commands);
        return body.commands;
      } catch (e) {
        setCustomError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [channel],
  );

  /** Why the draft can't be saved yet. `message` is null when it's just incomplete. */
  const draftProblem = useMemo((): { message: string | null } | null => {
    if (!draft) return null;
    if (draft.name.length > 0 && draft.name.length < 3) {
      return { message: "Command names need at least 3 letters or digits." };
    }
    if (draft.name !== draft.originalName && customCommands.some((c) => c.name === draft.name)) {
      return { message: `!${draft.name} already exists.` };
    }
    if (!/^\d+$/.test(draft.counter.trim())) return { message: "Uses must be a whole number." };
    const response = draft.response.trim();
    if (
      /^\/timeout\b/i.test(response) &&
      !/^\/timeout\s+@*(\$user1|\$user2|[A-Za-z0-9_]{2,25})\s+\d{1,6}[smhd]?(\s|$)/i.test(response)
    ) {
      return { message: "A /timeout response needs a user and a duration, e.g. /timeout $user1 1m" };
    }
    if (!draft.name || !draft.response.replace(/[<>]/g, "").trim()) return { message: null };
    return null;
  }, [draft, customCommands]);

  const saveCustomDraft = useCallback(async () => {
    if (!draft) return;
    const original = draft.originalName
      ? customCommands.find((c) => c.name === draft.originalName)
      : undefined;
    const counter = Number(draft.counter.trim());
    const payload = {
      name: draft.name,
      access: draft.access,
      response: draft.response,
      ...(draft.originalName ? { originalName: draft.originalName } : {}),
      // Only send the count when it was changed here, so uses racked up in chat
      // since this page loaded aren't overwritten by a stale number.
      ...(counter !== original?.counter ? { counter } : {}),
    };
    const saved = await customCall("custom-save", "", { method: "POST", body: JSON.stringify(payload) });
    if (saved) {
      setDraft(null);
      flash(`!${payload.name} ${draft.originalName ? "updated" : "added"} — live in chat now.`);
    }
  }, [customCall, customCommands, draft, flash]);

  const deleteCustom = useCallback(
    async (name: string) => {
      const left = await customCall("custom-delete", `?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      setConfirmDeleteCommand(null);
      if (left) flash(`!${name} deleted.`);
    },
    [customCall, flash],
  );

  // From the polled summary, not the initial one. Authorizing in another tab flips
  // the card to its rewards view on the next poll; keyed to the initial value, this
  // load never ran and "Loading rewards from Kick…" stayed up for good.
  const hasChannelOAuth = bot?.token.hasChannelOAuth ?? false;

  useEffect(() => {
    if (!hasChannelOAuth) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/bot/${channel}/rewards`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (ChannelRewards & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !body?.rewards) setRewardsError(body?.error ?? `Could not load rewards (${res.status})`);
        else setRewards({ rewards: body.rewards, orphaned: body.orphaned ?? [], scopes: body.scopes ?? [] });
      } catch (e) {
        if (!cancelled) setRewardsError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channel, hasChannelOAuth]);

  const rewardsCall = useCallback(
    async (key: string, path: string, init?: RequestInit): Promise<ChannelRewards | null> => {
      setBusy(key);
      setRewardsError(null);
      try {
        const res = await fetch(`${BASE_PATH}/api/bot/${channel}/rewards${path}`, {
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          ...init,
        });
        const body = (await res.json().catch(() => null)) as
          | (ChannelRewards & { error?: string; reloadFailed?: boolean })
          | null;
        // Kick took the change but the list couldn't be reloaded afterwards. Shown as a
        // failure, that invited a retry, which for a new reward created a second one.
        if (res.ok && body?.reloadFailed) {
          setRewardsError("Saved on Kick, but the reward list couldn't be reloaded — press Refresh.");
          return { rewards: [], orphaned: [], scopes: [] }; // truthy: the change went through
        }
        if (!res.ok || !body?.rewards) {
          setRewardsError(body?.error ?? `Request failed (${res.status})`);
          return null;
        }
        const next = { rewards: body.rewards, orphaned: body.orphaned ?? [], scopes: body.scopes ?? [] };
        setRewards(next);
        return next;
      } catch (e) {
        setRewardsError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [channel],
  );

  const patchRewardDraft = (change: Partial<RewardDraft>) =>
    setRewardDraft((d) => (d ? { ...d, ...change } : d));

  /** Why the reward form can't be saved yet. */
  const rewardDraftProblem = useMemo((): string | null => {
    const d = rewardDraft;
    if (!d) return null;
    if (d.canManage) {
      if (!d.title.trim() || d.title.trim().length > 50) return "Title must be 1–50 characters.";
      if (!/^\d+$/.test(d.cost.trim()) || Number(d.cost) < 1) return "Cost must be a whole number of points.";
      if (d.description.length > 200) return "Description must be 200 characters or fewer.";
    }
    if (d.actionKind === "points" && (!/^\d+$/.test(d.amount.trim()) || Number(d.amount) < 1)) {
      return "Set how much the redeemer gets, a whole number of 1 or more.";
    }
    if (d.actionKind && d.actionKind !== "pardon" && d.actionKind !== "points") {
      if (!/^\d+$/.test(d.duration.trim()) || Number(d.duration) < 1) return "Set how long it lasts.";
      if (Number(d.duration) * UNIT_SECONDS[d.unit] > 604800) return "The longest Kick allows is 7 days.";
    }
    if (d.actionKind && d.testMode) {
      const t = d.testDuration.trim();
      if (t && (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 3600)) return "Test length must be 1–3600 seconds.";
      const bad = d.testRedeemers.split(/[\s,]+/).filter(Boolean).find((u) => !/^@?[A-Za-z0-9_]{2,25}$/.test(u));
      if (bad) return `"${bad}" isn't a Kick username.`;
    }
    return null;
  }, [rewardDraft]);

  /** Allowed, but worth knowing before saving. */
  const rewardDraftWarnings = useMemo((): string[] => {
    const d = rewardDraft;
    if (!d || !d.actionKind) return [];
    const where = d.canManage ? "" : " — change it in the app that owns this reward";
    const warnings: string[] = [];
    if ((d.actionKind === "timeout" || d.actionKind === "roulette") && !d.inputRequired) {
      warnings.push(`Viewers have to type a username for this, so "Viewer must type something" should be on${where}.`);
    }
    if (d.skipQueue) {
      warnings.push(`This reward skips the request queue, so the bot can't refund a redemption that fails${where}.`);
    }
    return warnings;
  }, [rewardDraft]);

  const saveRewardDraft = useCallback(async () => {
    const d = rewardDraft;
    if (!d) return;
    const testers = d.testRedeemers.split(/[\s,]+/).filter(Boolean).map((u) => u.replace(/^@/, ""));
    const action = d.actionKind
      ? {
          action: d.actionKind,
          ...(d.actionKind !== "pardon" && d.actionKind !== "points" ? { durationSeconds: Number(d.duration) * UNIT_SECONDS[d.unit] } : {}),
          ...(d.actionKind === "points" ? { amount: Number(d.amount) } : {}),
          ...(d.actionKind === "shield" && d.reflect ? { reflect: true } : {}),
          announce: d.announce,
          ...(d.testMode
            ? {
                testMode: true,
                ...(d.testDuration.trim() ? { testDurationSeconds: Number(d.testDuration) } : {}),
                testRedeemers: testers,
              }
            : {}),
        }
      : null;
    const reward = d.canManage
      ? {
          title: d.title.trim(),
          cost: Number(d.cost),
          description: d.description,
          background_color: d.color.toUpperCase(),
          is_enabled: d.enabled,
          is_user_input_required: d.inputRequired,
          should_redemptions_skip_request_queue: d.skipQueue,
          ...(d.id ? { is_paused: d.paused } : {}),
        }
      : undefined;
    const saved = d.id
      ? await rewardsCall("reward-save", `/${d.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...(reward ? { reward } : {}), action }),
        })
      : await rewardsCall("reward-save", "", { method: "POST", body: JSON.stringify({ reward, action }) });
    if (saved) {
      setRewardDraft(null);
      flash(d.id ? `"${d.title}" saved — applies to the next redemption.` : `"${d.title}" created on Kick.`);
    }
  }, [rewardDraft, rewardsCall, flash]);

  const deleteReward = useCallback(
    async (r: ChannelRewardRow) => {
      const left = await rewardsCall("reward-delete", `/${r.id}`, { method: "DELETE" });
      setConfirmDeleteReward(null);
      if (left) flash(`"${r.title}" deleted from Kick.`);
    },
    [rewardsCall, flash],
  );

  const clearOrphanedAction = useCallback(
    async (rewardId: string) => {
      const left = await rewardsCall("reward-orphan", `/${rewardId}`, {
        method: "PATCH",
        body: JSON.stringify({ action: null }),
      });
      if (left) flash("Removed the bot action for a reward that no longer exists.");
    },
    [rewardsCall, flash],
  );

  const saveCommands = useCallback(async () => {
    const data = (await call("commands", "/commands", {
      method: "POST",
      body: JSON.stringify({ excludedCommands: Array.from(excluded) }),
    })) as BotChannel | null;
    if (data) {
      setBot(data);
      setExcluded(new Set(data.excludedCommands));
      flash("Commands saved — the bot is restarting to pick them up.");
    }
  }, [call, excluded, flash]);

  const saveSettings = useCallback(
    async (key: string, patch: Record<string, unknown>, message: string, resetForm?: "location" | "claude") => {
      const data = (await call(key, "/settings", {
        method: "POST",
        body: JSON.stringify(patch),
      })) as BotChannel | null;
      if (data) {
        setBot(data);
        // Only the form that was saved takes the server's copy. Resetting both on
        // every save threw away unsaved edits: toggling Vision mid-prompt lost the prompt.
        if (resetForm === "location") setLocation(data.location ?? { home: {}, current: {} });
        if (resetForm === "claude") setClaude(data.claude ?? {});
        flash(message);
      }
    },
    [call, flash],
  );

  const toggleChatOnly = useCallback(() => {
    if (!bot) return;
    void saveSettings(
      "chatOnly",
      { chatOnly: !bot.chatOnly },
      `Chat-only mode ${!bot.chatOnly ? "enabled" : "disabled"}.`,
    );
  }, [bot, saveSettings]);

  const saveClaude = useCallback(() => {
    void saveSettings(
      "claude",
      {
        claude: {
          // Empty textarea means "fall back to the bot's global prompt".
          systemPrompt: (claude.systemPrompt ?? "").trim() === "" ? null : claude.systemPrompt,
          context: claude.context ?? "",
          // A cleared box goes as null, which removes the override. Left out, the old value stayed.
          settings: {
            rateLimit: claude.settings?.rateLimit ?? null,
            burstRequests: claude.settings?.burstRequests ?? null,
            cooldownMinutes: claude.settings?.cooldownMinutes ?? null,
          },
        },
      },
      "AI settings saved — applies within 5 minutes, no restart.",
      "claude",
    );
  }, [claude, saveSettings]);

  const toggleVision = useCallback(() => {
    const next = !(bot?.claude?.vision?.enabled ?? false);
    void saveSettings(
      "vision",
      { claude: { vision: { enabled: next } } },
      `Vision ${next ? "enabled" : "disabled"}.`,
    );
  }, [bot, saveSettings]);

  const toggleEarnings = useCallback(() => {
    const next = !(bot?.earnings?.enabled ?? false);
    void saveSettings(
      "earnings",
      { earnings: { enabled: next } },
      `Earnings recording ${next ? "enabled" : "disabled"}.`,
    );
  }, [bot, saveSettings]);

  const toggleKpp = useCallback(() => {
    const next = !(bot?.kpp?.enabled ?? false);
    void saveSettings("kpp", { kpp: { enabled: next } }, `KPP recording ${next ? "enabled" : "disabled"}.`);
  }, [bot, saveSettings]);

  const saveLocation = useCallback(() => {
    void saveSettings("location", { location }, "Location saved.", "location");
  }, [location, saveSettings]);

  const toggleAutoTranslate = useCallback(() => {
    const next = !(bot?.autoTranslate?.enabled ?? false);
    void saveSettings(
      "autoTranslate",
      { autoTranslate: { enabled: next } },
      `Auto-translate ${next ? "enabled" : "disabled"}.`,
    );
  }, [bot, saveSettings]);

  const saveLanguages = useCallback(() => {
    const next = [...langDraft].sort();
    void saveSettings(
      "autoTranslate",
      { autoTranslate: { languages: next } },
      next.length === 0
        ? "Auto-translate set to any language."
        : `Auto-translate limited to ${next.map(languageLabel).join(", ")}.`,
    );
  }, [langDraft, saveSettings]);

  const saveManagers = useCallback(
    async (next: string[], message: string) => {
      // A save replaces the whole list, so a list that never loaded must not be saved over.
      if (managersLoadError) return;
      setManagerNotice(null);
      const data = (await call("managers", "/managers", {
        method: "POST",
        body: JSON.stringify({ managers: next }),
      }, setManagerNotice)) as BotChannel | null;
      if (data) {
        setManagers(data.managers ?? next);
        setManagerNotice(message);
        flash(message);
      }
    },
    [call, flash, managersLoadError],
  );

  const addManager = useCallback(
    (name: string) => {
      const clean = name.trim().toLowerCase().replace(/^@/, "");
      if (!clean) return;
      if (!/^[a-z0-9_]{1,25}$/.test(clean)) {
        setManagerNotice(`"${name.trim()}" is not a valid Kick username.`);
        return;
      }
      // The server drops the broadcaster's own name, after this card had already
      // announced them as a new manager.
      if (clean === channel) {
        setManagerNotice(`${clean} is the broadcaster and already has full access.`);
        return;
      }
      if (managers.includes(clean)) return;
      setManagerInput("");
      void saveManagers([...managers, clean], `${clean} can now manage the bot.`);
    },
    [channel, managers, saveManagers],
  );

  const syncManagersNow = useCallback(async () => {
    setManagerNotice(null);
    const data = (await call("sync", "/managers/sync", { method: "POST" }, setManagerNotice)) as
      | (BotChannel & { added?: string[] })
      | null;
    if (data) {
      // Sync only ever adds, and it answers with the real list, so it also recovers a list that failed to load.
      setManagersLoadError(null);
      setManagers(data.managers ?? []);
      const added = data.added ?? [];
      if (added.length > 0) {
        setManagerNotice(`Added ${added.length}: ${added.join(", ")}`);
        flash(`Added ${added.length} manager${added.length === 1 ? "" : "s"}.`);
      } else {
        // Say why, so "nothing to add" can't be mistaken for a dead button.
        setManagerNotice(
          "No new moderators found — nobody with a moderator badge has chatted in this channel since the bot joined (the bot's own account is ignored).",
        );
      }
    }
  }, [call, flash]);

  const remove = useCallback(async () => {
    const data = await call("remove", "", { method: "DELETE" });
    if (data) {
      setBot(null);
      setConfirmRemove(false);
      flash("Bot removed from this channel.");
    }
  }, [call, flash]);

  const loadLogs = useCallback(async () => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (!next) return;
    // Fetched on every open, since a log is only useful when it's current. Errors
    // show in this card: the page banner is far off-screen from here, and failing
    // there left "Loading…" up for good.
    setBusy("logs");
    setLogsError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/bot/${channel}/logs?lines=100`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { lines?: string[]; error?: string } | null;
      if (!res.ok || !body?.lines) setLogsError(body?.error ?? `Could not load logs (${res.status})`);
      else setLogs(body.lines);
    } catch (e) {
      setLogsError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [channel, logsOpen]);

  const grantDays = bot?.token.grantDaysLeft ?? null;
  const grantTone =
    grantDays === null ? "neutral" : grantDays <= 2 ? "danger" : grantDays <= 7 ? "warn" : "ok";
  // Kick authorization only ever applies to whoever signs in, so its buttons belong on your own channel.
  const isOwnChannel = username.toLowerCase() === channel;

  return (
    <div className="min-h-screen">
      {/* Shared nav — same on every signed-in page (see SiteHeader). */}
      <SiteHeader
        channel={channel}
        username={username}
        avatarUrl={avatarUrl}
        channelAvatarUrl={channelAvatarUrl}
        isAdmin={isAdmin}
        current="bot"
        switcher={switcher}
        showEarnings={canAdminister}
        status={
          <span className="flex flex-wrap items-center gap-2">
            {bot ? <StatusPill status={bot.status} /> : <StatusPill status="not-deployed" />}
            <LivePill isLive={live.isLive} viewers={live.viewers} />
          </span>
        }
      />

      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-8">
        <p className="text-sm text-neutral-500">
          Mr-AI-is-Here bot management
          {role !== "owner" ? (
            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
              {role === "admin" ? "admin view" : "manager access"}
            </span>
          ) : null}
        </p>
      </div>

      {/* banners */}
      {error ? (
        <div className="mb-5 flex items-start gap-3 rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-red-500 hover:text-red-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-[#53FC18]/30 bg-[#53FC18]/10 px-4 py-3 text-sm text-[#53FC18]">
          <Check className="h-4 w-4 shrink-0" />
          {notice}
        </div>
      ) : null}

      {!bot ? (
        <Card title="Bot not enrolled" icon={<Power className="h-4 w-4" />}>
          <p className="text-sm leading-relaxed text-neutral-400">
            The Mr-AI-is-Here bot is not running in <span className="text-neutral-200">{channel}</span> yet.
            Authorizing with Kick creates the bot, starts it, and gives it the bot badge in your chat.
          </p>
          {isOwnChannel ? (
            <div className="mt-4">
              <a
                href={ENROLL_URL}
                className="inline-flex items-center gap-2 rounded-lg bg-[#53FC18] px-4 py-2.5 text-sm font-semibold text-black transition hover:brightness-90"
              >
                <ShieldCheck className="h-4 w-4" />
                Add the bot to my channel
              </a>
            </div>
          ) : (
            <p className="mt-4 text-sm text-neutral-500">
              Only {channel} can add it: authorizing with Kick enrolls whichever account signs in.
            </p>
          )}
        </Card>
      ) : (
        <div className="space-y-5">
          {/* ---------------------------------------------------------- status */}
          <Card
            title="Bot status"
            icon={<Activity className="h-4 w-4" />}
            actions={
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={refresh} busy={busy === "refresh"} disabled={!!busy}>
                  <RefreshCw className="h-4 w-4" /> Refresh
                </Button>
                {bot.status === "online" ? (
                  <>
                    <Button onClick={() => control("restart")} busy={busy === "restart"} disabled={!!busy}>
                      <RefreshCw className="h-4 w-4" /> Restart
                    </Button>
                    {canAdminister ? (
                      <Button onClick={() => control("stop")} busy={busy === "stop"} disabled={!!busy}>
                        <Power className="h-4 w-4" /> Stop
                      </Button>
                    ) : null}
                  </>
                ) : (
                  <>
                    {/* A manager may start a bot that crashed, not one the broadcaster switched off. */}
                    {!canAdminister && bot.stopped ? (
                      <span className="text-xs text-neutral-500">
                        Stopped by {bot.stopped.by ?? "the broadcaster"} — only the broadcaster can start it
                      </span>
                    ) : null}
                    <Button
                      variant="primary"
                      onClick={() => control("start")}
                      busy={busy === "start"}
                      disabled={!!busy || (!canAdminister && !!bot.stopped)}
                    >
                      <Play className="h-4 w-4" /> Start
                    </Button>
                  </>
                )}
              </div>
            }
          >
            <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
              <Stat label="Uptime" value={formatUptime(bot.uptimeMs)} />
              <Stat label="Memory" value={formatMemory(bot.memoryBytes)} />
              <Stat
                label="Restarts"
                value={String(bot.restarts ?? "—")}
                tone={(bot.unstableRestarts ?? 0) > 0 ? "warn" : "default"}
              />
              <Stat label="Chatroom" value={bot.chatroomId ? String(bot.chatroomId) : "—"} />
            </dl>
            {(bot.unstableRestarts ?? 0) > 0 ? (
              <p className="mt-4 text-xs text-amber-500">
                {bot.unstableRestarts} unstable restart(s) — the bot crashed shortly after starting. Check the logs below.
              </p>
            ) : null}
          </Card>

          {/* ------------------------------------------------------ authorization */}
          <Card
            title="Kick authorization"
            icon={<KeyRound className="h-4 w-4" />}
            actions={
              // Only on your own channel. Enrollment authorizes whoever signs in to Kick,
              // so for an admin viewing another channel this renewed the admin's grant.
              isOwnChannel ? (
                <a
                  href={ENROLL_URL}
                  className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-3.5 py-2 text-sm font-medium text-neutral-200 transition hover:border-neutral-600 hover:bg-neutral-800"
                >
                  <ShieldCheck className="h-4 w-4" />
                  {bot.token.hasChannelOAuth ? "Re-authorize" : "Authorize"}
                </a>
              ) : null
            }
          >
            {bot.token.hasChannelOAuth ? (
              <>
                <div className="flex items-center gap-2 text-sm text-[#53FC18]">
                  <Check className="h-4 w-4" />
                  Streamer authorization active — the bot posts with the bot badge.
                </div>

                {grantDays !== null ? (
                  <div className="mt-4">
                    <div className="mb-1.5 flex items-baseline justify-between text-xs">
                      <span className="uppercase tracking-wider text-neutral-500">Authorization expires</span>
                      <span
                        className={
                          grantTone === "danger" ? "text-red-400" : grantTone === "warn" ? "text-amber-400" : "text-neutral-300"
                        }
                      >
                        {grantDays < 1 ? "less than a day" : `${Math.floor(grantDays)} days left`}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-neutral-800">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, Math.max(2, (grantDays / 30) * 100))}%`,
                          backgroundColor:
                            grantTone === "danger" ? "#f87171" : grantTone === "warn" ? "#fbbf24" : KICK_GREEN,
                        }}
                      />
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-neutral-500">
                      Kick authorizations last 30 days and cannot be extended by refreshing. When this runs out the bot
                      keeps working but loses the bot badge, so re-authorize before then.
                    </p>
                  </div>
                ) : null}

                <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4">
                  <Stat label="Authorized on" value={formatDate(bot.enrolledAt)} />
                  <Stat label="Last token refresh" value={formatDate(bot.lastUpdated)} />
                </dl>
              </>
            ) : (
              <>
                <div className="flex items-start gap-2 text-sm text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    No streamer authorization. The bot still replies in chat, but posts as a normal user — no bot badge,
                    and messages are limited to 10 special characters.
                  </span>
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {bot.enrolledAt
                    ? `Previously authorized on ${formatDate(bot.enrolledAt)}. Kick grants expire after 30 days.`
                    : "This channel has never completed the authorization flow."}
                </p>
              </>
            )}
          </Card>

          {/* -------------------------------------------------------- commands */}
          <Card
            title={`Commands (${listedCommands.filter((c) => !excluded.has(c)).length}/${listedCommands.length} enabled)`}
            icon={<Check className="h-4 w-4" />}
            actions={
              <div className="flex gap-2">
                {commandsDirty ? (
                  <>
                    <Button onClick={() => setExcluded(new Set(bot.excludedCommands))} disabled={!!busy}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={saveCommands} busy={busy === "commands"} disabled={!!busy}>
                      Save changes
                    </Button>
                  </>
                ) : null}
                <Button onClick={() => setCommandsOpen((v) => !v)} disabled={!!busy}>
                  <ChevronDown className={`h-4 w-4 transition-transform ${commandsOpen ? "rotate-180" : ""}`} />
                  {commandsOpen ? "Collapse" : "Edit"}
                </Button>
              </div>
            }
          >
            {listedCommands.length === 0 ? (
              <p className="text-sm text-neutral-500">No commands found. Has the bot been built?</p>
            ) : !commandsOpen ? (
              /* Collapsed: the only thing worth saying at a glance is what's OFF. */
              listedCommands.every((c) => !excluded.has(c)) ? (
                <p className="text-sm text-neutral-500">All {listedCommands.length} commands enabled.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-neutral-500">Disabled:</span>
                  {Array.from(excluded)
                    .filter((n) => !SETTINGS_MANAGED.has(n))
                    .sort()
                    .map((name) => (
                      <span
                        key={name}
                        title={meta(name).description}
                        className="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400"
                      >
                        {meta(name).trigger}
                      </span>
                    ))}
                </div>
              )
            ) : (
              <>
                <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
                  {listedCommands.map((name) => {
                    const m = meta(name);
                    const enabled = !excluded.has(name);
                    // Some commands only respond when their recording feature is on;
                    // without this the toggle looks live but the command stays silent.
                    const needs =
                      name === "earnings"
                        ? !(bot.earnings?.enabled ?? false) && "needs earnings recording"
                        : name === "kpp" || name === "topc"
                          ? !(bot.kpp?.enabled ?? false) && "needs KPP recording"
                          : false;
                    return (
                      <button
                        key={name}
                        type="button"
                        title={`${m.label} — ${m.description}`}
                        onClick={() =>
                          setExcluded((prev) => {
                            const next = new Set(prev);
                            if (next.has(name)) next.delete(name);
                            else next.add(name);
                            return next;
                          })
                        }
                        className={`flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-neutral-900 ${
                          enabled ? "" : "opacity-50"
                        }`}
                      >
                        <span
                          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                            enabled ? "border-[#53FC18] bg-[#53FC18]" : "border-neutral-600 bg-transparent"
                          }`}
                        >
                          {enabled ? <Check className="h-3 w-3 text-black" strokeWidth={3} /> : null}
                        </span>
                        <span className="truncate text-sm text-neutral-300">{m.label}</span>
                        {needs ? (
                          <span className="shrink-0 rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-500">
                            {needs}
                          </span>
                        ) : null}
                        <code className="ml-auto shrink-0 text-xs text-neutral-600">{m.trigger}</code>
                      </button>
                    );
                  })}
                </div>
                <p className="mt-4 text-xs text-neutral-500">
                  Hover a command for what it does. Saving restarts the bot so it can reload its command list.
                </p>
              </>
            )}
          </Card>

          {/* ------------------------------------------------- custom commands */}
          <Card
            title={`Custom commands (${customCommands.length})`}
            icon={<Terminal className="h-4 w-4" />}
            actions={
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setCustomOpen(true);
                    setConfirmDeleteCommand(null);
                    setDraft({ originalName: null, name: "", access: "n", response: "", counter: "0" });
                  }}
                  disabled={!!busy || draft !== null}
                >
                  <Plus className="h-4 w-4" /> Add
                </Button>
                {customCommands.length > 0 ? (
                  <Button onClick={() => setCustomOpen((v) => !v)} disabled={!!busy}>
                    <ChevronDown className={`h-4 w-4 transition-transform ${customOpen ? "rotate-180" : ""}`} />
                    {customOpen ? "Collapse" : "Manage"}
                  </Button>
                ) : null}
              </div>
            }
          >
            {customError ? (
              <div className="mb-4 flex items-start gap-2 text-sm text-red-400">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="flex-1">{customError}</span>
                <button
                  type="button"
                  onClick={() => void customCall("custom-reload", "")}
                  disabled={!!busy}
                  className="shrink-0 text-xs text-neutral-400 underline transition hover:text-neutral-200 disabled:opacity-40"
                >
                  Reload
                </button>
              </div>
            ) : null}

            {bot.excludedCommands.includes("customC") ? (
              <p className="mb-4 text-xs text-amber-500">
                The Custom Commands module is disabled under Commands above, so none of these respond in chat
                until it is re-enabled.
              </p>
            ) : null}

            {draft ? (
              <div className="mb-5 space-y-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
                <div className="text-sm font-medium text-neutral-200">
                  {draft.originalName ? `Edit !${draft.originalName}` : "New command"}
                </div>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Command</span>
                    <div className="flex items-center rounded-lg border border-neutral-700 bg-neutral-900 transition focus-within:border-neutral-500">
                      <span className="pl-3 text-sm text-neutral-500">!</span>
                      <input
                        type="text"
                        value={draft.name}
                        maxLength={25}
                        disabled={!!busy}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase() })
                        }
                        placeholder="crime"
                        className="w-full bg-transparent py-2 pl-0.5 pr-3 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 disabled:opacity-40"
                      />
                    </div>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Who can use it</span>
                    <select
                      value={draft.access}
                      disabled={!!busy}
                      onChange={(e) => setDraft({ ...draft, access: e.target.value as CustomCommandAccess })}
                      className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                    >
                      {(Object.keys(ACCESS_LABEL) as CustomCommandAccess[]).map((a) => (
                        <option key={a} value={a}>
                          {ACCESS_LABEL[a]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Uses</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={draft.counter}
                      disabled={!!busy}
                      onChange={(e) => setDraft({ ...draft, counter: e.target.value })}
                      className="w-24 tabular-nums rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Response</span>
                  <textarea
                    rows={3}
                    maxLength={500}
                    value={draft.response}
                    disabled={!!busy}
                    onChange={(e) => setDraft({ ...draft, response: e.target.value })}
                    placeholder={`${channel} has committed $counter crimes on stream`}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                  />
                  <div className="mt-1 flex justify-between gap-4 text-xs leading-relaxed text-neutral-600">
                    <span>
                      <code className="text-neutral-400">$counter</code> times used ·{" "}
                      <code className="text-neutral-400">$user1</code> who typed it ·{" "}
                      <code className="text-neutral-400">$user2</code> who they @mention ·{" "}
                      <code className="text-neutral-400">$percentage</code> random % ·{" "}
                      <code className="text-neutral-400">$streamerp</code> random %, huge for the streamer ·{" "}
                      <code className="text-neutral-400">$ynm</code> yes / no / maybe
                    </span>
                    <span className="shrink-0 tabular-nums">{draft.response.length}/500</span>
                  </div>
                </label>
                <p className="text-xs leading-relaxed text-neutral-500">
                  To time someone out, start the response with{" "}
                  <code className="text-neutral-400">/timeout $user1 1m</code> — the bot does it through Kick&apos;s API
                  instead of posting the text. Durations take s, m, h or d (a bare number is minutes), and anything
                  after the duration is posted to chat once it works. Only mods can time out someone other than
                  themselves. A response of <code className="text-neutral-400">/vanish</code> deletes the user&apos;s own
                  messages from the last 10 minutes for everyone, which a timeout on Kick doesn&apos;t: timed-out messages
                  come back when the page is reloaded.
                </p>
                {draftProblem?.message ? <p className="text-xs text-amber-500">{draftProblem.message}</p> : null}
                <div className="flex justify-end gap-2">
                  <Button onClick={() => setDraft(null)} disabled={busy === "custom-save"}>
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    onClick={saveCustomDraft}
                    busy={busy === "custom-save"}
                    disabled={!!busy || draftProblem !== null}
                  >
                    {draft.originalName ? "Save changes" : "Add command"}
                  </Button>
                </div>
              </div>
            ) : null}

            {customCommands.length === 0 ? (
              draft ? null : (
                <p className="text-sm text-neutral-500">
                  No custom commands yet. Add one here, or with{" "}
                  <code className="text-neutral-400">!acomm</code> in chat.
                </p>
              )
            ) : !customOpen ? (
              <div className="flex flex-wrap items-center gap-2">
                {customCommands.map((c) => (
                  <span
                    key={c.name}
                    title={c.response}
                    className="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400"
                  >
                    !{c.name}
                  </span>
                ))}
              </div>
            ) : (
              <>
                <ul className="divide-y divide-neutral-800">
                  {customCommands.map((c) => (
                    <li
                      key={c.name}
                      className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <code className="text-sm font-semibold text-neutral-200">!{c.name}</code>
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] ${
                              c.access === "n" ? "bg-neutral-800 text-neutral-400" : "bg-amber-950/50 text-amber-500"
                            }`}
                          >
                            {ACCESS_LABEL[c.access] ?? c.access}
                          </span>
                          {/^\/timeout\b/i.test(c.response.trim()) ? (
                            <span className="rounded bg-red-950/50 px-1.5 py-0.5 text-[10px] text-red-400">timeout</span>
                          ) : null}
                          {/^\/vanish\b/i.test(c.response.trim()) ? (
                            <span className="rounded bg-red-950/50 px-1.5 py-0.5 text-[10px] text-red-400">vanish</span>
                          ) : null}
                          <span className="text-xs tabular-nums text-neutral-600">
                            {c.counter.toLocaleString()} {c.counter === 1 ? "use" : "uses"}
                          </span>
                        </div>
                        <p className="mt-1 break-words text-sm text-neutral-400">{c.response}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {confirmDeleteCommand === c.name ? (
                          <>
                            <Button onClick={() => setConfirmDeleteCommand(null)} disabled={!!busy}>
                              Keep
                            </Button>
                            <Button
                              variant="danger"
                              onClick={() => deleteCustom(c.name)}
                              busy={busy === "custom-delete"}
                              disabled={!!busy}
                            >
                              Delete !{c.name}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              onClick={() => {
                                setConfirmDeleteCommand(null);
                                setDraft({
                                  originalName: c.name,
                                  name: c.name,
                                  access: c.access,
                                  response: c.response,
                                  counter: String(c.counter),
                                });
                              }}
                              disabled={!!busy || draft !== null}
                            >
                              <Pencil className="h-4 w-4" /> Edit
                            </Button>
                            <Button variant="danger" onClick={() => setConfirmDeleteCommand(c.name)} disabled={!!busy}>
                              <Trash2 className="h-4 w-4" /> Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs text-neutral-500">
                  Changes apply in chat straight away — no restart. Mods can also manage these from chat with{" "}
                  <code className="text-neutral-400">!acomm</code>, <code className="text-neutral-400">!ecomm</code>{" "}
                  and <code className="text-neutral-400">!dcomm</code>.
                </p>
              </>
            )}
          </Card>

          {/* ------------------------------------------- channel point rewards */}
          <Card
            title={rewards ? `Channel point rewards (${rewards.rewards.length})` : "Channel point rewards"}
            icon={<Gift className="h-4 w-4" />}
            actions={
              bot.token.hasChannelOAuth ? (
                <div className="flex flex-wrap justify-end gap-2">
                  {canAdminister ? (
                    <Button
                      onClick={() => {
                        setRewardsOpen(true);
                        setConfirmDeleteReward(null);
                        setRewardDraft(draftFromReward(null));
                      }}
                      disabled={!!busy || rewardDraft !== null || !rewards}
                    >
                      <Plus className="h-4 w-4" /> New reward
                    </Button>
                  ) : null}
                  <Button onClick={() => void rewardsCall("rewards-refresh", "")} busy={busy === "rewards-refresh"} disabled={!!busy}>
                    <RefreshCw className="h-4 w-4" /> Refresh
                  </Button>
                  {rewards && rewards.rewards.length > 0 ? (
                    <Button onClick={() => setRewardsOpen((v) => !v)} disabled={!!busy}>
                      <ChevronDown className={`h-4 w-4 transition-transform ${rewardsOpen ? "rotate-180" : ""}`} />
                      {rewardsOpen ? "Collapse" : "Manage"}
                    </Button>
                  ) : null}
                </div>
              ) : null
            }
          >
            {!bot.token.hasChannelOAuth ? (
              <p className="text-sm text-neutral-500">
                Rewards need the streamer to authorize the bot with Kick first — see Kick authorization above.
              </p>
            ) : (
              <>
                {rewardsError ? (
                  <div className="mb-4 flex items-start gap-2 text-sm text-red-400">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="flex-1">{rewardsError}</span>
                  </div>
                ) : null}
                {rewards && rewards.scopes.length > 0 && !rewards.scopes.includes("channel:rewards:write") ? (
                  <p className="mb-4 text-xs text-amber-500">
                    This channel&apos;s Kick authorization doesn&apos;t include rewards. The streamer needs to re-authorize
                    before rewards can be created or changed.
                  </p>
                ) : null}
                {rewards && rewards.scopes.length > 0 && !rewards.scopes.includes("moderation:ban") ? (
                  <p className="mb-4 text-xs text-amber-500">
                    This channel&apos;s Kick authorization doesn&apos;t include moderation, so timeout, roulette and get
                    out of jail actions can&apos;t run until the streamer re-authorizes.
                  </p>
                ) : null}
                {!canAdminister ? (
                  <p className="mb-4 text-xs text-neutral-500">Only the broadcaster can change rewards.</p>
                ) : null}

                {rewardDraft ? (
                  <div className="mb-5 space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
                    <div className="text-sm font-medium text-neutral-200">
                      {rewardDraft.id ? `Edit "${rewardDraft.title}"` : "New reward on Kick"}
                    </div>

                    {rewardDraft.canManage ? (
                      <div className="space-y-3">
                        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
                          <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Title</span>
                            <input
                              type="text"
                              maxLength={50}
                              value={rewardDraft.title}
                              disabled={!!busy}
                              onChange={(e) => patchRewardDraft({ title: e.target.value })}
                              placeholder="Timeout someone"
                              className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Cost (points)</span>
                            <input
                              type="text"
                              inputMode="numeric"
                              value={rewardDraft.cost}
                              disabled={!!busy}
                              onChange={(e) => patchRewardDraft({ cost: e.target.value })}
                              className="w-32 tabular-nums rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                            />
                          </label>
                          <label className="block">
                            <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Colour</span>
                            <input
                              type="color"
                              value={rewardDraft.color.toLowerCase()}
                              disabled={!!busy}
                              onChange={(e) => patchRewardDraft({ color: e.target.value })}
                              className="h-[38px] w-14 cursor-pointer rounded-lg border border-neutral-700 bg-neutral-900 p-1 disabled:opacity-40"
                            />
                          </label>
                        </div>
                        <label className="block">
                          <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Description</span>
                          <input
                            type="text"
                            maxLength={200}
                            value={rewardDraft.description}
                            disabled={!!busy}
                            onChange={(e) => patchRewardDraft({ description: e.target.value })}
                            placeholder="Shown to viewers under the title"
                            className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                          />
                        </label>
                        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                          <Checkbox label="Enabled" checked={rewardDraft.enabled} disabled={!!busy} onChange={(v) => patchRewardDraft({ enabled: v })} />
                          {rewardDraft.id ? (
                            <Checkbox label="Paused (visible, can't be redeemed)" checked={rewardDraft.paused} disabled={!!busy} onChange={(v) => patchRewardDraft({ paused: v })} />
                          ) : null}
                          <Checkbox label="Viewer must type something" checked={rewardDraft.inputRequired} disabled={!!busy} onChange={(v) => patchRewardDraft({ inputRequired: v })} />
                          <Checkbox label="Skip request queue" checked={rewardDraft.skipQueue} disabled={!!busy} onChange={(v) => patchRewardDraft({ skipQueue: v })} />
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs leading-relaxed text-neutral-500">
                        This reward belongs to another app, and Kick only lets that app edit it, so only its bot action
                        can be changed here.
                      </p>
                    )}

                    <div className="space-y-3 border-t border-neutral-800 pt-4">
                      <label className="block">
                        <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Bot action</span>
                        <select
                          value={rewardDraft.actionKind}
                          disabled={!!busy}
                          onChange={(e) => {
                            const kind = e.target.value as RewardActionKind | "";
                            patchRewardDraft({
                              actionKind: kind,
                              // Same value by default: a reward costing 5,000 gives 5,000.
                              ...(kind === "points" && !rewardDraft.amount ? { amount: rewardDraft.cost } : {}),
                              ...(kind && kind !== "pardon" && kind !== "points" && !rewardDraft.duration
                                ? { duration: kind === "shield" ? "10" : "1", unit: "m" as DurationUnit }
                                : {}),
                              ...(rewardDraft.canManage && !rewardDraft.id && (kind === "timeout" || kind === "roulette")
                                ? { inputRequired: true }
                                : {}),
                            });
                          }}
                          className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                        >
                          <option value="">None — mods handle redemptions by hand</option>
                          {(Object.keys(REWARD_ACTION_META) as RewardActionKind[]).map((k) => (
                            <option key={k} value={k}>
                              {REWARD_ACTION_META[k].label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {rewardDraft.actionKind ? (
                        <>
                          <p className="text-xs leading-relaxed text-neutral-500">
                            {REWARD_ACTION_META[rewardDraft.actionKind].description}
                          </p>
                          {rewardDraft.actionKind === "points" ? (
                            <label className="block">
                              <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Amount given</span>
                              <input
                                type="text"
                                inputMode="numeric"
                                value={rewardDraft.amount}
                                disabled={!!busy}
                                onChange={(e) => patchRewardDraft({ amount: e.target.value })}
                                className="w-32 tabular-nums rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                              />
                            </label>
                          ) : rewardDraft.actionKind !== "pardon" ? (
                            <label className="block">
                              <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">{rewardDraft.actionKind === "shield" ? "Shield lasts" : "Timeout length"}</span>
                              <div className="flex gap-2">
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={rewardDraft.duration}
                                  disabled={!!busy}
                                  onChange={(e) => patchRewardDraft({ duration: e.target.value })}
                                  className="w-20 tabular-nums rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                                />
                                <select
                                  value={rewardDraft.unit}
                                  disabled={!!busy}
                                  onChange={(e) => patchRewardDraft({ unit: e.target.value as DurationUnit })}
                                  className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                                >
                                  <option value="s">seconds</option>
                                  <option value="m">minutes</option>
                                  <option value="h">hours</option>
                                </select>
                              </div>
                            </label>
                          ) : null}
                          <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                            <Checkbox label="Announce the result in chat" checked={rewardDraft.announce} disabled={!!busy} onChange={(v) => patchRewardDraft({ announce: v })} />
                            {rewardDraft.actionKind === "shield" ? (
                              <Checkbox label="Reverse card: timeouts aimed at the holder bounce back" checked={rewardDraft.reflect} disabled={!!busy} onChange={(v) => patchRewardDraft({ reflect: v })} />
                            ) : null}
                            <Checkbox label="Test mode (shortened, points refunded)" checked={rewardDraft.testMode} disabled={!!busy} onChange={(v) => patchRewardDraft({ testMode: v })} />
                          </div>
                          {rewardDraft.testMode ? (
                            <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
                              <label className="block">
                                <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Test length (seconds)</span>
                                <input
                                  type="text"
                                  inputMode="numeric"
                                  value={rewardDraft.testDuration}
                                  disabled={!!busy}
                                  onChange={(e) => patchRewardDraft({ testDuration: e.target.value })}
                                  placeholder="5"
                                  className="w-28 tabular-nums rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">Only these viewers (blank = everyone)</span>
                                <input
                                  type="text"
                                  value={rewardDraft.testRedeemers}
                                  disabled={!!busy}
                                  onChange={(e) => patchRewardDraft({ testRedeemers: e.target.value })}
                                  placeholder="mrazishere"
                                  className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                                />
                              </label>
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </div>

                    {rewardDraftWarnings.map((w) => (
                      <p key={w} className="text-xs text-amber-500">
                        {w}
                      </p>
                    ))}
                    {rewardDraftProblem ? <p className="text-xs text-amber-500">{rewardDraftProblem}</p> : null}
                    <div className="flex justify-end gap-2">
                      <Button onClick={() => setRewardDraft(null)} disabled={busy === "reward-save"}>
                        Cancel
                      </Button>
                      <Button
                        variant="primary"
                        onClick={saveRewardDraft}
                        busy={busy === "reward-save"}
                        disabled={!!busy || rewardDraftProblem !== null}
                      >
                        {rewardDraft.id ? "Save" : "Create reward"}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {!rewards ? (
                  rewardsError ? null : <p className="text-sm text-neutral-500">Loading rewards from Kick…</p>
                ) : rewards.rewards.length === 0 ? (
                  rewardDraft ? null : <p className="text-sm text-neutral-500">No channel point rewards on Kick yet.</p>
                ) : !rewardsOpen ? (
                  rewards.rewards.some((r) => r.action) ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {rewards.rewards
                        .filter((r) => r.action)
                        .map((r) => (
                          <span
                            key={r.id}
                            className="rounded-full border border-neutral-700 bg-neutral-900 px-2.5 py-1 text-xs text-neutral-400"
                          >
                            {r.title} → {describeRewardAction(r.action as RewardActionConfig)}
                            {r.action?.testMode ? " (test)" : ""}
                          </span>
                        ))}
                    </div>
                  ) : (
                    <p className="text-sm text-neutral-500">
                      {rewards.rewards.length} {rewards.rewards.length === 1 ? "reward" : "rewards"} on Kick, none with a bot action.
                    </p>
                  )
                ) : (
                  <>
                    <ul className="divide-y divide-neutral-800">
                      {rewards.rewards.map((r) => (
                        <li
                          key={r.id}
                          className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:gap-4"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className="h-3 w-3 shrink-0 rounded-sm"
                                style={{ backgroundColor: r.background_color || "#525252" }}
                              />
                              <span className="text-sm font-semibold text-neutral-200">{r.title}</span>
                              <span className="text-xs tabular-nums text-neutral-500">{r.cost.toLocaleString()} pts</span>
                              {!r.is_enabled ? (
                                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">disabled</span>
                              ) : null}
                              {r.is_paused ? (
                                <span className="rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-500">paused</span>
                              ) : null}
                              {r.should_redemptions_skip_request_queue ? (
                                <span className="rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-500">skips queue</span>
                              ) : null}
                              {!r.canManage ? (
                                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-500">
                                  owned by another app
                                </span>
                              ) : null}
                            </div>
                            {r.description ? (
                              <p className="mt-1 break-words text-xs text-neutral-500">{r.description}</p>
                            ) : null}
                            <p className="mt-1.5 text-sm">
                              {r.action ? (
                                <span className="text-neutral-300">
                                  Bot: {describeRewardAction(r.action)}
                                  {r.action.testMode ? (
                                    <span className="ml-2 rounded bg-amber-950/50 px-1.5 py-0.5 text-[10px] text-amber-500">test mode</span>
                                  ) : null}
                                  {!r.actionPinned ? (
                                    <span className="ml-2 text-xs text-neutral-600">(matched by title)</span>
                                  ) : null}
                                </span>
                              ) : (
                                <span className="text-neutral-600">No bot action</span>
                              )}
                            </p>
                          </div>
                          {canAdminister ? (
                            <div className="flex shrink-0 gap-2">
                              {confirmDeleteReward === r.id ? (
                                <>
                                  <Button onClick={() => setConfirmDeleteReward(null)} disabled={!!busy}>
                                    Keep
                                  </Button>
                                  <Button
                                    variant="danger"
                                    onClick={() => deleteReward(r)}
                                    busy={busy === "reward-delete"}
                                    disabled={!!busy}
                                  >
                                    Delete from Kick
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <Button
                                    onClick={() => {
                                      setConfirmDeleteReward(null);
                                      setRewardDraft(draftFromReward(r));
                                    }}
                                    disabled={!!busy || rewardDraft !== null}
                                  >
                                    <Pencil className="h-4 w-4" /> Edit
                                  </Button>
                                  {r.canManage ? (
                                    <Button variant="danger" onClick={() => setConfirmDeleteReward(r.id)} disabled={!!busy}>
                                      <Trash2 className="h-4 w-4" /> Delete
                                    </Button>
                                  ) : null}
                                </>
                              )}
                            </div>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-4 text-xs leading-relaxed text-neutral-500">
                      Changes apply to the next redemption, no restart. Rewards made by another app can only get a bot
                      action here, since Kick lets only that app edit them. Keep &quot;Skip request queue&quot; off so
                      the bot can refund a redemption that fails. Test mode shortens timeouts and shields and refunds
                      the points.
                    </p>
                  </>
                )}
                {/* Outside the list above: once every reward is deleted on Kick there is no list to expand. */}
                {rewards && canAdminister && rewards.orphaned.length > 0 ? (
                  <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                    <p className="text-xs text-amber-500">Bot actions for rewards that no longer exist on Kick:</p>
                    <ul className="mt-2 space-y-2">
                      {rewards.orphaned.map((a) => (
                        <li key={a.rewardId} className="flex items-center justify-between gap-3 text-xs text-neutral-400">
                          <span>
                            {describeRewardAction(a)} <code className="text-neutral-600">{a.rewardId}</code>
                          </span>
                          <Button
                            onClick={() => void clearOrphanedAction(a.rewardId as string)}
                            busy={busy === "reward-orphan"}
                            disabled={!!busy}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </>
            )}
          </Card>

          {/* ------------------------------------------------- clip session */}
          {/* The bot account's own credential, not the channel's, so it is the
              owner's to manage and shows for nobody else. */}
          {isAdmin ? <ClipSessionCard /> : null}

          {/* -------------------------------------------------- loyalty points */}
          <PointsCard
            channel={channel}
            canAdminister={canAdminister}
            points={bot.points ?? null}
            onSaved={(data) => setBot(data as unknown as BotChannel)}
          />

          {/* -------------------------------------------------------- settings */}
          <Card title="Settings" icon={<ShieldCheck className="h-4 w-4" />}>
            <div className="space-y-5">
              <Toggle
                label="Chat-only mode"
                description="Restricts the bot to reading and writing chat — no moderation actions or channel-level features."
                checked={bot.chatOnly}
                disabled={!!busy}
                onChange={toggleChatOnly}
              />
              <div className="border-t border-neutral-800" />
              <Toggle
                label="Earnings recording"
                description="Polls viewer counts while live and records estimated earnings per session. Required for !earnings to respond."
                checked={bot.earnings?.enabled ?? false}
                disabled={!!busy}
                onChange={toggleEarnings}
              />
              <div className="border-t border-neutral-800" />
              <Toggle
                label="KPP recording"
                description={
                  "Tracks engagement for Kick Partner Program estimates. Required for !kpp and !topc to respond." +
                  (canAdminister ? "" : " Only the broadcaster can change this.")
                }
                checked={bot.kpp?.enabled ?? false}
                disabled={!!busy || !canAdminister}
                onChange={toggleKpp}
              />
              <div className="border-t border-neutral-800" />
              <Toggle
                label="Auto-translate"
                description="Automatically translates non-English chat messages as they arrive."
                checked={bot.autoTranslate?.enabled ?? false}
                disabled={!!busy}
                onChange={toggleAutoTranslate}
              />
              {excluded.has("autotranslate") ? (
                <p className="text-xs text-amber-500">
                  The auto-translate module is disabled for this channel, so this toggle has no effect
                  until it is re-enabled.
                </p>
              ) : null}
              {bot.autoTranslate?.logOnly ? (
                <p className="text-xs text-amber-500">
                  Dry-run mode is on in the config — translations are logged, not posted to chat.
                </p>
              ) : null}
              {bot.autoTranslate?.enabled ? (
                <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-neutral-200">Languages</div>
                      <p className="mt-1 text-xs leading-relaxed text-neutral-500">
                        {langDraft.length === 0
                          ? "Any language but English. Only messages carrying an accent, an umlaut or a non-Latin script get picked up — plain-ASCII German or Spanish can't be told apart from English, so it stays silent."
                          : `Only ${[...langDraft].sort().map(languageLabel).join(", ")} ${langDraft.length === 1 ? "is" : "are"} translated. Naming a language also catches it typed without accents (“Wie geht es dir?”), from 12 characters and 3 words up.`}
                      </p>
                    </div>
                    {langDirty ? (
                      <div className="flex shrink-0 gap-2">
                        <Button
                          onClick={() => setLangDraft(savedLangKey ? savedLangKey.split(",") : [])}
                          disabled={!!busy}
                        >
                          Cancel
                        </Button>
                        <Button
                          variant="primary"
                          onClick={saveLanguages}
                          busy={busy === "autoTranslate"}
                          disabled={!!busy}
                        >
                          Save
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setLangDraft([])}
                      className={`rounded-full border px-2.5 py-1 text-xs transition ${
                        langDraft.length === 0
                          ? "border-[#53FC18] bg-[#53FC18]/10 text-[#53FC18]"
                          : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600"
                      }`}
                    >
                      Any language
                    </button>
                    {LANGUAGE_CHOICES.map(({ code, label }) => {
                      const on = langDraft.includes(code);
                      return (
                        <button
                          key={code}
                          type="button"
                          onClick={() =>
                            setLangDraft((prev) =>
                              prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
                            )
                          }
                          className={`rounded-full border px-2.5 py-1 text-xs transition ${
                            on
                              ? "border-[#53FC18] bg-[#53FC18]/10 text-[#53FC18]"
                              : "border-neutral-700 bg-neutral-900 text-neutral-400 hover:border-neutral-600"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="mt-2.5 text-xs text-neutral-600">
                    Saving restarts the bot to apply — a couple of seconds off chat.
                  </p>
                </div>
              ) : null}
            </div>
          </Card>

          {/* ---------------------------------------------------------- claude */}
          <Card
            title="AI personality"
            icon={<Sparkles className="h-4 w-4" />}
            actions={
              <div className="flex gap-2">
                {claudeDirty ? (
                  <>
                    <Button onClick={() => setClaude(bot.claude ?? {})} disabled={!!busy}>
                      Cancel
                    </Button>
                    <Button variant="primary" onClick={saveClaude} busy={busy === "claude"} disabled={!!busy}>
                      Save
                    </Button>
                  </>
                ) : null}
                <Button onClick={() => setClaudeOpen((v) => !v)} disabled={!!busy}>
                  <ChevronDown className={`h-4 w-4 transition-transform ${claudeOpen ? "rotate-180" : ""}`} />
                  {claudeOpen ? "Collapse" : "Edit"}
                </Button>
              </div>
            }
          >
            {!claudeOpen ? (
              <p className="text-sm text-neutral-500">
                {bot.claude?.systemPrompt
                  ? `Custom prompt set (${bot.claude.systemPrompt.length} characters).`
                  : "Using the bot's default personality."}
                {bot.claude?.vision?.enabled ? " Vision on." : ""}
              </p>
            ) : (
              <div className="space-y-5">
                <div>
                  <label htmlFor="claude-prompt" className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">
                    System prompt
                  </label>
                  <p className="mb-2 text-xs leading-relaxed text-neutral-500">
                    Defines how <code className="text-neutral-400">!claude</code> behaves in this channel. Leave empty
                    to use the bot&apos;s default. Mods can also change this in chat with{" "}
                    <code className="text-neutral-400">!claudesystem</code> and reset it with{" "}
                    <code className="text-neutral-400">!claudereset</code>.
                  </p>
                  <textarea
                    id="claude-prompt"
                    rows={8}
                    maxLength={6000}
                    disabled={!!busy}
                    value={claude.systemPrompt ?? ""}
                    onChange={(e) => setClaude((p) => ({ ...p, systemPrompt: e.target.value }))}
                    placeholder="Using the bot's default personality — type here to override it for this channel."
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-xs leading-relaxed text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                  />
                  <div className="mt-1 text-right text-xs text-neutral-600">
                    {(claude.systemPrompt ?? "").length}/6000
                  </div>
                </div>

                <div>
                  <label htmlFor="claude-context" className="mb-1 block text-xs uppercase tracking-wider text-neutral-500">
                    Extra context
                  </label>
                  <p className="mb-2 text-xs leading-relaxed text-neutral-500">
                    Appended to the prompt as channel-specific context — inside jokes, regulars, running gags.
                  </p>
                  <textarea
                    id="claude-context"
                    rows={3}
                    maxLength={2000}
                    disabled={!!busy}
                    value={claude.context ?? ""}
                    onChange={(e) => setClaude((p) => ({ ...p, context: e.target.value }))}
                    className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-3">
                  {([
                    ["rateLimit", "Requests / hour", 1, 500],
                    ["burstRequests", "Burst limit", 1, 50],
                    ["cooldownMinutes", "User cooldown (min)", 0, 1440],
                  ] as const).map(([key, label, min, max]) => (
                    <div key={key}>
                      <label htmlFor={`claude-${key}`} className="mb-1 block text-xs text-neutral-500">
                        {label}
                      </label>
                      <input
                        id={`claude-${key}`}
                        type="number"
                        min={min}
                        max={max}
                        disabled={!!busy}
                        value={claude.settings?.[key] ?? ""}
                        placeholder={
                          bot.claudeDefaults?.[key] !== undefined
                            ? `${bot.claudeDefaults[key]} (default)`
                            : ""
                        }
                        onChange={(e) =>
                          setClaude((p) => ({
                            ...p,
                            settings: {
                              ...(p.settings ?? {}),
                              [key]: e.target.value === "" ? undefined : Number(e.target.value),
                            },
                          }))
                        }
                        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition focus:border-neutral-500 disabled:opacity-40"
                      />
                    </div>
                  ))}
                </div>

                <p className="-mt-1 text-xs text-neutral-500">
                  Leave a field empty to use the bot&apos;s default, shown greyed out in the box.
                </p>

                <div className="border-t border-neutral-800 pt-5">
                  <Toggle
                    label="Vision"
                    description="When someone @mentions the bot, it looks at 3 live frames (plus the streamer's reference photos) before answering. !claude stays text-only."
                    checked={bot.claude?.vision?.enabled ?? false}
                    disabled={!!busy}
                    onChange={toggleVision}
                  />
                </div>

                <p className="text-xs text-neutral-500">
                  AI settings are re-read from disk every 5 minutes, so saving here does not restart the bot.
                </p>
              </div>
            )}
          </Card>

          {/* -------------------------------------------------------- location */}
          <Card
            title="Location"
            icon={<MapPin className="h-4 w-4" />}
            actions={
              locationDirty ? (
                <div className="flex gap-2">
                  <Button
                    onClick={() => setLocation(bot.location ?? { home: {}, current: {} })}
                    disabled={!!busy}
                  >
                    Cancel
                  </Button>
                  <Button variant="primary" onClick={saveLocation} busy={busy === "location"} disabled={!!busy}>
                    Save location
                  </Button>
                </div>
              ) : null
            }
          >
            <p className="mb-4 text-xs leading-relaxed text-neutral-500">
              Used by weather and currency commands. <span className="text-neutral-400">Home</span> is where the
              channel is based; <span className="text-neutral-400">Current</span> is where the streamer is right now
              (travel, events). Leave a field blank if it does not apply. The chat command{" "}
              <code className="text-neutral-400">!location home set &lt;place&gt;</code> does the same thing and can
              work out the details from just a city name.
            </p>
            <div className="grid gap-6 sm:grid-cols-2">
              {(["home", "current"] as const).map((which) => (
                <div key={which}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400">
                    {which === "home" ? "Home" : "Current"}
                  </h3>
                  <div className="space-y-2.5">
                    {(["country", "city", "state", "province"] as const).map((field) => (
                      <div key={field}>
                        <label
                          htmlFor={`${which}-${field}`}
                          className="mb-1 block text-xs capitalize text-neutral-500"
                        >
                          {field}
                        </label>
                        <input
                          id={`${which}-${field}`}
                          type="text"
                          maxLength={60}
                          value={location[which]?.[field] ?? ""}
                          disabled={!!busy}
                          onChange={(e) =>
                            setLocation((prev) => ({
                              ...prev,
                              [which]: { ...(prev[which] ?? {}), [field]: e.target.value },
                            }))
                          }
                          className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                          placeholder="—"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* ------------------------------------------------------------ logs */}
          <Card
            title="Recent activity"
            icon={<ScrollText className="h-4 w-4" />}
            actions={
              <Button onClick={loadLogs} busy={busy === "logs"} disabled={!!busy}>
                <ChevronDown className={`h-4 w-4 transition-transform ${logsOpen ? "rotate-180" : ""}`} />
                {logsOpen ? "Hide" : "Show"} logs
              </Button>
            }
          >
            {logsOpen ? (
              logsError ? (
                <div className="flex items-start gap-2 text-sm text-red-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="flex-1">{logsError}</span>
                </div>
              ) : logs && logs.length > 0 ? (
                <pre className="max-h-96 overflow-auto rounded-lg bg-black/60 p-3 text-xs leading-relaxed text-neutral-400">
                  {logs.join("\n")}
                </pre>
              ) : (
                <p className="text-sm text-neutral-500">{logs && busy !== "logs" ? "No log output yet." : "Loading…"}</p>
              )
            ) : (
              <p className="text-sm text-neutral-500">The last 100 lines from this channel&apos;s bot log.</p>
            )}
          </Card>

          {/* ---------------------------------------------------- bot managers */}
          {canAdminister ? (
            <Card
              title={`Bot managers (${managers.length})`}
              icon={<Users className="h-4 w-4" />}
              actions={
                <Button onClick={syncManagersNow} busy={busy === "sync"} disabled={!!busy}>
                  <RefreshCw className="h-4 w-4" /> Sync moderators
                </Button>
              }
            >
              <p className="mb-4 text-xs leading-relaxed text-neutral-500">
                Pre-filled with the moderators seen in your chat — remove anyone who should not manage
                the bot. They can restart it, toggle commands, edit settings and read recent logs; they
                cannot remove the bot, stop it, re-authorize Kick, or change this list. New moderators
                are not added automatically — use <span className="text-neutral-400">Sync moderators</span>{" "}
                to pull in anyone promoted since.
              </p>

              {managersLoadError ? (
                <div className="mb-4 flex items-start gap-2 text-sm text-red-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="flex-1">
                    Couldn&apos;t load the manager list ({managersLoadError}). Editing is off so the real list isn&apos;t
                    overwritten — reload the page, or use Sync moderators.
                  </span>
                </div>
              ) : null}

              {managerNotice ? (
                <div className="mb-4 rounded-lg border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-xs leading-relaxed text-neutral-400">
                  {managerNotice}
                </div>
              ) : null}

              {managersLoadError ? null : managers.length > 0 ? (
                <ul className="mb-4 space-y-2">
                  {managers.map((m) => (
                    <li
                      key={m}
                      className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2"
                    >
                      <span className="text-sm text-neutral-200">{m}</span>
                      <button
                        type="button"
                        disabled={!!busy}
                        onClick={() =>
                          void saveManagers(
                            managers.filter((x) => x !== m),
                            `${m} can no longer manage the bot.`,
                          )
                        }
                        className="text-xs text-neutral-500 transition hover:text-red-400 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mb-4 text-sm text-neutral-500">
                  No one else can manage this bot. The list is filled from moderators seen chatting in
                  this channel — add a username below if none have.
                </p>
              )}

              <div className="flex gap-2">
                <input
                  type="text"
                  value={managerInput}
                  disabled={!!busy || !!managersLoadError}
                  onChange={(e) => setManagerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addManager(managerInput);
                    }
                  }}
                  placeholder="Kick username"
                  className="flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40"
                />
                <Button
                  variant="primary"
                  onClick={() => addManager(managerInput)}
                  busy={busy === "managers"}
                  disabled={!!busy || !managerInput.trim() || !!managersLoadError}
                >
                  Add
                </Button>
              </div>

              {managerSuggestions.filter((sug) => !managers.includes(sug)).length > 0 ? (
                <div className="mt-4">
                  <div className="mb-2 text-xs uppercase tracking-wider text-neutral-500">
                    Seen as moderator in your chat
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {managerSuggestions
                      .filter((sug) => !managers.includes(sug))
                      .map((sug) => (
                        <button
                          key={sug}
                          type="button"
                          disabled={!!busy}
                          onClick={() => addManager(sug)}
                          className="rounded-full border border-neutral-700 px-3 py-1 text-xs text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
                        >
                          + {sug}
                        </button>
                      ))}
                  </div>
                  <p className="mt-2 text-xs text-neutral-600">
                    Moderators the bot has seen in chat who are not on the list — removed earlier, or
                    promoted since the list was filled.
                  </p>
                </div>
              ) : null}
            </Card>
          ) : null}

          {/* ------------------------------------------------------ danger zone */}
          {canAdminister ? (
          <Card title="Danger zone" icon={<Trash2 className="h-4 w-4" />}>
            {confirmRemove ? (
              <div className="space-y-3">
                <p className="text-sm text-neutral-300">
                  This stops the bot, deletes its process and removes its configuration and authorization for{" "}
                  <span className="font-medium text-neutral-100">{channel}</span>. Re-adding it means authorizing again.
                </p>
                <div className="flex gap-2">
                  <Button variant="danger" onClick={remove} busy={busy === "remove"} disabled={!!busy}>
                    <Trash2 className="h-4 w-4" /> Yes, remove the bot
                  </Button>
                  <Button onClick={() => setConfirmRemove(false)} disabled={!!busy}>
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-4">
                <p className="text-sm text-neutral-500">Remove the bot from this channel entirely.</p>
                <Button variant="danger" onClick={() => setConfirmRemove(true)} disabled={!!busy}>
                  <Trash2 className="h-4 w-4" /> Remove bot
                </Button>
              </div>
            )}
          </Card>
          ) : null}
        </div>
      )}
      </div>
    </div>
  );
}
