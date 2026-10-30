"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { FishPage, FishReply, OwnShop as Shop } from "@/lib/bot-api";
import OwnShop from "@/components/OwnShop";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// The fishing game on the leaderboard's Fishing tab: casts, traps and their checks, played
// by the channel's bot exactly as in chat (community/web-fish.ts), and the gear shop. The
// page never decides anything itself: every button is a move the bot answers.

/** "1h 5m", "4m 10s", "12s". */
function span(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const minutesLabel = (m: number) => (m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

/** Trap lengths to offer: the usual one and round ones, within the channel's range. */
function trapChoices(t: FishPage["trapMinutes"]): number[] {
  const all = [t.usual, 60, 120, 240, 480, 720, t.max].filter((m) => m >= t.min && m <= t.max);
  return [...new Set(all)].sort((a, b) => a - b);
}

type Bucket = NonNullable<FishPage["bucket"]>[number];
type Held = Bucket["each"][number];
/** Fish alike (length, level, 🏅) as one choice, with how many. */
type Group = Held & { key: string; n: number };

function groups(each: Held[]): Group[] {
  const out = new Map<string, Group>();
  for (const e of each) {
    const key = `${e.cm}|${e.level}|${e.record ? 1 : 0}`;
    const had = out.get(key);
    if (had) had.n++;
    else out.set(key, { ...e, key, n: 1 });
  }
  return [...out.values()];
}

/** A reply with its emote words ("Sadge", a custom fish) drawn as the channel's emotes, as chat shows them. */
function WithEmotes({ text, emotes }: { text: string; emotes?: Record<string, string> }) {
  if (!emotes || !Object.keys(emotes).length) return <>{text}</>;
  return (
    <>
      {text.split(/(\s+)/).map((w, i) =>
        emotes[w] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={emotes[w]} alt={w} title={w} className="inline-block h-[1.5em] w-auto align-middle" loading="lazy" />
        ) : (
          w
        ),
      )}
    </>
  );
}

/** "100 cm Lv10 🏅", as chat names a fish. */
const fishLabel = (e: Pick<Held, "cm" | "level" | "record">) => `${e.cm} cm${e.level ? ` Lv${e.level}` : ""}${e.record ? " 🏅" : ""}`;

/** The very fish, as chat names it: kind, length, level and 🏅 ("🐟 100cm Lv10 🏅"). */
const exactWords = (emoji: string, e: Pick<Held, "cm" | "level" | "record">) => [emoji, `${e.cm}cm`, `Lv${e.level}`, ...(e.record ? ["🏅"] : [])];

/** A food on the plate: a kind ("any", unfed first) or that very fish, and how many. */
type Food = { key: string; label: string; n: number; words: string[] };

/** "feed 🦈 72cm Lv3 🐟 40cm Lv1 2 🦀 1": the very eater, then each food and how many. */
const feedArgs = (eater: Held & { emoji: string }, foods: Food[]) => ["feed", ...exactWords(eater.emoji, eater), ...foods.flatMap((f) => f.words)];

const select = "rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200";
const btn = "rounded-md border border-neutral-700 px-3 py-1.5 text-sm text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40";
const primary = "rounded-md bg-[#53FC18] px-3 py-1.5 text-sm font-medium text-black hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40";

export default function FishingGame({
  channel,
  me,
  viewerLogin,
  signinFailed,
}: {
  channel: string;
  /** The viewer signed in on the leaderboard, or null. */
  me: string | null;
  /** The viewer sign-in link, or null when it isn't set up. */
  viewerLogin: string | null;
  signinFailed: boolean;
}) {
  const [fish, setFish] = useState<FishPage | null>(null);
  const [shop, setShop] = useState<Shop | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The replies to the last move, shown above the log until the next one.
  const [latest, setLatest] = useState<FishReply[] | null>(null);
  const [answer, setAnswer] = useState("");
  const [trapFor, setTrapFor] = useState<number | null>(null);
  // Every feeding and trade answer asks once more, saying what goes and what it's worth,
  // before it's sent: a stray click (or a small child) can't give a fish away. `where` puts the
  // question under the row that asked it.
  const [pending, setPending] = useState<{ where: "feed" | "trade"; text: string; yes: string; args: string[]; after?: () => void } | null>(null);
  // The fish that eats (emoji|cm|level|record), the food picker, and the plate so far.
  const [feed, setFeed] = useState<{ eater: string; kind: string; count: number; foods: Food[] }>({ eater: "", kind: "", count: 1, foods: [] });
  // Server time minus this browser's, so countdowns don't drift with a wrong clock.
  const skew = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  const api = `${BASE_PATH}/api/public/${encodeURIComponent(channel)}`;

  const adopt = useCallback((next: FishPage | null) => {
    if (next) skew.current = next.now - Date.now();
    // A move's answer comes without the emote images: keep the ones loaded.
    setFish((prev) => (next && !next.emotes && prev?.emotes ? { ...next, emotes: prev.emotes } : next));
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}/fish`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { fish?: FishPage | null; error?: string } | null;
      if (!res.ok) throw new Error(body?.error ?? `Couldn't load your fishing (${res.status})`);
      adopt(body?.fish ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load your fishing");
    }
    try {
      const res = await fetch(`${api}/shop`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { shop?: Shop | null } | null;
      if (res.ok) setShop(body?.shop ?? null);
    } catch {
      // The shop is extra; the game works without it.
    }
  }, [api, adopt]);

  useEffect(() => {
    if (!me) return;
    void load();
    const poll = setInterval(() => void load(), 20_000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      window.removeEventListener("focus", focus);
    };
  }, [me, load]);

  /** Play one move; true once the bot has it (whatever it answered). */
  async function move(args: string[]): Promise<boolean> {
    setBusy(true);
    setLatest(null);
    try {
      const res = await fetch(`${api}/fish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args, requestId: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { replies?: FishReply[]; answered?: boolean; fish?: FishPage; error?: string } | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `That didn't go through (${res.status})`);
      if (body.fish) adopt(body.fish);
      setLatest(body.answered ? (body.replies ?? []) : [{ ts: Date.now(), text: "The bot didn't answer in time. Your move may still have gone through: check below in a moment.", kind: "info", item: null }]);
      setAnswer("");
      setPending(null);
      setError(null);
      if (!body.answered) setTimeout(() => void load(), 4000);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through");
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!me) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4 text-sm text-neutral-300">
        <p className="font-medium text-neutral-100">🎣 Fish here instead of in chat</p>
        <p className="mt-1 text-neutral-400">Cast, lay traps, feed, trade and buy gear from this page, with the same rules and cooldowns as chat.</p>
        {viewerLogin ? (
          <p className="mt-3 flex flex-wrap items-center gap-3">
            <a href={viewerLogin} className={primary}>Sign in with Kick</a>
            <span className="text-xs text-neutral-500">Kick only shares your name: nothing is added to your channel.</span>
          </p>
        ) : (
          <p className="mt-3 text-xs text-neutral-500">Signing in to fish here isn&apos;t open yet.</p>
        )}
        {signinFailed ? <p className="mt-2 text-xs text-red-400">That sign-in didn&apos;t work, try again.</p> : null}
      </section>
    );
  }

  if (!fish) {
    return (
      <section className="rounded-xl border border-neutral-800 bg-neutral-950/60 px-5 py-4 text-sm text-neutral-400">
        {error ?? "Loading your fishing…"}
      </section>
    );
  }

  const t = now + skew.current;
  const cur = fish.currency;
  const closed =
    fish.rule === "offline" && fish.live
      ? "Fishing is closed while the stream is live: it opens again when the stream ends."
      : fish.rule === "live" && !fish.live
        ? "Fishing here is only while the stream is live."
        : null;
  const waitMs = fish.readyAt ? fish.readyAt - t : 0;
  const check = fish.check && fish.check.until > t ? fish.check : null;
  const trap = fish.trap;
  const trapFull = !!trap && trap.end <= t;
  const choices = trapChoices(fish.trapMinutes);
  const chosen = trapFor ?? (choices.includes(fish.trapMinutes.usual) ? fish.trapMinutes.usual : choices[0]);
  const canCast = !busy && !closed && waitMs <= 0 && !trap && !check;
  const canTrap = !busy && !closed && waitMs <= 0 && !check;

  function tap(e: React.MouseEvent<HTMLImageElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (e.clientY - box.top) / box.height));
    void move(["answer", `tap:${x.toFixed(3)},${y.toFixed(3)}`]);
  }

  const row = "flex flex-wrap items-center justify-between gap-3 px-5 py-3";
  const bucket = fish.bucket ?? [];
  // Any fish below the top level can eat, named exactly (length, level, 🏅), so the one picked is the one fed.
  const eaters = bucket
    .filter((k) => k.type === "fish")
    .flatMap((k) => groups(k.each).filter((e) => e.level < 10).map((e) => ({ ...e, emoji: k.emoji, key: `${k.emoji}|${e.key}` })));
  const eater = eaters.find((e) => e.key === feed.eater);
  // Food, as the eater list: each kind (any of it, unfed first) and then each very fish. The eater itself is held back.
  const foodChoices = bucket
    .filter((k) => k.type === "fish")
    .flatMap((k) => {
      const minusEater = (gk: string) => (eater && eater.key === `${k.emoji}|${gk}` ? 1 : 0);
      const any = { key: `${k.emoji}|any`, label: `${k.emoji} any, unfed first`, max: k.n - (eater?.emoji === k.emoji ? 1 : 0), words: (n: number) => [k.emoji, String(n)] };
      const exact = groups(k.each).map((gp) => ({
        key: `${k.emoji}|${gp.key}`,
        label: `${k.emoji} ${fishLabel(gp)}${gp.n > 1 ? ` ×${gp.n}` : ""}`,
        max: gp.n - minusEater(gp.key),
        words: (n: number) => [...exactWords(k.emoji, gp), ...(n > 1 ? [String(n)] : [])],
      }));
      return [any, ...exact].filter((c) => c.max > 0);
    });
  const foodChoice = foodChoices.find((c) => c.key === feed.kind) ?? foodChoices[0];

  const ask = (where: "feed" | "trade", text: string, yes: string, args: string[], after?: () => void) =>
    setPending({ where, text, yes, args, after });

  /** The question waiting under a row: what happens, then yes or cancel. */
  const confirmBar = (where: "feed" | "trade") =>
    pending?.where === where ? (
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-amber-500/30 bg-amber-500/5 px-5 py-2">
        <span className="text-amber-200">{pending.text}</span>
        <span className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              const p = pending;
              void move(p.args).then((sent) => sent && p.after?.());
            }}
            className={primary}
          >
            {pending.yes}
          </button>
          <button type="button" onClick={() => setPending(null)} className={btn}>Cancel</button>
        </span>
      </div>
    ) : null;
  return (
    <section className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950/60 text-sm text-neutral-300">
      <h2 className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-800 px-5 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🎣 Your fishing</span>
        <span className="tabular-nums">
          {fish.balance.toLocaleString("en-US")} {cur} · 🐟 {fish.held.fish}
          {fish.held.maxFish ? `/${fish.held.maxFish}` : ""} · junk {fish.held.junk}
          {fish.held.maxJunk ? `/${fish.held.maxJunk}` : ""}
          {/* Selling is on your own row under Top fish, not here. */}
          {fish.held.fish + fish.held.junk > 0 ? (
            <a href={`${BASE_PATH}/leaderboard/${channel}?tab=fishing&section=top`} className="ml-2 text-neutral-300 underline">Sell under Top fish</a>
          ) : null}
        </span>
      </h2>

      {closed ? <p className="border-b border-neutral-800 px-5 py-2 text-amber-400">{closed}</p> : null}
      {error ? <p className="border-b border-neutral-800 px-5 py-2 text-red-400">{error}</p> : null}

      {check ? (
        <div className="space-y-3 border-b border-neutral-800 px-5 py-4">
          <p className="text-neutral-100">
            {check.onCast ? "Your line snagged! " : "Your traps are full! "}
            <b>{check.question}</b>
          </p>
          <p className="text-xs text-neutral-500">
            {check.triesLeft} {check.triesLeft === 1 ? "try" : "tries"} left · {span(check.until - t)} to answer · running out costs a fine
            {check.onCast ? "" : " and the catch"}
          </p>
          {check.picture ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={`${api}/fish/picture?c=${check.until}`}
              alt="Fish to tap"
              onClick={busy ? undefined : tap}
              className={`block w-full max-w-md cursor-crosshair rounded-md border border-neutral-800 ${busy ? "opacity-60" : ""}`}
              draggable={false}
            />
          ) : (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (answer.trim()) void move(["answer", answer.trim()]);
              }}
            >
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                maxLength={40}
                aria-label="Your answer"
                className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 outline-none focus:border-neutral-500"
              />
              <button type="submit" disabled={busy || !answer.trim()} className={primary}>Answer</button>
            </form>
          )}
        </div>
      ) : null}

      <div className="divide-y divide-neutral-800">
        <div className={row}>
          <span>
            Cast a line
            <span className="block text-xs text-neutral-500">
              {trap
                ? "Not while your traps are out."
                : waitMs > 0
                  ? `Next cast in ${span(waitMs)}.`
                  : `A fish 1 time in ${fish.catchOdds} without bait.`}
            </span>
          </span>
          <span className="flex flex-wrap gap-2">
            <button type="button" disabled={!canCast} onClick={() => void move([])} className={primary}>Cast</button>
            {fish.baits.map((b) => (
              <button
                key={b.word}
                type="button"
                disabled={!canCast || fish.balance < b.price}
                title={`1 in ${b.oneIn}, costs ${b.price} ${cur}`}
                onClick={() => void move([b.word])}
                className={btn}
              >
                {b.emoji} {b.word} · {b.price}
              </button>
            ))}
          </span>
        </div>

        <div className={row}>
          <span>
            Fish traps
            <span className="block text-xs text-neutral-500">
              {!trap
                ? "Lay them and come back when they're full."
                : trapFull
                  ? "Full: collect them."
                  : `Full in ${span(trap.end - t)}.`}
            </span>
          </span>
          <span className="flex flex-wrap items-center gap-2">
            {!trap || trapFull ? (
              <select
                value={chosen}
                onChange={(e) => setTrapFor(Number(e.target.value))}
                aria-label="How long to lay the traps"
                className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
              >
                {choices.map((m) => (
                  <option key={m} value={m}>{minutesLabel(m)}</option>
                ))}
              </select>
            ) : null}
            {!trap ? (
              <button type="button" disabled={!canTrap} onClick={() => void move(["trap", `${chosen}m`])} className={primary}>Lay traps</button>
            ) : trapFull ? (
              <>
                <button type="button" disabled={!canTrap} onClick={() => void move(["trap"])} className={primary}>Collect</button>
                <button type="button" disabled={!canTrap} onClick={() => void move(["trap", "reset", `${chosen}m`])} className={btn}>Collect and lay again</button>
              </>
            ) : (
              <>
                <button type="button" disabled={!canTrap} onClick={() => void move(["trap", "lift"])} className={btn} title="Pull them up now with what they've caught so far">Lift early</button>
                <button type="button" disabled={busy || !!check} onClick={() => void move(["trap", "cancel"])} className={btn} title="Pull them up with no catch">Cancel</button>
              </>
            )}
          </span>
        </div>
      </div>

      {latest?.length ? (
        <ul className="space-y-1 border-t border-neutral-800 bg-neutral-900/40 px-5 py-3">
          {latest.map((r, i) => (
            <li key={i} className={r.kind === "catch" || r.kind === "trap" ? "text-[#53FC18]" : "text-neutral-200"}><WithEmotes text={r.text} emotes={fish.emotes} /></li>
          ))}
        </ul>
      ) : null}

      {fish.bucket?.length ? (
        <div className="divide-y divide-neutral-800 border-t border-neutral-800">
          {fish.feeding && eaters.length ? (
            <div className={row}>
              <span>
                Feed
                <span className="block text-xs text-neutral-500">
                  {eater && eater.xpNext !== undefined
                    ? `${eater.emoji} ${eater.cm} cm Lv${eater.level}: ${(eater.xp ?? 0).toLocaleString("en-US")}/${eater.xpNext.toLocaleString("en-US")} XP to Lv${eater.level + 1}.`
                    : "Pick a fish to feed, then what it eats."}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <select value={feed.eater} onChange={(e) => setFeed({ ...feed, eater: e.target.value })} aria-label="Fish that eats" className={select}>
                  <option value="">Fish that eats…</option>
                  {eaters.map((e) => (
                    <option key={e.key} value={e.key}>{e.emoji} {e.cm} cm{e.level ? ` Lv${e.level}` : ""}{e.record ? " 🏅" : ""}</option>
                  ))}
                </select>
                <select value={foodChoice?.key ?? ""} onChange={(e) => setFeed({ ...feed, kind: e.target.value, count: 1 })} aria-label="Food" className={select}>
                  {foodChoices.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={1}
                  max={foodChoice?.max ?? 1}
                  value={feed.count}
                  onChange={(e) => setFeed({ ...feed, count: Math.max(1, Math.floor(Number(e.target.value) || 1)) })}
                  aria-label="How many"
                  className="w-16 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-200"
                />
                <button
                  type="button"
                  disabled={!foodChoice || feed.foods.length >= 6}
                  onClick={() => {
                    if (!foodChoice) return;
                    const n = Math.min(feed.count, foodChoice.max);
                    const label = foodChoice.label.replace(/ ×\d+$/, "");
                    setFeed({ ...feed, foods: [...feed.foods.filter((f) => f.key !== foodChoice.key), { key: foodChoice.key, label, n, words: foodChoice.words(n) }] });
                  }}
                  className={btn}
                >
                  Add
                </button>
                <button
                  type="button"
                  disabled={busy || !eater || !feed.foods.length}
                  onClick={() =>
                    eater &&
                    ask(
                      "feed",
                      `Feed ${feed.foods.map((f) => `${f.label} ×${f.n}`).join(", ")} to your ${eater.emoji} ${fishLabel(eater)}? The food is eaten and gone.`,
                      "Yes, feed",
                      feedArgs(eater, feed.foods),
                      () => setFeed((f) => ({ ...f, foods: [] })),
                    )
                  }
                  className={primary}
                >
                  Feed
                </button>
              </span>
              {feed.foods.length ? (
                <span className="flex w-full flex-wrap gap-2 text-xs">
                  {feed.foods.map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      onClick={() => setFeed({ ...feed, foods: feed.foods.filter((x) => x.key !== f.key) })}
                      className="rounded-md border border-neutral-800 px-2 py-1 text-neutral-300 hover:border-neutral-600"
                      title="Take it off the plate"
                    >
                      {f.label} ×{f.n} ✕
                    </button>
                  ))}
                  <span className="self-center text-neutral-500">Unfed ones go first; a fed fish eaten gives its levels as XP.</span>
                </span>
              ) : null}
            </div>
          ) : null}
          {confirmBar("feed")}
        </div>
      ) : null}

      {fish.trading ? (
        <div className="space-y-3 border-t border-neutral-800 px-5 py-3">
          <span className="block">
            Trades
            <span className="block text-xs text-neutral-500">
              {fish.trades?.length ? "Offers waiting on you or from you. " : "No offers waiting. "}
              To make one, open someone&apos;s row under <a href={`${BASE_PATH}/leaderboard/${channel}?tab=fishing&section=top`} className="text-neutral-300 underline">Top fish</a> and press 🤝 Trade.
            </span>
          </span>
          {(fish.trades ?? []).map((o, i) => (
            <div key={i} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-800 px-3 py-2">
              <span>
                {o.incoming ? (
                  <>@{o.with} offers <b>{o.give}</b> for your <b>{o.get}</b></>
                ) : (
                  <>Your offer to @{o.with}: <b>{o.give}</b> for <b>{o.get}</b></>
                )}
                <span className="block text-xs text-neutral-500">
                  {span(o.expiresAt - t)} left{o.incoming ? "" : ` · you pay a ${o.fee.toLocaleString("en-US")} ${cur} fee if it goes through`}
                </span>
              </span>
              <span className="flex gap-2">
                {o.incoming ? (
                  <>
                    <button type="button" disabled={busy} onClick={() => ask("trade", `Accept: you give ${o.get} and get ${o.give}?`, "Yes, trade", ["accept"])} className={primary}>Accept</button>
                    <button type="button" disabled={busy} onClick={() => void move(["decline"])} className={btn}>Decline</button>
                  </>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void move(["trade", "cancel"])} className={btn}>Take back</button>
                )}
              </span>
            </div>
          ))}
          {confirmBar("trade")}
        </div>
      ) : null}

      {fish.log.length ? (
        <details className="border-t border-neutral-800 px-5 py-3">
          <summary className="cursor-pointer text-xs text-neutral-500">Your last moves</summary>
          <ul className="mt-2 space-y-1 text-xs text-neutral-400">
            {fish.log.map((r, i) => (
              <li key={i}>
                <span className="mr-2 tabular-nums text-neutral-600">
                  {new Date(r.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" })}
                </span>
                <WithEmotes text={r.text} emotes={fish.emotes} />
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {shop ? (
        <div className="border-t border-neutral-800 p-3">
          <OwnShop channel={channel} initial={shop} currency={cur} />
        </div>
      ) : null}
    </section>
  );
}
