import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { validChannel } from "@/lib/bot-auth";
import { overlayStyleFor } from "@/lib/fish-overlay";
import FishOverlay from "@/components/FishOverlay";
import FishOverlayCards from "@/components/FishOverlayCards";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Fishing overlay", robots: { index: false, follow: false } };

type Props = {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

// A browser source for OBS: fishing plays out as a small animated scene over a transparent page.
// ?key= is required, and picks the look: the scene, or the earlier text cards.
// Optional: max=lanes (scene) or cards, scale=0.5–3, demo=1; side=left|right for cards.
export default async function FishOverlayPage({ params, searchParams }: Props) {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const q = await searchParams;
  const key = one(q.key) ?? "";
  const style = validChannel(slug) ? overlayStyleFor(slug, key) : null;
  if (!style) notFound();

  const scale = Math.min(3, Math.max(0.5, Number(one(q.scale)) || 1));
  const demo = one(q.demo) === "1";
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
        />
      ) : (
        <FishOverlay
          channel={slug}
          overlayKey={key}
          max={Math.min(10, Math.max(1, Math.round(Number(one(q.max)) || 6)))}
          scale={scale}
          demo={demo}
        />
      )}
    </>
  );
}
