"use client";

import { Fragment, useEffect, useState, useCallback, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, LabelList,
  ResponsiveContainer, CartesianGrid, Cell,
} from "recharts";
import { format, parseISO, differenceInSeconds } from "date-fns";
import { toZonedTime } from "date-fns-tz";
import SiteHeader from "./SiteHeader";

const TZ = "Asia/Singapore";

interface KPPSession {
  startedAt: string;
  endedAt: string; // ISO UTC
  durationSeconds: number;
  avgViewers: number;
  peakViewers: number;
  viewerHours: number;
  uniqueChatters: number;
  totalMessages: number;
  chatActivityRate: number;
  chatActivityWeight: number;
  engagementScore: number;
  authenticatedViewerHours?: number;
  /** null when the channel has no calibrated KPP rate. */
  estimatedCents: number | null;
}

interface Payout {
  date: string;
  actualCents: number | null;
  note: string;
}

interface KickChannel {
  slug: string;
  streamTitle: string;
  bannerUrl: string | null;
  activeSubscribers: number;
  category: { name: string } | null;
  streamUrl: string;
  vodsUrl: string;
}

interface KickVod {
  uuid: string;
  title: string;
  createdAt: string; // ISO
  duration: number;  // seconds
  url: string;
}

interface KickLive {
  isLive: boolean;
  viewerCount: number;
  thumbnailUrl: string | null;
  streamTitle: string;
  startedAt: string;
  category: { name: string } | null;
}

interface LiveSummary {
  startedAt: string;
  lastPolledAt: string;
  lastViewerCount: number;
  viewerHoursSum: number;
  peakViewers: number;
  totalMessages: number;
  uniqueChatters: number;
  chatRate: number;
  /** null while the channel has no calibrated rate. */
  estimatedCents: number | null;
}

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string) {
  return format(toZonedTime(parseISO(iso), TZ), "d MMM");
}

function fmtDuration(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function chatLabel(rate: number) {
  if (rate < 0.07) return { label: "low", color: "text-yellow-400" };
  if (rate < 0.11) return { label: "moderate", color: "text-yellow-400" };
  if (rate < 0.14) return { label: "healthy", color: "text-[#53FC18]" };
  return { label: "strong", color: "text-[#53FC18]" };
}

function InfoTip({ text, wide, position = "top", align = "center" }: {
  text: string;
  wide?: boolean;
  position?: "top" | "bottom";
  align?: "left" | "center" | "right";
}) {
  const isBottom = position === "bottom";
  const posH = align === "left"
    ? "left-0"
    : align === "right"
    ? "right-0"
    : "left-1/2 -translate-x-1/2";
  const caretH = align === "left"
    ? "left-3"
    : align === "right"
    ? "right-3"
    : "left-1/2 -translate-x-1/2";
  return (
    <span className="group relative inline-block ml-1 align-middle">
      <span className="cursor-help text-neutral-700 hover:text-neutral-400 text-[11px] select-none">ⓘ</span>
      <span className={`absolute ${isBottom ? "top-full mt-2" : "bottom-full mb-2"} ${posH} hidden group-hover:block z-20 ${wide ? "w-72" : "w-56"} rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2.5 text-xs text-neutral-300 leading-relaxed shadow-2xl pointer-events-none whitespace-normal`}>
        {text}
        <span className={`absolute ${isBottom ? "bottom-full border-b-neutral-700" : "top-full border-t-neutral-700"} ${caretH} border-4 border-transparent`} />
      </span>
    </span>
  );
}

function organicColor(rate: number) {
  if (rate >= 0.11) return "text-[#53FC18]";
  if (rate >= 0.07) return "text-yellow-400";
  return "text-red-400";
}

function matchVod(sessionStart: string, vods: KickVod[]): KickVod | null {
  const sessionMs = parseISO(sessionStart).getTime();
  // VOD created_at is typically within 2 hours of stream start
  return vods.find((v) => {
    if (!v.createdAt) return false;
    const diff = Math.abs(parseISO(v.createdAt).getTime() - sessionMs);
    return diff < 2 * 60 * 60 * 1000;
  }) ?? null;
}

function StatCard({ label, value, sub, info }: { label: string; value: string; sub?: string; info?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <span className="text-xs font-medium uppercase tracking-widest text-neutral-500">
        {label}{info && <InfoTip text={info} />}
      </span>
      <span className="text-2xl font-bold text-neutral-100">{value}</span>
      {sub && <span className="text-xs text-neutral-500">{sub}</span>}
    </div>
  );
}

/** The stream date in SGT — the day payouts are logged against. */
function sgtDate(iso: string) {
  return format(toZonedTime(parseISO(iso), TZ), "yyyy-MM-dd");
}

interface DaySummary {
  date: string;       // yyyy-MM-dd, SGT
  label: string;      // "d MMM yyyy"
  shortLabel: string; // "d MMM"
  streams: number;
  /** The day's estimates added up; null when any stream that day has no estimate. */
  estimatedCents: number | null;
}

/**
 * One entry per SGT day, oldest first. Payouts are logged per day and a day can
 * hold two streams, so anything compared with a payout has to be per day too.
 */
function daySummaries(sessions: KPPSession[]): DaySummary[] {
  const days = new Map<string, DaySummary>();
  for (const s of sessions) {
    const zoned = toZonedTime(parseISO(s.startedAt), TZ);
    const date = format(zoned, "yyyy-MM-dd");
    const day = days.get(date);
    if (!day) {
      days.set(date, { date, label: format(zoned, "d MMM yyyy"), shortLabel: format(zoned, "d MMM"), streams: 1, estimatedCents: s.estimatedCents });
    } else {
      day.streams++;
      day.estimatedCents = day.estimatedCents == null || s.estimatedCents == null ? null : day.estimatedCents + s.estimatedCents;
    }
  }
  return [...days.values()];
}

function PayoutForm({
  channel,
  sessions,
  payouts,
  onSaved,
  basePath,
  showKPP,
}: {
  channel: string;
  sessions: KPPSession[];
  payouts: Payout[];
  onSaved: () => void;
  basePath: string;
  /** With KPP hidden the amounts here are masked too — this page may be on stream. */
  showKPP: boolean;
}) {
  const BASE_PATH = basePath;
  // One entry per stream date, newest first. A day with two streams used to be listed twice.
  const sessionDates = daySummaries(sessions).reverse();

  const [date, setDate] = useState(sessionDates[0]?.date ?? "");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keyed on the saved values rather than the payouts array: the page refetches
  // every 60s with a fresh array, which wiped whatever was being typed.
  const saved = payouts.find((p) => p.date === date);
  const savedCents = saved?.actualCents ?? null;
  const savedNote = saved?.note ?? "";
  useEffect(() => {
    setAmount(savedCents != null ? (savedCents / 100).toFixed(2) : "");
    setNote(savedNote);
  }, [date, savedCents, savedNote]);

  async function save() {
    const trimmed = amount.trim();
    const value = trimmed ? Number(trimmed) : null;
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setError("Enter the payout as a dollar amount, e.g. 12.34");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/kpp/payout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, date, actualCents: value === null ? null : Math.round(value * 100), note }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? `Couldn't save the payout (${res.status})`);
        return;
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const selected = sessionDates.find((s) => s.date === date);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-neutral-400">
        Log Actual KPP Payout
      </h3>
      <div className="flex flex-wrap gap-3">
        <select
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 focus:outline-none"
        >
          {sessionDates.map((s) => (
            <option key={s.date} value={s.date}>
              {s.label}
            </option>
          ))}
        </select>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">$</span>
          <input
            type={showKPP ? "number" : "password"}
            inputMode="decimal"
            min="0"
            step="0.01"
            placeholder={!showKPP ? "••••" : selected?.estimatedCents != null ? (selected.estimatedCents / 100).toFixed(2) : "0.00"}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="rounded-lg border border-neutral-700 bg-neutral-800 pl-6 pr-3 py-2 text-sm text-neutral-200 focus:outline-none w-36"
          />
        </div>
        <input
          type="text"
          placeholder="Note (optional)"
          maxLength={200}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 min-w-[120px] rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm text-neutral-200 focus:outline-none"
        />
        <button
          onClick={save}
          disabled={saving || !date}
          className="rounded-lg bg-[#53FC18] px-4 py-2 text-sm font-semibold text-black transition hover:brightness-90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {selected && selected.streams > 1 ? (
        <p className="mt-3 text-xs text-neutral-500">
          {selected.label} had {selected.streams} streams — the payout covers the whole day.
        </p>
      ) : null}
      {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}

