import "server-only";
import crypto from "crypto";
import type { OverlayLink } from "./fish-overlay";

/**
 * The media share phone player: a page the streamer keeps open on a phone (in a split
 * screen, say) that plays the channel's StreamElements media share queue, in place of an
 * app's player, and that the video overlay follows exactly. Its own key, from the internal
 * secret like the overlays', since it can skip and pause the queue.
 */
export function mediaPlayerKey(channel: string): string | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`media-player:${channel}`).digest("base64url").slice(0, 24);
}

export function validMediaPlayerKey(channel: string, key: string | null | undefined): boolean {
  const want = mediaPlayerKey(channel);
  return !!want && typeof key === "string" && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
}

/** The channel's phone player link, for the bot page. Empty without the secret. */
export function mediaPlayerLinks(channel: string): OverlayLink[] {
  const base = (process.env.NEXT_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const key = mediaPlayerKey(channel);
  return key
    // No hint: the box it's shown in (PointsCard) says what it is.
    ? [{ label: "Phone player", hint: "", url: `${base}/${channel}/player?key=${key}` }]
    : [];
}
