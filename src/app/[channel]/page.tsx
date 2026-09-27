import { getSession, isAdmin } from "@/lib/session";
import { channelHasData, validKppChannel } from "@/lib/kpp-data";
import { getChannel, channelsReachableBy } from "@/lib/bot-api";
import { fetchChannelInfo, fetchUserAvatar } from "@/lib/kick-api";
import { notFound } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  const slug = channel.toLowerCase();

  if (!validKppChannel(slug)) notFound();

  // Public and read-only, like the /api/kpp routes it reads from. Signing in
  // only adds the payout form (owner or admin) and the bot switcher.
  const session = await getSession();
  const username = session.userId && session.username ? session.username : null;
  const admin = !!username && isAdmin(session.userId!);
  const isOwner = !!username && (username === slug || admin);

  // A channel with no KPP data is still a real page when the bot runs there —
  // never having streamed is a normal state, not a missing page. But an
  // arbitrary slug (an old route name, a typo) should 404 rather than render an
  // empty dashboard, which the admin would otherwise see for anything they type.
  if (!channelHasData(slug)) {
    let enrolled = false;
    try {
      await getChannel(slug);
      enrolled = true;
    } catch {
      enrolled = false;
    }
    if (!enrolled) notFound();
  }

  // Same header switcher as the bot pages — without it this page is a dead end
  // now that the nav no longer carries a Bot link.
  let switcher: { channel: string; isSelf: boolean }[] = [];
  if (username) {
    try {
      switcher = (await channelsReachableBy(username)).channels;
    } catch {
      // Navigation aid only.
    }
  }

  // The channel's own photo for the header — not the signed-in user's.
  let channelAvatarUrl: string | null = null;
  try {
    const info = await fetchChannelInfo(slug);
    if (info?.broadcasterUserId) channelAvatarUrl = await fetchUserAvatar(info.broadcasterUserId);
  } catch {
    // Decoration only.
  }

  return (
    <Dashboard
      channel={slug}
      username={username}
      avatarUrl={username ? session.avatarUrl : undefined}
      channelAvatarUrl={channelAvatarUrl}
      isAdmin={admin}
      isOwner={isOwner}
      isLoggedIn={!!username}
      switcher={switcher}
    />
  );
}
