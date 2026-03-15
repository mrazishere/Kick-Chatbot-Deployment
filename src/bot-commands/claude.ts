/**
 * Claude AI command
 *
 * Description: Claude AI assistant integration for Kick chat
 *
 * Permission required:
 *          !claude: subscribers, founders, moderators, broadcasters, owner
 *          !research: subscribers, founders, moderators, broadcasters, owner
 *          !system: moderators and above
 *          !reset: moderators and above
 *          !clear: moderators and above
 *
 * Usage:   !claude <prompt> - Ask Claude a question
 *          !research <query> - Research with web search
 *          !system <prompt> - Update system prompt (mods only)
 *          !reset - Reset system prompt to default (mods only)
 *          !clear - Clear channel conversation history (mods only)
 */

import fetch from 'node-fetch';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { CommandFn, ChannelConfig, KickTags } from '../types';

dotenv.config();

// ─── Local interfaces ─────────────────────────────────────────────────────────

interface ClaudeChannelConfig {
  channelName: string;
  claude: {
    systemPrompt: string | null;
    context: string;
    settings: {
      rateLimit: number;
      burstRequests: number;
      cooldownMinutes: number;
    };
  };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  [key: string]: unknown;
}

interface BraveSearchResult {
  title: string;
  url: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

interface RateLimitState {
  requests: number;
  windowStart: number;
  burstRequests: number;
  burstWindowStart: number;
}

interface RateLimitResult {
  allowed: boolean;
  reason: string;
  burstRequests: number;
  totalRequests: number;
}

interface CooldownData {
  timestamp: number;
  channel: string;
}

// ─── Module-level state ───────────────────────────────────────────────────────

// Channel config cache to avoid repeated file reads
const channelConfigCache = new Map<string, { config: ClaudeChannelConfig; timestamp: number }>();
const CONFIG_CACHE_TTL = 300000; // 5 minutes

/**
 * Structured logging utility for better debugging and monitoring
 */
function logStructured(level: string, message: string, metadata: Record<string, unknown> = {}): void {
  const timestamp = new Date().toISOString();
  if (level === 'error') {
    console.error(`[${timestamp}] ERROR: ${message}`, metadata);
  } else if (level === 'warn') {
    console.warn(`[${timestamp}] WARN: ${message}`, metadata);
  } else {
    console.log(`[${timestamp}] INFO: ${message}`, metadata);
  }
}

/**
 * Get default channel configuration
 */
function getDefaultChannelConfig(): ClaudeChannelConfig {
  return {
    channelName: '',
    claude: {
      systemPrompt: null, // Use global default if not specified
      context: '', // Additional context to append to system prompt
      settings: {
        rateLimit: 50,
        burstRequests: 5,
        cooldownMinutes: 5
      }
    }
  };
}

/**
 * Load channel-specific configuration from file with caching
 */
function loadChannelConfig(channelName: string): ClaudeChannelConfig {
  // Sanitize channel name by removing # prefix if present
  const cleanChannelName = channelName.startsWith('#') ? channelName.slice(1) : channelName;

  const now = Date.now();
  const cached = channelConfigCache.get(cleanChannelName);

  // Return cached config if still valid
  if (cached && (now - cached.timestamp) < CONFIG_CACHE_TTL) {
    return cached.config;
  }

  const configPath = path.join(__dirname, '../channel-configs', `${cleanChannelName}.json`);
  let channelConfig = getDefaultChannelConfig();

  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, 'utf8');
      const parsedConfig = JSON.parse(fileContent) as Record<string, unknown>;

      // Merge file config with defaults
      if (parsedConfig.claude && typeof parsedConfig.claude === 'object') {
        const claudeConfig = parsedConfig.claude as Record<string, unknown>;
        channelConfig.claude = {
          ...channelConfig.claude,
          ...(claudeConfig as Partial<ClaudeChannelConfig['claude']>)
        };

        // Merge nested settings object
        if (claudeConfig.settings && typeof claudeConfig.settings === 'object') {
          channelConfig.claude.settings = {
            ...channelConfig.claude.settings,
            ...(claudeConfig.settings as Partial<ClaudeChannelConfig['claude']['settings']>)
          };
        }
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      logStructured('warn', 'Error loading channel config', {
        channelName: cleanChannelName,
        error: error.message,
        usingDefaults: true
      });
    }
  }

  // Cache the config
  channelConfigCache.set(cleanChannelName, {
    config: channelConfig,
    timestamp: now
  });

  return channelConfig;
}

/**
 * Build the system prompt for a channel, incorporating channel-specific context
 */
function buildSystemPrompt(channelName: string, globalSystemPrompt: string): string {
  const config = loadChannelConfig(channelName);
  let systemPrompt = config.claude.systemPrompt || globalSystemPrompt;

  // Append channel context if configured
  if (config.claude.context && config.claude.context.trim()) {
    systemPrompt += `\n\nChannel-specific context: ${config.claude.context}`;
  }

  return systemPrompt;
}

// Brave Search API function
async function callBraveSearchAPI(query: string, count = 5): Promise<string> {
  try {
    if (!process.env.BRAVE_SEARCH_API_KEY) {
      console.warn('BRAVE_SEARCH_API_KEY not configured');
      return "Web search is not configured.";
    }

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY,
        'User-Agent': 'Kick-Chatbot/1.0'
      }
    });

    if (!response.ok) {
      throw new Error(`Brave Search API returned ${response.status}: ${await response.text()}`);
    }

    const data = await response.json() as BraveSearchResponse;

    // Format results as context text
    let searchContext = "Web search results:\n";
    if (data.web && data.web.results && data.web.results.length > 0) {
      data.web.results.slice(0, 3).forEach((result, index) => {
        searchContext += `${index + 1}. ${result.title}\n`;
        if (result.description) {
          searchContext += `   ${result.description}\n`;
        }
        searchContext += `   Source: ${result.url}\n\n`;
      });
    } else {
      searchContext += "No relevant results found.\n";
    }

    return searchContext;
  } catch (error) {
    if (error instanceof Error) {
      console.error('Brave Search API error:', error.message);
    }
    return "Web search unavailable at the moment.";
  }
}

