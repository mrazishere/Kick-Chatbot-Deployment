/**
 * Custom commands
 *
 * Description: Allow streamer to manage custom commands directly from Kick chat
 *
 *
 * Permission required:
 *          !acomm: Moderators and above
 *          !ecomm: Moderators and above
 *          !dcomm: Moderators and above
 *          !lcomm: Moderators and above
 *          !<commmandName>: all/Mods/VIP (Depends on what's configured for modOnly)
 *
 * Usage:   !acomm modOnly(n/y/v) commandName commandResponse - Add new custom command
 *          !ecomm modOnly(n/y/v) commandName commandResponse - Edit existing custom command
 *          !dcomm commandName - Delete existing custom command
 *          !lcomm - List all custom commands
 *          !<commandName> - Execute custom command
 *
 * Variables:   $counter - Number of times the command has been used
 *              $user1 - Username of the user who executed the command
 *              $user2 - Username of the mentioned user in the command
 *              $percentage - Random percentage
 *              $streamerp = Random percentage except if user2 is the streamer of the channel, will print 10000000%
 *              $ynm - Random yes/no/maybe
 *
 * Timeouts:    A response starting with "/timeout <user> <duration>" times the user out
 *              through Kick's API (e.g. "/timeout $user1 1m"). Duration takes s/m/h/d;
 *              a bare number is minutes. Text after the duration is posted once it works.
 *              Anyone allowed to use the command may time themselves out; timing out
 *              someone else needs a moderator.
 *
 */

import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ClientWrapper, CommandFn } from '../types';

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

// CRITICAL: After compilation, __dirname in dist/bot-commands/ resolves to dist/bot-commands/.
// Custom command JSON files live at data/custom-commands/ in the project root.
const CUSTOM_DIR = path.join(__dirname, '../../data/custom-commands');

// Command tuple: [modOnly, response, counter]
type CommandTuple = [string, string, number];
type CustomCommands = Record<string, CommandTuple>;

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 30000; // 30 seconds
const MAX_REQUESTS = 10; // Max 10 requests per 30 seconds for custom commands

// Rate limiting check
function checkRateLimit(username: string): boolean {
  const now = Date.now();
  const userRequests = rateLimitMap.get(username) || [];

  // Remove old requests outside the window
  const validRequests = userRequests.filter(timestamp => now - timestamp < RATE_LIMIT_WINDOW);

  if (validRequests.length >= MAX_REQUESTS) {
    return false; // Rate limited
  }

  validRequests.push(now);
  rateLimitMap.set(username, validRequests);
  return true; // Not rate limited
}

// Input sanitization functions
function sanitizeCommandName(name: string): string {
  if (!name || typeof name !== 'string') return '';
  // Only allow alphanumeric characters, no special chars
  return name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 25);
}

function sanitizeCommandResponse(response: string): string {
  if (!response || typeof response !== 'string') return '';
  // Remove potential XSS and harmful content, but allow basic text
  return response.replace(/[<>]/g, '').trim().substring(0, 500);
}

// Path validation to prevent directory traversal
function validateChannelPath(channelName: string): string | null {
  if (!channelName || typeof channelName !== 'string') return null;
  const sanitized = channelName.replace(/[^a-zA-Z0-9_-]/g, '');
  if (sanitized !== channelName || sanitized.length === 0) return null;
  return sanitized;
}

/**
 * Change the stored commands and save them.
 *
 * Works on a fresh read, not the copy loaded when the message arrived: the
 * dashboard writes this file too, and saving a stale copy undid its edits —
 * routinely, since every use of a command saves its counter. Read, change and
 * write are synchronous so nothing else in this bot interleaves, and the write
 * goes through a rename so no reader sees half a file. A file that won't parse
 * throws rather than being treated as empty, which would wipe every command.
 *
 * `change` returns false to skip the write.
 */
