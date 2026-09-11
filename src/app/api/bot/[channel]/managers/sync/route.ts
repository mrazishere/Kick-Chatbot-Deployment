import { NextResponse } from "next/server";
import { syncManagers } from "@/lib/bot-api";
import {
  authorizeChannel,
  errorResponse,
  requireAdminister,
  validChannel,
} from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

/** Additive merge of observed moderators into the manager list. Owner/admin only. */
export async function POST(_req: Request, { params }: Params): Promise<NextResponse> {
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
    const result = await syncManagers(channel);
    console.log(
      `[dashboard] ${gate.auth.username} synced ${channel} managers — added [${result.added.join(", ")}]`,
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
