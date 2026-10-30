"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// The media share phone player: plays the channel's StreamElements media share queue with
// sound, where an app's player would (on the streamer's phone, in a split screen), and
// reports every second where it is, so the video overlay follows it exactly: a pause here
// pauses and hides the overlay. It moves the queue on through StreamElements, so chat's
// !pause, !play and !skip work on it too.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
/** This page's build: a newer one answering means there's an update to reload into. */
const BUILD_ID = process.env.DASH_BUILD_ID ?? "";
/** How often it reports and asks what's up. */
const TICK_MS = 1_000;

type Song = { key: string; videoId: string; title: string; username: string; start: number; end: number; amount: number | null; tip: boolean; duration?: number; songKey?: string };
type Sync = { build?: string; active: boolean; otherActive: boolean; now: number; playing: Song | null; queue: Song[]; history: Song[]; state: "playing" | "paused"; resume: number | null; hidden: boolean; captions: boolean; acted: boolean | null; edit?: string | null; failures?: Failure[]; warnings?: Record<string, string> };
type Failure = { key: string; videoId: string; title: string; username: string; seconds: number; code: number; reason: string; at: number };
type Alt = { videoId: string; title: string; channel: string; durationS: number };
type Action = { type: "next" | "skip" | "play" | "pause" | "replay" | "hide" | "show" | "captions-on" | "captions-off" | "front" | "remove"; key?: string; error?: number };

interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number; endSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(v: number): void;
  getPlayerState(): number;
  getCurrentTime(): number;
  destroy(): void;
}
/** YouTube's IFrame API on window (VideoOverlay declares it globally with a narrower player). */
type YTApi = { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; PlayerState: { ENDED: number; PLAYING: number; BUFFERING: number; PAUSED: number; CUED: number } };
const win = () => window as unknown as { YT?: YTApi; onYouTubeIframeAPIReady?: () => void };

let apiReady: Promise<void> | null = null;
function loadApi(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise((resolve) => {
    if (win().YT?.Player) return resolve();
    const before = win().onYouTubeIframeAPIReady;
    win().onYouTubeIframeAPIReady = () => {
      before?.();
      resolve();
    };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  });
  return apiReady;
}

/** A per-phone setting, kept in this browser. */
function stored(name: string, fallback: number): number {
  try {
    const v = Number(window.localStorage.getItem(`media-player:${name}`));
    return Number.isFinite(v) && window.localStorage.getItem(`media-player:${name}`) !== null ? v : fallback;
  } catch {
    return fallback;
  }
}
function store(name: string, v: number): void {
  try {
    window.localStorage.setItem(`media-player:${name}`, String(v));
  } catch {
    // private window: it's just not remembered
  }
}

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
};

