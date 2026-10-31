/**
 * Loyalty points selftest. Runs against a scratch data directory with a fake
 * live check: it never calls Kick or Telegram and never touches data/points.
 *
 *   npx tsx src/tools/points-selftest.ts
 *
 * Exits non-zero when any check fails.
 */

import { recordWebReply, repliesFor } from '../community/web-fish';
import { makeTapCheck } from '../community/trap-check';
import { mirroredTrades } from '../community/fish-trade';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { ChannelConfig, ClientWrapper, KickTags, LivestreamStatusEvent, RawBadge } from '../types';
import { DEFAULT_BIG_BITE, effectiveCommand, effectivePointsConfig, invalidateLivePointsConfig, validatePointsPatch } from '../points/config';
import { closeAllPointsDbs, closePointsDb, openPointsDb, PointsDb, reportDbError, runWrite } from '../points/db';
import { LiveState } from '../points/live';
import { PointsService } from '../points/service';
import { spamKeyword } from '../points/antispam';
import { normalizeChat, presenceVerdict } from '../points/presence-rules';
import {
  acceptDuel, adjustPoints, backupPoints, createDuel, creditTx, debitTx, duelStats, gambleStats, getUser, grantTick, invariantViolations,
  openRaffle, raffleEntries, gamble,
  ensureUserTx, outgoingDuel, refundDuel, resetAllPoints,
  caughtFish, guardUntilFor, heistBoard, heldCatches, pointsLeaderboard, pointsSummary, searchPointsUsers, getPointsUserDetail, transfer
} from '../points/store';
import { WebhookPoller } from '../channels/webhook-poller';
import { points as pointsCommand, SUBCOMMAND_ALIASES } from '../bot-commands/points';
import { marksFor, readStats as readWordleStats, wordle as wordleCommand } from '../bot-commands/wordle';
import { advanceVideos, enqueueVideo, failVideo, findAlternatives, hasVideoInLine, searchPlayable, isoDurationSeconds, LOAD_PAD_MS, lookupVideo, markVideoOverlaySeen, parseYouTubeLink, neverPlaysReason, playingVideo, unplayableReason, youTubeErrorReason } from '../community/video-share';
import { duelStrength, moveFish, takeItems, addItem, overflow, nearCap, addXp, levelCost, takeSized, FishData, initialData, isTrophy, rarityOf, stealChance, stealCharges, stealRollChance, worstStealCharges, ITEMS, landsFish, loadFish, parseSellList, recordCatch, saveFish, sellPrice, weightedCatch } from '../community/fishing';
import { buyGuard, shopView, syncGuardPause } from '../community/fish-shop';
import { guardEnd, guardPausedAt, guardsPauseWhileLive } from '../community/fishing';
import { openCommunityDb } from '../community/store';
import { markOverlaySeen, noteOverlayHealth, overlayHealth, overlayOff, overlayReloadToken, overlayShowing, readOverlay, requestOverlayReload, watchOverlay } from '../community/fish-overlay';
import { biteFor, drawSnipeMs, LIVE_BITE_KEY, openSnipes, resetBites, rewardBitesWaiting, snipeOpen, SNIPE_PENDING, startBite, takeBite as takeBiteForTest } from '../community/big-bite';
import { fish as fishCommand, parseTrapMinutes, SUBCOMMANDS as FISH_SUBCOMMANDS, BOARDS as FISH_BOARD_MAP, BOARD_SHORT as FISH_BOARD_SHORT } from '../bot-commands/fish';
import { publicCommands, FISH_BOARDS, feedingGuide } from '../points/public-commands';
import { duelBoard, publicLedgerText, publicUserHistory, setMetaTx } from '../points/store';
import { mediaShareHeld, setMediaShareHeld } from '../community/mediashare';
import { answerMatches, makeTrapCheck, normalizeAnswer } from '../community/trap-check';
import { changeWheel, readWheel, validateWheel } from '../community/wheel';
import { funnels, linkedAccounts, linkedGroups, recordSignal, suspects } from '../community/cheat-signals';
import { resetWheelBusy, wheelBusy } from '../community/wheel-state';
import { recentSpins } from '../community/wheel-history';
import { alertsFor, scheduleTrapAlert } from '../community/fish-alerts';
import { wheel as wheelCommand } from '../bot-commands/wheel';
import { streamstatus } from '../bot-commands/streamstatus';
import { LISTED_FILES, NOT_LISTED } from '../points/public-bot-commands';
import { fight, fighterOf, fishNamed, fishSpecs, fishValue, pickByValue, pickFighter, pickForKeeps, playMs, sameFish, randomFish, SWITCH_MS, switchesIn, teamFight, teamSizeOf, typeOf, wantsRandom } from '../community/fish-duel';

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

