"use client";

import { COUNTERPARTY_PREFIX, REASON_LABEL } from "@/lib/points-labels";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Coins, Copy, ExternalLink, Loader2, Search } from "lucide-react";
import type { OverlayLink } from "@/lib/fish-overlay";
import { Button, Card, Checkbox, Stat, Toggle } from "./ui";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

// Mirrors src/lib/bot-api.ts — duplicated rather than imported, since that module is server-only.

export interface PointsBonuses {
  follow: number;
  subNew: number;
  subRenewal: number;
  giftSubGifterPerSub: number;
  giftSubRecipient: number;
  pointsPerKick: number;
  onlyWhileLive: boolean;
  announce: boolean;
}

export interface PointsGive {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  cooldownSeconds: number;
}

/** What a timeout costs the viewer who got it, scaled per second. */
export interface PointsTimeoutPenalty {
  enabled: boolean;
  pointsPerSecond: number;
  /** 0 means no cap. */
  maxDeduction: number;
  /** Flat cost of a permanent ban, which has no duration. 0 ignores them. */
  permanentBanCost: number;
  announce: boolean;
}

export interface PointsConfig {
  enabled: boolean;
  currencyName: string;
  currencyCommand: string | null;
  effectiveCommand: string;
  pointsPerInterval: number;
  intervalMinutes: number;
  activeWindowMinutes: number;
  subscriberMultiplier: number;
  excludeBroadcaster: boolean;
  ignoreUsers: string[];
  bonuses: PointsBonuses;
  give: PointsGive;
  modMaxAdjust: number;
  publicLeaderboard: boolean;
  timeoutPenalty: PointsTimeoutPenalty;
  /** Absent from a bot service older than the gamble game. */
  gamble?: PointsGamble;
  /** Absent from a bot service older than duels. */
  duel?: PointsDuel;
  /** Absent from a bot service older than raffles. */
  raffle?: PointsRaffle;
  /** Absent from a bot service older than fishing. */
  games?: PointsGames;
}

/**
 * `$<cmd> fish`: supibot's fishing game played for the channel currency. Bait is
 * bought and selling the catch pays out in it. Defaults are supibot's numbers.
 */
export interface PointsGames {
  enabled: boolean;
  /** Casting and laying traps only while live; selling and stats work any time. */
  onlyWhileLive: boolean;
  /** 1 in this many unbaited casts lands a fish. */
  catchOdds: number;
  catchCooldownMinutes: number;
  trapMinutes: number;
  /** Sell prices as a percentage of supibot's (fish 50, junk 1–20). */
  sellPricePercent: number;
  /** Bait prices as a percentage of supibot's (worm 2, fly 5, cricket 8). */
  baitPricePercent: number;
  /** A short AI story on 1 in 3 catches. */
  stories: boolean;
  /** Cast results and trap hauls go to chat. They always go to the fishing overlay; other fishing replies always go to chat. Absent from an older bot service. */
  chatReplies?: boolean;
  /** Every fish and junk item's odds and price. Absent from a bot service older than per-item settings. */
  catches?: FishCatch[];
  /** Reels in buying order. Absent from a bot service older than reels. */
  reels?: FishReel[];
  /** `fish steal`. Absent from a bot service older than stealing. */
  steal?: FishSteal;
}

/** `fish steal`: a hook to try, rarity odds, a burned fine when caught, and guards. Mirrors the bot's FishStealSetting. */
export interface FishSteal {
  enabled: boolean;
  hookPrice: number;
  hookUses: number;
  feePercent: number;
  feeMinimum: number;
  finePercent: number;
  fineMinimum: number;
  oddsCommon: number;
  oddsUncommon: number;
  oddsRare: number;
  oddsEpic: number;
  oddsLegendary: number;
  graceMinutes: number;
  protectMinutes: number;
  guardPercent: number;
  guardMinimum: number;
  guardHours: number;
}

type StealNumber = Exclude<keyof FishSteal, "enabled">;

/** The steal settings' inputs, in the order shown, with the bot's bounds and defaults. */
const STEAL_FIELDS: Array<{ key: StealNumber; label: string; hint: string; min: number; max: number }> = [
  { key: "hookPrice", label: "Hook price", hint: "default 500", min: 0, max: 1_000_000_000 },
  { key: "hookUses", label: "Tries per hook", hint: "default 3", min: 1, max: 100 },
  { key: "feePercent", label: "Fee (% of the fish)", hint: "every try, burned, default 10", min: 0, max: 1000 },
  { key: "feeMinimum", label: "Smallest fee", hint: "default 50", min: 0, max: 1_000_000_000 },
  { key: "finePercent", label: "Fine (% of the fish)", hint: "when caught, burned, default 50", min: 0, max: 1000 },
  { key: "fineMinimum", label: "Smallest fine", hint: "default 100", min: 0, max: 1_000_000_000 },
  { key: "oddsCommon", label: "Common (%)", hint: "chance it works, default 40", min: 0, max: 100 },
  { key: "oddsUncommon", label: "Uncommon (%)", hint: "default 30", min: 0, max: 100 },
  { key: "oddsRare", label: "Rare (%)", hint: "default 20", min: 0, max: 100 },
  { key: "oddsEpic", label: "Epic (%)", hint: "default 10", min: 0, max: 100 },
  { key: "oddsLegendary", label: "Legendary (%)", hint: "default 5", min: 0, max: 100 },
  { key: "graceMinutes", label: "Safe after landing (min)", hint: "default 30", min: 0, max: 1440 },
  { key: "protectMinutes", label: "Target left alone (min)", hint: "after a try, default 60", min: 0, max: 1440 },
  { key: "guardPercent", label: "Guard price (% of fish held)", hint: "default 5", min: 0, max: 100 },
  { key: "guardMinimum", label: "Cheapest guard", hint: "default 200", min: 0, max: 1_000_000_000 },
  { key: "guardHours", label: "Guard lasts (hours)", hint: "1–168, default 12", min: 1, max: 168 },
];

export interface FishReel {
  name: string;
  price: number;
  oddsMultiplier: number;
  rarityMultiplier: number;
  valueMultiplier: number;
}

export interface FishCatch {
  name: string;
  type: "fish" | "junk";
  /** Chance weight within its type, up to two decimals; 0 is never caught. */
  weight: number;
  /** Sell price; a sized fish's length and a record still scale it. */
  price: number;
  defaultWeight: number;
  defaultPrice: number;
}

/** The bot's defaults, for a bot service that doesn't report game settings yet. */
const GAMES_DEFAULTS: PointsGames = {
  enabled: false,
  onlyWhileLive: true,
  catchOdds: 20,
  catchCooldownMinutes: 30,
  trapMinutes: 60,
  sellPricePercent: 100,
  baitPricePercent: 100,
  stories: true,
  chatReplies: true,
};

/** `$<cmd> duel @user <amount>`: viewer against viewer, 50/50, winner takes both stakes. */
export interface PointsDuel {
  enabled: boolean;
  minAmount: number;
  maxAmount: number;
  cooldownSeconds: number;
  expirySeconds: number;
  onlyWhileLive: boolean;
}

/**
 * `$<cmd> raffle <prize> [seconds]`: a moderator opens it, viewers enter free with
 * `$<cmd> join`, and the prize is paid when it closes. The prize is minted rather than
 * taken from anyone, which is what the caps are for.
 */
export interface PointsRaffle {
  enabled: boolean;
  minPrize: number;
  maxPrize: number;
  maxPerStream: number;
  defaultDurationSeconds: number;
  maxDurationSeconds: number;
  winners: number;
  onlyWhileLive: boolean;
}

/** The bot's defaults, for a bot service that doesn't report raffle settings yet. */
const RAFFLE_DEFAULTS: PointsRaffle = {
  enabled: false,
  minPrize: 1,
  maxPrize: 100000,
  maxPerStream: 5,
  defaultDurationSeconds: 120,
  maxDurationSeconds: 600,
  winners: 3,
  onlyWhileLive: true,
};

/** The bot's defaults, for a bot service that doesn't report duel settings yet. */
const DUEL_DEFAULTS: PointsDuel = {
  enabled: false,
  minAmount: 1,
  maxAmount: 0,
  cooldownSeconds: 60,
  expirySeconds: 120,
  onlyWhileLive: true,
};

interface PointsDuelStats {
  duels: number;
  staked: number;
  pending: number;
}

/** `$<cmd> gamble <amount>`: even money at one win chance for the whole channel. */
export interface PointsGamble {
  enabled: boolean;
  winChancePercent: number;
  minAmount: number;
  maxAmount: number;
  cooldownSeconds: number;
  onlyWhileLive: boolean;
}

/** The bot's defaults, for a bot service that doesn't report gamble settings yet. */
const GAMBLE_DEFAULTS: PointsGamble = {
  enabled: false,
  winChancePercent: 50,
  minAmount: 1,
  maxAmount: 0,
  cooldownSeconds: 60,
  onlyWhileLive: true,
};

interface PointsGambleStats {
  gambles: number;
  wins: number;
  staked: number;
  net: number;
}

type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "timeoutPenalty" | "gamble" | "games">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
  gamble?: Partial<PointsGamble>;
  games?: Partial<Omit<PointsGames, "catches">> & { catches?: Record<string, { weight: number; price: number }> };
};

