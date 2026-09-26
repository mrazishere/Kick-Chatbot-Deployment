# Kick Chatbot

A multi-channel chatbot for [Kick.com](https://kick.com), written in TypeScript on the official Kick Developer API (OAuth 2.1). One bot account serves many channels: each channel runs as its own PM2 process with its own settings, and streamers enroll themselves through a web flow.

It does AI chat with Claude (with a live look at the stream), a StreamElements-style loyalty points currency, channel-point rewards that time people out, clips, reminders, chat games and a set of utility and fun commands. A companion web dashboard (a separate project) edits each channel's settings through the bot's internal API.

## Features

- **Claude AI:** `!claude` and `@mentions`, with per-channel memory, chat "lore", web search (`!research`) and optional vision on the live stream.
- **Loyalty points:** a per-channel currency earned by chatting while live and from follows, subs, gifted subs and Kicks. Viewers can give, gamble, duel and join raffles; moderators can adjust. Timeouts cost points. Public leaderboard.
- **Channel-point rewards:** redemptions mapped to moderation actions (timeout, roulette, pardon, shield).
- **Community:** `!remind`, `!lastseen`/`!firstseen`, `!followage`/`!subage`/`!accountage`, and `!chatsummary` ("what did I miss?").
- **Chat games:** ports of supibot's fishing (`$don fish`, played for points: cast, sell, show, stats, top, trap), slots (`!slots`) and fortune cookie (`!cookie`), plus `!8ball`, `!roll`, `!coinflip`, `!pick` and `!percent`.
- **Stream tools:** `!clip`, `!blerp` sound suggestions, countdown overlay (`!countd`), KPP and earnings estimates, top chatters, Hall of Shame.
- **Utilities:** translation (on demand and automatic), weather, currency conversion, dictionary, jokes and facts, custom text commands.
- **Operations:** self-service enrollment, per-channel command toggles, token refresh with a cross-process lock, reconnect and self-healing, Telegram alerts.

The full command reference, with permissions, cooldowns and examples, is in **[src/bot-commands/README.md](src/bot-commands/README.md)**.

## Commands at a glance

| Area | Commands |
|---|---|
| AI | `!claude`, `@<bot>`, `!research`, `!claudesystem`, `!claudereset`, `!claudeclear`, `!chatsummary` |
| Points | `$<currency>` (e.g. `$don`) with `give`, `gamble`, `duel`, `accept`, `deny`, `raffle`, `join`, `fish`, `top`, `activetime`, `leaderboard`, `add`/`remove`/`set` |
| Community | `!remind`, `!unremind`, `!lastseen`, `!seen`, `!firstseen`, `!followage`, `!fa`, `!subage`, `!accountage` |
| Games | `$<currency> fish` (points channels), `!slots`, `!cookie`, `!8ball`, `!roll`, `!coinflip`, `!pick`, `!percent`, `!catch` |
| Stream | `!clip`, `!blerp`, `!countd`, `!kpp`, `!earnings`, `!topc`, `!hallofshame` |
| Utility | `!<lang>` translate, `!weather`, `!fx`, `!define`, `!ping` |
| Fun | `!dad`, `!jokes`, `!catfacts`, `!dogfacts`, `!numfacts` |
| Channel admin | `!acomm`/`!ecomm`/`!dcomm`/`!lcomm` custom commands, `!config exclude add/remove/list`, `!location` |

## How it works

```
                    ┌────────────────────────────┐
 streamer ── OAuth ─▶ enrollment service         │  dist/mr-ai-bot-enrollment.js
                    │  • /kick-bot-enroll flow   │  • writes data/channel-configs/<ch>.json
 dashboard ─ HTTP ──▶  • internal settings API   │  • clones the channel template
                    └──────────────┬─────────────┘  • starts it under PM2
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   kick-<channel A>         kick-<channel B>          kick-<channel C>     one PM2 process each
   Pusher chat socket  ─▶  command dispatch  ─▶  src/bot-commands/*   (every module sees every message)
   Kick webhooks       ─▶  points, rewards, KPP / earnings trackers
```

- **Channel processes.** `src/channels/template-kick-bot.ts` is the bot loop: the chat socket, reconnects, token handling and command dispatch. Each enrolled channel is a clone of it (`src/channels/<channel>.ts`, git-ignored) started from `channels/ecosystem.config.js`. PM2 watches `data/channel-configs/<channel>.reload`, so touching it restarts that channel.
- **Commands** are modules in `src/bot-commands/`. Every module is loaded at start and handed every chat message; each one decides whether the message is for it. A channel turns a module off by listing it in `excludedCommands` (with `!config exclude` in chat, or from the dashboard).
- **Channel settings** live in `data/channel-configs/<channel>.json`: OAuth tokens, excluded commands, auto-translate, Claude, points and games, rewards, location. The points service re-reads its block within 15 seconds; most other settings apply on restart.
- **Storage** is per channel, under `data/`:
  - `data/points/<channel>/points.sqlite`: balances, ledger, duels, raffles, fishing catches, with daily backups
  - `data/community/<channel>.sqlite`: last seen, reminders, cookies, slots winners
  - JSON files for custom commands, KPP and earnings sessions, and lore
- **Auth.** The bot account's token is shared by every process in `dist/.tokens.json`, refreshed under a cross-process lock. Channels enrolled through the web flow also carry the streamer's own token, used for moderation and rewards.

## Setup

**Requirements:** Node.js 20+, PM2, and a Kick developer app from [dev.kick.com](https://dev.kick.com). Chromium is optional; it's only used by the browser-driven helpers.

```bash
npm install
cp .env.example .env      # fill in at least CLIENT_ID, CLIENT_SECRET, KICK_USERNAME, KICK_OWNER
npm run build             # compiles src/ to dist/
node authenticate.js      # one-time OAuth login for the bot account
pm2 start ecosystem.config.js   # the enrollment service
```

Streamers then enroll at `/kick-bot-enroll` on the enrollment service. That authorises the bot for their channel, writes the channel config, and starts `kick-<channel>` under PM2. Every key in `.env.example` is documented there; optional keys left blank just switch their command off (for example, no `ANTHROPIC_API_KEY` means no `!claude` and no `!chatsummary`).

### Deploying a change

```bash
npm run typecheck
npm run build
pm2 restart kick-<channel>        # or every kick-* process, plus Kick-Bot-Enrollment for API changes
```

A change to the chat loop goes into `template-kick-bot.ts` **and** each live channel clone, because the clones aren't tracked.

## Configuring a channel

Everything is per channel and can be edited from the dashboard or in `data/channel-configs/<channel>.json`:

- **Commands:** `excludedCommands` switches modules off. In chat, the broadcaster can run `!config exclude add fish`.
- **Command format:** anything that spends or pays loyalty points is `$<currency> <subcommand>` (`$don gamble 100`, `$don fish`) and exists only where points are on. `!` commands never touch points.
- **Points:** `points` holds the currency name and command, earn rate, bonuses, give, gamble, duel, raffle, timeout penalty, and `games`: whether fishing is on, live-only, catch odds, cooldown, trap time, sell and bait prices, and AI stories.
- **Claude:** the system prompt, and vision on the live stream.
- **Auto-translate:** on or off, with an optional list of source languages.
- **Rewards:** `rewardActions` maps channel-point rewards to timeouts and similar actions.

## Development

```bash
npm run typecheck
npx tsx src/tools/points-selftest.ts     # points system selftest (scratch data dir, no Kick calls)
npx tsx src/tools/rewards-selftest.ts
```

Code notes:
- Modules must never crash a channel. Recoverable failures log, recover, and answer in chat where it helps.
- Kick limits a message to 500 characters, and to 10 ASCII symbols when it's sent with the bot's own token (not a streamer's). Keep replies short and plain.
- Chat text sent to Claude is always passed as quoted, untrusted data, never as instructions.

## Security

- `.env`, token files, `data/` (OAuth tokens and databases), logs and channel clones are git-ignored. Never commit them.
- `WEBHOOK_VERIFY=false` disables Kick's webhook signature check. Use it for local testing only.
- The internal settings API requires `INTERNAL_API_SECRET`, shared with the dashboard.

## Kick documentation

- Developer portal: https://dev.kick.com/
- API docs: https://docs.kick.com/
- Docs repository: https://github.com/KickEngineering/KickDevDocs

## License

MIT
