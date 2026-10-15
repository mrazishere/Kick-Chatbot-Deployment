/**
 * !live / !offline — tell the bot the stream just started or ended, ahead of Kick.
 *
 * Description: Kick's API shows a stream's start and end minutes late, so commands
 *              that only work live (gamble, duels, raffles) or offline (fishing,
 *              traps, steals) open late. This sets the state those commands see right
 *              away. It stands until Kick says the same, a livestream webhook arrives,
 *              or 20 minutes pass (points/service.ts, LIVE_OVERRIDE_MS). Payouts and
 *              reward pausing still follow Kick, so it can't mint currency.
 *
 * Permission required: the streamer, the bot owner and mods; viewers get no answer
 *
 * Usage:   !live      - the stream is live
 *          !offline   - the stream has ended
 */

import { CommandFn } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { getPointsService } from '../points/service';

export const streamstatus: CommandFn = async function streamstatus(client, message, channel, tags) {
  const first = (message.trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (first !== '!live' && first !== '!offline') return;
  if (isBotSender(tags.username, tags.senderId)) return;
  if (!(tags.isBroadcaster || tags.isModUp || isBotOwner(tags.username))) return;
  const chan = channel.replace(/^#/, '').toLowerCase();
  // Only the points service's commands go by the stream's state.
  const svc = getPointsService(chan);
  if (!svc || !svc.config().enabled) return;

  const live = first === '!live';
  const before = svc.setLiveOverride(live, tags.username);
  const what = live
    ? '🔴 Stream is live: live-only commands are on'
    : '⚫ Stream is offline: offline-only commands are open';
  const note = before === live ? ' (it already was, as far as the bot knew)' : '';
  await client.say(channel, `@${tags.username} ${what}${note}.`).catch(err => {
    console.error(`[POINTS] !${live ? 'live' : 'offline'} reply in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
};
