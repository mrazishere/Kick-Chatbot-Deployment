/**
 * Remind command
 *
 * Description: Leave a viewer a message for the next time they chat here, or
 *              set a reminder that is posted at a set time. Stored per channel,
 *              so reminders survive restarts.
 *
 * Permission required: all users (1 per 10s each, 5 pending at a time)
 *
 * Usage:   !remind @user <message>          - delivered when they next chat
 *          !remind @user in 2h <message>    - posted in 2 hours, pinging them
 *          !remind me in 30m <message>      - a reminder for yourself
 *          !remind in 1h30m <message>       - the same
 *          !remind list                     - your pending reminders
 *          !unremind <id>                   - cancel one of yours
 *
 * Timed reminders are posted by a timer that starts with the first chat message
 * the bot handles after a start, since that is when a command gets its chat
 * client. One that fell due while the bot was down is posted late, marked so.
 */

import { ClientWrapper, CommandFn } from '../types';
import { isBotSender } from '../bot-identity';
import {
  addReminder, cancelReminder, CommunityDb, dueReminders, finishReminder, openCommunityDb, pendingFrom, pendingOnChat, Reminder
} from '../community/store';
import { makeCooldown, parseDuration, parseUsername, span } from '../community/format';

const MAX_PENDING = 5;
const MAX_TEXT = 200;
const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 365 * 24 * 3_600_000;
/** Delivered per chat message, so a pile of reminders doesn't flood chat at once. */
const DELIVER_PER_MESSAGE = 2;
const TICK_MS = 15_000;
/** A timed reminder this late was missed while the bot was down. */
const LATE_MS = 2 * 60_000;

const cooldown = makeCooldown(10_000);

function ago(r: Reminder, now: number): string {
  return `${span(now - r.created_at)} ago`;
}

function onChatText(r: Reminder, now: number): string {
  return `@${r.to_user} reminder from ${r.from_user} (${ago(r, now)}): ${r.text}`;
}

function timedText(r: Reminder, now: number): string {
  const late = r.due_at !== null && now - r.due_at > LATE_MS ? ` (late by ${span(now - r.due_at)})` : '';
  const from = r.from_user.toLowerCase() === r.to_lc ? 'reminder' : `reminder from ${r.from_user}`;
  return `@${r.to_user} ${from}${late}: ${r.text}`;
}

// ─── Timed delivery ─────────────────────────────────────────────────────────

/** Per channel: where to post. One bot process serves one channel, but keep it keyed. */
const sinks = new Map<string, { client: ClientWrapper; channel: string; timer: NodeJS.Timeout }>();

