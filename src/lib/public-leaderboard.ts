import "server-only";
import { BotApiError, getPointsLeaderboard, getPublicHistory, getPublicViewers, type PublicHistory, type PublicViewer, type PointsLeaderboard, type PublicCommands, type PublicCommandRow, type PublicCommandSection, type PointsLeaderboardEntry, type PublicCatch, type PublicFishing, type PublicHeists, type PublicRareCatch } from "./bot-api";

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

/** Only what a public page may show: rank, name, value and reel. Anything else the API sends is dropped. */
function publicEntries(rows: unknown): PointsLeaderboardEntry[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 100).flatMap((row) => {
    const r = row as Partial<PointsLeaderboardEntry> | null;
    if (!r || typeof r.username !== "string" || typeof r.rank !== "number" || typeof r.value !== "number") return [];
    const reel = typeof r.reel === "string" && r.reel.length > 0 && r.reel.length <= 24 ? r.reel : undefined;
    return [reel ? { rank: r.rank, username: r.username, value: r.value, reel } : { rank: r.rank, username: r.username, value: r.value }];
  });
}

const RARITIES = new Set(["Common", "Uncommon", "Rare", "Epic", "Legendary", "Mythic", "Never"]);

/** The Fishing tab's catch table, keeping only well-formed rows. */
function publicCatches(rows: unknown): PublicCatch[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 50).flatMap((row) => {
    const r = row as Partial<PublicCatch> | null;
    if (!r || typeof r.emoji !== "string" || r.emoji.length > 8 || typeof r.chance !== "number" || typeof r.price !== "number") return [];
    if (typeof r.rarity !== "string" || !RARITIES.has(r.rarity)) return [];
    return [{ emoji: r.emoji, chance: r.chance, rarity: r.rarity, price: r.price, ...(r.trophy === true ? { trophy: true } : {}) }];
  });
}

const USERNAME = /^[A-Za-z0-9_]{1,25}$/;

/** The rarest catches, keeping only well-formed rows. */
function publicRarest(rows: unknown): PublicRareCatch[] {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 5).flatMap((row) => {
    const r = row as Partial<PublicRareCatch> | null;
    if (!r || typeof r.emoji !== "string" || r.emoji.length > 8 || typeof r.chance !== "number" || typeof r.times !== "number") return [];
    if (typeof r.rarity !== "string" || !RARITIES.has(r.rarity)) return [];
    if (typeof r.firstBy !== "string" || !USERNAME.test(r.firstBy) || typeof r.lastBy !== "string" || !USERNAME.test(r.lastBy)) return [];
    if (typeof r.firstAt !== "string" || typeof r.lastAt !== "string") return [];
    return [{
      emoji: r.emoji, chance: r.chance, rarity: r.rarity, times: r.times,
      firstBy: r.firstBy, firstAt: r.firstAt.slice(0, 40), lastBy: r.lastBy, lastAt: r.lastAt.slice(0, 40),
      ...(r.trophy === true ? { trophy: true } : {}),
    }];
  });
}

/** The heists, keeping only well-formed rows: every name a username, every number a number. */
function publicHeists(raw: unknown): PublicHeists | null {
  const h = raw as Partial<PublicHeists> | null | undefined;
  if (!h || typeof h !== "object" || !h.totals) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const name = (v: unknown) => typeof v === "string" && USERNAME.test(v);
  const fish = (v: unknown) => typeof v === "string" && v.length <= 8;
  const iso = (v: unknown) => (typeof v === "string" ? v.slice(0, 40) : "");
  const list = <T,>(rows: unknown, max: number, keep: (r: Record<string, unknown>) => T | null): T[] =>
    (Array.isArray(rows) ? rows : []).slice(0, max).flatMap((r) => {
      const out = r && typeof r === "object" ? keep(r as Record<string, unknown>) : null;
      return out ? [out] : [];
    });
  return {
    totals: { attempts: n(h.totals.attempts), stolen: n(h.totals.stolen), caught: n(h.totals.caught), guarded: n(h.totals.guarded), burned: n(h.totals.burned) },
    thieves: list(h.thieves, 5, (r) => (name(r.name) ? { name: r.name as string, stolen: n(r.stolen), attempts: n(r.attempts), loot: n(r.loot) } : null)),
    shame: list(h.shame, 5, (r) => (name(r.name) ? { name: r.name as string, caught: n(r.caught), fines: n(r.fines) } : null)),
    biggest: list(h.biggest, 3, (r) =>
      name(r.thief) && name(r.victim) && fish(r.fish)
        ? { thief: r.thief as string, victim: r.victim as string, fish: r.fish as string, cm: typeof r.cm === "number" ? r.cm : null, worth: n(r.worth), at: iso(r.at) }
        : null,
    ),
    robbed: list(h.robbed, 5, (r) => (name(r.name) ? { name: r.name as string, lost: n(r.lost), value: n(r.value) } : null)),
    fortKnox: list(h.fortKnox, 5, (r) => (name(r.name) ? { name: r.name as string, turnedAway: n(r.turnedAway) } : null)),
    blotter: list(h.blotter, 5, (r) =>
      name(r.thief) && name(r.victim) && fish(r.fish) && (r.outcome === "stolen" || r.outcome === "caught")
        ? { thief: r.thief as string, victim: r.victim as string, fish: r.fish as string, outcome: r.outcome, at: iso(r.at) }
        : null,
    ),
  };
}

