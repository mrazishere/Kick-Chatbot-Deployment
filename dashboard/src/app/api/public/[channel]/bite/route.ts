import { NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { getBigBite } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";

// The channel's big bite for the leaderboard's Fishing tab (games.bigBite.onLeaderboard), polled
// by the page: anyone sees who has it and its time; the signed-in holder also learns whether
// their code is showing, and fetches it as a picture (bite/code).
export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const headers = { "Cache-Control": "private, no-store" };
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400, headers });
  const me = await leaderboardViewer().catch(() => null);
  try {
    return NextResponse.json(await getBigBite(slug, me?.userId), { headers });
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503, headers });
  }
}
