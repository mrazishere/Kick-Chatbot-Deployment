/**
 * KPP command — shows engagement-weighted KPP estimate (separate from !earnings).
 *
 * Description: Display current/recent KPP engagement score and $ estimate (if calibrated).
 * Based on the KPP pool-share model: score = viewer_hours x chat_activity_weight.
 *
 * Usage: !kpp
 *
 * Scope: sukasblood only (channel-name guarded). Returns silently on other channels.
 *
 * Data source:
 *   data/kpp/<channel>/current.json   (live session)
 *   data/kpp/<channel>/sessions.json  (finalized sessions)
 *
 * Calibration:
 *   config.kpp.dollarPerScore = <cents-paid-on-real-KPP-statement> / <our engagement score for same period>
 *   Until set, $ shows as "pending calibration".
 */

import * as fs from 'fs';
import * as path from 'path';
import { CommandFn, CurrentKPPSession, FinalizedKPPSession, KPPConfig } from '../types';

const SUPPORTED_CHANNELS = new Set(['sukasblood']);
const DEFAULT_CHAT_NORMAL_RATE = 0.09;
const CHAT_WEIGHT_FLOOR = 0.2;
const CHAT_WEIGHT_CEILING = 2.5;

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function chatHealthLabel(rate: number): string {
  // Reel: normal range 4–14%. Below = sparse/lurkers, above = strong.
  if (rate < 0.04) return 'sparse';
  if (rate < 0.07) return 'low';
  if (rate < 0.11) return 'healthy';
  if (rate < 0.14) return 'strong';
  return 'very strong';
}

export const kpp: CommandFn = async function kpp(client, message, channel, tags, config) {
  if (message.trim().split(/\s+/)[0] !== '!kpp') return;

  const channelName = config.channelName;
  if (!SUPPORTED_CHANNELS.has(channelName)) return;

  const cfg = (config.kpp as KPPConfig | undefined) || {};
  const chatNormalRate = cfg.chatNormalRate ?? DEFAULT_CHAT_NORMAL_RATE;
  const dollarPerScore = cfg.dollarPerScore ?? null;
  const centsPerVH = cfg.centsPerViewerHour ?? null;
  const centsPerAuthVH = cfg.centsPerAuthViewerHour ?? null;
  const POLL_INTERVAL_HOURS = 5 / 60; // 5-minute polls

  const dataDir = path.join(process.cwd(), 'data', 'kpp', channelName);
  const currentFile = path.join(dataDir, 'current.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  try {
    // LIVE — prorate viewer-hours forward, use running mean of per-window chat samples
    if (fs.existsSync(currentFile)) {
      const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as CurrentKPPSession;
      const nowMs = Date.now();
      const startedMs = new Date(current.startedAt).getTime();
      const lastMs = new Date(current.lastPolledAt).getTime();
      const sinceLastPollHours = Math.max(0, (nowMs - lastMs) / 3_600_000);
      const proratedVh = current.lastViewerCount * sinceLastPollHours;
      const viewerHours = current.viewerHoursSum + proratedVh;
      const durationSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
      const cumulativeChatters = Object.keys(current.cumulativeChatters).length;

      // Live-display sliding window sample: count current window chatters against
      // last-known viewer count and blend with the persisted running mean.
      const windowUniques = Object.keys(current.windowChatters).length;
      const livePartial = current.lastViewerCount > 0 ? windowUniques / current.lastViewerCount : 0;
      const totalSamples = current.chatRateSampleCount + (livePartial > 0 ? 1 : 0);
      const chatRate = totalSamples > 0
        ? (current.chatRateSum + livePartial) / totalSamples
        : 0;

      const rawWeight = chatRate / chatNormalRate;
      const chatWeight = Math.min(CHAT_WEIGHT_CEILING, Math.max(CHAT_WEIGHT_FLOOR, rawWeight));
      const score = viewerHours * chatWeight;

      // Authenticated viewer hours from per-user active window tracking
      const activeWindows = current.chatterActiveWindows || {};
      const totalActiveWindows = Object.values(activeWindows).reduce((a: number, b: number) => a + b, 0);
      const authVH = totalActiveWindows * POLL_INTERVAL_HOURS;

      let estCents: number | null = null;
      if (centsPerVH != null) {
        estCents = Math.round(viewerHours * centsPerVH);
      } else if (centsPerAuthVH != null) {
        estCents = Math.round(authVH * centsPerAuthVH);
      } else if (dollarPerScore != null) {
        estCents = Math.round(score * dollarPerScore * 100);
      }
      const estPart = estCents != null ? formatDollars(estCents) + ' est' : 'pending';

      await client.say(
        channel,
        `@${tags.username} Don is LIVE: ${estPart}, score ${score.toFixed(0)}, ${cumulativeChatters} chatters ${(chatRate * 100).toFixed(1)}pct ${chatHealthLabel(chatRate)}, ${formatDuration(durationSeconds)}, ${current.lastViewerCount} viewers peak ${current.peakViewers}`
      );
      return;
    }

    // OFFLINE — read most recent finalized session
    let sessions: FinalizedKPPSession[] = [];
    if (fs.existsSync(sessionsFile)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
        if (Array.isArray(parsed)) sessions = parsed as FinalizedKPPSession[];
      } catch (err) {
        if (err instanceof Error) console.error('[KPP CMD] Failed to read sessions.json:', err.message);
      }
    }

    if (sessions.length === 0) {
      await client.say(channel, `@${tags.username}, Don isn't streaming and no KPP sessions have been logged yet.`);
      return;
    }

    const last = sessions[sessions.length - 1];
    const lastEstCents = centsPerVH != null
      ? Math.round(last.viewerHours * centsPerVH)
      : last.estimatedCents;
    const estPart = lastEstCents != null ? formatDollars(lastEstCents) + ' est' : 'pending';
    await client.say(
      channel,
      `@${tags.username} Don is offline, last session: ${estPart}, score ${last.engagementScore}, ${last.uniqueChatters} chatters ${(last.chatActivityRate * 100).toFixed(1)}pct ${chatHealthLabel(last.chatActivityRate)}, ${formatDuration(last.durationSeconds)} avg ${Math.round(last.avgViewers)} peak ${last.peakViewers}`
    );
  } catch (err) {
    if (err instanceof Error) console.error('[KPP CMD] Command error:', err.message);
  }
};
