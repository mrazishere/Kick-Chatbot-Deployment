"use client";

import { useEffect, useRef, useState } from "react";
import { isStale, reloadInto } from "@/lib/overlay-build";
import { useWheel } from "@/components/FishWheelStage";
import type { FishOverlayEvent } from "@/lib/bot-api";

// The video overlay (a browser source): plays the YouTube video the bot says is on,
// with sound, through YouTube's IFrame player, and is clear when nothing is. The bot
// keeps the queue; this page only follows it, asking every second.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const POLL_MS = 1000;
/** The bot's slot for a video includes this long for the player to load (LOAD_PAD_MS in the bot). */
const LOAD_PAD_S = 4;

/**
 * The video on now. A paid one (id a number) plays from `start` for `seconds` from `startedAt`.
 * A media share one (id StreamElements' key) follows `sync` instead: it ends at `seconds` into the video.
 */
type Current = { id: number | string; videoId: string; title: string; username: string; start: number; seconds: number; startedAt: number; sync?: boolean };
/** What StreamElements media share is playing, as the bot keeps it (community/mediashare.ts). */
type MediaShare = { key: string; videoId: string; title: string; username: string; end: number; position: number; at: number; paused: boolean };
/** Seek when the overlay is this far off media share. */
const DRIFT_S = 1.5;

interface YTPlayer {
  destroy(): void;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(v: number): void;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}
