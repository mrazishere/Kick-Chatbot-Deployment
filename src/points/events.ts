/**
 * Bonus points for follows, subs, gifted subs and Kicks.
 *
 * Kick re-delivers webhooks, a bot that dies mid-batch replays its queue, and a
 * sub can arrive by webhook and on the chat socket. Every grant therefore has
 * an idempotency key built from the event's own fields, claimed in the same
 * transaction as the credit (store.applyOnce), so each event pays out once.
 *
 * When the database can't be used, events wait in a spool file and replay once
 * it's back; the keys make replaying safe.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { FollowEvent, KicksGiftedEvent, QueueMeta, SubscriptionEvent, SubscriptionGiftsEvent } from '../types';
import { LivePointsConfig, readSubscriptionStatus } from './config';
import { PointsDb, pointsDir, reportDbError } from './db';
import { Exclusions, applyOnce, creditTx, ensureUserTx, exclusionsFor, isExcluded, recentGrant } from './store';

const MIN = 60_000;
/** A gifted sub's recipient may also get a new-sub event; one of the two pays. */
const GIFT_DEDUPE_MS = 10 * MIN;
/** How long a chat-socket sub grant and a webhook sub grant are treated as the same sub. */
const PUSHER_DEDUPE_MS = 15 * MIN;

export interface BonusContext {
  channel: string;
  config(): LivePointsConfig;
  db(): PointsDb | null;
  /** Last known live state; null when unknown. */
  isLive(): boolean | null;
  announce(message: string): void;
  now(): number;
}

export interface BonusGrant {
  userId: number;
  username: string;
  points: number;
  reason: string;
}

export type BonusOutcome =
  | { status: 'granted'; grants: BonusGrant[] }
  | { status: 'duplicate' | 'skipped' | 'spooled'; detail: string };

type SpoolType = 'follow' | 'sub_new' | 'sub_renewal' | 'gifts' | 'kicks';

function validId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/** A stable part for a key when the payload has no timestamp: Kick's message id, else the minute. */
function stamp(value: string | undefined, meta: QueueMeta, now: number): string {
  return value || meta.messageId || `m${Math.floor(now / MIN)}`;
}

function spoolPath(channel: string): string {
  return path.join(pointsDir(channel), 'pending-events.jsonl');
}

function spool(ctx: BonusContext, type: SpoolType, payload: unknown, meta: QueueMeta): BonusOutcome {
  try {
    fs.mkdirSync(pointsDir(ctx.channel), { recursive: true });
    fs.appendFileSync(spoolPath(ctx.channel), JSON.stringify({ type, payload, meta, at: ctx.now() }) + '\n');
    console.warn(`[POINTS] ${type} bonus for ${ctx.channel} saved for later: database unavailable`);
    return { status: 'spooled', detail: 'database unavailable' };
  } catch (err) {
    console.error(`[POINTS] Could not save a ${type} bonus for later, it is lost: ${err instanceof Error ? err.message : String(err)}`);
    return { status: 'skipped', detail: 'database and spool unavailable' };
  }
}

/**
 * The shared path for every bonus: settings checks, the database (or the
 * spool), the idempotency key, and the announcement. An event announces in one
 * chat line however many viewers it paid; `describe` writes that line.
 */
function grantBonus(
  ctx: BonusContext,
  type: SpoolType,
  payload: unknown,
  meta: QueueMeta,
  key: string,
  build: (db: PointsDb, now: number, ex: Exclusions) => BonusGrant[],
  describe: (grants: BonusGrant[], currency: string) => string = (grants, currency) => announcement(grants[0], currency)
): BonusOutcome {
  const { cfg, broadcasterUserId } = ctx.config();
  if (!cfg.enabled) return { status: 'skipped', detail: 'points disabled' };
  if (cfg.bonuses.onlyWhileLive && ctx.isLive() !== true) return { status: 'skipped', detail: 'not live' };

  const db = ctx.db();
  if (!db) return spool(ctx, type, payload, meta);

  const now = ctx.now();
  let res: { applied: boolean; result?: BonusGrant[] };
  try {
    const ex = exclusionsFor(ctx.channel, cfg, broadcasterUserId);
    res = applyOnce(db, key, now, () => build(db, now, ex));
  } catch (err) {
    reportDbError(ctx.channel, err);
    console.error(`[POINTS] ${type} bonus failed for ${ctx.channel}: ${err instanceof Error ? err.message : String(err)}`);
    return spool(ctx, type, payload, meta);
  }
  if (!res.applied) return { status: 'duplicate', detail: key };

  const grants = res.result ?? [];
  if (!grants.length) return { status: 'skipped', detail: 'nothing to grant' };
  for (const g of grants) console.log(`[POINTS] +${g.points} ${cfg.currencyName} to ${g.username} (${g.reason})`);
  if (cfg.bonuses.announce) ctx.announce(describe(grants, cfg.currencyName));
  return { status: 'granted', grants };
}