function publicFishing(raw: unknown): PublicFishing | null {
  const f = raw as Partial<PublicFishing> | null | undefined;
  if (!f || typeof f.catchOdds !== "number") return null;
  const fish = publicCatches(f.fish);
  return fish.length ? { catchOdds: f.catchOdds, fish, junk: publicCatches(f.junk), rarest: publicRarest(f.rarest), steal: f.steal === true, heists: publicHeists(f.heists),
    trophies: publicCatches(f.trophies),
    bigBite: f.bigBite && typeof f.bigBite.everyMinutes === "number" ? { everyMinutes: f.bigBite.everyMinutes } : null } : null;
}

/** The command list, keeping only well-formed rows of plain, short text. */
function publicCommands(raw: unknown): PublicCommands | null {
  const c = raw as Partial<PublicCommands> | null | undefined;
  if (!c || typeof c.command !== "string" || !/^\$[a-z0-9_]{2,20}$/.test(c.command) || !Array.isArray(c.sections)) return null;
  const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null);
  const sections = c.sections.slice(0, 8).flatMap((s): PublicCommandSection[] => {
    const title = text(s?.title, 40);
    if (!title || !Array.isArray(s.rows)) return [];
    const rows = s.rows.slice(0, 40).flatMap((r): PublicCommandRow[] => {
      const usage = text(r?.usage, 80);
      const does = text(r?.does, 200);
      if (!usage || !does) return [];
      const short = text(r.short, 80);
      return [{ usage, does, ...(short ? { short } : {}), ...(r.who === "mods" || r.who === "streamer" ? { who: r.who } : {}) }];
    });
    const note = text(s.note, 300);
    return rows.length ? [{ title, rows, ...(note ? { note } : {}) }] : [];
  });
  return sections.length ? { command: c.command, sections } : null;
}

