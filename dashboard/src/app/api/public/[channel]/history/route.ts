import { NextRequest, NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { loadPublicHistory } from "@/lib/public-leaderboard";

// Public and read-only: one viewer's $DON history. ?name=<kick username>
export async function GET(req: NextRequest, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const name = (req.nextUrl.searchParams.get("name") ?? "").trim().replace(/^@+/, "");
  if (!validChannel(slug) || !/^[A-Za-z0-9_]{2,25}$/.test(name)) {
    return NextResponse.json({ error: "Invalid channel or name" }, { status: 400 });
  }
  const r = await loadPublicHistory(slug, name);
  if (r.kind === "not-found") return NextResponse.json({ error: "No such viewer here" }, { status: 404 });
  if (r.kind === "unavailable") return NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503 });
  return NextResponse.json(r.data);
}
