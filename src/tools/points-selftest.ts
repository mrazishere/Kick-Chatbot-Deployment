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
import { closeAllPointsDbs, openPointsDb, PointsDb, reportDbError, runWrite } from '../points/db';
import { LiveState } from '../points/live';
import { PointsService } from '../points/service';
import { normalizeChat, presenceVerdict } from '../points/presence-rules';
import {
  adjustPoints, backupPoints, creditTx, debitTx, getUser, grantTick, invariantViolations,
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

function makeService(channel: string, opts: { live?: () => Promise<LiveState | null>; now?: () => number; broadcaster?: number | null; dbProvider?: () => PointsDb | null; lookup?: (n: string) => Promise<number | null>; sent?: string[] } = {}) {
  return new PointsService({
    channelName: channel,
    getBroadcasterUserId: () => opts.broadcaster ?? null,
    sendMessage: async (message: string) => { opts.sent?.push(message); },
    lookupUser: opts.lookup,
    tokenFile: '/nonexistent',
    checkLive: opts.live ?? (async () => ({ isLive: true, startedAt: null })),
    now: opts.now,
    dbProvider: opts.dbProvider
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
  }

  // Store basics
  {
    const db = openPointsDb('basics', { create: true })!;
    check('migrated to user_version 1', db.pragma('user_version', { simple: true }) === 1);
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
