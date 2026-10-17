/**
 * Every spin of the prize wheel, kept in the channel's points database (wheel_spins,
 * schema v13): when, who spun it, where it landed and what was on the wheel then.
 * !wheel history shows the latest in chat; the dashboard's wheel card lists them.
 */

import { runWrite, type PointsDb } from '../points/db';
import type { WheelItem } from './wheel';

export interface WheelSpin {
  ts: number;
  by: string;
  result: string;
  /** 1-based, of `itemCount`. */
  position: number;
  itemCount: number;
  items: string[];
  overlay: 'fishing' | 'video';
}

export function recordSpin(db: PointsDb, spin: { ts: number; by: string; winner: number; items: WheelItem[]; overlay: 'fishing' | 'video' }): void {
  runWrite(db, () => {
    db.prepare('INSERT INTO wheel_spins (ts, by_name, result, position, item_count, items, overlay) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      spin.ts, spin.by, spin.items[spin.winner]?.label ?? '', spin.winner + 1, spin.items.length,
      JSON.stringify(spin.items.map(i => i.label)), spin.overlay
    );
  });
}

/** The latest spins, newest first. */
export function recentSpins(db: PointsDb, limit = 20): WheelSpin[] {
  const rows = db.prepare('SELECT ts, by_name, result, position, item_count, items, overlay FROM wheel_spins ORDER BY ts DESC, id DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Math.floor(limit)))) as { ts: number; by_name: string; result: string; position: number; item_count: number; items: string; overlay: string }[];
  return rows.map(r => {
    let items: string[] = [];
    try {
      const parsed: unknown = JSON.parse(r.items);
      if (Array.isArray(parsed)) items = parsed.map(String);
    } catch {
      // a bad row still shows its result
    }
    return { ts: r.ts, by: r.by_name, result: r.result, position: r.position, itemCount: r.item_count, items, overlay: r.overlay === 'video' ? 'video' : 'fishing' };
  });
}

/** "3m", "5h", "2d" ago. */
export function ago(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
