/**
 * Clip the last 30 seconds of the stream, or a length you choose.
 *
 * Description: Creates a real Kick clip of what just happened and posts the link.
 *
 * Permission required:
 *          !clip: all users
 *
 * Usage:   !clip                 - clip the last 30 seconds
 *          !clip <title>         - same, with your own title (50 chars max)
 *          !clip 45s [title]     - the last 45 seconds instead (5–90s; Kick keeps a 90s buffer)
 *
 * The length is only read as the first word and only with an "s", so a title like
 * "100 kills" stays a title.
 *
 * With no title the clip is named "<stream title> - clipped by <user>", trimmed to fit.
 *
 * Kick has no public clips API, so this drives the same internal calls the site
 * makes when a viewer presses the clip button, authenticated as the bot account
 * (see channels/kick-clips.ts). Clips therefore show the bot as their creator.
 */

import { CommandFn } from '../types';
import { clipLiveStream, cleanTitle, currentLivestream, fallbackTitle, sessionToken, DEFAULT_CLIP_SECONDS } from '../channels/kick-clips';
import { checkClipSession, clipSessionHealthy, startClipSessionWatchdog } from '../channels/clip-session';

/** One clip at a time per channel: Kick takes a second or two, and chat can spam. */
const USER_COOLDOWN_MS = 60_000;
const CHANNEL_COOLDOWN_MS = 15_000;
const MIN_CLIP_SECONDS = 5;
/** Kick's initiate call hands back a 90-second buffer (source_duration), checked live 2026-09-26. */
const MAX_CLIP_SECONDS = 90;

/** "45s title words" → 45 and the title. null seconds when the length is out of range. */
export function parseClipArgs(words: string[]): { seconds: number | null; title: string } {
  const m = /^(\d{1,3})s$/i.exec(words[0] ?? '');
  if (!m) return { seconds: DEFAULT_CLIP_SECONDS, title: words.join(' ').trim() };
  const n = Number(m[1]);
  return { seconds: n >= MIN_CLIP_SECONDS && n <= MAX_CLIP_SECONDS ? n : null, title: words.slice(1).join(' ').trim() };
}

// Loaded once per bot: watch the session so a dead token is found and renewed
// before a viewer runs into it, not after.
startClipSessionWatchdog();

const cooldowns = new Map<string, number>();
const inFlight = new Set<string>();

/** Remaining cooldown in seconds, starting it when free. */
function cooldownLeft(key: string, ms: number): number {
  const now = Date.now();
  const until = cooldowns.get(key) ?? 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  cooldowns.set(key, now + ms);
  if (cooldowns.size > 2000) for (const [k, v] of cooldowns) if (v <= now) cooldowns.delete(k);
  return 0;
}

export const clip: CommandFn = async function clip(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  if ((words[0] ?? '').toLowerCase() !== '!clip') return;

  const channelName = (config.channelName || channel.replace(/^#/, '')).toLowerCase();
  const me = tags.username;
  const say = (text: string) => client.say(channel, text);
  const { seconds, title: typed } = parseClipArgs(words.slice(1));
  if (seconds === null) return void say(`@${me} pick ${MIN_CLIP_SECONDS} to ${MAX_CLIP_SECONDS} seconds, like !clip 45s`);

  if (inFlight.has(channelName)) return;
  const wait = cooldownLeft(`${channelName}:${me.toLowerCase()}`, USER_COOLDOWN_MS);
  if (wait) return void say(`@${me} wait ${wait}s before clipping again`);
  if (cooldownLeft(`${channelName}:channel`, CHANNEL_COOLDOWN_MS)) return;

  inFlight.add(channelName);
  try {
    const live = await currentLivestream(channelName).catch(() => null);
    if (!live) return void say(`@${me} nothing to clip, the stream is offline`);

    const token = sessionToken();
    if (!token || !clipSessionHealthy()) {
      console.error('[CLIP] No usable Kick session token — the watchdog has been told to renew it.');
      void checkClipSession(true);
      return void say(`@${me} clipping is down right now, the bot is fixing it`);
    }

    const title = typed ? cleanTitle(typed, live.sessionTitle) : fallbackTitle(live.sessionTitle, me);
    const made = await clipLiveStream({ channelSlug: channelName, token, title, seconds });
    console.log(`[CLIP] ${me} clipped ${made.durationSeconds}s of ${channelName}: ${made.id} "${made.title}"`);
    return void say(`@${me} clipped the last ${made.durationSeconds}s ${made.url}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[CLIP] ${channelName} clip for ${me} failed: ${why}`);
    // A rejected token means the pasted session has expired and needs replacing.
    if (/401|403|unauthenticated/i.test(why)) {
      // Renew immediately rather than waiting for the hourly check.
      void checkClipSession(true);
    } else if (seconds !== DEFAULT_CLIP_SECONDS && /finalizing the clip: .*\b(400|422)\b/.test(why)) {
      // Kick turned the length down; say so rather than blaming a hiccup.
      return void say(`@${me} Kick didn't accept a ${seconds}s clip, try a shorter one`);
    }
    return void say(`@${me} could not make a clip just now, try again in a moment`);
  } finally {
    inFlight.delete(channelName);
  }
};
