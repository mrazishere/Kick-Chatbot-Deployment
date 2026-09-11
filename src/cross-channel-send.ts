/**
 * Post a message into a chatroom we don't own — used by shadow/debug-relay
 * flows where one channel's bot needs to emit into another channel.
 *
 * Uses the bot account's own token (no channel OAuth), so messages post as
 * `type: 'user'` and Kick's 10-non-ASCII-char cap applies. Same sanitization
 * as template-kick-bot.ts sendMessage().
 */

import axios from 'axios';
import KickAuth = require('./auth');

const MAX_SPECIAL_CHARS = 10;
const MAX_LENGTH = 500;

export async function sendToBroadcaster(broadcasterUserId: number, message: string): Promise<void> {
  const auth = new KickAuth();
  const token = await auth.getAccessToken();
  if (!token) throw new Error('cross-channel-send: no bot token available');

  let sanitized = message
    .replace(/\n+/g, ' ')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    // Underscores only count as markdown at word edges; inside a word they're part of a name.
    .replace(/(?<![A-Za-z0-9_@])__(\S(?:.*?\S)?)__(?![A-Za-z0-9_])/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/(?<![A-Za-z0-9_@])_(\S(?:.*?\S)?)_(?![A-Za-z0-9_])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();

  // type:'user' has a 10 non-ASCII char cap; drop anything beyond.
  let specials = 0;
  let buf = '';
  for (const c of Array.from(sanitized)) {
    const cp = c.codePointAt(0);
    if (cp !== undefined && cp > 127) {
      if (specials < MAX_SPECIAL_CHARS) {
        buf += c;
        specials++;
      }
    } else {
      buf += c;
    }
  }
  sanitized = buf;

  if (sanitized.length > MAX_LENGTH) {
    sanitized = sanitized.substring(0, MAX_LENGTH - 3) + '...';
  }

  await axios.post(
    'https://api.kick.com/public/v1/chat',
    {
      broadcaster_user_id: broadcasterUserId,
      content: sanitized,
      type: 'user'
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
}
