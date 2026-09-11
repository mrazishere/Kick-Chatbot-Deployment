import { getSession, isAdmin } from "@/lib/session";
import { channelHasData } from "@/lib/kpp-data";
import { getChannel, channelsReachableBy } from "@/lib/bot-api";
import { notFound, redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function ChannelPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  const slug = channel.toLowerCase();

  const session = await getSession();

  // Earnings estimates are private. This page used to render for anyone;
  // it now requires sign-in, and you only see your own channel (admin sees all).
  if (!session.userId || !session.username) redirect("/login");

  const admin = isAdmin(session.userId);
  const isOwner = session.username === slug || admin;
  if (!isOwner) redirect(`/${session.username}/bot`);

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
  try {
    switcher = (await channelsReachableBy(session.username)).channels;
  } catch {
    // Navigation aid only.
  }

  return (
    <Dashboard
      channel={slug}
      username={session.username}
      avatarUrl={session.avatarUrl}
      isAdmin={admin}
      isOwner={isOwner}
      isLoggedIn={true}
      switcher={switcher}
    />
  );
}
