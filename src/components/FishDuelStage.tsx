"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { FishDuel, FishDuelSide, FishOverlayEvent } from "@/lib/bot-api";

// A fish duel on the overlay: both fish, their hit points, and the fight the bot
// rolled, played back a hit at a time. Shared by the fishing scene and the text
// cards; while one plays, the overlay under it dims.

/** The bot waits this same time before telling chat who won (playMs in community/fish-duel.ts). */
const INTRO_MS = 2_500;
const perTurnMs = (turns: number) => (turns > 16 ? 550 : turns > 10 ? 750 : 950);
/** How long the winner stays up. */
const RESULT_MS = 6_000;

const TYPE_ICON: Record<FishDuelSide["type"], string> = { Predator: "🦷", Swift: "💨", Armored: "🪨" };

function hpAfter(d: FishDuel, turns: number): [number, number] {
  const hp: [number, number] = [d.a.hp, d.b.hp];
  for (let i = 0; i < Math.min(turns, d.turns.length); i++) {
    const [by, damage] = d.turns[i];
    const other = by === 0 ? 1 : 0;
    hp[other] = Math.max(0, hp[other] - damage);
  }
  return hp;
}

function Side({ side, hp, right, acting, struck, dodged, out, won, pop }: {
  side: FishDuelSide;
  hp: number;
  right: boolean;
  acting: boolean;
  struck: boolean;
  dodged: boolean;
  out: boolean;
  won: boolean;
  pop: { key: number; text: string; crit: boolean } | null;
}) {
  const share = Math.max(0, Math.min(1, hp / side.hp));
  const move = acting ? "fd-lunge" : struck ? "fd-struck" : dodged ? "fd-dodge" : "";
  return (
    <div className={`fd-side ${right ? "fd-right" : ""} ${out ? "fd-out" : ""} ${won ? "fd-won" : ""}`}>
      <div className="fd-name">{side.user}</div>
      <div className="fd-arena">
        {/* Keyed by the turn, so the same move plays again on the next one. */}
        <span key={pop ? `f${pop.key}` : acting ? "a" : "idle"} className={`fd-fish ${move}`}>
          <span className="fd-face">{side.fish}</span>
        </span>
        {pop ? (
          <span key={`p${pop.key}`} className={`fd-pop ${pop.crit ? "fd-crit" : ""}`}>
            {pop.text}
          </span>
        ) : null}
      </div>
      <div className="fd-bar">
        <div className={`fd-fill ${share <= 0.2 ? "fd-low" : share <= 0.5 ? "fd-mid" : ""}`} style={{ width: `${share * 100}%` }} />
      </div>
      <div className="fd-meta">
        <b>
          {hp}/{side.hp}
        </b>
        <span>
          {TYPE_ICON[side.type]} {side.type} · {side.rarity}
          {side.cm !== null ? ` · ${side.cm} cm` : ""}
        </span>
      </div>
    </div>
  );
}

