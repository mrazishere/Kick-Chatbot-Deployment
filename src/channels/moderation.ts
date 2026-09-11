/**
 * Timeouts through Kick's moderation API, shared by everything in a channel bot
 * that times someone out: channel-point rewards, and custom commands whose
 * response starts with /timeout.
 *
 * It owns who may be timed out (protected accounts, the moderator cache and
 * shields), who issues it (the bot's own token where it moderates, the
 * streamer's grant otherwise), and which timeouts the bot gave out — the only
 * ones a pardon may lift. Shields and issued timeouts are saved per channel so
 * a bot restart doesn't throw away what viewers paid channel points for.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { ModerationBannedEvent, RawBadge, TimeoutRequest, TimeoutResult } from '../types';
import { getBotIdentity } from '../bot-identity';

const API = 'https://api.kick.com/public/v1';

/** Kick's ban API caps a timeout at one week. */
const MAX_TIMEOUT_MINUTES = 10080;

/** Bots that carry a moderator badge but are not people. Kept out of the mod cache. */
const SYSTEM_BOTS = new Set(['kickbot', 'kickcx', 'botrix', 'streamelements', 'nightbot', 'moobot']);

/** How often the moderator cache is re-warmed from the channel log. */
const MOD_REFRESH_MS = 30 * 60 * 1000;

/** A token that can issue a ban, and the name Kick will show on it. */
interface ModerationActor {
  token: string;
  name: string;
  isBot: boolean;
}

/** A shield bought with channel points. */
export interface Shield {
  expiresAt: number;
  /** Timeout and roulette rewards aimed at the holder land on whoever redeemed them instead. */
  reflect: boolean;
}

/** A timeout this bot issued — kept so a pardon can lift it, and a restart can finish lifting it. */
interface IssuedTimeout {
  userId: number;
  /** Display name, for logs and chat. */
  name: string;
  /** When Kick lifts it on its own. The ban is issued in whole minutes. */
  expiresAt: number;
  /** When the bot lifts it early, at the exact second asked for. */
  liftAt: number;
  asBot: boolean;
  /** When the bot issued it, to tell Kick's echo of this ban from someone else's. */
  issuedAt?: number;
}

interface ModerationState {
  /** Keyed by lowercase username. */
  shields: Record<string, Shield>;
  /** Keyed by lowercase username. */
  timeouts: Record<string, IssuedTimeout>;
}

export type PardonResult = { ok: true; target: string } | { ok: false; error: string };

export interface ModeratorDeps {
  channelName: string;
  getBroadcasterUserId: () => number | null;
  /** Streamer-delegated token. `isChannelToken: false` means moderation is not authorized. */
  getToken: () => Promise<{ token: string; isChannelToken: boolean }>;
  /**
   * The bot's own token. It issues bans where the bot is a moderator, and does
   * username lookups — those are channel-agnostic and only need `channel:read`,
   * so they work even on a channel whose streamer grant is narrower.
   */
  getBotToken: () => Promise<string | null>;
}

export class ChannelModerator {
  private deps: ModeratorDeps;
  /** Usernames (lowercase) known to hold a moderator/broadcaster badge here. */
  private mods = new Set<string>();
  private modRefreshTimer: NodeJS.Timeout | null = null;
  /** Early-lift timers, keyed by lowercase username. */
  private liftTimers = new Map<string, NodeJS.Timeout>();
  /** Scopes actually granted on a given token, keyed by the token itself. */
  private scopeCache = new Map<string, string[]>();
  /** Loaded from disk on first use. */
  private state: ModerationState | null = null;

