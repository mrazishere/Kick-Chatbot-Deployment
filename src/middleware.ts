import { NextRequest, NextResponse } from "next/server";

/**
 * Refuse cross-origin writes to the API.
 *
 * The session cookie is SameSite=Lax. That stops other sites, but not another
 * origin on the same site (any subdomain), and no route checked where a write
 * came from — so a page there could have a signed-in owner restart the bot or
 * delete rewards. Browsers attach Origin to every POST, PATCH and DELETE, so a
 * write carrying a foreign Origin is refused here. Requests with no Origin at
 * all (curl, server-to-server) carry nobody's cookie and fall through to the
 * routes' normal sign-in checks.
 */
const PORT = process.env.PORT ?? "3008";
const ALLOWED_ORIGINS = new Set(
  [process.env.NEXT_PUBLIC_BASE_URL, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]
    .map((u) => {
      try {
        return u ? new URL(u).origin : "";
      } catch {
        return "";
      }
    })
    .filter(Boolean),
);

const refused = () => NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });

export function middleware(req: NextRequest): NextResponse {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return NextResponse.next();

  const origin = req.headers.get("origin");
  if (origin) return ALLOWED_ORIGINS.has(origin) ? NextResponse.next() : refused();

  // No Origin: fall back to Fetch Metadata where the client sends it.
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return refused();
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
