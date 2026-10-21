import { NextResponse } from "next/server";
import { getFishOverlayStatus, reloadFishOverlay } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";
import { overlayPagesFor } from "@/lib/overlay-health";

type Params = { params: Promise<{ channel: string }> };

// The fishing overlay's health for the Fishing > Overlay tab: each open page's last report (kept
// here, from their polls) and how the bot sees it. Managers too, as mods can reload it from chat.

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    const bot = await getFishOverlayStatus(channel);
    return NextResponse.json({ pages: overlayPagesFor(channel), liveBuild: process.env.DASH_BUILD_ID ?? null, bot });
  } catch (e) {
    return errorResponse(e);
  }
}

/** Reload every open fishing overlay now. */
export async function POST(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await reloadFishOverlay(channel));
  } catch (e) {
    return errorResponse(e);
  }
}
