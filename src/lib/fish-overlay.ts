import "server-only";
import crypto from "crypto";
import { BotApiError, getFishOverlay, type FishOverlayEvent, type FishOverlayFeed } from "./bot-api";

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
    { style: "scene", label: "Fishing scene", hint: "An animated strip of water: casts, catches, trap hauls and steals. About 1920×260 along the bottom." },
    { style: "cards", label: "Text cards", hint: "Each cast result, trap haul and steal as a card stacked in a corner. About 800×600." },
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
 * Every open overlay polls every couple of seconds; one call to the bot a second
 * per channel serves them all.
 */
const TTL_MS = 1_000;
const cache = new Map<string, { at: number; data: FishOverlayFeed }>();
const inFlight = new Map<string, Promise<FishOverlayFeed>>();

const KINDS = new Set(["catch", "trap", "miss", "steal", "caught", "bite", "info"]);

function shape(raw: FishOverlayFeed): FishOverlayFeed {
  const events = (Array.isArray(raw.events) ? raw.events : []).slice(-50).flatMap((e): FishOverlayEvent[] => {
    if (!e || typeof e.id !== "number" || typeof e.ts !== "number" || typeof e.username !== "string" || typeof e.text !== "string") return [];
    if (!KINDS.has(e.kind)) return [];
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
      ...(typeof e.item === "string" && e.item.length <= 8 ? { item: e.item } : {}),
      ...(typeof e.rarity === "string" && e.rarity.length <= 12 ? { rarity: e.rarity } : {}),
      ...(e.kind === "bite" && (typeof e.code === "string" || typeof e.code === "number") && /^[A-Z0-9]{1,8}$/.test(String(e.code)) ? { code: String(e.code) } : {}),
      ...(e.kind === "bite" && typeof e.flashMs === "number" && e.flashMs > 0 ? { flashMs: Math.min(60_000, e.flashMs) } : {}),
      ...(e.kind === "bite" && typeof e.until === "number" ? { until: e.until } : {}),
      ...(e.kind === "bite" && Number.isInteger(e.pull) && Number.isInteger(e.pulls) && e.pulls! <= 9 ? { pull: e.pull, pulls: e.pulls } : {}),
      ...(Object.keys(emotes).length ? { emotes } : {}),
    }];
  });
  return { lastId: typeof raw.lastId === "number" ? raw.lastId : 0, events, ...(typeof raw.now === "number" ? { now: raw.now } : {}), ...(raw.demo === false ? { demo: false } : {}) };
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
