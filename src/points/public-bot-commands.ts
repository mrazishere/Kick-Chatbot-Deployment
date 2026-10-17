/**
 * The bot's ! commands for the public leaderboard's Commands tab, beside the currency
 * ones (public-commands.ts): every command file in bot-commands/ a viewer can type,
 * the channel's own custom commands, and the inline ones in the channel bot. Written
 * for viewers; each row is keyed to its command file, so a command the channel has
 * turned off (excludedCommands) or doesn't have set up is left out.
 *
 * A new command file belongs here too: the points selftest fails on a command file
 * with no row (or a reason it has none in NOT_LISTED).
 */

import type { PublicCommandRow, PublicCommandSection } from './public-commands';

/** A row, with the command file (bot-commands/<file>.ts) that answers it. */
type Row = PublicCommandRow & { file: string };

/** Command files with no row of their own, and why. */
export const NOT_LISTED: Record<string, string> = {
  autotranslate: 'no command: it translates chat by itself',
  points: 'the currency commands, listed by public-commands.ts',
  fish: 'the currency commands, listed by public-commands.ts',
  wordle: 'the currency commands, listed by public-commands.ts',
  wheel: 'listed by public-commands.ts with the currency games',
  customC: 'listed below from the channel\'s custom commands',
  numfacts: 'switched off in its file: numbersapi.com, its only source, is gone'
};

const AI: Row[] = [
  { file: 'claude', usage: '!claude <question>', does: 'Ask the bot anything (also @MrAIisHere <question>)', who: 'subs' },
  { file: 'claude', usage: '!research <question>', does: 'The bot searches the web before it answers', who: 'subs' },
  { file: 'chatsummary', usage: '!chatsummary', short: '!csum', does: 'What did I miss? The last half hour of chat in a few lines (also !catchup)' },
  { file: 'hallofshame', usage: '!hallofshame', does: 'Who the bot roasts hardest: most roasted, dumbest and most addicted' },
  { file: 'hallofshame', usage: '!hallofshame trolled | dumb | yap', does: 'Top 5 by savagery, by dumbness, or by sheer volume' },
  { file: 'hallofshame', usage: '!hallofshame [me | @user]', does: 'Your shame stats, or someone else\'s' },
  { file: 'claude', usage: '!claudeclear', does: 'Clear the bot\'s memory of this chat', who: 'mods' },
  { file: 'claude', usage: '!claudesystem <prompt>', does: 'Give the bot a new personality until !claudereset or a restart', who: 'mods' },
  { file: 'claude', usage: '!claudereset', does: 'Back to the bot\'s usual personality', who: 'mods' },
  { file: 'hallofshame', usage: '!hallofshame reset', does: 'Wipe the board', who: 'mods' }
];

const CLIPS: Row[] = [
  { file: 'clip', usage: '!clip [45s] [title]', does: 'Clip the last 30 seconds (5 to 90) of the stream and post the link' },
  { file: 'blerp', usage: '!blerp [11s] [title]', does: 'Clip the last 30 seconds (5 to 30) and suggest it as a Blerp sound', who: 'mods' }
];

const VIEWERS: Row[] = [
  { file: 'followage', usage: '!followage [@user]', short: '!fa', does: 'How long you (or they) have followed the channel' },
  { file: 'followage', usage: '!subage [@user]', does: 'Months subscribed' },
  { file: 'followage', usage: '!accountage [@user]', short: '!accage', does: 'How old a Kick account is' },
  { file: 'lastseen', usage: '!lastseen @user', short: '!seen', does: 'When they last chatted here' },
  { file: 'lastseen', usage: '!firstseen @user', does: 'When they first chatted here' },
  { file: 'remind', usage: '!remind @user <message>', does: 'Give them a message the next time they chat' },
  { file: 'remind', usage: '!remind @user in 2h <message>', does: 'Post it in 2 hours, pinging them (or "me" for yourself)' },
  { file: 'remind', usage: '!remind list', does: 'Your pending reminders' },
  { file: 'remind', usage: '!unremind <id>', does: 'Cancel one of your reminders' },
  { file: 'topc', usage: '!topc', does: 'The top 5 chatters this stream' }
];

const FUN: Row[] = [
  { file: 'minigames', usage: '!8ball <question>', does: 'Ask the magic 8-ball' },
  { file: 'minigames', usage: '!roll [20 | 5-10 | 2d6]', does: 'Roll 1 to 100, a range, or dice' },
  { file: 'minigames', usage: '!coinflip', short: '!cf', does: 'Heads or tails' },
  { file: 'minigames', usage: '!pick a b c', does: 'Pick one for you (also "a, b, c" or "a or b")' },
  { file: 'minigames', usage: '!percent [thing]', short: '!%', does: 'A random percentage, for anything you name' },
  { file: 'slots', usage: '!slots <words or emotes>', does: 'Spin three from your own words' },
  { file: 'slots', usage: '!slots pattern:7tv | kick | numbers 100', does: 'Spin the channel\'s 7TV or Kick emotes, or numbers' },
  { file: 'slots', usage: '!slots winners', does: 'The luckiest spins so far' },
  { file: 'cookie', usage: '!cookie', does: 'Your fortune cookie for the day' },
  { file: 'cookie', usage: '!cookie donate @user', does: 'Give today\'s cookie away' },
  { file: 'cookie', usage: '!cookie stats [@user] | top', does: 'Cookies eaten, gifted and received, or the top eaters' },
  { file: 'pokecatch', usage: '!catch', does: 'Catch a random Pokémon' },
  { file: 'jokes', usage: '!jokes [topic]', does: 'A joke, about the topic if you name one' },
  { file: 'dad', usage: '!dad [topic]', does: 'A dad joke' },
  { file: 'catfacts', usage: '!catfacts', does: 'A cat fact' },
  { file: 'dogfacts', usage: '!dogfacts', does: 'A dog fact' }
];

