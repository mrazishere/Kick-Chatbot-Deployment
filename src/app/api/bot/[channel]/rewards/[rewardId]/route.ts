import { NextResponse } from "next/server";
import { deleteReward, updateReward } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string; rewardId: string }> };

function validRewardId(id: string): boolean {
  return /^[A-Za-z0-9]{10,40}$/.test(id);
}

export async function PATCH(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw, rewardId } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel) || !validRewardId(rewardId)) {
    return NextResponse.json({ error: "Invalid channel or reward" }, { status: 400 });
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

  const payload: { reward?: Record<string, unknown>; action?: Record<string, unknown> | null } = {};
  if (body.reward && typeof body.reward === "object") payload.reward = body.reward as Record<string, unknown>;
  if ("action" in body) {
    payload.action = body.action && typeof body.action === "object" ? (body.action as Record<string, unknown>) : null;
  }

  try {
    const result = await updateReward(channel, rewardId, payload);
    console.log(`[dashboard] ${gate.auth.username} updated reward ${rewardId} on ${channel}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw, rewardId } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel) || !validRewardId(rewardId)) {
    return NextResponse.json({ error: "Invalid channel or reward" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;
  const denied = requireAdminister(gate.auth);
  if (denied) return denied;

  try {
    const result = await deleteReward(channel, rewardId);
    console.log(`[dashboard] ${gate.auth.username} deleted reward ${rewardId} on ${channel}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
