/**
 * Turn the last 30 seconds of stream into a sound on the streamer's soundboard.
 *
 * Description: Clips the stream like !clip, imports that clip into Blerp as a
 *              sound, and files it in the streamer's suggestion queue for them
 *              to approve.
 *
 * Permission required:
 *          !blerp: moderators and above (user, 2026-09-12)
 *
 * Usage:   !blerp                - suggest the last 30 seconds
 *          !blerp <title>        - same, with your own title
 *          !blerp 11s [title]    - the last 11 seconds instead (5–30s; Blerp's cap is 30)
 *
 * Nothing here plays on stream by itself. The suggestion sits as PENDING until
 * the streamer approves it in their own Blerp dashboard, so the worst a bad
 * !blerp costs is one queue entry they can reject.
 *
 * Two things to know before changing this:
 *
 *   - The target is config.blerpStreamerId, not a lookup by Kick username.
 *     Streamers can hold several Blerp accounts and the one their Kick name is
 *     registered against may be dormant — sukasblood's is. Resolving at
 *     runtime would file suggestions into an inbox nobody reads.
 *   - A clip is made first and stays made. If the Blerp half fails the clip is
 *     still good, so the reply hands over the clip link rather than pretending
 *     the whole thing failed.
 */

import { CommandFn } from '../types';
import { clipLiveStream, cleanTitle as cleanClipTitle, currentLivestream, fallbackTitle, sessionToken } from '../channels/kick-clips';
import { checkClipSession, clipSessionHealthy } from '../channels/clip-session';
import {
  usableJwt, createBlerpFromUrl, suggestToStreamer, removeBlerp, cleanTitle, blerpErrorDetail,
  parseBlerpArgs, MIN_BLERP_SECONDS, MAX_BLERP_SECONDS
} from '../channels/blerp';
import { checkBlerpSession, startBlerpSessionWatchdog } from '../channels/blerp-session';

// Loaded once per bot: renew the Blerp login long before a mod runs into a
// dead one, the same shape as the clip session watchdog.
startBlerpSessionWatchdog();

/** Blerp does real work per import, and a queue of junk is the failure mode. */
const USER_COOLDOWN_MS = 5 * 60_000;
const CHANNEL_COOLDOWN_MS = 60_000;

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

export const blerp: CommandFn = async function blerp(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  if ((words[0] ?? '').toLowerCase() !== '!blerp') return;

  const channelName = (config.channelName || channel.replace(/^#/, '')).toLowerCase();
  const me = tags.username;
  const say = (text: string) => client.say(channel, text);

  const isOwner = !!process.env.KICK_OWNER && me.toLowerCase() === process.env.KICK_OWNER.toLowerCase();
  if (!tags.isModUp && !isOwner) return;

  // Checked before any cooldown, so a typo doesn't cost the five-minute wait.
  const { seconds, title: typed } = parseBlerpArgs(words.slice(1));
  if (seconds === null) return void say(`@${me} pick ${MIN_BLERP_SECONDS} to ${MAX_BLERP_SECONDS} seconds, like !blerp 11s`);

  const streamerId = typeof config.blerpStreamerId === 'string' ? config.blerpStreamerId.trim() : '';
  if (!streamerId) {
    console.error(`[BLERP] ${channelName} has no blerpStreamerId configured — command ignored.`);
    return void say(`@${me} this channel isn't linked to a Blerp soundboard yet`);
  }

  if (inFlight.has(channelName)) return;
  const wait = cooldownLeft(`${channelName}:${me.toLowerCase()}`, USER_COOLDOWN_MS);
  if (wait) return void say(`@${me} wait ${wait}s before making another blerp`);
  if (cooldownLeft(`${channelName}:channel`, CHANNEL_COOLDOWN_MS)) return;

  inFlight.add(channelName);
  let madeId = '';
  try {
    const live = await currentLivestream(channelName).catch(() => null);
    if (!live) return void say(`@${me} nothing to blerp, the stream is offline`);

    const token = sessionToken();
    if (!token || !clipSessionHealthy()) {
      console.error('[BLERP] No usable Kick session token — the watchdog has been told to renew it.');
      void checkClipSession(true);
      return void say(`@${me} clipping is down right now, the bot is fixing it`);
    }

    // Blerp first: a dead session should not leave an orphan clip behind.
    const jwt = await usableJwt();
    if (!jwt) {
      console.error('[BLERP] No usable Blerp session — renewing now.');
      void checkBlerpSession(true);
      return void say(`@${me} the bot can't reach Blerp right now`);
    }

    const clipTitle = typed ? cleanClipTitle(typed, live.sessionTitle) : fallbackTitle(live.sessionTitle, me);
    // The end of Kick's buffer: `seconds` of what just happened, and the sound keeps all of it.
    const made = await clipLiveStream({ channelSlug: channelName, token, title: clipTitle, seconds });
    console.log(`[BLERP] ${me} clipped ${made.durationSeconds}s of ${channelName}: ${made.id}`);

    const soundTitle = cleanTitle(typed, made.title);
    const sound = await createBlerpFromUrl({
      url: made.url,
      title: soundTitle,
      token: jwt,
      seconds: made.durationSeconds,
      keywords: ['kick', channelName]
    });
    madeId = sound.id;
    console.log(`[BLERP] imported ${made.id} as blerp ${sound.id} "${soundTitle}"`);

    const suggestion = await suggestToStreamer({ biteId: sound.id, streamerId, token: jwt });
    const state = (suggestion.approvalState || 'PENDING').toUpperCase();
    console.log(`[BLERP] suggested ${sound.id} to ${streamerId}: ${suggestion.id} (${state})`);

    const verb = state === 'APPROVED' ? 'added to the soundboard' : 'sent for approval';
    return void say(`@${me} blerped it and ${verb} ${sound.url}`);
  } catch (err) {
    const why = blerpErrorDetail(err);
    console.error(`[BLERP] ${channelName} blerp for ${me} failed: ${why}`);

    // The sound exists but never reached the queue: pull it rather than leave
    // an orphan on the bot's account that nobody asked for.
    if (madeId) {
      const jwt = await usableJwt();
      if (jwt) {
        const pulled = await removeBlerp(madeId, jwt);
        console.error(`[BLERP] orphan sound ${madeId} ${pulled ? 'removed' : 'could NOT be removed'}`);
      }
    }

    if (/blerp session expired|unauthenticated/i.test(why)) {
      // Renew immediately rather than waiting for the next scheduled check.
      void checkBlerpSession(true);
      return void say(`@${me} the bot's Blerp login is being renewed, try again shortly`);
    }
    if (/401|403/.test(why)) void checkClipSession(true);
    return void say(`@${me} could not make that blerp, try again in a moment`);
  } finally {
    inFlight.delete(channelName);
  }
};
