"use client";

import { useEffect, useState } from "react";

// The overlays count a big bite down on the bot's clock, not the viewer's machine:
// each poll of the feed carries the bot's time, and the difference is kept here.
//
// The overlay is drawn into the stream, so viewers see each frame the stream's delay
// late. The feed's leadMs (games.streamDelaySeconds) runs this clock that far ahead:
// what a frame shows is what holds on the bot when viewers see it.

let offset = 0;
let lead = 0;
let grace = 0;

/** Note the bot's clock, how far ahead to run it, and how long answers count past a deadline, from a feed answer. */
export function syncClock(botNow: unknown, leadMs?: unknown, graceMs?: unknown): void {
  if (typeof botNow === "number" && Number.isFinite(botNow)) offset = botNow - Date.now();
  lead = typeof leadMs === "number" && Number.isFinite(leadMs) && leadMs > 0 ? Math.min(leadMs, 30_000) : 0;
  grace = typeof graceMs === "number" && Number.isFinite(graceMs) && graceMs > 0 ? Math.min(graceMs, 30_000) : 0;
}

/** The bot's time as viewers will see this frame: its clock now, plus the stream's delay. */
export const botNow = (): number => Date.now() + offset + lead;

/**
 * Whether a flashing code has gone dark: `flashMs` after this viewer's overlay first
 * drew it, so a late poll doesn't eat into it. Re-evaluated on each countdown tick.
 */
export function useCodeHidden(flashMs: number | undefined): boolean {
  const [shownAt] = useState(() => Date.now());
  return flashMs !== undefined && Date.now() - shownAt >= flashMs;
}

/** Whether a big bite's first code has opened to snipers by the time viewers see this frame. Re-evaluated on each countdown tick. */
export const snipeIsOpen = (snipeAt: number | undefined): boolean => snipeAt !== undefined && botNow() >= snipeAt;

/** Time left to a big bite's deadline, ticking a few times a second. `total` is the whole window. */
export function useCountdown(until: number | undefined, total: number): { left: number; frac: number; secs: number; label: string } {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 250);
    return () => clearInterval(t);
  }, []);
  // Without a deadline (the demo), count the window from now.
  const [start] = useState(() => botNow());
  const end = until ?? start + total;
  const now = botNow();
  const left = Math.max(0, end - now);
  const secs = Math.ceil(left / 1000);
  // Past the deadline the bot still takes answers for its grace (the feed's graceMs): say so, not "time's up".
  const label = secs > 0 ? `${secs}s left` : now - end < grace ? "last chance!" : "time's up!";
  return { left, frac: total > 0 ? Math.min(1, left / total) : 0, secs, label };
}
