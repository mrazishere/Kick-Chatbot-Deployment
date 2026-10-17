/**
 * The streamer-delegated scope set requested at sign-in.
 *
 * This MUST stay byte-identical to SCOPES in the bot's enrollment service
 * (Kick-Chatbot-Deployment/src/mr-ai-bot-enrollment.ts). Kick only shows a
 * consent screen when the requested scope set changes, so an identical set is
 * what lets a routine dashboard login silently re-authorize and reset the
 * 30-day grant clock. If the two drift apart, every streamer gets an extra
 * consent prompt on every login.
 *
 * Deliberately excluded: streamkey:read (a leaked stream key lets someone
 * broadcast as the channel, and nothing here needs it) and ads:read/ads:write.
 */
export const KICK_SCOPES = [
  "user:read",
  "channel:read",
  "channel:write",
  "chat:write",
  "events:subscribe",
  "channel:rewards:write",
  "moderation:ban",
  "moderation:chat_message:manage",
].join(" ");
