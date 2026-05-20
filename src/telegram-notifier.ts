import 'dotenv/config';
import axios from 'axios';
import * as path from 'path';

const DEPLOY_PATH: string = process.env.BOT_FULL_PATH || path.resolve(__dirname, '..');

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

  // Alert: refresh token invalid/revoked — manual re-auth required
  async notifyReauthRequired(reason = 'Refresh token is invalid or revoked'): Promise<boolean> {
    const message = `
🚨 <b>Kick Bot - Re-authentication Required</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}
<b>Reason:</b> ${reason}

<b>Action Required:</b>
The bot's refresh token has been revoked by Kick. Automatic renewal is not possible.

Re-authorize the bot (log in as the <b>bot account</b> first):
https://${process.env.OAUTH_DOMAIN || 'mr-ai.dev'}/kick-bot-reauth
    `.trim();

    return await this.sendMessage(message, false); // audible — needs immediate action
  }

  // Alert: token expiring soon but refresh still possible
  async notifyTokenExpiringSoon(hoursLeft: number): Promise<boolean> {
    let emoji = '⚠️';
    let urgency = 'Warning';
    if (hoursLeft <= 1) { emoji = '🚨'; urgency = 'CRITICAL'; }
    else if (hoursLeft <= 6) { emoji = '🔴'; urgency = 'URGENT'; }

    const message = `
${emoji} <b>Kick Bot Token Expiry ${urgency}</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}
<b>Time Remaining:</b> ~${hoursLeft} hour(s)

Auto-refresh is being attempted. If the bot goes offline, re-authorize here:
https://${process.env.OAUTH_DOMAIN || 'mr-ai.dev'}/kick-bot-reauth
    `.trim();

    return await this.sendMessage(message, hoursLeft > 6);
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

<b>Channel:</b> ${channel}
<b>Consecutive failures:</b> ${failureCount}
<b>Last error:</b> <code>${reason.substring(0, 200)}</code>

${headline}.

The bot is still running and will fall back to text-only Claude responses. Investigate <code>src/channels/hls-resolver.ts</code> when convenient.
    `.trim();

    return await this.sendMessage(message, false); // audible
  }

  // Informational: vision started working again after being broken.
  async notifyVisionRecovered(channel: string): Promise<boolean> {
    const message = `
✅ <b>Kick Bot - Vision Recovered</b>

<b>Channel:</b> ${channel}

The HLS resolver is working again. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Alert: earnings poller has been failing for several consecutive cycles.
  // Most likely cause: enrollment service is down and dist/.tokens.json went
  // stale. Earnings poller only reads tokens, so it can't self-recover.
  async notifyEarningsBroken(channel: string, reason: string, failureCount: number): Promise<boolean> {
    const message = `
⚠️ <b>Kick Bot - Earnings Poller Broken</b>

<b>Channel:</b> ${channel}
<b>Consecutive failures:</b> ${failureCount}
<b>Last error:</b> <code>${reason.substring(0, 200)}</code>

Earnings polling has failed repeatedly. Likely cause: the central bot token (<code>dist/.tokens.json</code>) is stale because the enrollment service isn't refreshing it. Check that <code>Kick-Bot-Enrollment</code> is running.
    `.trim();

    return await this.sendMessage(message, false); // audible
  }

  // Informational: earnings poller started working again.
  async notifyEarningsRecovered(channel: string): Promise<boolean> {
    const message = `
✅ <b>Kick Bot - Earnings Poller Recovered</b>

<b>Channel:</b> ${channel}

Earnings polling is working again. No action needed.
    `.trim();
    return await this.sendMessage(message, true);
  }

  // Informational: token refreshed successfully after a failed attempt
  async notifyRefreshRecovered(): Promise<boolean> {
    const message = `
✅ <b>Kick Bot - Token Refreshed Successfully</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}

Token was renewed. No action needed.
    `.trim();

    return await this.sendMessage(message, true); // silent — just informational
  }
}

export = TelegramNotifier;
