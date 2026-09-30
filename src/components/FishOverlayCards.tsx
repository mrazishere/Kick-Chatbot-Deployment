"use client";

import { useEffect, useRef, useState } from "react";
import type { FishOverlayEvent } from "@/lib/bot-api";
import { codeHidden, syncClock, useCountdown } from "@/lib/overlay-clock";
import { demoGenerator, type DemoOdds } from "@/lib/fish-demo";

// The first overlay design: each fish reply as a text card. Kept beside the
// fishing scene (FishOverlay) so both can be compared; its URL has its own key.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const POLL_MS = 1500;
const TICK_MS = 100;
const EXIT_MS = 520;
/** Past this many waiting, misses (then other chatter) are dropped so the overlay catches up. */
const QUEUE_CAP = 20;

/**
 * How a burst is handled: at most `max` cards on screen, new ones enter one at a
 * time a short stagger apart, and while anything waits every card's time on
 * screen shrinks, down to a floor that keeps it readable. A rare catch keeps a
 * longer floor, and when the queue overflows misses go first.
 */
interface Card {
  ev: FishOverlayEvent;
  shownAt: number;
  phase: "in" | "out";
  outAt: number;
}

/** A big bite stays up for its whole window. */
const biteMs = (ev: FishOverlayEvent) => Math.max(5_000, Math.min(120_000, (ev.until ?? ev.ts + 30_000) - ev.ts));

function holdMs(ev: FishOverlayEvent): number {
  if (ev.kind === "bite") return biteMs(ev);
  if (ev.rarity === "Mythic") return 16_000;
  if (ev.rarity === "Legendary") return 14_000;
  if (ev.rarity === "Epic") return 11_000;
  if (ev.kind === "miss") return 4_500;
  if (ev.kind === "info") return 6_000;
  return 8_000;
}

/** The least time on screen, however long the queue. */
function floorMs(ev: FishOverlayEvent): number {
  if (ev.kind === "bite") return biteMs(ev);
  if (ev.rarity === "Mythic") return 8_000;
  if (ev.rarity === "Legendary") return 6_000;
  if (ev.rarity === "Epic") return 4_000;
  if (ev.kind === "miss") return 1_400;
  return 2_200;
}

function trimQueue(queue: FishOverlayEvent[]): void {
  for (const kind of ["miss", "info"] as const) {
    while (queue.length > QUEUE_CAP) {
      const i = queue.findIndex((e) => e.kind === kind && !e.rarity);
      if (i < 0) break;
      queue.splice(i, 1);
    }
  }
  // Never a big bite: its reel code has to show.
  while (queue.length > QUEUE_CAP) {
    const i = queue.findIndex((e) => e.kind !== "bite");
    if (i < 0) break;
    queue.splice(i, 1);
  }
}

