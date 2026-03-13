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

    this.reconnectDelay = 5000;
    this.manualDisconnect = false;

    this.pendingLocationClarifications = new Map(); // username -> { options, timestamp }

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

  subscribeToChannels() {
    const channels = [
      `chatrooms.${this.chatroomId}.v2`,
      `chatrooms.${this.chatroomId}`,
      `channel.${this.chatroomId}`
    ];
    channels.forEach(channelName => {
      this.ws.send(JSON.stringify({ event: 'pusher:unsubscribe', data: { channel: channelName } }));
      this.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: channelName } }));
      console.log(`[INFO] Sent subscription request for ${channelName}`);
    });
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

      let resolved = false;

      this.ws.on('open', () => {
        console.log('[SUCCESS] WebSocket connected!');
        this.reconnectDelay = 5000; // reset backoff on successful connection
        this.subscribeToChannels();

        // Handle ping/pong to keep connection alive (started per successful connection)
        this.pingInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
          }
        }, 30000);

        resolved = true;
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
        if (!resolved) reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WARNING] WebSocket disconnected - Code: ${code}, Reason: ${reason || 'No reason provided'}`);

        // Clear ping interval on disconnect
        if (this.pingInterval) {
          clearInterval(this.pingInterval);
          this.pingInterval = null;
        }

        if (this.manualDisconnect) return;

        // Exponential backoff reconnect (max 60s)
        console.log(`[INFO] Reconnecting in ${this.reconnectDelay / 1000}s...`);
        setTimeout(() => {
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60000);
          this.connectWebSocket().catch(() => {});
        }, this.reconnectDelay);
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
      const errData = message.data;
      console.error('[ERROR] Pusher error:', JSON.stringify(errData));
      if (errData.code === 4200) {
        // Pusher requests immediate reconnect
        console.log('[INFO] Pusher requested immediate reconnect');
        if (this.ws) this.ws.close();
      } else if (errData.code === null && typeof errData.message === 'string' && errData.message.includes('No current subscription')) {
        // Re-subscribe to the missing channel
        const match = errData.message.match(/channel ([\w.]+)/);
        if (match && this.ws && this.ws.readyState === WebSocket.OPEN) {
          console.log(`[INFO] Re-subscribing to ${match[1]}`);
          this.ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: match[1] } }));
        }
      }
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

    // Intercept numeric replies for pending location clarifications
    const locationPending = this.pendingLocationClarifications.get(username);
    if (locationPending && /^\d+$/.test(message.trim()) && Date.now() - locationPending.timestamp < 60000) {
      this.handleLocationClarificationReply(clientWrapper, username, parseInt(message.trim(), 10), kickTags).catch(err => {
        console.error('[LOCATION] Clarification reply error:', err.message);
      });
      return;
    }

    // Inline command: !location (handled before plugin dispatch — needs direct config/instance access)
    if (isCommand && requestedCommandName === 'location') {
      this.handleLocationCommand(clientWrapper, message, kickTags).catch(err => {
        console.error('[LOCATION] Command error:', err.message);
      });
      return;
    }

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

      const newAccessToken = response.data.access_token;
      const newRefreshToken = response.data.refresh_token;
      const newExpiresIn = response.data.expires_in;

      if (typeof newAccessToken !== 'string' || newAccessToken.length === 0) {
        console.error('[AUTH] Token refresh response missing valid access_token — retaining existing token. Response:', JSON.stringify(response.data).substring(0, 200));
        return;
      }

      this.config.oauth.accessToken = newAccessToken;
      // Only update refresh_token if the response provided one (some flows omit it)
      if (typeof newRefreshToken === 'string' && newRefreshToken.length > 0) {
        this.config.oauth.refreshToken = newRefreshToken;
      }
      this.config.oauth.expiresAt = Date.now() + ((typeof newExpiresIn === 'number' ? newExpiresIn : 3600) * 1000);
      this.config.lastUpdated = new Date().toISOString();

      // Save updated config
      const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log('[AUTH] Channel token refreshed');
    } catch (error) {
      console.error('[ERROR] Failed to refresh channel token:', error.message);
    }
  }

  async handleLocationCommand(clientWrapper, message, kickTags) {
    const username = kickTags.username;

    // Parse: "!location home set Bangkok" → target="home", subcommand="set", rest="Bangkok"
    // Parse: "!location current set Paris" → target="current", subcommand="set", rest="Paris"
    const parts = message.trim().split(/\s+/);
    // parts[0] = "!location", parts[1] = target (home|current), parts[2] = subcommand (set), parts[3+] = value
    const target = (parts[1] || '').toLowerCase();
    const subcommand = (parts[2] || '').toLowerCase();

    if ((target === 'home' || target === 'current') && subcommand === 'set') {
      // Permission check — silent ignore for non-moderators
      if (!kickTags.isModUp) {
        return;
      }

      const value = parts.slice(3).join(' ').trim();
      if (!value) {
        await clientWrapper.say(`#${this.channelName}`, `Usage: !location ${target} set <city, country, state, or region>`);
        return;
      }

      await this._resolveAndSetLocation(clientWrapper, username, value, target);
    }
    // Future subcommands (clear, show) — designed in, not implemented in v1.2
  }

  async _resolveAndSetLocation(clientWrapper, username, value) {
    const systemPrompt = `You are a geography resolver. Given a place name, return a JSON object with these fields:
- "status": "resolved" | "ambiguous" | "unknown"
- "location": { "country": "", "city": "", "state": "", "province": "" }  (only when status=resolved; fill only the fields that apply, leave others as "")
- "options": [ { "label": "...", "location": {...} }, ... ]  (only when status=ambiguous; 2-4 options max)

Rules:
- If input names a city, infer and fill "country" (e.g. "Bangkok" → city=Bangkok, country=Thailand)
- If input names a US/Canadian state or province, fill "country" accordingly
- If input could be multiple different geo-types or locations (e.g. "Georgia" is a country AND a US state), set status=ambiguous and provide options
- If input is not a real place, set status=unknown
- Return ONLY valid JSON. No explanation, no markdown fences.`;

    const fetchFn = globalThis.fetch ?? require('node-fetch');

    let resolved;
    try {
      const response = await fetchFn('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          system: systemPrompt,
          messages: [{ role: 'user', content: value }]
        })
      });

      if (!response.ok) {
        throw new Error(`API ${response.status}`);
      }

      const data = await response.json();
      const raw = data.content?.[0]?.text || '';
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      resolved = JSON.parse(text);
    } catch (err) {
      console.error('[LOCATION] Claude API error:', err.message);
      await clientWrapper.say(`#${this.channelName}`, 'Could not resolve location. Try again or use a more specific value.');
      return;
    }

    if (resolved.status === 'unknown') {
      await clientWrapper.say(`#${this.channelName}`, `Unknown location: "${value}". Try a more specific value.`);
      return;
    }

    if (resolved.status === 'ambiguous' && Array.isArray(resolved.options) && resolved.options.length > 0) {
      // Store pending clarification
      this.pendingLocationClarifications.set(username, {
        options: resolved.options,
        timestamp: Date.now()
      });

      const optionList = resolved.options
        .map((opt, i) => `${i + 1} for ${opt.label}`)
        .join(', ');
      await clientWrapper.say(`#${this.channelName}`, `"${value}" is ambiguous. Reply ${optionList}.`);
      return;
    }

    // Resolved — write to config
    await this._writeLocation(clientWrapper, resolved.location);
  }

  async handleLocationClarificationReply(clientWrapper, username, choice, kickTags) {
    const pending = this.pendingLocationClarifications.get(username);
    if (!pending) return;

    // Clear pending state regardless of outcome
    this.pendingLocationClarifications.delete(username);

    // Permission check (re-check in case status changed)
    if (!kickTags.isModUp) return;

    const selected = pending.options[choice - 1];
    if (!selected) {
      await clientWrapper.say(`#${this.channelName}`, `Invalid selection. Use !location set again.`);
      return;
    }

    await this._writeLocation(clientWrapper, selected.location);
  }

  async _writeLocation(clientWrapper, location) {
    // Upsert: create location field if absent (LOC-07 — pre-v1.1 configs)
    if (!this.config.location) {
      this.config.location = { country: '', city: '', state: '', province: '' };
    }

    this.config.location.country  = location.country  || '';
    this.config.location.city     = location.city     || '';
    this.config.location.state    = location.state    || '';
    this.config.location.province = location.province || '';
    this.config.lastUpdated = new Date().toISOString();

    // Build human-readable confirmation string (only non-empty fields)
    const parts = [
      this.config.location.city,
      this.config.location.state || this.config.location.province,
      this.config.location.country
    ].filter(Boolean);
    const display = parts.join(', ');

    // Send confirmation BEFORE writing config (bot may restart on PM2 after write)
    await clientWrapper.say(`#${this.channelName}`, `Location set: ${display}`);

    // Write config to disk
    const configPath = path.join(__dirname, '..', 'channel-configs', `${this.channelName}.json`);
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    console.log(`[LOCATION] Config written for ${this.channelName}: ${display}`);
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
    let attempt = 0;
    while (true) {
      try {
        await this.ensureAuthenticated();
        await this.getChatroomId();
        this.startTokenRefreshScheduler();
        await this.connectWebSocket();
        return;
      } catch (error) {
        attempt++;
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
        console.error(`[ERROR] Failed to connect (attempt ${attempt}): ${error.message}`);
        console.log(`[INFO] Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  disconnect() {
    this.manualDisconnect = true;

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
