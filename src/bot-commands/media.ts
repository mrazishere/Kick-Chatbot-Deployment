/**
 * !media — control the media share video overlay from chat.
 *
 * Description: the video overlay mirrors the channel's StreamElements media share
 *              (points.video.mediashare, community/mediashare.ts). A player that keeps
 *              its pause to itself, like an app on the streamer's phone, can't be
 *              followed, so a pause there leaves the overlay playing on: !media pause
 *              hides the overlay and stops its video where it is, and !media play shows
 *              it again and carries on from there, in step with the phone. Both also
 *              pause or play StreamElements' player, which the dashboard's phone player
 *              follows, so with that player the sound stops and starts with them. That lasts
 *              until !media play or the next stream. !media hide only hides it, for the
 *              video that's up (an audio-only request): it keeps following along unseen
 *              and shows again for the next one, or with !media show.
 *              (Not !ms: that's the translate command's Malay.)
 *
 * Permission required: plain !media (what's playing) is anyone's, once every 15s a
 *                      channel; the rest is the streamer's, the bot owner's and mods'
 *
 * Usage:   !media          - what's playing (and, for mods, what the overlay is doing)
 *          !media pause    - hide it and stop it where it is (also hold, stop)
 *          !media play     - show it and carry on (also resume, unpause)
 *          !media hide     - hide it for this video only; it keeps up
 *          !media show     - show it again
 *          (!mediashare works as !media)
 */

import { CommandFn } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { getPointsService } from '../points/service';
import { PlayerSong, mediaShareHeld, mediaShareHiddenKey, mediaShareUp, playerAction, setMediaShareHeld, setMediaShareHiddenKey } from '../community/mediashare';

const PAUSE = new Set(['pause', 'hold', 'stop']);
/** Plain !media from viewers: once this often a channel. */
const STATUS_GAP_MS = 15_000;
const lastStatus = new Map<string, number>();
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const PLAY = new Set(['play', 'resume', 'unpause']);

export const media: CommandFn = async function media(client, message, channel, tags) {
  const words = message.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  if (first !== '!media' && first !== '!mediashare') return;
  if (isBotSender(tags.username, tags.senderId)) return;
  const word = (words[1] ?? '').toLowerCase();
  // Plain !media (what's playing) is for everyone, once every STATUS_GAP_MS a channel; the rest is mods'.
  const mod = tags.isBroadcaster || tags.isModUp || isBotOwner(tags.username);
  if (!mod && word) return;
  const chan = channel.replace(/^#/, '').toLowerCase();
  const svc = getPointsService(chan);
  const cfg = svc?.config();
  const db = svc?.db();
  if (!svc || !cfg?.enabled || !cfg.video.mediashare || !db) return;
  const say = (text: string) => client.say(channel, `@${tags.username} ${text}`).catch(err => {
    console.error(`[MEDIASHARE] !media reply in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  const fail = (err: unknown) => {
    console.error(`[MEDIASHARE] !media ${words[1] ?? ''} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
    void say("couldn't change the media share overlay just now, try again.");
  };

  const held = mediaShareHeld(db);

  if (word === 'hide' || word === 'show') {
    let up: PlayerSong | null;
    try {
      up = await mediaShareUp(chan);
    } catch (err) {
      return fail(err);
    }
    if (word === 'show') {
      if (!mediaShareHiddenKey(db)) return void say('👁️ The media share overlay isn\'t hidden.');
      try {
        setMediaShareHiddenKey(db, null);
      } catch (err) {
        return fail(err);
      }
      console.log(`[MEDIASHARE] ${tags.username} showed the media share overlay in ${chan}`);
      return void say(`👁️ Media share overlay showing again${held ? ' (still paused: !media play)' : ''}.`);
    }
    if (!up) return void say('Nothing is playing on media share to hide.');
    if (mediaShareHiddenKey(db) === up.key) return void say('🙈 The media share overlay is already hidden for this one.');
    try {
      setMediaShareHiddenKey(db, up.key);
    } catch (err) {
      return fail(err);
    }
    console.log(`[MEDIASHARE] ${tags.username} hid the media share overlay for "${up.title}" in ${chan}`);
    return void say(`🙈 Media share overlay hidden for "${up.title}"; it shows again for the next one, or with !media show.`);
  }

  if (!PAUSE.has(word) && !PLAY.has(word)) {
    // What's playing, and (for mods) what the overlay is doing.
    if (!mod) {
      const now = Date.now();
      if (now - (lastStatus.get(chan) ?? 0) < STATUS_GAP_MS) return;
      lastStatus.set(chan, now);
    }
    let up: PlayerSong | null = null;
    try {
      up = await mediaShareUp(chan);
    } catch (err) {
      console.error(`[MEDIASHARE] !media in ${chan}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const playing = up
      ? `🎵 Now playing: ${up.title}${up.username ? ` · requested by ${up.username}` : ''}${up.tip && up.amount !== null ? ` ($${up.amount})` : ''}${up.end > up.start ? ` · ${clock(up.end - up.start)}` : ''}`
      : '🎵 Nothing is playing on media share right now.';
    if (!mod) return void say(playing);
    const hidden = up !== null && mediaShareHiddenKey(db) === up.key;
    const overlay = held
      ? ' · Overlay paused and hidden (!media play)'
      : hidden
        ? ' · Overlay hidden for this one (!media show)'
        : up ? ' · Overlay on (!media pause | hide)' : '';
    return void say(playing + overlay);
  }
  const hold = PAUSE.has(word);
  // StreamElements' own pause or play too: the dashboard's phone player follows it, so its sound
  // stops and starts with the overlay (an app's player, like Stream Buddy's, only holds the queue).
  try {
    await playerAction(chan, hold ? 'pause' : 'play');
  } catch (err) {
    console.error(`[MEDIASHARE] !media ${word} in ${chan}: StreamElements ${hold ? 'pause' : 'play'} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (hold === held) return void say(hold ? '⏸️ Media share paused.' : '▶️ Media share playing.');
  try {
    setMediaShareHeld(db, hold);
  } catch (err) {
    return fail(err);
  }
  console.log(`[MEDIASHARE] ${tags.username} ${hold ? 'paused' : 'resumed'} the media share overlay in ${chan}`);
  void say(hold
    ? '⏸️ Media share paused, and its overlay hidden. !media play carries on where it left off.'
    : '▶️ Media share playing, its overlay back on where it left off.');
};
