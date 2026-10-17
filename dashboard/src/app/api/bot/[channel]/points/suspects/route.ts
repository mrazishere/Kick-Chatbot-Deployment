import { NextResponse } from "next/server";
import { getCheatSuspects } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// Possible cheaters in the offline fishing games, for the owner and managers to judge.
// ?days=1–30 (default 7).
export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  const days = Math.min(30, Math.max(1, Math.round(Number(new URL(req.url).searchParams.get("days")) || 7)));
  try {
    return NextResponse.json(await getCheatSuspects(channel, days));
  } catch (e) {
    return errorResponse(e);
  }
}
