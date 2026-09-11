/**
 * Which chat messages keep a viewer earning.
 *
 * Earning follows chat presence, so anything that refreshes presence is worth
 * farming. The user's rules (2026-09-11): a message counts unless it is the
 * points command itself, low effort (only emotes, or under 3 characters of
 * text), or the same as that viewer's previous message. Only back-to-back
 * repeats are ignored; alternating two lines still counts.
 */

/** Kick writes emotes into message text as `[emote:<id>:<name>]`. */
const EMOTE_TOKEN = /\[emote:\d+:[^\]]*\]/gi;
const MIN_TEXT_CHARS = 3;
/** A viewer's last message is forgotten after this long idle; a repeat that late is not spam. */
const LAST_MESSAGE_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_REMEMBERED = 20_000;

/**
 * Comparable form of a message: emotes removed, lowercased, whitespace collapsed,
 * and runs of one character squeezed, so "LOL", "lol " and "lolll" are the same.
 */
export function normalizeChat(text: string): string {
  return text
    .replace(EMOTE_TOKEN, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(.)\1+/gu, '$1');
}

export type PresenceVerdict =
  | { counts: true; normalized: string }
  | { counts: false; reason: 'command' | 'low_effort' | 'repeat'; normalized: string };

/**
 * Whether `text` refreshes presence, given the normalized form of the same
 * viewer's previous message (undefined when there is none) and the channel's
 * points command word without the `!`.
 */
export function presenceVerdict(text: string, previousNormalized: string | undefined, command: string): PresenceVerdict {
  const normalized = normalizeChat(text);
  const firstWord = text.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (command && firstWord === `!${command.toLowerCase()}`) return { counts: false, reason: 'command', normalized };
  // Counted before squeezing repeats, so "aaa" is three characters of text.
  const textChars = Array.from(text.replace(EMOTE_TOKEN, '').replace(/\s+/g, '')).length;
  if (textChars < MIN_TEXT_CHARS) return { counts: false, reason: 'low_effort', normalized };
  if (previousNormalized !== undefined && normalized === previousNormalized) {
    return { counts: false, reason: 'repeat', normalized };
  }
  return { counts: true, normalized };
}

/**
 * Each viewer's previous message, in memory only. A restart forgets it, which at
 * worst lets one repeat count, and keeps the database out of the per-message path.
 */
export class LastMessages {
  private last = new Map<number, { normalized: string; at: number }>();

  previous(userId: number, now: number): string | undefined {
    const entry = this.last.get(userId);
    if (!entry || now - entry.at > LAST_MESSAGE_TTL_MS) return undefined;
    return entry.normalized;
  }

  remember(userId: number, normalized: string, now: number): void {
    // Delete first so the map's insertion order stays oldest-first for eviction.
    this.last.delete(userId);
    this.last.set(userId, { normalized, at: now });
    while (this.last.size > MAX_REMEMBERED) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
  }
}
