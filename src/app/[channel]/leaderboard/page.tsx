import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { validChannel } from "@/lib/bot-auth";
import { getSession } from "@/lib/session";
import { loadPublicLeaderboard } from "@/lib/public-leaderboard";
import type { PublicCatch, PublicFishing } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
};

// The one page here that anyone can open signed out. It never redirects to login,
// and shows only ranks, usernames and totals — never ids, managers or tokens.

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const robots = { index: false, follow: false };
  if (!validChannel(slug)) return { title: "Leaderboard", robots };
  const result = await loadPublicLeaderboard(slug);
  return {
    title: result.kind === "ok" ? `${result.data.currencyName} leaderboard · ${slug}` : `Leaderboard · ${slug}`,
    robots,
  };
}

function formatWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h.toLocaleString("en-US")}h ${m}m` : `${m}m`;
}

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.TZ || "Asia/Singapore" });
}

type Tab = "points" | "watchtime" | "fishing";

const RARITY_CLASS: Record<PublicCatch["rarity"], string> = {
  Common: "border-neutral-700 text-neutral-400",
  Uncommon: "border-emerald-900/70 bg-emerald-950/30 text-emerald-300",
  Rare: "border-sky-900/70 bg-sky-950/30 text-sky-300",
  Epic: "border-fuchsia-900/70 bg-fuchsia-950/30 text-fuchsia-300",
  Legendary: "border-amber-800/70 bg-amber-950/30 text-amber-300",
  Never: "border-neutral-800 text-neutral-600",
};

function formatChance(p: number): string {
  if (p <= 0) return "never";
  return `${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function CatchTable({ title, rows, currency }: { title: string; rows: PublicCatch[]; currency: string }) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      {/* Fixed columns, so the Fish and Junk tables line up with each other. */}
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b border-neutral-800 text-xs text-neutral-500">
            <th className="w-20 px-5 py-2 text-left font-normal sm:w-28">{title}</th>
            <th className="w-28 px-3 py-2 text-left font-normal sm:w-36">Rarity</th>
            <th className="w-20 px-3 py-2 text-right font-normal sm:w-28">Chance</th>
            <th className="px-5 py-2 text-right font-normal">Sells for</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-800">
          {rows.map((r) => (
            <tr key={r.emoji}>
              <td className="px-5 py-2.5 text-xl leading-none">{r.emoji}</td>
              <td className="px-3 py-2.5">
                <span className={`rounded-md border px-1.5 py-0.5 text-xs ${RARITY_CLASS[r.rarity]}`}>{r.rarity}</span>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-neutral-400">{formatChance(r.chance)}</td>
              <td className="px-5 py-2.5 text-right tabular-nums text-neutral-200">
                {r.price.toLocaleString("en-US")} {currency}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function FishingTab({ fishing, currency }: { fishing: PublicFishing; currency: string }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        {`A cast lands a fish 1 time in ${fishing.catchOdds}; bait and reels improve that. Chance is how often a catch is that fish. `}
        {`Prices are for an average 50 cm fish: length scales it from half (1 cm) to double (100 cm), and beating your record adds 50%.`}
      </p>
      <CatchTable title="Fish" rows={fishing.fish} currency={currency} />
      {fishing.junk.length ? <CatchTable title="Junk" rows={fishing.junk} currency={currency} /> : null}
    </div>
  );
}

export default async function LeaderboardPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();

  const { tab: rawTab } = await searchParams;
  const wanted = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  const tab: Tab = wanted === "watchtime" ? "watchtime" : wanted === "fishing" ? "fishing" : "points";

  const result = await loadPublicLeaderboard(slug);
  if (result.kind === "not-found") notFound();

  // The session only decides what the header's corner shows, never whether the page renders.
  let username: string | null = null;
  try {
    username = (await getSession()).username ?? null;
  } catch {
    username = null;
  }

  const data = result.kind === "ok" ? result.data : null;
  const fishing = data?.fishing ?? null;
  const currency = data?.currencyName ?? "Points";
  const rows = data ? (tab === "watchtime" ? data.watchtime : data.points) : [];
  const tabLink = (t: Tab) => `${BASE_PATH}/${slug}/leaderboard${t === "points" ? "" : `?tab=${t}`}`;
  const tabClass = (t: Tab) =>
    `rounded-lg border px-3 py-1.5 text-sm transition ${
      tab === t
        ? "border-[#53FC18]/40 bg-[#53FC18]/10 text-[#53FC18]"
        : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
    }`;

  return (
    <>
      <SiteHeader channel={slug} username={username} isAdmin={false} current="leaderboard" variant="public" />

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-2xl font-semibold text-neutral-100">{currency} leaderboard</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Earned by chatting while {slug} is live, and from follows, subs and Kicks.
          </p>
        </div>

        {!data ? (
          <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-8 text-center text-sm text-neutral-400">
            The leaderboard is unavailable right now. Try again in a minute.
          </div>
        ) : (
          <>
            <nav className="flex flex-wrap items-center gap-2">
              <a href={tabLink("points")} className={tabClass("points")}>
                {currency}
              </a>
              <a href={tabLink("watchtime")} className={tabClass("watchtime")}>
                Active time
              </a>
              {fishing ? (
                <a href={tabLink("fishing")} className={tabClass("fishing")}>
                  Fishing
                </a>
              ) : null}
              <span className="ml-auto text-xs text-neutral-600">
                {result.kind === "ok" && result.stale ? "Showing an earlier copy · " : ""}
                Updated {formatUpdated(data.updatedAt)}
              </span>
            </nav>
            {tab === "watchtime" ? (
              <p className="text-xs text-neutral-500">
                Time spent chatting while {slug} is live, counted in 10-minute steps. Kick doesn&apos;t share who is
                watching, so viewers who don&apos;t chat aren&apos;t counted.
              </p>
            ) : null}

            {tab === "fishing" ? (
              fishing ? (
                <FishingTab fishing={fishing} currency={currency} />
              ) : (
                <p className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-8 text-center text-sm text-neutral-500">
                  Fishing isn&apos;t on in this channel.
                </p>
              )
            ) : (
            <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
              {rows.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-neutral-500">
                  {tab === "watchtime" ? "No active time recorded yet." : `Nobody has earned ${currency} yet.`}
                </p>
              ) : (
                <ol className="divide-y divide-neutral-800">
                  {rows.map((row) => (
                    <li key={`${row.rank}-${row.username}`} className="flex items-center gap-4 px-5 py-3 text-sm">
                      <span
                        className={`w-10 shrink-0 tabular-nums ${
                          row.rank <= 3 ? "font-semibold text-[#53FC18]" : "text-neutral-500"
                        }`}
                      >
                        #{row.rank}
                      </span>
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate text-neutral-200">{row.username}</span>
                        {row.reel ? (
                          <span
                            title={`Fishes with the ${row.reel} reel`}
                            className="shrink-0 rounded-md border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 text-xs text-sky-300"
                          >
                            🎣 {row.reel}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 tabular-nums text-neutral-300">
                        {tab === "watchtime" ? formatWatch(row.value) : `${row.value.toLocaleString("en-US")} ${currency}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
