import "server-only";
import crypto from "crypto";
import { BotApiError, getFishOverlay, type FishDuel, type FishDuelSide, type FishOverlayEvent, type FishOverlayFeed, type FishOverlayWheel, type WheelItem } from "./bot-api";

/**
 * The fishing overlay: a browser source a streamer adds to OBS. Its URL carries a
 * key derived from the internal secret, so nothing new is stored and the page
 * can't be found by guessing the channel. Changing INTERNAL_API_SECRET changes
 * every key. Each look has its own key: the fishing scene, or the earlier text cards.
 */
export type OverlayStyle = "scene" | "cards";

export function overlayKey(channel: string, style: OverlayStyle = "scene"): string | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return null;
  const label = style === "scene" ? `fish-overlay:${channel}` : `fish-overlay-${style}:${channel}`;
  return crypto.createHmac("sha256", secret).update(label).digest("base64url").slice(0, 24);
}

/** Which style a key opens, or null when it's no key for this channel. */
export function overlayStyleFor(channel: string, key: string | null | undefined): OverlayStyle | null {
  if (typeof key !== "string") return null;
  for (const style of ["scene", "cards"] as const) {
    const want = overlayKey(channel, style);
    if (want && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want))) return style;
  }
  return null;
}

export function validOverlayKey(channel: string, key: string | null | undefined): boolean {
  return overlayStyleFor(channel, key) !== null;
}

