/**
 * Countdown timer command
 *
 * Description: Allows streamers to start named countdown timers in chat with an optional counter.
 *
 * Permission required: VIPs and above
 *
 * Usage:
 *   !countd list                      — List active countdowns
 *   !countd add [title] [n]s/m/h      — Start a countdown (e.g. !countd add race 5m)
 *   !countd edit [title] [n]s/m/h     — Change remaining time on an active countdown
 *   !countd delete [title]            — Remove a countdown
 *   !countd + [title]                 — Increment the counter attached to a countdown
 *   !countd - [title]                 — Decrement the counter attached to a countdown
 */

import * as fs from 'fs';
import * as path from 'path';
import { CommandFn } from '../types';

const COUNTDOWN_FILE = path.join(__dirname, '../../data/countd.json');

interface CountdownRecord {
  channel: string;
  title: string;
  duration: number;
  startTime: number;
  counter: number;
}

interface CountdownInMemory extends CountdownRecord {
  interval: NodeJS.Timeout;
}

type CountdownMap = Record<string, CountdownInMemory>;
type CountdownFileMap = Record<string, CountdownRecord>;

function readCountdownsFromFile(): CountdownFileMap {
  try {
    const data = fs.readFileSync(COUNTDOWN_FILE, 'utf8');
    const parsed: unknown = JSON.parse(data);
    if (typeof parsed !== 'object' || parsed === null) return {};

    const sanitized: CountdownFileMap = {};
    for (const [id, cd] of Object.entries(parsed as Record<string, unknown>)) {
      const c = cd as CountdownRecord;
      if (
        c && typeof c === 'object' &&
        typeof c.channel === 'string' &&
        typeof c.title === 'string' &&
        typeof c.duration === 'number' &&
        typeof c.startTime === 'number' &&
        typeof c.counter === 'number'
      ) {
        const title = sanitizeTitle(c.title);
        if (title) {
          sanitized[id] = { channel: c.channel, title, duration: c.duration, startTime: c.startTime, counter: c.counter };
        }
      }
    }
    return sanitized;
  } catch {
    return {};
  }
}

function writeCountdownsToFile(countdowns: CountdownMap): void {
  try {
    const out: CountdownFileMap = {};
    for (const id in countdowns) {
      const { channel, title, duration, startTime, counter } = countdowns[id];
      out[id] = { channel, title, duration, startTime, counter };
    }
    fs.writeFileSync(COUNTDOWN_FILE, JSON.stringify(out, null, 2), 'utf8');
  } catch (err) {
    if (err instanceof Error) console.error('[COUNTD] Write failed:', err.message);
  }
}

