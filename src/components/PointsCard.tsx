"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Coins, ExternalLink, Loader2, Search } from "lucide-react";
import { Button, Card, Checkbox, Stat, Toggle } from "./ui";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Mirrors src/lib/bot-api.ts — duplicated rather than imported, since that module is server-only.

export interface PointsBonuses {
  follow: number;
  subNew: number;
  subRenewal: number;
  giftSubGifterPerSub: number;
  giftSubRecipient: number;
  pointsPerKick: number;
  onlyWhileLive: boolean;
  announce: boolean;
}

export interface PointsGive {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  cooldownSeconds: number;
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

export interface PointsConfig {
  enabled: boolean;
  currencyName: string;
  currencyCommand: string | null;
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

type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "timeoutPenalty">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
};

interface PointsSummary {
  enabled: boolean;
  currencyName: string;
  effectiveCommand: string;
  dbAvailable: boolean;
  users: number;
  totalPoints: number;
  lastTickAt: string | null;
  lastTickUsers: number | null;
  subscriptions: Record<string, { ok: boolean; error?: string; at: string }>;
}

interface PointsUserRow {
  userId: number;
  username: string;
  balance: number;
  watchSeconds: number;
  rank: number;
  lastSeenAt: string | null;
}

interface PointsUserDetail {
  user: PointsUserRow & {
    lifetimeEarned: number;
    isSub: boolean;
    followBonusAt: string | null;
    firstSeenAt: string;
  };
  ledger: Array<{
    id: number;
    ts: string;
    delta: number;
    balanceAfter: number;
    reason: string;
    actor: string | null;
    note: string | null;
  }>;
}

type AdjustMode = "add" | "remove" | "set";

/** The settings form holds numbers as text, so a half-typed value isn't coerced to 0 while editing. */
interface SettingsForm {
  currencyName: string;
  currencyCommand: string;
  pointsPerInterval: string;
  intervalMinutes: string;
  activeWindowMinutes: string;
  subscriberMultiplier: string;
  excludeBroadcaster: boolean;
  ignoreUsers: string;
  follow: string;
  subNew: string;
  subRenewal: string;
  giftSubGifterPerSub: string;
  giftSubRecipient: string;
  pointsPerKick: string;
  onlyWhileLive: boolean;
  announce: boolean;
  giveEnabled: boolean;
  giveMin: string;
  giveMax: string;
  giveCooldown: string;
  modMaxAdjust: string;
  publicLeaderboard: boolean;
  penaltyEnabled: boolean;
  penaltyPerSecond: string;
  penaltyMax: string;
  penaltyIncludeBot: boolean;
  penaltyPermanentBan: string;
  penaltyAnnounce: boolean;
}

function formFromConfig(c: PointsConfig): SettingsForm {
  return {
    currencyName: c.currencyName,
    currencyCommand: c.currencyCommand ?? "",
    pointsPerInterval: String(c.pointsPerInterval),
    intervalMinutes: String(c.intervalMinutes),
    activeWindowMinutes: String(c.activeWindowMinutes),
    subscriberMultiplier: String(c.subscriberMultiplier),
    excludeBroadcaster: c.excludeBroadcaster,
    ignoreUsers: c.ignoreUsers.join(", "),
    follow: String(c.bonuses.follow),
    subNew: String(c.bonuses.subNew),
    subRenewal: String(c.bonuses.subRenewal),
    giftSubGifterPerSub: String(c.bonuses.giftSubGifterPerSub),
    giftSubRecipient: String(c.bonuses.giftSubRecipient),
    pointsPerKick: String(c.bonuses.pointsPerKick),
    onlyWhileLive: c.bonuses.onlyWhileLive,
    announce: c.bonuses.announce,
    giveEnabled: c.give.enabled,
    giveMin: String(c.give.minAmount),
    giveMax: String(c.give.maxAmount),
    giveCooldown: String(c.give.cooldownSeconds),
    modMaxAdjust: String(c.modMaxAdjust),
    publicLeaderboard: c.publicLeaderboard,
    penaltyEnabled: c.timeoutPenalty.enabled,
    penaltyPerSecond: String(c.timeoutPenalty.pointsPerSecond),
    penaltyMax: String(c.timeoutPenalty.maxDeduction),
    penaltyIncludeBot: c.timeoutPenalty.includeBotTimeouts,
    penaltyPermanentBan: String(c.timeoutPenalty.permanentBanCost),
    penaltyAnnounce: c.timeoutPenalty.announce,
  };
}

/**
 * The command the bot answers when no override is set. Mirrors effectiveCommand in
 * the bot's src/points/config.ts: lowercased, letters, digits and _ kept, at most 20
 * characters, and "points" when that leaves fewer than 2.
 */
function deriveCommand(name: string): string {
  const derived = name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return derived.length >= 2 ? derived : "points";
}

function parseIgnoreList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim().replace(/^@+/, "").toLowerCase())
        .filter(Boolean),
    ),
  );
}

