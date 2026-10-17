"use client";

// Possible cheaters in the offline fishing games: players whose timing looks like a
// script or an AI agent (the bot's community/cheat-signals.ts). Evidence for the owner
// to judge; nothing happens to anyone automatically.

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert } from "lucide-react";
import type { CheatSuspect, CheatSuspects } from "@/lib/bot-api";
import { Button, Card } from "./ui";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const RANGES = [1, 7, 30] as const;

const ago = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

const FLAG_TONE: Record<CheatSuspect["flags"][number]["code"], string> = {
  fast_answers: "border-red-900 bg-red-950/40 text-red-300",
  instant_traps: "border-amber-900 bg-amber-950/40 text-amber-300",
  no_sleep: "border-violet-900 bg-violet-950/40 text-violet-300",
  clockwork_casts: "border-sky-900 bg-sky-950/40 text-sky-300",
  parked_don: "border-emerald-900 bg-emerald-950/40 text-emerald-300",
};

export default function SuspectsCard({ channel }: { channel: string }) {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<CheatSuspects | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/bot/${encodeURIComponent(channel)}/points/suspects?days=${days}`, { cache: "no-store" });
      const body = (await res.json()) as CheatSuspects & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setData(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [channel, days]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card
      title="Possible cheaters"
      icon={<ShieldAlert className="h-4 w-4" />}
      actions={
        <div className="flex items-center gap-2">
          {RANGES.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-md px-2.5 py-1 text-xs ${d === days ? "bg-neutral-700 text-neutral-100" : "text-neutral-400 hover:text-neutral-200"}`}
            >
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
          <Button onClick={() => void load()} busy={busy}>
            Refresh
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-neutral-500">
          Offline fishing that looks scripted. <b className="text-neutral-400">Fast, flawless answers</b>: trap or cast checks passed in a median under 7 seconds with
          hardly a wrong try (people take 10–60s; an AI agent a few). <b className="text-neutral-400">Instant trap hauls</b>: traps collected a median under 30 seconds
          after they fill. <b className="text-neutral-400">No sleep</b>: offline play in 18+ hours of one day, never stopping 4 hours.{" "}
          <b className="text-neutral-400">Clockwork casting</b>: 11+ casts in a row whose gaps barely vary. <b className="text-neutral-400">Parked $DON</b>: gave
          away 80%+ of their balance (1,000+) and kept fishing offline within a day — a check&apos;s fine is a share of the balance, so an emptied account fails
          checks for free; the evidence names who got it (often an alt). These are evidence, not proof: a dedicated player can trip
          one, so look for several together or a pattern that keeps coming back. Nothing happens automatically — a $DON reset is in the viewer search above.
        </p>

        {!data && busy ? (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : null}

        {data && data.suspects.length === 0 ? (
          <p className="text-sm text-neutral-400">Nobody flagged in the last {data.days === 1 ? "24 hours" : `${data.days} days`}.</p>
        ) : null}

        {data?.suspects.map((s) => (
          <div key={s.userId} className="rounded-lg border border-neutral-800 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold text-neutral-100">{s.username}</span>
              <span className="text-xs text-neutral-500">
                {s.flags.length} flag{s.flags.length === 1 ? "" : "s"} · last seen {ago(s.lastSeen)}
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {s.flags.map((f) => (
                <li key={f.code} className="flex flex-wrap items-start gap-2 text-sm">
                  <span className={`shrink-0 rounded border px-1.5 py-0.5 text-xs font-medium ${FLAG_TONE[f.code]}`}>{f.label}</span>
                  <span className="text-neutral-300">{f.evidence}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-neutral-500">
              Offline: {s.casts} casts, {s.trapHauls} trap hauls · checks {s.checks.asked} asked, {s.checks.passed} passed, {s.checks.wrongTries} wrong tries,{" "}
              {s.checks.failed} failed
            </p>
          </div>
        ))}

        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </div>
    </Card>
  );
}
