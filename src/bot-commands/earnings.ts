/**
 * Earnings command — shows stream earnings tracked by EarningsTracker.
 *
 * Description: Display current (or most recent) stream earnings at the channel's
 *              configured rate (earnings.centsPerViewerHour).
 *
 * Permission required: all users
 *
 * Usage: !earnings
 *
 * Scope: channels with earnings.enabled in their config. Silent everywhere else.
 *
 * Data source:
 *   data/earnings/<channel>/current.json   (live session, while streaming)
 *   data/earnings/<channel>/sessions.json  (finalized sessions, most recent last)
 *
 * Live proration: when a live session is active, the displayed total adds
 * (lastViewerCount × rate × minutesSinceLastPoll) so the figure doesn't sit
 * stale between 5-min polls. This is display-only — no state is mutated.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ChannelConfig, CommandFn, CurrentEarningsSession, EarningsConfig, FinalizedEarningsSession } from '../types';

// EarningsTracker's CENTS_PER_VIEWER_PER_HOUR, the rate it records at when the
// config sets none. The stored totals already use whichever rate applied, so the
// live proration here has to use that same rate.
const DEFAULT_CENTS_PER_VIEWER_HOUR = 10;

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

/**
 * The rate the tracker is recording at, read the way EarningsTracker reads it,
 * and whether the channel actually set it. This used to be a hardcoded 10¢, so
 * a channel with its own rate got live figures prorated at the wrong one.
 */
function earningsRate(config: ChannelConfig): { cents: number; configured: boolean } {
  const rate = (config.earnings as EarningsConfig | undefined)?.centsPerViewerHour;
  return typeof rate === 'number' && rate >= 0
    ? { cents: rate, configured: true }
    : { cents: DEFAULT_CENTS_PER_VIEWER_HOUR, configured: false };
}

export const earnings: CommandFn = async function earnings(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  if (words[0] !== '!earnings') return;

  const channelName = config.channelName;
  // Availability follows the channel config, not a hardcoded allowlist — the
  // dashboard's command toggle would otherwise be a no-op on other channels.
  if ((config.earnings as { enabled?: boolean } | undefined)?.enabled !== true) return;

  const rate = earningsRate(config);
  // A figure from an uncalibrated default rate is labelled as one, not passed off as real earnings.
  const rateNote = rate.configured
    ? ''
    : ` Estimated at the default ${formatDollars(rate.cents)} per viewer-hour, since no rate is set for this channel.`;

  const dataDir = path.join(process.cwd(), 'data', 'earnings', channelName);
  const currentFile = path.join(dataDir, 'current.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  try {
    if (fs.existsSync(currentFile)) {
      const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as CurrentEarningsSession;
      const nowMs = Date.now();
      const minutesSincePoll = Math.max(0, (nowMs - new Date(current.lastPolledAt).getTime()) / 60000);
      const proratedCents = Math.round(current.lastViewerCount * rate.cents * (minutesSincePoll / 60));
      const displayCents = current.accumulatedCents + proratedCents;
      const durationSeconds = Math.max(0, Math.floor((nowMs - new Date(current.startedAt).getTime()) / 1000));

      await client.say(
        channel,
        `@${tags.username}, Don is LIVE — earnings so far: ${formatDollars(displayCents)} over ${formatDuration(durationSeconds)} (${current.lastViewerCount} viewers, peak ${current.peakViewers}).${rateNote}`
      );
      return;
    }

    let sessions: FinalizedEarningsSession[] = [];
    if (fs.existsSync(sessionsFile)) {
      try {
        const raw = fs.readFileSync(sessionsFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) sessions = parsed as FinalizedEarningsSession[];
      } catch (err) {
        if (err instanceof Error) {
          console.error('[EARNINGS CMD] Failed to read sessions.json:', err.message);
        }
      }
    }

    if (sessions.length === 0) {
      await client.say(channel, `@${tags.username}, Don isn't streaming and no earnings data has been logged yet.`);
      return;
    }

    const last = sessions[sessions.length - 1];
    await client.say(
      channel,
      `@${tags.username}, Don isn't streaming. Last session: ${formatDollars(last.totalCents)} over ${formatDuration(last.durationSeconds)} (peak ${last.peakViewers} viewers).${rateNote}`
    );
  } catch (err) {
    if (err instanceof Error) {
      console.error('[EARNINGS CMD] Command error:', err.message);
    }
  }
};
