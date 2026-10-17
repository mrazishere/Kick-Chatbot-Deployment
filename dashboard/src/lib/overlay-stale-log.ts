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
