/**
 * Inline commands (handled directly in this file, not in bot-commands/)
 *
 * !location home set <place>     — Set the channel's home currency location (mods only)
 * !location current set <place>  — Set the channel's current currency location (mods only)
 *
 * !config exclude add <command>    — Disable a command for this channel (broadcaster only)
 * !config exclude remove <command> — Re-enable a disabled command (broadcaster only)
 * !config exclude list             — List all disabled commands (broadcaster only)
 *
 * Channel config (channel-configs/<channel>.json):
 *
 * excludedCommands: ["fx", "translate"]
 *   — Managed via !config exclude. Prevents listed commands from loading or
 *     responding in this channel. Changes take effect immediately (no restart needed).
 */

import 'dotenv/config';
import axios from 'axios';
import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import KickAuth = require('../auth');
import { ChannelConfig, CommandFn, KickTags, ClientWrapper, ChannelLocation, LocationSubfields } from '../types';
import { markBotOutput } from '../recent-bot-outputs';
import { resolveBotIdentity } from '../bot-identity';
import { WebhookPoller } from './webhook-poller';

const CHANNEL_NAME = '$$UPDATEHERE$$';

interface ResolvedLocation {
  status: 'resolved' | 'ambiguous' | 'unknown';
  location?: Record<string, string>;
  options?: Array<{ label: string; location: Record<string, string> }>;
}

interface PusherMessage {
  event?: string;
  channel?: string;
  data?: string | Record<string, unknown>;
}

class KickChatBot {
  private channelName: string;
  private chatroomId: number | null;
  private broadcasterUserId: number | null;
  private ws: WebSocket | null;
  private prefix: string;
  private commands: Map<string, CommandFn>;
  private auth: InstanceType<typeof KickAuth>;
  private apiBase: string;
  private config: ChannelConfig;
  private tokenRefreshInterval: NodeJS.Timeout | null;
  private reconnectDelay: number;
  private manualDisconnect: boolean;
  private pingInterval: NodeJS.Timeout | null;
  private webhookPoller: WebhookPoller;
  private pendingLocationClarifications: Map<string, {
    options: Array<{ label: string; location: Record<string, string> }>;
    timestamp: number;
    targetKey: string;
  }>;

  constructor(channelName: string) {
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

    this.pingInterval = null;

    this.pendingLocationClarifications = new Map(); // username -> { options, timestamp, targetKey }

    this.webhookPoller = new WebhookPoller(this.channelName, (data) => this.handleChatMessage(data));

    this.setupCommands();
  }

