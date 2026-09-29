import { NextRequest, NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { loadFishOverlay, validOverlayKey } from "@/lib/fish-overlay";

// The fishing overlay's feed, polled by the browser source. ?key=<overlay key>
export async function GET(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug) || !validOverlayKey(slug, req.nextUrl.searchParams.get("key"))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const r = await loadFishOverlay(slug);
  const headers = { "Cache-Control": "no-store" };
  if (r.kind === "not-found") return NextResponse.json({ error: "Fishing is off in this channel" }, { status: 404, headers });
  if (r.kind === "unavailable") return NextResponse.json({ error: "Unavailable" }, { status: 503, headers });
  return NextResponse.json(r.data, { headers });
}
