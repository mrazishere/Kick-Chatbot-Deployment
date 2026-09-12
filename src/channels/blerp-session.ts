/**
 * Keeping !blerp's Blerp login working without a human.
 *
 * The JWT Blerp issues lives about 20 days. Unlike the Kick session token
 * (see clip-session.ts) this one can be renewed unattended, so the job here is
 * to make sure it always is:
 *
 *   - a six-hourly check that renews once the token is within RENEW_AHEAD_MS
 *     of expiry, long before a viewer could run into it
 *   - renewal by refresh token first, credentials second; either one reseeds
 *     the other, so the chain heals itself
 *   - a Telegram alert only once both have failed and a human has to paste a
 *     JWT again, sent while there are still days left rather than after
 *   - state shared through a file, because all four bots load this module and
 *     only one of them should be doing the work
 */

import * as fs from 'fs';
import * as path from 'path';
import TelegramNotifier = require('../telegram-notifier');
import { blerpJwt, jwtExpiresAt, jwtIsLive, expiringWithin, refreshJwt, signIn, signedInAs, RENEW_AHEAD_MS } from './blerp';

const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** Only one process does the work per window; the others see a recent check and skip. */
const VERIFY_GAP_MS = 5 * 60 * 60_000;

interface State {
  lastVerifyAt?: number;
  healthy?: boolean;
  expiresAt?: number;
  username?: string;
  lastReason?: string;
}

function statePath(): string {
  return path.join(process.cwd(), 'data', 'blerp-session.json');
}

function readState(): State {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as State; } catch { return {}; }
}

function writeState(next: State): void {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2));
  } catch { /* best effort: the check simply runs again next window */ }
}

/** False once a check has found the login dead, so !blerp can say so honestly. */
export function blerpSessionHealthy(): boolean {
  return readState().healthy !== false;
}

/** Days until the stored JWT expires, or null when it cannot be read. */
export function daysLeft(): number | null {
  const exp = jwtExpiresAt();
  return exp === null ? null : Math.floor((exp - Date.now()) / 86_400_000);
}

/**
 * One health cycle. Returns true when !blerp can authenticate.
 * `force` skips the shared throttle — used when a command has just been refused.
 */
export async function checkBlerpSession(force = false): Promise<boolean> {
  const state = readState();
  const now = Date.now();
  if (!force && state.lastVerifyAt && now - state.lastVerifyAt < VERIFY_GAP_MS) return state.healthy !== false;
  state.lastVerifyAt = now;

  const current = blerpJwt();
  const fresh = current && jwtIsLive(current) && !expiringWithin(RENEW_AHEAD_MS, current);

  if (fresh) {
    // Live and not near the cliff — but confirm Blerp still accepts it, since a
    // revoked token stays well-formed and would otherwise look healthy here.
    const who = await signedInAs(current);
    if (who) {
      if (state.healthy === false) {
        await new TelegramNotifier().notifyBlerpSessionRestored('the existing login still works').catch(() => {});
      }
      writeState({ lastVerifyAt: now, healthy: true, expiresAt: jwtExpiresAt(current) ?? undefined, username: who });
      return true;
    }
  }

  const why = !current ? 'no Blerp token is stored'
    : !jwtIsLive(current) ? 'the Blerp token has expired'
      : fresh ? 'the Blerp token was rejected'
        : 'the Blerp token is close to expiring';
  console.warn(`[BLERP] ${why} — renewing`);

  let token = await refreshJwt();
  let how = token ? 'refreshed the token' : '';
  if (!token) {
    token = await signIn();
    how = token ? 'signed in with stored credentials' : '';
  }

  if (token) {
    const who = await signedInAs(token);
    if (who) {
      console.log(`[BLERP] Session renewed — ${how} (${who}).`);
      writeState({ lastVerifyAt: now, healthy: true, expiresAt: jwtExpiresAt(token) ?? undefined, username: who });
      await new TelegramNotifier().notifyBlerpSessionRestored(how).catch(() => {});
      return true;
    }
  }

  // Nothing worked. Say how long is left so the alert can be acted on calmly
  // rather than treated as an outage — the old token often still works for days.
  const left = daysLeft();
  const reason = `${why}; no refresh token and no usable BLERP_EMAIL/BLERP_PASSWORD`;
  console.error(`[BLERP] ${reason}. Paste a fresh jwt into .blerp-session.json.`);
  writeState({ lastVerifyAt: now, healthy: false, expiresAt: jwtExpiresAt() ?? undefined, lastReason: reason });
  await new TelegramNotifier().notifyBlerpSessionDown(reason, left).catch(() => {});
  return false;
}

let timer: NodeJS.Timeout | null = null;

/** Six-hourly check, jittered so four bots don't all wake at the same second. */
export function startBlerpSessionWatchdog(): void {
  if (timer) return;
  const jitter = Math.floor(Math.random() * 10 * 60_000);
  timer = setInterval(() => {
    checkBlerpSession().catch(err => console.error(`[BLERP] Session check failed: ${err instanceof Error ? err.message : String(err)}`));
  }, CHECK_EVERY_MS + jitter);
  timer.unref();
}
