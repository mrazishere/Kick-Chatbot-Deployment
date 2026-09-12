/**
 * Clip the last 30 seconds of the stream.
 *
 * Description: Creates a real Kick clip of what just happened and posts the link.
 *
 * Permission required:
 *          !clip: all users
 *
 * Usage:   !clip            - clip the last 30 seconds
 *          !clip <title>    - same, with your own title (50 chars max)
 *
 * Kick has no public clips API, so this drives the same internal calls the site
 * makes when a viewer presses the clip button, authenticated as the bot account
 * (see channels/kick-clips.ts). Clips therefore show the bot as their creator.
 */

import { CommandFn } from '../types';
import { clipLiveStream, cleanTitle, currentLivestream, sessionToken, DEFAULT_CLIP_SECONDS } from '../channels/kick-clips';

/** One clip at a time per channel: Kick takes a second or two, and chat can spam. */
const USER_COOLDOWN_MS = 60_000;
const CHANNEL_COOLDOWN_MS = 15_000;

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

  if (inFlight.has(channelName)) return;
  const wait = cooldownLeft(`${channelName}:${me.toLowerCase()}`, USER_COOLDOWN_MS);
  if (wait) return void say(`@${me} wait ${wait}s before clipping again`);
  if (cooldownLeft(`${channelName}:channel`, CHANNEL_COOLDOWN_MS)) return;

  inFlight.add(channelName);
  try {
    const live = await currentLivestream(channelName).catch(() => null);
    if (!live) return void say(`@${me} nothing to clip, the stream is offline`);

    const token = sessionToken();
    if (!token) {
      console.error('[CLIP] No Kick session token on disk — put the session_token cookie in .session.json.');
      return void say(`@${me} clipping is not set up right now`);
    }

    const title = cleanTitle(words.slice(1).join(' '), live.sessionTitle);
    const made = await clipLiveStream({ channelSlug: channelName, token, title, seconds: DEFAULT_CLIP_SECONDS });
    console.log(`[CLIP] ${me} clipped ${made.durationSeconds}s of ${channelName}: ${made.id} "${made.title}"`);
    return void say(`@${me} clipped the last ${made.durationSeconds}s ${made.url}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(`[CLIP] ${channelName} clip for ${me} failed: ${why}`);
    // A rejected token means the pasted session has expired and needs replacing.
    if (/401|403|unauthenticated/i.test(why)) {
      console.error('[CLIP] Kick rejected the session token — it has expired; replace .session.json.');
    }
    return void say(`@${me} could not make a clip just now, try again in a moment`);
  } finally {
    inFlight.delete(channelName);
  }
};
