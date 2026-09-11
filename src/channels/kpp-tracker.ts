/**
 * KPPTracker — engagement-weighted earnings estimator for Kick's KPP program.
 *
 * Background (from the KPP explainer reel transcribed 2026-05-25):
 *   KPP isn't a flat $/viewer/hour. It's a monthly pool, distributed by:
 *     share = (your_engagement_score / total_platform_engagement_score) × pool
 *     score = authentic_watch_time × chat_activity_weight × viewer_trust_factor
 *   Viewer trust factor is server-side at Kick — we can't measure it.
 *   We approximate score = viewer_hours × chat_activity_weight.
 *
 * This tracker runs in parallel to EarningsTracker. It polls the same Kick
 * channel endpoint to detect live/offline transitions, and additionally
 * accepts chat messages via recordChat() to count unique chatters + messages.
 *
 * Math:
 *   viewer_hours        = Σ (avg(prev, curr) × interval_hours)
 *   chat_activity_rate  = unique_chatters / avg_viewers
 *   chat_activity_weight = clamp(chat_activity_rate / chatNormalRate, 0.2, 2.5)
 *   engagement_score    = viewer_hours × chat_activity_weight
 *   estimated_cents     = engagement_score × dollarPerScore × 100  (null if uncalibrated)
 *
 * The clamp prevents extreme outliers: dead chat caps the penalty at 0.2×,
 * hyper-active chat caps the boost at 2.5×. KPP's real curve is unknown but
 * almost certainly bounded too.
 *
 * Storage:
 *   data/kpp/<channel>/current.json   (live session)
 *   data/kpp/<channel>/sessions.json  (finalized sessions, append-only)
 *
 * Calibration:
 *   channel-configs/<channel>.json -> kpp.dollarPerScore
 *   Set after receiving one real KPP payout: dollarPerScore = paid_cents / sum(engagementScore)
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CurrentKPPSession, FinalizedKPPSession, KPPConfig } from '../types';
import KickAuth = require('../auth');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BACKFILL_HOURS = 24;
const MID_STREAM_JOIN_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_CHAT_NORMAL_RATE = 0.09;   // midpoint of reel's 4–14% normal band
const CHAT_WEIGHT_FLOOR = 0.2;
const CHAT_WEIGHT_CEILING = 2.5;

interface KickStream {
  viewer_count?: number;
  start_time?: string;
  is_live?: boolean;
}

interface KickChannelData {
  stream?: KickStream | null;
}

interface KickChannelsResponse {
  data?: KickChannelData[];
}

const TIMELINE_MINUTE_MS = 60_000;
const TIMELINE_KEEP_STREAMS = 2; // retain last N streams at 1-min resolution

// Chat counts are written to current.json at most this often. If the process
// dies, at most this much chat goes uncounted.
const CHAT_FLUSH_MS = 2000;

/**
 * Replace a file through a rename. The dashboard reads these files while they're
 * being written. A crash mid-write also used to leave a truncated current.json,
 * which reads as "no session", so the next poll started a fresh session and
 * everything the stream had counted so far was lost.
 */
function writeFileAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export class KPPTracker {
  private channelName: string;
  private auth: InstanceType<typeof KickAuth>;
  private dataDir: string;
  private currentFile: string;
  private sessionsFile: string;
  private timelineFile: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private minuteInterval: NodeJS.Timeout | null = null;
  private getConfig: () => KPPConfig | undefined;

  // In-memory per-minute counters — no file I/O per chat message
  private minuteChatters = new Set<string>();
  private minuteMessages = 0;

  // Chat not yet written to current.json. recordChat used to read, parse and
  // rewrite the whole session, every chatter's counts included, for each chat
  // message. Counts now collect here and flushChat writes them in batches.
  private pendingChatters = new Map<string, number>();
  private pendingMessages = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(channelName: string, tokenFilePath: string, getConfig: () => KPPConfig | undefined) {
    this.channelName = channelName;
    this.auth = new KickAuth(tokenFilePath);
    this.getConfig = getConfig;
    this.dataDir = path.join(process.cwd(), 'data', 'kpp', channelName);
    this.currentFile = path.join(this.dataDir, 'current.json');
    this.sessionsFile = path.join(this.dataDir, 'sessions.json');
    this.timelineFile = path.join(this.dataDir, 'timeline.jsonl');
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.sessionsFile)) {
      writeFileAtomic(this.sessionsFile, '[]');
    }
  }

  async start(): Promise<void> {
    console.log(`[KPP] Tracker starting for ${this.channelName} — polling every ${POLL_INTERVAL_MS / 60000}m, timeline every 1m`);
    await this.pollOnce();
    this.pollInterval = setInterval(() => {
      this.pollOnce().catch(err => {
        if (err instanceof Error) console.error('[KPP] Poll failed:', err.message);
      });
    }, POLL_INTERVAL_MS);
    // 1-minute timeline snapshots — in-memory counters, no extra API call
    this.minuteInterval = setInterval(() => this.recordMinuteSnapshot(), TIMELINE_MINUTE_MS);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.minuteInterval) {
      clearInterval(this.minuteInterval);
      this.minuteInterval = null;
    }
    this.flushChat();
    console.log('[KPP] Tracker stopped');
  }

  private recordMinuteSnapshot(): void {
    const current = this.readCurrent();
    if (!current) { this.minuteChatters.clear(); this.minuteMessages = 0; return; }

    // Estimate authenticated organic viewers from accumulated auth window data.
    // authVH / totalVH gives the session's auth rate; apply to current viewer count.
    const activeWindows = current.chatterActiveWindows ?? {};
    const totalActiveWindows = Object.values(activeWindows).reduce((a: number, b: number) => a + b, 0);
    const authVH = totalActiveWindows * (POLL_INTERVAL_MS / 3_600_000);
    const authViewers = current.viewerHoursSum > 0
      ? Math.round((authVH / current.viewerHoursSum) * current.lastViewerCount)
      : 0;

    const snapshot = JSON.stringify({
      ts: new Date().toISOString(),
      viewers: current.lastViewerCount,
      chatters: this.minuteChatters.size,
      mpm: this.minuteMessages,
      authViewers,
    });
    fs.appendFileSync(this.timelineFile, snapshot + '\n');
    this.minuteChatters.clear();
    this.minuteMessages = 0;
  }

  private rotateTimeline(): void {
    // Keep TIMELINE_KEEP_STREAMS archived timelines; drop the oldest
    for (let i = TIMELINE_KEEP_STREAMS; i >= 1; i--) {
      const older = this.timelineFile.replace('.jsonl', `-${i + 1}.jsonl`);
      const newer = this.timelineFile.replace('.jsonl', `-${i}.jsonl`);
      if (i === TIMELINE_KEEP_STREAMS && fs.existsSync(older)) fs.unlinkSync(older);
      if (fs.existsSync(newer)) fs.renameSync(newer, older);
    }
    if (fs.existsSync(this.timelineFile)) {
      fs.renameSync(this.timelineFile, this.timelineFile.replace('.jsonl', '-1.jsonl'));
    }
  }

  private isEnabled(): boolean {
    return this.getConfig()?.enabled === true;
  }

  // Called by the chat handler for every non-bot user message.
  // No-ops when disabled; chat with no active session is dropped at flush time.
  recordChat(username: string): void {
    if (!this.isEnabled()) return;
    if (!username) return;
    const key = username.toLowerCase();
    this.pendingChatters.set(key, (this.pendingChatters.get(key) ?? 0) + 1);
    this.pendingMessages++;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushChat(), CHAT_FLUSH_MS);
    }
    // In-memory per-minute counters (no file I/O per message). Anything counted
    // outside a session is cleared by recordMinuteSnapshot or at session start.
    this.minuteChatters.add(key);
    this.minuteMessages++;
  }

  /**
   * Write batched chat counts into the live session. Also runs at the start of
   * every poll, so a poll always sees chat that arrived before it. With no
   * session, the counts are dropped, just as recordChat used to drop them.
   * Never throws: it runs from a timer, and a throw there would take the bot down.
   */
  private flushChat(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingMessages === 0) return;
    const chatters = this.pendingChatters;
    const messages = this.pendingMessages;
    this.pendingChatters = new Map();
    this.pendingMessages = 0;

    const current = this.readCurrent();
    if (!current) return;
    for (const [key, n] of chatters) {
      current.cumulativeChatters[key] = (current.cumulativeChatters[key] || 0) + n;
      current.windowChatters[key] = (current.windowChatters[key] || 0) + n;
    }
    current.windowMessages = (current.windowMessages ?? 0) + messages;
    current.totalMessages += messages;
    try {
      this.writeCurrent(current);
    } catch (err) {
      console.error(`[KPP] Could not save ${messages} chat message(s):`, err instanceof Error ? err.message : String(err));
    }
  }

  private async fetchLivestream(): Promise<KickStream | null> {
    const token = this.auth.loadAccessToken();
    if (!token) throw new Error('No access token available');
    const response = await axios.get<KickChannelsResponse>(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(this.channelName)}`,
      {
        timeout: 15000,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
      }
    );
    return response.data?.data?.[0]?.stream ?? null;
  }

  private readCurrent(): CurrentKPPSession | null {
    try {
      if (!fs.existsSync(this.currentFile)) return null;
      return JSON.parse(fs.readFileSync(this.currentFile, 'utf8')) as CurrentKPPSession;
    } catch (err) {
      if (err instanceof Error) console.error('[KPP] Failed to read current session:', err.message);
      return null;
    }
  }

  private writeCurrent(session: CurrentKPPSession): void {
    writeFileAtomic(this.currentFile, JSON.stringify(session, null, 2));
  }

  private deleteCurrent(): void {
    if (fs.existsSync(this.currentFile)) fs.unlinkSync(this.currentFile);
  }

  private appendSession(session: FinalizedKPPSession): void {
    let sessions: FinalizedKPPSession[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf8'));
      if (Array.isArray(parsed)) sessions = parsed as FinalizedKPPSession[];
    } catch (err) {
      if (err instanceof Error) console.error('[KPP] sessions.json unreadable, starting fresh:', err.message);
    }
    sessions.push(session);
    writeFileAtomic(this.sessionsFile, JSON.stringify(sessions, null, 2));
  }

  private hoursBetween(fromIso: string, toMs: number): number {
    const ms = toMs - new Date(fromIso).getTime();
    if (ms <= 0) return 0;
    return Math.min(ms / 3_600_000, MAX_BACKFILL_HOURS);
  }

  private computeFinalized(
    current: CurrentKPPSession,
    endedAtMs: number,
    finalIntervalHours: number,
    finalViewerCount: number
  ): FinalizedKPPSession {
    const cfg = this.getConfig() || {};
    const chatNormalRate = cfg.chatNormalRate ?? DEFAULT_CHAT_NORMAL_RATE;
    const dollarPerScore = cfg.dollarPerScore ?? null;
    const centsPerAuthVH = cfg.centsPerAuthViewerHour ?? null;

    // Final interval — final viewer count held to end
    const finalViewerHours = finalViewerCount * finalIntervalHours;
    const viewerHours = current.viewerHoursSum + finalViewerHours;

    const startedAtMs = new Date(current.startedAt).getTime();
    const durationSeconds = Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
    const durationHours = durationSeconds / 3600;
    const avgViewers = durationHours > 0 ? viewerHours / durationHours : 0;
    const uniqueChatters = Object.keys(current.cumulativeChatters).length;

    // chat activity rate = mean of per-window (window_chatters / concurrent_viewers) samples.
    // This is the concurrent-participation rate that aligns with the reel's 4–14% framing.
    const chatActivityRate = current.chatRateSampleCount > 0
      ? current.chatRateSum / current.chatRateSampleCount
      : 0;
    const rawWeight = chatActivityRate / chatNormalRate;
    const chatActivityWeight = Math.min(CHAT_WEIGHT_CEILING, Math.max(CHAT_WEIGHT_FLOOR, rawWeight));

    const engagementScore = viewerHours * chatActivityWeight;

    // Authenticated viewer hours: sum of per-user active windows × window duration.
    const windowHours = POLL_INTERVAL_MS / 3_600_000;
    const activeWindows = current.chatterActiveWindows || {};
    const totalActiveWindows = Object.values(activeWindows).reduce((a, b) => a + b, 0);
    const authenticatedViewerHours = Math.round(totalActiveWindows * windowHours * 10) / 10;

    // Prefer auth model when calibrated, fall back to old engagementScore model.
    let estimatedCents: number | null = null;
    if (centsPerAuthVH != null) {
      estimatedCents = Math.round(authenticatedViewerHours * centsPerAuthVH);
    } else if (dollarPerScore != null) {
      estimatedCents = Math.round(engagementScore * dollarPerScore * 100);
    }

    return {
      startedAt: current.startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationSeconds,
      avgViewers: Math.round(avgViewers * 10) / 10,
      peakViewers: current.peakViewers,
      viewerHours: Math.round(viewerHours * 10) / 10,
      uniqueChatters,
      totalMessages: current.totalMessages,
      chatActivityRate: Math.round(chatActivityRate * 10000) / 10000,
      chatActivityWeight: Math.round(chatActivityWeight * 1000) / 1000,
      engagementScore: Math.round(engagementScore * 10) / 10,
      authenticatedViewerHours,
      estimatedCents
    };
  }

  private seedActiveWindows(current: CurrentKPPSession): Record<string, number> {
    const windows: Record<string, number> = {};
    const numWindows = current.chatRateSampleCount;
    if (numWindows <= 0) return windows;

    const durationHours = this.hoursBetween(current.startedAt, Date.now());
    const avgViewers = durationHours > 0 ? current.viewerHoursSum / durationHours : 0;
    const avgChatRate = current.chatRateSum / numWindows;
    const avgWindowChatters = avgChatRate * avgViewers;
    const totalSlots = avgWindowChatters * numWindows;
    const avgMsgsPerSlot = totalSlots > 0 ? current.totalMessages / totalSlots : 1;

    for (const [user, msgs] of Object.entries(current.cumulativeChatters)) {
      windows[user] = Math.min(Math.max(1, Math.round(msgs / avgMsgsPerSlot)), numWindows);
    }
    return windows;
  }

  private async pollOnce(): Promise<void> {
    if (!this.isEnabled()) return;
    let stream: KickStream | null;
    try {
      stream = await this.fetchLivestream();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[KPP] Fetch failed, skipping poll:', reason);
      return;
    }

    const isLive = stream?.is_live === true;
    const viewers = stream?.viewer_count ?? 0;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    // Land batched chat first, so this poll's window, and a session it finalizes, include it.
    this.flushChat();
    const current = this.readCurrent();

    if (isLive && !current) {
      const newSession: CurrentKPPSession = {
        startedAt: stream?.start_time ?? nowIso,
        firstObservedAt: nowIso,
        lastPolledAt: nowIso,
        lastViewerCount: viewers,
        viewerHoursSum: 0,
        peakViewers: viewers,
        cumulativeChatters: {},
        windowChatters: {},
        chatterActiveWindows: {},
        chatRateSum: 0,
        chatRateSampleCount: 0,
        totalMessages: 0
      };
      this.rotateTimeline(); // archive previous stream's timeline, drop oldest if > TIMELINE_KEEP_STREAMS
      this.minuteChatters.clear();
      this.minuteMessages = 0;
      this.writeCurrent(newSession);
      const joinedLate = nowMs - new Date(newSession.startedAt).getTime() > MID_STREAM_JOIN_THRESHOLD_MS;
      console.log(`[KPP] Session STARTED — ${viewers} viewers${joinedLate ? ' (joined mid-stream — will discard on finalize)' : ''}`);
      return;
    }

    if (isLive && current) {
      const hoursElapsed = this.hoursBetween(current.lastPolledAt, nowMs);
      const avgViewers = (current.lastViewerCount + viewers) / 2;
      current.viewerHoursSum += avgViewers * hoursElapsed;

      // Sample concurrent chat rate for this window before resetting it.
      // Rate = unique chatters in last poll interval / current viewer count.
      const windowUniques = Object.keys(current.windowChatters).length;
      if (viewers > 0) {
        const windowRate = windowUniques / viewers;
        current.chatRateSum += windowRate;
        current.chatRateSampleCount++;
      }

      // Track per-user active windows before resetting.
      // Seed from cumulativeChatters on first poll after upgrade/restart.
      if (!current.chatterActiveWindows) {
        current.chatterActiveWindows = this.seedActiveWindows(current);
        console.log(`[KPP] Seeded chatterActiveWindows for ${Object.keys(current.chatterActiveWindows).length} users from cumulative data`);
      }
      for (const user of Object.keys(current.windowChatters)) {
        current.chatterActiveWindows[user] = (current.chatterActiveWindows[user] || 0) + 1;
      }

      current.windowChatters = {};
      current.windowMessages = 0;

      current.lastPolledAt = nowIso;
      current.lastViewerCount = viewers;
      current.peakViewers = Math.max(current.peakViewers, viewers);
      this.writeCurrent(current);

      const totalActiveWindows = Object.values(current.chatterActiveWindows).reduce((a, b) => a + b, 0);
      const authVH = totalActiveWindows * (POLL_INTERVAL_MS / 3_600_000);
      const runningRate = current.chatRateSampleCount > 0
        ? current.chatRateSum / current.chatRateSampleCount : 0;
      const cumulative = Object.keys(current.cumulativeChatters).length;
      console.log(
        `[KPP] +${(avgViewers * hoursElapsed).toFixed(1)}vh — window ${windowUniques} chatters/${viewers} viewers (${((windowUniques/Math.max(1,viewers))*100).toFixed(1)}%), running avg ${(runningRate*100).toFixed(2)}%, cumulative ${cumulative} chatters, authVH ${authVH.toFixed(1)}`
      );
      return;
    }

    if (!isLive && current) {
      const startedAtMs = new Date(current.startedAt).getTime();
      const firstObservedMs = new Date(current.firstObservedAt).getTime();
      if (firstObservedMs - startedAtMs > MID_STREAM_JOIN_THRESHOLD_MS) {
        this.deleteCurrent();
        const lagMin = Math.round((firstObservedMs - startedAtMs) / 60000);
        console.log(`[KPP] Session DISCARDED — joined mid-stream (${lagMin}m after start_time)`);
        return;
      }

      // Same midpoint-estimate trick as EarningsTracker — true end was likely
      // between last-seen-live poll and offline detection.
      const lastSeenLiveMs = new Date(current.lastPolledAt).getTime();
      const endedAtMs = Math.round((lastSeenLiveMs + nowMs) / 2);
      const finalIntervalHours = this.hoursBetween(current.lastPolledAt, endedAtMs);

      // Final-window sample using the last-known viewer count (we no longer see
      // a live viewer reading — stream went offline).
      const finalWindowUniques = Object.keys(current.windowChatters).length;
      if (current.lastViewerCount > 0) {
        current.chatRateSum += finalWindowUniques / current.lastViewerCount;
        current.chatRateSampleCount++;
      }

      // Accumulate final window's chatters into active windows.
      if (!current.chatterActiveWindows) {
        current.chatterActiveWindows = this.seedActiveWindows(current);
      }
      for (const user of Object.keys(current.windowChatters)) {
        current.chatterActiveWindows[user] = (current.chatterActiveWindows[user] || 0) + 1;
      }

      const finalized = this.computeFinalized(current, endedAtMs, finalIntervalHours, current.lastViewerCount);
      this.appendSession(finalized);
      this.deleteCurrent();

      const dollarPart = finalized.estimatedCents != null
        ? `$${(finalized.estimatedCents / 100).toFixed(2)}`
        : '$ pending calibration';
      console.log(
        `[KPP] Session ENDED — score ${finalized.engagementScore} (${finalized.viewerHours}vh × ${finalized.chatActivityWeight} chat-weight), authVH ${finalized.authenticatedViewerHours}, ${finalized.uniqueChatters} unique chatters (${(finalized.chatActivityRate * 100).toFixed(1)}%), ${dollarPart}`
      );
      return;
    }
  }
}
