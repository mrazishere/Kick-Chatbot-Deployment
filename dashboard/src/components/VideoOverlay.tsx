"use client";

import { useEffect, useRef, useState } from "react";
import { isStale, reloadInto, rememberUrl, withBuild } from "@/lib/overlay-build";
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
type MediaShare = { key: string; videoId: string; title: string; username: string; end: number; position: number; at: number; paused: boolean; hidden?: boolean; exact?: boolean };
/** Seek when the overlay is this far off media share. */
const DRIFT_S = 1.5;
/** Following the phone player's own reports, which are exact: this far off and it seeks. */
const EXACT_DRIFT_S = 0.3;
/** And not again sooner than this after a seek, which takes a moment to land. */
const SEEK_GAP_MS = 3_000;

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
  loadModule(name: string): void;
  unloadModule(name: string): void;
  setOption(module: string, option: string, value: unknown): void;
  getOption(module: string, option: string): unknown;
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
  /**
   * points.video.mediashareDelaySeconds, in ms: media share's sound reaches the stream this late
   * (an IRL phone's, ingested with the camera), so everything it reports, a new video, a pause,
   * the end, is applied this much later, and the video plays this far behind it.
   */
  const delayMs = useRef(0);
  /** When the player last seeked to catch up (performance.now()). */
  const lastSeek = useRef(0);
  /** Media share as each poll found it, waiting to be applied once delayMs has passed. */
  const pending = useRef<Array<{ ms: MediaShare | null; due: number }>>([]);
  /** Media share is paused (on StreamElements, or held with !media pause): the overlay hides meanwhile. */
  const [msPaused, setMsPaused] = useState(false);
  /** The phone player hid the overlay for this one (audio only): it plays on unseen, in step. */
  const [msHidden, setMsHidden] = useState(false);
  /** The browser wouldn't play it with sound (a normal tab, before any click): it plays muted until clicked. OBS never needs this. */
  const [muted, setMuted] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const url = `${BASE_PATH}/api/overlay/${encodeURIComponent(channel)}/video?key=${encodeURIComponent(overlayKey)}${embedded ? "&in=fishing" : ""}`;
  /** How far the bot's clock is ahead of this machine's, from the last poll. */
  const offset = useRef(0);
  /** The channel's player volume (0–100), from the feed; applied as it changes. */
  const volume = useRef(50);
  /** YouTube's subtitles over the video (media share: the phone player's switch); off unless asked. */
  const captions = useRef(false);
  const applyCaptions = (p: YTPlayer | null) => {
    if (!p) return;
    try {
      if (captions.current) {
        // Loading the module isn't enough mid-video: a track has to be picked (English if there is one).
        p.loadModule("captions");
        const list = p.getOption("captions", "tracklist") as Array<{ languageCode?: string }> | undefined;
        const pick = list?.find((t) => t.languageCode?.startsWith("en")) ?? list?.[0];
        if (pick?.languageCode) p.setOption("captions", "track", { languageCode: pick.languageCode });
      } else {
        p.setOption("captions", "track", {});
        p.unloadModule("captions");
      }
    } catch {
      // not loaded yet: onApiChange tries again
    }
  };
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
    // A reload into a new build goes back to the URL as opened, key and all.
    if (!embedded) rememberUrl();
    if (!embedded && window.location.search) window.history.replaceState(null, "", window.location.pathname);
  }, [embedded]);

  // Follow the bot: what's on, every second.
  useEffect(() => {
    let alive = true;
    let t: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let off = false;
      try {
        const res = await fetch(withBuild(url), { cache: "no-store" });
        off = !res.ok;
        if (!res.ok) {
          setCurrent(null);
          return;
        }
        const data = (await res.json()) as { now: number; current: Current | null; mediashare?: MediaShare | null; delayMs?: number; captions?: boolean; build?: string; volume?: number; wheels?: FishOverlayEvent[] };
        if (!alive) return;
        offset.current = data.now - Date.now();
        if (typeof data.volume === "number" && data.volume !== volume.current) {
          volume.current = Math.max(0, Math.min(100, data.volume));
          if (player.current && !player.current.isMuted()) player.current.setVolume(volume.current);
        }
        if ((data.captions === true) !== captions.current) {
          captions.current = data.captions === true;
          applyCaptions(player.current);
        }
        if (data.mediashare !== undefined) {
          // Following media share, delayMs behind: applied by applyDue below.
          delayMs.current = Math.max(0, Math.min(15_000, data.delayMs ?? 0));
          pending.current.push({ ms: data.mediashare, due: Date.now() + delayMs.current });
          applyDue();
        } else {
          pending.current = [];
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
        // Not mid media share video either: its feed is never `current`.
        if (!embedded && !data.current && !sync.current && !wheelBusy() && isStale(data.build)) reloadInto(data.build!, url, 0);
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

  /** Where the overlay should be in media share's video now, by the bot's clock, delayMs behind it, in seconds. */
  const syncTarget = (): number | null => {
    const ms = sync.current;
    if (!ms) return null;
    return ms.paused ? ms.position : ms.position + (Date.now() + offset.current - ms.at - delayMs.current) / 1000;
  };
  /** Apply the newest media share report that's due: a new video only when its key changes; play, pause and position each time. */
  const applyDue = () => {
    const now = Date.now();
    let due: { ms: MediaShare | null } | null = null;
    while (pending.current.length && pending.current[0].due <= now) due = pending.current.shift()!;
    if (!due) return;
    const ms = due.ms;
    sync.current = ms;
    setMsPaused(!!ms?.paused);
    setMsHidden(!!ms?.hidden);
    setCurrent((c) => (ms ? (c?.id === ms.key ? c : { id: ms.key, videoId: ms.videoId, title: ms.title, username: ms.username, start: 0, seconds: ms.end, startedAt: 0, sync: true }) : null));
    follow();
  };
  // With a delay, reports come due between polls.
  useEffect(() => {
    const t = setInterval(() => {
      if (pending.current.length) applyDue();
    }, 200);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
    // Exact reports (the phone player's) are held tight; a guess from StreamElements loosely.
    const drift = ms.exact ? EXACT_DRIFT_S : DRIFT_S;
    const seek = () => {
      if (Math.abs(p.getCurrentTime() - target) <= drift || performance.now() - lastSeek.current < SEEK_GAP_MS) return;
      lastSeek.current = performance.now();
      p.seekTo(target, true);
    };
    if (ms.paused) {
      if (st === window.YT.PlayerState.PLAYING || st === window.YT.PlayerState.BUFFERING) p.pauseVideo();
      seek();
      return;
    }
    // Still loading after a seek: it lands where it was sent; measuring now would only send it again.
    if (st !== window.YT.PlayerState.BUFFERING) seek();
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
    // Already over (media share still names the last video): no empty box left up.
    if (into >= current.seconds) {
      if (current.seconds > 0) setEnded(current.id);
      return;
    }
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
          autoplay: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, ...(captions.current ? { cc_load_policy: 1 } : {}), modestbranding: 1, rel: 0, playsinline: 1,
          start: Math.floor(current.start + into), ...(current.seconds > 0 ? { end: current.start + current.seconds } : {}),
        },
        events: {
          // The captions module loads after the player is ready: set them once it's there.
          onApiChange: (e: { target: YTPlayer }) => applyCaptions(e.target),
          onReady: (e: { target: YTPlayer }) => {
            applyCaptions(e.target);
            e.target.unMute();
            e.target.setVolume(volume.current);
            e.target.playVideo();
            // Media share may have moved on (or paused) while the player loaded.
            if (current.sync) setTimeout(() => !gone && follow(), 300);
            // A browser that blocks sound without a click leaves it paused: play it muted instead
            // (a click on it brings the sound back). Not while media share is paused: that pause is ours.
            setTimeout(() => {
              if (gone || (current.sync && sync.current?.paused)) return;
              const st = e.target.getPlayerState();
              if (st !== window.YT?.PlayerState.PLAYING && st !== window.YT?.PlayerState.BUFFERING && st !== window.YT?.PlayerState.ENDED) {
                e.target.mute();
                e.target.playVideo();
                setMuted(true);
              }
            }, 3000);
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

  const showing = current !== null && ended !== current.id && !(current.sync && (msPaused || msHidden));
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
