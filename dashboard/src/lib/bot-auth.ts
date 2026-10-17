import "server-only";
import { NextResponse } from "next/server";
import { getSession, isAdmin } from "@/lib/session";
import { BotApiError, getChannel } from "@/lib/bot-api";

/**
 * owner   — the channel's own Kick account
 * admin   — the dashboard operator (ADMIN_KICK_USER_ID)
 * manager — a moderator the broadcaster explicitly added to `managers`
 *
 * Managers can operate the bot but not dismantle it: removing the bot, stopping
 * it indefinitely, re-authorizing Kick, and editing the manager list itself all
 * stay with the owner. A busy channel has a dozen moderators, and any one of
 * them being able to delete the integration is not a reasonable default.
 */
export type Role = "owner" | "admin" | "manager";

export interface Authorized {
  username: string;
  userId: number;
  role: Role;
  /** Owner/admin only — the destructive and identity-level actions. */
  canAdminister: boolean;
}

export async function authorizeChannel(
  channel: string,
): Promise<{ ok: true; auth: Authorized } | { ok: false; response: NextResponse }> {
  const session = await getSession();

  if (!session.userId || !session.username) {
    return { ok: false, response: NextResponse.json({ error: "Not signed in" }, { status: 401 }) };
  }

  const username = session.username.toLowerCase();
  const slug = channel.toLowerCase();

  if (isAdmin(session.userId)) {
    return { ok: true, auth: { username, userId: session.userId, role: "admin", canAdminister: true } };
  }
  let bot: Awaited<ReturnType<typeof getChannel>> | null = null;
  try {
    bot = await getChannel(slug);
  } catch (e) {
    // A channel that isn't enrolled has no managers, so this is a plain denial
    // rather than an error worth surfacing.
    if (!(e instanceof BotApiError && e.status === 404)) {
      console.error("[bot-auth] Could not read managers:", e);
    }
  }

  // The owner is the channel's Kick account by user id, not just by name: a name someone
  // else claims after a rename doesn't inherit the bot (2026-10-16 audit).
  if (username === slug && (!bot?.broadcasterUserId || bot.broadcasterUserId === session.userId)) {
    return { ok: true, auth: { username, userId: session.userId, role: "owner", canAdminister: true } };
  }

  // Not owner or admin — the only remaining route in is an explicit grant.
  const managers: string[] = bot?.managers ?? [];

  if (managers.includes(username)) {
    return { ok: true, auth: { username, userId: session.userId, role: "manager", canAdminister: false } };
  }

  return {
    ok: false,
    response: NextResponse.json(
      { error: "You do not have access to this channel's bot" },
      { status: 403 },
    ),
  };
}

/** Guard for actions restricted to the owner/admin. */
export function requireAdminister(auth: Authorized): NextResponse | null {
  if (auth.canAdminister) return null;
  return NextResponse.json(
    { error: "Only the broadcaster can do that" },
    { status: 403 },
  );
}

/** Turns a BotApiError into the matching HTTP response, and anything else into a 500. */
export function errorResponse(e: unknown): NextResponse {
  if (e instanceof BotApiError) {
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  console.error("[bot api]", e);
  return NextResponse.json({ error: "Internal error" }, { status: 500 });
}

/**
 * Names the bot service refuses as channels: `channels` is its list route, and
 * `moderation` is a module in the bot's channels directory that enrolling or
 * removing a channel of that name would overwrite or delete.
 */
const RESERVED_CHANNELS = new Set(["channels", "moderation"]);

/** Channel slugs mirror the bot's own validation: lowercase alphanumerics and underscores. */
export function validChannel(channel: string): boolean {
  return /^[a-z0-9_]{1,25}$/.test(channel) && !RESERVED_CHANNELS.has(channel);
}

/** The channel summary as this role may see it: who manages the bot is the broadcaster's business. */
export function visibleTo<T extends { managers?: string[] }>(auth: Authorized, bot: T): T {
  return auth.canAdminister ? bot : { ...bot, managers: [] };
}
