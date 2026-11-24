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
import { blerpJwt, jwtExpiresAt, jwtIsLive, expiringWithin, refreshJwt, signIn, signedInAs, mintRefreshToken, hasRefreshToken, sessionSavedAt, storedRefreshToken, writeSession, RENEW_AHEAD_MS } from './blerp';

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
      // Seed the refresh chain the moment there is a session to seed it from;
      // without it the next expiry needs a human and a browser.
      if (!hasRefreshToken()) {
        const seeded = await mintRefreshToken(current);
        console.log(seeded
          ? '[BLERP] Refresh token minted — renewals are self-service from now on.'
          : '[BLERP] No refresh token and none could be minted (login already completed); a fresh blerp.com login is needed to seed one.');
      }
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
  const reason = `${why}; ${hasRefreshToken() ? 'the refresh token was refused' : 'no refresh token'} and no usable BLERP_EMAIL/BLERP_PASSWORD`;
  console.error(`[BLERP] ${reason}. Paste a fresh jwt in the dashboard (bot page → Admin).`);
  writeState({ lastVerifyAt: now, healthy: false, expiresAt: jwtExpiresAt() ?? undefined, lastReason: reason });
  await new TelegramNotifier().notifyBlerpSessionDown(reason, left).catch(() => {});
  return false;
}

/** What the dashboard shows about the Blerp login. Never includes a token. */
export interface BlerpSessionStatus {
  healthy: boolean;
  hasToken: boolean;
  username: string | null;
  expiresAt: number | null;
  /** A refresh token is stored, so renewal needs nobody. */
  selfRenewing: boolean;
  lastVerifyAt: number | null;
  lastReason: string | null;
  tokenSavedAt: number | null;
}

export function blerpSessionStatus(): BlerpSessionStatus {
  const state = readState();
  return {
    healthy: state.healthy !== false,
    hasToken: !!blerpJwt(),
    username: state.username ?? null,
    expiresAt: jwtExpiresAt(),
    // A stored refresh token only counts once renewal hasn't just failed with it.
    selfRenewing: hasRefreshToken() && state.healthy !== false,
    lastVerifyAt: state.lastVerifyAt ?? null,
    lastReason: state.lastReason ?? null,
    tokenSavedAt: sessionSavedAt()
  };
}

/**
 * The JWT out of whatever the browser put on the clipboard: the bare value,
 * Chrome's `jwt:"…"` cookie-table row, or a whole Cookie header. Returns null
 * when what is left is not shaped like a JWT, which is reported as a bad paste.
 */
export function normalizeJwt(raw: string): string | null {
  let t = (raw || '').trim();
  if (!t) return null;
  const named = /(?:^|[;\s])jwt\s*[:=]\s*("[^"]*"|'[^']*'|[^;\s]+)/i.exec(t);
  if (named) t = named[1];
  else t = t.split(';')[0].trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) t = t.slice(1, -1);
  t = t.trim();
  try { t = decodeURIComponent(t); } catch { /* keep t as it is */ }
  if (/^bearer\s+/i.test(t)) t = t.replace(/^bearer\s+/i, '');
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) && t.length <= 4000 ? t : null;
}

export type InstallBlerpTokenResult =
  | { ok: true; status: BlerpSessionStatus }
  | { ok: false; reason: 'malformed' | 'expired' | 'rejected' };

/**
 * Take a JWT pasted in the dashboard and put it to work. It is checked against
 * Blerp before it is saved, so a bad paste never replaces a token that still
 * works. A fresh login can mint a refresh token exactly once, so that is done
 * straight away: it is what turns this one paste into unattended renewals.
 * Any older refresh token is set aside first, since a dead one would stop the
 * new one from being minted, and restored only if minting fails.
 */
export async function installBlerpToken(raw: string): Promise<InstallBlerpTokenResult> {
  const token = normalizeJwt(raw);
  if (!token) return { ok: false, reason: 'malformed' };
  if (!jwtIsLive(token)) return { ok: false, reason: 'expired' };
  const who = await signedInAs(token);
  if (!who) return { ok: false, reason: 'rejected' };

  const wasUnhealthy = readState().healthy === false;
  const previous = storedRefreshToken();
  writeSession({ jwt: token, username: who });
  const seeded = await mintRefreshToken(token);
  // Nothing minted: put the old refresh token back rather than lose one that
  // may still work (a paste made while renewal was healthy).
  if (!seeded && previous) writeSession({ jwt: token, username: who, refreshToken: previous });
  console.log(seeded
    ? `[BLERP] New login pasted in the dashboard (${who}); refresh token minted — renewals are self-service again.`
    : `[BLERP] New login pasted in the dashboard (${who}); no refresh token could be minted, so it will need pasting again before it expires.`);
  writeState({ lastVerifyAt: Date.now(), healthy: true, expiresAt: jwtExpiresAt(token) ?? undefined, username: who });
  if (wasUnhealthy) {
    await new TelegramNotifier().notifyBlerpSessionRestored('a new login was pasted in the dashboard').catch(() => {});
  }
  return { ok: true, status: blerpSessionStatus() };
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
