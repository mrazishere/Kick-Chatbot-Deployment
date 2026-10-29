"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ChannelRow } from "@/app/api/channels/route";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

function statusStyle(status: string): { label: string; className: string; dot: string } {
  const map: Record<string, { label: string; className: string; dot: string }> = {
    online: { label: "Bot online", className: "border-[#53FC18]/30 bg-[#53FC18]/10 text-[#53FC18]", dot: "bg-[#53FC18]" },
    stopped: { label: "Bot stopped", className: "border-amber-700/40 bg-amber-950/40 text-amber-400", dot: "bg-amber-400" },
    errored: { label: "Bot errored", className: "border-red-800/50 bg-red-950/40 text-red-400", dot: "bg-red-400" },
  };
  return (
    map[status] ?? {
      label: status === "not-deployed" ? "Bot not deployed" : status,
      className: "border-neutral-700 bg-neutral-900 text-neutral-400",
      dot: "bg-neutral-500",
    }
  );
}

export default function ChannelGrid({ initial }: { initial: ChannelRow[] }) {
  const [rows, setRows] = useState<ChannelRow[]>(initial);

  // Quiet background refresh — same cadence as the bot page. Failures are
  // ignored so a blip never replaces the list with an error.
  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch(`${BASE_PATH}/api/channels`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { channels?: ChannelRow[] };
        if (Array.isArray(data.channels)) setRows(data.channels);
      } catch {
        // try again next tick
      }
    };
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);

  if (rows.length === 0) {
    return <p className="text-sm text-neutral-500">No channels enrolled yet.</p>;
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rows.map((ch) => {
        const s = statusStyle(ch.status);
        const days = ch.grantDaysLeft;
        const grantTone = !ch.hasChannelOAuth
          ? "text-amber-500"
          : days !== null && days <= 2
            ? "text-red-400"
            : days !== null && days <= 20
              ? "text-amber-400"
              : "text-neutral-500";

        return (
          <div
            key={ch.channel}
            className="rounded-xl border border-neutral-800 bg-neutral-900/60 transition hover:border-neutral-600"
          >
            <Link href={`/${ch.channel}/bot`} className="block px-5 pt-4 pb-3">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate font-semibold text-neutral-200">{ch.channel}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {ch.isLive ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#53FC18]/30 bg-[#53FC18]/10 px-2.5 py-1 text-xs font-medium text-[#53FC18]">
                      <span className="relative flex h-1.5 w-1.5">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#53FC18] opacity-75" />
                        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#53FC18]" />
                      </span>
                      LIVE
                      {ch.viewers > 0 ? (
                        <span className="font-normal opacity-80">{ch.viewers.toLocaleString()}</span>
                      ) : null}
                    </span>
                  ) : null}
                  <span
                    className={`inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium ${s.className}`}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                    {s.label}
                  </span>
                </span>
              </div>
              <div className={`mt-2 text-xs ${grantTone}`}>
                {!ch.hasChannelOAuth
                  ? "No streamer authorization — no bot badge"
                  : days === null
                    ? "Authorized"
                    : days > 20
                      ? "Authorized · renews itself"
                      : `Not renewing: runs out in ${days < 1 ? "less than a day" : `${Math.floor(days)} days`}`}
              </div>
            </Link>
            <div className="flex gap-4 border-t border-neutral-800 px-5 py-2.5 text-xs">
              <Link href={`/${ch.channel}/bot`} className="text-neutral-400 transition hover:text-neutral-200">
                Manage bot
              </Link>
              <Link href={`/${ch.channel}`} className="text-neutral-500 transition hover:text-neutral-300">
                Earnings
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
