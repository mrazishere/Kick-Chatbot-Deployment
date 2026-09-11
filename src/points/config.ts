/**
 * Loyalty points settings: defaults, validation, and reading them live.
 *
 * Settings live in the channel config's `points` block and are stored partially,
 * so a default changed here reaches every channel that never overrode it. The
 * bot re-reads the block whenever the file changes, which is why a dashboard
 * edit applies without restarting a channel's bot.
 */

import * as fs from 'fs';
import * as path from 'path';
import { PointsBonusesConfig, PointsConfig, PointsGiveConfig, StoredPointsConfig } from '../types';

export function defaultPointsConfig(): PointsConfig {
  return {
    enabled: false,
    currencyName: 'Points',
    currencyCommand: null,
    pointsPerInterval: 10,
    intervalMinutes: 10,
    activeWindowMinutes: 30,
    subscriberMultiplier: 2,
    excludeBroadcaster: true,
    ignoreUsers: [],
    bonuses: {
      follow: 50,
      subNew: 500,
      subRenewal: 500,
      giftSubGifterPerSub: 250,
      giftSubRecipient: 100,
      pointsPerKick: 1,
      onlyWhileLive: false,
      announce: false
    },
    give: { enabled: false, minAmount: 10, maxAmount: 0, cooldownSeconds: 30 },
    modMaxAdjust: 1_000_000,
    publicLeaderboard: true
  };
}

/** The defaults. A fresh copy each time, so callers can't mutate the shared object. */
export const POINTS_DEFAULTS: Readonly<PointsConfig> = defaultPointsConfig();

/** The effective settings plus the file-only staging switch. */
export interface InternalPointsConfig extends PointsConfig {
  debugForceLive: boolean;
}

/**
 * The directory that holds `channel-configs/`, `points/` and
 * `webhook-subscriptions/`. Resolved from this file rather than the working
 * directory, so the enrollment service and every channel bot agree however pm2
 * started them. POINTS_DATA_ROOT points the selftest at a scratch directory.
 */
export function dataRoot(): string {
  return process.env.POINTS_DATA_ROOT || path.resolve(__dirname, '..', '..', 'data');
}

