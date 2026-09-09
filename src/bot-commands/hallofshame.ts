/**
 * AI Hall of Shame command
 *
 * Description: Fun leaderboard of !claude usage — who gets roasted hardest by
 *              the bot and who asks the dumbest questions. Data is captured by
 *              the !claude handler and scored (dumb/trolled 0-10) by a lazy,
 *              async LLM pass in ../leaderboard-store.
 *
 * Permission required:
 *          !hallofshame: all users (view)
 *          !hallofshame reset: moderators and above
 *
 * Usage:   !hallofshame            - overview (most roasted, dumbest, most addicted)
 *          !hallofshame trolled     - top 5 by avg savagery + hardest roast ever
 *          !hallofshame dumb        - top 5 by avg dumbness + dumbest question ever
 *          !hallofshame yap         - top 5 by sheer volume (Certified Yappers)
 *          !hallofshame me          - your own shame stats
 *          !hallofshame @user       - another user's shame stats
 *          !hallofshame reset       - wipe the board (mods only)
 *
 * Aliases: !shame
 */

import { CommandFn } from '../types';
import {
  readState,
  resetChannel,
  scoreBacklog,
  hasPending,
  topTrolled,
  topDumb,
  topAskers,
  hardestRoast,
  dumbestQuestion,
  avgTrolled,
  avgDumb,
  ShameState,
  Ranked
} from '../leaderboard-store';

const TRIGGERS = ['!hallofshame', '!shame'];

// Light per-channel cooldown so the board can't be spammed (mods bypass).
const COOLDOWN_MS = 15000;
const lastUse = new Map<string, number>();

/**
 * Strip a string down to Kick's message rules: at most 10 non-alphanumeric,
 * non-space, non-@ characters (extras dropped), and a hard length cap. Mirrors
 * the sanitizer in claude.ts so leaderboard messages are not rejected by Kick.
 */
