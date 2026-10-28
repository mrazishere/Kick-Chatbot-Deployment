import { NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { getOwnGuard } from "@/lib/bot-api";
import { getSession } from "@/lib/session";

// The signed-in viewer's own fish guard: when it runs out, or null. Never anyone else's:
// the Kick id comes from the session, not the request, since a guard's time is secret.
export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  let userId: number | undefined;
  let username: string | undefined;
  try {
    const session = await getSession();
    userId = session.userId;
    username = session.username;
  } catch {
    userId = undefined;
  }
  const headers = { "Cache-Control": "private, no-store" };
  if (!userId || !username) return NextResponse.json({ error: "Sign in to see your guard" }, { status: 401, headers });
  try {
    const { guardUntil } = await getOwnGuard(slug, userId);
    return NextResponse.json({ username, guardUntil: typeof guardUntil === "string" ? guardUntil : null }, { headers });
  } catch {
    return NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503, headers });
  }
}