function sanitizeTitle(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let t = raw.replace(/<[^>]*>/g, '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (t.length > 50) t = t.substring(0, 50);
  return t.length > 0 ? t : null;
}

function validateDuration(n: number, unit: string): boolean {
  if (isNaN(n) || n <= 0) return false;
  if (unit !== 's' && unit !== 'm' && unit !== 'h') return false;
  const secs = unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n;
  return secs <= 86400;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// In-memory state — module-level so countdowns survive command calls
const countdowns: CountdownMap = {};
let idCounter = 1;

// Re-hydrate from file at startup (intervals not restored — only persisted for crash inspection)
(function init() {
  const saved = readCountdownsFromFile();
  // We intentionally do NOT restart intervals on load; stale countdowns are
  // silently dropped. The file is only written so state survives a clean restart
  // when the bot owner wants to inspect what was running.
  void saved;
})();

export const countd: CommandFn = async function countd(client, message, channel, tags) {
  const input = message.trim().split(/\s+/);
  if (input[0] !== '!countd') return;

  const sub = input[1];

  if (sub === 'list') {
    const active = Object.values(countdowns).filter(c => c.channel === channel);
    if (active.length === 0) {
      client.say(channel, 'No active countdowns.');
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const info = active.map(c => {
      const remaining = Math.max(c.duration - (now - c.startTime), 0);
      return `[${c.title}/${formatTime(remaining)}] (Counter: ${c.counter})`;
    }).join(' ');
    client.say(channel, `Active countdowns: ${info}`);
    return;
  }

  if (!tags.isVIPUp) {
    client.say(channel, `@${tags.username}, !countd commands are for VIPs & above.`);
    return;
  }

  const params = input.slice(2).join(' ');

  if (sub === 'add') {
    const channelCount = Object.values(countdowns).filter(c => c.channel === channel).length;
    if (channelCount >= 5) {
      client.say(channel, `@${tags.username}, maximum of 5 active countdowns per channel.`);
      return;
    }

    const { title, durationStr } = parseParams(params);
    if (!title || !durationStr) {
      client.say(channel, `@${tags.username}, usage: !countd add [title] [n]s/m/h`);
      return;
    }

    const unit = durationStr.slice(-1);
    const n = parseInt(durationStr.slice(0, -1), 10);
    if (!validateDuration(n, unit)) {
      client.say(channel, `@${tags.username}, invalid duration. Use s/m/h (max 24h).`);
      return;
    }

    if (Object.values(countdowns).some(c => c.title === title && c.channel === channel)) {
      client.say(channel, `@${tags.username}, a countdown named "${title}" is already active.`);
      return;
    }

    let cd = unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n;
    const countdownID = idCounter++;
    const startTime = Math.floor(Date.now() / 1000);

    client.say(channel, `Countdown "${title}" ending in ${formatTime(cd)}...`);

    const milestones = [5, 4, 3, 2, 1];
    let mIdx = 0;

    const iv = setInterval(() => {
      if (cd >= 600 && cd % 600 === 0) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
      } else if (cd === 300) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
      } else if (mIdx < milestones.length && cd <= milestones[mIdx]) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
        mIdx++;
      }

      cd -= 1;

      if (cd === 0) {
        clearInterval(iv);
        client.say(channel, `Countdown "${title}" - Time's Up!`);
        delete countdowns[countdownID];
        writeCountdownsToFile(countdowns);
      }
    }, 1000);

    countdowns[countdownID] = { channel, title, duration: cd, startTime, interval: iv, counter: 0 };
    writeCountdownsToFile(countdowns);
    return;
  }

  if (sub === 'edit') {
    const { title, durationStr } = parseParams(params);
    if (!title || !durationStr) {
      client.say(channel, `@${tags.username}, usage: !countd edit [title] [n]s/m/h`);
      return;
    }

    const unit = durationStr.slice(-1);
    const n = parseInt(durationStr.slice(0, -1), 10);
    if (!validateDuration(n, unit)) {
      client.say(channel, `@${tags.username}, invalid duration. Use s/m/h (max 24h).`);
      return;
    }

    const id = Object.keys(countdowns).find(k => countdowns[k].title === title && countdowns[k].channel === channel);
    if (!id) {
      client.say(channel, `@${tags.username}, countdown "${title}" not found.`);
      return;
    }

    clearInterval(countdowns[id].interval);

    let cd = unit === 'm' ? n * 60 : unit === 'h' ? n * 3600 : n;
    const startTime = Math.floor(Date.now() / 1000);
    const prevCounter = countdowns[id].counter;

    client.say(channel, `Countdown "${title}" edited to ${formatTime(cd)}...`);

    const milestones = [60, 30, 5, 4, 3, 2, 1];
    let mIdx = 0;

    const iv = setInterval(() => {
      if (cd >= 600 && cd % 600 === 0) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
      } else if (cd === 300) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
      } else if (mIdx < milestones.length && cd <= milestones[mIdx]) {
        client.say(channel, `Countdown "${title}" - ${formatTime(cd)} remaining...`);
        mIdx++;
      }

      cd -= 1;

      if (cd === 0) {
        clearInterval(iv);
        client.say(channel, `Countdown "${title}" - Time's Up!`);
        delete countdowns[id];
        writeCountdownsToFile(countdowns);
      }
    }, 1000);

    countdowns[id] = { channel, title, duration: cd, startTime, interval: iv, counter: prevCounter };
    writeCountdownsToFile(countdowns);
    return;
  }

  if (sub === 'delete') {
    const title = sanitizeTitle(params);
    if (!title) {
      client.say(channel, `@${tags.username}, usage: !countd delete [title]`);
      return;
    }
    const id = Object.keys(countdowns).find(k => countdowns[k].title === title && countdowns[k].channel === channel);
    if (!id) {
      client.say(channel, `@${tags.username}, countdown "${title}" not found.`);
      return;
    }
    clearInterval(countdowns[id].interval);
    delete countdowns[id];
    writeCountdownsToFile(countdowns);
    client.say(channel, `Countdown "${title}" removed.`);
    return;
  }

  if (sub === '+' || sub === '-') {
    const title = sanitizeTitle(params);
    if (!title) {
      client.say(channel, `@${tags.username}, usage: !countd ${sub} [title]`);
      return;
    }
    const id = Object.keys(countdowns).find(k => countdowns[k].title === title && countdowns[k].channel === channel);
    if (!id) {
      client.say(channel, `@${tags.username}, countdown "${title}" not found.`);
      return;
    }
    countdowns[id].counter += sub === '+' ? 1 : -1;
    writeCountdownsToFile(countdowns);
    return;
  }

  client.say(channel, `@${tags.username}, invalid usage. Try !countd list | add | edit | delete | + | -`);
};

function parseParams(params: string): { title: string | null; durationStr: string | null } {
  let rawTitle: string | undefined;
  let durationStr: string | undefined;

  if (params.startsWith('"')) {
    const close = params.indexOf('"', 1);
    if (close !== -1) {
      rawTitle = params.substring(1, close);
      durationStr = params.substring(close + 1).trim().split(' ')[0];
    } else {
      const parts = params.split(' ');
      rawTitle = parts.shift();
      durationStr = parts.shift();
    }
  } else {
    const parts = params.split(' ');
    rawTitle = parts.shift();
    durationStr = parts.shift();
  }

  const title = rawTitle ? sanitizeTitle(rawTitle) : null;
  return { title, durationStr: durationStr ?? null };
}
