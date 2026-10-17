/**
 * Spin the wheel — a prize wheel on the fishing overlay (community/wheel.ts).
 *
 * Description: The bot picks the result, every item equally likely; the overlay
 *              plays the spin landing on it, and chat gets the result once the
 *              stream has caught up. Fishing alerts wait on the overlay while it
 *              spins and no big bite starts. Needs points with fishing on (the
 *              overlay is the fishing one) and an overlay showing.
 *
 * Permission required: the streamer, the bot owner and mods, for all of it (the
 *                      owner's call, 2026-10-14); viewers get no answer
 *
 * Usage:   !wheel [list]                   - the items, numbered
 *          !wheel spin                     - also !spin
 *          !wheel add <item> [| <item>…]   - add one or several, split with |
 *          !wheel remove <item or number>  - also rm, del
 *
 * Items, colours, spin length and "remove the winner" are also on the dashboard.
 */

import { CommandFn } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { getPointsService } from '../points/service';
import { overlayShowing, pushOverlay } from '../community/fish-overlay';
import { channelHasBite, STREAM_GRACE_MS } from '../community/big-bite';
import { addItems, changeWheel, pickWinner, readWheel, removeItem, RESULT_HOLD_MS, type Wheel } from '../community/wheel';
import { markWheelBusy, wheelBusy } from '../community/wheel-state';
import { extendVideo, videoOverlayShowing } from '../community/video-share';

/** How long a spin waits for a big bite already on the line, at most. */
const BITE_WAIT_MS = 90_000;
/** How often the overlay polls its feed (POLL_MS in the dashboard's FishOverlay): it can draw a spin this much late. */
const OVERLAY_POLL_MS = 500;
/** Kick cuts chat messages at 500 characters. */
const CHAT_MAX = 480;

const SUBS: Record<string, 'list' | 'spin' | 'add' | 'remove'> = {
  list: 'list', ls: 'list', spin: 'spin', add: 'add', remove: 'remove', rm: 'remove', del: 'remove', delete: 'remove'
};

const isWheelCommand = (word: string): boolean => word === '!wheel' || word === '!spin';

/** Spins waiting on a big bite, by channel, so a second !spin doesn't queue another. */
const waitingSpin = new Set<string>();

