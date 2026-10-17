"use client";

// The prize wheel on the fishing overlays. The bot picks the winner (`!wheel spin`);
// this only plays the spin landing on it, then holds the result a few seconds. While
// a wheel is up, the overlay holds its fishing alerts and they play after it.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FishOverlayEvent, FishOverlayWheel } from "@/lib/bot-api";

/** How long the result stays up after the wheel stops (the bot holds big bites as long). */
const RESULT_MS = 5_000;
const FADE_MS = 400;
/** Slices without a colour of their own, in turn. */
const PALETTE = ["#ef4444", "#f59e0b", "#eab308", "#22c55e", "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899", "#f97316", "#06b6d4", "#84cc16", "#a855f7"];

/** Black or white, whichever reads on this slice. */
function inkFor(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#111827" : "#ffffff";
}

function colorsOf(w: FishOverlayWheel): string[] {
  const n = w.items.length;
  return w.items.map((it, i) => {
    if (it.color) return it.color;
    let c = PALETTE[i % PALETTE.length];
    // Don't let the last auto colour meet the first one where the wheel wraps round.
    if (i === n - 1 && n > 1 && !w.items[0].color && c === PALETTE[0]) c = PALETTE[(i + 1) % PALETTE.length];
    return c;
  });
}

const polar = (deg: number, r: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)] as const;
};

function Wheel({ ev, onDone }: { ev: FishOverlayEvent & { wheel: FishOverlayWheel }; onDone: () => void }) {
  const w = ev.wheel;
  const n = w.items.length;
  const slice = 360 / n;
  const colors = useMemo(() => colorsOf(w), [w]);
  // Where it stops: the winning slice under the pointer, somewhere inside it rather than dead centre.
  const target = useMemo(() => {
    const within = 0.5 + (Math.random() - 0.5) * 0.7;
    const turns = Math.max(4, Math.round(w.spinMs / 1000));
    return turns * 360 + (360 - (w.winner + within) * slice);
  }, [w.spinMs, w.winner, slice]);
  const [angle, setAngle] = useState(0);
  const [phase, setPhase] = useState<"spin" | "result" | "out">("spin");

  useEffect(() => {
    // One frame at 0 first, so the browser animates from there.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setAngle(target)));
    const t1 = setTimeout(() => setPhase("result"), w.spinMs + 100);
    const t2 = setTimeout(() => setPhase("out"), w.spinMs + 100 + RESULT_MS);
    const t3 = setTimeout(onDone, w.spinMs + 100 + RESULT_MS + FADE_MS);
    return () => {
      cancelAnimationFrame(raf);
      [t1, t2, t3].forEach(clearTimeout);
    };
  }, [target, w.spinMs, onDone]);

  const won = w.items[w.winner];
  // Labels run from the rim toward the hub: as big as fits both the 33 units of radius
  // they have short of the hub (about 0.62 of the size per character) and the slice's width halfway out.
  const shown = (label: string) => (label.length > 18 ? `${label.slice(0, 17)}…` : label);
  const fontFor = (label: string) => Math.max(2.4, Math.min(7.5, 33 / (shown(label).length * 0.62), ((2 * Math.PI * 28) / n) * 0.5));

  return (
    <div className={`fw-stage ${phase === "out" ? "fw-out" : ""}`}>
      <div className="fw-title">🎡 {ev.username} spun the wheel</div>
      <div className="fw-wheelbox">
        <div className="fw-pointer" />
        <svg
          className="fw-wheel"
          viewBox="0 0 100 100"
          style={{ transform: `rotate(${angle}deg)`, transitionDuration: `${w.spinMs}ms` } as CSSProperties}
        >
          {w.items.map((it, i) => {
            const a0 = i * slice;
            const a1 = (i + 1) * slice;
            const [x0, y0] = polar(a0, 48);
            const [x1, y1] = polar(a1, 48);
            const large = slice > 180 ? 1 : 0;
            const mid = a0 + slice / 2;
            const [tx, ty] = polar(mid, 44);
            const lit = phase !== "spin" && i === w.winner;
            const dim = phase !== "spin" && i !== w.winner;
            return (
              <g key={i} className={lit ? "fw-lit" : dim ? "fw-dim" : undefined}>
                <path d={n === 1 ? "M50 2 A48 48 0 1 1 49.99 2Z" : `M50 50 L${x0} ${y0} A48 48 0 ${large} 1 ${x1} ${y1}Z`} fill={colors[i]} stroke="rgba(0,0,0,.35)" strokeWidth=".4" />
                <text
                  x={tx}
                  y={ty}
                  fill={inkFor(colors[i])}
                  fontSize={fontFor(it.label)}
                  fontWeight={800}
                  textAnchor="end"
                  dominantBaseline="central"
                  transform={`rotate(${mid - 90} ${tx} ${ty})`}
                >
                  {shown(it.label)}
                </text>
              </g>
            );
          })}
          <circle cx="50" cy="50" r="48" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="1.2" />
          <circle cx="50" cy="50" r="6" fill="#111827" stroke="#fde047" strokeWidth="1.2" />
        </svg>
      </div>
      <div key={phase === "spin" ? "spin" : "won"} className="fw-result">{phase === "spin" ? " " : <>🎉 <b>{won?.label}</b></>}</div>
    </div>
  );
}

/**
 * The wheel for an overlay. `take` keeps wheel spins out of a batch of feed events
 * and hands back the rest; `stage` draws the one playing; `showing` is whether one
 * is up (the overlay holds its fishing alerts meanwhile), `busy` also counts ones waiting.
 */
