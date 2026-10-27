"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicHistory, PublicViewer } from "@/lib/bot-api";
import ViewerHistory from "@/components/ViewerHistory";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * The public leaderboard's viewer list, like the admin dashboard's but read only:
 * search anyone by name and open their $DON history in place. The first page
 * comes from the server so the list shows before any script runs.
 */
export default function PublicViewers({
  channel,
  currency,
  initial,
  openFirst,
}: {
  channel: string;
  currency: string;
  initial: PublicViewer[];
  /** A viewer to open straight away, from ?user=. */
  openFirst?: string | null;
}) {
  const [query, setQuery] = useState("");
  const [viewers, setViewers] = useState<PublicViewer[] | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PublicHistory | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const detailSeq = useRef(0);

  // Search as you type, a moment after typing stops; an empty box is the top 100.
  useEffect(() => {
    const q = query.trim().replace(/^@+/, "");
    if (q && !/^[A-Za-z0-9_]{1,25}$/.test(q)) {
      setViewers([]);
      return;
    }
    if (!q) {
      setViewers(initial);
      setError(null);
      return;
    }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/public/${encodeURIComponent(channel)}/viewers?q=${encodeURIComponent(q)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { viewers?: PublicViewer[]; error?: string } | null;
        if (seq !== searchSeq.current) return;
        if (!res.ok) throw new Error(body?.error ?? `Search failed (${res.status})`);
        setViewers(body?.viewers ?? []);
        setError(null);
      } catch (e) {
        if (seq === searchSeq.current) setError(e instanceof Error ? e.message : "Search failed");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, channel, initial]);

  const open = useCallback(
    async (name: string) => {
      if (selected?.toLowerCase() === name.toLowerCase() && detail) {
        setSelected(null);
        setDetail(null);
        return;
      }
      setSelected(name);
      setDetail(null);
      setDetailError(null);
      const seq = ++detailSeq.current;
      try {
        const res = await fetch(`${BASE_PATH}/api/public/${encodeURIComponent(channel)}/history?name=${encodeURIComponent(name)}`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as (PublicHistory & { error?: string }) | null;
        if (seq !== detailSeq.current) return;
        if (!res.ok || !body) throw new Error(body?.error ?? `Couldn't load the history (${res.status})`);
        setDetail(body);
      } catch (e) {
        if (seq === detailSeq.current) setDetailError(e instanceof Error ? e.message : "Couldn't load the history");
      }
    },
    [channel, selected, detail],
  );

  // Open the viewer named in the link once, on first render.
  const opened = useRef(false);
  useEffect(() => {
    if (openFirst && !opened.current) {
      opened.current = true;
      void open(openFirst);
    }
  }, [openFirst, open]);

  const panel =
    selected !== null ? (
      <div className="border-t border-neutral-800 bg-neutral-900/40 px-4 py-4 sm:px-5">
        {detailError ? (
          <p className="text-sm text-red-400">{detailError}</p>
        ) : !detail ? (
          <p className="text-sm text-neutral-500">Loading {selected}&apos;s history…</p>
        ) : (
          <>
            <ViewerHistory h={detail} onOpen={(name) => void open(name)} />
          </>
        )}
      </div>
    ) : null;

  const shownSelected = viewers?.some((v) => v.username.toLowerCase() === selected?.toLowerCase());

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search any viewer, e.g. sukasblood"
        aria-label="Search viewers"
        maxLength={26}
        className="w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-500"
      />
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <p className="text-xs text-neutral-500">
        Click anyone to see every change to their {currency}, read only: the streamer&apos;s and moderators&apos; too.
      </p>

      <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
        {viewers && viewers.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-neutral-500">
            {query.trim() ? "Nobody by that name." : `Nobody has earned ${currency} yet.`}
          </p>
        ) : (
          <ol className="divide-y divide-neutral-800">
            {(viewers ?? []).map((v) => {
              const isOpen = selected?.toLowerCase() === v.username.toLowerCase();
              return (
                <li key={v.username}>
                  <button
                    type="button"
                    onClick={() => void open(v.username)}
                    aria-expanded={isOpen}
                    className={`flex w-full items-center gap-4 px-5 py-3 text-left text-sm transition hover:bg-neutral-900/60 ${isOpen ? "bg-neutral-900/60" : ""}`}
                  >
                    <span className={`w-12 shrink-0 tabular-nums ${v.rank !== null && v.rank <= 3 ? "font-semibold text-[#53FC18]" : "text-neutral-500"}`}>
                      {v.rank === null ? "—" : `#${v.rank}`}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className={`truncate ${isOpen ? "text-[#53FC18]" : "text-neutral-200"}`}>{v.username}</span>
                      {v.reel ? (
                        <span className="shrink-0 rounded-md border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 text-xs text-sky-300">
                          🎣 {v.reel}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right tabular-nums text-neutral-300">
                      {v.balance.toLocaleString("en-US")} {currency}
                    </span>
                  </button>
                  {isOpen ? panel : null}
                </li>
              );
            })}
          </ol>
        )}
        {/* Opened from a link but not in this list (e.g. outside the top 100): show it below. */}
        {selected !== null && !shownSelected ? panel : null}
      </section>
    </div>
  );
}
