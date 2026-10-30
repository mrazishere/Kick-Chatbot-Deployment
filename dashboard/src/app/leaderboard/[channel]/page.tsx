import * as fs from "fs";
import * as path from "path";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { validChannel } from "@/lib/bot-auth";
import { leaderboardViewer } from "@/lib/session";
import { loadPublicLeaderboard, loadPublicViewers, publicHolder } from "@/lib/public-leaderboard";
import { getFishPage } from "@/lib/bot-api";
import PublicViewers from "@/components/PublicViewers";
import FishingGame from "@/components/FishingGame";
import StealButton from "@/components/StealButton";
import SellButton from "@/components/SellButton";
import TradeBuilder, { type TradeFish } from "@/components/TradeBuilder";
import { viewerLoginEnabled } from "@/lib/viewer-login";
import Heists from "@/components/Heists";
import Duels from "@/components/Duels";
import type { PublicCatch, PublicCommands, PublicFishing, PublicHolder, PublicStealRules, PublicTopFish } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ tab?: string | string[]; user?: string | string[]; signin?: string | string[]; section?: string | string[] }>;
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

function formatUpdated(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: process.env.TZ || "Asia/Singapore" });
}

type Tab = "points" | "fishing" | "commands";

const RARITY_CLASS: Record<PublicCatch["rarity"], string> = {
  Common: "border-neutral-700 text-neutral-400",
  Uncommon: "border-emerald-900/70 bg-emerald-950/30 text-emerald-300",
  Rare: "border-sky-900/70 bg-sky-950/30 text-sky-300",
  Epic: "border-fuchsia-900/70 bg-fuchsia-950/30 text-fuchsia-300",
  Legendary: "border-amber-800/70 bg-amber-950/30 text-amber-300",
  Mythic: "border-pink-800/70 bg-pink-950/30 text-pink-300",
  Never: "border-neutral-800 text-neutral-600",
};

