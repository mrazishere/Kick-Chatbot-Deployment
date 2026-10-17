import { getSession, isAdmin } from "@/lib/session";
import { listChannels, channelsReachableBy, BotApiError, type BotChannel } from "@/lib/bot-api";
import { fetchChannelInfo } from "@/lib/kick-api";
import { redirect } from "next/navigation";
import SiteHeader from "@/components/SiteHeader";
import ChannelGrid from "@/components/ChannelGrid";

export const dynamic = "force-dynamic";


export default async function ChannelsPage() {
  const session = await getSession();

  // This dashboard holds channel tokens and bot controls — nothing here is public.
  if (!session.userId || !session.username) redirect("/login");

  // Admin-only: the cross-channel view behind the "All channels" link.
  if (!isAdmin(session.userId)) redirect(`/${session.username}/bot`);

  let channels: BotChannel[] = [];
  let loadError: string | null = null;
  try {
    channels = (await listChannels()).channels;
  } catch (e) {
    loadError = e instanceof BotApiError ? e.message : e instanceof Error ? e.message : String(e);
  }

  // Stream status per channel, fetched in parallel. Bot status and stream status
  // are independent — a running bot in an offline channel is the normal case.
  const liveByChannel = new Map<string, { isLive: boolean; viewers: number }>();
  await Promise.all(
    channels.map(async (ch) => {
      try {
        const info = await fetchChannelInfo(ch.channel);
        liveByChannel.set(ch.channel, {
          isLive: info?.isLive ?? false,
          viewers: info?.viewerCount ?? 0,
        });
      } catch {
        // Leave it unknown rather than failing the whole page.
      }
    }),
  );

  let switcher: { channel: string; isSelf: boolean }[] = [];
  try {
    switcher = (await channelsReachableBy(session.username)).channels;
  } catch {
    // Navigation aid only.
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a]">
      <SiteHeader
        channel={session.username}
        title="All channels"
        username={session.username}
        avatarUrl={session.avatarUrl ?? null}
        isAdmin
        current="channels"
        switcher={switcher}
      />

      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-neutral-100">All channels</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Admin view — every channel running the bot. Select one to manage it.
          </p>
        </div>

        {loadError ? (
          <div className="rounded-xl border border-red-900 bg-red-950/40 px-5 py-4 text-sm text-red-400">
            Could not reach the bot service: {loadError}
          </div>
        ) : (
          <ChannelGrid
            initial={channels.map((ch) => ({
              channel: ch.channel,
              status: ch.status,
              hasChannelOAuth: ch.token.hasChannelOAuth,
              grantDaysLeft: ch.token.grantDaysLeft,
              isLive: liveByChannel.get(ch.channel)?.isLive ?? false,
              viewers: liveByChannel.get(ch.channel)?.viewers ?? 0,
            }))}
          />
        )}
      </main>
    </div>
  );
}