  saveChatroomId(realId: number): void {
    try {
      const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ChannelConfig;
        config.chatroomId = realId;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[INFO] Corrected chatroom ID saved to config: ${realId}`);
      }
    } catch (e) {
      if (e instanceof Error) {
        console.error('[ERROR] Failed to save corrected chatroom ID:', e.message);
      }
    }
  }

  loadConfig(): ChannelConfig {
    try {
      const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ChannelConfig;
        console.log(`[CONFIG] Loaded config for ${this.channelName}`);
        return config;
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`[CONFIG] Failed to load config: ${error.message}`);
      }
    }

    // Return default config
    return {
      channelName: this.channelName,
      chatOnly: true,
      excludedCommands: [],
      lastUpdated: new Date().toISOString()
    };
  }

  setupCommands(): void {
    const excludedCommands: string[] = Array.isArray(this.config.excludedCommands)
      ? (this.config.excludedCommands as string[])
      : [];

    console.log('[COMMANDS] Loading bot commands from bot-commands directory...');

    // After compilation: __dirname = dist/channels/
    // Navigate: dist/channels/ -> dist/ -> dist/bot-commands/
    const commandsDir = path.join(__dirname, '..', 'bot-commands');
    let files: string[] = [];
    try {
      files = fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'));
    } catch (err) {
      if (err instanceof Error) {
        console.error('[COMMANDS] Failed to read bot-commands directory:', err.message);
      }
      return;
    }

    const commandFiles = files.map(f => path.join(commandsDir, f));

    commandFiles.forEach(file => {
      try {
        const functionName = path.basename(file, '.js');

        // Skip if command is in the excluded list
        if (excludedCommands.includes(functionName)) {
          console.log(`[COMMANDS] Skipping excluded command: ${functionName}`);
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const commandExports = require(file) as Record<string, unknown>;
        if (typeof commandExports[functionName] === 'function') {
          this.commands.set(functionName, commandExports[functionName] as CommandFn);
          console.log(`[COMMANDS] Loaded command: ${functionName}`);
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error(`[COMMANDS] Failed to load command from ${file}: ${error.message}`);
          console.error(`[COMMANDS] Command "${path.basename(file, '.js')}" is DISABLED — fix the module and restart to re-enable`);
        }
      }
    });

    console.log(`[COMMANDS] Loaded ${this.commands.size} commands`);
  }

  reloadCommands(): void {
    this.commands.clear();
    this.setupCommands();
  }

  saveConfig(): void {
    const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      console.log('[AUTH] Bot token not available — waiting for OAuth Token Manager to authenticate...');
      // Poll until the token manager provides valid tokens rather than competing on port 3004
      let attempts = 0;
      while (!this.auth.isAuthenticated()) {
        attempts++;
        if (attempts > 12) {
          throw new Error('Bot token unavailable after 60s — OAuth Token Manager may need attention');
        }
        await new Promise(r => setTimeout(r, 5000));
      }
      console.log('[AUTH] Bot token now available');
    } else {
      console.log('[AUTH] Already authenticated');
    }
  }

  async getChatroomId(): Promise<number | null> {
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
        const channelData = response.data.data[0] as { broadcaster_user_id?: number };

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
      if (error instanceof Error) {
        console.error(`[ERROR] Failed to get chatroom ID: ${error.message}`);
        console.error(`[ERROR] Please set chatroomId in channel config file`);
      }
      throw error;
    }
  }

  subscribeToChannels(): void {
    const channel = `chatrooms.${this.chatroomId}.v2`;
    this.ws!.send(JSON.stringify({ event: 'pusher:unsubscribe', data: { channel } }));
    this.ws!.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel } }));
    console.log(`[INFO] Sent subscription request for ${channel}`);
  }

  async connectWebSocket(): Promise<void> {
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

      this.ws.on('message', (data: WebSocket.RawData) => {
        try {
          const message = JSON.parse(data.toString()) as PusherMessage;
          this.handleWebSocketMessage(message);
        } catch (err) {
          if (err instanceof Error) {
            console.error('[ERROR] Failed to parse WebSocket message:', err.message);
          }
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

  handleWebSocketMessage(message: PusherMessage): void {
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
      const errData = message.data as Record<string, unknown> | undefined;
      console.error('[ERROR] Pusher error:', JSON.stringify(errData));

      const isObj = errData && typeof errData === 'object' && !Array.isArray(errData);
      const code = isObj ? errData.code : undefined;
      const errMsg = isObj && typeof errData.message === 'string' ? errData.message : '';

      if (code === 4200) {
        // Pusher requests immediate reconnect
        console.log('[INFO] Pusher requested immediate reconnect');
        if (this.ws) this.ws.close();
      } else if (/no current subscription|subscription in progress/i.test(errMsg)) {
        // Subscription was lost server-side — resubscribe on existing WS to self-heal silent deafness
        console.log('[INFO] Subscription lost — resubscribing');
        this.subscribeToChannels();
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
      console.error('[ERROR] Subscription failed, forcing reconnect:', JSON.stringify(message));
      if (this.ws) this.ws.close();
      return;
    }

    // Handle chat events - data field is a JSON string that needs parsing
    try {
      if (message.event === 'App\\Events\\ChatMessageEvent') {
        // Self-correct chatroom ID from real Pusher channel name on first message
        const chatroomMatch = message.channel?.match(/chatrooms\.(\d+)/);
        if (chatroomMatch && chatroomMatch[1]) {
          const realId = parseInt(chatroomMatch[1], 10);
          if (realId !== this.chatroomId) {
            console.log(`[INFO] Correcting chatroom ID: ${this.chatroomId} → ${realId}`);
            this.chatroomId = realId;
            this.saveChatroomId(realId);
          }
        }
        const eventData = (typeof message.data === 'string'
          ? JSON.parse(message.data)
          : message.data) as Record<string, unknown>;
        this.webhookPoller.markSeen(eventData?.id as string | undefined);
        this.handleChatMessage(eventData);
      } else if (message.event === 'App\\Events\\SubscriptionEvent') {
        const eventData = (typeof message.data === 'string'
          ? JSON.parse(message.data)
          : message.data) as Record<string, unknown>;
        console.log(`[EVENT] ${eventData.username} just subscribed!`);
      } else if (message.event === 'App\\Events\\GiftedSubscriptionsEvent') {
        const eventData = (typeof message.data === 'string'
          ? JSON.parse(message.data)
          : message.data) as Record<string, unknown>;
        const giftedUsernames = eventData.gifted_usernames as unknown[] | undefined;
        const count = giftedUsernames?.length ?? '?';
        console.log(`[EVENT] ${eventData.gifter_username} gifted ${count} subs!`);
      } else {
        // Log unknown events to see what we're missing
        if (message.event && !message.event.startsWith('pusher')) {
          console.log('[UNKNOWN EVENT]', message.event, 'Channel:', message.channel);
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        console.error('[ERROR] Failed to parse WebSocket event data:', err.message, 'Event:', message.event);
      }
    }
  }

  handleChatMessage(data: Record<string, unknown>): void {
    const sender = data.sender as { username?: string; identity?: { badges?: Array<{ type: string; [key: string]: unknown }> }; id?: number } | undefined;
    const content = data.content as string | undefined;

    if (!sender?.username || !content) {
      console.warn('[COMMANDS] Skipping malformed chat message — missing sender or content:', JSON.stringify(data).substring(0, 200));
      return;
    }
    const username = sender.username;
    const message = content;
    const badges = sender?.identity?.badges || [];

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
    const excludedCommands = (this.config.excludedCommands as string[] | undefined) || [];

    // For command messages, check if the requested command is excluded FIRST
    if (isCommand && excludedCommands.includes(requestedCommandName)) {
      console.log(`[COMMANDS] Command "${requestedCommandName}" is excluded for channel ${this.channelName}`);
      return;
    }

    // Build permission flags from badges
    const isBroadcaster = badges.some(b => b.type === 'broadcaster' || b.type === 'owner');
    const isMod = badges.some(b => b.type === 'moderator') || isBroadcaster;
    const isVip = badges.some(b => b.type === 'vip');
    const isFounder = badges.some(b => b.type === 'founder');
    const isSubGifter = badges.some(b => b.type === 'sub_gifter');
    // Founder is NOT a proxy for active subscription on Kick — the badge
    // persists after unsub, and the literal subscriber badge is shown alongside
    // founder when both apply. Treat them as independent signals.
    const isSubscriber = badges.some(b => b.type === 'subscriber');
    const isModUp = isMod || isBroadcaster;
    const isVIPUp = isVip || isModUp;

    // Create Kick-compatible tags object for commands
    const kickTags: KickTags = {
      username: username,
      'display-name': sender.username,
      badges: {
        broadcaster: isBroadcaster ? '1' : undefined,
        moderator: isMod ? '1' : undefined,
        vip: isVip ? '1' : undefined,
        subscriber: isSubscriber ? '1' : undefined,
        founder: isFounder ? '1' : undefined,
        sub_gifter: isSubGifter ? '1' : undefined
      },
      isBroadcaster: isBroadcaster,
      isModUp: isModUp,
      isVIPUp: isVIPUp,
      rawBadges: badges,
      senderId: sender?.id
    };

    // Create client wrapper for commands
    const clientWrapper: ClientWrapper = {
      say: async (_channel: string, msg: string): Promise<void> => {
        console.log(`[COMMAND RESPONSE] ${msg}`);
        await this.sendMessage(msg);
      }
    };

    // Intercept numeric replies for pending location clarifications
    const locationPending = this.pendingLocationClarifications.get(username);
    if (locationPending && /^\d+$/.test(message.trim()) && Date.now() - locationPending.timestamp < 60000) {
      this.handleLocationClarificationReply(clientWrapper, username, parseInt(message.trim(), 10), kickTags).catch(err => {
        if (err instanceof Error) {
          console.error('[LOCATION] Clarification reply error:', err.message);
        }
      });
      return;
    }

    // Inline command: !location (handled before plugin dispatch — needs direct config/instance access)
    if (isCommand && requestedCommandName === 'location') {
      this.handleLocationCommand(clientWrapper, message, kickTags).catch(err => {
        if (err instanceof Error) {
          console.error('[LOCATION] Command error:', err.message);
        }
      });
      return;
    }

    // Inline command: !config (broadcaster only)
    if (isCommand && requestedCommandName === 'config') {
      if (!kickTags.isBroadcaster) return;
      this.handleConfigCommand(clientWrapper, message, kickTags).catch(err => {
        if (err instanceof Error) {
          console.error('[CONFIG] Command error:', err.message);
        }
      });
      return;
    }

    // Execute ALL command functions for ALL messages (they handle their own filtering)
    this.commands.forEach((commandFunction, commandName) => {
      try {
        void commandFunction(clientWrapper, message, `#${this.channelName}`, kickTags, this.config);
      } catch (error) {
        // Only log actual errors, not "not our command" type messages
        if (error instanceof Error && !error.message.includes('Not our command')) {
          console.error(`[COMMANDS] Command ${commandName} failed: ${error.message}`);
        }
      }
    });
  }

  async getChannelAccessToken(): Promise<{ token: string; isChannelToken: boolean }> {
    // Use channel's own OAuth token if available
    if (this.config.oauth?.accessToken) {
      // Check if token needs refresh
      if (this.config.oauth.expiresAt && this.config.oauth.expiresAt < Date.now() + 300000) {
        const refreshed = await this.refreshChannelToken();
        if (!refreshed) {
          // Refresh failed (token likely fully expired) — fall back to bot token
          console.log('[AUTH] Channel token refresh failed, falling back to bot token');
          return { token: await this.auth.getAccessToken() ?? '', isChannelToken: false };
        }
      }
      return { token: this.config.oauth.accessToken, isChannelToken: true };
    }
    // Fallback to bot's token
    return { token: await this.auth.getAccessToken() ?? '', isChannelToken: false };
  }

  async refreshChannelToken(): Promise<boolean> {
    if (!this.config.oauth?.refreshToken) return false;

    try {
      const response = await axios.post('https://id.kick.com/oauth/token',
        new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: process.env.CLIENT_ID || '',
          client_secret: process.env.CLIENT_SECRET || '',
          refresh_token: this.config.oauth.refreshToken
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );

      const newAccessToken = response.data.access_token as unknown;
      const newRefreshToken = response.data.refresh_token as unknown;
      const newExpiresIn = response.data.expires_in as unknown;

      if (typeof newAccessToken !== 'string' || newAccessToken.length === 0) {
        console.error('[AUTH] Token refresh response missing valid access_token. Response:', JSON.stringify(response.data).substring(0, 200));
        return false;
      }

      this.config.oauth.accessToken = newAccessToken;
      // Only update refresh_token if the response provided one (some flows omit it)
      if (typeof newRefreshToken === 'string' && newRefreshToken.length > 0) {
        this.config.oauth.refreshToken = newRefreshToken;
      }
      this.config.oauth.expiresAt = Date.now() + ((typeof newExpiresIn === 'number' ? newExpiresIn : 3600) * 1000);
      this.config.lastUpdated = new Date().toISOString();

      // Save updated config
      const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
      fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
      console.log('[AUTH] Channel token refreshed');
      return true;
    } catch (error) {
      if (error instanceof Error) {
        console.error('[ERROR] Failed to refresh channel token:', error.message);
      }
      return false;
    }
  }

  async handleConfigCommand(clientWrapper: ClientWrapper, message: string, _kickTags: KickTags): Promise<void> {
    const args = message.trim().split(/\s+/);
    const subcommand = (args[1] || '').toLowerCase();

    if (subcommand === 'exclude') {
      if (!this.config.excludedCommands) this.config.excludedCommands = [];
      const action = (args[2] || '').toLowerCase();
      const rawCommandName = args[3];

      if (action === 'add' && rawCommandName) {
        const commandName = rawCommandName.toLowerCase();
        if (!/^[a-zA-Z0-9_-]{1,30}$/.test(commandName)) {
          await clientWrapper.say(`#${this.channelName}`, `Invalid command name: ${rawCommandName}`);
          return;
        }
        const excludedList = this.config.excludedCommands as string[];
        if (!excludedList.includes(commandName)) {
          excludedList.push(commandName);
          this.saveConfig();
          this.reloadCommands();
          await clientWrapper.say(`#${this.channelName}`, `Command "${commandName}" disabled for this channel.`);
        } else {
          await clientWrapper.say(`#${this.channelName}`, `Command "${commandName}" is already disabled.`);
        }

      } else if (action === 'remove' && rawCommandName) {
        const commandName = rawCommandName.toLowerCase();
        if (!/^[a-zA-Z0-9_-]{1,30}$/.test(commandName)) {
          await clientWrapper.say(`#${this.channelName}`, `Invalid command name: ${rawCommandName}`);
          return;
        }
        const excludedList = this.config.excludedCommands as string[];
        const index = excludedList.indexOf(commandName);
        if (index > -1) {
          excludedList.splice(index, 1);
          this.saveConfig();
          this.reloadCommands();
          await clientWrapper.say(`#${this.channelName}`, `Command "${commandName}" re-enabled for this channel.`);
        } else {
          await clientWrapper.say(`#${this.channelName}`, `Command "${commandName}" is not currently disabled.`);
        }

      } else if (action === 'list') {
        const excludedList = this.config.excludedCommands as string[];
        const list = excludedList.length > 0
          ? excludedList.join(', ')
          : 'None';
        await clientWrapper.say(`#${this.channelName}`, `Disabled commands: ${list}`);

      } else {
        await clientWrapper.say(`#${this.channelName}`, `Usage: !config exclude add/remove/list [commandname]`);
      }

    } else if (subcommand === 'autotranslate') {
      const action = (args[2] || '').toLowerCase();
      const current = this.config.autoTranslate || { enabled: false };

      if (action === 'on') {
        this.config.autoTranslate = { ...current, enabled: true };
        this.saveConfig();
        await clientWrapper.say(`#${this.channelName}`, `Auto-translate enabled — non-English chat will be translated to English.`);

      } else if (action === 'off') {
        this.config.autoTranslate = { ...current, enabled: false };
        this.saveConfig();
        await clientWrapper.say(`#${this.channelName}`, `Auto-translate disabled.`);

      } else if (action === 'status') {
        const state = current.enabled ? 'ON' : 'OFF';
        await clientWrapper.say(`#${this.channelName}`, `Auto-translate is ${state}.`);

      } else {
        await clientWrapper.say(`#${this.channelName}`, `Usage: !config autotranslate on/off/status`);
      }

    } else {
      await clientWrapper.say(`#${this.channelName}`, `Config commands: !config exclude add/remove/list [commandname] | !config autotranslate on/off/status`);
    }
  }

  async handleLocationCommand(clientWrapper: ClientWrapper, message: string, kickTags: KickTags): Promise<void> {
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

  async _resolveAndSetLocation(clientWrapper: ClientWrapper, username: string, value: string, targetKey: string): Promise<void> {
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

    let resolved: ResolvedLocation;
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY || '',
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

      const data = await response.json() as { content?: Array<{ text?: string }> };
      const raw = data.content?.[0]?.text || '';
      const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
      resolved = JSON.parse(text) as ResolvedLocation;
    } catch (err) {
      if (err instanceof Error) {
        console.error('[LOCATION] Claude API error:', err.message);
      }
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
        timestamp: Date.now(),
        targetKey: targetKey
      });

      const optionList = resolved.options
        .map((opt, i) => `${i + 1} for ${opt.label}`)
        .join(', ');
      await clientWrapper.say(`#${this.channelName}`, `"${value}" is ambiguous. Reply ${optionList}.`);
      return;
    }

    // Resolved — write to config
    if (resolved.location) {
      await this._writeLocation(clientWrapper, resolved.location, targetKey);
    }
  }

  async handleLocationClarificationReply(clientWrapper: ClientWrapper, username: string, choice: number, kickTags: KickTags): Promise<void> {
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

    await this._writeLocation(clientWrapper, selected.location, pending.targetKey);
  }

  async _writeLocation(clientWrapper: ClientWrapper, location: Record<string, string>, targetKey: string): Promise<void> {
    // Migration and upsert logic:
    //
    // Case 1 — No location field at all (pre-v1.1 config, LOC-19):
    //   Create full nested structure from scratch.
    //
    // Case 2 — Flat v1.1 location field { country, city, state, province } (LOC-18):
    //   Migrate: move flat data to location.home, initialize location.current as empty.
    //   Then write to the requested targetKey as normal.
    //
    // Case 3 — Already nested v1.2 structure:
    //   Write directly to location[targetKey].

    if (!this.config.location) {
      // Case 1: no location field — create full nested structure
      this.config.location = {
        home:    { country: '', city: '', state: '', province: '' },
        current: { country: '', city: '', state: '', province: '' }
      };
    } else if (!this.config.location.home && !this.config.location.current) {
      // Case 2: flat v1.1 shape — migrate flat data to home, initialize current as empty
      const flat = this.config.location as unknown as LocationSubfields;
      this.config.location = {
        home: {
          country:  flat.country  || '',
          city:     flat.city     || '',
          state:    flat.state    || '',
          province: flat.province || ''
        },
        current: { country: '', city: '', state: '', province: '' }
      };
    }
    // Case 3: already nested — no migration needed, fall through

    // Write to the target sub-object — go through ChannelLocation to bypass index signature
    const channelLoc = this.config.location as ChannelLocation;
    (channelLoc[targetKey as keyof ChannelLocation] as LocationSubfields) = {
      country:  location.country  || '',
      city:     location.city     || '',
      state:    location.state    || '',
      province: location.province || ''
    };
    this.config.lastUpdated = new Date().toISOString();

    // Build human-readable confirmation string (only non-empty fields)
    const locSub = channelLoc[targetKey as keyof ChannelLocation] as LocationSubfields;
    const parts = [
      locSub.city,
      locSub.state || locSub.province,
      locSub.country
    ].filter(Boolean);
    const display = parts.join(', ');

    // Confirmation label based on target key
    const label = targetKey === 'home' ? 'Home location set' : 'Current location set';

    // Send confirmation BEFORE writing config (bot may restart on PM2 after write)
    await clientWrapper.say(`#${this.channelName}`, `${label}: ${display}`);

    // Write config to disk (non-atomic — matches existing in-bot pattern per project decision)
    const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
    fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    console.log(`[LOCATION] Config written for ${this.channelName} (${targetKey}): ${display}`);
  }

  async checkAndRefreshToken(): Promise<void> {
    // Only check if we have OAuth configured
    if (!this.config.oauth?.accessToken) return;

    try {
      // Reload config from disk in case it was updated externally
      const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${this.channelName}.json`);
      try {
        const raw = await fs.promises.readFile(configPath, 'utf8');
        this.config = JSON.parse(raw) as ChannelConfig;
      } catch (readErr) {
        if (readErr instanceof Error && (readErr as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error('[AUTH] Failed to reload config:', readErr.message);
        }
      }

      // Check if token needs refresh (within 1 hour of expiry)
      if (this.config.oauth?.expiresAt && this.config.oauth.expiresAt < Date.now() + 3600000) {
        console.log('[AUTH] Token expiring soon, refreshing proactively...');
        await this.refreshChannelToken();
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error('[ERROR] Failed to check/refresh token:', error.message);
      }
    }
  }

  startTokenRefreshScheduler(): void {
    // Check token every 30 minutes
    this.tokenRefreshInterval = setInterval(() => {
      this.checkAndRefreshToken().catch(() => {});
    }, 30 * 60 * 1000);

    // Also check immediately on startup
    this.checkAndRefreshToken().catch(() => {});
    console.log('[AUTH] Token refresh scheduler started (checks every 30 minutes)');
  }

  async sendMessage(message: string): Promise<unknown> {
    try {
      const { token: accessToken, isChannelToken: hasChannelOAuth } = await this.getChannelAccessToken();

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
          const isSpecialChar = codePoint !== undefined && codePoint > 127; // Non-ASCII character

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
      markBotOutput(this.channelName, sanitized);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errData = error.response?.data as { message?: string } | undefined;
        console.error(`[ERROR] Failed to send message: ${errData?.message || error.message}`);
      } else if (error instanceof Error) {
        console.error(`[ERROR] Failed to send message: ${error.message}`);
      }
      throw error;
    }
  }

  async connect(): Promise<void> {
    let attempt = 0;
    while (true) {
      try {
        await this.ensureAuthenticated();
        // Fire-and-forget — handlers degrade gracefully if it's not resolved yet
        resolveBotIdentity().catch(() => {});
        await this.getChatroomId();
        this.startTokenRefreshScheduler();
        await this.connectWebSocket();
        this.webhookPoller.start();
        return;
      } catch (error) {
        attempt++;
        const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
        if (error instanceof Error) {
          console.error(`[ERROR] Failed to connect (attempt ${attempt}): ${error.message}`);
        }
        console.log(`[INFO] Retrying in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  disconnect(): void {
    this.manualDisconnect = true;

    // Clear token refresh interval
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
      console.log('[INFO] Token refresh scheduler stopped');
    }

    this.webhookPoller.stop();

    if (this.ws) {
      console.log('[INFO] Disconnecting from Kick chat...');
      this.ws.close();
    }
  }
}

// Main execution
async function main(): Promise<void> {
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