function makeService(channel: string, opts: { live?: () => Promise<LiveState | null>; now?: () => number; broadcaster?: number | null; dbProvider?: () => PointsDb | null; lookup?: (n: string) => Promise<number | null>; sent?: string[]; random?: () => number; timeout?: (r: { target: string; seconds: number; reason: string }) => Promise<{ ok: true; target: string; seconds: number; actor: string } | { ok: false; error: string }> } = {}) {
  return new PointsService({
    channelName: channel,
    getBroadcasterUserId: () => opts.broadcaster ?? null,
    sendMessage: async (message: string) => { opts.sent?.push(message); },
    lookupUser: opts.lookup,
    timeout: opts.timeout,
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

  // Fishing odds and prices per item
  {
    const stored = { games: { sellPricePercent: 300 } };
    const set = validatePointsPatch(stored, { games: { catches: { '🐟': { weight: 5, price: 999 }, '🐬': { weight: 1.5, price: 450 }, '🥾': { weight: 0 } } } });
    // 🐬 at weight 1.5 and 150 × 300% = 450 is the default, so nothing is stored for it.
    check('catch overrides stored, defaults dropped', set.errors.length === 0
      && JSON.stringify(set.next?.games?.catches) === JSON.stringify({ '🐟': { weight: 5, price: 999 }, '🥾': { weight: 0 } }), set);
    const g = effectivePointsConfig(set.next).games;
    const fish = g.catches.find(c => c.name === '🐟');
    const shark = g.catches.find(c => c.name === '🦈');
    check('effective catches fill every item', g.catches.length === ITEMS.length && fish?.weight === 5 && fish.price === 999
      && shark?.weight === 0.5 && shark.price === 1200 && shark.defaultPrice === 1200, { fish, shark });
    // Fishing on the leaderboard: on unless bot management turns it off, and only a true/false saves.
    check('leaderboard fishing is on by default', effectivePointsConfig({}).games.webPlay === true);
    const webOff = validatePointsPatch({}, { games: { webPlay: false } });
    check('bot management can switch leaderboard fishing off', webOff.errors.length === 0 && effectivePointsConfig(webOff.next).games.webPlay === false, webOff);
    check('leaderboard fishing takes only true or false', validatePointsPatch({}, { games: { webPlay: 'no' } }).errors.some(e => e.includes('games.webPlay')));
    const dec = validatePointsPatch({}, { games: { catches: { '🐋': { weight: 0.057 } } } });
    check('decimal odds kept to 2 places', dec.errors.length === 0 && dec.next?.games?.catches?.['🐋']?.weight === 0.06, dec);
    const msd = validatePointsPatch({}, { video: { mediashareDelaySeconds: 2.5 } });
    check('a media share delay in tenths is kept', msd.errors.length === 0 && effectivePointsConfig(msd.next).video.mediashareDelaySeconds === 2.5 && effectivePointsConfig({}).video.mediashareDelaySeconds === 0, msd);
    check('and one past 15 seconds is refused', validatePointsPatch({}, { video: { mediashareDelaySeconds: 20 } }).errors.length === 1);
    const gd = effectivePointsConfig({}).games;
    const tally: Record<string, number> = {};
    for (let i = 0; i < 50_000; i++) { const n = weightedCatch('fish', gd).name; tally[n] = (tally[n] ?? 0) + 1; }
    const common = ['🐟', '🦐', '🦀', '🐸', '🐚'].reduce((sum, n) => sum + (tally[n] ?? 0), 0) / 50_000;
    const legendary = ((tally['🐳'] ?? 0) + (tally['🐋'] ?? 0)) / 50_000;
    check('default tiers catch as documented', Math.abs(common - 0.683) < 0.015 && legendary > 0.0012 && legendary < 0.0045, { common, legendary });
    const avg = gd.catches.filter(c => c.type === 'fish' && !c.trophy).reduce((sum, c) => sum + c.weight * c.defaultPrice, 0)
      / gd.catches.filter(c => c.type === 'fish' && !c.trophy).reduce((sum, c) => sum + c.weight, 0);
    check('average fish price stays near supibot 50', avg > 48 && avg < 56, avg);
    const item = ITEMS.find(i => i.name === '🐟')!;
    check('override price is the base a size scales', sellPrice(item, g) === 999 && sellPrice(item, g, { cm: 100, record: false }) === 1998);
    check('junk sells at percent default', sellPrice(ITEMS.find(i => i.name === '🥫')!, g) === 24);
    let boots = 0;
    for (let i = 0; i < 2000; i++) if (weightedCatch('junk', g).name === '🥾') boots++;
    check('weight 0 is never caught', boots === 0, boots);
    const onlyShark = Object.fromEntries(ITEMS.filter(i => i.type === 'fish' && !i.trophy).map(i => [i.name, { weight: i.name === '🦈' ? 1 : 0 }]));
    const gs = effectivePointsConfig(validatePointsPatch({}, { games: { catches: onlyShark } }).next).games;
    check('one fish with odds is the only catch', Array.from({ length: 200 }, () => weightedCatch('fish', gs).name).every(n => n === '🦈'));
    const none = validatePointsPatch({}, { games: { catches: Object.fromEntries(ITEMS.filter(i => i.type === 'fish').map(i => [i.name, { weight: 0 }])) } });
    check('all fish at 0 rejected', !none.next && none.errors.some(e => e.includes('fish')), none.errors);
    check('unknown item rejected', validatePointsPatch({}, { games: { catches: { '🍕': { weight: 1 } } } }).errors.length === 1);
    const cleared = validatePointsPatch(set.next, { games: { catches: null } });
    check('null clears overrides', cleared.errors.length === 0 && cleared.next?.games?.catches === undefined, cleared);
    const handEdit = effectivePointsConfig({ games: { catches: Object.fromEntries(ITEMS.filter(i => i.type === 'junk').map(i => [i.name, { weight: 0 }])) } }).games;
    check('hand-edited all-zero junk falls back to defaults', handEdit.catches.filter(c => c.type === 'junk').every(c => c.weight === c.defaultWeight));
  }

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
    check('migrated to user_version 17', db.pragma('user_version', { simple: true }) === 17);
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

  // Always-present account: the owner earns every live tick without chatting
  {
    const ch = 'lurkch';
    const B = 1_000_002 * 10 * MIN;
    let live = true;
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, currencyName: '$DON' });
    const svc = makeService(ch, { live: async () => ({ isLive: live, startedAt: null }), now: () => B + 5000 });
    const db = openPointsDb(ch, { create: true })!;
    // KICK_OWNER is 'ownerx' in this selftest.
    runWrite(db, () => {
      creditTx(db, { userId: 91, username: 'OwnerX', amount: 1, reason: 'test', now: 1 });
      creditTx(db, { userId: 51, username: 'quietguy', amount: 1, reason: 'test', now: 1 });
    });
    await svc.runTick(B);
    check('the owner earns a live tick without chatting, at the sub rate; a quiet viewer does not',
      balance(ch, 91) === 11 && balance(ch, 51) === 1, [balance(ch, 91), balance(ch, 51)]);
    check('the owner also gets the active time', getUser(db, 91)?.watch_seconds === 600, getUser(db, 91));
    live = false;
    await svc.runTick(B + 10 * MIN);
    check('no lurking pay while offline', balance(ch, 91) === 11);
    live = true;
    writeConfig(root, ch, { enabled: true, pointsPerInterval: 5, currencyName: '$DON', ignoreUsers: ['ownerx'] });
    await svc.runTick(B + 20 * MIN);
    check('exclusions still apply to the owner', balance(ch, 91) === 11, balance(ch, 91));
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

  // chatReplies off: while live with an overlay showing every reply goes to the overlay only; otherwise chat still gets it
  {
    const ch = 'fishquiet';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, chatReplies: false } });
    let live = true;
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: live, startedAt: null }) });
    const qdb = openPointsDb(ch, { create: true })!;
    const seen = (at: number) => runWrite(qdb, () => qdb.prepare("INSERT INTO meta (key, value) VALUES ('overlay_seen_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(at)));
    const run = async (msg: string, name: string, senderId: number) => {
      const out: string[] = [];
      const t: KickTags = { username: name, 'display-name': name, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId };
      await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      await new Promise(r => setTimeout(r, 20));   // the reply is sent after the command returns
      return out;
    };
    seen(Date.now());
    const cast = await run('$don fish', 'quiet', 21);
    const f = readOverlay(qdb);
    check('chatReplies off: a cast goes to the overlay only', cast.length === 0 && f.events.length === 1 && ['catch', 'miss'].includes(f.events[0].kind), { cast, f });
    seen(Date.now());
    const lay = await run('$don fish trap', 'layer', 22);
    const stats = await run('$don fish stats', 'asker', 23);
    const all = readOverlay(qdb).events;
    check('chatReplies off: so does every other reply, laying traps and lookups included',
      lay.length === 0 && stats.length === 0 && all.length === 3 && all[1].kind === 'info' && all[1].text.includes('laid your fishing traps') && all[2].kind === 'info', { lay, stats, all });
    seen(0);
    const noOverlay = await run('$don fish stats', 'asker2', 24);
    seen(Date.now());
    live = false;
    writeConfig(root, 'fishquiet2', { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, chatReplies: false } });
    makeService('fishquiet2', { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const odb = openPointsDb('fishquiet2', { create: true })!;
    runWrite(odb, () => odb.prepare("INSERT INTO meta (key, value) VALUES ('overlay_seen_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now())));
    const offOut: string[] = [];
    await fishCommand({ say: async (_c, m) => { offOut.push(m); } }, '$don fish stats', '#fishquiet2',
      { username: 'night', 'display-name': 'night', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 25 }, { channelName: 'fishquiet2' } as ChannelConfig);
    await new Promise(r => setTimeout(r, 20));
    writeConfig(root, 'fishquiet3', { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true } });
    makeService('fishquiet3', { broadcaster: 999, live: async () => ({ isLive: true, startedAt: null }) });
    const ldb = openPointsDb('fishquiet3', { create: true })!;
    runWrite(ldb, () => ldb.prepare("INSERT INTO meta (key, value) VALUES ('overlay_seen_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now())));
    const liveOut: string[] = [];
    await fishCommand({ say: async (_c, m) => { liveOut.push(m); } }, '$don fish stats', '#fishquiet3',
      { username: 'day', 'display-name': 'day', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 26 }, { channelName: 'fishquiet3' } as ChannelConfig);
    await new Promise(r => setTimeout(r, 20));
    check('offline-only fishing keeps replies out of live chat too: they show on the overlay', liveOut.length === 0 && readOverlay(ldb).events.length === 1 && readOverlay(ldb).events[0].kind === 'info', { liveOut, e: readOverlay(ldb).events });
    check('chatReplies off: with no overlay showing, or offline, chat still gets the reply', noOverlay.length === 1 && offOut.length === 1 && readOverlay(qdb).events.length === 4, { noOverlay, offOut });
    {
      // A page that polls but has stopped drawing (2026-10-21, IRL Toolkit): not showing, so big bites wait.
      writeConfig(root, 'fishdraw', { enabled: true, currencyName: '$DON', games: { enabled: true } });
      const ddb = openPointsDb('fishdraw', { create: true })!;
      const t0 = Date.now();
      markOverlaySeen(ddb, t0);
      const before = overlayShowing(ddb, t0) && overlayHealth(ddb, t0) === null;
      noteOverlayHealth(ddb, { painted: 5, stallMs: 16 }, t0);
      const drawing = overlayShowing(ddb, t0 + 1_000) && overlayHealth(ddb, t0 + 1_000)?.painted === 5;
      noteOverlayHealth(ddb, { painted: 5, stallMs: 9_000 }, t0 + 1_500);
      const stuck = !overlayShowing(ddb, t0 + 2_000);
      noteOverlayHealth(ddb, { painted: 5, stallMs: 4_000 }, t0 + 2_100);
      // No newer report: its stall keeps growing until the page is taken as closed.
      const grows = !overlayShowing(ddb, t0 + 7_000) && overlayHealth(ddb, t0 + 20_000) === null;
      check('overlay health: no report counts as before; drawing shows; stopped drawing pauses, and a silent page\'s stall grows',
        before && drawing && stuck && grows, { before, drawing, stuck, grows });
      const first = requestOverlayReload(ddb, true, t0);
      const tooSoon = requestOverlayReload(ddb, true, t0 + 60_000);
      const mod = requestOverlayReload(ddb, false, t0 + 61_000);
      const later = requestOverlayReload(ddb, true, t0 + 61_000 + 2 * 60_000);
      check('overlay reload: the bot asks at most every 2 minutes, a mod always', first && !tooSoon && mod && later && overlayReloadToken(ddb) === t0 + 61_000 + 2 * 60_000,
        { first, tooSoon, mod, later, token: overlayReloadToken(ddb) });
    }
    {
      // The watchdog: a showing page that stopped drawing is reloaded, code or no code; still stuck
      // after 5 minutes, the owner hears, and again once it draws. Hidden (its scene is off) or offline: left alone.
      writeConfig(root, 'fishwatch', { enabled: true, currencyName: '$DON', games: { enabled: true } });
      const wdb = openPointsDb('fishwatch', { create: true })!;
      const said: string[] = [];
      const alerts = { frozen: (c: string, m: number) => void said.push(`frozen ${c} ${m}`), recovered: (c: string, m: number) => void said.push(`back ${c} ${m}`) };
      const t1 = Date.now() + 3_600_000;
      markOverlaySeen(wdb, t1);
      noteOverlayHealth(wdb, { painted: 3, stallMs: 60_000, hidden: true }, t1);
      watchOverlay(wdb, 'fishwatch', true, alerts, t1);
      const hiddenLeft = overlayReloadToken(wdb) === 0 && !overlayShowing(wdb, t1);
      noteOverlayHealth(wdb, { painted: 3, stallMs: 40_000 }, t1 + 3_000);
      watchOverlay(wdb, 'fishwatch', false, alerts, t1 + 3_000);
      const offlineLeft = overlayReloadToken(wdb) === 0;
      watchOverlay(wdb, 'fishwatch', true, alerts, t1 + 3_000);
      const reloaded = overlayReloadToken(wdb) === t1 + 3_000 && said.length === 0;
      // Reloaded, and still not drawing: the new page's stall counts from its load, the freeze from first noticed.
      noteOverlayHealth(wdb, { painted: 3, stallMs: 20_000 }, t1 + 5 * 60_000);
      watchOverlay(wdb, 'fishwatch', true, alerts, t1 + 5 * 60_000);
      const toldOnce = said.length === 1 && said[0] === 'frozen fishwatch 6';
      noteOverlayHealth(wdb, { painted: 3, stallMs: 30_000 }, t1 + 5 * 60_000 + 3_000);
      watchOverlay(wdb, 'fishwatch', true, alerts, t1 + 5 * 60_000 + 3_000);
      markOverlaySeen(wdb, t1 + 6 * 60_000);
      noteOverlayHealth(wdb, { painted: 4, stallMs: 16 }, t1 + 6 * 60_000);
      watchOverlay(wdb, 'fishwatch', true, alerts, t1 + 6 * 60_000);
      const back = said.length === 2 && said[1] === 'back fishwatch 7' && overlayShowing(wdb, t1 + 6 * 60_000);
      check('overlay watchdog: reloads a showing frozen page, leaves hidden or offline ones, alerts once after 5 min and on recovery',
        hiddenLeft && offlineLeft && reloaded && toldOnce && back, { hiddenLeft, offlineLeft, reloaded, toldOnce, back, said });
    }
    const demoOff = validatePointsPatch({}, { games: { overlayDemo: false } });
    check('overlayDemo is on unless turned off',
      effectivePointsConfig({}).games.overlayDemo && demoOff.errors.length === 0 && !effectivePointsConfig(demoOff.next).games.overlayDemo, demoOff);
    const sized = validatePointsPatch({}, { games: { overlaySizePercent: 200 } });
    const oversized = validatePointsPatch({}, { games: { overlaySizePercent: 400 } });
    check('overlaySizePercent is 100 unless set, and kept within 50–300',
      effectivePointsConfig({}).games.overlaySizePercent === 100 && sized.errors.length === 0 && effectivePointsConfig(sized.next).games.overlaySizePercent === 200 && oversized.errors.length === 1, { sized, oversized });
    const cleared = validatePointsPatch({}, { games: { overlayClearWidthPercent: 26, overlayClearHeightPercent: 46 } });
    const overCleared = validatePointsPatch({}, { games: { overlayClearWidthPercent: 90 } });
    check('the overlay keeps no corner clear unless set, and at most 80% each way',
      effectivePointsConfig({}).games.overlayClearWidthPercent === 0 && effectivePointsConfig({}).games.overlayClearHeightPercent === 0 && cleared.errors.length === 0
      && effectivePointsConfig(cleared.next).games.overlayClearWidthPercent === 26 && effectivePointsConfig(cleared.next).games.overlayClearHeightPercent === 46 && overCleared.errors.length === 1, { cleared, overCleared });
    const delayed = validatePointsPatch({}, { games: { streamDelaySeconds: 4 } });
    const tooLate = validatePointsPatch({}, { games: { streamDelaySeconds: 31 } });
    check('streamDelaySeconds is 0 unless set, and kept within 0–30',
      effectivePointsConfig({}).games.streamDelaySeconds === 0 && delayed.errors.length === 0 && effectivePointsConfig(delayed.next).games.streamDelaySeconds === 4
      && tooLate.errors.length === 1 && validatePointsPatch({}, { games: { streamDelaySeconds: 1.5 } }).errors.length === 1, { delayed, tooLate });
    // A big bite's time runs from when viewers can see the code: the delay later.
    const ddb = openPointsDb('delaych', { create: true })!;
    const bb = effectivePointsConfig({ games: { bigBite: { enabled: true } } }).games.bigBite;
    const t0 = Date.now();
    const plain = startBite({ channel: 'delaych', db: ddb, bigBite: bb, command: 'don', sendMessage: async () => {}, now: t0 }, 'plain', 1);
    const plainUntil = plain.until;
    takeBiteForTest('delaych', 'plain');
    const late = startBite({ channel: 'delaych', db: ddb, bigBite: bb, command: 'don', sendMessage: async () => {}, now: t0, delayMs: 4_000 }, 'late', 2);
    const lateUntil = late.until, lateSnipe = late.snipeAt;
    takeBiteForTest('delaych', 'late');
    check('a stream delay moves a big bite\'s deadline and snipe window that much later',
      plainUntil === t0 + bb.windowSeconds * 1000 && lateUntil === plainUntil + 4_000
      && lateSnipe !== undefined && lateUntil - lateSnipe >= 1_000 && lateUntil - lateSnipe <= bb.windowSeconds * 500, { plainUntil, lateUntil, lateSnipe, t0 });
    // Chat says the moment snipes open (it has no stream delay), and nothing if the bite is settled first.
    const said: string[] = [];
    const ctxAt = (now: number) => ({ channel: 'delaych', db: ddb, bigBite: bb, command: 'don', sendMessage: async (m: string) => { said.push(m); }, now });
    startBite(ctxAt(Date.now() - bb.windowSeconds * 1000 + 500), 'opened', 3); // snipes already due: the line fires at once
    startBite({ ...ctxAt(Date.now() - bb.windowSeconds * 1000 + 500), channel: 'delaych2' }, 'settled', 4);
    takeBiteForTest('delaych2', 'settled');
    await new Promise(r => setTimeout(r, 50));
    takeBiteForTest('delaych', 'opened');
    // While the line is being posted nobody can snipe yet; once Kick has it, snipes open.
    let post: () => void = () => {};
    const slow = startBite({ ...ctxAt(Date.now() - bb.windowSeconds * 1000 + 2_000), channel: 'delaych3', sendMessage: (m: string) => m.includes('SNIPE OPEN') ? new Promise<void>(r => { post = r; }) : Promise.resolve() }, 'slow', 5);
    await new Promise(r => setTimeout(r, 50));
    const pending = slow.snipeAt === SNIPE_PENDING && !snipeOpen(slow, Date.now());
    post();
    await new Promise(r => setTimeout(r, 10));
    const opened = slow.snipeAt !== undefined && slow.snipeAt <= Date.now() && snipeOpen(slow, Date.now());
    takeBiteForTest('delaych3', 'slow');
    check('snipes open only once the SNIPE OPEN line is posted: not while it is being sent', pending && opened, { pending, opened, snipeAt: slow.snipeAt });
    const opens = said.filter(m => m.includes('SNIPE OPEN'));
    check('chat says the moment snipes open, and stays quiet for a bite settled first',
      opens.length === 1 && opens[0].includes("@opened's big bite") && /\$don fish reel \d{2} takes it/.test(opens[0]) && said.some(m => m.includes("I'll post a snipe code in chat")), said);
  }

  // onlyWhileOffline: casting and trapping are shut while live, open offline; never on with onlyWhileLive
  {
    const ch = 'fishoffline';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: true, startedAt: null }) });
    const run = async (msg: string, name: string, senderId: number) => {
      const out: string[] = [];
      const t: KickTags = { username: name, 'display-name': name, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId };
      await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out;
    };
    const liveCast = await run('$don fish', 'night', 31);
    const liveTrap = await run('$don fish trap', 'dusk', 33);
    const liveStats = await run('$don fish stats', 'dawn', 34);
    check('onlyWhileOffline: casting and trapping stay silent while live, lookups still answer',
      liveCast.length === 0 && liveTrap.length === 0 && liveStats.length === 1, { liveCast, liveTrap, liveStats });
    // Traps laid offline: collecting or lifting them live stays silent too (it skipped the trap check); cancelling answers
    {
      const odb = openPointsDb(ch, { create: true })!;
      const lay = (id: number, name: string, full: boolean) => runWrite(odb, () => {
        ensureUserTx(odb, id, name, 1);
        const d = initialData();
        const start = Date.now() - 2 * 3_600_000;
        d.trap = { active: true, start, end: full ? start + 3_600_000 : Date.now() + 3_600_000, duration: 3_600_000 };
        saveFish(odb, id, d, 1);
      });
      lay(35, 'reef', true); lay(36, 'shoal', false); lay(37, 'cove', true);
      const collected = await run('$don fish trap', 'reef', 35);
      const lifted = await run('$don fish trap lift', 'shoal', 36);
      const cancelled = await run('$don fish trap cancel', 'cove', 37);
      check('onlyWhileOffline: full traps can\'t be collected or lifted while live, only cancelled',
        collected.length === 0 && lifted.length === 0 && loadFish(odb, 35)!.trap.active && loadFish(odb, 36)!.trap.active
        && cancelled.length === 1 && !loadFish(odb, 37)!.trap.active, { collected, lifted, cancelled });
    }
    const ch2 = 'fishoffline2';
    writeConfig(root, ch2, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true } });
    makeService(ch2, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const out: string[] = [];
    const t: KickTags = { username: 'owl', 'display-name': 'owl', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 32 };
    await fishCommand({ say: async (_c, m) => { out.push(m); } }, '$don fish trap', `#${ch2}`, t, { channelName: ch2 } as ChannelConfig);
    check('onlyWhileOffline: traps can be laid offline', out[0]?.includes('laid your fishing traps') === true, out);
    const both = validatePointsPatch({}, { games: { onlyWhileOffline: true } });
    const swap = validatePointsPatch({}, { games: { onlyWhileLive: false, onlyWhileOffline: true } });
    check('onlyWhileOffline can\'t be on together with onlyWhileLive',
      both.errors.length === 1 && swap.errors.length === 0 && effectivePointsConfig(swap.next).games.onlyWhileOffline, { both: both.errors, swap: swap.errors });
    // steal.onlyWhileLive: stealing keeps to live streams while casting stays offline-only
    for (const [ch3, isLive] of [['fishsteallive', true], ['fishsteallive2', false]] as const) {
      writeConfig(root, ch3, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true, onlyWhileLive: true } } });
      makeService(ch3, { broadcaster: 999, live: async () => ({ isLive, startedAt: null }) });
      const say = async (msg: string, name: string, senderId: number) => {
        const got: string[] = [];
        const tg: KickTags = { username: name, 'display-name': name, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId };
        await fishCommand({ say: async (_c, m) => { got.push(m); } }, msg, `#${ch3}`, tg, { channelName: ch3 } as ChannelConfig);
        return got;
      };
      const stole = await say('$don fish steal @nobody', `crook${ch3.length}`, 41);
      const cast = await say('$don fish trap', `angler${ch3.length}`, 42);
      check(`steal.onlyWhileLive: ${isLive ? 'live, stealing answers and traps stay silent' : 'offline, stealing stays silent and traps answer'}`,
        (stole.length === 1) === isLive && (cast.length === 1) === !isLive, { stole, cast });
    }
    const stealLive = validatePointsPatch({}, { enabled: true, games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true, onlyWhileLive: true } } });
    const stealBad = validatePointsPatch({}, { games: { steal: { onlyWhileLive: 'yes' } } });
    const note = publicCommands(effectivePointsConfig(stealLive.next)).sections.find(sec => sec.title === 'Fishing')?.note ?? '';
    check('steal.onlyWhileLive is stored, validated and named in the command list',
      stealLive.errors.length === 0 && effectivePointsConfig(stealLive.next).games.steal.onlyWhileLive && !effectivePointsConfig({}).games.steal.onlyWhileLive && stealBad.errors.length === 1
      && note.includes('Casting and traps only work while the stream is offline.') && note.includes('Stealing only works while the stream is live.'), { errors: stealLive.errors, bad: stealBad.errors, note });
  }

  // Short forms: every $don subcommand has one, and it does what the long form does
  {
    const ch = 'aliasch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', gamble: { enabled: true, cooldownSeconds: 0 }, give: { enabled: true, minAmount: 1, cooldownSeconds: 0 } });
    makeService(ch, { broadcaster: 999, random: () => 0.1 });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 50, reason: 'mod_add', now: 1 });
    });
    const run = async (msg: string, username: string, id: number) => {
      const out: string[] = [];
      const t: KickTags = { username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id };
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out;
    };
    const won = await run('$don g 40', 'alice', 1);
    check('$don g is $don gamble', won[0] === '@alice won 40 $DON and now has 140' && balance(ch, 1) === 140, won);
    await run('$don GV @bob 10', 'alice', 1);
    check('$don gv is $don give', balance(ch, 1) === 130 && balance(ch, 2) === 60, { a: balance(ch, 1), b: balance(ch, 2) });
    const mod = async (msg: string) => {
      const out: string[] = [];
      const t: KickTags = { username: 'modder', 'display-name': 'modder', badges: {}, isBroadcaster: false, isModUp: true, isVIPUp: true, rawBadges: [], senderId: 7 };
      await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out;
    };
    const tg = await mod('$don t g');
    const tat = await mod('$don t at');
    check('$don t g is top gamble, $don t at is top activetime', tg.length === 1 && tg[0] === (await mod('$don top gamble'))[0] && tat.length === 1 && tat[0] === (await mod('$don top activetime'))[0]
      && tg[0] !== tat[0], { tg, tat });
    const gst = await run('$don g st', 'alice', 1);
    check('$don g st is gamble stats', gst.length === 1 && gst[0] === '@alice 1 gambles 1 won 100.0% net 40 $DON', gst);
    const allIn = await run('$don g a', 'bob', 2);
    check('$don g a is gamble all', allIn[0] === '@bob went all in and won, now has 120 $DON' && balance(ch, 2) === 120, allIn);
    const top = await run('$don t', 'bob', 2);
    check('$don t is $don top', top.length === 1 && top[0].includes('alice'), top);
    const longs = Object.values(SUBCOMMAND_ALIASES);
    check('every $don subcommand has a short form', ['activetime', 'top', 'leaderboard', 'give', 'gamble', 'duel', 'accept', 'deny', 'cancel', 'raffle', 'sraffle', 'join', 'add', 'remove', 'set', 'fish', 'commands'].every(w => longs.includes(w)), longs);
    const link = await mod('$don cm');
    check('$don commands links to the Commands tab within the symbol allowance', link.length === 1 && link[0] === (await mod('$don commands'))[0]
      && link[0].endsWith('/aliasch/commands') && (link[0].match(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g) ?? []).length <= 10, link);
    // The public Commands tab: every short form it shows is one the commands answer to.
    const full = effectivePointsConfig({ enabled: true, give: { enabled: true }, gamble: { enabled: true }, duel: { enabled: true }, raffle: { enabled: true },
      games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true }, duel: { enabled: true, allowKeeps: true }, trade: { enabled: true } } });
    const listed = publicCommands(full);
    const wrong = listed.sections.flatMap(s => s.rows).filter(r => {
      if (!r.short) return false;
      const u = r.usage.split(' ');
      const sh = r.short.split(' ');
      if (u[1] !== undefined && sh[1] !== u[1] && SUBCOMMAND_ALIASES[sh[1]] !== u[1]) return true;
      return u[1] === 'fish' && u[2] !== undefined && FISH_SUBCOMMANDS[u[2]] !== undefined && FISH_SUBCOMMANDS[sh[2]] !== FISH_SUBCOMMANDS[u[2]];
    });
    check('the public command list only shows short forms that work', listed.command === '$points' && wrong.length === 0
      && listed.sections.map(s => s.title).join(',') === 'Points,Games,Fishing,Streamer' && listed.sections[2].note!.includes('offline'), { wrong, t: listed.sections.map(s => s.title) });
    // Every named fishing board (the emoji ones aside) is on the Commands tab, with the short form `fish top` takes.
    const named = [...FISH_BOARD_MAP.keys()].filter(k => /^[a-z-]+$/.test(k));
    check('the Commands tab names every fishing board and its short form',
      named.length === FISH_BOARDS.length && named.every(k => FISH_BOARDS.some(b => b.board === k && FISH_BOARD_SHORT[b.short] === k))
      && Object.keys(FISH_BOARD_SHORT).length === FISH_BOARDS.length
      && ['lucky (l)', 'total-lucky (tl)', 'robbed (r)', 'who holds the most'].every(t => listed.sections[2].rows.some(r => r.does.includes(t))),
      { named, listedBoards: FISH_BOARDS.map(b => b.board) });
    // !claude's feeding rules follow the channel: its command, its fail chance, nothing when feeding is off.
    const guide = feedingGuide(effectivePointsConfig({ enabled: true, currencyName: '$DON', games: { enabled: true, feedFailPercent: 15 } }));
    check('!claude gets the feeding rules, with the channel\'s fail chance, and none when feeding is off',
      guide.startsWith('FEEDING ($don fish feed') && guide.includes('15% of feedings fail') && guide.includes('Lv10')
      && feedingGuide(effectivePointsConfig({ enabled: true, currencyName: '$DON', games: { enabled: true, feedEnabled: false } })) === '', guide);
    const bare = publicCommands(effectivePointsConfig({ enabled: true, currencyName: '$DON', raffle: { enabled: false } }));
    check('and leaves out what the channel has off', bare.command === '$don' && bare.sections.map(s => s.title).join(',') === '$DON,Streamer' && !bare.sections[0].rows.some(r => /give|gamble/.test(r.usage)), bare.sections.map(s => s.title));
    // The bot's ! commands: every command file is listed (or has a reason it isn't), and what a channel has off is left out.
    const files = fs.readdirSync(path.join(__dirname, '..', 'bot-commands')).filter(f => /\.(ts|js)$/.test(f) && !f.endsWith('.d.ts')).map(f => f.replace(/\.(ts|js)$/, ''));
    const unlisted = files.filter(f => !LISTED_FILES.has(f) && !(f in NOT_LISTED));
    const withBot = publicCommands(full, { channel: { excludedCommands: ['Weather', 'wheel'], kpp: { enabled: true } }, custom: { crime: ['n', 'committed $counter crimes', 3], trap: ['n', '/timeout $user1 1m', 0], secret: ['y', 'mods only', 0] } });
    const rows = withBot.sections.flatMap(s => s.rows);
    check('the Commands tab lists every bot command a channel has on, and its custom commands',
      unlisted.length === 0 && rows.some(r => r.usage === '!clip [45s] [title]') && rows.some(r => r.usage === '!kpp') && !rows.some(r => r.usage.startsWith('!weather'))
      && !rows.some(r => r.usage === '!earnings') && !rows.some(r => r.usage.startsWith('!blerp')) && !withBot.sections.some(s => s.title === 'Wheel')
      && rows.find(r => r.usage === '!crime')?.does === 'committed N crimes' && rows.find(r => r.usage === '!trap')?.does === 'A surprise 🤫' && rows.find(r => r.usage === '!secret')?.who === 'mods'
      // The page drops a row past these lengths (dashboard/src/lib/public-leaderboard.ts): 2026-10-24 the duel and
      // trade rows ran past 200 with keeps on, and vanished from sukasblood's Commands tab.
      && rows.some(r => r.usage.includes('fish duel @user 3v3')) && rows.some(r => r.usage.includes('fish trade'))
      && withBot.sections.length <= 16 && withBot.sections.every(s => s.rows.length <= 60 && s.rows.every(r => r.usage.length <= 80 && r.does.length <= 400)),
      { unlisted, titles: withBot.sections.map(s => s.title) });
  }

  // Anti-spam: keyword messages past the threshold cost points, per viewer, inside the window
  {
    check('spam keywords match whole words, any case, and emote names',
      spamKeyword('LOL that was great', ['lol']) === 'lol' && spamKeyword('lollipop', ['lol']) === null
      && spamKeyword('nice [emote:123:KEKW]', ['kekw']) === 'kekw' && spamKeyword('so free   money here', ['free money']) === 'free money' && spamKeyword('freemoney', ['free money']) === null
      && spamKeyword('get free money here', ['free money']) === 'free money' && spamKeyword('what?? (c++)', ['c++']) === 'c++');
    const ch = 'antispam';
    const sent: string[] = [];
    let now = 5_000_000;
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', antiSpam: { enabled: true, keywords: ['kekw'], threshold: 2, windowMinutes: 5, cost: 30 } });
    const svc = makeService(ch, { now: () => now, sent });
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'spammer', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'modguy', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 3, username: 'bystander', amount: 100, reason: 'mod_add', now: 1 });
    });
    let n = 0;
    const say = (id: number, name: string, text: string, b: RawBadge[] = badges(), mid = `m${++n}`) => { now += 1000; svc.noteChat(id, name, b, text, mid); };
    say(1, 'spammer', 'KEKW');
    say(1, 'spammer', 'kekw kekw kekw');
    check('anti-spam: messages up to the threshold are free', balance(ch, 1) === 100 && sent.length === 0, { b: balance(ch, 1), sent });
    say(1, 'spammer', 'hello chat');
    say(3, 'bystander', 'kekw');
    say(1, 'spammer', 'Kekw!', badges(), 'dup');
    say(1, 'spammer', 'Kekw!', badges(), 'dup');
    check('anti-spam: the next keyword message costs once, however often Kick delivers it', balance(ch, 1) === 70 && balance(ch, 3) === 100, { b: balance(ch, 1) });
    say(1, 'spammer', 'kekw');
    say(1, 'spammer', 'kekw');
    say(1, 'spammer', 'kekw');
    say(1, 'spammer', 'kekw');
    check('anti-spam: every further one costs, never below zero, and no message is announced by itself', balance(ch, 1) === 0 && sent.length === 0, { b: balance(ch, 1), sent });
    say(3, 'bystander', 'kekw');
    say(3, 'bystander', 'kekw');
    const board = svc.spamBoardTick();
    check('anti-spam: the board lists the last ten minutes, biggest loss first',
      board === 'Spam tax, last 10 min: 1. spammer -100 $DON, 2. bystander -30 $DON' && sent.length === 1 && sent[0] === board, { board, sent });
    for (let i = 0; i < 5; i++) say(2, 'modguy', 'kekw', badges('moderator'));
    check('anti-spam: moderators are never charged', balance(ch, 2) === 100);
    now += 6 * 60_000;
    runWrite(db, () => creditTx(db, { userId: 1, username: 'spammer', amount: 50, reason: 'mod_add', now }));
    say(1, 'spammer', 'kekw');
    check('anti-spam: the count starts over once the window has passed', balance(ch, 1) === 50, balance(ch, 1));
    now += 5 * 60_000;
    check('anti-spam: no board when nobody was charged in the ten minutes', svc.spamBoardTick() === null && sent.length === 1, sent);
    // Not enough to pay: what's left is taken and the viewer is timed out.
    {
      const ch2 = 'antispamto';
      const sent2: string[] = [];
      const timeouts: Array<{ target: string; seconds: number; reason: string }> = [];
      let now2 = 9_000_000;
      let refuse = false;
      writeConfig(root, ch2, { enabled: true, currencyName: '$DON', antiSpam: { enabled: true, keywords: ['kekw'], threshold: 1, windowMinutes: 5, cost: 30 } });
      const svc2 = makeService(ch2, { now: () => now2, sent: sent2, timeout: async r => { timeouts.push(r); return refuse ? { ok: false, error: 'nope' } : { ok: true, target: r.target, seconds: r.seconds, actor: 'bot' }; } });
      const db2 = openPointsDb(ch2, { create: true })!;
      runWrite(db2, () => creditTx(db2, { userId: 1, username: 'spammer', amount: 70, reason: 'mod_add', now: 1 }));
      let n2 = 0;
      const say2 = async (text = 'kekw') => { now2 += 1000; svc2.noteChat(1, 'spammer', badges(), text, `t${++n2}`); await new Promise(r => setTimeout(r, 5)); };
      await say2();
      await say2();
      await say2();
      check('anti-spam: a viewer who can pay is charged, not timed out', balance(ch2, 1) === 10 && timeouts.length === 0 && sent2.length === 0, { b: balance(ch2, 1), timeouts });
      await say2();
      check('anti-spam: not enough to pay takes what is left and times them out for a minute, and chat is told', balance(ch2, 1) === 0 && timeouts.length === 1
        && timeouts[0].target === 'spammer' && timeouts[0].seconds === 60 && sent2.length === 1 && sent2[0] === "@spammer can't pay the 30 $DON spam tax: timed out for 1 min.", { timeouts, sent2 });
      refuse = true;
      await say2();
      check('anti-spam: with nothing at all it is a timeout again; one the moderator refuses is not announced', timeouts.length === 2 && sent2.length === 1, { timeouts, sent2 });
      writeConfig(root, ch2, { enabled: true, currencyName: '$DON', antiSpam: { enabled: true, keywords: ['kekw'], threshold: 1, windowMinutes: 5, cost: 30, timeoutMinutes: 0 } });
      now2 += 20_000;
      await say2();
      check('anti-spam: timeoutMinutes 0 only takes what they have', timeouts.length === 2 && effectivePointsConfig({}).antiSpam.timeoutMinutes === 1
        && validatePointsPatch({}, { antiSpam: { timeoutMinutes: 61 } }).errors.length === 1, timeouts);
    }
    const noWords = validatePointsPatch({}, { antiSpam: { enabled: true } });
    const ok = validatePointsPatch({}, { antiSpam: { enabled: true, keywords: [' KEKW ', 'kekw', 'Free  Money'], threshold: 5, cost: 25 } });
    const bad = validatePointsPatch({}, { antiSpam: { keywords: [''], cost: 0 } });
    check('anti-spam settings: needs a keyword to be on, keywords are tidied, bad values refused',
      noWords.errors.length === 1 && ok.errors.length === 0 && JSON.stringify(effectivePointsConfig(ok.next).antiSpam.keywords) === '["kekw","free money"]'
      && effectivePointsConfig(ok.next).antiSpam.threshold === 5 && bad.errors.length === 2 && effectivePointsConfig({}).antiSpam.enabled === false,
      { noWords: noWords.errors, ok: ok.errors, bad: bad.errors });
  }

  // Fish duels: fighters from held fish, a fight rolled turn by turn, stakes moved once
  {
    const ch = 'fishduel';
    const cfgWith = (duel: Record<string, unknown>, games: Record<string, unknown> = {}) => writeConfig(root, ch, {
      enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, ...games, duel: { enabled: true, onlyWhileLive: false, cooldownSeconds: 0, ...duel } }
    });
    // Keeps are only between fish close in value: priced so a 90 cm 🦈 and a 70 cm 🐢 are both worth 1,260.
    cfgWith({}, { catches: { '🦈': { price: 700 }, '🐢': { price: 900 } } });
    makeService(ch, { broadcaster: 999 });
    const ddb = openPointsDb(ch, { create: true })!;
    const g = effectivePointsConfig({ games: { enabled: true } }).games;
    const item = (n: string) => ITEMS.find(x => x.name === n)!;
    const fishOf = (id: number) => loadFish(ddb, id)!;
    const seed = (id: number, name: string, bal: number, fish: Array<[string, number]>) => runWrite(ddb, () => {
      creditTx(ddb, { userId: id, username: name, amount: bal, reason: 'mod_add', now: 1 });
      const d = initialData();
      d.lifetime.attempts = 1;
      for (const [n, cm] of fish) {
        addItem(d, item(n));
        d.catch.sizes ??= {};
        (d.catch.sizes[n] ??= []).push({ cm, record: false });
      }
      saveFish(ddb, id, d, 1);
    });
    seed(51, 'ash', 1000, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
    seed(52, 'gary', 1000, [['🐢', 70]]);
    seed(53, 'brock', 50, []);
    seed(54, 'misty', 1000, [['🦐', 30]]);

    // The engine
    const shark = fighterOf(g, item('🦈'), { cm: 90, record: false });
    const minnow = fighterOf(g, item('🐟'), { cm: 20, record: false });
    check('a fighter gets its level from rarity, and hit points and attack from its length',
      shark.rarity === 'Epic' && minnow.rarity === 'Common' && shark.hp > minnow.hp && shark.attack > minnow.attack && fighterOf(g, item('🐟'), { cm: 60, record: false }).attack > fighterOf(g, item('🐟'), { cm: 50, record: false }).attack && fighterOf(g, item('🐟'), { cm: 60, record: false }).hp > fighterOf(g, item('🐟'), { cm: 50, record: false }).hp
      && typeOf('🦈') === 'Predator' && typeOf('🐟') === 'Swift' && typeOf('🐢') === 'Armored', { shark, minnow });
    const half: () => number = () => 0.5;
    const even = fight(shark, minnow, half);
    check('a coin flip opens and the fight runs until one is out', even.turns[0].by === 1 && even.winner === 0 && even.left[1] === 0 && even.left[0] > 0
      && even.turns.every((t, i) => t.by === (i % 2 === 0 ? 1 : 0)) && even.turns.filter(t => t.by === 0).every(t => t.edge === 1 && t.damage === Math.round(shark.attack * 1.08)), even);
    const turtle = fighterOf(g, item('🐢'), { cm: 90, record: false });
    const sharkWeak = fight(shark, turtle, half).turns.find(t => t.by === 0)!;
    check('types: Predator is strong against Swift and weak against Armored', sharkWeak.edge === -1 && sharkWeak.damage === Math.round(shark.attack * 0.94), sharkWeak);
    const wins = Array.from({ length: 400 }, () => fight(shark, minnow).winner).filter(w => w === 0).length;
    const mirror = Array.from({ length: 2000 }, () => fight(minnow, minnow).winner).filter(w => w === 0).length;
    check('a far stronger fish nearly always wins; a mirror match is about even', wins > 390 && mirror > 850 && mirror < 1150, { wins, mirror });
    const bout = (a: string, acm: number, b: string, bcm: number): number => {
      const fa = fighterOf(g, item(a), { cm: acm, record: false }), fb = fighterOf(g, item(b), { cm: bcm, record: false });
      return Array.from({ length: 3000 }, (_, i) => (i % 2 ? fight(fa, fb).winner === 0 : fight(fb, fa).winner === 1)).filter(Boolean).length / 3000;
    };
    const bigger = bout('🐟', 60, '🐟', 50), rarer = bout('🐠', 50, '🐟', 50), typed = bout('🐸', 50, '🐟', 50), rarerCountered = bout('🐠', 50, '🐸', 50);
    check('the stats decide: bigger beats smaller, rarer beats commoner even against its counter, a type edge helps',
      bigger > 0.54 && bigger < 0.68 && rarer > 0.72 && rarer < 0.9 && typed > 0.6 && typed < 0.78 && rarerCountered > 0.52, { bigger, rarer, typed, rarerCountered });
    check('duel: random sends any fish held, by how many of each', wantsRandom(['Random', 'fish']) && !wantsRandom(['keeps'])
      && randomFish(fishOf(51), () => 0) !== undefined && pickFighter(fishOf(51), g, randomFish(fishOf(51), () => 0.999)) !== null && randomFish(fishOf(53)) === undefined && randomFish(null) === undefined);
    check('duel: a fish is named by emoji or by word, never junk', fishNamed(['Shark']) === '🦈' && fishNamed(['50', 'whale']) === '🐳' && fishNamed(['bluewhale']) === '🐋'
      && fishNamed(['🦈\uFE0F']) === '🦈' && fishNamed(['keeps']) === undefined && fishNamed(['🥾']) === undefined);
    check('someone sends their strongest fish, or the biggest of the kind they name',
      pickFighter(fishOf(51), g)!.item.name === '🦈' && pickFighter(fishOf(51), g, '🐟')!.held!.cm === 60 && pickFighter(fishOf(51), g, '🐟')!.index === 1
      && pickFighter(fishOf(53), g) === null && pickFighter(fishOf(52), g, '🦈') === null);
    const holding = (sizes: Record<string, number[]>): FishData => {
      const d = initialData();
      for (const [name, cms] of Object.entries(sizes)) {
        d.catch.types[name] = cms.length;
        (d.catch.sizes ??= {})[name] = cms.map(cm => ({ cm, record: false }));
        d.catch.fish += cms.length;
      }
      return d;
    };
    const keeper = holding({ '🦈': [120], '🐟': [90, 30] }), matcher = holding({ '🐟': [32] });
    const kept = pickForKeeps(keeper, matcher, g), keptNamed = pickForKeeps(keeper, matcher, g, '🐟');
    check('keeps: the challenger sends a fish the rival can match, a shorter one of a kind too; the answer is the closest by value, whatever its length',
      kept?.item.name === '🐟' && kept.held?.cm === 30 && keptNamed?.held?.cm === 30 && pickForKeeps(keeper, matcher, g, '🦈') === null
      && pickByValue(holding({ '🐟': [90, 31] }), g, fishValue(g, kept!), '🐟')?.held?.cm === 31
      && sameFish(keeper, g, '🐟', 30)?.index === 1 && sameFish(keeper, g, '🐟', 31) === null,
      { kept: kept?.held, keptNamed: keptNamed?.held });
    check('the overlay play time grows with the turns but stays short', playMs(4) < playMs(12) && playMs(40) <= 26_000, [playMs(4), playMs(12), playMs(40)]);

    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string, who: [string, number]) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out.join(' | ');
      };
      const ash: [string, number] = ['ash', 51];
      const gary: [string, number] = ['gary', 52];
      const lastDuel = () => ddb.prepare('SELECT * FROM fish_duels ORDER BY id DESC LIMIT 1').get() as { winner_id: number; challenger_fish: string; opponent_fish: string; stake: string; amount: number | null; turns: number };

      check('a duel needs a fish on both sides', (await run('$don fish duel @gary', ['brock', 53])).includes('need a fish') && (await run('$don fish duel @brock', ash)).includes('has no fish to fight with'));
      check('no duelling yourself, and nobody to answer without a challenge', (await run('$don fish duel @ash', ash)).includes("can't duel yourself") && (await run('$don fish accept', gary)).includes('Nobody has challenged you'));

      const asked = await run('$don fish duel @gary', ash);
      check('a challenge names the fish sent and how to answer', asked.startsWith('@gary ⚔️ ash challenges you') && asked.includes('🦈 90 cm') && asked.includes('Predator') && asked.includes('For glory only')
        && asked.includes('$don fish accept'), asked);
      check('one challenge at a time, for both sides', (await run('$don fish duel @misty', ash)).includes('already challenged gary') && (await run('$don fish duel @gary', ['misty', 54])).includes('busy with another duel')
        && (await run('$don fish duel @misty', gary)).includes('challenge to answer first'));
      const friendly = await run('$don fish accept', gary);
      const row1 = lastDuel();
      check('accepting fights it: a result line, a record for both, a row, and nothing changes hands',
        /⚔️ @(ash|gary)'s .* (crushed|beat|barely survived) @(ash|gary)'s .* in \d+ turns/.test(friendly) && row1.stake === 'friendly' && row1.challenger_fish === '🦈' && row1.opponent_fish === '🐢'
        && fishOf(51).lifetime.duel.wins + fishOf(52).lifetime.duel.wins === 1 && fishOf(51).lifetime.duel.losses + fishOf(52).lifetime.duel.losses === 1
        && balance(ch, 51) === 1000 && balance(ch, 52) === 1000 && fishOf(51).catch.types['🦈'] === 1 && fishOf(52).catch.types['🐢'] === 1, { friendly, row1 });
      const shown = readOverlay(ddb).events.find(e => e.kind === 'duel');
      check('the overlay gets both sides and every turn', !!shown?.duel && shown.duel.a.user === 'ash' && shown.duel.b.fish === '🐢' && shown.duel.turns.length === row1.turns
        && shown.duel.winner === (row1.winner_id === 51 ? 0 : 1) && !shown.text.includes('@'), shown);
      check('a challenge is gone once fought', (await run('$don fish accept', gary)).includes('Nobody has challenged you'));

      // An invite that runs out unanswered is deleted from chat; one answered isn't (owner, 2026-10-31).
      {
        const sentIds: string[] = [];
        const deleted: string[] = [];
        const due: Array<() => void> = [];
        const realTimeout = global.setTimeout;
        // The invite's timer is minutes long: catch it to run by hand, let short ones through.
        (global as { setTimeout: unknown }).setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) =>
          (ms ?? 0) >= 60_000 ? (due.push(fn), { unref() {} }) : (realTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest)) as unknown as typeof setTimeout;
        try {
          const invite = async (msg: string, who: [string, number]) => {
            shift += 6_000;
            const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
            await fishCommand({
              say: async () => {},
              sayForId: async () => { const id = `m${sentIds.length + 1}`; sentIds.push(id); return id; },
              deleteMessage: async id => (deleted.push(id), true)
            }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
          };
          await invite('$don fish duel @gary', ash);
          shift += 121_000;
          due.splice(0).forEach(f => f());
          await new Promise(r => realTimeout(r, 10));
          check('a duel challenge left unanswered is deleted from chat when its time runs out', sentIds.length === 1 && deleted.join() === 'm1', { sentIds, deleted });
          await invite('$don fish duel @gary', ash);
          await run('$don fish deny', gary);
          due.splice(0).forEach(f => f());
          await new Promise(r => realTimeout(r, 10));
          check('one that was answered (turned down, here) stays', sentIds.length === 2 && deleted.join() === 'm1', { sentIds, deleted });
        } finally {
          global.setTimeout = realTimeout;
        }
      }

      check('a wager must be covered by both', (await run('$don fish duel @brock 100', ash)).includes('has no fish') && (await run('$don fish duel @gary 5000', ash)).includes('You only have 1,000')
        && (await run('$don fish duel @gary 200 300', ash)).includes('Usage:'));
      const wagered = await run('$don fish duel @gary 🐟 200', ash);
      check('a wager is named in the challenge, with the fish asked for', wagered.includes('🐟 60 cm') && wagered.includes('Stake: 200 $DON each'), wagered);
      const paid = await run('$don fish accept 🐢', gary);
      const row2 = lastDuel();
      const [w2, l2] = row2.winner_id === 51 ? [51, 52] : [52, 51];
      check('the loser pays the winner the wager, once', row2.stake === 'wager' && row2.amount === 200 && balance(ch, w2) === 1200 && balance(ch, l2) === 800
        && paid.includes('takes 200 $DON and now has 1,200') && fishOf(w2).lifetime.duel.coinsWon === 200 && fishOf(l2).lifetime.duel.coinsLost === 200, { paid, row2 });

      const keeps = await run('$don fish duel @gary keeps', ash);
      check('a duel for keeps says so', keeps.includes("the winner takes the loser's fish"), keeps);
      const taken = await run('$don fish accept', gary);
      const row3 = lastDuel();
      const ashWon = row3.winner_id === 51;
      check('for keeps: the loser\'s fish moves to the winner with its length', row3.stake === 'keeps' && taken.includes('for keeps!')
        && (ashWon ? fishOf(51).catch.types['🐢'] === 1 && (fishOf(52).catch.types['🐢'] ?? 0) === 0 && fishOf(51).catch.sizes!['🐢'][0].cm === 70 && fishOf(51).lifetime.duel.fishWon === 1 && fishOf(52).lifetime.duel.fishLost === 1
          : fishOf(52).catch.types['🦈'] === 1 && (fishOf(51).catch.types['🦈'] ?? 0) === 0 && fishOf(52).catch.sizes!['🦈'][0].cm === 90 && fishOf(52).lifetime.duel.fishWon === 1)
        && fishOf(51).catch.fish + fishOf(52).catch.fish === 4, { taken, row3 });

      // Whoever won, both go on with what they started with.
      const restock = (id: number, fish: Array<[string, number]>) => runWrite(ddb, () => {
        const d = fishOf(id);
        d.catch.fish = fish.length;
        d.catch.types = {};
        d.catch.sizes = {};
        for (const [n, cm] of fish) {
          d.catch.types[n] = (d.catch.types[n] ?? 0) + 1;
          (d.catch.sizes[n] ??= []).push({ cm, record: false });
        }
        saveFish(ddb, id, d, 2);
      });
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70]]);

      const misty: [string, number] = ['misty', 54];
      await run('$don fish duel @misty', ash);
      const denied = await run('$don fish deny', misty);
      await run('$don fish duel @misty', ash);
      const back = await run('$don fish deny', ash);
      check('a duel can be turned down, or taken back by the one who asked', denied.includes('@ash misty turned down') && back.includes('took back your challenge to misty')
        && (await run('$don fish deny', misty)).includes('no fish duel to turn down'), { denied, back });

      await run('$don fish duel @misty 🐟', ash);
      runWrite(ddb, () => { const d = fishOf(51); d.catch.types['🐟'] = 0; d.catch.sizes!['🐟'] = []; d.catch.fish -= 2; saveFish(ddb, 51, d, 2); });
      const off = await run('$don fish accept', misty);
      check('a challenger who no longer has the fish they named calls the duel off', off.includes('no longer has their 🐟') && (await run('$don fish accept', misty)).includes('Nobody has challenged you'), off);

      await run('$don fish duel @misty', ash);
      shift += 121_000;
      check('an unanswered challenge runs out', (await run('$don fish accept', misty)).includes('Nobody has challenged you'));

      const board = duelBoard(ch, effectivePointsConfig({ enabled: true, games: { enabled: true, duel: { enabled: true } } }), 999)!;
      check('the leaderboard counts duels, wagers and fish taken, and lists the latest', board.totals.duels === 3 && board.totals.wagered === 200 && board.totals.fishTaken === 1
        && board.recent.length === 3 && board.recent[0].stake === 'keeps' && board.champions.reduce((n, c) => n + c.wins, 0) === 3, board);
      const top = await run('$don fish top duelists', ash);
      const stats = await run('$don fish stats', ash);
      check('duel wins have a board and a stats line', top.includes('fish duelists') && /fish duels won: \d, lost: \d/.test(stats), { top, stats });

      // Team battles: 2v2 / 3v3, each side's fish one after another.
      check('team sizes: 2v2 and 3v3, not 4v4 or 2v3', teamSizeOf('3v3') === 3 && teamSizeOf('2V2') === 2 && teamSizeOf('4v4') === null && teamSizeOf('2v3') === null && teamSizeOf('300') === null);
      {
        let i = 0;
        const seq = Array.from({ length: 500 }, (_, k) => ((k * 7919) % 1000) / 1000);
        const rngA = () => seq[i++ % seq.length];
        const one = fight(fighterOf(g, item('🦈'), { cm: 80, record: false }), fighterOf(g, item('🐢'), { cm: 70, record: false }), rngA);
        i = 0;
        const solo = teamFight([fighterOf(g, item('🦈'), { cm: 80, record: false })], [fighterOf(g, item('🐢'), { cm: 70, record: false })], rngA);
        check('a team of one fights exactly as a one-fish duel', JSON.stringify(one.turns) === JSON.stringify(solo.turns) && one.winner === solo.winner && one.left[0] === solo.left[0][0]);
        const strong = [80, 85, 90].map(cm => fighterOf(g, item('🦈'), { cm, record: false }));
        const weak = [20, 25, 30].map(cm => fighterOf(g, item('🐟'), { cm, record: false }));
        const tb = teamFight(strong, weak);
        const sw = Array.from({ length: 200 }, () => teamFight(strong, weak).winner).filter(w => w === 0).length;
        check('chat waits for every fish coming in on the overlay: each one knocked out but a side\'s last, each adding the pause',
          switchesIn(tb) === 2 + tb.left[0].filter(hp => hp <= 0).length && switchesIn({ turns: [], winner: 0, left: [[0, 0, 5], [0, 0, 0]] }) === 4 && playMs(30, 2) === playMs(30) + 2 * SWITCH_MS, switchesIn(tb));
        check('a team battle goes on until one side has no fish standing, and the stronger team wins',
          tb.winner === 0 && tb.left[1].every(hp => hp === 0) && tb.left[0].some(hp => hp > 0) && tb.left[0].length === 3 && sw > 195, { tb: tb.left, sw });
      }
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70], ['🐟', 40], ['🦀', 30]]);
      const teamAsk = await run('$don fish duel @gary 3v3', ash);
      check('a 3v3 challenge names the team, strongest first', teamAsk.startsWith('@gary ⚔️ ash challenges you to a 3v3 fish battle with 🦈 90 cm, 🐟 60 cm, 🐟 20 cm') && teamAsk.includes('For glory only'), teamAsk);
      const teamDone = await run('$don fish accept', gary);
      const row4 = lastDuel();
      const teamShown = readOverlay(ddb).events.filter(e => e.kind === 'duel').pop();
      check('accepting fights the team battle: one result line, a row with every fish, nothing changes hands',
        /⚔️ @(ash|gary)'s team \(.*\) beat @(ash|gary)'s \(.*\) in \d+ turns, with [123] of 3 fish still standing\.$/.test(teamDone)
        && row4.challenger_fish === '🦈 🐟 🐟' && row4.opponent_fish === '🐢 🐟 🦀' && row4.stake === 'friendly'
        && fishOf(51).catch.fish === 3 && fishOf(52).catch.fish === 3, { teamDone, row4 });
      check('the overlay gets both teams in order and every turn', teamShown?.duel?.teams?.[0].length === 3 && teamShown.duel.teams[1].map(x => x.fish).join('') === '🐢🐟🦀'
        && teamShown.duel.a.fish === '🦈' && teamShown.duel.turns.length === row4.turns, teamShown?.duel);
      check('a team battle needs that many fish on both sides', (await run('$don fish duel @misty 3v3', ash)).includes("doesn't have 3 fish") && (await run('$don fish duel @gary 2v2', ['brock', 53])).includes('You need 2 fish'));
      const named = await run('$don fish duel @ash 2v2 crab', gary);
      check('fish named for a team go first, the strongest fill the rest', named.includes('2v2 fish battle with 🦀 30 cm, 🐢 70 cm'), named);
      await run('$don fish deny', gary);
      restock(51, [['🐟', 50], ['🐟', 51], ['🐟', 52]]);
      restock(52, [['🐟', 50], ['🐟', 51], ['🐟', 52]]);
      const teamKeeps = await run('$don fish duel @gary 3v3 keeps', ash);
      const keepsDone = await run('$don fish accept', gary);
      const kw = lastDuel().winner_id === 51 ? 51 : 52;
      const kl = kw === 51 ? 52 : 51;
      check('a 3v3 for keeps: the winner takes every fish on the losing team, with their lengths', teamKeeps.includes('Their team is worth') && keepsDone.includes('for keeps!')
        && fishOf(kw).catch.fish === 6 && fishOf(kw).catch.types['🐟'] === 6 && fishOf(kl).catch.fish === 0 && (fishOf(kw).catch.sizes!['🐟'] ?? []).length === 6
        && fishOf(kw).lifetime.duel.fishWon >= 3 && fishOf(kl).lifetime.duel.fishLost >= 3, { keepsDone, w: fishOf(kw).catch, l: fishOf(kl).catch });
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70]]);

      // A certain fish, by its length.
      check('lengths are read after the fish they follow, glued on or spaced', JSON.stringify(fishSpecs(['🦈72cm', '🐢', '20', 'cm', 'shark', '5CM', '🐟']))
        === JSON.stringify([{ fish: '🦈', cm: 72 }, { fish: '🐢', cm: 20 }, { fish: '🦈', cm: 5 }, { fish: '🐟' }]), fishSpecs(['🦈72cm', '🐢', '20', 'cm', 'shark', '5CM', '🐟']));
      const listed = await run('$don fish show 🐟', ash);
      check('show 🐟 lists each one, biggest first, with its duel stats and price', listed.includes('You have 2 🐟 (') && listed.indexOf('60 cm') < listed.indexOf('20 cm')
        && /60 cm ❤️\d+ ⚔️[\d.]+ 💰[\d,]+ \| 20 cm/.test(listed) && listed.includes('fish duel @user 🐟 60cm'), listed);
      const showAll = [await run('$don fish show fish', ash), await run('$don fish show @ash shrimp', gary), await run('$don fish show @ash 🦈', gary)];
      check('show fish is still every fish, and show @user 🐟 someone else\'s', showAll[0].includes('3 fish in your collection')
        && showAll[1].includes('no 🦐') && showAll[2].includes('They have 1 🦈'), showAll);
      check('a length you don\'t have is said so', (await run('$don fish duel @gary 🐟 33cm', ash)).includes("You don't have a 🐟 33 cm"));
      const exactAsk = await run('$don fish duel @gary 🐟 20 cm', ash);
      await run('$don fish accept', gary);
      const exactShown = readOverlay(ddb).events.filter(e => e.kind === 'duel').pop()?.duel;
      check('a duel with a fish named by length sends that very one, not the biggest', exactAsk.includes('their 🐟 20 cm') && exactShown?.a.fish === '🐟' && exactShown.a.cm === 20, { exactAsk, a: exactShown?.a });
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70], ['🦀', 30], ['🦀', 40]]);
      await run('$don fish duel @gary', ash);
      await run('$don fish accept 🦀30cm', gary);
      const acceptShown = readOverlay(ddb).events.filter(e => e.kind === 'duel').pop()?.duel;
      check('accepting with a fish named by length sends that one', acceptShown?.b.fish === '🦀' && acceptShown.b.cm === 30, acceptShown?.b);
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70], ['🦀', 30], ['🦀', 40]]);
      const teamExact = await run('$don fish duel @gary 2v2 🐟 20cm 🦈', ash);
      await run('$don fish accept 🦀 30cm', gary);
      const teamExactShown = readOverlay(ddb).events.filter(e => e.kind === 'duel').pop()?.duel;
      check('team fish can be named by length too, on both sides', teamExact.includes('2v2 fish battle with 🐟 20 cm, 🦈 90 cm')
        && teamExactShown?.teams?.[1][0].fish === '🦀' && teamExactShown.teams[1][0].cm === 30 && teamExactShown.teams[1][1].fish === '🐢', { teamExact, b: teamExactShown?.teams?.[1] });
      restock(51, [['🦈', 90], ['🐟', 20], ['🐟', 60]]);
      restock(52, [['🐢', 70]]);

      cfgWith({ allowKeeps: false, maxWager: 100 });
      const noKeeps = await run('$don fish duel @gary keeps', ash);
      const capped = await run('$don fish duel @gary 150', ash);
      check('keeps can be turned off and wagers capped', noKeeps.includes('for keeps are off') && capped.includes('most you can stake'), { noKeeps, capped });
      cfgWith({ cooldownSeconds: 300 });
      await run('$don fish duel @misty', ash);
      await run('$don fish deny', ash);
      check('a cooldown between one viewer\'s challenges', (await run('$don fish duel @misty', ash)).includes('challenge someone again in'));

      cfgWith({ enabled: false });
      check('duels are off unless the channel turns them on', (await run('$don fish duel @gary', ash)).includes('no fish duels here') && !effectivePointsConfig({}).games.duel.enabled);
    } finally {
      Date.now = realNow;
    }

    // Live only by its own rule, in a channel that fishes offline
    for (const [ch3, isLive] of [['fishduellive', true], ['fishduellive2', false]] as const) {
      writeConfig(root, ch3, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, duel: { enabled: true } } });
      makeService(ch3, { broadcaster: 999, live: async () => ({ isLive, startedAt: null }) });
      const got: string[] = [];
      const tg: KickTags = { username: `duelist${ch3.length}`, 'display-name': `duelist${ch3.length}`, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 61 };
      await fishCommand({ say: async (_c, m) => { got.push(m); } }, '$don fish duel @nobody', `#${ch3}`, tg, { channelName: ch3 } as ChannelConfig);
      check(`duel.onlyWhileLive: ${isLive ? 'answers while live' : 'stays silent offline'}`, (got.length === 1) === isLive, got);
    }
    const duelCfg = validatePointsPatch({}, { enabled: true, games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true, onlyWhileLive: true }, duel: { enabled: true, maxWager: 500 } } });
    const duelBad = validatePointsPatch({}, { games: { duel: { enabled: 'yes', expirySeconds: 5, maxWager: -1 } } });
    const eff = effectivePointsConfig(duelCfg.next);
    const fishing = publicCommands(eff).sections.find(sec => sec.title === 'Fishing')!;
    check('duel settings are stored, validated and listed', duelCfg.errors.length === 0 && eff.games.duel.enabled && eff.games.duel.onlyWhileLive && eff.games.duel.maxWager === 500
      && Object.keys(duelCfg.next?.games?.duel ?? {}).sort().join(',') === 'enabled,maxWager' && duelBad.errors.length === 3
      && fishing.note!.includes('Stealing and duels only work while the stream is live.') && fishing.rows.some(r => r.usage.includes('fish duel @user') && r.short === '$points f d @user')
      && fishing.rows.some(r => r.short === '$points f a') && fishing.rows.some(r => r.short === '$points f dn'), { errors: duelCfg.errors, bad: duelBad.errors, note: fishing.note });
  }

  // Stealing: a hook to try, rarity odds, a burned fine, guards, grace and protection
  // $don video: pay per second to play a YouTube video on the video overlay, one at a time
  {
    check('YouTube links: watch, youtu.be, shorts, mobile, with t= and start=', JSON.stringify([
      parseYouTubeLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), parseYouTubeLink('youtu.be/dQw4w9WgXcQ?t=90'),
      parseYouTubeLink('https://youtube.com/shorts/dQw4w9WgXcQ'), parseYouTubeLink('https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s'),
      parseYouTubeLink('https://www.youtube.com/embed/dQw4w9WgXcQ?start=5'), parseYouTubeLink('https://vimeo.com/123'), parseYouTubeLink('nonsense')
    ]) === JSON.stringify([{ id: 'dQw4w9WgXcQ', start: 0 }, { id: 'dQw4w9WgXcQ', start: 90 }, { id: 'dQw4w9WgXcQ', start: 0 }, { id: 'dQw4w9WgXcQ', start: 90 }, { id: 'dQw4w9WgXcQ', start: 5 }, null, null])
      && isoDurationSeconds('PT3M33S') === 213 && isoDurationSeconds('PT1H') === 3600 && isoDurationSeconds('P0D') === 0);

    // Media share's skipped-video card: why YouTube wouldn't play it, region locks first.
    {
      const answer = (contentDetails: Record<string, unknown>, status = { embeddable: true, privacyStatus: 'public' }) => (async () => ({ ok: true, status: 200, json: async () => ({ items: [{ snippet: { title: 'x' }, contentDetails: { duration: 'PT1M', ...contentDetails }, status }] }) }));
      const blocked = await lookupVideo('EEEEEEEEEEE', 'k', answer({ regionRestriction: { blocked: ['MY', 'SG'] } }));
      const onlyUs = await lookupVideo('EEEEEEEEEEE', 'k', answer({ regionRestriction: { allowed: ['US'] } }));
      const many = await lookupVideo('EEEEEEEEEEE', 'k', answer({ regionRestriction: { blocked: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] } }));
      const noEmbed = await lookupVideo('EEEEEEEEEEE', 'k', answer({}, { embeddable: false, privacyStatus: 'public' }));
      const fine = await lookupVideo('EEEEEEEEEEE', 'k', answer({}));
      const licensed = await lookupVideo('EEEEEEEEEEE', 'k', answer({ regionRestriction: { allowed: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] } }));
      const both = await lookupVideo('EEEEEEEEEEE', 'k', answer({ regionRestriction: { blocked: ['MY'] } }, { embeddable: false, privacyStatus: 'public' }));
      check('media share skip reasons: blocked countries, only-in list, embedding off, both, removed, none', unplayableReason(blocked) === 'it is blocked in MY, SG'
        && unplayableReason(onlyUs) === 'it only plays in US'
        && unplayableReason(many) === 'it is blocked in 7 countries'
        && unplayableReason(noEmbed) === 'its owner turned off playing it outside YouTube'
        && unplayableReason(null) === 'it was removed or made private'
        && unplayableReason(fine) === null
        && unplayableReason(licensed) === 'it is only licensed in some countries (7), probably not where this phone is'
        && unplayableReason(both) === 'its owner turned off playing it outside YouTube; and it is blocked in MY', [blocked, onlyUs, unplayableReason(many), noEmbed, fine, unplayableReason(both)]);
      check('media share queue flags only what never plays: embedding off, removed; not region locks or fine ones',
        neverPlaysReason(noEmbed) === 'its owner turned off playing it outside YouTube' && neverPlaysReason(null) === 'it was removed or made private'
        && neverPlaysReason(blocked) === null && neverPlaysReason(licensed) === null && neverPlaysReason(fine) === null);
      // "Find another version": only uploads that play outside YouTube, unlocked first, nearest length.
      let searched = '';
      const ytFake = (async (url: string) => {
        const u = new URL(url);
        if (u.pathname.endsWith('/search')) {
          searched = u.searchParams.get('q') ?? '';
          return { ok: true, status: 200, json: async () => ({ items: ['ORIGINAL000', 'AGERESTRICT', 'ONLYINSOME0', 'LOCKEDRU000', 'FARLENGTH00', 'NEARLENGTH0', 'LIVESTREAM0'].map(videoId => ({ id: { videoId } })) }) };
        }
        const v = (id: string, d: string, extra: Record<string, unknown> = {}, live = 'none') => ({ id, snippet: { title: `T ${id}`, channelTitle: 'C', liveBroadcastContent: live }, contentDetails: { duration: d, ...extra }, status: { embeddable: true, privacyStatus: 'public' } });
        return { ok: true, status: 200, json: async () => ({ items: [
          v('AGERESTRICT', 'PT3M', { contentRating: { ytRating: 'ytAgeRestricted' } }), v('ONLYINSOME0', 'PT3M', { regionRestriction: { allowed: ['US'] } }),
          v('LOCKEDRU000', 'PT3M', { regionRestriction: { blocked: ['RU'] } }), v('FARLENGTH00', 'PT10M'), v('NEARLENGTH0', 'PT3M5S'), v('LIVESTREAM0', 'P0D', {}, 'live')
        ] }) };
      });
      const alts = await findAlternatives('Song Name (Official Music Video) [Lyrics]', 'ORIGINAL000', 180, 'k', ytFake);
      check('media share alternatives: playable outside YouTube only, close in length, unlocked first, noise dropped from the search',
        JSON.stringify(alts.map(a => a.videoId)) === JSON.stringify(['NEARLENGTH0', 'LOCKEDRU000']) && searched === 'Song Name', [alts.map(a => a.videoId), searched]);
      const plain = await searchPlayable('song', 'k', { max: 5, maxS: 20 * 60 }, ytFake);
      check('media share search: YouTube\'s order, unlocked first, nothing age-restricted, country-only, live or too long',
        JSON.stringify(plain.map(a => a.videoId)) === JSON.stringify(['FARLENGTH00', 'NEARLENGTH0', 'LOCKEDRU000'])
        && (await searchPlayable('song', 'k', { max: 5, maxS: 120 }, ytFake)).length === 0, plain.map(a => a.videoId));
      check('media share skip reasons from the player error code alone', youTubeErrorReason(100) === 'it was removed or made private'
        && youTubeErrorReason(150).includes('blocked in your country') && youTubeErrorReason(999) === 'YouTube refused it (error 999)');
    }

    const ch = 'videoch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', video: { enabled: true, pricePerSecond: 10, maxSeconds: 60, queueMax: 3, onlyWhileLive: false } });
    makeService(ch, { broadcaster: 999 });
    const vdb = openPointsDb(ch, { create: true })!;
    runWrite(vdb, () => {
      for (const [id, name, bal] of [[61, 'ann', 5000], [62, 'ben', 5000], [63, 'cat', 5000], [64, 'dan', 5000], [65, 'eve', 100]] as const) creditTx(vdb, { userId: id, username: name, amount: bal, reason: 'mod_add', now: 1 });
    });
    // YouTube, faked: three videos and their states.
    const VIDEOS: Record<string, unknown> = {
      AAAAAAAAAAA: { snippet: { title: 'Funny cat <3 @you', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT45S' }, status: { embeddable: true, privacyStatus: 'public' } },
      BBBBBBBBBBB: { snippet: { title: 'Long one', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT10M' }, status: { embeddable: true, privacyStatus: 'public' } },
      CCCCCCCCCCC: { snippet: { title: 'No embed', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT1M' }, status: { embeddable: false, privacyStatus: 'public' } },
      DDDDDDDDDDD: { snippet: { title: 'A stream', liveBroadcastContent: 'live' }, contentDetails: { duration: 'P0D' }, status: { embeddable: true, privacyStatus: 'public' } }
    };
    const realFetch = globalThis.fetch;
    const realKey = process.env.YOUTUBE_API_KEY;
    globalThis.fetch = (async (url: string) => {
      const id = new URL(url).searchParams.get('id') ?? '';
      return { ok: true, status: 200, json: async () => ({ items: VIDEOS[id] ? [VIDEOS[id]] : [] }) };
    }) as unknown as typeof fetch;
    process.env.YOUTUBE_API_KEY = 'test';
    try {
      const run = async (msg: string, who: [string, number], mod = false) => {
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: who[1] };
        await pointsCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      check('no video overlay open: turned away, nothing charged', (await run('$don video youtu.be/AAAAAAAAAAA', ['ann', 61])).includes("isn't on stream") && balance(ch, 61) === 5000);
      markVideoOverlaySeen(vdb);
      const q1 = await run('$don video https://youtu.be/AAAAAAAAAAA?t=5', ['ann', 61]);
      check('a video is priced on the seconds it plays (from its start time) and queued', q1.includes('queued Funny cat 3 you (0:40) for 400 $DON') && q1.includes('plays now') && balance(ch, 61) === 4600, q1);
      check('one in line each', (await run('$don v youtu.be/BBBBBBBBBBB', ['ann', 61])).includes('already have a video') && balance(ch, 61) === 4600);
      const q2 = await run('$don video youtu.be/BBBBBBBBBBB', ['ben', 62]);
      check('a long one plays up to maxSeconds and is priced on that', q2.includes('(1:00) for 600 $DON') && q2.includes('after 1 other') && balance(ch, 62) === 4400, q2);
      check('no embed, livestreams, unknown videos and bad links are turned away uncharged',
        (await run('$don video youtu.be/CCCCCCCCCCC', ['cat', 63])).includes("doesn't let it play") && (await run('$don video youtu.be/DDDDDDDDDDD', ['cat', 63])).includes('livestreams')
        && (await run('$don video youtu.be/EEEEEEEEEEE', ['cat', 63])).includes("can't find") && (await run('$don video hello', ['cat', 63])).includes('send a YouTube link') && balance(ch, 63) === 5000);
      check('too poor: told the price, nothing queued', (await run('$don video youtu.be/AAAAAAAAAAA', ['eve', 65])).includes('costs 450 $DON; you have 100') && balance(ch, 65) === 100 && !hasVideoInLine(vdb, 65));
      await run('$don video youtu.be/AAAAAAAAAAA', ['cat', 63]);
      check('the line holds queueMax', (await run('$don video youtu.be/AAAAAAAAAAA', ['dan', 64])).includes('line is full') && balance(ch, 64) === 5000);

      // The overlay's feed moves the queue on.
      const t0 = Date.now();
      const first = advanceVideos(vdb, t0);
      check('the first paid plays first, from its start time', first?.username === 'ann' && first.start_s === 5 && first.seconds === 40 && advanceVideos(vdb, t0 + 30_000)?.id === first.id, first);
      const second = advanceVideos(vdb, t0 + 40_000 + LOAD_PAD_MS);
      check('once its slot is over, the next starts', second?.username === 'ben' && (vdb.prepare('SELECT status FROM video_queue WHERE id = ?').get(first!.id) as { status: string }).status === 'done', second);
      check('only mods skip', (await run('$don video skip', ['dan', 64])) === '' && playingVideo(vdb)?.username === 'ben');
      const skipped = await run('$don video skip', ['modder', 66], true);
      check('a mod skips the one playing, unrefunded', skipped.includes("Skipped @ben's video") && balance(ch, 62) === 4400 && advanceVideos(vdb)?.username === 'cat', skipped);
      const catVideo = playingVideo(vdb)!;
      check('a video the overlay can\'t play is refunded, once', failVideo(vdb, catVideo.id) && balance(ch, 63) === 5000 && !failVideo(vdb, catVideo.id) && advanceVideos(vdb) === null);
      const info = await run('$don video', ['dan', 64]);
      check('$don video says what is on and how to share', info.includes('Nothing playing') && info.includes('$don video YOUTUBE-LINK') && info.includes('10 $DON a second'), info);
      const rows = publicCommands(effectivePointsConfig({ enabled: true, video: { enabled: true } })).sections[0].rows.filter(r => r.usage.includes('video'));
      check('the Commands tab lists video where it is on', rows.length === 3 && rows[0].short === '$points v <link>' && !publicCommands(effectivePointsConfig({ enabled: true })).sections[0].rows.some(r => r.usage.includes('video')), rows);
    } finally {
      globalThis.fetch = realFetch;
      if (realKey === undefined) delete process.env.YOUTUBE_API_KEY; else process.env.YOUTUBE_API_KEY = realKey;
    }
  }

  // $don wordle: one shared board, first right guess wins the prize
  {
    check('wordle squares: greens first, yellows only for letters left over', marksFor('crane', 'crane') === '🟩🟩🟩🟩🟩'
      && marksFor('react', 'crane') === '🟨🟨🟩🟨⬜' && marksFor('eerie', 'there') === '🟨⬜🟨⬜🟩' && marksFor('speed', 'abide') === '⬜⬜🟨⬜🟨'
      && marksFor('llama', 'hello') === '🟨🟨⬜⬜⬜', [marksFor('react', 'crane'), marksFor('eerie', 'there'), marksFor('speed', 'abide'), marksFor('llama', 'hello')]);
    const ch = 'wordlech';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', wordle: { enabled: true, prize: 500, maxGuesses: 3, guessCooldownSeconds: 0 } });
    makeService(ch, { broadcaster: 999 });
    const wdb = openPointsDb(ch, { create: true })!;
    let msgN = 0;
    const run = async (msg: string, who: [string, number], mod = false) => {
      const out: string[] = [];
      const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: who[1], messageId: `w${++msgN}` };
      await wordleCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out[0] ?? '';
    };
    const setWord = (word: string) => runWrite(wdb, () => wdb.prepare("UPDATE meta SET value = json_set(value, '$.word', ?) WHERE key = 'wordle_game'").run(word));
    check('viewers can\'t start one; there\'s none yet', (await run('$don wordle start', ['ann', 91])) === '' && (await run('$don wordle', ['ann', 91])).includes('No Wordle is on'));
    check('no stats before a game ends', (await run('$don w st', ['modder', 92], true)).includes('no Wordle games have been played'));
    const started = await run('$don wordle start', ['modder', 92], true);
    check('a mod starts one, with the rules', started.includes('Wordle!') && started.includes('$don w WORD') && started.includes('3 guesses for the whole chat') && started.includes('wins 500 $DON'), started);
    setWord('crane');
    check('$don w s is start: one is on already', (await run('$don w s', ['modder', 92], true)).includes('already on'));
    const startGuess = await run('$don w start', ['ann', 91]);
    check('during a game START is a guess, from anyone', startGuess.startsWith('START ') && startGuess.includes('Guesses: 1/3'), startGuess);
    check('not a word, or not 5 letters, uses no guess', (await run('$don wordle zzzzz', ['ann', 91])).includes("isn't in my word list") && (await run('$don wordle cat', ['ann', 91])).includes('5 letters'));
    const g1 = await run('$don w g react', ['ann', 91]);
    check('a guess gets its squares, the count and the alphabet so far', g1.startsWith('REACT 🟨🟨🟩🟨⬜ | Guesses: 2/3 | Unused:') && g1.includes('Not in word: ST'), g1);
    check('the same word twice is turned away', (await run('$don wordle REACT', ['ben', 93])).includes('guessed already'));
    const boardNow = await run('$don wordle', ['ben', 93]);
    check('$don wordle shows the board', boardNow.startsWith('START ') && boardNow.includes('REACT 🟨🟨🟩🟨⬜') && boardNow.includes('Guesses: 2/3'), boardNow);
    const won = await run('$don wordle crane', ['ben', 93]);
    check('the first right guess wins the prize', won.includes('🎉 @ben got it in 3/3: CRANE 🟩🟩🟩🟩🟩 +500 $DON') && balance(ch, 93) === 500, won);
    check('with no game on, a guess gets no reply at all', (await run('$don wordle crane', ['ann', 91])) === '' && (await run('$don w scammer', ['ann', 91])) === '');
    await run('$don wordle start', ['modder', 92], true);
    setWord('crane');
    await run('$don wordle slate', ['ann', 91]);
    await run('$don wordle pious', ['ann', 91]);
    const lost = await run('$don wordle dumpy', ['ben', 93]);
    check('out of guesses: the word is shown, no prize', lost.includes('Out of guesses! The word was CRANE') && balance(ch, 93) === 500, lost);
    await run('$don wordle start', ['modder', 92], true);
    setWord('crane');
    const midStats = await run('$don wordle stats', ['ann', 91]);
    check('$don wordle stats mid-game shows the stats, not a guess: a win and a loss so far', midStats.includes('📊 Wordle Stats: 2 games played | Avg guesses: 3.0 | Top 5: ben (1)'), midStats);
    check('stats are once per 30s for viewers, any time for mods', (await run('$don w st', ['ben', 93])) === '' && (await run('$don w st', ['modder', 92], true)).includes('2 games played'));
    check('a mod can stop one with x, showing the word', (await run('$don w x', ['modder', 92], true)).includes('The word was CRANE'));
    check('a stopped game isn\'t counted', readWordleStats(wdb).gamesPlayed === 2 && readWordleStats(wdb).totalGuesses === 6);
    const rows = publicCommands(effectivePointsConfig({ enabled: true, wordle: { enabled: true } })).sections.find(sec => sec.title === 'Games')?.rows.filter(r => r.usage.includes('wordle')) ?? [];
    check('the Commands tab lists wordle where it is on', rows.length === 6 && rows[0].short === '$points w <word>' && rows.some(r => r.short === '$points w st') && rows.some(r => r.short === '$points w s') && rows.some(r => r.short === '$points w x')
      && !(publicCommands(effectivePointsConfig({ enabled: true })).sections.find(sec => sec.title === 'Games')?.rows ?? []).some(r => r.usage.includes('wordle')), rows);
  }

  // fish give: one kind to someone who has fished before, on a cooldown, only where it's on
  {
    const ch = 'fishgive';
    const cfgWith = (games: Record<string, unknown>) => writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, ...games } });
    cfgWith({ giveEnabled: false });
    makeService(ch, { broadcaster: 999 });
    const gdb = openPointsDb(ch, { create: true })!;
    const fishOf = (id: number) => loadFish(gdb, id)!;
    const seed = (id: number, name: string, fished: boolean, extra: (d: FishData) => void = () => {}) => runWrite(gdb, () => {
      creditTx(gdb, { userId: id, username: name, amount: 10, reason: 'mod_add', now: 1 });
      const d = initialData();
      if (fished) d.lifetime.attempts = 1;
      extra(d);
      saveFish(gdb, id, d, 1);
    });
    const fish = (n: string) => ITEMS.find(x => x.name === n)!;
    seed(51, 'giver', true, d => {
      for (let i = 0; i < 3; i++) addItem(d, fish('🐟'));
      d.catch.sizes = { '🐟': [{ cm: 20, record: false }, { cm: 70, record: true }] }; // 2 sized, oldest 20 cm, and 1 unsized
      addItem(d, fish('🥫'));
    });
    seed(52, 'friend', true);
    seed(53, 'newbie', false);
    seed(54, 'biter', false, d => { addItem(d, fish('🦭')); d.lifetime.fish = 1; }); // only ever reeled in a big bite
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string, who: [string, number] = ['giver', 51]) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      check('fish give is off unless the channel turns it on', (await run('$don fish give @friend 🐟')).includes('switched off') && fishOf(51).catch.types['🐟'] === 3);
      cfgWith({ giveEnabled: true, giveCooldownSeconds: 30 });
      shift += 20_000; // the service re-reads its settings
      const toNew = await run('$don fish give @newbie 🦐');
      check('even someone who has never fished can take one', toNew.includes("don't have any 🦐") && fishOf(51).catch.types['🐟'] === 3, toNew);
      check('not more than you hold, nor to yourself', (await run('$don fish give @friend 🐟 4')).includes('only have 3') && (await run('$don fish give @giver 🐟')).includes('yourself'));
      const gave = await run('$don f gv @friend 🐟 2');
      check('the one given to is alerted', alertsFor(gdb, 52).some(a => a.kind === 'gift' && a.text === '🎁 giver gave you 2 🐟!'), alertsFor(gdb, 52));
      check('a give moves that many, oldest sized first, lengths kept and the record bonus left behind', gave.includes('You gave @friend 2 🐟') && gave.includes('1 left')
        && fishOf(51).catch.types['🐟'] === 1 && fishOf(51).catch.fish === 1 && fishOf(52).catch.types['🐟'] === 2 && fishOf(52).catch.fish === 2
        && JSON.stringify(fishOf(52).catch.sizes?.['🐟']) === JSON.stringify([{ cm: 20, record: false }, { cm: 70, record: false }]), { gave, from: fishOf(51).catch, to: fishOf(52).catch });
      check('one give per cooldown', (await run('$don fish give @friend 🥫')).includes('give fish again in') && fishOf(51).catch.types['🥫'] === 1);
      shift += 30_000;
      const junk = await run('$don fish give @friend 🥫');
      check('junk moves too, and counts as junk', junk.includes('You gave @friend 🥫') && fishOf(51).catch.junk === 0 && fishOf(52).catch.junk === 1 && fishOf(52).catch.types['🥫'] === 1, { junk, to: fishOf(52).catch });
      shift += 30_000;
      shift += 30_000;
      const toBiter = await run('$don fish give @biter 🐟');
      check('a viewer whose only catch was a big bite can take fish', toBiter.includes('You gave @biter 🐟') && fishOf(54).catch.types['🐟'] === 1, toBiter);
      shift += 30_000;
      seed(55, 'nobody', false);
      runWrite(gdb, () => gdb.prepare('DELETE FROM fish WHERE user_id = 55').run()); // known to the bot, no fishing record at all
      const toNobody = await run('$don fish give @nobody 🥫', ['friend', 52]);
      check('and so can someone with no fishing record at all: one starts with the gift', toNobody.includes('You gave @nobody 🥫') && fishOf(55).catch.junk === 1 && fishOf(55).lifetime.attempts === 0, toNobody);
      shift += 30_000;
      const glued = await run('$don fish give @giver 🐟1', ['biter', 54]);
      check('a count typed onto the emoji works too (🐟1)', glued.includes('You gave @giver 🐟') && fishOf(51).catch.types['🐟'] === 1 && fishOf(54).catch.types['🐟'] === 0, glued);
      shift += 30_000;
      check('a number with no fish says to name the fish', (await run('$don fish give @friend 1')).includes('Name the fish'));
      runWrite(gdb, () => { const d = fishOf(51); for (let i = 0; i < 3; i++) addItem(d, fish('🦈')); saveFish(gdb, 51, d, 1); });
      const byName = await run('$don fish give @friend 2 Sharks');
      shift += 30_000;
      const after = await run('$don fish give shark @friend');
      check('fish can be named by word, plural, count first, and the @user can come last', byName.includes('You gave @friend 2 🦈') && after.includes('You gave @friend 🦈')
        && fishOf(51).catch.types['🦈'] === 0 && fishOf(52).catch.types['🦈'] === 3, { byName, after });
      shift += 30_000;
      check('one kind at a time, and a clear usage line', (await run('$don fish give @friend 🐟 🥫')).includes('One kind at a time') && (await run('$don fish give')).includes('Give what to whom'));
      // A certain fish by its length: friend holds 🐟 20 cm and 70 cm (from the give above).
      const missingLen = await run('$don fish give @giver 🐟 33cm', ['friend', 52]);
      const byLength = await run('$don fish give @giver 🐟 70cm', ['friend', 52]);
      check('a length gives that very fish, not the oldest', missingLen.includes("You don't have a 🐟 33 cm") && byLength.includes('You gave @giver 🐟 (70 cm)')
        && JSON.stringify(fishOf(52).catch.sizes?.['🐟']) === JSON.stringify([{ cm: 20, record: false }]) && fishOf(51).catch.sizes!['🐟'].some(h => h.cm === 70), { missingLen, byLength, friend: fishOf(52).catch.sizes });
      shift += 30_000;
      check('a length only for fish, one at a time, and no more than are that long',
        (await run('$don fish give @giver 🥫 5cm', ['friend', 52])).includes('Only fish have a length')
        && (await run('$don fish give @giver 🐟 20 cm 70cm', ['friend', 52])).includes('One length at a time')
        && (await run('$don fish give @giver 🐟20cm 2', ['friend', 52])).includes('only have 1'));
      // fish remove: the streamer (or the bot owner) takes fish off a viewer, for nothing.
      seed(56, 'cheater', true, d => {
        for (const [n, cm] of [['🦈', 72], ['🦈', 40], ['🐟', 50], ['🐟', 50], ['🐟', 61]] as const) {
          addItem(d, fish(n));
          ((d.catch.sizes ??= {})[n] ??= []).push({ cm, record: false });
        }
        addItem(d, fish('🥫'));
      });
      const asStreamer = async (msg: string, who: [string, number] = [ch, 999], broadcaster = true) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: broadcaster, isModUp: broadcaster, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const notAllowed = await asStreamer('$don fish remove @cheater 🦈', ['friend', 52], false);
      const short = await asStreamer('$don fish remove @cheater 🦈 72cm 99cm');
      check('only the streamer or the bot owner removes fish, and nothing goes if any isn\'t theirs', notAllowed === '' && short.includes('Nothing removed: cheater has no 🦈 99 cm')
        && fishOf(56).catch.types['🦈'] === 2, { notAllowed, short });
      const sold = fishOf(56).lifetime.sold;
      const removed = await asStreamer('$don fish rm @cheater 🦈 72cm 🐟 50cm 2');
      const c = fishOf(56).catch;
      check('remove takes those very fish, and isn\'t a sale', removed.includes('Removed 🦈 72 cm, 🐟 50 cm x2 from @cheater') && removed.includes('2 fish and 1 junk left')
        && JSON.stringify(c.sizes!['🦈']) === JSON.stringify([{ cm: 40, record: false }]) && JSON.stringify(c.sizes!['🐟']) === JSON.stringify([{ cm: 61, record: false }])
        && fishOf(56).lifetime.sold === sold && balance(ch, 56) === 10, { removed, c });
      const wiped = await asStreamer('$don fish remove @cheater all');
      check('remove all takes every fish and leaves the junk', wiped.includes('Removed') && fishOf(56).catch.fish === 0 && fishOf(56).catch.junk === 1
        && (await asStreamer('$don fish remove @cheater all junk')).includes('🥫') && fishOf(56).catch.junk === 0, wiped);
      // fish add: the streamer (or the bot owner) hands a viewer fish, from nothing.
      const addDenied = await asStreamer('$don fish add @cheater 🦈 72cm', ['friend', 52], false);
      const caught = fishOf(56).lifetime.fish;
      const granted = await asStreamer('$don fish add @cheater 🦈 72cm 🐟 2 🥫');
      const ac = fishOf(56).catch;
      check('only the streamer or the bot owner adds fish: those lengths, random ones otherwise, not a catch', addDenied === ''
        && granted.includes('Added 🦈 72 cm, 🐟 (') && granted.includes('🥫 to @cheater') && ac.types['🦈'] === 1 && ac.types['🐟'] === 2 && ac.fish === 3 && ac.junk === 1
        && ac.sizes!['🦈'][0].cm === 72 && ac.sizes!['🐟'].length === 2 && ac.sizes!['🐟'].every(h => h.cm >= 1 && h.cm <= 100) && fishOf(56).lifetime.fish === caught, { granted, ac });
      const lead = await asStreamer('$don fish add @cheater 1cm 🦈');
      check('a length typed before the fish goes with it', lead.includes('Added 🦈 1 cm to @cheater') && fishOf(56).catch.sizes!['🦈'].some(h => h.cm === 1)
        && (await asStreamer('$don fish remove @cheater 1cm 🦈')).includes('Removed 🦈 1 cm') && (await asStreamer('$don fish add @cheater 5cm')).includes('Name the fish before its length'), lead);
      check('add keeps to the bucket cap and lengths of 1 to 100', (await asStreamer('$don fish add @cheater 🐟 100')).includes('Nothing added: @cheater has 3/100 fish, room for 97 more')
        && (await asStreamer('$don fish add @cheater 🐟 101cm')).includes('1 to 100 cm') && fishOf(56).catch.fish === 3);
      await asStreamer('$don fish remove @cheater all junk');
      check('the Commands tab lists remove for the streamer', publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true } })).sections.find(sec => sec.title === 'Fishing')!.rows
        .some(r => r.usage.includes('fish remove') && r.who === 'streamer'));
      const row = publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true, giveEnabled: true } })).sections.find(sec => sec.title === 'Fishing')!.rows.find(r => r.usage.includes('fish give'));
      check('the Commands tab lists fish give where it is on, and only there', row?.short === '$points f gv @user 🐟'
        && !publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true } })).sections.find(sec => sec.title === 'Fishing')!.rows.some(r => r.usage.includes('fish give')), row);
    } finally {
      Date.now = realNow;
    }
  }

  // Guards stand still while live when stealing is offline only (fish-shop.ts syncGuardPause)
  {
    const ch = 'guardpause';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true, guardHours: 12, guardMinimum: 10 } } });
    const g = effectivePointsConfig({ enabled: true, games: { enabled: true, onlyWhileLive: false, onlyWhileOffline: true, steal: { enabled: true, guardHours: 12, guardMinimum: 10 } } }).games;
    const pdb = openPointsDb(ch, { create: true })!;
    const H = 3_600_000;
    const t0 = 1_000 * H;
    const guardOf = (id: number) => loadFish(pdb, id)!.guardUntil ?? 0;
    runWrite(pdb, () => {
      for (const [id, until] of [[1, t0 + 5 * H], [2, t0 - H]] as const) {
        ensureUserTx(pdb, id, `gp${id}`, 1);
        const d = initialData();
        d.guardUntil = until;
        saveFish(pdb, id, d, 1);
      }
      ensureUserTx(pdb, 3, 'gp3', 1);
      creditTx(pdb, { userId: 3, username: 'gp3', amount: 10_000, reason: 'mod_add', now: 1 });
      const d3 = initialData();
      addItem(d3, ITEMS.find(x => x.name === '🐟')!);
      saveFish(pdb, 3, d3, 1);
    });
    check('no pause without the offline rule', (() => { syncGuardPause(pdb, effectivePointsConfig({ enabled: true, games: { enabled: true, steal: { enabled: true } } }).games, true, t0); return guardPausedAt(pdb) === null; })());
    check('no pause when the live rule wins (both rules on, hand-edited)',
      !guardsPauseWhileLive({ ...g, onlyWhileLive: true }) && !guardsPauseWhileLive({ ...g, steal: { ...g.steal, onlyWhileLive: true } }));
    // A stream start an hour back (the rule turned on mid-stream, say) isn't credited: from now.
    syncGuardPause(pdb, g, true, t0, t0 - H);
    const pausedFrom = guardPausedAt(pdb);
    syncGuardPause(pdb, g, false, t0);
    // Noticed 10 minutes late: guards stood still from the stream's start.
    syncGuardPause(pdb, g, true, t0 + 10 * 60_000, t0);
    check('going live pauses guards from the stream\'s start when it was just now, else from now',
      pausedFrom === t0 && guardPausedAt(pdb) === t0);
    syncGuardPause(pdb, g, false, t0);
    syncGuardPause(pdb, g, true, t0, t0 - H);
    syncGuardPause(pdb, g, true, t0 + H, t0 - H);
    check('a second live sync changes nothing', guardPausedAt(pdb) === t0);
    const mid = t0 + 2 * H;
    check('while paused a running guard\'s end moves on with the stream; one that ended before it doesn\'t',
      guardEnd(guardOf(1), guardPausedAt(pdb), mid) === t0 + 5 * H + 2 * H && guardEnd(guardOf(2), guardPausedAt(pdb), mid) === t0 - H);
    check('a guard\'s time left stands still while paused', guardEnd(guardOf(1), guardPausedAt(pdb), mid) - mid === guardEnd(guardOf(1), guardPausedAt(pdb), t0) - t0);
    const bought = runWrite(pdb, () => buyGuard({ db: pdb, g, userId: 3, username: 'gp3', actor: 'chat:gp3', cur: '$DON', cmd: '$don', now: mid }));
    check('a guard can be bought while paused', bought.ok, bought);
    const view = shopView(pdb, g, 3, mid).steal;
    check('the shop says paused and the full hours are left', view?.guardPaused === true && Date.parse(view.guardUntil ?? '') - mid === 12 * H, view);
    const end = t0 + 4 * H;
    syncGuardPause(pdb, g, false, end);
    check('going offline: running guards move on by the stream, a bought one starts its hours now, an old one stays',
      guardPausedAt(pdb) === null && guardOf(1) === t0 + 5 * H + 4 * H && guardOf(3) === end + 12 * H && guardOf(2) === t0 - H,
      { g1: guardOf(1) - t0, g3: guardOf(3) - end, g2: guardOf(2) - t0 });
    check('the shop runs again after', shopView(pdb, g, 3, end).steal?.guardPaused === false);
  }

  // Aimed steals: a kind or one fish by length, at that fish's own odds
  {
    const ch = 'aimsteal';
    // Luck 100 keeps a common fish at 100% whatever its value (an 80 cm 🐟 is 79% on value alone).
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, steal: { enabled: true, oddsCommon: 100, luckPercent: 100 } } });
    makeService(ch, { broadcaster: 999 });
    const adb = openPointsDb(ch, { create: true })!;
    const fishOf = (id: number) => loadFish(adb, id)!;
    const seed = (id: number, name: string, bal: number, held: Array<[string, number]>, hook = 0) => runWrite(adb, () => {
      creditTx(adb, { userId: id, username: name, amount: bal, reason: 'mod_add', now: 1 });
      const d = initialData();
      d.lifetime.attempts = 1;
      d.hook = hook;
      for (const [fishName, cm] of held) {
        addItem(d, ITEMS.find(x => x.name === fishName)!);
        (((d.catch.sizes ??= {})[fishName]) ??= []).push({ cm, record: false });
      }
      saveFish(adb, id, d, 1);
    });
    seed(61, 'aimer', 100_000, [], 3);
    seed(62, 'aimkind', 10, [['🐟', 30], ['🐟', 30], ['🐟', 30], ['🐋', 100]]);
    seed(63, 'aimlen', 10, [['🐟', 20], ['🐟', 80]]);
    seed(64, 'nokind', 10, [['🐟', 50]]);
    seed(65, 'freshlen', 10, [['🐟', 40], ['🐟', 70]]);
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string) => {
        shift += 31 * 60_000;   // past the fishing cooldown each time
        const out: string[] = [];
        const t: KickTags = { username: 'aimer', 'display-name': 'aimer', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 61 };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      check('aiming at junk is turned away, nothing spent', (await run('$don fish steal @aimkind 🥫')).includes('only grabs fish') && fishOf(61).hook === 3);
      check('aiming at two fish asks for one', (await run('$don fish steal @aimkind 🐟 🐋')).includes('Name one fish to aim for') && fishOf(61).hook === 3);
      const none = await run('$don fish steal @nokind 🐋');
      check('a kind they don\'t hold is turned away before anything is spent', none.includes("doesn't have a 🐋") && fishOf(61).hook === 3 && balance(ch, 61) === 100_000, none);
      const whale = await run('$don fish steal @aimkind 🐋');
      check('aiming at a kind reaches for that kind, past the commoner fish', whale.includes('their ✨🐋✨') && fishOf(61).hook === 2, whale);
      const len = await run('$don fish steal @aimlen 🐟 80cm');
      check('aiming at a length takes that very fish', len.includes('made off with') && len.includes('(80 cm)') && fishOf(61).catch.sizes?.['🐟']?.some(h => h.cm === 80) === true
        && fishOf(63).catch.sizes?.['🐟']?.map(h => h.cm).join() === '20', len);
      check('a length they don\'t hold is turned away', (await run('$don fish steal @nokind 🐟 55cm')).includes("doesn't have a 🐟 55 cm") && fishOf(61).hook === 1);
      // Landed just now (the run's clock moves on 31 minutes first, so a minute from then).
      runWrite(adb, () => recordCatch(adb, 65, '🐟', 'cast', 70, Date.now() + 30 * 60_000));
      const fresh = await run('$don fish steal @freshlen 🐟 70cm');
      check('a length landed within the grace time can\'t be aimed at', fresh.includes('only just caught their 🐟 70 cm') && /safe from thieves for another \d+m/.test(fresh) && fishOf(61).hook === 1, fresh);
      // Landed again, just as the next run's clock lands.
      runWrite(adb, () => recordCatch(adb, 65, '🐟', 'cast', 70, Date.now() + 31 * 60_000));
      const scoutFresh = await run('$don fish steal check @freshlen 🐟 70cm');
      check('the scout says a fresh fish is safe and for how long, and spends nothing', scoutFresh.includes('freshlen 🐟 70 cm: ❌') && scoutFresh.includes('they only just caught their 🐟 70 cm (safe for another') && fishOf(61).hook === 1, scoutFresh);
      const scoutOk = await run('$don fish steal check @freshlen 🐟 40cm');
      check('the scout gives a reachable fish\'s odds, fee and fine', scoutOk.includes('✅ you can try now') && scoutOk.includes('100% chance') && /fee, [\d,]+ \$DON fine if caught/.test(scoutOk) && fishOf(61).hook === 1, scoutOk);
      const scoutAll = await run('$don fish steal c @aimkind');
      // The 🐋 steal above works or not by chance: aimkind holds 3 or 4 fish now.
      const held = fishOf(62).catch.fish;
      check('the scout on a target alone counts the fish in reach and the worst it costs', scoutAll.includes('❌ you tried them today') && scoutAll.includes(`${held} fish in reach`) && scoutAll.includes('costs up to'), { scoutAll, held });
      check('a name that isn\'t a fish asks for one', (await run('$don fish steal check @aimkind 🥫')).includes('only grabs fish'));
      const old = await run('$don fish steal @freshlen 🐟 40cm');
      check('but an older one of the kind can', old.includes('made off with') && old.includes('(40 cm)') && fishOf(61).hook === 0, old);
      const status = await run('$don fish steal');
      check('steal alone shows the hook, who was tried today and when they free up', status.includes('no 🪝 hook') && /tried today: aimkind \(\d+h \d+m\), aimlen/.test(status) && status.includes('steal check @user'), status);
      const scoutTried = await run('$don fish steal check @aimlen');
      check('the scout lists every block: no hook, tried today', scoutTried.includes('you need a 🪝 hook') && scoutTried.includes('you tried them today'), scoutTried);
      const rows = publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true, steal: { enabled: true } } })).sections.find(sec => sec.title === 'Fishing')?.rows ?? [];
      check('the Commands tab shows aiming', rows.some(r => r.usage.endsWith('steal @user [fish]') && r.does.includes('72cm')), rows.filter(r => r.usage.includes('steal')));
    } finally {
      Date.now = realNow;
    }
  }

  {
    const ch = 'fishsteal';
    const cfgWith = (steal: Record<string, unknown>) => writeConfig(root, ch, {
      enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, steal: { enabled: true, ...steal } }
    });
    cfgWith({ oddsCommon: 100 });
    makeService(ch, { broadcaster: 999 });
    const sdb = openPointsDb(ch, { create: true })!;
    const fishOf = (id: number) => loadFish(sdb, id)!;
    const seed = (id: number, name: string, bal: number, fish: number, extra: (d: FishData) => void = () => {}) => runWrite(sdb, () => {
      creditTx(sdb, { userId: id, username: name, amount: bal, reason: 'mod_add', now: 1 });
      const d = initialData();
      d.lifetime.attempts = 1;
      for (let i = 0; i < fish; i++) addItem(d, ITEMS.find(x => x.name === '🐟')!);
      if (fish) d.catch.sizes = { '🐟': Array.from({ length: fish }, () => ({ cm: 50, record: false })) };
      extra(d);
      saveFish(sdb, id, d, 1);
    });
    seed(31, 'thief', 2000, 0);
    seed(32, 'mark', 10, 3);
    seed(33, 'guarded', 10, 3, d => { d.guardUntil = Date.now() + 3_600_000; });
    seed(34, 'mark3', 10, 2);
    seed(35, 'fresh', 10, 1);
    seed(36, 'poor', 20, 0, d => { d.hook = 3; });
    seed(37, 'whale', 10, 0, d => { addItem(d, ITEMS.find(x => x.name === '🐋')!); d.catch.sizes = { '🐋': [{ cm: 100, record: false }] }; });
    seed(38, 'rich', 5000, 0, d => { d.hook = 3; });
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string, who: [string, number] = ['thief', 31]) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      check('steal needs a hook', (await run('$don fish steal @mark')).includes('need a 🪝 grappling hook'));
      const bought = await run('$don fish buy hook');
      check('show gives your hook\'s tries even with nothing caught', (await run('$don fish show')).includes('Your 🪝 hook has 3 tries left'));
      check('buying a hook costs its price and gives its tries', bought.includes('grappling hook for 150') && fishOf(31).hook === 3 && balance(ch, 31) === 1850, bought);
      check('one hook at a time', (await run('$don fish buy hook')).includes('already have') && balance(ch, 31) === 1850);

      const got = await run('$don fish steal @mark');
      check('a steal that works moves one fish, keeps its length, burns the fee and a try', got.includes('made off with') && got.includes('@mark')
        && fishOf(31).catch.types['🐟'] === 1 && fishOf(31).catch.sizes?.['🐟']?.[0]?.cm === 50 && fishOf(32).catch.types['🐟'] === 2
        && fishOf(32).catch.sizes?.['🐟']?.length === 2 && fishOf(31).hook === 2 && balance(ch, 31) === 1840
        && fishOf(31).lifetime.steal.stolen === 1 && fishOf(32).lifetime.steal.lost === 1 && fishOf(31).lifetime.fish === 0, got);
      check('a stolen fish reaches the overlay', readOverlay(sdb).events.some(e => e.kind === 'steal' && e.item === '🐟'));
      check('the victim gets an alert for the leaderboard: who stole which fish', alertsFor(sdb, 32).some(a => a.kind === 'steal' && a.text.includes('thief stole your 🐟 (50 cm)')), alertsFor(sdb, 32));
      const again = await run('$don fish steal @mark3');
      check('a steal starts the steal cooldown and leaves fishing alone', again.includes('try another steal in') && (fishOf(31).stealReady ?? 0) > Date.now() && fishOf(31).readyTimestamp <= Date.now(), again);
      shift += 31 * 60_000;
      check('a target is left alone for a while after a try', (await run('$don fish steal @mark')).includes('still on alert') && fishOf(31).hook === 2);

      const blocked = await run('$don fish steal @guarded');
      // Since 2026-10-24 a guard catches the thief like a failed roll: guarded's 🐟 are worth 25, so the fee and fine are their minimums, 10 and 25.
      check('a guard catches the try: fee and fine as if caught, a hook use, the cooldown, no guard time shown',
        blocked.includes('@guarded has a guard') && blocked.includes('25 $DON fine') && !/guard[^.]*\d+h/.test(blocked) && fishOf(31).hook === 1 && balance(ch, 31) === 1805
        && fishOf(33).catch.types['🐟'] === 3 && fishOf(31).lifetime.steal.blocked === 1 && (fishOf(31).stealReady ?? 0) > Date.now(), blocked);
      check('and starts the steal cooldown', (await run('$don fish steal @guarded')).includes('try another steal in'));
      check('the guarded viewer is alerted that their guard caught the thief, with their half of the fine', alertsFor(sdb, 33).some(a => a.text.includes('Your guard caught thief') && a.text.includes('25 $DON fine, and 12 $DON of it is yours')), alertsFor(sdb, 33));
      check('a guard\'s catch pays the guarded half the fine, as a catch without one does', blocked.includes('25 $DON fine (12 $DON of it goes to @guarded)')
        && (sdb.prepare("SELECT SUM(delta) AS s FROM ledger WHERE user_id = 33 AND reason = 'game:fish_steal_comp'").get() as { s: number }).s === 12, blocked);
      shift += 31 * 60_000;
      runWrite(sdb, () => recordCatch(sdb, 35, '🐟', 'cast', 50, Date.now()));
      check('fish landed within the grace time can\'t be stolen', (await run('$don fish steal @fresh')).includes('no fish you can get your hook into'));
      check('the streamer is off limits', (await run(`$don fish steal @${ch}`)).length > 0 && fishOf(31).hook === 1);
      // mark3's fish are 🐟 worth 25 at 40%: the fee and fine are their minimums, 10 and 25.
      const short = await run('$don fish steal @mark3', ['poor', 36]);
      check('short of the fee and fine for the target\'s costliest fish: one hook use, nothing else', short.includes('need 35') && fishOf(36).hook === 2
        && balance(ch, 36) === 20 && fishOf(34).catch.types['🐟'] === 2, short);

      cfgWith({ oddsCommon: 0 });
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, chatReplies: false, steal: { enabled: true, oddsCommon: 0 } } });
      const caught = await run('$don fish steal @mark3');
      // At 0% the balanced fine is nothing, so the minimum: 25, with the 10 fee.
      check('caught: half the fine (rounded down) goes to the victim, the rest is burned; one hook try is used, the fish stays',
        caught.includes('caught you red-handed') && caught.includes('25 $DON fine (12 $DON of it goes to @mark3)')
        && fishOf(31).hook === 0 && balance(ch, 31) === 1770 && balance(ch, 34) === 22 && fishOf(34).catch.types['🐟'] === 2
        && fishOf(31).lifetime.steal.caught === 1, caught);
      check('caught: the victim is alerted with the fine', alertsFor(sdb, 34).some(a => a.text.includes('You caught thief trying to steal your 🐟') && a.text.includes('25 $DON fine, and 12 $DON of it is yours')), alertsFor(sdb, 34));
      check('a refused steal (short of the fee) alerts nobody', !alertsFor(sdb, 34).some(a => a.text.includes('poor')));
      check('caught: the steal cooldown starts too, fishing stays free', caught.includes('next steal in') && (fishOf(31).stealReady ?? 0) > Date.now() && fishOf(31).readyTimestamp <= Date.now(), caught);
      // A 🐋 at 100 cm is worth 3,000: a 3% fee of 90 when it works. Value counts as much as rarity, so every tier is at
      // 100% and the 🐳 lists at 3,000: a fish dearer than the 🐳's list price would be harder than its tier's odds.
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, catches: { '🐳': { price: 3000 } },
        steal: { enabled: true, oddsCommon: 100, oddsUncommon: 100, oddsRare: 100, oddsEpic: 100, oddsLegendary: 100 } } });
      const whale = await run('$don fish steal @whale', ['rich', 38]);
      check('the fee is a share of the grabbed fish\'s value', whale.includes('made off with') && whale.includes('90 $DON fee') && balance(ch, 38) === 4910, whale);
      check('a caught thief reaches the overlay, and chat even with chat replies off', readOverlay(sdb).events.some(e => e.kind === 'caught') && caught.length > 0);
      shift += 61 * 60_000;   // past the cooldown and mark3's protection, well within the day
      check('one try per target a day', (await run('$don fish buy hook')).includes('grappling hook for') && (await run('$don fish steal @mark3')).includes('already tried mark3 today'));

      check('a guard costs money up front', (await run('$don fish buy guard', ['mark', 32])).includes('costs 200') && balance(ch, 32) === 10);
      const t36 = await run('$don fish buy guard', ['poor', 36]);
      check('no fish, no guard', t36.includes("don't have any fish"), t36);
      runWrite(sdb, () => creditTx(sdb, { userId: 32, username: 'mark', amount: 1000, reason: 'mod_add', now: 2 }));
      const g2 = await run('$don fish buy guard', ['mark', 32]);
      check('buying a guard charges the minimum for a small collection and never says for how long', g2.includes('hired a guard for 200') && !/\d+h|\d+m/.test(g2) && balance(ch, 32) === 810
        && (fishOf(32).guardUntil ?? 0) > Date.now(), g2);
      const scoutGuard = await run('$don fish steal check @mark', ['rich', 38]);
      check('the scout never gives a guard away', !scoutGuard.includes('guard') && fishOf(38).hook === (fishOf(38).hook ?? 0), scoutGuard);
      const shown = await run('$don fish show', ['mark', 32]);
      check('show never gives a guard\'s time, not even to its owner', !shown.includes('guard') && !(await run('$don fish show mark')).includes('guard'), shown);
      check('the thieves board ranks fish stolen', (await run('$don fish top thieves')).includes('master thieves') );
      check('the hall of shame ranks the caught', (await run('$don fish top caught')).includes('hall of shame') && (await run('$don fish top robbed')).includes('easy pickings'));
      const hb = heistBoard(ch, effectivePointsConfig({ enabled: true, games: { enabled: true } }), 999)!;
      check('the heist board: totals, thieves, shame, biggest, robbed, fort knox, blotter',
        // Burned: thief's 10 fee, 10 + 25 when caught less the 12 paid to the victim, and rich's 90 fee on the whale.
        hb.totals.stolen === 2 && hb.totals.caught === 1 && hb.totals.guarded === 1 && hb.totals.burned === 10 + (35 - 12) + 90
        // Tied on fish stolen, the bigger loot ranks first.
        && hb.thieves[0]?.name === 'rich' && hb.thieves[0]?.loot === 3000 && hb.thieves[1]?.name === 'thief' && hb.thieves[1]?.attempts === 2
        && hb.shame[0]?.name === 'thief' && hb.shame[0]?.fines === 35
        && hb.biggest[0]?.fish === '🐋' && hb.biggest[0]?.victim === 'whale' && hb.biggest[0]?.cm === 100
        && hb.robbed.some(r => r.name === 'mark' && r.lost === 1) && hb.fortKnox[0]?.name === 'guarded' && hb.fortKnox[0]?.turnedAway === 1
        && hb.blotter[0]?.thief === 'rich' && hb.blotter.length === 3, hb);
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', debugStealTesters: ['Rich'], games: { enabled: true, onlyWhileLive: false, steal: { enabled: false, oddsCommon: 100 } } });
      const tried = await run('$don fish steal @mark3', ['rich', 38]);
      check('a tester can steal where stealing is off, past the target\'s protection', tried.includes('made off with'), tried);
      check('everyone else still can\'t', (await run('$don fish steal @mark', ['thief', 31])).includes('Nobody steals fish here'));
    } finally {
      Date.now = realNow;
    }
    // The balanced fine: at 20% odds on a 3,000 fish, fee 90; fine (0.2 x 3,000 x 1.2 - 90) / 0.8 = 787.5, so 788.
    const bal = effectivePointsConfig({ games: { enabled: true } }).games;
    const ch20 = stealCharges(bal, 3000, 20);
    check('the fine is set from the odds so thieves lose the edge on average', ch20.fee === 90 && ch20.fine === 788
      && Math.abs((0.2 * 3000 - ch20.fee - 0.8 * ch20.fine) / (0.2 * 3000) + 0.2) < 0.01, ch20);
    const lucky = effectivePointsConfig({ games: { enabled: true, steal: { luckPercent: 25 } } }).games;
    const luckier = effectivePointsConfig({ games: { enabled: true, steal: { luckPercent: 25, oddsCommon: 90 } } }).games;
    const common = ITEMS.find(i => i.type === 'fish' && rarityOf(bal, i.name) === 'Common')!.name;
    // Steal odds follow rarity with no steps: each tier's standard fish at its odds, the rest between, the rarest far below.
    const gs = effectivePointsConfig({ games: { enabled: true, steal: { enabled: true }, catches: { '🦞': { weight: 2 }, '🐬': { weight: 1 } }, customFish: [{ name: '🦩', weight: 0.01, price: 1000, type: 'Swift' }] } }).games;
    const sc = (n: string) => stealChance(gs, n);
    check('steal odds follow how rare a fish is: tier fish exact, rarer ones harder, trophies by their fighting tier',
      sc('🐟') === 40 && sc('🐠') === 30 && sc('🦑') === 20 && sc('🐊') === 10 && sc('🐳') === 5
      && sc('🦞') < 30 && sc('🦞') > 20 && sc('🐬') < 20 && sc('🐬') > 10 && sc('🦩') < 1 && sc('🦩') > 0
      && sc('🦭') === 20 && sc('🦕') === 10 && sc('🦄') === 5 && sc('🐉') === 2.5,
      Object.fromEntries(['🐟', '🦞', '🐬', '🐳', '🦩', '🦭', '🐉'].map(n => [n, sc(n)])));
    // Value counts as much as rarity (2026-10-29): a fish at its tier's list price keeps its rarity's odds,
    // a dearer one is harder, a cheap trophy easier than its tier, and past the 🐳's price ten times dearer is harder still.
    const price = (n: string) => sellPrice(ITEMS.find(i => i.name === n)!, gs);
    const sv = (n: string, worth: number) => stealChance(gs, n, worth);
    check('steal odds go by value as much as rarity',
      sv('🐟', price('🐟')) === 40 && sv('🐳', price('🐳')) === 5 && sv('🐊', price('🐊')) === 10
      && sv('🐟', price('🐟') * 10) < 40 && sv('🐟', price('🐟') * 10) > sv('🐠', price('🐟') * 10)
      && sv('🦄', price('🐟')) > 5 && sv('🦄', price('🐟')) < 40
      && sv('🐳', price('🐳') * 2) < 5 && sv('🐳', price('🐳') * 2) > sv('🐳', price('🐳') * 10)
      && Math.abs(sv('🐟', price('🐟') / 10) - 40) < 0.05
      && stealChance(effectivePointsConfig({ games: { enabled: true, steal: { enabled: true, oddsCommon: 0 } } }).games, '🐟', price('🐟') * 20) === 0.01,
      { fish10x: sv('🐟', price('🐟') * 10), cheapUnicorn: sv('🦄', price('🐟')), whale2x: sv('🐳', price('🐳') * 2), whale10x: sv('🐳', price('🐳') * 10) });
    // Duel strength rides the same curve: tier fish at the tier's, others between, the rarest past Legendary up to a cap.
    const ds = (n: string) => duelStrength(gs, n);
    check('duel strength follows rarity on the same curve as stealing',
      ds('🐟') === 1 && ds('🐠') === 1.12 && ds('🦑') === 1.25 && ds('🐊') === 1.4 && ds('🐳') === 1.6
      && ds('🦞') > 1.12 && ds('🦞') < 1.25 && ds('🐬') > 1.25 && ds('🐬') < 1.4 && ds('🦩') > 1.6 && ds('🦩') <= 2
      && ds('🦭') === 1.25 && ds('🐉') === 1.8
      && fighterOf(gs, ITEMS.find(i => i.name === '🦩')!, { cm: 50, record: false }).hp > fighterOf(gs, ITEMS.find(i => i.name === '🐳')!, { cm: 50, record: false }).hp,
      Object.fromEntries(['🦞', '🐬', '🦩', '🐉'].map(n => [n, ds(n)])));
    check('luck raises the roll\'s odds over the rarity\'s', bal.steal.luckPercent === 0 && stealRollChance(bal, common) === 40
      && stealRollChance(lucky, common) === 50 && stealChance(lucky, common) === 40 && stealRollChance(luckier, common) === 100,
      { common, roll: stealRollChance(lucky, common), capped: stealRollChance(luckier, common) });
    // And the fine follows the roll's odds, so luck doesn't eat the edge (2026-10-24: priced from the rarity's alone,
    // a whale try at 25% luck paid thieves about 5% on average).
    const whale = ITEMS.find(i => i.name === '🐳')!;
    const holder = initialData();
    addItem(holder, whale);
    (holder.catch.sizes ??= {})['🐳'] = [{ cm: 92, record: false }];
    const whaleWorth = sellPrice(whale, lucky, { cm: 92, record: false });
    const p = stealRollChance(lucky, '🐳', whaleWorth) / 100;
    const worst = worstStealCharges(holder, lucky, [{ item: whale }]);
    const charged = stealCharges(lucky, whaleWorth, p * 100);
    const ev = p * whaleWorth - charged.fee - (1 - p) * charged.fine;
    check('a steal\'s fine is priced on the odds the roll has, luck included, so the average try still loses the edge',
      worst === charged.fee + charged.fine && Math.abs(ev / (p * whaleWorth) + lucky.steal.edgePercent / 100) < 0.01, { worst, charged, ev, p });
    const pub = (reason: string, actor: string | null, note: string | null) => publicLedgerText(reason, actor, note);
    check('the public history hides who adjusted a balance and private notes, and keeps chat\'s own',
      pub('dash_add', 'dashboard:alice:admin', 'refund').actor === 'staff' && pub('dash_add', 'dashboard:alice:admin', 'refund').note === null
      && pub('manual', 'MrAZisHere (via Claude)', 'x').actor === 'staff' && pub('spam_penalty', 'system', 'kekw').note === null
      && pub('game:fish_trap_check', 'chat:bob', 'Q').note === null && pub('channel_points', 'chat:bob', 'Pardon').note === 'Pardon'
      && pub('game:fish_steal', 'chat:bob', 'carol 🐟').actor === 'chat:bob');
    {
      // A guard tells a thief whom to skip: hired guards stay out of the public history.
      const hch = 'guardhide';
      writeConfig(root, hch, { enabled: true, currencyName: '$DON' });
      const hdb = openPointsDb(hch, { create: true })!;
      runWrite(hdb, () => {
        creditTx(hdb, { userId: 71, username: 'gina', amount: 1000, reason: 'mod_add', now: 1 });
        debitTx(hdb, { userId: 71, amount: 200, reason: 'game:fish_guard', now: 2 });
        debitTx(hdb, { userId: 71, amount: 50, reason: 'game:fish_bait', now: 3 });
      });
      const hist = publicUserHistory(hch, effectivePointsConfig({ enabled: true }), 'gina', 50);
      check('the public history leaves out hired fish guards (rows and totals) and keeps the rest',
        !!hist && hist.balance === 750 && hist.ledger.length === 2 && !hist.ledger.some((l) => l.reason === 'game:fish_guard')
        && !hist.totals.some((t) => t.reason === 'game:fish_guard') && hist.ledgerCount === 2, hist && { ledger: hist.ledger.map((l) => l.reason), totals: hist.totals });
    }
    check('effective config strips debugFishTesters', !('debugFishTesters' in effectivePointsConfig({ debugFishTesters: ['x'] })));
    check('debugFishTesters survives a dashboard save', validatePointsPatch({ debugFishTesters: ['x'] }, { enabled: true }).next?.debugFishTesters?.[0] === 'x');
    const bad = validatePointsPatch({}, { games: { steal: { oddsCommon: 101, hookUses: 0, enabled: 'yes' } } });
    check('steal settings are validated', bad.errors.length === 3, bad.errors);
    const kept = validatePointsPatch({}, { games: { steal: { enabled: true, feePercent: 3, hookPrice: 800 } } });
    check('only steal settings that differ from the defaults are stored', kept.next?.games?.steal?.enabled === true && kept.next?.games?.steal?.hookPrice === 800 && Object.keys(kept.next?.games?.steal ?? {}).length === 2, kept);
  }

  // Big bites: live with an overlay showing, the code only on the overlay, one answer, trophies
  {
    const g0 = effectivePointsConfig({ games: { enabled: true, sellPricePercent: 300 } }).games;
    const fishRolls = Array.from({ length: 3000 }, () => weightedCatch('fish', g0).name);
    const trophyRolls = Array.from({ length: 500 }, () => weightedCatch('trophy', g0));
    check('casts never roll a trophy, big bites only roll trophies', !fishRolls.some(n => isTrophy(n)) && trophyRolls.every(t => t.trophy));
    check('trophies are Mythic and their prices aren\'t scaled by the channel', rarityOf(g0, '🐉') === 'Mythic' && rarityOf(g0, '🐋') !== 'Mythic'
      && sellPrice(ITEMS.find(i => i.name === '🐉')!, g0) === 12_500 && g0.catches.find(c => c.name === '🐉')?.trophy === true, rarityOf(g0, '🐉'));
    // Trophies fight as their tier: a seal like a Rare fish, only the dragon as a Mythic.
    const hpOf = (n: string) => fighterOf(g0, ITEMS.find(i => i.name === n)!, { cm: 50, record: false }).hp;
    check('trophies fight as their tier, not all as Mythic', hpOf('🦭') === hpOf('🐬') && hpOf('🦕') === hpOf('🦈') && hpOf('🦄') === hpOf('🐳') && hpOf('🐉') > hpOf('🐳')
      && fighterOf(g0, ITEMS.find(i => i.name === '🦭')!).rarity === 'Mythic', { seal: hpOf('🦭'), dolphin: hpOf('🐬'), dragon: hpOf('🐉') });

    const ch = 'fishbite';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', debugFishTesters: ['tester'], games: { enabled: true, onlyWhileLive: false, stories: false } });
    const sent: string[] = [];
    const bsvc = makeService(ch, { broadcaster: 999, sent });
    const bdb = openPointsDb(ch, { create: true })!;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const chat = (id: number, name: string, minutesAgo: number) => runWrite(bdb, () => {
        ensureUserTx(bdb, id, name, 1);
        bdb.prepare('UPDATE users SET last_chat_at = ? WHERE user_id = ?').run(Date.now() - minutesAgo * 60_000, id);
      });
      chat(41, 'biter', 1);
      chat(42, 'lurker', 20);
      chat(999, ch, 1);
      chat(43, 'botrix', 1);
      const run = async (msg: string, who: [string, number], step = 6_000) => {
        shift += step;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const lastBite = () => readOverlay(bdb).events.filter(e => e.kind === 'bite').pop();
      /** The newest overlay event: after the opening mention, a bite plays out there only. */
      const lastShown = () => readOverlay(bdb).events.pop();
      /** Ticks until a bite fires if it can: past any wait already running, or a fresh shortest one (28 minutes). */
      const fire = async (overlay = true) => {
        const tickNow = () => { chat(41, 'biter', 1); if (overlay) markOverlaySeen(bdb, Date.now()); return bsvc.bigBiteTick(() => 0); };
        shift += 31 * 60_000;
        const early = await tickNow();
        if (early) return early;
        shift += 29 * 60_000;
        return tickNow();
      };

      check('no big bite without an overlay showing', (await fire(false)) === null);
      resetBites(ch, bdb);
      // A mod switches the overlay off when it isn't on stream: big bites pause, replies go to chat, and the next stream undoes it.
      {
        const runAs = async (msg: string, who: [string, number], mod: boolean) => {
          shift += 6_000;
          const out: string[] = [];
          const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: false, rawBadges: [], senderId: who[1] };
          await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
          return out[0] ?? '';
        };
        check('a viewer can\'t switch the overlay off', (await runAs('$don fish overlay off', ['lurker', 42], false)) === '' && !overlayOff(bdb));
        const offReply = await runAs('$don fish ov off', ['amod', 44], true);
        check('a mod switches the overlay off', overlayOff(bdb) && /switched off/.test(offReply), offReply);
        markOverlaySeen(bdb, Date.now());
        check('switched off, an overlay polling doesn\'t count as showing', !overlayShowing(bdb));
        check('and big bites pause', (await fire()) === null);
        resetBites(ch, bdb);
        const prevLive = bdb.prepare("SELECT value FROM meta WHERE key = 'live_since'").get() as { value: string | null } | undefined;
        runWrite(bdb, () => setMetaTx(bdb, 'live_since', String(Date.now() + 1)));
        check('the next stream starts with it back on', !overlayOff(bdb));
        runWrite(bdb, () => setMetaTx(bdb, 'live_since', prevLive?.value ?? null));
        check('it holds through the stream it was set in', overlayOff(bdb));
        // The media share overlay's hold (!ms pause) goes by the stream the same way.
        setMediaShareHeld(bdb, true);
        check('the media share overlay holds through its stream', mediaShareHeld(bdb));
        runWrite(bdb, () => setMetaTx(bdb, 'live_since', String(Date.now() + 2)));
        check('and lets go when the next one starts', !mediaShareHeld(bdb));
        runWrite(bdb, () => setMetaTx(bdb, 'live_since', prevLive?.value ?? null));
        setMediaShareHeld(bdb, false);
        check('and !ms play lets it go', !mediaShareHeld(bdb));
        const onReply = await runAs('$don fish overlay on', ['amod', 44], true);
        check('and a mod switches it back on', !overlayOff(bdb) && /back on/.test(onReply), onReply);
        resetBites(ch, bdb);
      }
      // A restart keeps the wait: one drawn, the bot's memory gone, and it still isn't due early, then is.
      chat(41, 'biter', 1);
      markOverlaySeen(bdb, Date.now());
      const drawn = await bsvc.bigBiteTick(() => 0.99);
      resetBites(ch);
      shift += 25 * 60_000;
      chat(41, 'biter', 1);
      markOverlaySeen(bdb, Date.now());
      const soon = await bsvc.bigBiteTick(() => 0);
      shift += 7 * 60_000;
      chat(41, 'biter', 1);
      markOverlaySeen(bdb, Date.now());
      check('a restart keeps the wait for the next big bite instead of starting it over', drawn === null && soon === null && (await bsvc.bigBiteTick(() => 0)) === 'biter', lastBite());
      takeBiteForTest(ch, 'biter');
      resetBites(ch, bdb);
      chat(41, 'biter', 1);
      markOverlaySeen(bdb, Date.now());
      check('the wait is the setting, give or take two minutes: none before it is up',
        (await bsvc.bigBiteTick(() => 0.99)) === null && (shift += 31 * 60_000, chat(41, 'biter', 1), markOverlaySeen(bdb, Date.now()), await bsvc.bigBiteTick(() => 0)) === null, lastBite());
      shift += 60_000;
      chat(41, 'biter', 1);
      markOverlaySeen(bdb, Date.now());
      check('and one once it is', (await bsvc.bigBiteTick(() => 0)) === 'biter');
      takeBiteForTest(ch, 'biter');
      const got = await fire();
      const ev1 = lastBite();
      check('a big bite goes to an active chatter, never the streamer, a bot or someone quiet', got === 'biter' && ev1?.username === 'biter');
      check('chat names the chatter but never the code; the overlay has it', !!ev1 && typeof ev1.code === 'string' && /^\d{2}$/.test(ev1.code) && ev1.flashMs === undefined && sent.some(m => m.startsWith('@biter') && m.includes('Something BIG'))
        // As a word: "within 30s" isn't the code 30.
        && !sent.some(m => new RegExp(`\\b${String(ev1.code)}\\b`).test(m)), { sent, ev1 });
      check('one big bite at a time', (await bsvc.bigBiteTick(() => 0)) === null);
      const fast = await run(`$don fish reel ${ev1!.code}`, ['biter', 41], 500);
      check('an answer faster than the stream could show it snaps the line: the overlay and a chat result', fast.includes('yanked too early') && lastShown()?.kind === 'miss'
        && !!lastShown()?.text.includes('yanked too early'), { fast, shown: lastShown() });
      check('not again until the next wait is up', (shift += 5 * 60_000, markOverlaySeen(bdb, Date.now()), await bsvc.bigBiteTick(() => 0)) === null);

      await fire();
      const ev2 = lastBite()!;
      await run(`$don fish reel ${ev2.code === '10' ? '11' : '10'}`, ['biter', 41]);
      check('a wrong code loses it', !!lastShown()?.text.includes('Wrong move'));

      /** Answer every pull of the waiting bite with the code the overlay shows; what the overlay showed after each. */
      const reelAll = async (): Promise<{ replies: string[]; shown: string[]; codes: string[]; flashes: Array<number | undefined> }> => {
        const replies: string[] = [];
        const shown: string[] = [];
        const codes: string[] = [];
        const flashes: Array<number | undefined> = [];
        for (let i = 0; i < 5; i++) {
          const ev = lastBite()!;
          codes.push(ev.code!);
          flashes.push(ev.flashMs);
          // Any case counts: answer the later codes in lower case.
          replies.push(await run(`$don fish reel ${i ? ev.code!.toLowerCase() : ev.code}`, ['biter', 41], 3_000));
          const next = lastShown()!;
          shown.push(next.text);
          if (next.kind !== 'bite') break;
        }
        return { replies, shown, codes, flashes };
      };
      const chatBefore = sent.length;
      await fire();
      const first = await reelAll();
      check('reeling in takes three pulls, each with a new code, all on the overlay', first.shown.length === 3 && first.shown[0].includes('pull 2/3')
        && first.shown[1].includes('pull 3/3') && new Set(first.codes).size === 3, first);
      check('codes get harder each pull: 2 digits, then 3 and 4 clear characters, answered in any case', /^\d{2}$/.test(first.codes[0])
        && /^[ACDEFHJKMNPRTUVWXY3479]{3}$/.test(first.codes[1]) && /^[ACDEFHJKMNPRTUVWXY3479]{4}$/.test(first.codes[2]), first.codes);
      check('from the second pull codes flash for 3s; the first stays shown', first.flashes[0] === undefined && first.flashes[1] === 3_000 && first.flashes[2] === 3_000, first.flashes);
      check('a whole big bite is two chat lines: the opening mention and the result', sent.length - chatBefore === 1 && first.replies.slice(0, -1).every(r => r === '')
        && /MYTHIC|So close/.test(first.replies[first.replies.length - 1]), { chat: sent.slice(chatBefore), replies: first.replies });
      // The last pull lands the trophy by its land chance: try until one lands, and until one snaps.
      let won: string | null = null;
      let landed: string | undefined;
      let snapped: string | null = null;
      let beforeSnap = 0;
      for (let i = 0; i < 40 && (!won || !snapped); i++) {
        await fire();
        const before = loadFish(bdb, 41) ?? initialData();
        const last = (await reelAll()).shown.pop()!;
        const after = loadFish(bdb, 41) ?? initialData();   // none yet when the first bite snapped free
        if (last.includes('MYTHIC') && !won) {
          won = last;
          landed = Object.keys(after.catch.types).find(n => isTrophy(n) && (after.catch.types[n] ?? 0) > (before.catch.types[n] ?? 0));
          check('a landed trophy leaves casting alone and plays as Mythic on the overlay', after.readyTimestamp === before.readyTimestamp
            && readOverlay(bdb).events.some(e => e.kind === 'catch' && e.item === landed && e.rarity === 'Mythic'));
        }
        if (last.includes('So close') && !snapped) {
          snapped = last;
          beforeSnap = before.catch.fish - after.catch.fish;
        }
      }
      check('the last pull can land a Mythic trophy', !!won && !!landed
        && (bdb.prepare('SELECT COUNT(*) AS n FROM catches WHERE user_id = 41 AND name = ?').get(landed) as { n: number }).n >= 1, { won, landed });
      check('or snap the line, naming what got away and adding nothing', !!snapped && /It was a ✨.+✨/.test(snapped) && beforeSnap === 0, snapped);
      const biteRows = bdb.prepare("SELECT outcome, trophy, cm, land_percent, pull FROM big_bites WHERE user_id = 41 AND outcome IN ('landed', 'snapped')").all() as Array<{ outcome: string; trophy: string | null; cm: number | null; land_percent: number | null; pull: number }>;
      check('big_bites keeps each landed and snapped bite with its trophy, land chance and the last pull', biteRows.some(r => r.outcome === 'landed' && r.trophy && r.cm && r.land_percent)
        && biteRows.some(r => r.outcome === 'snapped' && r.trophy && r.cm === null && r.land_percent) && biteRows.every(r => r.pull === 3), biteRows);

      await fire();
      const ev4 = lastBite()!;
      shift += 31_000;
      // Past the countdown but inside the stream-delay grace: still counts.
      check('an answer just after the countdown still counts, for stream delay; $don f r is $don fish reel', (await run(`$don f r ${ev4.code}`, ['biter', 41], 0), lastShown()?.kind === 'bite' && lastShown()!.pull === 2));
      const ev5 = lastBite()!;
      shift += 20_000;
      await run(`$don fish reel ${ev5.code}`, ['biter', 41]);
      check('too slow loses it', !!lastShown()?.text.includes('Too slow'));
      check('reel with nothing on the line', (await run('$don fish reel 42', ['biter', 41])).includes('nothing big on your line'));
      check('the short forms answer the same', (await run('$don f r 42', ['biter', 41])).includes('nothing big on your line') && (await run('$don F stats', ['biter', 41])) !== '');

      // Sniping: the first code's last seconds are open to everyone else, one try each.
      await fire();
      const s1 = lastBite()!;
      const s1bite = biteFor(ch, 'biter')!;
      // 20s asked, capped at half the 30s window, then up to 3s shorter at random (never past the cap).
      check('the first code opens to snipers for about its last 15s, never more than half the window, and the overlay isn\'t told when', s1.username === 'biter'
        && s1bite.until - s1bite.snipeAt! >= 12_000 && s1bite.until - s1bite.snipeAt! <= 15_000 && s1.snipeAt === undefined
        && sent[sent.length - 1].includes('about the last 15s anyone can snipe'), { s1, chat: sent[sent.length - 1] });
      const draws = Array.from({ length: 400 }, () => drawSnipeMs({ ...DEFAULT_BIG_BITE, windowSeconds: 30, snipeSeconds: 10 }));
      check('each bite\'s snipe window is the set seconds ±3s at random', Math.min(...draws) >= 7_000 && Math.max(...draws) <= 13_000
        && Math.min(...draws) < 8_000 && Math.max(...draws) > 12_000 && new Set(draws).size > 100
        && drawSnipeMs({ ...DEFAULT_BIG_BITE, snipeSeconds: 0 }) === 0
        && Array.from({ length: 50 }, () => drawSnipeMs({ ...DEFAULT_BIG_BITE, windowSeconds: 10, snipeSeconds: 2 })).every(ms => ms >= 1_000 && ms <= 5_000),
        [Math.min(...draws), Math.max(...draws)]);
      check('a snipe before it opens uses up that sniper\'s try', (await run(`$don fish reel ${s1.code}`, ['early', 48], 5_000)).includes('Too early') && lastBite()?.username === 'biter');
      // 18.5s in: due whichever way the window was drawn (15–18s in here), but snipes open
      // only with the chat line, which the timer posts in real time: post it now.
      shift += 13_500;
      check('snipes don\'t open before the SNIPE OPEN line, even when due', !snipeOpen(s1bite, Date.now()) && s1bite.snipeCode === undefined);
      const openSaid: string[] = [];
      openSnipes({ channel: ch, db: bdb, bigBite: effectivePointsConfig({ games: { enabled: true } }).games.bigBite, command: 'don', sendMessage: async m => { openSaid.push(m); } }, s1bite);
      await new Promise(r => setImmediate(r));
      const snipeCode = s1bite.snipeCode!;
      check('the SNIPE OPEN line gives snipers a 2-digit code of their own, not the overlay\'s', /^\d{2}$/.test(snipeCode) && snipeCode !== s1.code
        && openSaid[0]?.includes(`$don fish reel ${snipeCode} takes it`) && !openSaid[0]?.includes(s1.code!) && snipeOpen(s1bite, Date.now()), { snipeCode, openSaid, code: s1.code });
      const wrongSnipe = await run(`$don fish reel ${s1.code}`, ['third', 47], 0);
      check('a sniper typing the overlay code gets it wrong, uses up their one try, and leaves the bite alone', wrongSnipe.includes('Wrong code') && wrongSnipe.includes('SNIPE OPEN line')
        && (await run(`$don fish reel ${snipeCode}`, ['third', 47], 500)) === '' && lastBite()?.username === 'biter' && lastBite()!.pull === 1, wrongSnipe);
      check('an early sniper gets no second try once it opens', (await run(`$don fish reel ${snipeCode}`, ['early', 48], 300)) === '' && lastBite()?.username === 'biter');
      const sniped = await run(`$don fish reel ${snipeCode}`, ['other', 44], 500);
      const s2 = lastBite()!;
      check('the first right snipe takes the bite and carries on from the next pull', sniped.includes('@biter') && sniped.includes('@other sniped') && s2.username === 'other'
        && s2.pull === 2 && s2.snipeAt === undefined && s2.code !== s1.code && biteFor(ch, 'other')!.snipeCode === undefined, { sniped, s2 });
      check('the chatter it was for has lost it, and later pulls can\'t be sniped', (await run(`$don fish reel ${s2.code}`, ['biter', 41], 500)).includes('nothing big on your line')
        && lastBite()?.username === 'other' && lastBite()!.pull === 2);
      await run(`$don fish reel ${s2.code}`, ['other', 44], 2_500);
      check('the sniper reels on as its chatter', lastBite()?.username === 'other' && lastBite()!.pull === 3);
      check('the holder was alerted to the bite, and to losing it to the sniper', alertsFor(bdb, 41).some(a => a.kind === 'bite' && a.text.includes('Something BIG'))
        && alertsFor(bdb, 41).some(a => a.text === '🪝 other sniped your big bite!'), alertsFor(bdb, 41));
      const mirrored = () => {
        const row = bdb.prepare('SELECT value FROM meta WHERE key = ?').get(LIVE_BITE_KEY) as { value: string } | undefined;
        return row ? JSON.parse(row.value) as { username: string; code: string; pull: number; until: number; flashMs?: number } : null;
      };
      check('the bite on a line is mirrored for the leaderboard, its code and pull as the overlay has them',
        mirrored()?.username === 'other' && mirrored()?.pull === 3 && mirrored()?.code === lastBite()?.code && mirrored()?.until === lastBite()?.until && mirrored()?.flashMs === lastBite()?.flashMs, mirrored());
      takeBiteForTest(ch, 'other');
      check('and cleared once it ends', mirrored() === null);
      // The holder answers from the leaderboard's fishing page: the page hears how it went.
      {
        let wn = 0;
        const fromPage = async (code: string, step = 3_000) => {
          shift += step;
          const requestId = `00000000-0000-4000-8000-${String(++wn).padStart(12, '0')}`;
          const tags: KickTags = { username: 'biter', 'display-name': 'biter', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 41,
            messageId: `web:${requestId}`, web: { reply: (text, meta) => recordWebReply(bdb, { requestId, userId: 41 }, text, meta) } };
          await fishCommand({ say: async () => {} }, `$don fish reel ${code}`, `#${ch}`, tags, { channelName: ch } as ChannelConfig);
          return repliesFor(bdb, requestId).map(r => r.text).join(' ');
        };
        const refused = await fromPage('42', 6_000);
        check('without the leaderboard switch, a code from the page is turned away', refused.includes('played in chat'), refused);
        writeConfig(root, ch, { enabled: true, currencyName: '$DON', debugFishTesters: ['tester'], games: { enabled: true, onlyWhileLive: false, stories: false, bigBite: { onLeaderboard: true } } });
        const wctx = { channel: ch, db: bdb, bigBite: effectivePointsConfig({ games: { enabled: true } }).games.bigBite, command: 'don', sendMessage: async () => {} };
        const wb = startBite(wctx, 'biter', 41);
        const first = await fromPage(wb.code);
        check('a right code from the page brings the next pull, and the page says so', first.includes('Got it') && mirrored()?.pull === 2 && mirrored()?.flashMs !== undefined, { first, m: mirrored() });
        const wrong = await fromPage(mirrored()?.code === 'AAA' ? 'CCC' : 'AAA');
        check('a wrong code from the page tells the page it got away', wrong.includes('got away') && mirrored() === null, wrong);
      }
      // A reward bite opens to snipers too, but a right snipe code only makes it spit the hook.
      {
        const rsaid: string[] = [];
        const rctx = { channel: ch, db: bdb, bigBite: effectivePointsConfig({ games: { enabled: true } }).games.bigBite, command: 'don', sendMessage: async (m: string) => { rsaid.push(m); } };
        const rb = startBite(rctx, 'biter', 41, 'the sub');
        check('a reward bite opens to snipers too, and tells its viewer so', rb.snipeAt !== undefined && rsaid[0]?.includes('guaranteed to land') && rsaid[0]?.includes('snipers get a shot'), rsaid);
        shift += rb.snipeAt! - Date.now() + 500;
        openSnipes(rctx, rb);
        await new Promise(r => setImmediate(r));
        const spat = await run(`$don fish reel ${rb.snipeCode}`, ['other', 44], 0);
        check('a right snipe on a reward bite ends it there: nobody else can win one', spat.includes('spat the hook') && spat.includes('@other') && spat.includes('@biter')
          && !biteFor(ch, 'biter') && !biteFor(ch, 'other') && lastShown()?.kind === 'miss', { spat });
      }
      // From the second pull the code alone is an answer, for the chatter reeling.
      await fire();
      const b1 = lastBite()!;
      check('the first code needs the command: the code alone is only chat', (await run(b1.code!, ['biter', 41], 3_000)) === '' && lastBite()!.pull === 1 && lastBite()!.code === b1.code);
      await run(`$don fish reel ${b1.code}`, ['biter', 41], 500);
      const b2 = lastBite()!;
      await run(b2.code === 'AAA' ? 'CCC' : 'AAA', ['biter', 41], 2_500);
      await run('lol nice', ['biter', 41], 200);
      check('from the second pull, anything that isn\'t the code is chat and loses nothing', lastBite()!.pull === 2 && lastBite()!.code === b2.code && lastShown()?.kind === 'bite');
      check('nor does the code from someone else', (await run(b2.code!, ['other', 44], 200)) === '' && lastBite()!.pull === 2);
      await run(` ${b2.code!.toLowerCase()} `, ['biter', 41], 200);
      const b3 = lastBite()!;
      check('the code by itself reels in the pull, in any case', b3.pull === 3 && b3.code !== b2.code, b3);
      await run(`$don f r ${b3.code}`, ['biter', 41], 2_500);
      check('and the command still works on later pulls', /MYTHIC|So close/.test(lastShown()!.text), lastShown());
      check('sniping can be switched off', validatePointsPatch({}, { games: { bigBite: { snipeSeconds: 0 } } }).errors.length === 0
        && effectivePointsConfig(validatePointsPatch({}, { games: { bigBite: { snipeSeconds: 0 } } }).next).games.bigBite.snipeSeconds === 0);

      await bsvc.bigBiteTick(() => 0);
      shift += 31 * 60_000;
      chat(41, 'biter', 1);
      chat(44, 'other', 1);
      markOverlaySeen(bdb, Date.now());
      const next = await bsvc.bigBiteTick(() => 0);
      check('with others chatting, not the same chatter twice in a row', next === 'other', { next, bite: lastBite()?.username });
      takeBiteForTest(ch, 'other');
      check('testers can put a big bite on themselves', (chat(45, 'tester', 1), shift += 11 * 60_000, markOverlaySeen(bdb, Date.now()), await run('$don fish bigbite', ['tester', 45], 6_000)).includes('Something BIG')
        && lastBite()?.username === 'tester');
      check('nobody else can', (await run('$don fish bigbite', ['other', 44])) === '' && lastBite()?.username === 'tester');
      const asStreamer = async (msg: string) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: ch, 'display-name': ch, badges: {}, isBroadcaster: true, isModUp: true, isVIPUp: true, rawBadges: [], senderId: 999 };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      check('the streamer can\'t start one while another is waiting', (await asStreamer('$don fish bigbite')).includes('already has a big bite') && lastBite()?.username === 'tester');
      takeBiteForTest(ch, 'tester');
      chat(44, 'other', 1);
      markOverlaySeen(bdb, Date.now());
      const named = await asStreamer('$don fish bigbite @Other');
      check('the streamer can put a big bite on a named chatter, right after the last one', named.startsWith('@other') && named.includes('Something BIG') && lastBite()?.username === 'other', { named, b: lastBite() });
      takeBiteForTest(ch, 'other');
      chat(41, 'biter', 1);
      chat(44, 'other', 1);
      chat(999, ch, 1);
      chat(43, 'botrix', 1);
      markOverlaySeen(bdb, Date.now());
      const anyone = await asStreamer('$don fish bigbite');
      check('or on a random active chatter, never themselves, a bot or the last one', anyone.includes('Something BIG') && !!lastBite() && !['other', ch, 'botrix'].includes(lastBite()!.username.toLowerCase()), { anyone, b: lastBite() });
      takeBiteForTest(ch, lastBite()!.username);
      markOverlaySeen(bdb, Date.now());
      const ownerBefore = process.env.KICK_OWNER;
      process.env.KICK_OWNER = 'bossman';
      chat(46, 'bossman', 1);
      chat(44, 'other', 1);
      markOverlaySeen(bdb, Date.now());
      const byOwner = await run('$don f bb @other', ['bossman', 46]);
      process.env.KICK_OWNER = ownerBefore;
      check('the bot owner can start one like the streamer', byOwner.startsWith('@other') && byOwner.includes('Something BIG') && lastBite()?.username === 'other', { byOwner, b: lastBite() });
      takeBiteForTest(ch, 'other');
      markOverlaySeen(bdb, Date.now());
      const self = await asStreamer('$don fish bigbite me');
      check('the streamer can put one on themselves to try it', self.startsWith(`@${ch}`) && self.includes('Something BIG') && lastBite()?.username === ch, { self, b: lastBite() });
      takeBiteForTest(ch, ch);
      markOverlaySeen(bdb, Date.now());
      check('never on a bot or an unknown name', (await asStreamer('$don fish bigbite botrix')).includes("can't get a big bite") && (await asStreamer('$don fish bigbite nobodyhere')).includes("don't know"));
    } finally {
      Date.now = realNow;
      resetBites(ch);
    }
    check('big bite settings are validated', validatePointsPatch({}, { games: { bigBite: { everyMinutes: 5, activeMinutes: 0, windowSeconds: 5, pulls: 9, pullSeconds: 4 } } }).errors.length === 5);
    check('a trophy pool can\'t be switched off entirely', validatePointsPatch({}, { games: { catches: Object.fromEntries(ITEMS.filter(i => i.trophy).map(i => [i.name, { weight: 0 }])) } })
      .errors.some(e => e.includes('big bite trophy')));
  }

  // A stream's end reaches commands within LIVE_FRESH_MS, without waiting for a tick or a webhook
  {
    const ch = 'liveagech';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON' });
    let live = true;
    let asks = 0;
    let at = 1_000_000_000;
    const lsvc = makeService(ch, { live: async () => { asks++; return { isLive: live, startedAt: null }; }, now: () => at });
    check('first ask goes to Kick', (await lsvc.isLiveNow()) === true && asks === 1);
    live = false;
    at += 10_000;
    check('a fresh answer is reused', (await lsvc.isLiveNow()) === true && asks === 1);
    at += 25_000;
    check('a stale one is asked again: the stream has ended', (await lsvc.isLiveNow()) === false && asks === 2);
    live = true;
    lsvc.onLivestreamStatus({ is_live: true } as never, { ageMs: 0 } as never);
    check('a webhook counts as fresh', (await lsvc.isLiveNow()) === true && asks === 2);

    // !offline / !live: commands follow it while Kick lags, until Kick agrees, a webhook, or it runs out
    const replies: string[] = [];
    const chat = { say: async (_c: string, m: string) => { replies.push(m); } } as never;
    const tag = (username: string, mod: boolean): KickTags => ({ username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: 71 });
    await streamstatus(chat, '!offline', `#${ch}`, tag('viewer', false), {} as never);
    check('!offline: viewers get nothing', replies.length === 0 && (await lsvc.isLiveNow()) === true);
    await streamstatus(chat, '!offline', `#${ch}`, tag('modder', true), {} as never);
    at += 60_000; // Kick still says live when asked again
    check('!offline: commands see offline while Kick still says live', replies.length === 1 && replies[0].includes('offline') && (await lsvc.isLiveNow()) === false && asks === 2);
    lsvc.onLivestreamStatus({ is_live: true } as never, { ageMs: 0 } as never);
    check('a livestream webhook ends it either way', (await lsvc.isLiveNow()) === true);
    await streamstatus(chat, '!offline', `#${ch}`, tag('modder', true), {} as never);
    live = false;
    at += 31_000;
    lsvc.setLiveOverride(false, 'again');
    at += 21 * 60_000;
    check('it runs out after 20 minutes, back to Kick', (await lsvc.isLiveNow()) === false && asks === 3);
    live = true;
    at += 31_000;
    check('and Kick decides again', (await lsvc.isLiveNow()) === true);
  }

  // Spin the wheel: chat edits, spins on the overlay, holds big bites
  {
    const ch = 'wheelch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false } });
    const wsvc = makeService(ch, { broadcaster: 999 });
    const wdb = openPointsDb(ch, { create: true })!;
    const said: string[] = [];
    const as = (username: string, mod: boolean): KickTags => ({ username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: mod, isVIPUp: mod, rawBadges: [], senderId: 70 });
    const say = async (msg: string, who = as('modder', true)) => {
      const before = said.length;
      await wheelCommand({ say: async (_c, m) => { said.push(m); } }, msg, `#${ch}`, who, { channelName: ch } as ChannelConfig);
      return said.slice(before).join(' | ');
    };
    resetWheelBusy();
    check('an empty wheel says so', (await say('!wheel')).includes('The wheel is empty'));
    check('no spins yet, no history', (await say('!wheel history')).includes("hasn't been spun yet") && (await say('!wheel h', as('viewer', false))) === '');
    const added = await say('!wheel add Sing a song | Do 10 pushups | sing a song');
    check('mods add items, several at once, without duplicates', added.includes('added "Sing a song", "Do 10 pushups"') && added.includes('skipped "sing a song"')
      && readWheel(ch).items.length === 2, added);
    check('viewers get no answer to any of it', (await say('!wheel add Nope', as('viewer', false))) === '' && (await say('!spin', as('viewer', false))) === ''
      && (await say('!wheel', as('viewer', false))) === '' && (await say('!wheel list', as('viewer', false))) === '' && readWheel(ch).items.length === 2);
    await say('!wheel add Pick a game');
    check('the list is numbered', (await say('!wheel list')).includes('1. Sing a song · 2. Do 10 pushups · 3. Pick a game'));
    check('remove by number or label', (await say('!wheel rm 2')).includes('removed "Do 10 pushups"') && (await say('!wheel remove pick A GAME')).includes('removed "Pick a game"')
      && (await say('!wheel remove nothing')).includes("isn't on the wheel") && readWheel(ch).items.length === 1);
    check('a one-item wheel won\'t spin', (await say('!spin')).includes('at least 2 items'));
    await say('!wheel add Raid someone | Hydrate');
    check('no overlay, no spin', (await say('!wheel spin')).includes('open the fishing overlay'));
    // markOverlaySeen writes at most every 5s per process; earlier tests just did.
    runWrite(wdb, () => wdb.prepare("INSERT INTO meta (key, value) VALUES ('overlay_seen_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(Date.now() + 10_000)));
    const spun = await say('!wheel spin');
    const ev = readOverlay(wdb).events.find(e => e.kind === 'wheel');
    check('a spin goes to the overlay with its items and winner, and holds the overlay', spun === '' && !!ev?.wheel && ev.wheel.items.length === 3
      && ev.wheel.winner >= 0 && ev.wheel.winner < 3 && ev.wheel.spinMs === 6000 && wheelBusy(ch), ev);
    check('one spin at a time', (await say('!spin')).includes('already spinning'));
    const hist = recentSpins(wdb);
    check('the spin is kept in the history with what was on the wheel', hist.length === 1 && hist[0].by === 'modder' && hist[0].itemCount === 3
      && hist[0].result === hist[0].items[hist[0].position - 1] && hist[0].result === ev?.wheel?.items[ev.wheel.winner].label && hist[0].overlay === 'fishing', hist);
    const histMsg = await say('!wheel hist');
    check('!wheel history shows it in chat', histMsg.startsWith('🎡 Last spins: ') && histMsg.includes(`${hist[0]?.result} (modder, 0m ago)`), histMsg);
    check('no big bite starts while it spins', (await wsvc.bigBiteTick(() => 0)) === null);

    // The dashboard's save: whole wheel, refused if chat changed it since it loaded.
    const v = readWheel(ch).version;
    const bad = validateWheel({ version: v, items: [{ label: '' }, { label: 'A', color: 'red' }, { label: 'B' }, { label: 'b' }], spinSeconds: 1, removeWinner: 'yes' });
    check('a dashboard save is checked', 'errors' in bad && bad.errors.length === 5, bad);
    const good = validateWheel({ version: v, items: [{ label: 'A', color: '#FF8800' }, { label: 'B' }], spinSeconds: 4, removeWinner: true });
    check('a valid save passes', !('errors' in good) && good.wheel.items[0].color === '#ff8800', good);
    await say('!wheel add C');
    const stale = await changeWheel(ch, w => (w.version !== v ? 'conflict' : w));
    check('a save from before a chat change is refused', stale === 'conflict');
    const saved = 'errors' in good ? null : await changeWheel(ch, w => ({ ...w, ...good.wheel }));
    check('a fresh save replaces the wheel', typeof saved === 'object' && saved !== null && saved.items.length === 2 && saved.spinSeconds === 4 && saved.removeWinner, saved);

    // Remove the winner: the landed item leaves the wheel once chat has the result (4s spin + 4s grace).
    resetWheelBusy();
    said.length = 0;
    await say('!spin');
    await new Promise(r => setTimeout(r, 8_600));
    const result = said.find(m => m.includes('The wheel landed on'));
    const landedLabel = result?.replace(/^.*landed on: (.*)!$/, '$1');
    check('the history keeps a removed winner, newest first', recentSpins(wdb).length === 2 && recentSpins(wdb)[0].result === landedLabel, recentSpins(wdb));
    check('the result goes to chat, and with removeWinner the item leaves the wheel', !!result && readWheel(ch).items.length === 1
      && !readWheel(ch).items.some(i => i.label === landedLabel), { said, items: readWheel(ch).items });
    resetWheelBusy();
  }

  // The wheel on the video overlay: spins there, and a playing video waits for it
  {
    const ch = 'wheelvidch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false }, video: { enabled: true, onlyWhileLive: false } });
    makeService(ch, { broadcaster: 999 });
    const wdb = openPointsDb(ch, { create: true })!;
    const said: string[] = [];
    const mod: KickTags = { username: 'modder', 'display-name': 'modder', badges: {}, isBroadcaster: false, isModUp: true, isVIPUp: true, rawBadges: [], senderId: 70 };
    const say = async (msg: string) => {
      const before = said.length;
      await wheelCommand({ say: async (_c, m) => { said.push(m); } }, msg, `#${ch}`, mod, { channelName: ch } as ChannelConfig);
      return said.slice(before).join(' | ');
    };
    resetWheelBusy();
    await changeWheel(ch, w => ({ ...w, items: [{ label: 'A' }, { label: 'B' }], onVideoOverlay: true }));
    check('a wheel on the video overlay needs that overlay open', (await say('!spin')).includes('open the video overlay'));
    markVideoOverlaySeen(wdb);
    runWrite(wdb, () => { creditTx(wdb, { userId: 80, username: 'viewer', amount: 100, reason: 'mod_add', now: 1 }); enqueueVideo(wdb, { ts: Date.now(), user_id: 80, username: 'viewer', video_id: 'AAAAAAAAAAA', title: 'T', start_s: 0, seconds: 30, cost: 0 }); });
    const started = advanceVideos(wdb)!.started_at!;
    const spun = await say('!spin');
    const after = playingVideo(wdb)!.started_at!;
    check('it spins there, and the playing video\'s slot stretches by the spin and its result', spun === '' && readOverlay(wdb).events.some(e => e.kind === 'wheel')
      && after - started === 6_000 + 5_000 + 500, { spun, stretch: after - started });
    check('the setting is kept by a dashboard save that doesn\'t name it', (() => {
      const v = validateWheel({ version: readWheel(ch).version, items: [{ label: 'A' }, { label: 'B' }], spinSeconds: 6, removeWinner: false });
      return !('errors' in v) && v.wheel.onVideoOverlay === undefined && readWheel(ch).onVideoOverlay === true;
    })());
    resetWheelBusy();
  }

  // Trap fish get a length, as a cast's do, shown in the haul
  {
    const ch = 'traplengthch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, catchOdds: 2 } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const pdb = openPointsDb(ch, { create: true })!;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const t: KickTags = { username: 'netter', 'display-name': 'netter', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 32 };
      const run = async (msg: string) => {
        shift += 6_000;
        const out: string[] = [];
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const fish = () => loadFish(pdb, 32)!;
      const fill = async () => { await run('$don fish trap'); shift += 61 * 60_000; return run('$don fish trap'); };
      runWrite(pdb, () => ensureUserTx(pdb, 32, 'netter', 1));
      const hauls: string[] = [];
      for (let i = 0; i < 6; i++) hauls.push(await fill());
      const held = fish().catch;
      const fishKinds = Object.entries(held.types).filter(([n, k]) => k > 0 && ITEMS.find(x => x.name === n)?.type === 'fish');
      check('every fish from a trap has a length, shown in the haul', fishKinds.length > 0 && fishKinds.every(([n, k]) => (held.sizes?.[n] ?? []).length === k)
        && hauls.filter(h => h.includes('spot some fish')).every(h => / \(\d+ cm\)/.test(h)), { hauls, held });
    } finally {
      Date.now = realNow;
    }
  }

  // Custom fish: a channel's own, by emoji or an emote's name
  {
    const ok = validatePointsPatch({}, { games: { customFish: [{ name: 'KEKLEO', weight: 1000000, price: 500, type: 'Predator' }, { name: '🦩\uFE0F', weight: 2, price: 900, type: 'Armored' }] } });
    const bad = (name: string, extra: Record<string, unknown> = {}) => validatePointsPatch({}, { games: { customFish: [{ name, weight: 1, price: 1, type: 'Swift', ...extra }] } }).errors.join(' ');
    check('custom fish: an emote\'s name or an emoji; not a built-in, a command word, a number or a bad type', ok.errors.length === 0
      && JSON.stringify(ok.next?.games?.customFish?.map(f => f.name)) === JSON.stringify(['KEKLEO', '🦩'])
      && bad('🐟').includes('built-in') && bad('shark').includes('built-in') && bad('Sharks').includes('built-in') && bad('junk').includes('already use') && bad('keeps').includes('already use')
      && bad('3v3').includes('emoji') && bad('a b').includes('emoji') && bad('K').includes('emoji') && bad('KEK', { type: 'Fire' }).includes('duel type')
      && validatePointsPatch({}, { games: { customFish: [{ name: 'KEK', weight: 1, price: 1, type: 'Swift' }, { name: 'kek', weight: 1, price: 1, type: 'Swift' }] } }).errors.join(' ').includes('Two custom fish'),
      [ok.errors, bad('🐟'), bad('fish'), bad('3v3')]);
    const gk = effectivePointsConfig(ok.next!).games;
    const kek = ITEMS.find(i => i.name === 'KEKLEO');
    const rolls = Array.from({ length: 50 }, () => weightedCatch('fish', gk).name);
    check('a custom fish joins the catches: sized, its odds and price, its rarity and duel type', !!kek?.custom && kek.size && gk.catches.some(c => c.name === 'KEKLEO' && c.custom && c.price === 500)
      && rolls.filter(n => n === 'KEKLEO').length > 45 && rarityOf(gk, 'KEKLEO') === 'Common' && typeOf('KEKLEO') === 'Predator' && sellPrice(kek!, gk, { cm: 50, record: false }) === 500, rolls.slice(0, 5));
    const other = effectivePointsConfig({ games: { enabled: true } }).games;
    check('another channel never catches it', Array.from({ length: 3000 }, () => weightedCatch('fish', other).name).every(n => n !== 'KEKLEO' && n !== '🦩') && !other.catches.some(c => c.custom));
    const sl = parseSellList(['kekleo', '2', '[emote:37225:KEKLEO]', '🦩']);
    check('it\'s typed by name in any case, from Kick\'s emote picker, or as its emoji', !('error' in sl) && sl.items.map(x => `${x.item.name}${x.n}`).join() === 'KEKLEO3,🦩1'
      && fishNamed(['[emote:1:KEKLEO]']) === 'KEKLEO' && fishNamed(['Kekleo']) === 'KEKLEO', sl);

    const ch = 'customfishch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, customFish: [{ name: 'KEKLEO', weight: 1, price: 500, type: 'Predator' }, { name: 'kek00cat', weight: 1, price: 300, type: 'Swift' }] } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const pdb = openPointsDb(ch, { create: true })!;
    runWrite(pdb, () => {
      ensureUserTx(pdb, 35, 'kekfan', 1);
      const d = initialData();
      d.lifetime.attempts = 1;
      for (const cm of [80, 30]) { addItem(d, kek!); ((d.catch.sizes ??= {}).KEKLEO ??= []).push({ cm, record: false }); }
      addItem(d, ITEMS.find(i => i.name === '🐟')!);
      (d.catch.sizes!['🐟'] ??= []).push({ cm: 50, record: false });
      saveFish(pdb, 35, d, 1);
    });
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const say = async (msg: string) => {
      shift += 6_000;
      const out: string[] = [];
      const t: KickTags = { username: 'kekfan', 'display-name': 'kekfan', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 35 };
      await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out[0] ?? '';
    };
    const shown = await say('$don fish show');
    const kinds = await say('$don fish show kekleo');
    const sold = await say('$don fish sell [emote:37225:KEKLEO] 30cm');
    check('viewers show and sell it like any fish, its name spaced so it shows as the emote', /KEKLEO KEKLEO/.test(shown) && !/KEKLEOKEKLEO|🐟KEKLEO|KEKLEO🐟/.test(shown)
      && kinds.includes('2 KEKLEO (🦷 Predator') && kinds.includes('80 cm') && sold.includes('Sold your KEKLEO 30 cm for') && loadFish(pdb, 35)!.catch.types.KEKLEO === 1, { shown, kinds, sold });
    // The streamer adds one, from Kick's emote picker, the length either side.
    shift += 6_000;
    const outs: string[] = [];
    const st: KickTags = { username: ch, 'display-name': ch, badges: {}, isBroadcaster: true, isModUp: true, isVIPUp: false, rawBadges: [], senderId: 999 };
    for (const m of ['$don fish add kekfan 1cm [emote:37225:KEKLEO]', '$don fish add @kekfan [emote:37225:KEKLEO] 64cm', '$don fish add kekfan [emote:6020230:kek00cat] 1cm', '$don fish add kekfan kek00cat 2']) {
      shift += 6_000;
      await fishCommand({ say: async (_c, x) => { outs.push(x); } }, m, `#${ch}`, st, { channelName: ch } as ChannelConfig);
    }
    check('the streamer adds a custom fish by its emote, the length before or after', outs[0]?.includes('Added KEKLEO 1 cm to @kekfan') && outs[1]?.includes('Added KEKLEO 64 cm')
      && JSON.stringify(loadFish(pdb, 35)!.catch.sizes!.KEKLEO.map(h => h.cm)) === '[80,1,64]'
      // Digits in a fish's own name aren't a count: the length is its, and a count after still counts.
      && outs[2]?.endsWith('🎁 Added kek00cat 1 cm to @kekfan. They have 5 fish and 0 junk now.') && /Added kek00cat \(\d+, \d+ cm\)/.test(outs[3] ?? ''), outs);
    Date.now = realNow;
  }

  // Reward big bites: Kicks over the line, a sub or resub, gifted subs (the gifter), on top of the timer.
  {
    const ch = 'rewardbite';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, bigBite: { kicksMin: 500, onSub: true, onGift: true } } });
    const sent: string[] = [];
    const rsvc = makeService(ch, { broadcaster: 999, sent });
    const rdb = openPointsDb(ch, { create: true })!;
    const bc = { user_id: 999, username: ch };
    const u = (id: number, name: string) => ({ user_id: id, username: name });
    const m = (id: string) => ({ ageMs: 0, messageId: id });
    rsvc.onLivestreamStatus({ broadcaster: bc, is_live: true } as LivestreamStatusEvent, { ageMs: 0 });
    markOverlaySeen(rdb, Date.now());
    const settle = () => new Promise(r => setTimeout(r, 50));
    rsvc.onKicksGifted({ broadcaster: bc, sender: u(61, 'smallkick'), gift: { amount: 100 } }, m('k1'));
    rsvc.onKicksGifted({ broadcaster: bc, sender: u(62, 'bigkick'), gift: { amount: 500 } }, m('k2'));
    rsvc.onKicksGifted({ broadcaster: bc, sender: u(62, 'bigkick'), gift: { amount: 500 } }, m('k2'));
    await settle();
    const kickLine = sent.find(x => x.includes('@bigkick')) ?? '';
    check('500 Kicks give the sender a big bite at once; fewer give none, and a redelivered event only one',
      !!biteFor(ch, 'bigkick') && !biteFor(ch, 'smallkick') && kickLine.includes('Thanks for the 500 Kicks') && kickLine.includes('guaranteed to land')
      && rewardBitesWaiting(ch) === 0, { sent, waiting: rewardBitesWaiting(ch) });
    // A resub while that bite is on its line waits its turn.
    rsvc.onSubscriptionRenewal({ broadcaster: bc, subscriber: u(63, 'resubber') }, m('r1'));
    await settle();
    const waited = !biteFor(ch, 'resubber') && rewardBitesWaiting(ch) === 1;
    takeBiteForTest(ch, 'bigkick');
    markOverlaySeen(rdb, Date.now());
    await rsvc.bigBiteTick();
    check('a resub\'s bite waits behind one already on a line, then starts', waited && !!biteFor(ch, 'resubber'), { waiting: rewardBitesWaiting(ch) });
    takeBiteForTest(ch, 'resubber');
    // A gifted sub: the recipient's own sub event comes too, and only the gifter gets a bite.
    rsvc.onSubscriptionNew({ broadcaster: bc, subscriber: u(65, 'giftee') }, m('n1'));
    rsvc.onSubscriptionGifts({ broadcaster: bc, gifter: u(64, 'gifter'), giftees: [u(65, 'giftee'), u(66, 'giftee2')] }, m('g1'));
    await settle();
    const gifted = !!biteFor(ch, 'gifter') && (sent.find(x => x.includes('@gifter')) ?? '').includes('the 2 gifted subs');
    takeBiteForTest(ch, 'gifter');
    markOverlaySeen(rdb, Date.now());
    await rsvc.bigBiteTick();
    check('gifted subs give the gifter a bite, and not their recipients', gifted && !biteFor(ch, 'giftee') && rewardBitesWaiting(ch) === 0, { sent: sent.slice(-3) });
    // Nothing for an anonymous gifter, the streamer, or while offline.
    rsvc.onSubscriptionGifts({ broadcaster: bc, gifter: { user_id: null, username: 'Anonymous', is_anonymous: true }, giftees: [u(67, 'g3')] }, m('g2'));
    rsvc.onKicksGifted({ broadcaster: bc, sender: u(999, ch), gift: { amount: 1000 } }, m('k3'));
    rsvc.onLivestreamStatus({ broadcaster: bc, is_live: false } as LivestreamStatusEvent, { ageMs: 0 });
    rsvc.onKicksGifted({ broadcaster: bc, sender: u(68, 'offkick'), gift: { amount: 900 } }, m('k4'));
    await settle();
    check('no reward bite for an anonymous gifter, the streamer, or offline', !biteFor(ch, ch) && !biteFor(ch, 'offkick') && rewardBitesWaiting(ch) === 0);
    // A paid bite always lands once every code is right, even the 🐉 (10%): 20 in a row.
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, catches: { '🦭': { weight: 0 }, '🦦': { weight: 0 }, '🦕': { weight: 0 }, '🦖': { weight: 0 }, '🦄': { weight: 0 } }, bigBite: { kicksMin: 500, pulls: 2 } } });
    rsvc.onLivestreamStatus({ broadcaster: bc, is_live: true } as LivestreamStatusEvent, { ageMs: 0 });
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    let landed = 0;
    try {
      for (let i = 0; i < 20; i++) {
        shift += 60_000;
        markOverlaySeen(rdb, Date.now());
        rsvc.onKicksGifted({ broadcaster: bc, sender: u(70, 'payer'), gift: { amount: 500 } }, m(`land${i}`));
        await settle();
        for (let pull = 0; pull < 2; pull++) {
          const b = biteFor(ch, 'payer');
          if (!b) break;
          shift += 3_000;
          const t: KickTags = { username: 'payer', 'display-name': 'payer', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 70 };
          await fishCommand({ say: async () => {} }, `$don fish reel ${b.code}`, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        }
        await settle();
        landed = loadFish(rdb, 70)?.catch.types['🐉'] ?? 0;
      }
    } finally {
      Date.now = realNow;
    }
    check('a paid bite always lands when every code is right, whatever the trophy\'s land chance', landed === 20, { landed });
    resetBites(ch, rdb);
  }

  // Feeding: a fish eats others, gains their value as XP, and levels up
  {
    const gf = effectivePointsConfig({ games: { enabled: true } }).games;
    const it = (n: string) => ITEMS.find(x => x.name === n)!;
    const shark = { cm: 50, record: false } as { cm: number; record: boolean; level?: number; xp?: number };
    const base = sellPrice(it('🦈'), gf, { cm: 50, record: false });
    const plain = fighterOf(gf, it('🦈'), { cm: 50, record: false });
    const cost = Math.round(base * 0.25);
    check('every level costs what it adds to the fish\'s value, a quarter of it', levelCost(it('🦈'), gf, shark, 0) === cost && levelCost(it('🦈'), gf, shark, 2) === cost);
    const up1 = addXp(it('🦈'), gf, shark, cost * 2 - 1);
    check('XP levels it as far as it reaches, the rest carried', up1 === 1 && shark.level === 1 && shark.xp === cost - 1, shark);
    addXp(it('🦈'), gf, shark, 1);
    const f2 = fighterOf(gf, it('🦈'), shark);
    check('each level adds 3% duel stats and 25% value', shark.level === 2 && !shark.xp && f2.level === 2 && Math.abs(f2.hp - plain.hp * 1.06) <= 1 && Math.abs(f2.attack - plain.attack * 1.06) < 0.2
      && sellPrice(it('🦈'), gf, shark) === Math.round(base * 1.5), { shark, f2, plain });
    // A level's bonus stops at the next tier's best: a maxed 🐟 is at most a full-length Lv0 🐠, a 🐳 has no ceiling.
    const maxedCommon = fighterOf(gf, it('🐟'), { cm: 100, record: false, level: 10 });
    const bestUncommon = fighterOf(gf, it('🐠'), { cm: 100, record: false });
    const maxedTop = fighterOf(gf, it('🐳'), { cm: 100, record: false, level: 10 });
    const topBase = fighterOf(gf, it('🐳'), { cm: 100, record: false });
    check('levels stop at the next tier\'s best, top tiers keep the whole bonus', maxedCommon.hp === bestUncommon.hp && maxedCommon.attack === bestUncommon.attack
      && maxedTop.hp === Math.round(topBase.hp * 1.3), { maxedCommon, bestUncommon, maxedTop, topBase });
    addXp(it('🦈'), gf, shark, 1e9);
    check('it stops at Lv10, the XP past it lost', shark.level === 10 && !shark.xp);
    const from = initialData(), to = initialData();
    addItem(from, it('🦈')); addItem(from, it('🦈'));
    from.catch.sizes = { '🦈': [{ cm: 50, record: false, level: 3, xp: 7 }, { cm: 50, record: false }] };
    takeSized(from, it('🦈'), 50, 1, gf);
    check('picking by length takes the lowest level first', from.catch.sizes['🦈'].length === 1 && from.catch.sizes['🦈'][0].level === 3);
    moveFish(from, to, it('🦈'), { index: 0, held: from.catch.sizes['🦈'][0] });
    check('a fish keeps its level and XP when it changes hands', to.catch.sizes!['🦈'][0].level === 3 && to.catch.sizes!['🦈'][0].xp === 7);
    const oldest = initialData();
    for (let i = 0; i < 3; i++) addItem(oldest, it('🐟'));
    oldest.catch.sizes = { '🐟': [{ cm: 90, record: false, level: 2 }, { cm: 10, record: false }, { cm: 20, record: false }] };
    takeItems(oldest, it('🐟'), 1, gf);
    const dup = initialData();
    for (let i = 0; i < 4; i++) addItem(dup, it('🐟'));
    dup.catch.sizes = { '🐟': [{ cm: 10, record: false, level: 1 }, { cm: 90, record: false }, { cm: 20, record: false, level: 3 }, { cm: 30, record: false }] };
    takeItems(dup, it('🐟'), 2, gf, true);
    check('taking the oldest skips fed fish; keeping the biggest keeps the fed ones', oldest.catch.sizes['🐟'].map(h => h.cm).join() === '20,90'
      && dup.catch.sizes['🐟'].map(h => `${h.cm}:${h.level ?? 0}`).join() === '10:1,20:3', [oldest.catch.sizes, dup.catch.sizes]);
    // An unsized 🐟 (from a trap) goes before a fed one, not after it.
    const unsized = initialData();
    for (let i = 0; i < 2; i++) addItem(unsized, it('🐟'));
    unsized.catch.sizes = { '🐟': [{ cm: 90, record: false, level: 2 }] };
    takeItems(unsized, it('🐟'), 1, gf);
    check('taking by kind takes an unsized fish before a fed one', unsized.catch.types['🐟'] === 1 && unsized.catch.sizes['🐟'][0]?.level === 2, unsized.catch);

    const ch = 'feedch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, feedFailPercent: 0 } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const ch2 = 'feedfailch';
    writeConfig(root, ch2, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, feedFailPercent: 100 } });
    makeService(ch2, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const seedFeed = (c: string) => {
      const db = openPointsDb(c, { create: true })!;
      runWrite(db, () => {
        ensureUserTx(db, 36, 'feeder', 1);
        const d = initialData();
        d.lifetime.attempts = 1;
        for (const [n, cm] of [['🦈', 50], ['🦈', 80], ['🐟', 20], ['🐟', 30], ['🐟', 40]] as const) { addItem(d, it(n)); ((d.catch.sizes ??= {})[n] ??= []).push({ cm, record: false }); }
        saveFish(db, 36, d, 1);
      });
      return db;
    };
    const fdb = seedFeed(ch), fdb2 = seedFeed(ch2);
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const say = async (c: string, msg: string) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: 'feeder', 'display-name': 'feeder', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 36 };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${c}`, t, { channelName: c } as ChannelConfig);
        return out[0] ?? '';
      };
      const food = ['🐟 20', '🐟 30', '🐟 40'].reduce((sum, x) => sum + sellPrice(it('🐟'), gf, { cm: Number(x.split(' ')[1]), record: false }), 0);
      const notHeld = await say(ch, '$don fish feed 🦈 50cm 🐟 4');
      const itself = await say(ch, '$don fish feed 🦈 50cm 🦈 80cm 🦈');
      const ate = await say(ch, '$don fish feed 🦈 50cm 🐟 3');
      const d = loadFish(fdb, 36)!.catch;
      const eater = d.sizes!['🦈'].find(h => h.cm === 50)!;
      check('feed: the first fish eats the rest, gaining their sell value as XP; food not held and the fish itself are refused',
        notHeld.includes('Nothing eaten: you have only 3 🐟') && itself.includes('Nothing eaten: you have no 🦈 besides the 🦈 50 cm eating')
        && ate.includes(`Your 🦈 50 cm ate 🐟 x3 (+${food} XP)`) && (d.types['🐟'] ?? 0) === 0 && d.types['🦈'] === 2 && eater.xp === food && !eater.level, { notHeld, itself, ate, eater });
      const failed = await say(ch2, '$don fish feed 🦈 🐟 🐟');
      const d2 = loadFish(fdb2, 36)!.catch;
      check('a failed feeding loses the food and gains nothing', failed.includes('Your 🦈 80 cm choked on 🐟 x2') && d2.types['🐟'] === 1 && d2.sizes!['🦈'].every(h => !h.xp && !h.level), { failed, d2 });
      runWrite(fdb, () => { const x = loadFish(fdb, 36)!; x.catch.sizes!['🦈'][0].level = 4; saveFish(fdb, 36, x, 1); });
      const shown = await say(ch, '$don fish show 🦈');
      check('show lists a fish\'s level', /50 cm Lv4 ❤️/.test(shown), shown);
      // "feed 🦈 🦈50cm": the highest-level 🦈 is the 50 cm one, named as food, so another 🦈 eats it.
      const other = await say(ch, '$don fish feed 🦈 🦈50cm');
      check('feed: an eater named without a length isn\'t the fish named as food', other.includes('Your 🦈 80 cm ate 🦈 50 cm') && loadFish(fdb, 36)!.catch.types['🦈'] === 1, other);
      // Two 🐟 60 cm, one fed: by length the unfed one is eaten, and a fed one eaten is named with its level.
      runWrite(fdb, () => {
        const x = loadFish(fdb, 36)!;
        for (const level of [2, 0]) { addItem(x, it('🐟')); ((x.catch.sizes ??= {})['🐟'] ??= []).push(level ? { cm: 60, record: false, level } : { cm: 60, record: false }); }
        saveFish(fdb, 36, x, 1);
      });
      const twin = await say(ch, '$don fish feed 🦈 🐟 60cm');
      const fedLeft = loadFish(fdb, 36)!.catch.sizes!['🐟'];
      const fedTwin = await say(ch, '$don fish feed 🦈 🐟');
      check('feed: of two the same length the unfed one is food, and a fed one eaten shows its level',
        /ate 🐟 60 cm \(/.test(twin) && fedLeft.length === 1 && fedLeft[0].level === 2 && fedTwin.includes('ate 🐟 60 cm Lv2 ('), { twin, fedTwin, fedLeft });
      // Full at Lv10: a 🐟 100 cm needs 10 levels of 38 XP; four 🐟 90 cm (~140 each) are one too many, so one goes back.
      runWrite(fdb, () => {
        const x = loadFish(fdb, 36)!;
        for (const cm of [100, 90, 90, 90, 90]) { addItem(x, it('🐟')); ((x.catch.sizes ??= {})['🐟'] ??= []).push({ cm, record: false }); }
        saveFish(fdb, 36, x, 1);
      });
      const full = await say(ch, '$don fish feed 🐟 100cm 🐟 90cm 4');
      const afterFull = loadFish(fdb, 36)!.catch;
      check('feed: a fish stops eating at Lv10 and what it didn\'t eat stays', full.includes('grew to Lv10') && full.includes('went back to your bucket') && full.includes('🐟 90 cm')
        && afterFull.types['🐟'] === 2 && afterFull.sizes!['🐟'].filter(h => h.cm === 90).length === 1, { full, left: afterFull.sizes!['🐟'] });
      // A Lv10 🐟 100 cm and an unfed 🐟 100 cm: the full one is passed over, by length or by kind.
      runWrite(fdb, () => {
        const x = loadFish(fdb, 36)!;
        for (const cm of [100, 90]) { addItem(x, it('🐟')); x.catch.sizes!['🐟'].push({ cm, record: false }); }
        saveFish(fdb, 36, x, 1);
      });
      const fresh = await say(ch, '$don fish feed 🐟 100cm 🐟 90cm');
      const byKind = await say(ch, '$don fish feed 🐟 🐟 90cm');
      const twins = loadFish(fdb, 36)!.catch.sizes!['🐟'].filter(h => h.cm === 100);
      check('feed: a Lv10 fish is passed over for an unfed one of the same kind and length',
        fresh.includes('Your 🐟 100 cm ate 🐟 90 cm') && byKind.includes('Your 🐟 100 cm Lv') && !byKind.includes('already')
        && twins.length === 2 && twins.filter(h => h.level === 10).length === 1 && twins.some(h => (h.level ?? 0) < 10 && ((h.level ?? 0) > 0 || (h.xp ?? 0) > 0)), { fresh, byKind, twins });
    } finally {
      Date.now = realNow;
    }
  }

  // Fish trades: an offer names the very fish, the other side accepts, both move, the proposer's fee burns.
  {
    const ch = 'tradech';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trade: { enabled: true, feePercent: 3, feeMinimum: 10 } } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const tdb = openPointsDb(ch, { create: true })!;
    const it = (n: string) => ITEMS.find(i => i.name === n)!;
    const gt = effectivePointsConfig({ games: { enabled: true } }).games;
    runWrite(tdb, () => {
      for (const [id, name, bal, fish] of [[71, 'alice', 5000, [['🦈', 72, 0], ['🐟', 40, 0], ['🐟', 50, 4]]], [72, 'bob', 100, [['🦭', 95, 0]]]] as const) {
        ensureUserTx(tdb, id, name, 1);
        creditTx(tdb, { userId: id, username: name, amount: bal, reason: 'mod_add', now: 1 });
        const d = initialData();
        d.lifetime.attempts = 1;
        for (const [n, cm, level] of fish) { addItem(d, it(n)); ((d.catch.sizes ??= {})[n] ??= []).push({ cm, record: false, ...(level ? { level } : {}), ...(n === '🦭' ? { legacyLevels: true as const } : {}) }); }
        saveFish(tdb, id, d, 1);
      }
    });
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    const say = async (who: [string, number], msg: string) => {
      shift += 6_000; // past the 5s between one viewer's commands
      const out: string[] = [];
      const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
      await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
      return out.join(' | ');
    };
    const A: [string, number] = ['alice', 71], B: [string, number] = ['bob', 72];
    const short = await say(A, '$don fish trade @bob 🐋 for 🦭');
    const notTheirs = await say(A, '$don fish trade @bob 🦈 for 🐋');
    // By kind, 🐟 is the unfed 40 cm one, not the Lv4: the offer names it.
    const offer = await say(A, '$don fish trade @bob 🦈 72cm 🐟 1000 for 🦭');
    const worth = sellPrice(it('🦈'), gt, { cm: 72, record: false }) + sellPrice(it('🐟'), gt, { cm: 40, record: false }) + 1000 + sellPrice(it('🦭'), gt, { cm: 95, record: false });
    const fee = Math.max(10, Math.round(worth * 0.03));
    const twice = await say(A, '$don fish trade @bob 🐟 for 🦭');
    const done = await say(B, '$don fish accept');
    const a = loadFish(tdb, 71)!.catch, b = loadFish(tdb, 72)!.catch;
    const bal = (id: number) => getUser(tdb, id)!.balance;
    check('trade: short or not held is refused, the offer names the very fish and the fee', short.includes("You can't offer that") && notTheirs.includes('bob has no 🐋')
      && offer.includes('🦈 72 cm, 🐟 40 cm, 1,000 $DON for your 🦭 95 cm') && offer.includes(`pays a ${fee.toLocaleString('en-US')} $DON fee`) && twice.includes('already have an offer'), { short, notTheirs, offer, twice });
    check('trade: accepted, the fish and currency change hands, the fee burns, a fish keeps its legacy levels', done.includes('Trade done') && b.sizes!['🦈']?.[0]?.cm === 72 && b.sizes!['🐟']?.[0]?.cm === 40
      && a.sizes!['🦭']?.[0]?.legacyLevels === true && a.sizes!['🐟'].length === 1 && a.sizes!['🐟'][0].level === 4 && !b.sizes!['🦭']?.length
      && bal(71) === 5000 - 1000 - fee && bal(72) === 100 + 1000
      && (tdb.prepare('SELECT COUNT(*) AS n FROM fish_trades').get() as { n: number }).n === 1, { done, a: a.sizes, b: b.sizes, b71: bal(71), b72: bal(72), fee });
    // The newer order: what you give, then who, then what you want.
    const back = await say(B, '$don fish trade 🦈 @alice 🦭');
    const no = await say(A, '$don fish decline');
    const gone = await say(B, '$don fish trade');
    check('trade: declined, nothing moves, nothing waits', back.includes('offers 🦈 72 cm for your 🦭 95 cm') && no.includes('turned down your trade') && gone.includes('No trades waiting')
      && loadFish(tdb, 72)!.catch.sizes!['🦈'].length === 1, { back, no, gone });
    Date.now = realNow;
  }

  // A cap on what one viewer holds: past it new fish sell on the spot, new junk is binned
  {
    const gc = effectivePointsConfig({ games: { enabled: true, maxFish: 3, maxJunk: 2 } }).games;
    const it = (n: string) => ITEMS.find(x => x.name === n)!;
    const d = initialData();
    for (const cm of [10, 20, 30]) { addItem(d, it('🐟')); ((d.catch.sizes ??= {})['🐟'] ??= []).push({ cm, record: false }); }
    check('under the cap nothing goes', overflow(d, it('🐟'), gc) === null && d.catch.fish === 3);
    addItem(d, it('🐟'));
    d.catch.sizes!['🐟'].push({ cm: 90, record: false });
    const coins = overflow(d, it('🐟'), gc, 1);
    check('past the cap the fish just added sells, at its own price', coins === sellPrice(it('🐟'), gc, { cm: 90, record: false }) && d.catch.fish === 3 && d.catch.types['🐟'] === 3
      && d.catch.sizes!['🐟'].map(h => h.cm).join() === '10,20,30' && d.lifetime.sold === 1 && d.lifetime.coins === coins, { coins, d: d.catch });
    for (let i = 0; i < 3; i++) addItem(d, it('🥫'));
    check('junk past its cap is binned for nothing; what was over before stays', overflow(d, it('🥫'), gc) === 0 && d.catch.junk === 2 && d.lifetime.scrapped === 1
      && overflow(d, it('🥫'), gc) === null);
    const g100 = effectivePointsConfig({ games: { enabled: true } }).games;
    check('caps are 100 by default, warned from 90; 0 is no cap', g100.maxFish === 100 && g100.maxJunk === 100 && nearCap(g100, 'fish', 90) && !nearCap(g100, 'fish', 89)
      && !nearCap(effectivePointsConfig({ games: { enabled: true, maxFish: 0 } }).games, 'fish', 5000));
    check('the Commands tab says so', publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true } })).sections.find(sec => sec.title === 'Fishing')!.note!.includes('hold 100 fish and 100 junk'));

    const ch = 'bucketch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, catchOdds: 2, maxFish: 1, maxJunk: 1, giveEnabled: true, giveCooldownSeconds: 0 } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const pdb = openPointsDb(ch, { create: true })!;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string, who: [string, number] = ['bucketeer', 33]) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: who[0], 'display-name': who[0], badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: who[1] };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      runWrite(pdb, () => { ensureUserTx(pdb, 33, 'bucketeer', 1); ensureUserTx(pdb, 34, 'donor', 1); });
      const hauls: string[] = [];
      for (let i = 0; i < 8; i++) { await run('$don fish trap'); shift += 61 * 60_000; hauls.push(await run('$don fish trap')); }
      const b = loadFish(pdb, 33)!.catch;
      const paid = balance(ch, 33);
      check('traps past the cap sell the fish and bin the junk, paying for the fish', b.fish === 1 && b.junk <= 1 && hauls.some(h => h.includes(', sold)') && h.includes('Your bucket is full (1 fish): sold for'))
        && paid > 0, { hauls, b, paid });
      runWrite(pdb, () => { const d = loadFish(pdb, 34) ?? initialData(); d.lifetime.attempts = 1; addItem(d, it('🦀')); ((d.catch.sizes ??= {})['🦀'] ??= []).push({ cm: 40, record: false }); saveFish(pdb, 34, d, 1); });
      const refused = await run('$don fish give @bucketeer 🦀', ['donor', 34]);
      check('a gift to a full bucket is refused and stays the giver\'s', refused.includes("bucket is full (1), so they can't take it") && loadFish(pdb, 34)!.catch.types['🦀'] === 1, refused);
    } finally {
      Date.now = realNow;
    }
  }

  // Trap checks: a question before an offline haul, against macros
  {
    const ch = 'trapcheckch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, trapCheck: { enabled: true, chancePercent: 100 } } });
    makeService(ch, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
    const pdb = openPointsDb(ch, { create: true })!;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const t: KickTags = { username: 'trapper', 'display-name': 'trapper', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 31 };
      const run = async (msg: string) => {
        shift += 6_000;
        const out: string[] = [];
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const fish = () => loadFish(pdb, 31)!;
      const fill = async (how = '$don fish trap') => { await run('$don fish trap'); shift += 61 * 60_000; return run(how); };
      runWrite(pdb, () => { ensureUserTx(pdb, 31, 'trapper', 1); creditTx(pdb, { userId: 31, username: 'trapper', amount: 1000, reason: 'test', now: 1 }); });

      const asked = await fill();
      const q = fish().trapCheck;
      check('offline, full traps ask a question first and hold the haul', asked.includes('Before you pull them up') && asked.includes('30s and 3 tries')
        && asked.includes('15% of your $DON') && !!q && fish().trap.active && fish().lifetime.trap.times === 0, { asked, q });
      const again = await run('$don f t');
      check('collecting again repeats the same question', again.includes(q!.question) && fish().trap.active, again);
      const blank = await run('$don fish answer');
      check('an empty answer repeats it, no fine', blank.includes(q!.question) && balance(ch, 31) === 1000 && !!fish().trapCheck, blank);
      const quick = async (msg: string) => {
        shift += 1_000;   // inside the 5s cooldown: a waiting answer skips it
        const out: string[] = [];
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const miss = await quick('$don fish answer nope');
      check('a wrong try leaves the rest, without the cooldown', miss.includes('Not quite! 2 tries left') && miss.includes(q!.question)
        && fish().trapCheck?.wrong === 1 && balance(ch, 31) === 1000, miss);
      const right = await quick(`$don f ans ${q!.answers[0]}`);
      check('a right answer collects the haul', right.includes('Correct!') && right.includes('drag the traps') && !fish().trap.active && !fish().trapCheck
        && fish().lifetime.trap.checksPassed === 1 && balance(ch, 31) === 1000, right);
      check('no question waiting says so', (await run('$don fish answer 3')).includes("There's no question"));

      const askedReset = await fill('$don fish trap reset');
      const qr = fish().trapCheck!;
      check('a reset asks too', askedReset.includes('Before you pull them up') && qr.reset, askedReset);
      const relaid = await run(`$don fish answer ${qr.answers[qr.answers.length - 1]}`);
      check('a right answer to a reset collects and lays again', relaid.includes('Correct!') && relaid.includes('You have laid') && fish().trap.active, relaid);
      await run('$don fish trap cancel');

      await fill();
      check('collecting meanwhile repeats it with the time left', (await run('$don fish trap')).includes('but first') && !!fish().trapCheck);
      shift += 31_000;
      const late = await run(`$don fish answer ${fish().trapCheck!.answers[0]}`);
      check('a right answer after the time is up is too late: fined', late.includes("Time's up!") && balance(ch, 31) === 1000 - 150 && !fish().trap.active, { late, b: balance(ch, 31) });
      await fill();
      shift += 5 * 3600_000;
      const restarted = await run('$don fish trap');
      check('a window whose timer never ran ends on the next trap command', restarted.includes("Time's up!") && !fish().trapCheck && balance(ch, 31) === 850 - 127, { restarted, b: balance(ch, 31) });
      runWrite(pdb, () => creditTx(pdb, { userId: 31, username: 'trapper', amount: 1000 - balance(ch, 31), reason: 'test', now: 1 }));
      await fill();
      await quick('$don fish answer nope');
      await quick('$don fish answer still no');
      const wrong = await quick('$don fish answer definitely not it');
      check('three wrong tries fine 15% and empty the traps', wrong.includes('Wrong again!') && wrong.includes('150 $DON') && balance(ch, 31) === 850
        && !fish().trap.active && !fish().trapCheck && fish().lifetime.trap.checksFailed === 3, wrong);
      const ledger = pdb.prepare("SELECT delta, reason FROM ledger WHERE user_id = 31 AND reason = 'game:fish_trap_check'").all();
      check('the fine is on the ledger', ledger.length === 3, ledger);

      await fill();
      await run('$don fish trap cancel');
      check('cancelling drops the question', !fish().trapCheck && !fish().trap.active);
      await run('$don fish trap');
      shift += 40 * 60_000;
      const liftAsked = await run('$don fish trap lift');
      check('a lift is asked too, with the traps ended where they were lifted', liftAsked.includes('Before you pull them up') && !!fish().trapCheck
        && Math.abs(fish().trap.duration - 40 * 60_000) < 60_000 && fish().trap.end <= Date.now(), { liftAsked, trap: fish().trap });
      const liftRight = await run(`$don fish answer ${fish().trapCheck!.answers[0]}`);
      check('answering a lifted trap\'s question collects the haul', liftRight.includes('Correct!') && liftRight.includes('drag the traps') && !fish().trap.active, liftRight);

      // Pulling the traps while a question waits is a failed check, fined.
      runWrite(pdb, () => creditTx(pdb, { userId: 31, username: 'trapper', amount: 1000 - balance(ch, 31), reason: 'test', now: 1 }));
      await fill();
      const pulled = await run('$don fish trap cancel');
      check('cancelling traps with a question waiting is a failed check', pulled.includes("Pulling your traps doesn't dodge") && pulled.includes('150 $DON')
        && balance(ch, 31) === 850 && !fish().trapCheck && !fish().trap.active, pulled);
      // The fine is set when asked: $DON moved away afterwards doesn't shrink it (only what's left caps it).
      await fill();
      check('the fine is set when the question is asked', fish().trapCheck?.fine === 127, fish().trapCheck);
      runWrite(pdb, () => debitTx(pdb, { userId: 31, amount: 400, reason: 'test', now: 1 }));
      shift += 121_000;
      const late2 = await run('$don fish trap');
      check('moving $DON away doesn\'t shrink it', late2.includes("Time's up") && balance(ch, 31) === 850 - 400 - 127, { late2, b: balance(ch, 31) });
      // The service keeps the live state it learned; a new one starts live.
      makeService(ch, { broadcaster: 999 });
      const live = await fill();
      check('never while live', live.includes('drag the traps') && !fish().trapCheck, live);
    } finally {
      Date.now = realNow;
    }

    check('answers match loosely', answerMatches({ answers: ['6', 'six'] }, ' Six. ')
      && answerMatches({ answers: [normalizeAnswer('🐙'), 'octopus'] }, '🐙\uFE0F \u{E0021}')
      && answerMatches({ answers: ['octopus'] }, 'the Octopus')
      && !answerMatches({ answers: ['6', 'six'] }, '7')
      // Plurals and spacing: "socks" for 🧦 was refused on 2026-10-14.
      && answerMatches({ answers: ['🧦', 'sock'] }, 'Socks') && answerMatches({ answers: ['pufferfish'] }, 'puffer fish')
      && answerMatches({ answers: ['leaves', 'leaf'] }, 'leafs') && !answerMatches({ answers: ['16', 'sixteen'] }, '1'));
    const samples = Array.from({ length: 300 }, () => makeTrapCheck(false, 0, 30));
    check('a fish question never takes "fish" as its answer', samples.every(c => !c.answers.includes('fish')));
    // On a phone an emoji is hard to copy: every question can be answered with digits.
    check('every question takes a plain number', samples.every(c => c.answers.some(a => /^\d+$/.test(a))), samples.filter(c => !c.answers.some(a => /^\d+$/.test(a))).slice(0, 3));
    check('every question has normalized answers, and the kinds vary', samples.every(c => c.answers.length > 0 && c.answers.every(a => a === normalizeAnswer(a)))
      && new Set(samples.map(c => c.question.split(' ')[0])).size >= 3, samples.slice(0, 5));
    // Cast checks: the same question on a share of offline casts.
    {
      const ch3 = 'castcheckch';
      writeConfig(root, ch3, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapCheck: { enabled: true, chancePercent: 100, castChancePercent: 100, answerSeconds: 120 } } });
      makeService(ch3, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
      const cdb3 = openPointsDb(ch3, { create: true })!;
      runWrite(cdb3, () => { ensureUserTx(cdb3, 33, 'caster', 1); creditTx(cdb3, { userId: 33, username: 'caster', amount: 1000, reason: 'test', now: 1 }); });
      const t3: KickTags = { username: 'caster', 'display-name': 'caster', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 33 };
      const realNow3 = Date.now;
      let shift3 = 0;
      Date.now = () => realNow3() + shift3;
      try {
        const run3 = async (msg: string) => {
          shift3 += 6_000;
          const out: string[] = [];
          await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch3}`, t3, { channelName: ch3 } as ChannelConfig);
          return out[0] ?? '';
        };
        const f3 = () => loadFish(cdb3, 33)!;
        const snag = await run3('$don fish');
        const q3 = f3().trapCheck;
        check('an offline cast can ask first, and doesn\'t cast', snag.includes('Your line snagged') && snag.includes('followed by your answer') && !!q3?.cast && f3().lifetime.attempts === 0, snag);
        check('casting again repeats it', (await run3('$don f')).includes('Before you cast again') && f3().lifetime.attempts === 0);
        check('so does laying traps', (await run3('$don fish trap')).includes('Free your line first') && !f3().trap.active);
        const freed = await run3(`$don fish answer ${q3!.answers.find(a => /^\d+$/.test(a))}`);
        check('a right answer frees the line, no fine', freed.includes('Correct! Your line is free') && !f3().trapCheck && balance(ch3, 33) === 1000, freed);
        await run3('$don fish');
        for (const w of ['nope', 'still no']) await run3(`$don fish answer ${w}`);
        const snapped = await run3('$don fish answer definitely not');
        check('failing a cast check fines and leaves the traps alone', snapped.includes('Wrong again! Your line snaps') && balance(ch3, 33) === 850
          && !f3().trapCheck && !f3().trap.active && f3().lifetime.trap.checksFailed === 1, snapped);
      } finally {
        Date.now = realNow3;
      }
    }

    // The leaderboard's fishing page: the same command, its replies kept for the page, a picture
    // check instead of a typed one, and chat pointed at the page rather than answering it.
    {
      const chw = 'webfishch';
      writeConfig(root, chw, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, feedFailPercent: 0, trade: { enabled: true }, steal: { enabled: true }, trapCheck: { enabled: true, chancePercent: 100, castChancePercent: 100, answerSeconds: 120 } } });
      makeService(chw, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
      const wdb = openPointsDb(chw, { create: true })!;
      runWrite(wdb, () => { ensureUserTx(wdb, 44, 'webber', 1); creditTx(wdb, { userId: 44, username: 'webber', amount: 1000, reason: 'test', now: 1 }); });
      const realNowW = Date.now;
      let shiftW = 0;
      Date.now = () => realNowW() + shiftW;
      try {
        let n = 0;
        const page = async (args: string[]) => {
          shiftW += 6_000;
          const requestId = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
          const chat: string[] = [];
          const tags: KickTags = { username: 'webber', 'display-name': 'webber', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 44,
            messageId: `web:${requestId}`, web: { reply: (text, meta) => recordWebReply(wdb, { requestId, userId: 44 }, text, meta) } };
          await fishCommand({ say: async (_c, m) => { chat.push(m); } }, `$don fish ${args.join(' ')}`.trim(), `#${chw}`, tags, { channelName: chw } as ChannelConfig);
          return { chat, replies: repliesFor(wdb, requestId).map(r => r.text) };
        };
        const chatSay = async (msg: string) => {
          shiftW += 6_000;
          const out: string[] = [];
          const t: KickTags = { username: 'webber', 'display-name': 'webber', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 44 };
          await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${chw}`, t, { channelName: chw } as ChannelConfig);
          return out[0] ?? '';
        };
        const fw = () => loadFish(wdb, 44)!;
        const cast = await page([]);
        const asked = fw().trapCheck;
        check('a page cast answers on the page, never in chat', cast.chat.length === 0 && cast.replies.length === 1 && cast.replies[0].includes('Your line snagged'), cast);
        check('a page cast asks a picture check, not a typed one', !!asked?.tap && asked.tap.fish.length >= 6 && asked.answers.length === 0 && /^Tap the /.test(asked.question), asked);
        const pointed = await chatSay('$don fish answer 3');
        check('a picture check typed at in chat is no try, just the page link', pointed.includes('fishing page') && pointed.includes('/leaderboard/webfishch?tab=fishing') && fw().trapCheck?.wrong === 0, pointed);
        const off = asked!.tap!.fish.find((_, i) => i !== asked!.tap!.target)!;
        const miss = await page(['answer', `tap:${off.x.toFixed(3)},${off.y.toFixed(3)}`]);
        check('tapping another fish counts as a wrong try', miss.replies[0]?.includes('Not quite') === true && fw().trapCheck?.wrong === 1, miss);
        const hit = asked!.tap!.fish[asked!.tap!.target];
        const freed = await page(['answer', `tap:${hit.x.toFixed(3)},${hit.y.toFixed(3)}`]);
        check('tapping the right fish frees the line', freed.replies[0]?.includes('Correct! Your line is free') === true && !fw().trapCheck && balance(chw, 44) === 1000, freed);
        const other = await page(['duel', '@partner']);
        check('the page plays only casts, traps, answers, selling, feeding, trades and steals', other.replies[0] === 'That one is played in chat.' && other.chat.length === 0, other);
        const quick = await page([]);
        shiftW -= 5_000;
        const spam = await page([]);
        check('the page is told about the cooldown instead of left waiting', spam.replies[0]?.includes('one move every few seconds') === true, { quick, spam });
        const sigs = wdb.prepare("SELECT COUNT(*) AS n FROM fish_signals WHERE user_id = 44 AND kind = 'cast'").get() as { n: number };
        check('page casts feed the cheat signals like chat casts', sigs.n >= 2, sigs);

        // Selling and trading from the page.
        runWrite(wdb, () => {
          ensureUserTx(wdb, 45, 'partner', 1);
          creditTx(wdb, { userId: 45, username: 'partner', amount: 1000, reason: 'test', now: 1 });
          const mine = loadFish(wdb, 44)!;
          for (const cm of [30, 60]) { addItem(mine, ITEMS.find(x => x.name === '🐟')!); (((mine.catch.sizes ??= {})['🐟']) ??= []).push({ cm, record: false }); }
          saveFish(wdb, 44, mine, 1);
          const theirs = loadFish(wdb, 45) ?? initialData();
          addItem(theirs, ITEMS.find(x => x.name === '🐠')!);
          (((theirs.catch.sizes ??= {})['🐠']) ??= []).push({ cm: 50, record: false });
          saveFish(wdb, 45, theirs, 1);
        });
        const before = balance(chw, 44);
        const sold = await page(['sell', '🐟', '1']);
        check('a page sale answers on the page and pays', sold.chat.length === 0 && /^Sold your 🐟/.test(sold.replies[0] ?? '') && balance(chw, 44) > before
          && (fw().catch.types['🐟'] ?? 0) === 1, sold);
        shiftW += 31 * 60_000;
        const offered = await page(['trade', '🐟', '@partner', '🐠']);
        check('a page trade offer pings the other viewer in chat and shows on the page', offered.chat.some(l => l.includes('@partner') && l.includes('webber offers'))
          && offered.replies.some(l => l.includes('@partner')) && mirroredTrades(wdb).some(o => o.fromId === 44 && o.toId === 45), offered);
        const partnerMove = async (args: string[]) => {
          shiftW += 6_000;
          const requestId = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
          const chat: string[] = [];
          const tags: KickTags = { username: 'partner', 'display-name': 'partner', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 45,
            messageId: `web:${requestId}`, web: { reply: (text, meta) => recordWebReply(wdb, { requestId, userId: 45 }, text, meta) } };
          await fishCommand({ say: async (_c, m) => { chat.push(m); } }, `$don fish ${args.join(' ')}`.trim(), `#${chw}`, tags, { channelName: chw } as ChannelConfig);
          return { chat, replies: repliesFor(wdb, requestId).map(r => r.text) };
        };
        const took = await partnerMove(['accept']);
        check('the other viewer accepts on the page, and both are told', took.chat.some(l => l.includes('Trade done')) && took.replies.some(l => l.includes('Trade done'))
          && (loadFish(wdb, 45)!.catch.types['🐟'] ?? 0) === 1 && (fw().catch.types['🐠'] ?? 0) === 1 && !mirroredTrades(wdb).length, took);
        const none = await partnerMove(['decline']);
        check('declining with nothing waiting says so', none.replies[0] === 'Nobody has offered you a trade.', none);

        // Selling one very fish: by length, level and 🏅, a plain one going before a record.
        runWrite(wdb, () => {
          const mine = loadFish(wdb, 44)!;
          for (const h of [{ cm: 100, record: true, level: 10 }, { cm: 100, record: false, level: 10 }, { cm: 100, record: false }]) {
            addItem(mine, ITEMS.find(x => x.name === '🐡')!);
            (((mine.catch.sizes ??= {})['🐡']) ??= []).push(h);
          }
          saveFish(wdb, 44, mine, 1);
        });
        const puffers = () => (fw().catch.sizes?.['🐡'] ?? []).map(h => `${h.level ?? 0}${h.record ? 'r' : ''}`).sort().join(',');
        const plainTen = await page(['sell', '🐡', '100cm', 'Lv10']);
        check('a level after a length sells that level, the plain one before the 🏅', plainTen.replies[0]?.includes('🐡 100 cm Lv10') === true && puffers() === '0,10r', { plainTen, left: puffers() });
        const recordTen = await page(['sell', '🐡', '100cm', 'Lv10', '🏅']);
        check('a 🏅 sells the record one', recordTen.replies[0]?.includes('🐡 100 cm Lv10 🏅') === true && puffers() === '0', { recordTen, left: puffers() });
        const noSuch = await page(['sell', '🐡', '100cm', 'Lv3']);
        check('a level they don\'t hold sells nothing', noSuch.replies[0]?.includes('Nothing sold: you have no 🐡 100 cm Lv3') === true && puffers() === '0', noSuch);
        const giveLv = await chatSay('$don fish give @partner 🐡 100cm Lv0');
        check('a level is only for selling: a gift still turns it down', !giveLv.includes('You gave') && puffers() === '0', giveLv);
        const twice = await page(['sell', '🐡', '100cm', '🐡', '100cm', 'Lv0']);
        check('naming the same fish twice sells nothing', twice.replies[0]?.startsWith('Nothing sold') === true && puffers() === '0', { twice, left: puffers() });
        const striped = makeTapCheck(false, 0, 60);
        check('a colour picture check also stripes its fish, and only that one',
          !striped.question.includes('striped') || (striped.tap!.fish.filter(f => f.striped).length === 1 && striped.tap!.fish[striped.tap!.target].striped === true));
        // Stealing from the page: the check and a refusal stay on the page; a try that goes ahead is told in chat too.
        shiftW += 2 * 60 * 60_000;
        const scout = await page(['steal', 'check', '@partner']);
        check('a page steal check answers on the page only', scout.chat.length === 0 && scout.replies.length === 1 && scout.replies[0].includes('partner'), scout);
        // Stealing needs a cast behind you: the test thief has only had its line snagged.
        runWrite(wdb, () => { const mine = loadFish(wdb, 44)!; mine.lifetime.attempts = Math.max(1, mine.lifetime.attempts); mine.lifetime.fish = Math.max(1, mine.lifetime.fish); saveFish(wdb, 44, mine, 1); });
        const noHook = await page(['steal', '@partner']);
        check('a page steal refused (no hook) stays on the page', noHook.chat.length === 0 && /hook/i.test(noHook.replies[0] ?? ''), noHook);
        runWrite(wdb, () => { const mine = loadFish(wdb, 44)!; mine.hook = 3; saveFish(wdb, 44, mine, 1); });
        const tryIt = await page(['steal', '@partner']);
        check('a page steal that goes ahead is told in chat with both names', tryIt.chat.some(l => l.startsWith('@webber') && l.includes('@partner'))
          && /made off with|red-handed|guard/.test(tryIt.replies[0] ?? ''), tryIt);
        // Feeding from the page, several foods at once.
        runWrite(wdb, () => {
          const mine = loadFish(wdb, 44)!;
          for (const [name, cm] of [['🐟', 40], ['🦐', 20]] as const) { addItem(mine, ITEMS.find(x => x.name === name)!); (((mine.catch.sizes ??= {})[name]) ??= []).push({ cm, record: false }); }
          saveFish(wdb, 44, mine, 1);
        });
        // A trade names the very fish too: the 🏅 one of two otherwise alike.
        runWrite(wdb, () => {
          const mine = loadFish(wdb, 44)!;
          for (const record of [true, false]) { addItem(mine, ITEMS.find(x => x.name === '🐳')!); (((mine.catch.sizes ??= {})['🐳']) ??= []).push({ cm: 100, record }); }
          saveFish(wdb, 44, mine, 1);
        });
        shiftW += 31 * 60_000;
        const exact = await page(['trade', '🐳', '100cm', '🏅', '@partner', '200']);
        const mirrored = mirroredTrades(wdb).find(o => o.fromId === 44);
        check('a trade offer can name the 🏅 one', exact.replies.some(l => l.includes('🐳 100 cm 🏅')) && mirrored?.give.items[0]?.record === true, { exact, mirrored });
        const tookExact = await partnerMove(['accept']);
        check('accepting moves that very fish and keeps the plain one', tookExact.replies.some(l => l.includes('Trade done'))
          && (fw().catch.sizes?.['🐳'] ?? []).map(h => h.record).join() === 'false' && (loadFish(wdb, 45)!.catch.types['🐳'] ?? 0) === 1, { tookExact, left: fw().catch.sizes?.['🐳'] });
        // An offered fish gone by the time it's accepted calls the trade off; a twin doesn't stand in.
        runWrite(wdb, () => {
          const mine = loadFish(wdb, 44)!;
          for (const record of [false, true]) { addItem(mine, ITEMS.find(x => x.name === '🦈')!); (((mine.catch.sizes ??= {})['🦈']) ??= []).push({ cm: 90, record }); }
          saveFish(wdb, 44, mine, 1);
        });
        shiftW += 31 * 60_000;
        await page(['trade', '🦈', '90cm', 'Lv0', '@partner', '200']);
        await page(['sell', '🦈', '90cm', 'Lv0']);
        const gone = await partnerMove(['accept']);
        check('a trade whose plain fish was sold is off; the 🏅 twin stays', gone.replies.some(l => l.includes('no longer has everything'))
          && (fw().catch.sizes?.['🦈'] ?? []).map(h => h.record).join() === 'true', { gone, left: fw().catch.sizes?.['🦈'] });
        // Feeding by the very fish: the Lv0 of two same-length 🐙 eats the Lv1 one.
        runWrite(wdb, () => {
          const mine = loadFish(wdb, 44)!;
          for (const level of [1, 0]) { addItem(mine, ITEMS.find(x => x.name === '🐙')!); (((mine.catch.sizes ??= {})['🐙']) ??= []).push({ cm: 70, record: false, ...(level ? { level } : {}) }); }
          saveFish(wdb, 44, mine, 1);
        });
        const exactFeed = await page(['feed', '🐙', '70cm', 'Lv0', '🐙', '70cm', 'Lv1']);
        const octo = fw().catch.sizes?.['🐙'] ?? [];
        check('feeding names the very eater and food by level', /ate 🐙 70 cm Lv1/.test(exactFeed.replies[0] ?? '') && octo.length === 1 && (octo[0].level ?? 0) >= 1, { exactFeed, octo });
        const had = { fish: fw().catch.types['🐟'] ?? 0, shrimp: fw().catch.types['🦐'] ?? 0 };
        const fed = await page(['feed', '🐡', '100cm', '🐟', '1', '🦐', '1']);
        check('the page feeds several foods to one fish', fed.chat.length === 0 && /ate/.test(fed.replies[0] ?? '') && (fw().catch.types['🐟'] ?? 0) === had.fish - 1 && (fw().catch.types['🦐'] ?? 0) === had.shrimp - 1
          && ((fw().catch.sizes?.['🐡'] ?? [])[0]?.xp ?? 0) + ((fw().catch.sizes?.['🐡'] ?? [])[0]?.level ?? 0) > 0, fed);
      } finally {
        Date.now = realNowW;
      }
    }

    // Play records the signals the cheater flags read.
    {
      const kinds = (pdb.prepare('SELECT kind, COUNT(*) AS n FROM fish_signals WHERE user_id = 31 GROUP BY kind').all() as Array<{ kind: string; n: number }>)
        .reduce<Record<string, number>>((o, r) => ({ ...o, [r.kind]: r.n }), {});
      check('trap checks and hauls are recorded as signals', (kinds.check_asked ?? 0) >= 5 && (kinds.check_passed ?? 0) >= 2 && (kinds.check_wrong ?? 0) >= 3
        && (kinds.check_failed ?? 0) >= 3 && (kinds.trap_collect ?? 0) >= 2, kinds);
    }

    // Reels have no effect on stealing: a stolen fish sells at its plain price, whoever holds it.
  {
    const g0 = effectivePointsConfig({ games: { enabled: true } }).games;
    const shark = ITEMS.find(i => i.name === '🦈')!;
    const shell = ITEMS.find(i => i.name === '🐚')!;   // unsized
    const plain = (held?: { cm: number; record: boolean }) => sellPrice(shark, g0, held);
    const victim = initialData();
    const thief = initialData();
    addItem(victim, shark);
    victim.catch.sizes = { '🦈': [{ cm: 50, record: false }] };
    addItem(thief, shark);
    thief.catch.sizes = { '🦈': [{ cm: 50, record: false }] };
    moveFish(victim, thief, shark, { index: 0, held: victim.catch.sizes['🦈'][0] }, true);
    const sold = takeItems(thief, shark, 2, g0, false, 3);
    check('a stolen fish sells at its plain price; the thief\'s own catch keeps the reel bonus',
      sold === plain({ cm: 50, record: false }) * 3 + plain({ cm: 50, record: false }), { sold, plain: plain({ cm: 50, record: false }) });
    // Unsized: two own shells and one stolen; the stolen one is plain-priced, and the mark follows it on.
    const v2 = initialData();
    const t2 = initialData();
    addItem(v2, shell);
    addItem(t2, shell);
    addItem(t2, shell);
    moveFish(v2, t2, shell, { index: -1 }, true);
    check('a stolen unsized fish is counted as stolen', t2.catch.stolen?.['🐚'] === 1 && !v2.catch.stolen);
    const third = initialData();
    const t3 = JSON.parse(JSON.stringify(t2)) as FishData;
    t3.catch.types['🐚'] = 1;
    t3.catch.fish = 1;
    moveFish(t3, third, shell, { index: -1 });   // its only shell is the stolen one: it stays stolen
    check('a stolen fish stays marked when it moves on', third.catch.stolen?.['🐚'] === 1 && !t3.catch.stolen);
    const unit = sellPrice(shell, g0);
    const shells = takeItems(t2, shell, 3, g0, false, 2);
    check('unsized: own ones with the reel, the stolen one plain', shells === unit * 2 * 2 + unit && !t2.catch.stolen, { shells, unit });
    const dv = initialData();
    const dw = initialData();
    addItem(dv, shark);
    dv.catch.sizes = { '🦈': [{ cm: 40, record: false }] };
    moveFish(dv, dw, shark, { index: 0, held: dv.catch.sizes['🦈'][0] });
    check('a fish won in a keeps duel isn\'t stolen', !dw.catch.sizes?.['🦈']?.[0]?.stolen);
  }

  // Possible cheaters: each pattern on its own made-up player, and a normal one who isn't flagged.
    {
      const sdb = openPointsDb('cheatch', { create: true })!;
      const T0 = 1_800_000_000_000;
      const sig = (userId: number, kind: Parameters<typeof recordSignal>[1]['kind'], at: number, delayMs: number | null = null, live = false) =>
        recordSignal(sdb, { userId, kind, now: at, delayMs, live });
      runWrite(sdb, () => {
        for (const [id, name] of [[1, 'agent'], [2, 'pinger'], [3, 'insomniac'], [4, 'metronome'], [5, 'human'], [6, 'streamwatcher']] as const) ensureUserTx(sdb, id, name, T0);
        for (let i = 0; i < 4; i++) sig(1, 'check_passed', T0 + i * 3600_000, 2_500 + i * 300);
        for (let i = 0; i < 10; i++) sig(2, 'trap_collect', T0 + i * 3_660_000, 8_000 + i * 500);
        for (let h = 0; h <= 25; h++) sig(3, 'cast', T0 + h * 3600_000 + 7 * 60_000);
        for (let i = 0; i < 12; i++) sig(4, 'cast', T0 + i * 61_000);
        // A person: slower answers with a slip, traps collected minutes late, uneven casting, asleep at night.
        for (const [at, ms] of [[0, 24_000], [2, 41_000], [5, 18_000]]) sig(5, 'check_passed', T0 + at * 3600_000, ms);
        sig(5, 'check_wrong', T0 + 3600_000, 9_000);
        for (let i = 0; i < 10; i++) sig(5, 'trap_collect', T0 + i * 4_000_000, 240_000 + i * 37_000);
        for (const g of [0, 45, 130, 170, 260, 300, 420, 470, 590, 640, 700, 830]) sig(5, 'cast', T0 + g * 1000);
        // Live play doesn't count: the stream is watching.
        for (let i = 0; i < 6; i++) sig(6, 'check_passed', T0 + i * 60_000, 2_000, true);
      });
      // Gives: the two ledger rows share a ref, as transfer() writes them.
      const give = (from: number, to: number, amount: number, left: number, at: number) => {
        const ref = `give:test-${from}-${at}`;
        sdb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(at, from, -amount, left, 'give_out', ref, 'chat:x', null);
        sdb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref, actor, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(at, to, amount, amount, 'give_in', ref, 'chat:x', null);
      };
      runWrite(sdb, () => {
        for (const [id, name] of [[7, 'parker'], [8, 'parkers_alt'], [9, 'generous'], [10, 'retiree']] as const) ensureUserTx(sdb, id, name, T0);
        give(7, 8, 95_000, 5_000, T0 + 3600_000);
        for (let i = 0; i < 3; i++) sig(7, 'cast', T0 + 2 * 3600_000 + i * 90_000);
        give(9, 8, 30_000, 70_000, T0 + 3600_000);
        for (let i = 0; i < 3; i++) sig(9, 'cast', T0 + 2 * 3600_000 + i * 90_000);
        sig(10, 'cast', T0);
        give(10, 8, 99_000, 1_000, T0 + 3600_000);
      });
      const list = suspects(sdb, T0 + 30 * 3600_000, 7);
      const flagsOf = (name: string) => list.find(x => x.username === name)?.flags.map(f => f.code) ?? [];
      check('an agent\'s fast, flawless answers are flagged', flagsOf('agent').includes('fast_answers'), list);
      check('collecting traps the moment they fill is flagged', flagsOf('pinger').includes('instant_traps'));
      check('playing round the clock is flagged', flagsOf('insomniac').includes('no_sleep'));
      check('casting like a metronome is flagged', flagsOf('metronome').includes('clockwork_casts'));
      const parked = list.find(x => x.username === 'parker')?.flags.find(f => f.code === 'parked_don');
      check('giving most of your $DON away and fishing on is flagged, naming who got it', !!parked && parked.evidence.includes('95%') && parked.evidence.includes('parkers_alt') && parked.evidence.includes('3 casts'), parked);
      check('a modest give, or parking then stopping, isn\'t', !flagsOf('generous').includes('parked_don') && !flagsOf('retiree').includes('parked_don'));
      check('a normal player and live play aren\'t', !list.some(x => x.username === 'human' || x.username === 'streamwatcher'), list.map(x => [x.username, x.flags.map(f => f.code)]));
    }

    // Alts: an account in step with another, a games-only farm, money funnelled to one account.
    {
      const adb = openPointsDb('altch', { create: true })!;
      const T0 = 1_800_000_000_000;
      const H = 3600_000;
      const users: Array<[number, string]> = [[20, 'mainacct'], [21, 'altacct'], [31, 'lender'], [32, 'borrower'], [33, 'feeder'], [34, 'sink'], [35, 'fishfeeder'], [36, 'santa'], [37, 'elf1'], [38, 'elf2'], [39, 'elf3'], [40, 'highroller'], [41, 'pal'], [42, 'loser'], [43, 'friend']];
      for (let i = 0; i < 12; i++) users.push([50 + i, `crowd${i}`]);
      const act = (id: number, at: number, reason = 'game:gamble') =>
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)').run(at, id, -10, 0, reason);
      const give = (from: number, to: number, amount: number, left: number, at: number) => {
        const ref = `give:alt-${from}-${to}-${at}`;
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref) VALUES (?, ?, ?, ?, ?, ?)').run(at, from, -amount, left, 'give_out', ref);
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason, ref) VALUES (?, ?, ?, ?, ?, ?)').run(at, to, amount, amount, 'give_in', ref);
      };
      runWrite(adb, () => {
        for (const [id, name] of users) ensureUserTx(adb, id, name, T0);
        // Everyone but the alt pair is an old regular with hours watched.
        adb.prepare('UPDATE users SET first_seen_at = ?, watch_seconds = ? WHERE user_id NOT IN (21, 35)').run(T0 - 60 * 24 * H, 100 * H / 1000);
        // The main plays five evenings; three minutes later each time, the alt does.
        for (let d = 0; d < 5; d++) {
          act(20, T0 + d * 20 * H);
          act(20, T0 + d * 20 * H + 5 * 60_000);
          act(21, T0 + d * 20 * H + 3 * 60_000, 'game:fish_sell');
        }
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)').run(T0 + 4 * 60_000, 21, 5_000, 5_000, 'game:fish_sell');
        // The crowd plays at its own times.
        for (let i = 0; i < 12; i++) for (let k = 0; k < 4; k++) act(50 + i, T0 + 7 * H + i * 37 * 60_000 + k * 21 * H);
        // A loan paid back the same morning, then fishing on: not parked.
        give(31, 32, 10_000, 500, T0 + H);
        give(32, 31, 10_000, 600, T0 + H + 8 * 60_000);
        for (let i = 0; i < 3; i++) recordSignal(adb, { userId: 32, kind: 'cast', now: T0 + 2 * H + i * 90_000, live: false });
        // Winnings sent on to one account, in $DON and in fish.
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)').run(T0 + H, 33, 3_000, 3_000, 'game:fish_sell');
        give(33, 34, 2_500, 500, T0 + 2 * H);
        recordSignal(adb, { userId: 35, kind: 'fish_give', now: T0 + 3 * H, detail: JSON.stringify({ to: 34, item: '🦈', n: 2, worth: 1_500 }) });
        // Handing it round to three people is generosity.
        adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)').run(T0 + H, 36, 1_000, 1_000, 'game:fish_sell');
        for (const to of [37, 38, 39]) give(36, to, 2_000, 1_000, T0 + 4 * H);
        // Gambling counts on balance: bet 5 million, paid out 5,056,000, so 56,000 won, and 30,000 of it sent on is a funnel.
        const bet = (id: number, reason: string, delta: number) =>
          adb.prepare('INSERT INTO ledger (ts, user_id, delta, balance_after, reason) VALUES (?, ?, ?, ?, ?)').run(T0 + 5 * H, id, delta, 0, reason);
        bet(40, 'game:gamble', -5_000_000);
        bet(40, 'game:gamble_win', 5_056_000);
        give(40, 41, 30_000, 26_000, T0 + 6 * H);
        // One who lost on balance won nothing, however big the payouts: a give isn't their winnings.
        bet(42, 'game:gamble', -100_000);
        bet(42, 'game:gamble_win', 60_000);
        give(42, 43, 5_000, 1_000, T0 + 6 * H);
      });
      const now = T0 + 100 * H;
      const list = suspects(adb, now, 7);
      const flagsOf = (name: string) => list.find(x => x.username === name)?.flags ?? [];
      const linked = flagsOf('altacct').find(f => f.code === 'linked_account');
      check('an account whose sessions start with another\'s is linked to it, with the odds', !!linked && linked.evidence.includes('5 of their 5') && linked.evidence.includes('mainacct') && linked.evidence.includes('by chance'), list.map(x => [x.username, x.flags.map(f => f.evidence)]));
      check('a new account that only plays games, never watching, is flagged', flagsOf('altacct').some(f => f.code === 'games_only' && f.evidence.includes('5,000 won')), flagsOf('altacct'));
      check('the regulars it plays alongside aren\'t linked', !list.some(x => x.username.startsWith('crowd') || x.username === 'mainacct'), list.map(x => x.username));
      check('paying back a loan isn\'t parking $DON, and neither side of it is a funnel', !flagsOf('borrower').some(f => f.code === 'parked_don' || f.code === 'funnel') && !flagsOf('lender').some(f => f.code === 'funnel'), [flagsOf('borrower'), flagsOf('lender')]);
      const fed = flagsOf('feeder').find(f => f.code === 'funnel');
      check('sending your winnings to one account is a funnel', !!fed && fed.evidence.includes('sink') && fed.evidence.includes('2,500 $DON in gives') && fed.evidence.includes('3,000 won'), fed);
      check('so are fish gifts, at their price', flagsOf('fishfeeder').some(f => f.code === 'funnel' && f.evidence.includes('2 fish and junk worth 1,500')), flagsOf('fishfeeder'));
      check('giving to several people isn\'t', !flagsOf('santa').some(f => f.code === 'funnel'), flagsOf('santa'));
      const roll = flagsOf('highroller').find(f => f.code === 'funnel');
      check('gambling winnings count on balance, not payouts: sending them on is a funnel', !!roll && roll.evidence.includes('pal') && roll.evidence.includes('56,000 won') && roll.evidence.includes('56,000 of it up on gambling'), flagsOf('highroller'));
      check('a gambler down on balance won nothing to funnel', !flagsOf('loser').some(f => f.code === 'funnel'), flagsOf('loser'));
      const groups = linkedGroups(adb, [...linkedAccounts(adb, now, 7), ...funnels(adb, now, 7).map(f => ({ userId: f.userId, otherId: f.toId }))]).map(g => g.members.map(m => m.username).sort().join(','));
      check('linked and funnelling accounts are grouped', groups.includes('altacct,mainacct') && groups.includes('feeder,fishfeeder,sink') && groups.includes('highroller,pal'), groups);
    }

    // "Your traps are full" waits until they fill, then shows as a new alert, past the page's cursor.
    {
      const tdb = openPointsDb('trapalertch', { create: true })!;
      const T0 = 1_800_000_000_000;
      const laidTill = (end: number | null) => runWrite(tdb, () => {
        ensureUserTx(tdb, 70, 'trapper70', T0);
        const d = initialData();
        d.trap = end === null ? { active: false, start: 0, end: 0, duration: 0 } : { active: true, start: T0, end, duration: end - T0 };
        saveFish(tdb, 70, d, T0);
      });
      laidTill(T0 + 120_000);
      scheduleTrapAlert(tdb, 70, T0 + 60_000, 'early');
      scheduleTrapAlert(tdb, 70, T0 + 120_000, '🪤 full');
      tdb.prepare("INSERT INTO fish_alerts (ts, user_id, kind, text) VALUES (?, 70, 'gift', 'a gift')").run(T0 + 30_000);
      const cursor = alertsFor(tdb, 70, 0, 30, T0 + 90_000);
      check('a trap alert waits for the traps to fill, and laying them again moves it', cursor.length === 1 && cursor[0].kind === 'gift', cursor);
      const later = alertsFor(tdb, 70, cursor[0].id, 30, T0 + 130_000);
      check('once full it shows, after the page\'s last alert, at the time they filled', later.length === 1 && later[0].kind === 'trap' && later[0].text === '🪤 full' && later[0].ts === T0 + 120_000 && later[0].id > cursor[0].id, later);
      check('and only once', alertsFor(tdb, 70, later[0].id, 30, T0 + 140_000).length === 0);
      laidTill(T0 + 200_000);
      scheduleTrapAlert(tdb, 70, T0 + 200_000, 'again');
      scheduleTrapAlert(tdb, 70, null, '');
      check('collecting or cancelling first drops it', alertsFor(tdb, 70, later[0].id, 30, T0 + 300_000).length === 0);
      // Collected, but a poll lands before the bot drops the row (or it crashed in between): no alert, and the row goes.
      laidTill(T0 + 400_000);
      scheduleTrapAlert(tdb, 70, T0 + 400_000, 'stale');
      laidTill(null);
      check('traps already collected are never announced, whatever row is left', alertsFor(tdb, 70, later[0].id, 30, T0 + 500_000).length === 0
        && !(tdb.prepare("SELECT 1 FROM fish_alerts WHERE user_id = 70 AND kind = 'trap_due'").get()));
    }

    // The timer ends a window nobody answered, in real time.
    {
      const ch2 = 'trapcheckclock';
      writeConfig(root, ch2, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapCheck: { enabled: true, chancePercent: 100, answerSeconds: 10 } } });
      makeService(ch2, { broadcaster: 999, live: async () => ({ isLive: false, startedAt: null }) });
      const cdb2 = openPointsDb(ch2, { create: true })!;
      runWrite(cdb2, () => {
        ensureUserTx(cdb2, 32, 'sleeper', 1);
        creditTx(cdb2, { userId: 32, username: 'sleeper', amount: 200, reason: 'test', now: 1 });
        const d = initialData();
        d.trap = { active: true, start: Date.now() - 61 * 60_000, end: Date.now() - 60_000, duration: 60 * 60_000 };
        saveFish(cdb2, 32, d, 1);
      });
      const said: string[] = [];
      const t2: KickTags = { username: 'sleeper', 'display-name': 'sleeper', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 32 };
      await fishCommand({ say: async (_c, m) => { said.push(m); } }, '$don fish trap', `#${ch2}`, t2, { channelName: ch2 } as ChannelConfig);
      await new Promise(r => setTimeout(r, 11_500));
      check('an unanswered question ends when its time runs out: fined, traps empty', said.length === 2 && said[1].includes("Time's up!") && said[1].includes('30 $DON')
        && balance(ch2, 32) === 170 && !loadFish(cdb2, 32)!.trapCheck && !loadFish(cdb2, 32)!.trap.active, { said, b: balance(ch2, 32) });
    }
    check('trap check settings are validated', validatePointsPatch({}, { games: { trapCheck: { chancePercent: 0, finePercent: 101, enabled: 'yes', answerSeconds: 5, tries: 0 } } }).errors.length === 5);
  }

  // A chatter names how long the traps go out: 31 min up to games.trapMaxMinutes
  {
    check('trap times parse: minutes, hours, both', parseTrapMinutes('90') === 90 && parseTrapMinutes('90m') === 90 && parseTrapMinutes('2h') === 120
      && parseTrapMinutes('1.5h') === 90 && parseTrapMinutes('1h30m') === 90 && parseTrapMinutes('1h30') === 90 && parseTrapMinutes('cancel') === null && parseTrapMinutes('2d') === null,
      ['90m', '2h', '1.5h', '1h30m', '1h30'].map(parseTrapMinutes));
    check('the longest trap is never below the trap time', effectivePointsConfig({ games: { trapMinutes: 120, trapMaxMinutes: 60 } }).games.trapMaxMinutes === 120
      && effectivePointsConfig({ games: { trapMinutes: 90 } }).games.trapMaxMinutes === 90 && effectivePointsConfig({ games: { trapMaxMinutes: 300 } }).games.trapMaxMinutes === 300);
    const ch = 'traptime';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, trapMaxMinutes: 240 } });
    makeService(ch, { broadcaster: 999 });
    const tdb = openPointsDb(ch, { create: true })!;
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const run = async (msg: string) => {
        shift += 6_000;
        const out: string[] = [];
        const t: KickTags = { username: 'setter', 'display-name': 'setter', badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: 51 };
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, t, { channelName: ch } as ChannelConfig);
        return out[0] ?? '';
      };
      const mins = () => (loadFish(tdb, 51)?.trap.duration ?? 0) / 60_000;
      const tooLong = await run('$don fish trap 5h');
      check('a time past the longest trap is refused with the range', tooLong.includes('31m up to 4h') && !loadFish(tdb, 51)?.trap.active, tooLong);
      check('so is one under 31 minutes', (await run('$don fish t 20m')).includes('31m up to 4h') && !loadFish(tdb, 51)?.trap.active);
      const laid = await run('$don fish trap 3h');
      check('trap 3h lays them for 3 hours', laid.includes('You have laid') && laid.includes('about 3h') && mins() === 180, laid);
      const due = () => tdb.prepare("SELECT ts, text FROM fish_alerts WHERE user_id = 51 AND kind = 'trap_due'").all() as Array<{ ts: number; text: string }>;
      check('laying traps books the "traps are full" alert for when they fill', due().length === 1 && due()[0].ts === loadFish(tdb, 51)!.trap.end && due()[0].text.includes('$don fish trap'), due());
      check('it doesn\'t show before then', !alertsFor(tdb, 51).some(a => a.kind === 'trap'));
      shift += 181 * 60_000;
      const full = alertsFor(tdb, 51).filter(a => a.kind === 'trap');
      const reset = await run('$don fish trap reset');
      check('a reset without a time lays them again for as long as before', reset.includes('drag the traps') && reset.includes('about 3h') && mins() === 180, reset);
      check('once full the alert shows on the page, and the traps laid again book the next one', full.length === 1 && alertsFor(tdb, 51).filter(a => a.kind === 'trap').length === 1 && due().length === 1 && due()[0].ts === loadFish(tdb, 51)!.trap.end, [full, due()]);
      shift += 181 * 60_000;
      check('a reset with a time uses it', (await run('$don fish t r 45m')).includes('about 45m') && mins() === 45);
      shift += 46 * 60_000;
      check('collecting with a time just collects', (await run('$don fish trap 2h')).includes('drag the traps') && !loadFish(tdb, 51)?.trap.active);
      check('lift with no traps out says so', (await run('$don fish trap lift')).includes("don't have any traps out"));
      await run('$don fish trap 2h');
      shift += 30 * 60_000;
      check('traps not full point to lift and cancel', (await run('$don fish trap')).includes('fish trap lift'));
      shift += 30 * 60_000;
      const spent = loadFish(tdb, 51)!.lifetime.trap.timeSpent;
      const lifted = await run('$don fish t l');
      check('lift pulls them up early with a haul for the time they were out', lifted.includes('You lift your traps early, 1h') && lifted.includes('drag the traps')
        && !loadFish(tdb, 51)!.trap.active && Math.abs(loadFish(tdb, 51)!.lifetime.trap.timeSpent - spent - 60 * 60_000) < 60_000, lifted);
      const sig = tdb.prepare("SELECT delay_ms, detail FROM fish_signals WHERE user_id = 51 AND kind = 'trap_collect' ORDER BY ts DESC LIMIT 1").get() as { delay_ms: number | null; detail: string | null };
      check('a lift never counts as an instant haul', sig.delay_ms === null && sig.detail === 'lift', sig);
      await run('$don fish trap 2h');
      shift += 121 * 60_000;
      const fullLift = await run('$don fish trap lift');
      check('lift on full traps is a plain collect', fullLift.includes('drag the traps') && !fullLift.includes('early') && !loadFish(tdb, 51)!.trap.active, fullLift);
      const plain = await run('$don fish trap');
      check('a plain trap lays the trap time', plain.includes('about 1h') && mins() === 60, plain);
      const rows = publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true, trapMaxMinutes: 240 } })).sections.find(sec => sec.title === 'Fishing')?.rows ?? [];
      check('the Commands tab tells chatters they can name a time', rows.some(r => r.usage.endsWith('trap [time]') && r.does.includes('31 min to 4h') && (r.short ?? '').endsWith('t 2h')), rows.filter(r => r.usage.includes('trap')));
      const hourRows = publicCommands(effectivePointsConfig({ enabled: true, games: { enabled: true } })).sections.find(sec => sec.title === 'Fishing')?.rows ?? [];
      check('its example time fits the channel\'s range', hourRows.some(r => r.usage.endsWith('trap [time]') && (r.short ?? '').endsWith('t 45m') && r.does.includes('31 min to 1h, like 45m')), hourRows.filter(r => r.usage.includes('trap')));
    } finally {
      Date.now = realNow;
    }
  }

  // Fishing traps set a reminder for when they're full
  {
    const ch = 'fishch';
    writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60 } });
    makeService(ch, { broadcaster: 999 });
    openPointsDb(ch, { create: true });
    const realNow = Date.now;
    let shift = 0;
    Date.now = () => realNow() + shift;
    try {
      const tags = (username: string, id: number): KickTags => ({
        username, 'display-name': username, badges: {}, isBroadcaster: false, isModUp: false, isVIPUp: false, rawBadges: [], senderId: id
      });
      const run = async (msg: string, config: ChannelConfig, who: [string, number] = ['angler', 11]) => {
        shift += 6_000;   // past the per-user cooldown
        const out: string[] = [];
        await fishCommand({ say: async (_c, m) => { out.push(m); } }, msg, `#${ch}`, tags(who[0], who[1]), config);
        return out;
      };
      const on = { channelName: ch } as ChannelConfig;
      const cdb = openCommunityDb(`#${ch}`)!;
      const pending = () => cdb.prepare("SELECT text, due_at FROM reminders WHERE to_lc = 'angler' AND done_at IS NULL").all() as Array<{ text: string; due_at: number }>;

      const laid = await run('$don fish trap', on);
      const p1 = pending();
      check('laying traps sets a reminder for when they fill', laid[0]?.includes("I'll ping you") && p1.length === 1
        && p1[0].text.startsWith('your fishing traps are ready') && Math.abs(p1[0].due_at - (Date.now() + 60 * 60_000)) < 10_000, { laid, p1 });
      await run('$don fish trap cancel', on);
      check('cancelling traps clears the reminder', pending().length === 0, pending());
      await run('$don fish trap', on);
      shift += 61 * 60_000;
      const collected = await run('$don fish trap', on);
      check('collecting traps clears the reminder', collected[0]?.includes('drag the traps') && pending().length === 0, { collected, p: pending() });
      const pdb0 = openPointsDb(ch, { create: false })!;
      const recorded = (pdb0.prepare("SELECT COUNT(*) AS n FROM catches WHERE user_id = 11 AND source = 'trap'").get() as { n: number }).n;
      check('every trapped fish is recorded', recorded === loadFish(pdb0, 11)!.lifetime.fish, { recorded, lifetime: loadFish(pdb0, 11)!.lifetime.fish });
      const feed = readOverlay(pdb0);
      check('a trap haul reaches the overlay feed as a haul', feed.events.some(e => e.kind === 'trap' && e.username === 'angler' && e.text.includes('drag the traps'))
        && feed.lastId === feed.events[feed.events.length - 1].id, feed.events.map(e => [e.kind, e.text.slice(0, 30)]));
      const off = { channelName: ch, excludedCommands: ['remind'] } as unknown as ChannelConfig;
      const quiet = await run('$don fish trap', off);
      check('no reminder where !remind is off', !quiet[0]?.includes("I'll ping") && pending().length === 0, { quiet, p: pending() });

      // Selling several kinds in one message
      const list = (words: string) => {
        const r = parseSellList(words.split(' '));
        return 'error' in r ? r.error : r.items.map(i => `${i.item.name}${i.n}`).join(',');
      };
      check('sell list: spaced, run together, counts, repeats', list('🐟 3 🦐') === '🐟3,🦐1' && list('🐟🦐🦀') === '🐟1,🦐1,🦀1'
        && list('🐟 x2 🐟') === '🐟3' && list('🐟\uFE0F 2') === '🐟2', [list('🐟 3 🦐'), list('🐟🦐🦀'), list('🐟 x2 🐟'), list('🐟\uFE0F 2')]);
      check('sell list: bad input', list('🐟🦐 3') === 'amount' && list('3') === 'amount' && list('🐟 0') === 'amount' && list('🍕') === 'unknown' && list('🐟 2 3') === 'amount');
      const pdb = openPointsDb(ch, { create: false })!;
      runWrite(pdb, () => {
        ensureUserTx(pdb, 12, 'seller', 1);
        const d = initialData();
        for (const name of ['🐟', '🐟', '🐟', '🦐', '🦀', '🦀', '🥫']) addItem(d, ITEMS.find(i => i.name === name)!);
        saveFish(pdb, 12, d, 1);
      });
      const sold = await run('$don fish sell 🐟 2 🦐🦀 🐙', on, ['seller', 12]);
      check('selling several kinds at once', sold[0] === '@seller Sold your 🐟 x2, 🦐, 🦀 for 100 $DON - now you have 100 $DON (you have no 🐙)' && balance(ch, 12) === 100, sold);
      const left = await run('$don fish sell 🐟 🦀 5', on, ['seller', 12]);
      check('counts cap at what is held', left[0]?.startsWith('@seller Sold your 🐟, 🦀 for 50 $DON'), left);
      const none = await run('$don fish sell 🐟 🦐', on, ['seller', 12]);
      check('nothing held of any is refused', none[0] === '@seller You have no 🐟🦐 to sell!', none);
      // A certain fish by its length: three 🦈, two of them 40 cm.
      runWrite(pdb, () => {
        const d = loadFish(pdb, 12)!;
        for (let i = 0; i < 3; i++) addItem(d, ITEMS.find(i2 => i2.name === '🦈')!);
        d.catch.sizes = { ...(d.catch.sizes ?? {}), '🦈': [{ cm: 40, record: false }, { cm: 90, record: false }, { cm: 40, record: false }] };
        saveFish(pdb, 12, d, 1);
      });
      const before = balance(ch, 12);
      const byLen = await run('$don fish sell 🦈 90cm', on, ['seller', 12]);
      const after90 = loadFish(pdb, 12)!.catch;
      check('selling by length sells that very fish at its price', byLen[0]?.startsWith('@seller Sold your 🦈 90 cm for ') && after90.types['🦈'] === 2
        && JSON.stringify(after90.sizes!['🦈']) === JSON.stringify([{ cm: 40, record: false }, { cm: 40, record: false }]) && balance(ch, 12) > before, { byLen, after90 });
      const twoLen = await run('$don fish sell 🦈40cm 3', on, ['seller', 12]);
      const noLen = await run('$don fish sell 🦈 41 cm', on, ['seller', 12]);
      const junkLen = await run('$don fish sell 🥫 5cm', on, ['seller', 12]);
      check('no more than are that long, a length you don\'t have, and only fish', twoLen[0]?.includes('Nothing sold: you have only 2 🦈 40 cm') && noLen[0]?.includes('no 🦈 41 cm')
        && junkLen[0]?.includes('Only fish have a length') && loadFish(pdb, 12)!.catch.types['🦈'] === 2, { twoLen, noLen, junkLen });
      // Several at once: lengths of one kind, another kind by length, and a kind with none.
      runWrite(pdb, () => {
        const d = loadFish(pdb, 12)!;
        for (const [n, cm] of [['🦕', 42], ['🦕', 44], ['🦕', 65], ['🐢', 30]] as const) {
          addItem(d, ITEMS.find(i2 => i2.name === n)!);
          (d.catch.sizes![n] ??= []).push({ cm, record: false });
        }
        addItem(d, ITEMS.find(i2 => i2.name === '🦐')!);
        saveFish(pdb, 12, d, 1);
      });
      const partial = await run('$don fish sell 🦕 42cm 43cm', on, ['seller', 12]);
      check('one length not held and nothing sells', partial[0]?.includes('Nothing sold: you have no 🦕 43 cm') && loadFish(pdb, 12)!.catch.types['🦕'] === 3, partial);
      const multi = await run('$don fish sell 🦕 42cm 44 cm 🐢30cm 🦈 40cm 🦐', on, ['seller', 12]);
      const left2 = loadFish(pdb, 12)!.catch;
      check('several fish by length in one sale, and kinds with none oldest first', multi[0]?.startsWith('@seller Sold your 🦕 42 cm, 🦕 44 cm, 🐢 30 cm, 🦈 40 cm, 🦐 for ')
        && JSON.stringify(left2.sizes!['🦕']) === JSON.stringify([{ cm: 65, record: false }]) && left2.types['🦕'] === 1 && (left2.types['🐢'] ?? 0) === 0
        && left2.types['🦈'] === 1 && (left2.types['🦐'] ?? 0) === 0, { multi, left2 });

      // Fish and junk together
      runWrite(pdb, () => {
        ensureUserTx(pdb, 13, 'bulk', 1);
        const d = initialData();
        for (const name of ['🐟', '🐟', '🦐', '🥫', '🥫', '🧦']) addItem(d, ITEMS.find(i => i.name === name)!);
        d.lifetime.attempts = 1;
        saveFish(pdb, 13, d, 1);
      });
      const bulk = (msg: string) => run(msg, on, ['bulk', 13]);
      const shown = await bulk('$don fish show');
      check('show lists fish and junk', shown[0] === '@bulk You have 3 fish (🐟🐟🦐) and 3 pieces of junk (🥫🥫🧦) in your collection. You also have 0 $DON in your purse.', shown);
      const shownJunk = await bulk('$don fish show junk');
      check('show junk is junk only', shownJunk[0] === '@bulk You have 3 pieces of junk in your collection. Here they are: 🥫🥫🧦 You also have 0 $DON in your purse.', shownJunk);
      const same = async (short: string, full: string) => { const a = await bulk(short); const b = await bulk(full); return a.length === 1 && a[0] === b[0]; };
      check('fish short forms reach past the subcommand: show, stats, top, buy',
        (await bulk('$don f sh j'))[0] === shownJunk[0] && await same('$don f st g', '$don fish stats global') && await same('$don f tp tf', '$don fish top total-fish')
        && await same('$don f tp ca', '$don fish top caught') && await same('$don f b h', '$don fish buy hook') && await same('$don f b r', '$don fish buy reel'));
      const other = await run('$don fish show @bulk', on, ['seller', 12]);
      check('show another viewer lists both', other[0]?.startsWith('@seller They have 3 fish (🐟🐟🦐) and 3 pieces of junk'), other);
      const mixed = await bulk('$don fish sell 🦐 🥫');
      check('fish and junk emojis in one sale', mixed[0] === '@bulk Sold your 🦐, 🥫 for 33 $DON - now you have 33 $DON', mixed);
      const noType = await bulk('$don fish sell all');
      check('sell all still needs a type', noType[0]?.includes('you must provide a type') && noType[0].includes('fish junk') && balance(ch, 13) === 33, noType);
      const dup = await bulk('$don fish sell duplicate fish junk');
      check('duplicate across both types', dup[0] === '@bulk You sold 1 duplicate fish for a grand total of 25 $DON - now you have 58 $DON', dup);
      const both = await bulk('$don f s a f j');
      check('sell all fish junk sells both, typed short as $don f s a f j', both[0] === '@bulk You sold 1 fish and 2 pieces of junk for a grand total of 38 $DON - now you have 96 $DON', both);
      const sellNotes = (pdb.prepare("SELECT note FROM ledger WHERE user_id = 13 AND reason = 'game:fish_sell' ORDER BY id").all() as Array<{ note: string | null }>).map(r => r.note);
      check('each sale notes what was sold, junk named as junk', sellNotes.join(' | ') === '🦐, 🥫 | 1 duplicate fish | 1 fish and 2 pieces of junk', sellNotes);
      // Reels
      const defaults = effectivePointsConfig({}).games.reels;
      check('four default reels, cheapest first', defaults.map(r => `${r.name}:${r.price}`).join(',') === 'Bamboo:5000,Fiberglass:25000,Carbon:100000,Golden:500000', defaults);
      const customReels = [{ name: 'Twig', price: 10, oddsMultiplier: 2, rarityMultiplier: 1, valueMultiplier: 1.5 }];
      const setReels = validatePointsPatch({}, { games: { reels: customReels } });
      check('custom reels stored', setReels.errors.length === 0 && JSON.stringify(setReels.next?.games?.reels) === JSON.stringify(customReels), setReels);
      check('default reels are not stored', validatePointsPatch({}, { games: { reels: defaults } }).next?.games?.reels === undefined);
      const badReels = validatePointsPatch({}, { games: { reels: [{ name: '', price: -1, oddsMultiplier: 20, rarityMultiplier: 1, valueMultiplier: 1 }, { name: 'A', price: 1, oddsMultiplier: 1, rarityMultiplier: 1, valueMultiplier: 1 }, { name: 'a', price: 1, oddsMultiplier: 1, rarityMultiplier: 1, valueMultiplier: 1 }] } });
      check('bad reels refused', !badReels.next && badReels.errors.length === 4, badReels.errors);
      check('no reels at all is allowed', validatePointsPatch({}, { games: { reels: [] } }).next?.games?.reels?.length === 0);
      let lands = 0;
      for (let i = 0; i < 40_000; i++) if (landsFish(20, { name: 'x', price: 0, oddsMultiplier: 2, rarityMultiplier: 1, valueMultiplier: 1 })) lands++;
      check('odds multiplier doubles the catch rate', Math.abs(lands / 40_000 - 0.1) < 0.008, lands / 40_000);
      const gd2 = effectivePointsConfig({}).games;
      let commons = 0;
      const commonSet = new Set(['🐟', '🦐', '🦀', '🐸', '🐚']);
      for (let i = 0; i < 40_000; i++) if (commonSet.has(weightedCatch('fish', gd2, 2).name)) commons++;
      check('rarity ×2 doubles every non-common fish', Math.abs(commons / 40_000 - 50 / 96.4) < 0.015, commons / 40_000);
      check('value multiplier is fish only', sellPrice(ITEMS.find(i => i.name === '🐟')!, gd2, undefined, 2) === 50 && sellPrice(ITEMS.find(i => i.name === '🥫')!, gd2, undefined, 2) === 8);

      runWrite(pdb, () => creditTx(pdb, { userId: 14, username: 'buyer', amount: 6000, reason: 'mod_add', now: 1 }));
      const buyer = (msg: string) => run(msg, on, ['buyer', 14]);
      const peek = await buyer('$don fish buy');
      check('buy shows the next reel without buying', peek[0] === '@buyer Next up: the Bamboo reel for 5,000 $DON (fish odds ×1.1). Buy it with $don fish buy reel' && balance(ch, 14) === 6000, peek);
      const bought = await buyer('$don fish buy reel');
      check('buy reel buys it', bought[0] === '@buyer You bought the Bamboo reel for 5,000 $DON! fish odds ×1.1. You have 1,000 $DON left.' && balance(ch, 14) === 1000, bought);
      const poorer = await buyer('$don fish buy reel');
      check('the next reel needs the money', poorer[0] === '@buyer The Fiberglass reel costs 25,000 $DON and you have 1,000 $DON.' && balance(ch, 14) === 1000, poorer);
      const owned = await buyer('$don fish buy');
      check('buy mentions the reel held', owned[0]?.startsWith('@buyer You fish with the Bamboo reel (fish odds ×1.1). Next up: the Fiberglass reel'), owned);

      writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, reels: [{ name: 'Twig', price: 0, oddsMultiplier: 1, rarityMultiplier: 1, valueMultiplier: 2 }] } });
      runWrite(pdb, () => {
        ensureUserTx(pdb, 15, 'valued', 1);
        const d = initialData();
        addItem(d, ITEMS.find(i => i.name === '🐟')!);
        d.lifetime.attempts = 1;
        saveFish(pdb, 15, d, 1);
      });
      const valued = (msg: string) => run(msg, on, ['valued', 15]);
      await valued('$don fish buy reel');
      const worth = await valued('$don fish sell 🐟');
      check('a reel with value ×2 doubles a sale', worth[0] === '@valued Sold your 🐟 for 50 $DON - now you have 50 $DON', worth);
      const best = await valued('$don fish buy');
      check('the last reel is the best', best[0] === "@valued You fish with the Twig reel (fish value ×2). That's the best reel in the shop!", best);
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60, reels: [] } });
      const shut = await valued('$don fish buy');
      check('no reels means an empty shop', shut[0] === "@valued There isn't anything you can buy at the fishing gear shop... yet.", shut);
      writeConfig(root, ch, { enabled: true, currencyName: '$DON', games: { enabled: true, onlyWhileLive: false, trapMinutes: 60 } });

      const board = pointsLeaderboard(ch, effectivePointsConfig({ enabled: true, games: { enabled: true } }), 100);
      const buyerRow = board.points.find(r => r.username === 'buyer');
      const bulkRow = board.points.find(r => r.username === 'bulk');
      check('leaderboard names the reel held', buyerRow?.reel === 'Bamboo' && bulkRow !== undefined && bulkRow.reel === undefined, { buyerRow, bulkRow });

      const balOut: string[] = [];
      const cfgFish = { channelName: ch } as ChannelConfig;
      await pointsCommand({ say: async (_c, m) => { balOut.push(m); } }, '$don', `#${ch}`, tags('buyer', 14), cfgFish);
      shift += 6_000;
      await pointsCommand({ say: async (_c, m) => { balOut.push(m); } }, '$don @buyer', `#${ch}`, tags('bulk', 13), cfgFish);
      shift += 6_000;
      await pointsCommand({ say: async (_c, m) => { balOut.push(m); } }, '$don @bulk', `#${ch}`, tags('buyer', 14), cfgFish);
      check('$don names the reel held', balOut[0]?.startsWith('@buyer has 1000 $DON, rank') && balOut[0].endsWith(', 🎣 Bamboo reel')
        && balOut[1]?.startsWith('buyer has 1000 $DON') && balOut[1].endsWith(', 🎣 Bamboo reel') && !balOut[2]?.includes('reel'), balOut);

      const emptied = await bulk('$don fish sell 🐟');
      check('both types emptied', emptied[0] === '@bulk You have no items to sell!', emptied);
    } finally {
      Date.now = realNow;
    }
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
    check('leaderboard link', (await run('$don leaderboard', tags('mod1', 90, true)))[0] === '$DON leaderboard https://example.test/kick/leaderboard/cmdch');
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
    mdb.exec('DROP TABLE fish_alerts; DROP TABLE web_replies; DROP TABLE big_bites; DROP TABLE fish_trades; DROP TABLE wheel_spins; DROP TABLE video_queue; DROP TABLE fish_signals; DROP TABLE fish_duels; DROP TABLE steals; DROP TABLE overlay_feed; DROP TABLE catches; DROP TABLE fish; DROP TABLE duels; DROP TABLE raffle_entries; DROP TABLE raffles; DROP INDEX ledger_ref');
    mdb.pragma('user_version = 1');
    closePointsDb(mch);
    const reopened = openPointsDb(mch, { create: false })!;
    const hasTable = (n: string) => !!reopened.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(n);
    check('a v1 database migrates to the latest version keeping balances',
      reopened.pragma('user_version', { simple: true }) === 17 && balance(mch, 1) === 77 && hasTable('fish_alerts') && hasTable('web_replies') && hasTable('video_queue') && hasTable('wheel_spins') && hasTable('fish_trades') && hasTable('big_bites')
      && hasTable('duels') && hasTable('raffles') && hasTable('raffle_entries') && hasTable('fish') && hasTable('catches') && hasTable('overlay_feed') && hasTable('steals') && hasTable('fish_duels') && hasTable('fish_signals'));

    // v2 → v3 specifically: a database that already has duels gains the raffle tables.
    const m2 = 'migrate2ch';
    const m2db = openPointsDb(m2, { create: true })!;
    runWrite(m2db, () => creditTx(m2db, { userId: 1, username: 'old2', amount: 42, reason: 'mod_add', now: 1 }));
    m2db.exec('DROP TABLE fish_alerts; DROP TABLE web_replies; DROP TABLE big_bites; DROP TABLE fish_trades; DROP TABLE wheel_spins; DROP TABLE video_queue; DROP TABLE fish_signals; DROP TABLE fish_duels; DROP TABLE steals; DROP TABLE overlay_feed; DROP TABLE catches; DROP TABLE fish; DROP TABLE raffle_entries; DROP TABLE raffles; DROP INDEX ledger_ref');
    m2db.pragma('user_version = 2');
    closePointsDb(m2);
    const re2 = openPointsDb(m2, { create: false })!;
    check('a v2 database gains the raffle tables and keeps its balances',
      re2.pragma('user_version', { simple: true }) === 17 && balance(m2, 1) === 42
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
    const cdbx = openPointsDb(ch, { create: true })!;
    runWrite(cdbx, () => {
      recordCatch(cdbx, 2, '🐋', 'trap', null, 3000);
      recordCatch(cdbx, 1, '🐋', 'cast', 40, 1000);
      recordCatch(cdbx, 1, '🐟', 'cast', 10, 2000);
      ensureUserTx(cdbx, 999, 'streamer', 1);
      recordCatch(cdbx, 999, '🦈', 'cast', 90, 500);
    });
    const caught = caughtFish(ch, cfg, 999);
    const whale = caught.find(c => c.name === '🐋');
    check('caught fish: count, first and latest catcher, excluded left out', caught.length === 2 && whale?.times === 2
      && whale.firstBy === 'alice' && whale.lastBy === 'bob' && whale.firstAt === new Date(1000).toISOString() && !caught.some(c => c.name === '🦈'), caught);
    runWrite(cdbx, () => {
      const guarded = initialData();
      guarded.guardUntil = 10_000;
      saveFish(cdbx, 1, guarded, 1);
    });
    check('a viewer\'s own guard: its end while it runs, null once it has or with none',
      guardUntilFor(ch, 1, 5_000) === 10_000 && guardUntilFor(ch, 1, 10_000) === null && guardUntilFor(ch, 2, 5_000) === null);
    runWrite(cdbx, () => {
      const hold = (id: number, name: string, n: number, sizes?: FishData['catch']['sizes']) => {
        const d = initialData();
        d.catch.types[name] = n;
        d.catch.fish = n;
        if (sizes) d.catch.sizes = sizes;
        saveFish(cdbx, id, d, 4000);
      };
      hold(1, '🐋', 2, { '🐋': [{ cm: 40, record: false }] });
      hold(2, '🐟', 0); // sold everything
      hold(999, '🦈', 1);
    });
    const held = heldCatches(ch, cfg, 999);
    check('held catches: what is unsold, sizes kept, empty-handed and excluded left out', held.length === 1 && held[0].username === 'alice'
      && held[0].types['🐋'] === 2 && held[0].sizes['🐋']?.[0]?.cm === 40, held);
    const lb = pointsLeaderboard(ch, cfg, 100, 999);
    check('leaderboard excludes system bots', !lb.points.some(r => r.username === 'botrix') && lb.points[0]?.username === 'alice', lb.points);
    const bk = await backupPoints(ch);
    check('backup written', !!bk && fs.existsSync(bk));
    check('summary for a channel without a database', pointsSummary('nodb').users === 0 && !fs.existsSync(path.join(root, 'points', 'nodb')));
    check('invariant holds (dashboard)', invariantViolations(openPointsDb(ch, { create: true })!).length === 0);
  }

  // Dashboard reset
  {
    const ch = 'resetch';
    const db = openPointsDb(ch, { create: true })!;
    runWrite(db, () => {
      creditTx(db, { userId: 1, username: 'alice', amount: 100, reason: 'mod_add', now: 1 });
      creditTx(db, { userId: 2, username: 'bob', amount: 40, reason: 'mod_add', now: 1 });
      ensureUserTx(db, 3, 'carol', 1);
    });
    const duel = createDuel(db, { challengerId: 1, opponentId: 2, amount: 30, expiresAt: Date.now() + MIN, actor: 'alice', now: 2 });
    const r1 = resetAllPoints(ch, { reason: 'new season', actor: 'dashboard:owner:owner', requestId: 'reset-1' });
    const r2 = resetAllPoints(ch, { reason: 'new season', actor: 'dashboard:owner:owner', requestId: 'reset-1' });
    check('reset zeroes every balance', 'applied' in r1 && r1.applied && r1.users === 2 && r1.total === 110
      && balance(ch, 1) === 0 && balance(ch, 2) === 0, r1);
    check('reset applies once per requestId', 'applied' in r2 && !r2.applied, r2);
    check('reset cancels pending duels without refund', duel.ok && 'duelsCancelled' in r1 && r1.duelsCancelled === 1
      && !outgoingDuel(db, 1) && refundDuel(db, { id: duel.ok ? duel.duel.id : '', status: 'expired', actor: 'sweep', now: 3 }) === null
      && balance(ch, 1) === 0);
    check('reset keeps watch time and lifetime earned', getUser(db, 1)!.lifetime_earned === 100);
    check('reset short reason is 400', (resetAllPoints(ch, { reason: 'x', actor: 'd', requestId: 'reset-2' }) as { status: number }).status === 400);
    check('reset without a database is 404', (resetAllPoints('nodb', { reason: 'abc', actor: 'd', requestId: 'reset-3' }) as { status: number }).status === 404);
    const named = await backupPoints(ch, 'points-before-reset-test');
    check('named backup written', !!named && path.basename(named) === 'points-before-reset-test.sqlite' && fs.existsSync(named));
    check('invariant holds (reset)', invariantViolations(db).length === 0);
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
