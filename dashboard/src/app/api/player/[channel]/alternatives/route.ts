import { NextRequest, NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { BotApiError, mediaShareAlternatives } from "@/lib/bot-api";
import { validMediaPlayerKey } from "@/lib/media-player";

const headers = { "Cache-Control": "no-store" };

// The phone player's YouTube search: "find another version" for a video YouTube won't play, or
// the streamer's own search. ?key=<player key>. Body: { find: { videoId, title, seconds } },
// { search: text } (words or a link), or { add: videoId } (one just offered).
export async function POST(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const slug = (await params).channel.toLowerCase();
  if (!validChannel(slug) || !validMediaPlayerKey(slug, req.nextUrl.searchParams.get("key"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  }
  const raw = (await req.json().catch(() => null)) as { find?: Record<string, unknown>; search?: unknown; add?: unknown } | null;
  const f = raw?.find;
  const body = typeof raw?.add === "string" && /^[\w-]{11}$/.test(raw.add)
    ? { add: raw.add }
    : f && typeof f.videoId === "string" && /^[\w-]{11}$/.test(f.videoId) && typeof f.title === "string"
      ? { find: { videoId: f.videoId, title: f.title.slice(0, 200), seconds: typeof f.seconds === "number" && Number.isFinite(f.seconds) ? Math.max(0, f.seconds) : 0 } }
      : typeof raw?.search === "string" && raw.search.trim()
        ? { search: raw.search.trim().slice(0, 200) }
        : null;
  if (!body) return NextResponse.json({ error: "Which video?" }, { status: 400, headers });
  try {
    return NextResponse.json(await mediaShareAlternatives(slug, body), { headers });
  } catch (e) {
    const status = e instanceof BotApiError && e.status < 500 ? e.status : 503;
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unavailable" }, { status, headers });
  }
}