/** Kick cuts a chat message at 500 characters; recipients past this become "and N more". */
const ANNOUNCE_MAX_CHARS = 450;

/**
 * One line for a whole gifted-subs event. It used to be a line per recipient,
 * so a 10-sub gift flooded chat with 10 (2026-09-11).
 */
function giftAnnouncement(grants: BonusGrant[], subs: number, currency: string): string {
  const gifter = grants.find(g => g.reason === 'gift_sub');
  const recipients = grants.filter(g => g.reason === 'gift_recv');
  const thanks = gifter ? `thanks for the ${subs} gifted ${subs === 1 ? 'sub' : 'subs'} ${gifter.username} +${gifter.points} ${currency}` : '';
  if (!recipients.length) return thanks;
  // The recipient bonus is one setting, so everyone in an event gets the same amount.
  const each = `+${recipients[0].points} ${currency}${recipients.length > 1 ? ' each' : ''}`;
  const lead = gifter ? `${thanks}, and ${each} to ` : `enjoy your gifted ${recipients.length === 1 ? 'sub' : 'subs'} `;
  const tail = gifter ? '' : ` ${each}`;
  return lead + nameList(recipients.map(r => r.username), ANNOUNCE_MAX_CHARS - lead.length - tail.length) + tail;
}

/** "a, b, c", or "a, b and 8 more" when the full list is longer than `budget`. */
function nameList(names: string[], budget: number): string {
  const text = (shown: number) => names.slice(0, shown).join(', ') + (shown < names.length ? ` and ${names.length - shown} more` : '');
  let shown = names.length;
  while (shown > 1 && text(shown).length > budget) shown--;
  return text(shown);
}

function announcement(g: BonusGrant, currency: string): string {
  const why: Record<string, string> = {
    follow: 'thanks for the follow',
    sub_new: 'thanks for subscribing',
    sub_renewal: 'thanks for resubscribing',
    pusher_sub: 'thanks for subscribing',
    gift_sub: 'thanks for the gifted subs',
    gift_recv: 'enjoy your gifted sub',
    kicks: 'thanks for the Kicks'
  };
  return `${why[g.reason] ?? 'thanks'} ${g.username} +${g.points} ${currency}`;
}

function credit(db: PointsDb, now: number, key: string, userId: number, username: string, points: number, reason: string): BonusGrant {
  creditTx(db, { userId, username, amount: points, reason, ref: key, actor: 'system', now });
  return { userId, username, points, reason };
}

/** A follow pays once per viewer, ever: unfollowing and following again doesn't repeat it. */
export function onFollow(ctx: BonusContext, e: FollowEvent, meta: QueueMeta): BonusOutcome {
  const f = e?.follower;
  if (!f || !validId(f.user_id)) return { status: 'skipped', detail: 'no follower id' };
  const userId = f.user_id;
  const key = `follow:${userId}`;
  return grantBonus(ctx, 'follow', e, meta, key, (db, now, ex) => {
    const amount = ctx.config().cfg.bonuses.follow;
    if (amount <= 0 || isExcluded(ex, userId, f.username)) return [];
    const user = ensureUserTx(db, userId, f.username, now);
    if (user.follow_bonus_at !== null) return [];
    db.prepare('UPDATE users SET follow_bonus_at = ? WHERE user_id = ?').run(now, userId);
    return [credit(db, now, key, userId, f.username, amount, 'follow')];
  });
}

