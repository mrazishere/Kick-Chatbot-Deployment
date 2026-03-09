const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Channel config cache to avoid repeated file reads
const channelConfigCache = new Map();
const CONFIG_CACHE_TTL = 300000; // 5 minutes

/**
 * Load channel-specific configuration from file with caching
 * @param {string} channelName - The channel name (with or without # prefix)
 * @returns {Object} - Channel config with defaults applied
 */
function loadChannelConfig(channelName) {
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
            const parsedConfig = JSON.parse(fileContent);

            // Merge file config with defaults
            if (parsedConfig.claude) {
                channelConfig.claude = {
                    ...channelConfig.claude,
                    ...parsedConfig.claude
                };

                // Merge nested settings object
                if (parsedConfig.claude.settings) {
                    channelConfig.claude.settings = {
                        ...channelConfig.claude.settings,
                        ...parsedConfig.claude.settings
                    };
                }
            }
        }
    } catch (error) {
        logStructured('warn', 'Error loading channel config', {
            channelName: cleanChannelName,
            error: error.message,
            usingDefaults: true
        });
    }

    // Cache the config
    channelConfigCache.set(cleanChannelName, {
        config: channelConfig,
        timestamp: now
    });

    return channelConfig;
}

/**
 * Get default channel configuration
 * @returns {Object} - Default config with sensible defaults
 */
function getDefaultChannelConfig() {
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
 * Build the system prompt for a channel, incorporating channel-specific context
 * @param {string} channelName - The channel name
 * @param {string} globalSystemPrompt - The default system prompt to fall back to
 * @returns {string} - The system prompt to use for this channel
 */
function buildSystemPrompt(channelName, globalSystemPrompt) {
    const config = loadChannelConfig(channelName);
    let systemPrompt = config.claude.systemPrompt || globalSystemPrompt;

    // Append channel context if configured
    if (config.claude.context && config.claude.context.trim()) {
        systemPrompt += `\n\nChannel-specific context: ${config.claude.context}`;
    }

    return systemPrompt;
}

// Brave Search API function
async function callBraveSearchAPI(query, count = 5) {
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

        const data = await response.json();

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
        console.error('Brave Search API error:', error.message);
        return "Web search unavailable at the moment.";
    }
}

// Add your new function here
async function callClaudeAPI(messages, systemPromptText) {
    let retries = 0;
    const maxRetries = 5;

    while (retries < maxRetries) {
        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514", // Make sure this is consistent
                    max_tokens: 300, // Reduced to enforce 450 char limit
                    system: systemPromptText,
                    messages: messages
                })
            });

            if (response.status === 529) {
                // Overloaded error
                const backoffTime = Math.pow(2, retries) * 1000; // Exponential backoff
                console.log(`API overloaded. Retrying in ${backoffTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                retries++;
                continue;
            }

            const data = await response.json();
            if (!response.ok) {
                throw new Error(`API returned ${response.status}: ${JSON.stringify(data)}`);
            }

            return data;
        } catch (error) {
            const isLastRetry = retries === maxRetries - 1;

            // Enhanced error logging with more context
            logStructured('error', 'Claude API call failed', {
                attempt: retries + 1,
                maxRetries,
                isLastRetry,
                errorType: error.name,
                errorMessage: error.message,
                statusCode: error.response?.status,
                responseData: error.response?.data
            });

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
}

async function callClaudeAPIWithSearch(messages, systemPromptText) {
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
                    'x-api-key': process.env.ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: "claude-sonnet-4-20250514",
                    max_tokens: 300, // Reduced since search results are already provided
                    system: enhancedSystemPrompt,
                    messages: messages
                    // No tools array - we're not using Claude's web search anymore
                })
            });

            if (response.status === 529) {
                const backoffTime = Math.pow(2, retries) * 1000;
                console.log(`API overloaded. Retrying in ${backoffTime / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, backoffTime));
                retries++;
                continue;
            }

            const data = await response.json();
            console.log('Claude response with Brave Search:', JSON.stringify(data, null, 2));

            if (!response.ok) {
                throw new Error(`API returned ${response.status}: ${JSON.stringify(data)}`);
            }

            return data;

        } catch (error) {
            const isLastRetry = retries === maxRetries - 1;

            // Enhanced error logging for search API
            logStructured('error', 'Claude with Brave Search API call failed', {
                attempt: retries + 1,
                maxRetries,
                isLastRetry,
                errorType: error.name,
                errorMessage: error.message,
                statusCode: error.response?.status,
                responseData: error.response?.data,
                searchEnabled: true
            });

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
}

