"use client";

import { useEffect, useRef, useState } from "react";
import { isStale, reloadInto } from "@/lib/overlay-build";

// The video overlay (a browser source): plays the YouTube video the bot says is on,
// with sound, through YouTube's IFrame player, and is clear when nothing is. The bot
// keeps the queue; this page only follows it, asking every second.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const POLL_MS = 1000;
/** The bot's slot for a video includes this long for the player to load (LOAD_PAD_MS in the bot). */
const LOAD_PAD_S = 4;

type Current = { id: number; videoId: string; title: string; username: string; start: number; seconds: number; startedAt: number };

interface YTPlayer {
  destroy(): void;
  unMute(): void;
  setVolume(v: number): void;
  playVideo(): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: { ENDED: number } };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** YouTube's IFrame API, loaded once. */
let apiReady: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve) => {
    if (window.YT?.Player) return resolve();
    window.onYouTubeIframeAPIReady = () => resolve();
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiReady;
}

export default function VideoOverlay({ channel, overlayKey }: { channel: string; overlayKey: string }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [ended, setEnded] = useState<number | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const url = `${BASE_PATH}/api/overlay/${encodeURIComponent(channel)}/video?key=${encodeURIComponent(overlayKey)}`;
  /** How far the bot's clock is ahead of this machine's, from the last poll. */
  const offset = useRef(0);

  // YouTube's player reports the page's address to YouTube: keep the overlay key out of
  // it. The feed is asked with the key from props, and OBS reloads its own saved link.
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, []);

  // Follow the bot: what's on, every second.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { now: number; current: Current | null; build?: string };
        if (!alive) return;
        offset.current = data.now - Date.now();
        setCurrent((c) => (c?.id === data.current?.id ? c : data.current));
        // A newer dashboard build is live: reload into it between videos.
        if (!data.current && isStale(data.build)) reloadInto(data.build!, url, 0);
      } catch {
        // offline for a moment; the next poll catches up
      }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [url]);

  // Play the current video: from its start time, or as far in as its slot already is
  // (a page that loads mid-video picks it up), and only to its last paid second.
  useEffect(() => {
    player.current?.destroy();
    player.current = null;
    if (!current || !holder.current) return;
    const into = Math.max(0, (Date.now() + offset.current - current.startedAt) / 1000 - LOAD_PAD_S);
    if (into >= current.seconds) return;
    const el = document.createElement("div");
    holder.current.replaceChildren(el);
    let gone = false;
    void loadApi().then(() => {
      if (gone || !window.YT) return;
      player.current = new window.YT.Player(el, {
        width: "100%",
        height: "100%",
        videoId: current.videoId,
        playerVars: {
          autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, rel: 0, playsinline: 1,
          start: Math.floor(current.start + into), end: current.start + current.seconds,
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            e.target.unMute();
            e.target.setVolume(100);
            e.target.playVideo();
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === window.YT?.PlayerState.ENDED) setEnded(current.id);
          },
          // Removed, private, or no longer embeddable: the bot ends it and refunds the viewer.
          onError: () => {
            setEnded(current.id);
            void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: current.id }) }).catch(() => {});
          },
        },
      });
    });
    return () => {
      gone = true;
    };
  }, [current, url]);

  const showing = current !== null && ended !== current.id;
  return (
    <div style={{ position: "fixed", inset: 0, opacity: showing ? 1 : 0, transition: "opacity .4s", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div ref={holder} style={{ position: "absolute", inset: 0, background: "#000" }} />
      {current ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "1.2vh 1.6vw", background: "linear-gradient(transparent, rgba(0,0,0,.75))", color: "#fff", fontSize: "2.6vh", fontWeight: 700, textShadow: "0 1px 3px #000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          📺 <span style={{ color: "#53FC18" }}>{current.username}</span> · {current.title}
        </div>
      ) : null}
    </div>
  );
}
