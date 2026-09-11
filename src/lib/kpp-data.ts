import "server-only";
import fs from "fs";
import readline from "readline";
import path from "path";

const KPP_ROOT = process.env.KPP_ROOT ?? "/home/you/Kick-Chatbot-Deployment/data/kpp";
const LOGS_DIR = process.env.LOGS_DIR ?? "/home/you/Kick-Chatbot-Deployment/logs";

// Log timestamps are in Asia/Singapore (UTC+8)
const SGT_OFFSET_MS = 8 * 60 * 60 * 1000;

// Bots to exclude from chat activity counts
const BOT_USERNAMES = new Set(["mraiishere", "streamelements", "nightbot", "moobot"]);

// Chat line: "2026-05-30 12:35:50: [og,subscriber] username: message"
// Badge block is always lowercase letters/commas; system lines use uppercase words
const CHAT_LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}): \[([a-z,_]+)\] ([^:@][^:]*): /;

export interface ChatWindow {
  minuteOffset: number;
  label: string;          // "0:05", "1:30", etc.
  messages: number;
  uniqueChatters: number;
}

/** Parse log timestamp (SGT) to UTC milliseconds */
function logTsToMs(ts: string): number {
  // "2026-05-30 12:35:50" treated as SGT → subtract offset to get UTC ms
  return new Date(ts.replace(" ", "T") + "+08:00").getTime();
}

function windowLabel(offsetMin: number): string {
  const h = Math.floor(offsetMin / 60);
  const m = offsetMin % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

function adaptiveWindow(durationSeconds: number): number {
  const hours = durationSeconds / 3600;
  if (hours <= 3) return 5;
  if (hours <= 7) return 10;
  return 15;
}

export interface TimelinePoint {
  ts: string;      // ISO UTC
  viewers: number;
  chatters: number;
  mpm: number;
  authViewers?: number;
}

export interface TimelineSession {
  index: number;   // 0 = current, 1 = previous, 2 = two streams ago
  startedAt: string | null;
  points: TimelinePoint[];
}

function readTimelineFile(file: string): TimelinePoint[] {
  if (!fs.existsSync(file)) return [];
  const points: TimelinePoint[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { points.push(JSON.parse(line) as TimelinePoint); } catch { /* skip */ }
  }
  return points;
}

export function getTimelines(channel: string): TimelineSession[] {
  const safe = channel.replace(/[^a-zA-Z0-9_]/g, "");
  const base = path.join(KPP_ROOT, safe);
  const sessions: TimelineSession[] = [];

  // Current stream (index 0)
  const currentPoints = readTimelineFile(path.join(base, "timeline.jsonl"));
  if (currentPoints.length > 0) {
    sessions.push({ index: 0, startedAt: currentPoints[0].ts, points: currentPoints });
  }

  // Past streams (timeline-1.jsonl, timeline-2.jsonl)
  for (let i = 1; i <= 2; i++) {
    const pts = readTimelineFile(path.join(base, `timeline-${i}.jsonl`));
    if (pts.length > 0) {
      sessions.push({ index: i, startedAt: pts[0].ts, points: pts });
    }
  }

  return sessions;
}

/** Channel slugs as the bot writes them: the only names that ever become file paths here. */
export function validKppChannel(channel: string): boolean {
  return /^[a-z0-9_]{1,25}$/.test(channel);
}

/** Longest span one session-activity request scans. Longer ranges are cut off, not refused. */
const MAX_ACTIVITY_SPAN_MS = 48 * 60 * 60 * 1000;
/** Each request reads the channel's whole log, so only a few may run at once. */
const MAX_ACTIVITY_SCANS = 3;
const ACTIVITY_CACHE_MS = 5 * 60 * 1000;
const activityCache = new Map<string, { at: number; windows: ChatWindow[] }>();
let activityScans = 0;

export class ActivityBusyError extends Error {}

/**
 * Chat activity per window across a session, or null when the input is invalid.
 *
 * The route behind this is public, so every argument is checked before use: the
 * channel becomes a file path (a raw "../" reached other logs), and the span sets
 * how many windows are built (a 1970–275760 range ran the process out of memory).
 */
export async function getSessionChatActivity(
  channel: string,
  startedAt: string,   // ISO UTC
  endedAt: string,     // ISO UTC
  windowMinutes?: number
): Promise<ChatWindow[] | null> {
  if (!validKppChannel(channel)) return null;
  const sessionStartMs = Date.parse(startedAt);
  const requestedEndMs = Date.parse(endedAt);
  if (!Number.isFinite(sessionStartMs) || !Number.isFinite(requestedEndMs) || requestedEndMs <= sessionStartMs) {
    return null;
  }
  const sessionEndMs = Math.min(requestedEndMs, sessionStartMs + MAX_ACTIVITY_SPAN_MS);

  const cacheKey = `${channel}|${sessionStartMs}|${sessionEndMs}|${windowMinutes ?? ""}`;
  const cached = activityCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ACTIVITY_CACHE_MS) return cached.windows;

  const logPath = path.join(LOGS_DIR, `kick-${channel}-out.log`);
  if (!fs.existsSync(logPath)) return [];

  if (activityScans >= MAX_ACTIVITY_SCANS) throw new ActivityBusyError("Too many activity requests in progress");
  activityScans++;
  try {
    const windows = await scanChatActivity(logPath, sessionStartMs, sessionEndMs, windowMinutes);
    if (activityCache.size > 200) activityCache.clear();
    activityCache.set(cacheKey, { at: Date.now(), windows });
    return windows;
  } finally {
    activityScans--;
  }
}

