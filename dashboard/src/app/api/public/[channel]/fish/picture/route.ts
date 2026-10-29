import { NextResponse } from "next/server";
import sharp from "sharp";
import { validChannel } from "@/lib/bot-auth";
import { getFishPicture } from "@/lib/bot-api";
import { leaderboardViewer } from "@/lib/session";

// The picture for a check the fishing page asked (community/trap-check.ts makeTapCheck),
// drawn here from the layout the bot keeps and sent as a PNG: the browser gets pixels,
// never where the fish are or which one to tap.
const W = 480;
const H = 300;
const COLORS: Record<string, string> = {
  red: "#ef4444", orange: "#f97316", yellow: "#eab308", green: "#22c55e", blue: "#3b82f6", purple: "#a855f7", pink: "#ec4899",
};

const r = (min: number, max: number) => min + Math.random() * (max - min);

/** One fish facing right (mirrored to face left), centred on 0,0, `w` wide; `striped` adds dark bands across its body. */
function fishSvg(cx: number, cy: number, w: number, left: boolean, color: string, striped = false, id = 0): string {
  const h = w * 0.55;
  const tilt = r(-10, 10).toFixed(1);
  const body = `<ellipse cx="${(-w * 0.08).toFixed(1)}" cy="0" rx="${(w * 0.4).toFixed(1)}" ry="${(h / 2).toFixed(1)}" fill="${color}"/>`;
  // A big forked tail, so which way it swims is plain at a glance.
  const tail = `<path d="M ${(-w * 0.38).toFixed(1)} 0 L ${(-w * 0.6).toFixed(1)} ${(-h * 0.5).toFixed(1)} L ${(-w * 0.53).toFixed(1)} 0 L ${(-w * 0.6).toFixed(1)} ${(h * 0.5).toFixed(1)} Z" fill="${color}"/>`;
  const fin = `<path d="M ${(-w * 0.12).toFixed(1)} ${(-h * 0.45).toFixed(1)} Q ${(w * 0.02).toFixed(1)} ${(-h * 0.85).toFixed(1)} ${(w * 0.12).toFixed(1)} ${(-h * 0.4).toFixed(1)} Z" fill="${color}" opacity="0.8"/>`;
  const stripes = striped
    ? `<clipPath id="b${id}"><ellipse cx="${(-w * 0.08).toFixed(1)}" cy="0" rx="${(w * 0.4).toFixed(1)}" ry="${(h / 2).toFixed(1)}"/></clipPath><g clip-path="url(#b${id})" fill="#0b1220" opacity="0.45">${[-0.3, -0.12, 0.06]
        .map((x) => `<rect x="${(w * x).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${(w * 0.07).toFixed(1)}" height="${h.toFixed(1)}"/>`)
        .join("")}</g>`
    : "";
  const eye = `<circle cx="${(w * 0.18).toFixed(1)}" cy="${(-h * 0.1).toFixed(1)}" r="${(w * 0.045).toFixed(1)}" fill="#0b1220"/>`;
  return `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${tilt}) scale(${left ? -1 : 1} 1)">${tail}${fin}${body}${stripes}${eye}</g>`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ channel: string }> }): Promise<NextResponse> {
  const { channel } = await params;
  const slug = channel.toLowerCase();
  const headers = { "Cache-Control": "private, no-store" };
  if (!validChannel(slug)) return NextResponse.json({ error: "Invalid channel" }, { status: 400, headers });
  const me = await leaderboardViewer().catch(() => null);
  if (!me) return NextResponse.json({ error: "Sign in to fish" }, { status: 401, headers });
  let scene: Awaited<ReturnType<typeof getFishPicture>>;
  try {
    scene = await getFishPicture(slug, me.userId, me.username);
  } catch {
    return NextResponse.json({ error: "No picture waiting" }, { status: 404, headers });
  }
  // Water, a few weeds and bubbles: noise around the fish, different every time it's drawn.
  const weeds = Array.from({ length: 6 }, () => {
    const x = r(0, W);
    return `<path d="M ${x.toFixed(0)} ${H} q ${r(-20, 20).toFixed(0)} ${r(-60, -30).toFixed(0)} ${r(-10, 10).toFixed(0)} ${r(-90, -50).toFixed(0)}" stroke="#14532d" stroke-width="${r(3, 6).toFixed(1)}" fill="none" opacity="0.7"/>`;
  }).join("");
  const bubbles = Array.from({ length: 18 }, () => `<circle cx="${r(0, W).toFixed(0)}" cy="${r(0, H).toFixed(0)}" r="${r(2, 7).toFixed(1)}" fill="none" stroke="#7dd3fc" stroke-width="1.2" opacity="${r(0.25, 0.6).toFixed(2)}"/>`).join("");
  const fish = scene.fish.map((f, i) => fishSvg(f.x * W, f.y * H, f.size * W, f.left, COLORS[f.color] ?? "#94a3b8", !!f.striped, i)).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0c4a6e"/><stop offset="1" stop-color="#082f49"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#sea)"/>${weeds}${bubbles}${fish}</svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return new NextResponse(new Uint8Array(png), { headers: { ...headers, "Content-Type": "image/png" } });
}
