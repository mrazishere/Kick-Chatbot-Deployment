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
import { botCommandSections, type BotCommandChannel, type CustomCommands } from './public-bot-commands';
import { LEVEL_STATS, LEVEL_VALUE, MAX_LEVEL } from '../community/fishing';

/**
 * The fishing leaderboards `fish top` answers to, with their short forms, as the
 * Commands tab names them. BOARDS and BOARD_SHORT in bot-commands/fish.ts are the
 * source; the points selftest checks this list matches them.
 */
export const FISH_BOARDS: { board: string; short: string; group: 'catch' | 'total' | 'steal' | 'duel' }[] = [
  { board: 'fish', short: 'f', group: 'catch' }, { board: 'coins', short: 'c', group: 'catch' }, { board: 'junk', short: 'j', group: 'catch' },
  { board: 'lucky', short: 'l', group: 'catch' }, { board: 'unlucky', short: 'u', group: 'catch' }, { board: 'traps', short: 't', group: 'catch' },
  { board: 'attempts', short: 'a', group: 'catch' },
  { board: 'total-fish', short: 'tf', group: 'total' }, { board: 'total-coins', short: 'tc', group: 'total' }, { board: 'total-junk', short: 'tj', group: 'total' },
  { board: 'total-lucky', short: 'tl', group: 'total' }, { board: 'total-unlucky', short: 'tu', group: 'total' },
  { board: 'thieves', short: 'th', group: 'steal' }, { board: 'caught', short: 'ca', group: 'steal' }, { board: 'robbed', short: 'r', group: 'steal' },
  { board: 'duelists', short: 'd', group: 'duel' }
];

function fishBoards(group: string): string {
  return FISH_BOARDS.filter(b => b.group === group).map(b => `${b.board} (${b.short})`).join(', ');
}

