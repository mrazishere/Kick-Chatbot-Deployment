import { NextRequest, NextResponse } from "next/server";
import { noteOverlayBuild } from "@/lib/overlay-stale-log";
import { validChannel } from "@/lib/bot-auth";
import { BotApiError, getVideoOverlay, reportVideoFailed } from "@/lib/bot-api";
import { validVideoOverlayKey } from "@/lib/video-overlay";

const headers = { "Cache-Control": "no-store" };

const check = async (req: NextRequest, params: Promise<{ channel: string }>): Promise<string | null> => {
  const slug = (await params).channel.toLowerCase();
  return validChannel(slug) && validVideoOverlayKey(slug, req.nextUrl.searchParams.get("key")) ? slug : null;
};

const failed = (e: unknown) =>
  e instanceof BotApiError && e.status === 404
    ? NextResponse.json({ error: "Video sharing is off in this channel" }, { status: 404, headers })
    : NextResponse.json({ error: "Unavailable" }, { status: 503, headers });

// The video overlay's feed, polled by the browser source. ?key=<video overlay key>.
// Every poll goes to the bot: it's what moves the queue on, so it isn't cached.
export async function GET(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const slug = await check(req, params);
  if (!slug) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  try {
    const embedded = req.nextUrl.searchParams.get("in") === "fishing";
    if (!embedded) noteOverlayBuild(slug, "video", req.nextUrl.searchParams.get("v"));
    const feed = await getVideoOverlay(slug, embedded);
    // build: which dashboard build answered, so an overlay running older page code reloads.
    // An overlay on an older build only reloads with nothing on (VideoOverlay), and media share
    // played back to back never stops: it's told nothing is on for this one poll, so it reloads
    // now and picks the video up again where it is.
    const v = req.nextUrl.searchParams.get("v");
    const build = process.env.DASH_BUILD_ID;
    const stale = !embedded && !!v && !!build && v !== build && (feed as { mediashare?: unknown }).mediashare;
    return NextResponse.json({ ...feed, ...(stale ? { mediashare: null } : {}), build }, { headers });
  } catch (e) {
    return failed(e);
  }
}

// The overlay couldn't play a video: the bot ends it and refunds its viewer. Body: { id }.
export async function POST(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const slug = await check(req, params);
  if (!slug) return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  const id = Number(((await req.json().catch(() => null)) as { id?: unknown } | null)?.id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id must be a video id" }, { status: 400, headers });
  try {
    return NextResponse.json(await reportVideoFailed(slug, id), { headers });
  } catch (e) {
    return failed(e);
  }
}
