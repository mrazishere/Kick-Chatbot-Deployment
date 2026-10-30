import "server-only";
import * as fs from "fs";
import * as path from "path";

// The dashboard's lines in logs/web-fishing.log (sign-ins and sign-outs on the leaderboard),
// next to the bot service's moves and buys (src/community/web-fish.ts logWebFishing), in the same format.
const LOGS_DIR = process.env.LOGS_DIR ?? path.join(process.cwd(), "..", "logs");
const WEB_LOG = path.join(LOGS_DIR, "web-fishing.log");
const WEB_LOG_MAX = 5 * 1024 * 1024;

/** Local time as the pm2 logs print it: 2026-10-30 08:27:37. */
function stamp(d = new Date()): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The channel in a leaderboard path ("/leaderboard/sukasblood?tab=fishing"), or "?". */
export function channelOf(returnTo: string | null | undefined): string {
  return /^\/leaderboard\/([a-z0-9_]{1,25})/.exec(returnTo ?? "")?.[1] ?? "?";
}

/** One line in logs/web-fishing.log. Never throws: logging must not break a sign-in. */
export function logWebFishing(channel: string, username: string, what: string, detail: string): void {
  try {
    try {
      if (fs.statSync(WEB_LOG).size > WEB_LOG_MAX) fs.renameSync(WEB_LOG, `${WEB_LOG}.1`);
    } catch {
      // No file yet.
    }
    fs.mkdirSync(path.dirname(WEB_LOG), { recursive: true });
    fs.appendFileSync(WEB_LOG, `${stamp()} [${channel}] ${username} ${what}: ${detail.replace(/\s+/g, " ").trim()}\n`, "utf8");
  } catch (err) {
    console.error(`[web-fishing.log] write failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
