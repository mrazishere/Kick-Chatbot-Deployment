import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { withFileLock, writeJsonAtomic } from './file-lock';

const DEPLOY_PATH: string = process.env.BOT_FULL_PATH || path.resolve(__dirname, '..');

/**
 * When each alert was last sent, shared by every Kick process. The enrollment
 * service and each channel bot all run their own notifier, so a shared failure
 * (a revoked bot grant, say) used to arrive once per process.
 */
const ALERT_STATE_FILE = path.join(DEPLOY_PATH, 'data', 'telegram-alerts.json');
const ALERT_LOCK = { staleMs: 10_000, waitMs: 3_000 };
/** Entries this old can't suppress anything any more; dropped so the file stays small. */
const ALERT_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

type AlertState = Record<string, number>;

/** Telegram's HTML mode rejects the whole message on a stray < or &, and would render one that parses. */
function esc(value: unknown): string {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function alertKey(kind: string, channel?: string): string {
  return channel ? `${kind}:${channel.toLowerCase()}` : kind;
}

function readAlertState(): AlertState {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALERT_STATE_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as AlertState : {};
  } catch {
    // Missing or corrupt: start clean. A lost entry can only cause one repeat alert.
    return {};
  }
}

class TelegramNotifier {
  private botToken: string | undefined;
  private chatId: string | undefined;
  private enabled: boolean;

  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      console.log('[TELEGRAM] Notifications disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    }
  }

