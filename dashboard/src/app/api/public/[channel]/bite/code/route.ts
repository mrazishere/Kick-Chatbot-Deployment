import { NextResponse } from "next/server";
import sharp from "sharp";
import { validChannel } from "@/lib/bot-auth";
import { getBigBiteCode } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";

// The code of the viewer's own big bite, drawn here and sent as a PNG, as the trap check's
// picture is: the browser gets pixels, never the code as text a script could read. Each
// character sits at its own tilt and height over a little noise, different every load.
const H = 110;
const r = (min: number, max: number) => min + Math.random() * (max - min);
const esc = (c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const headers = { "Cache-Control": "private, no-store" };
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400, headers });
  const me = await leaderboardViewer().catch(() => null);
  if (!me) return NextResponse.json({ error: "Sign in to fish" }, { status: 401, headers });
  let code: string;
  try {
    code = (await getBigBiteCode(slug, me.userId)).code;
  } catch {
    return NextResponse.json({ error: "No code showing" }, { status: 404, headers });
  }
  const chars = Array.from(code);
  const step = 62;
  const W = 40 + chars.length * step;
  const letters = chars
    .map((c, i) => {
      const x = 20 + step * i + step / 2 + r(-5, 5);
      const y = H / 2 + 22 + r(-8, 8);
      return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" transform="rotate(${r(-14, 14).toFixed(1)} ${x.toFixed(1)} ${(y - 22).toFixed(1)})" text-anchor="middle" font-family="DejaVu Sans Mono" font-weight="bold" font-size="${r(58, 66).toFixed(0)}" fill="#fde047" stroke="#713f12" stroke-width="1.5">${esc(c)}</text>`;
    })
    .join("");
  const lines = Array.from({ length: 4 }, () => `<path d="M 0 ${r(15, H - 15).toFixed(0)} Q ${(W / 2).toFixed(0)} ${r(0, H).toFixed(0)} ${W} ${r(15, H - 15).toFixed(0)}" stroke="#7dd3fc" stroke-width="${r(1.5, 3).toFixed(1)}" fill="none" opacity="0.45"/>`).join("");
  const bubbles = Array.from({ length: 14 }, () => `<circle cx="${r(0, W).toFixed(0)}" cy="${r(0, H).toFixed(0)}" r="${r(2, 6).toFixed(1)}" fill="none" stroke="#7dd3fc" stroke-width="1.2" opacity="${r(0.25, 0.55).toFixed(2)}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c4a6e"/><stop offset="1" stop-color="#082f49"/></linearGradient></defs>
<rect width="${W}" height="${H}" rx="10" fill="url(#sea)"/>${bubbles}${letters}${lines}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new NextResponse(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
}
