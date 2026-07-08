# Bot Commands

Each file exports a `CommandFn` registered in the channel config and dispatched by the main message handler. Commands are prefixed with `!` unless noted as passive.

---

## Quick Reference

| Command | Trigger | Permission | Scope |
|---|---|---|---|
| [Claude AI](#claudets--claude-ai) | `!claude <question>` · `@MrAIisHere <msg>` | Subs, Mods, Founders, VIPs | All channels |
| [Research](#claudets--claude-ai) | `!research <query>` | Subs, Mods, Founders | All channels |
| [System prompt](#claudets--claude-ai) | `!claudesystem` · `!claudereset` · `!claudeclear` | Mods+ | All channels |
| [Auto-translate](#autotranslatets--auto-translate) | Passive (non-English chat) | — | `autoTranslate.enabled` channels |
| [Translate](#translatets--translate) | `!<lang> <text>` | All users (5/min) | All channels |
| [Currency exchange](#fxts--currency-exchange) | `!fx [args]` | All users (5/min) | All channels |
| [Weather](#weatherts--weather) | `!weather [place]` | All users (5/min) | All channels |
| [Earnings](#earningsts--stream-earnings) | `!earnings` | All users | sukasblood only |
| [KPP score](#kppts--kpp-score) | `!kpp` | All users | sukasblood only |
| [Top chatters](#topcts--top-chatters) | `!topc` | All users | sukasblood only |
| [Countdown](#countdts--countdown-timers) | `!countd <subcommand>` | VIPs+ | All channels |
| [Custom commands](#customcts--custom-commands) | `!acomm` · `!ecomm` · `!dcomm` · `!lcomm` · `!<name>` | Mods+ (mgmt) | All channels |
| [Dictionary](#dictionaryts--dictionary) | `!define <word>` | All users | All channels |
| [Ping / uptime](#pingts--ping) | `!ping` | All users | All channels |
| [Dad jokes](#dadts--dad-jokes) | `!dad [term]` | All users (5/30s) | All channels |
| [Jokes](#jokests--jokes) | `!jokes [term]` | All users | All channels |
| [Cat facts](#catfactsts--cat-facts) | `!catfacts` | All users | All channels |
| [Dog facts](#dogfactsts--dog-facts) | `!dogfacts` | All users | All channels |
| [Number facts](#numfactsts--number-facts) | `!numfacts [number]` | All users (4/30s) | All channels |
| [Pokémon catch](#pokecatchts--pokémon-catch) | `!catch` | All users (3/30s) | All channels |

---

## `claude.ts` — Claude AI

Powered by the Anthropic API. Maintains a per-channel conversation history (last 50 exchanges) and injects recent chat moments ("lore") into the system prompt so replies are grounded in what's happening in the stream.

### Commands

| Command | Who can use | Description |
|---|---|---|
| `!claude <question>` | Subs, VIPs, Mods, Founders, Broadcaster | Ask Claude anything (text only) |
| `!research <query>` | Subs, VIPs, Mods, Founders, Broadcaster | Ask with live Brave web search results |
| `@MrAIisHere <message>` | Subs, VIPs, Mods, Founders, Broadcaster | Mention trigger — with live stream vision (see below) |
| `!claudesystem <prompt>` | Mods+ | Replace the active system prompt |
| `!claudereset` | Mods+ | Reset system prompt to default |
| `!claudeclear` | Mods+ | Wipe the channel's conversation history |

### Examples

```
!claude what's the best poker hand?
!research latest news on Kick.com
!claudesystem You are a pirate. Respond only in pirate speak.
!claudereset
!claudeclear
@MrAIisHere what is he playing right now?
@MrAIisHere roast sukasblood
```

### Vision on @mention

When `claude.vision.enabled` is set in the channel config, `@MrAIisHere` triggers a live video capture pipeline before the reply is generated:

1. **HLS resolution** — resolves the channel's live stream URL.
2. **Frame capture** — uses `ffmpeg` to grab **3 frames ~2 seconds apart** from the live stream.
3. **Reference photos** — loads any saved reference photos of the streamer from disk (used as the source of truth for who the streamer is).
4. **Vision API call** — all frames + reference photos are sent to `claude-sonnet-5` alongside the user's message. Claude can see what's on screen right now and answer in context.

If the stream is offline, ffmpeg fails, or the HLS token expires, the capture is silently skipped and Claude replies text-only as normal. The HLS cache is invalidated automatically on a 403/410 and retried once.

**Channel config to enable:**
```json
"claude": {
  "vision": {
    "enabled": true
  }
}
```

### Lore (rolling chat memory)

On every `!claude` or `@mention` call, the preceding 10 chat lines are captured from the channel's PM2 log as a "lore entry" and appended to `<channel>-lore.jsonl` (capped at 100 entries, oldest evicted). All stored lore is injected into the system prompt of subsequent calls so Claude has context for inside jokes, regulars, and ongoing stream events.

### Notes
- Broadcaster and bot owner bypass the per-user cooldown.
- `!claude` uses text-only API path. `@mention` uses the vision path (when enabled).
- Per-user cooldown applies to subs/VIPs; mods/broadcaster/owner are exempt.

---

## `autotranslate.ts` — Auto-translate

Passive — fires automatically on every chat message when `autoTranslate.enabled` is `true` in the channel config. No user command needed.

Silently skips: `!`-prefixed commands, bot's own messages, mixed-script messages, short/ambiguous Latin text, and messages where Google returns English as the source language. Only fires when translation actually changes the message.

**Config options (channel config):**
```json
"autoTranslate": {
  "enabled": true,
  "rateLimitPerMinute": 10
}
```

---

## `translate.ts` — Translate

Manually translate text using Google Translate. Trigger is `!<language_code> <text>`.

### Examples

```
!en Bonjour comment ça va
!fr Hello how are you
!ja Good morning everyone
!zh 你好吗
!pinyin 你好吗        ← returns romanized pronunciation
!romaji おはよう      ← returns romaji pronunciation
!lang                  ← shows usage hint
!translate             ← shows usage hint
```

### Supported language codes (common)

| Code | Language | Code | Language |
|---|---|---|---|
| `en` | English | `ar` | Arabic |
| `fr` | French | `zh` / `cn` | Chinese |
| `de` | German | `ja` | Japanese |
| `es` | Spanish | `ko` | Korean |
| `pt` | Portuguese | `ru` | Russian |
| `it` | Italian | `hi` | Hindi |
| `tr` | Turkish | `vi` | Vietnamese |
| `pinyin` | Chinese → romanized | `romaji` | Japanese → romaji |

Full list: [Google Translate language codes](https://cloud.google.com/translate/docs/languages)

**Rate limit:** 5 requests per 60 seconds per user.

---

## `fx.ts` — Currency exchange

Converts currencies using live exchange rates (ExchangeRate-API, cached 1 hour). Location names are resolved to ISO 4217 currency codes via Claude Haiku. Reads `config.location.home` and `config.location.current` from the channel config.

### Usage

```
!fx                          → 100 <current currency> to <home currency>
!fx <amount>                 → <amount> <current> to <home>
!fx <place> [amount]         → place's currency to home currency
!fx <FROM> <TO> [amount]     → explicit ISO codes
```

### Examples

```
!fx                          → 100 THB = 2.91 SGD (2025-06-30)
!fx 5000                     → 5000 THB = 145.50 SGD (2025-06-30)
!fx japan 10000              → 10000 JPY = 88.40 SGD (2025-06-30)
!fx USD SGD 100              → 100 USD = 134.20 SGD (2025-06-30)
!fx won 50000                → 50000 KRW = 37.80 SGD (2025-06-30)
```

**Rate limit:** 5 requests per 60 seconds per user. **Requires** `EXCHANGERATE_API_KEY` env var.

---

## `weather.ts` — Weather

Shows current weather using [wttr.in](https://wttr.in) (no API key required). Defaults to the channel's current location (`config.location.current`).

### Examples

```
!weather                     → weather at channel's current location
!weather Tokyo               → weather in Tokyo
!weather New York            → weather in New York
!weather Thailand            → weather in Thailand
```

**Sample output:**
```
@user, Bangkok TH ⛅: 34°C / 93°F, Partly Cloudy, Humidity: 72%, Wind: 18 km/h S
```

**Rate limit:** 5 requests per 60 seconds per user.

---

## `earnings.ts` — Stream earnings

Shows estimated stream earnings at $0.10/viewer/hour. Scoped to `sukasblood` channel only — silently ignored elsewhere.

### Usage

```
!earnings
```

**Sample output (live stream):**
```
@user, Stream earnings: $4.20 | 1h 30m | ~28 viewers avg (live, updating)
```

**Sample output (last session):**
```
@user, Last stream: $12.80 | 4h 15m | ~30 viewers avg
```

Live total is prorated in real-time between 5-minute polls so the figure stays current without waiting for the next tick.

---

## `kpp.ts` — KPP score

Shows the channel's engagement-weighted KPP estimate. Score = viewer-hours × chat-activity weight. If `config.kpp.dollarPerScore` is calibrated against a real KPP statement, it also shows a $ estimate. Scoped to `sukasblood` only.

### Usage

```
!kpp
```

**Sample output:**
```
@user, KPP score: 142.3 pts | ~$3.55 est | 2h 10m | chat: 🔥 strong (12.4%)
```

**Calibration** (channel config):
```json
"kpp": {
  "dollarPerScore": 0.025
}
```

---

## `topc.ts` — Top chatters

Shows the top 5 chatters by message count from the current or most recent KPP session. Scoped to `sukasblood` only.

### Usage

```
!topc
```

**Sample output:**
```
@user, Top 5 chatters this stream: 1. viewer1 (142) 2. viewer2 (98) 3. viewer3 (74) 4. viewer4 (61) 5. viewer5 (45)
```

---

## `countd.ts` — Countdown timers

VIPs and above only. Starts named countdown timers that post updates to chat at set intervals. Up to 5 active countdowns per channel. Persisted to `data/countd.json`.

### Usage

```
!countd list                        → list all active countdowns
!countd add <title> <duration>      → start a countdown
!countd edit <title> <duration>     → change time on an active countdown
!countd delete <title>              → remove a countdown
!countd + <title>                   → increment the counter on a countdown
!countd - <title>                   → decrement the counter on a countdown
```

### Duration format

| Suffix | Meaning | Example |
|---|---|---|
| `s` | seconds | `30s` |
| `m` | minutes | `5m` |
| `h` | hours | `2h` |

Max duration: 24h.

### Examples

```
!countd add race 5m              → starts "race" countdown for 5 minutes
!countd add giveaway 30s         → starts "giveaway" countdown for 30 seconds
!countd + race                   → increments race counter (e.g. "race x3")
!countd edit race 2m             → changes race countdown to 2 minutes remaining
!countd delete race              → removes race countdown
!countd list                     → race: 3m 42s (x3), giveaway: 12s
```

**Note:** Intervals are not restored after a bot restart. The file is for crash inspection only.

---

## `customC.ts` — Custom commands

Mods create, edit, and delete custom chat commands directly from chat. Commands are stored per-channel in `data/custom-commands/<channel>.json`.

### Management commands (Mods+)

```
!acomm <access> <name> <response>   → add a command
!ecomm <access> <name> <response>   → edit an existing command
!dcomm <name>                       → delete a command
!lcomm                              → list all commands
```

`<access>` values:
| Value | Who can trigger |
|---|---|
| `n` | All users |
| `y` | Mods and above |
| `v` | VIPs and above |

### Examples

```
!acomm n hype HYPE HYPE HYPE $user1 is going crazy!
!acomm n lurk @$user1 is now lurking... used $counter times
!acomm v giveaway 🎁 Giveaway started by @$user1!
!acomm y so @$user1 says... $ynm
!ecomm n hype LET'S GOOOO $user1!!
!dcomm hype
!lcomm
```

### Response variables

| Variable | Value |
|---|---|
| `$counter` | Number of times the command has been used |
| `$user1` | Username of the person who typed the command |
| `$user2` | Username of the @-mentioned user in the message |
| `$percentage` | Random percentage (0–100%) |
| `$streamerp` | Random % — but always 10,000,000% if `$user2` is the streamer |
| `$ynm` | Random: Yes / No / Maybe |

---

## `dictionary.ts` — Dictionary

Looks up word definitions using the [Free Dictionary API](https://dictionaryapi.dev/).

### Examples

```
!define serendipity
!define ephemeral
```

**Sample output:**
```
@user, serendipity: the occurrence and development of events by chance in a happy or beneficial way.
```

---

## `ping.ts` — Ping

Checks if the bot is online and shows how long it has been running.

### Example

```
!ping
```

**Sample output:**
```
@user, Pong! Bot is online. Uptime: 3h 42m 15s
```

---

## `dad.ts` — Dad jokes

Fetches dad jokes from [icanhazdadjoke.com](https://icanhazdadjoke.com/).

### Examples

```
!dad                     → random dad joke
!dad chicken             → dad joke containing "chicken"
!dad time                → dad joke containing "time"
```

**Rate limit:** 5 requests per 30 seconds per user.

---

## `jokes.ts` — Jokes

Fetches jokes from [JokeAPI](https://v2.jokeapi.dev/).

### Examples

```
!jokes                   → random joke
!jokes programming       → programming joke
!jokes dark              → dark humor joke
```

---

## `catfacts.ts` — Cat facts

Fetches a random cat fact from [catfact.ninja](https://catfact.ninja/).

### Example

```
!catfacts
```

---

## `dogfacts.ts` — Dog facts

Fetches a random dog fact from the dog facts API.

### Example

```
!dogfacts
```

---

## `numfacts.ts` — Number facts

Fetches number facts from [numbersapi.com](http://numbersapi.com/).

### Examples

```
!numfacts                → random number fact
!numfacts 42             → fact about the number 42
!numfacts 1969           → fact about 1969
```

**Rate limit:** 4 requests per 30 seconds per user.

---

## `pokecatch.ts` — Pokémon catch

Catches a random Pokémon.

### Example

```
!catch
```

**Sample output:**
```
@user, You caught a wild Bulbasaur! (#001) — Grass/Poison type
```

**Rate limit:** 3 requests per 30 seconds per user.

---

## Disabling commands per channel

Any command can be disabled for a specific channel without touching code. The list is stored in the channel's config JSON as `excludedCommands` and can be managed live from chat (broadcaster only):

```
!config exclude add <commandname>     → disable a command for this channel
!config exclude remove <commandname>  → re-enable a disabled command
!config exclude list                  → list all currently disabled commands
```

The `<commandname>` value is the function name as registered in the channel config (e.g. `fx`, `translate`, `claude`, `dad`). Changes take effect immediately — no restart required.

**Example** — disable currency exchange and dad jokes for a channel:
```
!config exclude add fx
!config exclude add dad
!config exclude list    → Disabled commands: fx, dad
```

The `excludedCommands` array is also editable directly in the channel's config JSON (`data/channel-configs/<channel>.json`) if you prefer to set it at deploy time rather than from chat.

---

## Adding a New Command

1. Create `src/bot-commands/<name>.ts` exporting a `CommandFn` (see `src/types/index.ts`).
2. Register it in `src/channels/template-kick-bot.ts` under `commands`.
3. Propagate to all live channel clones — fixes go to the template first, then every active clone.
