/**
 * Kick chat Google Translate command
 *
 * Description: Allows chat to perform google translation.
 *
 * Permission required: All users
 *
 * Usage:   !<language code><SPACE><message to translate>
 *          Language codes: https://cloud.google.com/translate/docs/languages
 */

import gtrans from 'googletrans';
import { CommandFn } from '../types';

// Rate limiting map to track user requests
const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_WINDOW = 60000; // 60 seconds
const MAX_REQUESTS = 5; // Max 5 translation requests per minute
const TWITCH_MESSAGE_LIMIT = 500; // Twitch message character limit

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

// Input sanitization for translation text
function sanitizeTranslationText(text: string): string {
    if (!text || typeof text !== 'string') return '';

    // Remove potentially harmful characters and limit length
    const cleaned = text.replace(/[<>'"&]/g, '').trim();
    return cleaned.substring(0, 200); // Max 200 characters
}

// Validate language code against known codes
function isValidLanguageCode(code: string | undefined): boolean {
    if (!code || typeof code !== 'string') return false;

    // Only allow alphanumeric characters and hyphens, max 10 chars
    const cleanCode = code.replace(/[^a-zA-Z0-9-]/g, '');
    return cleanCode.length > 0 && cleanCode.length <= 10 && Object.prototype.hasOwnProperty.call(tr_lang, cleanCode);
}

// Truncate message to fit character limit
function truncateMessage(msg: string): string {
    if (msg.length <= TWITCH_MESSAGE_LIMIT) {
        return msg;
    }
    return msg.substring(0, TWITCH_MESSAGE_LIMIT - 3) + '...';
}

// Safe translation with timeout
async function safeTranslate(text: string, options: object, timeoutMs = 8000): Promise<{ text: string; pronunciation: string }> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Translation timeout'));
        }, timeoutMs);

        gtrans(text, options)
            .then(result => {
                clearTimeout(timeout);
                resolve(result);
            })
            .catch(error => {
                clearTimeout(timeout);
                reject(error);
            });
    });
}

// Sleep helper
function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

void sleep; // prevent unused variable warning

const tr_lang: Record<string, [string, string]> = {
    'de': ['de', 'sagt'],
    'en': ['en', 'says'],
    'fr': ['fr', 'dit'],
    'pt': ['pt', 'disse'],
    'af': ['af', 'sê'],
    'sq': ['sq', 'thotë'],
    'am': ['am', 'አለው'],
    'ar': ['ar', 'يقول'],
    'hy': ['hy', 'կանչում է'],
    'az': ['az', 'deyir'],
    'eu': ['eu', 'esaten'],
    'be': ['be', 'кажа'],
    'bn': ['bn', 'বলে'],
    'bs': ['bs', 'kaže'],
    'bg': ['bg', 'казва'],
    'ca': ['ca', 'diu'],
    'ceb': ['ceb', 'mobuhat'],
    'ny': ['ny', 'anakhalitsa'],
    'cn': ['zh', '说'],
    'zh-cn': ['zh-cn', '说'],
    'zh-tw': ['zh-tw', '說'],
    'co': ['co', 'di'],
    'hr': ['hr', 'kaže'],
    'cs': ['cs', 'říká'],
    'da': ['da', 'siger'],
    'nl': ['nl', 'zegt'],
    'eo': ['eo', 'diras'],
    'et': ['et', 'ütlevad'],
    'tl': ['tl', 'sinasabi'],
    'fi': ['fi', 'sanoo'],
    'fy': ['fy', 'seit'],
    'gl': ['gl', 'di'],
    'ka': ['ka', 'ამოცნობს'],
    'el': ['el', 'λέει'],
    'gu': ['gu', 'કહેતું છે'],
    'ht': ['ht', 'di'],
    'ha': ['ha', 'yace'],
    'haw': ['haw', 'kaʻu'],
    'he': ['he', 'אומר'],
    'hi': ['hi', 'कहते हैं'],
    'hmn': ['hmn', 'tug'],
    'hu': ['hu', 'mondja'],
    'is': ['is', 'segir'],
    'ig': ['ig', 'enye'],
    'id': ['id', 'bilang'],
    'ga': ['ga', 'a dhéanann'],
    'it': ['it', 'dice'],
    'ja': ['ja', '言う'],
    'jw': ['jw', 'ngandika'],
    'kn': ['kn', 'ಹೇಳುತ್ತೇವೆ'],
    'kk': ['kk', 'әйтер'],
    'km': ['km', 'បាននិយាយ'],
    'ko': ['ko', '이야기한다'],
    'ku': ['ku', 'dibêje'],
    'ky': ['ky', 'айтады'],
    'lo': ['lo', 'ພູມ'],
    'la': ['la', 'dicit'],
    'lv': ['lv', 'saka'],
    'lt': ['lt', 'sako'],
    'lb': ['lb', 'seet'],
    'mk': ['mk', 'искаже'],
    'mg': ['mg', 'manao'],
    'ms': ['ms', 'mengatakan'],
    'ml': ['ml', 'പറഞ്ഞു'],
    'mt': ['mt', 'qalt'],
    'mi': ['mi', 'ka whakaahuatia'],
    'mr': ['mr', 'बोलतो'],
    'mn': ['mn', 'өгдөг'],
    'my': ['my', 'ကြေးမှု'],
    'ne': ['ne', 'बोल्छ।'],
    'no': ['no', 'sier'],
    'ps': ['ps', 'مننه'],
    'fa': ['fa', 'گفت'],
    'pl': ['pl', 'mówi'],
    'pa': ['pa', 'ਕਹਿਣਾ'],
    'ro': ['ro', 'spune'],
    'ru': ['ru', 'говорит'],
    'sm': ['sm', 'faʻamau'],
    'gd': ['gd', 'innis'],
    //'sr': ['sr', 'каже'],
    'st': ['st', 'khutla'],
    'sn': ['sn', 'anoda'],
    'sd': ['sd', 'کاندو'],
    'si': ['si', 'කරයි'],
    'sk': ['sk', 'hovorí'],
    'sl': ['sl', 'pravi'],
    //'so': ['so', 'wuxuu yidhi'],
    'es': ['es', 'dice'],
    'su': ['su', 'ngandika'],
    'sw': ['sw', 'anasema'],
    'sv': ['sv', 'säger'],
    'tg': ['tg', 'говорит'],
    'ta': ['ta', 'பேசுகிறது'],
    'te': ['te', 'ప్రబంధించాడు'],
    'th': ['th', 'พูด'],
    'tr': ['tr', 'söyler'],
    'uk': ['uk', 'говорить'],
    'ur': ['ur', 'کہتا ہے'],
    'uz': ['uz', 'deyarli'],
    'vi': ['vi', 'nói'],
    'cy': ['cy', 'dice'],
    'xh': ['xh', 'uthi'],
    'yi': ['yi', 'זאָגט'],
    'yo': ['yo', 'fi'],
    'zu': ['zu', 'ithi'],
    'pinyin': ['zh', 'says'],
    'romaji': ['ja', 'says']
};

