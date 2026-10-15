/**
 * Spin the wheel: a prize wheel on the fishing overlay. The streamer, the bot owner
 * and mods spin it from chat (bot-commands/wheel.ts); the bot picks the result, the
 * overlay plays the spin landing on it, and chat gets one line with the result once
 * the stream has caught up. Fishing alerts wait on the overlay while it spins, and
 * no big bite starts meanwhile (wheel-state.ts).
 *
 * Everything about a channel's wheel is one file, data/wheel/<channel>.json: its
 * items and settings. Chat (the bot) and the dashboard (the enrollment service)
 * both edit it, so every change is a read-modify-write under a file lock, and a
 * dashboard save names the version it loaded so it can't overwrite an item someone
 * added in chat meanwhile.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeJsonAtomic } from '../file-lock';

export interface WheelItem {
  label: string;
  /** #rrggbb; absent, the overlay picks one from its palette. */
  color?: string;
}

export interface WheelSettings {
  /** How long the wheel spins on the overlay. */
  spinSeconds: number;
  /** Take a landed item off the wheel, like a raffle wheel. */
  removeWinner: boolean;
}

export interface Wheel extends WheelSettings {
  items: WheelItem[];
  /** Bumped on every change: a dashboard save must name the one it loaded. */
  version: number;
}

export const WHEEL_DEFAULTS: Readonly<WheelSettings> = { spinSeconds: 6, removeWinner: false };
export const SPIN_SECONDS = { min: 3, max: 20 } as const;
/** Enough for a readable wheel on stream. */
export const MAX_ITEMS = 30;
export const MAX_LABEL = 30;
/** After the wheel stops, the overlay holds the result this long before fishing resumes. */
export const RESULT_HOLD_MS = 5_000;

const LOCK = { staleMs: 10_000, waitMs: 5_000 };
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const dataRoot = (): string => process.env.POINTS_DATA_ROOT || path.join(__dirname, '..', '..', 'data');
export const wheelFile = (channel: string): string => path.join(dataRoot(), 'wheel', `${channel.replace(/^#/, '').toLowerCase()}.json`);

/** A label as it's stored: one line, trimmed, at most MAX_LABEL characters, nothing that renders as markup. */
export function cleanLabel(raw: string): string {
  return Array.from(raw.replace(/[<>\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()).slice(0, MAX_LABEL).join('');
}

const sameLabel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function settle(raw: unknown): Wheel {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = (Array.isArray(r.items) ? r.items : []).flatMap((it): WheelItem[] => {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' ? cleanLabel(o.label) : '';
    if (!label) return [];
    return [{ label, ...(typeof o.color === 'string' && COLOR_RE.test(o.color) ? { color: o.color.toLowerCase() } : {}) }];
  }).slice(0, MAX_ITEMS);
  const secs = Number(r.spinSeconds);
  return {
    items,
    spinSeconds: Number.isInteger(secs) && secs >= SPIN_SECONDS.min && secs <= SPIN_SECONDS.max ? secs : WHEEL_DEFAULTS.spinSeconds,
    removeWinner: typeof r.removeWinner === 'boolean' ? r.removeWinner : WHEEL_DEFAULTS.removeWinner,
    version: Number.isInteger(r.version) ? Number(r.version) : 0
  };
}

export function readWheel(channel: string): Wheel {
  try {
    return settle(JSON.parse(fs.readFileSync(wheelFile(channel), 'utf8')));
  } catch {
    return settle({});
  }
}

/**
 * Change a channel's wheel under the lock. `fn` gets the current wheel and returns
 * the next one, or a string to refuse with (nothing is written). Resolves to the
 * saved wheel, or the refusal.
 */
export async function changeWheel(channel: string, fn: (w: Wheel) => Wheel | string): Promise<Wheel | string> {
  const file = wheelFile(channel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withFileLock(`${file}.lock`, async () => {
    const before = readWheel(channel);
    const out = fn({ ...before, items: before.items.map(i => ({ ...i })) });
    if (typeof out === 'string') return out;
    const next = { ...settle(out), version: before.version + 1 };
    writeJsonAtomic(file, next);
    return next;
  }, LOCK);
}

/**
 * The dashboard's save: the whole wheel, checked. Returns the errors, or the wheel to
 * store. `version` must be the one loaded; otherwise chat changed it since.
 */
export function validateWheel(body: unknown): { wheel: Omit<Wheel, 'version'>; version: number } | { errors: string[] } {
  const errors: string[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (!Number.isInteger(b.version)) errors.push('version is required');
  if (!Array.isArray(b.items)) errors.push('items must be a list');
  const items: WheelItem[] = [];
  for (const [i, it] of (Array.isArray(b.items) ? b.items : []).entries()) {
    const o = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>;
    const label = typeof o.label === 'string' ? cleanLabel(o.label) : '';
    if (!label) { errors.push(`Item ${i + 1} needs a label`); continue; }
    if (o.color !== undefined && o.color !== null && o.color !== '' && !(typeof o.color === 'string' && COLOR_RE.test(o.color))) {
      errors.push(`Item ${i + 1}'s colour must look like #ff8800`);
      continue;
    }
    if (items.some(x => sameLabel(x.label, label))) { errors.push(`"${label}" is on the wheel twice`); continue; }
    items.push({ label, ...(typeof o.color === 'string' && o.color ? { color: o.color.toLowerCase() } : {}) });
  }
  if (items.length > MAX_ITEMS) errors.push(`At most ${MAX_ITEMS} items`);
  const secs = b.spinSeconds;
  if (!(Number.isInteger(secs) && (secs as number) >= SPIN_SECONDS.min && (secs as number) <= SPIN_SECONDS.max)) {
    errors.push(`Spin length must be ${SPIN_SECONDS.min}–${SPIN_SECONDS.max} seconds`);
  }
  if (typeof b.removeWinner !== 'boolean') errors.push('removeWinner must be true or false');
  if (errors.length) return { errors };
  return { wheel: { items, spinSeconds: secs as number, removeWinner: b.removeWinner as boolean }, version: b.version as number };
}

/** Add labels from chat. Returns what was added and what was skipped (already on, or no room). */
export function addItems(w: Wheel, labels: string[]): { wheel: Wheel; added: string[]; skipped: string[] } {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const raw of labels) {
    const label = cleanLabel(raw);
    if (!label) continue;
    if (w.items.some(i => sameLabel(i.label, label)) || added.some(a => sameLabel(a, label)) || w.items.length >= MAX_ITEMS) {
      skipped.push(label);
      continue;
    }
    w.items.push({ label });
    added.push(label);
  }
  return { wheel: w, added, skipped };
}

/** Remove an item by its label or its 1-based number in the list. Returns the label removed, or null. */
export function removeItem(w: Wheel, which: string): { wheel: Wheel; removed: string | null } {
  const t = cleanLabel(which);
  let i = w.items.findIndex(it => sameLabel(it.label, t));
  if (i < 0 && /^\d+$/.test(t)) i = Number(t) - 1;
  if (i < 0 || i >= w.items.length) return { wheel: w, removed: null };
  const [gone] = w.items.splice(i, 1);
  return { wheel: w, removed: gone.label };
}

/** The winning slice, every item equally likely. */
export const pickWinner = (count: number): number => crypto.randomInt(count);
