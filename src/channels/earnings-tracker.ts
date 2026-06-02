/**
 * EarningsTracker — polls Kick public v1 channel endpoint (authenticated)
 * to track stream earnings at a fixed rate per viewer per hour.
 *
 * API note: the unauthenticated v2 endpoint (kick.com/api/v2/channels/<slug>)
 * is blocked by Cloudflare when called from a server. We use the authenticated
 * public v1 endpoint (api.kick.com/public/v1/channels?slug=<slug>) which
 * returns stream data under data[0].stream.{is_live, viewer_count, start_time}.
 *
 * Session lifecycle:
 *   - offline → live  : create current.json (startedAt, 0 cents)
 *   - live    → live  : accumulate earnings since last poll using avg(prev, curr) viewer count
 *   - live    → offline: finalize — attribute final interval, append to sessions.json, delete current.json
 *
 * Storage:
 *   data/earnings/<channel>/current.json   (exists only while streaming)
 *   data/earnings/<channel>/sessions.json  (append-only array of finalized sessions)
 *
 * Crash/restart resilience:
 *   On start(), pollOnce() runs immediately. If current.json exists and the
 *   stream is still live, accumulation continues based on elapsed time since
 *   lastPolledAt. If the stream is no longer live, the session is finalized
 *   using the last known state.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { CurrentEarningsSession, FinalizedEarningsSession } from '../types';
import KickAuth = require('../auth');
import TelegramNotifier = require('../telegram-notifier');

const POLL_INTERVAL_MS = 5 * 60 * 1000;          // 5 minutes
const CENTS_PER_VIEWER_PER_HOUR = 10;             // $0.10/viewer/hour
const MAX_BACKFILL_HOURS = 24;                    // cap bogus gaps (e.g. clock skew)
const MID_STREAM_JOIN_THRESHOLD_MS = 10 * 60 * 1000; // if we joined >10min after start_time, discard on finalize
// Watchdog: alert after this many consecutive poll failures. 5 polls × 5 min =
// 25 min of failure — long enough to filter transient blips, short enough to
// catch real outages (enrollment service down, central token unrecoverable).
const FAILURE_ALERT_THRESHOLD = 5;

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

export class EarningsTracker {
  private channelName: string;
  private auth: InstanceType<typeof KickAuth>;
  private telegram: TelegramNotifier;
  private dataDir: string;
  private currentFile: string;
  private sessionsFile: string;
  private pollInterval: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private hasAlertedBroken = false;

  constructor(channelName: string, tokenFilePath: string) {
    this.channelName = channelName;
    // Use a dedicated KickAuth pointed at the bot's central token file
    // (kept fresh by the enrollment service's startTokenMonitor). The poller
    // only reads the token — it does not refresh — to avoid racing with the
    // enrollment service on refresh-token rotation.
    this.auth = new KickAuth(tokenFilePath);
    this.telegram = new TelegramNotifier();
    this.dataDir = path.join(process.cwd(), 'data', 'earnings', channelName);
    this.currentFile = path.join(this.dataDir, 'current.json');
    this.sessionsFile = path.join(this.dataDir, 'sessions.json');
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.sessionsFile)) {
      fs.writeFileSync(this.sessionsFile, '[]');
    }
  }

  async start(): Promise<void> {
    console.log(
      `[EARNINGS] Tracker starting for ${this.channelName} — polling every ${POLL_INTERVAL_MS / 60000}m, rate $${(CENTS_PER_VIEWER_PER_HOUR / 100).toFixed(2)}/viewer/hour`
    );
    await this.pollOnce();
    this.pollInterval = setInterval(() => {
      this.pollOnce().catch(err => {
        if (err instanceof Error) {
          console.error('[EARNINGS] Poll failed:', err.message);
        }
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[EARNINGS] Tracker stopped');
    }
  }

  private async fetchLivestream(): Promise<KickStream | null> {
    const token = this.auth.loadAccessToken();
    if (!token) {
      throw new Error('No access token available');
    }
    const response = await axios.get<KickChannelsResponse>(
      `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(this.channelName)}`,
      {
        timeout: 15000,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      }
    );
    const item = response.data?.data?.[0];
    return item?.stream ?? null;
  }

  private readCurrent(): CurrentEarningsSession | null {
    try {
      if (!fs.existsSync(this.currentFile)) return null;
      return JSON.parse(fs.readFileSync(this.currentFile, 'utf8')) as CurrentEarningsSession;
    } catch (err) {
      if (err instanceof Error) {
        console.error('[EARNINGS] Failed to read current session:', err.message);
      }
      return null;
    }
  }

  private writeCurrent(session: CurrentEarningsSession): void {
    fs.writeFileSync(this.currentFile, JSON.stringify(session, null, 2));
  }

  private deleteCurrent(): void {
    if (fs.existsSync(this.currentFile)) {
      fs.unlinkSync(this.currentFile);
    }
  }

  private appendSession(session: FinalizedEarningsSession): void {
    let sessions: FinalizedEarningsSession[] = [];
    try {
      const raw = fs.readFileSync(this.sessionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) sessions = parsed as FinalizedEarningsSession[];
    } catch (err) {
      if (err instanceof Error) {
        console.error('[EARNINGS] sessions.json unreadable, starting fresh:', err.message);
      }
    }
    sessions.push(session);
    fs.writeFileSync(this.sessionsFile, JSON.stringify(sessions, null, 2));
  }

  private hoursBetween(fromIso: string, toMs: number): number {
    const ms = toMs - new Date(fromIso).getTime();
    if (ms <= 0) return 0;
    const hours = ms / (1000 * 60 * 60);
    return Math.min(hours, MAX_BACKFILL_HOURS);
  }

  private async pollOnce(): Promise<void> {
    let stream: KickStream | null;
    try {
      stream = await this.fetchLivestream();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[EARNINGS] Fetch failed, skipping poll:', reason);
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= FAILURE_ALERT_THRESHOLD && !this.hasAlertedBroken) {
        this.hasAlertedBroken = true;
        this.telegram
          .notifyEarningsBroken(this.channelName, reason, this.consecutiveFailures)
          .catch(() => {});
      }
      return;
    }

    if (this.hasAlertedBroken) {
      this.telegram.notifyEarningsRecovered(this.channelName).catch(() => {});
    }
    this.consecutiveFailures = 0;
    this.hasAlertedBroken = false;

    const isLive = stream?.is_live === true;
    const viewers = stream?.viewer_count ?? 0;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const current = this.readCurrent();

    if (isLive && !current) {
      const newSession: CurrentEarningsSession = {
        startedAt: stream?.start_time ?? nowIso,
        firstObservedAt: nowIso,
        lastPolledAt: nowIso,
        lastViewerCount: viewers,
        accumulatedCents: 0,
        peakViewers: viewers
      };
      this.writeCurrent(newSession);
      const startedAtMs = new Date(newSession.startedAt).getTime();
      const joinedLate = nowMs - startedAtMs > MID_STREAM_JOIN_THRESHOLD_MS;
      console.log(
        `[EARNINGS] Session STARTED — ${viewers} viewers, startedAt=${newSession.startedAt}${joinedLate ? ' (joined mid-stream — will discard on finalize)' : ''}`
      );
      return;
    }

    if (isLive && current) {
      const hoursElapsed = this.hoursBetween(current.lastPolledAt, nowMs);
      const avgViewers = (current.lastViewerCount + viewers) / 2;
      const earnedCents = Math.round(avgViewers * CENTS_PER_VIEWER_PER_HOUR * hoursElapsed);

      current.accumulatedCents += earnedCents;
      current.lastPolledAt = nowIso;
      current.lastViewerCount = viewers;
      current.peakViewers = Math.max(current.peakViewers, viewers);
      this.writeCurrent(current);

      console.log(
        `[EARNINGS] +${earnedCents}¢ (avg ${avgViewers.toFixed(1)} viewers × ${hoursElapsed.toFixed(3)}h) — total $${(current.accumulatedCents / 100).toFixed(2)}, now ${viewers} viewers`
      );
      return;
    }

    if (!isLive && current) {
      const startedAtMs = new Date(current.startedAt).getTime();
      const firstObservedAtMs = current.firstObservedAt
        ? new Date(current.firstObservedAt).getTime()
        : startedAtMs; // legacy sessions written before this field existed — treat as observed-from-start

      // Discard sessions where the tracker joined >10min after the real stream start.
      // Such sessions produce misleading stats (real duration, partial earnings).
      const joinLagMs = firstObservedAtMs - startedAtMs;
      if (joinLagMs > MID_STREAM_JOIN_THRESHOLD_MS) {
        this.deleteCurrent();
        const lagMin = Math.round(joinLagMs / 60000);
        console.log(
          `[EARNINGS] Session DISCARDED — joined mid-stream (${lagMin}m after start_time), not recording to sessions.json`
        );
        return;
      }

      const hoursElapsed = this.hoursBetween(current.lastPolledAt, nowMs);
      const finalCents = Math.round(current.lastViewerCount * CENTS_PER_VIEWER_PER_HOUR * hoursElapsed);
      const totalCents = current.accumulatedCents + finalCents;
      // Estimate true end as midpoint between last-seen-live and offline-detection.
      // Reduces expected error from ~half the poll interval to ~quarter.
      const lastSeenLiveMs = new Date(current.lastPolledAt).getTime();
      const endedAtMs = Math.round((lastSeenLiveMs + nowMs) / 2);
      const endedAtIso = new Date(endedAtMs).toISOString();
      const durationSeconds = Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000));
      const finalized: FinalizedEarningsSession = {
        startedAt: current.startedAt,
        endedAt: endedAtIso,
        durationSeconds,
        totalCents,
        peakViewers: current.peakViewers
      };
      this.appendSession(finalized);
      this.deleteCurrent();
      console.log(
        `[EARNINGS] Session ENDED — $${(totalCents / 100).toFixed(2)} over ${Math.round(durationSeconds / 60)}m, peak ${current.peakViewers} viewers`
      );
      return;
    }

    // offline and no session: nothing to do
  }
}
