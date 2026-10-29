import type { ReactNode } from "react";
import type { PublicHeists } from "@/lib/bot-api";

// The public leaderboard's heists: every steal ranked, on the Fishing tab.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: process.env.TZ || "Asia/Singapore" });
}

const num = (n: number) => n.toLocaleString("en-US");

/** One ranked list in the heists grid: a title, a line of what it counts, and name · value rows. */
function HeistList({ title, hint, rows, empty, who }: {
  title: string;
  hint: string;
  rows: Array<{ name: string; value: string; note?: string }>;
  empty: string;
  who: (name: string) => ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">{title}</span> · {hint}
      </h3>
      {rows.length ? (
        <ol className="divide-y divide-neutral-800">
          {rows.map((r, i) => (
            <li key={r.name} className="flex items-baseline gap-3 px-5 py-2.5 text-sm">
              <span className="w-4 shrink-0 text-xs tabular-nums text-neutral-600">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate">
                {who(r.name)}
                {r.note ? <span className="ml-2 text-xs text-neutral-500">{r.note}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-300">{r.value}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="px-5 py-3 text-xs text-neutral-600">{empty}</p>
      )}
    </section>
  );
}

export default function Heists({ heists, currency, channel }: { heists: PublicHeists | null; currency: string; channel: string }) {
  const who = (name: string) => (
    <a href={`${BASE_PATH}/leaderboard/${channel}?user=${encodeURIComponent(name)}`} className="text-neutral-200 hover:underline">
      {name}
    </a>
  );
  if (!heists) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">🥷 Heists</h2>
        <p className="mt-1 text-xs text-neutral-500">Nobody has tried stealing a fish yet. The first thief goes down in history.</p>
      </section>
    );
  }
  const t = heists.totals;
  const rate = (stolen: number, attempts: number) => (attempts ? `${Math.round((stolen / attempts) * 100)}% success` : "");
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4">
        <h2 className="text-sm text-neutral-200">🥷 Heists</h2>
        <p className="mt-1 text-xs text-neutral-500">
          {`${num(t.attempts)} ${t.attempts === 1 ? "try" : "tries"} · ${num(t.stolen)} fish stolen · ${num(t.caught)} caught red-handed`}
          {t.guarded ? ` · ${num(t.guarded)} turned away by guards` : ""}
          {` · ${num(t.burned)} ${currency} lost to fees and fines`}
        </p>
      </section>

      {heists.biggest.length ? (
        <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
            <span className="text-neutral-300">💎 Biggest heists</span> · the most valuable fish ever stolen
          </h3>
          <ol className="divide-y divide-neutral-800">
            {heists.biggest.map((b, i) => (
              <li key={i} className="flex items-center gap-4 px-5 py-3 text-sm">
                <span className="w-8 shrink-0 text-xl leading-none">{b.fish}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-neutral-400">
                    {who(b.thief)} <span className="text-neutral-600">took it from</span> {who(b.victim)}
                  </span>
                  <span className="mt-0.5 block text-xs text-neutral-500">
                    {b.cm ? `${b.cm} cm · ` : ""}
                    {formatDay(b.at)}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-neutral-200">
                  {num(b.worth)} {currency}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <HeistList
          title="🥷 Master thieves"
          hint="most fish stolen"
          rows={heists.thieves.map((r) => ({ name: r.name, value: `${num(r.stolen)} 🐟`, note: `${num(r.loot)} ${currency} · ${rate(r.stolen, r.attempts)}` }))}
          empty="No fish stolen yet."
          who={who}
        />
        <HeistList
          title="🚨 Hall of Shame"
          hint="caught red-handed"
          rows={heists.shame.map((r) => ({ name: r.name, value: `${num(r.caught)}×`, note: `paid ${num(r.fines)} ${currency}` }))}
          empty="Nobody's been caught. Yet."
          who={who}
        />
        <HeistList
          title="🎯 Easy pickings"
          hint="fish lost to thieves"
          rows={heists.robbed.map((r) => ({ name: r.name, value: `${num(r.lost)} 🐟`, note: `${num(r.value)} ${currency}` }))}
          empty="Nobody has lost a fish."
          who={who}
        />
        <HeistList
          title="🛡️ Fort Knox"
          hint="thieves turned away by a guard"
          rows={heists.fortKnox.map((r) => ({ name: r.name, value: `${num(r.turnedAway)}×` }))}
          empty="No guard has stopped a thief yet."
          who={who}
        />
      </div>

      {heists.blotter.length ? (
        <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <h3 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
            <span className="text-neutral-300">🚔 Police blotter</span> · the latest tries
          </h3>
          <ol className="divide-y divide-neutral-800">
            {heists.blotter.map((b, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                <span className="w-6 shrink-0 text-center">{b.outcome === "stolen" ? "🪝" : "🚨"}</span>
                <span className="min-w-0 flex-1 text-neutral-400">
                  {b.outcome === "stolen" ? (
                    <>
                      {who(b.thief)} swiped a {b.fish} from {who(b.victim)}
                    </>
                  ) : (
                    <>
                      {who(b.victim)} caught {who(b.thief)} reaching for their {b.fish}
                    </>
                  )}
                </span>
                <span className="shrink-0 text-xs text-neutral-500">{formatDay(b.at)}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