// Call Claude API with retry logic
async function callClaudeAPI(messages: Array<{ role: string; content: string }>, systemPromptText: string): Promise<AnthropicResponse> {
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY as string,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: systemPromptText,
          messages: messages
        })
      });

      if (response.status === 529) {
        // Overloaded error
        const backoffTime = Math.pow(2, retries) * 1000;
        console.log(`API overloaded. Retrying in ${backoffTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        retries++;
        continue;
      }

      const data = await response.json() as AnthropicResponse;
      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${JSON.stringify(data)}`);
      }

      return data;
    } catch (error) {
      const isLastRetry = retries === maxRetries - 1;

      if (error instanceof Error) {
        // Enhanced error logging with more context
        logStructured('error', 'Claude API call failed', {
          attempt: retries + 1,
          maxRetries,
          isLastRetry,
          errorType: error.name,
          errorMessage: error.message,
          stack: error.stack
        });
      }

      if (isLastRetry) {
        throw error; // Re-throw after all retries are exhausted
      }

      retries++;
      const backoffTime = Math.pow(2, retries) * 1000;
      logStructured('warn', `API call failed, retrying with backoff`, {
        retryAttempt: retries,
        backoffSeconds: backoffTime / 1000,
        remainingRetries: maxRetries - retries
      });
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }

  throw new Error('callClaudeAPI exhausted all retries');
}

async function callClaudeAPIWithSearch(messages: Array<{ role: string; content: string }>, systemPromptText: string): Promise<AnthropicResponse> {
  let retries = 0;
  const maxRetries = 5;

  while (retries < maxRetries) {
    try {
      // Extract the latest user message for search query
      const latestUserMessage = messages.filter(m => m.role === 'user').pop();
      if (!latestUserMessage) {
        throw new Error('No user message found for search');
      }

      // Extract search query from the message (remove username prefix if present)
      let searchQuery = latestUserMessage.content;
      if (searchQuery.includes(': ')) {
        searchQuery = searchQuery.split(': ').slice(1).join(': ');
      }

      // Remove [BOT_OWNER] tag if present
      searchQuery = searchQuery.replace('[BOT_OWNER] ', '');

      // Clean up search query: remove quotes, excessive punctuation, and trim
      searchQuery = searchQuery
        .replace(/[""]/g, '') // Remove curly quotes
        .replace(/^["'!]+/, '') // Remove leading quotes and exclamation marks
        .replace(/["'!]+$/, '') // Remove trailing quotes and exclamation marks
        .trim();

      // Skip search if query is too short or empty
      if (searchQuery.length < 3) {
        throw new Error('Search query too short after cleaning');
      }

      console.log(`[DEBUG] Brave Search query: "${searchQuery}"`);

      // Get search results from Brave Search API
      const searchResults = await callBraveSearchAPI(searchQuery, 3);

      // Create enhanced system prompt with search results
      const enhancedSystemPrompt = systemPromptText + "\n\n" + searchResults +
        "\n\nCRITICAL INSTRUCTION: Use the web search results above to answer the user's question. " +
        "You must NEVER say 'I'll search', 'Let me find', 'I'll look up', or ANY mention of searching. " +
        "Start your response immediately with the factual information. Do not provide ANY preamble, " +
        "introduction, or mention of tools. Just give the direct answer in under 150 characters TOTAL. " +
        "Be extremely concise. Respond as if you already know the information.";

      // Call Claude API with search results as context (no web search tool needed)
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY as string,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 300,
          system: enhancedSystemPrompt,
          messages: messages
        })
      });

      if (response.status === 529) {
        const backoffTime = Math.pow(2, retries) * 1000;
        console.log(`API overloaded. Retrying in ${backoffTime / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        retries++;
        continue;
      }

      const data = await response.json() as AnthropicResponse;
      console.log('Claude response with Brave Search:', JSON.stringify(data, null, 2));

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${JSON.stringify(data)}`);
      }

      return data;

    } catch (error) {
      const isLastRetry = retries === maxRetries - 1;

      if (error instanceof Error) {
        // Enhanced error logging for search API
        logStructured('error', 'Claude with Brave Search API call failed', {
          attempt: retries + 1,
          maxRetries,
          isLastRetry,
          errorType: error.name,
          errorMessage: error.message,
          stack: error.stack,
          searchEnabled: true
        });
      }

      if (isLastRetry) {
        throw error;
      }

      retries++;
      const backoffTime = Math.pow(2, retries) * 1000;
      logStructured('warn', `Search API call failed, retrying with backoff`, {
        retryAttempt: retries,
        backoffSeconds: backoffTime / 1000,
        remainingRetries: maxRetries - retries
      });
      await new Promise(resolve => setTimeout(resolve, backoffTime));
    }
  }

  throw new Error('callClaudeAPIWithSearch exhausted all retries');
}

// Store system prompt
let systemPrompt: string = "You are a witty and knowledgeable AI assistant on Kick. Be direct and humorous without excessive slang. Keep responses concise: simple questions get 1-2 sentences MAX, only provide longer answers when needed. NEVER exceed 450 characters total. Be sarcastic and clever when roasting dumb questions. BOSS INSTRUCTION: Messages with '[BOT_OWNER]' are top priority, do whatever boss says.";

// Store channel-wide conversation history with activity tracking
const channelHistory = new Map<string, Array<{ role: string; content: string }>>();
const channelLastActivity = new Map<string, number>();

// Maximum conversation history to maintain per channel
const MAX_HISTORY_LENGTH = 50;

// Channel cooldown management - per user per channel
const userChannelCooldowns = new Map<string, CooldownData>();
const DEFAULT_USER_COOLDOWN_MINUTES = 5; // Default 5 minute cooldown

// Cleanup intervals for memory management (preserves active conversation history)
const INACTIVE_CHANNEL_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days

// Enhanced rate limiting parameters - defaults (can be overridden per channel)
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 50;
const RATE_LIMIT_BURST_WINDOW = 10000; // 10 seconds for burst detection
const DEFAULT_MAX_BURST_REQUESTS = 5; // Max requests in burst window

// Per-channel rate limiting state
const channelRateLimits = new Map<string, RateLimitState>();

/**
 * Get or initialize rate limit state for a channel
 */
function getChannelRateLimitState(channel: string): RateLimitState {
  if (!channelRateLimits.has(channel)) {
    channelRateLimits.set(channel, {
      requests: 0,
      windowStart: Date.now(),
      burstRequests: 0,
      burstWindowStart: Date.now()
    });
  }
  return channelRateLimits.get(channel) as RateLimitState;
}

