import { NextResponse } from "next/server";
import { searchPointsUsers } from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

export async function GET(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  // A leading @ is how chat writes names; the search is on the bare, lowercased name.
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^@+/, "").toLowerCase();
  if (q && !/^[a-z0-9_]{1,25}$/.test(q)) {
    return NextResponse.json({ error: "Search by username: letters, digits and _" }, { status: 400 });
  }

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? 20 : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    return NextResponse.json({ error: "limit must be 1–50" }, { status: 400 });
  }

  try {
    return NextResponse.json(await searchPointsUsers(channel, q, limit));
  } catch (e) {
    return errorResponse(e);
  }
}