const CURRENCY_NAME_RE = /^[A-Za-z0-9 $_-]{1,24}$/;
const COMMAND_RE = /^[a-z0-9_]{2,20}$/;
const USERNAME_RE = /^[a-z0-9_]{2,25}$/;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function num(v: unknown, fallback: number, min: number, max: number, integer: boolean): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const n = integer ? Math.round(v) : v;
  return Math.min(max, Math.max(min, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Lowercase, `@` stripped, invalid and duplicate names dropped. */
export function normalizeIgnoreUsers(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const raw of v) {
    const name = String(raw ?? '').trim().replace(/^@+/, '').toLowerCase();
    if (USERNAME_RE.test(name)) out.add(name);
  }
  return Array.from(out).slice(0, 500);
}

/**
 * The stored block with every field filled in. Values edited straight into the
 * file are clamped to sane bounds instead of rejected, so a hand edit can't stop
 * the bot. The API applies the strict rules (validatePointsPatch).
 */
export function internalPointsConfig(raw: unknown): InternalPointsConfig {
  const d = defaultPointsConfig();
  const r = obj(raw);
  const b = obj(r.bonuses);
  const g = obj(r.give);

  const name = typeof r.currencyName === 'string' && r.currencyName.trim() ? r.currencyName.trim().slice(0, 24) : d.currencyName;
  const command = typeof r.currencyCommand === 'string' && COMMAND_RE.test(r.currencyCommand) ? r.currencyCommand : null;
  // Staging sometimes wants short intervals; the API still limits them to 5–60.
  const interval = num(r.intervalMinutes, d.intervalMinutes, 1, 60, true);

  const bonuses: PointsBonusesConfig = {
    follow: num(b.follow, d.bonuses.follow, 0, 1_000_000, true),
    subNew: num(b.subNew, d.bonuses.subNew, 0, 1_000_000, true),
    subRenewal: num(b.subRenewal, d.bonuses.subRenewal, 0, 1_000_000, true),
    giftSubGifterPerSub: num(b.giftSubGifterPerSub, d.bonuses.giftSubGifterPerSub, 0, 1_000_000, true),
    giftSubRecipient: num(b.giftSubRecipient, d.bonuses.giftSubRecipient, 0, 1_000_000, true),
    pointsPerKick: num(b.pointsPerKick, d.bonuses.pointsPerKick, 0, 1000, false),
    onlyWhileLive: bool(b.onlyWhileLive, d.bonuses.onlyWhileLive),
    announce: bool(b.announce, d.bonuses.announce)
  };
  const give: PointsGiveConfig = {
    enabled: bool(g.enabled, d.give.enabled),
    minAmount: num(g.minAmount, d.give.minAmount, 1, 1_000_000, true),
    maxAmount: num(g.maxAmount, d.give.maxAmount, 0, 1_000_000_000, true),
    cooldownSeconds: num(g.cooldownSeconds, d.give.cooldownSeconds, 0, 3600, true)
  };

  return {
    enabled: bool(r.enabled, d.enabled),
    currencyName: name,
    currencyCommand: command,
    pointsPerInterval: num(r.pointsPerInterval, d.pointsPerInterval, 0, 100_000, true),
    intervalMinutes: interval,
    activeWindowMinutes: num(r.activeWindowMinutes, Math.max(interval, d.activeWindowMinutes), interval, 1440, true),
    subscriberMultiplier: num(r.subscriberMultiplier, d.subscriberMultiplier, 1, 10, false),
    excludeBroadcaster: bool(r.excludeBroadcaster, d.excludeBroadcaster),
    ignoreUsers: r.ignoreUsers === undefined ? d.ignoreUsers : normalizeIgnoreUsers(r.ignoreUsers),
    bonuses,
    give,
    modMaxAdjust: num(r.modMaxAdjust, d.modMaxAdjust, 1, 1_000_000_000, true),
    publicLeaderboard: bool(r.publicLeaderboard, d.publicLeaderboard),
    debugForceLive: r.debugForceLive === true
  };
}

/** The effective settings as the API exposes them: defaults merged, the staging switch removed. */
export function effectivePointsConfig(raw: unknown): PointsConfig {
  const { debugForceLive: _staging, ...cfg } = internalPointsConfig(raw);
  return cfg;
}

/** The chat command word, without the `!`: "$DON" → "don". */
export function effectiveCommand(cfg: Pick<PointsConfig, 'currencyName' | 'currencyCommand'>): string {
  if (typeof cfg.currencyCommand === 'string' && COMMAND_RE.test(cfg.currencyCommand)) return cfg.currencyCommand;
  const derived = cfg.currencyName.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  return derived.length >= 2 ? derived : 'points';
}

/** Whether a command word is already taken, e.g. by a command module or a custom command. */
export function commandWordCollides(word: string, reservedWords: string[]): boolean {
  const w = word.toLowerCase().replace(/^!+/, '');
  return reservedWords.some(r => String(r).toLowerCase().replace(/^!+/, '') === w);
}

interface Rule {
  min: number;
  max: number;
  integer: boolean;
}

const TOP_NUMBERS: Record<string, Rule> = {
  pointsPerInterval: { min: 0, max: 100_000, integer: true },
  intervalMinutes: { min: 5, max: 60, integer: true },
  activeWindowMinutes: { min: 5, max: 240, integer: true },
  subscriberMultiplier: { min: 1, max: 10, integer: false },
  modMaxAdjust: { min: 1, max: 1_000_000_000, integer: true }
};
const BONUS_NUMBERS: Record<string, Rule> = {
  follow: { min: 0, max: 1_000_000, integer: true },
  subNew: { min: 0, max: 1_000_000, integer: true },
  subRenewal: { min: 0, max: 1_000_000, integer: true },
  giftSubGifterPerSub: { min: 0, max: 1_000_000, integer: true },
  giftSubRecipient: { min: 0, max: 1_000_000, integer: true },
  pointsPerKick: { min: 0, max: 1000, integer: false }
};
const GIVE_NUMBERS: Record<string, Rule> = {
  minAmount: { min: 1, max: 1_000_000, integer: true },
  maxAmount: { min: 0, max: 1_000_000_000, integer: true },
  cooldownSeconds: { min: 0, max: 3600, integer: true }
};

function checkNumber(label: string, v: unknown, rule: Rule, errors: string[]): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < rule.min || v > rule.max || (rule.integer && !Number.isInteger(v))) {
    errors.push(`${label} must be ${rule.integer ? 'a whole number' : 'a number'} from ${rule.min} to ${rule.max}`);
    return undefined;
  }
  return v;
}

