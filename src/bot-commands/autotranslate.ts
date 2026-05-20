/**
 * Auto-translate non-English chat messages to English — STRICT MODE.
 *
 * Philosophy: silence is better than a weird translation. The bot only fires
 * when there's unambiguous evidence the message is non-English and proper.
 * Mixed-language messages, short slang, romanized text, and undiacriticized
 * Latin-script chat are all silenced.
 *
 * Gate (all must be true):
 *   - opt-in via config.autoTranslate.enabled
 *   - not a command (`!`-prefixed)
 *   - not from the bot itself (identity check + echo store)
 *   - contains at least one non-ASCII character
 *   - NOT mixed script (no ASCII-Latin letters AND non-Latin script chars
 *     in the same message — e.g. "茶餐厅 of course lah" → silent)
 *   - length threshold: ≥8 chars for Latin-script (Spanish/French/etc.),
 *     ≥2 chars for pure non-Latin scripts (allows short CJK greetings)
 *   - Google's translation succeeds
 *   - Google's detected source is NOT English
 *   - normalized translation differs from normalized input
 *
 * That single gate replaces ~80 lines of previously-stacked heuristic patches
 * (English chat-token allowlist, suspicious-language blacklist, CJK fraction
 * math, confidence gates, dominance checks). It's strict — it WILL miss some
 * legit translations (e.g. Spanish typed without accents, very short CJK,
 * pinyin/romaji). That's the trade-off you signed up for.
 */

import gtrans from 'googletrans';
import { CommandFn, AutoTranslateConfig } from '../types';
import { wasRecentBotOutput } from '../recent-bot-outputs';
import { isBotSender } from '../bot-identity';
import { sendToBroadcaster } from '../cross-channel-send';

const KICK_MESSAGE_LIMIT = 500;
const TRANSLATE_TIMEOUT_MS = 8000;

// Optional per-channel rate limit. Disabled unless autoTranslate.rateLimitPerMinute > 0.
const channelRateLimit = new Map<string, number[]>();
const CHANNEL_WINDOW_MS = 60_000;

function channelRateLimitOk(channel: string, maxPerWindow: number): boolean {
    if (maxPerWindow <= 0) return true;
    const now = Date.now();
    const list = (channelRateLimit.get(channel) || []).filter(t => now - t < CHANNEL_WINDOW_MS);
    if (list.length >= maxPerWindow) {
        channelRateLimit.set(channel, list);
        return false;
    }
    list.push(now);
    channelRateLimit.set(channel, list);
    return true;
}

const ASCII_LATIN_LETTER = /[a-zA-Z]/;
const NON_ASCII = /[^\x00-\x7F]/;
// Scripts that aren't Latin at all — presence alongside ASCII Latin = mixed.
const NON_LATIN_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Script=Cyrillic}|\p{Script=Arabic}|\p{Script=Hebrew}|\p{Script=Thai}|\p{Script=Devanagari}|\p{Script=Bengali}|\p{Script=Greek}/u;

// Used when Google's reported `src` is wrong/missing (it occasionally returns
// `src: 'en'` for non-English non-Latin input even though it translates
// correctly). We trust the script over Google's verdict in that case.
function scriptCodeFallback(text: string): string {
    if (/\p{Script=Hangul}/u.test(text)) return 'ko';
    if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'ja';
    if (/\p{Script=Han}/u.test(text)) return 'zh';
    if (/\p{Script=Cyrillic}/u.test(text)) return 'ru';
    if (/\p{Script=Arabic}/u.test(text)) return 'ar';
    if (/\p{Script=Hebrew}/u.test(text)) return 'he';
    if (/\p{Script=Thai}/u.test(text)) return 'th';
    if (/\p{Script=Devanagari}/u.test(text)) return 'hi';
    if (/\p{Script=Bengali}/u.test(text)) return 'bn';
    if (/\p{Script=Greek}/u.test(text)) return 'el';
    return '';
}