function ensureTimer(db: CommunityDb, client: ClientWrapper, channel: string): void {
  const existing = sinks.get(channel);
  if (existing) {
    existing.client = client;
    return;
  }
  const timer = setInterval(() => {
    const sink = sinks.get(channel);
    if (!sink) return;
    try {
      const now = Date.now();
      for (const r of dueReminders(db, now, 3)) {
        if (!finishReminder(db, r.id, now)) continue;
        console.log(`[REMIND] Posting timed reminder #${r.id} for ${r.to_user}`);
        void sink.client.say(sink.channel, timedText(r, now));
      }
    } catch (err) {
      console.error(`[REMIND] Timed delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, TICK_MS);
  timer.unref();
  sinks.set(channel, { client, channel, timer });
}

// ─── Command ────────────────────────────────────────────────────────────────

export const remind: CommandFn = async function remind(client, message, channel, tags, _config) {
  const db = openCommunityDb(channel);
  if (!db) return;
  ensureTimer(db, client, channel);

  const me = tags.username;
  const meLc = me.toLowerCase();
  const now = Date.now();
  const say = (text: string) => client.say(channel, text);

  // Deliver what was waiting for this viewer to chat, whatever they said.
  if (!isBotSender(me, tags.senderId)) {
    try {
      for (const r of pendingOnChat(db, meLc, DELIVER_PER_MESSAGE)) {
        if (!finishReminder(db, r.id, now)) continue;
        console.log(`[REMIND] Delivering reminder #${r.id} to ${me}`);
        await say(onChatText(r, now));
      }
    } catch (err) {
      console.error(`[REMIND] Delivery to ${me} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const words = message.trim().split(/\s+/);
  const cmd = words[0].toLowerCase();
  if (cmd !== '!remind' && cmd !== '!unremind') return;
  if (isBotSender(me, tags.senderId)) return;

  if (cmd === '!unremind') {
    const id = Number((words[1] ?? '').replace(/^#/, ''));
    if (!Number.isInteger(id) || id <= 0) return void say(`@${me} usage: !unremind id, e.g. !unremind 2 (see !remind list)`);
    return void say(cancelReminder(db, id, meLc, now) ? `@${me} cancelled reminder #${id}` : `@${me} you have no pending reminder #${id}`);
  }

  const args = words.slice(1);
  if ((args[0] ?? '').toLowerCase() === 'list') {
    const mine = pendingFrom(db, meLc);
    if (!mine.length) return void say(`@${me} you have no pending reminders`);
    // "#id" so the id isn't read as a count ("pending: 2 for you" looked like two reminders).
    const parts = mine.map(r => `#${r.id} for ${r.to_lc === meLc ? 'you' : r.to_user} ${r.due_at === null ? 'when they chat' : `in ${span(r.due_at - now)}`}`);
    return void say(`@${me} ${mine.length} pending: ${parts.join(' · ')}`);
  }

  const usage = `@${me} usage: !remind @user message · !remind @user in 2h message · !remind me in 30m message`;
  if (!args.length) return void say(usage);

  // Who: "@user", "user", "me", or nobody when the reminder starts with "in".
  let to = me;
  let rest = args;
  const first = args[0].toLowerCase();
  if (first === 'me') {
    rest = args.slice(1);
  } else if (first !== 'in') {
    const name = parseUsername(args[0]);
    if (!name) return void say(usage);
    to = name;
    rest = args.slice(1);
  }
  const toLc = to.toLowerCase();
  if (isBotSender(to)) return void say(`@${me} I can't remind myself`);

  // When: "in <duration>", or nothing for the next time they chat.
  let dueAt: number | null = null;
  if ((rest[0] ?? '').toLowerCase() === 'in') {
    const d = parseDuration(rest.slice(1));
    if (!d) return void say(`@${me} I couldn't read that time, try e.g. in 2h or in 1h30m`);
    if (d.ms < MIN_DELAY_MS) return void say(`@${me} the shortest reminder is 1 minute`);
    if (d.ms > MAX_DELAY_MS) return void say(`@${me} the longest reminder is 365 days`);
    dueAt = now + d.ms;
    rest = rest.slice(1 + d.used);
  }

  const text = rest.join(' ').trim();
  if (!text) return void say(usage);
  if (text.length > MAX_TEXT) return void say(`@${me} keep it under ${MAX_TEXT} characters`);
  if (dueAt === null && toLc === meLc) return void say(`@${me} add a time for your own reminder, e.g. !remind me in 1h ${text.slice(0, 20)}`);

  if (cooldown(meLc)) return;
  if (pendingFrom(db, meLc).length >= MAX_PENDING) {
    return void say(`@${me} you already have ${MAX_PENDING} pending reminders, cancel one with !unremind id`);
  }

  const id = addReminder(db, { from: me, to, text, now, dueAt });
  console.log(`[REMIND] ${me} set reminder #${id} for ${to}${dueAt === null ? ' on next chat' : ` due ${new Date(dueAt).toISOString()}`}`);
  const who = toLc === meLc ? 'you' : to;
  return void say(dueAt === null
    ? `@${me} I'll remind ${who} when they next chat (reminder #${id})`
    : `@${me} I'll remind ${who} in ${span(dueAt - now)} (reminder #${id})`);
};