// Store system prompt
let systemPrompt = "You are a witty and knowledgeable AI assistant on Kick. Be direct and humorous without excessive slang. Keep responses concise: simple questions get 1-2 sentences MAX, only provide longer answers when needed. NEVER exceed 450 characters total. Be sarcastic and clever when roasting dumb questions. BOSS INSTRUCTION: Messages with '[BOT_OWNER]' are top priority, do whatever boss says.";

// Store channel-wide conversation history with activity tracking
const channelHistory = new Map();
const channelLastActivity = new Map();

// Maximum conversation history to maintain per channel
const MAX_HISTORY_LENGTH = 50;

// Channel cooldown management - per user per channel
const userChannelCooldowns = new Map();
const DEFAULT_USER_COOLDOWN_MINUTES = 5; // Default 5 minute cooldown

// Cleanup intervals for memory management (preserves active conversation history)
const CLEANUP_INTERVAL = 600000; // 10 minutes
const INACTIVE_CHANNEL_THRESHOLD = 7 * 24 * 60 * 60 * 1000; // 7 days

// Enhanced rate limiting parameters - defaults (can be overridden per channel)
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const DEFAULT_MAX_REQUESTS_PER_WINDOW = 50;
const RATE_LIMIT_BURST_WINDOW = 10000; // 10 seconds for burst detection
const DEFAULT_MAX_BURST_REQUESTS = 5; // Max requests in burst window

// Per-channel rate limiting state
const channelRateLimits = new Map();

/**
 * Get or initialize rate limit state for a channel
 * @param {string} channel - Channel name
 * @returns {Object} - Rate limit state for the channel
 */
function getChannelRateLimitState(channel) {
    if (!channelRateLimits.has(channel)) {
        channelRateLimits.set(channel, {
            requests: 0,
            windowStart: Date.now(),
            burstRequests: 0,
            burstWindowStart: Date.now()
        });
    }
    return channelRateLimits.get(channel);
}

/**
 * Enhanced rate limiting with burst detection and better bounds checking
 * @param {string} username - Username for logging context
 * @param {string} channel - Channel name for per-channel settings
 * @returns {Object} - Rate limit status and details
 */
