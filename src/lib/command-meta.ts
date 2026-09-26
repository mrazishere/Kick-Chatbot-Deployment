/**
 * Display metadata for the bot's commands.
 *
 * The authoritative list of commands is whatever modules exist in the bot's
 * dist/bot-commands directory — the API returns those names. This map only adds
 * human-readable labels; a command with no entry here still renders, using its
 * module name. That keeps a newly added command from silently disappearing
 * from the dashboard.
 */

export interface CommandMeta {
  label: string;
  trigger: string;
  description: string;
}

export const COMMAND_META: Record<string, CommandMeta> = {
  autotranslate: {
    label: "Auto Translate",
    trigger: "automatic",
    description: "Automatically translates non-English chat messages.",
  },
  blerp: {
    label: "Blerp",
    trigger: "!blerp",
    description:
      "Clips the last 30 seconds and files it in the streamer's Blerp soundboard queue for approval. Moderators and above; needs a Blerp account linked to the channel.",
  },
  catfacts: { label: "Cat Facts", trigger: "!catfacts", description: "Random cat fact." },
  chatsummary: { label: "Chat Summary", trigger: "!chatsummary / !catchup", description: "Summarises the last 30 minutes of chat with AI for people who just arrived. Once a minute per channel." },
  claude: {
    label: "Claude AI",
    trigger: "!claude or @MrAIisHere",
    description: "Ask the AI a question. Uses channel chat history and lore for context. With Vision on, @mentions also see the live stream.",
  },
  clip: {
    label: "Clip",
    trigger: "!clip",
    description:
      "Clips the last 30 seconds of the stream and posts the link. Open to everyone; the stream must be live.",
  },
  cookie: { label: "Fortune Cookie", trigger: "!cookie", description: "supibot's cookie: one fortune a day (a golden second one for subscribers), gift it with !cookie donate, !cookie stats and top." },
  countd: { label: "Countdown", trigger: "!countd", description: "Countdown timer overlay." },
  customC: {
    label: "Custom Commands",
    trigger: "!acomm / !dcomm",
    description: "Lets the channel define its own text commands.",
  },
  dad: { label: "Dad Jokes", trigger: "!dad", description: "Random dad joke." },
  dictionary: { label: "Dictionary", trigger: "!define", description: "Word definitions." },
  dogfacts: { label: "Dog Facts", trigger: "!dogfacts", description: "Random dog fact." },
  earnings: {
    label: "Earnings",
    trigger: "!earnings",
    description: "Estimated stream earnings. Restricted to supported channels.",
  },
  fish: { label: "Fishing", trigger: "$<currency> fish", description: "supibot's fishing game for points: cast, sell, show, stats, top, trap. Needs points and Fishing on (Points settings)." },
  followage: { label: "Followage", trigger: "!followage / !subage / !accountage", description: "How long someone has followed or subscribed here, and how old their Kick account is." },
  fx: { label: "Currency", trigger: "!fx", description: "Live currency conversion." },
  hallofshame: {
    label: "Hall of Shame",
    trigger: "!hallofshame",
    description: "Leaderboard of the channel's most-trolled AI users.",
  },
  jokes: { label: "Jokes", trigger: "!jokes", description: "Random joke." },
  kpp: {
    label: "KPP Estimate",
    trigger: "!kpp",
    description: "Kick Partner Program earnings estimate.",
  },
  lastseen: { label: "Last Seen", trigger: "!lastseen / !firstseen", description: "When someone last or first chatted in this channel. Switching it off also stops recording." },
  minigames: { label: "Mini Games", trigger: "!8ball !roll !coinflip !pick !percent", description: "Small chance commands with no stakes." },
  numfacts: { label: "Number Facts", trigger: "!numfacts", description: "Trivia about a number." },
  ping: { label: "Ping", trigger: "!ping", description: "Health check — confirms the bot is alive." },
  points: { label: "Loyalty Points", trigger: "$<currency> (e.g. $don)", description: "Balance, active time, top 5, giving, and adjustments by the broadcaster." },
  pokecatch: { label: "Pokécatch", trigger: "!catch", description: "Pokémon catching mini-game." },
  remind: { label: "Remind", trigger: "!remind / !unremind", description: "Leave someone a message for when they next chat, or set a timed reminder." },
  slots: { label: "Slots", trigger: "!slots", description: "supibot's slots: roll your words or the channel's emotes (pattern:7tv, pattern:kick) for a flush. No stakes." },
  topc: { label: "Top Chatters", trigger: "!topc", description: "Most active chatters." },
  translate: { label: "Translate", trigger: "!translate", description: "On-demand translation." },
  weather: { label: "Weather", trigger: "!weather", description: "Current weather for a location." },
};

export function commandMeta(name: string): CommandMeta {
  return (
    COMMAND_META[name] ?? {
      label: name,
      trigger: `!${name.toLowerCase()}`,
      description: "No description available.",
    }
  );
}
