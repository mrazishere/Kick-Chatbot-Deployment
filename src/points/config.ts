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
import { PointsBonusesConfig, PointsConfig, PointsDuelConfig, PointsGambleConfig, PointsGiveConfig, PointsRaffleConfig, StoredPointsConfig, PointsTimeoutPenaltyConfig } from '../types';

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
    publicLeaderboard: true,
    timeoutPenalty: {
      enabled: false,
      pointsPerSecond: 1,
      maxDeduction: 0,
      permanentBanCost: 0,
      announce: true
    },
    gamble: {
      enabled: false,
      winChancePercent: 50,
      minAmount: 1,
      maxAmount: 0,
      cooldownSeconds: 60,
      onlyWhileLive: true,
      winEmote: '',
      loseEmote: ''
    },
    duel: {
      enabled: false,
      minAmount: 1,
      maxAmount: 0,
      cooldownSeconds: 60,
      expirySeconds: 120,
      onlyWhileLive: true
    },
    raffle: {
      enabled: false,
      minPrize: 1,
      maxPrize: 100_000,
      maxPerStream: 5,
      defaultDurationSeconds: 120,
      maxDurationSeconds: 600,
      winners: 3,
      onlyWhileLive: true
    }
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
  const tp = obj(r.timeoutPenalty);

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
  const timeoutPenalty: PointsTimeoutPenaltyConfig = {
    enabled: bool(tp.enabled, d.timeoutPenalty.enabled),
    // Fractional rates are allowed: 0.5/second halves the cost of long timeouts.
    pointsPerSecond: num(tp.pointsPerSecond, d.timeoutPenalty.pointsPerSecond, 0, 10_000, false),
    maxDeduction: num(tp.maxDeduction, d.timeoutPenalty.maxDeduction, 0, 1_000_000_000, true),
    permanentBanCost: num(tp.permanentBanCost, d.timeoutPenalty.permanentBanCost, 0, 1_000_000_000, true),
    announce: bool(tp.announce, d.timeoutPenalty.announce)
  };
  const gm = obj(r.gamble);
  const gamble: PointsGambleConfig = {
    enabled: bool(gm.enabled, d.gamble.enabled),
    winChancePercent: num(gm.winChancePercent, d.gamble.winChancePercent, 0, 100, false),
    minAmount: num(gm.minAmount, d.gamble.minAmount, 1, 1_000_000_000, true),
    maxAmount: num(gm.maxAmount, d.gamble.maxAmount, 0, 1_000_000_000, true),
    cooldownSeconds: num(gm.cooldownSeconds, d.gamble.cooldownSeconds, 0, 3600, true),
    onlyWhileLive: bool(gm.onlyWhileLive, d.gamble.onlyWhileLive),
    winEmote: emoteWord(gm.winEmote, d.gamble.winEmote),
    loseEmote: emoteWord(gm.loseEmote, d.gamble.loseEmote)
  };
  const du = obj(r.duel);
  const duel: PointsDuelConfig = {
    enabled: bool(du.enabled, d.duel.enabled),
    minAmount: num(du.minAmount, d.duel.minAmount, 1, 1_000_000_000, true),
    maxAmount: num(du.maxAmount, d.duel.maxAmount, 0, 1_000_000_000, true),
    cooldownSeconds: num(du.cooldownSeconds, d.duel.cooldownSeconds, 0, 3600, true),
    expirySeconds: num(du.expirySeconds, d.duel.expirySeconds, 30, 600, true),
    onlyWhileLive: bool(du.onlyWhileLive, d.duel.onlyWhileLive)
  };

  const ra = obj(r.raffle);
  const raffle: PointsRaffleConfig = {
    enabled: bool(ra.enabled, d.raffle.enabled),
    minPrize: num(ra.minPrize, d.raffle.minPrize, 1, 1_000_000_000, true),
    maxPrize: num(ra.maxPrize, d.raffle.maxPrize, 0, 1_000_000_000, true),
    maxPerStream: num(ra.maxPerStream, d.raffle.maxPerStream, 0, 100, true),
    defaultDurationSeconds: num(ra.defaultDurationSeconds, d.raffle.defaultDurationSeconds, 10, 3600, true),
    maxDurationSeconds: num(ra.maxDurationSeconds, d.raffle.maxDurationSeconds, 10, 3600, true),
    winners: num(ra.winners, d.raffle.winners, 1, 50, true),
    onlyWhileLive: bool(ra.onlyWhileLive, d.raffle.onlyWhileLive)
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
    timeoutPenalty,
    gamble,
    duel,
    raffle,
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

/** The chat command word, without its `$`: "$DON" → "don", typed as $don. */
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
const PENALTY_NUMBERS: Record<string, Rule> = {
  // Fractional rates are allowed so long timeouts can be softened (0.5/second).
  pointsPerSecond: { min: 0, max: 10_000, integer: false },
  maxDeduction: { min: 0, max: 1_000_000_000, integer: true },
  permanentBanCost: { min: 0, max: 1_000_000_000, integer: true }
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
const DUEL_NUMBERS: Record<string, Rule> = {
  minAmount: { min: 1, max: 1_000_000_000, integer: true },
  maxAmount: { min: 0, max: 1_000_000_000, integer: true },
  cooldownSeconds: { min: 0, max: 3600, integer: true },
  expirySeconds: { min: 30, max: 600, integer: true }
};
const RAFFLE_NUMBERS: Record<string, Rule> = {
  minPrize: { min: 1, max: 1_000_000_000, integer: true },
  maxPrize: { min: 0, max: 1_000_000_000, integer: true },
  maxPerStream: { min: 0, max: 100, integer: true },
  defaultDurationSeconds: { min: 10, max: 3600, integer: true },
  maxDurationSeconds: { min: 10, max: 3600, integer: true },
  winners: { min: 1, max: 50, integer: true }
};
/**
 * An emote name as chat types it: letters, numbers and underscore, up to 40. Anything
 * else is dropped rather than posted, so a stray space or bracket can't turn one
 * reply into something Kick reads as markup.
 */
const EMOTE_RE = /^[A-Za-z0-9_]{1,40}$/;
function emoteWord(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const t = raw.trim();
  if (!t) return '';
  return EMOTE_RE.test(t) ? t : fallback;
}

const GAMBLE_NUMBERS: Record<string, Rule> = {
  // Decimals allowed, e.g. 47.5; the roll has 0.01% steps.
  winChancePercent: { min: 0, max: 100, integer: false },
  minAmount: { min: 1, max: 1_000_000_000, integer: true },
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
  const next: StoredPointsConfig = {
    ...cur,
    bonuses: { ...(cur.bonuses ?? {}) },
    give: { ...(cur.give ?? {}) },
    timeoutPenalty: { ...(cur.timeoutPenalty ?? {}) },
    gamble: { ...(cur.gamble ?? {}) },
    duel: { ...(cur.duel ?? {}) },
    raffle: { ...(cur.raffle ?? {}) }
  };

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

  if (p.timeoutPenalty !== undefined) {
    if (!p.timeoutPenalty || typeof p.timeoutPenalty !== 'object' || Array.isArray(p.timeoutPenalty)) {
      errors.push('timeoutPenalty must be an object');
    } else {
      const t = p.timeoutPenalty as Record<string, unknown>;
      for (const [key, rule] of Object.entries(PENALTY_NUMBERS)) {
        if (t[key] === undefined) continue;
        const v = checkNumber(`timeoutPenalty.${key}`, t[key], rule, errors);
        if (v !== undefined) (next.timeoutPenalty as Record<string, unknown>)[key] = v;
      }
      for (const key of ['enabled', 'announce'] as const) {
        if (t[key] === undefined) continue;
        if (typeof t[key] !== 'boolean') errors.push(`timeoutPenalty.${key} must be true or false`);
        else next.timeoutPenalty![key] = t[key] as boolean;
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

  if (p.gamble !== undefined) {
    if (!p.gamble || typeof p.gamble !== 'object' || Array.isArray(p.gamble)) errors.push('gamble must be an object');
    else {
      const gm = p.gamble as Record<string, unknown>;
      for (const [key, rule] of Object.entries(GAMBLE_NUMBERS)) {
        if (gm[key] === undefined) continue;
        const v = checkNumber(`gamble.${key}`, gm[key], rule, errors);
        if (v !== undefined) (next.gamble as Record<string, unknown>)[key] = v;
      }
      for (const key of ['enabled', 'onlyWhileLive'] as const) {
        if (gm[key] === undefined) continue;
        if (typeof gm[key] !== 'boolean') errors.push(`gamble.${key} must be true or false`);
        else next.gamble![key] = gm[key] as boolean;
      }
      for (const key of ['winEmote', 'loseEmote'] as const) {
        if (gm[key] === undefined) continue;
        const e = gm[key];
        if (typeof e !== 'string' || (e.trim() && !EMOTE_RE.test(e.trim()))) {
          errors.push(`gamble.${key} must be an emote name: letters, numbers or underscore, up to 40 characters`);
        } else next.gamble![key] = e.trim();
      }
    }
  }

  if (p.duel !== undefined) {
    if (!p.duel || typeof p.duel !== 'object' || Array.isArray(p.duel)) errors.push('duel must be an object');
    else {
      const du = p.duel as Record<string, unknown>;
      for (const [key, rule] of Object.entries(DUEL_NUMBERS)) {
        if (du[key] === undefined) continue;
        const v = checkNumber(`duel.${key}`, du[key], rule, errors);
        if (v !== undefined) (next.duel as Record<string, unknown>)[key] = v;
      }
      for (const key of ['enabled', 'onlyWhileLive'] as const) {
        if (du[key] === undefined) continue;
        if (typeof du[key] !== 'boolean') errors.push(`duel.${key} must be true or false`);
        else next.duel![key] = du[key] as boolean;
      }
    }
  }

  if (p.raffle !== undefined) {
    if (!p.raffle || typeof p.raffle !== 'object' || Array.isArray(p.raffle)) errors.push('raffle must be an object');
    else {
      const ra = p.raffle as Record<string, unknown>;
      for (const [key, rule] of Object.entries(RAFFLE_NUMBERS)) {
        if (ra[key] === undefined) continue;
        const v = checkNumber(`raffle.${key}`, ra[key], rule, errors);
        if (v !== undefined) (next.raffle as Record<string, unknown>)[key] = v;
      }
      for (const key of ['enabled', 'onlyWhileLive'] as const) {
        if (ra[key] === undefined) continue;
        if (typeof ra[key] !== 'boolean') errors.push(`raffle.${key} must be true or false`);
        else next.raffle![key] = ra[key] as boolean;
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
  if (eff.gamble.maxAmount > 0 && eff.gamble.maxAmount < eff.gamble.minAmount) {
    errors.push(`gamble.maxAmount (${eff.gamble.maxAmount}) can't be below gamble.minAmount (${eff.gamble.minAmount})`);
  }

  if (!Object.keys(next.bonuses ?? {}).length) delete next.bonuses;
  if (!Object.keys(next.give ?? {}).length) delete next.give;
  if (!Object.keys(next.gamble ?? {}).length) delete next.gamble;
  if (eff.duel.maxAmount > 0 && eff.duel.maxAmount < eff.duel.minAmount) {
    errors.push(`duel.maxAmount (${eff.duel.maxAmount}) can't be below duel.minAmount (${eff.duel.minAmount})`);
  }
  if (!Object.keys(next.duel ?? {}).length) delete next.duel;
  if (eff.raffle.maxPrize > 0 && eff.raffle.maxPrize < eff.raffle.minPrize) {
    errors.push(`raffle.maxPrize (${eff.raffle.maxPrize}) can't be below raffle.minPrize (${eff.raffle.minPrize})`);
  }
  if (eff.raffle.defaultDurationSeconds > eff.raffle.maxDurationSeconds) {
    errors.push(`raffle.defaultDurationSeconds (${eff.raffle.defaultDurationSeconds}) can't be above raffle.maxDurationSeconds (${eff.raffle.maxDurationSeconds})`);
  }
  if (!Object.keys(next.raffle ?? {}).length) delete next.raffle;
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
