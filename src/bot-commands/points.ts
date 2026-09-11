/**
 * Loyalty points command. The trigger is the channel's currency command:
 * sukasblood's $DON answers to $don. It starts with $ where other
 * commands use !, so the command reads like the currency.
 *
 * Description: Balances, watch time, leaderboards, giving, and moderator adjustments.
 *
 * Permission required:
 *          $<cmd>, watchtime, top, leaderboard: all users
 *          $<cmd> give: all users, when giving is enabled
 *          $<cmd> add/remove/set: moderators and above
 *
 * Usage:   $don [@user]               - balance and rank
 *          $don watchtime [@user]     - watch time and rank
 *          $don top [watchtime]       - top 5
 *          $don leaderboard           - link to the public leaderboard
 *          $don give @user 100        - send points to someone
 *          $don add|remove|set @user 500
 *
 * A subcommand word wins over a username; write @top to look up a user called top.
 * Chat also writes $DON in sentences ("$DON to the moon"), so a name without @
 * that isn't a known viewer gets no reply.
 */

import { CommandFn } from '../types';
import { SYSTEM_BOTS } from '../system-bots';
import { isBotSender } from '../bot-identity';
import { effectiveCommand } from '../points/config';
import { reportDbError, runWrite } from '../points/db';
import { getPointsService } from '../points/service';
import { applyOnce, countRanked, creditTx, debitTx, ensureUserTx, findUserByName, getUser, isExcluded, rankBy, setTx, topBy, transfer } from '../points/store';

const SUBCOMMANDS = new Set(['watchtime', 'top', 'leaderboard', 'give', 'add', 'remove', 'set']);
const AMOUNT_RE = /^\d{1,9}$/;
const NAME_RE = /^@?[A-Za-z0-9_]{2,25}$/;

/**
 * Kick allows 10 ASCII symbols in a message sent with the bot's token, and the
 * bot's sanitiser drops any past that, which would mangle names like a_b.
 */
const MAX_SYMBOLS = 10;

function asciiSymbols(text: string): number {
  return (text.match(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g) ?? []).length;
}

const USER_COOLDOWN_MS = 10_000;
const CHANNEL_COOLDOWN_MS = 30_000;
const TOTAL_CACHE_MS = 60_000;

const cooldowns = new Map<string, number>();
const totals = new Map<string, { at: number; n: number }>();

/** Remaining cooldown in seconds, or 0 when free (and then starts it when `start`). */
function cooldownLeft(key: string, ms: number, start: boolean): number {
  const now = Date.now();
  const until = cooldowns.get(key) ?? 0;
  if (until > now) return Math.ceil((until - now) / 1000);
  if (start) cooldowns.set(key, now + ms);
  if (cooldowns.size > 5000) {
    for (const [k, v] of cooldowns) if (v <= now) cooldowns.delete(k);
  }
  return 0;
}

