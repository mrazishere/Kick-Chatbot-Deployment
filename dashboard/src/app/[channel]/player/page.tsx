import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";
import { validMediaPlayerKey } from "@/lib/media-player";
import MediaPlayer from "@/components/MediaPlayer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Media share player", robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0a0a0a" };

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// The media share phone player: plays the channel's StreamElements media share queue with
// sound, on the streamer's phone, and the video overlay follows it. ?key= is required.
export default async function MediaPlayerPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const raw = (await searchParams).key;
  const key = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (!validChannel(slug) || !validMediaPlayerKey(slug, key)) notFound();
  return <MediaPlayer channel={slug} playerKey={key} />;
}
