/**
 * Cat Facts command
 *
 * Description: Get random cat facts on twitch chat
 *
 * Credits: https://meowfacts.herokuapp.com/
 *
 * Permission required: all users
 *
 * Usage:   !catfacts - Random cat fact
 *
 * TODO: add search functionality
 */

import fetch from 'node-fetch';
import { CommandFn } from '../types';

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_REQUESTS = 3; // Max 3 requests per 30 seconds

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

export const catfacts: CommandFn = async function catfacts(client, message, channel, tags, _config) {
  const input = message.split(" ");
  if (input[0] === "!catfacts") {
    // Check rate limiting
    if (!checkRateLimit(tags.username)) {
      client.say(channel, `@${tags.username}, please wait before requesting more cat facts.`);
      return;
    }

    try {
      const response = await fetch('https://meowfacts.herokuapp.com/', {
        method: 'GET',
        headers: { 'accept': 'application/json', 'content-type': 'application/json' },
        timeout: 5000 // 5 second timeout
      });

      if (response.ok) {
        const data = await response.json() as { data: string[] };
        const output = data.data[0];

        await sleep(1000);

        if (!input[1]) {
          client.say(channel, `@${tags.username}, ${output}`);
        } else {
          client.say(channel, `@${tags.username}, this command does not accept any inputs.`);
        }
      } else {
        client.say(channel, "Sorry, API is unavailable right now. Please try again later.");
      }
    } catch (error) {
      if (error instanceof Error) {
        console.error(`[CATFACTS] Error for user ${tags.username}:`, {
          message: error.message,
          timestamp: new Date().toISOString()
        });
      }
      client.say(channel, "Sorry, there was an error getting cat facts.");
    }
    return;
  }
};