function formatChance(p: number): string {
  if (p <= 0) return "never";
  return `${p < 1 ? p.toFixed(2) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

type Emotes = Record<string, string>;

/** A catch by its emoji, or the emote image for a custom fish named after one of the channel's emotes. */
function FishIcon({ name, emotes }: { name: string; emotes?: Emotes }) {
  const url = emotes?.[name];
  if (!url) return <>{name}</>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={name} title={name} className="inline-block h-[1.25em] w-auto align-middle" loading="lazy" />;
}

function CatchTable({ title, rows, currency, emotes }: { title: string; rows: PublicCatch[]; currency: string; emotes?: Emotes }) {
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
              <td className="px-5 py-2.5 text-xl leading-none"><FishIcon name={r.emoji} emotes={emotes} /></td>
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


/** The most valuable fish anyone holds right now, each with its owner, length, level and duel stats. */
function TopFish({ rows, currency, channel, emotes }: { rows: PublicTopFish[]; currency: string; channel: string; emotes?: Emotes }) {
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <h2 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🏆 Most valuable fish</span> · held right now, by what one sells for, their owner's reel included
      </h2>
      <ol className="divide-y divide-neutral-800">
        {rows.map((r, i) => (
          <li key={`${r.name}-${r.emoji}-${r.cm}-${r.level ?? 0}-${r.record ? 1 : 0}-${i}`} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <span className="w-6 shrink-0 text-xs tabular-nums text-neutral-600">{i + 1}</span>
            <span className="w-8 shrink-0 text-xl leading-none"><FishIcon name={r.emoji} emotes={emotes} /></span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="tabular-nums text-neutral-100">{r.cm === null ? "no size" : `${r.cm} cm`}</span>
                {r.level ? <span className="rounded bg-amber-500/15 px-1 text-xs text-amber-300">Lv{r.level}</span> : null}
                {r.record ? <span title="A size record: sells for 1.5x" aria-label="size record">🏅</span> : null}
                {r.n > 1 ? <span className="text-xs tabular-nums text-neutral-500">×{r.n}</span> : null}
                <span className={`rounded-md border px-1.5 py-0.5 text-xs ${RARITY_CLASS[r.rarity]}`}>{r.rarity}</span>
              </span>
              <span className="mt-1 block text-xs text-neutral-500">
                <a href={`${BASE_PATH}/leaderboard/${channel}?user=${encodeURIComponent(r.name)}`} className="text-neutral-200 hover:underline">{r.name}</a>
                <span className="ml-2 tabular-nums">{r.type ? `${TYPE_EMOJI[r.type] ?? ""} ` : ""}❤️{r.hp} ⚔️{r.attack}</span>
              </span>
            </span>
            <span className="shrink-0 tabular-nums text-neutral-300">{r.worth.toLocaleString("en-US")} {currency}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** How stealing works here: hooks, the odds, fees and fines, and guards, from the channel's settings. */
function StealGuide({ rules: r, currency, command, fish, emotes }: { rules: PublicStealRules; currency: string; command: string; fish: PublicCatch[]; emotes?: Emotes }) {
  // Each fish's own chance, luck included, easiest first. An older bot sends none: the tiers' then.
  const odds = fish.filter((f) => typeof f.steal === "number").sort((a, b) => b.steal! - a.steal! || a.chance - b.chance);
  const n = (v: number) => v.toLocaleString("en-US");
  const mins = (m: number) => (m >= 60 && m % 60 === 0 ? `${m / 60} hour${m === 60 ? "" : "s"}` : `${m} minutes`);
  const luck = (p: number) => Math.min(100, Math.round(p * (100 + r.luckPercent)) / 100);
  const code = (t: string) => <code className="rounded bg-neutral-900 px-1 py-0.5 text-[0.8em] text-neutral-200">{t}</code>;
  const when = r.onlyWhileLive ? "only while the stream is live" : r.offlineOnly ? "only while the stream is offline" : "any time";
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <h2 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🪝 How stealing works</span> · hooks, guards, odds and fines
      </h2>
      <div className="grid gap-5 px-5 py-4 text-sm text-neutral-300 sm:grid-cols-2">
        <div className="space-y-2">
          <h3 className="font-medium text-neutral-100">🪝 Grappling hook</h3>
          <p>
            {code(`${command} fish buy hook`)} costs <b>{n(r.hookPrice)} {currency}</b> for <b>{r.hookUses} tr{r.hookUses === 1 ? "y" : "ies"}</b>. You need one to steal, and every try uses one up,
            caught or not. A hook that hits a guard, or fumbles because you can&apos;t cover the costs, uses a try too.
          </p>
          <h3 className="pt-1 font-medium text-neutral-100">🎣 Stealing</h3>
          <p>
            {code(`${command} fish steal @user`)} reaches for one random fish they&apos;ve held for over {mins(r.graceMinutes)} (a fresh catch is safe, so it can be sold
            first). It works {when}, and uses your {r.cooldownMinutes}-minute fishing cooldown. Your bucket needs room for the fish.
          </p>
          {odds.length ? (
            <>
              <p className="text-xs text-neutral-400">
                The chance it works goes by how rare the fish is to catch and by what it&apos;s worth, both counting equally: the rarer or the dearer, the harder.
                Trophies go by the tier they fight as. Below, each fish at its list price; a long or fed one is harder to take, a small one easier.
              </p>
              <div className="grid grid-cols-3 gap-x-3 gap-y-0.5 text-xs tabular-nums sm:grid-cols-4">
                {odds.map((f) => (
                  <div key={f.emoji} className="flex items-center justify-between gap-1">
                    <span><FishIcon name={f.emoji} emotes={emotes} /></span>
                    <span>{f.steal! >= 1 ? f.steal!.toFixed(1).replace(/\.0$/, "") : f.steal!.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
          <table className="w-full max-w-xs text-xs">
              <thead>
                <tr className="text-neutral-500">
                  <th className="pb-1 text-left font-normal">The fish grabbed</th>
                  <th className="pb-1 text-right font-normal">Chance it works</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {(["Common", "Uncommon", "Rare", "Epic", "Legendary"] as const).map((k) => (
                  <tr key={k}>
                    <td className="py-0.5">{k}{k === "Legendary" ? " & trophies" : ""}</td>
                    <td className="py-0.5 text-right">{luck(r.odds[k])}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="font-medium text-neutral-100">💸 Fees and fines</h3>
          <p>
            Every try that goes ahead costs a fee of <b>{r.feePercent}%</b> of the grabbed fish&apos;s value (at least {n(r.feeMinimum)} {currency}), win or lose. Get caught and you
            also pay a fine (at least {n(r.fineMinimum)} {currency}).{" "}
            {r.luckPercent > 0
              ? `Every chance here gets a +${r.luckPercent}% boost (already in the table), and fines are priced from the boosted chance, so thieves still lose about ${r.edgePercent}% of what they'd hope to win, on average.`
              : `Fines are priced so that thieves lose about ${r.edgePercent}% of what they'd hope to win, on average.`}{" "}
            You need enough {currency} on hand to cover the fee and fine for their most valuable fish, or your hook fumbles.
          </p>
          <p>
            After a try on someone, they&apos;re on alert for {mins(r.protectMinutes)}: nobody can try them. You can try the same person once a day.
          </p>
          <h3 className="pt-1 font-medium text-neutral-100">💂 Guard</h3>
          <p>
            {code(`${command} fish buy guard`)} protects all your fish for <b>{r.guardHours} hours</b>. It costs {r.guardPercent}% of what your fish are worth when you buy it (at least {n(r.guardMinimum)} {currency});
            buying again adds more time.{r.offlineOnly && !r.onlyWhileLive ? " Its clock stops while the stream is live, when nobody can steal, so its hours are only spent offline." : ""} A guard catches every thief: they pay the fee and the fine as if caught, no roll. How long your guard has left is never shown in chat, so thieves can&apos;t time it.
          </p>
        </div>
      </div>
    </section>
  );
}

