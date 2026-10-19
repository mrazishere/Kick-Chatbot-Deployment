/**
 * The emotes a Kick channel can show: its own Kick emotes, Kick's globals and
 * emojis, and its 7TV set. Used by !slots patterns and by games that pick the
 * best emote the channel has from a list, the way supibot does.
 *
 * Kick's emote endpoint is internal and needs no auth; 7TV's is public. Both are
 * cached for an hour, and a failed fetch just means fewer emotes, never an error.
 */

import fetch from 'node-fetch';
import * as crypto from 'crypto';

export type EmoteSource = 'kick' | 'kick-global' | 'kick-emoji' | '7tv';

export interface Emote {
  name: string;
  source: EmoteSource;
  /** An image of it, for the overlay. */
  url?: string;
  /** Kick's id for a Kick emote: chat only shows one written as [emote:<id>:<name>]. */
  id?: number;
}

const CACHE_MS = 60 * 60_000;
const TIMEOUT_MS = 8000;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

const cache = new Map<string, { at: number; emotes: Emote[] }>();
const inflight = new Map<string, Promise<Emote[]>>();

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA }, timeout: TIMEOUT_MS });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function kickEmotes(channel: string): Promise<Emote[]> {
  const sets = await json(`https://kick.com/emotes/${encodeURIComponent(channel)}`) as Array<{ slug?: string; name?: string; emotes?: Array<{ id?: number; name?: string }> }>;
  const out: Emote[] = [];
  for (const set of Array.isArray(sets) ? sets : []) {
    const label = String(set.slug ?? set.name ?? '');
    const source: EmoteSource = label === 'Global' ? 'kick-global' : label === 'Emojis' ? 'kick-emoji' : 'kick';
    for (const e of set.emotes ?? []) {
      if (!e.name) continue;
      out.push(Number.isInteger(e.id) ? { name: e.name, source, id: e.id, url: `https://files.kick.com/emotes/${e.id}/fullsize` } : { name: e.name, source });
    }
  }
  return out;
}

async function sevenTvEmotes(kickUserId: number): Promise<Emote[]> {
  const data = await json(`https://7tv.io/v3/users/kick/${kickUserId}`) as { emote_set?: { emotes?: Array<{ id?: string; name?: string }> } };
  return (data.emote_set?.emotes ?? []).filter(e => e.name).map(e => {
    const id = typeof e.id === 'string' && /^[A-Za-z0-9]+$/.test(e.id) ? e.id : null;
    return id ? { name: e.name as string, source: '7tv' as const, url: `https://cdn.7tv.app/emote/${id}/2x.webp` } : { name: e.name as string, source: '7tv' as const };
  });
}

/**
 * Every emote the channel can show, cached for an hour. Once a channel has a
 * list, an expired one is still returned at once and refreshed behind the
 * caller: 7TV takes seconds and often its whole timeout, and a chat reply must
 * not wait on it. Only the first load after a start waits.
 */
export async function channelEmotes(channel: string, broadcasterUserId?: number | null): Promise<Emote[]> {
  const ch = channel.replace(/^#/, '').toLowerCase();
  const hit = cache.get(ch);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.emotes;
  const load = inflight.get(ch) ?? refresh(ch, broadcasterUserId);
  return hit ? hit.emotes : load;
}

function refresh(ch: string, broadcasterUserId?: number | null): Promise<Emote[]> {
  const load = (async () => {
    const stale = cache.get(ch)?.emotes ?? [];
    const results = await Promise.allSettled([
      kickEmotes(ch),
      broadcasterUserId ? sevenTvEmotes(broadcasterUserId) : Promise.resolve([] as Emote[])
    ]);
    const emotes: Emote[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') { emotes.push(...r.value); return; }
      console.warn(`[EMOTES] ${ch}: an emote source failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      // A source that failed keeps the emotes it gave last time.
      emotes.push(...stale.filter(e => (e.source === '7tv') === (i === 1)));
    });
    // Keep a failed fetch from being cached for an hour: with any source down, the next call tries again.
    const allOk = results.every(r => r.status === 'fulfilled');
    if (emotes.length) cache.set(ch, { at: allOk ? Date.now() : 0, emotes });
    return emotes;
  })().finally(() => inflight.delete(ch));
  inflight.set(ch, load);
  load.catch(() => {});
  return load;
}

/** The broadcaster's Kick user id, from the channel config the points service reads. */
export function broadcasterIdFor(config: { broadcasterUserId?: number; userId?: number }): number | null {
  const id = Number(config.broadcasterUserId ?? config.userId);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * A random emote from `wanted` that the channel has, or `fallback`. Mirrors
 * supibot's getBestAvailableEmote with shuffle on.
 */
export async function bestEmote(channel: string, broadcasterUserId: number | null, wanted: readonly string[], fallback: string): Promise<string> {
  let names: Set<string>;
  try {
    names = new Set((await channelEmotes(channel, broadcasterUserId)).map(e => e.name));
  } catch {
    return fallback;
  }
  const have = wanted.filter(w => names.has(w));
  return have.length ? have[crypto.randomInt(0, have.length)] : fallback;
}

/**
 * Image URLs for the channel's emotes that appear as words in `text`, for the
 * overlay. From the cache only, never a fetch: the reply that carries an emote
 * picked it through bestEmote, which filled the cache.
 */
export function emoteImages(channel: string, text: string): Record<string, string> {
  const emotes = cache.get(channel.replace(/^#/, '').toLowerCase())?.emotes ?? [];
  const words = new Set(text.split(/\s+/));
  const out: Record<string, string> = {};
  for (const e of emotes) {
    if (e.url && words.has(e.name) && !(e.name in out)) out[e.name] = e.url;
  }
  return out;
}

/**
 * Kick only draws a Kick emote in chat when the message has it as [emote:<id>:<name>]; a
 * viewer's chat box writes that for them, but a bot's plain "sukasbl00dcat" stays a word.
 * This writes the channel's Kick emotes in `text` that way (whole words, a bracket or
 * punctuation beside them is fine). 7TV emotes are left as words: viewers' extension draws
 * those. Never throws: on any trouble the text goes as it is.
 */
export function withKickEmotes(channel: string, text: string, broadcasterUserId?: number | null): string {
  try {
    // From what's cached, never waiting on a fetch: a reply goes at once and in order. A channel
    // not cached yet gets fetched meanwhile, for the replies after.
    const ch = channel.replace(/^#/, '').toLowerCase();
    const hit = cache.get(ch);
    if (!hit || Date.now() - hit.at >= CACHE_MS) channelEmotes(ch, broadcasterUserId).catch(() => {});
    const cached = hit?.emotes;
    if (!cached) return text;
    const emotes = cached
      .filter(e => (e.source === 'kick' || e.source === 'kick-global') && Number.isInteger(e.id) && text.includes(e.name));
    let out = text;
    for (const e of emotes) {
      const name = e.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(^|[\\s(\\[])${name}(?=$|[\\s).,!?:;\\]])`, 'g'), (m, pre: string, offset: number, all: string) =>
        // Already a code ("[emote:1:NAME]"): leave it.
        /\[emote:\d+:$/.test(all.slice(0, offset + pre.length)) ? m : `${pre}[emote:${e.id}:${e.name}]`);
    }
    // The codes are longer than the names: past Kick's 500 a message would be cut or refused.
    return out.length <= 500 ? out : text;
  } catch {
    return text;
  }
}
