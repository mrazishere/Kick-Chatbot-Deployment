import { notFound, permanentRedirect } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The leaderboard's old address, from before 2026-10-29 (now /leaderboard/<channel>). Links
// to it are all over chat, so it stays, sending them on with their ?user= and ?tab=.
export default async function OldLeaderboard({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  if (!validChannel(slug)) notFound();
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) {
    for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) query.append(k, one);
  }
  const qs = query.toString();
  permanentRedirect(`/leaderboard/${slug}${qs ? `?${qs}` : ""}`);
}
