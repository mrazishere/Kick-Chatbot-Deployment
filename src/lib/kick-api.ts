import "server-only";

const CLIENT_ID = process.env.KICK_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET ?? "";
const API_BASE = "https://api.kick.com/public/v1";

// ─── App access token (client_credentials, cached in memory) ─────────────────

let _appToken: string | null = null;
let _appTokenExpiresAt = 0;
let _appTokenPending: Promise<string> | null = null;

/** Shared by concurrent callers, so a page listing several channels asks Kick for one token, not one each. */
async function getAppToken(): Promise<string> {
  if (_appToken && Date.now() < _appTokenExpiresAt - 60_000) return _appToken;

  if (!_appTokenPending) {
    _appTokenPending = (async () => {
      const res = await fetch("https://id.kick.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
        }),
      });

      if (!res.ok) throw new Error(`App token fetch failed: ${res.status}`);
      const data = (await res.json()) as { access_token: string; expires_in: number };
      _appToken = data.access_token;
      _appTokenExpiresAt = Date.now() + data.expires_in * 1000;
      return _appToken;
    })().finally(() => {
      _appTokenPending = null;
    });
  }
  return _appTokenPending;
}

/**
 * GET from Kick's public API with the app token. A 401 means Kick dropped the token
 * before its expiry: fetch a new one and retry once, instead of every lookup failing
 * until the old token's expiry time or a restart.
 */
async function kickGet(url: string, revalidate: number): Promise<Response> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${await getAppToken()}` },
    next: { revalidate },
  });
  if (res.status !== 401) return res;
  _appToken = null;
  return fetch(url, { headers: { Authorization: `Bearer ${await getAppToken()}` }, cache: "no-store" });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface KickChannelInfo {
  slug: string;
  streamTitle: string;
  description: string;
  bannerUrl: string | null;
  activeSubscribers: number;
  category: { id: number; name: string; thumbnail: string } | null;
  broadcasterUserId: number;
  streamUrl: string;
  vodsUrl: string;
  // Live fields from stream object
  isLive: boolean;
  viewerCount: number;
  thumbnailUrl: string | null;
  streamStartedAt: string | null;
}

export interface KickLiveInfo {
  isLive: boolean;
  viewerCount: number;
  thumbnailUrl: string | null;
  streamTitle: string;
  startedAt: string;
  category: { name: string } | null;
}

// ─── Channel info ─────────────────────────────────────────────────────────────

export async function fetchChannelInfo(slug: string): Promise<KickChannelInfo | null> {
  try {
    // 30s — channels endpoint has all live data including thumbnail
    const res = await kickGet(`${API_BASE}/channels?slug=${encodeURIComponent(slug)}`, 30);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: Array<{
        broadcaster_user_id: number;
        slug: string;
        stream_title: string;
        channel_description: string;
        banner_picture: string | null;
        active_subscribers_count: number;
        category?: { id: number; name: string; thumbnail: string } | null;
        stream?: {
          is_live?: boolean;
          viewer_count?: number;
          start_time?: string;
          thumbnail?: string | null;
        } | null;
      }>;
    };
    const ch = body.data?.[0];
    if (!ch) return null;
    const stream = ch.stream;
    return {
      slug: ch.slug,
      streamTitle: ch.stream_title,
      description: ch.channel_description,
      bannerUrl: ch.banner_picture || null,
      activeSubscribers: ch.active_subscribers_count,
      category: ch.category?.id ? ch.category : null,
      broadcasterUserId: ch.broadcaster_user_id,
      streamUrl: `https://kick.com/${ch.slug}`,
      vodsUrl: `https://kick.com/${ch.slug}/videos`,
      isLive: stream?.is_live === true,
      viewerCount: stream?.viewer_count ?? 0,
      thumbnailUrl: stream?.thumbnail || null,
      streamStartedAt: stream?.start_time && stream.start_time !== "0001-01-01T00:00:00Z"
        ? stream.start_time
        : null,
    };
  } catch {
    return null;
  }
}

// ─── Profile photos ───────────────────────────────────────────────────────────

/**
 * A Kick user's profile photo. Kick answers a user with no photo of their own with
 * its default avatar URL rather than nothing, so null only means the lookup failed.
 */
export async function fetchUserAvatar(userId: number): Promise<string | null> {
  try {
    // An hour: photos rarely change, and the header asks on every page load.
    const res = await kickGet(`${API_BASE}/users?id=${encodeURIComponent(String(userId))}`, 3600);
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ user_id?: number; profile_picture?: string | null }> };
    const user = body.data?.find((u) => u.user_id === userId) ?? body.data?.[0];
    return user?.profile_picture || null;
  } catch {
    return null;
  }
}

// ─── VOD scrape from the videos page HTML ────────────────────────────────────
// Kick's /videos page is Next.js — video data lives in <script id="__NEXT_DATA__">.
// This works server-side as long as Cloudflare doesn't challenge the request.

export interface ScrapedVod {
  uuid: string;
  title: string;
  createdAt: string; // ISO
  duration: number;
  url: string;
}

// Internal enrollment service port — same server, not exposed via nginx
const ENROLLMENT_PORT = process.env.ENROLLMENT_PORT ?? "3006";

export async function scrapeVods(slug: string): Promise<ScrapedVod[]> {
  try {
    const res = await fetch(
      `http://localhost:${ENROLLMENT_PORT}/internal/vods/${encodeURIComponent(slug)}`,
      { next: { revalidate: 120 } }
    );
    if (!res.ok) return [];
    const { vods } = (await res.json()) as { vods?: ScrapedVod[] };
    return vods ?? [];
  } catch {
    return [];
  }
}

// ─── Live stream info ─────────────────────────────────────────────────────────

export async function fetchLiveInfo(broadcasterUserId: number): Promise<KickLiveInfo> {
  try {
    const res = await kickGet(`${API_BASE}/livestreams?broadcaster_user_id=${broadcasterUserId}`, 30); // 30s cache
    if (!res.ok) return { isLive: false, viewerCount: 0, thumbnailUrl: null, streamTitle: "", startedAt: "", category: null };
    const body = (await res.json()) as {
      data?: Array<{
        viewer_count: number;
        thumbnail: string | null;
        stream_title: string;
        started_at: string;
        category?: { name: string } | null;
      }>;
    };
    const stream = body.data?.[0];
    if (!stream) return { isLive: false, viewerCount: 0, thumbnailUrl: null, streamTitle: "", startedAt: "", category: null };
    return {
      isLive: true,
      viewerCount: stream.viewer_count,
      thumbnailUrl: stream.thumbnail ?? null,
      streamTitle: stream.stream_title,
      startedAt: stream.started_at,
      category: stream.category ?? null,
    };
  } catch {
    return { isLive: false, viewerCount: 0, thumbnailUrl: null, streamTitle: "", startedAt: "", category: null };
  }
}
