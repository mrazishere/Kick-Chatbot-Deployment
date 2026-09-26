/**
 * Followage / subage / account age command
 *
 * Description: How long a viewer has followed or subscribed to this channel, and
 *              how old their Kick account is. All three come from one call to
 *              Kick's internal channel-user endpoint, which needs no auth. It is
 *              undocumented, so a failure answers in chat rather than going quiet.
 *
 * Permission required: all users (1 per 5s each)
 *
 * Usage:   !followage [@user]   - also !fa
 *          !subage [@user]      - months subscribed
 *          !accountage [@user]  - also !accage
 */

import fetch from 'node-fetch';
import { CommandFn } from '../types';
import { isoDay, makeCooldown, parseUsername, span } from '../community/format';

const COMMANDS: Record<string, 'follow' | 'sub' | 'account'> = {
  '!followage': 'follow', '!fa': 'follow',
  '!subage': 'sub',
  '!accountage': 'account', '!accage': 'account'
};

interface ChannelUser {
  username?: string;
  following_since?: string | null;
  created_at?: string | null;
  subscribed_for?: number | null;
  is_channel_owner?: boolean;
}

const cooldown = makeCooldown(5000);
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; user: ChannelUser | null }>();

/** The viewer as this channel sees them. null when Kick has no such user. Throws when Kick can't be reached. */
async function channelUser(channel: string, username: string): Promise<ChannelUser | null> {
  const key = `${channel}:${username.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;

  const url = `https://kick.com/api/v2/channels/${encodeURIComponent(channel)}/users/${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36' },
    timeout: 8000
  });
  let user: ChannelUser | null;
  if (res.status === 404) user = null;
  else if (!res.ok) throw new Error(`HTTP ${res.status}`);
  else user = await res.json() as ChannelUser;

  cache.set(key, { at: Date.now(), user });
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  return user;
}

function since(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
}

export const followage: CommandFn = async function followage(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  const kind = COMMANDS[words[0].toLowerCase()];
  if (!kind) return;

  const me = tags.username;
  const say = (text: string) => client.say(channel, text);
  if (cooldown(me.toLowerCase())) return;

  const target = words[1] ? parseUsername(words[1]) : me;
  if (!target) return void say(`@${me} usage: ${words[0].toLowerCase()} @user`);
  const self = target.toLowerCase() === me.toLowerCase();
  const chan = (config.channelName || channel.replace(/^#/, '')).toLowerCase();
  const streamer = config.streamerName || chan;

  let user: ChannelUser | null;
  try {
    user = await channelUser(chan, target);
  } catch (err) {
    console.error(`[FOLLOWAGE] Lookup of ${target} failed: ${err instanceof Error ? err.message : String(err)}`);
    return void say(`@${me} Kick didn't answer, try again in a bit`);
  }
  if (!user) return void say(`@${me} there's no Kick user called ${target}`);

  const name = user.username || target;
  const who = self ? 'you' : name;
  const now = Date.now();

  if (kind === 'account') {
    const created = since(user.created_at);
    const whose = self ? 'your' : `${name}'s`;
    if (created === null) return void say(`@${me} Kick didn't say when ${whose} account was made`);
    return void say(`@${me} ${whose} account is ${span(now - created)} old, made ${isoDay(created)}`);
  }

  if (user.is_channel_owner) return void say(`@${me} ${self ? 'you are' : `${name} is`} the streamer here`);

  if (kind === 'sub') {
    const months = user.subscribed_for ?? 0;
    if (months <= 0) return void say(`@${me} ${self ? "you aren't" : `${name} isn't`} subscribed to ${streamer}`);
    return void say(`@${me} ${who} ${self ? 'have' : 'has'} been subscribed to ${streamer} for ${months} month${months === 1 ? '' : 's'}`);
  }

  const followed = since(user.following_since);
  if (followed === null) return void say(`@${me} ${self ? "you aren't" : `${name} isn't`} following ${streamer}`);
  return void say(`@${me} ${who} ${self ? 'have' : 'has'} followed ${streamer} for ${span(now - followed)}, since ${isoDay(followed)}`);
};
