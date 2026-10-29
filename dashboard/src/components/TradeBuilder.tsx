"use client";

import { useState } from "react";
import type { FishPage } from "@/lib/bot-api";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// A trade offer built from the leaderboard's holdings: your fish and theirs as buttons, with
// currency either side, so nothing is typed. It goes to the bot as chat's `fish trade`, each
// fish named by length, level and 🏅 so the very ones picked change hands, and the other
// viewer is pinged in chat. Their answer (and yours to their offers) is on the Play tab.

/** A fish to pick: as the page lists one, with how many alike. */
export interface TradeFish {
  emoji: string;
  cm: number | null;
  level: number;
  record: boolean;
  worth: number;
  n: number;
}

const keyOf = (f: TradeFish) => `${f.emoji}|${f.cm ?? "-"}|${f.level}|${f.record ? 1 : 0}`;
const label = (f: TradeFish) => `${f.emoji} ${f.cm === null ? "" : `${f.cm} cm`}${f.level ? ` Lv${f.level}` : ""}${f.record ? " 🏅" : ""}`.trim();

/** The words for a side: the currency first (where chat always reads a number as currency), then each fish exactly. */
function sideWords(picked: Map<string, number>, list: TradeFish[], coins: number): string[] {
  const words: string[] = coins > 0 ? [String(coins)] : [];
  for (const f of list) {
    const n = picked.get(keyOf(f)) ?? 0;
    if (!n) continue;
    if (f.cm === null) words.push(f.emoji, String(n));
    // A count after the very fish is more of it ("🐟 100cm Lv10 2"); under 100, chat reads it as a count, not currency.
    else words.push(f.emoji, `${f.cm}cm`, `Lv${f.level}`, ...(f.record ? ["🏅"] : []), ...(n > 1 ? [String(n)] : []));
  }
  return words;
}

/** The signed-in viewer's own fish, from their game state. */
function ownFish(fish: FishPage): TradeFish[] {
  return (fish.bucket ?? []).flatMap((k) => {
    if (k.type !== "fish") return [];
    const out = new Map<string, TradeFish>();
    for (const e of k.each) {
      const f: TradeFish = { emoji: k.emoji, cm: e.cm, level: e.level, record: e.record, worth: e.worth, n: 1 };
      const had = out.get(keyOf(f));
      if (had) had.n++;
      else out.set(keyOf(f), f);
    }
    const plain = k.unsized > 0 ? [{ emoji: k.emoji, cm: null, level: 0, record: false, worth: Math.round((k.worth - k.each.reduce((t, e) => t + e.worth, 0)) / k.unsized), n: k.unsized }] : [];
    return [...out.values(), ...plain];
  });
}

