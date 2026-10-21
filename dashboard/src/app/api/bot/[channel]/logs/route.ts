import { NextResponse } from "next/server";
import { getLogs } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// The channel bot's last log lines, for the Overview's Recent activity card.

export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  const asked = Number(new URL(req.url).searchParams.get("lines"));
  const lines = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 500) : 100;
  try {
    return NextResponse.json(await getLogs(channel, lines));
  } catch (e) {
    return errorResponse(e);
  }
}
