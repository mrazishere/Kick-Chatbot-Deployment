"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FishOverlayEvent } from "@/lib/bot-api";
import { STALE_WAIT_MS, freshReloadDue, isStale, paintStalled, reloadAfterStall, reloadAsked, reloadFresh, reloadInto, noteFeedStart, reloadNow, takeCursor, usePaintReport, withBuild } from "@/lib/overlay-build";
import { snipeIsOpen, syncClock, useCodeHidden, useCountdown } from "@/lib/overlay-clock";
import { demoBigBite, demoGenerator, type DemoOdds } from "@/lib/fish-demo";
import { useWheel } from "@/components/FishWheelStage";
import { useDuels } from "@/components/FishDuelStage";

// The first overlay design: each fish reply as a text card. Kept beside the
// fishing scene (FishOverlay) so both can be compared; its URL has its own key.

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const POLL_MS = 500;
const TICK_MS = 100;
const EXIT_MS = 520;
/** Past this many waiting, misses (then other chatter) are dropped so the overlay catches up. */
const QUEUE_CAP = 20;
/** The share of the source's height, from the top, kept for big bite codes; every other reply stacks in the rest. */
const TOP_SHARE = 0.5;
/** A big bite's code card with the room around it, in em of its own font: its zone has to hold that. */
const TOP_ZONE_EM = 9;
/** And across: the card at its widest with its margins. Only checked where a corner is kept clear, which narrows the zone. */
const ROAM_WIDTH_EM = 17.4;
/** Every other reply draws at this share of the asked size: they come often, so they stay small beside a big bite's code. */
const STACK_SHARE = 0.75;

/** The bottom-right corner kept clear, as percentages of the source's width and height. */
type Clear = { w: number; h: number };

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
  /** A big bite card's spot in the source, each 0 to 1 across and down: a new one for every code. */
  x?: number;
  y?: number;
  /** A reply too long for the zone turns pages: how many, and how long each shows. Set by the card once it's drawn. */
  pages?: number;
  pageMs?: number;
}

/** A reply this long (in characters) is a leaderboard or a stats line, not a one-liner. */
const LONG_TEXT = 160;

/** A big bite stays up for its whole window. */
const biteMs = (ev: FishOverlayEvent) => Math.max(5_000, Math.min(120_000, (ev.until ?? ev.ts + 30_000) - ev.ts));

