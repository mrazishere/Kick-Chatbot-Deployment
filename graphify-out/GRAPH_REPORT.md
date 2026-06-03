# Graph Report - .  (2026-05-26)

## Corpus Check
- 63 files · ~104,258 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 422 nodes · 594 edges · 53 communities detected
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 23 edges (avg confidence: 0.81)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Claude AI Command|Claude AI Command]]
- [[_COMMUNITY_Bot Template (JSTS)|Bot Template (JS/TS)]]
- [[_COMMUNITY_Mrazishere Channel|Mrazishere Channel]]
- [[_COMMUNITY_Sukasblood Channel|Sukasblood Channel]]
- [[_COMMUNITY_Mraiishere Channel|Mraiishere Channel]]
- [[_COMMUNITY_Bot Enrollment & Deploy|Bot Enrollment & Deploy]]
- [[_COMMUNITY_OAuth & Auth Flow|OAuth & Auth Flow]]
- [[_COMMUNITY_KPP Stream Tracker|KPP Stream Tracker]]
- [[_COMMUNITY_README Documentation|README Documentation]]
- [[_COMMUNITY_Mention Timeout Spike (After)|Mention Timeout Spike (After)]]
- [[_COMMUNITY_Telegram Notifications|Telegram Notifications]]
- [[_COMMUNITY_Earnings Tracker|Earnings Tracker]]
- [[_COMMUNITY_Session Auth|Session Auth]]
- [[_COMMUNITY_FX Currency Command|FX Currency Command]]
- [[_COMMUNITY_Sukasblood IRL Reference|Sukasblood IRL Reference]]
- [[_COMMUNITY_Mention Timeout Spike (Sukas)|Mention Timeout Spike (Sukas)]]
- [[_COMMUNITY_Auto-Translate|Auto-Translate]]
- [[_COMMUNITY_Weather Command|Weather Command]]
- [[_COMMUNITY_Jokes Command|Jokes Command]]
- [[_COMMUNITY_Translate Command|Translate Command]]
- [[_COMMUNITY_HLS Stream Resolver|HLS Stream Resolver]]
- [[_COMMUNITY_Sukasblood Setup Reference|Sukasblood Setup Reference]]
- [[_COMMUNITY_Dad Jokes Command|Dad Jokes Command]]
- [[_COMMUNITY_Dictionary Command|Dictionary Command]]
- [[_COMMUNITY_Recent Bot Output Guard|Recent Bot Output Guard]]
- [[_COMMUNITY_Custom Commands|Custom Commands]]
- [[_COMMUNITY_Number Facts Command|Number Facts Command]]
- [[_COMMUNITY_Bot Identity|Bot Identity]]
- [[_COMMUNITY_KPP Bot Command|KPP Bot Command]]
- [[_COMMUNITY_Dog Facts Command|Dog Facts Command]]
- [[_COMMUNITY_Pokemon Catch Command|Pokemon Catch Command]]
- [[_COMMUNITY_Chatroom Resolver|Chatroom Resolver]]
- [[_COMMUNITY_Spike Poll History|Spike Poll History]]
- [[_COMMUNITY_Authenticate Module|Authenticate Module]]
- [[_COMMUNITY_Cat Facts Command|Cat Facts Command]]
- [[_COMMUNITY_Earnings Bot Command|Earnings Bot Command]]
- [[_COMMUNITY_Live Frame Capture|Live Frame Capture]]
- [[_COMMUNITY_FX Error Types|FX Error Types]]
- [[_COMMUNITY_Spike Discover v4|Spike Discover v4]]
- [[_COMMUNITY_Cross-Channel Send|Cross-Channel Send]]
- [[_COMMUNITY_Spike Probe History|Spike Probe History]]
- [[_COMMUNITY_Spike Discover v1|Spike Discover v1]]
- [[_COMMUNITY_Spike Discover v5|Spike Discover v5]]
- [[_COMMUNITY_Spike Discover v7|Spike Discover v7]]
- [[_COMMUNITY_Spike Discover v6|Spike Discover v6]]
- [[_COMMUNITY_Spike Discover v2|Spike Discover v2]]
- [[_COMMUNITY_Spike Discover v3|Spike Discover v3]]
- [[_COMMUNITY_Root Ecosystem Config|Root Ecosystem Config]]
- [[_COMMUNITY_Channels Ecosystem Config|Channels Ecosystem Config]]
- [[_COMMUNITY_App Entry Point|App Entry Point]]
- [[_COMMUNITY_Ping Command|Ping Command]]
- [[_COMMUNITY_Top Chatters Command|Top Chatters Command]]
- [[_COMMUNITY_Cookie Type Defs|Cookie Type Defs]]