function Stage({ ev, onDone }: { ev: FishOverlayEvent; onDone: () => void }) {
  const d = ev.duel!;
  const currency = d.currency ?? "points";
  const total = d.turns.length;
  // -1 the intro, 0..total-1 the turn playing, total the result.
  const [step, setStep] = useState(-1);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const per = perTurnMs(total);
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    for (let i = 0; i <= total; i++) timers.push(setTimeout(() => setStep(i), INTRO_MS + i * per));
    timers.push(setTimeout(() => done.current(), INTRO_MS + total * per + RESULT_MS));
    return () => timers.forEach(clearTimeout);
  }, [ev.id, total]);

  const over = step >= total;
  const turn = step >= 0 && !over ? d.turns[step] : null;
  const hp = hpAfter(d, step + 1);
  const sides = [d.a, d.b] as const;

  let caption = "";
  if (step < 0) caption = d.stake === "wager" && d.amount ? `${d.amount.toLocaleString("en-US")} ${currency} each` : d.stake === "keeps" ? "Winner keeps the loser's fish" : "For glory";
  else if (turn) {
    const [by, , hit, edge] = turn;
    caption = hit === 0 ? `${sides[by].fish} missed!` : hit === 2 ? "A critical hit!" : edge > 0 ? "It's super effective!" : edge < 0 ? "It's not very effective…" : "";
  } else {
    const w = sides[d.winner];
    const l = sides[d.winner === 0 ? 1 : 0];
    caption = d.stake === "wager" && d.amount ? `${w.user} wins ${d.amount.toLocaleString("en-US")} ${currency}!` : d.stake === "keeps" ? `${w.user} wins and keeps the ${l.fish}!` : `${w.user} wins!`;
  }

  const view = (i: 0 | 1) => {
    const defending = !!turn && turn[0] !== i;
    const pop = defending && turn ? { key: step, text: turn[2] === 0 ? "miss" : `−${turn[1]}`, crit: turn[2] === 2 } : null;
    return (
      <Side
        side={sides[i]}
        hp={hp[i]}
        right={i === 1}
        acting={!!turn && turn[0] === i}
        struck={defending && turn![2] > 0}
        dodged={defending && turn![2] === 0}
        out={hp[i] <= 0 || (over && d.winner !== i)}
        won={over && d.winner === i}
        pop={pop}
      />
    );
  };

  return (
    <div className={`fd-stage ${over ? "fd-over" : ""}`}>
      <div className="fd-title">
        <span>⚔️ Fish duel</span>
        {step >= 0 && !over ? (
          <span className="fd-turn">
            Turn {step + 1}/{total}
          </span>
        ) : null}
      </div>
      <div className="fd-ring">
        {view(0)}
        <div className="fd-vs">VS</div>
        {view(1)}
      </div>
      <div key={`${step}-${caption}`} className={`fd-caption ${over ? "fd-final" : ""}`}>
        {caption || " "}
      </div>
    </div>
  );
}

/** A made-up duel for the preview link (?duel=1), a new matchup each time. */
function sampleDuel(id: number): FishOverlayEvent {
  const fish: Array<[string, FishDuelSide["type"], string, number]> = [["🦈", "Predator", "Epic", 1.4], ["🐢", "Armored", "Uncommon", 1.12], ["🐬", "Swift", "Rare", 1.25], ["🐟", "Swift", "Common", 1]];
  const pick = (user: string): FishDuelSide & { attack: number } => {
    const [f, type, rarity, level] = fish[Math.floor(Math.random() * fish.length)];
    const cm = 20 + Math.floor(Math.random() * 80);
    return { user, fish: f, cm, type, rarity, hp: Math.round((50 + cm * 0.7) * level), attack: Math.round(18 * level) };
  };
  const a = pick("ash_ketchum");
  const b = pick("gary_oak");
  const hp = [a.hp, b.hp];
  const turns: FishDuel["turns"] = [];
  let by: 0 | 1 = Math.random() < 0.5 ? 0 : 1;
  while (hp[0] > 0 && hp[1] > 0 && turns.length < 40) {
    const other: 0 | 1 = by === 0 ? 1 : 0;
    const roll = Math.random();
    const damage = roll < 0.1 ? 0 : Math.round((by === 0 ? a : b).attack * (0.85 + Math.random() * 0.3) * (roll > 0.9 ? 1.5 : 1));
    hp[other] = Math.max(0, hp[other] - damage);
    turns.push([by, damage, roll < 0.1 ? 0 : roll > 0.9 ? 2 : 1, 0]);
    by = other;
  }
  const stake = (["friendly", "wager", "keeps"] as const)[Math.abs(id) % 3];
  return {
    id, ts: Date.now(), username: a.user, kind: "duel", text: "",
    duel: { a, b, turns, winner: hp[1] <= 0 ? 0 : 1, stake, ...(stake === "wager" ? { amount: 500, currency: "$DON" } : {}) },
  };
}

