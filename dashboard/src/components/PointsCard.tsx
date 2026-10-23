"use client";

import { COUNTERPARTY_PREFIX, REASON_LABEL } from "@/lib/points-labels";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Coins, Copy, ExternalLink, Fish, Gamepad2, Layers, Loader2, Search } from "lucide-react";
import type { OverlayLink } from "@/lib/fish-overlay";
import { FISHING_TABS, type FishingTab } from "@/lib/bot-sections";
import FishOverlayStatus from "./FishOverlayStatus";
import { Button, Card, Checkbox, Stat, Toggle } from "./ui";
import MediaShareSetup from "./MediaShareSetup";

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

/** `$<cmd> wordle`: one Wordle for the whole chat. */
export interface PointsWordle {
  enabled: boolean;
  prize: number;
  maxGuesses: number;
  guessCooldownSeconds: number;
}

/** `$<cmd> video <youtube link>`: paid videos on the video overlay. */
export interface PointsVideo {
  enabled: boolean;
  pricePerSecond: number;
  maxSeconds: number;
  queueMax: number;
  onlyWhileLive: boolean;
  volumePercent?: number;
  /** The video overlay plays the channel's StreamElements media share. */
  mediashare?: boolean;
  mediashareDelaySeconds?: number;
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

/** What spamming a keyword costs: each keyword message past `threshold` inside `windowMinutes` costs `cost`. */
export interface PointsAntiSpam {
  enabled: boolean;
  /** Lowercase words or phrases, matched whole; an emote's name works too. */
  keywords: string[];
  threshold: number;
  windowMinutes: number;
  cost: number;
  /** A viewer who can't cover the cost is timed out this long; 0 only takes what they have. Absent from an older bot service. */
  timeoutMinutes?: number;
  announce: boolean;
}

const ANTI_SPAM_DEFAULTS: PointsAntiSpam = { enabled: false, keywords: [], threshold: 3, windowMinutes: 10, cost: 10, timeoutMinutes: 1, announce: true };

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
  /** Absent from a bot service older than video sharing. */
  video?: PointsVideo;
  /** Absent from a bot service older than Wordle. */
  wordle?: PointsWordle;
  modMaxAdjust: number;
  publicLeaderboard: boolean;
  timeoutPenalty: PointsTimeoutPenalty;
  /** Absent from a bot service older than anti-spam. */
  antiSpam?: PointsAntiSpam;
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
  /** The reverse: only while offline. Never on together with onlyWhileLive. Absent from an older bot service. */
  onlyWhileOffline?: boolean;
  /** 1 in this many unbaited casts lands a fish. */
  catchOdds: number;
  catchCooldownMinutes: number;
  trapMinutes: number;
  /** The longest trap a chatter can name ($cmd fish trap 2h); never below trapMinutes. Absent from an older bot service. */
  trapMaxMinutes?: number;
  /** Sell prices as a percentage of supibot's (fish 50, junk 1–20). */
  sellPricePercent: number;
  /** Bait prices as a percentage of supibot's (worm 2, fly 5, cricket 8). */
  baitPricePercent: number;
  /** A short AI story on 1 in 3 catches. */
  stories: boolean;
  /** `fish give` on, and seconds between a viewer's gives. Absent from an older bot service. */
  giveEnabled?: boolean;
  giveCooldownSeconds?: number;
  /** The most fish and junk one viewer holds, 0 for no cap. Absent from an older bot service. */
  maxFish?: number;
  maxJunk?: number;
  /** fish feed on, and the chance (%) a feeding fails. Absent from an older bot service. */
  feedEnabled?: boolean;
  feedFailPercent?: number;
  /** Fishing replies go to chat. They always go to the fishing overlay; off, chat only gets them offline or with no overlay showing. Absent from an older bot service. */
  chatReplies?: boolean;
  /** The fishing overlay's &demo=1 may play; off, overlays ignore it. Absent from an older bot service. */
  overlayDemo?: boolean;
  /** How big the fishing overlay draws, as a percentage (50–300). Absent from an older bot service. */
  overlaySizePercent?: number;
  /** The bottom-right corner the fishing overlay keeps clear (0–80 each; both above 0 to apply). Absent from an older bot service. */
  overlayClearWidthPercent?: number;
  overlayClearHeightPercent?: number;
  /** How far the stream runs behind chat, in seconds (0–30). Absent from an older bot service. */
  streamDelaySeconds?: number;
  /** Every fish and junk item's odds and price. Absent from a bot service older than per-item settings. */
  catches?: FishCatch[];
  /** The channel's own fish. Absent from a bot service older than them. */
  customFish?: CustomFish[];
  /** Reels in buying order. Absent from a bot service older than reels. */
  reels?: FishReel[];
  /** `fish steal`. Absent from a bot service older than stealing. */
  steal?: FishSteal;
  /** `fish duel`. Absent from a bot service older than duels. */
  duel?: FishDuelSettings;
  trade?: FishTradeSettings;
  /** Big bites. Absent from a bot service older than them. */
  bigBite?: FishBigBite;
  /** Trap and cast checks. Absent from a bot service older than them. */
  trapCheck?: FishTrapCheck;
}

/**
 * Trap and cast checks, against macros: while offline, collecting full traps (and a share
 * of casts) asks a question first; tries and time run out into a fine. Mirrors the bot's
 * FishTrapCheckSetting.
 */
export interface FishTrapCheck {
  enabled: boolean;
  chancePercent: number;
  finePercent: number;
  answerSeconds: number;
  tries: number;
  /** Absent from a bot service older than cast checks. */
  castChancePercent?: number;
}

/** `fish duel`: two viewers each send a fish and the bot plays the fight out. Mirrors the bot's FishDuelSetting. */
export interface FishDuelSettings {
  enabled: boolean;
  onlyWhileLive: boolean;
  allowKeeps: boolean;
  expirySeconds: number;
  cooldownSeconds: number;
  maxWager: number;
}

type DuelNumber = "expirySeconds" | "cooldownSeconds" | "maxWager";

/** `fish trade`: fish and/or currency for another viewer's, a burned fee on the proposer. Mirrors the bot's FishTradeSetting. */
export interface FishTradeSettings {
  enabled: boolean;
  feePercent: number;
  feeMinimum: number;
  expirySeconds: number;
}
type TradeNumber = "feePercent" | "feeMinimum" | "expirySeconds";
const TRADE_FIELDS: Array<{ key: TradeNumber; label: string; hint: string; min: number; max: number; decimal?: boolean }> = [
  { key: "feePercent", label: "Fee (% of the trade)", hint: "fish at sell value plus currency, both sides; default 3", min: 0, max: 50, decimal: true },
  { key: "feeMinimum", label: "Smallest fee", hint: "default 10", min: 0, max: 1_000_000_000 },
  { key: "expirySeconds", label: "Seconds to answer", hint: "default 120", min: 30, max: 600 },
];

/** The duel settings' inputs, in the order shown, with the bot's bounds and defaults. */
const DUEL_FIELDS: Array<{ key: DuelNumber; label: string; hint: string; min: number; max: number }> = [
  { key: "maxWager", label: "Biggest wager", hint: "0 for no limit", min: 0, max: 1_000_000_000 },
  { key: "expirySeconds", label: "Seconds to answer", hint: "default 120", min: 30, max: 600 },
  { key: "cooldownSeconds", label: "Seconds between challenges", hint: "per viewer, default 60", min: 0, max: 3600 },
];

/** `fish steal`: a hook to try, rarity odds, a burned fine when caught, and guards. Mirrors the bot's FishStealSetting. */
export interface FishSteal {
  enabled: boolean;
  /** Stealing only while live, whatever the fishing live/offline rule says. Absent from a bot service older than it. */
  onlyWhileLive?: boolean;
  hookPrice: number;
  hookUses: number;
  feePercent: number;
  feeMinimum: number;
  edgePercent: number;
  fineMinimum: number;
  oddsCommon: number;
  oddsUncommon: number;
  oddsRare: number;
  oddsEpic: number;
  oddsLegendary: number;
  luckPercent: number;
  graceMinutes: number;
  protectMinutes: number;
  guardPercent: number;
  guardMinimum: number;
  guardHours: number;
}

type StealNumber = Exclude<keyof FishSteal, "enabled" | "onlyWhileLive">;