function holdMs(ev: FishOverlayEvent): number {
  if (ev.kind === "bite") return biteMs(ev);
  if (ev.rarity === "Mythic") return 16_000;
  if (ev.rarity === "Legendary") return 14_000;
  if (ev.rarity === "Epic") return 11_000;
  if (ev.kind === "miss") return 4_500;
  // A leaderboard or someone's stats takes a while to read.
  if (ev.text.length > LONG_TEXT) return 12_000;
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
  if (ev.text.length > LONG_TEXT) return 7_000;
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

const ICON: Record<FishOverlayEvent["kind"], string> = { catch: "🐟", trap: "🪤", miss: "🎣", steal: "🪝", caught: "🚨", bite: "🎣", duel: "⚔️", wheel: "🎡", info: "🎣" };

function CardView({ card, side }: { card: Card; side: "left" | "right" }) {
  const { ev } = card;
  const { main, note } = splitNote(ev.text);
  const rarity = ev.kind === "catch" && ev.rarity && ev.rarity !== "Common" ? ev.rarity : null;
  const wrap = useRef<HTMLDivElement>(null);
  // A long reply (a leaderboard, someone's stats) takes as many lines as the lower zone has room for. If that still
  // isn't all of it, the text stays at its full size and the card turns pages, so it can be read from a small source.
  // Fitted again on every draw: the size and the zone change when the feed or the source's size does.
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(0);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const text = el.querySelector<HTMLElement>(".fo-text");
    const zone = el.parentElement;
    if (text && zone && card.x === undefined && ev.kind !== "miss") {
      text.style.display = "";
      text.style.maxHeight = "";
      const zoneEm = zone.clientHeight / (parseFloat(getComputedStyle(zone).fontSize) || 20);
      // A card is its text lines (1.215em each) plus about 4.1em of name, note and padding; the zone has 1.6em of its own.
      const lines = Math.max(2, Math.floor((zoneEm - 1.6 - 4.1) / 1.215));
      text.style.setProperty("-webkit-line-clamp", String(lines));
      let n = 1;
      if (text.scrollHeight > text.clientHeight + 1) {
        const pageH = lines * (parseFloat(getComputedStyle(text).lineHeight) || text.clientHeight / lines);
        text.style.display = "block";
        text.style.maxHeight = `${pageH}px`;
        n = Math.max(1, Math.ceil((text.scrollHeight - 2) / pageH));
        text.scrollTop = Math.min(page, n - 1) * pageH;
        card.pageMs = Math.min(6_500, 2_000 + 1_100 * lines);
      }
      card.pages = n;
      if (n !== pages) setPages(n);
    }
    if (!el.style.getPropertyValue("--h")) el.style.setProperty("--h", `${el.scrollHeight}px`);
  });
  useEffect(() => {
    if (pages <= 1) return;
    const t = setInterval(() => setPage(Math.min(pages - 1, Math.floor((performance.now() - card.shownAt) / (card.pageMs ?? 5_000)))), 250);
    return () => clearInterval(t);
  }, [pages, card]);
  return (
    <div
      ref={wrap}
      data-card={ev.id}
      className={`fo-wrap ${card.phase === "in" ? "fo-in" : "fo-out"} ${side === "right" ? "fo-right" : ""} ${card.x !== undefined ? "fo-roam" : ""}`}
      style={card.x !== undefined ? ({ "--x": card.x, "--y": card.y ?? 0 } as React.CSSProperties) : undefined}
    >
      <div className={`fo-card fo-${ev.kind} ${rarity ? `fo-${rarity.toLowerCase()}` : ""}`}>
        {rarity === "Legendary" || rarity === "Mythic" ? <span className="fo-shine" /> : null}
        <div className="fo-icon">
          <span className={ev.kind === "catch" ? "fo-pop" : ""}>
            {ev.kind === "catch" && ev.item && ev.emotes?.[ev.item] ? (
              <img src={ev.emotes[ev.item]} alt={ev.item} style={{ height: "1em", verticalAlign: "middle" }} />
            ) : ev.kind === "catch" && ev.item ? ev.item : ICON[ev.kind]}
          </span>
        </div>
        <div className="fo-body">
          <div className="fo-head">
            <span className="fo-name" style={{ color: nameColor(ev.username) }}>
              {ev.username}
            </span>
            {rarity ? <span className="fo-rarity">{rarity}</span> : null}
            {pages > 1 ? <span className="fo-page">{Math.min(page, pages - 1) + 1}/{pages}</span> : null}
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
  const { label } = useCountdown(ev.until, biteMs(ev));
  const hidden = useCodeHidden(ev.flashMs);
  const sniping = snipeIsOpen(ev.snipeAt);
  return (
    <div className={`fo-bigcode ${sniping ? "fo-sniping" : ""}`}>
      {sniping ? "Anyone can snipe it!" : ev.pulls && ev.pulls > 1 ? `Pull ${ev.pull}/${ev.pulls}` : "Reel code"} <b>{hidden ? "• • •" : ev.code}</b>
      <span className="fo-bigsecs">{label}</span>
    </div>
  );
}

/**
 * Where the two zones sit, for the stylesheet: the stack's top and bottom edges, and the
 * codes' zone from its top-left corner (it always starts at the source's left edge).
 */