/** A channel's overlay links, one per look, for the bot page. Empty without the secret. */
export function overlayLinks(channel: string): OverlayLink[] {
  const base = (process.env.NEXT_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const looks: Array<{ style: OverlayStyle; label: string; hint: string }> = [
    { style: "scene", label: "Fishing scene", hint: "An animated strip of water: casts, catches, trap hauls and steals. About 1920×260 along the bottom, at the source's full size." },
    { style: "cards", label: "Text cards", hint: "Each cast result, trap haul and steal as a card stacked in a corner. About 800×600, at the source's full size." },
  ];
  return looks.flatMap(({ style, label, hint }) => {
    const key = overlayKey(channel, style);
    return key ? [{ label, hint, url: `${base}/${channel}/overlay/fishing?key=${key}` }] : [];
  });
}

export interface OverlayLink {
  label: string;
  hint: string;
  url: string;
}

/**
 * Every open overlay polls twice a second; one call to the bot per 400ms per
 * channel serves them all.
 */
const TTL_MS = 400;
const cache = new Map<string, { at: number; data: FishOverlayFeed }>();
const inFlight = new Map<string, Promise<FishOverlayFeed>>();

const KINDS = new Set(["catch", "trap", "miss", "steal", "caught", "bite", "duel", "wheel", "info"]);

/** A wheel spin as the bot sent it, checked: 2–30 slices with short labels and #rrggbb colours, a winner among them. */
function wheelOf(raw: unknown): FishOverlayWheel | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (!Array.isArray(w.items) || w.items.length < 2 || w.items.length > 30) return null;
  const items: WheelItem[] = [];
  for (const it of w.items) {
    const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
    if (typeof o.label !== "string" || !o.label.trim() || o.label.length > 40) return null;
    items.push({ label: o.label.slice(0, 30), ...(typeof o.color === "string" && /^#[0-9a-f]{6}$/i.test(o.color) ? { color: o.color } : {}) });
  }
  const winner = w.winner;
  const spinMs = w.spinMs;
  if (!Number.isInteger(winner) || (winner as number) < 0 || (winner as number) >= items.length) return null;
  if (typeof spinMs !== "number" || spinMs < 1_000 || spinMs > 30_000) return null;
  return { items, winner: winner as number, spinMs };
}
const DUEL_TYPES = new Set(["Predator", "Swift", "Armored"]);

/** A duel as the bot sent it, checked field by field; null when anything is off, and the event is dropped. */
function duelOf(raw: unknown): FishDuel | null {
  if (!raw || typeof raw !== "object") return null;
  const d = raw as Record<string, unknown>;
  const side = (v: unknown): FishDuelSide | null => {
    if (!v || typeof v !== "object") return null;
    const s = v as Record<string, unknown>;
    if (typeof s.user !== "string" || !s.user || typeof s.fish !== "string" || !s.fish || s.fish.length > 25) return null;
    if (typeof s.type !== "string" || !DUEL_TYPES.has(s.type) || typeof s.rarity !== "string" || s.rarity.length > 12) return null;
    if (typeof s.hp !== "number" || !Number.isInteger(s.hp) || s.hp < 1 || s.hp > 10_000) return null;
    const cm = typeof s.cm === "number" && s.cm >= 1 && s.cm <= 1000 ? Math.round(s.cm) : null;
    return { user: s.user.slice(0, 30), fish: s.fish, cm, type: s.type as FishDuelSide["type"], rarity: s.rarity, hp: s.hp };
  };
  const a = side(d.a);
  const b = side(d.b);
  // A team battle (2v2, 3v3): each side's fish in order, a and b the first of each. Up to 40 turns a pairing.
  let teams: [FishDuelSide[], FishDuelSide[]] | undefined;
  if (d.teams !== undefined) {
    if (!Array.isArray(d.teams) || d.teams.length !== 2) return null;
    const t = d.teams.map((list) => (Array.isArray(list) && list.length >= 1 && list.length <= 3 ? list.map(side) : null));
    if (!t[0] || !t[1] || t[0].length !== t[1].length || t[0].some((x) => !x) || t[1].some((x) => !x)) return null;
    teams = [t[0] as FishDuelSide[], t[1] as FishDuelSide[]];
  }
  const maxTurns = 40 * (teams ? teams[0].length : 1);
  if (!a || !b || (d.winner !== 0 && d.winner !== 1) || !Array.isArray(d.turns) || d.turns.length < 1 || d.turns.length > Math.max(60, maxTurns)) return null;
  const turns: FishDuel["turns"] = [];
  for (const t of d.turns) {
    if (!Array.isArray(t) || (t[0] !== 0 && t[0] !== 1) || typeof t[1] !== "number" || !Number.isInteger(t[1]) || t[1] < 0 || t[1] > 10_000) return null;
    if ((t[2] !== 0 && t[2] !== 1 && t[2] !== 2) || (t[3] !== 1 && t[3] !== 0 && t[3] !== -1)) return null;
    turns.push([t[0], t[1], t[2], t[3]]);
  }
  const stake = d.stake === "wager" || d.stake === "keeps" ? d.stake : "friendly";
  return {
    a, b, ...(teams ? { teams } : {}), turns, winner: d.winner, stake,
    ...(stake === "wager" && typeof d.amount === "number" && d.amount > 0 ? { amount: Math.round(d.amount) } : {}),
    ...(typeof d.currency === "string" && d.currency.length <= 24 ? { currency: d.currency } : {}),
  };
}

/** The corner to keep clear as the bot sent it, or null when there is none or it's off. */
function clearOf(raw: unknown): { w: number; h: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const { w, h } = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === "number" && v > 0 && v <= 80;
  return ok(w) && ok(h) ? { w, h } : null;
}

function shape(raw: FishOverlayFeed): FishOverlayFeed {
  const events = (Array.isArray(raw.events) ? raw.events : []).slice(-50).flatMap((e): FishOverlayEvent[] => {
    if (!e || typeof e.id !== "number" || typeof e.ts !== "number" || typeof e.username !== "string" || typeof e.text !== "string") return [];
    if (!KINDS.has(e.kind)) return [];
    const duel = e.kind === "duel" ? duelOf(e.duel) : null;
    if (e.kind === "duel" && !duel) return [];
    const wheel = e.kind === "wheel" ? wheelOf(e.wheel) : null;
    if (e.kind === "wheel" && !wheel) return [];
    const emotes: Record<string, string> = {};
    for (const [name, url] of Object.entries(e.emotes ?? {})) {
      if (typeof url === "string" && /^https:\/\/(files\.kick\.com|cdn\.7tv\.app)\//.test(url) && name.length <= 40) emotes[name] = url;
    }
    return [{
      id: e.id,
      ts: e.ts,
      username: e.username.slice(0, 30),
      kind: e.kind,
      text: e.text.slice(0, 500),
      ...(typeof e.item === "string" && e.item.length <= 25 ? { item: e.item } : {}),
      ...(typeof e.rarity === "string" && e.rarity.length <= 12 ? { rarity: e.rarity } : {}),
      ...(e.kind === "bite" && (typeof e.code === "string" || typeof e.code === "number") && /^[A-Z0-9]{1,8}$/.test(String(e.code)) ? { code: String(e.code) } : {}),
      ...(e.kind === "bite" && typeof e.flashMs === "number" && e.flashMs > 0 ? { flashMs: Math.min(60_000, e.flashMs) } : {}),
      ...(e.kind === "bite" && typeof e.until === "number" ? { until: e.until } : {}),
      ...(e.kind === "bite" && typeof e.snipeAt === "number" ? { snipeAt: e.snipeAt } : {}),
      ...(e.kind === "bite" && Number.isInteger(e.pull) && Number.isInteger(e.pulls) && e.pulls! <= 9 ? { pull: e.pull, pulls: e.pulls } : {}),
      ...(Object.keys(emotes).length ? { emotes } : {}),
      ...(duel ? { duel } : {}),
      ...(wheel ? { wheel } : {}),
    }];
  });
  return { lastId: typeof raw.lastId === "number" ? raw.lastId : 0, events, ...(typeof raw.now === "number" ? { now: raw.now } : {}), ...(raw.demo === false ? { demo: false } : {}),
    ...(typeof raw.size === "number" && raw.size >= 50 && raw.size <= 300 && raw.size !== 100 ? { size: raw.size } : {}),
    ...(clearOf(raw.clear) ? { clear: clearOf(raw.clear)! } : {}),
    ...(typeof raw.leadMs === "number" && raw.leadMs > 0 && raw.leadMs <= 30_000 ? { leadMs: raw.leadMs } : {}),
    ...(typeof raw.graceMs === "number" && raw.graceMs > 0 && raw.graceMs <= 30_000 ? { graceMs: raw.graceMs } : {}) };
}

export type OverlayResult = { kind: "ok"; data: FishOverlayFeed } | { kind: "not-found" } | { kind: "unavailable" };

export async function loadFishOverlay(channel: string): Promise<OverlayResult> {
  const hit = cache.get(channel);
  // A cached answer's clock moves on with the time it sat in the cache.
  const aged = (h: { at: number; data: FishOverlayFeed }): FishOverlayFeed =>
    h.data.now === undefined ? h.data : { ...h.data, now: h.data.now + (Date.now() - h.at) };
  if (hit && Date.now() - hit.at < TTL_MS) return { kind: "ok", data: aged(hit) };
  let pending = inFlight.get(channel);
  if (!pending) {
    pending = getFishOverlay(channel).then(shape).finally(() => inFlight.delete(channel));
    inFlight.set(channel, pending);
  }
  try {
    const data = await pending;
    cache.set(channel, { at: Date.now(), data });
    return { kind: "ok", data };
  } catch (e) {
    if (e instanceof BotApiError && e.status === 404) return { kind: "not-found" };
    return { kind: "unavailable" };
  }
}
