import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import crypto from "crypto";
import { KICK_SCOPES } from "@/lib/kick-scopes";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3008";
const CLIENT_ID = process.env.KICK_CLIENT_ID ?? "";

function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export async function GET(): Promise<NextResponse> {
  const state = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePKCE();

  const session = await getSession();
  session.oauthState = state;
  session.oauthCodeVerifier = codeVerifier;
  await session.save();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: `${BASE_URL}/api/auth/callback`,
    response_type: "code",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    scope: KICK_SCOPES,
  });

  return NextResponse.redirect(`https://id.kick.com/oauth/authorize?${params.toString()}`);
}
