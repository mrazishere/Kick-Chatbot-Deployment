"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FishAlert } from "@/lib/bot-api";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** How often the page asks for new alerts. */
const POLL_MS = 10_000;
/** How long a pop-up stays. */
const TOAST_MS = 8_000;
/** Pop-ups for alerts from before the page opened: the latest few, the rest wait in the bell. */
const AWAY_TOASTS = 3;

const ago = (ts: number): string => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};

/**
 * The signed-in viewer's fishing alerts: a 🔔 with how many are unread, pop-ups as new ones come
 * in (and for the latest few from while they were away), and a list of the recent ones. What was
 * read is kept in this browser (localStorage), per channel and viewer.
 */
export default function FishAlerts({ channel, viewer }: { channel: string; viewer: string }) {
  const api = `${BASE_PATH}/api/public/${encodeURIComponent(channel)}/alerts`;
  // Per viewer too: two people signing in on one browser each keep their own.
  const readKey = `fish-alerts-read:${channel}:${viewer.toLowerCase()}`;
  const [alerts, setAlerts] = useState<FishAlert[]>([]);
  const [readId, setReadId] = useState(0);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<FishAlert[]>([]);
  // The newest id fetched, so each poll asks only for newer ones; null before the first load.
  const lastId = useRef<number | null>(null);

  const toast = useCallback((list: FishAlert[]) => {
    if (!list.length) return;
    setToasts((t) => [...t, ...list].slice(-AWAY_TOASTS));
    const ids = new Set(list.map((a) => a.id));
    setTimeout(() => setToasts((t) => t.filter((a) => !ids.has(a.id))), TOAST_MS);
  }, []);

  const load = useCallback(async () => {
    try {
      const first = lastId.current === null;
      const res = await fetch(`${api}${first ? "" : `?after=${lastId.current}`}`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { alerts?: FishAlert[] } | null;
      if (!res.ok || !body?.alerts) return;
      const got = body.alerts;
      if (got.length) lastId.current = got[got.length - 1].id;
      else if (first) lastId.current = 0;
      setAlerts((a) => (first ? got : [...a, ...got]).slice(-30));
      const read = Number(localStorage.getItem(readKey) ?? 0) || 0;
      setReadId(read);
      toast(first ? got.filter((a) => a.id > read).slice(-AWAY_TOASTS) : got);
    } catch {
      // The next poll tries again.
    }
  }, [api, readKey, toast]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(poll);
  }, [load]);

  const newest = alerts.length ? alerts[alerts.length - 1].id : 0;
  const unread = alerts.filter((a) => a.id > readId).length;

  function toggle() {
    setOpen((o) => !o);
    if (!open && newest > readId) {
      localStorage.setItem(readKey, String(newest));
      setReadId(newest);
    }
  }

  return (
    <>
      <div className="relative">
        <button
          type="button"
          onClick={toggle}
          aria-label={unread ? `${unread} new alerts` : "Alerts"}
          className="relative rounded-lg border border-neutral-700 px-2.5 py-1.5 text-sm text-neutral-300 transition hover:border-neutral-500"
        >
          🔔
          {unread ? (
            <span className="absolute -right-1.5 -top-1.5 min-w-[1.1rem] rounded-full bg-red-500 px-1 text-center text-[11px] font-semibold leading-[1.1rem] text-white">{unread > 9 ? "9+" : unread}</span>
          ) : null}
        </button>
        {open ? (
          <div className="absolute right-0 z-30 mt-2 max-h-96 w-80 overflow-y-auto rounded-xl border border-neutral-800 bg-neutral-950 p-2 shadow-xl">
            {alerts.length ? (
              <ul className="space-y-1">
                {[...alerts].reverse().map((a) => (
                  <li key={a.id} className="rounded-lg px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-900">
                    <p>{a.text}</p>
                    <p className="mt-0.5 text-xs text-neutral-500">{ago(a.ts)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-4 text-sm text-neutral-500">Nothing yet. Steals on your fish, gifts, trades, duels and big bites show up here.</p>
            )}
          </div>
        ) : null}
      </div>

      {toasts.length ? (
        <div className="fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {toasts.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setToasts((t) => t.filter((x) => x.id !== a.id))}
              className="rounded-xl border border-[#53FC18]/40 bg-neutral-950/95 px-4 py-3 text-left text-sm text-neutral-100 shadow-xl"
            >
              {a.text}
              <span className="mt-0.5 block text-xs text-neutral-500">{ago(a.ts)} · tap to close</span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
