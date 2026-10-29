"use client";

import { COUNTERPARTY_PREFIX, REASON_LABEL } from "@/lib/points-labels";
import type { PublicHistory } from "@/lib/bot-api";
import { Stat } from "@/components/ui";

// One viewer's details as the public leaderboard opens them: the admin
// dashboard's viewer panel, minus Adjust balance. Read only.

const LABEL = "mb-1 block text-xs uppercase tracking-wider text-neutral-500";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Singapore" });
}

export default function ViewerHistory({ h, onOpen }: { h: PublicHistory; /** Opens another viewer in the list. */ onOpen?: (name: string) => void }) {
  const g = h.gamble;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-neutral-100">{h.username}</span>
        <span className="text-xs text-neutral-500">
          {h.isSub ? "Subscriber · " : ""}first seen {formatDate(h.firstSeenAt)}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Stat label="Balance" value={`${h.balance.toLocaleString()}${h.rank === null ? "" : ` · #${h.rank}`}`} />
        <Stat label="Lifetime earned" value={h.lifetimeEarned.toLocaleString()} />
        <Stat label="Last seen" value={formatDate(h.lastSeenAt)} />
      </dl>
      {g && g.gambles > 0 ? (
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Stat label="Gambles" value={g.gambles.toLocaleString()} />
          <Stat label="Win rate" value={`${((g.wins / g.gambles) * 100).toFixed(1)}% · ${g.wins.toLocaleString()} won`} />
          <Stat label="Staked" value={g.staked.toLocaleString()} />
          <Stat label="Gamble net" value={`${g.net > 0 ? "+" : ""}${g.net.toLocaleString()}`} />
        </dl>
      ) : null}

      <div className="border-t border-neutral-800 pt-4">
        <h4 className={LABEL}>
          History
          {h.ledger.length > 0 ? (
            <span className="ml-2 normal-case tracking-normal text-neutral-600">
              {h.ledgerCount > h.ledger.length
                ? `latest ${h.ledger.length} of ${h.ledgerCount.toLocaleString()} changes (up to 100 are shown)`
                : `all ${h.ledgerCount.toLocaleString()} changes`}
            </span>
          ) : null}
        </h4>
        {h.ledger.length === 0 ? (
          <p className="text-sm text-neutral-500">No changes besides active-time earnings yet.</p>
        ) : (
          <ul className="divide-y divide-neutral-800">
            {h.ledger.map((entry) => (
              <li key={entry.id} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-start sm:gap-4">
                <span className="w-40 shrink-0 text-xs text-neutral-500">{formatDate(entry.ts)}</span>
                <span className={`w-24 shrink-0 tabular-nums ${entry.delta >= 0 ? "text-[#53FC18]" : "text-red-400"}`}>
                  {entry.delta >= 0 ? "+" : ""}
                  {entry.delta.toLocaleString()}
                </span>
                <span className="min-w-0 flex-1 text-neutral-300">
                  {REASON_LABEL[entry.reason] ?? entry.reason}
                  {entry.counterparty && COUNTERPARTY_PREFIX[entry.reason] ? (
                    <span className="text-neutral-400">
                      {` ${COUNTERPARTY_PREFIX[entry.reason]} `}
                      {onOpen ? (
                        <button type="button" onClick={() => onOpen(entry.counterparty!)} className="text-neutral-200 hover:underline">
                          {entry.counterparty}
                        </button>
                      ) : (
                        <span className="text-neutral-200">{entry.counterparty}</span>
                      )}
                    </span>
                  ) : null}
                  {entry.note ? <span className="text-neutral-500"> — {entry.note}</span> : null}
                  {entry.actor ? <span className="block text-xs text-neutral-600">{entry.actor}</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-neutral-500">= {entry.balanceAfter.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