const TYPE_EMOJI: Record<string, string> = { Predator: "🦷", Swift: "💨", Armored: "🪨" };

/**
 * One viewer's fish, a row per kind: each kind's fish strongest first by ❤️ health × ⚔️ attack
 * (the measure a duel picks someone's best fish by, so a levelled fish ranks above a longer
 * unfed one), and the kinds in order of their strongest fish. Each with its duel stats and
 * what it sells for.
 */
function HeldList({
  fish,
  currency,
  duel,
  emotes,
  steal,
  sell,
  junk,
}: {
  fish: PublicHolder["fish"];
  currency: string;
  duel: boolean;
  emotes?: Emotes;
  /** Set when the signed-in viewer may steal from this holder: a 🪝 on each fish aims for it. */
  steal?: { channel: string; target: string } | null;
  /** Set on the signed-in viewer's own row: a 💰 on each fish sells that very one. */
  sell?: { channel: string } | null;
  /** Their junk, shown under the fish. */
  junk?: PublicHolder["junk"];
}) {
  type Each = NonNullable<PublicHolder["fish"][number]["each"]>[number];
  const power = (e: Each) => e.hp * e.attack;
  const byStrength = (a: Each, b: Each) => power(b) - power(a) || b.worth - a.worth || (b.cm ?? -1) - (a.cm ?? -1);
  const kinds = fish
    .map((f) => ({ ...f, each: [...(f.each ?? [])].sort(byStrength) }))
    .filter((f) => f.each.length)
    .sort((a, b) => byStrength(a.each[0], b.each[0]));
  return (
    <div className="space-y-2 bg-neutral-900/20 px-5 py-3 sm:pl-14">
      {kinds.map((f) => (
        <div key={f.emoji} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="w-full text-xs text-neutral-400 sm:w-44 sm:shrink-0">
            <span className="mr-1 text-base"><FishIcon name={f.emoji} emotes={emotes} /></span>
            {f.type ? `${TYPE_EMOJI[f.type] ?? ""} ${f.type} · ` : ""}
            {f.rarity}
          </span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {f.each.map((e) => (
              <span
                key={`${e.cm}-${e.worth}-${e.level ?? 0}-${e.record ? 1 : 0}`}
                title={`${e.worth.toLocaleString("en-US")} ${currency} each${e.record ? ", a size record (1.5x)" : ""}`}
                className="rounded-md border border-neutral-800 bg-neutral-950/60 px-1.5 py-0.5 text-xs tabular-nums text-neutral-300"
              >
                <span className="text-neutral-100">{e.cm === null ? "no size" : `${e.cm} cm`}</span>
                {e.level ? <span className="ml-1 rounded bg-amber-500/15 px-1 text-amber-300">Lv{e.level}</span> : null}
                {e.record ? <span className="ml-1" aria-label="size record">🏅</span> : null}
                {e.n > 1 ? <span className="text-neutral-500"> ×{e.n}</span> : null}
                <span className="ml-1.5 text-neutral-500">❤️{e.hp} ⚔️{e.attack} 💰{e.worth.toLocaleString("en-US")}</span>
                {sell ? (
                  <span className="ml-1.5 inline-flex">
                    <SellButton
                      channel={sell.channel}
                      words={e.cm === null ? [f.emoji, "1"] : [f.emoji, `${e.cm}cm`, `Lv${e.level ?? 0}`, ...(e.record ? ["🏅"] : [])]}
                      label={`${f.emoji}${e.cm === null ? "" : ` ${e.cm} cm`}${e.level ? ` Lv${e.level}` : ""}${e.record ? " 🏅" : ""}`}
                      worth={e.worth}
                      currency={currency}
                      count={e.n}
                    />
                  </span>
                ) : null}
                {steal ? (
                  <span className="ml-1.5 inline-flex">
                    <StealButton
                      channel={steal.channel}
                      target={steal.target}
                      aim={e.cm === null ? [f.emoji] : [f.emoji, `${e.cm}cm`]}
                      label={`Steal this ${f.emoji}${e.cm === null ? "" : ` ${e.cm} cm`}`}
                      compact
                    />
                  </span>
                ) : null}
              </span>
            ))}
          </span>
        </div>
      ))}
      {junk?.length ? (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="w-full text-xs text-neutral-400 sm:w-44 sm:shrink-0">🗑️ Junk</span>
          <span className="flex min-w-0 flex-1 flex-wrap gap-1.5">
            {junk.map((j) => (
              <span key={j.emoji} className="rounded-md border border-neutral-800 bg-neutral-950/60 px-1.5 py-0.5 text-xs tabular-nums text-neutral-300">
                <span className="text-sm">{j.emoji}</span>
                {j.n > 1 ? <span className="text-neutral-500"> ×{j.n}</span> : null}
                <span className="ml-1.5 text-neutral-500">💰{j.worth.toLocaleString("en-US")}</span>
                {sell ? (
                  <span className="ml-1.5 inline-flex">
                    <SellButton channel={sell.channel} words={[j.emoji, "1"]} label={`${j.emoji}`} worth={j.worth} currency={currency} count={j.n} />
                  </span>
                ) : null}
              </span>
            ))}
          </span>
        </div>
      ) : null}
      <p className="pt-1 text-xs text-neutral-600">
        Grouped by kind, strongest first. ❤️ health and ⚔️ attack in a fish duel, 💰 what one sells for, their reel's bonus included (stolen fish don't get it). 🏅 a size record, worth 1.5x.{duel ? " Duel a certain one by its length, like 🦈 72cm." : ""}
      </p>
    </div>
  );
}

