"use client";

import Link from "next/link";
import { Activity, Coins, Crown, Fish, Gamepad2, Gift, Layers, MessageSquare, Users } from "lucide-react";
import { BOT_SECTIONS, FISHING_TABS, botPath, type BotSection, type FishingTab } from "@/lib/bot-sections";

const ICONS: Record<BotSection, React.ComponentType<{ className?: string }>> = {
  overview: Activity,
  chat: MessageSquare,
  loyalty: Coins,
  games: Gamepad2,
  fishing: Fish,
  overlays: Layers,
  rewards: Gift,
  team: Users,
  admin: Crown,
};

/** The bot page's menu: down the side on a wide screen, a scrolling row across the top on a phone. */
export function BotNav({ channel, section, sections }: { channel: string; section: BotSection; sections: BotSection[] }) {
  return (
    <nav aria-label="Bot settings" className="lg:sticky lg:top-6 lg:self-start">
      <ul className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0 lg:pb-0">
        {BOT_SECTIONS.filter((s) => sections.includes(s.key)).map((s) => {
          const Icon = ICONS[s.key];
          const on = s.key === section;
          return (
            <li key={s.key} className="shrink-0">
              <Link
                href={botPath(channel, s.key)}
                aria-current={on ? "page" : undefined}
                className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition ${
                  on
                    ? "bg-[#53FC18]/10 text-[#53FC18]"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Fishing's tabs, across the top of its page. */
export function FishingTabs({ channel, tab }: { channel: string; tab: FishingTab }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <ul className="flex gap-1 border-b border-neutral-800">
        {FISHING_TABS.map((t) => {
          const on = t.key === tab;
          return (
            <li key={t.key} className="shrink-0">
              <Link
                href={botPath(channel, "fishing", t.key)}
                aria-current={on ? "page" : undefined}
                className={`-mb-px block whitespace-nowrap border-b-2 px-3 py-2 text-sm transition ${
                  on ? "border-[#53FC18] text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
