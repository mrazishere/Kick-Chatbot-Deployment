import { NextRequest, NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { loadPublicViewers } from "@/lib/public-leaderboard";

// Public and read-only: the leaderboard's viewer list and search. ?q=<username prefix>
export async function GET(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().replace(/^@+/, "");
  if (!validChannel(slug) || (q && !/^[A-Za-z0-9_]{1,25}$/.test(q))) {
    return NextResponse.json({ error: "Invalid channel or search" }, { status: 400 });
  }
  const r = await loadPublicViewers(slug, q);
  if (r.kind === "not-found") return NextResponse.json({ error: "No public leaderboard here" }, { status: 404 });
  if (r.kind === "unavailable") return NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503 });
  return NextResponse.json({ viewers: r.viewers });
}
