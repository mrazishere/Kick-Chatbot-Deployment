import * as fs from "fs";
import * as path from "path";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import { validChannel } from "@/lib/bot-auth";
import { getSession } from "@/lib/session";
import { loadPublicLeaderboard, loadPublicViewers } from "@/lib/public-leaderboard";
import PublicViewers from "@/components/PublicViewers";
import Heists from "@/components/Heists";
import Duels from "@/components/Duels";
import type { PublicCatch, PublicCommands, PublicFishing, PublicHolder, PublicStealRules, PublicTopFish } from "@/lib/bot-api";

export const dynamic = "force-dynamic";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<{ tab?: string | string[]; user?: string | string[] }>;
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
          <li key={`${r.name}-${r.emoji}-${r.cm}-${r.level ?? 0}-${i}`} className="flex items-center gap-3 px-5 py-2.5 text-sm">
            <span className="w-6 shrink-0 text-xs tabular-nums text-neutral-600">{i + 1}</span>
            <span className="w-8 shrink-0 text-xl leading-none"><FishIcon name={r.emoji} emotes={emotes} /></span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="tabular-nums text-neutral-100">{r.cm === null ? "no size" : `${r.cm} cm`}</span>
                {r.level ? <span className="rounded bg-amber-500/15 px-1 text-xs text-amber-300">Lv{r.level}</span> : null}
                {r.n > 1 ? <span className="text-xs tabular-nums text-neutral-500">×{r.n}</span> : null}
                <span className={`rounded-md border px-1.5 py-0.5 text-xs ${RARITY_CLASS[r.rarity]}`}>{r.rarity}</span>
              </span>
              <span className="mt-1 block text-xs text-neutral-500">
                <a href={`${BASE_PATH}/${channel}/leaderboard?user=${encodeURIComponent(r.name)}`} className="text-neutral-200 hover:underline">{r.name}</a>
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
                The chance it works follows how rare the fish is to catch: the rarer, the harder. Trophies go by the tier they fight as.
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
              ? `Fines are priced so thieves would lose about ${r.edgePercent}% on average at the base odds, but every chance here gets a +${r.luckPercent}% boost (already in the table), so thieves come out a little ahead on average.`
              : `Fines are priced so that thieves lose about ${r.edgePercent}% of what they'd hope to win, on average.`}{" "}
            You need enough {currency} on hand to cover the fee and fine for their most valuable fish, or your hook fumbles.
          </p>
          <p>
            After a try on someone, they&apos;re on alert for {mins(r.protectMinutes)}: nobody can try them. You can try the same person once a day.
          </p>
          <h3 className="pt-1 font-medium text-neutral-100">💂 Guard</h3>
          <p>
            {code(`${command} fish buy guard`)} protects all your fish for <b>{r.guardHours} hours</b>. It costs {r.guardPercent}% of what your fish are worth when you buy it (at least {n(r.guardMinimum)} {currency});
            buying again adds more time. A guard catches every thief: they pay the fee and the fine as if caught, no roll. How long your guard has left is never shown in chat, so thieves can&apos;t time it.
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
function HeldList({ fish, currency, duel, emotes }: { fish: PublicHolder["fish"]; currency: string; duel: boolean; emotes?: Emotes }) {
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
                key={`${e.cm}-${e.worth}-${e.level ?? 0}`}
                title={`${e.worth.toLocaleString("en-US")} ${currency} each`}
                className="rounded-md border border-neutral-800 bg-neutral-950/60 px-1.5 py-0.5 text-xs tabular-nums text-neutral-300"
              >
                <span className="text-neutral-100">{e.cm === null ? "no size" : `${e.cm} cm`}</span>
                {e.level ? <span className="ml-1 rounded bg-amber-500/15 px-1 text-amber-300">Lv{e.level}</span> : null}
                {e.n > 1 ? <span className="text-neutral-500"> ×{e.n}</span> : null}
                <span className="ml-1.5 text-neutral-500">❤️{e.hp} ⚔️{e.attack} 💰{e.worth.toLocaleString("en-US")}</span>
              </span>
            ))}
          </span>
        </div>
      ))}
      <p className="pt-1 text-xs text-neutral-600">
        Grouped by kind, strongest first. ❤️ health and ⚔️ attack in a fish duel, 💰 what one sells for, their reel's bonus included (stolen fish don't get it).{duel ? " Duel a certain one by its length, like 🦈 72cm." : ""}
      </p>
    </div>
  );
}

