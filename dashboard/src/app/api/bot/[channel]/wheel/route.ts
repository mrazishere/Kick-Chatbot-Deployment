import { NextResponse } from "next/server";
import { getWheel, saveWheel } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// The prize wheel's items and settings. Managers may edit them as well as the owner:
// mods can already change the wheel from chat with !wheel add / remove. The bot
// service validates the fields, and refuses a save made from a stale copy (409).

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await getWheel(channel));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PUT(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.items) || typeof body.spinSeconds !== "number" || typeof body.removeWinner !== "boolean" || typeof body.version !== "number") {
    return NextResponse.json({ error: "items, spinSeconds, removeWinner and version are required" }, { status: 400 });
  }

  try {
    const items = body.items.map((it) => {
      const o = (it && typeof it === "object" ? it : {}) as Record<string, unknown>;
      return { label: typeof o.label === "string" ? o.label : "", ...(typeof o.color === "string" && o.color ? { color: o.color } : {}) };
    });
    const onVideoOverlay = typeof body.onVideoOverlay === "boolean" ? { onVideoOverlay: body.onVideoOverlay } : {};
    return NextResponse.json(await saveWheel(channel, { items, spinSeconds: body.spinSeconds, removeWinner: body.removeWinner, ...onVideoOverlay, version: body.version }));
  } catch (e) {
    return errorResponse(e);
  }
}
