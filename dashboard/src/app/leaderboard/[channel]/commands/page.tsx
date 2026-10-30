import { notFound, redirect } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ channel: string }> };

// The short address `$don commands` posts for the leaderboard's Commands tab: chat allows a
// bot message ten symbols, and the tab's own address has two more than that. The older
// /<channel>/commands still redirects here too.
export default async function CommandsLink({ params }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();
  redirect(`/leaderboard/${slug}?tab=commands`);
}
