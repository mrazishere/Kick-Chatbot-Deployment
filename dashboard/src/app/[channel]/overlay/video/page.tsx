import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";
import { validVideoOverlayKey } from "@/lib/video-overlay";
import VideoOverlay from "@/components/VideoOverlay";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Video overlay", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// A browser source for OBS: the YouTube videos viewers pay for with $<cmd> video play
// here, with sound, one at a time; the page is clear in between. ?key= is required.
export default async function VideoOverlayPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const raw = (await searchParams).key;
  const key = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  if (!validChannel(slug) || !validVideoOverlayKey(slug, key)) notFound();
  return (
    <>
      <style>{"html,body{background:transparent!important;overflow:hidden;margin:0}"}</style>
      <VideoOverlay channel={slug} overlayKey={key} />
    </>
  );
}
