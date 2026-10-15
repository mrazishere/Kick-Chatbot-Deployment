"use client";

// The prize wheel's items and settings. The wheel spins on the fishing overlay from
// chat (!wheel spin); mods can add and remove items there too, so a save names the
// version it loaded and the bot refuses it if chat changed the wheel meanwhile.

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RotateCw, Trash2 } from "lucide-react";
import type { WheelConfig, WheelItem } from "@/lib/bot-api";
import { Button, Card, Toggle } from "./ui";

/** The overlay's palette, so an item without a colour shows the one it'll get. */
const PALETTE = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#06b6d4", "#84cc16", "#a855f7"];

interface Row extends WheelItem {
  /** A stable key for the list while editing. */
  k: number;
}

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

let nextKey = 1;
const rowsOf = (items: WheelItem[]): Row[] => items.map((it) => ({ ...it, k: nextKey++ }));

export default function WheelCard({ channel, fishingOn }: { channel: string; fishingOn: boolean }) {
  const url = `${BASE_PATH}/api/bot/${encodeURIComponent(channel)}/wheel`;
  const [loaded, setLoaded] = useState<WheelConfig | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [spinSeconds, setSpinSeconds] = useState("6");
  const [removeWinner, setRemoveWinner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((w: WheelConfig) => {
    setLoaded(w);
    setRows(rowsOf(w.items));
    setSpinSeconds(String(w.spinSeconds));
    setRemoveWinner(w.removeWinner);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as WheelConfig & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      apply(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [url, apply]);

  useEffect(() => {
    void load();
  }, [load]);

  const limits = loaded?.limits ?? { maxItems: 30, maxLabel: 30, spinSeconds: { min: 3, max: 20 } };
  const dirty =
    !!loaded &&
    (Number(spinSeconds) !== loaded.spinSeconds ||
      removeWinner !== loaded.removeWinner ||
      JSON.stringify(rows.map(({ label, color }) => ({ label: label.trim(), ...(color ? { color } : {}) }))) !== JSON.stringify(loaded.items));

  const save = async () => {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: rows.map(({ label, color }) => ({ label, ...(color ? { color } : {}) })),
          spinSeconds: Number(spinSeconds),
          removeWinner,
          version: loaded.version,
        }),
      });
      const body = (await res.json()) as WheelConfig & { error?: string };
      if (res.status === 409) {
        setError(body.error ?? "The wheel was changed from chat since you loaded it.");
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      apply(body);
      setNotice("Saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (k: number, patch: Partial<WheelItem>) => setRows((rs) => rs.map((r) => (r.k === k ? { ...r, ...patch } : r)));

  return (
    <Card
      title="Spin the wheel"
      icon={<RotateCw className="h-4 w-4" />}
      actions={
        <Button onClick={() => void load()} disabled={busy}>
          Reload
        </Button>
      }
    >
      <div className="space-y-4">
        <p className="text-xs leading-relaxed text-neutral-500">
          A prize wheel on the fishing overlay. The streamer, the bot owner and mods spin it with <code className="text-neutral-300">!wheel spin</code> (or{" "}
          <code className="text-neutral-300">!spin</code>) and can change it with <code className="text-neutral-300">!wheel add &lt;item&gt;</code> and{" "}
          <code className="text-neutral-300">!wheel remove &lt;item&gt;</code>; anyone can list it with <code className="text-neutral-300">!wheel</code>. Every item is
          equally likely. Fishing alerts wait on the overlay while it spins, and chat gets the result.
        </p>
        {!fishingOn ? (
          <p className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
            The wheel shows on the fishing overlay, so it needs loyalty points with Fishing on.
          </p>
        ) : null}

        {!loaded && !error ? (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : null}

        {loaded ? (
          <>
            <div className="space-y-2">
              {rows.length === 0 ? <p className="text-sm text-neutral-500">No items yet.</p> : null}
              {rows.map((r, i) => (
                <div key={r.k} className="flex items-center gap-2">
                  <span className="w-6 text-right text-xs tabular-nums text-neutral-500">{i + 1}.</span>
                  <input
                    type="color"
                    value={r.color ?? PALETTE[i % PALETTE.length]}
                    onChange={(e) => update(r.k, { color: e.target.value })}
                    className="h-8 w-9 shrink-0 cursor-pointer rounded border border-neutral-700 bg-neutral-900 p-0.5"
                    aria-label={`Colour for item ${i + 1}`}
                    title={r.color ? "Colour" : "Automatic colour — pick one to set it"}
                  />
                  {r.color ? (
                    <button type="button" onClick={() => update(r.k, { color: undefined })} className="text-xs text-neutral-500 hover:text-neutral-300" title="Back to the automatic colour">
                      auto
                    </button>
                  ) : null}
                  <input
                    type="text"
                    value={r.label}
                    maxLength={limits.maxLabel}
                    onChange={(e) => update(r.k, { label: e.target.value })}
                    placeholder="Item"
                    className="min-w-0 flex-1 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
                  />
                  <button
                    type="button"
                    onClick={() => setRows((rs) => rs.filter((x) => x.k !== r.k))}
                    className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
                    aria-label={`Remove item ${i + 1}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <Button onClick={() => setRows((rs) => [...rs, { label: "", k: nextKey++ }])} disabled={rows.length >= limits.maxItems}>
                <Plus className="h-4 w-4" /> Add item
              </Button>
              <p className="text-xs text-neutral-500">
                {rows.length} of {limits.maxItems} items, up to {limits.maxLabel} characters each. It needs at least 2 to spin.
              </p>
            </div>

            <label className="block max-w-xs">
              <span className="text-sm font-medium text-neutral-200">Spin length (seconds)</span>
              <input
                type="number"
                min={limits.spinSeconds.min}
                max={limits.spinSeconds.max}
                value={spinSeconds}
                onChange={(e) => setSpinSeconds(e.target.value)}
                className="mt-1.5 w-24 rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm tabular-nums text-neutral-200 outline-none focus:border-neutral-500"
              />
              <span className="mt-1 block text-xs text-neutral-500">
                {limits.spinSeconds.min}–{limits.spinSeconds.max}. The result then shows for 5 seconds.
              </span>
            </label>

            <Toggle
              label="Remove the winner"
              description="Take the item the wheel lands on off the wheel, like a raffle wheel. It goes once chat has the result."
              checked={removeWinner}
              onChange={() => setRemoveWinner((v) => !v)}
            />

            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={() => void save()} busy={busy} disabled={!dirty}>
                Save wheel
              </Button>
              {notice && !dirty ? <span className="text-sm text-[#53FC18]">{notice}</span> : null}
            </div>
          </>
        ) : null}

        {error ? <p className="text-sm text-red-400">{error}</p> : null}
      </div>
    </Card>
  );
}
