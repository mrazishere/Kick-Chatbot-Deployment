import type { PublicDuels } from "@/lib/bot-api";
import { formatDay } from "@/components/Heists";

// The public leaderboard's fish duels, on the Fishing tab: totals, who has won most, and the latest fights.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const num = (n: number) => n.toLocaleString("en-US");

export default function Duels({ duels, currency, channel }: { duels: PublicDuels | null; currency: string; channel: string }) {
  const who = (name: string) => (
    <a href={`${BASE_PATH}/${channel}/leaderboard?user=${encodeURIComponent(name)}`} className="text-neutral-200 hover:underline">
      {name}
    </a>
  );
  if (!duels) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">⚔️ Fish duels</h2>
        <p className="mt-1 text-xs text-neutral-500">No fish have fought yet. The first duel makes history.</p>
      </section>
    );
  }
  const t = duels.totals;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">⚔️ Fish duels</h2>
        <p className="mt-1 text-xs text-neutral-500">
          {`${num(t.duels)} ${t.duels === 1 ? "duel" : "duels"} fought`}
          {t.wagered ? ` · ${num(t.wagered)} ${currency} won on wagers` : ""}
          {t.fishTaken ? ` · ${num(t.fishTaken)} fish taken for keeps` : ""}
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
            <span className="text-neutral-300">🏆 Champions</span> · most duels won
          </h3>
          <ol className="divide-y divide-neutral-800">
            {duels.champions.map((c, i) => (
              <li key={c.name} className="flex items-baseline gap-3 px-5 py-2.5 text-sm">
                <span className="w-4 shrink-0 text-xs tabular-nums text-neutral-600">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate">
                  {who(c.name)}
                  <span className="ml-2 text-xs text-neutral-500">{`${num(c.losses)} lost`}</span>
                </span>
                <span className="shrink-0 tabular-nums text-neutral-300">{`${num(c.wins)} won`}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
            <span className="text-neutral-300">📜 Latest duels</span> · winner first
          </h3>
          <ol className="divide-y divide-neutral-800">
            {duels.recent.map((r, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 text-neutral-400">
                  {who(r.winner)} {r.winnerFish} <span className="text-neutral-600">beat</span> {who(r.loser)} {r.loserFish}
                  <span className="ml-2 text-xs text-neutral-500">
                    {r.stake === "wager" && r.amount ? `${num(r.amount)} ${currency}` : r.stake === "keeps" ? "for keeps" : "for glory"}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-500">{formatDay(r.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
