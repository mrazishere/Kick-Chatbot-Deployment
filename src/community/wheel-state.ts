/**
 * Whether a channel's wheel is on the overlay right now, spinning or showing its
 * result. Its own module so big bites (big-bite.ts) can wait on it without the
 * two importing each other. In memory: a restart mid-spin only frees bites early.
 */

const busyUntil = new Map<string, number>();

const key = (channel: string): string => channel.replace(/^#/, '').toLowerCase();

export function wheelBusy(channel: string, now = Date.now()): boolean {
  return (busyUntil.get(key(channel)) ?? 0) > now;
}

export function markWheelBusy(channel: string, until: number): void {
  busyUntil.set(key(channel), until);
}

/** Selftest only. */
export function resetWheelBusy(): void {
  busyUntil.clear();
}
