import "server-only";

// Which build each open overlay runs, from its polls (?v=, absent before 2026-10-17):
// one line per channel, overlay and build every ten minutes while it's behind the
// live build, so an overlay that isn't reloading itself shows up in the logs.

const logged = new Map<string, number>();
const EVERY_MS = 10 * 60_000;

export function noteOverlayBuild(channel: string, overlay: string, pageBuild: string | null): void {
  const live = process.env.DASH_BUILD_ID;
  if (!live || pageBuild === live) return;
  const was = pageBuild ?? "a build from before 2026-10-17 22:00";
  const key = `${channel}|${overlay}|${was}`;
  const now = Date.now();
  if (now - (logged.get(key) ?? 0) < EVERY_MS) return;
  logged.set(key, now);
  console.log(`[overlay] ${channel}'s ${overlay} overlay is on ${was}, not the live ${live}`);
}

const stalls = new Map<string, number>();

// A page that says it hasn't drawn for a while (?stall=<ms>, see overlay-build's
// paintStalledMs): its browser source has stopped painting it. Once a minute at most.
export function noteOverlayStall(channel: string, overlay: string, stall: string | null, hidden = false): void {
  const secs = Number(stall) / 1000;
  if (!stall || !Number.isFinite(secs) || secs < 5) return;
  const key = `${channel}|${overlay}`;
  const now = Date.now();
  if (now - (stalls.get(key) ?? 0) < 60_000) return;
  stalls.set(key, now);
  console.log(`[overlay] ${channel}'s ${overlay} overlay hasn't drawn a frame for ${Math.round(secs)}s${hidden ? " (hidden: its scene isn't showing)" : ""}`);
}

const pollers = new Map<string, number>();

// Temporary (2026-10-21): who polls an overlay's feed, once a minute per address and
// build, to tell a streaming tool's frozen browser source from a tab left open elsewhere.
export function noteOverlayPoller(channel: string, overlay: string, ip: string, ua: string, pageBuild: string | null): void {
  const key = `${channel}|${overlay}|${ip}|${pageBuild}`;
  const now = Date.now();
  if (now - (pollers.get(key) ?? 0) < 60_000) return;
  pollers.set(key, now);
  console.log(`[overlay-poll] ${channel} ${overlay} build=${pageBuild ?? "-"} ip=${ip} ua=${ua}`);
}
