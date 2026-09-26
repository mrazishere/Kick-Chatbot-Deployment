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
| [Loyalty points](#pointsts--loyalty-points) | `$<currency> [subcommand]` | All users · broadcaster/owner to adjust | Channels with points enabled |
| [Hall of Shame](#hallofshamets--ai-hall-of-shame) | `!hallofshame [sub]` · `!shame` | All users (Mods+ to reset) | All channels |
| [Clip](#clipts--clip) | `!clip [45s] [title]` | All users (1/min) | All channels |
| [Blerp](#blerpts--blerp-sound-suggestions) | `!blerp [11s] [title]` | Mods+ (1 per 5 min) | Channels with `blerpStreamerId` |
| Remind | `!remind @user [in 2h] msg` · `!remind me in 30m msg` · `!remind list` · `!unremind id` | All users (5 pending each) | All channels |
| Last seen | `!lastseen @user` · `!seen` · `!firstseen @user` | All users (1/5s) | All channels, this channel's chat only |
| Followage | `!followage [@user]` · `!fa` · `!subage` · `!accountage` | All users (1/5s) | All channels |
| Chat summary | `!chatsummary` · `!csum` · `!catchup` | All users (1/min per channel) | All channels |
| Mini games | `!8ball` · `!roll [20\|5-10\|2d6]` · `!coinflip` · `!pick a b c` · `!percent` | All users (1/5s) | All channels |
| Fishing | `$<currency> fish` · `sell` · `show` · `stats` · `top` · `trap` | All users | Channels with points and Fishing on (Points settings) |
| Slots | `!slots words…` · `!slots pattern:7tv` · `!slots winners` | All users (1/5s) | All channels |
| Fortune cookie | `!cookie` · `donate @user` · `stats` · `top` | All users (1/10s) | All channels |

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
!jokes stack overflow    → joke containing the phrase "stack overflow"
```

Search terms may be several words; the whole phrase is passed to the API. Matching is
a substring, so `!jokes cat` can return a joke containing "dupli**cat**e". `safe-mode`
is always on. A search with no results says so rather than reporting the API as down.

**Rate limit:** 5 requests per 30 seconds per user.

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

## `points.ts` — Loyalty points

A StreamElements-style loyalty currency, kept per channel in SQLite. Viewers earn while
they chat during a live stream, then spend on giving, gambling and duels.

The trigger is the currency itself: the command word is derived from `currencyName` in the
channel config, so `$DON` answers to `$don` and `$AZ` to `$az`. It starts with `$` rather
than `!` so the command reads like the money. Set `currencyCommand` to override.

### Usage

```
$don                          → your balance and rank
$don @user                    → someone else's balance and rank
$don activetime [@user]       → active time and rank
$don top [activetime]         → top 5 by balance, or by active time
$don leaderboard              → link to the public web leaderboard
$don give @user 100           → send points to someone
$don gamble 100               → even money at the channel's win chance
$don duel @user 100           → challenge a viewer; 50/50, winner takes both
$don accept|deny [@user]      → answer a challenge
$don cancel                   → withdraw your own challenge
$don raffle 5000 120          → open a raffle: 5000 split between winners, 120s (Mods+)
$don sraffle 5000 120         → same, but one winner takes it all (Mods+)
$don join                     → enter the open raffle, free, one entry each
$don fish [bait]              → go fishing; also sell, show, stats, top, trap (Fishing on; see Games)
$don raffle cancel            → close it without drawing (Mods+)
$don add|remove|set @user 500 → adjust a balance (broadcaster and bot owner only)
```

Amounts accept `100`, `5k`, `1.5m`, `50%` and `all`.

### Permissions

| Subcommand | Who |
|---|---|
| balance, `activetime`, `top`, `leaderboard` | All users |
| `give`, `gamble`, `duel` / `accept` / `deny` / `cancel` | All users, when that feature is enabled |
| `raffle`, `sraffle`, `raffle cancel` | Moderators and above |
| `add`, `remove`, `set` | Broadcaster and bot owner only — **not** moderators |

Moderators skip the read cooldowns but cannot change balances.

### Earning

Points accrue on a tick while the stream is live, to accounts that chatted inside the
active window. Subscribers earn at `subscriberMultiplier`. Follows, subs, gifted subs and
Kicks pay configurable one-off bonuses, each applied exactly once by idempotency key.
Timeouts charge the viewer per second.

**Active time** is time spent chatting while live, counted in 10-minute steps. Kick exposes
no viewer list, so someone who watches in silence cannot be counted — which is why it is
called active time and not watch time.

### Raffles

Modelled on the StreamElements raffle. A moderator opens one with a prize and a duration,
viewers enter **free** with `$don join` — one entry each, however often they type it — and
the prize is paid when it closes. `raffle` splits between `winners` people (3 by default),
`sraffle` gives it all to one.

The prize is **minted**, not taken from anyone, which is why it is capped three ways:

| Setting | Default | What it stops |
|---|---|---|
| `raffle.maxPrize` | 100000 | One mod minting an unbounded prize |
| `raffle.maxPerStream` | 5 | Raffle after raffle inflating the economy |
| `raffle.maxDurationSeconds` | 600 | One left open all stream, blocking the next |

Cancelled raffles don't count against the per-stream allowance, since nothing was paid.

Only one raffle runs at a time, enforced in the schema rather than in memory, so a restart
mid-raffle cannot produce two. Entries and the open raffle live in SQLite: a raffle that
closes while the bot is down is drawn on the next sweep rather than lost. Joins are silent
by design — a busy raffle would otherwise post one line per viewer — and the entry count is
announced with the result. If fewer people enter than there are winner slots, everyone wins;
an uneven split gives the odd points to the earliest entrants, so the whole prize is paid.

### Notes

- Gambling and duels stay **silent** when disabled, on cooldown, or the stream is offline.
  The reason is logged rather than posted, to keep chat clean.
- A duel holds the challenger's stake until it is accepted, denied, cancelled or expires.
  Pending duels survive a restart and are refunded on sweep.
- A subcommand word beats a username — write `@top` to look up a viewer called `top`.
- A bare word that is not a known viewer gets no reply, because chat writes things like
  "$DON to the moon" in ordinary sentences.
- Per-user read cooldown 10s; channel-wide cooldown 30s on `top` and `leaderboard`.

---

## `hallofshame.ts` — AI Hall of Shame

A joke leaderboard built from `!claude` usage: who the bot roasts hardest, and who asks the
dumbest questions. The `!claude` handler captures the material and a lazy async LLM pass
scores each exchange 0–10 for dumbness and savagery.

### Usage

```
!hallofshame            → overview: most roasted, dumbest, most addicted
!hallofshame trolled    → top 5 by average savagery, plus the hardest roast ever
!hallofshame dumb       → top 5 by average dumbness, plus the dumbest question ever
!hallofshame yap        → top 5 by sheer volume (Certified Yappers)
!hallofshame me         → your own shame stats
!hallofshame @user      → another viewer's stats
!hallofshame reset      → wipe the board (Mods+)
```

**Alias:** `!shame`. The bot owner (`KICK_OWNER`) never lands on the board — `claude.ts`
skips the capture entirely for them, so nothing is recorded in the first place.

---

## `clip.ts` — Clip

Creates a real Kick clip of the last 30 seconds and posts the link.

### Usage

```
!clip              → clip the last 30 seconds
!clip <title>      → same, with your own title (50 chars max)
!clip 45s [title]  → the last 45 seconds instead (5–90s; Kick keeps a 90-second buffer)
```

With no title the clip is named `<stream title> - clipped by <user>`, trimmed to fit.

Kick publishes no clips API, so this drives the same internal calls the site makes when a
viewer presses the clip button, authenticated as the bot account. Clips therefore show the
**bot** as their creator. The session token is watched by a watchdog so an expired one is
renewed before a viewer hits it.

**Cooldowns:** 60s per user, 15s per channel.

---

## `blerp.ts` — Blerp sound suggestions

Clips the stream like `!clip`, imports that clip into [Blerp](https://blerp.com) as a sound,
and files it in the streamer's suggestion queue.

### Usage

```
!blerp                 → suggest the last 30 seconds
!blerp <title>         → same, with your own title
!blerp 11s [title]     → the last 11 seconds instead (5–30s; Blerp caps at 30)
```

**Permission:** moderators and above.
**Cooldowns:** 5 minutes per user, 60s per channel.

Nothing here plays on stream by itself. A suggestion sits as `PENDING` until the streamer
approves it in their own Blerp dashboard, so the worst a bad `!blerp` costs is one queue
entry they can reject.

Two things to know before changing it:

- The target is `config.blerpStreamerId`, not a lookup by Kick username. Streamers can hold
  several Blerp accounts and the one their Kick name is registered against may be dormant,
  so resolving at runtime would file suggestions into an inbox nobody reads.
- The clip is made first and stays made. If the Blerp half fails, the clip is still good, so
  the reply hands over the clip link rather than pretending the whole thing failed.

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

---

## Community commands — `remind.ts`, `lastseen.ts`, `followage.ts`, `chatsummary.ts`

Stored per channel in `data/community/<channel>.sqlite` (see `src/community/store.ts`).

- **Remind:** without a time, the reminder is delivered the next time the target chats here (two per message at most). With `in <time>` (`2h`, `1h30m`, `90 minutes`, 1 minute to 365 days) it is posted at that time; the timer starts with the first chat message after a restart, and a reminder that fell due while the bot was down is posted marked late.
- **Last seen:** every chat message updates the table. On the first run the table is filled from the channel's PM2 log, so first-seen dates reach back as far as the log does. It only knows this channel.
- **Followage:** Kick's internal `kick.com/api/v2/channels/<channel>/users/<user>` (no auth) returns `following_since`, `subscribed_for` and `created_at`. Undocumented; a failure answers in chat. Cached 60s.
- **Chat summary:** the last 30 minutes of chat from the log (commands left out) go to Claude Haiku as quoted, untrusted text; the reply has its @ signs removed so nobody is pinged.

## Games — `minigames.ts`, `fish.ts`, `slots.ts`, `cookie.ts`

Fishing, slots and the cookie are ports of [supibot](https://github.com/supinic/supibot)'s `$fish`, `$slots` and `$cookie`: the same rules, numbers and messages, in our own code (supibot is AGPL-3.0, so its code and its fortune list aren't copied). Supibot's web leaderboards are chat replies here, and its whisper and Discord options have no Kick equivalent.

**Format rule:** anything that uses the loyalty points is a currency subcommand, `$<currency> <subcommand>`. Fishing pays in the currency, so it's `$don fish` and exists only where the channel has points on **and** `points.games.enabled` (Fishing on the dashboard's Points card); there `!fish` only points to the `$` form. The cookie and slots don't touch points, so they're `!cookie` and `!slots` on every channel.

### `$don fish` — fishing (`fish.ts`, `community/fishing.ts`)

```
$don fish                     → cast: 1 in 20 lands a fish, else 1 in 4 snags junk
$don fish worm|fly|cricket    → buy bait and use it on the spot: 1/16, 1/14, 1/12 (2, 5, 8 $DON)
$don fish skipStory:true      → no AI story if you catch something
$don fish sell 🐠 [n]         → sell a catch (fish 50, junk 1–20)
$don fish sell all fish|junk  → sell a whole type; "duplicate" keeps one of each
$don fish show [user] [fish|junk|emoji]  → the collection and purse (also count, display, collection)
$don fish stats [user|global] → attempts, catches, traps, bait, sales, streaks
$don fish top [type]          → top 10: fish, coins, junk, lucky, unlucky, traps, attempts, total-…, or an emoji
$don fish trap [cancel|reset] → lay traps for an hour (also net, trawl); no casting meanwhile
$don fish buy                 → nothing yet, as in supibot
```

- A miss waits 30–90 seconds, a catch `catchCooldownMinutes` (30). Fish have a size (1–100 cm) and your record is kept. On 1 catch in 3, Claude Haiku writes a short story (`stories`).
- Catches are kept until sold. The purse is the points balance: bait is a `game:fish_bait` debit, selling a `game:fish_sell` credit. Each viewer's catch lives in the channel's points database (`fish` table, schema v5), so a sale and its payout are one transaction, keyed on the Kick message id so a replayed message acts once.
- Traps roll once a minute at 75–90% efficiency. A fish costs the rest of a catch cooldown, so a one-hour trap lands at most one fish, plus junk.
- Casting and laying traps follow `onlyWhileLive` and stay silent offline, like `$don gamble`. Selling, show, stats and top work any time.
- Settings (`points.games`): `enabled`, `onlyWhileLive`, `catchOdds` (20; bait odds scale with it), `catchCooldownMinutes` (30), `trapMinutes` (60, at least 31), `sellPricePercent` and `baitPricePercent` (100), `stories` (on).

### `!cookie` — fortune cookie (`cookie.ts`)

```
!cookie                → today's fortune (also !cookie eat); resets at midnight UTC
!cookie donate @user   → give your daily cookie away (also gift, give)
!cookie stats [@user]  → eaten, received, gifted, and a karma verdict from scrooge to saint
!cookie top            → the channel's biggest cookie eaters
```

A channel subscriber gets a second, golden cookie a day, which can't be gifted. You can only gift to someone who has eaten their own cookie and has no gift waiting, and a gift must be eaten the same UTC day. Stored in `data/community/<channel>.sqlite`; the subscriber flag for a gift's receiver comes from the last-seen table.

### `!slots` (`slots.ts`)

```
!slots a b c ...             → roll three from your words or emotes
!slots pattern:7tv           → the channel's 7TV emotes (also kick = its own Kick emotes, gachi, numbers N)
!slots winners               → the flushes that beat the longest odds (also leader, leaders, leaderboard)
```

All three alike is a flush, reported with the odds beaten, `(1/n)²`, and logged for the winners board. No stakes. Emotes come from Kick's channel emote endpoint and 7TV, cached for an hour (`community/emotes.ts`).