export default function MediaPlayer({ channel, playerKey }: { channel: string; playerKey: string }) {
  const url = `${BASE_PATH}/api/player/${encodeURIComponent(channel)}?key=${encodeURIComponent(playerKey)}`;
  const altUrl = `${BASE_PATH}/api/player/${encodeURIComponent(channel)}/alternatives?key=${encodeURIComponent(playerKey)}`;
  const holder = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const [ready, setReady] = useState(false);
  /** Tapped Start: a phone only plays with sound after a tap. */
  const [started, setStarted] = useState(false);
  const startedRef = useRef(false);
  const [sync, setSync] = useState<Sync | null>(null);
  const syncRef = useRef<Sync | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** A short line after a button, like a replay asked for. */
  const [note, setNote] = useState<string | null>(null);
  /** The phone muted or held a new video and wouldn't let it go without a tap. */
  const [needTap, setNeedTap] = useState(false);
  /** A newer dashboard build is live. Not reloaded by itself: that would cut the sound and need Start again. */
  const [update, setUpdate] = useState(false);
  /** When the player was first seen stuck (muted, or not playing when it should), for the tap prompt. */
  const stuckSince = useRef(0);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 4000);
    return () => clearTimeout(t);
  }, [note]);
  /** Failed videos already dismissed here (by key), kept across reloads. */
  const dismissedKey = `mediashare-dismissed:${channel}`;
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(dismissedKey) ?? "[]") as unknown;
      if (Array.isArray(saved)) setDismissed(saved.filter((k): k is string => typeof k === "string"));
    } catch {
      // Nothing saved, or unreadable: show them all.
    }
  }, [dismissedKey]);
  const dismiss = (keys: string[]) => {
    const next = [...dismissed, ...keys].slice(-50);
    setDismissed(next);
    try {
      localStorage.setItem(dismissedKey, JSON.stringify(next));
    } catch {
      // Private browsing: dismissed for this visit only.
    }
  };
  const [tab, setTab] = useState<"queue" | "history">("queue");
  /** Show the video here too; off (always, on opening), only its sound plays (the stream has the overlay). */
  const [showVideo, setShowVideo] = useState(false);
  const [volume, setVolume] = useState(80);
  /** Stream Buddy's "Delay new request": seconds before a new video starts (an alert can finish first). */
  const [delay, setDelay] = useState(0);
  const delayRef = useRef(0);
  const [position, setPosition] = useState(0);
  /** Where the timeline is being dragged to (seconds into the song), until it's let go. */
  const [scrub, setScrub] = useState<number | null>(null);
  /** The song loaded in the player, and whether its start is still being delayed. */
  const loaded = useRef<{ key: string; startsAt: number; started: boolean; endAsked: boolean; played: boolean } | null>(null);
  /** Buttons pressed, sent one per call in order. */
  const pendingActions = useRef<Action[]>([]);
  /** Played anything since Start: from then on the overlay follows this page, paused or not. */
  const playedOnce = useRef(false);
  /** When it last asked for the first song in, so it asks once every few seconds at most. */
  const firstAsked = useRef(0);
  /** About how long a report takes to reach the bot (ms). */
  const oneWay = useRef(100);
  /** This page load, to the bot: only one page plays a queue at a time. */
  const session = useRef(Math.random().toString(36).slice(2) + Date.now().toString(36));
  /** This page is the one playing (the bot says); tapped Take over, for the next call. */
  const activeRef = useRef(false);
  const takeover = useRef(false);
  /** Found the queue taken, or lost it to another page: from then on this page only takes it on a tap. */
  const displaced = useRef(false);
  const [standby, setStandby] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    setVolume(stored("volume", 80));
    const d = stored("delay", 0);
    setDelay(d);
    delayRef.current = d;
  }, []);

  // The YouTube player, made once.
  useEffect(() => {
    let gone = false;
    void loadApi().then(() => {
      const YT = win().YT;
      if (gone || !holder.current || !YT) return;
      const el = document.createElement("div");
      holder.current.replaceChildren(el);
      player.current = new YT.Player(el, {
        width: "100%",
        height: "100%",
        playerVars: { autoplay: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, modestbranding: 1, rel: 0, playsinline: 1 },
        events: {
          onReady: () => setReady(true),
          onStateChange: (e: { data: number }) => {
            const l = loaded.current;
            if (e.data === win().YT?.PlayerState.ENDED && l && !l.endAsked) {
              l.endAsked = true;
              act({ type: "next", key: l.key });
            }
          },
          // Removed, private, region-locked or not embeddable: on to the next one.
          // YouTube's code goes with the skip, to the page and the bot's log (100 gone, 101/150 not embeddable).
          onError: (e: { data: number }) => {
            const l = loaded.current;
            if (l && !l.endAsked) {
              l.endAsked = true;
              act({ type: "skip", key: l.key, error: e.data });
            }
          },
        },
      });
    });
    return () => {
      gone = true;
      player.current?.destroy();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const volumeRef = useRef(80);
  useEffect(() => {
    volumeRef.current = volume;
    player.current?.setVolume(volume);
  }, [volume, ready]);

  /** In the tap itself, so the phone lets it play with sound. */
  const restore = () => {
    const p = player.current;
    if (!p) return;
    p.unMute();
    p.setVolume(volumeRef.current);
    p.playVideo();
    stuckSince.current = 0;
    setNeedTap(false);
  };

  const act = useCallback((a: Action) => {
    pendingActions.current.push(a);
    void tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Put the player in line with what's up: a new video, StreamElements' play or pause, a delayed start. */
  const reconcile = (s: Sync) => {
    const p = player.current;
    const YT = win().YT;
    if (!p || !YT || !startedRef.current) return;
    // Not the page playing the queue: silent until it takes over.
    if (!s.active) {
      if (p.getPlayerState() === YT.PlayerState.PLAYING) p.pauseVideo();
      setNeedTap(false);
      return;
    }
    const song = s.playing;
    if (!song) {
      if (loaded.current) {
        p.stopVideo();
        loaded.current = null;
      }
      // Playing, nothing up and the queue waiting: take the first one in (StreamElements' own player does).
      if (s.state === "playing" && s.queue.length > 0 && Date.now() - firstAsked.current > 5_000) {
        firstAsked.current = Date.now();
        act({ type: "next" });
      }
      return;
    }
    const now = Date.now();
    if (loaded.current?.key !== song.key) {
      // A new video: from where this player left it, or its start, after the delay.
      const from = s.resume ?? song.start;
      const wait = s.resume === null ? delayRef.current * 1000 : 0;
      loaded.current = { key: song.key, startsAt: now + wait, started: false, endAsked: false, played: false };
      const o = { videoId: song.videoId, startSeconds: from, ...(song.end > from ? { endSeconds: song.end } : {}) };
      if (wait > 0 || s.state === "paused") p.cueVideoById(o);
      else {
        p.loadVideoById(o);
        loaded.current.started = true;
      }
      return;
    }
    const l = loaded.current;
    const st = p.getPlayerState();
    if (s.state === "paused") {
      if (st === YT.PlayerState.PLAYING || st === YT.PlayerState.BUFFERING) p.pauseVideo();
      stuckSince.current = 0;
      setNeedTap(false);
      return;
    }
    if (!l.started) {
      if (now < l.startsAt) return;
      l.started = true;
    }
    if (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING && st !== YT.PlayerState.ENDED) p.playVideo();
    // A video started without a fresh tap can come up muted (YouTube plays it silently rather than
    // not at all), or not start: unmute it, and if the phone won't, ask for a tap after a moment.
    if (p.isMuted()) {
      p.unMute();
      p.setVolume(volumeRef.current);
    }
    const stuck = p.isMuted() || (st !== YT.PlayerState.PLAYING && st !== YT.PlayerState.BUFFERING && st !== YT.PlayerState.ENDED);
    if (!stuck) stuckSince.current = 0;
    else if (!stuckSince.current) stuckSince.current = now;
    setNeedTap(stuck && now - stuckSince.current > 2_500);
    // Past its paid end (a tip's end time): on to the next.
    if (song.end > 0 && p.getCurrentTime() >= song.end - 0.3 && !l.endAsked) {
      l.endAsked = true;
      act({ type: "next", key: l.key });
    }
  };

  const tick = async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const p = player.current;
      const l = loaded.current;
      const YT = win().YT;
      const claimed = takeover.current;
      // Where it is, for the overlay: once this page has played something since Start. Until then
      // the overlay mirrors StreamElements, so a tab left open and never played can't hide it.
      if (l && p && YT && p.getPlayerState() === YT.PlayerState.PLAYING) l.played = playedOnce.current = true;
      const report = startedRef.current && activeRef.current && p && l && YT && playedOnce.current
        ? { key: l.key, position: l.started ? p.getCurrentTime() : syncRef.current?.playing?.start ?? 0, paused: !l.started || p.getPlayerState() !== YT.PlayerState.PLAYING, hidden: false, latencyMs: Math.round(oneWay.current) }
        : undefined;
      const action = pendingActions.current.shift();
      const sent = performance.now();
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session: session.current, claim: startedRef.current && (!displaced.current || takeover.current), takeover: takeover.current, report, action }), cache: "no-store" });
      // Half the round trip, smoothed: about how long a report takes to reach the bot.
      oneWay.current = oneWay.current * 0.7 + ((performance.now() - sent) / 2) * 0.3;
      const data = (await res.json().catch(() => null)) as (Sync & { error?: string }) | null;
      if (!res.ok || !data || data.error) {
        setError(data?.error ?? `The bot answered ${res.status}`);
        return;
      }
      setError(null);
      if (claimed) takeover.current = false;
      if (data.active) displaced.current = false;
      else if (startedRef.current && (activeRef.current || data.otherActive)) displaced.current = true;
      setStandby(startedRef.current && !data.active && displaced.current);
      // Another page took the queue over: go quiet, and drop the video so taking it back picks
      // it up where that page got to.
      if (activeRef.current && !data.active && player.current) {
        player.current.pauseVideo();
        loaded.current = null;
      }
      activeRef.current = data.active;
      setUpdate(!!BUILD_ID && !!data.build && data.build !== BUILD_ID);
      if (action?.type === "replay" && data.acted === false) setNote("Couldn't replay that one: it may have left the history");
      if ((action?.type === "front" || action?.type === "remove") && data.acted === false) {
        setNote(
          data.edit === "readded" ? "StreamElements wouldn't play it now, so it's back at the end of the queue (as the channel)"
            : data.edit === "lost" ? "StreamElements lost that song: add it again (its details are in the bot's log)"
              : data.edit === "failed" ? "StreamElements didn't answer; try again"
                : "That one isn't in the queue any more",
        );
      }
      syncRef.current = data;
      setSync(data);
      reconcile(data);
    } catch {
      setError("Can't reach the bot; trying again");
    } finally {
      busy.current = false;
      // More buttons pressed meanwhile: send them now, not at the next second.
      if (pendingActions.current.length) setTimeout(() => void tick(), 0);
    }
  };

  useEffect(() => {
    void tick();
    const t = setInterval(() => void tick(), TICK_MS);
    const pos = setInterval(() => {
      const p = player.current;
      if (p && loaded.current?.started) setPosition(p.getCurrentTime());
    }, 500);
    return () => {
      clearInterval(t);
      clearInterval(pos);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the screen on while it plays.
  useEffect(() => {
    if (!started) return;
    type Lock = { release(): Promise<void> };
    let lock: Lock | null = null;
    const take = async () => {
      try {
        lock = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<Lock> } }).wakeLock?.request("screen") ?? null;
      } catch {
        // not offered here
      }
    };
    void take();
    const again = () => document.visibilityState === "visible" && void take();
    document.addEventListener("visibilitychange", again);
    return () => {
      document.removeEventListener("visibilitychange", again);
      void lock?.release().catch(() => {});
    };
  }, [started]);

  const start = () => {
    const p = player.current;
    if (!p) return;
    // In the tap itself, so the phone lets it play with sound.
    p.unMute();
    p.setVolume(volume);
    startedRef.current = true;
    setStarted(true);
    if (syncRef.current?.playing) reconcile(syncRef.current);
    else {
      p.playVideo();
      p.pauseVideo();
    }
  };

  /** Pause or play now, on the phone, and on StreamElements for the overlay and chat. */
  const toggle = () => {
    const p = player.current;
    const s = syncRef.current;
    if (!p || !s) return;
    const pausing = s.state !== "paused";
    if (pausing) p.pauseVideo();
    else if (loaded.current?.started) p.playVideo();
    const next = { ...s, state: pausing ? ("paused" as const) : ("playing" as const) };
    syncRef.current = next;
    setSync(next);
    act({ type: pausing ? "pause" : "play" });
  };

  const song = sync?.playing ?? null;
  const failures = (sync?.failures ?? []).filter((f) => !dismissed.includes(f.key)).reverse();
  const paused = sync?.state === "paused";
  const waiting = song && loaded.current?.key === song.key && !loaded.current.started && !paused;
  const length = song ? Math.max(0, song.end - song.start) : 0;
  const into = song ? Math.max(0, Math.min(length, position - song.start)) : 0;
  /** Only once the video is going here: a seek on a cued one would start it. */
  const canSeek = started && !standby && !!song && loaded.current?.key === song.key && loaded.current.started;

  /** Jump to this many seconds into the song; the overlay follows from the next report. */
  const seek = (secs: number) => {
    const p = player.current;
    const l = loaded.current;
    setScrub(null);
    if (!p || !song || !l || l.key !== song.key || !l.started) return;
    // Short of the end, or it would count as finished and move the queue on.
    const to = song.start + Math.max(0, Math.min(length - 1, secs));
    p.seekTo(to, true);
    setPosition(to);
    l.endAsked = false;
  };
  const list = tab === "queue" ? sync?.queue ?? [] : sync?.history ?? [];
  /** Why a row won't play (queue, checked ahead) or didn't (history, what the player hit), dismissed or not. */
  const rowProblem = (s: Song): string | undefined =>
    tab === "queue" ? sync?.warnings?.[s.key] : sync?.failures?.find((f) => f.key === (s.songKey ?? s.key))?.reason;

  return (
    <main className="min-h-screen bg-neutral-950 px-4 py-4 text-neutral-100">
      <div className="mx-auto max-w-xl space-y-4">
        {update ? (
          <button onClick={() => window.location.reload()} className="w-full rounded-lg bg-sky-700 py-2 text-sm font-semibold">
            ⬆ Update available · tap to reload (then Start again)
          </button>
        ) : null}
        <header className="flex items-baseline justify-between">
          <h1 className="text-lg font-bold">🎵 Media share</h1>
          <span className="text-xs text-neutral-500">{channel}</span>
        </header>

        {/* The player: only its sound is needed here (the stream shows the video on the overlay), so it's
            all but invisible, and small enough that YouTube sends its smallest picture, sparing the phone's
            battery. 200px, YouTube's smallest proper player: a tiny one (2px was tried, 2026-10-18) gets new
            videos started muted. Not hidden outright: a browser may throttle or stop a player it can't see. */}
        <div
          className={showVideo ? "relative overflow-hidden rounded-xl bg-black" : "pointer-events-none fixed bottom-0 right-0 overflow-hidden"}
          style={showVideo ? { aspectRatio: "16 / 9" } : { width: 200, height: 200, opacity: 0.01 }}
          aria-hidden={!showVideo}
        >
          <div ref={holder} className="absolute inset-0" />
        </div>
        {standby ? (
          <div className="space-y-2 rounded-xl bg-neutral-900 p-3 text-center">
            <p className="text-sm text-neutral-300">
              {sync?.otherActive ? "Another player is playing this queue, so this one stays quiet." : "Another player had this queue. This one stays quiet until you take over."}
            </p>
            <button
              onClick={() => {
                // In the tap, so this phone may play with sound once it's in charge.
                player.current?.unMute();
                player.current?.setVolume(volumeRef.current);
                takeover.current = true;
                void tick();
              }}
              className="w-full rounded-xl bg-green-600 py-4 text-lg font-bold"
            >
              ▶ Take over here
            </button>
          </div>
        ) : null}
        {started && needTap ? (
          <button onClick={restore} className="w-full animate-pulse rounded-xl bg-amber-500 py-5 text-xl font-bold text-black">
            🔇 Tap to restore sound
          </button>
        ) : null}
        {!started ? (
          <button
            onClick={start}
            disabled={!ready}
            className="w-full rounded-xl bg-green-600 py-5 text-xl font-bold disabled:opacity-60"
          >
            {ready ? "▶ Tap to start the player" : "Loading…"}
          </button>
        ) : null}

        <section className="space-y-2">
          <p className="truncate text-base font-semibold">{song ? song.title : "Nothing in the queue"}</p>
          {song ? (
            <p className="text-sm text-neutral-400">
              {song.tip && song.amount !== null ? <span className="text-green-400">${song.amount} · </span> : null}
              {song.username || "someone"}
              {waiting ? " · starting in a moment" : paused ? " · paused" : ""}
            </p>
          ) : null}
          {song && length > 0 ? (
            <div>
              {/* Drag (or tap) to jump; it seeks on letting go, not on every step of a drag. */}
              <input
                type="range"
                min={0}
                max={Math.floor(length)}
                step={1}
                value={Math.floor(scrub ?? into)}
                disabled={!canSeek}
                onChange={(e) => setScrub(Number(e.target.value))}
                onPointerUp={(e) => seek(Number(e.currentTarget.value))}
                onKeyUp={(e) => seek(Number(e.currentTarget.value))}
                onBlur={() => setScrub(null)}
                className="h-6 w-full accent-green-500 disabled:opacity-60"
                aria-label="Timeline"
              />
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>{clock(scrub ?? into)}</span>
                <span className="flex gap-2">
                  <button onClick={() => seek(into - 10)} disabled={!canSeek} className="rounded bg-neutral-800 px-3 py-1 text-neutral-200 disabled:opacity-40">
                    ⏪ 10s
                  </button>
                  <button onClick={() => seek(into + 10)} disabled={!canSeek} className="rounded bg-neutral-800 px-3 py-1 text-neutral-200 disabled:opacity-40">
                    10s ⏩
                  </button>
                </span>
                <span>{clock(length)}</span>
              </div>
            </div>
          ) : null}
        </section>

        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={toggle}
            disabled={!started}
            className={`rounded-xl py-4 text-lg font-bold disabled:opacity-40 ${paused ? "bg-green-600" : "bg-neutral-800"}`}
          >
            {paused ? "▶ Play" : "⏸ Pause"}
          </button>
          <button
            onClick={() => {
              if (!song) return;
              act({ type: "skip", key: song.key });
              // A skip plays the next one, paused or not.
              if (syncRef.current?.state === "paused") act({ type: "play" });
            }}
            disabled={!started || !song}
            className="rounded-xl bg-neutral-800 py-4 text-lg font-bold disabled:opacity-40"
          >
            ⏭ Skip
          </button>
        </div>
        {/* The same switch as chat's !media hide / show, kept by the bot: either way, both see it. */}
        <button
          onClick={() => {
            const s = syncRef.current;
            if (!s?.playing) return;
            const next = { ...s, hidden: !s.hidden };
            syncRef.current = next;
            setSync(next);
            act({ type: s.hidden ? "show" : "hide" });
          }}
          disabled={!song}
          className={`w-full rounded-xl py-3 font-bold disabled:opacity-40 ${sync?.hidden ? "bg-amber-600" : "bg-neutral-800"}`}
        >
          {sync?.hidden ? "🙈 Overlay hidden for this one · tap to show" : "👁 Overlay showing · tap to hide (audio only)"}
        </button>
        {error ? <p className="text-sm text-amber-400">{error}</p> : null}
        {failures.length ? (
          <section className="space-y-2 rounded-xl border border-red-700 bg-red-950 p-3" role="alert">
            <div className="flex items-start justify-between gap-2">
              <p className="font-bold text-red-200">⚠ Skipped: YouTube wouldn&apos;t play {failures.length === 1 ? "this" : "these"} here</p>
              <button onClick={() => dismiss(failures.map((f) => f.key))} className="shrink-0 rounded-lg bg-red-900 px-3 py-1 text-sm" aria-label="Dismiss skipped videos">
                ✕
              </button>
            </div>
            <ul className="space-y-2">
              {failures.map((f) => (
                <li key={f.key} className="text-sm">
                  <p className="truncate font-semibold text-white">{f.title}</p>
                  <p className="text-red-200">
                    from {f.username || "someone"} · {f.reason}
                  </p>
                  <FindAlternative url={altUrl} video={{ videoId: f.videoId, title: f.title, seconds: f.seconds }} onAdded={(t) => setNote(`Added "${t}" to the queue`)} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {note && !error ? <p className="text-sm text-green-400">{note}</p> : null}

        <section className="space-y-3 rounded-xl bg-neutral-900 p-3">
          <label className="block text-sm">
            <span className="text-neutral-400">Volume {volume}%</span>
            <input
              type="range"
              min={0}
              max={100}
              value={volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVolume(v);
                store("volume", v);
              }}
              className="mt-1 w-full"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-neutral-400">Subtitles on the overlay (YouTube&apos;s captions)</span>
            <input
              type="checkbox"
              checked={!!sync?.captions}
              disabled={!sync}
              onChange={(e) => {
                const s = syncRef.current;
                if (!s) return;
                const next = { ...s, captions: e.target.checked };
                syncRef.current = next;
                setSync(next);
                act({ type: e.target.checked ? "captions-on" : "captions-off" });
              }}
              className="h-5 w-5"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-neutral-400">Show the video here (uses more battery)</span>
            <input
              type="checkbox"
              checked={showVideo}
              onChange={(e) => {
                // Not remembered: the player always opens with only its sound, to spare the battery.
                setShowVideo(e.target.checked);
              }}
              className="h-5 w-5"
            />
          </label>
          <label className="flex items-center justify-between gap-3 text-sm">
            <span className="text-neutral-400">Delay new request (s)</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={30}
              value={delay}
              onChange={(e) => {
                const v = Math.max(0, Math.min(30, Math.round(Number(e.target.value) || 0)));
                setDelay(v);
                delayRef.current = v;
                store("delay", v);
              }}
              className="w-20 rounded bg-neutral-800 px-2 py-1 text-right"
            />
          </label>
          <p className="text-xs text-neutral-500">
            The video overlay follows this player: pause here and it hides, play and it carries on with you. Keep this page on screen (a split screen works).
            Chat&apos;s !pause, !play and !skip work on it too.
          </p>
        </section>

        <SearchYouTube url={altUrl} onAdded={(t) => setNote(`Added "${t}" to the queue`)} />

        <section>
          <div className="mb-2 flex gap-2 text-sm">
            {(["queue", "history"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 ${tab === t ? "bg-neutral-100 text-neutral-900" : "bg-neutral-800"}`}>
                {t === "queue" ? `Queue (${sync?.queue.length ?? 0})` : "History"}
              </button>
            ))}
          </div>
          <ul className="space-y-1">
            {list.length === 0 ? <li className="text-sm text-neutral-500">{tab === "queue" ? "Nothing waiting." : "Nothing yet."}</li> : null}
            {list.map((s) => {
              const problem = rowProblem(s);
              return (
              <li key={s.key} className={`flex items-start gap-2 rounded px-3 py-2 text-sm ${problem ? "border border-red-800 bg-red-950" : "bg-neutral-900"}`}>
                <span className="w-4 shrink-0 text-green-400">{s.tip ? "$" : ""}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{s.title}</span>
                  {problem ? (
                    <span className="block text-xs text-red-300">
                      ⚠ {tab === "queue" ? "Won't play" : "Didn't play"}: {problem}
                    </span>
                  ) : null}
                  {problem ? (
                    <FindAlternative url={altUrl} video={{ videoId: s.videoId, title: s.title, seconds: s.duration ?? s.end }} onAdded={(t) => setNote(`Added "${t}" to the queue`)} />
                  ) : null}
                </span>
                <span className="shrink-0 text-neutral-500">{s.username}</span>
                {tab === "queue" ? (
                  <span className="flex shrink-0 gap-1">
                    {/* StreamElements' replay plays a song at once (the one cut off goes back first in line): there is no "play next". */}
                    <button
                      onClick={() => {
                        act({ type: "front", key: s.key });
                        setNote(`Playing "${s.title}" now; the song it cut off goes back to the front of the queue`);
                      }}
                      className="rounded bg-neutral-700 px-2 text-xs"
                      aria-label={`Play ${s.title} now`}
                    >
                      ▶ Now
                    </button>
                    <button
                      onClick={() => {
                        if (!window.confirm(`Take "${s.title}" from ${s.username || "someone"} out of the queue?`)) return;
                        act({ type: "remove", key: s.key });
                        setNote(`Removed "${s.title}"`);
                      }}
                      className="rounded bg-neutral-700 px-2 text-xs"
                      aria-label={`Remove ${s.title}`}
                    >
                      ✕
                    </button>
                  </span>
                ) : null}
                {tab === "history" ? (
                  <button
                    onClick={() => {
                      act({ type: "replay", key: s.key });
                      setNote(`Replaying "${s.title}"`);
                    }}
                    disabled={!started}
                    className="shrink-0 rounded bg-neutral-700 px-2 text-xs disabled:opacity-40"
                    aria-label={`Replay ${s.title}`}
                  >
                    ↻ Replay
                  </button>
                ) : null}
              </li>
              );
            })}
          </ul>
        </section>
      </div>
    </main>
  );
}

/** Ask the player's YouTube search route; throws its error message. */
async function searchCall(url: string, body: unknown): Promise<{ results?: Alt[]; problem?: string; ok?: boolean }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  const data = (await res.json().catch(() => null)) as { results?: Alt[]; problem?: string; ok?: boolean; error?: string } | null;
  if (!res.ok || !data) throw new Error(data?.error ?? `The bot answered ${res.status}`);
  return data;
}

/** Search results with a one-tap "Add" each; shared by "find another version" and the search box. */
function useResults(url: string, onAdded: (title: string) => void) {
  const [busy, setBusy] = useState<"searching" | "adding" | null>(null);
  const [results, setResults] = useState<Alt[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  /** Bumped by each search and by clear(): a slower, older answer is dropped. */
  const ask = useRef(0);
  const run = async (body: unknown, none: string) => {
    const mine = ++ask.current;
    setBusy("searching");
    setMsg(null);
    try {
      const data = await searchCall(url, body);
      if (mine !== ask.current) return;
      const list = data.results ?? [];
      setResults(list);
      setMsg(data.problem ? `That one won't play here: ${data.problem}` : list.length ? null : none);
    } catch (e) {
      if (mine !== ask.current) return;
      setMsg(e instanceof Error ? e.message : "Search failed");
    }
    setBusy(null);
  };
  const add = async (a: Alt) => {
    setBusy("adding");
    try {
      await searchCall(url, { add: a.videoId });
      setResults((l) => (l ?? []).filter((x) => x.videoId !== a.videoId));
      setMsg(`Added "${a.title}" to the end of the queue (shows as requested by the channel)`);
      onAdded(a.title);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Couldn't add it");
    }
    setBusy(null);
  };
  const view = (
    <span className="mt-1 block space-y-1">
      {busy === "searching" ? <span className="block text-xs text-neutral-400">Searching YouTube…</span> : null}
      {(results ?? []).map((a) => (
        <span key={a.videoId} className="flex items-center gap-2 rounded bg-neutral-900 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-white">{a.title}</span>
            <span className="block truncate text-neutral-400">
              {a.channel ? `${a.channel} · ` : ""}
              {clock(a.durationS)}
            </span>
          </span>
          <button onClick={() => void add(a)} disabled={busy !== null} className="shrink-0 rounded bg-green-700 px-2 py-1 font-semibold text-white disabled:opacity-50">
            + Add
          </button>
        </span>
      ))}
      {msg ? <span className="block text-xs text-neutral-300">{msg}</span> : null}
    </span>
  );
  // An error leaves no results: the button comes back (with the message) to try again.
  const clear = () => {
    ask.current++;
    setBusy(null);
    setResults(null);
    setMsg(null);
  };
  return { run, clear, busy, started: (results !== null && results.length > 0) || busy !== null, msg, view };
}

/** "Find another version" for a video YouTube won't play: up to 3 other uploads, one tap to queue. */
function FindAlternative({ url, video, onAdded }: { url: string; video: { videoId: string; title: string; seconds: number }; onAdded: (title: string) => void }) {
  const r = useResults(url, onAdded);
  if (!r.started) {
    return (
      <span className="mt-1 block">
        <button onClick={() => void r.run({ find: video }, "No other version YouTube will play here")} className="rounded bg-neutral-800 px-2 py-1 text-xs text-white">
          🔎 Find another version
        </button>
        {r.msg ? <span className="mt-1 block text-xs text-neutral-300">{r.msg}</span> : null}
      </span>
    );
  }
  return r.view;
}

/** The streamer's own search: words or a YouTube link, up to 5 results that will play here. */
function SearchYouTube({ url, onAdded }: { url: string; onAdded: (title: string) => void }) {
  const [q, setQ] = useState("");
  const r = useResults(url, onAdded);
  return (
    <section className="space-y-2 rounded-xl bg-neutral-900 p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) void r.run({ search: q.trim() }, "Nothing YouTube will play here");
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            // Emptied out: the old results go with it.
            if (!e.target.value.trim()) r.clear();
          }}
          placeholder="Search YouTube or paste a link"
          enterKeyHint="search"
          className="min-w-0 flex-1 rounded bg-neutral-800 px-3 py-2 text-sm"
        />
        <button type="submit" disabled={!q.trim() || r.busy !== null} className="shrink-0 rounded bg-neutral-700 px-3 py-2 text-sm font-semibold disabled:opacity-50">
          🔎 Search
        </button>
      </form>
      {r.view}
    </section>
  );
}
