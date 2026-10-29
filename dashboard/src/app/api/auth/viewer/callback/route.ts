import { NextRequest, NextResponse } from "next/server";
import { getViewerSession } from "@/lib/session";
import { VIEWER_CLIENT_ID, VIEWER_CLIENT_SECRET, viewerLoginEnabled } from "@/lib/viewer-login";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3008";

interface KickUser {
  user_id?: number;
  id?: number;
  username?: string;
  name?: string;
  slug?: string;
  profile_picture?: string;
}

// The viewer app's callback: signs the viewer in and goes back to the leaderboard they came
// from. Unlike /api/auth/callback it never hands a token to the bot service: a user:read
// token from the second app is no streamer grant, and it is dropped once we know who it is.
// It signs in to the viewer cookie only, so it never opens bot management.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const session = await getViewerSession();
  const back = `${BASE_URL}${session.oauthReturnTo ?? "/login"}`;
  const fail = (why: string) => NextResponse.redirect(`${back}${back.includes("?") ? "&" : "?"}signin=${encodeURIComponent(why)}`);

  if (!viewerLoginEnabled()) return fail("unavailable");
  if (searchParams.get("error")) return fail("cancelled");
  if (!code || !state || !session.oauthState || session.oauthState !== state || !session.oauthCodeVerifier) return fail("expired");
  const codeVerifier = session.oauthCodeVerifier;
  session.oauthState = undefined;
  session.oauthCodeVerifier = undefined;
  session.oauthReturnTo = undefined;

  let accessToken: string;
  try {
    const tokenRes = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: VIEWER_CLIENT_ID,
        client_secret: VIEWER_CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/api/auth/viewer/callback`,
        code,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}: ${await tokenRes.text()}`);
    accessToken = ((await tokenRes.json()) as { access_token: string }).access_token;
  } catch (e) {
    console.error("[KPP Auth] Viewer token exchange failed:", e);
    await session.save();
    return fail("failed");
  }

  let user: KickUser | undefined;
  try {
    const userRes = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!userRes.ok) throw new Error(`user fetch ${userRes.status}`);
    const body = (await userRes.json()) as { data: KickUser | KickUser[] };
    user = Array.isArray(body.data) ? body.data[0] : body.data;
  } catch (e) {
    console.error("[KPP Auth] Viewer user fetch failed:", e);
  }
  const userId = (user?.user_id ?? user?.id) as number | undefined;
  const username = (user?.username ?? user?.name ?? user?.slug ?? "").toLowerCase();
  if (!user || !userId || !username) {
    await session.save();
    return fail("failed");
  }

  session.userId = userId;
  session.username = username;
  session.displayName = user.name ?? username;
  session.avatarUrl = user.profile_picture;
  await session.save();
  console.log(`[KPP Auth] Viewer ${username} signed in from the leaderboard`);
  return NextResponse.redirect(back);
}