function Holders({ rows, currency, channel, duel, emotes }: { rows: PublicHolder[]; currency: string; channel: string; duel: boolean; emotes?: Emotes }) {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60">
      <h2 className="border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🪣 Holding right now</span>
        {` · ${total.toLocaleString("en-US")} unsold fish, by what they'd sell for with their reel. Tap someone to see their fish by kind, strongest first, each with its length and stats.`}
      </h2>
      <ol className="divide-y divide-neutral-800">
        {rows.map((r, i) => {
          const detailed = r.fish.some((f) => f.each?.length);
          // Collapsed: who and what it's worth. Open: every kind they hold, strongest kind first, each kind's fish strongest first.
          return (
            <li key={r.name} className="text-sm">
              <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-2.5 hover:bg-neutral-900/40 [&::-webkit-details-marker]:hidden">
                  <span className="w-6 shrink-0 text-xs tabular-nums text-neutral-600">{i + 1}</span>
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
                  <a href={`${BASE_PATH}/${channel}/leaderboard?user=${encodeURIComponent(r.name)}`} className="mt-2 inline-block text-xs text-neutral-500 hover:text-neutral-300 hover:underline">
                    {`${r.name}'s ${currency} history →`}
                  </a>
                </div>
                {detailed ? <HeldList fish={r.fish} currency={currency} duel={duel} emotes={emotes} /> : null}
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

function FishingTab({ fishing, currency, channel, command }: { fishing: PublicFishing; currency: string; channel: string; command: string }) {
  return (
    <div className="space-y-4">
      {fishing.bigBite && hasBigBiteVideo(channel) ? (
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
      ) : null}
      <p className="text-xs text-neutral-500">
        {`A cast lands a fish 1 time in ${fishing.catchOdds}; bait and reels improve that. Chance is how often a catch is that fish. `}
        {`Prices are for an average 50 cm fish: length scales it from half (1 cm) to double (100 cm), and beating your record adds 50%.`}
      </p>
      {fishing.topFish.length ? <TopFish rows={fishing.topFish} currency={currency} channel={channel} emotes={fishing.emotes} /> : null}
      {fishing.holders?.length ? <Holders rows={fishing.holders} currency={currency} channel={channel} duel={!!fishing.duel} emotes={fishing.emotes} /> : null}
      {fishing.stealRules ? <StealGuide rules={fishing.stealRules} currency={currency} command={command} fish={[...fishing.fish, ...(fishing.trophies ?? [])]} emotes={fishing.emotes} /> : null}
      {fishing.steal || fishing.heists ? <Heists heists={fishing.heists ?? null} currency={currency} channel={channel} /> : null}
      {fishing.duel || fishing.duels ? <Duels duels={fishing.duels ?? null} currency={currency} channel={channel} /> : null}
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

  const { tab: rawTab, user: rawUser } = await searchParams;
  // ?user=<name> opens that viewer's history in the list.
  const lookup = (Array.isArray(rawUser) ? rawUser[0] : rawUser)?.trim().replace(/^@+/, "");
  const openFirst = lookup && /^[A-Za-z0-9_]{2,25}$/.test(lookup) ? lookup : null;
  const wanted = Array.isArray(rawTab) ? rawTab[0] : rawTab;
  // The Active time tab was taken off on 2026-10-27: ?tab=watchtime opens the first tab.
  const tab: Tab = wanted === "fishing" ? "fishing" : wanted === "commands" ? "commands" : "points";

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
  // The $DON tab's list comes from the same source as its search.
  const firstViewers = tab === "points" && data ? await loadPublicViewers(slug, "") : null;
  const fishing = data?.fishing ?? null;
  const commands = data?.commands ?? null;
  const currency = data?.currencyName ?? "Points";
  const rows = data ? data.points : [];
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
              <PublicViewers channel={slug} currency={currency} initial={firstViewers.viewers} openFirst={openFirst} me={username} />
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
                <FishingTab fishing={fishing} currency={currency} channel={slug} command={commands?.command ?? "$points"} />
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
                          href={`${BASE_PATH}/${slug}/leaderboard?user=${encodeURIComponent(row.username)}`}
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