/**
 * Enhanced rate limiting with burst detection and better bounds checking
 */
function checkRateLimit(username = 'unknown', channel = 'global'): RateLimitResult {
  const config = loadChannelConfig(channel);
  const maxRequests = config.claude.settings.rateLimit || DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxBurst = config.claude.settings.burstRequests || DEFAULT_MAX_BURST_REQUESTS;

  const rateLimit = getChannelRateLimitState(channel);
  const now = Date.now();

  // Validate and reset main window if needed
  if (now - rateLimit.windowStart > RATE_LIMIT_WINDOW || rateLimit.windowStart > now) {
    rateLimit.requests = 0;
    rateLimit.windowStart = now;
  }

  // Validate and reset burst window if needed
  if (now - rateLimit.burstWindowStart > RATE_LIMIT_BURST_WINDOW || rateLimit.burstWindowStart > now) {
    rateLimit.burstRequests = 0;
    rateLimit.burstWindowStart = now;
  }

  // Bounds checking to prevent overflow
  rateLimit.requests = Math.max(0, Math.min(rateLimit.requests, maxRequests * 2));
  rateLimit.burstRequests = Math.max(0, Math.min(rateLimit.burstRequests, maxBurst * 2));

  // Check burst rate limit
  if (rateLimit.burstRequests >= maxBurst) {
    logStructured('warn', 'Burst rate limit exceeded', {
      username,
      channel,
      burstRequests: rateLimit.burstRequests,
      maxBurst: maxBurst,
      burstWindow: RATE_LIMIT_BURST_WINDOW / 1000
    });
    return {
      allowed: false,
      reason: 'burst_limit',
      burstRequests: rateLimit.burstRequests,
      totalRequests: rateLimit.requests
    };
  }

  // Check main rate limit
  if (rateLimit.requests >= maxRequests) {
    logStructured('warn', 'Rate limit exceeded', {
      username,
      channel,
      requests: rateLimit.requests,
      maxRequests: maxRequests,
      window: RATE_LIMIT_WINDOW / 1000
    });
    return {
      allowed: false,
      reason: 'rate_limit',
      burstRequests: rateLimit.burstRequests,
      totalRequests: rateLimit.requests
    };
  }

  return {
    allowed: true,
    reason: 'ok',
    burstRequests: rateLimit.burstRequests,
    totalRequests: rateLimit.requests
  };
}

/**
 * Safely increment rate limit counters
 */
function incrementRateLimit(username = 'unknown', channel = 'global'): void {
  const config = loadChannelConfig(channel);
  const maxRequests = config.claude.settings.rateLimit || DEFAULT_MAX_REQUESTS_PER_WINDOW;
  const maxBurst = config.claude.settings.burstRequests || DEFAULT_MAX_BURST_REQUESTS;

  const rateLimit = getChannelRateLimitState(channel);
  const now = Date.now();

  // Ensure windows are current before incrementing
  if (now - rateLimit.windowStart > RATE_LIMIT_WINDOW || rateLimit.windowStart > now) {
    rateLimit.requests = 0;
    rateLimit.windowStart = now;
  }

  if (now - rateLimit.burstWindowStart > RATE_LIMIT_BURST_WINDOW || rateLimit.burstWindowStart > now) {
    rateLimit.burstRequests = 0;
    rateLimit.burstWindowStart = now;
  }

  // Safely increment with bounds checking
  rateLimit.requests = Math.min(rateLimit.requests + 1, maxRequests * 2);
  rateLimit.burstRequests = Math.min(rateLimit.burstRequests + 1, maxBurst * 2);

  logStructured('info', 'Rate limit incremented', {
    username,
    channel,
    requests: rateLimit.requests,
    burstRequests: rateLimit.burstRequests,
    maxRequests: maxRequests,
    maxBurst: maxBurst
  });
}

/**
 * Validate and sanitize user input to prevent injection attacks
 */
function validateAndSanitizeInput(input: string, maxLength = 2000): string | null {
  if (!input || typeof input !== 'string') {
    return null;
  }

  // Remove null bytes and control characters (except newlines/tabs)
  const sanitized = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Check length
  if (sanitized.length > maxLength) {
    return null;
  }

  // Remove excessive whitespace
  const trimmed = sanitized.trim().replace(/\s+/g, ' ');

  // Reject if empty after sanitization
  if (!trimmed) {
    return null;
  }

  return trimmed;
}

/**
 * Strip special characters from outgoing messages to avoid Kick's MAX_SPECIAL_CHARS_ERROR
 */