interface TimelinePoint {
  ts: string;
  viewers: number;
  chatters: number;
  mpm: number;
  authViewers?: number;
}

interface TimelineSession {
  index: number;
  startedAt: string | null;
  points: TimelinePoint[];
}

type TimeWindow = "1H" | "3H" | "ALL";

function autoInterval(window: TimeWindow): SampleInterval {
  return window === "1H" ? "1M" : window === "3H" ? "5M" : "15M";
}
type SampleInterval = "1M" | "5M" | "15M";

function aggregatePoints(points: TimelinePoint[], interval: SampleInterval): TimelinePoint[] {
  if (interval === "1M") return points;
  const bucketSize = interval === "5M" ? 5 : 15;
  const buckets = new Map<number, TimelinePoint[]>();
  for (const p of points) {
    const t = new Date(p.ts).getTime();
    const bucket = Math.floor(t / (bucketSize * 60_000));
    const arr = buckets.get(bucket) ?? [];
    arr.push(p);
    buckets.set(bucket, arr);
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, pts]) => {
    const authPts = pts.filter((p) => p.authViewers != null);
    return {
      ts: pts[Math.floor(pts.length / 2)].ts,
      viewers: Math.round(pts.reduce((a, p) => a + p.viewers, 0) / pts.length),
      chatters: Math.round(pts.reduce((a, p) => a + p.chatters, 0) / pts.length),
      mpm: Math.round(pts.reduce((a, p) => a + p.mpm, 0) / pts.length * 10) / 10,
      authViewers: authPts.length
        ? Math.round(authPts.reduce((a, p) => a + (p.authViewers ?? 0), 0) / authPts.length)
        : undefined,
    };
  });
}