interface PointsSummary {
  enabled: boolean;
  currencyName: string;
  effectiveCommand: string;
  dbAvailable: boolean;
  users: number;
  totalPoints: number;
  lastTickAt: string | null;
  lastTickUsers: number | null;
  subscriptions: Record<string, { ok: boolean; error?: string; at: string }>;
  /** Absent from a bot service older than the gamble game. thisStream is null while offline. */
  gamble?: { allTime: PointsGambleStats; thisStream: PointsGambleStats | null };
  /** Absent from a bot service older than duels. thisStream is null while offline. */
  duel?: { allTime: PointsDuelStats; thisStream: PointsDuelStats | null };
}

interface PointsUserRow {
  userId: number;
  username: string;
  balance: number;
  watchSeconds: number;
  rank: number;
  lastSeenAt: string | null;
}

interface PointsUserDetail {
  user: PointsUserRow & {
    lifetimeEarned: number;
    isSub: boolean;
    followBonusAt: string | null;
    firstSeenAt: string;
  };
  /** Gamble results, all time. Absent from a bot service older than this field. */
  gamble?: { gambles: number; wins: number; staked: number; net: number };
  ledger: Array<{
    id: number;
    ts: string;
    delta: number;
    balanceAfter: number;
    reason: string;
    actor: string | null;
    note: string | null;
    /** The other side of a give or a duel. Absent from a bot service older than this field. */
    counterparty?: string | null;
  }>;
}

type AdjustMode = "add" | "remove" | "set";

/** The settings form holds numbers as text, so a half-typed value isn't coerced to 0 while editing. */
interface SettingsForm {
  currencyName: string;
  currencyCommand: string;
  pointsPerInterval: string;
  intervalMinutes: string;
  activeWindowMinutes: string;
  subscriberMultiplier: string;
  excludeBroadcaster: boolean;
  ignoreUsers: string;
  follow: string;
  subNew: string;
  subRenewal: string;
  giftSubGifterPerSub: string;
  giftSubRecipient: string;
  pointsPerKick: string;
  onlyWhileLive: boolean;
  announce: boolean;
  giveEnabled: boolean;
  giveMin: string;
  giveMax: string;
  giveCooldown: string;
  modMaxAdjust: string;
  publicLeaderboard: boolean;
  penaltyEnabled: boolean;
  penaltyPerSecond: string;
  penaltyMax: string;
  penaltyPermanentBan: string;
  penaltyAnnounce: boolean;
  gambleEnabled: boolean;
  gambleChance: string;
  gambleMin: string;
  gambleMax: string;
  gambleCooldown: string;
  gambleLiveOnly: boolean;
  duelEnabled: boolean;
  duelMin: string;
  duelMax: string;
  duelCooldown: string;
  duelExpiry: string;
  duelLiveOnly: boolean;
  raffleEnabled: boolean;
  raffleMinPrize: string;
  raffleMaxPrize: string;
  rafflePerStream: string;
  raffleDefaultSeconds: string;
  raffleMaxSeconds: string;
  raffleWinners: string;
  raffleLiveOnly: boolean;
  gamesEnabled: boolean;
  gamesLiveOnly: boolean;
  fishOdds: string;
  fishCatchCooldown: string;
  fishTrapMinutes: string;
  fishSellPct: string;
  fishBaitPct: string;
  fishStories: boolean;
  fishChatReplies: boolean;
  fishCatches: { name: string; type: "fish" | "junk"; weight: string; price: string; defaultWeight: number; defaultPrice: number }[];
  /** null when the bot service doesn't report reels. */
  fishReels: { name: string; price: string; odds: string; rarity: string; value: string }[] | null;
  /** null when the bot service doesn't report stealing. */
  fishSteal: ({ enabled: boolean } & Record<StealNumber, string>) | null;
}

function formFromConfig(c: PointsConfig): SettingsForm {
  return {
    currencyName: c.currencyName,
    currencyCommand: c.currencyCommand ?? "",
    pointsPerInterval: String(c.pointsPerInterval),
    intervalMinutes: String(c.intervalMinutes),
    activeWindowMinutes: String(c.activeWindowMinutes),
    subscriberMultiplier: String(c.subscriberMultiplier),
    excludeBroadcaster: c.excludeBroadcaster,
    ignoreUsers: c.ignoreUsers.join(", "),
    follow: String(c.bonuses.follow),
    subNew: String(c.bonuses.subNew),
    subRenewal: String(c.bonuses.subRenewal),
    giftSubGifterPerSub: String(c.bonuses.giftSubGifterPerSub),
    giftSubRecipient: String(c.bonuses.giftSubRecipient),
    pointsPerKick: String(c.bonuses.pointsPerKick),
    onlyWhileLive: c.bonuses.onlyWhileLive,
    announce: c.bonuses.announce,
    giveEnabled: c.give.enabled,
    giveMin: String(c.give.minAmount),
    giveMax: String(c.give.maxAmount),
    giveCooldown: String(c.give.cooldownSeconds),
    modMaxAdjust: String(c.modMaxAdjust),
    publicLeaderboard: c.publicLeaderboard,
    penaltyEnabled: c.timeoutPenalty.enabled,
    penaltyPerSecond: String(c.timeoutPenalty.pointsPerSecond),
    penaltyMax: String(c.timeoutPenalty.maxDeduction),
    penaltyPermanentBan: String(c.timeoutPenalty.permanentBanCost),
    penaltyAnnounce: c.timeoutPenalty.announce,
    gambleEnabled: (c.gamble ?? GAMBLE_DEFAULTS).enabled,
    gambleChance: String((c.gamble ?? GAMBLE_DEFAULTS).winChancePercent),
    gambleMin: String((c.gamble ?? GAMBLE_DEFAULTS).minAmount),
    gambleMax: String((c.gamble ?? GAMBLE_DEFAULTS).maxAmount),
    gambleCooldown: String((c.gamble ?? GAMBLE_DEFAULTS).cooldownSeconds),
    gambleLiveOnly: (c.gamble ?? GAMBLE_DEFAULTS).onlyWhileLive,
    duelEnabled: (c.duel ?? DUEL_DEFAULTS).enabled,
    duelMin: String((c.duel ?? DUEL_DEFAULTS).minAmount),
    duelMax: String((c.duel ?? DUEL_DEFAULTS).maxAmount),
    duelCooldown: String((c.duel ?? DUEL_DEFAULTS).cooldownSeconds),
    duelExpiry: String((c.duel ?? DUEL_DEFAULTS).expirySeconds),
    duelLiveOnly: (c.duel ?? DUEL_DEFAULTS).onlyWhileLive,
    raffleEnabled: (c.raffle ?? RAFFLE_DEFAULTS).enabled,
    raffleMinPrize: String((c.raffle ?? RAFFLE_DEFAULTS).minPrize),
    raffleMaxPrize: String((c.raffle ?? RAFFLE_DEFAULTS).maxPrize),
    rafflePerStream: String((c.raffle ?? RAFFLE_DEFAULTS).maxPerStream),
    raffleDefaultSeconds: String((c.raffle ?? RAFFLE_DEFAULTS).defaultDurationSeconds),
    raffleMaxSeconds: String((c.raffle ?? RAFFLE_DEFAULTS).maxDurationSeconds),
    raffleWinners: String((c.raffle ?? RAFFLE_DEFAULTS).winners),
    raffleLiveOnly: (c.raffle ?? RAFFLE_DEFAULTS).onlyWhileLive,
    gamesEnabled: (c.games ?? GAMES_DEFAULTS).enabled,
    gamesLiveOnly: (c.games ?? GAMES_DEFAULTS).onlyWhileLive,
    fishOdds: String((c.games ?? GAMES_DEFAULTS).catchOdds),
    fishCatchCooldown: String((c.games ?? GAMES_DEFAULTS).catchCooldownMinutes),
    fishTrapMinutes: String((c.games ?? GAMES_DEFAULTS).trapMinutes),
    fishSellPct: String((c.games ?? GAMES_DEFAULTS).sellPricePercent),
    fishBaitPct: String((c.games ?? GAMES_DEFAULTS).baitPricePercent),
    fishStories: (c.games ?? GAMES_DEFAULTS).stories,
    fishChatReplies: (c.games ?? GAMES_DEFAULTS).chatReplies !== false,
    fishCatches: (c.games?.catches ?? []).map((x) => ({ ...x, weight: String(x.weight), price: String(x.price) })),
    fishReels: c.games?.reels
      ? c.games.reels.map((r) => ({
          name: r.name,
          price: String(r.price),
          odds: String(r.oddsMultiplier),
          rarity: String(r.rarityMultiplier),
          value: String(r.valueMultiplier),
        }))
      : null,
    fishSteal: c.games?.steal
      ? {
          enabled: c.games.steal.enabled,
          ...(Object.fromEntries(STEAL_FIELDS.map(({ key }) => [key, String(c.games!.steal![key])])) as Record<StealNumber, string>),
        }
      : null,
  };
}

/**
 * The command the bot answers when no override is set. Mirrors effectiveCommand in
 * the bot's src/points/config.ts: lowercased, letters, digits and _ kept, at most 20
 * characters, and "points" when that leaves fewer than 2.
 */
function deriveCommand(name: string): string {
  const derived = name.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 20);
  return derived.length >= 2 ? derived : "points";
}

function parseIgnoreList(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,]+/)
        .map((s) => s.trim().replace(/^@+/, "").toLowerCase())
        .filter(Boolean),
    ),
  );
}

/**
 * Validate the form into a settings patch, mirroring the bot service's rules so a
 * mistake shows here instead of as a failed save. The service still has the final say.
 */
