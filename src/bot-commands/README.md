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
| [Custom commands](#customcts--custom-commands) | `!acomm` · `!ecomm` · `!dcomm` · `!lcomm` · `!counter <name>` · `!<name>` | Mods+ (mgmt); `!counter` all users | All channels |
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
| Fishing | `$<currency> fish` · `sell` · `show` · `stats` · `top` · `trap` · `buy` · `steal` · `give` · `feed` · `duel` · `accept` · `deny` · `reel` · `remove` | All users (`remove` and `bigbite`: streamer and bot owner) | Channels with points and Fishing on (Points settings); `steal`, `give`, `feed` and `duel` where each is on too |
| Wheel | `!wheel` · `!wheel spin` (`!spin`) · `!wheel add` · `!wheel remove` · `!wheel history` | Streamer, bot owner, mods (viewers get no answer) | Channels with points and Fishing on (it spins on the fishing overlay) |
| Stream status | `!live` · `!offline` | Streamer, bot owner, mods (viewers get no answer) | Channels with points on: commands that only work live or offline follow it at once, until Kick's API agrees, a livestream webhook arrives, or 20 minutes pass (`LIVE_OVERRIDE_MS`). Payouts and reward pausing still follow Kick |
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
$don top [activetime|gamble] → top 5 by balance, active time, or net gamble winnings (10+ gambles)
$don leaderboard              → link to the public web leaderboard
$don commands                 → link to the leaderboard's Commands tab (also cm, help)
$don give @user 100           → send points to someone
$don gamble 100               → even money at the channel's win chance
$don gamble stats [@user]     → gambles, wins, win rate and net, all time
$don duel @user 100           → challenge a viewer; 50/50, winner takes both
$don accept|deny [@user]      → answer a challenge
$don cancel                   → withdraw your own challenge
$don raffle 5000 120          → open a raffle: 5000 split between winners, 120s (Mods+)
$don sraffle 5000 120         → same, but one winner takes it all (Mods+)
$don join                     → enter the open raffle, free, one entry each
$don fish [bait]              → go fishing; also sell, show, stats, top, trap, buy, steal (Fishing on; see Games)
$don raffle cancel            → close it without drawing (Mods+)
$don add|remove|set @user 500 → adjust a balance (broadcaster and bot owner only)
short forms                   → g gamble, gv give, d duel, a accept, dn deny, c cancel, rf raffle, sr sraffle, j join, t top, lb leaderboard, at activetime, ad add, rm remove, st set, f fish ($don g 100); after them: top g gamble, at activetime; gamble st stats; raffle c cancel; an amount of a is all ($don g a)
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
$don fish sell 🐟 🦐 3 🦀     → sell one or more kinds at once, each with an optional count ("🐟🦐🦀" works too), oldest first
$don fish sell all fish|junk  → sell a whole type, or both ("all fish junk"); "duplicate" keeps the biggest of each
$don fish sell 🦕 42cm 44cm 🦈 72cm  → sell those very fish by length (with kinds beside them: … 🐟 3); all or nothing for the lengths
$don fish show [user] [fish|junk|emoji]  → the collection, reel and purse; your own also shows your hook's tries; a fish (show 🦈, show shark) lists each one held by length with its level, duel stats and price
$don fish stats [user|global] → attempts, catches, traps, bait, sales, streaks, and steals where stealing is on
$don fish top [type]          → top 10: fish, coins, junk, lucky, unlucky, traps, attempts, thieves, caught, robbed, total-…, or an emoji
$don fish trap [cancel|reset] → lay traps (also net, trawl); no casting meanwhile; pings you when full if !remind is on
$don fish answer <x>          → answer a trap check (also ans), where trapCheck is on
$don fish buy [reel|hook|guard] → the shop: plain "buy" shows the next reel's price; "buy reel" buys it
$don fish steal @user         → steal one of their fish (also rob); needs a hook, see Stealing
$don fish give @user 🐟 [count] [72cm] → give fish or junk (also gift), where giveEnabled is on; a length gives that very fish
$don fish feed 🦈 72cm 🐟 🐟 🦀 → the first fish eats the rest and levels up (also fd, eat, evolve), where feedEnabled is on
$don fish remove @user 🦈 72cm 🐟 3 | all → the streamer and the bot owner take fish off a viewer (also rm, confiscate)
short forms                   → $don f is $don fish; then r reel, t trap, s sell, b buy, sh show, st stats, tp top, sl steal, gv give, fd feed, rm remove, d duel, a accept, dn deny, bb bigbite ($don f r <code>); the words after them too: bait w worm, f fly, c cricket; trap c cancel, r reset; buy r reel, h hook, g guard; sell a all, d duplicate; f fish, j junk; stats g global; top f c j l u t a th ca r and tf tc tj tl tu for the totals ($don f s a f j)
$don fish reel <code>         → answer a big bite with the code shown on the stream overlay
```

- A miss waits 30–90 seconds, a catch `catchCooldownMinutes` (30). Every fish has a length (1–100 cm), from a cast, a trap or a big bite, and your record is kept (casts only). On 1 catch in 3, Claude Haiku writes a short story (`stories`).
- **Odds and prices per catch:** every fish and junk item has a weight (its share of catches) and a sell price, set per channel on the dashboard (`games.catches`, overrides only). The defaults put fish in five rarity tiers, Common to Legendary (68% / 22% / 8% / 1.4% / 0.3% of fish), priced 25 / 60 / 150 / 400 / 1,500. A catch's rarity name comes from its share as the channel has the odds set.
- **Size and price:** a fish's price scales with its length (0.5× at 1 cm, 1× at 50 cm, 2× at 100 cm), a fish that beat an earlier record is worth 50% more, and each feeding level 25% more. Junk sells at its base price. Fish held from before every fish had a length (trap fish, 🐚, the 💎 and 👑 trophies, older catches) were given 50 cm on 2026-10-18, which kept their price and strength.
- **Reels:** bought in order with `buy reel`, each multiplying catch odds, the odds of rarer fish and the value of fish sold (`games.reels`; defaults Bamboo, Fiberglass, Carbon, Golden). `$don` and the public leaderboard name the reel a viewer holds.
- **Storage:** catches are kept until sold. The purse is the points balance (`game:fish_bait`, `game:fish_sell`, `game:fish_reel`… in the ledger). Each viewer's collection is a document in the channel's points database (`fish` table); every fish landed is also a row in `catches` (schema v6) for the rarest-catches board. A change and its payout are one transaction keyed on the Kick message id, so a replayed message acts once.
- Traps roll once a minute at 75–90% efficiency. A fish costs the rest of a catch cooldown, so a one-hour trap lands at most one fish, plus junk. Each fish gets a length like a cast's, shown in the haul (`🦀 (63 cm)`); a trap fish never sets a size record.
- **Trap checks** (`trapCheck`, our addition, off by default) are against macros that collect and re-lay traps around the clock. While the stream is offline, collecting full traps asks a question first `chancePercent` of the time (25): count an emoji in a row (2–9), add or subtract two numbers with one in words, pick the fish or the junk out of a numbered row of six, or say where an emoji sits in a row of six or seven. Every one can be answered with a plain number, so nobody on a phone has to copy an emoji; the emoji and its everyday names (plurals too: "socks") also count. Each needs working out, so a macro that sends a fixed message or copies text can't pass it, and each has enough possible answers that the tries don't let a guesser through. The haul waits for `$don fish answer <x>`: `tries` (3) within `answerSeconds` (30), and answers skip the 5s cooldown so a quick correction counts. Digits or words, emoji or name, and any case all match. Right, the traps are collected (and laid again after a `reset`). Out of tries or out of time, they come up empty and the player pays `finePercent` (15) of their balance. A timer ends the window on time; after a restart, the player's next trap command or answer does. `$don fish answer` with nothing after it repeats the question and isn't a try; cancelling the traps drops the question and the catch. **Cast checks** (`castChancePercent`, 0 is off) ask the same on that share of offline casts, against casting macros: the cast waits for the answer (casting and traps both wait meanwhile), a right one frees the line to cast again, and failing costs the same fine and leaves any traps alone. Pulling the traps (`trap cancel`) with a question waiting counts as failing it. The fine is set from the balance when the question is asked, so $DON moved away afterwards doesn't shrink it (failing takes at most what's left), and `$don give` and $DON duel challenges and accepts wait until it's answered. Stolen fish sell at their plain price, never with a reel bonus.
- Casting, laying traps and stealing follow `onlyWhileLive` and stay silent offline, like `$don gamble`. `onlyWhileOffline` is the reverse: silent while live, open offline (the two can't both be on; big bites only come while live, so none arrive). `steal.onlyWhileLive` gives stealing its own rule: live only, whatever those two say, so a channel can keep casting and traps offline and still have heists on stream. Selling, show, stats, top and the shop work any time.

**Picking a fish by length.** Fish of a kind differ only by length (and level), so a length after a fish picks that very one: `🦈 72cm`, `🦈72cm` and `🦈 72 cm` all work, and `cm` is needed (a bare number is a count or a wager). It works in `sell`, `give`, `feed`, `remove`, `duel`, `accept` and team battles (`fishSpecs`, `splitLengths` in `fish-duel.ts`; `parsePicks` in `fish.ts`). Of several the same length, `sell`, `give` and `remove` take the lowest level and a duel the highest. `fish show 🦈` and the leaderboard list the lengths held.

**Gifts** (`giveEnabled`, off by default; `giveCooldownSeconds`, 30): `$don fish give @user 🦈 2` hands one kind of fish or junk to anyone the bot knows, oldest first (a fed fish only when it's all that's left), or a certain fish by length. The length goes with it, the record bonus stays with whoever caught it, and a fed fish keeps its level. The reply always goes to chat.

**Bucket caps** (`maxFish`, `maxJunk`; 100 each, 0 for none). From 90% of a cap, every catch and haul warns how close it is. Past it, a new fish sells on the spot (its full price, the reel bonus too, paid at once) and new junk is binned for nothing; a fish won for keeps that doesn't fit sells too, at its plain price. A gift to a full bucket is refused (the giver keeps it), and a viewer with a full bucket can't steal. What a viewer held over a cap when it came in stays; only what's new goes (`overflow`, `capOf` in `community/fishing.ts`).

**Custom fish** (`customFish`, up to 20, set on the dashboard's Custom fish panel). Each has a name, odds on the same scale as the built-in fish (🐟 is 10, 🦈 0.5), a price for a 50 cm one and a duel type. The name is one emoji, or a word: one of the channel's emotes (letters, digits and `_`, starting with a letter), never a built-in catch or a word the commands use (`shark`, `junk`, `keeps`…). Custom fish are caught, sized, sold, given, stolen, fed and duelled like any fish, and their rarity comes from their odds. Viewers type the name in any case, and Kick's emote picker (`[emote:123:NAME]`) is read as the name. The overlay and the public leaderboard show the emote's image where the name is one of the channel's Kick or 7TV emotes; chat shows the name, with spaces around it so 7TV can draw it. They join `ITEMS` when a channel's settings are first read (`registerCustomFish`), but only the channel that lists one catches it; taking one off the list stops it being caught, and anyone holding one can still sell it at its last price.

**Feeding** (`feedEnabled`, on; `feedFailPercent`, 10). `$don fish feed 🦈 72cm 🐟 🐟 🦀`: the first fish named (without a length, the highest level, then longest, of its kind) eats the rest, named as for `sell` and all or nothing, and gains their sell value (no reel bonus) as XP. Going from level L to the next costs the fish's own value at level 0 × (L + 1), up to Lv10. Each level adds 10% duel health and attack (×2 at Lv10) and 25% value, so feeding never pays back more than the food was worth. A feeding fails `feedFailPercent` of the time: the food is gone and nothing is gained. Level and XP are on the held fish (`level`, `xp` on `HeldFish`; `addXp`, `levelCost` in `community/fishing.ts`) and go with it when it's given, stolen or won. `sell 🦈`, `give` and `sell duplicate fish` take fed fish last or never (`sell all fish` still sells them).

**Removing fish** (the streamer and the bot owner): `$don fish remove @user 🦈 72cm 🐟 3` takes those fish off a viewer for nothing, `all` takes every fish and `all junk` their junk too. Nothing goes if any of it isn't theirs. It isn't a sale: no currency moves and their selling stats stay. The reply always goes to chat, and each removal is logged.

**Fishing overlay.** Every fishing reply goes to an overlay feed (`overlay_feed`, schema v7, kept 5 minutes; `community/fish-overlay.ts`) that the dashboard serves as an OBS browser source: an animated fishing scene or text cards, each behind its own per-channel key (the bot page shows both links; add `&demo=1` for a demo rolled at the channel's real odds, which `games.overlayDemo` off shuts out even for an overlay already open, `&steals=1` to include steals). `games.overlaySizePercent` (50–300) sets how big it draws, and reaches an overlay already open in OBS within a couple of seconds, so a source that was shrunk to fit a corner can be made readable without touching OBS; it multiplies any `&scale=` on the link. `games.overlayClearWidthPercent` and `games.overlayClearHeightPercent` (0–80, both above 0 to apply) keep the source's bottom-right corner clear for something else on stream, a map say: the cards overlay stacks replies above it and roams big bite codes in the strip to its left, the scene keeps its lanes left of it, and a fish duel plays above it. `games.chatReplies` off sends every fishing reply to the overlay only while the stream is live with an overlay showing; offline, or with none open, chat still gets it. `games.onlyWhileOffline` keeps replies out of live chat the same way, whatever `chatReplies` says. A big bite's opening mention and result always go to chat. `games.streamDelaySeconds` (0–30) is how far the stream runs behind chat: the overlay plays that much ahead, big bite deadlines move that much later, and chat's duel and wheel results wait for it.

**Rarest catches and holdings.** The public leaderboard's Fishing tab lists every catch with its chance, rarity and price, and the five rarest fish ever landed with who landed them first and last. `src/tools/backfill-catches.ts` filled `catches` once from the bot log for fish landed before it existed. "Holding right now" ranks viewers by what their unsold fish would sell for, one line each; opening one shows every kind they hold and each fish by length, with its level, duel stats and price. Where stealing is on, "How stealing works" explains hooks, odds, fees, fines and guards from the channel's settings.

#### Big bites and trophies (`games.bigBite`, on by default; `community/big-bite.ts`)

While the stream is live **and** a fishing overlay is showing (it checks in with the bot as it polls; `overlay_seen_at` in the points `meta` table), the points service checks every 30 seconds and, about once every `everyMinutes` (30) of live stream, gives a big bite to a random viewer who chatted in the last `activeMinutes` (10). Each wait is `everyMinutes`, give or take up to two minutes, counted from the last bite (or from going live, a restart or the setting changing), and one that comes due with no overlay showing or nobody chatting is held until it can go out. Never the same viewer twice in a row, never the streamer, a bot or an excluded account. Chat names them, but the two-digit reel code appears **only on the overlay**, so a chat script can't copy it. Reeling in takes `pulls` (3) codes in a row: `$don fish reel <code>` within `windowSeconds` (30) for the first, then each right answer brings a new, harder code ("pull 2/3") with only `pullSeconds` (8). Codes escalate: two digits, then three characters, then four (up to six), from letters and numbers that can't be mistaken on a blurry stream (no 0/O, 1/I/L, 5/S, 8/B, 6/G, Z/2, Q), answered in any case. From the second pull the viewer can type just the code, without `$don fish reel`: only an exact match counts as an answer, and anything else they say is ordinary chat that loses nothing (with the command, a wrong code still loses it). From the second pull a code shows for `flashSeconds` (3) and then hides while its time runs (0 keeps it shown). The overlay counts each code down on the bot's clock, and an answer still counts up to 4 seconds after it hits zero, for the stream's delay. After the last pull the trophy is rolled and lands by its **land chance**, or it thrashes free and chat says what it was.

- Trophies come from their own pool, the **Mythic** tier above Legendary (🦖 and 🦄 replaced 💎 and 👑 on 2026-10-18, held ones renamed): 🦭 1,000, 🦦 1,500, 🦕 2,500, 🦖 4,000, 🦄 6,000, 🐉 25,000 (shares of big bites 30 / 25 / 20 / 10 / 10 / 5%; land chances 90 / 80 / 70 / 60 / 50 / 40%). A bite is worth about 1,500–2,000 on average once pulls and land chances are counted. Trophies are fish in every other way (length and records, sell, show, steal, rarest catches), but casts and traps never roll them, and their prices aren't scaled by `sellPricePercent`. Weights and prices are editable per channel like any catch.
- **Sniping** (`snipeSeconds`, 20; 0 is off): for about the first code's last `snipeSeconds`, give or take up to 3 seconds drawn at random per bite (never under 1s or over half of `windowSeconds`), anyone else who could get a big bite can take it. Chat posts `🪝 SNIPE OPEN!` with a **snipe code** of its own: two digits, never the overlay's, and only in that line, so nobody can type it ahead off the stream (pre-typed overlay codes let the same fast few win every bite). Snipes open once Kick has posted the line. The first `$don fish reel <snipe code>` takes the bite from the viewer it was for and reels on from the next pull as theirs, with the overlay's codes; chat says who took it. One try per sniper per bite: the overlay code or a wrong number uses it up (the reply says the snipe code is in chat), and a `reel` before the line is posted does too. Later pulls can't be sniped.
- A wrong code, no answer in time, or an answer within 2 seconds of a code showing (faster than the stream could show it) and it gets away. One answer per pull; `reel` skips the 5-second command cooldown only while a bite waits for that viewer.
- A big bite isn't a cast: landing one or losing it leaves the viewer's casting and cooldowns alone, and anyone chatting can get one, fished before or not.
- **The streamer (and the bot owner) can start one**: `$don fish bigbite` puts a big bite on a random active chatter now, `$don fish bigbite @viewer` on that viewer, `$don fish bigbite me` on themselves to try it, without the dice or the 10-minute gap. Big bites still have to be on, with an overlay showing and no other bite waiting; bots and anyone left out of points can't get one.
- **Chat gets two lines** (three with a snipe): the opening mention ("@viewer 🎣 Something BIG is on your line! A code is showing on stream now: type $don fish reel and that code within 30s…") and the result (landed, snapped or got away). The pulls in between play on the overlay only, so a bite doesn't flood chat.
- One bite per channel at a time, kept in memory: a restart lets a waiting one get away. The overlay's scene shows the code in the viewer's lane over a draining timer; the text cards show it on the card.
- Testers (`debugFishTesters`) can put one on themselves with `$don fish bigbite`, live or not; an overlay still has to be showing.

#### Stealing (`games.steal`, off by default)

```
$don fish buy hook            → a 🪝 grappling hook: 3 tries (150); one hook at a time
$don fish steal @user         → the hook grabs one random fish they've held 30+ minutes
$don fish buy guard           → protect your fish for 12 hours; priced on what they're worth (5%, at least 200)
```

- **A try:** the hook grabs one of the target's fish at random, weighted by how many of each they hold (fish landed or stolen in the last `graceMinutes` are safe). It works at the chance for that fish's rarity (40 / 30 / 20 / 10 / 5% Common to Legendary). Every try uses one hook try, a fee (3% of the fish's value, at least 10) and the fishing cooldown. Success moves the fish, length kept (not a record bonus, and not a catch). Caught, the thief also pays a fine. Fees and fines are burned: nobody receives them.
- **Balanced by the odds:** the fine is set from the fish's chance so that, on average, a try loses `edgePercent` (20%) of what it could expect to win, whether the hook grabs a frog or a whale: fine = (chance × value × 1.2 − fee) / (1 − chance), at least 25. Cheap fish don't repay the hook; valuable ones are a fair gamble with a house edge.
- **Must be able to pay:** a thief must hold the fee and fine for the target's costliest fish before trying; short of that, the try only uses a hook try and says how much they'd need.
- **Guards:** a guarded target turns every try away for one hook try and nothing else; the thief is told, the owner is pinged. A guard's time left is never shown in chat, not even to its owner, since chat is public.
- **Limits:** after a try that went ahead, the target is left alone for `protectMinutes` (60); one try per thief and target a day; the streamer, bots and excluded accounts are off limits; a thief must have fished at least once.
- **Heists:** each try is a row in `steals` (schema v8, with value, fee and fine since v9). The public leaderboard's Fishing tab shows the totals, master thieves, the hall of shame, the biggest heists, easy pickings, Fort Knox and a police blotter (`heistBoard` in `points/store.ts`). In chat, `top thieves`, `top caught` and `top robbed`.
- **Testing:** `points.debugFishTesters` (a list of lowercase names, set by editing the channel config; never shown or set by the dashboard; `debugStealTesters`, its old name, still works) lets those viewers cast, steal and get big bites where they're off or the stream is offline, target the bot's account, and skip the steal cooldown and once-per-target limits. Big bites still need an overlay showing.

#### Fish duels (`games.duel`, off by default; `community/fish-duel.ts`)

```
$don fish duel @user [2v2 | 3v3] [fish… | random] [amount | keeps]   → challenge them (also battle, fight); a length (🦈 72cm) sends that very fish
$don fish accept [fish… | random]              → fight it, with your strongest fish, the ones you name (lengths too), or any one you hold
$don fish deny                                 → turn it down, or take back your own challenge
```

- **The fight** is automatic, Pokémon-style: one fish each, alternating hits until one is out of hit points (after 40 turns, whoever has more of theirs left). The stats decide it and luck is kept small. Rarity is the fish's level and scales hit points and attack (Common ×1, Uncommon ×1.12, Rare ×1.25, Epic ×1.4, Legendary ×1.6, Mythic ×1.8). Length is its size: hit points are (70 + 0.3 × cm) × level and attack is 17 × level, 0.3% more for each cm over 50 and as much less for each under, so the bigger of two fish of a kind is always the better. A fish with no length fights at 50 cm. A coin flip says who strikes first; each hit swings ±35%, 6% miss and 12% are criticals (×1.6). Between otherwise even fish: 60 cm beats 50 cm about 6 in 10 and 70 cm about 7 in 10; one rarity step wins about 8 in 10, two about 95 in 100; a fight lasts about nine hits.
- **Types:** 🦷 Predator beats 💨 Swift, Swift beats 🪨 Armored, Armored beats Predator: ×1.08 damage with the advantage, ×0.94 against it, which wins about 7 in 10 between even fish and doesn't overturn a rarity step (an Uncommon still beats the Common that counters it about 6 in 10). The challenger's fish is named in the challenge, so the one answering can pick a counter.
- **Levels:** a fed fish's level adds 10% to its hit points and attack per level (`fighterOf`), so a fed fish can beat a longer one; descriptions say `Lv3`.
- **Who fights:** the strongest fish held (hit points × attack), or the biggest of the kind named. `random` (also `rand`, `rng`) sends a kind picked at random, each fish held an equal chance, and wins over a fish named beside it. A fish is named by its emoji or by word (`shark`, `turtle`, `whale` for 🐳 and `bluewhale` for 🐋, …; `WORDS` in `fish-duel.ts`), since while live `show` may only be on the overlay, where an emoji can't be copied. The challenger's choice is fixed when they ask; if they no longer hold that kind when it's accepted, the duel is off.
- **Stakes**, set by the challenger: nothing ("for glory"), an amount both must hold (the loser pays the winner when the duel is fought; `maxWager` caps it, forms as for gamble: 500, 5k, 50%, all), or `keeps` (the winner takes the loser's fighter, length and level kept; `allowKeeps`). For keeps both fish must be close in value, within 25% (`KEEPS_RATIO`): the challenger's is one the target holds a match for, and a plain accept sends the closest in value. Nothing is held while a challenge waits; balances and fish are checked again at the fight, in one transaction keyed on the accept message.
- **Team battles** (`2v2`, `3v3`): each side fields that many fish, fighting one at a time, Pokémon style; when one faints the next comes in, and the last side with a fish standing wins (a long fight is called on the share of hit points left). The challenger names up to three fish (kinds or lengths, in fighting order) and the strongest fill the rest; `random` picks any. The one answering does the same with `accept`. For keeps, the teams' total values must be within 25%, a plain accept sends the closest in value place by place, and the winner takes every fish on the losing team. The overlay shows both benches, each faint and each fish coming in (`teamFight`, `overlayTeamDuel`); chat's result waits for the extra switches (`SWITCH_MS`).
- **Limits:** one challenge at a time per viewer, either way; it runs out after `expirySeconds` (120); `cooldownSeconds` (60) between one viewer's challenges; bots and excluded accounts don't duel. Challenges wait in memory, so a restart drops the unanswered ones.
- **Where it shows:** the challenge and the result always go to chat (they have to reach the other viewer), whatever `chatReplies` says. So do a duel command's usage and error lines, where duels are on. The overlay gets a `duel` event with both sides and every turn and plays it back on a stage over the scene or cards, dimming them (a big bite's code is never dimmed, and a duel waits for one showing). With an overlay open, chat's result line waits until the fight has played (`playMs`). `&duel=1` on an overlay link previews one.
- **When:** `duel.onlyWhileLive` (on by default) keeps duels to live streams whatever the casting rule says; off, they follow `onlyWhileLive` / `onlyWhileOffline` like casting.
- **Records:** each duel is a row in `fish_duels` (schema v10); `lifetime.duel` on the fish document counts wins, losses, fish and currency won and lost. `top duelists`, a line in `stats`, and a Fish duels section on the public leaderboard's Fishing tab (`duelBoard` in `points/store.ts`).

Settings (`points.games`): `enabled`, `onlyWhileLive`, `onlyWhileOffline` (off), `catchOdds` (20; bait odds scale with it), `catchCooldownMinutes` (30), `trapMinutes` (60, at least 31), `sellPricePercent` and `baitPricePercent` (100), `stories` (on), `chatReplies` (on), `overlayDemo` (on), `overlaySizePercent` (100), `overlayClearWidthPercent` and `overlayClearHeightPercent` (0), `streamDelaySeconds` (0), `giveEnabled` (off), `giveCooldownSeconds` (30), `maxFish` and `maxJunk` (100; 0 is no cap), `feedEnabled` (on), `feedFailPercent` (10), `catches`, `customFish` (none), `reels`, `bigBite`: `enabled` (on), `everyMinutes` (30), `activeMinutes` (10), `windowSeconds` (30), `pulls` (3), `pullSeconds` (8), `flashSeconds` (3), `snipeSeconds` (20), `trapCheck`: `enabled` (off), `chancePercent` (25), `finePercent` (15), `answerSeconds` (30), `tries` (3), `castChancePercent` (0), and `steal`: `enabled`, `onlyWhileLive` (off), `hookPrice` (150), `hookUses` (3), `feePercent` (3), `feeMinimum` (10), `edgePercent` (20), `fineMinimum` (25), `oddsCommon`…`oddsLegendary` (40/30/20/10/5), `luckPercent` (0; raises every chance by that share while fines stay priced from the odds, so past 0 stealing pays on average), `graceMinutes` (30), `protectMinutes` (60), `guardPercent` (5), `guardMinimum` (200), `guardHours` (12), and `duel`: `enabled`, `onlyWhileLive` (on), `allowKeeps` (on), `expirySeconds` (120), `cooldownSeconds` (60), `maxWager` (0, no limit).

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

All three alike is a flush, reported with the odds beaten, `(1/n)²`, and logged for the winners board. No stakes. Emotes come from Kick's channel emote endpoint and 7TV, cached for an hour (`community/emotes.ts`). Fishing replies pick their emotes from the same list. After the hour the old list still answers at once while a new one loads behind it, so a reply never waits on 7TV (only the first load after a start does), and a source that fails keeps the emotes it gave last time.

## Spin the wheel

A prize wheel on the fishing overlay (`community/wheel.ts`, `bot-commands/wheel.ts`). The bot picks the result, every item equally likely; the overlay plays the spin landing on it and holds the result for 5 seconds, and chat gets `🎡 The wheel landed on: <item>!` once the stream has caught up (spin length plus 4 seconds).

```
!wheel                         → the items, numbered
!wheel spin   (or !spin)       → spin it; needs 2+ items and an overlay showing
!wheel add <item> | <item>     → add one or more (| between), up to 30 items of 30 characters, no duplicates
!wheel remove <item or number> → also rm, del
!wheel history                 → the last 5 spins: what it landed on, who spun it, how long ago (also hist, h)
```

All of it is for the streamer, the bot owner and mods; viewers get no answer.

- Fishing alerts wait on the overlay while the wheel is up: anything playing goes back to the front of the queue and plays in full afterwards. No duel starts meanwhile (one already playing is hidden), and no big bite starts while it spins (`community/wheel-state.ts`). A spin asked for while a big bite is on the line waits for it, up to 90 seconds.
- Items and settings live in `data/wheel/<channel>.json`: the items (a label and an optional `#rrggbb` colour; without one the overlay picks from its palette), `spinSeconds` (6, 3–20) and `removeWinner` (off; on, the landed item leaves the wheel once chat has the result). The dashboard edits them on the bot page (Spin the wheel); chat and the dashboard both change the file under a lock, and a dashboard save is refused if chat changed the wheel since it loaded.
- Every spin is a row in the points database's `wheel_spins` (schema v13): when, who, the result, its place and the items on the wheel then (`community/wheel-history.ts`). The dashboard's wheel card lists the last 50.
- The overlay link's `&wheel=1` spins a made-up wheel every 25 seconds, to place the source.

