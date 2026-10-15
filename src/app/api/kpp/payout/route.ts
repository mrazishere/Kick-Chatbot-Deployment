import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { channelHasData, getPayouts, upsertPayout, validKppChannel } from "@/lib/kpp-data";
import { authorizeChannel } from "@/lib/bot-auth";
import { z } from "zod";

const PayoutSchema = z.object({
  channel: z.string().regex(/^[a-z0-9_]{1,30}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actualCents: z.number().int().min(0).nullable(),
  note: z.string().max(200).default(""),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Public and read-only.
  const channel = (req.nextUrl.searchParams.get("channel") ?? "").toLowerCase();
  if (!validKppChannel(channel)) {
    return NextResponse.json({ error: "Missing or invalid channel" }, { status: 400 });
  }
  return NextResponse.json({ payouts: getPayouts(channel) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSession();
  if (!session.userId || !session.username) {
    return NextResponse.json({ error: "Sign in to edit payout data" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = PayoutSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  const { channel, date, actualCents, note } = parsed.data;

  // Only a channel with KPP data: any Kick account can sign in, and its own name made a
  // payouts file (a fake channel on the admin page) for anyone (2026-10-16 audit).
  if (!channelHasData(channel)) {
    return NextResponse.json({ error: "No such channel" }, { status: 404 });
  }
  // Only the channel owner (by Kick user id, see authorizeChannel) or an admin can write payout data
  const authz = await authorizeChannel(channel);
  if (!authz.ok || !authz.auth.canAdminister) {
    return NextResponse.json({ error: "Not authorised to edit this channel" }, { status: 403 });
  }

  upsertPayout(channel, date, actualCents, note);
  return NextResponse.json({ payouts: getPayouts(channel) });
}
