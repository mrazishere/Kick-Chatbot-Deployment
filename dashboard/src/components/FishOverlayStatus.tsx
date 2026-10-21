"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "./ui";

// The fishing overlay as it is right now, on the Fishing > Overlay tab: each open page (an OBS
// source, a preview tab) with whether it's drawing, and whether the bot counts the overlay as
// showing, which is what lets big bites go out. A stuck source shows here before anyone on
// stream says so, and the button reloads every open page, as $cmd fish overlay reload does.

interface Page {
  id: string;
  agoMs: number;
  painted: number;
  stall: number;
  hidden: boolean;
  obs: boolean;
  build: string | null;
}

interface Status {
  pages: Page[];
  liveBuild: string | null;
  bot: { showing: boolean; off: boolean; health: { painted: number; stallMs: number; hidden?: boolean } | null };
}

/** Not drawing for this long counts as stuck, as the bot sees it (fish-overlay STALL_PAUSE_MS). */
const STUCK_MS = 8_000;
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const EVERY_MS = 3_000;

const secs = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`);

function pageState(p: Page): { label: string; tone: string } {
  if (p.hidden) return { label: "Hidden (its scene isn't on)", tone: "text-neutral-400" };
  if (p.stall >= STUCK_MS) return { label: `Frozen: no frame for ${secs(p.stall)}`, tone: "text-red-400" };
  return { label: "Drawing", tone: "text-[#53FC18]" };
}

export default function FishOverlayStatus({ channel, canReload }: { channel: string; canReload: boolean }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${BASE_PATH}/api/bot/${encodeURIComponent(channel)}/fishing-overlay`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as (Status & { error?: string }) | null;
      if (!res.ok || !body?.pages) setError(body?.error ?? `Could not load the overlay's status (${res.status})`);
      else {
        setStatus(body);
        setError(null);
      }
    } catch {
      setError("Network error, retrying");
    }
  }, [channel]);

  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, EVERY_MS);
    return () => clearInterval(t);
  }, [load]);

  const reload = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/bot/${encodeURIComponent(channel)}/fishing-overlay`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) setError(body?.error ?? `Could not reload (${res.status})`);
      else setNotice("Told every open fishing overlay to reload. They do within a second or two.");
    } catch {
      setError("Network error, try again");
    } finally {
      setBusy(false);
      setTimeout(() => void load(), 2_500);
    }
  };

  const bot = status?.bot;
  const obsOpen = status?.pages.some((p) => p.obs) ?? false;

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-neutral-200">Live status</h4>
          <p className="mt-1 text-xs text-neutral-500">
            {!status
              ? "Loading…"
              : bot?.off
                ? "Switched off for this stream: fishing replies go to chat and big bites wait."
                : bot?.showing
                  ? "Showing: big bites go out."
                  : status.pages.length
                    ? "Not drawing: big bites wait until it does. The bot reloads a frozen source by itself while you're live."
                    : "No fishing overlay is open: big bites wait for one."}
          </p>
        </div>
        <Button onClick={() => void reload()} busy={busy} disabled={busy || !canReload || !status?.pages.length}>
          <RefreshCw className="h-4 w-4" /> Reload overlay
        </Button>
      </div>
      {error ? <p className="mt-3 text-sm text-red-400">{error}</p> : null}
      {notice ? <p className="mt-3 text-sm text-[#53FC18]">{notice}</p> : null}
      {status && status.pages.length ? (
        <ul className="mt-3 divide-y divide-neutral-800 rounded-lg border border-neutral-800">
          {status.pages.map((p) => {
            const state = pageState(p);
            const outdated = !!status.liveBuild && !!p.build && p.build !== status.liveBuild;
            return (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
                <span className="text-neutral-300">
                  {p.obs ? "OBS browser source" : "Browser tab"}
                  {outdated ? <span className="ml-2 text-xs text-amber-400">older build, reloads itself soon</span> : null}
                </span>
                <span className={`text-xs ${state.tone}`}>
                  {state.label} · polled {secs(p.agoMs)} ago
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {status && !obsOpen && status.pages.length ? (
        <p className="mt-2 text-xs text-neutral-500">No OBS source is open, only browser tabs, so these count instead.</p>
      ) : null}
    </div>
  );
}
