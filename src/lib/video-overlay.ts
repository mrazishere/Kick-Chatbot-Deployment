import "server-only";
import crypto from "crypto";
import type { OverlayLink } from "./fish-overlay";

/**
 * The video overlay: a browser source that plays the YouTube videos viewers pay for
 * with $<cmd> video (points.video). Its own key, from the internal secret like the
 * fishing overlay's, so its link can't be guessed from the channel or the fishing one.
 */
export function videoOverlayKey(channel: string): string | null {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(`video-overlay:${channel}`).digest("base64url").slice(0, 24);
}

export function validVideoOverlayKey(channel: string, key: string | null | undefined): boolean {
  const want = videoOverlayKey(channel);
  return !!want && typeof key === "string" && key.length === want.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(want));
}

/** The channel's video overlay link, for the bot page. Empty without the secret. */
export function videoOverlayLinks(channel: string): OverlayLink[] {
  const base = (process.env.NEXT_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  const key = videoOverlayKey(channel);
  return key
    ? [{ label: "Video player", hint: "Plays each paid video full size, with its sound, then goes clear. Size the source 16:9 (e.g. 1280×720) and set its volume in OBS.", url: `${base}/${channel}/overlay/video?key=${key}` }]
    : [];
}
