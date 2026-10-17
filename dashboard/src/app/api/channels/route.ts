import { NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { listChannels } from "@/lib/bot-api";
import { fetchChannelInfo } from "@/lib/kick-api";
import { errorResponse } from "@/lib/bot-auth";

export interface ChannelRow {
  channel: string;
  status: string;
  hasChannelOAuth: boolean;
  grantDaysLeft: number | null;
  isLive: boolean;
  viewers: number;
}

/**
 * Cross-channel status for the admin list, polled by the client.
 *
 * Deliberately NOT under /api/bot/, where it would collide with the
 * /api/bot/[channel] dynamic route.
 */
export async function GET(): Promise<NextResponse> {
  const session = await getSession();
  if (!session.userId || !isAdmin(session.userId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const { channels } = await listChannels();
    const rows: ChannelRow[] = await Promise.all(
      channels.map(async (ch) => {
        // A Kick hiccup should leave one channel's stream state unknown,
        // not fail the whole poll.
        const info = await fetchChannelInfo(ch.channel).catch(() => null);
        return {
          channel: ch.channel,
          status: ch.status,
          hasChannelOAuth: ch.token.hasChannelOAuth,
          grantDaysLeft: ch.token.grantDaysLeft,
          isLive: info?.isLive ?? false,
          viewers: info?.viewerCount ?? 0,
        };
      }),
    );
    return NextResponse.json({ channels: rows });
  } catch (e) {
    return errorResponse(e);
  }
}