function zones(clear: Clear | null): Record<string, string> {
  if (!clear) return { "--st": `${TOP_SHARE * 100}vh`, "--sb": "0px", "--rt": "0px", "--rw": "100vw", "--rh": `${TOP_SHARE * 100}vh` };
  return { "--st": "0px", "--sb": `${clear.h}vh`, "--rt": `${100 - clear.h}vh`, "--rw": `${100 - clear.w}vw`, "--rh": `${clear.h}vh` };
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
  duelDemo,
  wheelDemo = false,
}: {
  channel: string;
  overlayKey: string;
  side: "left" | "right";
  max: number;
  scale: number;
  demo: boolean;
  /** The channel's odds for the demo; null uses the bot's defaults. */
  demoOdds: DemoOdds | null;
  /** Play a made-up fish duel now and then, to preview it. */
  duelDemo: boolean;
  /** Spin a made-up wheel now and then, to preview it. */
  wheelDemo?: boolean;
}) {
  const queue = useRef<FishOverlayEvent[]>([]);
  const cards = useRef<Card[]>([]);
  const lastRelease = useRef(0);
  const lastSpot = useRef({ x: -1, y: -1 });
  const root = useRef<HTMLDivElement>(null);
  // The source is split: big bite codes get the top half (TOP_SHARE), every other reply stacks in the rest.
  // With a corner kept clear (the channel's map, say) it's the other way up: replies stack above the corner,
  // and the codes roam the strip to its left.
  // A code card is about 7em tall; where its zone is shorter than that, it draws smaller to fit.
  const [roamPx, setRoamPx] = useState(20 * scale);
  // Drawn bigger, a reply wraps onto more lines, but never so many that one card is taller than the lower zone.
  const [lines, setLines] = useState(3);
  // And where even a two-line card wouldn't fit there, the stack draws smaller, as the code card does.
  const [stackPx, setStackPx] = useState(20 * scale * STACK_SHARE);
  const [, setVersion] = useState(0);
  // Whether the channel lets the demo play, from the feed; null until the feed has answered.
  const [demoAllowed, setDemoAllowed] = useState<boolean | null>(null);
  // The channel's own size setting, from the feed, on top of the link's scale.
  const [size, setSize] = useState(1);
  // And the corner it wants kept clear, from the feed too.
  const [clear, setClear] = useState<Clear | null>(null);
  // The prize wheel plays over everything, and holds the cards until it's done.
  const wheel = useWheel({ fontPx: 20 * scale * size, clearBottom: clear ? clear.h / 100 : 0, demo: wheelDemo && demoAllowed === true });
  const takeWheel = wheel.take;
  const wheelShowing = wheel.isShowing;
  const wheelBusy = wheel.busy;
  // Fish duels play on a stage of their own, over the cards.
  const duels = useDuels({ fontPx: 20 * scale * size, demo: duelDemo && demoAllowed === true, clearBottom: clear ? clear.h / 100 : 0, held: wheel.showing });
  const takeDuels = duels.take;
  const duelsBusy = duels.busy;

  useEffect(() => {
    const fit = () => {
      const asked = 20 * scale * size;
      const roamH = window.innerHeight * (clear ? clear.h / 100 : TOP_SHARE);
      const roamW = clear ? (window.innerWidth * (100 - clear.w)) / 100 : Infinity;
      const stackH = window.innerHeight - roamH;
      setRoamPx(Math.max(8, Math.min(asked, roamH / TOP_ZONE_EM, roamW / ROAM_WIDTH_EM)));
      // A card is its text lines (1.215em each) plus about 4.1em of name, note and padding; the zone has 1.6em of its own padding.
      const em = Math.max(8, Math.min(asked * STACK_SHARE, stackH / (1.6 + 4.1 + 2 * 1.215 + 0.3)));
      setStackPx(em);
      const fitLines = Math.floor((stackH / em - 1.6 - 4.1) / 1.215);
      setLines(Math.max(2, Math.min(Math.max(3, Math.ceil(3 * size)), fitLines)));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [scale, size, clear]);

  // Poll the feed. The first answer only sets where to start, so opening the
  // source doesn't replay the last few minutes.
  useEffect(() => {
    const url = `${BASE_PATH}/api/overlay/${encodeURIComponent(channel)}/fishing?key=${encodeURIComponent(overlayKey)}`;
    // After reloading into a new build, carry on from where the old page was.
    let after: number | null = takeCursor(url);
    if (after !== null) noteFeedStart(after);
    // Since when the feed has been on a newer build than this page.
    let staleSince: number | null = null;
    const poll = async () => {
      try {
        const res = await fetch(withBuild(url), { cache: "no-store" });
        if (!res.ok) {
          setDemoAllowed((a) => a ?? true); // no feed (fishing off, say): the demo still previews
          return;
        }
        const data = (await res.json()) as { lastId: number; events: FishOverlayEvent[]; now?: number; build?: string; demo?: boolean; size?: number; clear?: Clear; leadMs?: number; graceMs?: number; reload?: number };
        // Told to reload (a mod's command, or the bot after a code went undrawn): now, busy or not.
        if (reloadAsked(data.reload)) return reloadNow(url, after);
        syncClock(data.now, data.leadMs, data.graceMs);
        setDemoAllowed(data.demo !== false);
        setSize((data.size ?? 100) / 100);
        const c = data.clear ?? null;
        setClear((was) => (was?.w === c?.w && was?.h === c?.h ? was : c));
        if (after === null || data.lastId < after) {
          after = data.lastId; // first load, or the feed restarted
          noteFeedStart(after);
          return;
        }
        const all = data.events.filter((e) => e.id > (after as number));
        if (all.length) {
          after = Math.max(...all.map((e) => e.id));
          const fresh = takeDuels(takeWheel(all));
          // A reel code can't wait its turn: big bites go to the front.
          queue.current.unshift(...fresh.filter((e) => e.kind === "bite"));
          queue.current.push(...fresh.filter((e) => e.kind !== "bite"));
          trimQueue(queue.current);
        }
        // A newer dashboard build is live: reload into it once nothing is on screen, or after
        // STALE_WAIT_MS anyway (a page that never went quiet stayed on an old build for good) unless a code is up.
        const idle = cards.current.length === 0 && queue.current.length === 0 && !duelsBusy() && !wheelBusy();
        if (isStale(data.build)) {
          staleSince ??= Date.now();
          const waited = Date.now() - staleSince >= STALE_WAIT_MS && !cards.current.some((c) => c.phase === "in" && c.ev.kind === "bite");
          if (idle || waited) reloadInto(data.build!, url, after);
        }
        // Not drawing any more, so nothing on screen is being seen anyway: reload to get it going.
        else if (paintStalled()) reloadAfterStall(url, after);
        // Open a long while: a fresh copy, while there's nothing on it to see go.
        else if (idle && freshReloadDue()) reloadFresh(url, after);
      } catch {
        // offline for a moment; the next poll catches up
        setDemoAllowed((a) => a ?? true);
      }
    };
    void poll();
    const t = setInterval(poll, POLL_MS);
    return () => clearInterval(t);
  }, [channel, overlayKey, takeDuels, duelsBusy, takeWheel, wheelBusy]);

  useEffect(() => {
    if (!demo || !demoAllowed) return;
    // Ten anglers at once, repeated, rolled at the channel's odds, to see how a burst plays.
    const demoBurst = demoGenerator(demoOdds);
    let id = -1;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const fire = () => {
      queue.current.push(...demoBurst(id));
      // And a big bite a few seconds into each burst: its codes, then the trophy.
      for (const s of demoBigBite(id - 10)) {
        timers.push(setTimeout(() => {
          const ev = s.at();
          if (ev.kind === "bite") queue.current.unshift(ev);
          else queue.current.push(ev);
        }, 3_000 + s.afterMs));
      }
      id -= 20;
      trimQueue(queue.current);
    };
    fire();
    const t = setInterval(fire, 25_000);
    return () => {
      clearInterval(t);
      timers.forEach(clearTimeout);
      // Turned off mid-burst: the demo anglers still waiting go too.
      queue.current = queue.current.filter((e) => e.id >= 0);
    };
  }, [demo, demoAllowed, demoOdds]);

  // The scheduler: expire, make room, release.
  useEffect(() => {
    const t = setInterval(() => {
      const now = performance.now();
      let changed = false;
      const before = cards.current.length;
      cards.current = cards.current.filter((c) => !(c.phase === "out" && now - c.outAt >= EXIT_MS));
      if (cards.current.length !== before) changed = true;

      // The wheel is up: cards on screen go back to the front of the queue to show in
      // full afterwards (not a big bite's code: the bot holds bites around a spin, so
      // one still up has ended), and nothing new shows until it's done.
      if (wheelShowing()) {
        if (cards.current.length) {
          queue.current.unshift(...cards.current.filter((c) => c.phase === "in" && c.ev.kind !== "bite").map((c) => c.ev));
          cards.current = [];
          changed = true;
        }
        if (changed) setVersion((v) => v + 1);
        return;
      }

      const waiting = queue.current.length;
      const live = () => cards.current.filter((c) => c.phase === "in");
      for (const c of live()) {
        const full = holdMs(c.ev);
        // A card turning pages stays for all of them, whatever is waiting.
        const paged = (c.pages ?? 1) > 1 ? c.pages! * (c.pageMs ?? 5_000) + 400 : 0;
        const hold = paged || (waiting > 0 ? Math.max(floorMs(c.ev), full * (waiting > 5 ? 0.35 : 0.6)) : full);
        if (now - c.shownAt >= hold) {
          c.phase = "out";
          c.outAt = now;
          changed = true;
        }
      }

      // The stack has the lower zone only. It's as good as full when one more card, taken
      // at the size of the newest, wouldn't fit under the top zone.
      const zoneFull = (): boolean => {
        const zone = root.current;
        const stackNow = live().filter((c) => c.x === undefined);
        if (!zone || !stackNow.length) return false;
        const first = zone.querySelector(`[data-card="${stackNow[0].ev.id}"]`)?.getBoundingClientRect();
        const last = zone.querySelector(`[data-card="${stackNow[stackNow.length - 1].ev.id}"]`)?.getBoundingClientRect();
        if (!first || !last) return false;
        const style = getComputedStyle(zone);
        const room = zone.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - (last.bottom - first.top);
        return room < last.height;
      };
      // A card turning pages has the lower zone to itself until it's done: nothing new stacks on it and pushes it out.
      const full = live().length >= max || live().some((c) => (c.pages ?? 1) > 1) || zoneFull();

      // Full and more waiting: the oldest card past its floor makes way.
      if (waiting > 0 && full) {
        const oldest = live().find((c) => c.x === undefined && (c.pages ?? 1) <= 1 && now - c.shownAt >= floorMs(c.ev));
        if (oldest) {
          oldest.phase = "out";
          oldest.outAt = now;
          changed = true;
        }
      }

      // The stack only has the lower zone: when it outgrows it, its oldest card leaves,
      // one at a time (a leaving card still takes up room for a moment).
      const el = root.current;
      const stack = live().filter((c) => c.x === undefined);
      const topCard = stack.length > 1 ? el?.querySelector(`[data-card="${stack[0].ev.id}"]`) : null;
      if (el && topCard && topCard.getBoundingClientRect().top < el.getBoundingClientRect().top - 1 && !cards.current.some((c) => c.phase === "out" && c.x === undefined)) {
        {
          stack[0].phase = "out";
          stack[0].outAt = now;
          changed = true;
        }
      }

      const stagger = waiting > 4 ? 160 : 340;
      // A big bite's code has the top zone to itself, so it never waits on the stack.
      if (queue.current.length > 0 && (!full || queue.current[0].kind === "bite") && now - lastRelease.current >= stagger) {
        const ev = queue.current.shift()!;
        // The angler's answer, or their next pull's code, ends their big bite card; another
        // reply to them (a lookup they typed meanwhile) leaves the code up.
        for (const c of ev.kind === "info" ? [] : live()) {
          // Only a reply from after the code: an older one may have waited in the queue behind it.
          // Feed ids count up; the demo's count down from -1.
          const newer = c.ev.id >= 0 ? ev.id > c.ev.id : ev.id < c.ev.id;
          if (c.ev.kind === "bite" && c.ev.username === ev.username && newer) {
            c.phase = "out";
            c.outAt = now;
          }
        }
        // A big bite's code turns up somewhere else each time, well away from where the last one was.
        let spot = {};
        if (ev.kind === "bite") {
          let x = Math.random();
          let y = Math.random();
          for (let i = 0; i < 20 && Math.abs(x - lastSpot.current.x) < 0.35 && Math.abs(y - lastSpot.current.y) < 0.35; i++) {
            x = Math.random();
            y = Math.random();
          }
          lastSpot.current = { x, y };
          spot = { x, y };
        }
        cards.current.push({ ev, shownAt: now, phase: "in", outAt: 0, ...spot });
        lastRelease.current = now;
        changed = true;
      }
      if (changed) setVersion((v) => v + 1);
    }, TICK_MS);
    return () => clearInterval(t);
  }, [max, wheelShowing]);

  usePaintReport(cards.current.filter((c) => c.phase === "in").map((c) => c.ev.id));

  return (
    <>
      <style>{CSS}</style>
      <div ref={root} className={`fo-root ${side === "right" ? "fo-root-right" : ""}`} style={{ fontSize: `${stackPx}px`, "--lines": lines, "--roam": `${roamPx}px`, ...zones(clear), opacity: wheel.showing ? 0 : duels.dim ? 0.12 : 1, transition: "opacity .4s ease" } as React.CSSProperties}>
        {cards.current.map((c) => (
          <CardView key={c.ev.id} card={c} side={side} />
        ))}
      </div>
      {duels.stage}
      {wheel.stage}
    </>
  );
}

const CSS = `
/* The stack's zone (--st to --sb): replies stack up from its bottom and never reach into the big bite codes' zone. */
.fo-root{position:fixed;inset:var(--st,50vh) 0 var(--sb,0px) 0;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;padding:.4em 1.2em 1.2em;overflow:hidden;pointer-events:none;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif,"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji";color:#f5f5f5}
.fo-root-right{align-items:flex-end}
.fo-wrap{--dir:1;flex-shrink:0;overflow:hidden;padding:.35em .6em;margin:-.1em -.6em;max-width:36em}
.fo-wrap.fo-right{--dir:-1}
/* A big bite's code is a small card that turns up anywhere in its own zone of the source (--rw by --rh, from --rt down), clear of the stack, so it has to be looked for. */
.fo-wrap.fo-roam{position:fixed;left:1.2em;top:calc(var(--rt,0px) + .8em);z-index:2;margin:0;max-width:15em;font-size:var(--roam,1em);
  transform:translate(calc(var(--x,0) * max(0px,var(--rw,100vw) - 2.4em - 100%)),calc(var(--y,0) * max(0px,var(--rh,50vh) - 1.2em - 100%)))}
.fo-roam .fo-card{gap:.5em;padding:.45em .7em .5em .5em}
.fo-roam .fo-icon{width:1.7em;height:1.7em;font-size:1em}
.fo-roam .fo-text{font-size:.68em;-webkit-line-clamp:2}
/* Narrow: the pull and the time left share a line, the code has the next to itself. */
.fo-roam .fo-bigcode{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;column-gap:.6em;white-space:nowrap}
.fo-roam .fo-bigcode b{order:2;flex-basis:100%;margin-left:0;line-height:1.15}
.fo-roam .fo-bigsecs{margin-left:0}
.fo-roam .fo-body{flex:1}
.fo-roam .fo-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
/* Drawn bigger in the same source, a reply wraps onto more lines: --lines grows with the channel's size. */
.fo-text{font-size:.9em;line-height:1.35;margin-top:.1em;display:-webkit-box;-webkit-line-clamp:var(--lines,3);-webkit-box-orient:vertical;overflow:hidden}
.fo-page{margin-left:auto;font-size:.62em;font-weight:700;color:rgba(230,236,245,.6);padding-left:.6em}
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
/* Glows hold still: a blurred shadow redrawn every frame stalled a streaming tool's cloud OBS, which draws without a GPU. */
.fo-epic{border-color:rgba(220,120,255,.7);box-shadow:0 0 1.1em rgba(210,100,255,.35),0 .3em 1.2em rgba(0,0,0,.45)}
.fo-epic .fo-rarity{color:#f0abfc}
.fo-epic .fo-icon{background:radial-gradient(circle at 35% 30%,rgba(220,120,255,.5),rgba(80,20,110,.4))}
.fo-legendary{border:1.5px solid rgba(255,200,70,.9);background:linear-gradient(135deg,rgba(60,40,8,.92),rgba(18,12,4,.9));box-shadow:0 0 1.3em rgba(255,190,60,.45),0 .3em 1.2em rgba(0,0,0,.45)}
.fo-legendary .fo-rarity{color:#fcd34d}
.fo-legendary .fo-icon{background:radial-gradient(circle at 35% 30%,rgba(255,210,90,.65),rgba(120,70,0,.45));font-size:1.45em}
.fo-shine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(110deg,transparent 30%,rgba(255,235,160,.35) 50%,transparent 70%);
  transform:translateX(-100%);will-change:transform;animation:fo-shine 2.2s ease-in-out .5s 3}
@keyframes fo-shine{60%,100%{transform:translateX(100%)}}
.fo-bite{border:1.5px solid rgba(253,224,71,.9);box-shadow:0 0 1em rgba(255,190,60,.4),0 .3em 1.2em rgba(0,0,0,.45)}
/* A big bite's code still throbs, but only an inner glow's opacity changes: nothing is redrawn, only blended. */
.fo-bite::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 1.2em rgba(253,224,71,.6);
  opacity:0;will-change:opacity;animation:fo-throb .5s ease-in-out infinite alternate}
@keyframes fo-throb{to{opacity:1}}
.fo-bigcode{margin-top:.3em;font-size:.8em;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#fde047}
.fo-bigcode b{margin-left:.3em;font-size:2em;letter-spacing:.04em;color:#fff;vertical-align:middle;text-shadow:0 0 .3em rgba(253,224,71,.8)}
.fo-bigsecs{margin-left:.6em;font-size:1em;color:#fbbf24}
/* The first code's last seconds, open to everyone. */
.fo-sniping{color:#f87171}
.fo-mythic{border:1.5px solid rgba(244,114,182,.9);background:linear-gradient(135deg,rgba(60,14,48,.92),rgba(14,20,50,.9));box-shadow:0 0 1.4em rgba(244,114,182,.45),0 .3em 1.2em rgba(0,0,0,.45)}
.fo-mythic .fo-rarity{color:#f9a8d4}
.fo-mythic .fo-icon{background:conic-gradient(rgba(244,114,182,.6),rgba(96,165,250,.6),rgba(52,211,153,.6),rgba(250,204,21,.6),rgba(244,114,182,.6));font-size:1.5em}
`;