## God Nodes (most connected - your core abstractions)
1. `KickChatBot` - 26 edges
2. `KickChatBot` - 26 edges
3. `KickChatBot` - 26 edges
4. `KickChatBot` - 26 edges
5. `KickAuth` - 15 edges
6. `KPPTracker` - 14 edges
7. `TelegramNotifier` - 11 edges
8. `logStructured()` - 11 edges
9. `EarningsTracker` - 11 edges
10. `KickSessionAuth` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Kick Cookie Header (Spike Auth)` --semantically_similar_to--> `OAuth 2.1 Authentication`  [INFERRED] [semantically similar]
  spike/mention-timeout/cookies.txt → README.md
- `Mention-Timeout Measurement Spike` --conceptually_related_to--> `Kick Chatbot (Official API)`  [INFERRED]
  spike/mention-timeout/README.txt → README.md
- `Mention-Timeout Measurement Spike` --conceptually_related_to--> `Rate Limiting`  [INFERRED]
  spike/mention-timeout/README.txt → README.md
- `Mention-Timeout Measurement Spike` --references--> `Kick Cookie Header (Spike Auth)`  [EXTRACTED]
  spike/mention-timeout/README.txt → spike/mention-timeout/cookies.txt

## Hyperedges (group relationships)
- **Kick Chatbot Core Architecture** — readme_auth_js, readme_bot_js, readme_oauth21_authentication, readme_websocket_connection, readme_api_communication [EXTRACTED 1.00]
- **Secrets and Token Security** — readme_security_rationale, readme_env_configuration, readme_token_management [EXTRACTED 1.00]

## Communities

### Community 0 - "Claude AI Command"
Cohesion: 0.14
Nodes (28): buildMentionVisionContext(), buildSystemPrompt(), callBraveSearchAPI(), callClaudeAPI(), callClaudeAPIWithSearch(), callClaudeAPIWithVision(), captureLoreEntry(), checkRateLimit() (+20 more)

### Community 1 - "Bot Template (JS/TS)"
Cohesion: 0.13
Nodes (2): KickChatBot, main()

### Community 2 - "Mrazishere Channel"
Cohesion: 0.13
Nodes (2): KickChatBot, main()

### Community 3 - "Sukasblood Channel"
Cohesion: 0.13
Nodes (2): KickChatBot, main()

### Community 4 - "Mraiishere Channel"
Cohesion: 0.13
Nodes (2): KickChatBot, main()

### Community 5 - "Bot Enrollment & Deploy"
Cohesion: 0.19
Nodes (9): connectDeploymentWebSocket(), deployAddChannel(), deployHelp(), deployRemoveChannel(), deployStatus(), handleDeploymentCommand(), handleDeploymentMessage(), sendDeploymentMessage() (+1 more)

### Community 6 - "OAuth & Auth Flow"
Cohesion: 0.19
Nodes (1): KickAuth

### Community 7 - "KPP Stream Tracker"
Cohesion: 0.25
Nodes (1): KPPTracker

### Community 8 - "README Documentation"
Cohesion: 0.17
Nodes (15): API Communication, auth.js Module, bot.js Module, Command System, .env Configuration, Event Tracking (Subscriptions, Gifted Subs), Kick Chatbot (Official API), Kick Developer API (+7 more)

### Community 9 - "Mention Timeout Spike (After)"
Cohesion: 0.18
Nodes (14): Chat Panel with Test Messages, Following List Sidebar, jaiwmelon (Followed Channel), Kick Streaming Platform, LeslieNGGG (Followed Channel), Mention Timeout Spike (After Typing), mrazishere Channel Page, mrazishere (User / Channel Owner) (+6 more)

### Community 10 - "Telegram Notifications"
Cohesion: 0.27
Nodes (1): TelegramNotifier

### Community 11 - "Earnings Tracker"
Cohesion: 0.27
Nodes (1): EarningsTracker

### Community 12 - "Session Auth"
Cohesion: 0.31
Nodes (1): KickSessionAuth

### Community 13 - "FX Currency Command"
Cohesion: 0.25
Nodes (6): fetchRate(), getCachedLocation(), getCachedRate(), resolveLocationToIso(), setCachedLocation(), setCachedRate()

### Community 14 - "Sukasblood IRL Reference"
Cohesion: 0.31
Nodes (11): 11 GUYS Title Overlay Text, Casino Venue (IRL Location), Female Stream Companion, Gambling Content Category, IRL Casino Stream Format, Kick Live Chat Overlay, Kick Streaming Platform, Scape Brand Watermark (+3 more)

### Community 15 - "Mention Timeout Spike (Sukas)"
Cohesion: 0.33
Nodes (9): @-Mention Only Response Mode, Bot-Token-Only Auth Mode, Kick Chat Panel (Offline State), Kick Streaming Platform, Mention Timeout Spike Investigation, Channel Offline Status, Sukasblood @-Mention Only Screenshot, CHMA Stream Series (Multi-Day VODs) (+1 more)

### Community 16 - "Auto-Translate"
Cohesion: 0.25
Nodes (0): 

### Community 17 - "Weather Command"
Cohesion: 0.38
Nodes (3): fetchWeather(), getCachedWeather(), setCachedWeather()

### Community 18 - "Jokes Command"
Cohesion: 0.33
Nodes (2): deliverJoke(), sleep()

### Community 19 - "Translate Command"
Cohesion: 0.29
Nodes (0): 

### Community 20 - "HLS Stream Resolver"
Cohesion: 0.38
Nodes (2): decodeJwtExp(), HlsResolver

### Community 21 - "Sukasblood Setup Reference"
Cohesion: 0.33
Nodes (7): Boom Arm Microphone, Internet Meme Culture, Kick Streaming Platform, Pepe the Frog Plush Toy, Bedroom Streaming Setup, Sukasblood (Streamer), Veritas et Aequitas Chest Tattoo

### Community 22 - "Dad Jokes Command"
Cohesion: 0.33
Nodes (0): 

### Community 23 - "Dictionary Command"
Cohesion: 0.33
Nodes (0): 

### Community 24 - "Recent Bot Output Guard"
Cohesion: 0.8
Nodes (4): markBotOutput(), normalizeChannel(), prune(), wasRecentBotOutput()

### Community 25 - "Custom Commands"
Cohesion: 0.4
Nodes (0): 

### Community 26 - "Number Facts Command"
Cohesion: 0.4
Nodes (0): 

### Community 27 - "Bot Identity"
Cohesion: 0.5
Nodes (0): 

### Community 28 - "KPP Bot Command"
Cohesion: 0.5
Nodes (0): 

### Community 29 - "Dog Facts Command"
Cohesion: 0.5
Nodes (0): 

### Community 30 - "Pokemon Catch Command"
Cohesion: 0.5
Nodes (0): 

### Community 31 - "Chatroom Resolver"
Cohesion: 0.67
Nodes (1): ChatroomResolver

### Community 32 - "Spike Poll History"
Cohesion: 0.67
Nodes (2): log(), poll()

### Community 33 - "Authenticate Module"
Cohesion: 0.67
Nodes (1): authenticate()

### Community 34 - "Cat Facts Command"
Cohesion: 0.67
Nodes (0): 

### Community 35 - "Earnings Bot Command"
Cohesion: 0.67
Nodes (0): 

### Community 36 - "Live Frame Capture"
Cohesion: 0.67
Nodes (0): 

### Community 37 - "FX Error Types"
Cohesion: 0.67
Nodes (1): FxError

### Community 38 - "Spike Discover v4"
Cohesion: 0.67
Nodes (0): 

### Community 39 - "Cross-Channel Send"
Cohesion: 1.0
Nodes (0): 

### Community 40 - "Spike Probe History"
Cohesion: 1.0
Nodes (0): 

### Community 41 - "Spike Discover v1"
Cohesion: 1.0
Nodes (0): 

### Community 42 - "Spike Discover v5"
Cohesion: 1.0
Nodes (0): 

### Community 43 - "Spike Discover v7"
Cohesion: 1.0
Nodes (0): 

### Community 44 - "Spike Discover v6"
Cohesion: 1.0
Nodes (0): 

### Community 45 - "Spike Discover v2"
Cohesion: 1.0
Nodes (0): 

### Community 46 - "Spike Discover v3"
Cohesion: 1.0
Nodes (0): 

### Community 47 - "Root Ecosystem Config"
Cohesion: 1.0
Nodes (0): 

### Community 48 - "Channels Ecosystem Config"
Cohesion: 1.0
Nodes (0): 

### Community 49 - "App Entry Point"
Cohesion: 1.0
Nodes (0): 

### Community 50 - "Ping Command"
Cohesion: 1.0
Nodes (0): 

### Community 51 - "Top Chatters Command"
Cohesion: 1.0
Nodes (0): 

### Community 52 - "Cookie Type Defs"
Cohesion: 1.0
Nodes (0): 

## Ambiguous Edges - Review These
- `Sukasblood (Streamer)` → `Scape Brand Watermark`  [AMBIGUOUS]
  data/channel-refs/sukasblood/02.jpg · relation: conceptually_related_to
- `@-Mention Only Response Mode` → `Bot-Token-Only Auth Mode`  [AMBIGUOUS]
  spike/mention-timeout/sukas-at-only.png · relation: conceptually_related_to

## Knowledge Gaps
- **17 isolated node(s):** `WebSocket Connection (Pusher)`, `Command System`, `Event Tracking (Subscriptions, Gifted Subs)`, `Boom Arm Microphone`, `Veritas et Aequitas Chest Tattoo` (+12 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Cross-Channel Send`** (2 nodes): `sendToBroadcaster()`, `cross-channel-send.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Probe History`** (2 nodes): `parseCookies()`, `probe-history.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v1`** (2 nodes): `parseCookies()`, `discover.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v5`** (2 nodes): `parseCookies()`, `discover5.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v7`** (2 nodes): `parseCookies()`, `discover7.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v6`** (2 nodes): `parseCookies()`, `discover6.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v2`** (2 nodes): `parseCookies()`, `discover2.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Spike Discover v3`** (2 nodes): `parseCookies()`, `discover3.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Root Ecosystem Config`** (1 nodes): `ecosystem.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Channels Ecosystem Config`** (1 nodes): `ecosystem.config.js`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `App Entry Point`** (1 nodes): `index.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Ping Command`** (1 nodes): `ping.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Top Chatters Command`** (1 nodes): `topc.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.
- **Thin community `Cookie Type Defs`** (1 nodes): `cookie.d.ts`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Sukasblood (Streamer)` and `Scape Brand Watermark`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `@-Mention Only Response Mode` and `Bot-Token-Only Auth Mode`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What connects `WebSocket Connection (Pusher)`, `Command System`, `Event Tracking (Subscriptions, Gifted Subs)` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Claude AI Command` be split into smaller, more focused modules?**
  _Cohesion score 0.14 - nodes in this community are weakly interconnected._
- **Should `Bot Template (JS/TS)` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `Mrazishere Channel` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._
- **Should `Sukasblood Channel` be split into smaller, more focused modules?**
  _Cohesion score 0.13 - nodes in this community are weakly interconnected._