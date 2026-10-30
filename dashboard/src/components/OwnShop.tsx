"use client";

import { useEffect, useState } from "react";
import type { OwnShop as Shop, ShopItem } from "@/lib/bot-api";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// The signed-in viewer's own fishing gear on the leaderboard's Fishing tab, with chat's
// `fish buy` as buttons: a hook, a guard and the next reel. Each buy asks once more
// before it spends, and shows the bot's own reply.

/** Time left until `iso`: "7h 12m", "45m", or null once it's past. */
function timeLeft(iso: string, now: number): string | null {
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.ceil(ms / 60_000);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h ${total % 60}m` : `${total}m`;
}

const n = (v: number) => v.toLocaleString("en-US");

export default function OwnShop({ channel, initial, currency }: { channel: string; initial: Shop; currency: string }) {
  const [shop, setShop] = useState(initial);
  // The item waiting for its confirm click, and the one being bought.
  const [confirm, setConfirm] = useState<ShopItem | null>(null);
  const [busy, setBusy] = useState<ShopItem | null>(null);
  const [reply, setReply] = useState<{ ok: boolean; text: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const guardUntil = shop.steal?.guardUntil ?? null;
  const guardPaused = shop.steal?.guardPaused === true;
  // Counts down while the panel is open, and says "no guard" once it runs out. Paused (live), it stands still.
  useEffect(() => {
    if (!guardUntil) return;
    setNow(Date.now());
    if (guardPaused) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [guardUntil, guardPaused]);
  const guardLeft = guardUntil ? timeLeft(guardUntil, now) : null;

  async function buy(item: ShopItem) {
    setConfirm(null);
    setBusy(item);
    setReply(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/public/${encodeURIComponent(channel)}/shop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item, requestId: crypto.randomUUID() }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; text?: string; shop?: Shop; error?: string } | null;
      if (!res.ok || !body) throw new Error(body?.error ?? `Couldn't buy that (${res.status})`);
      if (body.shop) setShop(body.shop);
      setReply({ ok: body.ok === true, text: body.text ?? "" });
    } catch (e) {
      setReply({ ok: false, text: e instanceof Error ? e.message : "Couldn't buy that" });
    } finally {
      setBusy(null);
    }
  }

  const button = (item: ShopItem, label: string, price: number) => {
    const short = shop.balance < price;
    if (confirm === item) {
      return (
        <span className="flex shrink-0 gap-1.5">
          <button type="button" onClick={() => void buy(item)} className="rounded-md bg-[#53FC18] px-2 py-1 text-xs font-medium text-black hover:brightness-110">
            Pay {n(price)}
          </button>
          <button type="button" onClick={() => setConfirm(null)} className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200">
            Cancel
          </button>
        </span>
      );
    }
    return (
      <button
        type="button"
        disabled={busy !== null || short}
        title={short ? `You have ${n(shop.balance)} ${currency}` : undefined}
        onClick={() => setConfirm(item)}
        className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy === item ? "Buying…" : `${label} · ${n(price)}`}
      </button>
    );
  };

  const row = "flex flex-wrap items-center justify-between gap-2 px-3 py-2";
  const st = shop.steal;
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950/60 text-sm text-neutral-300">
      <h3 className="flex flex-wrap items-baseline justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-xs text-neutral-500">
        <span className="text-neutral-300">🎣 Your gear</span>
        <span>
          {n(shop.balance)} {currency} to spend · only you can see this
        </span>
      </h3>
      <div className="divide-y divide-neutral-800">
        {st ? (
          <div className={row}>
            <span>
              🛡️ {guardLeft ? <>Guard on: <b className="tabular-nums">{guardLeft}</b> left{guardPaused ? " · ⏸ paused while the stream is live" : ""}</> : "No guard on your fish right now."}
              <span className="block text-xs text-neutral-500">
                {st.guardPrice === null
                  ? "No fish to guard yet."
                  : `${st.guardHours}h more for ${st.guardPercent}% of what your fish are worth now${guardLeft ? ", added to the time left" : ""}.${guardPaused ? " Bought now, its hours start when the stream ends." : ""}`}
              </span>
            </span>
            {st.guardPrice !== null ? button("guard", guardLeft ? "Extend" : "Hire guard", st.guardPrice) : null}
          </div>
        ) : null}
        {st ? (
          <div className={row}>
            <span>
              🪝 {st.hookTries > 0 ? <>Hook: <b className="tabular-nums">{st.hookTries}</b> {st.hookTries === 1 ? "try" : "tries"} left</> : "No grappling hook."}
              <span className="block text-xs text-neutral-500">
                {st.hookTries > 0 ? "Use them up before buying another." : `${st.hookUses} steal tries, used caught or not.`}
              </span>
            </span>
            {st.hookTries > 0 ? null : button("hook", "Buy hook", st.hookPrice)}
          </div>
        ) : null}
        {shop.reel || shop.nextReel ? <div className={row}>
          <span>
            🎣 {shop.reel ? <>Reel: <b>{shop.reel.name}</b></> : "No reel yet."}
            <span className="block text-xs text-neutral-500">
              {shop.nextReel ? `Next: ${shop.nextReel.name} (${shop.nextReel.effects}), kept for good.` : "That's the best reel in the shop."}
            </span>
          </span>
          {shop.nextReel ? button("reel", "Buy reel", shop.nextReel.price) : null}
        </div> : null}
      </div>
      {reply ? <p className={`border-t border-neutral-800 px-3 py-2 text-xs ${reply.ok ? "text-[#53FC18]" : "text-red-400"}`}>{reply.text}</p> : null}
    </section>
  );
}