  async sendMessage(message: string, silent = false): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      await axios.post(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          chat_id: this.chatId,
          text: message,
          parse_mode: 'HTML',
          disable_notification: silent
        },
        { timeout: 5000 }
      );
      console.log('[TELEGRAM] Message sent successfully');
      return true;
    } catch (error) {
      if (error instanceof Error) {
        console.error('[TELEGRAM] Failed to send message:', error.message);
      }
      return false;
    }
  }

  /**
   * Send an alert at most once per `cooldownMs` across every process.
   *
   * The key is claimed before sending, under a lock, so processes that hit the
   * same failure together can't all see it unsent. A send that fails gives the
   * claim back, so the next attempt isn't muted for a whole cooldown. If the
   * shared state can't be used at all the alert goes out anyway: a duplicate
   * beats silence.
   */
  private async sendOnce(key: string, cooldownMs: number, message: string, silent: boolean): Promise<boolean> {
    if (!this.enabled) return false;

    let claimed: boolean;
    try {
      claimed = await withFileLock(`${ALERT_STATE_FILE}.lock`, async () => {
        const state = readAlertState();
        const now = Date.now();
        const last = state[key];
        if (typeof last === 'number' && now - last < cooldownMs) return false;
        for (const [k, at] of Object.entries(state)) {
          if (typeof at !== 'number' || now - at > ALERT_STATE_MAX_AGE_MS) delete state[k];
        }
        state[key] = now;
        fs.mkdirSync(path.dirname(ALERT_STATE_FILE), { recursive: true });
        writeJsonAtomic(ALERT_STATE_FILE, state);
        return true;
      }, ALERT_LOCK);
    } catch (err) {
      console.error(`[TELEGRAM] Alert dedupe unavailable for "${key}", sending anyway:`, err instanceof Error ? err.message : String(err));
      return this.sendMessage(message, silent);
    }

    if (!claimed) {
      console.log(`[TELEGRAM] "${key}" alert already sent within its cooldown — skipped`);
      return false;
    }
    const sent = await this.sendMessage(message, silent);
    if (!sent) await this.forget([key]);
    return sent;
  }

  /** Drop alert keys so the next failure of that kind alerts straight away. */
  private async forget(keys: string[]): Promise<void> {
    // Read first without the lock: recoveries fire often and there is usually nothing to clear.
    const present = readAlertState();
    if (!keys.some(k => k in present)) return;
    try {
      await withFileLock(`${ALERT_STATE_FILE}.lock`, async () => {
        const state = readAlertState();
        for (const k of keys) delete state[k];
        writeJsonAtomic(ALERT_STATE_FILE, state);
      }, ALERT_LOCK);
    } catch (err) {
      console.error('[TELEGRAM] Could not clear alert state:', err instanceof Error ? err.message : String(err));
    }
  }

  /** Mark a failure as resolved without sending anything, e.g. after a successful token refresh. */
  async clearAlert(kind: string, channel?: string): Promise<void> {
    await this.forget([alertKey(kind, channel)]);
  }

  // Alert: refresh token invalid/revoked — manual re-auth required
  async notifyReauthRequired(reason = 'Refresh token is invalid or revoked'): Promise<boolean> {
    const message = `
🚨 <b>Kick Bot - Re-authentication Required</b>

<b>Bot Account:</b> ${esc(process.env.KICK_USERNAME || 'Unknown')}
<b>Reason:</b> ${esc(reason)}

<b>Action Required:</b>
The bot's refresh token has been revoked by Kick. Automatic renewal is not possible.

Re-authorize the bot (log in as the <b>bot account</b> first):
https://${esc(process.env.OAUTH_DOMAIN || 'mr-ai.dev')}/kick-bot-reauth
    `.trim();

    return await this.sendOnce(alertKey('reauth-required'), HOUR, message, false); // audible — needs immediate action
  }

  // Alert: token expiring soon but refresh still possible
  async notifyTokenExpiringSoon(hoursLeft: number): Promise<boolean> {
    let emoji = '⚠️';
    let urgency = 'Warning';
    if (hoursLeft <= 1) { emoji = '🚨'; urgency = 'CRITICAL'; }
    else if (hoursLeft <= 6) { emoji = '🔴'; urgency = 'URGENT'; }

    const message = `
${emoji} <b>Kick Bot Token Expiry ${urgency}</b>

<b>Bot Account:</b> ${esc(process.env.KICK_USERNAME || 'Unknown')}
<b>Time Remaining:</b> ~${esc(hoursLeft)} hour(s)

Auto-refresh is being attempted. If the bot goes offline, re-authorize here:
https://${esc(process.env.OAUTH_DOMAIN || 'mr-ai.dev')}/kick-bot-reauth
    `.trim();

    // Keyed by urgency so an escalation still gets through the cooldown.
    return await this.sendOnce(alertKey(`token-expiring-${urgency.toLowerCase()}`), HOUR, message, hoursLeft > 6);
  }

  // Alert: vision (HLS resolver) has been failing for several attempts.
  // Distinguishes Cloudflare-block from generic failure so the message is
  // actionable.
  async notifyVisionBroken(channel: string, reason: string, failureCount: number): Promise<boolean> {
    const isCloudflare = /Cloudflare|Just a moment|challenge/i.test(reason);
    const emoji = isCloudflare ? '🛑' : '⚠️';
    const headline = isCloudflare
      ? 'Cloudflare is blocking the vision resolver — likely needs a library/tool update'
      : 'Vision resolver is failing consistently';
    const message = `
${emoji} <b>Kick Bot - Vision Broken</b>

<b>Channel:</b> ${esc(channel)}
<b>Consecutive failures:</b> ${esc(failureCount)}
<b>Last error:</b> <code>${esc(reason.substring(0, 200))}</code>

${headline}.

The bot is still running and will fall back to text-only Claude responses. Investigate <code>src/channels/hls-resolver.ts</code> when convenient.
    `.trim();

    return await this.sendOnce(alertKey('vision-broken', channel), HOUR, message, false); // audible
  }

  // Informational: vision started working again after being broken.
  async notifyVisionRecovered(channel: string): Promise<boolean> {
    await this.forget([alertKey('vision-broken', channel)]);
    const message = `
✅ <b>Kick Bot - Vision Recovered</b>

<b>Channel:</b> ${esc(channel)}

The HLS resolver is working again. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Alert: the Kick session token that !clip depends on stopped working and the
  // bot could not renew it. Kick rate-limits logins from this host, so a human
  // may have to paste a fresh cookie; nothing else on the bot is affected.
  async notifyClipSessionDown(reason: string): Promise<boolean> {
    const message = `
\u{1F6D1} <b>Kick Bot - Clipping Down</b>

<b>Reason:</b> <code>${esc(reason.substring(0, 200))}</code>

<code>!clip</code> needs a Kick session token and the bot could not renew it by itself.

<b>To fix (about two minutes):</b>
1. Log in to kick.com as MrAIisHere in a private window
2. F12 → Application → Cookies → kick.com → copy <code>session_token</code>
3. Put it in <code>.session.json</code> as <code>{"token":"...","savedAt":0}</code>
4. Close that window WITHOUT logging out

Everything else keeps running; only clipping is affected.
    `.trim();
    return await this.sendOnce(alertKey('clip-session-down'), 12 * HOUR, message, false);
  }

  // Alert: the Blerp login could not be renewed and !blerp will stop working.
  // Sent days ahead of the deadline: the token usually still works meanwhile,
  // so this is a reminder to act, not an outage.
  async notifyBlerpSessionDown(reason: string, daysLeft: number | null): Promise<boolean> {
    const clock = daysLeft === null ? 'Expiry unknown.'
      : daysLeft > 0 ? `The current token still works for about <b>${daysLeft} day(s)</b>.`
        : 'The current token has <b>already expired</b>.';
    const message = `
\u{1F6D1} <b>Kick Bot - Blerp Login Needs Renewing</b>

<b>Reason:</b> <code>${esc(reason.substring(0, 200))}</code>

${clock}

<b>Permanent fix (about a minute):</b>
Put the bot's Blerp account into <code>.env</code> and the bot renews itself from then on:
<code>BLERP_EMAIL=...</code>
<code>BLERP_PASSWORD=...</code>

<b>Stopgap:</b>
1. Log in to blerp.com as MrAIisHere
2. F12 → Application → Cookies → blerp.com → copy <code>jwt</code>
3. Put it in <code>.blerp-session.json</code> as the <code>jwt</code> field

Everything else keeps running; only <code>!blerp</code> is affected.
    `.trim();
    return await this.sendOnce(alertKey('blerp-session-down'), 24 * HOUR, message, false);
  }

  // Informational: the Blerp login works again.
  async notifyBlerpSessionRestored(how: string): Promise<boolean> {
    await this.forget([alertKey('blerp-session-down')]);
    const message = `
\u{2705} <b>Kick Bot - Blerp Login Restored</b>

The Blerp session works again (${esc(how)}). <code>!blerp</code> is back. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Informational: clipping can authenticate again.
  async notifyClipSessionRestored(how: string): Promise<boolean> {
    await this.forget([alertKey('clip-session-down')]);
    const message = `
\u{2705} <b>Kick Bot - Clipping Restored</b>

The Kick session works again (${esc(how)}). <code>!clip</code> is back. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Alert: earnings poller has been failing for several consecutive cycles.
  // Most likely cause: enrollment service is down and dist/.tokens.json went
  // stale. Earnings poller only reads tokens, so it can't self-recover.
  async notifyEarningsBroken(channel: string, reason: string, failureCount: number): Promise<boolean> {
    const message = `
⚠️ <b>Kick Bot - Earnings Poller Broken</b>

<b>Channel:</b> ${esc(channel)}
<b>Consecutive failures:</b> ${esc(failureCount)}
<b>Last error:</b> <code>${esc(reason.substring(0, 200))}</code>

Earnings polling has failed repeatedly. Likely cause: the central bot token (<code>dist/.tokens.json</code>) is stale because the enrollment service isn't refreshing it. Check that <code>Kick-Bot-Enrollment</code> is running.
    `.trim();

    return await this.sendOnce(alertKey('earnings-broken', channel), HOUR, message, false); // audible
  }

  // Informational: earnings poller started working again.
  async notifyEarningsRecovered(channel: string): Promise<boolean> {
    await this.forget([alertKey('earnings-broken', channel)]);
    const message = `
✅ <b>Kick Bot - Earnings Poller Recovered</b>

<b>Channel:</b> ${esc(channel)}

Earnings polling is working again. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Warning: the bot grant is approaching Kick's hard 30-day lifetime.
  // Refreshing does not extend it — only a manual re-auth creates a new grant.
  async notifyGrantExpiringSoon(daysLeft: number): Promise<boolean> {
    const urgent = daysLeft <= 1;
    const message = `
${urgent ? '🚨' : '⏳'} <b>Kick Bot - Re-auth Needed Within ${urgent ? '24 Hours' : '2 Days'}</b>

<b>Bot Account:</b> ${esc(process.env.KICK_USERNAME || 'Unknown')}
<b>Grant expires in:</b> ~${esc(daysLeft.toFixed(1))} day(s)

Kick OAuth grants last exactly 30 days and cannot be extended by refreshing. Re-authorize now to avoid downtime (log in as the <b>bot account</b> first):
https://${esc(process.env.OAUTH_DOMAIN || 'mr-ai.dev')}/kick-bot-reauth
    `.trim();

    // Daily reminder; the urgent tier has its own key so crossing into it alerts at once.
    return await this.sendOnce(alertKey(urgent ? 'grant-expiring-urgent' : 'grant-expiring'), 20 * HOUR, message, !urgent);
  }

  // Alert: a channel's streamer OAuth token can no longer be refreshed —
  // the streamer must re-enroll. Without this the bot silently falls back
  // to the bot token and the failure goes unnoticed.
  async notifyChannelTokenBroken(channel: string, failureCount: number): Promise<boolean> {
    const message = `
⚠️ <b>Kick Bot - Channel Token Broken</b>

<b>Channel:</b> ${esc(channel)}
<b>Consecutive refresh failures:</b> ${esc(failureCount)}

The streamer OAuth token for this channel can no longer be refreshed (Kick grants expire 30 days after enrollment). The dead token was removed from the channel config and the bot now uses the bot account token for sends. Re-enrolling restores the channel token.

Have <b>${esc(channel)}</b> re-enroll here:
https://${esc(process.env.OAUTH_DOMAIN || 'mr-ai.dev')}/kick-bot-enroll
    `.trim();

    return await this.sendOnce(alertKey('channel-token-broken', channel), 6 * HOUR, message, false); // audible — needs streamer action
  }

  // Alert: a channel has rewardActions configured but its streamer grant
  // predates the scopes those actions need. Redemptions silently no-op until
  // the streamer re-authorizes, so this must not stay buried in a log.
  async notifyRewardScopeMissing(channel: string, missing: string[], granted: string[]): Promise<boolean> {
    const message = `
⚠️ <b>Kick Bot - Reward Actions Not Authorized</b>

<b>Channel:</b> ${esc(channel)}
<b>Missing scopes:</b> ${esc(missing.join(', '))}
<b>Granted:</b> ${esc(granted.join(' ') || 'none')}

This channel has <code>rewardActions</code> configured, but its OAuth grant predates those scopes. Refreshing never widens a grant, so redemptions are being left pending and no timeout is applied.

Have <b>${esc(channel)}</b> sign in again here to re-authorize:
https://${esc(process.env.OAUTH_DOMAIN || 'mr-ai.dev')}/kick-bot-enroll
    `.trim();

    // The bot checks once per start, so without a cooldown every restart re-alerts.
    return await this.sendOnce(alertKey('reward-scope-missing', channel), 24 * HOUR, message, false); // audible — needs streamer action
  }

  // Informational: token refreshed successfully after a failed attempt
  async notifyRefreshRecovered(): Promise<boolean> {
    // A new grant resets both the revoked-token alert and the 30-day countdown.
    await this.forget([
      alertKey('reauth-required'),
      alertKey('grant-expiring'),
      alertKey('grant-expiring-urgent'),
      alertKey('token-expiring-warning'),
      alertKey('token-expiring-urgent'),
      alertKey('token-expiring-critical')
    ]);
    const message = `
✅ <b>Kick Bot - Token Refreshed Successfully</b>

<b>Bot Account:</b> ${esc(process.env.KICK_USERNAME || 'Unknown')}

Token was renewed. No action needed.
    `.trim();

    return await this.sendMessage(message, true); // silent — just informational
  }
}

export = TelegramNotifier;