export interface PublicCommandRow {
  /** The command as typed in full, e.g. "$don gamble 100". */
  usage: string;
  /** The same, typed short, e.g. "$don g 100". */
  short?: string;
  does: string;
  /** Who may use it when it isn't everyone. */
  who?: 'subs' | 'vips' | 'mods' | 'streamer';
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

/**
 * How feeding levels a fish up, in full, for !claude to answer from (bot-commands/claude.ts):
 * the Commands tab row has room for the gist only. '' when feeding is off.
 */
export function feedingGuide(cfg: PointsConfig): string {
  const g = cfg.games;
  if (!g.enabled || !g.feedEnabled) return '';
  const f = `$${effectiveCommand(cfg)} fish`;
  return [
    `FEEDING (${f} feed 🦈 72cm 🐟 🐟 🦀, short ${f.replace(' fish', ' f')} fd): the first fish named eats the rest and gains what they would sell for as XP (their length and their own levels count).`,
    `Levels go up to Lv${MAX_LEVEL}. Each one adds ${LEVEL_STATS * 100}% to the fish's duel health and attack and ${LEVEL_VALUE * 100}% to its sell value.`,
    `Every level costs the same XP: ${LEVEL_VALUE * 100}% of the eater's own unlevelled price at its length, which is what the level adds to its value, so the food's worth goes into the fish and the duel stats come on top. A big or rare fish needs more food. One feeding can gain several levels; XP past Lv${MAX_LEVEL} is lost, and a Lv${MAX_LEVEL} fish can't eat.`,
    'Named without a length, the eater is your highest-level, then longest, fish of that kind. Food is fish only, never junk, named the same way as for selling (kinds, counts, lengths); it can be the same kind as the eater but not the eater itself. If any of the food is missing, nothing is eaten.',
    g.feedFailPercent > 0 ? `${g.feedFailPercent}% of feedings fail: the fish chokes, the food is gone and no XP is gained.` : 'Feedings never fail here.',
    `The reply shows the XP toward the next level, and ${f} show 🦈 lists each fish with its level (LvN), duel stats and price. Duels send your highest-level fish of a kind unless you name a length; selling or giving by kind uses unfed fish first, so fed fish are kept. A fed fish keeps its level when it is given away, stolen or lost in a duel.`
  ].join(' ');
}

/**
 * `channel`: the channel config, for the bot's ! commands it has on (public-bot-commands.ts),
 * !wheel among them; `custom`: its custom commands.
 */
export function publicCommands(cfg: PointsConfig, opts: { channel?: BotCommandChannel; custom?: CustomCommands | null } = {}): PublicCommands {
  const excluded = Array.isArray(opts.channel?.excludedCommands) ? opts.channel.excludedCommands.map(c => String(c).toLowerCase()) : [];
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
      ...(cfg.give.enabled ? [{ usage: `${c} give @user 100`, short: `${c} gv @user 100`, does: `Send ${cur} to someone` }] : []),
      ...(cfg.video.enabled ? [
        { usage: `${c} video <youtube link>`, short: `${c} v <link>`, does: `Play a YouTube video on stream, with sound, for ${cfg.video.pricePerSecond.toLocaleString('en-US')} ${cur} a second (up to ${cfg.video.maxSeconds}s; a ?t= start time works). One in line each, up to ${cfg.video.queueMax} waiting${cfg.video.onlyWhileLive ? ', while live' : ''}` },
        { usage: `${c} video`, short: `${c} v`, does: "What's playing and how many wait" },
        { usage: `${c} video skip`, short: `${c} v skip`, does: 'Skip the video playing (no refund)', who: 'mods' as const }
      ] : [])
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
  if (cfg.wordle.enabled) {
    games.push(
      { usage: `${c} wordle <word>`, short: `${c} w <word>`, does: `Guess the Wordle: 🟩 right place, 🟨 elsewhere in the word, ⬛ not in it. ${cfg.wordle.maxGuesses} guesses for the whole chat${cfg.wordle.prize > 0 ? `; the first to get it wins ${cfg.wordle.prize.toLocaleString('en-US')} ${cur}` : ''}` },
      { usage: `${c} wordle`, short: `${c} w`, does: 'The board so far, and the letters ruled out' },
      { usage: `${c} wordle guess <word>`, short: `${c} w g <word>`, does: 'The same, for a guess that is also a command word, like START' },
      { usage: `${c} wordle start`, short: `${c} w s`, does: 'Start a Wordle', who: 'mods' },
      { usage: `${c} wordle stop`, short: `${c} w x`, does: 'End it and show the word', who: 'mods' }
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
      note: [`${s} is short for ${f}.`, when, `Selling, show, stats, top${g.giveEnabled ? ', gifts' : ''} and the shop work any time.`,
        g.maxFish > 0 || g.maxJunk > 0 ? `You can hold ${[g.maxFish > 0 ? `${g.maxFish} fish` : '', g.maxJunk > 0 ? `${g.maxJunk} junk` : ''].filter(Boolean).join(' and ')}: past that, new fish sell on the spot and new junk is binned (you're warned from 90%).` : ''
      ].filter(Boolean).join(' '),
      rows: [
        { usage: f, short: s, does: 'Cast your line' },
        { usage: `${f} worm | fly | cricket`, short: `${s} w | f | c`, does: 'Buy bait and cast with it, for better odds' },
        { usage: `${f} trap`, short: `${s} t`, does: `Lay traps for ${g.trapMinutes} minutes, or collect them when they're full; no casting meanwhile` },
        { usage: `${f} trap cancel`, short: `${s} t c`, does: 'Pull your traps in early and lose the catch' },
        { usage: `${f} trap reset`, short: `${s} t r`, does: 'Collect full traps and lay them again' },
        ...(g.trapCheck.enabled ? [
          { usage: `${f} answer <x>`, short: `${s} ans <x>`, does: `Answer the question your full traps${g.trapCheck.castChancePercent > 0 ? ' or a cast' : ''} sometimes ask while the stream is offline: ${g.trapCheck.tries === 1 ? 'one try' : `${g.trapCheck.tries} tries`} within ${g.trapCheck.answerSeconds} seconds${g.trapCheck.finePercent > 0 ? `, or it costs ${g.trapCheck.finePercent}% of your ${cur} and the catch` : ', or you lose the catch'}` }
        ] : []),
        { usage: `${f} sell 🐟 🦐 3`, short: `${s} s 🐟 🦐 3`, does: 'Sell the kinds you name, each with an optional count (oldest first)' },
        { usage: `${f} sell 🦕 42cm 44cm 🦈 72cm`, short: `${s} s 🦈 72cm`, does: 'Sell certain fish by length, as many as you list (a count after a length sells more of it); nothing sells if one isn\'t yours' },
        { usage: `${f} sell all fish junk`, short: `${s} s a f j`, does: 'Sell every fish, every piece of junk, or both' },
        { usage: `${f} sell duplicate fish`, short: `${s} s d f`, does: 'Sell your duplicates, keeping the biggest of each' },
        { usage: `${f} show [@user] [fish | junk | 🦈]`, short: `${s} sh 🦈`, does: 'A collection, reel and purse; name a fish to list each one you hold by length, with its duel stats (❤️ health, ⚔️ attack) and price' },
        ...(g.giveEnabled ? [
          { usage: `${f} give @user 🐟 [count] [length]`, short: `${s} gv @user 🐟`, does: `Give one kind of fish or junk to someone, by emoji or name (2 sharks), oldest first, or a certain fish by its length (🦈 72cm)${g.giveCooldownSeconds > 0 ? `; ${g.giveCooldownSeconds}s between gives` : ''}` }
        ] : []),
        ...(g.feedEnabled ? [
          { usage: `${f} feed 🦈 72cm 🐟 🐟 🦀`, short: `${s} fd 🦈 🐟`, does: `Level a fish up: the first fish eats the rest and gains their sell value as XP. Each level (up to 10) adds 10% duel health and attack and 25% value${g.feedFailPercent > 0 ? `; ${g.feedFailPercent}% of feedings fail and the food is lost` : ''}` }
        ] : []),
        { usage: `${f} stats [@user | global]`, short: `${s} st`, does: 'Attempts, catches, traps, bait, sales and streaks' },
        { usage: `${f} top [board]`, short: `${s} tp`, does: `Top 10 on a board, fish by default: ${fishBoards('catch')}` },
        { usage: `${f} top total-fish`, short: `${s} tp tf`, does: `All-time boards: ${fishBoards('total')}` },
        ...(steal ? [{ usage: `${f} top thieves`, short: `${s} tp th`, does: `Stealing boards: ${fishBoards('steal')}` }] : []),
        ...(g.duel.enabled ? [{ usage: `${f} top duelists`, short: `${s} tp d`, does: 'Most fish duels won' }] : []),
        { usage: `${f} top 🐋`, short: `${s} tp 🐋`, does: 'Any fish or junk emoji: who holds the most of it' },
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
          { usage: `${f} duel @user [fish | random] [amount${g.duel.allowKeeps ? ' | keeps' : ''}]`, short: `${s} d @user`, does: `Challenge them to a fish duel with your strongest fish, the one you name (emoji or word, like shark; add its length for that very one, like 🦈 72cm) or a random one: for glory, for a ${cur} wager${g.duel.allowKeeps ? ", or for keeps (the winner takes the loser's fish)" : ''}` },
          { usage: `${f} duel @user 3v3 [fish fish fish | random] [amount${g.duel.allowKeeps ? ' | keeps' : ''}]`, short: `${s} d @user 3v3`, does: `A team battle (2v2 or 3v3): each side's fish fight one after another, Pokémon style, the next coming in when one faints, and the last side standing wins. Your strongest fish unless you name them (with a length for a certain one, like 🦈 72cm)${g.duel.allowKeeps ? '; for keeps, the winner takes every fish on the losing team' : ''}` },
          { usage: `${f} accept [fish | random]`, short: `${s} a`, does: 'Take up a duel, with your strongest fish, the one you name (🦈 72cm for that very one) or a random one (for a team battle, name up to 3)' },
          { usage: `${f} deny`, short: `${s} dn`, does: 'Turn a duel down, or take back your own challenge' }
        ] : []),
        ...(g.bigBite.enabled ? [
          { usage: `${f} reel <code>`, short: `${s} r <code>`, does: 'Answer a big bite with the code shown on stream' },
          { usage: `${f} bigbite [@user | me]`, short: `${s} bb`, does: 'Start a big bite now, on a random chatter, the one named, or yourself', who: 'streamer' as const }
        ] : []),
        { usage: `${f} overlay [on | off]`, short: `${s} ov off`, does: 'The fishing overlay isn\'t on stream: off sends every fishing reply to chat and pauses big bites, until on or the next stream', who: 'mods' as const },
        { usage: `${f} add @user 🦈 72cm 🐟 3`, short: `${s} ad @user 🦈`, does: 'Give a viewer fish or junk from nothing: by kind, length and count (no length: a random one), within their bucket caps; not counted as a catch', who: 'streamer' as const },
        { usage: `${f} remove @user 🦈 72cm 🐟 3`, short: `${s} rm @user 🦈`, does: 'Take fish off a viewer for nothing: by kind, length and count, or all (all junk for junk too); nothing goes if any isn\'t theirs', who: 'streamer' as const }
      ]
    });
  }

  if (g.enabled && opts.channel && !excluded.includes('wheel')) {
    sections.push({
      title: 'Wheel',
      note: 'The prize wheel spins on the stream overlay; chat gets the result.',
      rows: [
        { usage: '!wheel', does: 'List the items on the wheel', who: 'mods' },
        { usage: '!wheel spin', short: '!spin', does: 'Spin the wheel', who: 'mods' },
        { usage: '!wheel add <item> | <item>', does: 'Add one or more items, split with |', who: 'mods' },
        { usage: '!wheel remove <item or number>', short: '!wheel rm', does: 'Take an item off the wheel', who: 'mods' },
        { usage: '!wheel history', short: '!wheel h', does: 'The last 5 spins: where it landed, who spun it and when', who: 'mods' }
      ]
    });
  }

  if (opts.channel) sections.push(...botCommandSections(opts.channel, opts.custom ?? null, cfg.enabled));

  sections.push({
    title: 'Streamer',
    rows: [
      { usage: `${c} add @user 500`, short: `${c} ad @user 500`, does: `Add ${cur} to a viewer`, who: 'streamer' },
      { usage: `${c} remove @user 500`, short: `${c} rm @user 500`, does: `Take ${cur} from a viewer`, who: 'streamer' },
      { usage: `${c} set @user 500`, short: `${c} st @user 500`, does: `Set a viewer's ${cur}`, who: 'streamer' },
      { usage: '!config exclude add | remove <command>', does: 'Turn one of the bot\'s commands off or back on here (list shows them)', who: 'streamer' }
    ]
  });
  return { command: c, sections };
}
