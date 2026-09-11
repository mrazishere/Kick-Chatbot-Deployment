import { NextRequest, NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { fetchChannelInfo, scrapeVods } from "@/lib/kick-api";
import { channelHasData, validKppChannel } from "@/lib/kpp-data";

// Public and read-only: channel info and VODs for the earnings page.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();

  const channelParam = req.nextUrl.searchParams.get("channel");
  if (!channelParam && !session.username) {
    return NextResponse.json({ error: "Missing channel" }, { status: 400 });
  }
  const asParam = req.nextUrl.searchParams.get("as");
  const channel = ((asParam && session.userId && isAdmin(session.userId))
    ? asParam
    : (channelParam ?? session.username ?? "")).toLowerCase();
  if (!validKppChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  // Single call — channels endpoint returns all static + live fields including thumbnail.
  // 30s cache keeps viewer count fresh. fetchLiveInfo (livestreams endpoint) is no longer needed.
  // VODs come from a headless browser on the bot server, so only channels the
  // earnings page covers get one. Any made-up name used to launch another Chromium.
  const [channelInfo, vods] = await Promise.all([
    fetchChannelInfo(channel),
    channelHasData(channel) ? scrapeVods(channel) : Promise.resolve([]),
  ]);

  if (!channelInfo) {
    return NextResponse.json({ channel: null, live: null, vods: [] });
  }

  const live = channelInfo.isLive ? {
    isLive: true,
    viewerCount: channelInfo.viewerCount,
    thumbnailUrl: channelInfo.thumbnailUrl,
    streamTitle: channelInfo.streamTitle,
    startedAt: channelInfo.streamStartedAt ?? "",
    category: channelInfo.category ? { name: channelInfo.category.name } : null,
  } : null;

  return NextResponse.json({ channel: channelInfo, live, vods });
}