function buildPatch(f: SettingsForm): { patch: PointsSettingsPatch } | { error: string } {
  const errors: string[] = [];
  const whole = (raw: string, label: string, min: number, max: number): number => {
    const t = raw.trim();
    const n = Number(t);
    if (t === "" || !Number.isInteger(n) || n < min || n > max) {
      errors.push(`${label} must be a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`);
      return min;
    }
    return n;
  };
  const decimal = (raw: string, label: string, min: number, max: number): number => {
    const t = raw.trim();
    const n = Number(t);
    if (t === "" || !Number.isFinite(n) || n < min || n > max) {
      errors.push(`${label} must be a number from ${min} to ${max}`);
      return min;
    }
    return n;
  };

  const currencyName = f.currencyName.trim();
  if (!/^[A-Za-z0-9 $_-]{1,24}$/.test(currencyName)) {
    errors.push("Currency name must be 1–24 letters, digits, spaces or $ _ -");
  }
  const command = f.currencyCommand.trim().replace(/^[!$]+/, "").toLowerCase();
  if (command && !/^[a-z0-9_]{2,20}$/.test(command)) {
    errors.push("Command must be 2–20 lowercase letters, digits or _");
  }

  const ignoreUsers = parseIgnoreList(f.ignoreUsers);
  if (ignoreUsers.length > 500) errors.push("The ignore list is limited to 500 names");
  const badNames = ignoreUsers.filter((u) => !/^[a-z0-9_]{2,25}$/.test(u));
  if (badNames.length > 0) errors.push(`Not valid usernames: ${badNames.slice(0, 5).join(", ")}`);

  const intervalMinutes = whole(f.intervalMinutes, "Interval", 5, 60);
  const patch: PointsSettingsPatch = {
    currencyName,
    currencyCommand: command || null,
    pointsPerInterval: whole(f.pointsPerInterval, "Points per interval", 0, 100_000),
    intervalMinutes,
    activeWindowMinutes: whole(f.activeWindowMinutes, "Active window", intervalMinutes, 240),
    subscriberMultiplier: decimal(f.subscriberMultiplier, "Subscriber multiplier", 1, 10),
    excludeBroadcaster: f.excludeBroadcaster,
    ignoreUsers,
    bonuses: {
      follow: whole(f.follow, "Follow bonus", 0, 1_000_000),
      subNew: whole(f.subNew, "New sub bonus", 0, 1_000_000),
      subRenewal: whole(f.subRenewal, "Resub bonus", 0, 1_000_000),
      giftSubGifterPerSub: whole(f.giftSubGifterPerSub, "Gifted sub bonus", 0, 1_000_000),
      giftSubRecipient: whole(f.giftSubRecipient, "Gift recipient bonus", 0, 1_000_000),
      pointsPerKick: decimal(f.pointsPerKick, "Points per Kick", 0, 1000),
      onlyWhileLive: f.onlyWhileLive,
      announce: f.announce,
    },
    give: {
      enabled: f.giveEnabled,
      minAmount: whole(f.giveMin, "Minimum give", 1, 1_000_000),
      maxAmount: whole(f.giveMax, "Maximum give", 0, 1_000_000_000),
      cooldownSeconds: whole(f.giveCooldown, "Give cooldown", 0, 3600),
    },
    timeoutPenalty: {
      enabled: f.penaltyEnabled,
      pointsPerSecond: decimal(f.penaltyPerSecond, "Cost per second", 0, 10_000),
      maxDeduction: whole(f.penaltyMax, "Maximum deduction", 0, 1_000_000_000),
      permanentBanCost: whole(f.penaltyPermanentBan, "Permanent ban cost", 0, 1_000_000_000),
      announce: f.penaltyAnnounce,
    },
    gamble: {
      enabled: f.gambleEnabled,
      winChancePercent: decimal(f.gambleChance, "Win chance", 0, 100),
      minAmount: whole(f.gambleMin, "Minimum bet", 1, 1_000_000_000),
      maxAmount: whole(f.gambleMax, "Maximum bet", 0, 1_000_000_000),
      cooldownSeconds: whole(f.gambleCooldown, "Gamble cooldown", 0, 3600),
      onlyWhileLive: f.gambleLiveOnly,
    },
    modMaxAdjust: whole(f.modMaxAdjust, "Max per mod adjustment", 1, 1_000_000_000),
    publicLeaderboard: f.publicLeaderboard,
  };
  const gamble = patch.gamble!;
  if (gamble.maxAmount! > 0 && gamble.maxAmount! < gamble.minAmount!) {
    errors.push("Maximum bet can't be below the minimum bet (0 means no maximum)");
  }
  patch.duel = {
    enabled: f.duelEnabled,
    minAmount: whole(f.duelMin, "Minimum duel", 1, 1_000_000_000),
    maxAmount: whole(f.duelMax, "Maximum duel", 0, 1_000_000_000),
    cooldownSeconds: whole(f.duelCooldown, "Duel cooldown", 0, 3600),
    expirySeconds: whole(f.duelExpiry, "Time to answer", 30, 600),
    onlyWhileLive: f.duelLiveOnly,
  };
  if (patch.duel.maxAmount! > 0 && patch.duel.maxAmount! < patch.duel.minAmount!) {
    errors.push("Maximum duel can't be below the minimum duel (0 means no maximum)");
  }
  patch.raffle = {
    enabled: f.raffleEnabled,
    minPrize: whole(f.raffleMinPrize, "Minimum prize", 1, 1_000_000_000),
    maxPrize: whole(f.raffleMaxPrize, "Maximum prize", 0, 1_000_000_000),
    maxPerStream: whole(f.rafflePerStream, "Raffles per stream", 0, 100),
    defaultDurationSeconds: whole(f.raffleDefaultSeconds, "Default length", 10, 3600),
    maxDurationSeconds: whole(f.raffleMaxSeconds, "Longest raffle", 10, 3600),
    winners: whole(f.raffleWinners, "Winners", 1, 50),
    onlyWhileLive: f.raffleLiveOnly,
  };
  if (patch.raffle.maxPrize! > 0 && patch.raffle.maxPrize! < patch.raffle.minPrize!) {
    errors.push("Maximum prize can't be below the minimum prize (0 means no maximum)");
  }
  if (patch.raffle.defaultDurationSeconds! > patch.raffle.maxDurationSeconds!) {
    errors.push("Default raffle length can't be longer than the longest raffle");
  }
  patch.games = {
    enabled: f.gamesEnabled,
    onlyWhileLive: f.gamesLiveOnly,
    catchOdds: whole(f.fishOdds, "Catch odds", 1, 1000),
    catchCooldownMinutes: whole(f.fishCatchCooldown, "Cooldown after a catch", 1, 1440),
    trapMinutes: whole(f.fishTrapMinutes, "Trap time", 31, 1440),
    sellPricePercent: whole(f.fishSellPct, "Sell prices", 0, 1000),
    baitPricePercent: whole(f.fishBaitPct, "Bait prices", 0, 1000),
    stories: f.fishStories,
    chatReplies: f.fishChatReplies,
  };
  if (f.fishCatches.length > 0) {
    // Only items that differ from their default are sent; the rest keep following it.
    const catches: Record<string, { weight: number; price: number }> = {};
    for (const c of f.fishCatches) {
      const weight = Math.round(decimal(c.weight, `${c.name} odds`, 0, 1_000_000) * 100) / 100;
      const price = whole(c.price, `${c.name} price`, 0, 1_000_000_000);
      if (weight !== c.defaultWeight || price !== c.defaultPrice) catches[c.name] = { weight, price };
    }
    for (const type of ["fish", "junk"] as const) {
      if (f.fishCatches.filter((c) => c.type === type).every((c) => Number(c.weight) === 0)) {
        errors.push(`At least one ${type === "fish" ? "fish" : "junk item"} needs odds above 0`);
      }
    }
    patch.games.catches = catches;
  }
  if (f.fishReels) {
    const names = new Set<string>();
    patch.games.reels = f.fishReels.map((r, i) => {
      const label = `Reel ${i + 1}`;
      const name = r.name.trim();
      if (!name || name.length > 24 || /[<>@]/.test(name)) errors.push(`${label} needs a name of 1 to 24 characters, without < > or @`);
      else if (names.has(name.toLowerCase())) errors.push(`Two reels are called ${name}`);
      names.add(name.toLowerCase());
      const mult = (raw: string, what: string) => Math.round(decimal(raw, `${label} ${what}`, 0.1, 10) * 100) / 100;
      return {
        name,
        price: whole(r.price, `${label} price`, 0, 1_000_000_000),
        oddsMultiplier: mult(r.odds, "odds ×"),
        rarityMultiplier: mult(r.rarity, "rarity ×"),
        valueMultiplier: mult(r.value, "value ×"),
      };
    });
    if (f.fishReels.length > 10) errors.push("There can be at most 10 reels");
  }
  if (f.fishSteal) {
    const steal = { enabled: f.fishSteal.enabled } as FishSteal;
    for (const { key, label, min, max } of STEAL_FIELDS) steal[key] = whole(f.fishSteal[key], `Stealing: ${label}`, min, max);
    patch.games.steal = steal;
  }

  return errors.length > 0 ? { error: errors.join("; ") } : { patch };
}

