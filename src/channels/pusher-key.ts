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

interface PusherCreds { appKey: string; cluster: string }

/** What Kick handed out on 2026-10-14, for a start without the file. */
const KNOWN: PusherCreds = { appKey: '34bf7a0ff419a2a775b9', cluster: 'us2' };
const FILE = path.join(__dirname, '..', '..', 'data', 'kick-pusher.json');
const ENDPOINT = 'https://web.kick.com/api/v1/realtime/connection';
/** One ask per process this often at most, however often Pusher refuses. */
const REFRESH_EVERY_MS = 60_000;

/** Pusher's close and error codes for a key it doesn't know or won't take. */
export const PUSHER_BAD_KEY_CODES: ReadonlySet<number> = new Set([4001, 4003]);

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
        console.error(`[PUSHER] Kick offered no Pusher key (${conns.map(c => c.provider).join(', ') || 'nothing'})`);
        return false;
      }
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
      console.error(`[PUSHER] Asking Kick for the Pusher key failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}
