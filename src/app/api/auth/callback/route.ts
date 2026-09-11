import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { storeChannelGrant, BotApiError } from "@/lib/bot-api";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3008";
const CLIENT_ID = process.env.KICK_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.KICK_CLIENT_SECRET ?? "";

interface KickTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

interface KickUser {
  user_id?: number;
  id?: number;
  username?: string;
  name?: string;
  slug?: string;
  profile_picture?: string;
}

interface KickUsersResponse {
  data: KickUser | KickUser[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = req.nextUrl;
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  const error = searchParams.get("error");

  const loginUrl = `${BASE_URL}/login`;

  if (error) {
    return NextResponse.redirect(`${loginUrl}?error=${encodeURIComponent(error)}`);
  }
  if (!code || !state) {
    return NextResponse.redirect(`${loginUrl}?error=missing_params`);
  }

  const session = await getSession();
  if (!session.oauthState || session.oauthState !== state || !session.oauthCodeVerifier) {
    return NextResponse.redirect(`${loginUrl}?error=state_mismatch`);
  }

  const codeVerifier = session.oauthCodeVerifier;
  session.oauthState = undefined;
  session.oauthCodeVerifier = undefined;

  // Exchange code for token (PKCE + client secret)
  let tokenData: KickTokenResponse;
  try {
    const tokenRes = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: `${BASE_URL}/api/auth/callback`,
        code,
        code_verifier: codeVerifier,
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text();
      console.error("[KPP Auth] Token exchange failed:", tokenRes.status, body);
      throw new Error(`Token exchange failed: ${tokenRes.status}`);
    }
    tokenData = (await tokenRes.json()) as KickTokenResponse;
  } catch (e) {
    console.error("[KPP Auth] Token exchange error:", e);
    return NextResponse.redirect(`${loginUrl}?error=token_exchange_failed`);
  }

  // Fetch user info — endpoint is /users (plural), returns data array
  let user: KickUser;
  try {
    const userRes = await fetch("https://api.kick.com/public/v1/users", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    if (!userRes.ok) {
      throw new Error(`User fetch failed: ${userRes.status}`);
    }
    const userBody = (await userRes.json()) as KickUsersResponse;
    // Response can be array or single object under data
    user = Array.isArray(userBody.data) ? userBody.data[0] : userBody.data;
    if (!user) throw new Error("Empty user data");
  } catch (e) {
    console.error("[KPP Auth] User fetch error:", e);
    return NextResponse.redirect(`${loginUrl}?error=user_fetch_failed`);
  }

  const userId = (user.user_id ?? user.id) as number;
  const username = (user.username ?? user.name ?? user.slug ?? "").toLowerCase();

  if (!userId || !username) {
    return NextResponse.redirect(`${loginUrl}?error=user_fetch_failed`);
  }

  session.userId = userId;
  session.username = username;
  session.displayName = user.name ?? username;
  session.avatarUrl = user.profile_picture;
  await session.save();

  // Signing in doubles as re-authorization for anyone who already runs the bot.
  // The login requests the same scope set as enrollment, so this token is a
  // full streamer grant — handing it to the bot service resets that channel's
  // 30-day clock, which is what stops the bot badge lapsing between logins.
  //
  // Only for a channel that is already enrolled. If it isn't, the token is
  // discarded here (as it always was) rather than banking credentials for
  // someone who may only be here to look at earnings charts. New channels go
  // through /kick-bot-enroll, which also needs the chatroom lookup and pm2 setup.
  if (tokenData.refresh_token) {
    try {
      await storeChannelGrant(username, {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
      });
      console.log(`[KPP Auth] Refreshed streamer grant for ${username} via login`);
    } catch (e) {
      // Never block sign-in on this. A 404 just means "not enrolled".
      if (!(e instanceof BotApiError && e.status === 404)) {
        console.error("[KPP Auth] Could not store streamer grant:", e);
      }
    }
  }

  // Bot management is the primary interface; KPP earnings hang off it.
  return NextResponse.redirect(`${BASE_URL}/${username}/bot`);
}