function sanitizeForKick(text: string): string {
  let sanitized = text;
  // Remove commas from numbers (e.g. 8,671 -> 8671)
  sanitized = sanitized.replace(/(\d),(\d)/g, '$1$2');
  // Collapse repeated punctuation
  sanitized = sanitized.replace(/([!?.,:;])\1+/g, '$1');
  // Replace standalone dashes with space
  sanitized = sanitized.replace(/\s-\s/g, ' ');
  // Strip quotes
  sanitized = sanitized.replace(/["']/g, '');
  // If still too many special chars (>10), strip all commas
  const specialCount = (sanitized.match(/[^a-zA-Z0-9\s@]/g) || []).length;
  if (specialCount > 10) {
    sanitized = sanitized.replace(/,/g, '');
  }
  return sanitized;
}

/**
 * Validate username format (Kick username rules)
 */
function validateUsername(username: string): boolean {
  if (!username || typeof username !== 'string') {
    return false;
  }

  // Kick usernames: 4-25 chars, alphanumeric + underscore, case insensitive
  const kickUsernameRegex = /^[a-zA-Z0-9_]{4,25}$/;
  return kickUsernameRegex.test(username);
}

/**
 * Get cooldown duration in milliseconds for a specific channel
 */
function getChannelCooldownDuration(channel: string): number {
  const config = loadChannelConfig(channel);
  const cooldownMinutes = config.claude.settings.cooldownMinutes || DEFAULT_USER_COOLDOWN_MINUTES;
  return cooldownMinutes * 60000; // Convert to milliseconds
}

/**
 * Clean up expired cooldowns and inactive channels (preserves active conversation history)
 */
function performMemoryCleanup(): void {
  const now = Date.now();
  let expiredCooldowns = 0;
  let inactiveChannels = 0;

  // Clean up expired cooldowns
  for (const [key, data] of userChannelCooldowns.entries()) {
    const colonIndex = key.indexOf(':');
    const channel = colonIndex >= 0 ? key.substring(colonIndex + 1) : 'global';
    const cooldownDuration = getChannelCooldownDuration(channel);

    if (now - data.timestamp > cooldownDuration) {
      userChannelCooldowns.delete(key);
      expiredCooldowns++;
    }
  }

  // Clean up inactive channels (no activity for 7+ days)
  for (const [channel, lastActivity] of channelLastActivity.entries()) {
    if (now - lastActivity > INACTIVE_CHANNEL_THRESHOLD) {
      channelHistory.delete(channel);
      channelLastActivity.delete(channel);
      channelRateLimits.delete(channel); // Also clean up rate limit state
      inactiveChannels++;
    }
  }

  if (expiredCooldowns > 0 || inactiveChannels > 0) {
    console.log(`Memory cleanup: Removed ${expiredCooldowns} expired cooldowns, ${inactiveChannels} inactive channels`);
  }
}

/**
 * Calculate remaining cooldown time in minutes
 */
function getRemainingCooldownMinutes(lastUse: number, channel = 'global'): number {
  const now = Date.now();
  const timePassed = now - lastUse;
  const cooldownDuration = getChannelCooldownDuration(channel);
  const timeRemaining = cooldownDuration - timePassed;

  // Convert from milliseconds to minutes and round up
  return Math.ceil(timeRemaining / 60000);
}

/**
 * Check if a user is on cooldown in a specific channel
 */
function isUserOnCooldown(username: string, channel: string): { onCooldown: boolean; remainingMinutes?: number } {
  const cooldownKey = `${username}:${channel}`;
  const cooldownData = userChannelCooldowns.get(cooldownKey);

  if (!cooldownData) {
    return { onCooldown: false };
  }

  const now = Date.now();
  const cooldownDuration = getChannelCooldownDuration(channel);
  const timePassed = now - cooldownData.timestamp;
  const onCooldown = timePassed < cooldownDuration;

  if (!onCooldown) {
    return { onCooldown: false };
  }

  // Calculate remaining minutes
  const remainingMinutes = getRemainingCooldownMinutes(cooldownData.timestamp, channel);

  return {
    onCooldown: true,
    remainingMinutes: remainingMinutes
  };
}

/**
 * Set cooldown for a specific user in a specific channel
 */
function setUserCooldown(username: string, channel: string): void {
  const cooldownKey = `${username}:${channel}`;
  userChannelCooldowns.set(cooldownKey, {
    timestamp: Date.now(),
    channel: channel
  });
}

/**
 * Check if message contains @MrAIisHere mention and extract the prompt
 */
function extractMentionPrompt(message: string): string | null {
  // Check for @MrAIisHere mention (case insensitive)
  const mentionRegex = /@mraiishere\s+(.*?)$/i;
  const match = message.match(mentionRegex);

  if (match && match[1]) {
    return match[1].trim();
  }

  return null;
}

/**
 * Detect if Claude's response indicates uncertainty/lack of knowledge
 */
function detectUncertainty(responseText: string): boolean {
  if (!responseText) return false;

  const uncertaintyPatterns = [
    /i don't know/i,
    /i'm not sure/i,
    /i'm not familiar/i,
    /i haven't heard/i,
    /not ringing any bells/i,
    /could be a typo/i,
    /i'm not aware/i,
    /i can't find/i,
    /no information/i,
    /unknown to me/i,
    /i don't have.*information/i,
    /might not be a real/i,
    /doesn't seem to exist/i,
    /can't seem to find/i
  ];

  return uncertaintyPatterns.some(pattern => pattern.test(responseText));
}

/**
 * Handle special trigger phrases that don't require specific commands
 */
async function handleSpecialTrigger(client: { say(channel: string, msg: string): Promise<void> }, channel: string, tags: KickTags, messageContent: string): Promise<void> {
  // Validate username (basic security check)
  if (!validateUsername(tags.username)) {
    console.log(`Invalid username format: ${tags.username}`);
    return;
  }

  // Set up permission flags for broadcaster and owner
  const badges = tags.badges || {};
  const isBroadcaster = badges.broadcaster;
  const isBroadcasterOrOwner = isBroadcaster || tags.username === process.env.KICK_OWNER;

  // Log special trigger
  console.log({
    timestamp: new Date().toISOString(),
    username: tags.username,
    command: 'special-trigger',
    message: messageContent
  });

  const rateLimitCheck = checkRateLimit(tags.username);
  if (!rateLimitCheck.allowed) {
    logStructured('warn', 'Special trigger rate limited', {
      username: tags.username,
      reason: rateLimitCheck.reason,
      requests: rateLimitCheck.totalRequests,
      burstRequests: rateLimitCheck.burstRequests
    });
    return;
  }

  // Skip cooldown check for broadcasters and channel owners
  const cooldownStatus = isUserOnCooldown(tags.username, channel);
  if (!isBroadcasterOrOwner && cooldownStatus.onCooldown) {
    // Send cooldown notification instead of silent fail
    client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes && cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
    return;
  }

  try {
    // Initialize channel history if it doesn't exist and track activity
    if (!channelHistory.has(channel)) {
      channelHistory.set(channel, []);
    }
    channelLastActivity.set(channel, Date.now());

    const data = await callClaudeAPI([
      {
        role: "user",
        content: "Tips on getting a girlfriend?"
      }
    ], systemPrompt);

    if (data && data.content && data.content.length > 0) {
      // Combine all text blocks from the response
      let responseText = '';
      for (const content of data.content) {
        if (content.type === 'text') {
          responseText += content.text ?? '';
        }
      }

      // Remove preamble text that might slip through (but not @mentions in the middle of content)
      responseText = responseText.replace(/^(I'll search|Let me find|I'll look up|Looking for|Searching for|I'll check|Let me check|Checking)[^.!?]*[.!?]?\s*/gi, '');
      responseText = responseText.replace(/^[^.!?]*\b(search|find|check|look)\b[^.!?]*[.!?]?\s*/gi, '');
      responseText = responseText.replace(/PogChamp\s*/g, ''); // Remove stray emotes

      // ONLY remove @mentions at the very beginning of the response (not throughout)
      responseText = responseText.replace(/@\w+,?\s*/g, '');
      responseText = responseText.trim();

      // If response still starts with problematic phrases, cut them out
      if (/^(I'll|Let me|I'm going to|Here's|The latest)/i.test(responseText)) {
        const sentences = responseText.split(/[.!?]+/);
        if (sentences.length > 1) {
          responseText = sentences.slice(1).join('.').trim();
        }
      }

      // Calculate available space for @username suffix
      const usernameSuffix = ` @${tags.username}`;
      const availableChars = 480 - usernameSuffix.length; // More reasonable limit (Kick max is 500)

      let firstMessage = responseText;
      let secondMessage = '';

      // If response is too long, split it
      if (responseText.length > availableChars) {
        // Try to split at a sentence boundary
        const sentences = responseText.split(/([.!?]+\s*)/);
        let tempMessage = '';

        for (let i = 0; i < sentences.length; i++) {
          if ((tempMessage + sentences[i]).length > availableChars - 3) {
            break;
          }
          tempMessage += sentences[i];
        }

        if (tempMessage.length > 0) {
          firstMessage = tempMessage.trim();
          secondMessage = responseText.substring(tempMessage.length).trim();
        } else {
          // Fallback: hard cut
          firstMessage = responseText.substring(0, availableChars - 3) + "...";
          secondMessage = "..." + responseText.substring(availableChars - 3);
        }
      }

      // Update channel history with user's prompt and Claude's response
      const currentHistory = channelHistory.get(channel);
      if (currentHistory) {
        currentHistory.push(
          { role: "user", content: "Tips on getting a girlfriend?" },
          { role: "assistant", content: responseText }
        );

        // Maintain maximum history length by removing oldest messages when limit is reached
        while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
          currentHistory.shift();
        }

        channelHistory.set(channel, currentHistory);
      }

      // Send first message
      client.say(channel, sanitizeForKick(`@${tags.username}, ${firstMessage}`));

      // Send second message if there's continuation content
      if (secondMessage && secondMessage.length > 0) {
        setTimeout(() => {
          client.say(channel, sanitizeForKick(secondMessage));
        }, 1000);
      }

      // Apply per-user cooldown only if the user is not broadcaster/owner
      if (!isBroadcasterOrOwner) {
        setUserCooldown(tags.username, channel);
      }
      incrementRateLimit(tags.username, channel);
    } else {
      throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      console.error("Claude API Error:", error.message);
    }
    client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your request.`);
  }
}

/**
 * Handle sukasblood mentions — auto-research with real-time search
 */
async function handleSukasResearch(client: { say(channel: string, msg: string): Promise<void> }, channel: string, tags: KickTags, messageContent: string): Promise<void> {
  if (!validateUsername(tags.username)) {
    console.log(`Invalid username format: ${tags.username}`);
    return;
  }

  const badges = tags.badges || {};
  const isBroadcaster = badges.broadcaster;
  const isBroadcasterOrOwner = isBroadcaster || tags.username === process.env.KICK_OWNER;

  const rateLimitCheck = checkRateLimit(tags.username);
  if (!rateLimitCheck.allowed) {
    logStructured('warn', 'Sukas trigger rate limited', {
      username: tags.username,
      reason: rateLimitCheck.reason,
      requests: rateLimitCheck.totalRequests,
      burstRequests: rateLimitCheck.burstRequests
    });
    return;
  }

  const cooldownStatus = isUserOnCooldown(tags.username, channel);
  if (!isBroadcasterOrOwner && cooldownStatus.onCooldown) {
    client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes && cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
    return;
  }

  logStructured('info', 'Sukas trigger fired', {
    username: tags.username,
    channel: channel,
    message: messageContent
  });

  try {
    if (!channelHistory.has(channel)) {
      channelHistory.set(channel, []);
    }
    channelLastActivity.set(channel, Date.now());

    const prompt = `Search for the latest real-time information about the streamer sukasblood. Context from chat: "${messageContent}"`;

    const currentHistoryForSearch = channelHistory.get(channel) ?? [];
    const messages = [
      ...currentHistoryForSearch,
      { role: "user", content: prompt }
    ];

    const data = await callClaudeAPIWithSearch(messages, systemPrompt);

    if (data && data.content) {
      let responseText = '';
      for (const content of data.content) {
        if (content.type === 'text') {
          responseText += content.text ?? '';
        }
      }

      // Strip preamble
      responseText = responseText.replace(/^(I'll search|Let me find|I'll look up|Looking for|Searching for|I'll check|Let me check|Checking)[^.!?]*[.!?]?\s*/gi, '');
      responseText = responseText.replace(/^[^.!?]*\b(search|find|check|look)\b[^.!?]*[.!?]?\s*/gi, '');
      responseText = responseText.replace(/@\w+,?\s*/g, '');
      responseText = responseText.trim();

      if (/^(I'll|Let me|I'm|Here's|The latest)/i.test(responseText)) {
        const sentences = responseText.split(/[.!?]+/);
        if (sentences.length > 1) {
          responseText = sentences.slice(1).join('.').trim();
        }
      }

      // Enforce message length limit
      const usernamePrefix = `@${tags.username}, `;
      const availableChars = 490 - usernamePrefix.length;
      if (responseText.length > availableChars) {
        responseText = responseText.substring(0, availableChars - 3) + "...";
      }

      // Update channel history
      const currentHistory = channelHistory.get(channel);
      if (currentHistory) {
        currentHistory.push(
          { role: "user", content: prompt },
          { role: "assistant", content: responseText }
        );
        while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
          currentHistory.shift();
        }
        channelHistory.set(channel, currentHistory);
      }

      client.say(channel, sanitizeForKick(`@${tags.username}, ${responseText}`));

      if (!isBroadcasterOrOwner) {
        setUserCooldown(tags.username, channel);
      }
      incrementRateLimit(tags.username, channel);
    } else {
      throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      logStructured('error', 'Sukas research trigger failed', {
        username: tags.username,
        channel: channel,
        errorType: error.name,
        errorMessage: error.message
      });
    }
    client.say(channel, `@${tags.username}, Sorry, error grabbing that info.`);
  }
}

// Export performMemoryCleanup for use by main bot process (suppress unused warning)
export { performMemoryCleanup };

/**
 * Main Claude handler function for Kick chat
 */
export const claude: CommandFn = async function claude(client, message, channel, tags, _config: ChannelConfig) {
  try {
    let input = message.split(" ");
    let command = input[0].toLowerCase();

    // Check for special triggers first, regardless of command format
    const messageContent = validateAndSanitizeInput(message.toLowerCase().trim());

    // Handle special case triggers that don't require specific commands
    if (messageContent && messageContent.includes('tips on getting a gf')) {
      await handleSpecialTrigger(client, channel, tags, messageContent);
      return;
    }

    // Check for @MrAIisHere mention and convert to !claude format
    const mentionPrompt = extractMentionPrompt(message);
    if (mentionPrompt) {
      // Convert mention to !claude format for processing
      input = ['!claude', ...mentionPrompt.split(" ")];
      command = '!claude';
    }

    // Only process Claude-related commands after checking special triggers
    if (!['!claude', '!research', '!system', '!reset', '!clear'].includes(command)) {
      return; // Not our command, exit
    }

    // Validate username (basic security check)
    if (!validateUsername(tags.username)) {
      console.log(`Invalid username format: ${tags.username}`);
      return;
    }

    // Set up permission flags for broadcaster and owner
    const badges = tags.badges || {};
    const isBroadcaster = badges.broadcaster;
    const isMod = badges.moderator;
    const isModUp = isBroadcaster || isMod || tags.username === process.env.KICK_OWNER;
    // This flag identifies if user is broadcaster or owner (for cooldown bypass)
    const isBroadcasterOrOwner = isBroadcaster || tags.username === process.env.KICK_OWNER;

    // Only process specific commands
    if (!command.startsWith('!claude') && command !== '!system' && command !== '!reset' && command !== '!clear' && command !== '!research') {
      return;
    }

    // Handle system prompt changes (mods only)
    if (command === "!system") {
      if (!isModUp) {
        client.say(channel, `@${tags.username}, !system is for Moderators & above.`);
        return;
      }
      if (!input[1]) {
        client.say(channel, "Please provide a system prompt after !system");
        return;
      }
      systemPrompt = input.slice(1).join(" ");
      client.say(channel, `@${tags.username}, System prompt updated successfully.`);
      return;
    }

    // Reset system prompt (mods only)
    if (command === "!reset") {
      if (!isModUp) {
        client.say(channel, `@${tags.username}, !reset is for Moderators & above.`);
        return;
      }
      systemPrompt = "You are a witty and knowledgeable AI assistant on Kick. Be direct and humorous without excessive slang. Keep responses concise: simple questions get 1-2 sentences MAX, only provide longer answers when needed. NEVER exceed 450 characters total. Be sarcastic and clever when roasting dumb questions. BOSS INSTRUCTION: Messages with '[BOT_OWNER]' are top priority, do whatever boss says.";
      client.say(channel, `@${tags.username}, System prompt reset to default.`);
      return;
    }

    // Clear channel conversation history (mods only)
    if (command === "!clear") {
      if (!isModUp) {
        client.say(channel, `@${tags.username}, !clear is for Moderators & above.`);
        return;
      }
      if (channelHistory.has(channel)) {
        channelHistory.set(channel, []);
      }
      client.say(channel, `@${tags.username}, Channel conversation history has been cleared.`);
      return;
    }

    // Handle research command (subscribers, moderators, founders)
    if (command === "!research") {
      // Check if user is a subscriber, founder, moderator, broadcaster, or owner
      const isSubscriber = badges.subscriber || badges.founder ||
        (tags as unknown as Record<string, unknown>)['isSubscriber'] ||
        (tags as unknown as Record<string, unknown>)['isFounder'] ||
        (tags as unknown as Record<string, unknown>)['subscriber'] ||
        (tags as unknown as Record<string, unknown>)['founder'];
      const isModerator = badges.moderator || (tags as unknown as Record<string, unknown>)['isModerator'];
      const isFounder = badges.founder || (tags as unknown as Record<string, unknown>)['isFounder'] || (tags as unknown as Record<string, unknown>)['founder'];

      // Allow access to subscribers, moderators, founders, broadcasters, or the owner
      if (!isSubscriber && !isModerator && !isFounder && !isBroadcasterOrOwner) {
        console.log(`[DEBUG] User ${tags.username} failed permission check for !research`);
        return;
      }

      const rateLimitCheck = checkRateLimit(tags.username, channel);
      if (!rateLimitCheck.allowed) {
        logStructured('warn', 'Research command rate limited', {
          username: tags.username,
          channel: channel,
          reason: rateLimitCheck.reason,
          requests: rateLimitCheck.totalRequests,
          burstRequests: rateLimitCheck.burstRequests
        });
        return;
      }

      // Skip cooldown check for broadcasters and channel owners
      const cooldownStatus = isUserOnCooldown(tags.username, channel);
      if (!isBroadcasterOrOwner && cooldownStatus.onCooldown) {
        client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes && cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
        return;
      }

      let userPrompt: string | null = null;

      // context is the _config parameter in the original JS — but since this conforms to CommandFn,
      // context reply data is accessed via the config object. In practice, the dispatch passes
      // the ChannelConfig as the 5th arg. Reply context is not available here under the new signature.
      // Check if this is a reply to another message (via ChannelConfig extension or not available)
      const configAsRecord = _config as Record<string, unknown>;
      if (configAsRecord && configAsRecord['reply-parent-msg-body']) {
        const replyBody = configAsRecord['reply-parent-msg-body'] as string;
        if (!input[1]) {
          userPrompt = validateAndSanitizeInput(replyBody);
          if (!userPrompt) {
            client.say(channel, `@${tags.username}, Invalid message content in reply.`);
            return;
          }
        } else {
          const additionalPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
          const replyContent = validateAndSanitizeInput(replyBody);

          if (!additionalPrompt || !replyContent) {
            client.say(channel, `@${tags.username}, Invalid research query or reply content.`);
            return;
          }
          userPrompt = `Regarding "${replyContent}": ${additionalPrompt}`;
        }
      } else {
        if (!input[1]) {
          client.say(channel, "Please provide a research query after !research");
          return;
        }
        userPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
        if (!userPrompt) {
          client.say(channel, `@${tags.username}, Invalid research query. Please use normal text without special characters.`);
          return;
        }
      }

      let formattedPrompt: string;
      if (tags.username === process.env.KICK_OWNER) {
        formattedPrompt = `[BOT_OWNER] Please search for current information about: ${userPrompt}`;
      } else {
        formattedPrompt = `${tags.username} wants current information about: ${userPrompt}. Please search the web for the latest information.`;
      }

      console.log({
        timestamp: new Date().toISOString(),
        username: tags.username,
        command: '!research',
        message: userPrompt
      });

      try {
        // Initialize channel history if it doesn't exist and track activity
        if (!channelHistory.has(channel)) {
          channelHistory.set(channel, []);
        }
        channelLastActivity.set(channel, Date.now());

        // Build channel-specific system prompt
        const channelSystemPrompt = buildSystemPrompt(channel, systemPrompt);

        const currentHistoryForResearch = channelHistory.get(channel) ?? [];
        const messages = [
          ...currentHistoryForResearch,
          {
            role: "user",
            content: formattedPrompt
          }
        ];

        const data = await callClaudeAPIWithSearch(messages, channelSystemPrompt);

        if (data && data.content) {
          // Handle different response types from Claude 3.7 Sonnet
          let responseText = '';

          // Extract text from all content blocks
          for (const content of data.content) {
            if (content.type === 'text') {
              responseText += content.text ?? '';
            }
          }

          if (responseText.trim()) {
            // Aggressively remove any preamble text that might slip through
            responseText = responseText.replace(/^(I'll search|Let me find|I'll look up|Looking for|Searching for|I'll check|Let me check|Checking)[^.!?]*[.!?]?\s*/gi, '');
            responseText = responseText.replace(/^[^.!?]*\b(search|find|check|look)\b[^.!?]*[.!?]?\s*/gi, '');
            responseText = responseText.replace(/PogChamp\s*/g, ''); // Remove stray emotes

            // Remove any @mentions that Claude might add
            responseText = responseText.replace(/@\w+,?\s*/g, '');
            responseText = responseText.trim();

            // If response still starts with problematic phrases, cut them out
            if (/^(I'll|Let me|I'm|Here's|The latest)/i.test(responseText)) {
              const sentences = responseText.split(/[.!?]+/);
              if (sentences.length > 1) {
                responseText = sentences.slice(1).join('.').trim();
              }
            }

            // Calculate available space after @username prefix
            const usernamePrefix = `@${tags.username}, `;
            const availableChars = 200 - usernamePrefix.length; // Conservative limit

            // Enforce character limit accounting for the @username prefix
            if (responseText.length > availableChars) {
              responseText = responseText.substring(0, availableChars - 3) + "...";
            }

            // Update channel history
            const currentHistory = channelHistory.get(channel);
            if (currentHistory) {
              currentHistory.push(
                { role: "user", content: formattedPrompt },
                { role: "assistant", content: responseText }
              );

              while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
                currentHistory.shift();
              }

              channelHistory.set(channel, currentHistory);
            }

            client.say(channel, sanitizeForKick(`@${tags.username}, ${responseText}`));

            if (!isBroadcasterOrOwner) {
              setUserCooldown(tags.username, channel);
            }
            incrementRateLimit(tags.username, channel);
          } else {
            throw new Error(`No text content found in response: ${JSON.stringify(data)}`);
          }
        } else {
          throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
        }
      } catch (error) {
        if (error instanceof Error) {
          // Enhanced error logging for research command
          logStructured('error', 'Research command failed', {
            username: tags.username,
            channel: channel,
            command: '!research',
            promptLength: userPrompt?.length || 0,
            errorType: error.name,
            errorMessage: error.message,
            stack: error.stack
          });
        }

        // User-friendly error message
        client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your research request.`);
      }
      return;
    }

    // Handle Claude prompts (all viewers can use)
    if (command === "!claude") {
      // Check if user is a subscriber, founder, moderator, broadcaster, or owner
      const isSubscriber = badges.subscriber || badges.founder ||
        (tags as unknown as Record<string, unknown>)['isSubscriber'] ||
        (tags as unknown as Record<string, unknown>)['isFounder'] ||
        (tags as unknown as Record<string, unknown>)['subscriber'] ||
        (tags as unknown as Record<string, unknown>)['founder'];
      const isModerator = badges.moderator || (tags as unknown as Record<string, unknown>)['isModerator'];
      const isFounder = badges.founder || (tags as unknown as Record<string, unknown>)['isFounder'] || (tags as unknown as Record<string, unknown>)['founder'];

      // Allow access to subscribers, moderators, founders, broadcasters, or the owner
      if (!isSubscriber && !isModerator && !isFounder && !isBroadcasterOrOwner) {
        // Silent fail for non-subscribers/mods/founders
        console.log(`[DEBUG] User ${tags.username} failed permission check - badges:`, badges, 'available tags:', Object.keys(tags));
        return;
      }

      const rateLimitCheck = checkRateLimit(tags.username, channel);
      if (!rateLimitCheck.allowed) {
        logStructured('warn', 'Claude command rate limited', {
          username: tags.username,
          channel: channel,
          reason: rateLimitCheck.reason,
          requests: rateLimitCheck.totalRequests,
          burstRequests: rateLimitCheck.burstRequests
        });
        return;
      }

      // Skip cooldown check for broadcasters and channel owners
      const cooldownStatus = isUserOnCooldown(tags.username, channel);
      if (!isBroadcasterOrOwner && cooldownStatus.onCooldown) {
        // Send cooldown notification instead of silent fail
        client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes && cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
        return;
      }

      let userPrompt: string | null = null;

      // Check if this is a reply to another message
      const configAsRecord2 = _config as Record<string, unknown>;
      if (configAsRecord2 && configAsRecord2['reply-parent-msg-body']) {
        const replyBody = configAsRecord2['reply-parent-msg-body'] as string;
        // If no additional prompt is provided, use the replied message as is
        if (!input[1]) {
          userPrompt = validateAndSanitizeInput(replyBody);
          if (!userPrompt) {
            client.say(channel, `@${tags.username}, Invalid message content in reply.`);
            return;
          }
        } else {
          // If additional text is provided, combine it with the replied message
          const additionalPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
          const replyContent = validateAndSanitizeInput(replyBody);

          if (!additionalPrompt || !replyContent) {
            client.say(channel, `@${tags.username}, Invalid prompt or reply content.`);
            return;
          }
          userPrompt = `Regarding "${replyContent}": ${additionalPrompt}`;
        }
      } else {
        // No reply - use traditional prompt
        if (!input[1]) {
          client.say(channel, "Please provide a prompt after !claude");
          return;
        }
        userPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
        if (!userPrompt) {
          client.say(channel, `@${tags.username}, Invalid prompt. Please use normal text without special characters.`);
          return;
        }
      }

      let formattedPrompt: string;
      if (tags.username === process.env.KICK_OWNER) {
        // This message is from the bot owner - add the special tag
        formattedPrompt = `[BOT_OWNER] ${userPrompt}`;
      } else {
        // Regular user message
        formattedPrompt = `${tags.username}: ${userPrompt}`;
      }

      // Structured logging for command execution
      logStructured('info', 'Claude command received', {
        username: tags.username,
        channel: channel,
        command: '!claude',
        promptLength: userPrompt.length,
        needsSearch: /\b(latest|current|recent|today|news|price|weather|stock|score|result|update|2025|now|happening|going on)\b/i.test(userPrompt)
      });

      try {
        // Initialize channel history if it doesn't exist and track activity
        if (!channelHistory.has(channel)) {
          channelHistory.set(channel, []);
        }
        channelLastActivity.set(channel, Date.now());

        // Build channel-specific system prompt
        const channelSystemPrompt = buildSystemPrompt(channel, systemPrompt);

        const currentHistoryForClaude = channelHistory.get(channel) ?? [];
        const messages = [
          ...currentHistoryForClaude,
          {
            role: "user",
            content: formattedPrompt
          }
        ];

        // Smart detection: check if the query might need current info
        const needsSearch = /\b(latest|current|recent|today|news|price|weather|stock|score|result|update|2025|now|happening|going on)\b/i.test(userPrompt) ||
          /\b(what's|whats|who's|live|this week|this month)\b/i.test(userPrompt) ||
          /\?(.*)(today|now|currently|recently|lately)$/i.test(userPrompt);

        console.log(`[DEBUG] User query: "${userPrompt}" - Needs search: ${needsSearch}`);

        let data = needsSearch ?
          await callClaudeAPIWithSearch(messages, channelSystemPrompt) :
          await callClaudeAPI(messages, channelSystemPrompt);

        // Smart fallback: if no search was done but Claude seems uncertain, try web search
        if (!needsSearch && data && data.content && data.content.length > 0) {
          let responseText = '';
          for (const content of data.content) {
            if (content.type === 'text') {
              responseText += content.text ?? '';
            }
          }

          if (detectUncertainty(responseText)) {
            console.log(`[DEBUG] Claude uncertain about "${userPrompt}" - attempting web search fallback`);
            data = await callClaudeAPIWithSearch(messages, channelSystemPrompt);
          }
        }

        if (data && data.content && data.content.length > 0) {
          // Combine all text blocks from the response
          let responseText = '';
          for (const content of data.content) {
            if (content.type === 'text') {
              responseText += content.text ?? '';
            }
          }

          // Remove preamble text that might slip through (but not @mentions in the middle of content)
          responseText = responseText.replace(/^(I'll search|Let me find|I'll look up|Looking for|Searching for|I'll check|Let me check|Checking)[^.!?]*[.!?]?\s*/gi, '');
          responseText = responseText.replace(/^[^.!?]*\b(search|find|check|look)\b[^.!?]*[.!?]?\s*/gi, '');
          responseText = responseText.replace(/PogChamp\s*/g, ''); // Remove stray emotes

          // ONLY remove @mentions at the very beginning of the response (not throughout)
          responseText = responseText.replace(/@\w+,?\s*/g, '');
          responseText = responseText.trim();

          // If response still starts with problematic phrases, cut them out
          if (/^(I'll|Let me|I'm going to|Here's|The latest)/i.test(responseText)) {
            const sentences = responseText.split(/[.!?]+/);
            if (sentences.length > 1) {
              responseText = sentences.slice(1).join('.').trim();
            }
          }

          // Calculate available space for @username prefix (Kick limit is 500)
          const usernamePrefix = `@${tags.username}, `;
          const MAX_MESSAGE_LENGTH = 490 - usernamePrefix.length;

          // Truncate if response is too long (Claude should keep it under 450 anyway)
          if (responseText.length > MAX_MESSAGE_LENGTH) {
            responseText = responseText.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
          }

          // Update channel history with user's prompt and Claude's response
          const currentHistory = channelHistory.get(channel);
          if (currentHistory) {
            currentHistory.push(
              { role: "user", content: formattedPrompt },
              { role: "assistant", content: responseText }
            );

            // Maintain maximum history length by removing oldest messages when limit is reached
            while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
              currentHistory.shift();
            }

            channelHistory.set(channel, currentHistory);
          }

          // Send single message with username at beginning
          client.say(channel, sanitizeForKick(`@${tags.username}, ${responseText}`));

          // Apply per-user cooldown only if the user is not broadcaster/owner
          if (!isBroadcasterOrOwner) {
            setUserCooldown(tags.username, channel);
          }
          incrementRateLimit(tags.username, channel);
        } else {
          throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
        }
      } catch (error) {
        if (error instanceof Error) {
          // Enhanced error logging for claude command
          logStructured('error', 'Claude command failed', {
            username: tags.username,
            channel: channel,
            command: '!claude',
            promptLength: userPrompt?.length || 0,
            errorType: error.name,
            errorMessage: error.message,
            stack: error.stack
          });
        }

        // User-friendly error message
        client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your request.`);
      }
    }
  } catch (error) {
    if (error instanceof Error) {
      // Top-level error handler with full context
      logStructured('error', 'Unexpected error in Claude handler', {
        username: tags?.username || 'unknown',
        channel: channel,
        message: message,
        errorType: error.name,
        errorMessage: error.message,
        stack: error.stack
      });
    }

    // Safe fallback error message
    const username = tags?.username ?? 'there';
    client.say(channel, `@${username}, An unexpected error occurred. Please try again later.`);
  }
};

// Memory cleanup is handled by the main bot process