/**
 * Fish duels for an overlay. `take` keeps the duels out of a batch of feed events
 * and hands back the rest; `stage` draws the one playing; `dim` is whether the
 * overlay under it should fade back. A big bite's code matters more than a fight:
 * a duel waits for one that's showing, and stops dimming if one arrives. So does the
 * prize wheel (`held`): no duel starts while it's up, and one playing is hidden.
 */
export function useDuels({ fontPx, demo, clearBottom = 0, held = false }: {
  fontPx: number;
  demo: boolean;
  /** The prize wheel is up. */
  held?: boolean;
  /** The share of the source's height, from the bottom, the stage keeps out of (0 to 1). */
  clearBottom?: number;
}): {
  take: (events: FishOverlayEvent[]) => FishOverlayEvent[];
  stage: ReactNode;
  dim: boolean;
  busy: () => boolean;
} {
  const waiting = useRef<FishOverlayEvent[]>([]);
  const biteUntil = useRef(0);
  const [playing, setPlaying] = useState<FishOverlayEvent | null>(null);
  const [biteUp, setBiteUp] = useState(false);
  const playingRef = useRef<FishOverlayEvent | null>(null);
  playingRef.current = playing;
  const heldRef = useRef(held);
  heldRef.current = held;

  const take = useCallback((events: FishOverlayEvent[]): FishOverlayEvent[] => {
    const rest: FishOverlayEvent[] = [];
    for (const ev of events) {
      if (ev.kind === "duel") {
        if (ev.duel) waiting.current.push(ev);
        continue;
      }
      // A code shows for its window; the angler's answer, or their next code, ends it sooner, but waiting it out is harmless.
      if (ev.kind === "bite") biteUntil.current = Date.now() + Math.max(5_000, Math.min(60_000, (ev.until ?? ev.ts + 30_000) - ev.ts));
      rest.push(ev);
    }
    return rest;
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      const bite = Date.now() < biteUntil.current;
      setBiteUp(bite);
      if (!playingRef.current && !bite && !heldRef.current && waiting.current.length) setPlaying(waiting.current.shift()!);
    }, 250);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!demo) return;
    let id = -1000;
    const fire = () => waiting.current.push(sampleDuel(id--));
    fire();
    const t = setInterval(fire, 30_000);
    return () => {
      clearInterval(t);
      waiting.current = waiting.current.filter((e) => e.id >= 0);
    };
  }, [demo]);

  // The stage is about 11em tall and wants 20em across: in a short or narrow source it draws smaller rather than being cut off.
  const [fitPx, setFitPx] = useState(fontPx);
  useEffect(() => {
    const fit = () => setFitPx(Math.max(8, Math.min(fontPx, (window.innerHeight * (1 - clearBottom)) / 11.2, window.innerWidth / 20)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fontPx, clearBottom]);

  const finish = useCallback(() => setPlaying(null), []);
  const busy = useCallback(() => playingRef.current !== null || waiting.current.length > 0, []);

  const stage = useMemo(
    () =>
      playing ? (
        <>
          <style>{CSS}</style>
          <div className="fd-root" style={{ fontSize: `${fitPx}px`, bottom: `${clearBottom * 100}vh`, opacity: held ? 0 : 1, transition: "opacity .3s ease" } as CSSProperties}>
            <Stage key={playing.id} ev={playing} onDone={finish} />
          </div>
        </>
      ) : null,
    [playing, fitPx, finish, clearBottom, held],
  );

  return { take, stage, dim: playing !== null && !biteUp && !held, busy };
}

const CSS = `
.fd-root{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:.6em;pointer-events:none;z-index:5;color:#f5f5f5;
  font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif,"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji"}
.fd-stage{width:min(36em,100%);max-height:100%;padding:.5em .9em .55em;border-radius:1em;overflow:hidden;
  background:linear-gradient(135deg,rgba(14,22,34,.94),rgba(10,12,18,.92));border:1.5px solid rgba(250,204,21,.55);
  box-shadow:0 .3em 1.6em rgba(0,0,0,.55);text-shadow:0 1px 2px rgba(0,0,0,.6);animation:fd-enter .45s cubic-bezier(.2,1.3,.4,1) both}
@keyframes fd-enter{from{transform:scale(.8);opacity:0}to{transform:none;opacity:1}}
.fd-title{display:flex;justify-content:space-between;align-items:baseline;font-size:.72em;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fde047}
.fd-turn{color:rgba(230,236,245,.6);letter-spacing:.06em}
.fd-ring{display:flex;align-items:stretch;gap:.6em;margin-top:.2em}
.fd-vs{align-self:center;font-weight:900;font-size:.9em;color:rgba(250,204,21,.8)}
.fd-side{flex:1;min-width:0;display:flex;flex-direction:column;transition:opacity .5s ease}
.fd-right{text-align:right}
.fd-name{font-weight:800;font-size:.95em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fd-arena{position:relative;height:2.9em;display:flex;align-items:center;justify-content:center}
.fd-fish{display:inline-block;font-size:2.3em;line-height:1;--dir:1}
.fd-right .fd-fish{--dir:-1}
/* Fish emoji face left: the one on the left is turned to face its rival. */
.fd-face{display:inline-block}
.fd-side:not(.fd-right) .fd-face{transform:scaleX(-1)}
.fd-lunge{animation:fd-lunge .45s ease-in-out both}
.fd-struck{animation:fd-struck .45s ease-in-out .15s both}
.fd-dodge{animation:fd-dodge .45s ease-in-out .1s both}
@keyframes fd-lunge{40%{transform:translateX(calc(var(--dir) * 1.1em)) scale(1.15)}}
@keyframes fd-struck{20%{transform:translateX(calc(var(--dir) * -.3em)) rotate(calc(var(--dir) * -12deg));filter:brightness(2.2)}60%{transform:translateX(calc(var(--dir) * .12em))}}
@keyframes fd-dodge{40%{transform:translateY(-.45em)}}
.fd-pop{position:absolute;top:-.1em;left:50%;font-weight:900;font-size:1.05em;color:#fca5a5;white-space:nowrap;animation:fd-pop .8s ease-out .15s both}
.fd-pop.fd-crit{color:#fde047;font-size:1.35em}
@keyframes fd-pop{from{transform:translate(-50%,.5em) scale(.6);opacity:0}25%{transform:translate(-50%,0) scale(1.1);opacity:1}to{transform:translate(-50%,-.9em);opacity:0}}
.fd-bar{height:.55em;border-radius:.3em;background:rgba(255,255,255,.12);overflow:hidden}
.fd-fill{height:100%;border-radius:.3em;background:#4ade80;transition:width .4s ease-out .15s,background-color .3s ease}
.fd-right .fd-fill{margin-left:auto}
.fd-fill.fd-mid{background:#facc15}
.fd-fill.fd-low{background:#f87171}
.fd-meta{display:flex;justify-content:space-between;gap:.5em;margin-top:.15em;font-size:.62em;color:rgba(230,236,245,.7);white-space:nowrap}
.fd-right .fd-meta{flex-direction:row-reverse}
.fd-meta b{color:#f5f5f5}
.fd-meta span{overflow:hidden;text-overflow:ellipsis}
.fd-out{opacity:.45}
.fd-out .fd-fish{transform:rotate(calc(var(--dir) * 180deg));transition:transform .5s ease-in;filter:grayscale(1)}
.fd-won .fd-fish{animation:fd-cheer .6s ease-in-out infinite alternate}
@keyframes fd-cheer{to{transform:translateY(-.3em) scale(1.12)}}
.fd-caption{margin-top:.25em;text-align:center;font-size:.8em;font-weight:700;min-height:1.3em;color:#e5e7eb;animation:fd-cap .25s ease-out both}
.fd-caption.fd-final{font-size:1em;color:#fde047}
@keyframes fd-cap{from{opacity:0;transform:translateY(.2em)}to{opacity:1;transform:none}}
`;
