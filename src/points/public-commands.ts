/**
 * The currency commands as the public leaderboard's Commands tab lists them: what
 * each does, its short form, and who may use it, for the features this channel has
 * on. Written for viewers, so it lives apart from the README.
 *
 * The short forms here must match the ones the commands answer to
 * (SUBCOMMAND_ALIASES in bot-commands/points.ts, SUBCOMMANDS in bot-commands/fish.ts);
 * the points selftest checks that they do.
 */

import { PointsConfig } from '../types';
import { effectiveCommand } from './config';

export interface PublicCommandRow {
  /** The command as typed in full, e.g. "$don gamble 100". */
  usage: string;
  /** The same, typed short, e.g. "$don g 100". */
  short?: string;
  does: string;
  /** Who may use it when it isn't everyone. */
  who?: 'mods' | 'streamer';
}

export interface PublicCommandSection {
  title: string;
  note?: string;
  rows: PublicCommandRow[];
}

export interface PublicCommands {
  /** The command word with its $, e.g. "$don". */
  command: string;
  sections: PublicCommandSection[];
}

export function publicCommands(cfg: PointsConfig): PublicCommands {
  const c = `$${effectiveCommand(cfg)}`;
  const cur = cfg.currencyName;
  const g = cfg.games;
  const sections: PublicCommandSection[] = [];

  sections.push({
    title: cur,
    note: `Amounts can be typed as 100, 5k, 1.5m, 50% or all (a for short).`,
    rows: [
      { usage: c, does: `Your ${cur} and rank` },
      { usage: `${c} @user`, does: `Someone else's ${cur} and rank` },
      { usage: `${c} top`, short: `${c} t`, does: `Top 5 by ${cur}` },
      { usage: `${c} top activetime`, short: `${c} t at`, does: 'Top 5 by active time' },
      ...(cfg.gamble.enabled ? [{ usage: `${c} top gamble`, short: `${c} t g`, does: 'Top 5 gamblers by net winnings' }] : []),
      { usage: `${c} activetime [@user]`, short: `${c} at`, does: 'Active time and rank' },
      { usage: `${c} leaderboard`, short: `${c} lb`, does: 'A link to this page' },
      ...(cfg.give.enabled ? [{ usage: `${c} give @user 100`, short: `${c} gv @user 100`, does: `Send ${cur} to someone` }] : [])
    ]
  });

  const games: PublicCommandRow[] = [];
  if (cfg.gamble.enabled) {
    games.push(
      { usage: `${c} gamble 100`, short: `${c} g 100`, does: `Bet ${cur}: a win doubles it, a loss takes it` },
      { usage: `${c} gamble all`, short: `${c} g a`, does: 'Bet everything you have' },
      { usage: `${c} gamble stats [@user]`, short: `${c} g st`, does: 'Gambles, wins, win rate and net' }
    );
  }
  if (cfg.duel.enabled) {
    games.push(
      { usage: `${c} duel @user 100`, short: `${c} d @user 100`, does: 'Challenge a viewer: 50/50, the winner takes both stakes' },
      { usage: `${c} accept [@user]`, short: `${c} a`, does: 'Accept a challenge' },
      { usage: `${c} deny [@user]`, short: `${c} dn`, does: 'Turn a challenge down' },
      { usage: `${c} cancel`, short: `${c} c`, does: 'Withdraw your own challenge' }
    );
  }
  if (cfg.raffle.enabled) {
    games.push(
      { usage: `${c} join`, short: `${c} j`, does: 'Enter the open raffle, free, one entry each' },
      { usage: `${c} raffle 5000 120`, short: `${c} rf 5000 120`, does: `Open a raffle: 5000 ${cur} shared between the winners, drawn after 120 seconds`, who: 'mods' },
      { usage: `${c} sraffle 5000 120`, short: `${c} sr 5000 120`, does: 'The same, with one winner taking it all', who: 'mods' },
      { usage: `${c} raffle cancel`, short: `${c} rf c`, does: 'Close the raffle without drawing', who: 'mods' }
    );
  }
  if (games.length) sections.push({ title: 'Games', rows: games });

  if (g.enabled) {
    const f = `${c} fish`;
    const s = `${c} f`;
    const steal = g.steal.enabled;
    // Stealing has a live-only rule of its own; without it, it follows casting and traps.
    const ownRule = steal && g.steal.onlyWhileLive && !g.onlyWhileLive;
    const acts = steal && !ownRule ? 'Casting, traps and stealing' : 'Casting and traps';
    // Duels are live only by a rule of their own, the same way.
    const duelRule = g.duel.enabled && g.duel.onlyWhileLive && !g.onlyWhileLive;
    const when = [
      g.onlyWhileOffline ? `${acts} only work while the stream is offline.` : g.onlyWhileLive ? `${acts} only work while the stream is live.` : '',
      ownRule && duelRule ? 'Stealing and duels only work while the stream is live.' : ownRule ? 'Stealing only works while the stream is live.' : duelRule ? 'Duels only work while the stream is live.' : ''
    ].filter(Boolean).join(' ');
    sections.push({
      title: 'Fishing',
      note: [`${s} is short for ${f}.`, when, 'Selling, show, stats, top and the shop work any time.'].filter(Boolean).join(' '),
      rows: [
        { usage: f, short: s, does: 'Cast your line' },
        { usage: `${f} worm | fly | cricket`, short: `${s} w | f | c`, does: 'Buy bait and cast with it, for better odds' },
        { usage: `${f} trap`, short: `${s} t`, does: `Lay traps for ${g.trapMinutes} minutes, or collect them when they're full; no casting meanwhile` },
        { usage: `${f} trap cancel`, short: `${s} t c`, does: 'Pull your traps in early and lose the catch' },
        { usage: `${f} trap reset`, short: `${s} t r`, does: 'Collect full traps and lay them again' },
        ...(g.trapCheck.enabled ? [
          { usage: `${f} answer <x>`, short: `${s} ans <x>`, does: `Answer the question your full traps sometimes ask while the stream is offline: ${g.trapCheck.tries === 1 ? 'one try' : `${g.trapCheck.tries} tries`} within ${g.trapCheck.answerSeconds} seconds${g.trapCheck.finePercent > 0 ? `, or it costs ${g.trapCheck.finePercent}% of your ${cur} and the catch` : ', or you lose the catch'}` }
        ] : []),
        { usage: `${f} sell 🐟 🦐 3`, short: `${s} s 🐟 🦐 3`, does: 'Sell the kinds you name, each with an optional count' },
        { usage: `${f} sell all fish junk`, short: `${s} s a f j`, does: 'Sell every fish, every piece of junk, or both' },
        { usage: `${f} sell duplicate fish`, short: `${s} s d f`, does: 'Sell your duplicates, keeping the biggest of each' },
        { usage: `${f} show [@user] [fish | junk]`, short: `${s} sh`, does: 'A collection, reel and purse' },
        { usage: `${f} stats [@user | global]`, short: `${s} st`, does: 'Attempts, catches, traps, bait, sales and streaks' },
        { usage: `${f} top [type]`, short: `${s} tp`, does: 'Top 10 anglers: fish, coins, junk, lucky, unlucky, traps, attempts and more' },
        ...(g.reels.length ? [
          { usage: `${f} buy`, short: `${s} b`, does: 'The gear shop: your reel and the next one\'s price' },
          { usage: `${f} buy reel`, short: `${s} b r`, does: 'Buy the next reel, for better odds, rarer fish and higher prices' }
        ] : []),
        ...(steal ? [
          { usage: `${f} buy hook`, short: `${s} b h`, does: 'A grappling hook, needed to steal' },
          { usage: `${f} buy guard`, short: `${s} b g`, does: 'A guard to watch your fish' },
          { usage: `${f} steal @user`, short: `${s} sl @user`, does: 'Try to steal one of their fish' }
        ] : []),
        ...(g.duel.enabled ? [
          { usage: `${f} duel @user [fish | random] [amount${g.duel.allowKeeps ? ' | keeps' : ''}]`, short: `${s} d @user`, does: `Challenge them to a fish duel with your strongest fish, the one you name (emoji or word, like shark) or a random one: for glory, for a ${cur} wager${g.duel.allowKeeps ? ", or for keeps (the winner takes the loser's fish)" : ''}` },
          { usage: `${f} accept [fish | random]`, short: `${s} a`, does: 'Take up a duel, with your strongest fish, the one you name or a random one' },
          { usage: `${f} deny`, short: `${s} dn`, does: 'Turn a duel down, or take back your own challenge' }
        ] : []),
        ...(g.bigBite.enabled ? [
          { usage: `${f} reel <code>`, short: `${s} r <code>`, does: 'Answer a big bite with the code shown on stream' },
          { usage: `${f} bigbite [@user | me]`, short: `${s} bb`, does: 'Start a big bite now, on a random chatter, the one named, or yourself', who: 'streamer' as const }
        ] : [])
      ]
    });
  }

  sections.push({
    title: 'Streamer',
    rows: [
      { usage: `${c} add @user 500`, short: `${c} ad @user 500`, does: `Add ${cur} to a viewer`, who: 'streamer' },
      { usage: `${c} remove @user 500`, short: `${c} rm @user 500`, does: `Take ${cur} from a viewer`, who: 'streamer' },
      { usage: `${c} set @user 500`, short: `${c} st @user 500`, does: `Set a viewer's ${cur}`, who: 'streamer' }
    ]
  });
  return { command: c, sections };
}
