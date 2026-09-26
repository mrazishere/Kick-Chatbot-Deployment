/**
 * Last seen / first seen command
 *
 * Description: When a viewer last (or first) chatted in this channel. Each bot
 *              serves one channel, so this is per channel, not Kick-wide. Every
 *              chat message is recorded as it arrives; on first run the table is
 *              filled from the channel's log, so history reaches back as far as
 *              the log does.
 *
 * Permission required: all users (1 per 5s each)
 *
 * Usage:   !lastseen @user   - when they last chatted here
 *          !seen @user       - the same
 *          !firstseen @user  - when they first chatted here
 */

import { CommandFn } from '../types';
import { SYSTEM_BOTS } from '../system-bots';
import { isBotSender } from '../bot-identity';
import { getSeen, noteSeen, openCommunityDb } from '../community/store';
import { isoDay, makeCooldown, parseUsername, span } from '../community/format';

const cooldown = makeCooldown(5000);

export const lastseen: CommandFn = async function lastseen(client, message, channel, tags, _config) {
  const db = openCommunityDb(channel);
  if (!db) return;

  const now = Date.now();
  const words = message.trim().split(/\s+/);
  const cmd = words[0].toLowerCase();
  const isQuery = cmd === '!lastseen' || cmd === '!seen' || cmd === '!firstseen';

  // Record first, so asking about yourself counts as being seen. The query itself
  // is recorded too: typing a command is still chatting.
  const me = tags.username;
  if (!SYSTEM_BOTS.has(me.toLowerCase()) && !isBotSender(me, tags.senderId)) {
    try {
      noteSeen(db, me, now, !!tags.badges.subscriber);
    } catch (err) {
      console.error(`[LASTSEEN] Could not record ${me}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (!isQuery) return;

  const say = (text: string) => client.say(channel, text);
  const target = parseUsername(words[1]);
  if (!target) return void say(`@${me} usage: ${cmd} @user`);
  if (cooldown(me.toLowerCase())) return;

  const lc = target.toLowerCase();
  if (lc === me.toLowerCase() && cmd !== '!firstseen') return void say(`@${me} you're right here`);
  if (isBotSender(target)) return void say(`@${me} I'm always here`);

  const row = getSeen(db, lc);
  if (!row) return void say(`@${me} I've never seen ${target} chat here`);

  if (cmd === '!firstseen') {
    return void say(`@${me} ${row.username} first chatted here on ${isoDay(row.first_at)}, ${span(now - row.first_at)} ago`);
  }
  return void say(`@${me} ${row.username} last chatted here ${span(now - row.last_at)} ago`);
};
