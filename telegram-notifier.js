require('dotenv').config();
const axios = require('axios');

class TelegramNotifier {
  constructor() {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.botToken && this.chatId);

    if (!this.enabled) {
      console.log('[TELEGRAM] Notifications disabled (TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set)');
    }
  }

  async sendMessage(message, silent = false) {
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
      console.error('[TELEGRAM] Failed to send message:', error.message);
      return false;
    }
  }

  // Alert: refresh token invalid/revoked — manual re-auth required
  async notifyReauthRequired(reason = 'Refresh token is invalid or revoked') {
    const message = `
🚨 <b>Kick Bot - Re-authentication Required</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}
<b>Reason:</b> ${reason}

<b>Action Required:</b>
The bot's refresh token has been revoked by Kick. Automatic renewal is not possible.

SSH into the server and run:
<code>cd /home/user/Kick-Chatbot-Deployment && node authenticate.js</code>

Then open the browser link shown in the terminal to re-authorize the bot.
    `.trim();

    return await this.sendMessage(message, false); // audible — needs immediate action
  }

  // Alert: token expiring soon but refresh still possible
  async notifyTokenExpiringSoon(hoursLeft) {
    let emoji = '⚠️';
    let urgency = 'Warning';
    if (hoursLeft <= 1) { emoji = '🚨'; urgency = 'CRITICAL'; }
    else if (hoursLeft <= 6) { emoji = '🔴'; urgency = 'URGENT'; }

    const message = `
${emoji} <b>Kick Bot Token Expiry ${urgency}</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}
<b>Time Remaining:</b> ~${hoursLeft} hour(s)

Auto-refresh is being attempted. If the bot goes offline, manual re-auth may be required:
<code>cd /home/user/Kick-Chatbot-Deployment && node authenticate.js</code>
    `.trim();

    return await this.sendMessage(message, hoursLeft > 6);
  }

  // Informational: token refreshed successfully after a failed attempt
  async notifyRefreshRecovered() {
    const message = `
✅ <b>Kick Bot - Token Refreshed Successfully</b>

<b>Bot Account:</b> ${process.env.KICK_USERNAME || 'Unknown'}

Token was renewed. No action needed.
    `.trim();

    return await this.sendMessage(message, true); // silent — just informational
  }
}

module.exports = TelegramNotifier;
