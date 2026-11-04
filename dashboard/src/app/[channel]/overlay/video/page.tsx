import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";
import { validVideoOverlayKey } from "@/lib/video-overlay";
import { logOverlayLoad } from "@/lib/overlay-load-log";
import VideoOverlay from "@/components/VideoOverlay";
import OverlayKeyRecover from "@/components/OverlayKeyRecover";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Video overlay", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

// A browser source for OBS: the YouTube videos viewers pay for with $<cmd> video play
// here, with sound, one at a time; the page is clear in between. ?key= is required
// (or the overlay's own cookie, after a refresh by hand).
export default async function VideoOverlayPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const q = await searchParams;
  const raw = q.key;
  const given = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  // No key in the link: the overlay takes it out of the address bar (VideoOverlay), so a refresh
  // by hand comes here. The overlay keeps it in a cookie for this page's path; failing that, the
  // tab's storage holds the link it was opened with (OverlayKeyRecover).
  const kept = given ? "" : (await cookies()).get("vo-key")?.value ?? "";
  const key = given || kept;
  const ok = validChannel(slug) && validVideoOverlayKey(slug, key);
  const recover = !ok && validChannel(slug) && !given;
  await logOverlayLoad(slug, "video", ok ? (kept ? "ok-cookie" : "ok") : recover ? "recover" : "404", given, q);
  if (recover) return <OverlayKeyRecover />;
  if (!ok) notFound();
  return (
    <>
      <style>{"html,body{background:transparent!important;overflow:hidden;margin:0}"}</style>
      <VideoOverlay channel={slug} overlayKey={key} />
    </>
  );
}
