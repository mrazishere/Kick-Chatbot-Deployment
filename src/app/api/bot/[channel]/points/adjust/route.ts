import { NextResponse } from "next/server";
import { adjustPoints, type PointsAdjustMode } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

const MODES = new Set<PointsAdjustMode>(["add", "remove", "set"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Owner, admin and managers alike: moderators can already change balances from chat.
// Every change needs a reason and is logged against the signed-in user — the actor
// comes from the session, never from the request body.

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const { userId, mode, amount, reason, requestId } = body;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId < 1) {
    return NextResponse.json({ error: "userId must be a Kick user id" }, { status: 400 });
  }
  if (typeof mode !== "string" || !MODES.has(mode as PointsAdjustMode)) {
    return NextResponse.json({ error: "mode must be add, remove or set" }, { status: 400 });
  }
  const minAmount = mode === "set" ? 0 : 1;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < minAmount || amount > 1_000_000_000) {
    return NextResponse.json(
      { error: mode === "set" ? "Amount must be a whole number, 0 or more" : "Amount must be a whole number, 1 or more" },
      { status: 400 },
    );
  }
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3 || why.length > 200) {
    return NextResponse.json({ error: "A reason of 3–200 characters is required" }, { status: 400 });
  }
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return NextResponse.json({ error: "requestId must be a UUID" }, { status: 400 });
  }

  try {
    const result = await adjustPoints(channel, {
      userId,
      mode: mode as PointsAdjustMode,
      amount,
      reason: why,
      actor: { username: gate.auth.username, role: gate.auth.role },
      requestId,
    });
    console.log(
      `[dashboard] ${gate.auth.username} (${gate.auth.role}) adjusted ${channel} points: ${mode} ${amount} ` +
        `for ${result.user?.username ?? userId}${result.applied ? "" : " (already applied)"} — ${why}`,
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