export function onSubscription(ctx: BonusContext, kind: 'new' | 'renewal', e: SubscriptionEvent, meta: QueueMeta): BonusOutcome {
  const s = e?.subscriber;
  if (!s || !validId(s.user_id)) return { status: 'skipped', detail: 'no subscriber id' };
  const userId = s.user_id;
  const reason = kind === 'new' ? 'sub_new' : 'sub_renewal';
  // A renewal's created_at may be the original sub date, repeated every month, and
  // a repeat within the key's 30-day life would then read as a duplicate. With the
  // period's expiry and length added the key is unique per billing period.
  const duration = (e as { duration?: unknown }).duration;
  const period = kind === 'renewal'
    ? [e.created_at, e.expires_at, duration].filter(v => v !== undefined && v !== null && v !== '').join(':')
    : (e.created_at || e.expires_at);
  const key = `${kind === 'new' ? 'subnew' : 'subrenew'}:${userId}:${stamp(period || undefined, meta, ctx.now())}`;
  return grantBonus(ctx, reason, e, meta, key, (db, now, ex) => {
    const { bonuses } = ctx.config().cfg;
    const amount = kind === 'new' ? bonuses.subNew : bonuses.subRenewal;
    if (amount <= 0 || isExcluded(ex, userId, s.username)) return [];
    // The same sub may already have paid through the chat socket fallback or as a gift.
    if (recentGrant(db, userId, ['pusher_sub'], now - PUSHER_DEDUPE_MS)) return [];
    if (kind === 'new' && recentGrant(db, userId, ['gift_recv'], now - GIFT_DEDUPE_MS)) return [];
    return [credit(db, now, key, userId, s.username, amount, reason)];
  });
}

/** The gifter gets a bonus per sub (not when anonymous); each recipient gets their own. */
export function onGifts(ctx: BonusContext, e: SubscriptionGiftsEvent, meta: QueueMeta): BonusOutcome {
  const giftees = (Array.isArray(e?.giftees) ? e.giftees : []).filter(g => g && validId(g.user_id));
  if (!giftees.length) return { status: 'skipped', detail: 'no giftees' };
  const gifter = e.gifter && !e.gifter.is_anonymous && validId(e.gifter.user_id) ? e.gifter : null;
  const ids = giftees.map(g => g.user_id as number).sort((a, b) => a - b).join(',');
  const digest = crypto.createHash('sha1').update(ids).digest('hex').slice(0, 16);
  const key = `gifts:${gifter ? gifter.user_id : 'anon'}:${stamp(e.created_at, meta, ctx.now())}:${digest}`;

  return grantBonus(ctx, 'gifts', e, meta, key, (db, now, ex) => {
    const { bonuses } = ctx.config().cfg;
    const grants: BonusGrant[] = [];
    if (gifter && bonuses.giftSubGifterPerSub > 0 && !isExcluded(ex, gifter.user_id, gifter.username)) {
      grants.push(credit(db, now, key, gifter.user_id as number, gifter.username, bonuses.giftSubGifterPerSub * giftees.length, 'gift_sub'));
    }
    if (bonuses.giftSubRecipient > 0) {
      for (const g of giftees) {
        const uid = g.user_id as number;
        if (isExcluded(ex, uid, g.username)) continue;
        if (recentGrant(db, uid, ['sub_new'], now - GIFT_DEDUPE_MS) || recentGrant(db, uid, ['pusher_sub'], now - PUSHER_DEDUPE_MS)) continue;
        grants.push(credit(db, now, key, uid, g.username, bonuses.giftSubRecipient, 'gift_recv'));
      }
    }
    return grants;
  }, (grants, currency) => giftAnnouncement(grants, giftees.length, currency));
}

export function onKicks(ctx: BonusContext, e: KicksGiftedEvent, meta: QueueMeta): BonusOutcome {
  const s = e?.sender;
  const amount = Number(e?.gift?.amount);
  if (!s || !validId(s.user_id) || !Number.isFinite(amount) || amount <= 0) return { status: 'skipped', detail: 'no sender or amount' };
  const userId = s.user_id;
  const key = `kicks:${userId}:${stamp(e.created_at, meta, ctx.now())}:${amount}`;
  return grantBonus(ctx, 'kicks', e, meta, key, (db, now, ex) => {
    const points = Math.floor(amount * ctx.config().cfg.bonuses.pointsPerKick);
    if (points <= 0 || isExcluded(ex, userId, s.username)) return [];
    return [credit(db, now, key, userId, s.username, points, 'kicks')];
  });
}

