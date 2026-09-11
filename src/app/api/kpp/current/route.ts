import { NextRequest, NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { getLiveSession, computeLiveEstimate, validKppChannel } from "@/lib/kpp-data";

const CENTS_PER_AUTH_VH = 104.5;

// Public and read-only.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const channelParam = (req.nextUrl.searchParams.get("channel") ?? "").toLowerCase();
  if (!validKppChannel(channelParam)) {
    return NextResponse.json({ error: "Missing or invalid channel" }, { status: 400 });
  }

  const session = await getSession();
  const adminOverride = req.nextUrl.searchParams.get("as")?.toLowerCase();
  const channel = adminOverride && validKppChannel(adminOverride) && session.userId && isAdmin(session.userId)
    ? adminOverride
    : channelParam;

  const live = getLiveSession(channel);
  if (!live) return NextResponse.json({ live: null });

  const estimatedCents = computeLiveEstimate(live, CENTS_PER_AUTH_VH);
  const uniqueChatters = Object.keys(live.cumulativeChatters).length;
  const chatRate = live.chatRateSampleCount > 0 ? live.chatRateSum / live.chatRateSampleCount : 0;

  return NextResponse.json({
    live: {
      startedAt: live.startedAt,
      lastPolledAt: live.lastPolledAt,
      lastViewerCount: live.lastViewerCount,
      viewerHoursSum: live.viewerHoursSum,
      peakViewers: live.peakViewers,
      totalMessages: live.totalMessages,
      uniqueChatters,
      chatRate,
      estimatedCents,
    },
  });
}
