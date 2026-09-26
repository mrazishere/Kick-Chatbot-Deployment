/**
 * Reading chat back out of a channel's PM2 log.
 *
 * The bot prints every chat message as "[badges] username: message", and PM2
 * prefixes the line with its local timestamp. That log is the only record of
 * chat text the bot keeps: !chatsummary tails it, and lastseen backfills from it
 * once so first-seen dates reach back past the day the table was created.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { SYSTEM_BOTS } from '../system-bots';
import { isBotSender } from '../bot-identity';

export interface ChatLine {
  /** Epoch ms, from the log's local-time stamp. */
  at: number;
  username: string;
  badges: string[];
  text: string;
}

// "YYYY-MM-DD HH:MM:SS: [badges] username: message". A viewer with no badges has
// no bracket, and badge names carry underscores (sub_gifter). Same shape claude.ts reads.
const CHAT_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): (?:\[([a-z0-9_]+(?:,[a-z0-9_]+)*)\] )?([A-Za-z0-9_]{2,25}): (.*)$/;
// A native reply is logged as a prefix on the message; it isn't what the viewer typed.
const REPLY_PREFIX_RE = /^\[↩ reply to [^\]]*\] /;

export function channelLogPath(channel: string): string {
  const clean = channel.replace(/^#/, '').toLowerCase();
  return path.join(__dirname, '..', '..', 'logs', `kick-${clean}-out.log`);
}

export function parseChatLine(line: string): ChatLine | null {
  const m = CHAT_LINE_RE.exec(line);
  if (!m) return null;
  // PM2 writes local time without a zone, which is how Date reads "YYYY-MM-DDTHH:MM:SS".
  const at = new Date(m[1].replace(' ', 'T')).getTime();
  if (!Number.isFinite(at)) return null;
  return { at, username: m[3], badges: m[2] ? m[2].split(',') : [], text: m[4].replace(REPLY_PREFIX_RE, '') };
}

/** KickBot and friends carry no bot badge, and neither do this bot's own messages. */
function isBotLine(c: ChatLine): boolean {
  return c.badges.includes('bot') || SYSTEM_BOTS.has(c.username.toLowerCase()) || isBotSender(c.username);
}

/** The chat lines in the last `bytes` of the log, oldest first. Bot accounts are left out. */
export function tailChat(channel: string, bytes: number): ChatLine[] {
  const file = channelLogPath(channel);
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // The first line is usually cut mid-way by the byte offset.
    if (len < size) lines.shift();
    const out: ChatLine[] = [];
    for (const l of lines) {
      const c = parseChatLine(l);
      if (c && !isBotLine(c)) out.push(c);
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Every chat line in the log, oldest first, streamed so an 80 MB log isn't held in memory. */
export async function scanChat(channel: string, onLine: (c: ChatLine) => void): Promise<number> {
  const file = channelLogPath(channel);
  if (!fs.existsSync(file)) return 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let n = 0;
  for await (const l of rl) {
    const c = parseChatLine(l);
    if (c && !isBotLine(c)) {
      onLine(c);
      n++;
    }
  }
  return n;
}
