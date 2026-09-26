/**
 * Routing for points games. Anything that uses the loyalty points is a currency
 * subcommand, so a points game exists only where the channel has points on and
 * points.games.enabled set, and is played as `$<cmd> <game>`. Anywhere else it
 * isn't available at all.
 */

import { effectiveCommand } from '../points/config';
import { getPointsService } from '../points/service';

/**
 * How a message invokes `game`, or null when it doesn't.
 *
 * - 'currency': `$<cmd> fish` where the channel has its points games on.
 * - 'redirect': `!fish` there; answer with a pointer to the `$` form.
 *
 * Where the games are off there is no form at all. `args` are the words after
 * the game's name; `usage` is how to call it.
 */
export function gameInvocation(
  message: string, channel: string, game: string
): { form: 'currency' | 'redirect'; args: string[]; usage: string } | null {
  const words = message.trim().split(/\s+/);
  const first = (words[0] ?? '').toLowerCase();
  const svc = getPointsService(channel.replace(/^#/, '').toLowerCase());
  const cfg = svc?.config();
  const cmd = cfg && cfg.enabled && cfg.games.enabled ? effectiveCommand(cfg) : null;
  if (!cmd) return null;
  if (first === `$${cmd}` && (words[1] ?? '').toLowerCase() === game) {
    return { form: 'currency', args: words.slice(2), usage: `$${cmd} ${game}` };
  }
  return first === `!${game}` ? { form: 'redirect', args: words.slice(1), usage: `$${cmd} ${game}` } : null;
}
