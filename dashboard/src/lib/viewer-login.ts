// Viewer sign-in on the public leaderboard, through a second Kick app that asks for
// user:read only. Chatters who just want their fishing gear see Kick ask to read their
// profile, not the streamer permissions (ban, chat, channel) the main sign-in needs, and
// it is a separate app, so it can never touch a streamer's bot grant on the main one.

export const VIEWER_CLIENT_ID = process.env.KICK_VIEWER_CLIENT_ID ?? "";
export const VIEWER_CLIENT_SECRET = process.env.KICK_VIEWER_CLIENT_SECRET ?? "";
export const VIEWER_SCOPES = "user:read";

/** Off until the second app's id and secret are set: the leaderboard then shows no viewer sign-in. */
export const viewerLoginEnabled = (): boolean => Boolean(VIEWER_CLIENT_ID && VIEWER_CLIENT_SECRET);

/** Only a channel's own leaderboard, with its query, is a place to come back to. */
const RETURN_TO = /^\/leaderboard\/[a-z0-9_]{1,25}(\?[A-Za-z0-9_=&%.\-]*)?$/;

export function safeReturnTo(path: string | null | undefined): string | null {
  return path && RETURN_TO.test(path) ? path : null;
}
