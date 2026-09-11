import { NextResponse } from "next/server";
import { controlBot } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel, visibleTo } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

const ACTIONS = new Set(["start", "stop", "restart"]);

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  let action: unknown;
  try {
    ({ action } = (await req.json()) as { action?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json(
      { error: "action must be start, stop or restart" },
      { status: 400 },
    );
  }

  // Restarting fixes the common "bot is wedged" case and is safe to delegate.
  // Stopping leaves the channel bot-less until someone notices, so it isn't.
  if (action === "stop") {
    const denied = requireAdminister(gate.auth);
    if (denied) return denied;
  }

  try {
    const result = await controlBot(channel, action as "start" | "stop" | "restart");
    console.log(`[dashboard] ${gate.auth.username} ran ${action} on ${channel}`);
    return NextResponse.json(visibleTo(gate.auth, result));
  } catch (e) {
    return errorResponse(e);
  }
}
