import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";
import { overlayStyleFor } from "@/lib/fish-overlay";
import { loadPublicLeaderboard } from "@/lib/public-leaderboard";
import type { DemoOdds } from "@/lib/fish-demo";
import FishOverlay from "@/components/FishOverlay";
import FishOverlayCards from "@/components/FishOverlayCards";
import VideoOverlay from "@/components/VideoOverlay";
import { videoOverlayKey } from "@/lib/video-overlay";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Fishing overlay", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// A browser source for OBS: fishing plays out as a small animated scene over a transparent page.
// ?key= is required, and picks the look: the scene, or the earlier text cards.
// Optional: max=lanes (scene) or cards, scale=0.5–3, wheel=1 (a made-up prize wheel spin every 25s), demo=1 (with steals=1, 3 in 10 demo replies are steals; the channel can shut the demo out, which the feed tells the overlay); side=left|right for cards.
export default async function FishOverlayPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const q = await searchParams;
  const key = one(q.key) ?? "";
  const style = validChannel(slug) ? overlayStyleFor(slug, key) : null;
  if (!style) notFound();

  const scale = Math.min(3, Math.max(0.5, Number(one(q.scale)) || 1));
  const demo = one(q.demo) === "1";
  // duel=1 plays a made-up fish duel now and then, to see how one looks in the source.
  const duelDemo = one(q.duel) === "1";
  // wheel=1 spins a made-up prize wheel now and then, to place it in the source.
  const wheelDemo = one(q.wheel) === "1";
  // The demo rolls at the channel's own odds, from what its public leaderboard shows.
  let demoOdds: DemoOdds | null = null;
  if (demo) {
    const board = await loadPublicLeaderboard(slug);
    const f = board.kind === "ok" ? board.data.fishing : null;
    // steals=1 is for reviewing them: on even where stealing is off, and 3 in 10 replies.
    const review = one(q.steals) === "1";
    if (f) demoOdds = { catchOdds: f.catchOdds, fish: f.fish, junk: f.junk, steal: f.steal || review, ...(review ? { stealShare: 0.3 } : {}) };
  }
  const videoKey = videoOverlayKey(slug);
  return (
    <>
      <style>{"html,body{background:transparent!important;overflow:hidden}"}</style>
      {style === "cards" ? (
        <FishOverlayCards
          channel={slug}
          overlayKey={key}
          side={one(q.side) === "right" ? "right" : "left"}
          max={Math.min(8, Math.max(1, Math.round(Number(one(q.max)) || 5)))}
          scale={scale}
          demo={demo}
          demoOdds={demoOdds}
          duelDemo={duelDemo}
          wheelDemo={wheelDemo}
        />
      ) : (
        <FishOverlay
          channel={slug}
          overlayKey={key}
          max={Math.min(10, Math.max(1, Math.round(Number(one(q.max)) || 6)))}
          scale={scale}
          demo={demo}
          demoOdds={demoOdds}
          duelDemo={duelDemo}
          wheelDemo={wheelDemo}
        />
      )}
      {/* Paid videos, while the channel tests them here before adding the video overlay to OBS (points.video.onFishOverlay). */}
      {videoKey ? <VideoOverlay channel={slug} overlayKey={videoKey} embedded /> : null}
    </>
  );
}