/**
 * Chat's bulk sales for your own row, each with about what it brings: all junk, all fish, and
 * duplicate fish (as chat sells them: every fed fish is kept, and of a kind with none fed, its biggest).
 */
function bulkSales(r: PublicHolder): Array<{ words: string[]; button: string; n: number; worth: number; what: string }> {
  const junkN = (r.junk ?? []).reduce((t, j) => t + j.n, 0);
  const junkWorth = (r.junk ?? []).reduce((t, j) => t + j.n * j.worth, 0);
  let dupN = 0;
  let dupWorth = 0;
  for (const f of r.fish) {
    const each = f.each ?? [];
    const fed = each.filter((e) => e.level).reduce((t, e) => t + e.n, 0);
    // Every unfed one goes, but with none fed the biggest stays.
    const unfed = each.filter((e) => !e.level);
    const kept = fed || !unfed.length ? null : unfed.reduce((a, b) => ((b.cm ?? -1) > (a.cm ?? -1) ? b : a));
    dupN += unfed.reduce((t, e) => t + e.n, 0) - (kept ? 1 : 0);
    dupWorth += unfed.reduce((t, e) => t + e.n * e.worth, 0) - (kept?.worth ?? 0);
  }
  return [
    ...(junkN ? [{ words: ["all", "junk"], button: "Sell all junk", n: junkN, worth: junkWorth, what: `all ${junkN} junk` }] : []),
    ...(dupN ? [{ words: ["duplicate", "fish"], button: "Sell duplicates", n: dupN, worth: dupWorth, what: `${dupN} duplicate fish (fed fish stay, and the biggest of a kind with none fed)` }] : []),
    ...(r.count ? [{ words: ["all", "fish"], button: "Sell all fish", n: r.count, worth: r.worth, what: `every one of your ${r.count} fish, fed and 🏅 ones too,` }] : []),
  ];
}