/**
 * A sub seen on the chat socket, used only when the enrollment service recorded
 * that the sub webhooks couldn't be subscribed. The socket event has a username
 * but no id or timestamp, so the id is resolved and any sub grant for the same
 * viewer in the last 15 minutes counts as this one.
 */
export async function onPusherSubscription(
  ctx: BonusContext,
  data: Record<string, unknown>,
  resolve: (username: string) => Promise<{ userId: number; username: string } | null>
): Promise<BonusOutcome> {
  const status = readSubscriptionStatus(ctx.channel);
  const webhookDown = status?.['channel.subscription.new']?.ok === false || status?.['channel.subscription.renewal']?.ok === false;
  if (!webhookDown) return { status: 'skipped', detail: 'sub webhooks handle this' };
  if (!ctx.config().cfg.enabled) return { status: 'skipped', detail: 'points disabled' };

  const name = typeof data?.username === 'string' ? data.username : '';
  if (!name) return { status: 'skipped', detail: 'no username' };
  const who = await resolve(name);
  if (!who) return { status: 'skipped', detail: `could not resolve ${name}` };
  if (!ctx.db()) return { status: 'skipped', detail: 'database unavailable' };

  const months = Number(data.months);
  const now = ctx.now();
  const key = `pushersub:${who.userId}:${Math.floor(now / PUSHER_DEDUPE_MS)}`;
  return grantBonus(ctx, 'sub_new', { subscriber: { user_id: who.userId, username: who.username } }, { ageMs: 0 }, key, (db, at, ex) => {
    const { bonuses } = ctx.config().cfg;
    const amount = months > 1 ? bonuses.subRenewal : bonuses.subNew;
    if (amount <= 0 || isExcluded(ex, who.userId, who.username)) return [];
    if (recentGrant(db, who.userId, ['sub_new', 'sub_renewal', 'pusher_sub', 'gift_recv'], at - PUSHER_DEDUPE_MS)) return [];
    return [credit(db, at, key, who.userId, who.username, amount, 'pusher_sub')];
  });
}

/** Replay bonuses saved while the database was unavailable. Returns how many lines were processed. */
export function replaySpool(ctx: BonusContext): number {
  const file = spoolPath(ctx.channel);
  const claimed = `${file}.replay`;
  if ((!fs.existsSync(file) && !fs.existsSync(claimed)) || !ctx.db()) return 0;
  let processed = 0;
  // A crash mid-replay leaves the claimed file behind. Finish it before claiming the
  // spool again, or that rename would overwrite it and lose its bonuses.
  if (fs.existsSync(claimed)) processed += replayFile(ctx, claimed);
  if (fs.existsSync(file)) {
    try {
      fs.renameSync(file, claimed);
      processed += replayFile(ctx, claimed);
    } catch { /* claimed meanwhile */ }
  }
  if (processed) console.log(`[POINTS] Replayed ${processed} saved bonus event(s) for ${ctx.channel}`);
  return processed;
}

function replayFile(ctx: BonusContext, claimed: string): number {
  let lines: string[] = [];
  try { lines = fs.readFileSync(claimed, 'utf8').split('\n').filter(Boolean); } catch { /* unreadable */ }
  let processed = 0;
  for (const line of lines) {
    try {
      const { type, payload, meta } = JSON.parse(line) as { type: SpoolType; payload: never; meta: QueueMeta };
      // Anything that can't be applied now goes back into the spool through the handler itself.
      if (type === 'follow') onFollow(ctx, payload, meta);
      else if (type === 'sub_new') onSubscription(ctx, 'new', payload, meta);
      else if (type === 'sub_renewal') onSubscription(ctx, 'renewal', payload, meta);
      else if (type === 'gifts') onGifts(ctx, payload, meta);
      else if (type === 'kicks') onKicks(ctx, payload, meta);
      processed++;
    } catch { /* malformed line */ }
  }
  try { fs.unlinkSync(claimed); } catch { /* ignore */ }
  return processed;
}
