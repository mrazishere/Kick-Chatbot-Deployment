import { NextResponse } from "next/server";
import {
  deleteCustomCommand,
  getCustomCommands,
  saveCustomCommand,
  type CustomCommandInput,
} from "@/lib/bot-api";
import { authorizeChannel, errorResponse, validChannel } from "@/lib/bot-auth";

type Params = { params: Promise<{ channel: string }> };

// Managers may edit these as well as the owner: moderators can already do the
// same from chat with !acomm / !ecomm / !dcomm. The bot service validates the
// fields, so this layer only checks shape and who is asking.

export async function GET(_req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  try {
    return NextResponse.json(await getCustomCommands(channel));
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.name !== "string" || typeof body.access !== "string" || typeof body.response !== "string") {
    return NextResponse.json({ error: "name, access and response are required" }, { status: 400 });
  }

  const input: CustomCommandInput = {
    name: body.name,
    access: body.access as CustomCommandInput["access"],
    response: body.response,
    ...(typeof body.counter === "number" ? { counter: body.counter } : {}),
    ...(typeof body.originalName === "string" ? { originalName: body.originalName } : {}),
  };

  try {
    const result = await saveCustomCommand(channel, input);
    const verb = input.originalName ? "updated" : "added";
    console.log(`[dashboard] ${gate.auth.username} ${verb} ${channel} custom command !${input.name}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, { params }: Params): Promise<NextResponse> {
  const { channel: raw } = await params;
  const channel = raw.toLowerCase();
  if (!validChannel(channel)) {
    return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
  }

  const gate = await authorizeChannel(channel);
  if (!gate.ok) return gate.response;

  const name = new URL(req.url).searchParams.get("name") ?? "";
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const result = await deleteCustomCommand(channel, name);
    console.log(`[dashboard] ${gate.auth.username} deleted ${channel} custom command !${name}`);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
