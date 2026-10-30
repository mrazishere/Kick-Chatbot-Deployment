import { NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { getFishAlerts } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";

// The signed-in viewer's fishing alerts (a steal on their fish, a gift, a trade or duel for them,
// a big bite on their line), polled by the leaderboard. ?after=<id> returns only newer ones.
export async function GET(req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const headers = { "Cache-Control": "private, no-store" };
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400, headers });
  const me = await leaderboardViewer().catch(() => null);
  if (!me) return NextResponse.json({ error: "Sign in to see your alerts" }, { status: 401, headers });
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  try {
    return NextResponse.json(await getFishAlerts(slug, me.userId, Number.isSafeInteger(after) && after > 0 ? after : 0), { headers });
  } catch {
    return NextResponse.json({ error: "Unavailable" }, { status: 503, headers });
  }
}
