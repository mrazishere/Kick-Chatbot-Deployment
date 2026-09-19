/**
 * Loyalty points selftest. Runs against a scratch data directory with a fake
 * live check: it never calls Kick or Telegram and never touches data/points.
 *
 *   npx tsx src/tools/points-selftest.ts
 *
 * Exits non-zero when any check fails.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ChannelConfig, ClientWrapper, KickTags, RawBadge } from '../types';
import { effectiveCommand, effectivePointsConfig, invalidateLivePointsConfig, validatePointsPatch } from '../points/config';
import { closeAllPointsDbs, closePointsDb, openPointsDb, PointsDb, reportDbError, runWrite } from '../points/db';
import { LiveState } from '../points/live';
import { PointsService } from '../points/service';
import { normalizeChat, presenceVerdict } from '../points/presence-rules';
import {
  acceptDuel, adjustPoints, backupPoints, createDuel, creditTx, debitTx, duelStats, gambleStats, getUser, grantTick, invariantViolations,
  openRaffle, raffleEntries, gamble,
  outgoingDuel, refundDuel,
  pointsLeaderboard, pointsSummary, searchPointsUsers, getPointsUserDetail, transfer
} from '../points/store';
import { WebhookPoller } from '../channels/webhook-poller';
import { points as pointsCommand } from '../bot-commands/points';

const MIN = 60_000;

// ─── Child processes for the two-process race ───────────────────────────────

async function child(mode: string, root: string, seed: number): Promise<void> {
  process.env.POINTS_DATA_ROOT = root;
  if (mode === 'opencheck' || mode === 'opencreate') {
    // opencheck: a quarantined channel must be refused. opencreate: first opens racing to migrate.
    const ch = mode === 'opencheck' ? 'quarch' : 'migratech';
    const opened = openPointsDb(ch, { create: true });
    if (opened) opened.prepare('SELECT COUNT(*) AS n FROM users').get();
    process.exitCode = opened ? 0 : 3;
    closeAllPointsDbs();
    return;
  }
  let x = seed;
  const rand = (n: number) => { x = (x * 1103515245 + 12345) % 2147483648; return x % n; };
  const db = openPointsDb('racech', { create: true })!;
  const cfg = effectivePointsConfig({ enabled: true });
  if (mode === 'ops') {
    for (let i = 0; i < 2000; i++) {
      const a = 1 + rand(20);
      const b = 1 + rand(20);
      const op = rand(10);
      if (op < 6 && a !== b) {
        transfer(db, { fromId: a, toId: b, toName: `u${b}`, amount: 1 + rand(50), actor: 'race', now: Date.now() });
      } else {
        const mode2 = (['add', 'remove', 'set'] as const)[rand(3)];
        adjustPoints('racech', cfg, { userId: a, mode: mode2, amount: mode2 === 'set' ? rand(2000) : 1 + rand(100), reason: 'race test', actor: 'race', requestId: `${seed}-${i}` });
      }
    }
  } else if (mode === 'tick') {
    const rows = Array.from({ length: 20 }, (_, i) => ({ userId: i + 1, points: 10, isSub: false }));
    for (let i = 0; i < 50; i++) {
      grantTick(db, { slotKey: `watch:race-${i}`, streamKey: 'stream:race', now: Date.now(), boundaryMs: 1000 + i, seconds: 600, rows });
    }
  }
  closeAllPointsDbs();
}

function runChild(mode: string, root: string, seed: number): Promise<number> {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [...process.execArgv, __filename, '--child', mode, root, String(seed)], { stdio: 'inherit' });
    p.on('exit', code => resolve(code ?? 1));
  });
}

// ─── Harness ────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++;
  else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  }
}

function writeConfig(root: string, channel: string, points: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  const dir = path.join(root, 'channel-configs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${channel}.json`), JSON.stringify({ channelName: channel, ...extra, points }, null, 2));
  invalidateLivePointsConfig(channel);
}

const badges = (...types: string[]): RawBadge[] => types.map(type => ({ type }));

function makeService(channel: string, opts: { live?: () => Promise<LiveState | null>; now?: () => number; broadcaster?: number | null; dbProvider?: () => PointsDb | null; lookup?: (n: string) => Promise<number | null>; sent?: string[]; random?: () => number } = {}) {
  return new PointsService({
    channelName: channel,
    getBroadcasterUserId: () => opts.broadcaster ?? null,
    sendMessage: async (message: string) => { opts.sent?.push(message); },
    lookupUser: opts.lookup,
    tokenFile: '/nonexistent',
    checkLive: opts.live ?? (async () => ({ isLive: true, startedAt: null })),
    now: opts.now,
    dbProvider: opts.dbProvider,
    random: opts.random
  });
}

function balance(channel: string, userId: number): number {
  return getUser(openPointsDb(channel, { create: true })!, userId)?.balance ?? 0;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'points-selftest-'));
  process.env.POINTS_DATA_ROOT = root;
  process.env.POINTS_SELFTEST = '1';
  process.env.KICK_OWNER = 'ownerx';
  process.env.KICK_USERNAME = 'thebotacct';
  process.env.BOT_DASHBOARD_URL = 'https://example.test/kick';
  console.log(`[selftest] data root ${root}`);

  // Config
  {
    check('command derived from $DON', effectiveCommand({ currencyName: '$DON', currencyCommand: null }) === 'don');
    check('command falls back to points', effectiveCommand({ currencyName: '$', currencyCommand: null }) === 'points');
    check('explicit command wins', effectiveCommand({ currencyName: '$DON', currencyCommand: 'coins' }) === 'coins');
    const ok = validatePointsPatch({ enabled: false }, { enabled: true, currencyName: '$DON', bonuses: { follow: 25 }, give: { enabled: true } });
    check('valid patch merges', ok.errors.length === 0 && ok.next?.enabled === true && ok.next?.bonuses?.follow === 25 && ok.next?.give?.enabled === true, ok);
    const bad = validatePointsPatch({}, { intervalMinutes: 3, currencyName: 'bad<name>', ignoreUsers: ['ok_user', 'x'] });
    check('invalid patch rejected', !bad.next && bad.errors.length === 3, bad.errors);
    const cross = validatePointsPatch({}, { intervalMinutes: 60, activeWindowMinutes: 30 });
    check('window shorter than interval rejected', !cross.next && cross.errors.some(e => e.includes('activeWindowMinutes')), cross.errors);
    const staging = validatePointsPatch({ debugForceLive: true }, { debugForceLive: false, enabled: true });
    check('debugForceLive survives but cannot be set by patch', staging.next?.debugForceLive === true);
    check('effective config strips debugForceLive', !('debugForceLive' in effectivePointsConfig({ debugForceLive: true })));
    const gDefaults = effectivePointsConfig({}).gamble;
    check('gamble defaults: off, 50%, min 1, no cap, 60s, live only',
      !gDefaults.enabled && gDefaults.winChancePercent === 50 && gDefaults.minAmount === 1 && gDefaults.maxAmount === 0 && gDefaults.cooldownSeconds === 60 && gDefaults.onlyWhileLive, gDefaults);
    const gOk = validatePointsPatch({ gamble: { enabled: true } }, { gamble: { winChancePercent: 45.5 } });
    check('gamble patch merges field by field', gOk.errors.length === 0 && gOk.next?.gamble?.enabled === true && gOk.next?.gamble?.winChancePercent === 45.5, gOk);
    const gBad = validatePointsPatch({}, { gamble: { winChancePercent: 101, onlyWhileLive: 'yes' } });
    check('gamble out-of-range chance and non-boolean rejected', !gBad.next && gBad.errors.length === 2, gBad.errors);
    const gCross = validatePointsPatch({}, { gamble: { minAmount: 50, maxAmount: 10 } });
    check('gamble maximum below minimum rejected', !gCross.next && gCross.errors.some(e => e.includes('gamble.maxAmount')), gCross.errors);
    check('hand-edited chance is clamped', effectivePointsConfig({ gamble: { winChancePercent: 150 } }).gamble.winChancePercent === 100);
    const dDefaults = effectivePointsConfig({}).duel;
    check('duel defaults: off, min 1, no cap, 60s cooldown, 120s to answer, live only',
      !dDefaults.enabled && dDefaults.minAmount === 1 && dDefaults.maxAmount === 0 && dDefaults.cooldownSeconds === 60 && dDefaults.expirySeconds === 120 && dDefaults.onlyWhileLive, dDefaults);
    const dOk = validatePointsPatch({ duel: { enabled: true } }, { duel: { expirySeconds: 90 } });
    check('duel patch merges field by field', dOk.errors.length === 0 && dOk.next?.duel?.enabled === true && dOk.next?.duel?.expirySeconds === 90, dOk);
    const dBad = validatePointsPatch({}, { duel: { expirySeconds: 10, enabled: 'on' } });
    check('duel expiry under 30s and non-boolean rejected', !dBad.next && dBad.errors.length === 2, dBad.errors);
    const dCross = validatePointsPatch({}, { duel: { minAmount: 50, maxAmount: 10 } });
    check('duel maximum below minimum rejected', !dCross.next && dCross.errors.some(e => e.includes('duel.maxAmount')), dCross.errors);
    check('hand-edited expiry is clamped', effectivePointsConfig({ duel: { expirySeconds: 5 } }).duel.expirySeconds === 30);
  }

  // Store basics
  {
    const db = openPointsDb('basics', { create: true })!;
    check('migrated to user_version 4', db.pragma('user_version', { simple: true }) === 4);
    runWrite(db, () => creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 }));
    const over = runWrite(db, () => debitTx(db, { userId: 1, amount: 150, reason: 'mod_remove', now: 2 }));
    check('debit beyond balance refused', !over.ok && over.balance === 100);
    const under = runWrite(db, () => debitTx(db, { userId: 1, amount: 40, reason: 'mod_remove', now: 3 }));
    check('debit within balance', under.ok && under.balance === 60);
    let threw = false;
    try { db.prepare('UPDATE users SET balance = -1 WHERE user_id = 1').run(); } catch { threw = true; }
    check('CHECK balance >= 0 enforced', threw);
    check('invariant holds (basics)', invariantViolations(db).length === 0, invariantViolations(db));
  }

  // Two-process race
  {
    const db = openPointsDb('racech', { create: true })!;
    runWrite(db, () => { for (let i = 1; i <= 20; i++) creditTx(db, { userId: i, username: `u${i}`, amount: 1000, reason: 'mod_add', now: 1 }); });
    closeAllPointsDbs();
    const codes = await Promise.all([runChild('ops', root, 7), runChild('ops', root, 99)]);
    check('race children exited cleanly', codes.every(c => c === 0), codes);
    const db2 = openPointsDb('racech', { create: true })!;
    check('invariant holds after 4000 racing ops', invariantViolations(db2).length === 0, invariantViolations(db2).slice(0, 3));
    const neg = db2.prepare('SELECT COUNT(*) AS n FROM users WHERE balance < 0').get() as { n: number };
    check('no negative balances after race', neg.n === 0);

    const watchBefore = (db2.prepare('SELECT COALESCE(SUM(points),0) AS s FROM watch_ledger').get() as { s: number }).s;
    closeAllPointsDbs();
    const tickCodes = await Promise.all([runChild('tick', root, 1), runChild('tick', root, 2)]);
    check('tick children exited cleanly', tickCodes.every(c => c === 0), tickCodes);
    const db3 = openPointsDb('racech', { create: true })!;
    const watchAfter = (db3.prepare('SELECT COALESCE(SUM(points),0) AS s FROM watch_ledger').get() as { s: number }).s;
    check('same slots from two processes granted once', watchAfter - watchBefore === 50 * 20 * 10, { watchBefore, watchAfter });
    check('invariant holds after tick race', invariantViolations(db3).length === 0);
  }

  // Presence rules: which messages keep a viewer earning
  {
    check('case, spacing and stretched letters normalize alike',
      normalizeChat('LOL') === normalizeChat(' lolll ') && normalizeChat('Hello   World') === normalizeChat('hello worlddd'));
    const v = (text: string, prev?: string) => presenceVerdict(text, prev === undefined ? undefined : normalizeChat(prev), 'don');
    check('back-to-back repeat ignored', v('HELLO  thereee', 'hello there').counts === false);
    check('alternating lines count', v('bbb', 'aaa').counts === true && v('aaa', 'bbb').counts === true);
    check('repeat after a different message counts again', v('hello there', 'something else').counts === true);
    check('emote-only ignored', v('[emote:123:peeguu] [emote:456:cat]').counts === false);
    check('k and ?? ignored', v('k').counts === false && v('??').counts === false);
    check('three characters of text count', v('abc').counts === true && v('aaa').counts === true);
    check('emote plus short text ignored', v('[emote:1:x] ok').counts === false);
    check('$don and $don top ignored', v('$don').counts === false && v('$DON top').counts === false);
    check('a word starting with the command still counts', v('$donate now please').counts === true);
    check('!don is ordinary chat now', v('!don').counts === true);

    // At tick time: ignored messages must not extend the window.
    const ch = 'spamch';
    const B = 1_000_001 * 10 * MIN;
    let now = B;
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, currencyName: '$DON' });
    const svc = makeService(ch, { live: async () => ({ isLive: true, startedAt: null }), now: () => now });
    const say = (id: number, name: string, at: number, text: string) => { now = at; svc.noteChat(id, name, badges(), text); };
    say(41, 'repeater', B - 40 * MIN, 'hello there');
    say(41, 'repeater', B - 5 * MIN, 'HELLO  thereee');
    say(42, 'emoter', B - 40 * MIN, 'first message');
    say(42, 'emoter', B - 5 * MIN, '[emote:1:x] [emote:2:y]');
    say(43, 'commander', B - 40 * MIN, 'hi everyone');
    say(43, 'commander', B - 5 * MIN, '$don top');
    say(44, 'alternator', B - 40 * MIN, 'aaa');
    say(44, 'alternator', B - 35 * MIN, 'bbb');
    say(44, 'alternator', B - 5 * MIN, 'aaa');
    say(45, 'shorty', B - 5 * MIN, 'ok');
    say(46, 'normal', B - 5 * MIN, 'lol');
    now = B + 5000;
    svc.flushPresence();
    await svc.runTick(B);
    check('repeat does not extend the window', balance(ch, 41) === 0);
    check('emote-only does not extend the window', balance(ch, 42) === 0);
    check('$don does not extend the window', balance(ch, 43) === 0);
    check('alternating message extends the window', balance(ch, 44) === 5);
    check('short message never earns', balance(ch, 45) === 0);
    check('ordinary message earns', balance(ch, 46) === 5);
  }

  // Earner
  {
    const ch = 'earnch';
    const B = 1_000_000 * 10 * MIN;
    let now = B;
    let live: LiveState | null = { isLive: true, startedAt: null };
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, subscriberMultiplier: 1.5, ignoreUsers: ['ignored1'] });
    const svc = makeService(ch, { live: async () => live, now: () => now, broadcaster: 999 });

    const chat = (id: number, name: string, at: number, ...b: string[]) => { now = at; svc.noteChat(id, name, badges(...b)); };
    chat(1, 'inside', B - 30 * MIN + 1000);
    chat(2, 'edge', B - 30 * MIN);
    chat(3, 'outside', B - 31 * MIN);
    chat(4, 'subber', B - MIN, 'subscriber');
    chat(5, 'founderonly', B - MIN, 'founder');
    chat(6, 'botrix', B - MIN);
    chat(7, 'ignored1', B - MIN);
    chat(999, 'broadcasterx', B - MIN, 'broadcaster');
    chat(8, 'thebotacct', B - MIN);
    chat(9, 'lateignored', B - MIN);
    now = B + 5000;
    svc.flushPresence();
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, subscriberMultiplier: 1.5, ignoreUsers: ['ignored1', 'lateignored'] });

    const r1 = await svc.runTick(B);
    check('tick granted', r1.status === 'granted', r1);
    check('inside window earns', balance(ch, 1) === 5);
    check('exactly at window start does not earn', balance(ch, 2) === 0);
    check('outside window does not earn', balance(ch, 3) === 0);
    check('sub multiplier rounds (5 × 1.5 = 8)', balance(ch, 4) === 8);
    check('founder badge alone is not a sub', balance(ch, 5) === 5);
    check('system bot excluded', balance(ch, 6) === 0);
    check('ignore list excluded at note time', balance(ch, 7) === 0);
    check('broadcaster excluded', balance(ch, 999) === 0);
    check('bot account excluded', balance(ch, 8) === 0);
    check('ignore list applied at tick time', balance(ch, 9) === 0);
    check('watch time granted', getUser(openPointsDb(ch, { create: true })!, 1)?.watch_seconds === 600);

    const r2 = await svc.runTick(B);
    check('same slot twice is a duplicate', r2.status === 'duplicate' && balance(ch, 1) === 5, r2);
    const r3 = await svc.runTick(B + MIN);
    check('a slot too soon after the last is skipped', r3.status === 'skipped', r3);

    const B2 = B + 10 * MIN;
    chat(1, 'inside', B2 - MIN);
    live = null;
    const r4 = await svc.runTick(B2);
    check('unknown live state grants nothing', r4.status === 'skipped' && balance(ch, 1) === 5, r4);
    live = { isLive: false, startedAt: null };
    const r5 = await svc.runTick(B2);
    check('offline grants nothing', r5.status === 'skipped' && balance(ch, 1) === 5, r5);

    live = null;
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, debugForceLive: true });
    const r6 = await svc.runTick(B2);
    check('debugForceLive grants without a live check', r6.status === 'granted' && balance(ch, 1) === 10, r6);

    // Stream start narrows the window to one interval before it.
    const B3 = B2 + 10 * MIN;
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5 });
    chat(20, 'prestream', B3 - 20 * MIN);
    chat(21, 'nearstart', B3 - 12 * MIN);
    live = { isLive: true, startedAt: B3 - 5 * MIN };
    await svc.runTick(B3);
    check('chat long before stream start does not earn', balance(ch, 20) === 0);
    check('chat within an interval of stream start earns', balance(ch, 21) === 5);

    // Catch-up on start for a boundary under 3 minutes old.
    const B4 = B3 + 10 * MIN;
    chat(1, 'inside', B4 - MIN);
    const beforeCatchUp = balance(ch, 1);
    now = B4 + MIN;
    live = { isLive: true, startedAt: B3 - 5 * MIN };
    svc.start();
    await new Promise(r => setTimeout(r, 200));
    svc.stop();
    check('catch-up tick on start', balance(ch, 1) === beforeCatchUp + 5, { beforeCatchUp, after: balance(ch, 1) });

    writeConfig(root, ch, { enabled: false });
    const r7 = await svc.runTick(B4 + 10 * MIN);
    check('disabled grants nothing', r7.status === 'skipped');
    check('invariant holds (earner)', invariantViolations(openPointsDb(ch, { create: true })!).length === 0);
  }

  // Events
  {
    const ch = 'eventch';
    let now = 50_000 * MIN;
    writeConfig(root, ch, { enabled: true });
    const svc = makeService(ch, { now: () => now, broadcaster: 999 });
    const meta = { ageMs: 0 };
    const user = (id: number, name: string) => ({ user_id: id, username: name });
    const bc = user(999, 'eventch');

    for (let i = 0; i < 3; i++) svc.onFollow({ broadcaster: bc, follower: user(10, 'fan') }, { ageMs: 0, messageId: 'f1' });
    check('follow replayed 3× pays once', balance(ch, 10) === 50);
    now += 60 * MIN;
    svc.onFollow({ broadcaster: bc, follower: user(10, 'fan') }, { ageMs: 0, messageId: 'f2' });
    check('refollow never pays again', balance(ch, 10) === 50);

    for (let i = 0; i < 3; i++) svc.onSubscriptionNew({ broadcaster: bc, subscriber: user(11, 'subby'), created_at: '2026-09-11T10:00:00Z' }, meta);
    check('new sub replayed 3× pays once', balance(ch, 11) === 500);
    svc.onSubscriptionRenewal({ broadcaster: bc, subscriber: user(11, 'subby'), created_at: '2026-10-11T10:00:00Z' }, meta);
    check('renewal pays', balance(ch, 11) === 1000);

    const gifts = { broadcaster: bc, gifter: user(12, 'gifter'), giftees: [user(13, 'g1'), user(14, 'g2'), user(15, 'g3')], created_at: '2026-09-11T11:00:00Z' };
    for (let i = 0; i < 3; i++) svc.onSubscriptionGifts(gifts, meta);
    check('gifter paid per sub once', balance(ch, 12) === 750);
    check('each giftee paid once', [13, 14, 15].every(id => balance(ch, id) === 100));
    svc.onSubscriptionGifts({ broadcaster: bc, gifter: { user_id: null, username: 'Anonymous', is_anonymous: true }, giftees: [user(16, 'g4')], created_at: '2026-09-11T11:05:00Z' }, meta);
    check('anonymous gift pays only the giftee', balance(ch, 16) === 100);

    now += 60 * MIN;
    svc.onSubscriptionGifts({ broadcaster: bc, gifter: user(12, 'gifter'), giftees: [user(21, 'gf')], created_at: '2026-09-11T12:00:00Z' }, meta);
    svc.onSubscriptionNew({ broadcaster: bc, subscriber: user(21, 'gf'), created_at: '2026-09-11T12:00:01Z' }, meta);
    check('gift then sub_new pays one', balance(ch, 21) === 100);
    svc.onSubscriptionNew({ broadcaster: bc, subscriber: user(22, 'sg'), created_at: '2026-09-11T12:01:00Z' }, meta);
    svc.onSubscriptionGifts({ broadcaster: bc, gifter: user(12, 'gifter'), giftees: [user(22, 'sg')], created_at: '2026-09-11T12:01:01Z' }, meta);
    check('sub_new then gift pays one', balance(ch, 22) === 500);

    svc.onKicksGifted({ broadcaster: bc, sender: user(23, 'tipper'), gift: { amount: 250 }, created_at: '2026-09-11T12:02:00Z' }, meta);
    svc.onKicksGifted({ broadcaster: bc, sender: user(23, 'tipper'), gift: { amount: 250 }, created_at: '2026-09-11T12:02:00Z' }, meta);
    check('kicks scaled and paid once', balance(ch, 23) === 250);
    writeConfig(root, ch, { enabled: true, bonuses: { pointsPerKick: 0.5 } });
    svc.onKicksGifted({ broadcaster: bc, sender: user(24, 'tipper2'), gift: { amount: 101 }, created_at: '2026-09-11T12:03:00Z' }, meta);
    check('kicks floor with fractional rate', balance(ch, 24) === 50);

    // Announcements: one chat line per event, however many viewers it paid.
    const ach = 'announcech';
    writeConfig(root, ach, { enabled: true, currencyName: '$DON', bonuses: { announce: true } });
    const sent: string[] = [];
    const asvc = makeService(ach, { now: () => now, broadcaster: 999, sent });
    const abc = user(999, ach);
    asvc.onSubscriptionGifts({ broadcaster: abc, gifter: { user_id: null, username: 'Anonymous', is_anonymous: true }, giftees: Array.from({ length: 10 }, (_, i) => user(100 + i, `anon${i}`)), created_at: '2026-09-11T15:35:18Z' }, meta);
    check('anonymous 10-sub gift announces in one line', sent.length === 1 && sent[0] === `enjoy your gifted subs ${Array.from({ length: 10 }, (_, i) => `anon${i}`).join(', ')} +100 $DON each`, sent);
    sent.length = 0;
    asvc.onSubscriptionGifts({ broadcaster: abc, gifter: user(200, 'bigspender'), giftees: [user(201, 'r1'), user(202, 'r2')], created_at: '2026-09-11T15:40:00Z' }, meta);
    check('named gift thanks the gifter and names recipients in one line', sent.length === 1 && sent[0] === 'thanks for the 2 gifted subs bigspender +500 $DON, and +100 $DON each to r1, r2', sent);
    sent.length = 0;
    asvc.onSubscriptionGifts({ broadcaster: abc, gifter: null, giftees: Array.from({ length: 100 }, (_, i) => user(300 + i, `a_long_recipient_name_${i}`)), created_at: '2026-09-11T15:45:00Z' }, meta);
    check('a 100-sub gift stays one line under the chat limit', sent.length === 1 && sent[0].length <= 500 && / and \d+ more \+100 \$DON each$/.test(sent[0]), sent);
    sent.length = 0;
    asvc.onFollow({ broadcaster: abc, follower: user(400, 'newfan') }, { ageMs: 0, messageId: 'fa1' });
    check('single-grant announcement unchanged', sent.length === 1 && sent[0] === 'thanks for the follow newfan +50 $DON', sent);

    // Chat-socket fallback only when the webhook subscription failed.
    writeConfig(root, ch, { enabled: true });
    now += 60 * MIN;
    svc.noteChat(31, 'pushy', badges());
    svc.noteChat(32, 'webby', badges());
    svc.onPusherSubscription({ username: 'pushy' });
    await new Promise(r => setTimeout(r, 50));
    check('no fallback without a failed subscription', balance(ch, 31) === 0);
    fs.mkdirSync(path.join(root, 'webhook-subscriptions'), { recursive: true });
    fs.writeFileSync(path.join(root, 'webhook-subscriptions', `${ch}.json`), JSON.stringify({ 'channel.subscription.new': { ok: false, error: 'x', at: 'now' } }));
    svc.onPusherSubscription({ username: 'pushy' });
    await new Promise(r => setTimeout(r, 50));
    svc.onSubscriptionNew({ broadcaster: bc, subscriber: user(31, 'pushy'), created_at: '2026-09-11T13:00:00Z' }, meta);
    check('pusher then webhook pays one', balance(ch, 31) === 500);
    svc.onSubscriptionNew({ broadcaster: bc, subscriber: user(32, 'webby'), created_at: '2026-09-11T13:01:00Z' }, meta);
    svc.onPusherSubscription({ username: 'webby' });
    await new Promise(r => setTimeout(r, 50));
    check('webhook then pusher pays one', balance(ch, 32) === 500);

    svc.onFollow({ broadcaster: bc, follower: user(999, 'eventch') }, meta);
    check('broadcaster gets no follow bonus', balance(ch, 999) === 0);
    check('invariant holds (events)', invariantViolations(openPointsDb(ch, { create: true })!).length === 0);

    // Spool while the database is away, replay when it returns.
    const sch = 'spoolch';
    writeConfig(root, sch, { enabled: true });
    let available = false;
    const ssvc = makeService(sch, { dbProvider: () => (available ? openPointsDb(sch, { create: true }) : null) });
    const r = ssvc.onFollow({ broadcaster: user(1, sch), follower: user(40, 'late') }, meta);
    ssvc.onKicksGifted({ broadcaster: user(1, sch), sender: user(41, 'latetip'), gift: { amount: 10 }, created_at: '2026-09-11T14:00:00Z' }, meta);
    check('bonus spooled while database unavailable', r?.status === 'spooled', r);
    available = true;
    ssvc.db();
    await new Promise(r2 => setTimeout(r2, 100));
    check('spool replayed when database returns', balance(sch, 40) === 50 && balance(sch, 41) === 10);
    fs.writeFileSync(path.join(root, 'points', sch, 'pending-events.jsonl'), JSON.stringify({ type: 'follow', payload: { broadcaster: user(1, sch), follower: user(40, 'late') }, meta }) + '\n');
    available = false; ssvc.db(); available = true; ssvc.db();
    await new Promise(r2 => setTimeout(r2, 100));
    check('replaying twice stays idempotent', balance(sch, 40) === 50);
  }

  // Webhook poller
  {
    const ch = 'pollch';
    const dir = path.join(root, 'queue');
    fs.mkdirSync(dir, { recursive: true });
    writeConfig(root, ch, { enabled: true });
    const svc = makeService(ch);
    const calls = { chat: 0, follow: 0 };
    const poller = new WebhookPoller(ch, {
      chat: () => { calls.chat++; },
      follow: (e, m) => { calls.follow++; svc.onFollow(e, m); }
    }, dir);
    const now = Date.now();
    const lines = [
      { __event: 'channel.mystery.event', receivedAt: now, payload: { message_id: 'm1', sender: { username: 'x' }, content: 'hi' } },
      { __event: 'channel.followed', receivedAt: now, messageId: 'k1', payload: { broadcaster: { user_id: 1, username: ch }, follower: { user_id: 50, username: 'pollfan' } } },
      { __event: 'chat.message.sent', receivedAt: now, payload: { message_id: 'm2', sender: { user_id: 51, username: 'chatter' }, content: 'hello' } },
      { __event: 'channel.subscription.gifts', receivedAt: now, messageId: 'g1', payload: { broadcaster: { user_id: 1, username: ch }, gifter: { user_id: null, username: null, is_anonymous: true }, giftees: [{ user_id: 52, username: 'giftee' }] } }
    ];
    fs.writeFileSync(path.join(dir, `${ch}.jsonl`), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    poller.poll();
    check('unknown event never reaches chat', calls.chat === 1, calls);
    check('follow reaches its handler', calls.follow === 1, calls);
    const samples = fs.readFileSync(path.join(root, 'gift-samples.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    check('gifted subs keep a raw payload sample', samples.length === 1 && samples[0].messageId === 'g1' && samples[0].payload.gifter.is_anonymous === true, samples);
    const follow = JSON.stringify(lines[1]) + '\n';
    fs.writeFileSync(path.join(dir, `${ch}.jsonl.proc`), follow);
    poller.poll();
    fs.writeFileSync(path.join(dir, `${ch}.jsonl.proc`), follow);
    poller.poll();
    check('replayed .proc batch pays the follow once', calls.follow === 3 && balance(ch, 50) === 50, { calls, bal: balance(ch, 50) });
  }

  // Command
  {
    const ch = 'cmdch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    const svc = makeService(ch, { broadcaster: 999 });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 50, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'top', amount: 70, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 6, username: 'botrix', amount: 5000, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 8, username: 'poor', amount: 15, reason: 'mod_add', now: 1 });
    });
    const out: string[] = [];
    const client: ClientWrapper = { say: async (_c, m) => { out.push(m); } };
    const config = { channelName: ch } as ChannelConfig;
    const tags = (username: string, id: number, mod = false): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: id
    });
    const run = async (msg: string, t: KickTags) => { out.length = 0; await pointsCommand(client, msg, `#${ch}`, t, config); return out.slice(); };

    check('other triggers ignored', (await run('!points', tags('alice', 1))).length === 0);
    check('!don no longer triggers', (await run('!don', tags('alice', 1))).length === 0);
    const self = await run('$don', tags('alice', 1));
    check('balance with rank', self[0] === '@alice has 100 $DON, rank 1 of 4', self);
    const other = await run('$don @bob', tags('carol', 4));
    check('other user balance', other[0] === 'bob has 50 $DON, rank 3 of 4', other);
    const topList = await run('$don top', tags('mod1', 90, true));
    check('subcommand wins over a user named top', topList[0] === 'Top $DON · 1 alice 100 · 2 top 70 · 3 bob 50 · 4 poor 15', topList);
    const atTop = await run('$don @top', tags('dave', 5));
    check('@name forces a lookup', atTop[0] === 'top has 70 $DON, rank 2 of 4', atTop);
    const sentence = await run('$DON to the moon', tags('erin', 66));
    check('a sentence starting with $DON stays silent', sentence.length === 0, sentence);
    const ghost = await run('$don @ghost', tags('frank', 67));
    check('an unknown @name still gets a reply', ghost[0] === 'ghost has no $DON yet', ghost);
    const noRow = await run('$don', tags('newbie', 77));
    check('no balance yet', noRow[0] === '@newbie has no $DON yet', noRow);
    const cooled = await run('$don', tags('alice', 1));
    check('balance cooldown is silent', cooled.length === 0);

    const off = await run('$don give @bob 20', tags('alice', 1));
    check('give off by default', off[0] === '@alice giving $DON is turned off', off);
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', give: { enabled: true } });
    check('give minimum', (await run('$don give bob 5', tags('alice', 1)))[0] === '@alice the minimum is 10');
    check('give to self refused', (await run('$don give alice 20', tags('alice', 1)))[0] === '@alice you cannot give to yourself');
    check('give to unknown user', (await run('$don give ghost 20', tags('alice', 1)))[0] === '@alice I could not find ghost');
    check('give to a system bot refused', (await run('$don give botrix 20', tags('alice', 1)))[0] === '@alice botrix cannot receive $DON');
    const gave = await run('$don give 20 @bob', tags('alice', 1));
    check('give either argument order', gave[0] === '@alice gave 20 $DON to bob' && balance(ch, 1) === 80 && balance(ch, 2) === 70, gave);
    const again = await run('$don give bob 20', tags('alice', 1));
    check('give cooldown after success', /^@alice wait \d+s before giving again$/.test(again[0] ?? ''), again);
    const gave2 = await run('$don give bob 20', tags('top', 3));
    check('second giver unaffected by first cooldown', gave2[0] === '@top gave 20 $DON to bob', gave2);
    const broke = await run('$don give bob 60', tags('poor', 8));
    check('insufficient balance', broke[0] === '@poor you only have 15 $DON' && balance(ch, 8) === 15, broke);
    const none = await run('$don give bob 60', tags('newbie', 77));
    check('giver without a balance', none[0] === '@newbie you only have 0 $DON', none);

    check('non-mod add is silent', (await run('$don add bob 5', tags('carol', 4))).length === 0);
    // Only the broadcaster and the bot owner change balances; moderators can only read.
    const broadcasterTags: KickTags = { ...tags('cmdch', 999), isBroadcaster: true, isModUp: true };
    check('mod add is silent: mods can only read', (await run('$don add bob 5', tags('mod1', 90, true))).length === 0 && balance(ch, 2) === 90);
    check('mod set is silent', (await run('$don set @bob 1', tags('mod1', 90, true))).length === 0 && balance(ch, 2) === 90);
    check('broadcaster add', (await run('$don add bob 5', broadcasterTags))[0] === 'Added 5 $DON to bob, now 95');
    check('bot owner can remove', (await run('$don remove bob 1000', tags('ownerx', 91)))[0] === 'Removed 95 $DON from bob, now 0');
    check('broadcaster set', (await run('$don set @bob 7', broadcasterTags))[0] === 'bob now has 7 $DON');
    check('adjust needs a user and amount', (await run('$don add bob', tags('ownerx', 91)))[0] === 'Usage: $don add user amount');
    check('leaderboard link', (await run('$don leaderboard', tags('mod1', 90, true)))[0] === '$DON leaderboard https://example.test/kick/cmdch/leaderboard');
    const watch = await run('$don activetime', tags('bob', 2));
    check('no active time yet', watch[0] === '@bob has no active time yet', watch);
    check('old watchtime word is just an unknown name now', (await run('$don watchtime', tags('gina', 68))).length === 0);
    check('top by active time', (await run('$don top activetime', tags('mod1', 90, true)))[0] === 'No active time recorded yet');

    writeConfig(root, ch, { enabled: false, currencyName: '$DON' });
    check('disabled is silent', (await run('$don top', tags('mod1', 90, true))).length === 0);
    check('invariant holds (commands)', invariantViolations(db).length === 0, invariantViolations(db));
    void svc;
  }

  // Gamble
  {
    const ch = 'gamblech';
    const gambleOn = (extra: Record<string, unknown> = {}) =>
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', gamble: { enabled: true, cooldownSeconds: 0, ...extra } });
    gambleOn();
    // The next roll(s), replacing whatever is left: a replayed message still rolls before it's found to be a replay.
    const rolls: number[] = [];
    const setRoll = (...v: number[]) => { rolls.length = 0; rolls.push(...v); };
    let live: LiveState | null = { isLive: true, startedAt: null };
    const fresh = () => makeService(ch, { broadcaster: 999, random: () => rolls.shift() ?? 0.5, live: async () => live });
    let svc = fresh();
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 50, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'carol', amount: 30, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 4, username: 'dave', amount: 1000, reason: 'mod_add', now: 1 });
    });
    const config = { channelName: ch } as ChannelConfig;
    const t = (username: string, id: number, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, tags: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags, config);
      return out;
    };

    setRoll(0.1);
    const won = await run('$don gamble 40', t('alice', 1));
    check('gamble win adds the bet', won[0] === '@alice won 40 $DON and now has 140' && balance(ch, 1) === 140, won);
    const rows = db.prepare("SELECT reason, delta, ref FROM ledger WHERE user_id = 1 AND reason LIKE 'game:%' ORDER BY id").all() as Array<{ reason: string; delta: number; ref: string }>;
    check('a win writes stake and payout sharing a ref',
      rows.length === 2 && rows[0].delta === -40 && rows[1].delta === 80 && rows[0].ref === rows[1].ref && rows[0].ref.startsWith('gamble:'), rows);
    check('winnings do not count as lifetime earned', getUser(db, 1)?.lifetime_earned === 100, getUser(db, 1));

    setRoll(0.9);
    const lost = await run('$don gamble 50%', t('alice', 1));
    check('gamble 50% of the balance, loss takes the bet', lost[0] === '@alice lost 70 $DON and now has 70' && balance(ch, 1) === 70, lost);
    setRoll(0.2);
    const allWin = await run('$don gamble all', t('alice', 1));
    check('all in and won', allWin[0] === '@alice went all in and won, now has 140 $DON' && balance(ch, 1) === 140, allWin);
    setRoll(0.7);
    const allLose = await run('$DON GAMBLE ALL', t('bob', 2));
    check('all in and lost, any case', allLose[0] === '@bob went all in and lost 50 $DON' && balance(ch, 2) === 0, allLose);
    check('nothing to gamble', (await run('$don gamble 10', t('bob', 2)))[0] === '@bob you have no $DON to gamble');
    check('no row at all is nothing to gamble', (await run('$don gamble 10', t('newbie', 77)))[0] === '@newbie you have no $DON to gamble');
    check('bet over the balance', (await run('$don gamble 31', t('carol', 3)))[0] === '@carol you only have 30 $DON' && balance(ch, 3) === 30);
    check('missing amount gets usage', (await run('$don gamble', t('carol', 3)))[0] === 'Usage: $don gamble amount');
    for (const bad of ['abc', '101%', '0%', '-5', '1e3', '5x']) {
      check(`unreadable amount "${bad}" gets usage`, (await run(`$don gamble ${bad}`, t('carol', 3)))[0] === 'Usage: $don gamble amount');
    }
    setRoll(0.9);
    const k = await run('$don gamble 0.5k', t('dave', 4));
    check('0.5k reads as 500', k[0] === '@dave lost 500 $DON and now has 500', k);
    check('zero is under the minimum', (await run('$don gamble 0', t('carol', 3)))[0] === '@carol the minimum is 1');

    gambleOn({ minAmount: 10, maxAmount: 20 });
    check('gamble minimum', (await run('$don gamble 5', t('carol', 3)))[0] === '@carol the minimum is 10');
    check('gamble maximum', (await run('$don gamble 25', t('carol', 3)))[0] === '@carol the maximum is 20');
    check('refusals leave the balance alone', balance(ch, 3) === 30);

    gambleOn();
    setRoll(0.9);
    const r1 = await run('$don gamble 5', t('carol', 3, 'gmsg-1'));
    setRoll(0.1);
    const r2 = await run('$don gamble 5', t('carol', 3, 'gmsg-1'));
    check('replayed gamble message applies once, replay silent', r1.length === 1 && r2.length === 0 && balance(ch, 3) === 25, { r1, r2, bal: balance(ch, 3) });
    runWrite(db, () => creditTx(db, { userId: 9, username: 'eve', amount: 20, reason: 'mod_add', now: 1 }));
    setRoll(0.9);
    const e1 = await run('$don gamble all', t('eve', 9, 'gmsg-2'));
    const e2 = await run('$don gamble all', t('eve', 9, 'gmsg-2'));
    check('replay of an all-in loss stays silent', e1[0] === '@eve went all in and lost 20 $DON' && e2.length === 0 && balance(ch, 9) === 0, { e1, e2 });

    gambleOn({ cooldownSeconds: 60 });
    const bad = await run('$don gamble abc', t('carol', 3));
    setRoll(0.9);
    const first = await run('$don gamble 5', t('carol', 3));
    const second = await run('$don gamble 5', t('carol', 3));
    check('a failed gamble hands the cooldown back; cooldown is silent', bad.length === 1 && first.length === 1 && second.length === 0 && balance(ch, 3) === 20, { bad, first, second });

    gambleOn();
    live = { isLive: false, startedAt: null };
    svc = fresh();
    const offline = await run('$don gamble 5', t('dave', 4));
    check('offline gamble is silent and free', offline.length === 0 && balance(ch, 4) === 500, offline);
    live = null;
    svc = fresh();
    check('unknown live state counts as offline', (await run('$don gamble 5', t('dave', 4))).length === 0 && balance(ch, 4) === 500);
    gambleOn({ onlyWhileLive: false });
    setRoll(0.1);
    check('onlyWhileLive off allows gambling offline', (await run('$don gamble 5', t('dave', 4)))[0] === '@dave won 5 $DON and now has 505');
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', debugForceLive: true, gamble: { enabled: true, cooldownSeconds: 0 } });
    setRoll(0.9);
    check('debugForceLive counts as live for staging', (await run('$don gamble 5', t('dave', 4)))[0] === '@dave lost 5 $DON and now has 500');
    live = { isLive: true, startedAt: null };
    svc = fresh();

    gambleOn({ winChancePercent: 0 });
    setRoll(0);
    check('0% never wins, even on the lowest roll', /^@dave lost/.test((await run('$don gamble 5', t('dave', 4)))[0] ?? ''));
    gambleOn({ winChancePercent: 100 });
    setRoll(0.99999);
    check('100% always wins, even on the highest roll', /^@dave won/.test((await run('$don gamble 5', t('dave', 4)))[0] ?? ''));

    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    check('gambling off is silent', (await run('$don gamble 5', t('dave', 4))).length === 0 && balance(ch, 4) === 500);
    gambleOn();
    check('the bot account cannot gamble', (await run('$don gamble 5', t('thebotacct', 5))).length === 0);

    const stats = gambleStats(db);
    const expected = db.prepare("SELECT SUM(reason = 'game:gamble') AS g, SUM(reason = 'game:gamble_win') AS w, SUM(delta) AS net FROM ledger WHERE reason LIKE 'game:%'").get() as { g: number; w: number; net: number };
    check('gamble stats: 12 gambles, 4 wins, net matches the ledger',
      stats.gambles === 12 && stats.wins === 4 && stats.net === expected.net && stats.gambles === expected.g && stats.wins === expected.w, { stats, expected });
    check('summary carries gamble stats', pointsSummary(ch).gamble.allTime.gambles === 12);
    void svc;
    check('invariant holds (gamble)', invariantViolations(db).length === 0, invariantViolations(db));

    // Real randomness: 100,000 rolls at 50% across the channel land within a point of 50%.
    const realSvc = makeService('rollch');
    let wins = 0;
    for (let i = 0; i < 100_000; i++) if (realSvc.rollGamble(50).win) wins++;
    check('100,000 real rolls at 50% win 49–51%', wins > 49_000 && wins < 51_000, wins);
    let wins30 = 0;
    for (let i = 0; i < 100_000; i++) if (realSvc.rollGamble(30).win) wins30++;
    check('100,000 real rolls at 30% win 29–31%', wins30 > 29_000 && wins30 < 31_000, wins30);
    makeService(ch, { broadcaster: 999 });
  }

  // Duel
  {
    const ch = 'duelch';
    const duelOn = (extra: Record<string, unknown> = {}) =>
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', duel: { enabled: true, cooldownSeconds: 0, ...extra } });
    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    let roll = 0.5;
    let live: LiveState | null = { isLive: true, startedAt: null };
    const sent: string[] = [];
    const fresh = () => makeService(ch, { broadcaster: 999, sent, random: () => roll, live: async () => live });
    let svc = fresh();
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 1000, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 500, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'carol', amount: 300, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 4, username: 'dave', amount: 50, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 6, username: 'botrix', amount: 5000, reason: 'mod_add', now: 1 });
    });
    const config = { channelName: ch } as ChannelConfig;
    const t = (username: string, id: number, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, tags: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags, config);
      return out;
    };
    const bal = () => [1, 2, 3, 4].map(id => balance(ch, id)).join(',');

    check('duels off by default are silent', (await run('$don duel @bob 100', t('alice', 1))).length === 0 && bal() === '1000,500,300,50');
    duelOn();
    check('duel usage without a name or amount', (await run('$don duel', t('alice', 1)))[0] === 'Usage: $don duel @user amount'
      && (await run('$don duel @bob', t('alice', 1)))[0] === 'Usage: $don duel @user amount'
      && (await run('$don duel @bob abc', t('alice', 1)))[0] === 'Usage: $don duel @user amount');
    check('cannot duel yourself', (await run('$don duel @alice 10', t('alice', 1)))[0] === '@alice you cannot duel yourself');
    check('cannot duel a system bot', (await run('$don duel @botrix 10', t('alice', 1)))[0] === '@alice you cannot duel botrix');
    check('cannot duel an unknown viewer', (await run('$don duel ghost 10', t('alice', 1)))[0] === '@alice you cannot duel ghost');
    check('opponent must be able to match', (await run('$don duel @dave 100', t('alice', 1)))[0] === '@alice dave only has 50 $DON' && bal() === '1000,500,300,50');
    check('challenger must cover the stake', (await run('$don duel @alice 60', t('dave', 4)))[0] === '@dave you only have 50 $DON');

    const challenge = await run('$don duel @bob 100', t('alice', 1));
    check('challenge holds the stake and tells the opponent',
      challenge[0] === '@bob alice challenges you to a duel for 100 $DON, type $don accept or $don deny within 2 min' && bal() === '900,500,300,50', challenge);
    check('one pending challenge per challenger', (await run('$don duel @carol 10', t('alice', 1)))[0] === '@alice you already challenged bob, $don cancel first');
    const second = await run('$don duel 50% @bob', t('carol', 3));
    check('amount before @name, 50% of the challenger', /for 150 \$DON/.test(second[0] ?? '') && balance(ch, 3) === 150, second);
    check('several incoming: bare accept asks to pick', (await run('$don accept', t('bob', 2)))[0] === '@bob pick one: $don accept @alice or @carol');
    check('deny by name refunds', (await run('$don deny @carol', t('bob', 2)))[0] === '@carol bob declined the duel, 150 $DON refunded' && balance(ch, 3) === 300);
    check('accept by an unknown name', (await run('$don accept @dave', t('bob', 2)))[0] === '@bob dave has not challenged you');

    roll = 0.1; // below 5000: the challenger wins
    const won = await run('$don accept', t('bob', 2));
    check('accept: challenger wins both stakes', won[0] === 'alice won the duel against bob and takes 100 $DON, now has 1100' && bal() === '1100,400,300,50', won);
    check('nothing left to accept', (await run('$don accept', t('bob', 2)))[0] === '@bob you have no duel to accept');
    const rows = db.prepare("SELECT reason, delta FROM ledger WHERE reason LIKE 'game:duel%' ORDER BY id").all() as Array<{ reason: string; delta: number }>;
    check('duel ledger: hold, hold, refund, stake, win', rows.map(r => `${r.reason.slice(10)}${r.delta}`).join(' ') === 'hold-100 hold-150 refund150 stake-100 win200', rows);

    check('challenge then cancel refunds', (await run('$don duel @bob 100', t('carol', 3))).length === 1
      && (await run('$don cancel', t('carol', 3)))[0] === '@carol duel cancelled, 100 $DON refunded' && balance(ch, 3) === 300);
    check('nothing to cancel', (await run('$don cancel', t('carol', 3)))[0] === '@carol you have no duel to cancel');

    await run('$don duel @dave 50', t('carol', 3));
    runWrite(db, () => debitTx(db, { userId: 4, amount: 40, reason: 'mod_remove', now: Date.now() }));
    check('opponent short at accept: reply, duel stays pending',
      (await run('$don accept', t('dave', 4)))[0] === '@dave you only have 10 $DON' && !!outgoingDuel(db, 3) && balance(ch, 3) === 250);

    db.prepare("UPDATE duels SET expires_at = ? WHERE status = 'pending'").run(Date.now() - 1);
    sent.length = 0;
    const swept = svc.sweepDuels();
    check('expiry refunds and says so', swept === 1 && sent[0] === "@carol dave didn't answer, 50 $DON refunded" && balance(ch, 3) === 300, { swept, sent });
    check('a second sweep finds nothing', svc.sweepDuels() === 0);

    const raced = createDuel(db, { challengerId: 1, opponentId: 2, amount: 10, expiresAt: Date.now() + 60_000, actor: 'test', now: Date.now() });
    const id = raced.ok ? raced.duel.id : '';
    const refunded = refundDuel(db, { id, status: 'expired', actor: 'test', now: Date.now() });
    const late = acceptDuel(db, { id, challengerWins: true, actor: 'test', now: Date.now() });
    check('accept after expiry is gone; refunded once', !!refunded && !late.ok && late.reason === 'gone' && refundDuel(db, { id, status: 'denied', actor: 'test', now: Date.now() }) === null && balance(ch, 1) === 1100, late);

    createDuel(db, { challengerId: 1, opponentId: 3, amount: 20, expiresAt: Date.now() - 1, actor: 'test', now: Date.now() - 120_000 });
    svc = fresh(); // a restarted bot: the pending duel is only in the database
    check('the stake is held while the bot is down', balance(ch, 1) === 1080);
    check('after a restart, a duel that expired meanwhile is refunded', svc.sweepDuels() === 1 && balance(ch, 1) === 1100);

    roll = 0.9; // at or above 5000: the opponent wins
    const c1 = await run('$don duel @bob 30', t('alice', 1, 'dmsg-1'));
    const c2 = await run('$don duel @bob 30', t('alice', 1, 'dmsg-1'));
    const a1 = await run('$don accept', t('bob', 2, 'dmsg-2'));
    const a2 = await run('$don accept', t('bob', 2, 'dmsg-2'));
    check('replayed challenge and accept act once', c1.length === 1 && c2.length === 0 && a2.length === 0
      && a1[0] === 'bob won the duel against alice and takes 30 $DON, now has 430' && bal() === '1070,430,300,10', { c1, c2, a1, a2, bal: bal() });

    live = { isLive: false, startedAt: null };
    svc = fresh();
    check('offline challenge is silent and holds nothing', (await run('$don duel @bob 10', t('carol', 3))).length === 0 && balance(ch, 3) === 300);
    live = { isLive: true, startedAt: null };
    svc = fresh();
    await run('$don duel @bob 10', t('alice', 1));
    live = null;
    svc = fresh();
    check('accept while live state is unknown is silent, duel stays pending', (await run('$don accept', t('bob', 2))).length === 0 && !!outgoingDuel(db, 1));
    check('cancel works offline', (await run('$don cancel', t('alice', 1)))[0] === '@alice duel cancelled, 10 $DON refunded' && balance(ch, 1) === 1070);
    live = { isLive: true, startedAt: null };
    svc = fresh();

    duelOn({ cooldownSeconds: 60, minAmount: 5, maxAmount: 200 });
    check('duel minimum and maximum', (await run('$don duel @bob 1', t('carol', 3)))[0] === '@carol the minimum is 5'
      && (await run('$don duel @bob 201', t('carol', 3)))[0] === '@carol the maximum is 200');
    const cd1 = await run('$don duel @bob 10', t('carol', 3));
    await run('$don cancel', t('carol', 3));
    const cd2 = await run('$don duel @bob 10', t('carol', 3));
    check('failed challenges hand the cooldown back; cooldown is silent', cd1.length === 1 && cd2.length === 0 && balance(ch, 3) === 300, { cd1, cd2 });

    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    check('accept with duels off is silent', (await run('$don accept', t('bob', 2))).length === 0);

    check('refunds and wins do not count as lifetime earned', getUser(db, 1)?.lifetime_earned === 1000 && getUser(db, 2)?.lifetime_earned === 500);
    const ds = duelStats(db);
    check('duel stats: 2 played, 260 staked, none pending', ds.duels === 2 && ds.staked === 260 && ds.pending === 0, ds);
    check('summary carries duel stats', pointsSummary(ch).duel.allTime.duels === 2);
    check('invariant holds (duel)', invariantViolations(db).length === 0, invariantViolations(db));

    // v1 → latest migration on an existing database keeps its rows. Every table a
    // later version adds is dropped, so this really starts from v1 rather than
    // replaying a step whose tables are already there.
    const mch = 'migrate1ch';
    const mdb = openPointsDb(mch, { create: true })!;
    runWrite(mdb, () => creditTx(mdb, { userId: 1, username: 'old', amount: 77, reason: 'mod_add', now: 1 }));
    mdb.exec('DROP TABLE duels; DROP TABLE raffle_entries; DROP TABLE raffles; DROP INDEX ledger_ref');
    mdb.pragma('user_version = 1');
    closePointsDb(mch);
    const reopened = openPointsDb(mch, { create: false })!;
    const hasTable = (n: string) => !!reopened.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(n);
    check('a v1 database migrates to the latest version keeping balances',
      reopened.pragma('user_version', { simple: true }) === 4 && balance(mch, 1) === 77
      && hasTable('duels') && hasTable('raffles') && hasTable('raffle_entries'));

    // v2 → v3 specifically: a database that already has duels gains the raffle tables.
    const m2 = 'migrate2ch';
    const m2db = openPointsDb(m2, { create: true })!;
    runWrite(m2db, () => creditTx(m2db, { userId: 1, username: 'old2', amount: 42, reason: 'mod_add', now: 1 }));
    m2db.exec('DROP TABLE raffle_entries; DROP TABLE raffles; DROP INDEX ledger_ref');
    m2db.pragma('user_version = 2');
    closePointsDb(m2);
    const re2 = openPointsDb(m2, { create: false })!;
    check('a v2 database gains the raffle tables and keeps its balances',
      re2.pragma('user_version', { simple: true }) === 4 && balance(m2, 1) === 42
      && !!re2.prepare("SELECT 1 FROM sqlite_master WHERE name = 'raffles'").get());
    void svc;
    makeService(ch, { broadcaster: 999 });
  }

  // Ledger counterparty: the log names the other side of a give or a duel
  {
    const ch = 'cpartych';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', give: { enabled: true }, duel: { enabled: true } });
    const cfg = effectivePointsConfig({ enabled: true, currencyName: '$DON' });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'giver', amount: 500, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'taker', amount: 500, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'bystander', amount: 500, reason: 'mod_add', now: 1 });
    });

    transfer(db, { fromId: 1, toId: 2, toName: 'taker', amount: 40, actor: 'chat:giver', now: 100 });
    const rowsOf = (id: number) => getPointsUserDetail(ch, cfg, id)!.ledger;
    const give = rowsOf(1).find(r => r.reason === 'give_out')!;
    const recv = rowsOf(2).find(r => r.reason === 'give_in')!;
    check('a give names the recipient on the giver\'s row', give.counterparty === 'taker', give);
    check('and names the giver on the recipient\'s row', recv.counterparty === 'giver', recv);

    // A gamble is the viewer against the house: both rows are theirs, so nobody to name.
    gamble(db, { userId: 3, amount: 10, win: true, actor: 'chat:bystander', now: 110 });
    check('a gamble has no counterparty',
      rowsOf(3).filter(r => r.reason.startsWith('game:gamble')).every(r => r.counterparty === null),
      rowsOf(3).filter(r => r.reason.startsWith('game:gamble')));

    // An unanswered duel has only the challenger's hold — no second side yet.
    const pending = createDuel(db, { challengerId: 1, opponentId: 3, amount: 25, expiresAt: Date.now() + 60_000, actor: 'chat:giver', now: 120 });
    check('an unanswered duel names nobody', rowsOf(1).find(r => r.reason === 'game:duel_hold')!.counterparty === null);

    // Once accepted, both sides have a row under the same ref.
    acceptDuel(db, { id: pending.ok ? pending.duel.id : '', challengerWins: true, actor: 'chat:bystander', now: 130 });
    check('an accepted duel names the opponent',
      rowsOf(1).find(r => r.reason === 'game:duel_win')!.counterparty === 'bystander'
      && rowsOf(3).find(r => r.reason === 'game:duel_stake')!.counterparty === 'giver');

    check('a row with no ref, like a mod adjustment, names nobody',
      rowsOf(1).find(r => r.reason === 'mod_add')!.counterparty === null);
  }

  // A channel's hype emote rides along on a gamble win, never on a loss
  {
    const ch = 'emotech';
    const sent: string[] = [];
    let roll = 0;
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', gamble: { enabled: true, winEmote: 'GAMBA', loseEmote: 'poor', onlyWhileLive: false, cooldownSeconds: 0 } });
    const svc = makeService(ch, { sent, random: () => roll, live: async () => ({ isLive: true, startedAt: null }) });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 }));
    const config = { channelName: ch } as ChannelConfig;
    const t = (username: string, id: number, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, tags: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags, config);
      return out;
    };

    roll = 0.1; // below the 50% threshold: a win
    check('a win carries the emote', (await run('$don gamble 10', t('alice', 1)))[0] === '@alice won 10 $DON and now has 110 GAMBA');
    roll = 0.9; // a loss
    check('a loss carries its own', (await run('$don gamble 10', t('alice', 1, 'm2')))[0] === '@alice lost 10 $DON and now has 100 poor');
    roll = 0.1;
    check('an all-in win carries it too', (await run('$don gamble all', t('alice', 1, 'm3')))[0] === '@alice went all in and won, now has 200 $DON GAMBA');

    // A channel that sets no emote reads exactly as before.
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', gamble: { enabled: true, onlyWhileLive: false, cooldownSeconds: 0 } });
    makeService(ch, { sent, random: () => roll, live: async () => ({ isLive: true, startedAt: null }) });
    check('no emote configured leaves the reply unchanged',
      (await run('$don gamble 10', t('alice', 1, 'm4')))[0] === '@alice won 10 $DON and now has 210');
    roll = 0.9;
    check('and a loss is unchanged too',
      (await run('$don gamble 10', t('alice', 1, 'm5')))[0] === '@alice lost 10 $DON and now has 200');
    roll = 0.1;

    // Junk never reaches chat.
    check('a bad emote falls back rather than posting markup',
      effectivePointsConfig({ gamble: { winEmote: 'GAM BA]' } }).gamble.winEmote === ''
      && validatePointsPatch({}, { gamble: { winEmote: 'oops [x]' } }).errors.length === 1);
    void svc;
  }

  // Raffles: moderator-only to open, free to enter, capped three ways
  {
    const ch = 'raffch';
    const sent: string[] = [];
    let live: LiveState | null = { isLive: true, startedAt: null };
    let pick = 0;
    const base = { enabled: true, pointsPerInterval: 5, currencyName: '$DON' };
    const raffleOn = (extra: Record<string, unknown> = {}) =>
      writeConfig(root, ch, { ...base, raffle: { enabled: true, maxPrize: 1000, maxPerStream: 2, maxDurationSeconds: 300, defaultDurationSeconds: 120, winners: 3, ...extra } });
    writeConfig(root, ch, base);
    const fresh = () => makeService(ch, { sent, random: () => pick, live: async () => live });
    let svc = fresh();
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      for (const [id, name] of [[1, 'alice'], [2, 'bob'], [3, 'carol'], [4, 'dave']] as Array<[number, string]>) {
        creditTx(db, { userId: id, username: name, amount: 100, reason: 'mod_add', now: 1 });
      }
    });
    const config = { channelName: ch } as ChannelConfig;
    const t = (username: string, id: number, mod = false, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, tags: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags, config);
      return out;
    };
    const bal = () => [1, 2, 3, 4].map(id => balance(ch, id)).join(',');

    check('raffles off by default are silent', (await run('$don raffle 100', t('alice', 1, true))).length === 0);
    raffleOn();
    svc = fresh();
    check('a viewer cannot open a raffle', (await run('$don raffle 100', t('alice', 1))).length === 0);
    check('prize above the cap is refused', (await run('$don raffle 5000', t('alice', 1, true)))[0] === '@alice the biggest prize is 1000 $DON');
    check('a run longer than the cap is refused', (await run('$don raffle 100 999', t('alice', 1, true)))[0] === '@alice a raffle can run for at most 300s');
    check('a prize that is not a number is usage', (await run('$don raffle abc', t('alice', 1, true)))[0] === 'Usage: $don raffle prize [seconds]');

    const opened = await run('$don raffle 100 60', t('alice', 1, true));
    check('a moderator opens it and chat is told how to enter',
      opened[0] === 'Raffle open — 100 $DON split 3 ways, type $don join within 1 min', opened);
    check('a second raffle while one runs is refused',
      (await run('$don raffle 50', t('alice', 1, true)))[0] === '@alice a raffle is already running, $don raffle cancel to stop it');

    check('joining is silent and free', (await run('$don join', t('bob', 2))).length === 0 && bal() === '100,100,100,100');
    await run('$don join', t('bob', 2));
    await run('$don join', t('carol', 3));
    check('a viewer gets one ticket however often they join', raffleEntries(db, openRaffle(db)!.id).length === 2);

    // Two entrants, three winner slots: everyone wins and the odd point goes first.
    const open1 = openRaffle(db)!;
    db.prepare('UPDATE raffles SET closes_at = ? WHERE id = ?').run(Date.now() - 1, open1.id);
    check('the sweep draws it and pays the whole prize',
      svc.sweepRaffles() === 1 && balance(ch, 2) + balance(ch, 3) === 200 + 100, bal());
    check('the draw is announced with the entry count', /^Raffle drawn from 2 entries/.test(sent[sent.length - 1]), sent[sent.length - 1]);
    check('a drawn raffle is not drawn twice', svc.sweepRaffles() === 0);

    // sraffle: one winner takes it all.
    const before = bal();
    await run('$don sraffle 60 60', t('alice', 1, true));
    await run('$don join', t('bob', 2));
    await run('$don join', t('carol', 3));
    pick = 0; // first entrant
    const open2 = openRaffle(db)!;
    check('sraffle draws a single winner', open2.winners === 1);
    db.prepare('UPDATE raffles SET closes_at = ? WHERE id = ?').run(Date.now() - 1, open2.id);
    svc.sweepRaffles();
    check('the single winner takes the whole prize', balance(ch, 2) === Number(before.split(',')[1]) + 60, { before, after: bal() });

    check('the per-stream allowance is spent', (await run('$don raffle 10', t('alice', 1, true)))[0] === "@alice that's all 2 raffles for this stream");

    // A cancelled raffle pays nobody and does not count against the allowance.
    writeConfig(root, ch, { ...base, raffle: { enabled: true, maxPrize: 1000, maxPerStream: 5, maxDurationSeconds: 300, defaultDurationSeconds: 120, winners: 3 } });
    svc = fresh();
    await run('$don raffle 100 60', t('alice', 1, true));
    await run('$don join', t('dave', 4));
    const held = bal();
    check('cancel closes it and pays nobody',
      (await run('$don raffle cancel', t('alice', 1, true)))[0] === 'Raffle cancelled by alice, no $DON paid' && bal() === held);
    check('cancelling with none open says so', (await run('$don raffle cancel', t('alice', 1, true)))[0] === '@alice no raffle is open');
    check('join with no raffle open is silent', (await run('$don join', t('dave', 4))).length === 0);

    // Offline, and a raffle that closed while the bot was down.
    live = { isLive: false, startedAt: null };
    svc = fresh();
    check('opening while offline is silent', (await run('$don raffle 100', t('alice', 1, true))).length === 0);
    live = { isLive: true, startedAt: null };
    svc = fresh();
    await run('$don raffle 40 60', t('alice', 1, true));
    await run('$don join', t('dave', 4));
    db.prepare("UPDATE raffles SET closes_at = ? WHERE status = 'open'").run(Date.now() - 1);
    const daveBefore = balance(ch, 4);
    svc = fresh(); // a restarted bot: the open raffle is only in the database
    check('a raffle that closed while the bot was down is drawn on the next sweep',
      svc.sweepRaffles() === 1 && balance(ch, 4) === daveBefore + 40);

    // Nobody entered: the raffle still closes, and nothing is minted.
    await run('$don raffle 70 60', t('alice', 1, true));
    db.prepare("UPDATE raffles SET closes_at = ? WHERE status = 'open'").run(Date.now() - 1);
    const beforeEmpty = bal();
    check('an empty raffle closes without paying',
      svc.sweepRaffles() === 1 && bal() === beforeEmpty && /nobody entered/.test(sent[sent.length - 1]), sent[sent.length - 1]);
  }

  // Dashboard API
  {
    const ch = 'cmdch';
    const cfg = effectivePointsConfig({ enabled: true, currencyName: '$DON' });
    const sum = pointsSummary(ch);
    check('summary counts users', sum.dbAvailable && sum.users === 5, sum);
    const found = searchPointsUsers(ch, cfg, 'b', 10, 999);
    check('prefix search', found.map(u => u.username).join(',') === 'bob,botrix', found);
    check('excluded account ranks 0', found.find(u => u.username === 'botrix')?.rank === 0);
    const a1 = adjustPoints(ch, cfg, { userId: 2, mode: 'add', amount: 10, reason: 'giveaway', actor: 'dashboard:alice:manager', requestId: 'req-1' }, 999);
    const a2 = adjustPoints(ch, cfg, { userId: 2, mode: 'add', amount: 10, reason: 'giveaway', actor: 'dashboard:alice:manager', requestId: 'req-1' }, 999);
    check('adjust applies once per requestId', 'applied' in a1 && a1.applied && 'applied' in a2 && !a2.applied && balance(ch, 2) === 17, { a1, a2 });
    const clamp = adjustPoints(ch, cfg, { userId: 2, mode: 'remove', amount: 500, reason: 'cleanup', actor: 'd', requestId: 'req-2' });
    check('dashboard remove clamps at 0', 'user' in clamp && clamp.user.balance === 0, clamp);
    check('adjust unknown user is 404', (adjustPoints(ch, cfg, { userId: 12345, mode: 'add', amount: 1, reason: 'abc', actor: 'd', requestId: 'r3' }) as { status: number }).status === 404);
    check('adjust short reason is 400', (adjustPoints(ch, cfg, { userId: 2, mode: 'add', amount: 1, reason: 'x', actor: 'd', requestId: 'r4' }) as { status: number }).status === 400);
    const detail = getPointsUserDetail(ch, cfg, 2, 999);
    check('user detail with ledger', !!detail && detail.ledger[0]?.reason === 'dash_remove' && detail.ledger[0]?.note === 'cleanup', detail?.ledger.slice(0, 2));
    const lb = pointsLeaderboard(ch, cfg, 100, 999);
    check('leaderboard excludes system bots', !lb.points.some(r => r.username === 'botrix') && lb.points[0]?.username === 'alice', lb.points);
    const bk = await backupPoints(ch);
    check('backup written', !!bk && fs.existsSync(bk));
    check('summary for a channel without a database', pointsSummary('nodb').users === 0 && !fs.existsSync(path.join(root, 'points', 'nodb')));
    check('invariant holds (dashboard)', invariantViolations(openPointsDb(ch, { create: true })!).length === 0);
  }

  // Review fixes
  {
    const ch = 'fixch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', give: { enabled: true, cooldownSeconds: 0 } });
    const lookups: Record<string, number> = { '12345': 500, slowguy: 501, slowgal: 502 };
    const svc = makeService(ch, {
      broadcaster: 999,
      lookup: async n => { await new Promise(r => setTimeout(r, 30)); return lookups[n] ?? null; }
    });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 50, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'racer', amount: 100, reason: 'mod_add', now: 1 });
    });
    const config = { channelName: ch } as ChannelConfig;
    const tagsFor = (username: string, id: number, mod = false, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, t: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, config);
      return out;
    };

    const add1 = await run('$don add bob 5', tagsFor('ownerx', 91, false, 'msg-a'));
    const add2 = await run('$don add bob 5', tagsFor('ownerx', 91, false, 'msg-a'));
    check('replayed owner add applies once, replay silent', add1.length === 1 && add2.length === 0 && balance(ch, 2) === 55, { add1, add2, bal: balance(ch, 2) });
    const give1 = await run('$don give bob 10', tagsFor('alice', 1, false, 'msg-b'));
    const give2 = await run('$don give bob 10', tagsFor('alice', 1, false, 'msg-b'));
    check('replayed give applies once, replay silent', /gave 10/.test(give1[0] ?? '') && give2.length === 0 && balance(ch, 1) === 90 && balance(ch, 2) === 65, { give1, give2 });

    const num = await run('$don add 12345 7', tagsFor('ownerx', 91));
    check('all-digit username read by position', num[0] === 'Added 7 $DON to 12345, now 7', num);
    const swapped = await run('$don add 8 @bob', tagsFor('ownerx', 91));
    check('@name marks the name in either order', swapped[0] === 'Added 8 $DON to bob, now 73', swapped);

    writeConfig(root, ch, { enabled: true, currencyName: '$DON', give: { enabled: true, cooldownSeconds: 30 } });
    const [r1, r2] = await Promise.all([run('$don give slowguy 10', tagsFor('racer', 3)), run('$don give slowgal 10', tagsFor('racer', 3))]);
    const gaveCount = [r1, r2].filter(o => /gave 10/.test(o[0] ?? '')).length;
    check('concurrent gives respect the cooldown', gaveCount === 1 && balance(ch, 3) === 90, { r1, r2, bal: balance(ch, 3) });
    const miss = await run('$don give ghost 10', tagsFor('alice', 1));
    const after = await run('$don give bob 10', tagsFor('alice', 1));
    check('failed give hands the cooldown back', /could not find/.test(miss[0] ?? '') && /gave 10/.test(after[0] ?? ''), { miss, after });

    runWrite(db, () => {
      creditTx(db, { userId: 10, username: 'a_b_c_d_e', amount: 5000, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 11, username: 'f_g_h_i_j', amount: 4000, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 12, username: 'k_l_m', amount: 3000, reason: 'mod_add', now: 1 });
    });
    const top = (await run('$don top', tagsFor('mod1', 90, true)))[0] ?? '';
    const symbols = (top.match(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g) ?? []).length;
    check('top drops entries instead of mangling names past 10 symbols', top === 'Top $DON · 1 a_b_c_d_e 5000 · 2 f_g_h_i_j 4000' && symbols <= 10, { top, symbols });

    const renewal = (expires: string) => ({ subscriber: { user_id: 20, username: 'subber' }, created_at: '2026-01-01T00:00:00Z', expires_at: expires, duration: 1 }) as never;
    svc.onSubscriptionRenewal(renewal('2026-10-01T00:00:00Z'), { ageMs: 0 });
    svc.onSubscriptionRenewal(renewal('2026-11-01T00:00:00Z'), { ageMs: 0 });
    svc.onSubscriptionRenewal(renewal('2026-11-01T00:00:00Z'), { ageMs: 0 });
    check('renewals sharing created_at pay once per billing period', balance(ch, 20) === 1000, balance(ch, 20));

    const leftover = path.join(root, 'points', ch, 'pending-events.jsonl.replay');
    fs.writeFileSync(leftover, JSON.stringify({ type: 'follow', payload: { follower: { user_id: 30, username: 'crashfollow' } }, meta: { ageMs: 0 }, at: 1 }) + '\n');
    const svc2 = makeService(ch, { broadcaster: 999 });
    svc2.db();
    await new Promise(r => setImmediate(r));
    check('leftover replay file from a crash is processed', balance(ch, 30) === 50 && !fs.existsSync(leftover), balance(ch, 30));

    openPointsDb('quarch', { create: true });
    reportDbError('quarch', Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }));
    const marker = path.join(root, 'points', 'quarch', 'points.sqlite.quarantined');
    const refused = await runChild('opencheck', root, 0);
    check('quarantine marker makes another process refuse without creating a file',
      fs.existsSync(marker) && refused === 3 && !fs.existsSync(path.join(root, 'points', 'quarch', 'points.sqlite')), { refused });

    const codes = await Promise.all([1, 2, 3, 4].map(i => runChild('opencreate', root, i)));
    check('concurrent first opens migrate cleanly', codes.every(c => c === 0), codes);
  }

  // Give amounts: the same forms as gamble, against the giver's balance
  {
    const ch = 'givech';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', give: { enabled: true, cooldownSeconds: 0 } });
    makeService(ch, { broadcaster: 999 });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 10, reason: 'mod_add', now: 1 });
    });
    const config = { channelName: ch } as ChannelConfig;
    const t = (username: string, id: number, messageId?: string): KickTags => ({
      username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id, messageId
    });
    const run = async (msg: string, tags: KickTags) => {
      const out: string[] = [];
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags, config);
      return out;
    };
    const bal = () => `${balance(ch, 1)},${balance(ch, 2)}`;

    check('give 50%', (await run('$don give bob 50%', t('alice', 1)))[0] === '@alice gave 50 $DON to bob' && bal() === '50,60', bal());
    check('give all, amount before @name', (await run('$don give all @bob', t('alice', 1)))[0] === '@alice gave 50 $DON to bob' && bal() === '0,110', bal());
    check('give 0.05k, amount after a bare name', (await run('$don give alice 0.05k', t('bob', 2)))[0] === '@bob gave 50 $DON to alice' && bal() === '50,60', bal());
    check('give all without a balance', (await run('$don give alice all', t('newbie', 77)))[0] === '@newbie you only have 0 $DON');
    check('give with an unreadable amount', (await run('$don give alice abc', t('bob', 2)))[0] === 'Usage: $don give user amount'
      && (await run('$don give alice 200%', t('bob', 2)))[0] === 'Usage: $don give user amount');
    check('give a percentage under the minimum', (await run('$don give alice 5%', t('bob', 2)))[0] === '@bob the minimum is 10');
    const g1 = await run('$don give bob all', t('alice', 1, 'gv-1'));
    const g2 = await run('$don give bob all', t('alice', 1, 'gv-1'));
    check('replayed give all acts once and stays silent', g1[0] === '@alice gave 50 $DON to bob' && g2.length === 0 && bal() === '0,110', { g1, g2, bal: bal() });
    check('invariant holds (give amounts)', invariantViolations(db).length === 0, invariantViolations(db));
  }

  // ─── Timeout penalties ──────────────────────────────────────────────────
  {
    const ch = 'pench';
    const sent: string[] = [];
    writeConfig(root, ch, {
      enabled: true, currencyName: '$DON',
      timeoutPenalty: { enabled: true, pointsPerSecond: 1, announce: true }
    });
    const svc = makeService(ch, { broadcaster: 999, sent });
    const db = svc.db()!;

    const ban = (userId: number, username: string, seconds: number | null, createdAt: string) => ({
      broadcaster: { user_id: 999, username: ch },
      moderator: { user_id: 5, username: 'amod' },
      banned_user: { user_id: userId, username },
      metadata: {
        created_at: createdAt,
        expires_at: seconds === null ? null : new Date(Date.parse(createdAt) + seconds * 1000).toISOString()
      }
    });

    runWrite(db, () => creditTx(db, { userId: 101, username: 'richguy', amount: 5000, reason: 'test', now: Date.now() }));
    svc.onBan(ban(101, 'richguy', 120, '2026-09-13T00:00:00.000Z'));
    check('a 120s timeout costs 120 at 1/second', balance(ch, 101) === 4880, balance(ch, 101));
    check('the deduction is announced once', sent.filter(m => m.includes('richguy')).length === 1, sent);

    // The same webhook again: Kick re-delivers, and the bot replays its queue.
    svc.onBan(ban(101, 'richguy', 120, '2026-09-13T00:00:00.000Z'));
    check('the same ban event charges only once', balance(ch, 101) === 4880, balance(ch, 101));

    // A second, different timeout on the same viewer must still charge.
    svc.onBan(ban(101, 'richguy', 60, '2026-09-13T00:05:00.000Z'));
    check('a later timeout on the same viewer charges again', balance(ch, 101) === 4820, balance(ch, 101));

    runWrite(db, () => creditTx(db, { userId: 102, username: 'brokeguy', amount: 40, reason: 'test', now: Date.now() }));
    svc.onBan(ban(102, 'brokeguy', 600, '2026-09-13T00:00:00.000Z'));
    check('a penalty larger than the balance takes what is there, never negative', balance(ch, 102) === 0, balance(ch, 102));

    runWrite(db, () => creditTx(db, { userId: 103, username: 'rouletteguy', amount: 1000, reason: 'test', now: Date.now() }));
    svc.onBan({ ...ban(103, 'rouletteguy', 120, '2026-09-13T00:00:00.000Z'), moderator: { user_id: 83432826, username: 'MrAIisHere' } });
    check('a reward timeout issued by the bot is charged like any other', balance(ch, 103) === 880, balance(ch, 103));

    runWrite(db, () => creditTx(db, { userId: 104, username: 'permaguy', amount: 800, reason: 'test', now: Date.now() }));
    svc.onBan(ban(104, 'permaguy', null, '2026-09-13T00:00:00.000Z'));
    check('a permanent ban costs nothing while permanentBanCost is 0', balance(ch, 104) === 800, balance(ch, 104));

    // The broadcaster is excluded from earning, so they are excluded from losing.
    runWrite(db, () => creditTx(db, { userId: 999, username: ch, amount: 500, reason: 'test', now: Date.now() }));
    svc.onBan(ban(999, ch, 120, '2026-09-13T00:00:00.000Z'));
    check('an excluded user is not charged', balance(ch, 999) === 500, balance(ch, 999));

    // Rate and cap.
    writeConfig(root, ch, {
      enabled: true, currencyName: '$DON',
      timeoutPenalty: { enabled: true, pointsPerSecond: 2, maxDeduction: 100, announce: false }
    });
    const svc2 = makeService(ch, { broadcaster: 999, sent });
    runWrite(db, () => creditTx(db, { userId: 105, username: 'cappedguy', amount: 5000, reason: 'test', now: Date.now() }));
    svc2.onBan(ban(105, 'cappedguy', 300, '2026-09-13T00:00:00.000Z'));
    check('maxDeduction caps a long timeout', balance(ch, 105) === 4900, balance(ch, 105));

    // Off by default.
    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    const svc3 = makeService(ch, { broadcaster: 999 });
    runWrite(db, () => creditTx(db, { userId: 106, username: 'safeguy', amount: 300, reason: 'test', now: Date.now() }));
    svc3.onBan(ban(106, 'safeguy', 120, '2026-09-13T00:00:00.000Z'));
    check('no penalty when timeoutPenalty is off', balance(ch, 106) === 300, balance(ch, 106));
  }

  closeAllPointsDbs();
  console.log(`\n[selftest] ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(failures.map(f => `  - ${f}`).join('\n'));
    process.exitCode = 1;
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') {
  child(process.argv[3], process.argv[4], Number(process.argv[5])).catch(err => { console.error(err); process.exit(1); });
} else {
  main().catch(err => { console.error(err); process.exit(1); });
}
