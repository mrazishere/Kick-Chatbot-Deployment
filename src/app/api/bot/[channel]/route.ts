import { NextResponse } from "next/server";
import { getChannel, removeBot } from "@/lib/bot-api";
import { fetchChannelInfo } from "@/lib/kick-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel, visibleTo } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    // Bot process state and stream state are independent; the client polls this
    // one endpoint for both so the two pills can't drift out of sync.
    const [bot, info] = await Promise.all([
      getChannel(channel),
      fetchChannelInfo(channel).catch(() => null),
    ]);
    return NextResponse.json({
      ...visibleTo(gate.auth, bot),
      live: { isLive: info?.isLive ?? false, viewers: info?.viewerCount ?? 0 },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;
  const denied = requireAdminister(gate.auth);
  if (denied) return denied;

  try {
    const result = await removeBot(channel);
    console.log(`[dashboard] ${gate.auth.username} removed the bot from ${channel}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