/** A made-up spin for &wheel=1, to see how the wheel sits in the source. */
function sampleWheel(id: number): FishOverlayEvent & { wheel: FishOverlayWheel } {
  const labels = ["Sing a song", "10 pushups", "Hydrate", "Raid someone", "Pick a game", "Accent for 5 min", "Spin again", "Free choice"];
  const items = labels.slice(0, 4 + (Math.abs(id) % 5)).map((label) => ({ label }));
  return { id, ts: Date.now(), username: "demo", kind: "wheel", text: "demo spun the wheel!", wheel: { items, winner: Math.floor(Math.random() * items.length), spinMs: 6_000 } };
}

export function useWheel({ fontPx, clearBottom = 0, demo = false }: { fontPx: number; clearBottom?: number; demo?: boolean }): {
  take: (events: FishOverlayEvent[]) => FishOverlayEvent[];
  stage: ReactNode;
  showing: boolean;
  isShowing: () => boolean;
  busy: () => boolean;
} {
  const waiting = useRef<Array<FishOverlayEvent & { wheel: FishOverlayWheel }>>([]);
  const [playing, setPlaying] = useState<(FishOverlayEvent & { wheel: FishOverlayWheel }) | null>(null);
  const playingRef = useRef(playing);
  playingRef.current = playing;

  const take = useCallback((events: FishOverlayEvent[]): FishOverlayEvent[] => {
    const rest: FishOverlayEvent[] = [];
    for (const ev of events) {
      if (ev.kind === "wheel") {
        if (ev.wheel) waiting.current.push(ev as FishOverlayEvent & { wheel: FishOverlayWheel });
        continue;
      }
      rest.push(ev);
    }
    // Shown at once, not on the next tick, so the scheduler holds alerts from this batch on.
    if (!playingRef.current && waiting.current.length) {
      playingRef.current = waiting.current.shift()!;
      setPlaying(playingRef.current);
    }
    return rest;
  }, []);

  useEffect(() => {
    if (!demo) return;
    let id = -5000;
    const fire = () => {
      waiting.current.push(sampleWheel(id--));
      if (!playingRef.current) {
        playingRef.current = waiting.current.shift()!;
        setPlaying(playingRef.current);
      }
    };
    fire();
    const t = setInterval(fire, 25_000);
    return () => {
      clearInterval(t);
      waiting.current = waiting.current.filter((e) => e.id >= 0);
    };
  }, [demo]);

  const finish = useCallback(() => {
    const next = waiting.current.shift() ?? null;
    playingRef.current = next;
    setPlaying(next);
  }, []);

  // The wheel is about 16.5em tall with its title and result: in a short source it draws smaller.
  const [fitPx, setFitPx] = useState(fontPx);
  useEffect(() => {
    const fit = () => setFitPx(Math.max(8, Math.min(fontPx * 1.15, (window.innerHeight * (1 - clearBottom)) / 17.5, window.innerWidth / 16.5)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fontPx, clearBottom]);

  const isShowing = useCallback(() => playingRef.current !== null, []);
  const busy = useCallback(() => playingRef.current !== null || waiting.current.length > 0, []);

  const stage = useMemo(
    () =>
      playing ? (
        <>
          <style>{CSS}</style>
          <div className="fw-root" style={{ fontSize: `${fitPx}px`, bottom: `${clearBottom * 100}vh` }}>
            <Wheel key={playing.id} ev={playing} onDone={finish} />
          </div>
        </>
      ) : null,
    [playing, fitPx, finish, clearBottom],
  );

  return { take, stage, showing: playing !== null, isShowing, busy };
}

const CSS = `
.fw-root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:6;color:#f5f5f5;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif,"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji"}
.fw-stage{display:flex;flex-direction:column;align-items:center;gap:.35em;padding:.6em .9em;border-radius:1em;
  background:radial-gradient(circle at 50% 40%,rgba(20,28,44,.82),rgba(8,10,16,.78));box-shadow:0 .3em 1.6em rgba(0,0,0,.5);
  text-shadow:0 1px 2px rgba(0,0,0,.6);animation:fw-enter .45s cubic-bezier(.2,1.3,.4,1) both;transition:opacity ${FADE_MS}ms ease,transform ${FADE_MS}ms ease}
.fw-out{opacity:0;transform:scale(.9)}
@keyframes fw-enter{from{transform:scale(.75);opacity:0}to{transform:none;opacity:1}}
.fw-title{font-size:.8em;font-weight:800;letter-spacing:.06em;color:#fde047;max-width:18em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fw-wheelbox{position:relative;width:13.5em;height:13.5em}
.fw-wheel{width:100%;height:100%;display:block;transition-property:transform;transition-timing-function:cubic-bezier(.12,.72,.12,1);
  filter:drop-shadow(0 .2em .5em rgba(0,0,0,.55))}
.fw-wheel text{paint-order:stroke;stroke:rgba(0,0,0,.25);stroke-width:.25px;font-family:inherit}
.fw-pointer{position:absolute;left:50%;top:-.45em;z-index:1;width:0;height:0;transform:translateX(-50%);
  border-left:.55em solid transparent;border-right:.55em solid transparent;border-top:1.1em solid #fde047;filter:drop-shadow(0 .1em .15em rgba(0,0,0,.6))}
.fw-dim{opacity:.35;transition:opacity .4s ease}
.fw-lit path{animation:fw-glow .7s ease-in-out infinite alternate}
@keyframes fw-glow{to{filter:brightness(1.35)}}
.fw-result{min-height:1.4em;font-size:1.15em;font-weight:800;color:#fde047;max-width:16em;text-align:center;animation:fw-pop .4s cubic-bezier(.2,1.4,.4,1) both}
.fw-result b{color:#fff}
@keyframes fw-pop{from{transform:scale(.6);opacity:0}to{transform:none;opacity:1}}
`;
