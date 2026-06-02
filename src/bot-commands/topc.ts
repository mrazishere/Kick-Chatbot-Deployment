/**
 * Top chatters command — shows top 5 chatters from the current/last KPP session.
 *
 * Usage: !topc
 *
 * Scope: sukasblood only.
 *
 * Data source:
 *   data/kpp/<channel>/current.json   (live session)
 *   data/kpp/<channel>/sessions.json  (finalized — uses cumulativeChatters if present, else uniqueChatters count)
 */

import * as fs from 'fs';
import * as path from 'path';
import { CommandFn, CurrentKPPSession } from '../types';

const SUPPORTED_CHANNELS = new Set(['sukasblood']);

export const topc: CommandFn = async function topc(client, message, channel, tags, config) {
  if (message.trim().split(/\s+/)[0] !== '!topc') return;
  if (!SUPPORTED_CHANNELS.has(config.channelName)) return;

  const dataDir = path.join(process.cwd(), 'data', 'kpp', config.channelName);
  const currentFile = path.join(dataDir, 'current.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  try {
    if (!fs.existsSync(currentFile)) return;

    const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')) as CurrentKPPSession;
    const chatters = current.cumulativeChatters;

    if (!chatters || Object.keys(chatters).length === 0) {
      await client.say(channel, `@${tags.username}, no chat data yet this stream.`);
      return;
    }

    const sorted = Object.entries(chatters)
      .filter(([user]) => user !== 'mraiishere')
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    const list = sorted.map(([user, count], i) => `${i + 1}. ${user} (${count})`).join(' | ');
    await client.say(channel, `@${tags.username}, Top 5 chatters this stream: ${list}`);
  } catch (err) {
    if (err instanceof Error) console.error('[TOPC] Command error:', err.message);
  }
};
