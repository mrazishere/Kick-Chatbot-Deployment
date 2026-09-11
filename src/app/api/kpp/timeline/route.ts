import { NextRequest, NextResponse } from "next/server";
import { getTimelines, validKppChannel } from "@/lib/kpp-data";

// Public and read-only.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const channel = (req.nextUrl.searchParams.get("channel") ?? "").toLowerCase();
  if (!validKppChannel(channel)) {
    return NextResponse.json({ error: "Missing or invalid channel" }, { status: 400 });
  }

  return NextResponse.json({ sessions: getTimelines(channel) });
}
