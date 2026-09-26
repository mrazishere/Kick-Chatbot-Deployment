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
  const sets = await json(`https://kick.com/emotes/${encodeURIComponent(channel)}`) as Array<{ slug?: string; name?: string; emotes?: Array<{ name?: string }> }>;
  const out: Emote[] = [];
  for (const set of Array.isArray(sets) ? sets : []) {
    const label = String(set.slug ?? set.name ?? '');
    const source: EmoteSource = label === 'Global' ? 'kick-global' : label === 'Emojis' ? 'kick-emoji' : 'kick';
    for (const e of set.emotes ?? []) if (e.name) out.push({ name: e.name, source });
  }
  return out;
}

async function sevenTvEmotes(kickUserId: number): Promise<Emote[]> {
  const data = await json(`https://7tv.io/v3/users/kick/${kickUserId}`) as { emote_set?: { emotes?: Array<{ name?: string }> } };
  return (data.emote_set?.emotes ?? []).filter(e => e.name).map(e => ({ name: e.name as string, source: '7tv' as const }));
}

/** Every emote the channel can show, cached for an hour. */
export async function channelEmotes(channel: string, broadcasterUserId?: number | null): Promise<Emote[]> {
  const ch = channel.replace(/^#/, '').toLowerCase();
  const hit = cache.get(ch);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.emotes;
  const running = inflight.get(ch);
  if (running) return running;

  const load = (async () => {
    const results = await Promise.allSettled([
      kickEmotes(ch),
      broadcasterUserId ? sevenTvEmotes(broadcasterUserId) : Promise.resolve([] as Emote[])
    ]);
    const emotes: Emote[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') emotes.push(...r.value);
      else console.warn(`[EMOTES] ${ch}: an emote source failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    }
    // Keep a failed fetch from being cached for an hour when nothing came back.
    if (emotes.length) cache.set(ch, { at: Date.now(), emotes });
    return emotes;
  })().finally(() => inflight.delete(ch));
  inflight.set(ch, load);
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