function nameColor(name: string): string {
  let h = 0;
  for (const ch of name.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 85% 68%)`;
}

/** The reply without its "(… cooldown …)" note, which is shown smaller underneath. */
function splitNote(text: string): { main: string; note: string | null } {
  const m = /\s*\(([^()]*cooldown[^()]*)\)/i.exec(text);
  if (!m) return { main: text, note: null };
  return { main: (text.slice(0, m.index) + text.slice(m.index + m[0].length)).trim(), note: m[1] };
}

function Words({ text, emotes }: { text: string; emotes?: Record<string, string> }) {
  const parts = text.split(/(\s+)/);
  return (
    <>
      {parts.map((p, i) =>
        emotes?.[p] ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={emotes[p]} alt={p} className="fo-emote" />
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

const ICON: Record<FishOverlayEvent["kind"], string> = { catch: "🐟", trap: "🪤", miss: "🎣", steal: "🪝", caught: "🚨", bite: "🎣", info: "🎣" };

function CardView({ card, side }: { card: Card; side: "left" | "right" }) {
  const { ev } = card;
  const { main, note } = splitNote(ev.text);
  const rarity = ev.kind === "catch" && ev.rarity && ev.rarity !== "Common" ? ev.rarity : null;
  const measure = (el: HTMLDivElement | null) => {
    if (el && !el.style.getPropertyValue("--h")) el.style.setProperty("--h", `${el.scrollHeight}px`);
  };
  return (
    <div ref={measure} className={`fo-wrap ${card.phase === "in" ? "fo-in" : "fo-out"} ${side === "right" ? "fo-right" : ""}`}>
      <div className={`fo-card fo-${ev.kind} ${rarity ? `fo-${rarity.toLowerCase()}` : ""}`}>
        {rarity === "Legendary" || rarity === "Mythic" ? <span className="fo-shine" /> : null}
        <div className="fo-icon">
          <span className={ev.kind === "catch" ? "fo-pop" : ""}>{ev.kind === "catch" && ev.item ? ev.item : ICON[ev.kind]}</span>
        </div>
        <div className="fo-body">
          <div className="fo-head">
            <span className="fo-name" style={{ color: nameColor(ev.username) }}>
              {ev.username}
            </span>
            {rarity ? <span className="fo-rarity">{rarity}</span> : null}
          </div>
          <div className="fo-text">
            <Words text={main} emotes={ev.emotes} />
          </div>
          {ev.kind === "bite" && typeof ev.code === "string" ? <BiteCode ev={ev} /> : null}
          {note ? <div className="fo-note">{note}</div> : null}
        </div>
      </div>
    </div>
  );
}

/** A big bite card's code, which pull it is, and the time left on the bot's clock. */
function BiteCode({ ev }: { ev: FishOverlayEvent }) {
  const { secs } = useCountdown(ev.until, biteMs(ev));
  return (
    <div className="fo-bigcode">
      {ev.pulls && ev.pulls > 1 ? `Pull ${ev.pull}/${ev.pulls}` : "Reel code"} <b>{codeHidden(ev.flashUntil) ? "• • •" : ev.code}</b>
      <span className="fo-bigsecs">{secs > 0 ? `${secs}s left` : "time's up!"}</span>
    </div>
  );
}

// ─── The overlay ─────────────────────────────────────────────────────────────

export default function FishOverlayCards({
  channel,
  overlayKey,
  side,
  max,
  scale,
  demo,
  demoOdds,
}: {
  channel: string;
  overlayKey: string;
  side: "left" | "right";
  max: number;
  scale: number;
  demo: boolean;
  /** The channel's odds for the demo; null uses the bot's defaults. */
  demoOdds: DemoOdds | null;
}) {
  const queue = useRef<FishOverlayEvent[]>([]);
  const cards = useRef<Card[]>([]);
  const lastRelease = useRef(0);
  const [, setVersion] = useState(0);

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
          // A reel code can't wait its turn: big bites go to the front.
          queue.current.unshift(...fresh.filter((e) => e.kind === "bite"));
          queue.current.push(...fresh.filter((e) => e.kind !== "bite"));
          trimQueue(queue.current);
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
      queue.current.push(...demoBurst(id));
      id -= 10;
      trimQueue(queue.current);
    };
    fire();
    const t = setInterval(fire, 25_000);
    return () => clearInterval(t);
  }, [demo, demoOdds]);

  // The scheduler: expire, make room, release.
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      let changed = false;
      const before = cards.current.length;
      cards.current = cards.current.filter((c) => !(c.phase === "out" && now - c.outAt >= EXIT_MS));
      if (cards.current.length !== before) changed = true;

      const waiting = queue.current.length;
      const live = () => cards.current.filter((c) => c.phase === "in");
      for (const c of live()) {
        const full = holdMs(c.ev);
        const hold = waiting > 0 ? Math.max(floorMs(c.ev), full * (waiting > 5 ? 0.35 : 0.6)) : full;
        if (now - c.shownAt >= hold) {
          c.phase = "out";
          c.outAt = now;
          changed = true;
        }
      }

      // Full and more waiting: the oldest card past its floor makes way.
      if (waiting > 0 && live().length >= max) {
        const oldest = live().find((c) => now - c.shownAt >= floorMs(c.ev));
        if (oldest) {
          oldest.phase = "out";
          oldest.outAt = now;
          changed = true;
        }
      }

      const stagger = waiting > 4 ? 160 : 340;
      if (queue.current.length > 0 && live().length < max && now - lastRelease.current >= stagger) {
        const ev = queue.current.shift()!;
        // The angler's answer, or their next pull's code, ends their big bite card.
        for (const c of live()) {
          if (c.ev.kind === "bite" && c.ev.username === ev.username) {
            c.phase = "out";
            c.outAt = now;
          }
        }
        cards.current.push({ ev, shownAt: now, phase: "in", outAt: 0 });
        lastRelease.current = now;
        changed = true;
      }
      if (changed) setVersion((v) => v + 1);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [max]);

  return (
    <>
      <style>{CSS}</style>
      <div className={`fo-root ${side === "right" ? "fo-root-right" : ""}`} style={{ fontSize: `${20 * scale}px` }}>
        {cards.current.map((c) => (
          <CardView key={c.ev.id} card={c} side={side} />
        ))}
      </div>
    </>
  );
}

const CSS = `
.fo-root{position:fixed;inset:0;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;padding:1.2em;pointer-events:none;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif,"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji";color:#f5f5f5}
.fo-root-right{align-items:flex-end}
.fo-wrap{--dir:1;overflow:hidden;padding:.35em .6em;margin:-.1em -.6em;max-width:36em}
.fo-wrap.fo-right{--dir:-1}
.fo-in{animation:fo-grow .28s ease-out both}
.fo-in>.fo-card{animation:fo-slide .6s cubic-bezier(.2,1.35,.4,1) both}
.fo-out{animation:fo-shrink .32s ease-in .2s both}
.fo-out>.fo-card{animation:fo-leave .3s ease-in both}
@keyframes fo-grow{from{max-height:0}to{max-height:var(--h,16em)}}
@keyframes fo-shrink{from{max-height:var(--h,16em)}to{max-height:0;padding-top:0;padding-bottom:0}}
@keyframes fo-slide{from{transform:translateX(calc(var(--dir) * -115%)) scale(.92);opacity:0}to{transform:none;opacity:1}}
@keyframes fo-leave{to{transform:translateX(calc(var(--dir) * -30%)) scale(.96);opacity:0}}

.fo-card{position:relative;display:flex;gap:.7em;align-items:flex-start;padding:.6em .9em .6em .6em;border-radius:1em;overflow:hidden;
  background:linear-gradient(135deg,rgba(14,22,34,.9),rgba(10,12,18,.86));border:1px solid rgba(120,200,255,.18);
  box-shadow:0 .3em 1.2em rgba(0,0,0,.45);text-shadow:0 1px 2px rgba(0,0,0,.6)}
.fo-icon{flex:none;width:2.3em;height:2.3em;display:grid;place-items:center;border-radius:.7em;font-size:1.25em;
  background:radial-gradient(circle at 35% 30%,rgba(90,170,255,.35),rgba(20,50,90,.35))}
.fo-body{min-width:0}
.fo-head{display:flex;align-items:center;gap:.45em;line-height:1.2}
.fo-name{font-weight:700;font-size:.95em}
.fo-rarity{font-size:.62em;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:.15em .45em;border-radius:.4em;border:1px solid currentColor}
.fo-text{font-size:.9em;line-height:1.35;margin-top:.1em;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.fo-note{font-size:.68em;color:rgba(230,236,245,.55);margin-top:.2em}
.fo-emote{display:inline-block;height:1.5em;vertical-align:-.4em;margin:0 .05em}
.fo-pop{display:inline-block;animation:fo-pop .75s cubic-bezier(.3,1.9,.5,1) .25s both}
@keyframes fo-pop{from{transform:scale(0) rotate(-35deg)}to{transform:none}}

.fo-miss{opacity:.82;padding:.4em .8em .4em .45em}
.fo-miss .fo-icon{width:1.8em;height:1.8em;font-size:1em;background:rgba(255,255,255,.06)}
.fo-miss .fo-text{font-size:.8em;-webkit-line-clamp:2}
.fo-trap .fo-icon{background:radial-gradient(circle at 35% 30%,rgba(120,220,140,.35),rgba(20,70,40,.35))}

.fo-uncommon{border-color:rgba(80,220,150,.45)} .fo-uncommon .fo-rarity{color:#6ee7b7}
.fo-rare{border-color:rgba(90,180,255,.6);box-shadow:0 0 1em rgba(60,150,255,.3),0 .3em 1.2em rgba(0,0,0,.45)} .fo-rare .fo-rarity{color:#7dd3fc}
.fo-epic{border-color:rgba(220,120,255,.7)}
.fo-in>.fo-epic{animation:fo-slide .6s cubic-bezier(.2,1.35,.4,1) both,fo-epic 1.6s ease-in-out .6s infinite}
.fo-epic .fo-rarity{color:#f0abfc}
.fo-epic .fo-icon{background:radial-gradient(circle at 35% 30%,rgba(220,120,255,.5),rgba(80,20,110,.4))}
@keyframes fo-epic{50%{box-shadow:0 0 1.6em rgba(210,100,255,.55),0 .3em 1.2em rgba(0,0,0,.45)}}
.fo-legendary{border:1.5px solid rgba(255,200,70,.9);background:linear-gradient(135deg,rgba(60,40,8,.92),rgba(18,12,4,.9))}
.fo-in>.fo-legendary{animation:fo-slide .6s cubic-bezier(.2,1.35,.4,1) both,fo-legend 1.2s ease-in-out .6s infinite}
.fo-legendary .fo-rarity{color:#fcd34d}
.fo-legendary .fo-icon{background:radial-gradient(circle at 35% 30%,rgba(255,210,90,.65),rgba(120,70,0,.45));font-size:1.45em}
@keyframes fo-legend{50%{box-shadow:0 0 2.2em rgba(255,190,60,.7),0 .3em 1.2em rgba(0,0,0,.45)}}
.fo-shine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(110deg,transparent 30%,rgba(255,235,160,.35) 50%,transparent 70%);
  transform:translateX(-100%);animation:fo-shine 2.2s ease-in-out .5s infinite}
@keyframes fo-shine{60%,100%{transform:translateX(100%)}}
.fo-bite{border:1.5px solid rgba(253,224,71,.9);animation:fo-legend 1s ease-in-out infinite}
.fo-bigcode{margin-top:.3em;font-size:.8em;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#fde047}
.fo-bigcode b{margin-left:.3em;font-size:2em;letter-spacing:.04em;color:#fff;vertical-align:middle;text-shadow:0 0 .3em rgba(253,224,71,.8)}
.fo-bigsecs{margin-left:.6em;font-size:1em;color:#fbbf24}
.fo-mythic{border:1.5px solid rgba(244,114,182,.9);background:linear-gradient(135deg,rgba(60,14,48,.92),rgba(14,20,50,.9))}
.fo-in>.fo-mythic{animation:fo-slide .6s cubic-bezier(.2,1.35,.4,1) both,fo-mythic 1.2s ease-in-out .6s infinite}
.fo-mythic .fo-rarity{color:#f9a8d4}
.fo-mythic .fo-icon{background:conic-gradient(rgba(244,114,182,.6),rgba(96,165,250,.6),rgba(52,211,153,.6),rgba(250,204,21,.6),rgba(244,114,182,.6));font-size:1.5em}
@keyframes fo-mythic{50%{box-shadow:0 0 2.4em rgba(244,114,182,.7),0 .3em 1.2em rgba(0,0,0,.45)}}
`;
