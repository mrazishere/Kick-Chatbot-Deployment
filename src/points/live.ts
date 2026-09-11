/**
 * Is the channel live right now? Asked once per points tick.
 *
 * Same call the KPP tracker makes, with the bot's token read from the shared
 * file (never refreshed here; the enrollment service keeps it fresh). A failed
 * call is retried, and after three failures the answer is "unknown", never
 * "offline": a tick with an unknown state grants nothing, and a blip must not
 * be recorded as the stream ending.
 */

import axios from 'axios';
import KickAuth = require('../auth');

export interface LiveState {
  isLive: boolean;
  /** Kick's stream start time in epoch ms, when it gave one. */
  startedAt: number | null;
}

interface ChannelsResponse {
  data?: Array<{ stream?: { is_live?: boolean; start_time?: string } | null }>;
}

export async function checkLive(channel: string, tokenFile: string, attempts = 3, gapMs = 15_000): Promise<LiveState | null> {
  const auth = new KickAuth(tokenFile);
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, gapMs));
    try {
      const token = auth.loadAccessToken();
      if (!token) throw new Error('no bot access token');
      const res = await axios.get<ChannelsResponse>(
        `https://api.kick.com/public/v1/channels?slug=${encodeURIComponent(channel)}`,
        { timeout: 15_000, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
      );
      const stream = res.data?.data?.[0]?.stream ?? null;
      const started = stream?.start_time ? Date.parse(stream.start_time) : NaN;
      return { isLive: stream?.is_live === true, startedAt: Number.isFinite(started) ? started : null };
    } catch (err) {
      if (i === attempts - 1) {
        console.error(`[POINTS] Live check for ${channel} failed ${attempts} times, skipping this tick: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return null;
}
