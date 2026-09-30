"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { FishOverlayEvent } from "@/lib/bot-api";
import { syncClock, useCodeHidden, useCountdown } from "@/lib/overlay-clock";
import { demoGenerator, type DemoOdds } from "@/lib/fish-demo";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const POLL_MS = 1500;
const TICK_MS = 100;
/** Past this many waiting, misses go first so the overlay catches up. */
const QUEUE_CAP = 20;
/** The narrowest a lane gets, in em. */
const LANE_EM = 7.5;

/**
 * A fishing scene rather than text: a strip of water along the bottom, and each
 * reply plays in a lane of its own — a cast and a catch, a miss, a trap hauled
 * up, coins for a sale. A burst fills free lanes at random a moment apart; the
 * rest wait, and while anything waits each scene plays faster.
 */
type Scene =
  | { v: "catch"; item: string; rarity: string | null; cm: number | null }
  | { v: "miss"; junk: string | null }
  | { v: "trap"; haul: string[] }
  | { v: "bite"; code: string; windowSec: number; pull: number; pulls: number; until?: number; flashMs?: number }
  | { v: "steal"; item: string; victim: string | null; cm: number | null }
  | { v: "caught"; item: string; victim: string | null; fine: string | null }
  | { v: "lay" }
  | { v: "sell"; amount: string | null }
  | { v: "wait"; trap: boolean; time: string | null }
  | { v: "blocked"; ready: boolean }
  | { v: "cancel" }
  | { v: "inv"; items: Array<{ e: string; n: number }>; purse: string | null }
  | { v: "stats"; rows: Array<{ icon: string; value: string }> }
  | { v: "top"; title: string; podium: Array<{ value: string; names: string }>; you: string | null }
  | { v: "reel"; mode: "bought" | "next" | "best" | "short" | "none"; name: string | null; price: string | null }
  | { v: "note"; icon: string; text: string };

const graphemes = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
const split = (s: string) => (graphemes ? Array.from(graphemes.segment(s), (g) => g.segment) : Array.from(s));

// Built with the constructor: the dashboard compiles to ES2017, before \p{} in regex literals.
const EMOJI = new RegExp("(\\d+)x (\\p{Extended_Pictographic}\\uFE0F?)|(\\p{Extended_Pictographic}\\uFE0F?)", "gu");

/** Emoji in a reply with their counts ("5x 🐟" or 🐟🐟), in order of first appearance. */
function emojiCounts(text: string): Array<{ e: string; n: number }> {
  const out = new Map<string, number>();
  for (const m of text.matchAll(EMOJI)) {
    const e = (m[2] ?? m[3]).replace("\uFE0F", "");
    if (e === "✨") continue;
    out.set(e, (out.get(e) ?? 0) + (m[1] ? Number(m[1]) : 1));
  }
  return [...out].map(([e, n]) => ({ e, n }));
}

