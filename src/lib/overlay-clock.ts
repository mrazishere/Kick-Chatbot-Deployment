"use client";

import { useEffect, useState } from "react";

// The overlays count a big bite down on the bot's clock, not the viewer's machine:
// each poll of the feed carries the bot's time, and the difference is kept here.

let offset = 0;

/** Note the bot's clock from a feed answer. */
export function syncClock(botNow: unknown): void {
  if (typeof botNow === "number" && Number.isFinite(botNow)) offset = botNow - Date.now();
}

/** The bot's time now, as best known. */
export const botNow = (): number => Date.now() + offset;

/**
 * Whether a flashing code has gone dark: `flashMs` after this viewer's overlay first
 * drew it, so a late poll doesn't eat into it. Re-evaluated on each countdown tick.
 */
export function useCodeHidden(flashMs: number | undefined): boolean {
  const [shownAt] = useState(() => Date.now());
  return flashMs !== undefined && Date.now() - shownAt >= flashMs;
}

/** Time left to a big bite's deadline, ticking a few times a second. `total` is the whole window. */
export function useCountdown(until: number | undefined, total: number): { left: number; frac: number; secs: number } {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((v) => v + 1), 250);
    return () => clearInterval(t);
  }, []);
  // Without a deadline (the demo), count the window from now.
  const [start] = useState(() => botNow());
  const end = until ?? start + total;
  const left = Math.max(0, end - botNow());
  return { left, frac: total > 0 ? Math.min(1, left / total) : 0, secs: Math.ceil(left / 1000) };
}
