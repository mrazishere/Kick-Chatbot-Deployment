import { NextResponse } from "next/server";
import { validChannel } from "@/lib/bot-auth";
import { BotApiError, fishMove, getFishPage } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";
import { MOVE_MAX_CHARS, moveLength } from "@/lib/fish-move";
import { emoteImages } from "@/lib/public-leaderboard";

// The signed-in viewer's fishing game on the leaderboard: casts, traps, check answers, selling and trades,
// played by the channel's bot exactly as in chat. Who it is comes from the viewer sign-in.
const headers = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One word of a move: a fish emoji, a length, an amount, an @name. Never a space, $ or !.
const WORD = /^[^\p{Cc}\s$!]{1,40}$/u;

async function viewer(): Promise<{ userId: number; username: string } | null> {
  try {
    return await leaderboardViewer();
  } catch {
    return null;
  }
}

const unavailable = (e: unknown): NextResponse =>
  e instanceof BotApiError && e.status >= 400 && e.status < 500
    ? NextResponse.json({ error: e.message }, { status: e.status, headers })
    : NextResponse.json({ error: "Unavailable right now, try again in a minute" }, { status: 503, headers });

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  const me = await viewer();
  if (!me) return NextResponse.json({ error: "Sign in to fish" }, { status: 401, headers });
  try {
    const { fish } = await getFishPage(slug, me.userId, me.username);
    return NextResponse.json({ username: me.username, fish: fish && { ...fish, emotes: emoteImages(fish.emotes) } }, { headers });
  } catch (e) {
    if (e instanceof BotApiError && e.status === 404) return NextResponse.json({ username: me.username, fish: null }, { headers });
    return unavailable(e);
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  const me = await viewer();
  if (!me) return NextResponse.json({ error: "Sign in to fish" }, { status: 401, headers });
  const body = (await req.json().catch(() => null)) as { args?: unknown; requestId?: unknown } | null;
  const args = Array.isArray(body?.args) ? body.args : null;
  // A typed answer can be an emoji or words ("tin can"); every other part is a plain word.
  const ok = (a: unknown, i: number): a is string =>
    typeof a === "string" && (args?.[0] === "answer" && i === 1 ? /^[^\p{Cc}$!]{1,40}$/u.test(a) && a.trim() !== "" : WORD.test(a));
  if (!args || !args.every(ok) || moveLength(args) > MOVE_MAX_CHARS) {
    return NextResponse.json({ error: "Bad move" }, { status: 400, headers });
  }
  if (typeof body?.requestId !== "string" || !UUID.test(body.requestId)) return NextResponse.json({ error: "Bad request" }, { status: 400, headers });
  try {
    const result = await fishMove(slug, { userId: me.userId, username: me.username, args, requestId: body.requestId });
    return NextResponse.json({ username: me.username, ...result }, { headers });
  } catch (e) {
    return unavailable(e);
  }
}
