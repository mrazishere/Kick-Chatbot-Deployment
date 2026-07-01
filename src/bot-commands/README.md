# Bot Commands

Each file exports a `CommandFn` that is registered in the channel config and dispatched by the main message handler.

## Command Reference

| Command | File | Trigger | Permission | Scope |
|---|---|---|---|---|
| Claude AI | `claude.ts` | `!claude <question>` or `@mention` | All users | All channels |
| Auto-translate | `autotranslate.ts` | Passive (non-English messages) | — | Channels with `autoTranslate.enabled` |
| Translate | `translate.ts` | `!<lang> <text>` (e.g. `!en Bonjour`) | All users (5/min) | All channels |
| Currency exchange | `fx.ts` | `!fx [place/FROM] [TO] [amount]` | All users (5/min) | All channels |
| Weather | `weather.ts` | `!weather [place]` | All users (5/min) | All channels |
| Earnings | `earnings.ts` | `!earnings` | All users | sukasblood only |
| KPP score | `kpp.ts` | `!kpp` | All users | sukasblood only |
| Top chatters | `topc.ts` | `!topc` | All users | sukasblood only |
| Countdown | `countd.ts` | `!countd add/edit/delete/list/+/-` | VIPs+ | All channels |
| Custom commands | `customC.ts` | `!acomm / !ecomm / !dcomm / !lcomm / !<name>` | Mods+ (mgmt), configured (exec) | All channels |
| Ping / uptime | `ping.ts` | `!ping` | All users | All channels |
| Dictionary | `dictionary.ts` | `!dict <word>` | All users | All channels |
| Dad jokes | `dad.ts` | `!dad [search term]` | All users (5/30s) | All channels |
| Jokes | `jokes.ts` | `!jokes [search term]` | All users | All channels |
| Cat facts | `catfacts.ts` | `!catfacts` | All users | All channels |
| Dog facts | `dogfacts.ts` | `!dogfacts` | All users | All channels |
| Number facts | `numfacts.ts` | `!numfacts [number]` | All users (4/30s) | All channels |
| Pokémon catch | `pokecatch.ts` | `!catch` | All users (3/30s) | All channels |

## Command Details

### `claude.ts` — Claude AI
Answers freeform questions via the Anthropic API. Two entry points:
- `!claude <question>` — direct invocation, rate-limited per user per channel.
- `@<botname> <message>` — mention-triggered; optionally captures live HLS stream frames (vision) and prepends them alongside reference photos of the streamer when `claude.vision.enabled` is set.

On every invocation, the preceding 10 lines of chat are captured as a "lore entry" (`<channel>-lore.jsonl`, capped at 100) and injected into the system prompt to give Claude rolling chat memory.

### `autotranslate.ts` — Passive auto-translation
Fires on every chat message when `autoTranslate.enabled` is true. Silently ignores commands, bot echoes, mixed-script messages, and short ambiguous Latin text. Only fires when a non-ASCII message is unambiguously non-English and Google Translate changes it. Opt-in rate cap via `autoTranslate.rateLimitPerMinute`.

### `translate.ts` — Manual translation
Triggered by `!<lang_code> <text>` (e.g. `!fr Hello`). Also responds to `!lang` / `!translate` with a usage hint. Language codes follow Google Translate ISO 639-1 conventions.

### `fx.ts` — Currency exchange
Uses ExchangeRate-API with 1-hour caching. Location names are resolved to ISO 4217 codes via Claude Haiku. Reads `config.location` for the channel's home and current location. Forms:
- `!fx` — current → home, 100 units
- `!fx <amount>` — current → home
- `!fx <place> [amount]` — place's currency → home
- `!fx <FROM> <TO> [amount]` — explicit codes

### `earnings.ts` — Stream earnings
Reads `data/earnings/<channel>/current.json` (live) and `sessions.json` (history). Live total is prorated between polls using `lastViewerCount × $0.10/viewer/hour`. Scoped to `sukasblood`.

### `kpp.ts` — KPP engagement score
Engagement-weighted score based on viewer-hours × chat-activity weight. Reports estimated $ if `config.kpp.dollarPerScore` is calibrated. Reads `data/kpp/<channel>/current.json` and `sessions.json`. Scoped to `sukasblood`.

### `topc.ts` — Top chatters
Shows top 5 chatters by message count from the current or most recent KPP session. Excludes `mraiishere`. Scoped to `sukasblood`.

### `countd.ts` — Countdown timers
VIP+ only. Persists countdowns to `data/countd.json` (crash inspection only — intervals are not restored on restart). Subcommands: `add`, `edit`, `delete`, `list`, `+` (increment counter), `-` (decrement counter).

### `customC.ts` — Custom commands
Mods manage commands from chat. Stored per-channel in `data/custom-commands/<channel>.json`. Response variables: `$counter`, `$user1`, `$user2`, `$percentage`, `$streamerp`, `$ynm`. Permission levels: `n` (all), `y` (mods), `v` (VIPs+).

## Adding a New Command

1. Create `src/bot-commands/<name>.ts` exporting a `CommandFn`.
2. Register it in `src/channels/template-kick-bot.ts` under `commands`.
3. Propagate to all live channel clones (see [channel-clone pattern](../../.claude/projects/-home-user-Kick-Chatbot-Deployment/memory/project_channel_clone_pattern.md)).
