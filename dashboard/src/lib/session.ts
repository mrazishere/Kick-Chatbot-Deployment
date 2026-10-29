import { getIronSession, unsealData, IronSession } from "iron-session";
import { cookies } from "next/headers";

export interface SessionData {
  userId?: number;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  oauthState?: string;
  oauthCodeVerifier?: string;
  /** Viewer sign-in only: the leaderboard page to go back to. */
  oauthReturnTo?: string;
}

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * The cookie this dashboard used until 2026-09-11: named kpp_session, set at path
 * "/", sealed with the same secret. Renaming and scoping the cookie would otherwise
 * sign everyone out, and making streamers log in again costs them. Browsers still
 * send the old cookie to /kick, so it is honoured until it lapses: 7 days after it
 * was last written, so by 2026-09-18. From LEGACY_COOKIE_RETIRES_AT this path is
 * switched off by itself, so there is nothing to remember to remove on that date.
 */
const LEGACY_COOKIE = "kpp_session";
// A day of slack past the last possible lapse, in the dashboard's own timezone.
const LEGACY_COOKIE_RETIRES_AT = Date.parse("2026-09-19T00:00:00+08:00");
const LEGACY_SEAL_TTL_SECONDS = 60 * 60 * 24 * 14; // iron-session's default when those were sealed

type CookieStore = Awaited<ReturnType<typeof cookies>>;

function sessionOptions() {
  const password = process.env.SESSION_SECRET;
  // No fallback. A default baked into the source would let anyone who has read it
  // seal their own admin session whenever the variable goes missing.
  if (!password || password.length < 32) {
    throw new Error("SESSION_SECRET must be set to at least 32 characters");
  }
  return {
    password,
    // Renamed with the path change below, so a browser still holding the old
    // site-wide cookie doesn't send two cookies with one name.
    cookieName: "kick_dashboard_session",
    // How long the sealed session itself is honoured. iron-session defaults to
    // 14 days, so a copied cookie outlived its own 7-day maxAge.
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax" as const,
      // Scoped to this app. At "/" every other app on the domain received it.
      path: process.env.NEXT_PUBLIC_BASE_PATH || "/",
      maxAge: SESSION_TTL_SECONDS - 60,
    },
  };
}

/** Delete the old cookie where it was set. Only possible in a route handler; pages can't write cookies. */
function dropLegacyCookie(cookieStore: CookieStore): boolean {
  try {
    cookieStore.set(LEGACY_COOKIE, "", { path: "/", maxAge: 0 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign this request in from the old cookie, and move it to the new one where
 * possible. A page render can't write cookies, so there the session only lives
 * for the render; the page's first API call (every page makes one) completes
 * the move.
 */
async function adoptLegacySession(cookieStore: CookieStore, session: IronSession<SessionData>, password: string): Promise<void> {
  const sealed = cookieStore.get(LEGACY_COOKIE)?.value;
  if (!sealed) return;

  let legacy: SessionData;
  try {
    legacy = await unsealData<SessionData>(sealed, { password, ttl: LEGACY_SEAL_TTL_SECONDS });
  } catch {
    return;
  }
  if (!legacy.userId || !legacy.username) return;

  session.userId = legacy.userId;
  session.username = legacy.username;
  session.displayName = legacy.displayName;
  session.avatarUrl = legacy.avatarUrl;

  try {
    await session.save();
  } catch {
    return; // rendering a page: keep the old cookie until an API call can move it
  }
  dropLegacyCookie(cookieStore);
}

export async function getSession(): Promise<IronSession<SessionData>> {
  const cookieStore = await cookies();
  const options = sessionOptions();
  const session = await getIronSession<SessionData>(cookieStore, options);

  if (Date.now() >= LEGACY_COOKIE_RETIRES_AT) {
    // Every old cookie has lapsed by now; the migration no longer does anything.
  } else if (!session.userId) {
    await adoptLegacySession(cookieStore, session, options.password);
  } else if (cookieStore.get(LEGACY_COOKIE)) {
    // Already moved. A leftover old cookie would sign the user back in after logout.
    dropLegacyCookie(cookieStore);
  }
  return session;
}

export function isAdmin(userId: number): boolean {
  const adminId = parseInt(process.env.ADMIN_KICK_USER_ID ?? "3220408", 10);
  return userId === adminId;
}

/**
 * The leaderboard's own sign-in cookie (the user:read viewer app, lib/viewer-login). The two
 * sides never share one: bot management reads only getSession's cookie, so a viewer can't
 * open it, and a streamer there always comes through the streamer sign-in, the one that
 * renews their 30-day Kick grant. The leaderboard reads only this one.
 */
export async function getViewerSession(): Promise<IronSession<SessionData>> {
  const options = sessionOptions();
  // Its own key too, so a viewer cookie's value can't be passed off as the streamer cookie.
  return getIronSession<SessionData>(await cookies(), { ...options, password: `${options.password}:viewer`, cookieName: "kick_viewer_session" });
}

/** Who is signed in on the leaderboard, from its own cookie only. */
export async function leaderboardViewer(): Promise<{ userId: number; username: string } | null> {
  const s = await getViewerSession();
  return s.userId && s.username ? { userId: s.userId, username: s.username } : null;
}