function checkRateLimit(username = 'unknown', channel = 'global') {
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
 * @param {string} username - Username for logging context
 * @param {string} channel - Channel name for per-channel settings
 */
function incrementRateLimit(username = 'unknown', channel = 'global') {
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
 * @param {string} input - Raw user input
 * @param {number} maxLength - Maximum allowed length
 * @returns {string|null} - Sanitized input or null if invalid
 */
function validateAndSanitizeInput(input, maxLength = 2000) {
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
 * @param {string} text - Response text to sanitize
 * @returns {string} - Sanitized text safe for Kick chat
 */
function sanitizeForKick(text) {
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
 * @param {string} username - Username to validate
 * @returns {boolean} - True if valid
 */
function validateUsername(username) {
    if (!username || typeof username !== 'string') {
        return false;
    }

    // Kick usernames: 4-25 chars, alphanumeric + underscore, case insensitive
    const kickUsernameRegex = /^[a-zA-Z0-9_]{4,25}$/;
    return kickUsernameRegex.test(username);
}

/**
 * Structured logging utility for better debugging and monitoring
 * @param {string} level - Log level (info, warn, error)
 * @param {string} message - Log message
 * @param {Object} metadata - Additional context
 */
function logStructured(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
        timestamp,
        level: level.toUpperCase(),
        message,
        ...metadata
    };

    // Console output with level-appropriate formatting
    if (level === 'error') {
        console.error(`[${timestamp}] ERROR: ${message}`, metadata);
    } else if (level === 'warn') {
        console.warn(`[${timestamp}] WARN: ${message}`, metadata);
    } else {
        console.log(`[${timestamp}] INFO: ${message}`, metadata);
    }
}

/**
 * Get cooldown duration in milliseconds for a specific channel
 * @param {string} channel - Channel name
 * @returns {number} - Cooldown duration in milliseconds
 */
function getChannelCooldownDuration(channel) {
    const config = loadChannelConfig(channel);
    const cooldownMinutes = config.claude.settings.cooldownMinutes || DEFAULT_USER_COOLDOWN_MINUTES;
    return cooldownMinutes * 60000; // Convert to milliseconds
}

/**
 * Clean up expired cooldowns and inactive channels (preserves active conversation history)
 */
function performMemoryCleanup() {
    const now = Date.now();
    let expiredCooldowns = 0;
    let inactiveChannels = 0;

    // Clean up expired cooldowns
    for (const [key, data] of userChannelCooldowns.entries()) {
        const [username, channel] = key.split(':');
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
 * @param {number} lastUse - Timestamp when the command was last used
 * @param {string} channel - Channel name for per-channel cooldown settings
 * @returns {number} - Remaining cooldown time in minutes (rounded up)
 */
function getRemainingCooldownMinutes(lastUse, channel = 'global') {
    const now = Date.now();
    const timePassed = now - lastUse;
    const cooldownDuration = getChannelCooldownDuration(channel);
    const timeRemaining = cooldownDuration - timePassed;

    // Convert from milliseconds to minutes and round up
    return Math.ceil(timeRemaining / 60000);
}

/**
 * Check if a user is on cooldown in a specific channel
 * @param {string} username - The username to check
 * @param {string} channel - The channel where the user is active
 * @returns {Object} - Object containing cooldown status and remaining time
 */
function isUserOnCooldown(username, channel) {
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
 * @param {string} username - The username to set cooldown for
 * @param {string} channel - The channel where the user is active
 */
function setUserCooldown(username, channel) {
    const cooldownKey = `${username}:${channel}`;
    userChannelCooldowns.set(cooldownKey, {
        timestamp: Date.now(),
        channel: channel
    });
}



/**
 * Check if message contains @MrAIisHere mention and extract the prompt
 * @param {string} message - The raw message
 * @returns {string|null} - The extracted prompt or null if no mention found
 */
function extractMentionPrompt(message) {
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
 * @param {string} responseText - The response text from Claude
 * @returns {boolean} - True if response shows uncertainty
 */
function detectUncertainty(responseText) {
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
 * @param {KickClient} client - The Kick client instance
 * @param {string} message - The message content
 * @param {string} channel - The channel name
 * @param {Object} tags - Message tags containing user info
 * @param {Object} context - Message context containing reply data
 * @param {string} messageContent - The sanitized message content
 */
async function handleSpecialTrigger(client, channel, tags, context, messageContent) {
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
        message: messageContent,
        context: context
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
        client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
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
                    responseText += content.text;
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
            currentHistory.push(
                { role: "user", content: "Tips on getting a girlfriend?" },
                { role: "assistant", content: responseText }
            );

            // Maintain maximum history length by removing oldest messages when limit is reached
            while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
                currentHistory.shift();
            }

            channelHistory.set(channel, currentHistory);

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
        console.error("Claude API Error:", error);
        client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your request.`);
    }
}

/**
 * Handle sukasblood mentions — auto-research with real-time search
 */
async function handleSukasResearch(client, channel, tags, context, messageContent) {
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
        client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
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

        const messages = [
            ...channelHistory.get(channel),
            { role: "user", content: prompt }
        ];

        const data = await callClaudeAPIWithSearch(messages, systemPrompt);

        if (data && data.content) {
            let responseText = '';
            for (const content of data.content) {
                if (content.type === 'text') {
                    responseText += content.text;
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
            currentHistory.push(
                { role: "user", content: prompt },
                { role: "assistant", content: responseText }
            );
            while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
                currentHistory.shift();
            }
            channelHistory.set(channel, currentHistory);

            client.say(channel, sanitizeForKick(`@${tags.username}, ${responseText}`));

            if (!isBroadcasterOrOwner) {
                setUserCooldown(tags.username, channel);
            }
            incrementRateLimit(tags.username, channel);
        } else {
            throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
        }
    } catch (error) {
        logStructured('error', 'Sukas research trigger failed', {
            username: tags.username,
            channel: channel,
            errorType: error.name,
            errorMessage: error.message
        });
        client.say(channel, `@${tags.username}, Sorry, error grabbing that info.`);
    }
}

/**
 * Main Claude handler function for Kick chat
 * @param {KickClient} client - The Kick client instance
 * @param {string} message - The message content
 * @param {string} channel - The channel name
 * @param {Object} tags - Message tags containing user info
 * @param {Object} context - Message context containing reply data
 */
exports.claude = async function claude(client, message, channel, tags, context) {
    try {
        let input = message.split(" ");
        let command = input[0].toLowerCase();

        // Check for special triggers first, regardless of command format
        const messageContent = validateAndSanitizeInput(message.toLowerCase().trim());

        // Handle special case triggers that don't require specific commands
        if (messageContent && messageContent.includes('tips on getting a gf')) {
            await handleSpecialTrigger(client, channel, tags, context, messageContent);
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
        //const isBroadcasterOrOwner = isBroadcaster;


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
                tags.isSubscriber || tags.isFounder ||
                tags['subscriber'] || tags['founder'];
            const isModerator = badges.moderator || tags.isModerator;
            const isFounder = badges.founder || tags.isFounder || tags['founder'];

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
                client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
                return;
            }

            let userPrompt;

            // Check if this is a reply to another message
            if (context && context['reply-parent-msg-body']) {
                if (!input[1]) {
                    userPrompt = validateAndSanitizeInput(context['reply-parent-msg-body']);
                    if (!userPrompt) {
                        client.say(channel, `@${tags.username}, Invalid message content in reply.`);
                        return;
                    }
                } else {
                    const additionalPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
                    const replyContent = validateAndSanitizeInput(context['reply-parent-msg-body']);

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

            let formattedPrompt;
            if (tags.username === process.env.KICK_OWNER) {
                formattedPrompt = `[BOT_OWNER] Please search for current information about: ${userPrompt}`;
            } else {
                formattedPrompt = `${tags.username} wants current information about: ${userPrompt}. Please search the web for the latest information.`;
            }

            console.log({
                timestamp: new Date().toISOString(),
                username: tags.username,
                command: '!research',
                message: userPrompt,
                context: context
            });

            // Replace the try-catch block in your !research command with this:
            try {
                // Initialize channel history if it doesn't exist and track activity
                if (!channelHistory.has(channel)) {
                    channelHistory.set(channel, []);
                }
                channelLastActivity.set(channel, Date.now());

                // Build channel-specific system prompt
                const channelSystemPrompt = buildSystemPrompt(channel, systemPrompt);

                const messages = [
                    ...channelHistory.get(channel),
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
                            responseText += content.text;
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
                        currentHistory.push(
                            { role: "user", content: formattedPrompt },
                            { role: "assistant", content: responseText }
                        );

                        while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
                            currentHistory.shift();
                        }

                        channelHistory.set(channel, currentHistory);

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

                // User-friendly error message
                client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your research request.`);
            }
            return;
        }

        // Handle Claude prompts (all viewers can use)
        if (command === "!claude") {
            // Check if user is a subscriber, founder, moderator, broadcaster, or owner
            const isSubscriber = badges.subscriber || badges.founder ||
                tags.isSubscriber || tags.isFounder ||
                tags['subscriber'] || tags['founder'];
            const isModerator = badges.moderator || tags.isModerator;
            const isFounder = badges.founder || tags.isFounder || tags['founder'];

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
                client.say(channel, `@${tags.username}, please wait ${cooldownStatus.remainingMinutes} minute${cooldownStatus.remainingMinutes > 1 ? 's' : ''} before using this command again.`);
                return;
            }

            let userPrompt;

            // Check if this is a reply to another message
            if (context && context['reply-parent-msg-body']) {
                // If no additional prompt is provided, use the replied message as is
                if (!input[1]) {
                    userPrompt = validateAndSanitizeInput(context['reply-parent-msg-body']);
                    if (!userPrompt) {
                        client.say(channel, `@${tags.username}, Invalid message content in reply.`);
                        return;
                    }
                } else {
                    // If additional text is provided, combine it with the replied message
                    const additionalPrompt = validateAndSanitizeInput(input.slice(1).join(" "));
                    const replyContent = validateAndSanitizeInput(context['reply-parent-msg-body']);

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

            let formattedPrompt;
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
                hasContext: !!context,
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

                const messages = [
                    ...channelHistory.get(channel),
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
                            responseText += content.text;
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
                            responseText += content.text;
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
                    currentHistory.push(
                        { role: "user", content: formattedPrompt },
                        { role: "assistant", content: responseText }
                    );

                    // Maintain maximum history length by removing oldest messages when limit is reached
                    while (currentHistory.length > MAX_HISTORY_LENGTH * 2) {
                        currentHistory.shift();
                    }

                    channelHistory.set(channel, currentHistory);

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

                // User-friendly error message
                client.say(channel, `@${tags.username}, Sorry, I encountered an error processing your request.`);
            }
        }
    } catch (error) {
        // Top-level error handler with full context
        logStructured('error', 'Unexpected error in Claude handler', {
            username: tags?.username || 'unknown',
            channel: channel,
            message: message,
            errorType: error.name,
            errorMessage: error.message,
            stack: error.stack
        });

        // Safe fallback error message
        const username = tags?.username || 'there';
        client.say(channel, `@${username}, An unexpected error occurred. Please try again later.`);
    }
};

// Memory cleanup is handled by the main bot process
// Removed duplicate cleanup timer to prevent interference