function passesStrictGate(text: string): boolean {
    if (!NON_ASCII.test(text)) return false;
    const hasAsciiLatin = ASCII_LATIN_LETTER.test(text);
    const hasNonLatin = NON_LATIN_SCRIPT.test(text);
    // Mixed script — silence
    if (hasAsciiLatin && hasNonLatin) return false;
    // Length floor — looser for pure non-Latin (CJK greetings)
    const minLen = hasAsciiLatin ? 8 : 2;
    if (text.length < minLen) return false;
    return true;
}

// Quick reject for URL-only / emoji-only / mention-only messages.
function isLowSignal(text: string): boolean {
    const stripped = text
        .replace(/https?:\/\/\S+/g, '')
        .replace(/@\S+/g, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    const letters = (stripped.match(/\p{L}/gu) || []).length;
    return letters < 2;
}

function truncate(msg: string): string {
    if (msg.length <= KICK_MESSAGE_LIMIT) return msg;
    return msg.substring(0, KICK_MESSAGE_LIMIT - 3) + '...';
}

// Lowercase, strip combining diacritics, keep only letters/digits — used to
// compare input vs translation to detect "Google didn't actually translate".
function normalizeForCompare(s: string): string {
    return s
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

interface TranslateResult {
    text: string;
    src: string;
}

async function safeTranslate(text: string): Promise<TranslateResult> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('translate-timeout')), TRANSLATE_TIMEOUT_MS);
        gtrans(text, { to: 'en' })
            .then(res => {
                clearTimeout(timer);
                const r = res as { text?: string; src?: string };
                resolve({ text: r.text || '', src: (r.src || '').toLowerCase() });
            })
            .catch(err => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

export const autotranslate: CommandFn = async function autotranslate(client, message, channel, tags, config) {
    const settings = config.autoTranslate as AutoTranslateConfig | undefined;
    if (!settings?.enabled) return;

    const text = message.trim();
    if (!text) return;
    if (text.startsWith('!')) return;

    if (isBotSender(tags.username, tags.senderId)) return;
    if (wasRecentBotOutput(channel, text)) return;

    if (isLowSignal(text)) return;
    if (!passesStrictGate(text)) return;

    const maxPerWindow = settings.rateLimitPerMinute ?? 0;
    if (!channelRateLimitOk(channel, maxPerWindow)) {
        console.log(`[AUTOTRANSLATE] Rate limit hit on ${channel}, skipping`);
        return;
    }

    try {
        const result = await safeTranslate(text);
        const translated = result.text;
        if (!translated) return;

        // Determine source label. Trust Google's src unless it's missing or
        // gives 'en' for input that demonstrably contains non-Latin script
        // (Google sometimes returns 'en' as src for Chinese/Japanese/Korean
        // even when it translates correctly — a known googletrans quirk).
        const srcBase = result.src.split('-')[0];
        const scriptFallback = scriptCodeFallback(text);
        let sourceLabel: string;
        if (srcBase && srcBase !== 'en') {
            sourceLabel = srcBase;
        } else if (scriptFallback) {
            sourceLabel = scriptFallback;
        } else if (srcBase === 'en') {
            // Pure-Latin input that Google calls English — trust Google, skip.
            return;
        } else {
            return;
        }

        // Nothing actually changed once normalized — Google didn't translate.
        if (normalizeForCompare(translated) === normalizeForCompare(text)) return;

        const sourcePrefix = settings.shadowSourceLabel ? `[${settings.shadowSourceLabel}] ` : '';
        const out = truncate(`${sourcePrefix}@${tags.username} (${sourceLabel}->en): ${translated}`);

        if (settings.logOnly) {
            console.log(`[AUTOTRANSLATE][log-only][${channel}] ${out}`);
            return;
        }

        if (settings.shadowTargetBroadcasterId) {
            await sendToBroadcaster(settings.shadowTargetBroadcasterId, out);
        } else {
            await client.say(channel, out);
        }
    } catch (err) {
        if (err instanceof Error) {
            console.error(`[AUTOTRANSLATE] Failed for ${tags.username} on ${channel}: ${err.message}`);
        }
    }
};
