import "server-only";

// What each open fishing overlay page says about drawing (?p, ?painted, ?stall on its polls),
// summed up per channel for the bot: the newest reply drawn, and the shortest time without a
// frame. A streaming tool's source (OBS in the user agent) is what viewers see, so while one is
// polling only those count: a healthy tab left open elsewhere can't cover for a frozen source.

interface Report {
  at: number;
  painted: number;
  stall: number;
  hidden: boolean;
  obs: boolean;
}

/** A page that hasn't polled for this long is closed. */
const FRESH_MS = 15_000;
const pages = new Map<string, Map<string, Report>>();

export function noteOverlayHealth(channel: string, query: URLSearchParams, ua: string): void {
  const page = query.get("p");
  const painted = Number(query.get("painted"));
  const stall = Number(query.get("stall"));
  if (!page || !/^[a-z0-9]{1,16}$/.test(page) || !Number.isInteger(painted) || painted < 0 || !Number.isFinite(stall) || stall < 0) return;
  let open = pages.get(channel);
  if (!open) pages.set(channel, (open = new Map()));
  open.set(page, { at: Date.now(), painted, stall: Math.floor(stall), hidden: query.get("h") === "1", obs: /\bOBS\//.test(ua) });
}

/** The channel's summed-up report, or null when no reporting page is open. Hidden only when every counted page is. */
export function overlayHealthFor(channel: string): { painted: number; stall: number; hidden: boolean } | null {
  const open = pages.get(channel);
  if (!open) return null;
  const now = Date.now();
  for (const [page, r] of open) if (now - r.at >= FRESH_MS) open.delete(page);
  const all = [...open.values()];
  const counted = all.some((r) => r.obs) ? all.filter((r) => r.obs) : all;
  if (!counted.length) return null;
  const shown = counted.filter((r) => !r.hidden);
  const stalls = (shown.length ? shown : counted).map((r) => r.stall);
  return { painted: Math.max(...counted.map((r) => r.painted)), stall: Math.min(...stalls), hidden: !shown.length };
}
