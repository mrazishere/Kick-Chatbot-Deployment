import fetch, { type RequestInit, type Response } from 'node-fetch';

// Telegram alerts for things that break quietly: one when a problem starts (once per key
// across every Kick process, again after 6 hours if it lasts), one when it's over.
// Callers report as things happen; this keeps the bookkeeping. Never throws, and never
// reaches Telegram from a selftest.

type Notifier = {
  notifyProblem(key: string, title: string, detail: string, cooldownMs?: number): Promise<boolean>;
  notifyResolved(key: string, title: string, detail: string): Promise<boolean>;
};

let notifier: Notifier | null | undefined;
function telegram(): Notifier | null {
  if (notifier !== undefined) return notifier;
  if (process.env.POINTS_SELFTEST === '1' || process.env.NO_TELEGRAM === '1') return (notifier = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const TelegramNotifier = require('./telegram-notifier') as new () => Notifier;
    return (notifier = new TelegramNotifier());
  } catch {
    return (notifier = null);
  }
}

/** Keys this process has raised and not cleared, and when it last tried clearing each other key. */
const raised = new Set<string>();
const clearTried = new Map<string, number>();
/** A key raised by another process is cleared at most this often from here, so a hot path stays cheap. */
const CLEAR_GAP_MS = 60_000;

/** A problem has started (or is still going): alert unless one was sent for it lately. */
export function raiseAlert(key: string, title: string, detail: string): void {
  raised.add(key);
  const t = telegram();
  if (t) void t.notifyProblem(key, title, detail).catch(() => false);
}

/** It works again: if an alert was out for it, say so (once, from whichever process clears it). */
export function clearAlert(key: string, title: string, detail: string): void {
  const now = Date.now();
  if (!raised.has(key) && now - (clearTried.get(key) ?? 0) < CLEAR_GAP_MS) return;
  raised.delete(key);
  clearTried.set(key, now);
  const t = telegram();
  if (t) void t.notifyResolved(key, title, detail).catch(() => false);
}

// ─── Anthropic ───────────────────────────────────────────────────────────────

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const AI_KEY = 'anthropic-down';

/**
 * fetch() to Anthropic's messages API, reporting the answer: a refused key, no credit left or
 * a model that's gone (every AI command fails until someone acts) alerts; the next success
 * closes it. Busy or 5xx answers are left to the callers' retries.
 */
export async function anthropicFetch(init: RequestInit): Promise<Response> {
  const res = await fetch(ANTHROPIC_URL, init);
  void noteAnthropic(res.clone());
  return res;
}

async function noteAnthropic(res: Response): Promise<void> {
  try {
    if (res.ok) {
      clearAlert(AI_KEY, 'Anthropic API Working Again', '!claude, chat summaries and fishing stories answer again.');
      return;
    }
    const body = await res.text().catch(() => '');
    const why =
      res.status === 401 ? 'The API key was refused (401): it may have been revoked or rotated.'
      : res.status === 403 ? 'The API key isn\'t allowed to do this (403).'
      : res.status === 400 && /credit|billing|balance/i.test(body) ? 'The account is out of credit.'
      : res.status === 404 && /model/i.test(body) ? 'The model the bot asks for is gone (404): it needs updating to a current one.'
      : null;
    if (!why) return;
    raiseAlert(AI_KEY, 'Anthropic API Failing', `${why}\n\nUntil it's fixed, !claude, chat summaries, AI fishing stories and !fx don't answer.\n\n${body.slice(0, 300)}`);
  } catch { /* alerting never breaks the caller */ }
}

// ─── Chat sends ──────────────────────────────────────────────────────────────

/** Failed in a row, and for at least this long, before it counts: one Kick hiccup isn't worth a page. */
const SEND_FAILS = 3;
const SEND_FAIL_SPAN_MS = 60_000;
const sendFails = new Map<string, { count: number; since: number; last: string }>();

/** A channel bot's chat send, as it went: the bot can't talk in chat once Kick keeps refusing. */
export function noteChatSend(channel: string, ok: boolean, why = ''): void {
  const key = `chat-send:${channel}`;
  if (ok) {
    if (sendFails.delete(channel) || raised.has(key)) clearAlert(key, 'Bot Talking Again', `The bot in ${channel} can post in chat again.`);
    return;
  }
  const now = Date.now();
  const f = sendFails.get(channel) ?? { count: 0, since: now, last: '' };
  f.count++;
  f.last = why;
  sendFails.set(channel, f);
  if (f.count >= SEND_FAILS && now - f.since >= SEND_FAIL_SPAN_MS) {
    raiseAlert(key, 'Bot Can\'t Post In Chat', `The bot in ${channel} has failed to post its last ${f.count} messages (for ${Math.round((now - f.since) / 60_000)} min). Chat sees nothing from it: commands, games, replies.\n\nKick said: ${why || 'no reason given'}`);
  }
}

// ─── Command errors ──────────────────────────────────────────────────────────

/** This many command errors in COMMAND_WINDOW_MS is a broken command, not a stray failure. */
const COMMAND_ERRORS = 5;
const COMMAND_WINDOW_MS = 10 * 60_000;
/** Quiet this long and it's over. */
const COMMAND_QUIET_MS = 30 * 60_000;
const commandErrors = new Map<string, { at: number[]; last: Map<string, string>; quiet?: ReturnType<typeof setTimeout> }>();

/** A chat command threw: chatters get no reply. Bursts alert, with which commands and why. */
export function noteCommandError(channel: string, command: string, message: string): void {
  const key = `command-errors:${channel}`;
  const now = Date.now();
  const e = commandErrors.get(channel) ?? { at: [], last: new Map<string, string>() };
  commandErrors.set(channel, e);
  e.at = [...e.at.filter(t => now - t < COMMAND_WINDOW_MS), now];
  e.last.set(command, message.slice(0, 200));
  if (e.quiet) clearTimeout(e.quiet);
  e.quiet = setTimeout(() => {
    commandErrors.delete(channel);
    clearAlert(key, 'Commands Working Again', `No command has failed in ${channel} for ${COMMAND_QUIET_MS / 60_000} min.`);
  }, COMMAND_QUIET_MS);
  e.quiet.unref?.();
  if (e.at.length >= COMMAND_ERRORS) {
    const which = [...e.last].map(([c, m]) => `${c}: ${m}`).join('\n');
    raiseAlert(key, 'Commands Failing', `${e.at.length} command errors in ${channel} in the last ${COMMAND_WINDOW_MS / 60_000} min, so chatters using them get no reply:\n\n${which}`.slice(0, 1500));
  }
}

/** A command module failed to load: it's off until the bot restarts with it fixed. */
export function noteCommandLoadFailed(channel: string, command: string, message: string): void {
  raiseAlert(`command-load:${channel}:${command}`, 'Command Disabled', `The ${command} command didn't load in ${channel}'s bot, so it's off until the module is fixed and the bot restarted:\n\n${message.slice(0, 400)}`);
}