/**
 * Validate a settings patch from the API and merge it into the stored block.
 *
 * Nested blocks merge field by field, unknown keys are ignored, and `null`
 * clears `currencyCommand` back to the derived word. The result is what gets
 * written to the channel config: still partial, so untouched fields keep
 * following the defaults. The file-only staging switch carries over but can't
 * be set here. Collisions with other commands are the caller's check
 * (commandWordCollides).
 */
export function validatePointsPatch(current: unknown, patch: unknown): { next?: StoredPointsConfig; errors: string[] } {
  const errors: string[] = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { errors: ['points must be an object'] };
  }
  const p = patch as Record<string, unknown>;
  const cur = obj(current) as StoredPointsConfig;
  const next: StoredPointsConfig = { ...cur, bonuses: { ...(cur.bonuses ?? {}) }, give: { ...(cur.give ?? {}) } };

  for (const key of ['enabled', 'excludeBroadcaster', 'publicLeaderboard'] as const) {
    if (p[key] === undefined) continue;
    if (typeof p[key] !== 'boolean') errors.push(`${key} must be true or false`);
    else next[key] = p[key] as boolean;
  }

  if (p.currencyName !== undefined) {
    const name = typeof p.currencyName === 'string' ? p.currencyName.trim() : '';
    if (!CURRENCY_NAME_RE.test(name)) errors.push('currencyName must be 1–24 letters, digits, spaces, $, _ or -');
    else next.currencyName = name;
  }
  if (p.currencyCommand !== undefined) {
    if (p.currencyCommand === null || p.currencyCommand === '') next.currencyCommand = null;
    else if (typeof p.currencyCommand !== 'string' || !COMMAND_RE.test(p.currencyCommand)) {
      errors.push('currencyCommand must be 2–20 lowercase letters, digits or _');
    } else next.currencyCommand = p.currencyCommand;
  }

  for (const [key, rule] of Object.entries(TOP_NUMBERS)) {
    if (p[key] === undefined) continue;
    const v = checkNumber(key, p[key], rule, errors);
    if (v !== undefined) (next as Record<string, unknown>)[key] = v;
  }

  if (p.ignoreUsers !== undefined) {
    if (!Array.isArray(p.ignoreUsers) || p.ignoreUsers.length > 500) {
      errors.push('ignoreUsers must be a list of at most 500 usernames');
    } else {
      const bad = p.ignoreUsers.filter(u => !USERNAME_RE.test(String(u ?? '').trim().replace(/^@+/, '').toLowerCase()));
      if (bad.length) errors.push(`ignoreUsers has invalid usernames: ${bad.slice(0, 5).map(String).join(', ')}`);
      else next.ignoreUsers = normalizeIgnoreUsers(p.ignoreUsers);
    }
  }

  if (p.bonuses !== undefined) {
    if (!p.bonuses || typeof p.bonuses !== 'object' || Array.isArray(p.bonuses)) errors.push('bonuses must be an object');
    else {
      const b = p.bonuses as Record<string, unknown>;
      for (const [key, rule] of Object.entries(BONUS_NUMBERS)) {
        if (b[key] === undefined) continue;
        const v = checkNumber(`bonuses.${key}`, b[key], rule, errors);
        if (v !== undefined) (next.bonuses as Record<string, unknown>)[key] = v;
      }
      for (const key of ['onlyWhileLive', 'announce'] as const) {
        if (b[key] === undefined) continue;
        if (typeof b[key] !== 'boolean') errors.push(`bonuses.${key} must be true or false`);
        else next.bonuses![key] = b[key] as boolean;
      }
    }
  }

  if (p.give !== undefined) {
    if (!p.give || typeof p.give !== 'object' || Array.isArray(p.give)) errors.push('give must be an object');
    else {
      const g = p.give as Record<string, unknown>;
      if (g.enabled !== undefined) {
        if (typeof g.enabled !== 'boolean') errors.push('give.enabled must be true or false');
        else next.give!.enabled = g.enabled;
      }
      for (const [key, rule] of Object.entries(GIVE_NUMBERS)) {
        if (g[key] === undefined) continue;
        const v = checkNumber(`give.${key}`, g[key], rule, errors);
        if (v !== undefined) (next.give as Record<string, unknown>)[key] = v;
      }
    }
  }

  // Rules that span fields are checked against the settings as they'd end up. The
  // window is read before clamping: effective values would quietly stretch it to
  // the interval and hide the mistake.
  const eff = effectivePointsConfig(next);
  const window = typeof next.activeWindowMinutes === 'number' ? next.activeWindowMinutes : POINTS_DEFAULTS.activeWindowMinutes;
  if (window < eff.intervalMinutes) {
    errors.push(`activeWindowMinutes (${window}) can't be shorter than intervalMinutes (${eff.intervalMinutes})`);
  }
  if (eff.give.maxAmount > 0 && eff.give.maxAmount < eff.give.minAmount) {
    errors.push(`give.maxAmount (${eff.give.maxAmount}) can't be below give.minAmount (${eff.give.minAmount})`);
  }

  if (!Object.keys(next.bonuses ?? {}).length) delete next.bonuses;
  if (!Object.keys(next.give ?? {}).length) delete next.give;
  return errors.length ? { errors } : { next, errors };
}

