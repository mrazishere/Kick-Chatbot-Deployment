// How long a Kick grant lives. Until Kick fixed it on 2026-07-16 (KickDevDocs issue #359),
// a refresh token died 30 days after the authorization whatever we did. It is now a sliding
// 30-day window: every refresh starts a new one, and token responses say how long it is in
// refresh_expires_in. So a grant only lapses if refreshing stops for that long.

/** Kick's sliding window, for a response that doesn't say. */
export const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** When the refresh token in this token response stops working, epoch ms. */
export function refreshExpiresAt(data: unknown, now = Date.now()): number {
  const s = (data as { refresh_expires_in?: unknown } | null)?.refresh_expires_in;
  return now + (typeof s === 'number' && s > 0 ? s * 1000 : REFRESH_WINDOW_MS);
}
