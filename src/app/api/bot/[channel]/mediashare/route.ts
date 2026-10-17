import { NextResponse } from "next/server";
import { getMediaShareStatus, removeMediaShareToken, saveMediaShareToken } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// The channel's StreamElements JWT, for mirroring its media share on the video overlay.
// Owner (and admin) only: the token runs the streamer's whole StreamElements account, so
// managers can't set, replace or remove it. It's never sent back, only whether one is saved.

async function gate(raw: string) {
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return { channel, response: NextResponse.json({ error: "Invalid channel" }, { status: 400 }) };
  const g = await authorizeChannel(channel);
  if (!g.ok) return { channel, response: g.response };
  if (!g.auth.canAdminister) return { channel, response: NextResponse.json({ error: "Only the channel's owner can manage its StreamElements token" }, { status: 403 }) };
  return { channel, response: null };
}

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel, response } = await gate((await params).channel);
  if (response) return response;
  try {
    return NextResponse.json(await getMediaShareStatus(channel));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel, response } = await gate((await params).channel);
  if (response) return response;
  const jwt = ((await req.json().catch(() => null)) as { jwt?: unknown } | null)?.jwt;
  if (typeof jwt !== "string" || !jwt.trim()) return NextResponse.json({ error: "Paste the JWT token" }, { status: 400 });
  try {
    return NextResponse.json(await saveMediaShareToken(channel, jwt));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel, response } = await gate((await params).channel);
  if (response) return response;
  try {
    return NextResponse.json(await removeMediaShareToken(channel));
  } catch (e) {
    return errorResponse(e);
  }
}
