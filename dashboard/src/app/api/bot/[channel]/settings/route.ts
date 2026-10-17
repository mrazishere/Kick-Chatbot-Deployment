import { NextResponse } from "next/server";
import { updateSettings, type SettingsPatch } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel, visibleTo } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

const ALLOWED_KEYS = new Set(["chatOnly", "location", "autoTranslate", "kpp", "claude", "earnings", "points"]);

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  // Reject unknown keys here rather than letting them reach the bot service —
  // a typo'd setting name should fail loudly, not silently do nothing.
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !ALLOWED_KEYS.has(k));
  if (unknown.length > 0) {
    return NextResponse.json(
      { error: `Unknown settings: ${unknown.join(", ")}` },
      { status: 400 },
    );
  }
  if (keys.length === 0) {
    return NextResponse.json({ error: "No settings provided" }, { status: 400 });
  }

  // Every setting is the broadcaster's call (or the admin's). KPP and earnings decide what the
  // public earnings figures claim, points what every balance is worth, claude what the bot says
  // in chat and what it costs. Managers restart the bot and edit custom commands and the wheel,
  // nothing more (the owner's call, 2026-10-16 audit).
  const denied = requireAdminister(gate.auth);
  if (denied) return denied;

  try {
    const result = await updateSettings(channel, body as SettingsPatch);
    console.log(`[dashboard] ${gate.auth.username} updated ${channel} settings: ${keys.join(", ")}`);
    return NextResponse.json(visibleTo(gate.auth, result));
  } catch (e) {
    return errorResponse(e);
  }
}
