import { NextResponse } from "next/server";
import { getClipSession, setClipToken } from "@/lib/bot-api";
import { errorResponse } from "@/lib/bot-auth";
import { getSession, isAdmin } from "@/lib/session";

// The clip session belongs to the bot account, not to any one channel, and the
// token is a full login for it. Only the bot owner may read its health or
// replace it — a channel manager has no business with the bot's own credentials.
async function requireOwner(): Promise<NextResponse | null> {
  const session = await getSession();
  if (!session?.userId) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!isAdmin(session.userId)) return NextResponse.json({ error: "Not allowed" }, { status: 403 });
  return null;
}

export async function GET(): Promise<NextResponse> {
  const gate = await requireOwner();
  if (gate) return gate;
  try {
    return NextResponse.json(await getClipSession());
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request): Promise<NextResponse> {
  const gate = await requireOwner();
  if (gate) return gate;

  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token.trim() : "";
  } catch {
    return NextResponse.json({ error: "Expected JSON" }, { status: 400 });
  }
  if (!token) return NextResponse.json({ error: "Paste a session token first" }, { status: 400 });

  try {
    return NextResponse.json(await setClipToken(token));
  } catch (e) {
    return errorResponse(e);
  }
}