/** The steal settings' inputs, in the order shown, with the bot's bounds and defaults. */
const STEAL_FIELDS: Array<{ key: StealNumber; label: string; hint: string; min: number; max: number }> = [
  { key: "hookPrice", label: "Hook price", hint: "default 150", min: 0, max: 1_000_000_000 },
  { key: "hookUses", label: "Tries per hook", hint: "default 3", min: 1, max: 100 },
  { key: "feePercent", label: "Fee (% of the fish)", hint: "every try, burned, default 3", min: 0, max: 1000 },
  { key: "feeMinimum", label: "Smallest fee", hint: "default 10", min: 0, max: 1_000_000_000 },
  { key: "edgePercent", label: "Thief's edge (%)", hint: "average loss, sets the fine, default 20", min: 0, max: 1000 },
  { key: "fineMinimum", label: "Smallest fine", hint: "default 25", min: 0, max: 1_000_000_000 },
  { key: "oddsCommon", label: "Common (%)", hint: "chance it works, default 40", min: 0, max: 100 },
  { key: "oddsUncommon", label: "Uncommon (%)", hint: "default 30", min: 0, max: 100 },
  { key: "oddsRare", label: "Rare (%)", hint: "default 20", min: 0, max: 100 },
  { key: "oddsEpic", label: "Epic (%)", hint: "default 10", min: 0, max: 100 },
  { key: "oddsLegendary", label: "Legendary (%)", hint: "default 5", min: 0, max: 100 },
  { key: "luckPercent", label: "Thief's luck (%)", hint: "raises every chance by this share, fines stay as priced: stealing pays, default 0", min: 0, max: 100 },
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

export interface CustomFish {
  /** An emoji or an emote's name. */
  name: string;
  weight: number;
  price: number;
  type: "Predator" | "Swift" | "Armored";
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
  /** A big bite trophy: its odds are a share of big bites. */
  trophy?: boolean;
  /** One of the channel's custom fish: set under Custom fish, not here. */
  custom?: boolean;
}

/** Big bites: live casts that land a trophy if the angler types the code shown on stream. Mirrors the bot's FishBigBiteSetting. */
export interface FishBigBite {
  enabled: boolean;
  everyMinutes: number;
  activeMinutes: number;
  windowSeconds: number;
  pulls: number;
  pullSeconds: number;
  flashSeconds: number;
  /** The first code's last seconds, open to snipers; 0 is off. Absent from an older bot service. */
  snipeSeconds?: number;
  /** Reward bites: Kicks in one gift that earn the sender a bite (0 off), and subs / gifted subs (the gifter). */
  kicksMin?: number;
  onSub?: boolean;
  onGift?: boolean;
}

/** The bot's defaults, for a bot service that doesn't report game settings yet. */
const GAMES_DEFAULTS: PointsGames = {
  enabled: false,
  onlyWhileLive: true,
  catchOdds: 20,
  catchCooldownMinutes: 30,
  trapMinutes: 60,
  trapMaxMinutes: 60,
  sellPricePercent: 100,
  baitPricePercent: 100,
  stories: true,
  chatReplies: true,
  overlayDemo: true,
  overlaySizePercent: 100,
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

type PointsSettingsPatch = Partial<Omit<PointsConfig, "effectiveCommand" | "bonuses" | "give" | "video" | "wordle" | "timeoutPenalty" | "antiSpam" | "gamble" | "games">> & {
  bonuses?: Partial<PointsBonuses>;
  give?: Partial<PointsGive>;
  video?: Partial<PointsVideo>;
  wordle?: Partial<PointsWordle>;
  timeoutPenalty?: Partial<PointsTimeoutPenalty>;
  antiSpam?: Partial<PointsAntiSpam>;
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
  videoEnabled: boolean;
  videoPrice: string;
  videoMax: string;
  videoQueue: string;
  videoLiveOnly: boolean;
  videoVolume: string;
  videoMediashare: boolean;
  videoMediashareDelay: string;
  wordleEnabled: boolean;
  wordlePrize: string;
  wordleGuesses: string;
  wordleCooldown: string;
  modMaxAdjust: string;
  publicLeaderboard: boolean;
  penaltyEnabled: boolean;
  penaltyPerSecond: string;
  penaltyMax: string;
  penaltyPermanentBan: string;
  penaltyAnnounce: boolean;
  spamEnabled: boolean;
  spamKeywords: string;
  spamThreshold: string;
  spamWindow: string;
  spamCost: string;
  spamTimeout: string;
  spamAnnounce: boolean;
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
  gamesOfflineOnly: boolean;
  fishOdds: string;
  fishCatchCooldown: string;
  fishTrapMinutes: string;
  fishTrapMax: string;
  fishSellPct: string;
  fishBaitPct: string;
  fishStories: boolean;
  fishGive: boolean;
  fishGiveCooldown: string;
  fishMaxFish: string;
  fishMaxJunk: string;
  fishFeed: boolean;
  fishFeedFail: string;
  fishChatReplies: boolean;
  fishOverlayDemo: boolean;
  fishOverlaySize: string;
  fishOverlayClearW: string;
  fishOverlayClearH: string;
  fishStreamDelay: string;
  fishCatches: { name: string; type: "fish" | "junk"; weight: string; price: string; defaultWeight: number; defaultPrice: number; trophy?: boolean }[];
  /** null: a bot service older than custom fish, so none are sent. */
  fishCustom: { name: string; weight: string; price: string; type: CustomFish["type"] }[] | null;
  /** null when the bot service doesn't report big bites. */
  fishBigBite: { enabled: boolean; everyMinutes: string; activeMinutes: string; windowSeconds: string; pulls: string; pullSeconds: string; flashSeconds: string; snipeSeconds: string; kicksMin: string; onSub: boolean; onGift: boolean } | null;
  fishTrapCheck: { enabled: boolean; chancePercent: string; castChancePercent: string; finePercent: string; answerSeconds: string; tries: string } | null;
  /** null when the bot service doesn't report reels. */
  fishReels: { name: string; price: string; odds: string; rarity: string; value: string }[] | null;
  /** null when the bot service doesn't report stealing. */
  fishSteal: ({ enabled: boolean; onlyWhileLive: boolean } & Record<StealNumber, string>) | null;
  /** null when the bot service doesn't report duels. */
  fishDuel: ({ enabled: boolean; onlyWhileLive: boolean; allowKeeps: boolean } & Record<DuelNumber, string>) | null;
  fishTrade: ({ enabled: boolean } & Record<TradeNumber, string>) | null;
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
    videoEnabled: c.video?.enabled === true,
    videoPrice: String(c.video?.pricePerSecond ?? 100),
    videoMax: String(c.video?.maxSeconds ?? 180),
    videoQueue: String(c.video?.queueMax ?? 5),
    videoLiveOnly: c.video?.onlyWhileLive !== false,
    videoVolume: String(c.video?.volumePercent ?? 50),
    videoMediashare: c.video?.mediashare === true,
    videoMediashareDelay: String(c.video?.mediashareDelaySeconds ?? 0),
    wordleEnabled: c.wordle?.enabled === true,
    wordlePrize: String(c.wordle?.prize ?? 1000),
    wordleGuesses: String(c.wordle?.maxGuesses ?? 6),
    wordleCooldown: String(c.wordle?.guessCooldownSeconds ?? 5),
    modMaxAdjust: String(c.modMaxAdjust),
    publicLeaderboard: c.publicLeaderboard,
    penaltyEnabled: c.timeoutPenalty.enabled,
    penaltyPerSecond: String(c.timeoutPenalty.pointsPerSecond),
    penaltyMax: String(c.timeoutPenalty.maxDeduction),
    penaltyPermanentBan: String(c.timeoutPenalty.permanentBanCost),
    penaltyAnnounce: c.timeoutPenalty.announce,
    spamEnabled: (c.antiSpam ?? ANTI_SPAM_DEFAULTS).enabled,
    spamKeywords: (c.antiSpam ?? ANTI_SPAM_DEFAULTS).keywords.join(", "),
    spamThreshold: String((c.antiSpam ?? ANTI_SPAM_DEFAULTS).threshold),
    spamWindow: String((c.antiSpam ?? ANTI_SPAM_DEFAULTS).windowMinutes),
    spamCost: String((c.antiSpam ?? ANTI_SPAM_DEFAULTS).cost),
    spamTimeout: String((c.antiSpam ?? ANTI_SPAM_DEFAULTS).timeoutMinutes ?? 1),
    spamAnnounce: (c.antiSpam ?? ANTI_SPAM_DEFAULTS).announce,
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
    gamesOfflineOnly: (c.games ?? GAMES_DEFAULTS).onlyWhileOffline ?? false,
    fishOdds: String((c.games ?? GAMES_DEFAULTS).catchOdds),
    fishCatchCooldown: String((c.games ?? GAMES_DEFAULTS).catchCooldownMinutes),
    fishTrapMinutes: String((c.games ?? GAMES_DEFAULTS).trapMinutes),
    fishTrapMax: String((c.games ?? GAMES_DEFAULTS).trapMaxMinutes ?? (c.games ?? GAMES_DEFAULTS).trapMinutes),
    fishSellPct: String((c.games ?? GAMES_DEFAULTS).sellPricePercent),
    fishBaitPct: String((c.games ?? GAMES_DEFAULTS).baitPricePercent),
    fishStories: (c.games ?? GAMES_DEFAULTS).stories,
    fishGive: c.games?.giveEnabled === true,
    fishGiveCooldown: String(c.games?.giveCooldownSeconds ?? 30),
    fishMaxFish: String(c.games?.maxFish ?? 100),
    fishMaxJunk: String(c.games?.maxJunk ?? 100),
    fishFeed: c.games?.feedEnabled !== false,
    fishFeedFail: String(c.games?.feedFailPercent ?? 10),
    fishChatReplies: (c.games ?? GAMES_DEFAULTS).chatReplies !== false,
    fishOverlayDemo: (c.games ?? GAMES_DEFAULTS).overlayDemo !== false,
    fishOverlaySize: String((c.games ?? GAMES_DEFAULTS).overlaySizePercent ?? 100),
    fishOverlayClearW: String(c.games?.overlayClearWidthPercent ?? 0),
    fishOverlayClearH: String(c.games?.overlayClearHeightPercent ?? 0),
    fishStreamDelay: String(c.games?.streamDelaySeconds ?? 0),
    fishCatches: (c.games?.catches ?? []).filter((x) => !x.custom).map((x) => ({ ...x, weight: String(x.weight), price: String(x.price) })),
    fishCustom: c.games?.customFish ? c.games.customFish.map((x) => ({ name: x.name, weight: String(x.weight), price: String(x.price), type: x.type })) : c.games ? [] : null,
    fishBigBite: c.games?.bigBite
      ? {
          enabled: c.games.bigBite.enabled,
          everyMinutes: String(c.games.bigBite.everyMinutes),
          activeMinutes: String(c.games.bigBite.activeMinutes),
          windowSeconds: String(c.games.bigBite.windowSeconds),
          pulls: String(c.games.bigBite.pulls ?? 3),
          pullSeconds: String(c.games.bigBite.pullSeconds ?? 8),
          flashSeconds: String(c.games.bigBite.flashSeconds ?? 3),
          snipeSeconds: String(c.games.bigBite.snipeSeconds ?? 20),
          kicksMin: String(c.games.bigBite.kicksMin ?? 0),
          onSub: c.games.bigBite.onSub ?? false,
          onGift: c.games.bigBite.onGift ?? false,
        }
      : null,
    fishTrapCheck: c.games?.trapCheck
      ? {
          enabled: c.games.trapCheck.enabled,
          chancePercent: String(c.games.trapCheck.chancePercent),
          castChancePercent: String(c.games.trapCheck.castChancePercent ?? 0),
          finePercent: String(c.games.trapCheck.finePercent),
          answerSeconds: String(c.games.trapCheck.answerSeconds),
          tries: String(c.games.trapCheck.tries),
        }
      : null,
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
          onlyWhileLive: c.games.steal.onlyWhileLive ?? false,
          ...(Object.fromEntries(STEAL_FIELDS.map(({ key }) => [key, String(c.games!.steal![key])])) as Record<StealNumber, string>),
        }
      : null,
    fishDuel: c.games?.duel
      ? {
          enabled: c.games.duel.enabled,
          onlyWhileLive: c.games.duel.onlyWhileLive,
          allowKeeps: c.games.duel.allowKeeps,
          ...(Object.fromEntries(DUEL_FIELDS.map(({ key }) => [key, String(c.games!.duel![key])])) as Record<DuelNumber, string>),
        }
      : null,
    fishTrade: c.games?.trade
      ? {
          enabled: c.games.trade.enabled,
          ...(Object.fromEntries(TRADE_FIELDS.map(({ key }) => [key, String(c.games!.trade![key])])) as Record<TradeNumber, string>),
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

/** Spam keywords as typed: split on commas, lowercased, inner spaces collapsed, no repeats. */
function parseSpamKeywords(raw: string): string[] {
  return Array.from(new Set(raw.split(/[,\n]+/).map((s) => s.trim().toLowerCase().replace(/\s+/g, " ")).filter(Boolean)));
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
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The parts of `next` that differ from `base`, as a patch: nested settings field by field (the bot
 * merges them), anything else (lists included) whole. Undefined when nothing changed.
 */
function changedOnly(next: unknown, base: unknown): Record<string, unknown> | undefined {
  if (!isPlain(next) || !isPlain(base)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(next)) {
    if (!(k in base)) out[k] = v;
    else if (isPlain(v) && isPlain(base[k])) {
      const inner = changedOnly(v, base[k]);
      if (inner) out[k] = inner;
    } else if (JSON.stringify(v) !== JSON.stringify(base[k])) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

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

  const spamKeywords = parseSpamKeywords(f.spamKeywords);
  if (spamKeywords.length > 20) errors.push("Spam keywords are limited to 20");
  if (spamKeywords.some((k) => k.length > 50)) errors.push("A spam keyword can be up to 50 characters");
  if (f.spamEnabled && spamKeywords.length === 0) errors.push("Add at least one spam keyword, or turn the spam penalty off");

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
    video: {
      enabled: f.videoEnabled,
      pricePerSecond: whole(f.videoPrice, "Video price per second", 0, 1_000_000),
      maxSeconds: whole(f.videoMax, "Longest video", 5, 3600),
      queueMax: whole(f.videoQueue, "Videos waiting", 1, 50),
      onlyWhileLive: f.videoLiveOnly,
      volumePercent: whole(f.videoVolume, "Video volume", 0, 100),
      mediashare: f.videoMediashare,
      mediashareDelaySeconds: decimal(f.videoMediashareDelay, "Media share delay", 0, 15),
    },
    wordle: {
      enabled: f.wordleEnabled,
      prize: whole(f.wordlePrize, "Wordle prize", 0, 1_000_000_000),
      maxGuesses: whole(f.wordleGuesses, "Wordle guesses", 1, 30),
      guessCooldownSeconds: whole(f.wordleCooldown, "Wordle guess cooldown", 0, 600),
    },
    timeoutPenalty: {
      enabled: f.penaltyEnabled,
      pointsPerSecond: decimal(f.penaltyPerSecond, "Cost per second", 0, 10_000),
      maxDeduction: whole(f.penaltyMax, "Maximum deduction", 0, 1_000_000_000),
      permanentBanCost: whole(f.penaltyPermanentBan, "Permanent ban cost", 0, 1_000_000_000),
      announce: f.penaltyAnnounce,
    },
    antiSpam: {
      enabled: f.spamEnabled,
      keywords: spamKeywords,
      threshold: whole(f.spamThreshold, "Free spam messages", 1, 1000),
      windowMinutes: whole(f.spamWindow, "Spam window", 1, 1440),
      cost: whole(f.spamCost, "Spam cost", 1, 1_000_000_000),
      timeoutMinutes: whole(f.spamTimeout, "Spam timeout", 0, 60),
      announce: f.spamAnnounce,
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
    onlyWhileOffline: f.gamesOfflineOnly,
    catchOdds: whole(f.fishOdds, "Catch odds", 1, 1000),
    catchCooldownMinutes: whole(f.fishCatchCooldown, "Cooldown after a catch", 1, 1440),
    trapMinutes: whole(f.fishTrapMinutes, "Trap time", 31, 1440),
    trapMaxMinutes: whole(f.fishTrapMax, "Longest trap", 31, 1440),
    sellPricePercent: whole(f.fishSellPct, "Sell prices", 0, 1000),
    baitPricePercent: whole(f.fishBaitPct, "Bait prices", 0, 1000),
    stories: f.fishStories,
    giveEnabled: f.fishGive,
    giveCooldownSeconds: whole(f.fishGiveCooldown, "Gift cooldown", 0, 3600),
    maxFish: whole(f.fishMaxFish, "Most fish held", 0, 100000),
    maxJunk: whole(f.fishMaxJunk, "Most junk held", 0, 100000),
    feedEnabled: f.fishFeed,
    feedFailPercent: whole(f.fishFeedFail, "Feeding fail chance", 0, 100),
    chatReplies: f.fishChatReplies,
    overlayDemo: f.fishOverlayDemo,
    overlaySizePercent: whole(f.fishOverlaySize, "Overlay size", 50, 300),
    overlayClearWidthPercent: whole(f.fishOverlayClearW, "Clear corner width", 0, 80),
    overlayClearHeightPercent: whole(f.fishOverlayClearH, "Clear corner height", 0, 80),
    streamDelaySeconds: whole(f.fishStreamDelay, "Stream delay", 0, 30),
  };
  if ((patch.games.trapMaxMinutes ?? 0) < (patch.games.trapMinutes ?? 0)) errors.push("Longest trap must be at least the trap time");
  if (f.fishCatches.length > 0) {
    // Only items that differ from their default are sent; the rest keep following it.
    const catches: Record<string, { weight: number; price: number }> = {};
    for (const c of f.fishCatches) {
      const weight = Math.round(decimal(c.weight, `${c.name} odds`, 0, 1_000_000) * 100) / 100;
      const price = whole(c.price, `${c.name} price`, 0, 1_000_000_000);
      if (weight !== c.defaultWeight || price !== c.defaultPrice) catches[c.name] = { weight, price };
    }
    const pools: Array<[string, typeof f.fishCatches]> = [
      ["fish", f.fishCatches.filter((c) => c.type === "fish" && !c.trophy)],
      ["junk item", f.fishCatches.filter((c) => c.type === "junk")],
      ["big bite trophy", f.fishCatches.filter((c) => c.trophy)],
    ];
    for (const [label, pool] of pools) {
      if (pool.length && pool.every((c) => Number(c.weight) === 0)) errors.push(`At least one ${label} needs odds above 0`);
    }
    patch.games.catches = catches;
  }
  if (f.fishCustom) {
    const names = new Set<string>();
    patch.games.customFish = f.fishCustom.map((x, i) => {
      const name = x.name.replace(/\uFE0F/g, "").trim();
      const label = `Custom fish ${i + 1}${name ? ` (${name})` : ""}`;
      if (!name) errors.push(`${label} needs a name: an emoji or an emote's name`);
      else if (names.has(name.toLowerCase())) errors.push(`Two custom fish are called ${name}`);
      names.add(name.toLowerCase());
      return {
        name,
        weight: Math.round(decimal(x.weight, `${label} odds`, 0, 1_000_000) * 100) / 100,
        price: whole(x.price, `${label} price`, 0, 1_000_000_000),
        type: x.type,
      };
    });
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
  if (f.fishBigBite) {
    patch.games.bigBite = {
      enabled: f.fishBigBite.enabled,
      everyMinutes: whole(f.fishBigBite.everyMinutes, "Big bite every (min)", 10, 600),
      activeMinutes: whole(f.fishBigBite.activeMinutes, "Big bite chatters active within (min)", 1, 120),
      windowSeconds: whole(f.fishBigBite.windowSeconds, "Big bite first code time", 10, 120),
      pulls: whole(f.fishBigBite.pulls, "Big bite pulls", 1, 5),
      pullSeconds: whole(f.fishBigBite.pullSeconds, "Big bite time per pull", 5, 60),
      flashSeconds: whole(f.fishBigBite.flashSeconds, "Big bite code flash", 0, 60),
      snipeSeconds: whole(f.fishBigBite.snipeSeconds, "Big bite sniping", 0, 60),
      kicksMin: whole(f.fishBigBite.kicksMin, "Big bite for Kicks", 0, 1_000_000),
      onSub: f.fishBigBite.onSub,
      onGift: f.fishBigBite.onGift,
    };
  }
  if (f.fishTrapCheck) {
    patch.games.trapCheck = {
      enabled: f.fishTrapCheck.enabled,
      chancePercent: whole(f.fishTrapCheck.chancePercent, "Trap checks: chance on full traps", 1, 100),
      castChancePercent: whole(f.fishTrapCheck.castChancePercent, "Trap checks: chance on casts", 0, 100),
      finePercent: whole(f.fishTrapCheck.finePercent, "Trap checks: fine", 0, 100),
      answerSeconds: whole(f.fishTrapCheck.answerSeconds, "Trap checks: time to answer", 10, 300),
      tries: whole(f.fishTrapCheck.tries, "Trap checks: tries", 1, 5),
    };
  }
  if (f.fishSteal) {
    const steal = { enabled: f.fishSteal.enabled, onlyWhileLive: f.fishSteal.onlyWhileLive } as FishSteal;
    for (const { key, label, min, max } of STEAL_FIELDS) steal[key] = whole(f.fishSteal[key], `Stealing: ${label}`, min, max);
    patch.games.steal = steal;
  }
  if (f.fishDuel) {
    const duel = { enabled: f.fishDuel.enabled, onlyWhileLive: f.fishDuel.onlyWhileLive, allowKeeps: f.fishDuel.allowKeeps } as FishDuelSettings;
    for (const { key, label, min, max } of DUEL_FIELDS) duel[key] = whole(f.fishDuel[key], `Fish duels: ${label}`, min, max);
    patch.games.duel = duel;
  }
  if (f.fishTrade) {
    const trade = { enabled: f.fishTrade.enabled } as FishTradeSettings;
    for (const { key, label, min, max, decimal } of TRADE_FIELDS) {
      const raw = f.fishTrade[key].trim();
      const v = Number(raw);
      if (raw === "" || !Number.isFinite(v) || v < min || v > max || (!decimal && !Number.isInteger(v))) errors.push(`Fish trades: ${label} must be ${decimal ? "a number" : "a whole number"} from ${min} to ${max.toLocaleString()}`);
      else trade[key] = v;
    }
    patch.games.trade = trade;
  }

  return errors.length > 0 ? { error: errors.join("; ") } : { patch };
}

/** Turn the rate into something concrete, since "per second" is easy to misjudge. */
function spamExample(free: string, minutes: string, cost: string, currency: string): string {
  const [f, m, c] = [Number(free), Number(minutes), Number(cost)];
  if (![f, m, c].every((n) => Number.isInteger(n) && n > 0)) return "";
  return `Message ${f + 1} within ${m} min costs ${c.toLocaleString()} ${currency.trim() || "points"}, and so does each one after.`;
}

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
type BigBiteForm = NonNullable<SettingsForm["fishBigBite"]>;

/** Big bites: on by default, but only ever while live with a fishing overlay showing. */
function BigBiteSettings({ value, command, disabled, onChange }: {
  value: BigBiteForm;
  command: string;
  disabled: boolean;
  onChange: (v: BigBiteForm) => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-neutral-800 p-3">
      <Checkbox
        label={`Big bites: now and then while live, a chatter can reel in a trophy ($${command} fish reel <code>)`}
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled ? (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-4">
            <Field label="About every (min)" hint="of live stream, 10–600, default 30">
              <input value={value.everyMinutes} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, everyMinutes: e.target.value })} className={INPUT} />
            </Field>
            <Field label="Chatters active within (min)" hint="who can get one, default 10">
              <input value={value.activeMinutes} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, activeMinutes: e.target.value })} className={INPUT} />
            </Field>
            <Field label="First code (s)" hint="to notice and answer, default 30">
              <input value={value.windowSeconds} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, windowSeconds: e.target.value })} className={INPUT} />
            </Field>
            <Field label="Pulls to land" hint="codes in a row, 1–5, default 3">
              <input value={value.pulls} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, pulls: e.target.value })} className={INPUT} />
            </Field>
            <Field label="Each later pull (s)" hint="quick on purpose, 5–60, default 8">
              <input value={value.pullSeconds} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, pullSeconds: e.target.value })} className={INPUT} />
            </Field>
            <Field label="Later codes flash for (s)" hint="then hide; 0 keeps them shown, default 3">
              <input value={value.flashSeconds} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, flashSeconds: e.target.value })} className={INPUT} />
            </Field>
            <Field label="Snipers get the last (s)" hint="of the first code, give or take 3s at random per bite, at most half of it; 0 = no sniping, default 20">
              <input value={value.snipeSeconds} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, snipeSeconds: e.target.value })} className={INPUT} />
            </Field>
          </div>
          <div className="mt-4 space-y-2 rounded-md border border-neutral-800/70 p-3">
            <p className="text-xs font-medium text-neutral-300">🎁 Reward bites: a big bite for viewers who support the channel, on top of the timed ones</p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="For Kicks, at least" hint="sent in one go; 0 = off">
                <input value={value.kicksMin} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, kicksMin: e.target.value })} className={INPUT} />
              </Field>
            </div>
            <Checkbox label="For a new sub or resub" checked={value.onSub} disabled={disabled} onChange={(onSub) => onChange({ ...value, onSub })} />
            <Checkbox label="For gifting subs (the gifter, not the recipients)" checked={value.onGift} disabled={disabled} onChange={(onGift) => onChange({ ...value, onGift })} />
            <p className="text-xs text-neutral-500">
              {`Live with the overlay showing only. A reward bite goes to that viewer straight away, or right after a bite already on a line (they wait up to 15 minutes), says thanks in chat, opens to snipers like any bite but a right snipe code only ends it (nobody else can win it), always lands if they get every code right, and doesn't move the timer. Not for the streamer or anonymous gifts.`}
            </p>
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {`While the stream is live and a fishing overlay is showing, a random viewer who chatted recently gets something big on their line, as often as set, give or take two minutes, so 15 means 13 to 17 minutes after the last one (never the same viewer twice in a row). Chat gets two lines, one naming them and one with the result; the reel codes and every pull play on the overlay only, which keeps chat quiet and means chat scripts can't answer. They type $${command} fish reel <code>, and each right answer brings a harder code for the next pull (two digits, then three and four letters and numbers, any case) with less time, shown only for a flash before it hides; from the second code they can type just the code, without the command; the overlay counts each one down, and an answer still counts a few seconds after zero for the stream's delay; after the last pull the trophy lands by its own chance (🦭 60% down to 🐉 10%) or snaps the line. A wrong code or too slow and it gets away. For the first code's last seconds, as set, anyone else chatting can snipe it with a different code the bot posts in chat: the first to type it takes the bite from them and reels on from the next pull (one try each, and chat says who took it). It isn't a cast: it doesn't touch their fishing cooldown. With no overlay showing, there are no big bites.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
type TrapCheckForm = NonNullable<SettingsForm["fishTrapCheck"]>;

/** Trap and cast checks: off until a channel turns them on; the numbers only show once on. */
function TrapCheckSettings({ value, currency, command, disabled, onChange }: {
  value: TrapCheckForm;
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (v: TrapCheckForm) => void;
}) {
  const field = (key: Exclude<keyof TrapCheckForm, "enabled">, label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <input value={value[key]} inputMode="numeric" disabled={disabled} onChange={(e) => onChange({ ...value, [key]: e.target.value })} className={INPUT} />
    </Field>
  );
  return (
    <div className="mt-4 rounded-md border border-neutral-800 p-3">
      <Checkbox
        label="Trap & cast checks: while offline, ask a question before some trap hauls and casts, against macros"
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled ? (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {field("chancePercent", "Chance on full traps (%)", "per offline collect, 1–100, default 25")}
            {field("castChancePercent", "Chance on casts (%)", "per offline cast, 0–100; 0 = off, default 0")}
            {field("finePercent", `Fine (% of ${currency})`, "for running out of tries or time, 0–100, default 15")}
            {field("answerSeconds", "Time to answer (s)", "10–300, default 30")}
            {field("tries", "Tries", "1–5, default 3")}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {`Only while the stream is offline. On that share of trap collects (and of casts, if set), the bot asks a question first: count an emoji, add or subtract, pick the fish or the junk out of a numbered row, or say where an emoji sits. Every one can be answered with a plain number, so nobody on a phone has to copy an emoji; the emoji and its everyday names (plurals too) count as well. They answer with $${command} fish answer and the answer, within the time and tries set; answers skip the 5-second cooldown. Right, the traps are collected (or the line is freed to cast again). Out of tries or time, they pay the fine on their balance and the traps come up empty (a cast check leaves traps alone). Once asked, the question stays until answered or out of time, so waiting it out doesn't skip it.`}
          </p>
        </>
      ) : null}
    </div>
  );
}
type TradeForm = NonNullable<SettingsForm["fishTrade"]>;

