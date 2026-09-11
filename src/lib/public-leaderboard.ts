import "server-only";
import { BotApiError, getPointsLeaderboard, type PointsLeaderboard, type PointsLeaderboardEntry } from "./bot-api";

/**
 * The public leaderboard page is the one page anyone can open signed out, so it
 * must not let a crawler or a refresh loop drive the bot service. Answers are kept
 * for a minute per channel, and a burst of requests shares one call.
 */
const TTL_MS = 60_000;
const MAX_CHANNELS = 100;

const cache = new Map<string, { at: number; data: PointsLeaderboard }>();
const inFlight = new Map<string, Promise<PointsLeaderboard>>();

export type PublicLeaderboardResult =
  | { kind: "ok"; data: PointsLeaderboard; /** Last good copy, served because the bot service is unreachable. */ stale: boolean }
  | { kind: "not-found" }
  | { kind: "unavailable" };

function remember(channel: string, data: PointsLeaderboard): void {
  cache.delete(channel); // re-inserted at the end, so the oldest entry is evicted first
  cache.set(channel, { at: Date.now(), data });
  while (cache.size > MAX_CHANNELS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Only what a public page may show: rank, name, value. Anything else the API sends is dropped. */
function publicEntries(rows: unknown): PointsLeaderboardEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).flatMap((row) => {
    const r = row as Partial<PointsLeaderboardEntry> | null;
    if (!r || typeof r.username !== "string" || typeof r.rank !== "number" || typeof r.value !== "number") return [];
    return [{ rank: r.rank, username: r.username, value: r.value }];
  });
}

function publicShape(raw: PointsLeaderboard, channel: string): PointsLeaderboard {
  return {
    channel,
    currencyName: typeof raw.currencyName === "string" && raw.currencyName ? raw.currencyName : "Points",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    points: publicEntries(raw.points),
    watchtime: publicEntries(raw.watchtime),
  };
}

export async function loadPublicLeaderboard(channel: string): Promise<PublicLeaderboardResult> {
  const hit = cache.get(channel);
  if (hit && Date.now() - hit.at < TTL_MS) return { kind: "ok", data: hit.data, stale: false };

  let pending = inFlight.get(channel);
  if (!pending) {
    pending = getPointsLeaderboard(channel)
      .then((raw) => publicShape(raw, channel))
      .finally(() => inFlight.delete(channel));
    inFlight.set(channel, pending);
  }

  try {
    const data = await pending;
    remember(channel, data);
    return { kind: "ok", data, stale: false };
  } catch (e) {
    // Not enrolled, points off, or the page switched off: the page doesn't exist.
    if (e instanceof BotApiError && e.status === 404) {
      cache.delete(channel);
      return { kind: "not-found" };
    }
    console.error(`[leaderboard] ${channel} unavailable:`, e instanceof Error ? e.message : e);
    return hit ? { kind: "ok", data: hit.data, stale: true } : { kind: "unavailable" };
  }
}
