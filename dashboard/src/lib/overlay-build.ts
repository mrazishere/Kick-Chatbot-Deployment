"use client";

import { useEffect } from "react";

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

/**
 * The poll URL with this page's build on it, so the feed can tell (and log) an overlay left on
 * an old build. A page that reports drawing (usePaintReport) also says which page it is (p), the
 * newest reply it has drawn (painted), how long since its last frame (stall, ms; since it loaded
 * where it never drew) and whether it's hidden (h=1, a source on a scene that isn't showing): the
 * bot reloads a visible page that isn't drawing, and pauses big bites while none is drawing.
 */
export function withBuild(url: string): string {
  const q: string[] = [];
  if (BUILD_ID) q.push(`v=${encodeURIComponent(BUILD_ID)}`);
  const stall = Math.floor(paintStalledMs());
  if (reportsPaint) q.push(`p=${PAGE_ID}`, `painted=${painted}`, `stall=${stall}`);
  if (reportsPaint && pageHidden()) q.push("h=1");
  return q.length ? `${url}${url.includes("?") ? "&" : "?"}${q.join("&")}` : url;
}

const pageHidden = (): boolean => typeof document !== "undefined" && document.visibilityState !== "visible";

const PAGE_ID = Math.random().toString(36).slice(2, 10);
let reportsPaint = false;
let painted = 0;

/**
 * After each render, once two frames have really been drawn, the newest feed id on screen
 * counts as drawn. A browser source that has stopped drawing never gets there.
 */
export function usePaintReport(onScreen: number[]): void {
  reportsPaint = true;
  useEffect(() => {
    const newest = Math.max(0, ...onScreen);
    if (newest <= painted) return;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (newest > painted) painted = newest;
    }));
  });
}

/**
 * The feed's reload token ($cmd fish overlay reload, or the bot after a code went undrawn):
 * the first one a page sees is where it starts; a different one later means reload now.
 */
let reloadSeen: number | null = null;
export function reloadAsked(token: unknown): boolean {
  if (typeof token !== "number") return false;
  if (reloadSeen === null) reloadSeen = token;
  return token !== reloadSeen;
}

/** Where this page started on the feed: a reload never replays from before it. */
let feedStart: number | null = null;
export function noteFeedStart(id: number): void {
  feedStart ??= id;
}

/**
 * Where a reload of a page that may not have been drawing picks up: after the newest reply it
 * actually drew, so what viewers never saw (a big bite's code) shows again; never before where it started.
 */
function resumeFrom(cursor: number | null): number | null {
  if (cursor === null || !reportsPaint) return cursor;
  return Math.min(cursor, Math.max(painted, feedStart ?? cursor));
}

/** Reload the same build now, resuming the feed after what it last drew. */
export function reloadNow(feedKey: string, cursor: number | null): void {
  const from = resumeFrom(cursor);
  go(openedAt ?? window.location.href, () => {
    if (from !== null) store()?.setItem(CURSOR, JSON.stringify({ feedKey, cursor: from, at: Date.now() }));
  });
}

/**
 * Navigate, but only once the page answers: a reload that hits a network blip would leave the
 * source on the browser's error page, with none of this code left to bring it back.
 */
let going = false;
function go(to: string, before?: () => void): void {
  if (going) return;
  going = true;
  fetch(to, { cache: "no-store" })
    .then((res) => {
      if (!res.ok) throw new Error(String(res.status));
      before?.(); // what the reload carries (cursor, loop guards), only once it's really going
      window.location.replace(to);
    })
    .catch(() => {
      going = false; // the next poll asks again
    });
}

// A browser source left open for hours: sukasblood's froze about 2.5 hours into a page on
// 2026-10-21. A page this old reloads itself the next time nothing is on it, which viewers
// can't see (it's transparent), so no page is ever that old.
const FRESH_MS = 30 * 60_000;
const loadedAt = typeof performance !== "undefined" ? performance.now() : 0;

/** Whether this page is old enough for a fresh copy; reload only while nothing is on screen. */
export const freshReloadDue = (): boolean => performance.now() - loadedAt >= FRESH_MS;

/** Reload the same build while idle, carrying on right after `cursor` (everything up to it was shown). */
export function reloadFresh(feedKey: string, cursor: number | null): void {
  go(openedAt ?? window.location.href, () => {
    if (cursor !== null) store()?.setItem(CURSOR, JSON.stringify({ feedKey, cursor, at: Date.now() }));
  });
}

/** A page on an old build waits this long at most for a quiet moment before reloading into the new one anyway. */
export const STALE_WAIT_MS = 2 * 60_000;

// A streaming tool's browser source can stop drawing the page while its code runs on:
// sukasblood's cloud OBS froze a card half faded for 40s on 2026-10-21, then drew
// nothing at all. Frames are counted here; a page that's visible but hasn't drawn
// for STALL_MS (since it loaded, where it never has) reloads itself, at most once
// every STALL_GAP_MS. The bot asks too, more often, while the stream is live.
const STALL_MS = 20_000;
const STALL_GAP_MS = 5 * 60_000;
const STALL_RELOADED_AT = "overlay-stall-reloaded-at";
let lastFrame = 0;

function watchPaint(): void {
  if (lastFrame || typeof window === "undefined") return;
  lastFrame = performance.now();
  const frame = () => {
    lastFrame = performance.now();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** How long the page has gone without drawing a frame, hidden or not: either way viewers don't see it change. */
export function paintStalledMs(): number {
  watchPaint();
  return typeof window === "undefined" ? 0 : performance.now() - lastFrame;
}

/**
 * Whether the page has stopped drawing long enough to reload, and hasn't reloaded for that lately.
 * Only while visible: a hidden page (a tab in the background, a source off the scene) doesn't draw anyway.
 */
export function paintStalled(): boolean {
  if (typeof document === "undefined" || pageHidden() || paintStalledMs() < STALL_MS) return false;
  let at: string | null | undefined = store()?.getItem(STALL_RELOADED_AT);
  if (!at) {
    try {
      at = new URL(openedAt ?? window.location.href).searchParams.get("s");
    } catch {
      at = null;
    }
  }
  return !at || Date.now() - Number(at) >= STALL_GAP_MS;
}

/** Reload the same build, resuming the feed after `cursor`, to get the page drawing again. */
export function reloadAfterStall(feedKey: string, cursor: number): void {
  const s = store();
  const to = new URL(openedAt ?? window.location.href);
  const now = String(Date.now());
  if (s) to.searchParams.delete("s");
  else to.searchParams.set("s", now);
  go(to.toString(), () => {
    s?.setItem(STALL_RELOADED_AT, now);
    s?.setItem(CURSOR, JSON.stringify({ feedKey, cursor: resumeFrom(cursor), at: Date.now() }));
  });
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
  if (s) to.searchParams.delete("r");
  else to.searchParams.set("r", feedBuild);
  go(to.toString(), () => {
    s?.setItem(RELOADED_FOR, feedBuild);
    s?.setItem(CURSOR, JSON.stringify({ feedKey, cursor, at: Date.now() }));
  });
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
