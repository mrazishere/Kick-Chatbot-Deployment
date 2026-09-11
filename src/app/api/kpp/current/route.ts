import { NextRequest, NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { getLiveSession, computeLiveEstimate, validKppChannel } from "@/lib/kpp-data";
import { BotApiError, getChannel } from "@/lib/bot-api";

/**
 * The rate comes from the channel's bot config — the one the bot applies to
 * finished sessions — so the live figure can't claim what the history won't. It
 * was a hardcoded 104.5 that no payout had ever confirmed. This route is public
 * and polled, and each lookup lists pm2 on the bot service, so answers are kept
 * for a minute.
 */
const RATE_TTL_MS = 60_000;
const rateCache = new Map<string, { at: number; rate: number | null }>();

async function centsPerAuthViewerHour(channel: string): Promise<number | null> {
  const hit = rateCache.get(channel);
  if (hit && Date.now() - hit.at < RATE_TTL_MS) return hit.rate;
  let rate: number | null = null;
  try {
    const configured = (await getChannel(channel)).kpp?.centsPerAuthViewerHour;
    rate = typeof configured === "number" && Number.isFinite(configured) ? configured : null;
  } catch (e) {
    // A channel that isn't enrolled has no rate. Any other failure is the bot
    // service being briefly away: keep the last answer rather than blank the figure.
    if (!(e instanceof BotApiError && e.status === 404) && hit) return hit.rate;
  }
  if (rateCache.size > 100) rateCache.clear();
  rateCache.set(channel, { at: Date.now(), rate });
  return rate;
}

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

  const estimatedCents = computeLiveEstimate(live, await centsPerAuthViewerHour(channel));
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
