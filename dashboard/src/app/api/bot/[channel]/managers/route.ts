import { NextResponse } from "next/server";
import { getManagers, setManagers } from "@/lib/bot-api";
import {
  authorizeChannel,
  errorResponse,
  requireAdminister,
  validChannel,
} from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// Deciding who can manage the bot is the broadcaster's call, so both reading and
// writing this list stay with the owner/admin — a manager can't see or extend it.
export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
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
    return NextResponse.json(await getManagers(channel));
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

  let managers: unknown;
  try {
    ({ managers } = (await req.json()) as { managers?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(managers) || managers.some((m) => typeof m !== "string")) {
    return NextResponse.json(
      { error: "managers must be an array of usernames" },
      { status: 400 },
    );
  }

  try {
    const result = await setManagers(channel, managers as string[]);
    console.log(
      `[dashboard] ${gate.auth.username} set ${channel} managers to [${(managers as string[]).join(", ")}]`,
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
