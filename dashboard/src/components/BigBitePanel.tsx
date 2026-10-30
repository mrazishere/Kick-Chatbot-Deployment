"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BigBiteFeed, FishReply } from "@/lib/bot-api";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** How often the page asks for the bite: quickly while one is on a line, slowly otherwise. */
const POLL_BITE_MS = 700;
const POLL_IDLE_MS = 3_000;

const OUTCOME: Record<string, (name: string, trophy: string | null, cm: number | null) => string> = {
  landed: (n, t, cm) => `🏆 ${n} reeled in a MYTHIC ${t ?? "trophy"}${cm ? ` (${cm} cm)` : ""}!`,
  snapped: (n, t) => `😱 ${n}'s ${t ?? "trophy"} thrashed free on the last pull and snapped the line!`,
  "got-away": (n) => `💨 The big one got away from ${n}.`,
  spat: (n) => `🪝 The big one spat the hook: it only bit for ${n}.`,
};

/**
 * Big bites on the leaderboard's Fishing tab (games.bigBite.onLeaderboard), as the stream
 * overlay plays them but with no stream delay: everyone sees who has one, the pull and its
 * time; the signed-in holder sees the code, as a picture, and can answer it here. Chat
 * answers still count, and snipes still go by the SNIPE OPEN line in chat.
 */
export default function BigBitePanel({ channel, me, everyMinutes, howTo }: { channel: string; me: string | null; everyMinutes: number; howTo: string | null }) {
  const api = `${BASE_PATH}/api/public/${encodeURIComponent(channel)}`;
  const [feed, setFeed] = useState<BigBiteFeed | null>(null);
  // Server time minus this browser's, so the countdown runs on the bot's clock.
  const skew = useRef(0);
  const [now, setNow] = useState(() => Date.now());
  // When this page first drew the current pull's code, for its flash.
  const [shown, setShown] = useState<{ startedAt: number; at: number } | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [replies, setReplies] = useState<FishReply[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${api}/bite`, { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as BigBiteFeed | null;
      if (!res.ok || !body) return;
      if (body.on) skew.current = body.now - Date.now();
      setFeed(body);
    } catch {
      // The next poll tries again.
    }
  }, [api]);

  const bite = feed?.on ? feed.bite : null;
  // Each poll brings a new object: the timers follow whether a bite is on, not the object.
  const biting = !!bite;
  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), biting ? POLL_BITE_MS : POLL_IDLE_MS);
    return () => clearInterval(poll);
  }, [load, biting]);

  useEffect(() => {
    if (!biting) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [biting]);

  // A new pull (or a new bite): its code is drawn afresh, and the answer box clears.
  const startedAt = bite?.startedAt ?? null;
  useEffect(() => {
    setShown(null);
    setAnswer("");
  }, [startedAt]);

  if (!feed?.on) return null;

  async function reel() {
    const code = answer.trim();
    if (!code || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${api}/fish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args: ["reel", code], requestId: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { replies?: FishReply[]; answered?: boolean; error?: string } | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `That didn't go through (${res.status})`);
      setReplies(body.answered ? (body.replies ?? []) : [{ ts: Date.now(), text: "The bot didn't answer in time: watch the bite below.", kind: "info", item: null }]);
      setAnswer("");
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through");
    } finally {
      setBusy(false);
    }
  }

  const botNow = now + skew.current;
  const card = "rounded-xl border bg-neutral-950/60 px-5 py-4";

  if (!bite) {
    const last = feed.last;
    return (
      <div className={`${card} border-neutral-800`}>
        {last ? (
          <p className={last.outcome === "landed" ? "text-[#53FC18]" : "text-neutral-200"}>{(OUTCOME[last.outcome] ?? OUTCOME["got-away"])(last.username, last.trophy, last.cm)}</p>
        ) : (
          <p className="text-sm text-neutral-400">
            🎣 Big bites play here live: about every {everyMinutes} min while the stream is on, a chatter gets something big on the line. If it&apos;s you, the code shows here
            {me ? "" : " once you're signed in"}, with no stream delay.
          </p>
        )}
        {howTo ? (
          <a href={howTo} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline">
            🎬 How to play big bites (video)
          </a>
        ) : null}
      </div>
    );
  }

  const total = Math.max(1, bite.until - bite.startedAt);
  const left = Math.max(0, bite.until - botNow);
  const secs = Math.ceil(left / 1000);
  const label = secs > 0 ? `${secs}s left` : botNow - bite.until < bite.graceMs ? "last chance!" : "time's up!";
  // From the second pull the code flashes: hidden flashMs after this page first drew it.
  const flashOver = !!bite.flashMs && !!shown && shown.startedAt === bite.startedAt && Date.now() - shown.at >= bite.flashMs;
  const showCode = !!bite.mine && !!bite.codeShowing && !flashOver;

  return (
    <div className={`${card} border-[#53FC18]/50`}>
      <p className="font-medium text-neutral-100">
        🎣 Something BIG is on <span className="text-[#53FC18]">{bite.mine ? "your" : `${bite.holder}'s`}</span> line!
        {bite.reward ? " 🎁" : ""}
      </p>
      <p className="mt-0.5 text-xs text-neutral-500">
        Pull {bite.pull}/{bite.pulls}
        {bite.snipedFrom ? ` · sniped from ${bite.snipedFrom}` : ""}
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-800">
        <div className="h-full rounded-full bg-[#53FC18] transition-[width] duration-200" style={{ width: `${Math.min(100, (left / total) * 100)}%` }} />
      </div>
      <p className="mt-1 text-right text-xs tabular-nums text-neutral-400">{label}</p>

      {bite.mine ? (
        <div className="mt-3 space-y-3">
          {showCode ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={bite.startedAt}
              src={`${api}/bite/code?c=${bite.startedAt}`}
              alt="Your reel code"
              className="h-20 w-auto rounded-md"
              onLoad={() => setShown((s) => (s && s.startedAt === bite.startedAt ? s : { startedAt: bite.startedAt, at: Date.now() }))}
            />
          ) : (
            <p className="text-sm text-neutral-400">{bite.pull > 1 ? "The code flashed and hid: type what you saw." : "Waiting for the code…"}</p>
          )}
          {bite.canAnswer ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void reel();
              }}
            >
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value.toUpperCase())}
                autoFocus
                autoComplete="off"
                maxLength={8}
                aria-label="Reel code"
                placeholder="Code"
                className="w-32 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-lg uppercase tracking-widest text-neutral-100"
              />
              <button type="submit" disabled={busy || !answer.trim()} className="rounded-md bg-[#53FC18] px-4 py-2 text-sm font-medium text-black hover:brightness-110 disabled:opacity-40">
                Reel it in
              </button>
              <span className="text-xs text-neutral-500">or in chat: ${feed.command} fish reel &lt;code&gt;</span>
            </form>
          ) : (
            <p className="text-xs text-neutral-500">Answer in chat: ${feed.command} fish reel &lt;code&gt;</p>
          )}
        </div>
      ) : (
        <p className="mt-3 text-xs text-neutral-500">Only {bite.holder} sees the code. Snipers: watch chat for the SNIPE OPEN line.</p>
      )}

      {error ? <p className="mt-2 text-sm text-red-400">{error}</p> : null}
      {replies?.length ? (
        <ul className="mt-2 space-y-1 text-sm">
          {replies.map((r, i) => (
            <li key={i} className={r.kind === "catch" ? "text-[#53FC18]" : "text-neutral-200"}>
              {r.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
