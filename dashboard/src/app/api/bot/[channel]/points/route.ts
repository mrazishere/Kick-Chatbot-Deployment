import { NextResponse } from "next/server";
import { getPointsSummary } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// Managers see the points card as well as the owner: moderators can already check
// and change balances from chat. Only the settings stay with the broadcaster.

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await getPointsSummary(channel));
  } catch (e) {
    return errorResponse(e);
  }
}
