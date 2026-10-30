// The fishing gear shop's purchases: a 🪝 hook, a guard and the next reel. Chat
// (`$<cmd> fish buy …`) and the public leaderboard's signed-in buy buttons both go through
// these, so a price, a check and a reply are the same wherever someone buys. Each one is a
// write: run it inside the caller's transaction (chat's once, the dashboard's applyOnce).

import { runWrite, type PointsDb } from '../points/db';
import { debitTx, ensureUserTx, getUser, setMetaTx } from '../points/store';
import type { FishReelSetting, PointsGamesConfig } from '../types';
import { currentReel, GUARD_PAUSE_KEY, guardEnd, guardPausedAt, guardsPauseWhileLive, heldFishValue, initialData, loadFish, saveFish } from './fishing';

export type ShopItem = 'hook' | 'guard' | 'reel';

export interface ShopBuyer {
  db: PointsDb;
  g: PointsGamesConfig;
  userId: number;
  username: string;
  /** Who did it, for the ledger: `chat:<name>` or `web:<name>`. */
  actor: string;
  /** The currency's name and the command prefix, for the reply. */
  cur: string;
  cmd: string;
  now: number;
}

/** ok false: nothing was bought or spent, and text says why. */
export interface ShopResult { ok: boolean; text: string }

const groupDigits = (n: number): string => Math.round(n).toLocaleString('en-US');
const tries = (n: number) => `${n} ${n === 1 ? 'try' : 'tries'}`;

/** What a reel does, e.g. "fish odds ×1.25, rarer fish ×2, fish value ×1.25". */
export function reelEffects(r: FishReelSetting): string {
  const parts: string[] = [];
  if (r.oddsMultiplier !== 1) parts.push(`fish odds ×${r.oddsMultiplier}`);
  if (r.rarityMultiplier !== 1) parts.push(`rarer fish ×${r.rarityMultiplier}`);
  if (r.valueMultiplier !== 1) parts.push(`fish value ×${r.valueMultiplier}`);
  return parts.join(', ') || 'no bonus';
}

/** A guard's price for the fish held now, or null with no fish to guard. */
export function guardPrice(worth: number, g: PointsGamesConfig): number | null {
  if (worth <= 0) return null;
  return Math.max(g.steal.guardMinimum, Math.round(worth * g.steal.guardPercent / 100));
}

/** A grappling hook: stealing needs one. One at a time, used up a try at a time. */
export function buyHook(b: ShopBuyer): ShopResult {
  const { db, g, userId, cur, cmd, now } = b;
  const st = g.steal;
  ensureUserTx(db, userId, b.username, now);
  const d = loadFish(db, userId) ?? initialData();
  if ((d.hook ?? 0) > 0) return { ok: false, text: `You already have a 🪝 grappling hook with ${tries(d.hook!)} left.` };
  const balance = getUser(db, userId)?.balance ?? 0;
  if (balance < st.hookPrice) return { ok: false, text: `A 🪝 grappling hook costs ${groupDigits(st.hookPrice)} ${cur} and you have ${groupDigits(balance)} ${cur}.` };
  const after = st.hookPrice > 0
    ? debitTx(db, { userId, amount: st.hookPrice, reason: 'game:fish_hook', actor: b.actor, now }).balance
    : balance;
  d.hook = st.hookUses;
  saveFish(db, userId, d, now);
  return { ok: true, text: `You bought a 🪝 grappling hook for ${groupDigits(st.hookPrice)} ${cur}: ${tries(st.hookUses)} at ${cmd} fish steal @user. Every try uses one, caught or not. You have ${groupDigits(after)} ${cur} left.` };
}

/**
 * Guards stand still while the stream is live and stealing is closed (guardsPauseWhileLive): called with
 * Kick's live state (the earner's tick, the livestream webhook). Going live records when guards stopped:
 * the stream's start (`since`) if it's within GUARD_PAUSE_LAG_MS, which covers noticing late without
 * crediting hours from before the rule (turned on mid-stream, say); going offline moves every guard still running then on
 * by the time stood still, in one transaction. Safe to call again with the same state.
 */
const GUARD_PAUSE_LAG_MS = 15 * 60_000;

export function syncGuardPause(db: PointsDb, g: PointsGamesConfig, live: boolean, now: number, since?: number | null): void {
  const at = guardPausedAt(db);
  const pause = live && guardsPauseWhileLive(g);
  if (pause && at === null) {
    const from = since && Number.isFinite(since) && since <= now && now - since <= GUARD_PAUSE_LAG_MS ? since : now;
    runWrite(db, () => setMetaTx(db, GUARD_PAUSE_KEY, String(from)));
    console.log(`[FISH] guards paused from ${new Date(from).toISOString()} (live, stealing closed)`);
  } else if (!pause && at !== null) {
    const stood = Math.max(0, now - at);
    const moved = runWrite(db, () => {
      const r = db.prepare(
        "UPDATE fish SET data = json_set(data, '$.guardUntil', json_extract(data, '$.guardUntil') + ?) WHERE json_extract(data, '$.guardUntil') > ?"
      ).run(stood, at);
      setMetaTx(db, GUARD_PAUSE_KEY, null);
      return r.changes;
    });
    console.log(`[FISH] guards running again: ${moved} moved on by ${Math.round(stood / 60_000)}m`);
  }
}