export const wheel: CommandFn = async function wheel(client, message, channel, tags) {
  const words = message.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  if (!isWheelCommand(first)) return;
  if (isBotSender(tags.username, tags.senderId)) return;
  const chan = channel.replace(/^#/, '').toLowerCase();
  const me = tags.username;
  const say = (text: string) => client.say(channel, text).catch(err => {
    console.error(`[WHEEL] Reply in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // The overlay is the fishing one: no points or no fishing, no wheel.
  const svc = getPointsService(chan);
  const cfg = svc?.config();
  const db = svc?.db();
  if (!svc || !cfg?.enabled || !cfg.games.enabled || !db) return;

  const sub = first === '!spin' ? 'spin' : SUBS[(words[1] ?? 'list').toLowerCase()];
  const rest = message.trim().split(/\s+/).slice(first === '!spin' ? 1 : 2).join(' ').trim();
  if (!(tags.isBroadcaster || tags.isModUp || isBotOwner(me))) return;

  if (!sub) {
    // Kick chat drops anything in angle brackets, so placeholders are spelled out.
    void say(`@${me} 🎡 !wheel (list) · !wheel spin (or !spin) · !wheel add Item | Another item · !wheel remove Item (or its number)`);
    return;
  }

  if (sub === 'list') {
    const w = readWheel(chan);
    if (!w.items.length) return void say(`@${me} 🎡 The wheel is empty. Add items with !wheel add Item | Another item.`);
    let text = `🎡 Wheel (${w.items.length}):`;
    for (const [i, it] of w.items.entries()) {
      const next = ` ${i + 1}. ${it.label}${i < w.items.length - 1 ? ' ·' : ''}`;
      if (text.length + next.length > CHAT_MAX) { text += ' …'; break; }
      text += next;
    }
    return void say(text);
  }

  if (sub === 'add') {
    const labels = rest.split('|').map(s => s.trim()).filter(Boolean);
    if (!labels.length) return void say(`@${me} usage: !wheel add Item | Another item`);
    let added: string[] = [];
    let skipped: string[] = [];
    const out = await changeWheel(chan, w => {
      const r = addItems(w, labels);
      added = r.added;
      skipped = r.skipped;
      return added.length ? r.wheel : 'nothing new';
    }).catch(err => (console.error(`[WHEEL] Add in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`), null));
    if (out === null) return void say(`@${me} couldn't change the wheel just now, try again.`);
    const total = typeof out === 'string' ? readWheel(chan).items.length : out.items.length;
    const parts = [
      added.length ? `added ${added.map(a => `"${a}"`).join(', ')}` : '',
      skipped.length ? `skipped ${skipped.map(a => `"${a}"`).join(', ')} (already on it, or the wheel is full)` : ''
    ].filter(Boolean);
    console.log(`[WHEEL] ${me} added ${added.length} item(s) in ${chan}`);
    return void say(`@${me} 🎡 ${parts.join('; ')}. ${total} on the wheel.`);
  }

  if (sub === 'remove') {
    if (!rest) return void say(`@${me} usage: !wheel remove Item (or its number)`);
    let removed: string | null = null;
    const out = await changeWheel(chan, w => {
      const r = removeItem(w, rest);
      removed = r.removed;
      return removed ? r.wheel : 'not found';
    }).catch(err => (console.error(`[WHEEL] Remove in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`), null));
    if (out === null) return void say(`@${me} couldn't change the wheel just now, try again.`);
    if (typeof out === 'string') return void say(`@${me} 🎡 "${rest}" isn't on the wheel. !wheel lists them.`);
    console.log(`[WHEEL] ${me} removed "${removed}" in ${chan}`);
    return void say(`@${me} 🎡 removed "${removed}". ${out.items.length} on the wheel.`);
  }

  // ── spin ──
  if (wheelBusy(chan)) return void say(`@${me} 🎡 the wheel is already spinning!`);
  if (waitingSpin.has(chan)) return void say(`@${me} 🎡 a spin is already waiting for the big bite to finish.`);
  const w = readWheel(chan);
  if (w.items.length < 2) return void say(`@${me} 🎡 the wheel needs at least 2 items to spin (it has ${w.items.length}). Add some with !wheel add Item | Another item.`);
  if (w.onVideoOverlay ? !videoOverlayShowing(db) : !overlayShowing(db)) {
    return void say(`@${me} 🎡 open the ${w.onVideoOverlay ? 'video' : 'fishing'} overlay first: the wheel spins there.`);
  }

  // A big bite's code is on the fishing overlay against a clock: a spin there waits for it.
  if (!w.onVideoOverlay && channelHasBite(chan)) {
    waitingSpin.add(chan);
    void say(`@${me} 🎡 a big bite is on the line: the wheel spins as soon as it's over.`);
    const deadline = Date.now() + BITE_WAIT_MS;
    while (channelHasBite(chan) && Date.now() < deadline) await new Promise(r => setTimeout(r, 1000));
    waitingSpin.delete(chan);
    if (channelHasBite(chan)) return void say(`@${me} 🎡 the big bite is still going: spin again once it's done.`);
    if (wheelBusy(chan)) return;
  }
  spin(chan, me, readWheel(chan), db, say, svc.config().games.streamDelaySeconds * 1000);
};

/** Put a spin on the overlay now, and the result in chat once the stream has shown it. */
function spin(chan: string, by: string, w: Wheel, db: Parameters<typeof pushOverlay>[0], say: (t: string) => unknown, delayMs = 0): void {
  if (w.items.length < 2) return void say(`@${by} 🎡 the wheel needs at least 2 items to spin.`);
  const now = Date.now();
  const spinMs = w.spinSeconds * 1000;
  const winner = pickWinner(w.items.length);
  const landed = w.items[winner];
  // Busy through the spin, the result on screen, and the stream's delay behind chat:
  // the channel's own (games.streamDelaySeconds, plus a poll of the overlay) where it's longer.
  const behindMs = Math.max(STREAM_GRACE_MS, delayMs + OVERLAY_POLL_MS);
  markWheelBusy(chan, now + spinMs + RESULT_HOLD_MS + behindMs);
  console.log(`[WHEEL] ${by} spun the wheel in ${chan}: "${landed.label}" (${winner + 1} of ${w.items.length})${w.onVideoOverlay ? ' on the video overlay' : ''}`);
  // On the video overlay a playing video pauses for the spin and the result: its slot stretches by as much.
  if (w.onVideoOverlay) extendVideo(db, spinMs + RESULT_HOLD_MS + OVERLAY_POLL_MS);
  pushOverlay(db, { username: by, kind: 'wheel', text: `${by} spun the wheel!`, wheel: { items: w.items, winner, spinMs } }, now);
  const t = setTimeout(() => {
    void say(`🎡 The wheel landed on: ${landed.label}!`);
    if (!w.removeWinner) return;
    void changeWheel(chan, cur => {
      const r = removeItem(cur, landed.label);
      return r.removed ? r.wheel : 'gone already';
    }).catch(err => console.error(`[WHEEL] Removing the winner in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`));
  }, spinMs + behindMs);
  t.unref?.();
}
