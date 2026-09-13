"use client";

import type { ReactNode } from "react";

const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/**
 * The one header used by every signed-in page, so the nav doesn't change shape
 * as you move between bot management and earnings. Page-specific controls go in
 * `children` and render to the left of the shared nav — that's the only part
 * that should ever differ between pages.
 */
export default function SiteHeader({
  channel,
  username,
  avatarUrl,
  channelAvatarUrl,
  isAdmin,
  current,
  title,
  status,
  switcher,
  showEarnings = true,
  variant = "default",
  children,
}: {
  /**
   * "public" is for pages anyone can open signed out (the leaderboard): just the
   * channel name and a sign-in link, with no nav, switcher or sign-out.
   */
  variant?: "default" | "public";
  /** Off for managers: the earnings page is the broadcaster's and would only bounce them. */
  showEarnings?: boolean;
  channel: string;
  username: string | null;
  /** The signed-in user's photo. Shown beside their name, never the channel's. */
  avatarUrl?: string | null;
  /**
   * The channel's own photo, shown beside the channel name. It used to be the
   * signed-in user's photo there, so an admin viewing another channel saw their
   * own face next to that channel's name.
   */
  channelAvatarUrl?: string | null;
  isAdmin: boolean;
  /** Which page is showing, so its own nav entry renders as the active one. */
  current: "bot" | "earnings" | "channels" | "leaderboard";
  /** Overrides the displayed name — the channels page isn't about one channel. */
  title?: string;
  /** Optional element shown beside the channel name (e.g. the live indicator). */
  status?: ReactNode;
  /**
   * Bots this user can manage, own channel included. Rendered as a second row
   * so every page has a route to a bot page — the nav no longer carries one.
   */
  switcher?: { channel: string; isSelf: boolean }[];
  children?: ReactNode;
}) {
  if (variant === "public") {
    return (
      <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate font-semibold text-[#53FC18]">{title ?? channel}</span>
            {status}
          </div>
          {username ? (
            <span className="text-sm text-neutral-500">{username}</span>
          ) : (
            <a
              href={`${BASE_PATH}/api/auth/login`}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200"
            >
              Sign in
            </a>
          )}
        </div>
      </header>
    );
  }

  const link = "px-3 py-2 text-sm transition rounded-lg";
  const active = "text-[#53FC18]";
  const idle = "text-neutral-400 hover:text-neutral-200";

  return (
    <header className="border-b border-neutral-800 bg-neutral-950/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          {channelAvatarUrl && !title ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={channelAvatarUrl} alt={channel} className="h-8 w-8 shrink-0 rounded-full" />
          ) : null}
          <span className="truncate font-semibold text-[#53FC18]">{title ?? channel}</span>
          {status}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {children}

          <nav className="flex items-center gap-1">
            {showEarnings ? (
              <a
                href={`${BASE_PATH}/${channel}`}
                className={`${link} ${current === "earnings" ? active : idle}`}
              >
                Earnings
              </a>
            ) : null}
            {isAdmin ? (
              <a
                href={`${BASE_PATH}/channels`}
                className={`${link} ${current === "channels" ? active : idle}`}
              >
                All channels
              </a>
            ) : null}
          </nav>

          <span className="hidden text-neutral-700 sm:inline">|</span>

          {username ? (
            <span className="flex items-center gap-2" title={`Signed in as ${username}`}>
              {avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full" />
              ) : null}
              <span className="hidden text-sm text-neutral-500 sm:inline">{username}</span>
            </span>
          ) : null}

          <form action={`${BASE_PATH}/api/auth/logout`} method="POST">
            <button
              type="submit"
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-200 active:scale-95"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {switcher && switcher.length > 0 ? (
        <div className="border-t border-neutral-900 bg-neutral-950/60">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2 sm:px-6">
            <span className="text-xs uppercase tracking-wider text-neutral-600">Your bots</span>
            {switcher.map((c) => {
              const isCurrent = c.channel === channel && current === "bot";
              return (
                <a
                  key={c.channel}
                  href={`${BASE_PATH}/${c.channel}/bot`}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    isCurrent
                      ? "border-[#53FC18]/40 bg-[#53FC18]/10 text-[#53FC18]"
                      : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                  }`}
                >
                  {c.channel}
                  {c.isSelf ? <span className="ml-1.5 text-neutral-600">you</span> : null}
                </a>
              );
            })}
          </div>
        </div>
      ) : null}
    </header>
  );
}
