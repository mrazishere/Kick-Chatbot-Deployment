/** Shared chat formatting and parsing for the community commands. */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A span as chat reads it, two units at most: "3d 4h", "2h 5m", "4m", "12s". */
export function span(ms: number): string {
  const t = Math.max(0, ms);
  if (t < MIN) return `${Math.floor(t / 1000)}s`;
  if (t < HOUR) return `${Math.floor(t / MIN)}m`;
  if (t < DAY) {
    const h = Math.floor(t / HOUR);
    const m = Math.floor((t % HOUR) / MIN);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(t / DAY);
  if (d >= 365) {
    const y = Math.floor(d / 365);
    const mo = Math.floor((d % 365) / 30);
    return mo ? `${y}y ${mo}mo` : `${y}y`;
  }
  if (d >= 60) {
    const mo = Math.floor(d / 30);
    const rd = d % 30;
    return rd ? `${mo}mo ${rd}d` : `${mo}mo`;
  }
  const h = Math.floor((t % DAY) / HOUR);
  return h ? `${d}d ${h}h` : `${d}d`;
}

/** YYYY-MM-DD in UTC. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const UNITS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: MIN, min: MIN, mins: MIN, minute: MIN, minutes: MIN,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
  d: DAY, day: DAY, days: DAY,
  w: 7 * DAY, wk: 7 * DAY, week: 7 * DAY, weeks: 7 * DAY
};

/**
 * Read a duration from the front of `words`: "2h", "1h30m", "90 minutes",
 * "1 day 2h". Returns the length and how many words it used, or null when the
 * first word isn't a duration.
 */
export function parseDuration(words: string[]): { ms: number; used: number } | null {
  let ms = 0;
  let i = 0;
  while (i < words.length) {
    const w = words[i].toLowerCase();
    // One word holding one or more number+unit pairs: 2h, 1h30m.
    if (/^(\d+(?:\.\d+)?[a-z]+)+$/.test(w)) {
      let ok = true;
      let sum = 0;
      for (const m of w.matchAll(/(\d+(?:\.\d+)?)([a-z]+)/g)) {
        const u = UNITS[m[2]];
        if (!u) { ok = false; break; }
        sum += Number(m[1]) * u;
      }
      if (!ok) break;
      ms += sum;
      i++;
      continue;
    }
    // A number, then its unit as the next word: 90 minutes.
    if (/^\d+(?:\.\d+)?$/.test(w) && i + 1 < words.length && UNITS[words[i + 1].toLowerCase()]) {
      ms += Number(w) * UNITS[words[i + 1].toLowerCase()];
      i += 2;
      continue;
    }
    break;
  }
  return i > 0 && ms > 0 ? { ms: Math.round(ms), used: i } : null;
}

/** A Kick username from chat input, without the @, or null. */
export function parseUsername(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/^@+/, '').replace(/[,.:!?]+$/, '');
  return /^[A-Za-z0-9_]{2,25}$/.test(name) ? name : null;
}

/** Per-key cooldown. Returns seconds left, or 0 and starts the cooldown. */
export function makeCooldown(ms: number): (key: string) => number {
  const until = new Map<string, number>();
  return (key: string): number => {
    const now = Date.now();
    const u = until.get(key) ?? 0;
    if (u > now) return Math.ceil((u - now) / 1000);
    until.set(key, now + ms);
    if (until.size > 5000) for (const [k, v] of until) if (v <= now) until.delete(k);
    return 0;
  };
}
