"use client";

import { useState } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// A steal from the leaderboard's holdings, played by the channel's bot as in chat. Clicking
// runs the free steal check first (`fish steal check @user [fish]`): the chance and what it
// could cost, or every reason it can't go ahead. Only then is there a Steal button. A try
// that goes ahead is told in chat too, as a chat steal is.

type Reply = { text: string };

export default function StealButton({
  channel,
  target,
  aim = [],
  label,
  compact = false,
}: {
  channel: string;
  target: string;
  /** A kind and length to aim for (["🦈", "72cm"]); empty for a random fish. */
  aim?: string[];
  label: string;
  /** Just the hook, for a fish chip. */
  compact?: boolean;
}) {
  const [stage, setStage] = useState<"idle" | "checking" | "checked" | "stealing" | "done">("idle");
  const [text, setText] = useState("");
  const [canTry, setCanTry] = useState(false);

  async function play(args: string[]): Promise<string> {
    const res = await fetch(`${BASE_PATH}/api/public/${encodeURIComponent(channel)}/fish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args, requestId: crypto.randomUUID() }),
    });
    const body = (await res.json().catch(() => null)) as { replies?: Reply[]; answered?: boolean; error?: string } | null;
    if (!res.ok || !body) throw new Error(body?.error ?? `That didn't go through (${res.status})`);
    if (!body.answered) return "The bot didn't answer in time: try again in a moment.";
    return (body.replies ?? []).map((r) => r.text).join(" ");
  }

  async function check() {
    setStage("checking");
    try {
      const reply = await play(["steal", "check", `@${target}`, ...aim]);
      setText(reply);
      // The check marks a try that can go now with ✅; anything else is why it can't.
      setCanTry(reply.includes("✅"));
    } catch (e) {
      setText(e instanceof Error ? e.message : "That didn't go through");
      setCanTry(false);
    }
    setStage("checked");
  }

  async function steal() {
    setStage("stealing");
    try {
      setText(await play(["steal", `@${target}`, ...aim]));
    } catch (e) {
      setText(e instanceof Error ? e.message : "That didn't go through");
    }
    setCanTry(false);
    setStage("done");
  }

  const btn = "rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-40";
  if (stage === "idle" || stage === "checking") {
    return (
      <button type="button" disabled={stage === "checking"} onClick={() => void check()} className={btn} title={compact ? label : undefined}>
        {stage === "checking" ? "Checking…" : compact ? "🪝" : `🪝 ${label}`}
      </button>
    );
  }
  return (
    <span className="flex w-full flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200">
      <span className="min-w-0 flex-1">{text}</span>
      {stage === "checked" && canTry ? (
        <button type="button" onClick={() => void steal()} className="rounded-md bg-[#53FC18] px-2 py-0.5 font-medium text-black hover:brightness-110">
          Steal
        </button>
      ) : null}
      {stage === "stealing" ? <span className="text-neutral-400">Stealing…</span> : null}
      <button type="button" disabled={stage === "stealing"} onClick={() => { setStage("idle"); setText(""); }} className={btn}>
        {stage === "done" ? "Close" : "Cancel"}
      </button>
    </span>
  );
}