function publicShape(raw: PointsLeaderboard, channel: string): PointsLeaderboard {
  return {
    channel,
    currencyName: typeof raw.currencyName === "string" && raw.currencyName ? raw.currencyName : "Points",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    points: publicEntries(raw.points),
    watchtime: publicEntries(raw.watchtime),
    fishing: publicFishing(raw.fishing),
    commands: publicCommands(raw.commands),
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

// ─── One viewer's history ────────────────────────────────────────────────────

/** Short, since a viewer checking after a change expects to see it; a burst still shares one call. */
const HISTORY_TTL_MS = 20_000;
const MAX_HISTORIES = 500;
const historyCache = new Map<string, { at: number; data: PublicHistory }>();
const historyInFlight = new Map<string, Promise<PublicHistory>>();

export type PublicHistoryResult = { kind: "ok"; data: PublicHistory } | { kind: "not-found" } | { kind: "unavailable" };

const str = (v: unknown, max: number): string | null => (typeof v === "string" ? v.slice(0, max) : null);

/** Only the fields the page shows, whatever else the API sends. */
function publicHistoryShape(raw: PublicHistory): PublicHistory {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const entries = (rows: unknown, max: number) =>
    (Array.isArray(rows) ? rows : []).slice(0, max).map((e) => ({
      id: num(e?.id),
      ts: str(e?.ts, 40) ?? "",
      delta: num(e?.delta),
      balanceAfter: num(e?.balanceAfter),
      reason: str(e?.reason, 40) ?? "",
      actor: str(e?.actor, 80),
      note: str(e?.note, 300),
      counterparty: str(e?.counterparty, 30),
    }));
  return {
    channel: raw.channel,
    currencyName: str(raw.currencyName, 30) || "Points",
    username: str(raw.username, 30) ?? "",
    balance: num(raw.balance),
    rank: typeof raw.rank === "number" ? raw.rank : null,
    watchSeconds: num(raw.watchSeconds),
    activeTimeEarned: num(raw.activeTimeEarned),
    totals: (Array.isArray(raw.totals) ? raw.totals : []).slice(0, 60).map((t) => ({
      reason: str(t?.reason, 40) ?? "",
      total: num(t?.total),
      count: num(t?.count),
    })),
    ledgerCount: num(raw.ledgerCount),
    lifetimeEarned: num(raw.lifetimeEarned),
    isSub: raw.isSub === true,
    firstSeenAt: str(raw.firstSeenAt, 40),
    lastSeenAt: str(raw.lastSeenAt, 40),
    gamble: raw.gamble && typeof raw.gamble === "object"
      ? { gambles: num(raw.gamble.gambles), wins: num(raw.gamble.wins), staked: num(raw.gamble.staked), net: num(raw.gamble.net) }
      : null,
    ledger: entries(raw.ledger, 200),
  };
}

export async function loadPublicHistory(channel: string, name: string): Promise<PublicHistoryResult> {
  const key = `${channel}:${name.toLowerCase()}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return { kind: "ok", data: hit.data };
  let pending = historyInFlight.get(key);
  if (!pending) {
    pending = getPublicHistory(channel, name).then(publicHistoryShape).finally(() => historyInFlight.delete(key));
    historyInFlight.set(key, pending);
  }
  try {
    const data = await pending;
    historyCache.delete(key);
    historyCache.set(key, { at: Date.now(), data });
    while (historyCache.size > MAX_HISTORIES) {
      const oldest = historyCache.keys().next().value;
      if (oldest === undefined) break;
      historyCache.delete(oldest);
    }
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof BotApiError && (e.status === 404 || e.status === 400)) return { kind: "not-found" };
    console.error(`[leaderboard] history ${key} unavailable:`, e instanceof Error ? e.message : e);
    return hit ? { kind: "ok", data: hit.data } : { kind: "unavailable" };
  }
}

// ─── The viewer list and search ──────────────────────────────────────────────

const viewerCache = new Map<string, { at: number; data: PublicViewer[] }>();

export type PublicViewersResult = { kind: "ok"; viewers: PublicViewer[] } | { kind: "not-found" } | { kind: "unavailable" };

export async function loadPublicViewers(channel: string, q: string): Promise<PublicViewersResult> {
  const key = `${channel}:${q.toLowerCase()}`;
  const hit = viewerCache.get(key);
  if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return { kind: "ok", viewers: hit.data };
  try {
    const raw = await getPublicViewers(channel, q);
    const viewers = (Array.isArray(raw.viewers) ? raw.viewers : []).slice(0, 100).flatMap((v) => {
      if (!v || typeof v.username !== "string" || typeof v.balance !== "number") return [];
      const row: PublicViewer = {
        rank: typeof v.rank === "number" ? v.rank : null,
        username: v.username.slice(0, 30),
        balance: v.balance,
        watchSeconds: typeof v.watchSeconds === "number" ? v.watchSeconds : 0,
      };
      if (typeof v.reel === "string" && v.reel.length <= 24) row.reel = v.reel;
      return [row];
    });
    viewerCache.delete(key);
    viewerCache.set(key, { at: Date.now(), data: viewers });
    while (viewerCache.size > MAX_HISTORIES) {
      const oldest = viewerCache.keys().next().value;
      if (oldest === undefined) break;
      viewerCache.delete(oldest);
    }
    return { kind: "ok", viewers };
  } catch (e) {
    if (e instanceof BotApiError && (e.status === 404 || e.status === 400)) return { kind: "not-found" };
    console.error(`[leaderboard] viewers ${key} unavailable:`, e instanceof Error ? e.message : e);
    return hit ? { kind: "ok", viewers: hit.data } : { kind: "unavailable" };
  }
}