export default function TradeBuilder({ channel, target, theirs, currency }: { channel: string; target: string; theirs: TradeFish[]; currency: string }) {
  const [open, setOpen] = useState(false);
  const [mine, setMine] = useState<TradeFish[] | null>(null);
  const [balance, setBalance] = useState(0);
  const [give, setGive] = useState(new Map<string, number>());
  const [want, setWant] = useState(new Map<string, number>());
  const [coins, setCoins] = useState({ give: "", want: "" });
  const [stage, setStage] = useState<"pick" | "confirm" | "sending" | "done">("pick");
  const [text, setText] = useState("");
  const api = `${BASE_PATH}/api/public/${encodeURIComponent(channel)}/fish`;

  async function start() {
    setOpen(true);
    setStage("pick");
    setText("");
    try {
      const res = await fetch(api, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { fish?: FishPage | null; error?: string } | null;
      if (!res.ok || !body?.fish) throw new Error(body?.error ?? "Couldn't load your fish");
      setMine(ownFish(body.fish));
      setBalance(body.fish.balance);
    } catch (e) {
      setText(e instanceof Error ? e.message : "Couldn't load your fish");
      setMine([]);
    }
  }

  const amount = (v: string) => Math.max(0, Math.floor(Number(v.replace(/[^\d]/g, "")) || 0));
  const giveCoins = amount(coins.give);
  const wantCoins = amount(coins.want);
  const giveWords = sideWords(give, mine ?? [], giveCoins);
  const wantWords = sideWords(want, theirs, wantCoins);
  const worth = (picked: Map<string, number>, list: TradeFish[]) => list.reduce((t, f) => t + (picked.get(keyOf(f)) ?? 0) * f.worth, 0);
  const giveWorth = worth(give, mine ?? []) + giveCoins;
  const wantWorth = worth(want, theirs) + wantCoins;
  const fishOnEither = [...give.values(), ...want.values()].some((n) => n > 0);
  // The bot takes 40 words a move: "trade", "@name" and the two sides.
  const tooMany = giveWords.length + wantWords.length + 2 > 40;
  const ready = giveWords.length > 0 && wantWords.length > 0 && fishOnEither && !tooMany;

  async function send() {
    setStage("sending");
    try {
      const res = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: ["trade", ...giveWords, `@${target}`, ...wantWords], requestId: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { replies?: Array<{ text: string }>; answered?: boolean; error?: string } | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `That didn't go through (${res.status})`);
      setText(body.answered ? (body.replies ?? []).map((r) => r.text).join(" ") : "The bot didn't answer in time: check the Play tab in a moment.");
    } catch (e) {
      setText(e instanceof Error ? e.message : "That didn't go through");
    }
    setStage("done");
  }

  const btn = "rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40";
  if (!open) {
    return <button type="button" onClick={() => void start()} className={btn}>🤝 Trade</button>;
  }

  const picker = (list: TradeFish[], picked: Map<string, number>, set: (m: Map<string, number>) => void) =>
    list.length ? (
      <span className="flex flex-wrap gap-1.5">
        {list.map((f) => {
          const n = picked.get(keyOf(f)) ?? 0;
          const bump = (d: number) => {
            const next = new Map(picked);
            const v = Math.min(f.n, Math.max(0, n + d));
            if (v) next.set(keyOf(f), v);
            else next.delete(keyOf(f));
            set(next);
          };
          return (
            <span key={keyOf(f)} className={`inline-flex items-center rounded-md border text-xs ${n ? "border-[#53FC18]/50 bg-[#53FC18]/10" : "border-neutral-800"}`}>
              <button type="button" onClick={() => bump(1)} disabled={n >= f.n} className="px-1.5 py-0.5 text-neutral-200 disabled:opacity-60" title={`${f.worth.toLocaleString("en-US")} ${currency} each`}>
                {label(f)}
                {f.n > 1 ? <span className="text-neutral-500"> ×{f.n}</span> : null}
                {n ? <span className="ml-1 text-[#53FC18]">{n > 1 || f.n > 1 ? `✓${n}` : "✓"}</span> : null}
              </button>
              {n ? (
                <button type="button" onClick={() => bump(-1)} className="border-l border-neutral-800 px-1.5 py-0.5 text-neutral-500 hover:text-neutral-200" aria-label="One fewer">
                  −
                </button>
              ) : null}
            </span>
          );
        })}
      </span>
    ) : (
      <span className="text-xs text-neutral-500">No fish.</span>
    );

  const input = "w-28 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200";
  return (
    <div className="w-full space-y-3 rounded-md border border-neutral-800 bg-neutral-950/80 p-3 text-xs text-neutral-300">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-2">
          <p className="text-neutral-400">You give</p>
          {mine === null ? <span className="text-neutral-500">Loading your fish…</span> : picker(mine, give, setGive)}
          <label className="flex items-center gap-2 text-neutral-500">
            +
            <input value={coins.give} onChange={(e) => setCoins({ ...coins, give: e.target.value })} inputMode="numeric" placeholder="0" className={input} />
            {currency} (you have {balance.toLocaleString("en-US")})
          </label>
        </div>
        <div className="space-y-2">
          <p className="text-neutral-400">You want from {target}</p>
          {picker(theirs, want, setWant)}
          <label className="flex items-center gap-2 text-neutral-500">
            +
            <input value={coins.want} onChange={(e) => setCoins({ ...coins, want: e.target.value })} inputMode="numeric" placeholder="0" className={input} />
            {currency}
          </label>
        </div>
      </div>
      <p className="text-neutral-500">
        You give about {giveWorth.toLocaleString("en-US")} {currency}, you get about {wantWorth.toLocaleString("en-US")} {currency}. You pay a trade fee if {target} accepts.
        {tooMany ? <span className="ml-1 text-red-400">That&apos;s too many fish for one trade: take a few off.</span> : null}
        {!fishOnEither && (giveCoins || wantCoins) ? <span className="ml-1 text-red-400">A trade needs a fish on one side.</span> : null}
      </p>
      {stage === "confirm" ? (
        <p className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-amber-200">
          <span className="flex-1">Offer this to @{target}? They get a ping in chat and can answer there or on the Play tab.</span>
          <button type="button" onClick={() => void send()} className="rounded-md bg-[#53FC18] px-2 py-0.5 font-medium text-black hover:brightness-110">Yes, offer</button>
          <button type="button" onClick={() => setStage("pick")} className={btn}>Back</button>
        </p>
      ) : stage === "sending" ? (
        <p className="text-neutral-400">Sending…</p>
      ) : stage === "done" ? (
        <p className="rounded-md border border-neutral-800 px-2 py-1.5 text-neutral-200">{text}</p>
      ) : text ? (
        <p className="text-red-400">{text}</p>
      ) : null}
      <span className="flex gap-2">
        {stage === "pick" ? (
          <button type="button" disabled={!ready} onClick={() => setStage("confirm")} className="rounded-md bg-[#53FC18] px-2 py-1 font-medium text-black hover:brightness-110 disabled:opacity-40">
            Offer
          </button>
        ) : null}
        <button type="button" onClick={() => { setOpen(false); setGive(new Map()); setWant(new Map()); setCoins({ give: "", want: "" }); }} className={btn}>
          {stage === "done" ? "Close" : "Cancel"}
        </button>
      </span>
    </div>
  );
}