const explanations: Record<string, string> = {
    'english': 'You can use our Translator Bot. Start your message by typing !en To translate your message into English. For example: "!en Bonjour"',
};

// Called every time a message comes in
export const translate: CommandFn = async function translate(client, message, channel, tags, _config) {
    try {
        // Remove whitespace from chat message
        const tMsg = message.trim();

        // Filter commands (options)
        if (tMsg[0] !== '!') return;

        // Extract command
        const cmd = tMsg.split(' ')[0].substring(1).toLowerCase();

        // Check rate limiting for translation commands
        if (isValidLanguageCode(cmd)) {
            if (!checkRateLimit(tags.username)) {
                await client.say(channel, `@${tags.username}, please wait before making more translation requests.`);
                return;
            }
        }

        // Command for displaying the commands (in english)
        if (cmd === "lang" || cmd === "translate") {
            await client.say(channel, `@${tags.username}, I can translate your messages in many languages. Use !<language_code> <text> (e.g., !en Bonjour). Supported codes: en, de, fr, es, pt, ja, zh, ko, etc.`);
            return;
        }

        // Commands for displaying messages explaining the translation feature in various languages
        if (cmd in explanations) {
            await client.say(channel, `@${tags.username}, ${explanations[cmd]}`);
            return;
        }

        // Validate language code
        if (!isValidLanguageCode(cmd)) {
            return; // Silently ignore invalid language codes
        }

        const ll = tr_lang[cmd];
        let txt = tMsg.substring(1 + cmd.length).trim();

        // Sanitize input text
        txt = sanitizeTranslationText(txt);

        // Text must be at least 2 characters
        if (txt.length < 2) {
            await client.say(channel, `@${tags.username}, please provide text to translate (minimum 2 characters).`);
            return;
        }

        // Handle long text with lazy mode
        let lazy = false;
        if (txt.length > 150) {
            lazy = true;
            txt = "Text too long - please use shorter messages for translation";
        }

        // Lazy mode, and english target => no translation, only displays 'lazy' message in english
        if (lazy === true && ll[0].indexOf('en') === 0) {
            await client.say(channel, `@${tags.username}, ${txt}`);
            return;
        }

        try {
            // Translate text with timeout protection
            const res = await safeTranslate(txt, { to: ll[0] });

            if (cmd === 'pinyin') {
                // Special handling for pinyin - only show pinyin pronunciation
                const pronunciation = res.pronunciation || 'N/A';
                const responseMsg = truncateMessage(`@${tags.username} | pinyin: ${pronunciation}`);
                await client.say(channel, responseMsg);
            } else if (cmd === 'romaji') {
                // Special handling for romaji - only show romaji pronunciation
                const pronunciation = res.pronunciation || 'N/A';
                const responseMsg = truncateMessage(`@${tags.username} | romaji: ${pronunciation}`);
                await client.say(channel, responseMsg);
            } else if (lazy === true) {
                // Lazy mode sentence in english and also in requested language
                const translation = res.text || 'Translation unavailable';
                const responseMsg = truncateMessage(`@${tags.username}, ${txt} / ${translation}`);
                await client.say(channel, responseMsg);
            } else {
                // Normal translation
                const pronunciation = res.pronunciation || '';
                const translation = res.text || 'Translation unavailable';
                const connector = ll[1] || 'says';

                let responseMsg: string;
                if (pronunciation && pronunciation !== translation) {
                    responseMsg = truncateMessage(`@${tags.username} ${connector}: ${pronunciation}: ${translation}`);
                } else {
                    responseMsg = truncateMessage(`@${tags.username} ${connector}: ${translation}`);
                }
                await client.say(channel, responseMsg);
            }

        } catch (error) {
            if (error instanceof Error) {
                console.error(`[TRANSLATE] Translation error for user ${tags.username}:`, {
                    message: error.message,
                    language: cmd,
                    timestamp: new Date().toISOString()
                });
            }
            await client.say(channel, `@${tags.username}, translation service temporarily unavailable.`);
        }

    } catch (error) {
        if (error instanceof Error) {
            console.error(`[TRANSLATE] Error for user ${tags.username}:`, {
                message: error.message,
                timestamp: new Date().toISOString()
            });
        }
        await client.say(channel, `@${tags.username}, translation service encountered an error.`);
    }
};