/** `fish trade`, off until a channel turns it on. */
function TradeSettings({ value, currency, command, disabled, onChange }: {
  value: TradeForm;
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (v: TradeForm) => void;
}) {
  return (
    <div className="rounded-md border border-neutral-800 p-3">
      <Checkbox
        label={`Let viewers trade fish ($${command} fish trade 🦈 72cm @user 🐋)`}
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled ? (
        <>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {TRADE_FIELDS.map(({ key, label, hint, decimal }) => (
              <Field key={key} label={label} hint={hint}>
                <input
                  value={value[key]}
                  inputMode={decimal ? "decimal" : "numeric"}
                  disabled={disabled}
                  onChange={(e) => onChange({ ...value, [key]: e.target.value })}
                  className={INPUT}
                />
              </Field>
            ))}
          </div>
          <p className="mt-3 text-xs text-neutral-500">
            {`A viewer offers fish and/or ${currency} for another's with $${command} fish trade 🦈 72cm @user 🐋: what they give, then who, then what they want ($${command} fish trade 5000 @user 🦦 buys a 🦦). A number first on a side, over 100, or written 50$ is ${currency}. `}
            {`The other answers $${command} fish accept or $${command} fish decline in time; $${command} fish trade cancel takes an offer back. Any time, live or offline. The offer names the very fish, and everything is checked again on accept. `}
            {`Whoever offered pays the fee when it goes through, a share of everything that changes hands (fish at sell value plus ${currency}), burned like steal fees so alts can't shuffle value around for free. Every trade is recorded, and a lopsided one counts as a gift for the cheat flags.`}
          </p>
        </>
      ) : null}
    </div>
  );
}

