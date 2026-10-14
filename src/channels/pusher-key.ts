/**
 * The Pusher app key and cluster Kick's chat WebSocket runs on.
 *
 * Kick doesn't publish them, and it changes the key now and then: on 2026-10-13 the
 * old one started answering 4001 ("App key … not in this cluster") and the bots went
 * deaf on the socket, leaving chat to the webhooks. Kick's web client asks for them
 * at web.kick.com/api/v1/realtime/connection, so when Pusher refuses the key, ask the
 * same way and reconnect with what comes back. The last key that worked is kept in
 * data/kick-pusher.json so every bot process and the next start begin with it.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { randomUUID } from 'crypto';
import TelegramNotifier = require('../telegram-notifier');

interface PusherCreds { appKey: string; cluster: string }

/** What Kick handed out on 2026-10-14, for a start without the file. */
const KNOWN: PusherCreds = { appKey: '34bf7a0ff419a2a775b9', cluster: 'us2' };
const FILE = path.join(__dirname, '..', '..', 'data', 'kick-pusher.json');
const ENDPOINT = 'https://web.kick.com/api/v1/realtime/connection';
/** One ask per process this often at most, however often Pusher refuses. */
const REFRESH_EVERY_MS = 60_000;

/** Pusher's close and error codes for a key it doesn't know or won't take. */
export const PUSHER_BAD_KEY_CODES: ReadonlySet<number> = new Set([4001, 4003]);

/** Why the last ask for a key came back with nothing usable, for the down alert. */
let lastAskProblem: string | null = null;
/** The last close the chat sockets in this process saw. */
let lastClose: string | null = null;

let creds: PusherCreds | null = null;
let lastRefresh = 0;
let inFlight: Promise<boolean> | null = null;

function valid(v: unknown): v is PusherCreds {
  const c = v as Partial<PusherCreds> | null;
  return !!c && typeof c.appKey === 'string' && /^[a-z0-9]{10,40}$/i.test(c.appKey)
    && typeof c.cluster === 'string' && /^[a-z0-9-]{1,20}$/i.test(c.cluster);
}

function current(): PusherCreds {
  if (creds) return creds;
  try {
    const stored = JSON.parse(fs.readFileSync(FILE, 'utf8')) as unknown;
    if (valid(stored)) return (creds = { appKey: stored.appKey, cluster: stored.cluster });
  } catch { /* no file yet */ }
  return (creds = { ...KNOWN });
}

/** The WebSocket URL to connect with now. */
export function pusherUrl(): string {
  const c = current();
  return `wss://ws-${c.cluster}.pusher.com/app/${c.appKey}?protocol=7&client=js&version=8.4.0-rc2&flash=false`;
}

/**
 * Ask Kick for the Pusher key and cluster, as its web client does. Resolves true
 * when they changed, so a reconnect would use something new. Never rejects.
 */
export function refreshPusherKey(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (Date.now() - lastRefresh < REFRESH_EVERY_MS) {
    // Another process may have found it meanwhile.
    creds = null;
    return Promise.resolve(false);
  }
  lastRefresh = Date.now();
  inFlight = (async () => {
    try {
      const res = await axios.post(ENDPOINT, {
        client: { id: randomUUID(), type: 'web' },
        capabilities: { accepted_providers: [{ provider: 'pusher' }] }
      }, {
        timeout: 10_000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      const conns = (res.data as { data?: { connections?: Array<{ provider?: string; credentials?: { app_key?: string; cluster?: string } }> } })?.data?.connections ?? [];
      const p = conns.find(c => c.provider === 'pusher')?.credentials;
      const next = { appKey: p?.app_key, cluster: p?.cluster };
      if (!valid(next)) {
        lastAskProblem = `Kick offered no Pusher key (it offered: ${conns.map(c => c.provider).join(', ') || 'nothing'})`;
        console.error(`[PUSHER] ${lastAskProblem}`);
        return false;
      }
      lastAskProblem = null;
      const before = current();
      if (before.appKey === next.appKey && before.cluster === next.cluster) return false;
      creds = next;
      try {
        const tmp = `${FILE}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
        fs.renameSync(tmp, FILE);
      } catch (err) {
        console.error(`[PUSHER] Saving the new key failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(`[PUSHER] Kick moved chat to key ${next.appKey} on ${next.cluster} (was ${before.appKey} on ${before.cluster})`);
      return true;
    } catch (err) {
      lastAskProblem = `asking Kick for the key failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`[PUSHER] Asking Kick for the Pusher key failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Record a chat socket's close, for the down alert. */
export function noteSocketClose(code: number, reason: string): void {
  lastClose = `code ${code}${reason ? `: ${reason.slice(0, 120)}` : ''}`;
}

/** How long a chat socket may stay unsubscribed before Telegram hears about it. */
const DOWN_ALERT_MS = 30 * 60_000;
const WATCH_EVERY_MS = 60_000;

/**
 * Alert on Telegram when a chat socket has gone `DOWN_ALERT_MS` without a live
 * subscription, and again when it's back. Kick changes the socket without notice
 * (it's not part of its public API), and chat carrying on over the webhooks hid a
 * day-long outage once; this makes the next one show. The alert is shared by every
 * process, so a Kick-wide change sends one, not one per bot. Returns a stop function.
 */
export function watchChatSocket(label: string, isUp: () => boolean): () => void {
  let downSince: number | null = null;
  let alerted = false;
  const notifier = new TelegramNotifier();
  const timer = setInterval(() => {
    if (isUp()) {
      downSince = null;
      if (alerted) {
        alerted = false;
        void notifier.notifyChatSocketRecovered(label).catch(() => {});
      }
      return;
    }
    downSince ??= Date.now();
    const downMs = Date.now() - downSince;
    if (alerted || downMs < DOWN_ALERT_MS) return;
    alerted = true;
    const detail = [lastClose && `Last close: ${lastClose}`, lastAskProblem && `Key lookup: ${lastAskProblem}`].filter(Boolean).join('\n');
    console.error(`[PUSHER] ${label}: chat socket down for ${Math.round(downMs / 60_000)} min — alerting`);
    void notifier.notifyChatSocketDown(label, Math.round(downMs / 60_000), detail || 'no close recorded').catch(() => {});
  }, WATCH_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}
