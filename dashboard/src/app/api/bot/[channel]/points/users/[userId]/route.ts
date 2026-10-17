import { NextResponse } from "next/server";
import { getPointsUser } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string; userId: string }> };

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw, userId: rawUserId } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  // Kick user ids are positive integers. Checked before the bot service is asked,
  // so nothing but digits ever reaches its URL.
  const userId = /^[1-9]\d{0,15}$/.test(rawUserId) ? Number(rawUserId) : NaN;
  if (!Number.isSafeInteger(userId)) {
    return NextResponse.json({ error: "Invalid user id" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await getPointsUser(channel, userId));
  } catch (e) {
    return errorResponse(e);
  }
}