const TOOLS: Row[] = [
  { file: 'translate', usage: '!<language code> <text>', does: 'Translate text, like !es good morning or !ja thank you' },
  { file: 'dictionary', usage: '!define <word>', does: 'What a word means' },
  { file: 'fx', usage: '!fx [amount]', does: 'Convert money from where the stream is to the streamer\'s home currency' },
  { file: 'fx', usage: '!fx <FROM> <TO> [amount]', does: 'Convert between any two currencies, like !fx USD SGD 20' },
  { file: 'weather', usage: '!weather [place]', does: 'The weather where the stream is, or anywhere' },
  { file: 'earnings', usage: '!earnings', does: 'This stream\'s estimated earnings' },
  { file: 'kpp', usage: '!kpp', does: 'This stream\'s engagement score for Kick\'s partner payout' },
  { file: 'ping', usage: '!ping', does: 'Check the bot is awake' },
  { file: 'countd', usage: '!countd add <title> 5m', does: 'Start a countdown in chat (also list, edit, delete, + and -)', who: 'vips' }
];

const MODS: Row[] = [
  { file: 'streamstatus', usage: '!live | !offline', does: 'Tell the bot the stream just started or ended, so live-only and offline-only commands switch at once', who: 'mods' },
  { file: '', usage: '!location current set <place>', does: 'Where the stream is now, for the currency and weather commands (or home set)', who: 'mods' }
];

/** The channel config fields that decide which commands are set up. */
export interface BotCommandChannel {
  excludedCommands?: unknown;
  kpp?: { enabled?: unknown };
  earnings?: { enabled?: unknown };
  blerpStreamerId?: unknown;
}

/** A custom command as data/custom-commands/<channel>.json keeps it: [who, response, counter]. */
export type CustomCommands = Record<string, unknown>;

/** What a custom command does, for a viewer: its reply with the placeholders read out; a / command keeps its surprise. */
function customDoes(response: string): string {
  if (response.startsWith('/')) return 'A surprise 🤫';
  const text = response.replace(/\$user1/g, 'you').replace(/\$user2/g, 'them').replace(/\$counter/g, 'N').replace(/\s+/g, ' ').trim();
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** Whether a command file is on and set up for the channel. */
function setUp(file: string, cfg: BotCommandChannel, excluded: Set<string>): boolean {
  if (file && excluded.has(file.toLowerCase())) return false;
  if (file === 'kpp' || file === 'topc') return cfg.kpp?.enabled === true;
  if (file === 'earnings') return cfg.earnings?.enabled === true;
  if (file === 'blerp') return typeof cfg.blerpStreamerId === 'string' && cfg.blerpStreamerId.trim() !== '';
  return true;
}

/** The ! command sections for a channel, in the order the tab shows them. `pointsOn` gates !live / !offline. */
export function botCommandSections(cfg: BotCommandChannel, custom: CustomCommands | null, pointsOn: boolean): PublicCommandSection[] {
  const excluded = new Set(Array.isArray(cfg.excludedCommands) ? cfg.excludedCommands.map(c => String(c).toLowerCase()) : []);
  const keep = (rows: Row[]): PublicCommandRow[] => rows
    .filter(r => setUp(r.file, cfg, excluded) && (r.file !== 'streamstatus' || pointsOn))
    .map(({ file: _file, ...row }) => row);
  const sections: PublicCommandSection[] = [];
  const add = (title: string, rows: Row[], note?: string) => {
    const kept = keep(rows);
    if (kept.length) sections.push({ title, rows: kept, ...(note ? { note } : {}) });
  };

  add('AI', AI);
  add('Clips', CLIPS);
  add('Viewers', VIEWERS);
  add('Fun', FUN);
  add('Tools', TOOLS);

  if (!excluded.has('customc') && custom) {
    const rows: Row[] = Object.entries(custom).flatMap(([name, v]): Row[] => {
      if (!Array.isArray(v) || typeof v[1] !== 'string' || !/^[a-z0-9_]{1,30}$/i.test(name)) return [];
      const who = v[0] === 'y' ? 'mods' : v[0] === 'v' ? 'vips' : undefined;
      return [{ file: 'customC', usage: `!${name}`, does: customDoes(v[1]), ...(who ? { who } : {}) }];
    }).sort((a, b) => a.usage.localeCompare(b.usage));
    if (rows.length) {
      rows.push(
        { file: 'customC', usage: '!counter <command>', does: 'How many times a counting command has been used' },
        { file: 'customC', usage: '!acomm | !ecomm | !dcomm | !lcomm', does: 'Add, edit, delete or list custom commands', who: 'mods' }
      );
      add('Channel commands', rows, 'This channel\'s own commands. N is a running count.');
    }
  }

  add('Mods', MODS);
  return sections;
}

/** Every command file named in a row, for the selftest. */
export const LISTED_FILES: ReadonlySet<string> = new Set([...AI, ...CLIPS, ...VIEWERS, ...FUN, ...TOOLS, ...MODS].map(r => r.file).filter(Boolean));
