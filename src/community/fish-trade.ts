// Fish trades (bot-commands/fish.ts `fish trade`): one viewer offers fish and/or currency for
// another's, who accepts or declines within games.trade.expirySeconds. Offers live here, in
// memory like duel challenges: a restart drops them, and they only wait a couple of minutes.

/** One fish (cm for that very one) or piece of junk (cm null), as offered. */
export interface TradeItem { name: string; cm: number | null; level?: number; /** That fish is its catcher's size record, named so the trade moves it and not a plain twin. */ record?: true }

/** One side of a trade: what that viewer hands over. */
export interface TradeSide { items: TradeItem[]; coins: number }

export interface TradeOffer {
  fromId: number;
  from: string;
  toId: number;
  to: string;
  /** What the proposer gives. */
  give: TradeSide;
  /** What they ask for in return. */
  get: TradeSide;
  /** Fish at their sell value plus currency, both sides: the fee is a share of it. */
  value: number;
  fee: number;
  at: number;
  expiresAt: number;
}

import type { PointsDb } from '../points/db';
import { runWrite } from '../points/db';

const offers = new Map<string, TradeOffer[]>();

function live(channel: string, now: number): TradeOffer[] {
  const list = (offers.get(channel) ?? []).filter(o => o.expiresAt > now);
  offers.set(channel, list);
  return list;
}

/** The offer waiting on this viewer's answer, if any. */
export function tradeFor(channel: string, toId: number, now = Date.now()): TradeOffer | undefined {
  return live(channel, now).find(o => o.toId === toId);
}

/** The offer this viewer made that's still waiting, if any. */
export function tradeBy(channel: string, fromId: number, now = Date.now()): TradeOffer | undefined {
  return live(channel, now).find(o => o.fromId === fromId);
}

export function addTrade(channel: string, offer: TradeOffer): void {
  live(channel, offer.at).push(offer);
}

export function dropTrade(channel: string, offer: TradeOffer): void {
  offers.set(channel, (offers.get(channel) ?? []).filter(o => o !== offer));
}

/**
 * A copy of the channel's live offers in its points database (meta trade_offers), for the
 * leaderboard's fishing page: that page is served by another process, which can't see this
 * module's memory. Written after every change; expired ones fall away when it's read.
 */
export function mirrorTrades(db: PointsDb, channel: string, now = Date.now()): void {
  try {
    runWrite(db, () => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(TRADE_MIRROR_KEY, JSON.stringify(live(channel, now))));
  } catch (err) {
    console.error(`[FISH] Trade mirror write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The mirrored offers still open, from the database (mirrorTrades). */
export function mirroredTrades(db: PointsDb, now = Date.now()): TradeOffer[] {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(TRADE_MIRROR_KEY) as { value: string | null } | undefined;
    const list = JSON.parse(row?.value ?? '[]') as TradeOffer[];
    return Array.isArray(list) ? list.filter(o => o && typeof o.expiresAt === 'number' && o.expiresAt > now) : [];
  } catch {
    return [];
  }
}

const TRADE_MIRROR_KEY = 'trade_offers';

/** "🦈 72 cm, 🐟 x2 + 500 $DON", or "nothing". */
export function sideText(side: TradeSide, currency: string): string {
  const counts = new Map<string, number>();
  for (const i of side.items) {
    const k = i.cm !== null ? `${i.name} ${i.cm} cm${i.level ? ` Lv${i.level}` : ''}${i.record ? ' 🏅' : ''}` : i.name;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const parts = [...counts].map(([k, n]) => (n > 1 ? `${k} x${n}` : k));
  if (side.coins > 0) parts.push(`${side.coins.toLocaleString('en-US')} ${currency}`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/** Selftest only: forget every offer. */
export function resetTrades(): void {
  offers.clear();
}
