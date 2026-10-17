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

/** The URL the page was opened with, before a page takes its key out of the address bar. */
let openedAt: string | null = null;

/** Call before changing the address bar: a reload goes back to this URL, key and all. */
export function rememberUrl(): void {
  if (openedAt === null && typeof window !== "undefined") openedAt = window.location.href;
}

/** Which build a reload was last made for: in storage, or (where a browser source has none) on the URL. */
function reloadedFor(): string | null {
  const s = store();
  const kept = s?.getItem(RELOADED_FOR);
  if (kept) return kept;
  try {
    return new URL(openedAt ?? window.location.href).searchParams.get("r");
  } catch {
    return null;
  }
}

/** The poll URL with this page's build on it, so the feed can tell (and log) an overlay left on an old build. */
export function withBuild(url: string): string {
  return BUILD_ID ? `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(BUILD_ID)}` : url;
}

/** Whether the feed is served by a newer build than this page's. */
export function isStale(feedBuild: unknown): boolean {
  if (!BUILD_ID || typeof feedBuild !== "string" || !feedBuild || feedBuild === BUILD_ID) return false;
  // Reloaded for this build already and still stale (a cached page?): don't loop.
  return reloadedFor() !== feedBuild;
}

/**
 * Reload into the feed's build, resuming the feed after `cursor`. Where there's no
 * storage (some browser sources), the build goes on the URL instead, as the loop guard,
 * and the feed starts from the live end.
 */
export function reloadInto(feedBuild: string, feedKey: string, cursor: number): void {
  const s = store();
  const to = new URL(openedAt ?? window.location.href);
  if (s) {
    s.setItem(RELOADED_FOR, feedBuild);
    s.setItem(CURSOR, JSON.stringify({ feedKey, cursor, at: Date.now() }));
    to.searchParams.delete("r");
  } else {
    to.searchParams.set("r", feedBuild);
  }
  window.location.replace(to.toString());
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
