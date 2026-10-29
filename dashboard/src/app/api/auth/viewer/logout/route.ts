import { NextResponse } from "next/server";
import { getViewerSession } from "@/lib/session";
import { safeReturnTo } from "@/lib/viewer-login";

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3008";

// The leaderboard's sign-out: ends the viewer sign-in only (a streamer's bot management
// sign-in is its own cookie) and goes back to that leaderboard, a 303 so the browser GETs it.
export async function POST(req: Request): Promise<NextResponse> {
  const session = await getViewerSession();
  session.destroy();
  const form = await req.formData().catch(() => null);
  const raw = form?.get("next");
  const next = safeReturnTo(typeof raw === "string" ? raw : null);
  return NextResponse.redirect(`${BASE_URL}${next ?? "/login"}`, 303);
}
