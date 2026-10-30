import { NextRequest, NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { BotApiError, syncMediaPlayer } from "@/lib/bot-api";
import { validMediaPlayerKey } from "@/lib/media-player";

const headers = { "Cache-Control": "no-store" };
const ACTIONS = new Set(["next", "skip", "play", "pause", "replay", "hide", "show", "captions-on", "captions-off", "front", "remove"]);

// The media share phone player's once-a-second call. ?key=<player key>. Body: { report?, action? }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const slug = (await params).channel.toLowerCase();
  if (!validChannel(slug) || !validMediaPlayerKey(slug, req.nextUrl.searchParams.get("key"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  }
  const raw = (await req.json().catch(() => null)) as { session?: unknown; claim?: unknown; takeover?: unknown; report?: Record<string, unknown>; action?: Record<string, unknown> } | null;
  const session = typeof raw?.session === "string" ? raw.session.slice(0, 64) : undefined;
  const r = raw?.report;
  const report = r && typeof r.key === "string" && typeof r.position === "number" && Number.isFinite(r.position)
    ? { key: r.key.slice(0, 64), position: Math.max(0, r.position), paused: r.paused === true, hidden: r.hidden === true, latencyMs: typeof r.latencyMs === "number" && Number.isFinite(r.latencyMs) ? Math.max(0, Math.min(1_000, r.latencyMs)) : 0 }
    : undefined;
  const a = raw?.action;
  const action = a && typeof a.type === "string" && ACTIONS.has(a.type)
    ? { type: a.type as "next" | "skip" | "play" | "pause" | "replay" | "hide" | "show" | "captions-on" | "captions-off" | "front" | "remove", ...(typeof a.key === "string" ? { key: a.key.slice(0, 64) } : {}), ...(Number.isInteger(a.error) ? { error: a.error as number } : {}) }
    : undefined;
  try {
    // build: the dashboard build answering, so a page on an older one offers to reload.
    return NextResponse.json({ ...(await syncMediaPlayer(slug, { session, claim: raw?.claim === true, takeover: raw?.takeover === true, report, action })), build: process.env.DASH_BUILD_ID }, { headers });
  } catch (e) {
    const status = e instanceof BotApiError && e.status < 500 ? e.status : 503;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unavailable" }, { status, headers });
  }
}
