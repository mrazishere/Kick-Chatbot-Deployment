// The bot page's menu: one page per section, /<channel>/bot/<section>[/<tab>].
// Overview is the bare /<channel>/bot, so links from before the split still land somewhere.

export const BOT_SECTIONS = [
  { key: "overview", label: "Overview" },
  { key: "chat", label: "Chat Bot" },
  { key: "loyalty", label: "Loyalty" },
  { key: "games", label: "Mini-Games" },
  { key: "fishing", label: "Fishing" },
  { key: "overlays", label: "Overlays" },
  { key: "rewards", label: "Rewards" },
  { key: "team", label: "Team" },
  { key: "admin", label: "Admin" },
] as const;

export type BotSection = (typeof BOT_SECTIONS)[number]["key"];

export const FISHING_TABS = [
  { key: "general", label: "General" },
  { key: "catches", label: "Catches" },
  { key: "bigbites", label: "Big bites" },
  { key: "traps", label: "Traps" },
  { key: "steals", label: "Steals" },
  { key: "duels", label: "Duels" },
  { key: "trades", label: "Trades" },
  { key: "overlay", label: "Overlay" },
] as const;

export type FishingTab = (typeof FISHING_TABS)[number]["key"];

/** The section and tab a URL's segments name, or null for one that doesn't exist. */
export function parseBotPath(segments: string[] | undefined): { section: BotSection; tab: FishingTab | null } | null {
  const [s, t, ...rest] = segments ?? [];
  if (rest.length) return null;
  if (!s) return { section: "overview", tab: null };
  const section = BOT_SECTIONS.find((x) => x.key === s)?.key;
  if (!section || section === "overview") return null;
  if (section !== "fishing") return t ? null : { section, tab: null };
  if (!t) return { section, tab: "general" };
  // Possible cheaters moved to Loyalty (2026-10-31): it covers gambling too. Old links still land.
  if (t === "cheaters") return { section: "loyalty", tab: null };
  const tab = FISHING_TABS.find((x) => x.key === t)?.key;
  return tab ? { section, tab } : null;
}

/** The page's path under the dashboard's base path (Link adds it). */
export function botPath(channel: string, section: BotSection, tab?: FishingTab | null): string {
  if (section === "overview") return `/${channel}/bot`;
  return `/${channel}/bot/${section}${tab && tab !== "general" ? `/${tab}` : ""}`;
}
