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
  catfacts: { label: "Cat Facts", trigger: "!catfacts", description: "Random cat fact." },
  claude: {
    label: "Claude AI",
    trigger: "!claude or @MrAIisHere",
    description: "Ask the AI a question. Uses channel chat history and lore for context. With Vision on, @mentions also see the live stream.",
  },
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
  numfacts: { label: "Number Facts", trigger: "!numfacts", description: "Trivia about a number." },
  ping: { label: "Ping", trigger: "!ping", description: "Health check — confirms the bot is alive." },
  points: { label: "Loyalty Points", trigger: "$<currency> (e.g. $don)", description: "Balance, active time, top 5, giving, and adjustments by the broadcaster." },
  pokecatch: { label: "Pokécatch", trigger: "!catch", description: "Pokémon catching mini-game." },
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
