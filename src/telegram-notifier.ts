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