  constructor(deps: ModeratorDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.modRefreshTimer) return;
    void this.warmModeratorCache();
    this.modRefreshTimer = setInterval(() => void this.warmModeratorCache(), MOD_REFRESH_MS);
    this.resumeLifts();
  }

  /** Timers stop; the saved state stays, so the next start() picks the lifts back up. */
  stop(): void {
    if (this.modRefreshTimer) {
      clearInterval(this.modRefreshTimer);
      this.modRefreshTimer = null;
    }
    for (const t of this.liftTimers.values()) clearTimeout(t);
    this.liftTimers.clear();
  }

  /**
   * Feed live chat badges in. A moderator who has not spoken since the bot
   * started is still covered by the log warm-start, but this keeps freshly
   * promoted mods protected without waiting for the next refresh.
   */
  noteBadges(username: string, badges: RawBadge[] | undefined): void {
    if (!username || !badges?.length) return;
    const isMod = badges.some(b => b.type === 'moderator' || b.type === 'broadcaster' || b.type === 'owner');
    if (isMod) this.mods.add(username.toLowerCase());
  }

  /**
   * Seed the moderator set from the channel's own log.
   *
   * Kick's public API has no endpoint that lists moderators, so past chat is
   * the only signal. Without this, a mod who is lurking at bot-restart time
   * would be a legal timeout target.
   */
  private warmModeratorCache(): Promise<void> {
    const logPath = path.join(process.cwd(), 'logs', `kick-${this.deps.channelName}-out.log`);
    if (!fs.existsSync(logPath)) return Promise.resolve();

    // Filter in the shell: these logs reach tens of MB and buffering a raw tail
    // in Node blows past exec's maxBuffer, which fails silently.
    const cmd = `tail -n 200000 ${JSON.stringify(logPath)} | grep -oE '\\[[a-z_,]*moderator[a-z_,]*\\] [A-Za-z0-9_]+:' | sed -E 's/.*\\] //; s/:$//' | sort -u`;
    return new Promise<void>(resolve => {
      exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve();
        let added = 0;
        for (const line of stdout.split('\n')) {
          const name = line.trim().toLowerCase();
          if (!name || SYSTEM_BOTS.has(name)) continue;
          if (!this.mods.has(name)) added++;
          this.mods.add(name);
        }
        if (added) console.log(`[MODERATION] Moderator cache warmed from log (+${added}, ${this.mods.size} total)`);
        resolve();
      });
    });
  }

  /**
   * Why `target` may not be timed out by `invoker`, or null if they may.
   *
   * Naming yourself is always allowed: a self-inflicted timeout harms nobody
   * else, and it's the only way a moderator can use a timeout reward or command
   * on themselves. The broadcaster and the bot stay protected even from
   * themselves — gagging either one breaks the stream or the bot's own replies.
   */
  protectionReason(target: string, invoker: string): string | null {
    const name = target.toLowerCase();
    if (name === this.deps.channelName.toLowerCase()) return 'broadcaster';
    const bot = getBotIdentity();
    if (bot?.username && name === bot.username.toLowerCase()) return 'the bot';
    if (SYSTEM_BOTS.has(name)) return 'a system bot';

    if (name === invoker.toLowerCase()) return null;   // self-inflicted

    if (name === (process.env.KICK_OWNER || '').toLowerCase()) return 'the bot owner';
    if (this.mods.has(name)) return 'a moderator';
    return null;
  }

  /** The user's active shield, if any. */
  shieldOf(username: string): Shield | null {
    return this.getState().shields[username.replace(/^@+/, '').toLowerCase()] ?? null;
  }

  /** Give a shield, or extend one that is still running — buying another adds to it. */
  grantShield(username: string, seconds: number, reflect: boolean): Shield {
    const key = username.replace(/^@+/, '').toLowerCase();
    const state = this.getState();
    const current = state.shields[key];
    const from = Math.max(Date.now(), current?.expiresAt ?? 0);
    const shield: Shield = {
      expiresAt: from + Math.max(1, Math.floor(seconds)) * 1000,
      reflect: reflect || (current?.reflect ?? false)
    };
    state.shields[key] = shield;
    this.saveState();
    return shield;
  }

  /**
   * Scopes actually present on a token.
   *
   * A grant made before a scope was added to the enrollment request keeps the
   * old, narrower set forever — refreshing never widens it. Acting without
   * checking means the ban call 403s and callers report failures they could
   * have predicted.
   */
  async grantedScopes(token: string): Promise<string[]> {
    const cached = this.scopeCache.get(token);
    if (cached) return cached;
    try {
      const res = await axios.post(`${API}/token/introspect`, null, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const scope = (res.data as { data?: { scope?: string } })?.data?.scope ?? '';
      const scopes = scope.split(/\s+/).filter(Boolean);
      // Tokens rotate on refresh; keep the map from growing unbounded.
      if (this.scopeCache.size > 4) this.scopeCache.clear();
      this.scopeCache.set(token, scopes);
      return scopes;
    } catch {
      // Unknown rather than empty — assume capable and let the API be the judge.
      return [];
    }
  }

  /**
   * Who a timeout would be issued as right now, in the order they'd be tried.
   * Empty means this channel can't moderate at all, which lets a caller stay
   * silent instead of promising something it can't do.
   */
  async issuers(): Promise<Array<{ name: string; isBot: boolean }>> {
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) return [];
    const actors = await this.moderationActors(token, await this.grantedScopes(token));
    return actors.map(({ name, isBot }) => ({ name, isBot }));
  }

  /** A Kick user's id, or null when there is no such user or the lookup failed. */
  async lookupUser(username: string): Promise<number | null> {
    const name = username.replace(/^@+/, '');
    const botToken = await this.deps.getBotToken().catch(() => null);
    const { token } = await this.deps.getToken().catch(() => ({ token: '' }));
    const first = botToken || token;
    if (!first) return null;
    return (await resolveUserId(name, first))
      ?? (token && token !== first ? await resolveUserId(name, token) : null);
  }

  /**
   * Time `request.target` out for `request.seconds`.
   *
   * Kick's ban API takes whole minutes, so the ban is rounded up and then lifted
   * early at the exact second. Failures come back as short sentences that are
   * safe to post in chat; the detail goes to the log.
   */
  async timeout(request: TimeoutRequest): Promise<TimeoutResult> {
    const target = request.target.replace(/^@+/, '');

    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (!isChannelToken || !token) {
      console.error(`[MODERATION] Timeout of ${target} skipped — ${this.deps.channelName} has no streamer token. Channel must re-authorize.`);
      return { ok: false, error: 'timeouts are not set up for this channel' };
    }
    const scopes = await this.grantedScopes(token);
    const actors = await this.moderationActors(token, scopes);
    if (actors.length === 0) {
      console.error(
        `[MODERATION] Timeout of ${target} skipped — neither the bot nor ${this.deps.channelName}'s token carries moderation:ban ` +
        `(channel granted: ${scopes.join(' ') || 'none'}).`
      );
      return { ok: false, error: 'timeouts are not set up for this channel' };
    }

    const blocked = this.protectionReason(target, request.invoker);
    if (blocked) {
      return { ok: false, error: `${target} cannot be timed out (${blocked})` };
    }

    const broadcasterUserId = this.deps.getBroadcasterUserId();
    if (!broadcasterUserId) {
      console.error('[MODERATION] Broadcaster user id unknown — cannot time out.');
      return { ok: false, error: 'the bot could not identify this channel' };
    }

    const targetUserId = await this.lookupUser(target);
    if (!targetUserId) {
      return { ok: false, error: `I could not find a Kick user called "${target}"` };
    }
    if (targetUserId === broadcasterUserId) {
      return { ok: false, error: `${target} cannot be timed out` };
    }

    const seconds = Math.min(MAX_TIMEOUT_MINUTES * 60, Math.max(1, Math.floor(request.seconds)));
    // Round up so the punishment is never shorter than asked, then lift it early below.
    const minutes = Math.ceil(seconds / 60);

    const actor = await this.firstThatWorks(actors, `Timeout of ${target}`, t =>
      axios.post(`${API}/moderation/bans`, {
        broadcaster_user_id: broadcasterUserId,
        user_id: targetUserId,
        duration: minutes,
        reason: truncate(plainReason(request.reason), 100)
      }, { headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } })
    );
    if (!actor) {
      return { ok: false, error: `I could not time out ${target}` };
    }

    const now = Date.now();
    const key = target.toLowerCase();
    const entry: IssuedTimeout = {
      userId: targetUserId,
      name: target,
      expiresAt: now + minutes * 60_000,
      liftAt: now + seconds * 1000,
      asBot: actor.isBot,
      issuedAt: now
    };
    this.clearLiftTimer(key);
    this.getState().timeouts[key] = entry;
    this.saveState();
    if (entry.liftAt < entry.expiresAt) this.scheduleLift(key, entry);

    return { ok: true, target, seconds, actor: actor.name };
  }

  /**
   * Lift a timeout this bot issued, from a reward or a /timeout command.
   *
   * Anything else — a moderator's own timeout or ban — is out of reach on
   * purpose: channel points must never undo a moderator's decision.
   */
  async pardon(target: string): Promise<PardonResult> {
    const name = target.replace(/^@+/, '');
    const key = name.toLowerCase();
    const entry = this.getState().timeouts[key];
    if (!entry) {
      return { ok: false, error: `${name} is not in a timeout from the bot` };
    }
    if (!(await this.lift(entry, `Pardon of ${entry.name}`))) {
      return { ok: false, error: `I could not lift ${entry.name}'s timeout` };
    }
    this.clearLiftTimer(key);
    if (this.getState().timeouts[key] === entry) {
      delete this.getState().timeouts[key];
      this.saveState();
    }
    return { ok: true, target: entry.name };
  }

  /**
   * Forget a timeout the bot gave out once someone else bans the same user.
   *
   * Kick's unban lifts whatever ban a user has now, not a particular one. Without
   * this, a moderator who banned someone the bot had timed out would have that
   * ban quietly lifted by the bot's early unban, or by a viewer's pardon.
   */
  noteBan(event: ModerationBannedEvent): void {
    const name = event?.banned_user?.username;
    if (!name) return;
    const key = name.replace(/^@+/, '').toLowerCase();
    const entry = this.getState().timeouts[key];
    if (!entry) return;

    // An unrecognised payload leaves the bot's state alone. Guessing wrong would
    // drop the bot's own timeouts on Kick's echo of them, and with them every
    // early unban and pardon.
    const meta = event.metadata;
    if (!meta || !('expires_at' in meta)) return;
    const permanent = meta.expires_at === null;
    const expiresAt = typeof meta.expires_at === 'string' ? Date.parse(meta.expires_at) : NaN;
    if (!permanent && !Number.isFinite(expiresAt)) return;

    // Kick reports the bot's own ban as well. That one expires with the bot's
    // entry and was created when the bot issued it; anything else is someone else's.
    const ECHO_TOLERANCE_MS = 20_000;
    const createdAt = typeof meta.created_at === 'string' ? Date.parse(meta.created_at) : NaN;
    const sameExpiry = !permanent && Math.abs(expiresAt - entry.expiresAt) < ECHO_TOLERANCE_MS;
    const sameIssue = !entry.issuedAt || !Number.isFinite(createdAt) || Math.abs(createdAt - entry.issuedAt) < ECHO_TOLERANCE_MS;
    if (sameExpiry && sameIssue) return;

    this.clearLiftTimer(key);
    delete this.getState().timeouts[key];
    this.saveState();
    console.log(
      `[MODERATION] ${entry.name} was ${permanent ? 'banned' : 'timed out again'} by ${event.moderator?.username ?? 'someone else'} — ` +
      `the bot will not lift that, or pardon its own timeout on them`
    );
  }

  /**
   * Who may issue this channel's bans, in the order to try them.
   *
   * The bot goes first when its own token carries moderation:ban, so Kick
   * credits the timeout to the bot instead of the streamer. That only works
   * where the bot is a moderator, and no API reports that — so the streamer
   * token stays behind it as the fallback.
   */
  private async moderationActors(streamerToken: string, streamerScopes: string[]): Promise<ModerationActor[]> {
    const actors: ModerationActor[] = [];
    const botToken = await this.deps.getBotToken().catch(() => null);
    if (botToken && botToken !== streamerToken && (await this.grantedScopes(botToken)).includes('moderation:ban')) {
      actors.push({ token: botToken, name: getBotIdentity()?.username || 'the bot', isBot: true });
    }
    // Empty means introspection failed: assume capable and let the API judge.
    if (streamerScopes.length === 0 || streamerScopes.includes('moderation:ban')) {
      actors.push({ token: streamerToken, name: this.deps.channelName, isBot: false });
    }
    return actors;
  }

  /**
   * Run a moderation call as each actor in turn until one succeeds.
   *
   * The bot being refused is expected on any channel that has not made it a
   * moderator, so that is a warning and the next actor gets its turn.
   * Returns the actor that succeeded, or null when every one failed.
   */
  private async firstThatWorks(
    actors: ModerationActor[],
    what: string,
    call: (token: string) => Promise<unknown>
  ): Promise<ModerationActor | null> {
    for (const [i, actor] of actors.entries()) {
      try {
        await call(actor.token);
        return actor;
      } catch (err) {
        const detail = describeError(err);
        const next = actors[i + 1];
        if (next) {
          // Kick answers a non-moderator with a bare 400 "Invalid request". The bot's
          // Kick account shares its name with the app that posts under the bot badge,
          // and modding that badged entry only mods the app — bans use the account's token.
          const hint = actor.isBot
            ? ` To have timeouts credited to the bot, the Kick account kick.com/${actor.name.toLowerCase()} must be a moderator ` +
              `in ${this.deps.channelName} — modding the [bot]-badged app of the same name isn't enough.`
            : '';
          // Logged rather than warned: the dashboard's log card only shows the out log.
          console.log(`[MODERATION] ${what} as ${actor.name} refused: ${detail} — retrying as ${next.name}.${hint}`);
        } else {
          console.error(`[MODERATION] ${what} failed as ${actor.name}: ${detail}`);
        }
      }
    }
    return null;
  }

  /** Remove a ban as whoever issued it, falling back to the streamer token. Returns success. */
  private async lift(entry: IssuedTimeout, what: string): Promise<boolean> {
    const broadcasterUserId = this.deps.getBroadcasterUserId();
    if (!broadcasterUserId) {
      console.error(`[MODERATION] ${what} skipped — broadcaster user id unknown.`);
      return false;
    }
    // Fetch tokens now — either may have rotated since the timeout was issued.
    const actors: ModerationActor[] = [];
    if (entry.asBot) {
      const botToken = await this.deps.getBotToken().catch(() => null);
      if (botToken) actors.push({ token: botToken, name: getBotIdentity()?.username || 'the bot', isBot: true });
    }
    const { token, isChannelToken } = await this.deps.getToken().catch(() => ({ token: '', isChannelToken: false }));
    if (isChannelToken && token) actors.push({ token, name: this.deps.channelName, isBot: false });

    const actor = await this.firstThatWorks(actors, what, t =>
      axios.delete(`${API}/moderation/bans`, {
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        data: { broadcaster_user_id: broadcasterUserId, user_id: entry.userId }
      })
    );
    return actor !== null;
  }

  /**
   * Lift the rounded-up ban at the exact requested second.
   *
   * Best-effort by design: if the lift fails, Kick expires the timeout on its
   * own within the minute rather than leaving anyone stuck.
   */
  private scheduleLift(key: string, entry: IssuedTimeout, minDelayMs = 0): void {
    const timer = setTimeout(() => {
      this.liftTimers.delete(key);
      // Dropped or replaced since this was scheduled: someone else's ban now, or a newer timeout.
      if (this.getState().timeouts[key] !== entry) return;
      void (async () => {
        if (!(await this.lift(entry, `Early unban of ${entry.name}`))) return;
        console.log(`[MODERATION] Timeout on ${entry.name} lifted on schedule`);
        // A newer timeout on the same user replaces the entry; leave that one alone.
        if (this.getState().timeouts[key] === entry) {
          delete this.getState().timeouts[key];
          this.saveState();
        }
      })();
    }, Math.max(minDelayMs, entry.liftAt - Date.now()));
    this.liftTimers.set(key, timer);
  }

  private clearLiftTimer(key: string): void {
    const timer = this.liftTimers.get(key);
    if (timer) clearTimeout(timer);
    this.liftTimers.delete(key);
  }

  /**
   * After a restart, finish the early lifts that were still pending. Overdue ones
   * wait a few seconds so the webhook poller can first apply any ban a moderator
   * issued while the bot was down.
   */
  private resumeLifts(): void {
    for (const [key, entry] of Object.entries(this.getState().timeouts)) {
      if (entry.liftAt < entry.expiresAt && !this.liftTimers.has(key)) this.scheduleLift(key, entry, 3000);
    }
  }

  private statePath(): string {
    return path.join(process.cwd(), 'data', 'moderation', `${this.deps.channelName}.json`);
  }

  /** The saved shields and issued timeouts, loaded on first use and pruned of anything expired. */
  private getState(): ModerationState {
    if (!this.state) {
      this.state = { shields: {}, timeouts: {} };
      try {
        const saved = JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) as Partial<ModerationState>;
        this.state.shields = saved.shields ?? {};
        this.state.timeouts = saved.timeouts ?? {};
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.error(`[MODERATION] Could not read ${this.statePath()}, starting without saved shields or timeouts: ${describeError(err)}`);
        }
      }
    }
    const now = Date.now();
    for (const [key, shield] of Object.entries(this.state.shields)) {
      if (shield.expiresAt <= now) delete this.state.shields[key];
    }
    for (const [key, entry] of Object.entries(this.state.timeouts)) {
      if (entry.expiresAt <= now) delete this.state.timeouts[key];
    }
    return this.state;
  }

  private saveState(): void {
    const p = this.statePath();
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.getState(), null, 2));
      fs.renameSync(tmp, p);
    } catch (err) {
      console.error(`[MODERATION] Could not save ${p}: ${describeError(err)}`);
    }
  }
}

