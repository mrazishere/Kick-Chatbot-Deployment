import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { getViewerSession } from "@/lib/session";
import { safeReturnTo, VIEWER_CLIENT_ID, VIEWER_SCOPES, viewerLoginEnabled } from "@/lib/viewer-login";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3008";

// Viewer sign-in from a leaderboard: Kick's second app, user:read only (lib/viewer-login).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const returnTo = safeReturnTo(req.nextUrl.searchParams.get("next"));
  if (!viewerLoginEnabled()) return NextResponse.redirect(`${BASE_URL}${returnTo ?? "/login"}`);

  const state = crypto.randomBytes(16).toString("hex");
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");

  const session = await getViewerSession();
  session.oauthState = state;
  session.oauthCodeVerifier = codeVerifier;
  session.oauthReturnTo = returnTo ?? undefined;
  await session.save();

  const params = new URLSearchParams({
    client_id: VIEWER_CLIENT_ID,
    redirect_uri: `${BASE_URL}/api/auth/viewer/callback`,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: VIEWER_SCOPES,
  });
  return NextResponse.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
}
