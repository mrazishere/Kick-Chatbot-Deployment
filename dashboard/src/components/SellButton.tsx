"use client";

import { useState } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// A sale from your own row in the leaderboard's holdings, played by the bot as chat's
// `fish sell 🐟 100cm Lv10 🏅` (or `sell all junk`, `sell duplicate fish`). It asks once more, with the price, first.

export default function SellButton({ channel, words, label, worth, currency, button, question, count = 1 }: {
  channel: string;
  /** The fish as chat names it: ["🐟", "100cm", "Lv10", "🏅"], or ["🐟", "1"] for one without a length. */
  words: string[];
  label: string;
  worth: number;
  currency: string;
  /** Shown on the button instead of 💰, for a sale of several ("Sell all junk"). */
  button?: string;
  /** The confirm's question instead of "Sell your <label> for <worth>?". */
  question?: string;
  /** How many alike this line stands for (a ×2 line sells one at a time). */
  count?: number;
}) {
  const [stage, setStage] = useState<"idle" | "confirm" | "selling" | "done">("idle");
  const [text, setText] = useState("");
  // The holdings list is cached for up to a minute: a fish just sold says so here until it refreshes.
  const [sold, setSold] = useState(0);

  async function sell() {
    setStage("selling");
    try {
      const res = await fetch(`${BASE_PATH}/api/public/${encodeURIComponent(channel)}/fish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: ["sell", ...words], requestId: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { replies?: Array<{ text: string }>; answered?: boolean; error?: string } | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `That didn't go through (${res.status})`);
      const reply = body.answered ? (body.replies ?? []).map((r) => r.text).join(" ") : "The bot didn't answer in time: check again in a moment.";
      setText(reply);
      if (/^(Sold|You sold) /.test(reply)) setSold((n) => n + 1);
    } catch (e) {
      setText(e instanceof Error ? e.message : "That didn't go through");
    }
    setStage("done");
  }

  const btn = "rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40";
  // A bulk sale (button set) is always all of it.
  if (sold >= (button ? 1 : count) && stage === "idle") return <span className="text-xs text-[#53FC18]">Sold ✓</span>;
  if (stage === "idle") {
    return <button type="button" onClick={() => setStage("confirm")} className={btn} title={`Sell ${label}`}>{button ?? "💰"}</button>;
  }
  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200">
      <span className="min-w-0 flex-1">{stage === "done" ? text : question ?? `Sell your ${label} for ${worth.toLocaleString("en-US")} ${currency}?`}</span>
      {stage === "confirm" ? (
        <button type="button" onClick={() => void sell()} className="rounded-md bg-[#53FC18] px-2 py-0.5 font-medium text-black hover:brightness-110">Yes, sell</button>
      ) : null}
      {stage === "selling" ? <span className="text-neutral-400">Selling…</span> : null}
      <button type="button" disabled={stage === "selling"} onClick={() => {
          // After a bulk sale the row's other buttons are out of date: load it again.
          if (button && sold) return window.location.reload();
          setStage("idle");
          setText("");
        }} className={btn}>
        {stage === "done" ? "Close" : "Cancel"}
      </button>
    </span>
  );
}