function StreamTimeline({ channel, basePath }: { channel: string; basePath: string }) {
  const [sessions, setSessions] = useState<TimelineSession[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [interval, setInterval_] = useState<SampleInterval | "auto">("auto");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("ALL");

  const fetch_ = useCallback(async () => {
    const params = new URLSearchParams({ channel });
    const res = await fetch(`${basePath}/api/kpp/timeline?${params.toString()}`);
    if (!res.ok) return;
    const { sessions: s } = await res.json();
    // Keep the stream the viewer picked; fall back to the current one only when it's gone.
    if (s?.length) {
      setSessions(s);
      setSelectedIdx((prev) => (s.some((x: TimelineSession) => x.index === prev) ? prev : 0));
    }
  }, [basePath, channel]);

  useEffect(() => {
    fetch_();
    const t = setInterval(fetch_, 60_000);
    return () => clearInterval(t);
  }, [fetch_]);

  const currentSession = sessions.find((s) => s.index === selectedIdx) ?? sessions[0];
  const rawPoints: TimelinePoint[] = currentSession?.points ?? [];

  // Apply time window filter
  const lastTs = rawPoints.length ? new Date(rawPoints[rawPoints.length - 1].ts).getTime() : Date.now();
  const cutoffMs = timeWindow === "1H" ? lastTs - 3_600_000 : timeWindow === "3H" ? lastTs - 10_800_000 : 0;
  const filtered = cutoffMs > 0 ? rawPoints.filter((p) => new Date(p.ts).getTime() >= cutoffMs) : rawPoints;

  const resolvedInterval: SampleInterval = interval === "auto" ? autoInterval(timeWindow) : interval;
  const aggregated = aggregatePoints(filtered, resolvedInterval);

  // Format X labels as wall-clock SGT
  const chartData = aggregated.map((p) => ({
    ...p,
    label: new Date(p.ts).toLocaleTimeString("en-SG", {
      hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore", hour12: false,
    }),
  }));

  const peakViewers = chartData.length ? Math.max(...chartData.map((p) => p.viewers)) : 0;
  const peakMpm = chartData.length ? Math.max(...chartData.map((p) => p.mpm)) : 0;
  const avgMpm = chartData.length
    ? (chartData.reduce((a, p) => a + p.mpm, 0) / chartData.length).toFixed(1)
    : "0";

  if (!sessions.length) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-neutral-500">Stream Timeline</h3>
        <p className="text-xs text-neutral-600 py-4 text-center">
          Timeline data starts recording from the next stream.
        </p>
      </div>
    );
  }

  const sessionLabel = (s: TimelineSession) => {
    if (s.index === 0) return "Current";
    if (!s.startedAt) return `Stream -${s.index}`;
    return format(toZonedTime(parseISO(s.startedAt), TZ), "d MMM");
  };

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-3 border-b border-neutral-800 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Stream Timeline</h3>
          <span className="text-xs text-neutral-700">{rawPoints.length} samples · {resolvedInterval}{interval === "auto" ? " auto" : ""}</span>
          {/* Session tabs */}
          {sessions.length > 1 && (
            <div className="flex items-center gap-1 ml-2">
              {sessions.map((s) => (
                <button
                  key={s.index}
                  type="button"
                  onClick={() => { setSelectedIdx(s.index); setTimeWindow("ALL"); }}
                  className={`rounded px-2 py-0.5 text-xs transition ${
                    selectedIdx === s.index
                      ? "bg-neutral-700 text-neutral-200"
                      : "text-neutral-600 hover:text-neutral-400"
                  }`}
                >
                  {sessionLabel(s)}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Resolution */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-neutral-700 mr-1">Res</span>
            {(["1M", "5M", "15M"] as SampleInterval[]).map((v) => (
              <button key={v} type="button"
                onClick={() => setInterval_(v)}
                className={`rounded px-2 py-0.5 text-xs transition ${resolvedInterval === v && interval !== "auto" ? "bg-neutral-700 text-neutral-200" : interval === "auto" && autoInterval(timeWindow) === v ? "bg-neutral-800 text-neutral-400 ring-1 ring-neutral-700" : "text-neutral-600 hover:text-neutral-400"}`}
                title={interval === "auto" && autoInterval(timeWindow) === v ? "Auto-selected" : ""}
              >
                {v}
              </button>
            ))}
            {interval !== "auto" && (
              <button type="button" onClick={() => setInterval_("auto")}
                className="text-xs text-neutral-700 hover:text-neutral-400 ml-1" title="Reset to auto">✕</button>
            )}
          </div>
          {/* Time window */}
          <div className="flex items-center gap-1">
            <span className="text-xs text-neutral-700 mr-1">View</span>
            {(["1H", "3H", "ALL"] as TimeWindow[]).map((w) => (
              <button key={w} type="button"
                onClick={() => { setTimeWindow(w); setInterval_("auto"); }}
                className={`rounded px-2 py-0.5 text-xs transition ${timeWindow === w ? "bg-neutral-700 text-neutral-200" : "text-neutral-600 hover:text-neutral-400"}`}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Legend + key stats */}
      <div className="px-5 pt-3 pb-1 flex flex-wrap gap-5 text-xs">
        <span className="flex items-center gap-1.5 text-neutral-500">
          <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: "#84cc16" }} />
          Viewers <span className="font-semibold text-neutral-300">peak {peakViewers}</span>
        </span>
        <span className="flex items-center gap-1.5 text-neutral-500">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-cyan-400" />
          Active chatters
        </span>
        <span className="flex items-center gap-1.5 text-neutral-500">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-yellow-400" />
          Msg/min <span className="font-semibold text-neutral-300">avg {avgMpm} · peak {peakMpm}</span>
        </span>
      </div>

      {/* Chart */}
      <div className="px-5 py-4">
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={chartData} margin={{ top: 4, right: 0, left: -24, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a1a" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "#404040", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={Math.max(0, Math.floor(chartData.length / 8) - 1)}
            />
            <YAxis tick={{ fill: "#404040", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: "#0f0f0f", border: "1px solid #2a2a2a", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#606060", marginBottom: 4 }}
              formatter={(v: number, name: string) => {
                const labels: Record<string, string> = {
                  viewers: "Viewers",
chatters: "Active chatters",
                  mpm: "Msg/min",
                };
                return [v, labels[name] ?? name];
              }}
            />
            <Line type="monotone" dataKey="viewers" stroke="#84cc16" strokeWidth={2} dot={false} />
<Line type="monotone" dataKey="chatters" stroke="#22d3ee" strokeWidth={1.5} dot={false} />
            <Line type="monotone" dataKey="mpm" stroke="#facc15" strokeWidth={1} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface ChatWindowData {
  minuteOffset: number;
  label: string;
  messages: number;
  uniqueChatters: number;
}

function SessionActivityChart({
  channel,
  startedAt,
  endedAt,
  basePath,
  asQuery,
  isLive,
}: {
  channel: string;
  startedAt: string;
  endedAt: string;
  basePath: string;
  asQuery: string;
  isLive?: boolean;
}) {
  const activeChannel = channel;
  const [windows, setWindows] = useState<ChatWindowData[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchActivity = useCallback(async () => {
    const params = new URLSearchParams({ channel: activeChannel, start: startedAt, end: endedAt });
    if (asQuery) params.set("as", asQuery.replace("?as=", "").replace("as=", ""));
    const url = `${basePath}/api/kpp/session-activity?${params.toString()}`;
    let res: Response;
    try {
      res = await fetch(url);
      // The server caps concurrent log scans and answers 503 when busy. Retry a few
      // times, then give up, rather than leaving a spinner that never stops.
      for (let attempt = 0; attempt < 5 && res.status === 503; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        res = await fetch(url);
      }
    } catch {
      setLoading(false);
      return;
    }
    if (!res.ok) {
      setLoading(false);
      return;
    }
    const { windows: w } = await res.json();
    setWindows(w ?? []);
    setLoading(false);
  }, [activeChannel, startedAt, endedAt, basePath, asQuery]);

  useEffect(() => {
    fetchActivity();
    if (!isLive) return;
    const t = setInterval(fetchActivity, 60_000);
    return () => clearInterval(t);
  }, [fetchActivity, isLive]);

  const peak = windows.length ? Math.max(...windows.map((w) => w.messages)) : 0;
  const totalMessages = windows.reduce((a, w) => a + w.messages, 0);
  const peakWindow = windows.find((w) => w.messages === peak);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-10">
        <span className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-700 border-t-[#53FC18]" />
      </div>
    );
  }
  if (!windows.length) {
    return <p className="py-6 text-center text-xs text-neutral-600">No log data found for this session.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Mini stats */}
      <div className="flex flex-wrap gap-4 text-xs">
        <span className="text-neutral-500">
          <span className="font-semibold text-neutral-300">{totalMessages.toLocaleString()}</span> total messages
        </span>
        {peakWindow && (
          <span className="text-neutral-500">
            Peak <span className="font-semibold text-neutral-300">{peak} msg/{windows[1] ? windows[1].minuteOffset - windows[0].minuteOffset : 5}min</span>
            {" "}at <span className="font-semibold text-neutral-300">{peakWindow.label}</span>
          </span>
        )}
        <span className="text-neutral-500">
          Avg <span className="font-semibold text-neutral-300">
            {(totalMessages / windows.filter(w => w.messages > 0).length || 0).toFixed(0)} msg/window
          </span> (active windows only)
        </span>
      </div>

      {/* Area chart — messages over time */}
      <div>
        <div className="mb-1 text-xs text-neutral-600">Messages per window</div>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={windows} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
            <defs>
              <linearGradient id="chatGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#53FC18" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#53FC18" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: "#525252", fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval={Math.floor(windows.length / 8)}
            />
            <YAxis tick={{ fill: "#525252", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: "#171717", border: "1px solid #404040", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#e5e5e5", fontWeight: 600 }}
                    itemStyle={{ color: "#a3a3a3" }}
              formatter={(v: number, name: string) => [v, name === "messages" ? "Messages" : "Unique chatters"]}
              labelFormatter={(label) => `Time ${label}`}
            />
            <Area type="monotone" dataKey="messages" stroke="#53FC18" strokeWidth={1.5} fill="url(#chatGrad)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* Line chart — unique chatters */}
      <div>
        <div className="mb-1 text-xs text-neutral-600">Unique chatters per window</div>
        <ResponsiveContainer width="100%" height={100}>
          <LineChart data={windows} margin={{ top: 4, right: 0, left: -28, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
            <XAxis dataKey="label" hide />
            <YAxis tick={{ fill: "#525252", fontSize: 10 }} axisLine={false} tickLine={false} />
            <Tooltip
              contentStyle={{ background: "#171717", border: "1px solid #404040", borderRadius: 6, fontSize: 11 }}
              labelStyle={{ color: "#e5e5e5", fontWeight: 600 }}
                    itemStyle={{ color: "#a3a3a3" }}
              formatter={(v: number) => [v, "Unique chatters"]}
              labelFormatter={(label) => `Time ${label}`}
            />
            <Line type="monotone" dataKey="uniqueChatters" stroke="#a78bfa" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function Dashboard({
  channel,
  username,
  avatarUrl,
  channelAvatarUrl,
  isAdmin = false,
  isOwner = false,
  isLoggedIn = false,
  switcher,
  viewAs,
}: {
  channel: string;        // the channel whose data is displayed
  username: string | null;
  avatarUrl?: string;
  channelAvatarUrl?: string | null;
  isAdmin?: boolean;
  isOwner?: boolean;      // logged-in user owns this channel (can edit payouts)
  isLoggedIn?: boolean;
  switcher?: { channel: string; isSelf: boolean }[];
  viewAs?: string;        // admin override
}) {
  const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const activeChannel = viewAs ?? channel;
  const [sessions, setSessions] = useState<KPPSession[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [live, setLive] = useState<LiveSummary | null>(null);
  const [noData, setNoData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(new Date());
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [showKPP, setShowKPP] = useState(false);
  const [kickChannel, setKickChannel] = useState<KickChannel | null>(null);
  const [kickLive, setKickLive] = useState<KickLive | null>(null);
  const [kickVods, setKickVods] = useState<KickVod[]>([]);

  const asQuery = viewAs ? `&as=${encodeURIComponent(viewAs)}` : "";
  // A session without a calibrated rate has no estimate: a dash, not "$0.00".
  const kpp = (cents: number | null) => (!showKPP ? "••••" : cents == null ? "—" : dollars(cents));
  const channelQuery = `?channel=${encodeURIComponent(activeChannel)}${asQuery}`;

  const fetchData = useCallback(async () => {
    try {
      const [sessRes, liveRes] = await Promise.all([
        fetch(`${BASE_PATH}/api/kpp/sessions${channelQuery}`),
        fetch(`${BASE_PATH}/api/kpp/current${channelQuery}`),
      ]);
      // During a restart these answer 502 with HTML. Keep what's on screen; the next poll retries.
      if (!sessRes.ok || !liveRes.ok) return;
      const { sessions: s, payouts: p, noData: nd } = await sessRes.json();
      const { live: l } = await liveRes.json();
      setSessions(s ?? []);
      setPayouts(p ?? []);
      setNoData(!!nd);
      setLive(l ?? null);
    } catch {
      // Network blip — the next poll retries.
    } finally {
      setLoading(false);
    }
  }, [BASE_PATH, channelQuery]);

  const fetchKickInfo = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/kick${channelQuery}`);
      if (!res.ok) return;
      const { channel, live, vods } = await res.json();
      setKickChannel(channel ?? null);
      setKickLive(live ?? null);
      setKickVods(vods ?? []);
    } catch {
      // The next poll retries.
    }
  }, [BASE_PATH, channelQuery]);

  useEffect(() => {
    fetchData();
    fetchKickInfo();
    const interval = setInterval(() => { fetchData(); fetchKickInfo(); }, 60_000);
    return () => clearInterval(interval);
  }, [fetchData, fetchKickInfo]);

  useEffect(() => {
    // Only the live banner's hours-and-minutes label reads this. A 1s tick re-rendered every chart each second.
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Aggregate stats
  // Sessions with no calibrated rate have no estimate: left out of the total and counted separately.
  const uncalibrated = sessions.filter((s) => s.estimatedCents == null).length;
  const totalEstCents = sessions.reduce((a, s) => a + (s.estimatedCents ?? 0), 0);
  const bestSession = sessions.reduce<KPPSession | null>(
    (best, s) => (s.estimatedCents != null && (best?.estimatedCents == null || s.estimatedCents > best.estimatedCents) ? s : best),
    null,
  );
  const totalHours = sessions.reduce((a, s) => a + s.durationSeconds / 3600, 0);
  const avgChatRate = sessions.length
    ? sessions.reduce((a, s) => a + s.chatActivityRate, 0) / sessions.length
    : 0;

  // Organic metrics — only sessions where authenticatedViewerHours is recorded
  const authSessions = sessions.filter((s) => s.authenticatedViewerHours != null);
  const avgOrganicRate = authSessions.length
    ? authSessions.reduce((a, s) => a + s.authenticatedViewerHours! / s.viewerHours, 0) / authSessions.length
    : null;
  const avgAuthViewers = authSessions.length
    ? authSessions.reduce((a, s) => a + s.authenticatedViewerHours! / (s.durationSeconds / 3600), 0) / authSessions.length
    : null;
  const totalAuthVH = authSessions.reduce((a, s) => a + (s.authenticatedViewerHours ?? 0), 0);
  const totalNonAuthVH = authSessions.reduce((a, s) => a + s.viewerHours - (s.authenticatedViewerHours ?? 0), 0);

  // Chart data
  const chartData = sessions.map((s) => ({
    date: fmtDate(s.startedAt),
    estimated: s.estimatedCents == null ? null : s.estimatedCents / 100,
    viewerHours: Math.round(s.viewerHours),
    chatPct: +(s.chatActivityRate * 100).toFixed(1),
    peakViewers: s.peakViewers,
  }));

  // Organic breakdown chart data — includes both chatActivityRate and authVH% for combined chart
  const organicChartData = sessions
    .filter((s) => s.authenticatedViewerHours != null)
    .map((s) => ({
      date: fmtDate(s.startedAt),
      authVH: Math.round(s.authenticatedViewerHours!),
      nonAuthVH: Math.round(s.viewerHours - s.authenticatedViewerHours!),
      organicPct: +((s.authenticatedViewerHours! / s.viewerHours) * 100).toFixed(1),
      chatPct: +(s.chatActivityRate * 100).toFixed(1),
    }));

  // Payout comparison data — per session date
  // Per day, like payouts themselves: a day with two streams used to count its payout twice.
  const days = daySummaries(sessions);
  const dayByDate = new Map(days.map((d) => [d.date, d]));
  const payoutChart = days.map((d) => {
    const actual = payouts.find((p) => p.date === d.date);
    return {
      date: d.shortLabel,
      estimated: d.estimatedCents == null ? null : +(d.estimatedCents / 100).toFixed(2),
      actual: actual?.actualCents != null ? +(actual.actualCents / 100).toFixed(2) : null,
    };
  });
  const hasAnyActual = payoutChart.some((p) => p.actual !== null);

  // Live session elapsed
  const liveElapsed = live
    ? differenceInSeconds(now, parseISO(live.startedAt))
    : 0;
  // current.json lingers when a bot stops mid-stream, which left LIVE up for good.
  // Live means Kick says so, or the tracker polled in the last 15 minutes.
  const liveFresh = !!live && (kickLive?.isLive === true || now.getTime() - parseISO(live.lastPolledAt).getTime() < 15 * 60_000);

  return (
    <div className="min-h-screen">
      <SiteHeader
        channel={activeChannel}
        username={username}
        avatarUrl={avatarUrl}
        channelAvatarUrl={channelAvatarUrl}
        isAdmin={isAdmin}
        current="earnings"
        switcher={switcher}
      >
        <button
          type="button"
          onClick={() => setShowKPP((v) => !v)}
          className={`rounded-lg border px-3 py-2 text-sm font-medium transition active:scale-95 ${
            showKPP ? "border-[#53FC18] text-[#53FC18]" : "border-neutral-700 text-neutral-400"
          }`}
          title={showKPP ? "Hide KPP estimates" : "Show KPP estimates"}
        >
          {showKPP ? "Hide KPP" : "Show KPP"}
        </button>
      </SiteHeader>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        {/* Loading state */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-[#53FC18]" />
          </div>
        )}

        {/* No data state */}
        {!loading && noData && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-10 text-center">
            <div className="text-3xl mb-3">📊</div>
            <div className="text-lg font-semibold text-neutral-200 mb-2">No stream data yet</div>
            <div className="text-sm text-neutral-500">
              The bot isn&apos;t tracking KPP for <span className="text-[#53FC18]">{username}</span> yet.
              <br />Contact the bot owner to get your channel enrolled.
            </div>
          </div>
        )}

        {/* Live session banner */}
        {!loading && live && liveFresh && !noData && (
          <div className="overflow-hidden rounded-xl border border-[#53FC18]/30 bg-[#53FC18]/5">
            {/* Thumbnail strip */}
            {kickLive?.thumbnailUrl && (
              <a href={kickChannel?.streamUrl ?? "#"} target="_blank" rel="noopener noreferrer" className="block relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={kickLive.thumbnailUrl} alt="Live thumbnail" className="w-full object-cover max-h-48 opacity-80" />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                <div className="absolute bottom-3 left-4 flex items-center gap-2">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#53FC18] opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#53FC18]" />
                  </span>
                  <span className="text-xs font-bold uppercase tracking-widest text-[#53FC18]">Live</span>
                  {kickLive.streamTitle && (
                    <span className="text-xs text-white/80 truncate max-w-[200px]">{kickLive.streamTitle}</span>
                  )}
                </div>
              </a>
            )}
            <div className="p-5">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {!kickLive?.thumbnailUrl && (
                    <>
                      <span className="relative flex h-2.5 w-2.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#53FC18] opacity-75" />
                        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#53FC18]" />
                      </span>
                      <span className="text-xs font-semibold uppercase tracking-widest text-[#53FC18]">
                        Live
                      </span>
                    </>
                  )}
                  <span className="text-xs text-neutral-500">{fmtDuration(liveElapsed)}</span>
                  {kickLive?.category && (
                    <span className="rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-400">
                      {kickLive.category.name}
                    </span>
                  )}
                </div>
                {kickChannel?.streamUrl && (
                  <a
                    href={kickChannel.streamUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg bg-[#53FC18] px-3 py-1.5 text-xs font-semibold text-black transition hover:brightness-90"
                  >
                    Watch →
                  </a>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <div className="text-xs text-neutral-500">Viewers<InfoTip text="Concurrent viewer count from Kick's API at last poll." /></div>
                  <div className="text-xl font-bold">{(kickLive?.isLive ? kickLive.viewerCount : live.lastViewerCount).toLocaleString()}</div>
                  <div className="text-xs text-neutral-500">peak {live.peakViewers}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">Viewer Hours<InfoTip text="Cumulative viewer-hours since stream start. Calculated as Σ(avg viewers × interval) across each 5-minute poll window." /></div>
                  <div className="text-xl font-bold">{live.viewerHoursSum.toFixed(0)}</div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">Chat Rate<InfoTip text="Unique chatters in the last 5-min window ÷ concurrent viewers. The running session average is shown here." /></div>
                  <div className={`text-xl font-bold ${chatLabel(live.chatRate).color}`}>
                    {(live.chatRate * 100).toFixed(1)}%
                  </div>
                  <div className={`text-xs ${chatLabel(live.chatRate).color}`}>
                    {chatLabel(live.chatRate).label}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-neutral-500">Est. KPP<InfoTip text="Chat-engaged viewer hours so far × the calibrated rate. This is a live running estimate — toggle 'Show KPP' to reveal." /></div>
                  <div className="text-xl font-bold text-[#53FC18]">
                    {kpp(live.estimatedCents)}
                  </div>
                  {showKPP && live.estimatedCents == null ? (
                    <div className="text-xs text-neutral-500">not calibrated</div>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Stream timeline — always show for channels the bot tracks (live or not) */}
        {!loading && !noData && (
          <StreamTimeline channel={activeChannel} basePath={BASE_PATH} />
        )}

        {/* Summary stats + charts + table — hidden when loading or no data */}
        {!loading && !noData && <>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatCard
            label="Total Estimated"
            value={kpp(totalEstCents)}
            sub={uncalibrated ? `${sessions.length} sessions · ${uncalibrated} without a KPP rate` : `${sessions.length} sessions`}
            info="Sum of estimated KPP earnings across all tracked sessions. Calculated as chat-engaged viewer hours × a calibrated rate per hour. Enable 'Show KPP' to reveal figures."
          />
          <StatCard
            label="Total Stream Hours"
            value={`${totalHours.toFixed(1)}h`}
            sub={`${sessions.length} streams`}
            info="Total cumulative stream duration across all recorded sessions."
          />
          <StatCard
            label="Avg Chat Rate"
            value={`${(avgChatRate * 100).toFixed(1)}%`}
            sub={chatLabel(avgChatRate).label}
            info="Average % of concurrent viewers who chatted in any 5-minute window. Calculated as unique chatters per window ÷ viewer count, averaged across all windows and sessions."
          />
          {kickChannel ? (
            <StatCard
              label="Subscribers"
              value={kickChannel.activeSubscribers.toLocaleString()}
              sub={kickChannel.category?.name ?? undefined}
              info="Total active channel subscribers from Kick's public API. This is the current subscription count for the channel, not per-stream."
            />
          ) : (
            <StatCard
              label="Best Session"
              value={bestSession ? kpp(bestSession.estimatedCents) : "—"}
              sub={bestSession ? fmtDate(bestSession.startedAt) : undefined}
            />
          )}
        </div>

        {/* Organic breakdown — only shown when authVH data exists */}
        {organicChartData.length > 0 && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
            <div className="px-5 py-4 border-b border-neutral-800 flex items-start justify-between gap-4">
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">Chat-engaged Viewer Hours</h3>
                <p className="mt-1 text-xs text-neutral-700">Viewer hours from chatters vs non-chatting viewers, used as input to the KPP estimate model.</p>
              </div>
              {avgOrganicRate != null && (
                <div className="shrink-0 text-right">
                  <div className={`text-2xl font-bold ${organicColor(avgOrganicRate)}`}>
                    {(avgOrganicRate * 100).toFixed(1)}%
                  </div>
                  <div className="text-xs text-neutral-500">avg chat-engaged rate</div>
                </div>
              )}
            </div>

            <div className="grid gap-px sm:grid-cols-3 border-b border-neutral-800 bg-neutral-800">
              <div className="bg-neutral-900/60 px-5 py-4">
                <div className="text-xs text-neutral-500 mb-1">Avg Chat-engaged Viewers<InfoTip text="Estimated average concurrent chatters per stream — chat-engaged VH ÷ stream duration. Not the same as Kick's logged-in viewer count." /></div>
                <div className="text-xl font-bold text-neutral-200">
                  {avgAuthViewers != null ? `~${Math.round(avgAuthViewers)}` : "—"}
                </div>
                <div className="text-xs text-neutral-600 mt-0.5">concurrent chatters, per stream</div>
              </div>
              <div className="bg-neutral-900/60 px-5 py-4">
                <div className="text-xs text-neutral-500 mb-1">Chat-engaged Viewer Hours<InfoTip text="Total viewer-hours from viewers who chatted in at least one 5-minute window. Each active chatter contributes 5 min (1/12 hr) per window. This is the primary input to the KPP estimate." wide /></div>
                <div className="text-xl font-bold text-[#53FC18]">{totalAuthVH.toFixed(0)} vh</div>
                <div className="text-xs text-neutral-600 mt-0.5">KPP estimate input</div>
              </div>
              <div className="bg-neutral-900/60 px-5 py-4">
                <div className="text-xs text-neutral-500 mb-1">Non-chatting Viewer Hours<InfoTip text="Total VH minus chat-engaged VH. These viewers watched without sending any messages during a 5-minute window. Not used in the KPP estimate." /></div>
                <div className="text-xl font-bold text-neutral-500">{totalNonAuthVH.toFixed(0)} vh</div>
                <div className="text-xs text-neutral-600 mt-0.5">lurkers / passive viewers</div>
              </div>
            </div>

            <div className="p-5">
              <p className="mb-3 text-xs text-neutral-600">
                Both metrics measure chat engagement as a % of viewership — plotted together to show they track each other.
              </p>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={organicChartData} margin={{ top: 8, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                  <XAxis dataKey="date" tick={{ fill: "#737373", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis
                    domain={[0, Math.max(20, ...organicChartData.map((d) => Math.max(d.organicPct, d.chatPct))) + 2]}
                    tick={{ fill: "#737373", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v) => `${v}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: "#111111", border: "1px solid #404040", borderRadius: 8 }}
                    labelStyle={{ color: "#e5e5e5", fontWeight: 600, marginBottom: 4 }}
                    itemStyle={{ color: "#a3a3a3" }}
                    formatter={(v: number, name: string) => [
                      `${v}%`,
                      name === "chatPct" ? "Chat rate (5-min window)" : "Chat-engaged VH %"
                    ]}
                  />
                  <Line type="monotone" dataKey="chatPct" stroke="#53FC18" strokeWidth={2} dot={{ r: 4, fill: "#53FC18" }} />
                  <Line type="monotone" dataKey="organicPct" stroke="#53FC18" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 4, fill: "#53FC18" }} strokeOpacity={0.5} />
                </LineChart>
              </ResponsiveContainer>
              <div className="flex items-center gap-5 mt-3 text-xs text-neutral-600">
                <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-[#53FC18]"/>Chat rate (5-min window avg)</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-5 bg-[#53FC18] opacity-50" style={{borderTop: "2px dashed #53FC18", background: "none"}}/>Chat-engaged VH %</span>
              </div>
            </div>
          </div>
        )}

        {/* Charts row — Est. KPP only shown when KPP toggled on */}
        <div className="grid gap-4">
          {/* Estimated KPP per session — hidden when KPP toggled off */}
          {showKPP && <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Estimated KPP per Session
            </h3>
            <p className="mt-1 mb-4 text-xs text-neutral-700">Chat-engaged VH × calibrated rate, per stream. Unlock with Show KPP.</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#737373", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#737373", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: "#171717", border: "1px solid #404040", borderRadius: 8 }}
                  labelStyle={{ color: "#e5e5e5", fontWeight: 600 }}
                    itemStyle={{ color: "#a3a3a3" }}
                  formatter={(v) => [typeof v === "number" ? `$${v.toFixed(2)}` : "—", "Estimated"]}
                />
                <Bar dataKey="estimated" radius={[4, 4, 0, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill="#53FC18" fillOpacity={0.85} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>}

        </div>

        {/* Estimated vs Actual payouts */}
        {hasAnyActual && showKPP && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Estimated vs Actual KPP per Session
              <InfoTip text="Compares the model estimate (chat-engaged VH × rate) against the actual payout you entered. The gap shows how accurately the model predicts real earnings." wide />
            </h3>
            <p className="mt-1 mb-4 text-xs text-neutral-700">Light bars = estimated · solid bars = actual payout entered manually.</p>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={payoutChart} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#262626" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: "#737373", fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: "#737373", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v}`} />
                <Tooltip
                  contentStyle={{ background: "#171717", border: "1px solid #404040", borderRadius: 8 }}
                  labelStyle={{ color: "#e5e5e5", fontWeight: 600 }}
                    itemStyle={{ color: "#a3a3a3" }}
                  formatter={(v, name) => [typeof v === "number" ? `$${v.toFixed(2)}` : "—", name === "estimated" ? "Estimated" : "Actual"]}
                />
                <Bar dataKey="estimated" radius={[4, 4, 0, 0]} fill="#53FC18" fillOpacity={0.4} />
                <Bar dataKey="actual" radius={[4, 4, 0, 0]} fill="#53FC18" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Session table */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden">
          <div className="px-5 py-4 border-b border-neutral-800">
            <h3 className="text-xs font-semibold uppercase tracking-widest text-neutral-500">
              Session History<InfoTip position="bottom" text="Each row is one recorded stream. Click a row to expand the chat activity chart for that session. VOD link appears if the recording is still available on Kick." wide />
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-neutral-800 text-left text-xs text-neutral-500">
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Date<InfoTip position="bottom" align="left" text="Stream date in Singapore time (SGT). Click any row to expand the chat activity chart for that session." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Duration<InfoTip position="bottom" align="left" text="Total stream length from first detection to offline. May be slightly shorter than actual if the bot joined mid-stream." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Avg Viewers<InfoTip position="bottom" text="Time-weighted average concurrent viewer count across the session. Calculated as total viewer-hours ÷ stream duration." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Peak<InfoTip position="bottom" text="Highest concurrent viewer count observed during the session." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">VH<InfoTip position="bottom" text="Total viewer-hours: sum of (avg viewers × interval) across each 5-minute poll window. The raw input for all engagement calculations." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Chatters<InfoTip position="bottom" text="Cumulative unique chatters across the entire session. Counts each person once regardless of how many messages they sent." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap">Chat %<InfoTip position="bottom" text="Unique chatters in each 5-min window ÷ concurrent viewers. The session running average shown as a label." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap text-right">Chat VH<InfoTip position="bottom" align="right" text="Chat-engaged viewer hours: sum of (active chat windows × 5 min) across all chatters in this session. Used as input to the KPP estimate." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap text-right">Est. KPP<InfoTip position="bottom" align="right" text="Chat-engaged VH × $1.045 calibrated rate. Toggle 'Show KPP' to reveal." /></th>
                  <th className="px-5 py-3 font-medium whitespace-nowrap text-right">Actual<InfoTip position="bottom" align="right" text="Actual payout entered manually from your Kick creator dashboard. Used to validate the estimate model." /></th>
                  <th className="px-5 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {[...sessions].reverse().map((s, i, rows) => {
                  const { label, color } = chatLabel(s.chatActivityRate);
                  const sessionDate = sgtDate(s.startedAt);
                  // A payout covers the whole day, so it shows once — on the day's latest
                  // stream — against the day's combined estimate.
                  const firstOfDay = i === 0 || sgtDate(rows[i - 1].startedAt) !== sessionDate;
                  const payout = firstOfDay ? payouts.find((p) => p.date === sessionDate) : undefined;
                  const dayEstimate = dayByDate.get(sessionDate)?.estimatedCents ?? null;
                  const diff = payout?.actualCents != null && dayEstimate != null ? payout.actualCents - dayEstimate : null;
                  const vod = matchVod(s.startedAt, kickVods);
                  const isSelected = selectedSession === s.startedAt;
                  return (
                    <Fragment key={s.startedAt}>
                      <tr
                        onClick={() => setSelectedSession(isSelected ? null : s.startedAt)}
                        className={`border-b border-neutral-800/50 cursor-pointer transition ${isSelected ? "bg-neutral-800/50" : "hover:bg-neutral-800/30"}`}
                      >
                        <td className="px-5 py-3 text-neutral-300">
                          <span className="flex items-center gap-1.5">
                            <span className={`transition-transform text-neutral-600 text-xs ${isSelected ? "rotate-90" : ""}`}>▶</span>
                            {fmtDate(s.startedAt)}
                          </span>
                        </td>
                        <td className="px-5 py-3 text-neutral-400">{fmtDuration(s.durationSeconds)}</td>
                        <td className="px-5 py-3">{s.avgViewers.toFixed(0)}</td>
                        <td className="px-5 py-3">{s.peakViewers}</td>
                        <td className="px-5 py-3">{s.viewerHours.toFixed(0)}</td>
                        <td className="px-5 py-3">{s.uniqueChatters}</td>
                        <td className="px-5 py-3">
                          <span className={color}>{(s.chatActivityRate * 100).toFixed(1)}%</span>
                          <span className={`ml-1 text-xs ${color}`}>({label})</span>
                        </td>
                        <td className="px-5 py-3 text-right text-neutral-400">
                          {s.authenticatedViewerHours != null
                            ? s.authenticatedViewerHours.toFixed(0)
                            : <span className="text-neutral-700">—</span>}
                        </td>
                        <td className="px-5 py-3 text-right font-semibold text-[#53FC18]">
                          {kpp(s.estimatedCents)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {payout?.actualCents != null ? (
                            <span className="font-semibold text-neutral-200">
                              {kpp(payout.actualCents)}
                              {diff !== null && showKPP && (
                                <span className={`ml-1.5 text-xs ${diff >= 0 ? "text-[#53FC18]" : "text-red-400"}`}>
                                  {diff >= 0 ? "+" : ""}{dollars(diff)}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-neutral-700">—</span>
                          )}
                        </td>
                        <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                          {vod ? (
                            <a href={vod.url} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-[#53FC18] hover:brightness-90 transition" title={vod.title}>
                              VOD ↗
                            </a>
                          ) : kickChannel?.vodsUrl ? (
                            <a href={kickChannel.vodsUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs text-neutral-600 hover:text-neutral-400 transition">
                              Videos ↗
                            </a>
                          ) : null}
                        </td>
                      </tr>
                      {isSelected && (
                        <tr key={`${s.startedAt}-detail`} className="border-b border-neutral-800/50 bg-neutral-900/40">
                          <td colSpan={12} className="px-5 py-5">
                            <div className="mb-3 flex items-center justify-between">
                              <div>
                                <span className="text-sm font-semibold text-neutral-200">{fmtDate(s.startedAt)} — Chat Activity</span>
                                <span className="ml-2 text-xs text-neutral-500">{fmtDuration(s.durationSeconds)} stream</span>
                              </div>
                              {vod && (
                                <a href={vod.url} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-[#53FC18] hover:brightness-90">
                                  Watch VOD ↗
                                </a>
                              )}
                            </div>
                            <SessionActivityChart
                              channel={activeChannel}
                              startedAt={s.startedAt}
                              endedAt={s.endedAt}
                              basePath={BASE_PATH}
                              asQuery={asQuery}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Payout form — owner only */}
        {isOwner && <PayoutForm channel={activeChannel} sessions={sessions} payouts={payouts} onSaved={fetchData} basePath={BASE_PATH} showKPP={showKPP} />}
        {!isOwner && !isLoggedIn && (
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 px-5 py-4 text-xs text-neutral-600 text-center">
            <a href={`${BASE_PATH}/api/auth/login`} className="text-neutral-500 hover:text-[#53FC18] transition">Sign in with Kick</a> to log actual KPP payouts for this channel.
          </div>
        )}
        </>}
      </main>

      <footer className="border-t border-neutral-900 mt-4">
        <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-700">
          <span>KPP estimates are model-derived and do not represent official Kick earnings · sourced from public Kick APIs and live stream monitoring</span>
          <span>For educational and informational use only</span>
        </div>
      </footer>
    </div>
  );
}