/** A reply's scene. Every reply gets one; what isn't recognised shows as a short note. */
function sceneOf(ev: FishOverlayEvent): Scene | null {
  const t = ev.text;
  if (ev.kind === "catch" && ev.item) {
    const cm = /It is (\d+) cm/.exec(t);
    return { v: "catch", item: ev.item, rarity: ev.rarity ?? null, cm: cm ? Number(cm[1]) : null };
  }
  if (ev.kind === "bite" && typeof ev.code === "string") {
    // The window, measured on the bot's clock, so a skewed viewer clock doesn't matter.
    const windowSec = Math.max(5, Math.min(120, ((ev.until ?? ev.ts + 30_000) - ev.ts) / 1000));
    return {
      v: "bite", code: ev.code, windowSec, pull: ev.pull ?? 1, pulls: ev.pulls ?? 1,
      ...(ev.until ? { until: ev.until } : {}), ...(ev.flashMs ? { flashMs: ev.flashMs } : {}),
    };
  }
  if (ev.kind === "steal" && ev.item) {
    const cm = /\((\d+) cm\)/.exec(t);
    return { v: "steal", item: ev.item, victim: /@(\w+)/.exec(t)?.[1] ?? null, cm: cm ? Number(cm[1]) : null };
  }
  if (ev.kind === "caught" && ev.item) {
    return { v: "caught", item: ev.item, victim: /@(\w+)/.exec(t)?.[1] ?? null, fine: /paid a ([\d,]+) /.exec(t)?.[1] ?? null };
  }
  if (ev.kind === "miss") return { v: "miss", junk: /You reel out an? (\S+)/.exec(t)?.[1] ?? null };
  if (ev.kind === "trap") {
    const m = /(?:fish!|junk\.) (\S+)/.exec(t);
    return { v: "trap", haul: m ? split(m[1]).filter((g) => g.trim()).slice(0, 9) : [] };
  }
  if (/laid your fishing traps/.test(t)) return { v: "lay" };
  if (/^(Sold your|You sold)/.test(t)) return { v: "sell", amount: /for (?:a grand total of )?([\d,]+) /.exec(t)?.[1] ?? null };
  if (/^Hol' up partner!|^Your traps are not fully loaded yet!/.test(t)) {
    return { v: "wait", trap: /traps/.test(t), time: /\bin (\d[^.!]*)[.!]/.exec(t)?.[1] ?? null };
  }
  if (/^You cannot go fishing while your traps are laid out/.test(t)) return { v: "blocked", ready: /ready to be collected/.test(t) };
  if (/retrieved your traps before they filled up/.test(t)) return { v: "cancel" };
  if (/in (?:your|their) collection|never gone fishing before/.test(t)) {
    const purse = /purse contains ([\d,]+)|have ([\d,]+) \S+ in (?:your|their) purse/.exec(t);
    const listed = t.replace(/ (?:You|They) also have.*$/, "").replace(/purse contains.*$/, "");
    return { v: "inv", items: emojiCounts(listed).slice(0, 8), purse: purse ? (purse[1] ?? purse[2]) : null };
  }
  if (/fishing stats →/.test(t)) {
    const num = (label: string) => new RegExp(`${label}: ([\\d,]+)`).exec(t)?.[1] ?? null;
    const rows = [
      { icon: "👥", value: num("anglers") },
      { icon: "🎣", value: num("attempts") },
      { icon: "🐟", value: num("caught fish") },
      { icon: "🪤", value: num("traps set up") },
      { icon: "💰", value: num("fish sold") },
    ].flatMap((r) => (r.value ? [{ icon: r.icon, value: r.value }] : []));
    return { v: "stats", rows };
  }
  if (/^Top 10 /.test(t)) {
    const podium = [...t.matchAll(/Rank #\d+ \(([\d,]+)\): (.+?)(?= Rank #| Your rank|$)/g)].slice(0, 3).map((m) => ({ value: m[1], names: m[2] }));
    return { v: "top", title: /^Top 10 (.+?):/.exec(t)?.[1] ?? "", podium, you: /Your rank is: #(\d+)/.exec(t)?.[1] ?? null };
  }
  if (/reel|fishing gear shop/.test(t)) {
    const bought = /You bought the (.+?) reel for ([\d,]+)/.exec(t);
    if (bought) return { v: "reel", mode: "bought", name: bought[1], price: bought[2] };
    const next = /Next up: the (.+?) reel for ([\d,]+)/.exec(t);
    if (next) return { v: "reel", mode: "next", name: next[1], price: next[2] };
    const short = /The (.+?) reel costs ([\d,]+)/.exec(t);
    if (short) return { v: "reel", mode: "short", name: short[1], price: short[2] };
    if (/best reel/.test(t)) return { v: "reel", mode: "best", name: null, price: null };
    if (/gear shop/.test(t)) return { v: "reel", mode: "none", name: null, price: null };
  }
  const icon = /\$|need|costs/i.test(t) ? "💸" : /No such user|never/i.test(t) ? "❔" : /Invalid|must|Tell me/i.test(t) ? "⚠️" : "💬";
  const short = t.replace(/\s*\([^()]*\)\s*$/, "") || t;
  return { v: "note", icon, text: short.length > 90 ? `${short.slice(0, 88)}…` : short };
}

function holdOf(s: Scene): number {
  if (s.v !== "catch") return 0;
  return s.rarity === "Mythic" ? 5.5 : s.rarity === "Legendary" ? 4.5 : s.rarity === "Epic" ? 2.8 : s.rarity === "Rare" ? 2 : 1.4;
}

/** Seconds a scene lasts at speed 1. */
function lengthOf(s: Scene): number {
  switch (s.v) {
    case "catch":
      return 1.75 + 0.9 + holdOf(s) + 0.6;
    case "miss":
      return s.junk ? 3.2 : 2.6;
    case "trap":
      return 0.7 + s.haul.length * 0.12 + 2 + 0.6;
    case "steal":
      return 4.7;
    case "bite":
      return s.windowSec + 0.5;
    case "caught":
      return 4;
    case "lay":
      return 2.3;
    case "sell":
      return 2.6;
    case "wait":
    case "cancel":
      return 2.4;
    case "blocked":
      return 2.6;
    case "inv":
      return 3.2 + s.items.length * 0.1;
    case "stats":
      return 4.2;
    case "top":
      return 5;
    case "reel":
      return s.mode === "bought" ? 3.6 : 3;
    case "note":
      return 3 + Math.min(2, s.text.length / 60);
  }
}

interface Waiting {
  ev: FishOverlayEvent;
  scene: Scene;
}

interface Lane extends Waiting {
  /** Speed factor: 1 normally, smaller while a queue waits. */
  s: number;
  endsAt: number;
}

function trimQueue(queue: Waiting[]): void {
  for (const v of ["note", "wait", "blocked", "miss", "lay", "cancel", "sell"] as const) {
    while (queue.length > QUEUE_CAP) {
      const i = queue.findIndex((w) => w.scene.v === v);
      if (i < 0) break;
      queue.splice(i, 1);
    }
  }
  while (queue.length > QUEUE_CAP) queue.shift();
}

function nameColor(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 85% 72%)`;
}

/** A big bite's lane: the code, which pull it is, and the time left on the bot's clock. */
function BiteView({ scene }: { scene: Extract<Scene, { v: "bite" }> }) {
  const { frac, secs } = useCountdown(scene.until, scene.windowSec * 1000);
  const hidden = useCodeHidden(scene.flashMs);
  const color = frac > 0.6 ? "#fde047" : frac > 0.3 ? "#fbbf24" : "#ef4444";
  return (
    <>
      <div className="fo-line" />
      <div className="fo-bobber" />
      <div className="fo-ripple r1" />
      <div className="fo-ripple r2" />
      <div className="fo-codebox">
        <span className="fo-codelabel">{scene.pulls > 1 ? `Pull ${scene.pull}/${scene.pulls}` : "Reel code"}</span>
        {hidden ? <b className="fo-codegone">• • •</b> : <b className={scene.code.length > 2 ? "fo-codelong" : ""}>{scene.code}</b>}
        <span className="fo-codesecs" style={{ color }}>{secs > 0 ? `${secs}s left` : "time's up!"}</span>
      </div>
      <div className="fo-timer" style={{ transform: `scaleX(${frac})`, background: color }} />
    </>
  );
}

// ─── One lane's scene ────────────────────────────────────────────────────────

function LaneView({ lane }: { lane: Lane }) {
  const { scene, ev, s } = lane;
  const style = {
    "--s": s, "--hold": `${holdOf(scene)}s`, "--len": `${lengthOf(scene)}s`, ...(scene.v === "bite" ? { "--win": `${scene.windowSec}s` } : {}),
  } as CSSProperties;
  const rarity = scene.v === "catch" && scene.rarity && scene.rarity !== "Common" ? scene.rarity.toLowerCase() : "";
  return (
    <div className={`fo-lane v-${scene.v} ${rarity ? `r-${rarity}` : ""}`} style={style}>
      <div className="fo-name" style={{ color: nameColor(ev.username) }}>
        {ev.username}
      </div>

      {scene.v === "catch" || scene.v === "miss" ? (
        <>
          <div className="fo-line" />
          <div className="fo-bobber" />
          <div className="fo-ripple r1" />
          <div className="fo-ripple r2" />
        </>
      ) : null}

      {scene.v === "catch" ? (
        <>
          {[-3, -1.6, 0, 1.6, 3].map((dx, i) => (
            <div key={i} className="fo-drop" style={{ "--dx": `${dx}em`, "--dy": `${-2.6 + Math.abs(dx) * 0.3}em` } as CSSProperties} />
          ))}
          {rarity ? <div className="fo-aura" /> : null}
          {rarity === "legendary" || rarity === "mythic" ? <div className="fo-rays" /> : null}
          <div className="fo-fish">
            <span>{scene.item}</span>
          </div>
          {rarity || scene.cm ? (
            <div className="fo-tag">
              {rarity ? <b>{scene.rarity}</b> : null}
              {rarity && scene.cm ? " · " : null}
              {scene.cm ? `${scene.cm} cm` : null}
            </div>
          ) : null}
        </>
      ) : null}

      {scene.v === "miss" && scene.junk ? (
        <div className="fo-junk">
          <span>{scene.junk}</span>
        </div>
      ) : null}

      {scene.v === "wait" ? (
        <>
          <div className="fo-big fo-hourglass">
            <span>{scene.trap ? "🪤" : "⏳"}</span>
          </div>
          <div className="fo-tag fo-tag-low">{scene.time ? `⏳ ${scene.time}` : "Not yet"}</div>
        </>
      ) : null}

      {scene.v === "blocked" || scene.v === "cancel" ? (
        <>
          <div className="fo-ripple r1" />
          <div className="fo-cage">
            <i />
          </div>
          <div className="fo-tag fo-tag-low">{scene.v === "cancel" ? "✖ Cancelled" : scene.ready ? "Traps ready!" : "Traps out"}</div>
        </>
      ) : null}

      {scene.v === "inv" ? (
        <>
          <div className="fo-big fo-bag">
            <span>🎒</span>
          </div>
          {(scene.items.length ? scene.items : [{ e: "🕸️", n: 1 }]).map((it, i, all) => {
            const mid = (all.length - 1) / 2;
            return (
              <div
                key={it.e}
                className="fo-haul fo-inv"
                style={{ "--dx": `${(i - mid) * 1.45}em`, "--dy": `${-3.6 - (mid - Math.abs(i - mid)) * 0.4}em`, "--i": i } as CSSProperties}
              >
                <span>{it.e}</span>
                {it.n > 1 ? <b>×{it.n}</b> : null}
              </div>
            );
          })}
          {scene.purse ? <div className="fo-tag fo-tag-low">💰 {scene.purse}</div> : null}
        </>
      ) : null}

      {scene.v === "stats" ? (
        <div className="fo-panel">
          {scene.rows.map((r) => (
            <div key={r.icon} className="fo-stat">
              <span>{r.icon}</span>
              <b>{r.value}</b>
            </div>
          ))}
        </div>
      ) : null}

      {scene.v === "top" ? (
        <div className="fo-panel fo-podium">
          {scene.title ? <div className="fo-panel-title">🏆 {scene.title}</div> : null}
          {scene.podium.map((p, i) => (
            <div key={i} className="fo-rank" style={{ "--i": i } as CSSProperties}>
              <span>{["🥇", "🥈", "🥉"][i]}</span>
              <em>{p.names}</em>
              <b>{p.value}</b>
            </div>
          ))}
          {scene.you ? <div className="fo-panel-foot">you #{scene.you}</div> : null}
        </div>
      ) : null}

      {scene.v === "reel" ? (
        <>
          {scene.mode === "bought" ? <div className="fo-aura fo-aura-gold" /> : null}
          <div className={`fo-big ${scene.mode === "bought" ? "fo-reel-new" : "fo-reel"}`}>
            <span>{scene.mode === "best" ? "🏆" : "🎣"}</span>
          </div>
          <div className="fo-tag fo-tag-low">
            {scene.mode === "bought"
              ? `${scene.name} reel!`
              : scene.mode === "next"
                ? `Next: ${scene.name} · ${scene.price}`
                : scene.mode === "short"
                  ? `Need ${scene.price}`
                  : scene.mode === "best"
                    ? "Best reel owned"
                    : "Shop is empty"}
          </div>
        </>
      ) : null}

      {scene.v === "note" ? (
        <div className="fo-panel fo-note">
          <span>{scene.icon}</span>
          <p>{scene.text}</p>
        </div>
      ) : null}

      {scene.v === "trap" || scene.v === "lay" ? (
        <>
          <div className="fo-ripple r1" />
          <div className="fo-cage">
            <i />
          </div>
        </>
      ) : null}

      {scene.v === "trap"
        ? (scene.haul.length ? scene.haul : ["💨"]).map((g, i, all) => {
            const mid = (all.length - 1) / 2;
            const dx = (i - mid) * 1.35;
            const dy = -3.4 - (mid - Math.abs(i - mid)) * 0.45;
            return (
              <div key={i} className="fo-haul" style={{ "--dx": `${dx}em`, "--dy": `${dy}em`, "--i": i } as CSSProperties}>
                <span>{g}</span>
              </div>
            );
          })
        : null}

      {scene.v === "bite" ? <BiteView scene={scene} /> : null}

      {scene.v === "steal" || scene.v === "caught" ? (
        <>
          <div className="fo-ripple r1" />
          <div className="fo-loot">
            <span>{scene.item}</span>
          </div>
          <div className="fo-hook">
            <span>🪝</span>
          </div>
          {scene.v === "caught" ? (
            <div className="fo-siren">
              <span>🚨</span>
            </div>
          ) : (
            <div className="fo-stamp">🥷 Stolen!</div>
          )}
          <div className="fo-tag fo-tag-heist">
            {scene.v === "steal"
              ? `🪝 from ${scene.victim ?? "someone"}${scene.cm ? ` · ${scene.cm} cm` : ""}`
              : `Caught by ${scene.victim ?? "the owner"}${scene.fine ? ` · −${scene.fine}` : ""}`}
          </div>
        </>
      ) : null}

      {scene.v === "sell" ? (
        <>
          {[-2.2, -1.1, 0, 1.1, 2.2, -0.5, 0.6].map((dx, i) => (
            <div key={i} className="fo-coin" style={{ "--dx": `${dx}em`, "--i": i, "--dy": `${-3 - (i % 3) * 0.9}em` } as CSSProperties}>
              <span>🪙</span>
            </div>
          ))}
          {scene.amount ? <div className="fo-amount">+{scene.amount}</div> : null}
        </>
      ) : null}
    </div>
  );
}

// ─── The overlay ─────────────────────────────────────────────────────────────

export default function FishOverlay({
  channel,
  overlayKey,
  max,
  scale,
  demo,
  demoOdds,
}: {
  channel: string;
  overlayKey: string;
  max: number;
  scale: number;
  demo: boolean;
  /** The channel's odds for the demo; null uses the bot's defaults. */
  demoOdds: DemoOdds | null;
}) {
  const queue = useRef<Waiting[]>([]);
  const lanes = useRef<Array<Lane | null>>([]);
  const lastRelease = useRef(0);
  const [active, setActive] = useState(false);
  const idleSince = useRef(0);
  const [laneCount, setLaneCount] = useState(max);
  const [, setVersion] = useState(0);
  const fontPx = 18 * scale;

  const enqueue = (events: FishOverlayEvent[]) => {
    for (const ev of events) {
      const scene = sceneOf(ev);
      if (!scene) continue;
      if (scene.v === "bite") {
        // The next pull's code replaces the last one in the same lane, timer restarted.
        const now = performance.now();
        const i = lanes.current.findIndex((l) => l && l.scene.v === "bite" && l.ev.username === ev.username);
        if (i >= 0) {
          lanes.current[i] = { ev, scene, s: 1, endsAt: now + lengthOf(scene) * 1000 + 150 };
          continue;
        }
        // A reel code can't wait its turn: to the front of the queue.
        queue.current = queue.current.filter((w) => !(w.scene.v === "bite" && w.ev.username === ev.username));
        queue.current.unshift({ ev, scene });
        continue;
      }
      // The angler's answer ends their big bite, playing or still waiting.
      const now = performance.now();
      for (const l of lanes.current) if (l && l.scene.v === "bite" && l.ev.username === ev.username) l.endsAt = Math.min(l.endsAt, now + 250);
      queue.current = queue.current.filter((w) => !(w.scene.v === "bite" && w.ev.username === ev.username));
      queue.current.push({ ev, scene });
    }
    trimQueue(queue.current);
  };

  // As many lanes as fit the source's width, up to `max`.
  useEffect(() => {
    const fit = () => setLaneCount(Math.max(1, Math.min(max, Math.floor(window.innerWidth / (LANE_EM * fontPx)))));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [max, fontPx]);

  // Poll the feed. The first answer only sets where to start, so opening the
  // source doesn't replay the last few minutes.
  useEffect(() => {
    let after: number | null = null;
    const url = `${BASE_PATH}/api/overlay/${encodeURIComponent(channel)}/fishing?key=${encodeURIComponent(overlayKey)}`;
    const poll = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { lastId: number; events: FishOverlayEvent[]; now?: number };
        syncClock(data.now);
        if (after === null || data.lastId < after) {
          after = data.lastId; // first load, or the feed restarted
          return;
        }
        const fresh = data.events.filter((e) => e.id > (after as number));
        if (fresh.length) {
          after = Math.max(...fresh.map((e) => e.id));
          enqueue(fresh);
        }
      } catch {
        // offline for a moment; the next poll catches up
      }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [channel, overlayKey]);

  useEffect(() => {
    if (!demo) return;
    // Ten anglers at once, repeated, rolled at the channel's odds, to see how a burst plays.
    const demoBurst = demoGenerator(demoOdds);
    let id = -1;
    const fire = () => {
      enqueue(demoBurst(id));
      id -= 10;
    };
    fire();
    const t = setInterval(fire, 15_000);
    return () => clearInterval(t);
  }, [demo, demoOdds]);

  // The scheduler: free finished lanes, then start the next scene in a random free lane.
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      let changed = false;
      if (lanes.current.length !== laneCount) {
        lanes.current = Array.from({ length: laneCount }, (_, i) => lanes.current[i] ?? null);
        changed = true;
      }
      lanes.current = lanes.current.map((l) => {
        if (l && now >= l.endsAt) {
          changed = true;
          return null;
        }
        return l;
      });
      const waiting = queue.current.length;
      // A big bite with every lane busy takes the lane closest to finishing.
      if (queue.current[0]?.scene.v === "bite" && !lanes.current.some((l) => !l)) {
        let soonest = -1;
        lanes.current.forEach((l, i) => {
          if (l && l.scene.v !== "bite" && (soonest < 0 || l.endsAt < lanes.current[soonest]!.endsAt)) soonest = i;
        });
        if (soonest >= 0) {
          lanes.current[soonest] = null;
          changed = true;
        }
      }
      const free = lanes.current.flatMap((l, i) => (l ? [] : [i]));
      const stagger = queue.current[0]?.scene.v === "bite" ? 0 : waiting > 3 ? 180 : 400;
      if (waiting && free.length && now - lastRelease.current >= stagger) {
        const next = queue.current.shift()!;
        // Speed up while others wait; a rare catch keeps most of its moment, and a big bite all of it.
        let s = waiting > 6 ? 0.55 : waiting > 1 ? 0.75 : 1;
        if (next.scene.v === "catch" && (next.scene.rarity === "Mythic" || next.scene.rarity === "Legendary" || next.scene.rarity === "Epic")) s = Math.max(s, 0.85);
        if (next.scene.v === "bite") s = 1;
        const slot = free[Math.floor(Math.random() * free.length)];
        lanes.current[slot] = { ...next, s, endsAt: now + lengthOf(next.scene) * s * 1000 + 150 };
        lastRelease.current = now;
        changed = true;
      }
      // The water shows while anything plays, and lingers a moment after.
      const busy = lanes.current.some(Boolean) || queue.current.length > 0;
      if (busy) idleSince.current = 0;
      else if (!idleSince.current) idleSince.current = now;
      setActive(busy || now - idleSince.current < 1200);
      if (changed) setVersion((v) => v + 1);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [laneCount]);

  return (
    <>
      <style>{CSS}</style>
      <div className="fo-root" style={{ fontSize: `${fontPx}px` }}>
        <div className={`fo-water ${active ? "on" : ""}`}>
          <div className="w1" />
          <div className="w2" />
        </div>
        {lanes.current.map((l, i) =>
          l ? (
            <div key={l.ev.id} className="fo-slot" style={{ left: `${((i + 0.5) / lanes.current.length) * 100}%` }}>
              <LaneView lane={l} />
            </div>
          ) : null,
        )}
      </div>
    </>
  );
}

const wave = (fill: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='200' height='40' preserveAspectRatio='none'><path d='M0 14 Q25 4 50 14 T100 14 T150 14 T200 14 V40 H0Z' fill='${fill}'/></svg>`,
  )}")`;

// Times are written against --s (speed), so a whole scene plays faster by one number.
const T = (sec: number) => `calc(var(--s) * ${sec}s)`;
/** The moment a scene starts fading out, from its length. */
const END = "calc(var(--len) * var(--s) - var(--s) * .6s)";

const CSS = `
.fo-root{position:fixed;inset:0;overflow:hidden;pointer-events:none;--surf:2.1em;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif,"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji"}
.fo-water{position:absolute;left:0;right:0;bottom:0;height:3em;opacity:0;transform:translateY(1.2em);transition:opacity .8s ease,transform .8s ease}
.fo-water.on{opacity:1;transform:none}
.fo-water>div{position:absolute;inset:0;background-size:12em 100%;background-repeat:repeat-x}
.fo-water .w1{background-image:${wave("rgba(70,170,255,0.35)")};animation:fo-wave 7s linear infinite}
.fo-water .w2{top:.35em;background-image:${wave("rgba(25,110,200,0.55)")};animation:fo-wave 4.5s linear infinite reverse}
.fo-water::after{content:"";position:absolute;left:0;right:0;bottom:0;height:2.2em;background:linear-gradient(transparent,rgba(10,50,110,.55))}
@keyframes fo-wave{to{background-position-x:12em}}

.fo-slot{position:absolute;bottom:0;width:${LANE_EM}em;height:13em;transform:translateX(-50%)}
.fo-lane{position:absolute;inset:0}
.fo-lane>*{position:absolute;left:50%}

.fo-name{bottom:.25em;transform:translateX(-50%);font-size:.62em;font-weight:700;white-space:nowrap;max-width:11em;overflow:hidden;text-overflow:ellipsis;
  padding:.1em .55em;border-radius:1em;background:rgba(5,15,30,.6);text-shadow:0 1px 2px #000;
  animation:fo-in .35s ease-out both,fo-out .5s ease-in calc(var(--len) * var(--s) - .5s) forwards}

.fo-line{bottom:var(--surf);width:2px;height:9em;margin-left:-1px;transform-origin:bottom;
  background:linear-gradient(rgba(255,255,255,0),rgba(255,255,255,.85));box-shadow:0 0 1px rgba(0,0,0,.55);
  animation:fo-line-drop ${T(0.5)} ease-out both,fo-line-reel ${T(0.45)} ease-in ${T(1.75)} forwards}
@keyframes fo-line-drop{from{transform:translateY(-9em);opacity:0}to{transform:none;opacity:1}}
@keyframes fo-line-reel{to{transform:translateY(-9em);opacity:0}}

.fo-bobber{bottom:calc(var(--surf) - .35em);width:.8em;height:.8em;margin-left:-.4em;border-radius:50%;
  background:linear-gradient(#ff4a4a 0 50%,#fff 50%);box-shadow:0 0 0 1px rgba(0,0,0,.35),0 .15em .3em rgba(0,0,0,.4);
  animation:fo-bob-drop ${T(0.5)} cubic-bezier(.5,0,.8,.6) both,fo-bob ${T(0.6)} ease-in-out ${T(0.5)} 2,fo-bob-out ${T(0.4)} ease-in ${T(1.75)} forwards}
@keyframes fo-bob-drop{from{transform:translateY(-9em)}to{transform:none}}
@keyframes fo-bob{50%{transform:translateY(.22em)}}
@keyframes fo-bob-out{30%{transform:translateY(.45em)}to{transform:translateY(-9em);opacity:0}}
.v-catch .fo-bobber{animation:fo-bob-drop ${T(0.5)} cubic-bezier(.5,0,.8,.6) both,fo-bob ${T(0.6)} ease-in-out ${T(0.5)} 2,fo-bob-dip ${T(0.5)} ease-in ${T(1.7)} forwards}
@keyframes fo-bob-dip{30%{transform:translateY(.6em)}45%{transform:translateY(.1em)}to{transform:translateY(-9em);opacity:0}}

.fo-ripple{bottom:calc(var(--surf) - .5em);width:3em;height:.9em;margin-left:-1.5em;border-radius:50%;border:2px solid rgba(255,255,255,.7);opacity:0}
.fo-ripple.r1{animation:fo-ripple ${T(0.9)} ease-out ${T(0.5)}}
.fo-ripple.r2{animation:fo-ripple ${T(0.9)} ease-out ${T(1.72)}}
.v-trap .fo-ripple.r1,.v-lay .fo-ripple.r1{animation-delay:${T(0.35)}}
@keyframes fo-ripple{from{transform:scale(.3);opacity:.9}to{transform:scale(1.8);opacity:0}}

.fo-drop{bottom:var(--surf);width:.35em;height:.35em;margin-left:-.17em;border-radius:50%;background:rgba(170,220,255,.95);opacity:0;
  animation:fo-drop ${T(0.7)} cubic-bezier(.2,.7,.5,1) ${T(1.75)}}
@keyframes fo-drop{0%{transform:none;opacity:1}60%{transform:translate(var(--dx),var(--dy));opacity:1}100%{transform:translate(calc(var(--dx) * 1.3),0);opacity:0}}

.fo-fish{bottom:var(--surf);transform:translateX(-50%);line-height:1;
  animation:fo-leap ${T(0.9)} cubic-bezier(.25,.9,.35,1.15) ${T(1.75)} both,fo-float 1.6s ease-in-out calc(var(--s) * 2.65s) infinite,fo-out .5s ease-in calc(var(--s) * 2.65s + var(--hold)) forwards}
.fo-fish>span{display:block;font-size:2.6em;filter:drop-shadow(0 .06em .1em rgba(0,0,0,.5))}
@keyframes fo-leap{0%{transform:translate(-50%,.5em) scale(.2) rotate(30deg);opacity:0}15%{opacity:1}
  55%{transform:translate(-50%,-5.6em) scale(1.2) rotate(-18deg)}80%{transform:translate(-50%,-4.1em) scale(.95) rotate(6deg)}100%{transform:translate(-50%,-4.5em) scale(1)}}
@keyframes fo-float{0%,100%{transform:translate(-50%,-4.5em)}50%{transform:translate(-50%,-4.85em) rotate(-4deg)}}

.fo-tag{bottom:calc(var(--surf) + 3.35em);transform:translateX(-50%);white-space:nowrap;font-size:.62em;font-weight:700;color:#e8f4ff;
  padding:.12em .5em;border-radius:.5em;background:rgba(5,15,30,.65);text-shadow:0 1px 2px #000;
  animation:fo-in .35s ease-out calc(var(--s) * 2.45s) both,fo-out .5s ease-in calc(var(--s) * 2.65s + var(--hold)) forwards}
.fo-tag b{letter-spacing:.06em;text-transform:uppercase}
.r-uncommon .fo-tag b{color:#6ee7b7}.r-rare .fo-tag b{color:#7dd3fc}.r-epic .fo-tag b{color:#f0abfc}.r-legendary .fo-tag b{color:#fcd34d}

.fo-aura{bottom:calc(var(--surf) + 4em);width:5em;height:5em;margin-left:-2.5em;border-radius:50%;
  animation:fo-in .5s ease-out calc(var(--s) * 2.2s) both,fo-pulse 1.2s ease-in-out calc(var(--s) * 2.2s) infinite,fo-out .5s ease-in calc(var(--s) * 2.65s + var(--hold)) forwards}
.r-uncommon .fo-aura{background:radial-gradient(circle,rgba(80,230,160,.45),transparent 65%)}
.r-rare .fo-aura{background:radial-gradient(circle,rgba(80,170,255,.55),transparent 65%)}
.r-epic .fo-aura{width:6em;height:6em;margin-left:-3em;bottom:calc(var(--surf) + 3.5em);background:radial-gradient(circle,rgba(220,110,255,.7),transparent 65%)}
.r-legendary .fo-aura{width:7em;height:7em;margin-left:-3.5em;bottom:calc(var(--surf) + 3em);background:radial-gradient(circle,rgba(255,205,80,.85),rgba(255,160,40,.25) 45%,transparent 68%)}
@keyframes fo-pulse{50%{transform:scale(1.15)}}
.fo-rays{bottom:calc(var(--surf) + 2.5em);width:8em;height:8em;margin-left:-4em;border-radius:50%;
  background:repeating-conic-gradient(rgba(255,220,120,.55) 0 8deg,transparent 8deg 24deg);
  -webkit-mask:radial-gradient(circle,#000 20%,transparent 68%);mask:radial-gradient(circle,#000 20%,transparent 68%);
  animation:fo-in .6s ease-out calc(var(--s) * 2.2s) both,fo-spin 6s linear infinite,fo-out .5s ease-in calc(var(--s) * 2.65s + var(--hold)) forwards}
@keyframes fo-spin{to{transform:rotate(360deg)}}

.fo-junk{bottom:var(--surf);transform:translateX(-50%);filter:grayscale(.6) brightness(.9);
  animation:fo-junk ${T(1.2)} ease-out ${T(1.85)} both}
.fo-junk>span{display:block;font-size:1.5em}
@keyframes fo-junk{0%{transform:translate(-50%,.3em) scale(.3);opacity:0}35%{transform:translate(-50%,-2.4em) scale(1) rotate(-10deg);opacity:1}
  75%{transform:translate(-50%,-2.2em) rotate(8deg);opacity:1}100%{transform:translate(-50%,-.5em) rotate(20deg);opacity:0}}

.fo-cage{bottom:calc(var(--surf) - .6em);width:2.6em;height:1.9em;margin-left:-1.3em;border-radius:.25em;
  border:.18em solid #b07a3c;background:repeating-linear-gradient(90deg,rgba(176,122,60,.95) 0 .16em,rgba(40,25,10,.25) .16em .55em);
  box-shadow:0 .2em .4em rgba(0,0,0,.45)}
.fo-cage>i{position:absolute;left:-.18em;right:-.18em;top:40%;height:.16em;background:#b07a3c}
.v-trap .fo-cage{animation:fo-cage-up ${T(0.7)} cubic-bezier(.3,1.4,.5,1) both,fo-out ${T(0.5)} ease-in ${END} forwards}
@keyframes fo-cage-up{from{transform:translateY(1.6em) rotate(-8deg);opacity:0}to{transform:translateY(-.3em)}}
.v-lay .fo-cage{animation:fo-cage-lay ${T(2.2)} ease-in both}
@keyframes fo-cage-lay{0%{transform:translateY(-7em) rotate(10deg);opacity:0}20%{opacity:1}40%{transform:translateY(-.2em) rotate(-4deg)}
  55%{transform:translateY(-.5em)}100%{transform:translateY(1.6em);opacity:0}}

.fo-haul{bottom:calc(var(--surf) + .2em);transform:translateX(-50%);
  animation:fo-haul ${T(0.55)} cubic-bezier(.3,1.6,.5,1) calc(var(--s) * (.7s + var(--i) * .12s)) both,fo-out .5s ease-in ${END} forwards}
.fo-haul>span{display:block;font-size:1.35em;filter:drop-shadow(0 .06em .1em rgba(0,0,0,.5))}
@keyframes fo-haul{from{transform:translate(-50%,0) scale(0);opacity:0}to{transform:translate(calc(-50% + var(--dx)),var(--dy)) scale(1);opacity:1}}

.fo-coin{bottom:var(--surf);transform:translateX(-50%);
  animation:fo-coin ${T(1.5)} cubic-bezier(.2,.8,.4,1) calc(var(--s) * var(--i) * .09s) both}
.fo-coin>span{display:block;font-size:1.2em}
@keyframes fo-coin{0%{transform:translate(-50%,0) scale(.3);opacity:0}15%{opacity:1}
  55%{transform:translate(calc(-50% + var(--dx)),var(--dy)) rotate(180deg)}100%{transform:translate(calc(-50% + var(--dx) * 1.2),.5em) rotate(360deg);opacity:0}}
.fo-amount{bottom:calc(var(--surf) + 1.2em);transform:translateX(-50%);font-weight:800;font-size:1.05em;color:#fde68a;text-shadow:0 1px 3px #000;
  animation:fo-rise ${T(2.2)} ease-out ${T(0.2)} both}
@keyframes fo-rise{0%{transform:translate(-50%,.5em);opacity:0}20%{transform:translate(-50%,-1em);opacity:1}80%{opacity:1}100%{transform:translate(-50%,-2.6em);opacity:0}}

.fo-big{bottom:calc(var(--surf) + .9em);transform:translateX(-50%);line-height:1;
  animation:fo-big-in ${T(0.55)} cubic-bezier(.3,1.6,.5,1) both,fo-out .5s ease-in ${END} forwards}
.fo-big>span{display:block;font-size:2.1em;filter:drop-shadow(0 .06em .1em rgba(0,0,0,.5))}
@keyframes fo-big-in{from{transform:translate(-50%,1.5em) scale(.3);opacity:0}to{transform:translateX(-50%);opacity:1}}
.fo-hourglass>span{animation:fo-flip 1.1s ease-in-out .5s infinite}
@keyframes fo-flip{0%,35%{transform:none}50%,85%{transform:rotate(180deg)}100%{transform:rotate(360deg)}}
.fo-bag>span{font-size:1.8em}
.fo-reel-new>span{font-size:2.4em;animation:fo-wiggle .9s ease-in-out .4s 2}
@keyframes fo-wiggle{25%{transform:rotate(-14deg) scale(1.1)}75%{transform:rotate(12deg) scale(1.1)}}
.fo-aura-gold{bottom:calc(var(--surf) + .1em);width:5.5em;height:5.5em;margin-left:-2.75em;border-radius:50%;
  background:radial-gradient(circle,rgba(255,205,80,.75),transparent 65%);
  animation:fo-in .4s ease-out both,fo-pulse 1.1s ease-in-out infinite,fo-out .5s ease-in ${END} forwards}
.fo-tag-low{bottom:calc(var(--surf) + .05em);font-size:.6em;animation:fo-in .35s ease-out ${T(0.35)} both,fo-out .5s ease-in ${END} forwards}
.v-blocked .fo-cage{animation:fo-cage-up ${T(0.7)} cubic-bezier(.3,1.4,.5,1) both,fo-bob .7s ease-in-out ${T(0.7)} infinite,fo-out ${T(0.5)} ease-in ${END} forwards}
.v-cancel .fo-cage{animation:fo-cage-cancel ${T(2.2)} ease-in-out both}
@keyframes fo-cage-cancel{0%{transform:translateY(1.6em);opacity:0}25%{transform:translateY(-1.4em) rotate(-6deg);opacity:1}
  55%{transform:translateY(-1.2em) rotate(5deg);opacity:1}100%{transform:translateY(-3.5em) rotate(20deg);opacity:0}}
.v-blocked .fo-tag-low,.v-cancel .fo-tag-low{bottom:calc(var(--surf) + 2.3em)}
.fo-inv{display:flex;align-items:flex-end;gap:.05em}
.fo-inv>b{font-size:.55em;font-weight:800;color:#e8f4ff;text-shadow:0 1px 2px #000;margin-bottom:.1em}

.fo-panel{bottom:calc(var(--surf) + .7em);transform:translateX(-50%);width:max-content;min-width:6.5em;max-width:12.5em;padding:.45em .65em;border-radius:.7em;
  background:rgba(8,18,32,.84);border:1px solid rgba(120,200,255,.28);box-shadow:0 .25em .8em rgba(0,0,0,.45);
  color:#e8f4ff;font-size:.72em;line-height:1.3;text-shadow:0 1px 2px #000;
  animation:fo-panel-in ${T(0.5)} cubic-bezier(.3,1.4,.5,1) both,fo-out .5s ease-in ${END} forwards}
@keyframes fo-panel-in{from{transform:translate(-50%,1.4em) scale(.85);opacity:0}to{transform:translateX(-50%);opacity:1}}
.fo-stat{display:inline-flex;align-items:center;gap:.25em;margin:.1em .35em .1em 0;white-space:nowrap}
.fo-stat b{font-weight:800}
.fo-panel-title{font-size:.8em;font-weight:800;letter-spacing:.04em;color:#fcd34d;margin-bottom:.2em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fo-rank{display:flex;align-items:center;gap:.35em;white-space:nowrap;animation:fo-in .3s ease-out calc(var(--s) * (.4s + var(--i) * .25s)) both}
.fo-rank em{font-style:normal;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.fo-rank b{font-weight:800;color:#fde68a}
.fo-podium{width:11em}
.fo-panel-foot{font-size:.8em;color:rgba(232,244,255,.6);margin-top:.15em}
.fo-note{display:flex;gap:.4em;align-items:flex-start}
.fo-note>span{font-size:1.1em;line-height:1.1}
.fo-note>p{margin:0;min-width:0;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}

@keyframes fo-in{from{opacity:0}to{opacity:1}}
@keyframes fo-out{to{opacity:0}}

.fo-loot{bottom:var(--surf);transform:translateX(-50%);line-height:1;animation:fo-loot-up ${T(0.5)} ease-out ${T(0.65)} both}
.fo-loot>span{display:block;font-size:2.2em;filter:drop-shadow(0 .06em .1em rgba(0,0,0,.5))}
@keyframes fo-loot-up{from{transform:translate(-50%,.5em) scale(.3);opacity:0}to{transform:translate(-50%,-.9em) scale(1);opacity:1}}
.fo-hook{bottom:var(--surf);transform:translate(-50%,-3em);line-height:1;animation:fo-hook-drop ${T(0.6)} cubic-bezier(.5,0,.8,.6) both}
.fo-hook>span{display:block;font-size:1.7em;filter:drop-shadow(0 .06em .1em rgba(0,0,0,.6))}
.fo-hook::before{content:"";position:absolute;left:50%;bottom:1.5em;width:.09em;height:14em;margin-left:-.045em;background:rgba(235,240,245,.75)}
@keyframes fo-hook-drop{from{transform:translate(-50%,-12em)}to{transform:translate(-50%,-3em)}}
/* A steal: the hook lifts the fish into the air, STOLEN! slams down while it hangs there, then the hook yanks it away. */
.v-steal .fo-hook{animation:fo-hook-drop ${T(0.6)} cubic-bezier(.5,0,.8,.6) both,fo-lift-hook ${T(0.55)} cubic-bezier(.3,1.4,.5,1) ${T(1.2)} forwards,fo-yank-hook ${T(0.9)} cubic-bezier(.5,-.3,.7,1) ${T(3.2)} forwards}
.v-steal .fo-loot{animation:fo-loot-up ${T(0.5)} ease-out ${T(0.65)} both,fo-lift-loot ${T(0.55)} cubic-bezier(.3,1.4,.5,1) ${T(1.2)} forwards,fo-dangle 1s ease-in-out ${T(1.75)} 2 alternate,fo-yank-loot ${T(0.9)} cubic-bezier(.5,-.3,.7,1) ${T(3.2)} forwards}
@keyframes fo-lift-hook{from{transform:translate(-50%,-3em)}to{transform:translate(-50%,-7.4em)}}
@keyframes fo-lift-loot{from{transform:translate(-50%,-.9em)}to{transform:translate(-50%,-5.3em)}}
@keyframes fo-dangle{from{transform:translate(-50%,-5.3em) rotate(-9deg)}to{transform:translate(-50%,-5.3em) rotate(9deg)}}
@keyframes fo-yank-hook{0%{transform:translate(-50%,-7.4em)}20%{transform:translate(-50%,-6.9em)}100%{transform:translate(calc(-50% + 8em),-15em) rotate(20deg);opacity:0}}
@keyframes fo-yank-loot{0%{transform:translate(-50%,-5.3em)}20%{transform:translate(-50%,-4.8em)}100%{transform:translate(calc(-50% + 8em),-13em) rotate(35deg);opacity:0}}
.fo-stamp{bottom:calc(var(--surf) + 2.2em);transform:translateX(-50%) rotate(-7deg);white-space:nowrap;font-size:1.05em;font-weight:900;letter-spacing:.08em;
  text-transform:uppercase;color:#fde047;padding:.08em .45em;border:.14em solid #fde047;border-radius:.35em;background:rgba(25,18,0,.72);
  text-shadow:0 1px 2px #000;box-shadow:0 0 .8em rgba(253,224,71,.55);
  animation:fo-stamp ${T(0.35)} cubic-bezier(.2,1.6,.4,1) ${T(1.55)} both,fo-out .4s ease-in ${T(3.35)} forwards}
@keyframes fo-stamp{from{transform:translateX(-50%) rotate(-7deg) scale(2.8);opacity:0}to{transform:translateX(-50%) rotate(-7deg) scale(1);opacity:1}}
.fo-lane.v-steal .fo-tag-heist{bottom:calc(var(--surf) + .3em)}

/* A big bite: the line tugs, the bobber thrashes, and the reel code waits over a draining timer. */
.v-bite .fo-line{animation:fo-line-drop ${T(0.5)} ease-out both,fo-line-tug .3s ease-in-out .5s infinite}
@keyframes fo-line-tug{50%{transform:rotate(4deg)}}
.v-bite .fo-bobber{animation:fo-bob-drop ${T(0.5)} cubic-bezier(.5,0,.8,.6) both,fo-thrash .32s ease-in-out .5s infinite}
@keyframes fo-thrash{0%,100%{transform:translate(0,.1em)}25%{transform:translate(-.28em,.55em)}75%{transform:translate(.28em,.35em)}}
.v-bite .fo-ripple.r1{animation:fo-ripple .9s ease-out .5s infinite}
.v-bite .fo-ripple.r2{animation:fo-ripple .9s ease-out .95s infinite}
.fo-codebox{bottom:calc(var(--surf) + 3.3em);transform:translateX(-50%);text-align:center;white-space:nowrap;padding:.12em .55em .08em;border-radius:.4em;
  background:rgba(8,16,32,.9);border:.1em solid #fde047;box-shadow:0 0 .8em rgba(253,224,71,.55);
  animation:fo-big-in .45s cubic-bezier(.3,1.6,.5,1) .3s both,fo-code-pulse 1s ease-in-out .8s infinite,fo-out .4s ease-in calc(var(--len) - .5s) forwards}
.fo-codebox b{display:block;font-size:2.3em;line-height:1;font-weight:900;letter-spacing:.06em;color:#fff;text-shadow:0 0 .3em rgba(253,224,71,.8)}
.fo-codelabel{display:block;font-size:.5em;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#fde047}
@keyframes fo-code-pulse{50%{box-shadow:0 0 1.5em rgba(253,224,71,.95)}}
.fo-timer{bottom:calc(var(--surf) + 2.55em);width:5em;height:.28em;margin-left:-2.5em;border-radius:.2em;transform-origin:left center;
  transition:transform .25s linear,background .4s}
.fo-codesecs{display:block;font-size:.55em;font-weight:800;letter-spacing:.04em;margin-top:.1em}
.fo-codebox b.fo-codelong{font-size:1.9em;letter-spacing:.1em}
.fo-codebox b.fo-codegone{color:rgba(255,255,255,.35);text-shadow:none;letter-spacing:.02em}

/* Mythic: a big bite trophy, above Legendary. */
.r-mythic .fo-aura{width:8em;height:8em;margin-left:-4em;bottom:calc(var(--surf) + 2.6em);
  background:conic-gradient(rgba(244,114,182,.75),rgba(96,165,250,.75),rgba(52,211,153,.75),rgba(250,204,21,.75),rgba(244,114,182,.75));
  -webkit-mask:radial-gradient(circle,#000 22%,transparent 68%);mask:radial-gradient(circle,#000 22%,transparent 68%);
  animation:fo-in .5s ease-out calc(var(--s) * 2.2s) both,fo-spin 3s linear infinite,fo-out .5s ease-in calc(var(--s) * 2.65s + var(--hold)) forwards}
.r-mythic .fo-tag b{color:#f9a8d4}
.v-caught .fo-hook{animation:fo-hook-drop ${T(0.6)} cubic-bezier(.5,0,.8,.6) both,fo-hook-fall ${T(0.8)} ease-in ${T(1.45)} forwards}
.v-caught .fo-loot{animation:fo-loot-up ${T(0.5)} ease-out ${T(0.65)} both,fo-loot-dive ${T(0.6)} ease-in ${T(1.45)} forwards}
.v-caught .fo-hook::before{animation:fo-out ${T(0.15)} ease-in ${T(1.45)} forwards}
@keyframes fo-hook-fall{0%{transform:translate(-50%,-3em)}25%{transform:translate(-50%,-3.6em) rotate(-25deg)}100%{transform:translate(calc(-50% - 3em),1.5em) rotate(-140deg);opacity:0}}
@keyframes fo-loot-dive{to{transform:translate(-50%,.8em) scale(.4);opacity:0}}
.fo-siren{bottom:calc(var(--surf) + .9em);transform:translateX(-50%);line-height:1;
  animation:fo-big-in ${T(0.45)} cubic-bezier(.3,1.6,.5,1) ${T(1.45)} both,fo-out .5s ease-in ${END} forwards}
.fo-siren>span{display:block;font-size:2.3em;filter:drop-shadow(0 0 .35em rgba(255,40,40,.95));animation:fo-flash .5s steps(2) ${T(1.45)} 5}
@keyframes fo-flash{50%{filter:drop-shadow(0 0 .7em rgba(80,120,255,.95)) brightness(1.5)}}
.fo-lane .fo-tag-heist{bottom:calc(var(--surf) + 4.4em);animation:fo-in .35s ease-out ${T(1.4)} both,fo-out .5s ease-in ${END} forwards}
.v-caught .fo-tag-heist{color:#fecaca}
`;
