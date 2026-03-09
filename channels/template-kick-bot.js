require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const WebSocket = require('ws');
const KickAuth = require('../auth');
const fs = require('fs');
const path = require('path');

const CHANNEL_NAME = '$$UPDATEHERE$$';

class KickChatBot {
  constructor(channelName) {
    this.channelName = channelName;
    this.chatroomId = null;
    this.broadcasterUserId = null;
    this.ws = null;
    this.prefix = process.env.BOT_PREFIX || '!';
    this.commands = new Map();
    this.auth = new KickAuth();
    this.apiBase = 'https://kick.com/api/v2';
    this.config = this.loadConfig();
    this.tokenRefreshInterval = null;

    this.setupCommands();
  }

  saveChatroomId(realId) {
    try {
      const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.chatroomId = realId;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[INFO] Corrected chatroom ID saved to config: ${realId}`);
      }
    } catch (e) {
      console.error('[ERROR] Failed to save corrected chatroom ID:', e.message);
    }
  }

  loadConfig() {
    try {
      const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        console.log(`[CONFIG] Loaded config for ${this.channelName}`);
        return config;
      }
    } catch (error) {
      console.error(`[CONFIG] Failed to load config: ${error.message}`);
    }

    // Return default config
    return {
      channelName: this.channelName,
      chatOnly: true,
      excludedCommands: [],
      lastUpdated: new Date().toISOString()
    };
  }

  setupCommands() {
    // Load bot commands from bot-commands directory
    const glob = require('glob');
    const excludedCommands = this.config.excludedCommands || [];

    console.log('[COMMANDS] Loading bot commands from bot-commands directory...');

    const commandFiles = glob.sync(path.join(__dirname, '..', 'bot-commands', '*.js'));

    commandFiles.forEach(file => {
      try {
        const functionName = path.basename(file, '.js');

        // Skip if command is in the excluded list
        if (excludedCommands.includes(functionName)) {
          console.log(`[COMMANDS] Skipping excluded command: ${functionName}`);
          return;
        }

        const commandExports = require(file);
        if (typeof commandExports[functionName] === 'function') {
          this.commands.set(functionName, commandExports[functionName]);
          console.log(`[COMMANDS] Loaded command: ${functionName}`);
        }
      } catch (error) {
        console.error(`[COMMANDS] Failed to load command from ${file}: ${error.message}`);
        console.error(`[COMMANDS] Command "${path.basename(file, '.js')}" is DISABLED — fix the module and restart to re-enable`);
      }
    });

    console.log(`[COMMANDS] Loaded ${this.commands.size} commands`);
  }

  async ensureAuthenticated() {
    if (!this.auth.isAuthenticated()) {
      console.log('[AUTH] Not authenticated. Starting OAuth flow...');
      await this.auth.startOAuthFlow();
    } else {
      console.log('[AUTH] ✓ Already authenticated');
    }
  }

  async getChatroomId() {
    // Load chatroom ID for WebSocket subscriptions
    if (this.config.chatroomId) {
      this.chatroomId = this.config.chatroomId;
      console.log(`[INFO] Chatroom ID (for WebSocket): ${this.chatroomId}`);
    }

    // Load broadcaster user ID for sending messages
    if (this.config.broadcasterUserId) {
      this.broadcasterUserId = this.config.broadcasterUserId;
      console.log(`[INFO] Broadcaster User ID (for sending): ${this.broadcasterUserId}`);
    }

    if (this.chatroomId) {
      return this.chatroomId;
    }

    // Try to fetch from API using new public API
    try {
      console.log(`[INFO] Fetching chatroom ID for channel: ${this.channelName}`);

      const accessToken = await this.auth.getAccessToken();
      const response = await axios.get(`https://api.kick.com/public/v1/channels?slug=${this.channelName}`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': '*/*'
        }
      });

      // The new API returns an array with data property
      if (response.data && response.data.data && response.data.data.length > 0) {
        const channelData = response.data.data[0];

        // Store broadcaster_user_id (used for both chatroom ID and sending messages)
        if (channelData.broadcaster_user_id) {
          this.broadcasterUserId = channelData.broadcaster_user_id;
          this.chatroomId = channelData.broadcaster_user_id;
          console.log(`[INFO] Broadcaster User ID: ${this.broadcasterUserId}`);
          console.log(`[INFO] Using as chatroom ID: ${this.chatroomId}`);
          return this.chatroomId;
        } else {
          throw new Error(`No broadcaster_user_id found for channel ${this.channelName}`);
        }
      } else {
        throw new Error(`Channel ${this.channelName} not found or empty response`);
      }
    } catch (error) {
      console.error(`[ERROR] Failed to get chatroom ID: ${error.message}`);
      console.error(`[ERROR] Please set chatroomId in channel config file`);
      throw error;
    }
  }

  async connectWebSocket() {
    return new Promise((resolve, reject) => {
      const wsUrl = `wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false`;

      // Clear any existing ping interval
      if (this.pingInterval) {
        clearInterval(this.pingInterval);
        this.pingInterval = null;
      }

      // Tear down previous WebSocket before creating a new one
      if (this.ws) {
        this.ws.removeAllListeners();
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.terminate(); // force-close without waiting for handshake
        }
        this.ws = null;
      }

      console.log('[INFO] Connecting to Kick chat WebSocket...');
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        console.log('[SUCCESS] WebSocket connected!');

        // Subscribe to the chatroom channel
        const channels = [
          `chatrooms.${this.chatroomId}.v2`,
          `chatrooms.${this.chatroomId}`,
          `channel.${this.chatroomId}`
        ];

        channels.forEach(channelName => {
          // Unsubscribe first to prevent duplicate subscriptions on reconnect
          this.ws.send(JSON.stringify({
            event: 'pusher:unsubscribe',
            data: { channel: channelName }
          }));
          this.ws.send(JSON.stringify({
            event: 'pusher:subscribe',
            data: { auth: '', channel: channelName }
          }));
          console.log(`[INFO] Sent subscription request for ${channelName}`);
        });

        // Handle ping/pong to keep connection alive (started per successful connection)
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, 30000);

        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleWebSocketMessage(message);
        } catch (error) {
          console.error('[ERROR] Failed to parse WebSocket message:', error.message);
        }
      });

      this.ws.on('error', (error) => {
        console.error('[ERROR] WebSocket error:', error.message);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WARNING] WebSocket disconnected - Code: ${code}, Reason: ${reason || 'No reason provided'}`);

        // Clear ping interval on disconnect
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        // Attempt to reconnect after 5 seconds
        setTimeout(() => {
          console.log('[INFO] Attempting to reconnect...');
          this.connectWebSocket();
        }, 5000);
      });
    });
  }

  handleWebSocketMessage(message) {
    if (!message.event) return;

    // Handle Pusher protocol messages
    if (message.event === 'pusher:connection_established') {
      console.log('[INFO] Connection established');
      return;
    }

    if (message.event === 'pusher:pong') {
      return; // Silent pong response
    }

    if (message.event === 'pusher:error') {
      console.error('[ERROR] Pusher error:', JSON.stringify(message.data));
      return;
    }

    if (message.event === 'pusher_internal:subscription_succeeded') {
      console.log('[SUCCESS] Successfully subscribed to chat!');
      console.log(`[INFO] Listening to ${this.channelName}'s chat...`);
      console.log(`[INFO] Command prefix: ${this.prefix}`);
      return;
    }

    if (message.event === 'pusher_internal:subscription_error') {
      console.error('[ERROR] Subscription failed:', JSON.stringify(message));
      return;
    }

    // Handle chat events - data field is a JSON string that needs parsing
    try {
      if (message.event === 'App\\Events\\ChatMessageEvent') {
        // Self-correct chatroom ID from real Pusher channel name on first message
        const chatroomMatch = message.channel?.match(/chatrooms\.(\d+)/);
        if (chatroomMatch) {
          const realId = parseInt(chatroomMatch[1]);
          if (realId !== this.chatroomId) {
            console.log(`[INFO] Correcting chatroom ID: ${this.chatroomId} → ${realId}`);
            this.chatroomId = realId;
            this.saveChatroomId(realId);
          }
        }
        const eventData = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        this.handleChatMessage(eventData);
      } else if (message.event === 'App\\Events\\SubscriptionEvent') {
        const eventData = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        console.log(`[EVENT] ${eventData.username} just subscribed!`);
      } else if (message.event === 'App\\Events\\GiftedSubscriptionsEvent') {
        const eventData = typeof message.data === 'string' ? JSON.parse(message.data) : message.data;
        const count = eventData.gifted_usernames?.length ?? '?';
        console.log(`[EVENT] ${eventData.gifter_username} gifted ${count} subs!`);
      } else {
        // Log unknown events to see what we're missing
        if (message.event && !message.event.startsWith('pusher')) {
          console.log('[UNKNOWN EVENT]', message.event, 'Channel:', message.channel);
        }
      }
    } catch (err) {
      console.error('[ERROR] Failed to parse WebSocket event data:', err.message, 'Event:', message.event);
    }
  }

  handleChatMessage(data) {
    if (!data?.sender?.username || !data?.content) {
      console.warn('[COMMANDS] Skipping malformed chat message — missing sender or content:', JSON.stringify(data).substring(0, 200));
      return;
    }
    const username = data.sender.username;
    const message = data.content;
    const badges = data.sender?.identity?.badges || [];

    // Display the message
    const badgeStr = badges.length > 0 ? `[${badges.map(b => b.type).join(',')}] ` : '';
    console.log(`${badgeStr}${username}: ${message}`);

    // Check if message starts with command prefix
    const messageWords = message.split(' ');
    const potentialCommand = messageWords[0].toLowerCase();
    let isCommand = false;
    let requestedCommandName = '';

    if (potentialCommand.startsWith(this.prefix)) {
      requestedCommandName = potentialCommand.substring(this.prefix.length);
      isCommand = true;
    }

    // Get excluded commands from config
    const excludedCommands = this.config.excludedCommands || [];

    // For command messages, check if the requested command is excluded FIRST
    if (isCommand && excludedCommands.includes(requestedCommandName)) {
      console.log(`[COMMANDS] Command "${requestedCommandName}" is excluded for channel ${this.channelName}`);
      return;
    }

    // Build permission flags from badges
    const isBroadcaster = badges.some(b => b.type === 'broadcaster' || b.type === 'owner');
    const isMod = badges.some(b => b.type === 'moderator') || isBroadcaster;
    const isVip = badges.some(b => b.type === 'vip');
    const isSubscriber = badges.some(b => b.type === 'subscriber');
    const isModUp = isMod || isBroadcaster;
    const isVIPUp = isVip || isModUp;

    // Create Kick-compatible tags object for commands
    const kickTags = {
      username: username,
      'display-name': data.sender.username,
      badges: {
        broadcaster: isBroadcaster ? '1' : undefined,
        moderator: isMod ? '1' : undefined,
        vip: isVip ? '1' : undefined,
        subscriber: isSubscriber ? '1' : undefined
      },
      isModUp: isModUp,
      isVIPUp: isVIPUp,
      rawBadges: badges,
      senderId: data.sender?.id
    };

    // Create client wrapper for commands
    const clientWrapper = {
      say: async (channel, msg) => {
        console.log(`[COMMAND RESPONSE] ${msg}`);
        return await this.sendMessage(msg);
      }
    };

    // Execute ALL command functions for ALL messages (they handle their own filtering)
    this.commands.forEach((commandFunction, commandName) => {
      try {
        commandFunction(clientWrapper, message, `#${this.channelName}`, kickTags);
      } catch (error) {
        // Only log actual errors, not "not our command" type messages
        if (error.message && !error.message.includes('Not our command')) {
          console.error(`[COMMANDS] Command ${commandName} failed: ${error.message}`);
        }
      }
    });
  }

  async getChannelAccessToken() {
    // Use channel's own OAuth token if available
    if (this.config.oauth?.accessToken) {
      // Check if token needs refresh
      if (this.config.oauth.expiresAt && this.config.oauth.expiresAt < Date.now() + 300000) {
        await this.refreshChannelToken();
      }
      return this.config.oauth.accessToken;
    }
    // Fallback to bot's token
    return await this.auth.getAccessToken();
  }

  async refreshChannelToken() {
    if (!this.config.oauth?.refreshToken) return;

    try {
      const response = await axios.post('https://id.kick.com/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.CLIENT_ID,
          client_secret: process.env.CLIENT_SECRET,
          refresh_token: this.config.oauth.refreshToken
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      this.config.oauth.accessToken = response.data.access_token;
      this.config.oauth.refreshToken = response.data.refresh_token;
      this.config.oauth.expiresAt = Date.now() + (response.data.expires_in * 1000);
      this.config.lastUpdated = new Date().toISOString();

      // Save updated config
      const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log('[AUTH] Channel token refreshed');
    } catch (error) {
      console.error('[ERROR] Failed to refresh channel token:', error.message);
    }
  }

  async checkAndRefreshToken() {
    // Only check if we have OAuth configured
    if (!this.config.oauth?.accessToken) return;

    try {
      // Reload config from disk in case it was updated externally
      const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        this.config = JSON.parse(raw);
      } catch (readErr) {
        if (readErr.code !== 'ENOENT') {
          console.error('[AUTH] Failed to reload config:', readErr.message);
        }
      }

      // Check if token needs refresh (within 1 hour of expiry)
      if (this.config.oauth.expiresAt && this.config.oauth.expiresAt < Date.now() + 3600000) {
        console.log('[AUTH] Token expiring soon, refreshing proactively...');
        await this.refreshChannelToken();
      }
    } catch (error) {
      console.error('[ERROR] Failed to check/refresh token:', error.message);
    }
  }

  startTokenRefreshScheduler() {
    // Check token every 30 minutes
    this.tokenRefreshInterval = setInterval(() => {
      this.checkAndRefreshToken();
    }, 30 * 60 * 1000);

    // Also check immediately on startup
    this.checkAndRefreshToken();
    console.log('[AUTH] Token refresh scheduler started (checks every 30 minutes)');
  }

  async sendMessage(message) {
    try {
      const accessToken = await this.getChannelAccessToken();
      const hasChannelOAuth = !!this.config.oauth?.accessToken;

      // Sanitize message for Kick API - Kick has VERY strict formatting rules
      let sanitized = message
        .replace(/\n+/g, ' ')                    // Replace newlines with spaces
        .replace(/\*\*(.+?)\*\*/g, '$1')         // Remove **bold** markdown
        .replace(/__(.+?)__/g, '$1')             // Remove __italic__ markdown
        .replace(/\*(.+?)\*/g, '$1')             // Remove *italic* markdown
        .replace(/_(.+?)_/g, '$1')               // Remove _underline_ markdown
        .replace(/\s+/g, ' ')                    // Collapse multiple spaces
        .trim();                                 // Remove leading/trailing spaces

      // Limit special characters for type: "user" - Kick allows max 10 non-ASCII chars
      if (!hasChannelOAuth) {
        const MAX_SPECIAL_CHARS = 10;
        let specialCharCount = 0;
        let result = '';

        // Use Array.from to properly handle multi-byte characters (emojis)
        const chars = Array.from(sanitized);
        for (const char of chars) {
          const codePoint = char.codePointAt(0);
          const isSpecialChar = codePoint > 127; // Non-ASCII character

          if (isSpecialChar) {
            if (specialCharCount < MAX_SPECIAL_CHARS) {
              result += char;
              specialCharCount++;
            }
            // Skip if over limit
          } else {
            result += char;
          }
        }

        sanitized = result;
      }

      // Kick has a max message length (usually 500 chars)
      const MAX_LENGTH = 500;
      if (sanitized.length > MAX_LENGTH) {
        sanitized = sanitized.substring(0, MAX_LENGTH - 3) + '...';
      }

      const response = await axios.post(
        'https://api.kick.com/public/v1/chat',
        {
          broadcaster_user_id: this.broadcasterUserId,
          content: sanitized,
          type: hasChannelOAuth ? 'bot' : 'user'
        },
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`[SENT] ${sanitized}`);
      return response.data;
    } catch (error) {
      console.error(`[ERROR] Failed to send message: ${error.response?.data?.message || error.message}`);
      throw error;
    }
  }

  async connect() {
    try {
      // Ensure we're authenticated first
      await this.ensureAuthenticated();

      // Get chatroom ID
      await this.getChatroomId();

      // Start token refresh scheduler
      this.startTokenRefreshScheduler();

      // Connect to WebSocket
      await this.connectWebSocket();

    } catch (error) {
      console.error('[ERROR] Failed to connect:', error.message);
      process.exit(1);
    }
  }

  disconnect() {
    // Clear token refresh interval
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
      console.log('[INFO] Token refresh scheduler stopped');
    }

    if (this.ws) {
      console.log('[INFO] Disconnecting from Kick chat...');
      this.ws.close();
    }
  }
}

// Main execution
async function main() {
  const bot = new KickChatBot(CHANNEL_NAME);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[INFO] Shutting down bot...');
    bot.disconnect();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n[INFO] Shutting down bot...');
    bot.disconnect();
    process.exit(0);
  });

  // Start the bot
  await bot.connect();
}

main().catch(error => {
  console.error('[FATAL ERROR]', error);
  process.exit(1);
});