/** A channel's settings as last read from disk, with its broadcaster id. */
export interface LivePointsConfig {
  cfg: InternalPointsConfig;
  broadcasterUserId: number | null;
}

/** How often the config file's modification time is checked. */
const CONFIG_RECHECK_MS = 15_000;

const liveCache = new Map<string, { checkedAt: number; mtimeMs: number; file: string; value: LivePointsConfig }>();

export function channelConfigPath(channel: string): string {
  return path.join(dataRoot(), 'channel-configs', `${channel}.json`);
}

/**
 * The channel's points settings as they are on disk now. Re-parsed only when
 * the file's modification time changed, checked at most every 15 seconds. A
 * missing or unreadable file keeps the last good copy, or the defaults.
 */
export function readLivePointsConfig(channel: string, now = Date.now()): LivePointsConfig {
  const file = channelConfigPath(channel);
  const cached = liveCache.get(channel);
  if (cached && cached.file === file && now - cached.checkedAt < CONFIG_RECHECK_MS) return cached.value;

  let mtimeMs = -1;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* missing */ }
  if (cached && cached.file === file && cached.mtimeMs === mtimeMs) {
    cached.checkedAt = now;
    return cached.value;
  }

  let value: LivePointsConfig = cached && cached.file === file ? cached.value : { cfg: internalPointsConfig(undefined), broadcasterUserId: null };
  if (mtimeMs >= 0) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
      const bid = parsed.broadcasterUserId;
      value = {
        cfg: internalPointsConfig(parsed.points),
        broadcasterUserId: typeof bid === 'number' && Number.isFinite(bid) ? bid : null
      };
    } catch {
      // Mid-write or corrupt: keep what we had. The next change retries.
    }
  } else {
    value = { cfg: internalPointsConfig(undefined), broadcasterUserId: null };
  }
  liveCache.set(channel, { checkedAt: now, mtimeMs, file, value });
  return value;
}

/** Forget the cached settings so the next read goes to disk. For tests and immediate re-reads. */
export function invalidateLivePointsConfig(channel?: string): void {
  if (channel) liveCache.delete(channel);
  else liveCache.clear();
}

/** Per-event webhook subscription results, written by the enrollment service. */
export type SubscriptionStatus = Record<string, { ok: boolean; error?: string; at: string }>;

/** null when the enrollment service hasn't recorded anything for the channel yet. */
export function readSubscriptionStatus(channel: string): SubscriptionStatus | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dataRoot(), 'webhook-subscriptions', `${channel}.json`), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as SubscriptionStatus) : null;
  } catch {
    return null;
  }
}