function sanitizeForKick(text: string): string {
  let s = text.replace(/([!?.,:;])\1+/g, '$1').replace(/["']/g, '');
  const MAX_SPECIAL = 10;
  let special = 0;
  let out = '';
  for (const ch of Array.from(s)) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const ok =
      (cp >= 48 && cp <= 57) ||
      (cp >= 65 && cp <= 90) ||
      (cp >= 97 && cp <= 122) ||
      cp === 32 ||
      cp === 64;
    if (!ok) {
      if (special < MAX_SPECIAL) {
        out += ch;
        special++;
      }
    } else {
      out += ch;
    }
  }
  if (out.length > 490) out = out.substring(0, 487) + '...';
  return out;
}

/** "1 alice 2 bob 3 carol" from a ranked list. */
function rankLine(rows: Ranked[]): string {
  return rows.map((r, i) => `${i + 1} ${r.user}`).join(' ');
}

/** One-decimal average, e.g. 5.8 (single special char). */
function avg1(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/**
 * Trim a captured quote to fit a chat line AND strip all punctuation, so the
 * quote contributes zero special chars — that protects the score decimals in
 * the rank line from being dropped by Kick's 10-special-char cap.
 */
function quote(text: string, max = 120): string {
  const cleaned = (text || '').replace(/[^A-Za-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
}

const EMPTY_BOARD = 'not enough data yet. Users need at least 3 !claude questions to rank';

function renderOverview(state: ShameState): string {
  const roasted = topTrolled(state, 3);
  const clowns = topDumb(state, 3);
  const parts: string[] = ['AI Hall of Shame quality ranked'];
  if (roasted.length) parts.push(`Most Roasted 1 ${roasted[0].user} avg ${avg1(roasted[0].avg)} then ${roasted.slice(1).map(r => r.user).join(' ')}`.trim());
  if (clowns.length) parts.push(`Biggest Clowns 1 ${clowns[0].user} avg ${avg1(clowns[0].avg)} then ${clowns.slice(1).map(r => r.user).join(' ')}`.trim());
  const askers = topAskers(state, 1);
  if (askers.length) parts.push(`Certified Yapper ${askers[0].user} ${askers[0].stats.count} asks`);
  if (!roasted.length && !clowns.length) return `AI Hall of Shame ${EMPTY_BOARD}`;
  parts.push('try shame trolled dumb yap or me');
  return parts.join(' - ');
}

function renderAsks(state: ShameState): string {
  const rows = topAskers(state, 5);
  if (!rows.length) return 'No Certified Yappers yet. Chat is normal for once';
  const line = rows.map((r, i) => `${i + 1} ${r.user} ${r.stats.count}`).join(' ');
  return `Certified Yappers most times pestering the AI - ${line} - touch grass`;
}

function renderTrolled(state: ShameState): string {
  const rows = topTrolled(state, 5);
  if (!rows.length) return `Most Roasted board ${EMPTY_BOARD}`;
  const line = rows.map((r, i) => `${i + 1} ${r.user} ${avg1(r.avg)}`).join(' ');
  const hof = hardestRoast(state);
  const q = hof && hof.stats.topTrolledResponse
    ? ` - HALL OF FAME roast on ${hof.user} ${quote(hof.stats.topTrolledResponse)}`
    : '';
  return `Most Roasted by avg savagery per Q - ${line}${q}`;
}

function renderDumb(state: ShameState): string {
  const rows = topDumb(state, 5);
  if (!rows.length) return `Biggest Clowns board ${EMPTY_BOARD}`;
  const line = rows.map((r, i) => `${i + 1} ${r.user} ${avg1(r.avg)}`).join(' ');
  const hof = dumbestQuestion(state);
  const q = hof && hof.stats.topDumbPrompt
    ? ` - DUMBEST QUESTION EVER by ${hof.user} ${quote(hof.stats.topDumbPrompt)}`
    : '';
  return `Biggest Clowns by avg dumbness per Q - ${line}${q}`;
}

function renderUser(state: ShameState, user: string, isSelf: boolean): string {
  const u = state.users[user];
  if (!u || u.count === 0) {
    return isSelf
      ? `${user} you have no shame on record yet. Use !claude and earn your spot`
      : `${user} has no shame on record. Either innocent or too scared to use !claude`;
  }
  const bits = [
    isSelf ? `${user} your AI Wrapped` : `${user} AI rap sheet`,
    `${u.count} questions`,
    `avg savagery ${avg1(avgTrolled(u))}`,
    `avg clown ${avg1(avgDumb(u))}`
  ];
  if (u.count < 3) bits.push('needs 3+ to rank on the boards');
  if (u.topTrolledPrompt) bits.push(`hardest roasted for asking ${quote(u.topTrolledPrompt, 70)}`);
  return bits.join(' - ');
}

/**
 * Extract a bare/@-prefixed Kick username from a token, or null. Tolerant of
 * trailing punctuation and extra text (e.g. "@Name," or "@Name lol") — takes
 * the first username-like run after an optional leading @.
 */
function parseTarget(raw: string): string | null {
  const m = (raw || '').match(/^@?([a-zA-Z0-9_]{1,25})/);
  return m ? m[1] : null;
}

/** Case-insensitive lookup of a stored user key. */
function resolveUser(state: ShameState, target: string): string | null {
  const t = target.toLowerCase();
  for (const key of Object.keys(state.users)) {
    if (key.toLowerCase() === t) return key;
  }
  return null;
}

export const hallofshame: CommandFn = async function hallofshame(client, message, channel, tags, _config) {
  const input = message.trim().split(/\s+/);
  const cmd = (input[0] || '').toLowerCase();
  if (!TRIGGERS.includes(cmd)) return;

  const rawSub = input[1] || '';
  const sub = rawSub.toLowerCase();
  const isModUp = tags.isModUp || tags.isBroadcaster || tags.username === process.env.KICK_OWNER;

  // Reset (mods only)
  if (sub === 'reset') {
    if (!isModUp) {
      client.say(channel, `@${tags.username}, !hallofshame reset is for Moderators & above.`);
      return;
    }
    resetChannel(channel);
    client.say(channel, `@${tags.username}, AI Hall of Shame wiped clean. Fresh clowns incoming.`);
    return;
  }

  // Cooldown (mods bypass)
  if (!isModUp) {
    const last = lastUse.get(channel) || 0;
    if (Date.now() - last < COOLDOWN_MS) return;
    lastUse.set(channel, Date.now());
  }

  const state = readState(channel);

  // Kick off lazy async scoring of any new events; serve current data now.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    void scoreBacklog(channel, apiKey).catch(() => { /* best-effort */ });
  }

  if (Object.keys(state.users).length === 0) {
    const msg = hasPending(channel)
      ? 'AI Hall of Shame is still tallying the clowns. Run it again in a moment.'
      : 'AI Hall of Shame is empty. Use !claude to start earning shame.';
    client.say(channel, sanitizeForKick(`@${tags.username}, ${msg}`));
    return;
  }

  let body: string;
  if (sub === 'me') body = renderUser(state, tags.username, true);
  else if (sub.startsWith('troll') || sub === 'roasted') body = renderTrolled(state);
  else if (sub.startsWith('dumb') || sub.startsWith('clown')) body = renderDumb(state);
  else if (sub.startsWith('yap') || sub.startsWith('ask') || sub === 'active' || sub === 'addicted' || sub === 'curious') body = renderAsks(state);
  else if (rawSub.startsWith('@') || (rawSub && parseTarget(rawSub))) {
    // Look up another user's stats: !hallofshame @someone  (or bare username)
    const target = parseTarget(rawSub);
    if (!target) {
      body = renderOverview(state);
    } else {
      const key = resolveUser(state, target);
      const isSelf = !!key && key.toLowerCase() === tags.username.toLowerCase();
      body = key
        ? renderUser(state, key, isSelf)
        : `${target} has no shame on record. Either innocent or too scared to use !claude`;
    }
  } else body = renderOverview(state);

  client.say(channel, sanitizeForKick(`@${tags.username}, ${body}`));
};
