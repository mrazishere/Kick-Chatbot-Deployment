/**
 * Loyalty points command. The trigger is the channel's currency command:
 * sukasblood's $DON answers to $don. It starts with $ where other
 * commands use !, so the command reads like the currency.
 *
 * Description: Balances, active time, leaderboards, giving, gambling, and moderator adjustments.
 *
 * Permission required:
 *          $<cmd>, activetime, top, leaderboard: all users
 *          $<cmd> give: all users, when giving is enabled
 *          $<cmd> gamble: all users, when gambling is enabled
 *          $<cmd> add/remove/set: the broadcaster and the bot owner only
 *          (moderators can read and skip read cooldowns, but not change balances)
 *
 * Usage:   $don [@user]               - balance and rank
 *          $don activetime [@user]    - active time and rank
 *          $don top [activetime]      - top 5
 *          $don leaderboard           - link to the public leaderboard
 *          $don give @user 100|5k|50%|all - send points to someone
 *          $don gamble 100|5k|50%|all - even money at the channel's win chance
 *          $don duel @user 100        - challenge a viewer; 50/50, winner takes both
 *          $don accept|deny [@user]   - answer a challenge
 *          $don cancel                - withdraw your challenge
 *          $don add|remove|set @user 500
 *
 * Gambling and duels stay silent when off, on cooldown, or the stream is offline
 * (the user's choice, to keep chat clean); the log says why each was ignored. A
 * challenger's stake is held until the duel is accepted, denied, cancelled or
 * expires; pending duels are stored, so a restart still refunds them.
 *
 * A subcommand word wins over a username; write @top to look up a user called top.
 * Chat also writes $DON in sentences ("$DON to the moon"), so a name without @
 * that isn't a known viewer gets no reply.
 *
 * Active time is time spent chatting while live, in 10-minute steps. Kick has no
 * viewer list, so a viewer who watches without chatting can't be counted, and
 * calling it watch time would claim more than the bot knows.
 */

import { CommandFn } from '../types';
import { SYSTEM_BOTS } from '../system-bots';
import { isBotSender } from '../bot-identity';
import { effectiveCommand } from '../points/config';
import { reportDbError, runWrite } from '../points/db';
import { getPointsService } from '../points/service';
import {
  acceptDuel, applyOnce, countRanked, createDuel, creditTx, debitTx, ensureUserTx, findUserByName, gamble, getUser,
  cancelRaffle, createRaffle, incomingDuels, isApplied, isExcluded, joinRaffle, openRaffle, outgoingDuel, rankBy, refundDuel, setTx, topBy, transfer
} from '../points/store';

const SUBCOMMANDS = new Set(['activetime', 'top', 'leaderboard', 'give', 'gamble', 'duel', 'accept', 'deny', 'cancel', 'raffle', 'sraffle', 'join', 'add', 'remove', 'set']);
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

/**
 * A gamble amount against a balance, the forms StreamElements takes: 250, 5k,
 * 1.5m, 50% (rounded down) or all. null when it's none of those. Can be 0,
 * which the minimum then refuses.
 */
export function parseBet(raw: string, balance: number): number | null {
  const t = raw.trim().toLowerCase();
  if (t === 'all') return balance;
  const pct = /^(\d{1,3}(?:\.\d+)?)%$/.exec(t);
  if (pct) {
    const p = Number(pct[1]);
    return p > 0 && p <= 100 ? Math.floor((balance * p) / 100) : null;
  }
  const short = /^(\d{1,9}(?:\.\d+)?)([km])$/.exec(t);
  if (short) return Math.floor(Number(short[1]) * (short[2] === 'k' ? 1_000 : 1_000_000));
  return /^\d{1,12}$/.test(t) ? Number(t) : null;
}