function Holders({
  rows,
  currency,
  channel,
  duel,
  emotes,
  stealer,
  trader,
  seller,
  own,
}: {
  rows: PublicHolder[];
  currency: string;
  channel: string;
  duel: boolean;
  emotes?: Emotes;
  /** The signed-in viewer, when they may steal here from the page (web play and stealing on); null otherwise. */
  stealer?: string | null;
  /** The same for trading (web play and trading on). */
  trader?: string | null;
  /** The signed-in viewer, when web play is on: their own row sells. */
  seller?: string | null;
  /** The seller's own row, shown under the list when they aren't on it (junk only, or below its top 100). */
  own?: PublicHolder | null;
}) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  // Not from yourself: the bot would refuse it anyway.
  const canSteal = (name: string) => !!stealer && stealer.toLowerCase() !== name.toLowerCase();
  const canTrade = (name: string) => !!trader && trader.toLowerCase() !== name.toLowerCase();
  // Your own row: sell from it. Selling lives here only, not on the Play tab.
  const isMine = (name: string) => !!seller && seller.toLowerCase() === name.toLowerCase();
  // Their fish as the trade builder picks them: exactly, by length, level and 🏅.
  // Stolen and kept twins (or two groups without a length) are one choice to the builder, at their average worth.
  const tradeFish = (r: PublicHolder): TradeFish[] => {
    const out = new Map<string, TradeFish>();
    for (const f of r.fish) {
      for (const e of f.each ?? []) {
        const k = `${f.emoji}|${e.cm ?? "-"}|${e.level ?? 0}|${e.record ? 1 : 0}`;
        const had = out.get(k);
        if (had) {
          had.worth = Math.round((had.worth * had.n + e.worth * e.n) / (had.n + e.n));
          had.n += e.n;
        } else out.set(k, { emoji: f.emoji, cm: e.cm, level: e.level ?? 0, record: !!e.record, worth: e.worth, n: e.n });
      }
    }
    return [...out.values()];
  };
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <h2 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🪣 Holding right now</span>
        {` · ${total.toLocaleString("en-US")} unsold fish, by what they'd sell for with their reel. Tap someone to see their fish by kind, strongest first, each with its length and stats.`}
      </h2>
      <ol className="divide-y divide-neutral-800">
        {/* Your own row is the fresh one (the list is a cached copy), in your place or under the list if you're not on it. */}
        {(own && isMine(own.name) ? (rows.some((r) => isMine(r.name)) ? rows.map((r) => (isMine(r.name) ? own : r)) : [...rows, own]) : rows).map((r, i) => {
          // Your own row under the list, when you're not on it: no place, only you see it.
          const extra = i >= rows.length;
          const detailed = r.fish.some((f) => f.each?.length) || !!r.junk?.length;
          // Collapsed: who and what it's worth. Open: every kind they hold, strongest kind first, each kind's fish strongest first.
          return (
            <li key={r.name} className="text-sm">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-2.5 hover:bg-neutral-900/40 [&::-webkit-details-marker]:hidden">
                  <span className="w-6 shrink-0 text-xs tabular-nums text-neutral-600">{extra ? "you" : i + 1}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-neutral-200">{r.name}</span>
                    {r.reel ? (
                      <span
                        title={`Fishes with the ${r.reel} reel`}
                        className="shrink-0 rounded-md border border-sky-900/60 bg-sky-950/40 px-1.5 py-0.5 text-xs text-sky-300"
                      >
                        🎣 {r.reel}
                      </span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-right tabular-nums text-neutral-300">
                    {r.worth.toLocaleString("en-US")} {currency}
                    <span className="ml-2 text-xs text-neutral-500">{`${r.count} fish`}</span>
                    <span className="ml-2 inline-block text-xs text-neutral-500 transition group-open:rotate-90">▸</span>
                  </span>
                </summary>
                <div className="border-t border-neutral-800/60 bg-neutral-900/20 px-5 pb-1 pt-3 sm:pl-14">
                  <span className="flex flex-wrap gap-1.5">
                    {r.fish.map((f) => (
                      <span key={f.emoji} title={f.rarity} className={`rounded-md border px-1.5 py-0.5 leading-none ${RARITY_CLASS[f.rarity]}`}>
                        <span className="text-base leading-none"><FishIcon name={f.emoji} emotes={emotes} /></span>
                        {f.n > 1 ? <span className="ml-1 text-xs tabular-nums">×{f.n}</span> : null}
                      </span>
                    ))}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-3">
                    <a href={`${BASE_PATH}/leaderboard/${channel}?user=${encodeURIComponent(r.name)}`} className="text-xs text-neutral-500 hover:text-neutral-300 hover:underline">
                      {`${r.name}'s ${currency} history →`}
                    </a>
                    {canSteal(r.name) ? <StealButton channel={channel} target={r.name} label="Steal a random fish" /> : null}
                    {canTrade(r.name) ? <TradeBuilder channel={channel} target={r.name} theirs={tradeFish(r)} currency={currency} /> : null}
                  </span>
                  {isMine(r.name) ? (
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      {bulkSales(r).map((b) => (
                        <SellButton
                          key={b.button}
                          channel={channel}
                          words={b.words}
                          label={b.what}
                          worth={b.worth}
                          currency={currency}
                          button={b.button}
                          question={`Sell ${b.what} for about ${b.worth.toLocaleString("en-US")} ${currency}?${b.words[1] === "fish" && b.words[0] === "all" ? " This can't be undone." : ""}`}
                        />
                      ))}
                    </span>
                  ) : null}
                </div>
                {detailed ? (
                  <HeldList
                    fish={r.fish}
                    currency={currency}
                    duel={duel}
                    emotes={emotes}
                    steal={canSteal(r.name) ? { channel, target: r.name } : null}
                    sell={isMine(r.name) ? { channel } : null}
                    junk={r.junk}
                  />
                ) : null}
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * A channel's big-bite how-to, public/videos/big-bite-<channel>.mp4 with a .jpg poster.
 * Per channel because it shows that channel's command and timings.
 */
function hasBigBiteVideo(channel: string): boolean {
  return /^[a-z0-9_]+$/.test(channel) && fs.existsSync(path.join(process.cwd(), "public", "videos", `big-bite-${channel}.mp4`));
}

type FishSection = "play" | "top" | "stealing" | "duels" | "odds";

/** The Fishing tab's sections that have something here, in order. "play" only with the game on. */
function fishSections(fishing: PublicFishing, playable: boolean): Array<{ id: FishSection; label: string }> {
  return [
    ...(playable ? [{ id: "play" as const, label: "Play" }] : []),
    { id: "top" as const, label: "Top fish" },
    ...(fishing.stealRules || fishing.steal || fishing.heists ? [{ id: "stealing" as const, label: "Stealing" }] : []),
    ...(fishing.duel || fishing.duels ? [{ id: "duels" as const, label: "Duels" }] : []),
    { id: "odds" as const, label: "Odds & prices" },
  ];
}

/**
 * The Fishing tab, split into sections like bot management's settings so it isn't one long
 * page: playing, the boards, stealing, duels and the odds tables. Each is its own link.
 */
function FishingTab({
  fishing,
  currency,
  channel,
  command,
  game,
  section: wanted,
  stealer,
  trader,
  viewer,
  own,
}: {
  fishing: PublicFishing;
  currency: string;
  channel: string;
  command: string;
  /** The signed-in viewer's game, below the big bite video; null with it off. */
  game: ReactNode;
  section: string | undefined;
  /** The signed-in viewer, when they may steal from the holdings (web play and stealing on). */
  stealer: string | null;
  /** The same for trading (web play and trading on). */
  trader: string | null;
  /** The signed-in viewer on the leaderboard. */
  viewer: string | null;
  /** Their own holdings row, loaded for Top fish with web play on. */
  own?: PublicHolder | null;
}) {
  const sections = fishSections(fishing, game !== null);
  const section = sections.find((x) => x.id === wanted)?.id ?? sections[0].id;
  // The big bite how-to is for everyone in chat: on Play when there is one, else at the top of Top fish.
  const video = fishing.bigBite && hasBigBiteVideo(channel) ? (
    <figure className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <video
        className="block aspect-video w-full bg-black"
        src={`${BASE_PATH}/videos/big-bite-${channel}.mp4`}
        poster={`${BASE_PATH}/videos/big-bite-${channel}.jpg`}
        controls
        playsInline
        preload="none"
      />
      <figcaption className="px-5 py-2 text-xs text-neutral-500">🎣 How to play big bites: how one plays out on stream, from the code to a snipe.</figcaption>
    </figure>
  ) : null;
  const link = (id: FishSection) => `${BASE_PATH}/leaderboard/${channel}?tab=fishing${id === sections[0].id ? "" : `&section=${id}`}`;
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-x-5 gap-y-1 border-b border-neutral-800 text-sm">
        {sections.map((x) => (
          <a
            key={x.id}
            href={link(x.id)}
            className={`-mb-px border-b-2 px-0.5 pb-2 transition ${
              x.id === section ? "border-[#53FC18] text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
            }`}
          >
            {x.label}
          </a>
        ))}
      </nav>

      {section === "play" ? (
        <>
          {video}
          {game}
        </>
      ) : null}

      {section === "top" ? (
        <>
          {game === null ? video : null}
          {fishing.topFish.length ? <TopFish rows={fishing.topFish} currency={currency} channel={channel} emotes={fishing.emotes} /> : null}
          {fishing.holders?.length || own ? (
            <Holders rows={fishing.holders ?? []} currency={currency} channel={channel} duel={!!fishing.duel} emotes={fishing.emotes} stealer={stealer} trader={trader} seller={game !== null ? stealer ?? trader ?? viewer : null} own={own} />
          ) : null}
          {!fishing.topFish.length && !fishing.holders?.length && !own ? <p className="text-sm text-neutral-500">Nobody holds any fish yet.</p> : null}
        </>
      ) : null}

      {section === "stealing" ? (
        <>
          {fishing.stealRules ? <StealGuide rules={fishing.stealRules} currency={currency} command={command} fish={[...fishing.fish, ...(fishing.trophies ?? [])]} emotes={fishing.emotes} /> : null}
          {fishing.steal || fishing.heists ? <Heists heists={fishing.heists ?? null} currency={currency} channel={channel} /> : null}
        </>
      ) : null}

      {section === "duels" ? <Duels duels={fishing.duels ?? null} currency={currency} channel={channel} /> : null}

      {section === "odds" ? (
        <>
          <p className="text-xs text-neutral-500">
            {`A cast lands a fish 1 time in ${fishing.catchOdds}; bait and reels improve that. Chance is how often a catch is that fish. `}
            {`Prices are for an average 50 cm fish: length scales it from half (1 cm) to double (100 cm), and a size record adds 50%: a fish you cast or land from a big bite that's longer than any you cast or landed before. Your first one only sets the length to beat, trap fish never count, and a tie isn't a record.`}
          </p>
          <CatchTable title="Fish" rows={fishing.fish} currency={currency} emotes={fishing.emotes} />
          {fishing.bigBite && fishing.trophies?.length ? (
            <>
              <p className="text-xs text-neutral-500">
                {`🎣 Big bites: while the stream is live, about every ${fishing.bigBite.everyMinutes} minutes someone chatting gets something big on their line. Reel in the codes shown on stream, one per pull and each harder and briefer than the last, and the trophy may still snap free on the last one. Chance here is a share of big bites.`}
              </p>
              <CatchTable title="Trophies" rows={fishing.trophies} currency={currency} />
            </>
          ) : null}
          {fishing.junk.length ? <CatchTable title="Junk" rows={fishing.junk} currency={currency} /> : null}
        </>
      ) : null}
    </div>
  );
}

const WHO_LABEL = { subs: "Subs & up", vips: "VIPs & up", mods: "Mods only", streamer: "Streamer only" } as const;

/**
 * A link target for a command row, from its words before any argument: "$don fish give
 * @user 🐟" is fish-give, "!claude <question>" is claude, "$don top activetime" is
 * top-activetime. Repeats get -2, -3 in page order, so every row has its own.
 */
function commandAnchors(sections: PublicCommands["sections"]): string[][] {
  const seen = new Map<string, number>();
  return sections.map((s) =>
    s.rows.map((r) => {
      const words = r.usage.trim().split(/\s+/);
      const head = words[0].replace(/^[$!]/, "");
      // The currency command itself ($don) is left out: its subcommand names the row.
      const rest = words[0].startsWith("$") ? words.slice(1) : [head, ...words.slice(1)];
      const named: string[] = [];
      for (const w of rest) {
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(w)) break;
        named.push(w.toLowerCase());
      }
      const base = named.join("-") || head.toLowerCase().replace(/[^a-z0-9-]/g, "") || "command";
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return n === 1 ? base : `${base}-${n}`;
    }),
  );
}

/** A link target for each section, from its title; one a command row already has gets -section. */
function sectionAnchors(sections: PublicCommands["sections"], rows: string[][]): string[] {
  const taken = new Set(rows.flat());
  return sections.map((s) => {
    const base = s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";
    return taken.has(base) ? `${base}-section` : base;
  });
}

/** Every command the channel has on: the currency ones with their short forms, then the bot's ! commands. */
function CommandsTab({ commands }: { commands: PublicCommands }) {
  const anchors = commandAnchors(commands.sections);
  const heads = sectionAnchors(commands.sections, anchors);
  return (
    <div className="space-y-4">
      <p className="text-xs text-neutral-500">
        {`Type these in chat. A green tag is a short form that does the same thing; words in [brackets] are optional. The # beside a command links straight to it.`}
      </p>
      {commands.sections.map((s, si) => (
        <section key={s.title} id={heads[si]} className="scroll-mt-4 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
          <div className="border-b border-neutral-800 px-5 py-2.5">
            <h2 className="text-sm font-medium text-neutral-200">
              <a href={`?tab=commands#${heads[si]}`} className="hover:underline">{s.title}</a>
            </h2>
            {s.note ? <p className="mt-0.5 text-xs text-neutral-500">{s.note}</p> : null}
          </div>
          <ul className="divide-y divide-neutral-800">
            {s.rows.map((r, ri) => (
              <li
                key={r.usage}
                id={anchors[si][ri]}
                className="group scroll-mt-4 px-5 py-2.5 text-sm [&:target]:bg-[#53FC18]/10 [&:target]:shadow-[inset_3px_0_0_#53FC18]"
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <a
                    href={`?tab=commands#${anchors[si][ri]}`}
                    aria-label={`Link to ${r.usage}`}
                    title="Link to this command"
                    className="-ml-3.5 w-2.5 font-mono text-xs text-neutral-600 opacity-40 hover:text-[#53FC18] group-hover:opacity-100"
                  >
                    #
                  </a>
                  <code className="-ml-2 font-mono text-[13px] text-neutral-100">{r.usage}</code>
                  {r.short ? <code className="rounded-md border border-neutral-800 bg-neutral-900 px-1.5 py-0.5 font-mono text-xs text-[#53FC18]">{r.short}</code> : null}
                  {r.who ? (
                    <span className="rounded-md border border-amber-900/60 bg-amber-950/40 px-1.5 py-0.5 text-xs text-amber-300">{WHO_LABEL[r.who]}</span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-neutral-400">{r.does}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export default async function LeaderboardPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();

  const { tab: rawTab, user: rawUser, signin: rawSignin, section: rawSection } = await searchParams;
  // ?user=<name> opens that viewer's history in the list.
  const lookup = (Array.isArray(rawUser) ? rawUser[0] : rawUser)?.trim().replace(/^@+/, "");
  const openFirst = lookup && /^[A-Za-z0-9_]{2,25}$/.test(lookup) ? lookup : null;
  const wanted = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  // The Active time tab was taken off on 2026-10-27: ?tab=watchtime opens the first tab.
  const tab: Tab = wanted === "fishing" ? "fishing" : wanted === "commands" ? "commands" : "points";

  const result = await loadPublicLeaderboard(slug);
  if (result.kind === "not-found") notFound();

  // The session only decides what the header's corner shows, never whether the page renders.
  let me: { userId: number; username: string } | null = null;
  try {
    me = await leaderboardViewer();
  } catch {
    me = null;
  }
  const username = me?.username ?? null;

  const data = result.kind === "ok" ? result.data : null;
  // The Fishing tab's game, played signed in (lib/viewer-login), which comes back there. Off in bot management, none.
  const fishingOn = data?.fishing?.webPlay === true;
  const viewerLogin = fishingOn && viewerLoginEnabled()
    ? `${BASE_PATH}/api/auth/viewer/login?next=${encodeURIComponent(`/leaderboard/${slug}?tab=fishing`)}`
    : null;
  const signinFailed = typeof rawSignin === "string" && !username;
  // The $DON tab's list comes from the same source as its search.
  const firstViewers = tab === "points" && data ? await loadPublicViewers(slug, "") : null;
  const fishing = data?.fishing ?? null;
  const fishSection = Array.isArray(rawSection) ? rawSection[0] : rawSection;
  // Top fish, signed in with web play on: your own row, which is where you sell, even off the public list.
  let own: PublicHolder | null = null;
  if (tab === "fishing" && fishingOn && fishSection === "top" && me) {
    try {
      own = publicHolder((await getFishPage(slug, me.userId, me.username)).fish?.own);
    } catch {
      own = null;
    }
  }
  const commands = data?.commands ?? null;
  const currency = data?.currencyName ?? "Points";
  const rows = data ? data.points : [];
  const tabLink = (t: Tab) => `${BASE_PATH}/leaderboard/${slug}${t === "points" ? "" : `?tab=${t}`}`;
  const tabClass = (t: Tab) =>
    `rounded-lg border px-3 py-1.5 text-sm transition ${
      tab === t
        ? "border-[#53FC18]/40 bg-[#53FC18]/10 text-[#53FC18]"
        : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
    }`;

  return (
    <>
      <SiteHeader channel={slug} username={username} isAdmin={false} current="leaderboard" variant="public" signInHref={viewerLogin} signOutTo={`/leaderboard/${slug}`} />

      <main className="mx-auto max-w-3xl space-y-5 px-4 py-8 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-neutral-100">{currency} leaderboard</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Earned by chatting while {slug} is live, and from follows, subs and Kicks.
            </p>
          </div>
          {/* The channel's earnings page is public too: a way over from here. */}
          <a
            href={`${BASE_PATH}/${slug}`}
            className="shrink-0 rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
          >
            Stream earnings →
          </a>
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
              {fishing ? (
                <a href={tabLink("fishing")} className={tabClass("fishing")}>
                  Fishing
                </a>
              ) : null}
              {commands ? (
                <a href={tabLink("commands")} className={tabClass("commands")}>
                  Commands
                </a>
              ) : null}
              <span className="ml-auto text-xs text-neutral-600">
                {result.kind === "ok" && result.stale ? "Showing an earlier copy · " : ""}
                Updated {formatUpdated(data.updatedAt)}
              </span>
            </nav>

            {tab === "points" && firstViewers?.kind === "ok" ? (
              <PublicViewers channel={slug} currency={currency} initial={firstViewers.viewers} openFirst={openFirst} />
            ) : tab === "commands" ? (
              commands ? (
                <CommandsTab commands={commands} />
              ) : (
                <p className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-8 text-center text-sm text-neutral-500">
                  The command list is unavailable right now.
                </p>
              )
            ) : tab === "fishing" ? (
              fishing ? (
                <FishingTab
                  fishing={fishing}
                  currency={currency}
                  channel={slug}
                  command={commands?.command ?? "$points"}
                  // Signed in only (or just back from a failed sign-in, to say so): signed out, Play stays hidden
                  // and Top fish opens first, so the game isn't the first thing every visitor sees.
                  game={fishingOn && (username || signinFailed) ? <FishingGame channel={slug} me={username} viewerLogin={viewerLogin} signinFailed={signinFailed} /> : null}
                  section={fishSection}
                  stealer={fishingOn && fishing.steal ? username : null}
                  trader={fishingOn && fishing.trade ? username : null}
                  viewer={username}
                  own={own}
                />
              ) : (
                <p className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-8 text-center text-sm text-neutral-500">
                  Fishing isn&apos;t on in this channel.
                </p>
              )
            ) : (
            <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
              {rows.length === 0 ? (
                <p className="px-5 py-8 text-center text-sm text-neutral-500">
                  {`Nobody has earned ${currency} yet.`}
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
                        <a
                          href={`${BASE_PATH}/leaderboard/${slug}?user=${encodeURIComponent(row.username)}`}
                          className="truncate text-neutral-200 hover:underline"
                          title={`${row.username}'s ${currency} history`}
                        >
                          {row.username}
                        </a>
                      </span>
                      <span className="shrink-0 tabular-nums text-neutral-300">
                        {`${row.value.toLocaleString("en-US")} ${currency}`}
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
