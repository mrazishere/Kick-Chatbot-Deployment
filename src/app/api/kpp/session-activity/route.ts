import { NextRequest, NextResponse } from "next/server";
import { ActivityBusyError, getSessionChatActivity } from "@/lib/kpp-data";

// Public and read-only. getSessionChatActivity validates everything it's given.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const channel = (params.get("channel") ?? "").toLowerCase();
  const startedAt = params.get("start");
  const endedAt = params.get("end");

  if (!channel || !startedAt || !endedAt) {
    return NextResponse.json({ error: "Missing channel, start, or end" }, { status: 400 });
  }

  try {
    const windows = await getSessionChatActivity(channel, startedAt, endedAt);
    if (windows === null) {
      return NextResponse.json({ error: "Invalid channel, start, or end" }, { status: 400 });
    }
    return NextResponse.json({ windows });
  } catch (e) {
    if (e instanceof ActivityBusyError) {
      return NextResponse.json({ error: "Busy — try again in a moment" }, { status: 503 });
    }
    throw e;
  }
}
