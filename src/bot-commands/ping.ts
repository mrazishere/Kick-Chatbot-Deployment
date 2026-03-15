/**
 * Ping command with uptime
 *
 * Description: Check if bot is responsive and show uptime
 *
 * Permission required: all users
 *
 * Usage: !ping - Check if bot is online and show uptime
 */

import { CommandFn } from '../types';

export const ping: CommandFn = async function ping(client, message, channel, tags, _config) {
  const input = message.split(" ");

  if (input[0] === "!ping") {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    client.say(channel, `@${tags.username}, Pong! Bot is online. Uptime: ${hours}h ${minutes}m ${seconds}s`);
    return;
  }
};