/** Turn the rate into something concrete, since "per second" is easy to misjudge. */
function costExample(perSecond: string, max: string, currency: string): string {
  const rate = Number(perSecond);
  if (!Number.isFinite(rate) || rate <= 0) return "Free at 0.";
  const cap = Number(max);
  const capped = (n: number) => (Number.isFinite(cap) && cap > 0 ? Math.min(n, cap) : n);
  const unit = currency.trim() || "points";
  const min5 = capped(Math.floor(rate * 300)).toLocaleString();
  return `1 min costs ${capped(Math.floor(rate * 60)).toLocaleString()}, 5 min costs ${min5} ${unit}.`;
}

/**
 * What a win chance means, since "50%" reads like "50 wins per 100". It's one
 * setting for the whole channel and every gamble is its own roll, so the channel's
 * overall rate only settles near it: the ranges are the 95% band, p ± 2·√(p(1−p)/n).
 */
function gambleExplain(raw: string): string {
  const t = raw.trim();
  const p = Number(t);
  if (t === "" || !Number.isFinite(p) || p < 0 || p > 100) return "Enter a chance from 0 to 100.";
  const band = (n: number) => {
    const spread = 200 * Math.sqrt(((p / 100) * (1 - p / 100)) / n);
    return `${Math.max(0, Math.round(p - spread))}–${Math.min(100, Math.round(p + spread))}%`;
  };
  // Even money: each bet returns (2p − 1) of itself on average.
  const edge = 2 * p - 100;
  const round = (n: number) => Number(n.toFixed(1)).toString();
  const economy =
    Math.abs(edge) < 0.05
      ? "breaks even on average"
      : edge < 0
        ? `removes about ${round(-edge)}% of each bet on average`
        : `creates about ${round(edge)}% of each bet on average`;
  return (
    `Applies to everyone in the channel. Each gamble is its own roll, so the channel's overall win rate settles near this: ` +
    `about ${band(100)} over 100 gambles, ${band(1000)} over 1,000. Gambling ${economy}.`
  );
}

function gambleStatsText(s: PointsGambleStats, currency: string): string {
  if (s.gambles === 0) return "no gambles yet";
  const rate = ((s.wins / s.gambles) * 100).toFixed(1);
  const net = `${s.net > 0 ? "+" : ""}${s.net.toLocaleString()}`;
  return `${s.gambles.toLocaleString()} gambles, ${rate}% won, viewers net ${net} ${currency}`;
}

function duelStatsText(s: PointsDuelStats, currency: string): string {
  const pending = s.pending > 0 ? `, ${s.pending.toLocaleString()} waiting for an answer` : "";
  if (s.duels === 0) return `no duels played yet${pending}`;
  return `${s.duels.toLocaleString()} duels, ${s.staked.toLocaleString()} ${currency} put in${pending}`;
}

function formatWatch(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h.toLocaleString()}h ${m}m` : `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

/**
 * How the other side of an event reads on its row: a give has a direction, a duel
 * has an opponent. Reasons that never have a second party aren't listed, so their
 * rows stay as they were.
 */
async function callApi<T>(channel: string, path: string, init?: RequestInit): Promise<{ data?: T; error?: string }> {
  try {
    const res = await fetch(`${BASE_PATH}/api/bot/${encodeURIComponent(channel)}${path}`, {
      cache: "no-store",
      ...init,
      headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    });
    const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) return { error: body?.error ?? `Request failed (${res.status})` };
    return { data: body as T };
  } catch {
    return { error: "Network error — try again" };
  }
}

const INPUT =
  "w-full rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-neutral-500 disabled:opacity-40";
const LABEL = "mb-1 block text-xs uppercase tracking-wider text-neutral-500";
const SECTION = "mb-3 text-xs font-semibold uppercase tracking-wider text-neutral-400";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={LABEL}>{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-neutral-500">{hint}</span> : null}
    </label>
  );
}

const CELL_INPUT =
  "w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-right text-sm tabular-nums text-neutral-200 outline-none transition focus:border-neutral-500 disabled:opacity-40";

type CatchRow = SettingsForm["fishCatches"][number];
type StealForm = NonNullable<SettingsForm["fishSteal"]>;

