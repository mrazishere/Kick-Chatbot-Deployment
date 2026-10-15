import { NextResponse } from "next/server";
import { setExcludedCommands } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, requireAdminister, validChannel, visibleTo } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;
  // Turning commands on or off is the broadcaster's (managers restart, and edit custom commands and the wheel).
  const denied = requireAdminister(gate.auth);
  if (denied) return denied;

  let excluded: unknown;
  try {
    ({ excludedCommands: excluded } = (await req.json()) as { excludedCommands?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(excluded) || excluded.some((c) => typeof c !== "string")) {
    return NextResponse.json(
      { error: "excludedCommands must be an array of strings" },
      { status: 400 },
    );
  }

  try {
    const result = await setExcludedCommands(channel, excluded as string[]);
    console.log(
      `[dashboard] ${gate.auth.username} set ${channel} excludedCommands to [${(excluded as string[]).join(", ")}]`,
    );
    return NextResponse.json(visibleTo(gate.auth, result));
  } catch (e) {
    return errorResponse(e);
  }
}
