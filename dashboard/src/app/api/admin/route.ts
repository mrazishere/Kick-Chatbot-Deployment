import { NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { listChannels, getSessions, getLiveSession } from "@/lib/kpp-data";

/** current.json lingers when a bot stops mid-stream, so "live" also needs a poll this recent. */
const LIVE_STALE_MS = 15 * 60 * 1000;

export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session.userId || !isAdmin(session.userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const channels = listChannels().map((channel) => {
    const sessions = getSessions(channel);
    const live = getLiveSession(channel);
    // A session without a calibrated rate has no estimate; count it as nothing, not NaN.
    const totalEstCents = sessions.reduce((a, s) => a + (s.estimatedCents ?? 0), 0);
    const lastSession = sessions.at(-1);
    const isLive = live !== null && Date.now() - Date.parse(live.lastPolledAt) < LIVE_STALE_MS;
    return {
      channel,
      sessionCount: sessions.length,
      totalEstCents,
      lastStreamedAt: lastSession?.startedAt ?? null,
      isLive,
      liveViewers: isLive ? live.lastViewerCount : null,
    };
  });

  return NextResponse.json({ channels });
}