/**
 * Resolve a Kick username to its numeric user id via its channel slug.
 *
 * A slug is not the username: Kick lowercases it and turns underscores into
 * hyphens ("VJ_in_PJs" → "vj-in-pjs"), and a lookup by the raw name finds
 * nothing. The raw lowercase form is still tried second, in case a slug was
 * ever minted differently.
 */
export async function resolveUserId(username: string, token: string): Promise<number | null> {
  const lower = username.toLowerCase();
  const slugs = Array.from(new Set([lower.replace(/_/g, '-'), lower]));
  for (const slug of slugs) {
    try {
      const res = await axios.get(`${API}/channels`, {
        params: { slug },
        headers: { Authorization: `Bearer ${token}`, Accept: '*/*' }
      });
      const rows = (res.data as { data?: Array<{ broadcaster_user_id?: number }> })?.data;
      const id = rows?.[0]?.broadcaster_user_id;
      if (typeof id === 'number') return id;
    } catch (err) {
      // A failed request says nothing about the other slug; the caller retries with its other token.
      console.error(`[MODERATION] Could not resolve user "${username}" (slug ${slug}): ${describeError(err)}`);
      return null;
    }
  }
  return null;
}

function describeError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    return `${status ? `HTTP ${status} ` : ''}${JSON.stringify(err.response?.data ?? err.message)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Keep a ban reason to plain text. On 2026-09-10, timeouts whose reason quoted
 * the reward title were missing from Kick's Mod actions feed, while the /timeout
 * command's unquoted reasons appeared, so quotes and backslashes are stripped.
 */
function plainReason(text: string): string {
  return text.replace(/["'`\\]/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const mins = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem ? `${mins}m ${rem}s` : `${mins} minute${mins === 1 ? '' : 's'}`;
}
