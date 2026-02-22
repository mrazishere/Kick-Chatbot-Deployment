# Kick Chatbot (Official API)

A Node.js chatbot for Kick.com using the official Kick Developer API with OAuth 2.1 authentication.

## Features

- Official Kick Developer API integration
- OAuth 2.1 authentication
- Real-time chat message listening via WebSocket
- Send messages to chat (two-way communication)
- Command system with customizable prefix
- Event tracking (subscriptions, gifted subs)
- Automatic token refresh
- Reconnection handling
- Easy to extend with custom commands

## Prerequisites

- Node.js (v16 or higher)
- A Kick.com account
- A Kick Developer App (instructions below)

## Setup Instructions

### Step 1: Create a Kick Developer App

1. Go to https://dev.kick.com/
2. Log in with your Kick account
3. Navigate to your account settings
4. Click on the "Developer" tab
5. Click "Create App"
6. Fill in the app details:
   - **App Name**: Your bot name
   - **Redirect URI**: `http://localhost:3000/callback`
   - **Scopes**: Select `chat:read` and `chat:write`
7. Save the app and copy your **Client ID** and **Client Secret**

### Step 2: Configure the Bot

1. Install dependencies:
```bash
npm install
```

2. Edit the `.env` file and add your credentials:
```env
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here
REDIRECT_URI=http://localhost:3000/callback
KICK_CHANNEL=your_channel_name
BOT_PREFIX=!
```

Replace:
- `your_client_id_here` - Your app's Client ID from dev.kick.com
- `your_client_secret_here` - Your app's Client Secret from dev.kick.com
- `your_channel_name` - The Kick channel to monitor

### Step 3: First Run (Authentication)

The first time you run the bot, it will need to authenticate:

```bash
npm start
```

You'll see output like:
```
[AUTH] Not authenticated. Starting OAuth flow...
[AUTH] Please authenticate your bot:
[AUTH] Open this URL in your browser:

    https://kick.com/oauth2/authorize?client_id=...

[AUTH] Waiting for callback on http://localhost:3000/callback...
```

1. Open the URL in your browser
2. Log in to Kick if needed
3. Authorize the app
4. You'll be redirected to a success page
5. Return to the terminal - the bot will be connected!

The bot saves authentication tokens to `.tokens.json` and will automatically refresh them, so you only need to do this once.

## Usage

Start the bot:
```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Built-in Commands

The bot comes with several example commands:

- `!hello` - Bot greets the user
- `!help` - Shows available commands
- `!uptime` - Displays bot uptime
- `!ping` - Simple responsiveness check

All commands will send responses to the chat using the official API.

## Adding Custom Commands

Edit `bot.js` and add new commands in the `setupCommands()` method:

```javascript
this.commands.set('yourcommand', {
  description: 'What your command does',
  execute: async (username, args) => {
    // Your command logic here
    await this.sendMessage(`Hello ${username}!`);
  }
});
```

The `sendMessage()` method automatically handles authentication and sends messages through the official API.

## How It Works

### Architecture

1. **OAuth 2.1 Authentication** (`auth.js`)
   - Handles the OAuth flow
   - Stores and refreshes access tokens
   - Manages token expiration

2. **WebSocket Connection** (bot.js)
   - Connects to Kick's Pusher WebSocket for real-time chat
   - Listens for chat messages and events
   - Automatic reconnection on disconnect

3. **API Communication** (bot.js)
   - Uses official Kick API endpoints for sending messages
   - Bearer token authentication
   - Proper error handling

### API Endpoints Used

- `GET /api/v2/channels/{channel}` - Get channel and chatroom info
- `POST /api/v2/channels/{channel}/messages` - Send chat messages
- OAuth endpoints for authentication

### WebSocket Events Captured

- `App\Events\ChatMessageEvent` - Regular chat messages
- `App\Events\SubscriptionEvent` - New subscriptions
- `App\Events\GiftedSubscriptionsEvent` - Gifted subscriptions

## Project Structure

```
.
├── bot.js          # Main bot logic
├── auth.js         # OAuth 2.1 authentication handler
├── package.json    # Dependencies and scripts
├── .env           # Configuration (not committed)
├── .tokens.json   # OAuth tokens (auto-generated, not committed)
└── README.md      # This file
```

## Security Notes

- Never commit `.env` or `.tokens.json` to version control
- Keep your Client Secret secure
- The `.tokens.json` file contains access tokens - treat it like a password
- Tokens are automatically refreshed before expiration

## Troubleshooting

**OAuth flow fails:**
- Verify your Client ID and Client Secret are correct
- Ensure the Redirect URI matches exactly: `http://localhost:3000/callback`
- Check that you have the correct scopes enabled (`chat:read`, `chat:write`)

**Bot won't connect:**
- Verify the channel name is correct
- Check if the channel exists and is public
- Ensure you completed the OAuth flow

**Messages not sending:**
- Check that your access token is valid (bot will try to refresh automatically)
- Verify you have the `chat:write` scope enabled
- Check for rate limiting in the console output

**Token expired errors:**
- Delete `.tokens.json` and restart the bot to re-authenticate
- Check your system clock is accurate (affects token expiration)

## Rate Limiting

Kick's API has rate limits. Best practices:
- Don't spam messages
- Add cooldowns to frequently-used commands
- Handle rate limit errors gracefully

## Official Documentation

- Kick Developer Portal: https://dev.kick.com/
- API Documentation: https://docs.kick.com/
- GitHub Docs: https://github.com/KickEngineering/KickDevDocs
- Discord Community: https://discord.gg/SvyWXP5aWb

## Contributing

Ideas for extending this bot:
- Add command cooldowns
- Implement user permission levels
- Add database integration for persistent data
- Create custom moderation commands
- Add more chat events and reactions
- Implement message filtering/auto-moderation

## License

MIT
