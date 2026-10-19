import "server-only";
import { headers } from "next/headers";

// Temporary (2026-10-19): one line per overlay page load, to see what a streaming tool's
// browser source actually asks for when it shows a 404 we can't reproduce. The key is
// never logged: only its length and the query's other names.
export async function logOverlayLoad(
  channel: string,
  overlay: string,
  result: string,
  key: string,
  query: Record<string, string | string[] | undefined>,
): Promise<void> {
  const h = await headers();
  const ip = h.get("x-real-ip") ?? h.get("x-forwarded-for") ?? "?";
  const ua = h.get("user-agent") ?? "?";
  const others = Object.keys(query).filter((k) => k !== "key").join(",") || "-";
  console.log(`[overlay-load] ${channel} ${overlay} -> ${result} key=${key.length} params=${others} ip=${ip} ua=${ua}`);
}