/** `fish steal`, off until a channel turns it on; the numbers only show once it's on. */
function StealSettings({ value, currency, command, disabled, onChange }: {
  value: StealForm;
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (v: StealForm) => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-neutral-800 p-3">
      <Checkbox
        label={`Let viewers steal fish from each other ($${command} fish steal @user)`}
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled ? (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-5">
            {STEAL_FIELDS.map(({ key, label, hint }) => (
              <Field key={key} label={label} hint={hint}>
                <input
                  value={value[key]}
                  inputMode="numeric"
                  disabled={disabled}
                  onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                  className={INPUT}
                />
              </Field>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {`A thief first buys a 🪝 grappling hook with $${command} fish buy hook, then picks a target; the hook grabs one random fish that target has held longer than the safe time. Each try costs one hook use, the fishing cooldown and a fee on the grabbed fish's value. `}
            {`It works at the chance for that fish's rarity; otherwise the thief is caught, pays a fine on the fish's value on top of the fee and loses the hook. Fees and fines go nowhere: nobody receives them. `}
            {`A thief must hold the fee and fine for the target's most valuable fish before trying; short of that, the try only costs a hook use, and the reply says how much they need. Steals always reply in chat, whatever the chat setting above, and also play on the overlay. `}
            {`A viewer can hire a guard with $${command} fish buy guard, priced on what their fish are worth right now. A guarded target turns every try away for one hook use and nothing else. How long a guard lasts is set below but never shown in chat, not even to its owner, since chat is public. Prices are in ${currency}.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
type ReelRow = NonNullable<SettingsForm["fishReels"]>[number];

/**
 * The reels viewers buy, in order, with what each one does. Folded away like the
 * catch table; most channels will only ever touch the prices.
 */
function ReelTable({ rows, currency, command, disabled, onChange }: {
  rows: ReelRow[];
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (rows: ReelRow[]) => void;
}) {
  const edit = (i: number, key: keyof ReelRow, value: string) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
  const remove = (i: number) => onChange(rows.filter((_, j) => j !== i));
  const add = () => onChange([...rows, { name: "", price: "0", odds: "1", rarity: "1", value: "1" }]);
  const cell = (i: number, key: keyof ReelRow, label: string, mode: "numeric" | "decimal" | "text") => (
    <input
      aria-label={`Reel ${i + 1} ${label}`}
      inputMode={mode === "text" ? undefined : mode}
      value={rows[i][key]}
      disabled={disabled}
      onChange={(e) => edit(i, key, e.target.value)}
      className={mode === "text" ? CELL_INPUT.replace("text-right ", "") : CELL_INPUT}
    />
  );

  return (
    <details className="mt-3 rounded-lg border border-neutral-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-neutral-300">
        Reels
        <span className="ml-2 text-xs text-neutral-500">{rows.length === 0 ? "none, the shop is empty" : `${rows.length} in the shop`}</span>
      </summary>
      <div className="border-t border-neutral-800 p-3">
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-xs text-neutral-500">
                  <th className="w-6 pb-1 text-left font-normal">#</th>
                  <th className="pb-1 text-left font-normal">Name</th>
                  <th className="w-28 pb-1 text-right font-normal">Price</th>
                  <th className="w-20 pb-1 text-right font-normal">Odds ×</th>
                  <th className="w-20 pb-1 text-right font-normal">Rarity ×</th>
                  <th className="w-20 pb-1 text-right font-normal">Value ×</th>
                  <th className="w-8 pb-1" />
                </tr>
              </thead>
              <tbody>
                {rows.map((_, i) => (
                  <tr key={i}>
                    <td className="py-0.5 text-xs tabular-nums text-neutral-500">{i + 1}</td>
                    <td className="py-0.5 pr-2">{cell(i, "name", "name", "text")}</td>
                    <td className="py-0.5 pl-2">{cell(i, "price", "price", "numeric")}</td>
                    <td className="py-0.5 pl-2">{cell(i, "odds", "odds multiplier", "decimal")}</td>
                    <td className="py-0.5 pl-2">{cell(i, "rarity", "rarity multiplier", "decimal")}</td>
                    <td className="py-0.5 pl-2">{cell(i, "value", "value multiplier", "decimal")}</td>
                    <td className="py-0.5 pl-2 text-right">
                      <button
                        type="button"
                        onClick={() => remove(i)}
                        disabled={disabled}
                        aria-label={`Remove reel ${i + 1}`}
                        className="rounded px-1.5 text-neutral-500 transition hover:text-red-400 disabled:opacity-40"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-xs text-neutral-500">
            {`Viewers buy reels in this order with $${command} fish buy reel; $${command} fish buy shows the next one and its price first. Prices are in ${currency}. Odds × multiplies how often casts and traps land a fish, Rarity × multiplies every fish except the commonest, and Value × multiplies what fish sell for (junk is unaffected). 1 means no change. Removing a reel from the end takes it away from anyone who bought it.`}
          </p>
          <button
            type="button"
            onClick={add}
            disabled={disabled || rows.length >= 10}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
          >
            Add reel
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * Per-item odds and sell prices, folded away by default so the Fishing section
 * stays as short as it was for anyone who doesn't need it.
 */
function CatchTable({ rows, currency, disabled, onChange }: {
  rows: CatchRow[];
  currency: string;
  disabled: boolean;
  onChange: (rows: CatchRow[]) => void;
}) {
  const changed = rows.filter((r) => Number(r.weight) !== r.defaultWeight || Number(r.price) !== r.defaultPrice).length;
  const edit = (name: string, key: "weight" | "price", value: string) =>
    onChange(rows.map((r) => (r.name === name ? { ...r, [key]: value } : r)));
  const reset = () =>
    onChange(rows.map((r) => ({ ...r, weight: String(r.defaultWeight), price: String(r.defaultPrice) })));

  const table = (type: "fish" | "junk") => {
    const ofType = rows.filter((r) => r.type === type);
    const total = ofType.reduce((sum, r) => sum + (Number(r.weight) > 0 ? Number(r.weight) : 0), 0);
    return (
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-neutral-500">
            <th className="pb-1 text-left font-normal">{type === "fish" ? "Fish" : "Junk"}</th>
            <th className="w-20 pb-1 text-right font-normal">Odds</th>
            <th className="w-16 pb-1 text-right font-normal">Chance</th>
            <th className="w-28 pb-1 text-right font-normal">Sells for</th>
          </tr>
        </thead>
        <tbody>
          {ofType.map((r) => {
            const w = Number(r.weight);
            const share = total > 0 ? (w / total) * 100 : 0;
            const chance = !(w > 0) || total === 0 ? "never" : `${share.toFixed(share < 1 ? 2 : share < 10 ? 1 : 0)}%`;
            return (
              <tr key={r.name}>
                <td className="py-0.5 text-lg leading-none">{r.name}</td>
                <td className="py-0.5 pl-2">
                  <input
                    aria-label={`${r.name} odds`}
                    inputMode="decimal"
                    value={r.weight}
                    disabled={disabled}
                    onChange={(e) => edit(r.name, "weight", e.target.value)}
                    className={CELL_INPUT}
                  />
                </td>
                <td className="py-0.5 text-right text-xs tabular-nums text-neutral-500">{chance}</td>
                <td className="py-0.5 pl-2">
                  <input
                    aria-label={`${r.name} sell price`}
                    inputMode="numeric"
                    value={r.price}
                    disabled={disabled}
                    onChange={(e) => edit(r.name, "price", e.target.value)}
                    className={CELL_INPUT}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  };

  return (
    <details className="mt-3 rounded-lg border border-neutral-800">
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-neutral-300">
        Odds and prices per catch
        <span className="ml-2 text-xs text-neutral-500">{changed > 0 ? `${changed} changed` : "defaults"}</span>
      </summary>
      <div className="border-t border-neutral-800 p-3">
        <div className="grid items-start gap-6 lg:grid-cols-2">
          {table("fish")}
          {table("junk")}
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-xs text-neutral-500">
            {`Lower odds make an item rarer: 0.5 is half as likely as 1, and 0 is never caught. Chance is that item's share of fish (or junk) catches; how often a cast lands anything at all is the catch odds above. Prices are in ${currency}, and a fish's length and a record still scale its price.`}
          </p>
          <button
            type="button"
            onClick={reset}
            disabled={disabled || changed === 0}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-40"
          >
            Reset to defaults
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * The fishing overlay's browser-source links. Shown whatever the chat setting:
 * a channel can keep replies in chat and show the overlay too.
 */
function FishOverlayLinks({ links }: { links: OverlayLink[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!links.length) return null;
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
    } catch {
      // clipboard blocked; the link is selectable
    }
  };
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/40 p-3">
      <p className="text-sm text-neutral-200">Fishing overlay</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        Add one as a Browser Source in OBS. It shows fishing on stream whether or not replies also go to chat. Keep the links
        private: anyone with one can show this channel&apos;s fishing. Add &amp;demo=1 to preview a burst.
      </p>
      <div className="mt-3 space-y-3">
        {links.map((l) => (
          <div key={l.url}>
            <p className="text-xs font-medium text-neutral-300">{l.label}</p>
            <p className="text-xs text-neutral-500">{l.hint}</p>
            <div className="mt-1 flex items-center gap-2">
              <input
                readOnly
                value={l.url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-300"
              />
              <button
                type="button"
                onClick={() => void copy(l.url)}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
              >
                {copied === l.url ? <Check className="h-3.5 w-3.5 text-[#53FC18]" /> : <Copy className="h-3.5 w-3.5" />}
                {copied === l.url ? "Copied" : "Copy"}
              </button>
              <a
                href={`${l.url}&demo=1`}
                target="_blank"
                rel="noreferrer"
                title="Open a preview"
                className="inline-flex shrink-0 items-center rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PointsCard({
  channel, canAdminister, points, fishOverlays, onSaved,
}: {
  channel: string;
  /** Owner/admin edit the settings; managers see them read-only but can still adjust balances. */
  canAdminister: boolean;
  /** null when the bot service is older than the points system. */
  points: PointsConfig | null;
  /** The fishing overlay's browser-source links, one per look. */
  fishOverlays: OverlayLink[];
  /** Receives the updated channel after a settings save, so the rest of the page stays current. */
  onSaved: (bot: { points?: PointsConfig | null }) => void;
}) {
  const [saved, setSaved] = useState<PointsConfig | null>(points);
  const [form, setForm] = useState<SettingsForm | null>(points ? formFromConfig(points) : null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [summary, setSummary] = useState<PointsSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<PointsUserRow[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  /** Bumped to run the current search again, e.g. after a reset changes every balance. */
  const [usersRefresh, setUsersRefresh] = useState(0);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PointsUserDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  const [mode, setMode] = useState<AdjustMode>("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [adjustNotice, setAdjustNotice] = useState<string | null>(null);
  // One request id per attempted change. Retrying the same change reuses it, so a
  // save that landed but whose answer was lost is never applied a second time.
  const pendingAttempt = useRef<{ signature: string; requestId: string } | null>(null);

  const [resetOpen, setResetOpen] = useState(false);
  const [resetConfirm, setResetConfirm] = useState("");
  const [resetReason, setResetReason] = useState("");
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetNotice, setResetNotice] = useState<string | null>(null);
  // Kept across a failed attempt, like pendingAttempt, so a retry can't reset twice.
  const resetRequestId = useRef<string | null>(null);

  // A newer copy from the page (another card saved) replaces the form only when it
  // has no unsaved edits — otherwise those edits would silently disappear.
  const savedRef = useRef<PointsConfig | null>(points);
  useEffect(() => {
    const previous = savedRef.current;
    savedRef.current = points;
    setSaved(points);
    setForm((current) =>
      !current || !previous || JSON.stringify(current) === JSON.stringify(formFromConfig(previous))
        ? points
          ? formFromConfig(points)
          : null
        : current,
    );
  }, [points]);

  const loadSummary = useCallback(async () => {
    const r = await callApi<PointsSummary>(channel, "/points");
    if (r.data) {
      setSummary(r.data);
      setSummaryError(null);
    } else {
      setSummaryError(r.error ?? "Could not load points status");
    }
  }, [channel]);

  // Loaded after the page renders, like rewards, so the bot page never waits on it.
  useEffect(() => {
    if (points) void loadSummary();
  }, [points, loadSummary]);

  useEffect(() => {
    if (!points) return;
    const q = query.trim().replace(/^@+/, "").toLowerCase();
    if (q && !/^[a-z0-9_]{1,25}$/.test(q)) {
      setUsersError("Usernames are letters, digits and _");
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      const r = await callApi<{ users: PointsUserRow[] }>(
        channel,
        `/points/users?q=${encodeURIComponent(q)}&limit=20`,
      );
      if (seq !== searchSeq.current) return; // a newer search is already on its way
      if (r.data) {
        setUsers(r.data.users);
        setUsersError(null);
      } else {
        setUsersError(r.error ?? "Search failed");
      }
    }, q ? 300 : 0);
    return () => clearTimeout(timer);
  }, [channel, query, points, usersRefresh]);

  const loadDetail = useCallback(
    async (userId: number) => {
      setDetailError(null);
      const r = await callApi<PointsUserDetail>(channel, `/points/users/${userId}`);
      if (r.data) setDetail(r.data);
      else setDetailError(r.error ?? "Could not load this viewer");
    },
    [channel],
  );

  const selectUser = useCallback(
    (userId: number) => {
      if (selectedId === userId) {
        setSelectedId(null);
        setDetail(null);
        return;
      }
      setSelectedId(userId);
      setDetail(null);
      setAdjustError(null);
      setAdjustNotice(null);
      pendingAttempt.current = null;
      void loadDetail(userId);
    },
    [selectedId, loadDetail],
  );

  const saveSettings = useCallback(
    async (patch: PointsSettingsPatch, message: string, key: string, resetForm: boolean) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      const r = await callApi<{ points?: PointsConfig | null }>(channel, "/settings", {
        method: "POST",
        body: JSON.stringify({ points: patch }),
      });
      setBusy(null);
      if (!r.data) {
        setError(r.error ?? "Could not save the points settings");
        return;
      }
      const next = r.data.points ?? null;
      if (next) {
        savedRef.current = next;
        setSaved(next);
        // Toggling points on or off must not throw away edits waiting in the form.
        if (resetForm) setForm(formFromConfig(next));
      }
      onSaved(r.data);
      setNotice(message);
      void loadSummary();
    },
    [channel, onSaved, loadSummary],
  );

  const saveForm = useCallback(() => {
    if (!form) return;
    const built = buildPatch(form);
    if ("error" in built) {
      setError(built.error);
      setNotice(null);
      return;
    }
    void saveSettings(built.patch, "Points settings saved — applies within 15 seconds, no restart.", "points-save", true);
  }, [form, saveSettings]);

  const submitAdjust = useCallback(async () => {
    if (!detail) return;
    setAdjustError(null);
    setAdjustNotice(null);
    const n = Number(amount.trim());
    const min = mode === "set" ? 0 : 1;
    if (amount.trim() === "" || !Number.isInteger(n) || n < min || n > 1_000_000_000) {
      setAdjustError(mode === "set" ? "Enter a whole number, 0 or more" : "Enter a whole number, 1 or more");
      return;
    }
    const why = reason.trim();
    if (why.length < 3 || why.length > 200) {
      setAdjustError("A reason of 3–200 characters is required");
      return;
    }

    const userId = detail.user.userId;
    const signature = JSON.stringify([userId, mode, n, why]);
    if (!pendingAttempt.current || pendingAttempt.current.signature !== signature) {
      pendingAttempt.current = { signature, requestId: crypto.randomUUID() };
    }

    setBusy("adjust");
    const r = await callApi<{ ok: true; applied: boolean; user: PointsUserRow }>(channel, "/points/adjust", {
      method: "POST",
      body: JSON.stringify({ userId, mode, amount: n, reason: why, requestId: pendingAttempt.current.requestId }),
    });
    setBusy(null);
    if (!r.data) {
      // The attempt is kept: pressing Apply again retries with the same request id.
      setAdjustError(r.error ?? "Could not adjust the balance");
      return;
    }

    pendingAttempt.current = null;
    const updated = r.data.user;
    setUsers((list) => list?.map((row) => (row.userId === updated.userId ? updated : row)) ?? list);
    const currency = saved?.currencyName ?? "points";
    setAdjustNotice(
      r.data.applied
        ? `${updated.username} now has ${updated.balance.toLocaleString()} ${currency}.`
        : "That change was already applied.",
    );
    setAmount("");
    setReason("");
    void loadDetail(updated.userId);
    void loadSummary();
  }, [amount, channel, detail, loadDetail, loadSummary, mode, reason, saved]);

  const submitReset = useCallback(async () => {
    setResetError(null);
    setResetNotice(null);
    if (resetConfirm.trim().toLowerCase() !== channel) {
      setResetError(`Type ${channel} to confirm`);
      return;
    }
    const why = resetReason.trim();
    if (why.length < 3 || why.length > 200) {
      setResetError("A reason of 3–200 characters is required");
      return;
    }
    resetRequestId.current ??= crypto.randomUUID();

    setBusy("reset");
    const r = await callApi<{ applied: boolean; users: number; total: number; duelsCancelled: number; backup: string }>(
      channel,
      "/points/reset",
      {
        method: "POST",
        body: JSON.stringify({ confirm: resetConfirm.trim(), reason: why, requestId: resetRequestId.current }),
      },
    );
    setBusy(null);
    if (!r.data) {
      setResetError(r.error ?? "Could not reset the balances");
      return;
    }

    resetRequestId.current = null;
    const currency = saved?.currencyName ?? "points";
    const duels = r.data.duelsCancelled ? `, ${r.data.duelsCancelled} pending duel(s) cancelled` : "";
    setResetNotice(
      r.data.applied
        ? `Reset ${r.data.total.toLocaleString()} ${currency} across ${r.data.users.toLocaleString()} viewers${duels}. ` +
            `Backup saved as ${r.data.backup}.`
        : "That reset was already applied.",
    );
    setResetOpen(false);
    setResetConfirm("");
    setResetReason("");
    setSelectedId(null);
    setDetail(null);
    setUsersRefresh((n) => n + 1);
    void loadSummary();
  }, [channel, loadSummary, resetConfirm, resetReason, saved]);

  if (!saved || !form) {
    return (
      <Card title="Loyalty points" icon={<Coins className="h-4 w-4" />}>
        <p className="text-sm text-neutral-500">
          The bot service hasn&apos;t reported points settings. It may need updating before points can be managed here.
        </p>
      </Card>
    );
  }

  const currency = saved.currencyName;
  const readOnly = !canAdminister;
  const dirty = JSON.stringify(form) !== JSON.stringify(formFromConfig(saved));
  const commandPreview =
    form.currencyCommand.trim().replace(/^[!$]+/, "").toLowerCase() || deriveCommand(form.currencyName.trim());
  const leaderboardUrl = `${BASE_PATH}/${channel}/leaderboard`;
  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) =>
    setForm((f) => (f ? { ...f, [key]: value } : f));
  const text = (key: keyof SettingsForm, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...extra}
      value={form[key] as string}
      disabled={readOnly || !!busy}
      onChange={(e) => set(key, e.target.value as never)}
      className={INPUT}
    />
  );
  const subscriptions = Object.entries(summary?.subscriptions ?? {}).sort(([a], [b]) => a.localeCompare(b));

  return (
    <Card
      title={`Loyalty points · ${currency}`}
      icon={<Coins className="h-4 w-4" />}
      actions={
        saved.enabled && saved.publicLeaderboard ? (
          <a
            href={leaderboardUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-neutral-400 transition hover:text-[#53FC18]"
          >
            Public leaderboard <ExternalLink className="h-3.5 w-3.5" />
          </a>
        ) : null
      }
    >
      <div className="space-y-6">
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        {notice ? <p className="text-sm text-[#53FC18]">{notice}</p> : null}

        <Toggle
          label={`${currency} loyalty points`}
          description={
            `Viewers who chatted recently earn ${currency} while the stream is live, plus bonuses for follows, subs and Kicks. ` +
            `Chat command: $${saved.effectiveCommand}.` +
            (readOnly ? " Only the broadcaster can change this." : "")
          }
          checked={saved.enabled}
          disabled={!!busy || readOnly}
          onChange={() =>
            void saveSettings(
              { enabled: !saved.enabled },
              `Loyalty points ${saved.enabled ? "disabled" : "enabled"} — applies within 15 seconds, no restart.`,
              "points-enabled",
              false,
            )
          }
        />

        {/* ------------------------------------------------------------ status */}
        <div>
          <h3 className={SECTION}>Status</h3>
          {summaryError ? (
            <p className="text-sm text-red-400">{summaryError}</p>
          ) : !summary ? (
            <p className="flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Database"
                  value={summary.dbAvailable ? "OK" : "Unavailable"}
                  tone={summary.dbAvailable ? "default" : "warn"}
                />
                <Stat label="Viewers" value={summary.users.toLocaleString()} />
                <Stat label={`Total ${currency}`} value={summary.totalPoints.toLocaleString()} />
                <Stat
                  label="Last payout"
                  value={
                    summary.lastTickAt
                      ? `${formatDate(summary.lastTickAt)} · ${(summary.lastTickUsers ?? 0).toLocaleString()} viewers`
                      : "—"
                  }
                />
              </dl>
              {subscriptions.length === 0 ? (
                <p className="mt-3 text-xs text-neutral-500">
                  Event subscriptions haven&apos;t been reported yet. They are set up when the bot service restarts.
                </p>
              ) : (
                <ul className="mt-3 flex flex-wrap gap-2">
                  {subscriptions.map(([event, s]) => (
                    <li
                      key={event}
                      title={s.ok ? `Subscribed ${formatDate(s.at)}` : s.error ?? "Subscription failed"}
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        s.ok
                          ? "border-neutral-700 bg-neutral-900 text-neutral-400"
                          : "border-red-900 bg-red-950/40 text-red-400"
                      }`}
                    >
                      {s.ok ? "✓" : "✕"} {event}
                      {s.ok ? "" : `: ${s.error ?? "failed"}`}
                    </li>
                  ))}
                </ul>
              )}
              {summary.gamble && (saved.gamble?.enabled || summary.gamble.allTime.gambles > 0) ? (
                <p className="mt-3 text-xs text-neutral-500">
                  Gamble, whole channel: {gambleStatsText(summary.gamble.allTime, currency)} all time
                  {summary.gamble.thisStream
                    ? ` · ${gambleStatsText(summary.gamble.thisStream, currency)} this stream`
                    : ""}
                  {saved.gamble ? ` · set to ${saved.gamble.winChancePercent}% win chance` : ""}.
                </p>
              ) : null}
              {summary.duel && (saved.duel?.enabled || summary.duel.allTime.duels > 0 || summary.duel.allTime.pending > 0) ? (
                <p className="mt-1 text-xs text-neutral-500">
                  Duels: {duelStatsText(summary.duel.allTime, currency)} all time
                  {summary.duel.thisStream ? ` · ${duelStatsText(summary.duel.thisStream, currency)} this stream` : ""}.
                </p>
              ) : null}
            </>
          )}
        </div>

        {/* ---------------------------------------------------------- settings */}
        <div>
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-400 transition hover:text-neutral-200"
          >
            Settings
            <ChevronDown className={`h-3.5 w-3.5 transition ${settingsOpen ? "rotate-180" : ""}`} />
          </button>

          {settingsOpen ? (
            <div className="mt-3 space-y-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              {readOnly ? <p className="text-xs text-amber-500">Only the broadcaster can change these.</p> : null}

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Currency name" hint={`Chat command: $${commandPreview || "…"}`}>
                  {text("currencyName", { maxLength: 24, placeholder: "$DON" })}
                </Field>
                <Field label="Command override" hint="Leave empty to use the currency name.">
                  {text("currencyCommand", { maxLength: 21, placeholder: deriveCommand(form.currencyName) || "don" })}
                </Field>
              </div>

              <div>
                <h4 className={LABEL}>Earning</h4>
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Per interval">{text("pointsPerInterval", { inputMode: "numeric" })}</Field>
                  <Field label="Interval (min)">{text("intervalMinutes", { inputMode: "numeric" })}</Field>
                  <Field label="Active window (min)">{text("activeWindowMinutes", { inputMode: "numeric" })}</Field>
                  <Field label="Sub multiplier">{text("subscriberMultiplier", { inputMode: "decimal" })}</Field>
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Every interval while live, each viewer who chatted within the active window earns the amount above.
                  Kick has no viewer list, so chatting is how a viewer is seen.
                </p>
                <div className="mt-3">
                  <Checkbox
                    label="Don't pay the broadcaster"
                    checked={form.excludeBroadcaster}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("excludeBroadcaster", v)}
                  />
                </div>
              </div>

              <Field label="Ignored viewers" hint="Usernames separated by commas or spaces. They never earn and never show on leaderboards.">
                <textarea
                  value={form.ignoreUsers}
                  disabled={readOnly || !!busy}
                  onChange={(e) => set("ignoreUsers", e.target.value)}
                  rows={2}
                  className={INPUT}
                />
              </Field>

              <div>
                <h4 className={LABEL}>Bonuses (0 turns one off)</h4>
                <div className="grid gap-4 sm:grid-cols-3">
                  <Field label="Follow (once)">{text("follow", { inputMode: "numeric" })}</Field>
                  <Field label="New sub">{text("subNew", { inputMode: "numeric" })}</Field>
                  <Field label="Resub">{text("subRenewal", { inputMode: "numeric" })}</Field>
                  <Field label="Gifter, per sub">{text("giftSubGifterPerSub", { inputMode: "numeric" })}</Field>
                  <Field label="Gift recipient">{text("giftSubRecipient", { inputMode: "numeric" })}</Field>
                  <Field label="Per Kick">{text("pointsPerKick", { inputMode: "decimal" })}</Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only give bonuses while live"
                    checked={form.onlyWhileLive}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("onlyWhileLive", v)}
                  />
                  <Checkbox
                    label="Thank viewers in chat for bonuses"
                    checked={form.announce}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("announce", v)}
                  />
                </div>
              </div>

              <div>
                <h4 className={LABEL}>Giving between viewers</h4>
                <Checkbox
                  label={`Let viewers give ${form.currencyName.trim() || "points"} to each other`}
                  checked={form.giveEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("giveEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label="Minimum">{text("giveMin", { inputMode: "numeric" })}</Field>
                  <Field label="Maximum (0 = none)">{text("giveMax", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown (s)">{text("giveCooldown", { inputMode: "numeric" })}</Field>
                </div>
              </div>

              <div>
                <h4 className={LABEL}>Gamble</h4>
                <Checkbox
                  label={`Let viewers gamble ${form.currencyName.trim() || "points"} with $${commandPreview || "…"} gamble`}
                  checked={form.gambleEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("gambleEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Win chance (%)">{text("gambleChance", { inputMode: "decimal" })}</Field>
                  <Field label="Minimum bet">{text("gambleMin", { inputMode: "numeric" })}</Field>
                  <Field label="Maximum bet (0 = none)">{text("gambleMax", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown per viewer (s)">{text("gambleCooldown", { inputMode: "numeric" })}</Field>
                </div>
                <p className="mt-2 text-xs text-neutral-500">{gambleExplain(form.gambleChance)}</p>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only while the stream is live"
                    checked={form.gambleLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("gambleLiveOnly", v)}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Even money: a win adds the bet, a loss takes it. Viewers can bet a number, 5k, 50% or all.
                  The bot stays quiet when gambling is off, on cooldown or offline, and replies to wins, losses and mistakes.
                </p>
              </div>

              <div>
                <h4 className={LABEL}>Duels</h4>
                <Checkbox
                  label={`Let viewers duel each other for ${form.currencyName.trim() || "points"}`}
                  checked={form.duelEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("duelEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Minimum">{text("duelMin", { inputMode: "numeric" })}</Field>
                  <Field label="Maximum (0 = none)">{text("duelMax", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown per challenger (s)">{text("duelCooldown", { inputMode: "numeric" })}</Field>
                  <Field label="Time to answer (s)" hint="30–600">{text("duelExpiry", { inputMode: "numeric" })}</Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only while the stream is live"
                    checked={form.duelLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("duelLiveOnly", v)}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {`$${commandPreview || "…"} duel @viewer 100 challenges someone; they answer with $${commandPreview || "…"} accept or deny. `}
                  Always 50/50 and the winner takes both stakes. The challenger&apos;s stake is held until then and refunded
                  if the duel is declined, cancelled or not answered in time. Cooldown, offline and duels-off stay silent.
                </p>
              </div>

              <div>
                <h4 className={LABEL}>Raffles</h4>
                <Checkbox
                  label={`Let moderators raffle ${form.currencyName.trim() || "points"} to chat`}
                  checked={form.raffleEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("raffleEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Minimum prize">{text("raffleMinPrize", { inputMode: "numeric" })}</Field>
                  <Field label="Maximum prize (0 = none)">{text("raffleMaxPrize", { inputMode: "numeric" })}</Field>
                  <Field label="Raffles per stream (0 = no limit)">{text("rafflePerStream", { inputMode: "numeric" })}</Field>
                  <Field label="Winners" hint="shared by $raffle">{text("raffleWinners", { inputMode: "numeric" })}</Field>
                </div>
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Default length (s)" hint="10–3600">{text("raffleDefaultSeconds", { inputMode: "numeric" })}</Field>
                  <Field label="Longest raffle (s)" hint="10–3600">{text("raffleMaxSeconds", { inputMode: "numeric" })}</Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only while the stream is live"
                    checked={form.raffleLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("raffleLiveOnly", v)}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {`$${commandPreview || "…"} raffle 5000 120 opens a raffle a moderator sets the size of; viewers enter free with $${commandPreview || "…"} join, one entry each. `}
                  {`$${commandPreview || "…"} sraffle gives the whole prize to one winner instead of sharing it, and $${commandPreview || "…"} raffle cancel closes one without paying. `}
                  The prize is created rather than taken from anyone, so only moderators and above can open one and the caps
                  above bound what a single raffle, and one stream, can add. Entries are silent; the winners and the entry
                  count are announced when it draws.
                </p>
              </div>

              <div>
                <h4 className={LABEL}>Fishing</h4>
                <Checkbox
                  label={`Turn on fishing for ${form.currencyName.trim() || "points"}`}
                  checked={form.gamesEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("gamesEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Catch odds (1 in …)" hint="supibot: 20">{text("fishOdds", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown after a catch (min)" hint="supibot: 30">{text("fishCatchCooldown", { inputMode: "numeric" })}</Field>
                  <Field label="Trap time (min)" hint="31–1440, supibot: 60">{text("fishTrapMinutes", { inputMode: "numeric" })}</Field>
                </div>
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  {form.fishCatches.length === 0 ? (
                    <Field label="Sell prices (%)" hint="100 = fish 50, junk 1–20">{text("fishSellPct", { inputMode: "numeric" })}</Field>
                  ) : null}
                  <Field label="Bait prices (%)" hint="100 = worm 2, fly 5, cricket 8">{text("fishBaitPct", { inputMode: "numeric" })}</Field>
                </div>
                {form.fishReels ? (
                  <ReelTable
                    rows={form.fishReels}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(rows) => set("fishReels", rows)}
                  />
                ) : null}
                {form.fishSteal ? (
                  <StealSettings
                    value={form.fishSteal}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishSteal", v)}
                  />
                ) : null}
                {form.fishCatches.length > 0 ? (
                  <CatchTable
                    rows={form.fishCatches}
                    currency={form.currencyName.trim() || "points"}
                    disabled={readOnly || !!busy}
                    onChange={(rows) => set("fishCatches", rows)}
                  />
                ) : null}
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only fish and lay traps while the stream is live"
                    checked={form.gamesLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("gamesLiveOnly", v)}
                  />
                  <Checkbox
                    label="AI story on 1 in 3 catches"
                    checked={form.fishStories}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishStories", v)}
                  />
                  <Checkbox
                    label="Post cast results and trap hauls in chat"
                    checked={form.fishChatReplies}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishChatReplies", v)}
                  />
                  {!form.fishChatReplies ? (
                    <p className="pl-6 text-xs text-amber-300/80">
                      Cast results and trap hauls only show on the fishing overlay, so make sure it&apos;s on stream. Every other fishing reply still goes to chat.
                    </p>
                  ) : null}
                </div>
                <div className="mt-4">
                  <FishOverlayLinks links={fishOverlays} />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  {`supibot's fishing game, played as $${commandPreview || "…"} fish like every command that uses ${form.currencyName.trim() || "points"}: cast (with worm, fly or cricket bait), then sell, show, stats, top and trap. `}
                  Catches are kept until sold; selling pays {form.currencyName.trim() || "points"}, bait costs it. A fish's price scales with its length (half at 1 cm, double at 100 cm), plus 50% for beating a record. A miss waits 30–90 seconds and
                  snags junk 1 time in 4. Laying traps pings the viewer in chat when they&apos;re full, if !remind is on. With this off fishing isn&apos;t available. !cookie and !slots don&apos;t use points and are
                  switched on under Commands.
                </p>
              </div>

              <div>
                <h4 className={LABEL}>Timeout penalty</h4>
                <Checkbox
                  label={`Deduct ${form.currencyName.trim() || "points"} when a viewer is timed out`}
                  checked={form.penaltyEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("penaltyEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field
                    label="Cost per second"
                    hint={costExample(form.penaltyPerSecond, form.penaltyMax, form.currencyName)}
                  >
                    {text("penaltyPerSecond", { inputMode: "decimal" })}
                  </Field>
                  <Field label="Maximum per timeout (0 = none)">
                    {text("penaltyMax", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Permanent ban (0 = ignore)" hint="A ban has no length to charge for.">
                    {text("penaltyPermanentBan", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Say in chat what was deducted"
                    checked={form.penaltyAnnounce}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("penaltyAnnounce", v)}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Every timeout counts, whether a moderator, the streamer or a reward gave it.
                  A viewer never goes below zero — someone with less than the penalty loses what
                  they have. Anyone excluded from earning is excluded from being charged.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max per mod adjustment" hint="The most a mod can add, remove or set in one chat command.">
                  {text("modMaxAdjust", { inputMode: "numeric" })}
                </Field>
                <div className="flex items-center pt-5">
                  <Checkbox
                    label="Public leaderboard page"
                    checked={form.publicLeaderboard}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("publicLeaderboard", v)}
                  />
                </div>
              </div>

              {readOnly ? null : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" onClick={saveForm} busy={busy === "points-save"} disabled={!!busy || !dirty}>
                    Save settings
                  </Button>
                  <Button
                    onClick={() => {
                      setForm(formFromConfig(saved));
                      setError(null);
                    }}
                    disabled={!!busy || !dirty}
                  >
                    Reset
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* ----------------------------------------------------------- viewers */}
        <div>
          <h3 className={SECTION}>Viewers</h3>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-600" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by username"
              maxLength={26}
              className={`${INPUT} pl-9`}
            />
          </div>
          {usersError ? <p className="mt-2 text-sm text-red-400">{usersError}</p> : null}

          {users === null && !usersError ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          ) : users && users.length === 0 ? (
            <p className="mt-3 text-sm text-neutral-500">
              {query.trim() ? "No viewers match." : `Nobody has earned ${currency} yet.`}
            </p>
          ) : users ? (
            <ul className="mt-3 divide-y divide-neutral-800">
              {users.map((u) => (
                <li key={u.userId}>
                  <button
                    type="button"
                    onClick={() => selectUser(u.userId)}
                    className={`flex w-full items-center justify-between gap-3 py-2 text-left text-sm transition ${
                      selectedId === u.userId ? "text-[#53FC18]" : "text-neutral-200 hover:text-white"
                    }`}
                  >
                    <span className="truncate">
                      <span className="mr-2 tabular-nums text-neutral-600">#{u.rank}</span>
                      {u.username}
                    </span>
                    <span className="shrink-0 tabular-nums text-neutral-400">
                      {u.balance.toLocaleString()} {currency} · {formatWatch(u.watchSeconds)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {selectedId !== null ? (
            <div className="mt-4 space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              {detailError ? (
                <p className="text-sm text-red-400">{detailError}</p>
              ) : !detail ? (
                <p className="flex items-center gap-2 text-sm text-neutral-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-medium text-neutral-100">{detail.user.username}</span>
                    <span className="text-xs text-neutral-500">
                      {detail.user.isSub ? "Subscriber · " : ""}first seen {formatDate(detail.user.firstSeenAt)}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Balance" value={`${detail.user.balance.toLocaleString()} · #${detail.user.rank}`} />
                    <Stat label="Active time" value={formatWatch(detail.user.watchSeconds)} />
                    <Stat label="Lifetime earned" value={detail.user.lifetimeEarned.toLocaleString()} />
                    <Stat label="Last seen" value={formatDate(detail.user.lastSeenAt)} />
                  </dl>
                  {detail.gamble && detail.gamble.gambles > 0 ? (
                    <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                      <Stat label="Gambles" value={detail.gamble.gambles.toLocaleString()} />
                      <Stat label="Win rate" value={`${((detail.gamble.wins / detail.gamble.gambles) * 100).toFixed(1)}% · ${detail.gamble.wins.toLocaleString()} won`} />
                      <Stat label="Staked" value={detail.gamble.staked.toLocaleString()} />
                      <Stat label="Gamble net" value={`${detail.gamble.net > 0 ? "+" : ""}${detail.gamble.net.toLocaleString()}`} />
                    </dl>
                  ) : null}

                  <div className="space-y-3 border-t border-neutral-800 pt-4">
                    <h4 className={LABEL}>Adjust balance</h4>
                    {readOnly ? (
                      <p className="text-sm text-neutral-500">Only the broadcaster can adjust balances.</p>
                    ) : (
                    <>
                    <div className="flex flex-wrap gap-2">
                      {(["add", "remove", "set"] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setMode(m)}
                          disabled={!!busy}
                          className={`rounded-lg border px-3 py-1.5 text-sm capitalize transition disabled:opacity-40 ${
                            mode === m
                              ? "border-[#53FC18]/40 bg-[#53FC18]/10 text-[#53FC18]"
                              : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                          }`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
                      <input
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        inputMode="numeric"
                        placeholder="Amount"
                        disabled={!!busy}
                        className={INPUT}
                      />
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        maxLength={200}
                        placeholder="Reason (required, shown in the history)"
                        disabled={!!busy}
                        className={INPUT}
                      />
                    </div>
                    {adjustError ? <p className="text-sm text-red-400">{adjustError}</p> : null}
                    {adjustNotice ? <p className="text-sm text-[#53FC18]">{adjustNotice}</p> : null}
                    <Button variant="primary" onClick={() => void submitAdjust()} busy={busy === "adjust"} disabled={!!busy}>
                      Apply
                    </Button>
                    </>
                    )}
                  </div>

                  <div className="border-t border-neutral-800 pt-4">
                    <h4 className={LABEL}>History</h4>
                    {detail.ledger.length === 0 ? (
                      <p className="text-sm text-neutral-500">No changes besides active-time earnings yet.</p>
                    ) : (
                      <ul className="divide-y divide-neutral-800">
                        {detail.ledger.map((entry) => (
                          <li key={entry.id} className="flex flex-col gap-1 py-2 text-sm sm:flex-row sm:items-start sm:gap-4">
                            <span className="w-40 shrink-0 text-xs text-neutral-500">{formatDate(entry.ts)}</span>
                            <span
                              className={`w-24 shrink-0 tabular-nums ${
                                entry.delta >= 0 ? "text-[#53FC18]" : "text-red-400"
                              }`}
                            >
                              {entry.delta >= 0 ? "+" : ""}
                              {entry.delta.toLocaleString()}
                            </span>
                            <span className="min-w-0 flex-1 text-neutral-300">
                              {REASON_LABEL[entry.reason] ?? entry.reason}
                              {entry.counterparty && COUNTERPARTY_PREFIX[entry.reason] ? (
                                <span className="text-neutral-400">
                                  {` ${COUNTERPARTY_PREFIX[entry.reason]} `}
                                  <span className="text-neutral-200">{entry.counterparty}</span>
                                </span>
                              ) : null}
                              {entry.note ? <span className="text-neutral-500"> — {entry.note}</span> : null}
                              {entry.actor ? <span className="block text-xs text-neutral-600">{entry.actor}</span> : null}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-neutral-500">
                              = {entry.balanceAfter.toLocaleString()}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}
        </div>

        {canAdminister ? (
          <div className="border-t border-neutral-800 pt-6">
            <h3 className={SECTION}>Danger zone</h3>
            {resetNotice ? <p className="mb-3 text-sm text-[#53FC18]">{resetNotice}</p> : null}
            {!resetOpen ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-neutral-500">
                  Set every viewer&apos;s {currency} to 0. Active time and history are kept.
                </p>
                <Button
                  variant="danger"
                  onClick={() => {
                    setResetOpen(true);
                    setResetError(null);
                    setResetNotice(null);
                  }}
                  disabled={!!busy}
                >
                  Reset all balances…
                </Button>
              </div>
            ) : (
              <div className="space-y-3 rounded-lg border border-red-900 bg-red-950/20 p-4">
                <p className="text-sm text-neutral-300">
                  This sets all{summary ? ` ${summary.totalPoints.toLocaleString()}` : ""} {currency}
                  {summary ? ` held by ${summary.users.toLocaleString()} viewers` : ""} to 0 and cancels pending duels
                  without refunds. The bot saves a backup of the database first, so it can be undone by restoring it.
                </p>
                <Field label={`Type ${channel} to confirm`}>
                  <input
                    value={resetConfirm}
                    onChange={(e) => setResetConfirm(e.target.value)}
                    placeholder={channel}
                    autoComplete="off"
                    disabled={!!busy}
                    className={INPUT}
                  />
                </Field>
                <Field label="Reason">
                  <input
                    value={resetReason}
                    onChange={(e) => setResetReason(e.target.value)}
                    maxLength={200}
                    placeholder="Required, shown in every viewer's history"
                    disabled={!!busy}
                    className={INPUT}
                  />
                </Field>
                {resetError ? <p className="text-sm text-red-400">{resetError}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="danger"
                    onClick={() => void submitReset()}
                    busy={busy === "reset"}
                    disabled={!!busy || resetConfirm.trim().toLowerCase() !== channel}
                  >
                    Reset all balances to 0
                  </Button>
                  <Button
                    onClick={() => {
                      setResetOpen(false);
                      setResetError(null);
                    }}
                    disabled={!!busy}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Card>
  );
}
