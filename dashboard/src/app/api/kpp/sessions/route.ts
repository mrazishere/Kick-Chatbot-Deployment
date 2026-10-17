import { NextRequest, NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { getSessions, getPayouts, channelHasData, validKppChannel } from "@/lib/kpp-data";

// Public and read-only.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const channelParam = (req.nextUrl.searchParams.get("channel") ?? "").toLowerCase();
  if (!validKppChannel(channelParam)) {
    return NextResponse.json({ error: "Missing or invalid channel" }, { status: 400 });
  }

  // Admin can query any channel; everyone else reads the requested channel
  const session = await getSession();
  const adminOverride = req.nextUrl.searchParams.get("as")?.toLowerCase();
  const channel = adminOverride && validKppChannel(adminOverride) && session.userId && isAdmin(session.userId)
    ? adminOverride
    : channelParam;

  if (!channelHasData(channel)) {
    return NextResponse.json({ sessions: [], payouts: [], noData: true });
  }

  return NextResponse.json({
    sessions: getSessions(channel),
    payouts: getPayouts(channel),
    noData: false,
  });
}
