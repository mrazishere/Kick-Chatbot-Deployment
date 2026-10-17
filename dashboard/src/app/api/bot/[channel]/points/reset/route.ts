import { NextResponse } from "next/server";
import { resetPoints } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Zeroes every balance in the channel. Owner and admin only, like single-viewer
// adjustments. The client must echo the channel name back as `confirm`, so a stray
// request can't wipe a channel; the bot backs the database up before touching it.

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

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const { confirm, reason, requestId } = body;
  if (typeof confirm !== "string" || confirm.trim().toLowerCase() !== channel) {
    return NextResponse.json({ error: "Type the channel name to confirm" }, { status: 400 });
  }
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why.length < 3 || why.length > 200) {
    return NextResponse.json({ error: "A reason of 3–200 characters is required" }, { status: 400 });
  }
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return NextResponse.json({ error: "requestId must be a UUID" }, { status: 400 });
  }

  try {
    const result = await resetPoints(channel, {
      reason: why,
      actor: { username: gate.auth.username, role: gate.auth.role },
      requestId,
    });
    console.log(
      `[dashboard] ${gate.auth.username} (${gate.auth.role}) RESET ${channel} points: ` +
        `${result.total} from ${result.users} viewers${result.applied ? "" : " (already applied)"} — ${why}`,
    );
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
