import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { validChannel } from "@/lib/bot-auth";
import { getSession } from "@/lib/session";
import { loadPublicLeaderboard } from "@/lib/public-leaderboard";

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

export default async function LeaderboardPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();

  const { tab: rawTab } = await searchParams;
  const tab = (Array.isArray(rawTab) ? rawTab[0] : rawTab) === "watchtime" ? "watchtime" : "points";

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
  const currency = data?.currencyName ?? "Points";
  const rows = data ? (tab === "watchtime" ? data.watchtime : data.points) : [];
  const tabLink = (t: "points" | "watchtime") =>
    `${BASE_PATH}/${slug}/leaderboard${t === "watchtime" ? "?tab=watchtime" : ""}`;
  const tabClass = (t: "points" | "watchtime") =>
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
                Watch time
              </a>
              <span className="ml-auto text-xs text-neutral-600">
                {result.kind === "ok" && result.stale ? "Showing an earlier copy · " : ""}
                Updated {formatUpdated(data.updatedAt)}
              </span>
            </nav>

            <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
              {rows.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-neutral-500">
                  {tab === "watchtime" ? "No watch time recorded yet." : `Nobody has earned ${currency} yet.`}
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
                      <span className="min-w-0 flex-1 truncate text-neutral-200">{row.username}</span>
                      <span className="shrink-0 tabular-nums text-neutral-300">
                        {tab === "watchtime" ? formatWatch(row.value) : `${row.value.toLocaleString("en-US")} ${currency}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </main>
    </>
  );
}