/** A guard: priced on what the fish held right now are worth, and adds its hours to any guard still running. */
export function buyGuard(b: ShopBuyer): ShopResult {
  const { db, g, userId, cur, now } = b;
  const st = g.steal;
  ensureUserTx(db, userId, b.username, now);
  const d = loadFish(db, userId) ?? initialData();
  const worth = heldFishValue(d, g);
  const price = guardPrice(worth, g);
  if (price === null) return { ok: false, text: "You don't have any fish to guard!" };
  const balance = getUser(db, userId)?.balance ?? 0;
  if (balance < price) return { ok: false, text: `Guarding your fish costs ${groupDigits(price)} ${cur} right now (${st.guardPercent}% of what they're worth) and you have ${groupDigits(balance)} ${cur}.` };
  const after = price > 0
    ? debitTx(db, { userId, amount: price, reason: 'game:fish_guard', actor: b.actor, now }).balance
    : balance;
  // While guards stand still (live), the hours start when they run again: stored as an end the pause moves on.
  const pausedAt = guardPausedAt(db);
  const end = guardEnd(d.guardUntil, pausedAt, now);
  const extended = end > now;
  const newEnd = Math.max(now, end) + st.guardHours * 3_600_000;
  d.guardUntil = pausedAt !== null ? newEnd - (now - pausedAt) : newEnd;
  saveFish(db, userId, d, now);
  // No time in the reply: chat is public, and a guard's time left is the owner's secret.
  return {
    ok: true,
    text: extended
      ? `You paid your guard ${groupDigits(price)} ${cur} to stay on longer. You have ${groupDigits(after)} ${cur} left.`
      : `You hired a guard for ${groupDigits(price)} ${cur}. Your fish are safe from thieves for now. You have ${groupDigits(after)} ${cur} left.`
  };
}

/** The next reel in the shop's order. */
export function buyReel(b: ShopBuyer): ShopResult {
  const { db, g, userId, cur, now } = b;
  ensureUserTx(db, userId, b.username, now);
  const d = loadFish(db, userId) ?? initialData();
  const level = Math.min(d.reel ?? 0, g.reels.length);
  if (level >= g.reels.length) return { ok: false, text: 'You already have the best reel in the shop!' };
  const next = g.reels[level];
  const balance = getUser(db, userId)?.balance ?? 0;
  if (balance < next.price) return { ok: false, text: `The ${next.name} reel costs ${groupDigits(next.price)} ${cur} and you have ${groupDigits(balance)} ${cur}.` };
  const after = next.price > 0
    ? debitTx(db, { userId, amount: next.price, reason: 'game:fish_reel', actor: b.actor, note: next.name, now }).balance
    : balance;
  d.reel = level + 1;
  saveFish(db, userId, d, now);
  return { ok: true, text: `You bought the ${next.name} reel for ${groupDigits(next.price)} ${cur}! ${reelEffects(next)}. You have ${groupDigits(after)} ${cur} left.` };
}

/** One viewer's own gear and what the shop would charge them now, for their signed-in leaderboard panel. */
export interface ShopView {
  balance: number;
  reel: { name: string; effects: string } | null;
  nextReel: { name: string; price: number; effects: string } | null;
  /** Null when stealing is off: no hooks or guards. */
  steal: {
    hookTries: number;
    hookPrice: number;
    hookUses: number;
    /** ISO, or null with no guard on. While paused, when it would end if the stream ended now. */
    guardUntil: string | null;
    /** Guards stand still: the stream is live and stealing is closed (syncGuardPause). */
    guardPaused: boolean;
    /** Null with no fish to guard. */
    guardPrice: number | null;
    guardHours: number;
    guardPercent: number;
  } | null;
}

export function shopView(db: PointsDb, g: PointsGamesConfig, userId: number, now: number): ShopView {
  const d = loadFish(db, userId) ?? initialData();
  const have = currentReel(d, g);
  const level = Math.min(d.reel ?? 0, g.reels.length);
  const next = level < g.reels.length ? g.reels[level] : null;
  const st = g.steal;
  const pausedAt = guardPausedAt(db);
  const end = guardEnd(d.guardUntil, pausedAt, now);
  return {
    balance: getUser(db, userId)?.balance ?? 0,
    reel: have ? { name: have.name, effects: reelEffects(have) } : null,
    nextReel: next ? { name: next.name, price: next.price, effects: reelEffects(next) } : null,
    steal: st.enabled ? {
      hookTries: d.hook ?? 0,
      hookPrice: st.hookPrice,
      hookUses: st.hookUses,
      guardUntil: end > now ? new Date(end).toISOString() : null,
      guardPaused: pausedAt !== null,
      guardPrice: guardPrice(heldFishValue(d, g), g),
      guardHours: st.guardHours,
      guardPercent: st.guardPercent
    } : null
  };
}