/**
 * Validate the form into a settings patch, mirroring the bot service's rules so a
 * mistake shows here instead of as a failed save. The service still has the final say.
 */
function buildPatch(f: SettingsForm): { patch: PointsSettingsPatch } | { error: string } {
  const errors: string[] = [];
  const whole = (raw: string, label: string, min: number, max: number): number => {
    const t = raw.trim();
    const n = Number(t);
    if (t === "" || !Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`);
      return min;
    }
    return n;
  };
  const decimal = (raw: string, label: string, min: number, max: number): number => {
    const t = raw.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n) || n < min || n > max) {
      errors.push(`${label} must be a number from ${min} to ${max}`);
      return min;
    }
    return n;
  };

  const currencyName = f.currencyName.trim();
  if (!/^[A-Za-z0-9 $_-]{1,24}$/.test(currencyName)) {
    errors.push("Currency name must be 1–24 letters, digits, spaces or $ _ -");
  }
  const command = f.currencyCommand.trim().replace(/^[!$]+/, "").toLowerCase();
  if (command && !/^[a-z0-9_]{2,20}$/.test(command)) {
    errors.push("Command must be 2–20 lowercase letters, digits or _");
  }

  const ignoreUsers = parseIgnoreList(f.ignoreUsers);
  if (ignoreUsers.length > 500) errors.push("The ignore list is limited to 500 names");
  const badNames = ignoreUsers.filter((u) => !/^[a-z0-9_]{2,25}$/.test(u));
  if (badNames.length > 0) errors.push(`Not valid usernames: ${badNames.slice(0, 5).join(", ")}`);

  const intervalMinutes = whole(f.intervalMinutes, "Interval", 5, 60);
  const patch: PointsSettingsPatch = {
    currencyName,
    currencyCommand: command || null,
    pointsPerInterval: whole(f.pointsPerInterval, "Points per interval", 0, 100_000),
    intervalMinutes,
    activeWindowMinutes: whole(f.activeWindowMinutes, "Active window", intervalMinutes, 240),
    subscriberMultiplier: decimal(f.subscriberMultiplier, "Subscriber multiplier", 1, 10),
    excludeBroadcaster: f.excludeBroadcaster,
    ignoreUsers,
    bonuses: {
      follow: whole(f.follow, "Follow bonus", 0, 1_000_000),
      subNew: whole(f.subNew, "New sub bonus", 0, 1_000_000),
      subRenewal: whole(f.subRenewal, "Resub bonus", 0, 1_000_000),
      giftSubGifterPerSub: whole(f.giftSubGifterPerSub, "Gifted sub bonus", 0, 1_000_000),
      giftSubRecipient: whole(f.giftSubRecipient, "Gift recipient bonus", 0, 1_000_000),
      pointsPerKick: decimal(f.pointsPerKick, "Points per Kick", 0, 1000),
      onlyWhileLive: f.onlyWhileLive,
      announce: f.announce,
    },
    give: {
      enabled: f.giveEnabled,
      minAmount: whole(f.giveMin, "Minimum give", 1, 1_000_000),
      maxAmount: whole(f.giveMax, "Maximum give", 0, 1_000_000_000),
      cooldownSeconds: whole(f.giveCooldown, "Give cooldown", 0, 3600),
    },
    timeoutPenalty: {
      enabled: f.penaltyEnabled,
      pointsPerSecond: decimal(f.penaltyPerSecond, "Cost per second", 0, 10_000),
      maxDeduction: whole(f.penaltyMax, "Maximum deduction", 0, 1_000_000_000),
      includeBotTimeouts: f.penaltyIncludeBot,
      permanentBanCost: whole(f.penaltyPermanentBan, "Permanent ban cost", 0, 1_000_000_000),
      announce: f.penaltyAnnounce,
    },
    modMaxAdjust: whole(f.modMaxAdjust, "Max per mod adjustment", 1, 1_000_000_000),
    publicLeaderboard: f.publicLeaderboard,
  };

  return errors.length > 0 ? { error: errors.join("; ") } : { patch };
}

/** Turn the rate into something concrete, since "per second" is easy to misjudge. */
function costExample(perSecond: string, max: string, currency: string): string {
  const rate = Number(perSecond);
  if (!Number.isFinite(rate) || rate <= 0) return "Free at 0.";
  const cap = Number(max);
  const capped = (n: number) => (Number.isFinite(cap) && cap > 0 ? Math.min(n, cap) : n);
  const unit = currency.trim() || "points";
  const min5 = capped(Math.floor(rate * 300)).toLocaleString();
  return `1 min costs ${capped(Math.floor(rate * 60)).toLocaleString()}, 5 min costs ${min5} ${unit}.`;
}

function formatWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h.toLocaleString()}h ${m}m` : `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

const REASON_LABEL: Record<string, string> = {
  follow: "Follow bonus",
  sub_new: "New sub",
  sub_renewal: "Resub",
  gift_sub: "Gifted subs",
  gift_recv: "Received a gifted sub",
  kicks: "Kicks",
  give_out: "Gave",
  give_in: "Received",
  mod_add: "Added by mod",
  mod_remove: "Removed by mod",
  mod_set: "Set by mod",
  dash_add: "Added in dashboard",
  dash_remove: "Removed in dashboard",
  dash_set: "Set in dashboard",
  pusher_sub: "Sub",
};

async function callApi<T>(channel: string, path: string, init?: RequestInit): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${BASE_PATH}/api/bot/${encodeURIComponent(channel)}${path}`, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { error: body?.error ?? `Request failed (${res.status})` };
    return { data: body as T };
  } catch {
    return { error: "Network error — try again" };
  }
}

const INPUT =
  "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40";
const LABEL = "mb-1 block text-xs uppercase tracking-wider text-neutral-500";
const SECTION = "mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

export default function PointsCard({
  channel, canAdminister, points, onSaved,
}: {
  channel: string;
  /** Owner/admin edit the settings; managers see them read-only but can still adjust balances. */
  canAdminister: boolean;
  /** null when the bot service is older than the points system. */
  points: PointsConfig | null;
  /** Receives the updated channel after a settings save, so the rest of the page stays current. */
  onSaved: (bot: { points?: PointsConfig | null }) => void;
}) {
  const [saved, setSaved] = useState<PointsConfig | null>(points);
  const [form, setForm] = useState<SettingsForm | null>(points ? formFromConfig(points) : null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [summary, setSummary] = useState<PointsSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PointsUserRow[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PointsUserDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [mode, setMode] = useState<AdjustMode>("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustNotice, setAdjustNotice] = useState<string | null>(null);
  // One request id per attempted change. Retrying the same change reuses it, so a
  // save that landed but whose answer was lost is never applied a second time.
  const pendingAttempt = useRef<{ signature: string; requestId: string } | null>(null);

  // A newer copy from the page (another card saved) replaces the form only when it
  // has no unsaved edits — otherwise those edits would silently disappear.
  const savedRef = useRef<PointsConfig | null>(points);
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = points;
    setSaved(points);
    setForm((current) =>
      !current || !previous || JSON.stringify(current) === JSON.stringify(formFromConfig(previous))
        ? points
          ? formFromConfig(points)
          : null
        : current,
    );
  }, [points]);

  const loadSummary = useCallback(async () => {
    const r = await callApi<PointsSummary>(channel, "/points");
    if (r.data) {
      setSummary(r.data);
      setSummaryError(null);
    } else {
      setSummaryError(r.error ?? "Could not load points status");
    }
  }, [channel]);

  // Loaded after the page renders, like rewards, so the bot page never waits on it.
  useEffect(() => {
    if (points) void loadSummary();
  }, [points, loadSummary]);

  useEffect(() => {
    if (!points) return;
    const q = query.trim().replace(/^@+/, "").toLowerCase();
    if (q && !/^[a-z0-9_]{1,25}$/.test(q)) {
      setUsersError("Usernames are letters, digits and _");
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      const r = await callApi<{ users: PointsUserRow[] }>(
        channel,
        `/points/users?q=${encodeURIComponent(q)}&limit=20`,
      );
      if (seq !== searchSeq.current) return; // a newer search is already on its way
      if (r.data) {
        setUsers(r.data.users);
        setUsersError(null);
      } else {
        setUsersError(r.error ?? "Search failed");
      }
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [channel, query, points]);

  const loadDetail = useCallback(
    async (userId: number) => {
      setDetailError(null);
      const r = await callApi<PointsUserDetail>(channel, `/points/users/${userId}`);
      if (r.data) setDetail(r.data);
      else setDetailError(r.error ?? "Could not load this viewer");
    },
    [channel],
  );

  const selectUser = useCallback(
    (userId: number) => {
      if (selectedId === userId) {
        setSelectedId(null);
        setDetail(null);
        return;
      }
      setSelectedId(userId);
      setDetail(null);
      setAdjustError(null);
      setAdjustNotice(null);
      pendingAttempt.current = null;
      void loadDetail(userId);
    },
    [selectedId, loadDetail],
  );

  const saveSettings = useCallback(
    async (patch: PointsSettingsPatch, message: string, key: string, resetForm: boolean) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      const r = await callApi<{ points?: PointsConfig | null }>(channel, "/settings", {
        method: "POST",
        body: JSON.stringify({ points: patch }),
      });
      setBusy(null);
      if (!r.data) {
        setError(r.error ?? "Could not save the points settings");
        return;
      }
      const next = r.data.points ?? null;
      if (next) {
        savedRef.current = next;
        setSaved(next);
        // Toggling points on or off must not throw away edits waiting in the form.
        if (resetForm) setForm(formFromConfig(next));
      }
      onSaved(r.data);
      setNotice(message);
      void loadSummary();
    },
    [channel, onSaved, loadSummary],
  );

  const saveForm = useCallback(() => {
    if (!form) return;
    const built = buildPatch(form);
    if ("error" in built) {
      setError(built.error);
      setNotice(null);
      return;
    }
    void saveSettings(built.patch, "Points settings saved — applies within 15 seconds, no restart.", "points-save", true);
  }, [form, saveSettings]);

  const submitAdjust = useCallback(async () => {
    if (!detail) return;
    setAdjustError(null);
    setAdjustNotice(null);
    const n = Number(amount.trim());
    const min = mode === "set" ? 0 : 1;
    if (amount.trim() === "" || !Number.isInteger(n) || n < min || n > 1_000_000_000) {
      setAdjustError(mode === "set" ? "Enter a whole number, 0 or more" : "Enter a whole number, 1 or more");
      return;
    }
    const why = reason.trim();
    if (why.length < 3 || why.length > 200) {
      setAdjustError("A reason of 3–200 characters is required");
      return;
    }

    const userId = detail.user.userId;
    const signature = JSON.stringify([userId, mode, n, why]);
    if (!pendingAttempt.current || pendingAttempt.current.signature !== signature) {
      pendingAttempt.current = { signature, requestId: crypto.randomUUID() };
    }

    setBusy("adjust");
    const r = await callApi<{ ok: true; applied: boolean; user: PointsUserRow }>(channel, "/points/adjust", {
      method: "POST",
      body: JSON.stringify({ userId, mode, amount: n, reason: why, requestId: pendingAttempt.current.requestId }),
    });
    setBusy(null);
    if (!r.data) {
      // The attempt is kept: pressing Apply again retries with the same request id.
      setAdjustError(r.error ?? "Could not adjust the balance");
      return;
    }

    pendingAttempt.current = null;
    const updated = r.data.user;
    setUsers((list) => list?.map((row) => (row.userId === updated.userId ? updated : row)) ?? list);
    const currency = saved?.currencyName ?? "points";
    setAdjustNotice(
      r.data.applied
        ? `${updated.username} now has ${updated.balance.toLocaleString()} ${currency}.`
        : "That change was already applied.",
    );
    setAmount("");
    setReason("");
    void loadDetail(updated.userId);
    void loadSummary();
  }, [amount, channel, detail, loadDetail, loadSummary, mode, reason, saved]);

  if (!saved || !form) {
    return (
      <Card title="Loyalty points" icon={<Coins className="h-4 w-4" />}>
        <p className="text-sm text-neutral-500">
          The bot service hasn&apos;t reported points settings. It may need updating before points can be managed here.
        </p>
      </Card>
    );
  }

  const currency = saved.currencyName;
  const readOnly = !canAdminister;
  const dirty = JSON.stringify(form) !== JSON.stringify(formFromConfig(saved));
  const commandPreview =
    form.currencyCommand.trim().replace(/^[!$]+/, "").toLowerCase() || deriveCommand(form.currencyName.trim());
  const leaderboardUrl = `${BASE_PATH}/${channel}/leaderboard`;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const text = (key: keyof SettingsForm, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...extra}
      value={form[key] as string}
      disabled={readOnly || !!busy}
      onChange={(e) => set(key, e.target.value as never)}
      className={INPUT}
    />
  );
  const subscriptions = Object.entries(summary?.subscriptions ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card
      title={`Loyalty points · ${currency}`}
      icon={<Coins className="h-4 w-4" />}
      actions={
        saved.enabled && saved.publicLeaderboard ? (
          <a
            href={leaderboardUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-neutral-400 transition hover:text-[#53FC18]"
          >
            Public leaderboard <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null
      }
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        {notice ? <p className="text-sm text-[#53FC18]">{notice}</p> : null}

        <Toggle
          label={`${currency} loyalty points`}
          description={
            `Viewers who chatted recently earn ${currency} while the stream is live, plus bonuses for follows, subs and Kicks. ` +
            `Chat command: $${saved.effectiveCommand}.` +
            (readOnly ? " Only the broadcaster can change this." : "")
          }
          checked={saved.enabled}
          disabled={!!busy || readOnly}
          onChange={() =>
            void saveSettings(
              { enabled: !saved.enabled },
              `Loyalty points ${saved.enabled ? "disabled" : "enabled"} — applies within 15 seconds, no restart.`,
              "points-enabled",
              false,
            )
          }
        />

        {/* ------------------------------------------------------------ status */}
        <div>
          <h3 className={SECTION}>Status</h3>
          {summaryError ? (
            <p className="text-sm text-red-400">{summaryError}</p>
          ) : !summary ? (
            <p className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Database"
                  value={summary.dbAvailable ? "OK" : "Unavailable"}
                  tone={summary.dbAvailable ? "default" : "warn"}
                />
                <Stat label="Viewers" value={summary.users.toLocaleString()} />
                <Stat label={`Total ${currency}`} value={summary.totalPoints.toLocaleString()} />
                <Stat
                  label="Last payout"
                  value={
                    summary.lastTickAt
                      ? `${formatDate(summary.lastTickAt)} · ${(summary.lastTickUsers ?? 0).toLocaleString()} viewers`
                      : "—"
                  }
                />
              </dl>
              {subscriptions.length === 0 ? (
                <p className="mt-3 text-xs text-neutral-500">
                  Event subscriptions haven&apos;t been reported yet. They are set up when the bot service restarts.
                </p>
              ) : (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {subscriptions.map(([event, s]) => (
                    <li
                      key={event}
                      title={s.ok ? `Subscribed ${formatDate(s.at)}` : s.error ?? "Subscription failed"}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        s.ok
                          ? "border-neutral-700 bg-neutral-900 text-neutral-400"
                          : "border-red-900 bg-red-950/40 text-red-400"
                      }`}
                    >
                      {s.ok ? "✓" : "✕"} {event}
                      {s.ok ? "" : `: ${s.error ?? "failed"}`}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {/* ---------------------------------------------------------- settings */}
        <div>
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400 transition hover:text-neutral-200"
          >
            Settings
            <ChevronDown className={`h-3.5 w-3.5 transition ${settingsOpen ? "rotate-180" : ""}`} />
          </button>

          {settingsOpen ? (
            <div className="mt-3 space-y-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              {readOnly ? <p className="text-xs text-amber-500">Only the broadcaster can change these.</p> : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Currency name" hint={`Chat command: $${commandPreview || "…"}`}>
                  {text("currencyName", { maxLength: 24, placeholder: "$DON" })}
                </Field>
                <Field label="Command override" hint="Leave empty to use the currency name.">
                  {text("currencyCommand", { maxLength: 21, placeholder: deriveCommand(form.currencyName) || "don" })}
                </Field>
              </div>

              <div>
                <h4 className={LABEL}>Earning</h4>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Per interval">{text("pointsPerInterval", { inputMode: "numeric" })}</Field>
                  <Field label="Interval (min)">{text("intervalMinutes", { inputMode: "numeric" })}</Field>
                  <Field label="Active window (min)">{text("activeWindowMinutes", { inputMode: "numeric" })}</Field>
                  <Field label="Sub multiplier">{text("subscriberMultiplier", { inputMode: "decimal" })}</Field>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Every interval while live, each viewer who chatted within the active window earns the amount above.
                  Kick has no viewer list, so chatting is how a viewer is seen.
                </p>
                <div className="mt-3">
                  <Checkbox
                    label="Don't pay the broadcaster"
                    checked={form.excludeBroadcaster}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("excludeBroadcaster", v)}
                  />
                </div>
              </div>

              <Field label="Ignored viewers" hint="Usernames separated by commas or spaces. They never earn and never show on leaderboards.">
                <textarea
                  value={form.ignoreUsers}
                  disabled={readOnly || !!busy}
                  onChange={(e) => set("ignoreUsers", e.target.value)}
                  rows={2}
                  className={INPUT}
                />
              </Field>

              <div>
                <h4 className={LABEL}>Bonuses (0 turns one off)</h4>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Follow (once)">{text("follow", { inputMode: "numeric" })}</Field>
                  <Field label="New sub">{text("subNew", { inputMode: "numeric" })}</Field>
                  <Field label="Resub">{text("subRenewal", { inputMode: "numeric" })}</Field>
                  <Field label="Gifter, per sub">{text("giftSubGifterPerSub", { inputMode: "numeric" })}</Field>
                  <Field label="Gift recipient">{text("giftSubRecipient", { inputMode: "numeric" })}</Field>
                  <Field label="Per Kick">{text("pointsPerKick", { inputMode: "decimal" })}</Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only give bonuses while live"
                    checked={form.onlyWhileLive}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("onlyWhileLive", v)}
                  />
                  <Checkbox
                    label="Thank viewers in chat for bonuses"
                    checked={form.announce}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("announce", v)}
                  />
                </div>
              </div>

              <div>
                <h4 className={LABEL}>Giving between viewers</h4>
                <Checkbox
                  label={`Let viewers give ${form.currencyName.trim() || "points"} to each other`}
                  checked={form.giveEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("giveEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label="Minimum">{text("giveMin", { inputMode: "numeric" })}</Field>
                  <Field label="Maximum (0 = none)">{text("giveMax", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown (s)">{text("giveCooldown", { inputMode: "numeric" })}</Field>
                </div>
              </div>

              <div>
                <h4 className={LABEL}>Timeout penalty</h4>
                <Checkbox
                  label={`Deduct ${form.currencyName.trim() || "points"} when a viewer is timed out`}
                  checked={form.penaltyEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("penaltyEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Cost per second"
                    hint={costExample(form.penaltyPerSecond, form.penaltyMax, form.currencyName)}
                  >
                    {text("penaltyPerSecond", { inputMode: "decimal" })}
                  </Field>
                  <Field label="Maximum per timeout (0 = none)">
                    {text("penaltyMax", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Permanent ban (0 = ignore)" hint="A ban has no length to charge for.">
                    {text("penaltyPermanentBan", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Say in chat what was deducted"
                    checked={form.penaltyAnnounce}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("penaltyAnnounce", v)}
                  />
                  <Checkbox
                    label="Also charge for timeouts from reward redemptions"
                    checked={form.penaltyIncludeBot}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("penaltyIncludeBot", v)}
                  />
                  {form.penaltyIncludeBot ? (
                    <p className="text-xs text-amber-500/80">
                      A roulette or timeout reward already costs the redeemer points. With this
                      on they pay twice for one redemption.
                    </p>
                  ) : null}
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  A viewer never goes below zero — someone with less than the penalty loses what
                  they have. Anyone excluded from earning is excluded from being charged.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max per mod adjustment" hint="The most a mod can add, remove or set in one chat command.">
                  {text("modMaxAdjust", { inputMode: "numeric" })}
                </Field>
                <div className="flex items-center pt-5">
                  <Checkbox
                    label="Public leaderboard page"
                    checked={form.publicLeaderboard}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("publicLeaderboard", v)}
                  />
                </div>
              </div>

              {readOnly ? null : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={saveForm} busy={busy === "points-save"} disabled={!!busy || !dirty}>
                    Save settings
                  </Button>
                  <Button
                    onClick={() => {
                      setForm(formFromConfig(saved));
                      setError(null);
                    }}
                    disabled={!!busy || !dirty}
                  >
                    Reset
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* ----------------------------------------------------------- viewers */}
        <div>
          <h3 className={SECTION}>Viewers</h3>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by username"
              maxLength={26}
              className={`${INPUT} pl-9`}
            />
          </div>
          {usersError ? <p className="mt-2 text-sm text-red-400">{usersError}</p> : null}

          {users === null && !usersError ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : users && users.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              {query.trim() ? "No viewers match." : `Nobody has earned ${currency} yet.`}
            </p>
          ) : users ? (
            <ul className="mt-3 divide-y divide-neutral-800">
              {users.map((u) => (
                <li key={u.userId}>
                  <button
                    type="button"
                    onClick={() => selectUser(u.userId)}
                    className={`flex w-full items-center justify-between gap-3 py-2 text-left text-sm transition ${
                      selectedId === u.userId ? "text-[#53FC18]" : "text-neutral-200 hover:text-white"
                    }`}
                  >
                    <span className="truncate">
                      <span className="mr-2 tabular-nums text-neutral-600">#{u.rank}</span>
                      {u.username}
                    </span>
                    <span className="shrink-0 tabular-nums text-neutral-400">
                      {u.balance.toLocaleString()} {currency} · {formatWatch(u.watchSeconds)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {selectedId !== null ? (
            <div className="mt-4 space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              {detailError ? (
                <p className="text-sm text-red-400">{detailError}</p>
              ) : !detail ? (
                <p className="flex items-center gap-2 text-sm text-neutral-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-neutral-100">{detail.user.username}</span>
                    <span className="text-xs text-neutral-500">
                      {detail.user.isSub ? "Subscriber · " : ""}first seen {formatDate(detail.user.firstSeenAt)}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Balance" value={`${detail.user.balance.toLocaleString()} · #${detail.user.rank}`} />
                    <Stat label="Active time" value={formatWatch(detail.user.watchSeconds)} />
                    <Stat label="Lifetime earned" value={detail.user.lifetimeEarned.toLocaleString()} />
                    <Stat label="Last seen" value={formatDate(detail.user.lastSeenAt)} />
                  </dl>

                  <div className="space-y-3 border-t border-neutral-800 pt-4">
                    <h4 className={LABEL}>Adjust balance</h4>
                    {readOnly ? (
                      <p className="text-sm text-neutral-500">Only the broadcaster can adjust balances.</p>
                    ) : (
                    <>
                    <div className="flex flex-wrap gap-2">
                      {(["add", "remove", "set"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMode(m)}
                          disabled={!!busy}
                          className={`rounded-lg border px-3 py-1.5 text-sm capitalize transition disabled:opacity-40 ${
                            mode === m
                              ? "border-[#53FC18]/40 bg-[#53FC18]/10 text-[#53FC18]"
                              : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                      <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="numeric"
                        placeholder="Amount"
                        disabled={!!busy}
                        className={INPUT}
                      />
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={200}
                        placeholder="Reason (required, shown in the history)"
                        disabled={!!busy}
                        className={INPUT}
                      />
                    </div>
                    {adjustError ? <p className="text-sm text-red-400">{adjustError}</p> : null}
                    {adjustNotice ? <p className="text-sm text-[#53FC18]">{adjustNotice}</p> : null}
                    <Button variant="primary" onClick={() => void submitAdjust()} busy={busy === "adjust"} disabled={!!busy}>
                      Apply
                    </Button>
                    </>
                    )}
                  </div>

                  <div className="border-t border-neutral-800 pt-4">
                    <h4 className={LABEL}>History</h4>
                    {detail.ledger.length === 0 ? (
                      <p className="text-sm text-neutral-500">No changes besides active-time earnings yet.</p>
                    ) : (
                      <ul className="divide-y divide-neutral-800">
                        {detail.ledger.map((entry) => (
                          <li key={entry.id} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-start sm:gap-4">
                            <span className="w-40 shrink-0 text-xs text-neutral-500">{formatDate(entry.ts)}</span>
                            <span
                              className={`w-24 shrink-0 tabular-nums ${
                                entry.delta >= 0 ? "text-[#53FC18]" : "text-red-400"
                              }`}
                            >
                              {entry.delta >= 0 ? "+" : ""}
                              {entry.delta.toLocaleString()}
                            </span>
                            <span className="min-w-0 flex-1 text-neutral-300">
                              {REASON_LABEL[entry.reason] ?? entry.reason}
                              {entry.note ? <span className="text-neutral-500"> — {entry.note}</span> : null}
                              {entry.actor ? <span className="block text-xs text-neutral-600">{entry.actor}</span> : null}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                              = {entry.balanceAfter.toLocaleString()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
