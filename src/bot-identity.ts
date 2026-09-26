/**
 * Resolves and caches the bot's own Kick identity (username + userId) so
 * message handlers can recognize the bot's own echoed-back messages and
 * never act on them.
 *
 * Resolves once per process from the bot's own bearer token via the public
 * `/users` endpoint. After resolution, lookups are synchronous.
 */

import axios from 'axios';
import KickAuth = require('./auth');

interface BotIdentity {
  username: string;       // lowercase
  userId: number | string;
}

let cached: BotIdentity | null = null;
let resolving: Promise<BotIdentity | null> | null = null;

export async function resolveBotIdentity(): Promise<BotIdentity | null> {
  if (cached) return cached;
  if (resolving) return resolving;

  resolving = (async () => {
    try {
      const auth = new KickAuth();
      const token = await auth.getAccessToken();
      if (!token) return null;

      const resp = await axios.get('https://api.kick.com/public/v1/users', {
        headers: { Authorization: `Bearer ${token}` }
      });

      const raw = resp.data?.data;
      const userData = Array.isArray(raw) ? raw[0] : raw;
      if (!userData) return null;

      const username = String(userData.username || userData.name || userData.slug || '').toLowerCase();
      const userId = userData.user_id ?? userData.id;
      if (!username) return null;

      cached = { username, userId };
      console.log(`[BOT-IDENTITY] Resolved bot identity: ${username} (id=${userId})`);
      return cached;
    } catch (err) {
      if (err instanceof Error) {
        console.error('[BOT-IDENTITY] Failed to resolve:', err.message);
      }
      return null;
    } finally {
      resolving = null;
    }
  })();

  return resolving;
}

export function getBotIdentity(): BotIdentity | null {
  return cached;
}

export function isBotSender(username: string | undefined, senderId?: number | string): boolean {
  if (!cached) return false;
  if (username && username.toLowerCase() === cached.username) return true;
  if (senderId !== undefined && String(senderId) === String(cached.userId)) return true;
  return false;
}

/**
 * Whether `username` is the bot owner (KICK_OWNER). Case-insensitive: Kick sends
 * the display spelling ("MrAZisHere") while the setting is usually lowercase, and
 * an exact match silently treated the owner as a regular viewer.
 */
export function isBotOwner(username: string | undefined): boolean {
  const owner = (process.env.KICK_OWNER || '').trim().replace(/^@+/, '').toLowerCase();
  return !!owner && !!username && username.replace(/^@+/, '').toLowerCase() === owner;
}
