import { NextResponse } from "next/server";
import { createReward, getRewards } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// Anyone who can open the bot page may see the rewards. Only the broadcaster or
// the admin may change them: they spend viewers' points and moderate chat.

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await getRewards(channel));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;
  const denied = requireAdminister(gate.auth);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.reward || typeof body.reward !== "object") {
    return NextResponse.json({ error: "reward is required" }, { status: 400 });
  }

  try {
    const result = await createReward(channel, {
      reward: body.reward as Record<string, unknown>,
      action: body.action && typeof body.action === "object" ? (body.action as Record<string, unknown>) : null,
    });
    console.log(`[dashboard] ${gate.auth.username} created reward ${result.id} on ${channel}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
