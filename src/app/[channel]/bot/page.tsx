import { getSession, isAdmin } from "@/lib/session";
import { getChannel, listChannels, getManagers, syncManagers, channelsReachableBy, getCustomCommands, BotApiError, type BotChannel, type CustomCommand } from "@/lib/bot-api";
import { authorizeChannel, validChannel, visibleTo } from "@/lib/bot-auth";
import { fetchChannelInfo, fetchUserAvatar } from "@/lib/kick-api";
import { notFound, redirect } from "next/navigation";
import BotManager from "@/components/BotManager";

export const dynamic = "force-dynamic";

export default async function BotPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();

  const session = await getSession();
  if (!session.userId || !session.username) redirect("/login");

  // Owner, admin, or a moderator the broadcaster added to `managers`.
  const gate = await authorizeChannel(slug);
  if (!gate.ok) redirect(`/${session.username}/bot`);
  const { role, canAdminister } = gate.auth;
  const admin = isAdmin(session.userId);

  let bot: BotChannel | null = null;
  let available: string[] = [];
  let loadError: string | null = null;

  try {
    bot = visibleTo(gate.auth, await getChannel(slug));
    available = bot.availableCommands ?? [];
  } catch (e) {
    if (e instanceof BotApiError && e.status === 404) {
      // Not enrolled yet — the page still renders, offering enrollment.
      bot = null;
      try {
        available = (await listChannels()).availableCommands;
      } catch {
        available = [];
      }
    } else {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  // Unlike the manager list, managers can edit these — mods already can from chat.
  let customCommands: CustomCommand[] = [];
  let customCommandsError: string | null = null;
  if (bot) {
    try {
      customCommands = (await getCustomCommands(slug)).commands;
    } catch (e) {
      // Shown in the card rather than as "no commands", which would read as data loss.
      customCommandsError = e instanceof Error ? e.message : String(e);
    }
  }

  // Only the owner/admin sees or edits the manager list.
  let managers: string[] = [];
  let managerSuggestions: string[] = [];
  let managersError: string | null = null;
  if (canAdminister && bot) {
    try {
      let m = await getManagers(slug);
      // The first time the broadcaster opens their own list, populate it from the
      // moderators seen in chat so they prune rather than build. Only when it has
      // never been configured — an empty list is a decision — and only for the
      // broadcaster: an admin merely opening the page used to hand every moderator
      // manager access without the broadcaster deciding anything.
      if (!m.seeded && role === "owner") {
        await syncManagers(slug);
        m = await getManagers(slug);
      }
      managers = m.managers;
      managerSuggestions = m.suggestions;
    } catch (e) {
      // Not the same as "no managers": the card would save that empty list over the real one.
      managersError = e instanceof Error ? e.message : String(e);
    }
  }

  // Every bot this user can reach, own channel included — the header switcher is
  // now the only route between bot pages.
  let switcher: { channel: string; isSelf: boolean }[] = [];
  try {
    switcher = (await channelsReachableBy(session.username)).channels;
  } catch {
    // Navigation aid only — never block the page on it.
  }

  // Whether the CHANNEL is streaming — distinct from whether the bot process is
  // up, which is what the header used to show (and was therefore always green).
  let isLive = false;
  let viewerCount = 0;
  let channelAvatarUrl: string | null = null;
  try {
    const info = await fetchChannelInfo(slug);
    isLive = info?.isLive ?? false;
    viewerCount = info?.viewerCount ?? 0;
    const broadcasterUserId = info?.broadcasterUserId ?? bot?.broadcasterUserId ?? null;
    if (broadcasterUserId) channelAvatarUrl = await fetchUserAvatar(broadcasterUserId);
  } catch {
    // Kick being unreachable shouldn't stop the page rendering.
  }

  return (
    <BotManager
      channel={slug}
      username={session.username}
      avatarUrl={session.avatarUrl ?? null}
      channelAvatarUrl={channelAvatarUrl}
      isAdmin={admin}
      role={role}
      canAdminister={canAdminister}
      initialBot={bot}
      availableCommands={available}
      initialManagers={managers}
      managerSuggestions={managerSuggestions}
      managersError={managersError}
      switcher={switcher}
      isLive={isLive}
      viewerCount={viewerCount}
      loadError={loadError}
      initialCustomCommands={customCommands}
      customCommandsError={customCommandsError}
    />
  );
}