/** A duel's time to answer as chat reads it: 120 → "2 min", 90 → "90s". */
function expiryText(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
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
  const isOwner = !!process.env.KICK_OWNER && meLc === process.env.KICK_OWNER.toLowerCase();
  // Moderators skip the read cooldowns. Changing balances is only for the broadcaster
  // and the bot owner (user, 2026-09-12): a mod could otherwise mint up to modMaxAdjust at will.
  const isModUp = tags.isModUp || isOwner;
  const canWrite = tags.isBroadcaster || isOwner;

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

    // ── activetime ──
    if (sub === 'activetime') {
      if (cooldownLeft(`${channelName}:${meLc}:activetime`, USER_COOLDOWN_MS, true)) return;
      const named = args[1];
      let u = self;
      let label = `@${me}`;
      if (named && NAME_RE.test(named) && named.replace(/^@+/, '').toLowerCase() !== meLc) {
        const who = await svc.resolveUser(named, false);
        u = who ? getUser(db, who.userId) : undefined;
        label = u?.username ?? named.replace(/^@+/, '');
      }
      if (!u || u.watch_seconds <= 0) return void say(`${label} has no active time yet`);
      const rank = rankBy(db, u.user_id, 'watch_seconds', ex);
      return void say(`${label} has ${watchLong(u.watch_seconds)} of active time${rank === null ? '' : `, rank ${rank}`}`);
    }

    // ── top ──
    if (sub === 'top') {
      if (!isModUp && cooldownLeft(`${channelName}:top`, CHANNEL_COOLDOWN_MS, true)) return;
      const byWatch = /^active/i.test(args[1] ?? '');
      const rows = topBy(db, byWatch ? 'watch_seconds' : 'balance', 5, ex);
      if (!rows.length) return void say(byWatch ? 'No active time recorded yet' : `No ${cur} earned yet`);
      // "·" separates entries because Kick doesn't count it toward the symbol limit.
      // When names bring their own symbols, later entries are dropped rather than
      // letting the sanitiser strip characters out of a name.
      let text = byWatch ? 'Top active time' : `Top ${cur}`;
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
      // A replay must stay silent, e.g. not answer "the minimum is 10" after its own give-all emptied the balance.
      if (tags.messageId && isApplied(db, `chat:${tags.messageId}`)) return;
      // "user amount" in either order; an @ marks the name. The amount takes the same
      // forms as gamble (100, 5k, 50%, all), measured against the giver's balance.
      const [a, b] = args.slice(1);
      if (a === undefined || b === undefined) return void say(`Usage: $${cmd} give user amount`);
      const [nameRaw, amountRaw] = a.startsWith('@') ? [a, b] : b.startsWith('@') ? [b, a] : parseBet(b, 0) !== null ? [a, b] : [b, a];
      const have = self?.balance ?? 0;
      const amount = parseBet(amountRaw, have);
      if (!NAME_RE.test(nameRaw) || amount === null) return void say(`Usage: $${cmd} give user amount`);
      if (have === 0 && amount === 0) return void say(`@${me} you only have 0 ${cur}`);
      const t = { name: nameRaw.replace(/^@+/, ''), amount };
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

    // ── gamble ──
    if (sub === 'gamble') {
      const g = cfg.gamble;
      // Silent by choice (user, 2026-09-15); the log keeps it debuggable.
      const ignore = (why: string) => void console.log(`[POINTS] gamble from ${me} ignored: ${why}`);
      if (!g.enabled) return ignore('disabled');
      if (isExcluded(ex, self?.user_id ?? null, meLc) || isBotSender(me, tags.senderId)) return ignore('excluded');
      // A replay must stay silent, e.g. not answer "you have no $DON" after its own all-in loss.
      if (tags.messageId && isApplied(db, `chat:${tags.messageId}`)) return ignore('already handled');
      const raw = args[1];
      if (raw === undefined) return void say(`Usage: $${cmd} gamble amount`);
      // Reserved before the live check awaits, so a burst can't all pass at once.
      // Handed back unless a bet is actually placed.
      const cdKey = `${channelName}:${meLc}:gamble`;
      const wait = cooldownLeft(cdKey, g.cooldownSeconds * 1000, g.cooldownSeconds > 0);
      if (wait) return ignore(`cooldown ${wait}s`);

      let keepCooldown = false;
      try {
        if (g.onlyWhileLive) {
          const live = await svc.isLiveNow();
          if (live !== true) return ignore(live === null ? 'live state unknown' : 'offline');
        }
        // Read after the await: a tick or another bet may have changed the balance.
        const player = self ? getUser(db, self.user_id) : undefined;
        if (!player || player.balance <= 0) return void say(`@${me} you have no ${cur} to gamble`);
        const bet = parseBet(raw, player.balance);
        if (bet === null) return void say(`Usage: $${cmd} gamble amount`);
        if (bet < g.minAmount) return void say(`@${me} the minimum is ${g.minAmount}`);
        if (g.maxAmount > 0 && bet > g.maxAmount) return void say(`@${me} the maximum is ${g.maxAmount}`);
        if (bet > player.balance) return void say(`@${me} you only have ${player.balance} ${cur}`);

        const roll = svc.rollGamble(g.winChancePercent);
        const run = once(() => gamble(db, { userId: player.user_id, amount: bet, win: roll.win, actor: `chat:${me}`, now: Date.now() }));
        if (!run.applied) {
          keepCooldown = true;
          return;
        }
        const res = run.result!;
        if (!res.ok) return void say(`@${me} you only have ${res.balance} ${cur}`);
        keepCooldown = true;
        console.log(`[POINTS] ${me} gambled ${bet} ${cur}: ${roll.win ? 'won' : 'lost'} (roll ${roll.roll}/10000, wins below ${roll.threshold}), now ${res.balance} (${res.ref})`);
        if (bet === player.balance) {
          return void say(roll.win ? `@${me} went all in and won, now has ${res.balance} ${cur}` : `@${me} went all in and lost ${bet} ${cur}`);
        }
        return void say(roll.win ? `@${me} won ${bet} ${cur} and now has ${res.balance}` : `@${me} lost ${bet} ${cur} and now has ${res.balance}`);
      } finally {
        if (!keepCooldown) cooldowns.delete(cdKey);
      }
    }

    // ── duel / accept / deny / cancel ──
    if (sub === 'duel' || sub === 'accept' || sub === 'deny' || sub === 'cancel') {
      const d = cfg.duel;
      // Cooldown, offline and duels-off stay silent like gamble (user, 2026-09-15); the log says why.
      const ignore = (why: string) => void console.log(`[POINTS] ${sub} from ${me} ignored: ${why}`);
      if (!d.enabled) return ignore('duels disabled');
      if (isExcluded(ex, self?.user_id ?? null, meLc) || isBotSender(me, tags.senderId)) return ignore('excluded');
      // A replay must stay silent, not answer "you already challenged…" about the duel it made.
      if (tags.messageId && isApplied(db, `chat:${tags.messageId}`)) return ignore('already handled');
      // Refund whatever ran out first, so nobody accepts or waits on a dead duel.
      svc.sweepDuels();
      const nameOf = (userId: number) => getUser(db, userId)?.username ?? String(userId);

      if (sub === 'cancel') {
        const mine = self ? outgoingDuel(db, self.user_id) : undefined;
        if (!mine) return void say(`@${me} you have no duel to cancel`);
        const run = once(() => refundDuel(db, { id: mine.id, status: 'cancelled', actor: `chat:${me}`, now: Date.now() }));
        if (!run.applied) return;
        if (!run.result) return void say(`@${me} you have no duel to cancel`);
        console.log(`[POINTS] ${me} cancelled ${mine.id}: ${mine.amount} ${cur} refunded`);
        return void say(`@${me} duel cancelled, ${mine.amount} ${cur} refunded`);
      }

      if (sub === 'accept' || sub === 'deny') {
        const named = args[1] && NAME_RE.test(args[1]) ? args[1].replace(/^@+/, '') : null;
        let incoming = self ? incomingDuels(db, self.user_id) : [];
        if (named) incoming = incoming.filter(x => nameOf(x.challenger_id).toLowerCase() === named.toLowerCase());
        if (!incoming.length) return void say(named ? `@${me} ${named} has not challenged you` : `@${me} you have no duel to ${sub}`);
        if (incoming.length > 1) {
          const names = incoming.slice(0, 3).map(x => `@${nameOf(x.challenger_id)}`);
          const list = names.length > 2 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join(' or ');
          return void say(`@${me} pick one: $${cmd} ${sub} ${list}`);
        }
        const duel = incoming[0];
        const challenger = nameOf(duel.challenger_id);

        if (sub === 'deny') {
          const run = once(() => refundDuel(db, { id: duel.id, status: 'denied', actor: `chat:${me}`, now: Date.now() }));
          if (!run.applied) return;
          if (!run.result) return void say(`@${me} you have no duel to deny`);
          console.log(`[POINTS] ${me} denied ${duel.id}: ${duel.amount} ${cur} refunded to ${challenger}`);
          return void say(`@${challenger} ${me} declined the duel, ${duel.amount} ${cur} refunded`);
        }

        if (d.onlyWhileLive) {
          const live = await svc.isLiveNow();
          if (live !== true) return ignore(live === null ? 'live state unknown' : 'offline');
        }
        const challengerWins = svc.rollDuel();
        const run = once(() => acceptDuel(db, { id: duel.id, challengerWins, actor: `chat:${me}`, now: Date.now() }));
        if (!run.applied) return;
        const res = run.result!;
        if (!res.ok) {
          return void say(res.reason === 'short' ? `@${me} you only have ${res.balance} ${cur}` : `@${me} you have no duel to accept`);
        }
        const winner = res.winnerId === duel.challenger_id ? challenger : me;
        const loser = res.winnerId === duel.challenger_id ? me : challenger;
        console.log(`[POINTS] ${duel.id}: ${winner} beat ${loser} for ${duel.amount} ${cur}, winner now has ${res.winnerBalance}`);
        return void say(`${winner} won the duel against ${loser} and takes ${duel.amount} ${cur}, now has ${res.winnerBalance}`);
      }

      // duel: an @ marks the name, otherwise the name comes first.
      const [first, second] = args.slice(1);
      if (first === undefined || second === undefined) return void say(`Usage: $${cmd} duel @user amount`);
      const [nameRaw, amountRaw] = second.startsWith('@') && !first.startsWith('@') ? [second, first] : [first, second];
      if (!NAME_RE.test(nameRaw)) return void say(`Usage: $${cmd} duel @user amount`);
      const targetName = nameRaw.replace(/^@+/, '');
      if (targetName.toLowerCase() === meLc) return void say(`@${me} you cannot duel yourself`);
      // Reserved before the awaits below, so a burst can't all pass; handed back unless a challenge is made.
      const cdKey = `${channelName}:${meLc}:duel`;
      const wait = cooldownLeft(cdKey, d.cooldownSeconds * 1000, d.cooldownSeconds > 0);
      if (wait) return ignore(`cooldown ${wait}s`);

      let keepCooldown = false;
      try {
        if (d.onlyWhileLive) {
          const live = await svc.isLiveNow();
          if (live !== true) return ignore(live === null ? 'live state unknown' : 'offline');
        }
        // No Kick lookup: someone with no balance couldn't match a stake anyway.
        const who = await svc.resolveUser(targetName, false);
        const opponent = who ? getUser(db, who.userId) : undefined;
        if (!who || !opponent || isExcluded(ex, who.userId, who.username) || isBotSender(who.username, who.userId) || SYSTEM_BOTS.has(who.username.toLowerCase())) {
          return void say(`@${me} you cannot duel ${targetName}`);
        }
        // Read after the awaits: a tick or another bet may have changed the balances.
        const player = self ? getUser(db, self.user_id) : undefined;
        if (player && opponent.user_id === player.user_id) return void say(`@${me} you cannot duel yourself`);
        if (!player || player.balance <= 0) return void say(`@${me} you have no ${cur} to duel`);
        const bet = parseBet(amountRaw, player.balance);
        if (bet === null) return void say(`Usage: $${cmd} duel @user amount`);
        if (bet < d.minAmount) return void say(`@${me} the minimum is ${d.minAmount}`);
        if (d.maxAmount > 0 && bet > d.maxAmount) return void say(`@${me} the maximum is ${d.maxAmount}`);
        if (bet > player.balance) return void say(`@${me} you only have ${player.balance} ${cur}`);
        if (opponent.balance < bet) return void say(`@${me} ${opponent.username} only has ${opponent.balance} ${cur}`);
        const pending = outgoingDuel(db, player.user_id);
        if (pending) return void say(`@${me} you already challenged ${nameOf(pending.opponent_id)}, $${cmd} cancel first`);

        const now = Date.now();
        const run = once(() => createDuel(db, {
          challengerId: player.user_id, opponentId: opponent.user_id, amount: bet,
          expiresAt: now + d.expirySeconds * 1000, actor: `chat:${me}`, now
        }));
        if (!run.applied) {
          keepCooldown = true;
          return;
        }
        const res = run.result!;
        if (!res.ok) {
          return void say(res.reason === 'pending'
            ? `@${me} you already challenged ${nameOf(res.pending.opponent_id)}, $${cmd} cancel first`
            : `@${me} you only have ${res.balance} ${cur}`);
        }
        keepCooldown = true;
        console.log(`[POINTS] ${me} challenged ${opponent.username} for ${bet} ${cur} (${res.duel.id}, ${d.expirySeconds}s to answer)`);
        return void say(`@${opponent.username} ${me} challenges you to a duel for ${bet} ${cur}, type $${cmd} accept or $${cmd} deny within ${expiryText(d.expirySeconds)}`);
      } finally {
        if (!keepCooldown) cooldowns.delete(cdKey);
      }
    }

    // ── raffle / sraffle / join ──
    if (sub === 'raffle' || sub === 'sraffle' || sub === 'join') {
      const rc = cfg.raffle;
      const ignore = (why: string) => void console.log(`[POINTS] ${sub} from ${me} ignored: ${why}`);
      if (!rc.enabled) return ignore('raffles disabled');
      // Resolve anything that has already run out before reading the open raffle,
      // so a closed one is never treated as still taking entries.
      svc.sweepRaffles();

      if (sub === 'join') {
        if (isExcluded(ex, self?.user_id ?? null, meLc) || isBotSender(me, tags.senderId)) return ignore('excluded');
        const open = openRaffle(db);
        if (!open) return ignore('no raffle open');
        const uid = self?.user_id ?? (Number.isInteger(senderId) && senderId > 0 ? senderId : null);
        if (uid === null) return ignore('no user id on the message');
        const res = joinRaffle(db, { userId: uid, username: me, now: Date.now() });
        // Entries are silent by design: a busy raffle would otherwise flood chat
        // with one line per viewer. The count is announced when it draws.
        return ignore(res === 'joined' ? `entered ${open.id}` : res === 'already' ? 'already entered' : 'raffle closed');
      }

      // Opening and cancelling are moderators and above.
      if (!isModUp) return ignore('not a moderator');

      if ((args[1] ?? '').toLowerCase() === 'cancel') {
        const open = openRaffle(db);
        if (!open) return void say(`@${me} no raffle is open`);
        if (!cancelRaffle(db, { id: open.id, now: Date.now() })) return void say(`@${me} no raffle is open`);
        console.log(`[POINTS] ${open.id} cancelled by ${me}`);
        return void say(`Raffle cancelled by ${me}, no ${cur} paid`);
      }

      if (rc.onlyWhileLive) {
        const live = await svc.isLiveNow();
        if (live !== true) return ignore(live === null ? 'live state unknown' : 'offline');
      }
      const prize = Number(args[1]);
      if (!Number.isInteger(prize) || prize <= 0) return void say(`Usage: $${cmd} ${sub} prize [seconds]`);
      if (prize < rc.minPrize) return void say(`@${me} the smallest prize is ${rc.minPrize} ${cur}`);
      if (rc.maxPrize > 0 && prize > rc.maxPrize) return void say(`@${me} the biggest prize is ${rc.maxPrize} ${cur}`);

      const typedSeconds = args[2] === undefined ? rc.defaultDurationSeconds : Number(args[2]);
      if (!Number.isInteger(typedSeconds) || typedSeconds <= 0) return void say(`Usage: $${cmd} ${sub} prize [seconds]`);
      if (typedSeconds > rc.maxDurationSeconds) return void say(`@${me} a raffle can run for at most ${rc.maxDurationSeconds}s`);

      const winners = sub === 'sraffle' ? 1 : rc.winners;
      const run = once(() => createRaffle(db, {
        prize,
        winners,
        streamKey: svc.raffleStreamKey(),
        openedBy: me,
        closesAt: Date.now() + typedSeconds * 1000,
        maxPerStream: rc.maxPerStream,
        now: Date.now()
      }));
      if (!run.applied) return;
      const res = run.result!;
      if (!res.ok) {
        return void say(res.reason === 'already'
          ? `@${me} a raffle is already running, $${cmd} raffle cancel to stop it`
          : `@${me} that's all ${res.opened} raffles for this stream`);
      }
      console.log(`[POINTS] ${me} opened ${res.raffle.id}: ${prize} ${cur}, ${winners} winner(s), ${typedSeconds}s`);
      const share = winners === 1 ? `${prize} ${cur}` : `${prize} ${cur} split ${winners} ways`;
      return void say(`Raffle open — ${share}, type $${cmd} join within ${expiryText(typedSeconds)}`);
    }

    // ── add / remove / set ──
    if (!canWrite) return;
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