async function scanChatActivity(
  logPath: string,
  sessionStartMs: number,
  sessionEndMs: number,
  windowMinutes?: number
): Promise<ChatWindow[]> {
  const durationSeconds = (sessionEndMs - sessionStartMs) / 1000;
  const winMin = windowMinutes ?? adaptiveWindow(durationSeconds);

  const windowMap = new Map<number, { messages: number; chatters: Set<string> }>();

  const stream = fs.createReadStream(logPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      const match = line.match(CHAT_LINE_RE);
      if (!match) continue;

      const lineMs = logTsToMs(match[1]);
      if (lineMs < sessionStartMs) continue;
      if (lineMs > sessionEndMs) break; // log is chronological — stop early

      const username = match[3].trim().toLowerCase();
      if (BOT_USERNAMES.has(username)) continue;

      const offsetMin = Math.floor((lineMs - sessionStartMs) / 60_000);
      const windowKey = Math.floor(offsetMin / winMin) * winMin;

      let w = windowMap.get(windowKey);
      if (!w) { w = { messages: 0, chatters: new Set() }; windowMap.set(windowKey, w); }
      w.messages++;
      w.chatters.add(username);
    }
  } finally {
    // Stopping early closes readline but not the file under it. Without this every
    // scan that ended before the log did left an open file and its buffer behind.
    rl.close();
    stream.destroy();
  }

  // Build a complete result covering the full session duration
  const totalMinutes = Math.ceil(durationSeconds / 60);
  const result: ChatWindow[] = [];
  for (let offset = 0; offset < totalMinutes; offset += winMin) {
    const w = windowMap.get(offset);
    result.push({
      minuteOffset: offset,
      label: windowLabel(offset),
      messages: w?.messages ?? 0,
      uniqueChatters: w?.chatters.size ?? 0,
    });
  }
  return result;
}

function dataDir(channel: string): string {
  // Sanitize: only allow alphanumeric + underscore channel names
  const safe = channel.replace(/[^a-zA-Z0-9_]/g, "");
  return path.join(KPP_ROOT, safe);
}

export function listChannels(): string[] {
  try {
    return fs.readdirSync(KPP_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export function channelHasData(channel: string): boolean {
  const dir = dataDir(channel);
  return fs.existsSync(path.join(dir, "sessions.json")) || fs.existsSync(path.join(dir, "current.json"));
}

export interface KPPSession {
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  avgViewers: number;
  peakViewers: number;
  viewerHours: number;
  uniqueChatters: number;
  totalMessages: number;
  chatActivityRate: number;
  chatActivityWeight: number;
  engagementScore: number;
  authenticatedViewerHours?: number;
  /** null when the channel has no calibrated KPP rate. */
  estimatedCents: number | null;
}

export interface LiveSession {
  startedAt: string;
  firstObservedAt: string;
  lastPolledAt: string;
  lastViewerCount: number;
  viewerHoursSum: number;
  peakViewers: number;
  chatRateSum: number;
  chatRateSampleCount: number;
  totalMessages: number;
  cumulativeChatters: Record<string, unknown>;
  windowChatters: Record<string, unknown>;
  chatterActiveWindows: Record<string, number>;
}

export interface Payout {
  date: string; // "YYYY-MM-DD" — matches the session's stream date
  actualCents: number | null;
  note: string;
}

function readJson<T>(channel: string, file: string): T | null {
  const full = path.join(dataDir(channel), file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJson(channel: string, file: string, data: unknown): void {
  const dir = dataDir(channel);
  fs.mkdirSync(dir, { recursive: true });
  // Through a rename, so a crash mid-write can't leave half a payouts file.
  const target = path.join(dir, file);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, target);
}

export function getSessions(channel: string): KPPSession[] {
  const sessions = readJson<KPPSession[]>(channel, "sessions.json");
  return Array.isArray(sessions) ? sessions : [];
}

export function getLiveSession(channel: string): LiveSession | null {
  return readJson<LiveSession>(channel, "current.json");
}

export function getPayouts(channel: string): Payout[] {
  const payouts = readJson<Payout[]>(channel, "payouts.json");
  return Array.isArray(payouts) ? payouts : [];
}

export function upsertPayout(channel: string, date: string, actualCents: number | null, note: string): void {
  // Read strictly. getPayouts turns an unreadable file into [], and saving over that
  // would replace the whole payout history with this one entry.
  const file = path.join(dataDir(channel), "payouts.json");
  let payouts: Payout[] = [];
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("payouts.json is not a list");
    payouts = parsed as Payout[];
  }
  const idx = payouts.findIndex((p) => p.date === date);
  if (idx >= 0) {
    payouts[idx] = { date, actualCents, note };
  } else {
    payouts.push({ date, actualCents, note });
  }
  payouts.sort((a, b) => a.date.localeCompare(b.date));
  writeJson(channel, "payouts.json", payouts);
}

/** null without a calibrated rate, like a finished session: a guessed rate is a made-up number. */
export function computeLiveEstimate(live: LiveSession, centsPerAuthVH: number | null): number | null {
  if (centsPerAuthVH == null) return null;
  const POLL_HOURS = 5 / 60;
  const totalWindows = Object.values(live.chatterActiveWindows).reduce((a, b) => a + b, 0);
  const authVH = totalWindows * POLL_HOURS;
  return Math.round(authVH * centsPerAuthVH);
}
