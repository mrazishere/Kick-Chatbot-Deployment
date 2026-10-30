/**
 * $<cmd> ask <question>: Mr Ali answers a question about this channel's currency and games
 * (balances, ranks, fishing, prices, odds, how a game or any bot command works) from the real data, through the
 * read-only lookups in claude-stat-tools.ts and the command list. Since 2026-10-30 !claude has
 * no game data (owner: it stays the stream's AI) and sends these questions here.
 *
 * Permission: everyone, where the channel has a currency. One question per ASK_COOLDOWN_MS
 * each; mods, the broadcaster and the bot owner skip the wait.
 *
 * Usage:   $don ask how much do i have
 *          $don ask what does the golden reel do
 *
 * Each question stands alone, with no chat history or lore: a reply costs only the rules,
 * the lookups and the question.
 */

import { CommandFn } from '../types';
import { isBotOwner, isBotSender } from '../bot-identity';
import { SYSTEM_BOTS } from '../system-bots';
import { getPointsService } from '../points/service';
import { effectiveCommand } from '../points/config';
import { buildSystemPrompt, callClaudeAPI, COMMANDS_RULE, STATS_RULE, sanitizeForKick, sayLines, validateAndSanitizeInput } from './claude';

const NAMES = new Set(['ask']);
const ASK_MODEL = 'claude-sonnet-5';
const ASK_COOLDOWN_MS = 30_000;

const cooldowns = new Map<string, number>();

function askRule(cmd: string): string {
  return `ASK: this reply answers ${cmd} ask, a question about this channel's currency, games or bot commands. Answer it from the tools, with their real numbers. A question about anything else gets a one-line nudge to ask !claude instead, without looking anything up.`;
}

export const ask: CommandFn = async function ask(client, message, channel, tags) {
  const words = message.trim().split(/\s+/);
  const chan = channel.replace(/^#/, '').toLowerCase();
  const svc = getPointsService(chan);
  const cfg = svc?.config();
  if (!svc || !cfg?.enabled) return;
  const cmd = `$${effectiveCommand(cfg)}`;
  if ((words[0] ?? '').toLowerCase() !== cmd || !NAMES.has((words[1] ?? '').toLowerCase())) return;
  const me = tags.username;
  if (SYSTEM_BOTS.has(me.toLowerCase()) || isBotSender(me, tags.senderId)) return;
  const say = (text: string) => client.say(channel, text).catch(err => console.error(`[ASK] Reply in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`));

  // Silent while waiting, like the other $<cmd> reads; an empty ask waits too, so it can't flood chat.
  const now = Date.now();
  const key = `${chan}:${me.toLowerCase()}`;
  if (!(tags.isBroadcaster || tags.isModUp || isBotOwner(me))) {
    if ((cooldowns.get(key) ?? 0) > now) return;
    cooldowns.set(key, now + ASK_COOLDOWN_MS);
    if (cooldowns.size > 5000) for (const [k, until] of cooldowns) if (until <= now) cooldowns.delete(k);
  }

  const question = validateAndSanitizeInput(words.slice(2).join(' '), 500);
  if (!question) return void say(`@${me} ask me about ${cfg.currencyName}, the games or the commands, like: ${cmd} ask how much do i have`);

  console.log(`[ASK] ${me} in ${chan}: ${question}`);
  const system = `${buildSystemPrompt(channel)}\n\n${COMMANDS_RULE}\n\n${STATS_RULE}\n\n${askRule(cmd)}`;
  const prompt = isBotOwner(me) ? `[BOT_OWNER] ${question}` : `${me}: ${question}`;
  try {
    const data = await callClaudeAPI([{ role: 'user', content: prompt }], system, { channel: chan, asker: me }, 0, undefined, ASK_MODEL);
    const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text ?? '').join('').replace(/^(?:@\w+,?\s*)+/, '').trim();
    if (!text) {
      console.warn(`[ASK] Empty reply for ${me} in ${chan} (stop: ${String(data.stop_reason)})`);
      return void say(`@${me}, I came up blank on that one. Try asking again?`);
    }
    await sayLines(client, channel, sanitizeForKick(`@${me}, ${text}`));
  } catch (err) {
    console.error(`[ASK] ${me} in ${chan} failed: ${err instanceof Error ? err.message : String(err)}`);
    void say(`@${me}, I couldn't answer that right now. Try again in a minute?`);
  }
};