type DuelForm = NonNullable<SettingsForm["fishDuel"]>;

/** `fish duel`, off until a channel turns it on; the rest only shows once it's on. */
function DuelSettings({ value, currency, command, disabled, onChange }: {
  value: DuelForm;
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (v: DuelForm) => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-neutral-800 p-3">
      <Checkbox
        label={`Let viewers duel their fish ($${command} fish duel @user)`}
        checked={value.enabled}
        disabled={disabled}
        onChange={(enabled) => onChange({ ...value, enabled })}
      />
      {value.enabled ? (
        <>
          <div className="mt-2 space-y-2">
            <Checkbox
              label="Only duel while the stream is live (whatever the live/offline setting above says for casting and traps)"
              checked={value.onlyWhileLive}
              disabled={disabled}
              onChange={(onlyWhileLive) => onChange({ ...value, onlyWhileLive })}
            />
            <Checkbox
              label="Allow duels for keeps: the winner takes the loser's fish"
              checked={value.allowKeeps}
              disabled={disabled}
              onChange={(allowKeeps) => onChange({ ...value, allowKeeps })}
            />
          </div>
          <div className="mt-3 grid gap-4 sm:grid-cols-3">
            {DUEL_FIELDS.map(({ key, label, hint }) => (
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
            {`A viewer challenges another with $${command} fish duel @user, sending their strongest fish or the one they name, and sets the stake: nothing, an amount of ${currency} both put up, or "keeps". The other answers with $${command} fish accept (naming a fish if they like) or $${command} fish deny. `}
            {`The fight is automatic and plays on the fishing overlay, turn by turn: the stats decide it, with little left to luck. Rarity is a fish's level, a longer fish has more hit points and hits harder, and each fish has a type that gives a small edge (Predator beats Swift, Swift beats Armored, Armored beats Predator). `}
            {`Chat gets the challenge and the result; with an overlay open the result waits until the fight has played. Nothing is held while a challenge waits: the stake is checked and moved when the duel is fought.`}
          </p>
        </>
      ) : null}
    </div>
  );
}

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
          <div className="mt-2">
            <Checkbox
              label="Only steal while the stream is live (whatever the live/offline setting above says for casting and traps)"
              checked={value.onlyWhileLive}
              disabled={disabled}
              onChange={(onlyWhileLive) => onChange({ ...value, onlyWhileLive })}
            />
          </div>
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
            {`A thief first buys a 🪝 grappling hook with $${command} fish buy hook, then picks a target; the hook grabs one random fish that target has held longer than the safe time. Every try, caught or not, uses one hook try, a fee on the grabbed fish's value and starts the steal cooldown (as long as the catch cooldown), which holds up only stealing: thieves can still fish and lay traps. `}
            {`It works at the chance for that fish's rarity; otherwise the thief is caught and pays a fine on top. The fine is set from the odds so that, on average, a thief loses the edge % of what a try could expect to win, whether the hook grabs a frog or a whale; at the defaults a thief loses about a fifth, and cheap fish don't repay the hook. Fees and fines go nowhere: nobody receives them. `}
            {`A thief must hold the fee and fine for the target's costliest fish before trying; short of that, the try only costs a hook use, and the reply says how much they need. Steals always reply in chat, whatever the chat setting above, and also play on the overlay. `}
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

  const table = (type: "fish" | "junk" | "trophy") => {
    const ofType = rows.filter((r) => (type === "trophy" ? r.trophy : r.type === type && !r.trophy));
    if (!ofType.length) return null;
    const total = ofType.reduce((sum, r) => sum + (Number(r.weight) > 0 ? Number(r.weight) : 0), 0);
    return (
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-neutral-500">
            <th className="pb-1 text-left font-normal">{type === "fish" ? "Fish" : type === "junk" ? "Junk" : "Big bite trophies"}</th>
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
          {table("trophy")}
        </div>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-xs text-neutral-500">
            {`Lower odds make an item rarer: 0.5 is half as likely as 1, and 0 is never caught. Chance is that item's share of fish (or junk) catches; how often a cast lands anything at all is the catch odds above. Trophies only come from big bites, and their chance is a share of big bites. Prices are in ${currency}, and a fish's length and a record still scale its price; the sell-price % above doesn't change trophies.`}
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

const MAX_CUSTOM_FISH = 20;

/**
 * The channel's own fish: a name (an emoji or an emote's name), odds on the same scale as
 * the built-in fish, a price at 50 cm, and a duel type. Caught, sold and duelled like the rest.
 */
function CustomFishTable({ rows, builtInTotal, currency, command, disabled, onChange }: {
  rows: NonNullable<SettingsForm["fishCustom"]>;
  builtInTotal: number;
  currency: string;
  command: string;
  disabled: boolean;
  onChange: (rows: NonNullable<SettingsForm["fishCustom"]>) => void;
}) {
  const total = builtInTotal + rows.reduce((sum, r) => sum + (Number(r.weight) > 0 ? Number(r.weight) : 0), 0);
  const edit = (i: number, patch: Partial<(typeof rows)[number]>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <details className="mt-3 rounded-lg border border-neutral-800" open={rows.length > 0}>
      <summary className="cursor-pointer select-none px-3 py-2 text-sm text-neutral-300">
        Custom fish
        <span className="ml-2 text-xs text-neutral-500">{rows.length ? `${rows.length} of ${MAX_CUSTOM_FISH}` : "none yet"}</span>
      </summary>
      <div className="border-t border-neutral-800 p-3">
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-sm">
              <thead>
                <tr className="text-xs text-neutral-500">
                  <th className="pb-1 text-left font-normal">Name</th>
                  <th className="w-20 pb-1 text-right font-normal">Odds</th>
                  <th className="w-16 pb-1 text-right font-normal">Chance</th>
                  <th className="w-28 pb-1 text-right font-normal">Sells for</th>
                  <th className="w-28 pb-1 pl-2 text-left font-normal">Duel type</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const w = Number(r.weight);
                  const share = total > 0 ? (w / total) * 100 : 0;
                  const chance = !(w > 0) || total === 0 ? "never" : `${share.toFixed(share < 1 ? 2 : share < 10 ? 1 : 0)}%`;
                  return (
                    <tr key={i}>
                      <td className="py-0.5 pr-2">
                        <input
                          aria-label={`Custom fish ${i + 1} name`}
                          value={r.name}
                          placeholder="🦄 or an emote's name"
                          maxLength={25}
                          disabled={disabled}
                          onChange={(e) => edit(i, { name: e.target.value })}
                          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
                        />
                      </td>
                      <td className="py-0.5 pl-2">
                        <input aria-label={`Custom fish ${i + 1} odds`} inputMode="decimal" value={r.weight} disabled={disabled} onChange={(e) => edit(i, { weight: e.target.value })} className={CELL_INPUT} />
                      </td>
                      <td className="py-0.5 text-right text-xs tabular-nums text-neutral-500">{chance}</td>
                      <td className="py-0.5 pl-2">
                        <input aria-label={`Custom fish ${i + 1} sell price`} inputMode="numeric" value={r.price} disabled={disabled} onChange={(e) => edit(i, { price: e.target.value })} className={CELL_INPUT} />
                      </td>
                      <td className="py-0.5 pl-2">
                        <select
                          aria-label={`Custom fish ${i + 1} duel type`}
                          value={r.type}
                          disabled={disabled}
                          onChange={(e) => edit(i, { type: e.target.value as CustomFish["type"] })}
                          className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-1 py-1 text-sm text-neutral-200"
                        >
                          <option value="Predator">🦷 Predator</option>
                          <option value="Swift">💨 Swift</option>
                          <option value="Armored">🪨 Armored</option>
                        </select>
                      </td>
                      <td className="py-0.5 pl-2 text-right">
                        <button
                          type="button"
                          aria-label={`Remove custom fish ${i + 1}`}
                          disabled={disabled}
                          onClick={() => onChange(rows.filter((_, j) => j !== i))}
                          className="text-neutral-500 hover:text-red-400 disabled:opacity-40"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-xl text-xs text-neutral-500">
            {`Your own fish, caught by casts and traps like the rest. The name is an emoji or one of your emotes' names (then it shows as the emote on the overlay, and viewers type it: ${command ? `$${command}` : ""} fish sell KEKLEO). Odds are on the same scale as the built-in fish (🐟 is 10, 🦈 0.5), and chance is its share of all fish. The price is for a 50 cm one; length scales it like any fish. The duel type decides what it beats: Predator beats Swift, Swift beats Armored, Armored beats Predator. Taking one off the list stops it being caught; anyone holding one can still sell it at its last price.`}
          </p>
          <button
            type="button"
            onClick={() => onChange([...rows, { name: "", weight: "0.5", price: "500", type: "Swift" }])}
            disabled={disabled || rows.length >= MAX_CUSTOM_FISH}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:border-neutral-500 hover:text-neutral-100 disabled:opacity-40"
          >
            Add a custom fish
          </button>
        </div>
        <p className="mt-2 text-xs text-neutral-600">{`Prices are in ${currency}.`}</p>
      </div>
    </details>
  );
}

/**
 * The fishing overlay's browser-source links. Shown whatever the chat setting:
 * a channel can keep replies in chat and show the overlay too.
 */
function FishOverlayLinks({ links, title = "Fishing overlay", blurb }: { links: OverlayLink[]; title?: string; blurb?: string }) {
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
      <p className="text-sm text-neutral-200">{title}</p>
      <p className="mt-0.5 text-xs text-neutral-500">
        {blurb ?? (
          <>
            Add one as a Browser Source in OBS. It shows fishing on stream whether or not replies also go to chat. Keep the links
            private: anyone with one can show this channel&apos;s fishing. Add &amp;demo=1 to preview a burst, unless the demo is turned off above.
          </>
        )}
      </p>
      <div className="mt-3 space-y-3">
        {links.map((l) => (
          <div key={l.url}>
            {/* A box with one link has its title already: the link's own name would say it twice. */}
            {links.length > 1 ? <p className="text-xs font-medium text-neutral-300">{l.label}</p> : null}
            {l.hint ? <p className="text-xs text-neutral-500">{l.hint}</p> : null}
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

/** Unsaved settings edits by channel, kept while the dashboard is open, against the saved copy they were made on. */
const drafts = new Map<string, { base: string; form: SettingsForm }>();

const TITLES: Record<PointsSection, (currency: string, tab: FishingTab | null) => string> = {
  loyalty: (currency) => `Loyalty points · ${currency}`,
  games: () => "Mini-game settings",
  overlays: () => "Video sharing",
  fishing: (_currency, tab) => `Fishing · ${FISHING_TABS.find((t) => t.key === tab)?.label ?? "General"}`,
};

/** Which menu page the card draws its share of the settings for (lib/bot-sections). */
export type PointsSection = "loyalty" | "games" | "fishing" | "overlays";

export default function PointsCard({
  channel, canAdminister, points, fishOverlays, videoOverlays, mediaPlayers, onSaved, section, fishingTab,
}: {
  channel: string;
  /** Owner/admin edit the settings; managers see them read-only but can still adjust balances. */
  canAdminister: boolean;
  /** null when the bot service is older than the points system. */
  points: PointsConfig | null;
  /** The fishing overlay's browser-source links, one per look. */
  fishOverlays: OverlayLink[];
  videoOverlays: OverlayLink[];
  mediaPlayers: OverlayLink[];
  /** Receives the updated channel after a settings save, so the rest of the page stays current. */
  onSaved: (bot: { points?: PointsConfig | null }) => void;
  section: PointsSection;
  /** On Fishing, which tab. */
  fishingTab: FishingTab | null;
}) {
  const [saved, setSaved] = useState<PointsConfig | null>(points);
  // Edits not saved yet come back when this card does: each menu page and fishing tab draws a
  // new card, and switching used to drop them, so one Save now keeps every page's changes.
  const [form, setForm] = useState<SettingsForm | null>(() => {
    if (!points) return null;
    const fresh = formFromConfig(points);
    const draft = drafts.get(channel);
    return draft && draft.base === JSON.stringify(fresh) ? draft.form : fresh;
  });
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

  // Keep this card's unsaved edits for the next page, and warn before the tab closes with them.
  const unsaved = !!form && !!saved && JSON.stringify(form) !== JSON.stringify(formFromConfig(saved));
  useEffect(() => {
    if (unsaved && form && saved) drafts.set(channel, { base: JSON.stringify(formFromConfig(saved)), form });
    else drafts.delete(channel);
  }, [channel, unsaved, form, saved]);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);

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
    if (!form || !saved) return;
    const built = buildPatch(form);
    if ("error" in built) {
      setError(built.error);
      setNotice(null);
      return;
    }
    // Only what was changed goes: a page shows a share of the settings, and resending the rest
    // from this copy would undo a change made since in another tab.
    const base = buildPatch(formFromConfig(saved));
    const patch = "error" in base ? built.patch : (changedOnly(built.patch, base.patch) ?? {});
    void saveSettings(patch as PointsSettingsPatch, "Settings saved — applies within 15 seconds, no restart.", "points-save", true);
  }, [form, saved, saveSettings]);

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
  const tab = (t: FishingTab) => fishingTab === t;
  // The viewer picked in the list: balance, adjust and history.
  const detailPanel = (
    <div className="mb-3 space-y-4 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
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
  );

  return (
    <Card
      title={TITLES[section](currency, fishingTab)}
      icon={section === "fishing" ? <Fish className="h-4 w-4" /> : section === "games" ? <Gamepad2 className="h-4 w-4" /> : section === "overlays" ? <Layers className="h-4 w-4" /> : <Coins className="h-4 w-4" />}
      actions={
        section === "loyalty" && saved.enabled && saved.publicLeaderboard ? (
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

        {section !== "loyalty" && !saved.enabled ? (
          <p className="text-sm text-amber-300/80">
            Loyalty points are off, so none of this is available in chat. Turn them on under Loyalty.
          </p>
        ) : null}

        {section === "loyalty" ? (<>
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
        </>) : null}

        {/* ---------------------------------------------------------- settings */}
        <div>
          {section === "loyalty" ? <h3 className={SECTION}>Settings</h3> : null}
          {section === "fishing" && fishingTab === "overlay" ? <FishOverlayStatus channel={channel} canReload={saved.enabled && !!saved.games?.enabled} /> : null}
          <div className="mt-3 space-y-5 rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
              {readOnly ? <p className="text-xs text-amber-500">Only the broadcaster can change these.</p> : null}

              {section === "loyalty" ? (<>
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

              </>) : null}

              {section === "games" ? (<>
              <div>
                <h4 className={LABEL}>Wordle</h4>
                <Checkbox
                  label={`Let chat play Wordle ($${commandPreview || "…"} wordle <word>; mods start it with $${commandPreview || "…"} wordle start)`}
                  checked={form.wordleEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("wordleEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label={`Prize (${form.currencyName.trim() || "points"})`} hint="For the first right guess. 0 plays for glory.">
                    {text("wordlePrize", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Guesses per game" hint="For the whole chat together. Wordle's own is 6.">
                    {text("wordleGuesses", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Seconds between a viewer's guesses" hint="Keeps one viewer from using up the board.">
                    {text("wordleCooldown", { inputMode: "numeric" })}
                  </Field>
                </div>
              </div>

              </>) : null}

              {section === "overlays" ? (<>
              <div>
                <h4 className={LABEL}>Video sharing</h4>
                <Checkbox
                  label={`Let viewers pay to play a YouTube video on stream ($${commandPreview || "…"} video <link>)`}
                  checked={form.videoEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("videoEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label={`${form.currencyName.trim() || "Points"} per second`} hint="A video costs this for each second it plays, paid when it's queued.">
                    {text("videoPrice", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Longest video (s)" hint="Longer ones play this long from their start time, and cost that much.">
                    {text("videoMax", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Videos waiting" hint="The line's length, the one playing aside. One each per viewer.">
                    {text("videoQueue", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Volume (%)" hint="The player's own volume, 0–100; reaches a video already playing within a second. OBS's volume for the source applies on top.">
                    {text("videoVolume", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-3">
                  <Checkbox
                    label="Only while the stream is live"
                    checked={form.videoLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("videoLiveOnly", v)}
                  />
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Videos play in the order paid for, with sound, on the video overlay below: a browser source of its own, so the fishing overlay is untouched.
                  Viewers are turned away (and not charged) while it isn&apos;t open. Mods can end one early with ${commandPreview || "…"} video skip, without a refund;
                  one YouTube won&apos;t play is refunded. Livestreams, age-restricted videos and ones their owner keeps on YouTube are refused.
                </p>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Play my StreamElements media share on the video overlay"
                    checked={form.videoMediashare}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("videoMediashare", v)}
                  />
                  <p className="pl-6 text-xs text-neutral-500">
                    The overlay follows your media share (connect it below) instead of {form.currencyName.trim() || "points"}-paid videos; works with paid videos off.
                  </p>
                  <div className="pl-6 sm:max-w-xs">
                    <Field label="Media share delay (s)" hint="0–15, in tenths. If media share's sound reaches the stream late (played on an IRL phone and ingested with the camera, say), the overlay holds the video back this long to match it. Reaches an open overlay within a second.">
                      {text("videoMediashareDelay", { inputMode: "decimal" })}
                    </Field>
                  </div>
                  <MediaShareSetup channel={channel} canAdminister={canAdminister} />
                  {form.videoMediashare && canAdminister ? (
                    <FishOverlayLinks links={mediaPlayers} title="Phone player" blurb="Open it on your phone in place of an app's media share player (Stream Buddy, say): it plays your media share with sound, and the video overlay follows it exactly; pause there and the overlay hides. Keep it on screen (a split screen works), and the link private: it can pause and skip your queue." />
                  ) : null}
                </div>
                <div className="mt-3">
                  <FishOverlayLinks links={videoOverlays} title="Video overlay" blurb="Add it as a Browser Source in OBS, sized 16:9, and set its volume there. Keep the link private: anyone with it could show this channel's videos." />
                </div>
              </div>

              </>) : null}

              {section === "games" ? (<>
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

              </>) : null}

              {section === "fishing" ? (
              <div>
                {tab("general") ? (<>
                <Checkbox
                  label={`Turn on fishing for ${form.currencyName.trim() || "points"}`}
                  checked={form.gamesEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("gamesEnabled", v)}
                />
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  <Field label="Catch odds (1 in …)" hint="supibot: 20">{text("fishOdds", { inputMode: "numeric" })}</Field>
                  <Field label="Cooldown after a catch (min)" hint="supibot: 30">{text("fishCatchCooldown", { inputMode: "numeric" })}</Field>
                </div>
                </>) : null}
                {tab("traps") ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Trap time (min)" hint="31–1440, supibot: 60">{text("fishTrapMinutes", { inputMode: "numeric" })}</Field>
                  <Field label="Longest trap (min)" hint={`Chatters can name a time from 31 min up to this: $${commandPreview || "…"} fish trap 2h. At least the trap time`}>{text("fishTrapMax", { inputMode: "numeric" })}</Field>
                </div>
                ) : null}
                {tab("general") ? (
                <div className="mt-3 grid gap-4 sm:grid-cols-4">
                  {form.fishCatches.length === 0 ? (
                    <Field label="Sell prices (%)" hint="100 = fish 50, junk 1–20">{text("fishSellPct", { inputMode: "numeric" })}</Field>
                  ) : null}
                  <Field label="Bait prices (%)" hint="100 = worm 2, fly 5, cricket 8">{text("fishBaitPct", { inputMode: "numeric" })}</Field>
                  <Field label="Most fish held" hint="Per viewer; past it new fish sell on the spot, warned from 90%. 0 = no cap">{text("fishMaxFish", { inputMode: "numeric" })}</Field>
                  <Field label="Most junk held" hint="Per viewer; past it new junk is thrown away. 0 = no cap">{text("fishMaxJunk", { inputMode: "numeric" })}</Field>
                </div>
                ) : null}
                {tab("catches") && form.fishReels ? (
                  <ReelTable
                    rows={form.fishReels}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(rows) => set("fishReels", rows)}
                  />
                ) : null}
                {tab("bigbites") && form.fishBigBite ? (
                  <BigBiteSettings
                    value={form.fishBigBite}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishBigBite", v)}
                  />
                ) : null}
                {tab("traps") && form.fishTrapCheck ? (
                  <TrapCheckSettings
                    value={form.fishTrapCheck}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishTrapCheck", v)}
                  />
                ) : null}
                {tab("steals") && form.fishSteal ? (
                  <StealSettings
                    value={form.fishSteal}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishSteal", v)}
                  />
                ) : null}
                {tab("trades") && form.fishTrade ? (
                  <TradeSettings
                    value={form.fishTrade}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishTrade", v)}
                  />
                ) : null}
                {tab("duels") && form.fishDuel ? (
                  <DuelSettings
                    value={form.fishDuel}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishDuel", v)}
                  />
                ) : null}
                {tab("catches") && form.fishCatches.length > 0 ? (
                  <CatchTable
                    rows={form.fishCatches}
                    currency={form.currencyName.trim() || "points"}
                    disabled={readOnly || !!busy}
                    onChange={(rows) => set("fishCatches", rows)}
                  />
                ) : null}
                {tab("catches") && form.fishCustom ? (
                  <CustomFishTable
                    rows={form.fishCustom}
                    builtInTotal={form.fishCatches.filter((c) => c.type === "fish" && !c.trophy).reduce((sum, c) => sum + (Number(c.weight) > 0 ? Number(c.weight) : 0), 0)}
                    currency={form.currencyName.trim() || "points"}
                    command={commandPreview || "…"}
                    disabled={readOnly || !!busy}
                    onChange={(rows) => set("fishCustom", rows)}
                  />
                ) : null}
                {tab("general") ? (
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Only fish and lay traps while the stream is live"
                    checked={form.gamesLiveOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => setForm((f) => (f ? { ...f, gamesLiveOnly: v, gamesOfflineOnly: v ? false : f.gamesOfflineOnly } : f))}
                  />
                  <Checkbox
                    label="Only fish and lay traps while the stream is offline"
                    checked={form.gamesOfflineOnly}
                    disabled={readOnly || !!busy}
                    onChange={(v) => setForm((f) => (f ? { ...f, gamesOfflineOnly: v, gamesLiveOnly: v ? false : f.gamesLiveOnly } : f))}
                  />
                  {form.gamesOfflineOnly ? (
                    <p className="pl-6 text-xs text-amber-300/80">
                      {form.fishBigBite?.enabled ? `Big bites still come while the stream is live; only casting${form.fishSteal?.enabled && form.fishSteal.onlyWhileLive ? " and traps" : ", traps and stealing"} wait for it to end. ` : ""}
                      While the stream is live with a fishing overlay open, fishing replies show on the overlay only; chat gets them once it&apos;s offline.
                    </p>
                  ) : null}
                  <Checkbox
                    label="AI story on 1 in 3 catches"
                    checked={form.fishStories}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishStories", v)}
                  />
                  <Checkbox
                    label={`Let viewers give fish and junk to each other (${commandPreview ? `$${commandPreview}` : "…"} fish give @user 🐟 [count])`}
                    checked={form.fishGive}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishGive", v)}
                  />
                  {form.fishGive ? (
                    <div className="pl-6 sm:w-1/3">
                      <Field label="Seconds between gives" hint="Per viewer. Anyone can receive, fished before or not; oldest fish go first, and a record bonus stays with whoever caught it.">
                        {text("fishGiveCooldown", { inputMode: "numeric" })}
                      </Field>
                    </div>
                  ) : null}
                  <Checkbox
                    label={`Let viewers level up a fish by feeding it others (${commandPreview ? `$${commandPreview}` : "…"} fish feed 🦈 72cm 🐟 🐟)`}
                    checked={form.fishFeed}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishFeed", v)}
                  />
                  {form.fishFeed ? (
                    <div className="pl-6 sm:w-1/3">
                      <Field label="Chance a feeding fails (%)" hint="The food is lost and no XP gained. Food gives its sell value as XP; each level (up to 10) adds 3% duel health and attack, up to a full-length fish of the next rarity up, and 25% value.">
                        {text("fishFeedFail", { inputMode: "numeric" })}
                      </Field>
                    </div>
                  ) : null}
                  <Checkbox
                    label="Post fishing replies in chat"
                    checked={form.fishChatReplies}
                    disabled={readOnly || !!busy || form.gamesOfflineOnly}
                    onChange={(v) => set("fishChatReplies", v)}
                  />
                  {form.gamesOfflineOnly ? (
                    <p className="pl-6 text-xs text-neutral-500">
                      Decided by offline-only fishing above: the overlay while live, chat while offline.
                    </p>
                  ) : !form.fishChatReplies ? (
                    <p className="pl-6 text-xs text-amber-300/80">
                      While the stream is live with a fishing overlay open, every fishing reply shows on the overlay only. Offline, or with no overlay open, replies still go to chat. A big bite&apos;s ping and result always go to chat.
                    </p>
                  ) : null}
                </div>
                ) : null}
                {tab("overlay") ? (<>
                <div className="space-y-2">
                  <Checkbox
                    label="Let the fishing overlay play its demo (&demo=1)"
                    checked={form.fishOverlayDemo}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("fishOverlayDemo", v)}
                  />
                  {!form.fishOverlayDemo ? (
                    <p className="pl-6 text-xs text-neutral-500">
                      Overlays ignore &amp;demo=1, including one already open in OBS with it left on its link.
                    </p>
                  ) : null}
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <Field label="Overlay size (%)" hint="100 = as designed. Raise it if the source was shrunk in OBS and reads too small. An overlay already open follows within a couple of seconds.">
                    {text("fishOverlaySize", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Clear corner width (%)" hint="Keeps the source's bottom-right corner free for something else on stream, a map say: this share of its width. 0 = nothing kept clear.">
                    {text("fishOverlayClearW", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Clear corner height (%)" hint="And this share of its height. Replies then show above the corner, big bite codes to its left. Both must be above 0.">
                    {text("fishOverlayClearH", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-4 grid gap-4 sm:grid-cols-3">
                  <Field label="Stream delay (seconds)" hint="How far the stream runs behind chat. The overlay runs this far ahead, so big bite countdowns and the snipe label are right when viewers see them; a big bite's time starts once viewers can see the code, and wheel and duel results wait for the stream in chat. Set it a little under the real delay: over it, viewers see snipes open before they do. 0 = off.">
                    {text("fishStreamDelay", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-4">
                  <FishOverlayLinks links={fishOverlays} />
                </div>
                </>) : null}
                {tab("general") ? (
                <p className="mt-3 text-xs text-neutral-500">
                  {`supibot's fishing game, played as $${commandPreview || "…"} fish like every command that uses ${form.currencyName.trim() || "points"}: cast (with worm, fly or cricket bait), then sell, show, stats, top and trap. `}
                  Catches are kept until sold; selling pays {form.currencyName.trim() || "points"}, bait costs it. A fish's price scales with its length (half at 1 cm, double at 100 cm), plus 50% for beating a record. A miss waits 30–90 seconds and
                  snags junk 1 time in 4. Laying traps pings the viewer in chat when they&apos;re full, if !remind is on. With this off fishing isn&apos;t available. !cookie and !slots don&apos;t use points and are
                  switched on under Commands.
                </p>
                ) : null}
              </div>
              ) : null}

              {section === "loyalty" ? (<>
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

              <div>
                <h4 className={LABEL}>Spam penalty</h4>
                <Checkbox
                  label={`Deduct ${form.currencyName.trim() || "points"} when a viewer spams a keyword`}
                  checked={form.spamEnabled}
                  disabled={readOnly || !!busy}
                  onChange={(v) => set("spamEnabled", v)}
                />
                <div className="mt-3">
                  <Field label="Keywords" hint="Words, phrases or emote names, separated by commas. Whole words only, any case.">
                    {text("spamKeywords", { placeholder: "kekw, free money" })}
                  </Field>
                </div>
                <div className="mt-3 grid gap-4 sm:grid-cols-3">
                  <Field label="Free messages" hint="How many a viewer may send before it costs.">
                    {text("spamThreshold", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Counted over (minutes)" hint="Older messages stop counting.">
                    {text("spamWindow", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Cost per message after that" hint={spamExample(form.spamThreshold, form.spamWindow, form.spamCost, form.currencyName)}>
                    {text("spamCost", { inputMode: "numeric" })}
                  </Field>
                  <Field label="Timeout if they can't pay (min)" hint="Per message they can't cover. 0 = no timeout, default 1.">
                    {text("spamTimeout", { inputMode: "numeric" })}
                  </Field>
                </div>
                <div className="mt-3 space-y-2">
                  <Checkbox
                    label="Announce the top 5 spam deductions of the last 10 minutes in chat, every 10 minutes"
                    checked={form.spamAnnounce}
                    disabled={readOnly || !!busy}
                    onChange={(v) => set("spamAnnounce", v)}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Counted per viewer, one per message however often it repeats the keyword. The streamer and moderators
                  are never charged, nor is anyone excluded from earning. A viewer never goes below zero: one who can't cover the cost
                  loses what they have and is timed out for the minutes set, and chat is told why. Timeouts need the bot to be able to
                  moderate here; moderators and the bot owner are never timed out.
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
              </>) : null}

              {readOnly ? null : (
                <div className="flex flex-wrap items-center gap-2">
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
                  {dirty ? (
                    <span className="text-xs text-amber-300/80">Unsaved changes, here or on other pages: Save keeps them all, Reset drops them all.</span>
                  ) : null}
                </div>
              )}
          </div>
        </div>

        {section === "loyalty" ? (<>
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
                  {/* Opens under the viewer clicked, not after the whole list. */}
                  {selectedId === u.userId ? detailPanel : null}
                </li>
              ))}
            </ul>
          ) : null}

          {selectedId !== null && !users?.some((u) => u.userId === selectedId) ? <div className="mt-4">{detailPanel}</div> : null}
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
        </>) : null}
      </div>
    </Card>
  );
}