declare global {
  interface Window {
    YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: { ENDED: number; PLAYING: number; BUFFERING: number; PAUSED: number; CUED: number } };
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

/**
 * `embedded`: inside the fishing overlay, for a channel testing videos before it adds the
 * video overlay to OBS. A centered 16:9 box 60% wide, fed only while the channel has
 * points.video.onFishOverlay on; otherwise it stays empty and asks rarely.
 */
export default function VideoOverlay({ channel, overlayKey, embedded = false }: { channel: string; overlayKey: string; embedded?: boolean }) {
  const [current, setCurrent] = useState<Current | null>(null);
  const [ended, setEnded] = useState<number | string | null>(null);
  /** The media share position as the bot last said, for following it between polls. */
  const sync = useRef<MediaShare | null>(null);
  /** The browser wouldn't play it with sound (a normal tab, before any click): it plays muted until clicked. OBS never needs this. */
  const [muted, setMuted] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const url = `${BASE_PATH}/api/overlay/${encodeURIComponent(channel)}/video?key=${encodeURIComponent(overlayKey)}${embedded ? "&in=fishing" : ""}`;
  /** How far the bot's clock is ahead of this machine's, from the last poll. */
  const offset = useRef(0);
  /** The channel's player volume (0–100), from the feed; applied as it changes. */
  const volume = useRef(50);
  // The prize wheel, where the channel spins it here (wheel onVideoOverlay): over the video, which pauses meanwhile.
  const wheel = useWheel({ fontPx: 64 });
  const takeWheel = wheel.take;
  const wheelBusy = wheel.busy;
  const wheelShowing = wheel.isShowing;
  /** The newest spin already seen; null until the first poll, which only notes it (no replays on load). */
  const wheelSeen = useRef<number | null>(null);

  // YouTube's player reports the page's address to YouTube: keep the overlay key out of
  // it. The feed is asked with the key from props, and OBS reloads its own saved link.
  useEffect(() => {
    // Inside the fishing overlay the address is the fishing page's, which keeps its own query.
    if (!embedded && window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [embedded]);

  // Follow the bot: what's on, every second.
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let off = false;
      try {
        const res = await fetch(url, { cache: "no-store" });
        off = !res.ok;
        if (!res.ok) {
          setCurrent(null);
          return;
        }
        const data = (await res.json()) as { now: number; current: Current | null; mediashare?: MediaShare | null; build?: string; volume?: number; wheels?: FishOverlayEvent[] };
        if (!alive) return;
        offset.current = data.now - Date.now();
        if (typeof data.volume === "number" && data.volume !== volume.current) {
          volume.current = Math.max(0, Math.min(100, data.volume));
          if (player.current && !player.current.isMuted()) player.current.setVolume(volume.current);
        }
        if (data.mediashare !== undefined) {
          // Following media share: a new video only when its key changes; play, pause and position each poll.
          const ms = data.mediashare;
          sync.current = ms;
          setCurrent((c) => (ms ? (c?.id === ms.key ? c : { id: ms.key, videoId: ms.videoId, title: ms.title, username: ms.username, start: 0, seconds: ms.end, startedAt: 0, sync: true }) : null));
          follow();
        } else {
          sync.current = null;
          setCurrent((c) => (c?.id === data.current?.id ? c : data.current));
        }
        const spins = data.wheels ?? [];
        const newest = spins.reduce((m, e) => Math.max(m, e.id), wheelSeen.current ?? 0);
        if (wheelSeen.current !== null) {
          const fresh = spins.filter((e) => e.id > wheelSeen.current!);
          if (fresh.length) takeWheel(fresh);
        }
        wheelSeen.current = newest;
        // A newer dashboard build is live: reload into it between videos and spins (the fishing overlay does its own).
        if (!embedded && !data.current && !wheelBusy() && isStale(data.build)) reloadInto(data.build!, url, 0);
      } catch {
        // offline for a moment; the next poll catches up
      } finally {
        // Embedded and switched off: ask again now and then, in case the test starts.
        if (alive) t = setTimeout(poll, off && embedded ? 10_000 : POLL_MS);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [url, embedded, takeWheel, wheelBusy]);

  /** Where media share is in its video now, by the bot's clock, in seconds. */
  const syncTarget = (): number | null => {
    const ms = sync.current;
    if (!ms) return null;
    return ms.paused ? ms.position : ms.position + (Date.now() + offset.current - ms.at) / 1000;
  };
  /** Keep the player where media share is: paused with it, playing with it, and within DRIFT_S of it. */
  const follow = () => {
    const p = player.current;
    const ms = sync.current;
    const target = syncTarget();
    // A wheel spin holds the video where it is; it catches up after.
    if (!p || !ms || target === null || !window.YT || wheelShowing()) return;
    const st = p.getPlayerState();
    // For checking from outside: the player's state and second, against where media share is.
    holder.current?.setAttribute("data-follow", `${st}@${Math.round(p.getCurrentTime())}/${Math.round(target)}`);
    if (ms.paused) {
      if (st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.BUFFERING) p.pauseVideo();
      if (Math.abs(p.getCurrentTime() - target) > DRIFT_S) p.seekTo(target, true);
      return;
    }
    if (Math.abs(p.getCurrentTime() - target) > DRIFT_S) p.seekTo(target, true);
    if (st === window.YT.PlayerState.PAUSED || st === window.YT.PlayerState.CUED) p.playVideo();
  };

  // A spin pauses the video; it carries on once the wheel is gone (the bot stretched its slot to match).
  useEffect(() => {
    const p = player.current;
    if (!p) return;
    if (wheel.showing) p.pauseVideo();
    else if (p.getPlayerState() === window.YT?.PlayerState.PAUSED) p.playVideo();
  }, [wheel.showing]);

  // Play the current video: from its start time, or as far in as its slot already is
  // (a page that loads mid-video picks it up), and only to its last paid second.
  useEffect(() => {
    player.current?.destroy();
    player.current = null;
    setMuted(false);
    if (!current || !holder.current) return;
    // Media share: start where it is. A paid video: as far into its slot as it already is.
    const into = current.sync
      ? Math.max(0, syncTarget() ?? 0)
      : Math.max(0, (Date.now() + offset.current - current.startedAt) / 1000 - LOAD_PAD_S);
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
          start: Math.floor(current.start + into), ...(current.seconds > 0 ? { end: current.start + current.seconds } : {}),
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            e.target.unMute();
            e.target.setVolume(volume.current);
            e.target.playVideo();
            // Media share may have moved on (or paused) while the player loaded.
            if (current.sync) setTimeout(() => !gone && follow(), 300);
            // A browser that blocks sound without a click leaves it paused: play it muted instead.
            setTimeout(() => {
              if (gone) return;
              const st = e.target.getPlayerState();
              if (st !== window.YT?.PlayerState.PLAYING && st !== window.YT?.PlayerState.BUFFERING && st !== window.YT?.PlayerState.ENDED) {
                e.target.mute();
                e.target.playVideo();
                setMuted(true);
              }
            }, 1500);
          },
          onStateChange: (e: { data: number }) => {
            if (e.data === window.YT?.PlayerState.ENDED) setEnded(current.id);
          },
          // Removed, private, or no longer embeddable: the bot ends it and refunds the viewer (a paid one).
          onError: () => {
            setEnded(current.id);
            if (current.sync) return;
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
  const sound = () => {
    if (!muted) return;
    player.current?.unMute();
    player.current?.setVolume(volume.current);
    setMuted(false);
  };
  return (
    <>
    <div
      onClick={sound}
      style={{
        position: "fixed", opacity: showing ? 1 : 0, transition: "opacity .4s", fontFamily: "Inter, system-ui, sans-serif", zIndex: 50,
        pointerEvents: showing ? "auto" : "none",
        ...(embedded
          ? { left: "20%", width: "60%", top: "50%", transform: "translateY(-50%)", aspectRatio: "16 / 9", borderRadius: 12, overflow: "hidden", boxShadow: "0 8px 40px rgba(0,0,0,.6)" }
          : { inset: 0 }),
      }}
    >
      <div ref={holder} style={{ position: "absolute", inset: 0, background: "#000" }} />
      {muted && showing ? (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", cursor: "pointer" }}>
          <span style={{ background: "rgba(0,0,0,.7)", color: "#fff", padding: "1vh 2vw", borderRadius: 8, fontSize: "3vh", fontWeight: 700 }}>🔇 Click for sound</span>
        </div>
      ) : null}
      {current ? (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "1.2vh 1.6vw", background: "linear-gradient(transparent, rgba(0,0,0,.75))", color: "#fff", fontSize: "2.6vh", fontWeight: 700, textShadow: "0 1px 3px #000", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          📺 <span style={{ color: "#53FC18" }}>{current.username}</span> · {current.title}
        </div>
      ) : null}
    </div>
      <div style={{ position: "relative", zIndex: 100 }}>{wheel.stage}</div>
    </>
  );
}