function mutateCommands(channelName: string, change: (commands: CustomCommands) => boolean | void): CustomCommands {
  const file = path.join(CUSTOM_DIR, `${channelName}.json`);
  let commands: CustomCommands = {};
  try {
    commands = JSON.parse(fs.readFileSync(file, 'utf8')) as CustomCommands;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (change(commands) === false) return commands;
  fs.mkdirSync(CUSTOM_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(commands, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return commands;
}

/**
 * Kick only turns slash commands into actions when a person types them into its
 * own chat box. Sent through the API — which is how every bot talks — "/timeout"
 * is just text, so the bot performs the timeout itself.
 */
const TIMEOUT_RESPONSE = /^\/timeout\s+@*([A-Za-z0-9_]{2,25})\s+(\d{1,6})([smhd]?)(?:\s+([\s\S]*))?$/i;
const MAX_TIMEOUT_SECONDS = 7 * 24 * 60 * 60;   // Kick's ban API caps a timeout at one week

function parseTimeoutResponse(response: string): { target: string; seconds: number; followUp: string } | null {
    const m = TIMEOUT_RESPONSE.exec(response.trim());
    if (!m) return null;
    const unit = (m[3] || 'm').toLowerCase();
    const multiplier = unit === 's' ? 1 : unit === 'h' ? 3600 : unit === 'd' ? 86400 : 60;
    return { target: m[1], seconds: Number(m[2]) * multiplier, followUp: (m[4] ?? '').trim() };
}

async function runTimeoutResponse(
    client: ClientWrapper,
    channel: string,
    commandName: string,
    response: string,
    invoker: string,
    invokerIsModUp: boolean
): Promise<void> {
    const parsed = parseTimeoutResponse(response);
    if (!parsed) {
        console.error(`[CUSTOMC] !${commandName} has a malformed /timeout response: ${response}`);
        await client.say(channel, `@${invoker}, !${commandName} is misconfigured — its /timeout needs a user and a duration like 1m.`);
        return;
    }
    const { target, seconds, followUp } = parsed;
    if (seconds < 1 || seconds > MAX_TIMEOUT_SECONDS) {
        await client.say(channel, `@${invoker}, !${commandName} asks for a timeout outside Kick's limit of 1 second to 7 days.`);
        return;
    }
    // Timing yourself out is anyone's call; timing out someone else is a moderator's.
    if (target.toLowerCase() !== invoker.toLowerCase() && !invokerIsModUp) {
        await client.say(channel, `@${invoker}, only moderators can use !${commandName} on someone else.`);
        return;
    }
    if (!client.timeout) {
        console.error(`[CUSTOMC] !${commandName} wants a timeout but this bot cannot moderate`);
        return;
    }

    const result = await client.timeout({ target, seconds, invoker, reason: `!${commandName} used by ${invoker}` });
    if (!result.ok) {
        await client.say(channel, `@${invoker}, ${result.error}.`);
        return;
    }
    console.log(`[CUSTOMC] !${commandName}: ${invoker} timed out ${result.target} for ${result.seconds}s (as ${result.actor})`);
    if (followUp) await client.say(channel, followUp);
}

export const customC: CommandFn = async function customC(client, message, channel, tags, _config) {
    // Clean and split input to handle invisible Unicode characters
    const input = message.trim().split(" ").filter(part => part.trim().length > 0);

    // Check if this is a custom command-related message FIRST
    const isManagementCommand = ['!acomm', '!ecomm', '!dcomm', '!countcomm', '!lcomm'].includes(input[0]);
    const isCustomCommand = input[0].startsWith('!') && input[0].length > 1;

    // Early exit if not a command at all
    if (!isManagementCommand && !isCustomCommand) {
        return;
    }

    // Extract badges from Kick tags structure
    const badges = tags.badges || {};
    const isBroadcaster = badges.broadcaster || tags.rawBadges?.some(b => b.type === 'broadcaster' || b.type === 'owner');
    const isMod = badges.moderator || tags.rawBadges?.some(b => b.type === 'moderator');
    const isVIP = badges.vip || tags.rawBadges?.some(b => b.type === 'vip');
    const isModUp = isBroadcaster || isMod || tags.username === process.env.KICK_OWNER;
    const isVIPUp = isVIP || isModUp;
    const channelName = channel.startsWith('#') ? channel.substring(1) : channel;

    // Validate channel path to prevent directory traversal
    const validatedChannelName = validateChannelPath(channelName);
    if (!validatedChannelName) {
        console.error(`[CUSTOMC] Invalid channel name: ${channelName}`);
        return;
    }

    const channelFile: string = validatedChannelName;

    let customCommands: CustomCommands = {};
    try {
        const safePath = path.join(CUSTOM_DIR, `${channelFile}.json`);
        const data = await readFileAsync(safePath, 'utf8');
        customCommands = JSON.parse(data) as CustomCommands;
    } catch (err) {
        // A missing file just means no commands yet. An unreadable or corrupt one
        // must not be treated as empty: !acomm would then save that empty set over
        // every existing command.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`[CUSTOMC] Error loading commands for ${channelFile}:`, err instanceof Error ? err.message : String(err));
            return;
        }
    }

    function commandExists(commandName: string): boolean {
        return Object.prototype.hasOwnProperty.call(customCommands, commandName);
    }

    // Now check if it's actually a custom command or management command
    if (!isManagementCommand && !commandExists(input[0].substring(1))) {
        return; // Not a custom command we handle
    }

    // Check rate limiting only for valid commands
    if (!checkRateLimit(tags.username)) {
        client.say(channel, `@${tags.username}, please wait before using custom commands again.`);
        return;
    }

    // Add command function with security validation
    async function addCommand(commandName: string, modOnly: string, commandResponse: string): Promise<string> {
        // Sanitize inputs
        const sanitizedName = sanitizeCommandName(commandName);
        const sanitizedResponse = sanitizeCommandResponse(commandResponse);

        if (!sanitizedName || sanitizedName.length < 3) {
            return `@${tags.username}, Invalid command name! Must be 3-25 alphanumeric characters.`;
        }

        if (!sanitizedResponse || sanitizedResponse.length < 1) {
            return `@${tags.username}, Invalid command response!`;
        }

        let exists = false;
        try {
            customCommands = mutateCommands(channelFile, commands => {
                // Checked against the file as it is now, not as it was when this message arrived.
                if (Object.prototype.hasOwnProperty.call(commands, sanitizedName)) {
                    exists = true;
                    return false;
                }
                commands[sanitizedName] = [modOnly, sanitizedResponse, 0];
            });
        } catch (err) {
            if (err instanceof Error) {
                console.error(`[CUSTOMC] Error saving command: ${err.message}`);
            }
            return `@${tags.username}, Error saving command!`;
        }
        if (exists) {
            return `@${tags.username}, That command already exists!`;
        }

        console.log(`[CUSTOMC] Command added: ${sanitizedName} by ${tags.username}`);
        return `@${tags.username}, !${sanitizedName} Command added!`;
    }

    async function removeCommand(commandName: string): Promise<string> {
        const sanitizedName = sanitizeCommandName(commandName);
        if (!sanitizedName) {
            return `@${tags.username}, That command doesn't exist!`;
        }

        let missing = false;
        try {
            customCommands = mutateCommands(channelFile, commands => {
                if (!Object.prototype.hasOwnProperty.call(commands, sanitizedName)) {
                    missing = true;
                    return false;
                }
                delete commands[sanitizedName];
            });
        } catch (err) {
            if (err instanceof Error) {
                console.error(`[CUSTOMC] Error removing command: ${err.message}`);
            }
            return `@${tags.username}, Error removing command!`;
        }
        if (missing) {
            return `@${tags.username}, That command doesn't exist!`;
        }

        console.log(`[CUSTOMC] Command removed: ${sanitizedName} by ${tags.username}`);
        return `@${tags.username}, !${sanitizedName} Command removed!`;
    }

    /**
     * Change one command. Anything left out of `changes` keeps its stored value —
     * the counter especially, so an edit can't roll back uses counted since this
     * message was read.
     */
    async function editCommand(
        commandName: string,
        changes: { modOnly?: string; response?: string; counter?: number },
        respondToUser = false
    ): Promise<string | null> {
        const sanitizedName = sanitizeCommandName(commandName);
        const sanitizedResponse = changes.response === undefined ? undefined : sanitizeCommandResponse(changes.response);

        if (sanitizedResponse !== undefined && sanitizedResponse.length < 1) {
            return `@${tags.username}, Invalid command response!`;
        }

        let missing = !sanitizedName;
        if (!missing) {
            try {
                customCommands = mutateCommands(channelFile, commands => {
                    const current = commands[sanitizedName];
                    if (!Object.prototype.hasOwnProperty.call(commands, sanitizedName) || !Array.isArray(current)) {
                        missing = true;
                        return false;
                    }
                    commands[sanitizedName] = [
                        changes.modOnly ?? current[0],
                        sanitizedResponse ?? current[1],
                        changes.counter ?? (Number.isFinite(current[2]) ? current[2] : 0)
                    ];
                });
            } catch (err) {
                if (err instanceof Error) {
                    console.error(`[CUSTOMC] Error updating command: ${err.message}`);
                }
                return `@${tags.username}, Error updating command!`;
            }
        }
        if (missing) {
            return `@${tags.username}, That command does not exist!`;
        }

        // Respond only when called by !ecomm
        if (respondToUser) {
            console.log(`[CUSTOMC] Command updated: ${sanitizedName} by ${tags.username}`);
            return `@${tags.username}, !${sanitizedName} Command updated!`;
        }
        return null;
    }

    if (!isModUp && (input[0] === "!acomm" || input[0] === "!ecomm" || input[0] === "!dcomm" || input[0] === "!countcomm")) {
        client.say(channel, `@${tags.username}, Custom Commands are for Moderators & above.`);
        return;
    }

    if (input[0] === "!acomm") {
        if (input.length < 4) {
            client.say(channel, `@${tags.username}, !acomm <modOnly(n/y/v)> <commandName> <commandResponse>`);
            return;
        }

        const modOnly = input[1].toLowerCase();
        const commandName = input[2];
        const commandResponse = input.slice(3).join(" ");

        // Validate modOnly parameter
        if (!["n", "y", "v"].includes(modOnly)) {
            client.say(channel, `@${tags.username}, modOnly must be n/y/v (none/mod/vip)`);
            return;
        }

        // Add the command (validation happens inside addCommand)
        try {
            const response = await addCommand(commandName, modOnly, commandResponse);
            client.say(channel, response);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[CUSTOMC] Error adding command:`, error.message);
            }
            client.say(channel, `@${tags.username}, Error adding command!`);
        }
        return;
    }


    if (input[0] === "!ecomm") {
        if (input.length < 4) {
            client.say(channel, `@${tags.username}, !ecomm <modOnly(n/y/v)> <commandName> <commandResponse>`);
            return;
        }

        const modOnly = input[1].toLowerCase();
        const commandName = input[2];
        const commandResponse = input.slice(3).join(" ");

        // Validate modOnly parameter
        if (!["n", "y", "v"].includes(modOnly)) {
            client.say(channel, `@${tags.username}, modOnly must be n/y/v (none/mod/vip)`);
            return;
        }

        // Check if command exists and get current counter
        const sanitizedName = sanitizeCommandName(commandName);
        if (!sanitizedName || !commandExists(sanitizedName)) {
            client.say(channel, `@${tags.username}, That command does not exist!`);
            return;
        }

        // Edit the command (validation happens inside editCommand). The stored counter is kept.
        try {
            const response = await editCommand(sanitizedName, { modOnly, response: commandResponse }, true);
            if (response) {
                client.say(channel, response);
            }
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[CUSTOMC] Error editing command:`, error.message);
            }
            client.say(channel, `@${tags.username}, Error editing command!`);
        }
        return;
    }

    if (input[0] === "!dcomm") {
        if (input.length < 2) {
            client.say(channel, `@${tags.username}, !dcomm <commandName>`);
            return;
        }

        const commandName = input[1];

        // Remove the command (validation happens inside removeCommand)
        try {
            const response = await removeCommand(commandName);
            client.say(channel, response);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[CUSTOMC] Error removing command:`, error.message);
            }
            client.say(channel, `@${tags.username}, Error removing command!`);
        }
        return;
    }

    // Update command counter
    if (input[0] === "!countcomm") {
        if (input.length < 3) {
            client.say(channel, `@${tags.username}, !countcomm <commandName> <commandCounter>`);
            return;
        }

        const commandName = input[1];
        const commandCounterNew = Number(input[2]);

        // Validate inputs
        if (!Number.isInteger(commandCounterNew) || commandCounterNew < 0) {
            client.say(channel, `@${tags.username}, Counter must be a positive integer!`);
            return;
        }

        const sanitizedName = sanitizeCommandName(commandName);
        if (!sanitizedName || !commandExists(sanitizedName)) {
            client.say(channel, `@${tags.username}, That command doesn't exist!`);
            return;
        }

        // Update the commandCounter, leaving the access level and response as stored.
        try {
            const problem = await editCommand(sanitizedName, { counter: commandCounterNew }, false);
            client.say(channel, problem ?? `@${tags.username}, Counter updated to ${commandCounterNew}!`);
        } catch (error) {
            if (error instanceof Error) {
                console.error(`[CUSTOMC] Error updating counter:`, error.message);
            }
            client.say(channel, `@${tags.username}, Error updating counter!`);
        }
        return;
    }

    if (input[0] === "!lcomm") {
        // Get the list of custom commands
        const commandList = Object.keys(customCommands);
        // Check if there are any custom commands
        if (commandList.length === 0) {
            client.say(channel, `@${tags.username}, There are no custom commands!`);
            return;
        } else {
            // Send the list of custom commands to chat
            client.say(channel, `@${tags.username}, Custom Commands: "!${commandList.join('", "!')}"`);
            return;
        }
    }
    // Check if the user is trying to call a custom command
    if (commandExists(input[0].substring(1)) && input[0].startsWith('!')) {
        const commandName = input[0].substring(1);
        const commandData = customCommands[commandName];
        const modOnly = commandData[0];
        const commandResponse = commandData[1];
        let commandCounterNew = (Number.isFinite(commandData[2]) ? commandData[2] : 0) + 1;

        // Count the use against the file as it is now, so it can't undo an edit made
        // elsewhere since this message was read, and so $counter shows the real total.
        try {
            mutateCommands(channelFile, commands => {
                const current = commands[commandName];
                if (!Array.isArray(current)) return false;   // deleted meanwhile
                current[2] = (Number.isFinite(current[2]) ? current[2] : 0) + 1;
                commandCounterNew = current[2];
            });
        } catch (err) {
            console.error(`[CUSTOMC] Error updating counter for ${commandName}:`, err instanceof Error ? err.message : String(err));
        }

        // Process command response with variable substitution (securely)
        let response = sanitizeCommandResponse(commandResponse);

        // Replace variables with sanitized values
        if (response.includes("$counter")) {
            response = response.replace(/\$counter/g, commandCounterNew.toString());
        }
        if (response.includes("$user1")) {
            response = response.replace(/\$user1/g, tags.username);
        }

        // Safe user2 extraction
        let user2 = tags.username; // Default to command user
        if (response.includes("$user2")) {
            if (message.includes("@")) {
                const mentionMatch = message.match(/@([a-zA-Z0-9_]{1,25})/);
                if (mentionMatch) {
                    user2 = mentionMatch[1];
                }
            }
            response = response.replace(/\$user2/g, `@${user2}`);
        }

        if (response.includes("$percentage")) {
            response = response.replace(/\$percentage/g, `${Math.floor(Math.random() * 100)}%`);
        }

        if (response.includes("$streamerp")) {
            if (user2.toLowerCase() === validatedChannelName.toLowerCase()) {
                // Generate a random number between 100 and 10,000,000 for streamer
                const randomPercentage = Math.floor(Math.random() * (10000000 - 100 + 1)) + 100;
                response = response.replace(/\$streamerp/g, `${randomPercentage}%`);
            } else {
                response = response.replace(/\$streamerp/g, `${Math.floor(Math.random() * 100)}%`);
            }
        }

        if (response.includes("$ynm")) {
            const yesNoMaybe = ["Yes", "No", "Maybe"];
            response = response.replace(/\$ynm/g, yesNoMaybe[Math.floor(Math.random() * yesNoMaybe.length)]);
        }

        // Check permissions and execute command
        if (modOnly === "y" && !isModUp) {
            return; // Silently ignore for mod-only commands
        } else if (modOnly === "v" && !isVIPUp) {
            return; // Silently ignore for VIP+ commands
        } else if (/^\/timeout\b/i.test(response.trim())) {
            await runTimeoutResponse(client, channel, commandName, response, tags.username, !!isModUp);
            return;
        } else {
            // Execute the command
            client.say(channel, response);
            return;
        }
    }
};
