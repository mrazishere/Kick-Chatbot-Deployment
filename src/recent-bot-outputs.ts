/**
 * Tracks recent bot outputs per channel so that auto-translate (and any other
 * passive message handler) can skip messages the bot itself just sent — Kick
 * echoes the bot's own messages back through the chat feed, and we don't want
 * to translate our own translations into an infinite loop.
 *
 * In-memory only; entries expire after TTL_MS.
 */

const TTL_MS = 60_000;
const MAX_PER_CHANNEL = 40;

interface Entry {
  text: string;
  expiresAt: number;
}

const perChannel = new Map<string, Entry[]>();

// Callers pass channel sometimes as "mrazishere" (sendMessage) and sometimes
// as "#mrazishere" (command dispatch). Normalize so lookups match.
function normalizeChannel(channel: string): string {
  return channel.startsWith('#') ? channel.slice(1) : channel;
}

function prune(channel: string): Entry[] {
  const key = normalizeChannel(channel);
  const now = Date.now();
  const list = (perChannel.get(key) || []).filter(e => e.expiresAt > now);
  perChannel.set(key, list);
  return list;
}

export function markBotOutput(channel: string, text: string): void {
  if (!text) return;
  const key = normalizeChannel(channel);
  const list = prune(key);
  list.push({ text: text.trim(), expiresAt: Date.now() + TTL_MS });
  if (list.length > MAX_PER_CHANNEL) {
    list.splice(0, list.length - MAX_PER_CHANNEL);
  }
  perChannel.set(key, list);
}

export function wasRecentBotOutput(channel: string, text: string): boolean {
  if (!text) return false;
  const needle = text.trim();
  const list = prune(channel);
  return list.some(e => e.text === needle);
}
