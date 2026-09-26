/**
 * Dictionary command
 *
 * Description: Get word definitions in chat
 *
 * Credits: Wiktionary (en.wiktionary.org REST API), with https://dictionaryapi.dev/
 *          as a fallback. dictionaryapi.dev went unresponsive on 2026-09-26 (it
 *          accepts connections but never answers), so Wiktionary leads now.
 *
 * Permission required: all users
 *
 * Usage:   !define<SPACE>[SEARCH TERM] - Get definition of search term
 *
 *
 *
 */

import fetch from 'node-fetch';
import { CommandFn } from '../types';

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_REQUESTS = 5; // Max 5 requests per 30 seconds


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
function sanitizeWord(word: string | undefined): string {
  if (!word || typeof word !== 'string') return '';
  // Only allow letters and basic punctuation for dictionary words
  return word.replace(/[^a-zA-Z'-]/g, '').trim().substring(0, 30);
}

interface ExtractedDefinition {
  word: string;
  partOfSpeech: string;
  definition: string;
}

const UA = 'KickChatbot/1.0 (https://github.com/mrazishere/Kick-Chatbot-Deployment)';

async function getJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'User-Agent': UA }, signal: controller.signal });
    const body = response.ok ? await response.json() as unknown : null;
    return { status: response.status, body };
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Wiktionary's definitions come as HTML fragments. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
}

/**
 * The first English definition on Wiktionary. Titles are case-sensitive there
 * ("Austrian" exists, "austrian" doesn't), so the spelling typed, lowercase and
 * capitalised are tried in turn. null when none has an English entry.
 */
async function fromWiktionary(word: string): Promise<ExtractedDefinition | null> {
  const lower = word.toLowerCase();
  const variants = [...new Set([word, lower, lower.charAt(0).toUpperCase() + lower.slice(1)])];
  for (const v of variants) {
    const { status, body } = await getJson(`https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(v)}`, 6000);
    if (status === 404) continue;
    if (status !== 200) throw new Error(`Wiktionary responded with status: ${status}`);
    const entries = (body as { en?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }> })?.en ?? [];
    for (const e of entries) {
      const def = (e.definitions ?? []).map(d => stripHtml(d.definition ?? '')).find(d => d.length > 0);
      if (def) return { word: v, partOfSpeech: e.partOfSpeech ? `(${e.partOfSpeech.toLowerCase()}) ` : '', definition: def };
    }
  }
  return null;
}

/** dictionaryapi.dev, kept as a fallback with a short timeout since it can hang. */
async function fromDictionaryApi(word: string): Promise<ExtractedDefinition | null> {
  const { status, body } = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`, 4000);
  if (status === 404) return null;
  if (status !== 200) throw new Error(`dictionaryapi.dev responded with status: ${status}`);
  const entry = (body as Array<{ word?: string; meanings?: Array<{ partOfSpeech?: string; definitions?: Array<{ definition?: string }> }> }>)?.[0];
  const meaning = entry?.meanings?.[0];
  const def = meaning?.definitions?.[0]?.definition?.trim();
  if (!def) return null;
  return { word: entry?.word || word, partOfSpeech: meaning?.partOfSpeech ? `(${meaning.partOfSpeech}) ` : '', definition: def };
}

/** A definition, null when the word isn't in either dictionary, or throws when neither answers. */
async function getDefinition(word: string): Promise<ExtractedDefinition | null> {
  try {
    const found = await fromWiktionary(word);
    if (found) return found;
  } catch (err) {
    console.error('[DICTIONARY] Wiktionary failed, trying dictionaryapi.dev:', err instanceof Error ? err.message : String(err));
    return await fromDictionaryApi(word);
  }
  // Wiktionary answered but had nothing; the other dictionary may still know it.
  try {
    return await fromDictionaryApi(word);
  } catch {
    return null;
  }
}

export const dictionary: CommandFn = async function dictionary(client, message, channel, tags, _config) {
  // Clean and split input to handle invisible Unicode characters
  const input = message.trim().split(" ").filter(part => part.trim().length > 0);

  if (input[0] !== "!define") {
    return;
  }

  // Check rate limiting
  if (!checkRateLimit(tags.username)) {
    client.say(channel, `@${tags.username}, please wait before requesting more definitions.`);
    return;
  }

  // Validate input
  if (!input[1]) {
    client.say(channel, `@${tags.username}, please provide a word to define. Usage: !define [word]`);
    return;
  }

  if (input.length > 2) {
    client.say(channel, `@${tags.username}, please provide only one word to define.`);
    return;
  }

  const word = sanitizeWord(input[1]);
  if (!word || word.length < 2) {
    client.say(channel, `@${tags.username}, invalid word provided. Please use letters only.`);
    return;
  }

  try {
    const definition = await getDefinition(word);
    if (!definition) {
      client.say(channel, `@${tags.username}, sorry, no definition found for: ${word}`);
      return;
    }

    // Format response (keep it concise for Twitch chat)
    let response = `@${tags.username}, ${definition.word}: ${definition.partOfSpeech}${definition.definition}`;

    // Keep it well inside Kick's 500-character limit
    if (response.length > 400) {
      response = response.substring(0, 397) + '...';
    }

    client.say(channel, response);

  } catch (err) {
    if (err instanceof Error) {
      console.error(`[DICTIONARY] Error for user ${tags.username}:`, {
        message: err.message,
        timestamp: new Date().toISOString(),
        word: word
      });
    }

    client.say(channel, `@${tags.username}, sorry, dictionary service is temporarily unavailable.`);
  }
};
