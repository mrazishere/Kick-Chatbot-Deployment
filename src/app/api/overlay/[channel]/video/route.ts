import { NextRequest, NextResponse } from "next/server";
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
    const feed = await getVideoOverlay(slug, req.nextUrl.searchParams.get("in") === "fishing");
    // build: which dashboard build answered, so an overlay running older page code reloads.
    return NextResponse.json({ ...feed, build: process.env.DASH_BUILD_ID }, { headers });
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
