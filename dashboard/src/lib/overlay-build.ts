"use client";

// A browser source in OBS stays open for weeks, running the page code it first
// loaded. Each feed answer names the dashboard build serving it; when that isn't
// the build this page came from, the overlay reloads itself, once it's idle.
// Where the feed had got to is kept across the reload, so nothing is skipped.

const BUILD_ID = process.env.DASH_BUILD_ID ?? "";
const RELOADED_FOR = "overlay-reloaded-for";
const CURSOR = "overlay-cursor";
/** A saved cursor older than this is stale: start from the live end as usual. */
const CURSOR_MAX_AGE_MS = 60_000;

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Whether the feed is served by a newer build than this page's. */
export function isStale(feedBuild: unknown): boolean {
  if (!BUILD_ID || typeof feedBuild !== "string" || !feedBuild || feedBuild === BUILD_ID) return false;
  // Reloaded for this build already and still stale (a cached page?): don't loop.
  return store()?.getItem(RELOADED_FOR) !== feedBuild;
}

/** Reload into the feed's build, resuming the feed after `cursor`. */
export function reloadInto(feedBuild: string, feedKey: string, cursor: number): void {
  const s = store();
  if (!s) return; // without storage a reload could loop and would lose the cursor
  s.setItem(RELOADED_FOR, feedBuild);
  s.setItem(CURSOR, JSON.stringify({ feedKey, cursor, at: Date.now() }));
  window.location.reload();
}

/** The cursor saved by a reload into this build, once; null to start from the live end. */
export function takeCursor(feedKey: string): number | null {
  const s = store();
  const raw = s?.getItem(CURSOR);
  if (!raw) return null;
  s!.removeItem(CURSOR);
  try {
    const c = JSON.parse(raw) as { feedKey?: unknown; cursor?: unknown; at?: unknown };
    if (c.feedKey !== feedKey || typeof c.cursor !== "number" || typeof c.at !== "number") return null;
    return Date.now() - c.at <= CURSOR_MAX_AGE_MS ? c.cursor : null;
  } catch {
    return null;
  }
}
