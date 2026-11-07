import type { PublicSnipes } from "@/lib/bot-api";
import { formatDay } from "@/components/Heists";

// The public leaderboard's big bite snipers, on the Fishing tab: who takes the most bites off
// someone else's line, how often a snipe ends with the trophy landed, and the best one landed.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const num = (n: number) => n.toLocaleString("en-US");

const OUTCOME = {
  landed: { text: "landed", className: "text-[#53FC18]" },
  snapped: { text: "snapped on the last pull", className: "text-amber-300" },
  "got-away": { text: "got away", className: "text-neutral-500" },
  spat: { text: "spat the hook (a reward bite)", className: "text-neutral-500" },
} as const;

export default function Snipers({ snipes, currency, channel }: { snipes: PublicSnipes | null; currency: string; channel: string }) {
  const who = (name: string) => (
    <a href={`${BASE_PATH}/leaderboard/${channel}?user=${encodeURIComponent(name)}`} className="text-neutral-200 hover:underline">
      {name}
    </a>
  );
  if (!snipes || !snipes.snipers.length) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">🎯 Big bite snipers</h2>
        <p className="mt-1 text-xs text-neutral-500">Nobody has sniped a big bite yet. When the SNIPE OPEN line hits chat, the first right code takes it.</p>
      </section>
    );
  }
  const t = snipes.totals;
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">🎯 Big bite snipers</h2>
        <p className="mt-1 text-xs text-neutral-500">
          {`${num(t.snipes)} ${t.snipes === 1 ? "bite" : "bites"} sniped by ${num(t.snipers)} ${t.snipers === 1 ? "sniper" : "snipers"} · ${num(t.landed)} landed`}
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          {`Success is how many of their snipes ended with the trophy landed. A sniped reward bite only spits the hook, so it doesn't count against them. Best is the most valuable trophy they landed from a snipe, priced as it sells.`}
        </p>
      </section>

      <section className="overflow-x-auto rounded-xl border border-neutral-800 bg-neutral-950/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-800 text-left text-xs text-neutral-500">
              <th className="w-8 px-5 py-2 font-normal">#</th>
              <th className="px-2 py-2 font-normal">Sniper</th>
              <th className="px-2 py-2 text-right font-normal">Snipes</th>
              <th className="px-2 py-2 text-right font-normal">Landed</th>
              <th className="px-2 py-2 text-right font-normal">Success</th>
              <th className="px-5 py-2 text-right font-normal">Best trophy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {snipes.snipers.map((s, i) => (
              <tr key={s.name}>
                <td className="px-5 py-2.5 text-xs tabular-nums text-neutral-600">{i + 1}</td>
                <td className="max-w-[10rem] truncate px-2 py-2.5">{who(s.name)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-neutral-300">{num(s.snipes)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums text-neutral-300">
                  {num(s.landed)}
                  {s.snapped ? <span className="ml-1.5 text-xs text-neutral-500" title="every code right, but the trophy snapped free">{`${num(s.snapped)} snapped`}</span> : null}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums text-neutral-300">{s.rate === null ? "–" : `${s.rate}%`}</td>
                <td className="whitespace-nowrap px-5 py-2.5 text-right">
                  {s.best ? (
                    <>
                      <span className="text-base">{s.best.fish}</span>
                      {s.best.cm !== null ? <span className="ml-1 text-xs text-neutral-500">{`${s.best.cm} cm`}</span> : null}
                      <span className="ml-2 tabular-nums text-neutral-300">{`${num(s.best.worth)} ${currency}`}</span>
                    </>
                  ) : (
                    <span className="text-neutral-600">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {snipes.recent.length ? (
        <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
            <span className="text-neutral-300">📜 Latest snipes</span> · sniper first
          </h3>
          <ol className="divide-y divide-neutral-800">
            {snipes.recent.map((r, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="min-w-0 flex-1 text-neutral-400">
                  {who(r.sniper)} <span className="text-neutral-600">sniped</span> {who(r.victim)}
                  <span className={`ml-2 text-xs ${OUTCOME[r.outcome].className}`}>
                    {OUTCOME[r.outcome].text}
                    {r.outcome === "landed" && r.fish ? ` ${r.fish}${r.cm !== null ? ` ${r.cm} cm` : ""}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-neutral-500">{formatDay(r.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