function watchLong(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

function watchShort(seconds: number): string {
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : `${Math.floor(seconds / 60)}m`;
}

export const points: CommandFn = async function points(client, message, channel, tags, config) {
  const words = message.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  if (!first.startsWith('$')) return;

  const channelName = (config.channelName || channel.replace(/^#/, '')).toLowerCase();
  const svc = getPointsService(channelName);
  if (!svc) return;
  const cfg = svc.config();
  if (!cfg.enabled) return;
  const cmd = effectiveCommand(cfg);
  if (first !== `$${cmd}`) return;

  const cur = cfg.currencyName;
  const me = tags.username;
  const meLc = me.toLowerCase();
  const say = (text: string) => client.say(channel, text);
  const args = words.slice(1);
  const sub = SUBCOMMANDS.has((args[0] ?? '').toLowerCase()) ? args[0].toLowerCase() : null;
  const isModUp = tags.isModUp || (!!process.env.KICK_OWNER && meLc === process.env.KICK_OWNER.toLowerCase());

  try {
    svc.flushPresence();
    const db = svc.db();
    if (!db) {
      console.error(`[POINTS] $${cmd} from ${me} ignored: database unavailable`);
      return;
    }
    const ex = svc.exclusions();
    const senderId = Number(tags.senderId);
    const self = Number.isInteger(senderId) && senderId > 0 ? getUser(db, senderId) : findUserByName(db, meLc);

    const total = (): number => {
      const hit = totals.get(channelName);
      if (hit && Date.now() - hit.at < TOTAL_CACHE_MS) return hit.n;
      const n = countRanked(db, ex);
      totals.set(channelName, { at: Date.now(), n });
      return n;
    };

    /**
     * "user amount". An @ always marks the name; otherwise the order decides, and
     * "amount user" is read only when the name isn't a number too, since Kick
     * usernames can be all digits.
     */
    const target = (rest: string[]): { name: string; amount: number } | null => {
      const [a, b] = rest;
      if (a === undefined || b === undefined) return null;
      const pick = (name: string, amount: string) =>
        NAME_RE.test(name) && AMOUNT_RE.test(amount) ? { name: name.replace(/^@+/, ''), amount: Number(amount) } : null;
      if (a.startsWith('@')) return pick(a, b);
      if (b.startsWith('@')) return pick(b, a);
      if (AMOUNT_RE.test(b)) return pick(a, b);
      return pick(b, a);
    };

    /**
     * Apply a balance change once per chat message. After a restart the same
     * message can come back from the webhook queue, already handled from the chat
     * socket; its Kick message id is the idempotency key. A replay stays silent.
     */
    const once = <T>(fn: () => T): { applied: boolean; result?: T } =>
      tags.messageId ? applyOnce(db, `chat:${tags.messageId}`, Date.now(), fn) : { applied: true, result: fn() };

    // ── balance ──
    if (sub === null) {
      const named = args[0];
      if (cooldownLeft(`${channelName}:${meLc}:balance`, USER_COOLDOWN_MS, true)) return;
      if (named && NAME_RE.test(named) && named.replace(/^@+/, '').toLowerCase() !== meLc) {
        const lc = named.replace(/^@+/, '').toLowerCase();
        const who = await svc.resolveUser(lc, false);
        const u = who ? getUser(db, who.userId) : undefined;
        // Only an @name that isn't found gets a reply: "$DON to the moon" isn't a lookup of "to".
        if (!u) return named.startsWith('@') ? void say(`${named.replace(/^@+/, '')} has no ${cur} yet`) : undefined;
        const rank = rankBy(db, u.user_id, 'balance', ex);
        return void say(rank === null ? `${u.username} has ${u.balance} ${cur}` : `${u.username} has ${u.balance} ${cur}, rank ${rank} of ${total()}`);
      }
      if (named && !NAME_RE.test(named)) return;
      if (!self) return void say(`@${me} has no ${cur} yet`);
      const rank = rankBy(db, self.user_id, 'balance', ex);
      return void say(rank === null ? `@${me} has ${self.balance} ${cur}` : `@${me} has ${self.balance} ${cur}, rank ${rank} of ${total()}`);
    }

    // ── watchtime ──
    if (sub === 'watchtime') {
      if (cooldownLeft(`${channelName}:${meLc}:watchtime`, USER_COOLDOWN_MS, true)) return;
      const named = args[1];
      let u = self;
      let label = `@${me}`;
      if (named && NAME_RE.test(named) && named.replace(/^@+/, '').toLowerCase() !== meLc) {
        const who = await svc.resolveUser(named, false);
        u = who ? getUser(db, who.userId) : undefined;
        label = u?.username ?? named.replace(/^@+/, '');
      }
      if (!u || u.watch_seconds <= 0) return void say(`${label} has no watch time yet`);
      const rank = rankBy(db, u.user_id, 'watch_seconds', ex);
      return void say(`${label} has watched ${watchLong(u.watch_seconds)}${rank === null ? '' : `, rank ${rank}`}`);
    }

    // ── top ──
    if (sub === 'top') {
      if (!isModUp && cooldownLeft(`${channelName}:top`, CHANNEL_COOLDOWN_MS, true)) return;
      const byWatch = /^watch/i.test(args[1] ?? '');
      const rows = topBy(db, byWatch ? 'watch_seconds' : 'balance', 5, ex);
      if (!rows.length) return void say(byWatch ? 'No watch time recorded yet' : `No ${cur} earned yet`);
      // "·" separates entries because Kick doesn't count it toward the symbol limit.
      // When names bring their own symbols, later entries are dropped rather than
      // letting the sanitiser strip characters out of a name.
      let text = byWatch ? 'Top watch time' : `Top ${cur}`;
      let used = asciiSymbols(text);
      for (const [i, u] of rows.entries()) {
        const entry = ` · ${i + 1} ${u.username} ${byWatch ? watchShort(u.watch_seconds) : u.balance}`;
        const cost = asciiSymbols(entry);
        if (i > 0 && used + cost > MAX_SYMBOLS) break;
        text += entry;
        used += cost;
      }
      return void say(text);
    }

    // ── leaderboard ──
    if (sub === 'leaderboard') {
      if (!cfg.publicLeaderboard) return;
      if (!isModUp && cooldownLeft(`${channelName}:leaderboard`, CHANNEL_COOLDOWN_MS, true)) return;
      const base = (process.env.BOT_DASHBOARD_URL || 'https://mr-ai.dev/kick').replace(/\/+$/, '');
      // No colon: the URL alone spends most of the 10-symbol allowance.
      return void say(`${cur} leaderboard ${base}/${channelName}/leaderboard`);
    }

    // ── give ──
    if (sub === 'give') {
      if (!cfg.give.enabled) {
        if (!cooldownLeft(`${channelName}:${meLc}:give-off`, USER_COOLDOWN_MS, true)) say(`@${me} giving ${cur} is turned off`);
        return;
      }
      if (isExcluded(ex, self?.user_id ?? null, meLc) || isBotSender(me, tags.senderId)) return;
      const t = target(args.slice(1));
      if (!t) return void say(`Usage: $${cmd} give user amount`);
      if (t.amount < cfg.give.minAmount) return void say(`@${me} the minimum is ${cfg.give.minAmount}`);
      if (cfg.give.maxAmount > 0 && t.amount > cfg.give.maxAmount) return void say(`@${me} the maximum is ${cfg.give.maxAmount}`);
      if (t.name.toLowerCase() === meLc) return void say(`@${me} you cannot give to yourself`);
      // Reserved before the lookup below awaits, so a burst of gives can't all pass
      // the check at once. Handed back if this give doesn't go through.
      const cdKey = `${channelName}:${meLc}:give`;
      const wait = cooldownLeft(cdKey, cfg.give.cooldownSeconds * 1000, cfg.give.cooldownSeconds > 0);
      if (wait) return void say(`@${me} wait ${wait}s before giving again`);

      let keepCooldown = false;
      try {
        const to = await svc.resolveUser(t.name, true);
        if (!to) return void say(`@${me} I could not find ${t.name}`);
        if (self && to.userId === self.user_id) return void say(`@${me} you cannot give to yourself`);
        if (isExcluded(ex, to.userId, to.username)) return void say(`@${me} ${to.username} cannot receive ${cur}`);
        if (!self) return void say(`@${me} you only have 0 ${cur}`);

        const run = once(() => transfer(db, { fromId: self.user_id, toId: to.userId, toName: to.username, amount: t.amount, actor: `chat:${me}`, now: Date.now() }));
        if (!run.applied) {
          keepCooldown = true;
          return;
        }
        const res = run.result!;
        if (!res.ok) return void say(`@${me} you only have ${res.fromBalance} ${cur}`);
        keepCooldown = true;
        console.log(`[POINTS] ${me} gave ${t.amount} ${cur} to ${to.username} (${res.ref})`);
        return void say(`@${me} gave ${t.amount} ${cur} to ${to.username}`);
      } finally {
        if (!keepCooldown) cooldowns.delete(cdKey);
      }
    }

    // ── add / remove / set ──
    if (!isModUp) return;
    const t = target(args.slice(1));
    if (!t || (sub !== 'set' && t.amount < 1)) return void say(`Usage: $${cmd} ${sub} user amount`);
    if (t.amount > cfg.modMaxAdjust) return void say(`@${me} the most you can adjust at once is ${cfg.modMaxAdjust}`);
    const who = await svc.resolveUser(t.name, true);
    if (!who) return void say(`@${me} I could not find ${t.name}`);
    if (SYSTEM_BOTS.has(who.username.toLowerCase()) || isBotSender(who.username, who.userId)) {
      return void say(`@${me} ${who.username} cannot hold ${cur}`);
    }

    const now = Date.now();
    const common = { userId: who.userId, ref: `mod:${now}:${meLc}`, actor: `chat:${me}`, now };
    if (sub === 'add') {
      const run = once(() => runWrite(db, () => creditTx(db, { ...common, username: who.username, amount: t.amount, reason: 'mod_add' })));
      if (!run.applied) return;
      console.log(`[POINTS] ${me} added ${t.amount} ${cur} to ${who.username}`);
      return void say(`Added ${t.amount} ${cur} to ${who.username}, now ${run.result}`);
    }
    if (sub === 'remove') {
      const run = once(() => runWrite(db, () => {
        const u = ensureUserTx(db, who.userId, who.username, now);
        const take = Math.min(u.balance, t.amount);
        const res = debitTx(db, { ...common, amount: take, reason: 'mod_remove' });
        return { take, balance: res.balance };
      }));
      if (!run.applied) return;
      const out = run.result!;
      console.log(`[POINTS] ${me} removed ${out.take} ${cur} from ${who.username}`);
      return void say(`Removed ${out.take} ${cur} from ${who.username}, now ${out.balance}`);
    }
    const run = once(() => runWrite(db, () => {
      ensureUserTx(db, who.userId, who.username, now);
      setTx(db, { ...common, value: t.amount, reason: 'mod_set' });
    }));
    if (!run.applied) return;
    console.log(`[POINTS] ${me} set ${who.username} to ${t.amount} ${cur}`);
    return void say(`${who.username} now has ${t.amount} ${cur}`);
  } catch (err) {
    reportDbError(channelName, err);
    console.error(`[POINTS] $${cmd} failed for ${me}: ${err instanceof Error ? err.message : String(err)}`);
  }
};
