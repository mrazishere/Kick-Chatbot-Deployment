/**
 * Dog Facts command
 *
 * Description: Get random dog facts on twitch chat
 *
 * Credits: https://dogapi.dog/api/v1/facts
 *
 * Permission required: all users
 *
 * Usage:   !dogfacts - Random dog fact
 *
 * TODO: add search functionality
 */

import fetch from 'node-fetch';
import { CommandFn } from '../types';

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_REQUESTS = 5; // Max 5 requests per 30 seconds

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Rate limiting check
function checkRateLimit(username: string): boolean {
  const now = Date.now();
  const userRequests = rateLimitMap.get(username) || [];

  // Remove old requests outside the window
  const validRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);

  if (validRequests.length >= MAX_REQUESTS) {
    return false; // Rate limited
  }

  validRequests.push(now);
  rateLimitMap.set(username, validRequests);
  return true; // Not rate limited
}

// Fetch dog fact with timeout protection
async function getDogFact(): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

  try {
    const response = await fetch('https://dogapi.dog/api/v1/facts', {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'User-Agent': 'Twitch Bot Dog Facts'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json() as { facts: string[] };

    // Safe array access with bounds checking
    if (!data.facts || !Array.isArray(data.facts) || data.facts.length === 0) {
      throw new Error('Invalid API response format or no facts available');
    }

    return data.facts[0];

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

export const dogfacts: CommandFn = async function dogfacts(client, message, channel, tags, _config) {
  // Clean and split input to handle invisible Unicode characters
  const input = message.trim().split(" ").filter(part => part.trim().length > 0);

  if (input[0] !== "!dogfacts") {
    return;
  }

  // Check rate limiting
  if (!checkRateLimit(tags.username)) {
    client.say(channel, `@${tags.username}, please wait before requesting more dog facts.`);
    return;
  }

  // Validate input - command should not accept parameters
  if (input.length > 1) {
    client.say(channel, `@${tags.username}, this command does not accept any inputs.`);
    return;
  }

  try {
    const dogFact = await getDogFact();
    await sleep(1000);

    // Validate fact content before sending
    if (!dogFact || typeof dogFact !== 'string' || dogFact.trim().length === 0) {
      throw new Error('Invalid fact content received');
    }

    client.say(channel, `@${tags.username}, ${dogFact.trim()}`);

  } catch (error) {
    if (error instanceof Error) {
      console.error(`[DOGFACTS] Error for user ${tags.username}:`, {
        message: error.message,
        timestamp: new Date().toISOString()
      });
    }

    client.say(channel, `@${tags.username}, sorry, dog facts service is temporarily unavailable.`);
  }
};
