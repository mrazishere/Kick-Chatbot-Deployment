/**
 * Jokes command
 *
 * Description: Get random jokes on twitch chat
 *
 * Credits: https://v2.jokeapi.dev/joke
 *
 * Permission required: all users
 *
 * Usage:   !jokes - Random jokes
 *          !jokes<SPACE>[SEARCH TERM] - Jokes with search term
 *
 *
 *
 */

import fetch from 'node-fetch';
import { CommandFn, ClientWrapper, KickTags } from '../types';

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_REQUESTS = 5; // Max 5 requests per 30 seconds

function sleep(ms: number): Promise<void> {
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

// Input sanitization function
function sanitizeSearchTerm(term: string | undefined): string {
  if (!term || typeof term !== 'string') return '';
  // Allow letters, numbers, spaces, basic punctuation for joke searches
  return term.replace(/[^a-zA-Z0-9\s\-_.,!?]/g, '').trim().substring(0, 50);
}

interface JokeData {
  type: string;
  setup?: string;
  delivery?: string;
  joke?: string;
  error?: boolean;
}

// Fetch random joke
async function getRandomJoke(): Promise<JokeData> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

  try {
    const response = await fetch('https://v2.jokeapi.dev/joke/Any?safe-mode', {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'User-Agent': 'Twitch Bot Jokes'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json() as JokeData;
    return data;

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Search for jokes by term
async function searchJokes(searchTerm: string): Promise<JokeData> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000); // 8 second timeout

  try {
    const response = await fetch(`https://v2.jokeapi.dev/joke/Any?safe-mode&contains=${encodeURIComponent(searchTerm)}`, {
      method: 'GET',
      headers: {
        'accept': 'application/json',
        'content-type': 'application/json',
        'User-Agent': 'Twitch Bot Jokes'
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`API responded with status: ${response.status}`);
    }

    const data = await response.json() as JokeData;
    return data;

  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

// Format and deliver joke content
async function deliverJoke(client: ClientWrapper, channel: string, tags: KickTags, jokeData: JokeData): Promise<boolean> {
  if (jokeData.error) {
    return false; // Indicates no joke found
  }

  if (jokeData.type === 'twopart') {
    // Two-part joke: setup and delivery
    if (jokeData.setup && jokeData.delivery) {
      client.say(channel, `@${tags.username}, ${jokeData.setup}`);
      await sleep(3000); // Wait 3 seconds before punchline
      client.say(channel, jokeData.delivery);
      return true;
    }
  } else if (jokeData.type === 'single') {
    // Single joke
    if (jokeData.joke) {
      client.say(channel, `@${tags.username}, ${jokeData.joke}`);
      return true;
    }
  }

  return false; // Invalid joke format
}

export const jokes: CommandFn = async function jokes(client, message, channel, tags, _config) {
  const input = message.split(" ");

  if (input[0] !== "!jokes") {
    return;
  }

  // Check rate limiting
  if (!checkRateLimit(tags.username)) {
    client.say(channel, `@${tags.username}, please wait before requesting more jokes.`);
    return;
  }

  try {
    if (!input[1]) {
      // Get random joke
      const jokeData = await getRandomJoke();
      await sleep(1000);

      const success = await deliverJoke(client, channel, tags, jokeData);
      if (!success) {
        client.say(channel, `@${tags.username}, sorry, unable to get a joke right now.`);
      }

    } else {
      // Search for jokes with term
      const searchTerm = sanitizeSearchTerm(input[1]);
      if (!searchTerm) {
        client.say(channel, `@${tags.username}, invalid search term provided.`);
        return;
      }

      const jokeData = await searchJokes(searchTerm);
      await sleep(1000);

      if (jokeData.error) {
        client.say(channel, `@${tags.username}, sorry, nothing found with the search term: ${searchTerm}`);
        return;
      }

      const success = await deliverJoke(client, channel, tags, jokeData);
      if (!success) {
        client.say(channel, `@${tags.username}, sorry, unable to get a joke with that search term.`);
      }
    }

  } catch (err) {
    if (err instanceof Error) {
      console.error(`[JOKES] Error for user ${tags.username}:`, {
        message: err.message,
        timestamp: new Date().toISOString(),
        searchTerm: input[1] ? sanitizeSearchTerm(input[1]) : 'none'
      });
    }

    client.say(channel, `@${tags.username}, sorry, jokes service is temporarily unavailable.`);
  }
};
