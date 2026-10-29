import { NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { BotApiError, buyFromShop, getOwnShop, type ShopItem } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";

// The signed-in viewer's own fishing gear, and buying a hook, guard or reel with their own
// currency. Who it is comes from the session, never the request.
const headers = { "Cache-Control": "private, no-store" };
const ITEMS = new Set<ShopItem>(["hook", "guard", "reel"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function viewer(): Promise<{ userId: number; username: string } | null> {
  try {
    return await leaderboardViewer();
  } catch {
    return null;
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  const me = await viewer();
  if (!me) return NextResponse.json({ error: "Sign in to see your gear" }, { status: 401, headers });
  try {
    const { shop } = await getOwnShop(slug, me.userId, me.username);
    return NextResponse.json({ username: me.username, shop }, { headers });
  } catch (e) {
    if (e instanceof BotApiError && e.status === 404) return NextResponse.json({ username: me.username, shop: null }, { headers });
    return NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503, headers });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  const me = await viewer();
  if (!me) return NextResponse.json({ error: "Sign in to buy" }, { status: 401, headers });
  const body = (await req.json().catch(() => null)) as { item?: unknown; requestId?: unknown } | null;
  const item = body?.item;
  const requestId = body?.requestId;
  if (typeof item !== "string" || !ITEMS.has(item as ShopItem)) return NextResponse.json({ error: "Unknown item" }, { status: 400, headers });
  if (typeof requestId !== "string" || !UUID.test(requestId)) return NextResponse.json({ error: "Bad request" }, { status: 400, headers });
  try {
    const result = await buyFromShop(slug, { userId: me.userId, username: me.username, item: item as ShopItem, requestId });
    return NextResponse.json({ username: me.username, ...result }, { headers });
  } catch (e) {
    if (e instanceof BotApiError && e.status >= 400 && e.status < 500) {
      return NextResponse.json({ error: e.message }, { status: e.status, headers });
    }
    return NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503, headers });
  }
}
