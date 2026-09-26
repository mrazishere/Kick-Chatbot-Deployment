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
 *   - NOT mixed script (no ASCII-Latin letters AND non-Latin script chars
 *     in the same message — e.g. "茶餐厅 of course lah" → silent)
 *   - contains at least one non-ASCII character, UNLESS a language allowlist
 *     is set (see below) — that exception is what catches plain "Wie geht es
 *     dir?", typed without an umlaut
 *   - length threshold: ≥8 chars for Latin-script (Spanish/French/etc.),
 *     ≥2 chars for pure non-Latin scripts (allows short CJK greetings),
 *     ≥12 chars and ≥3 words for plain-ASCII text
 *   - Google's translation succeeds
 *   - Google's detected source is NOT English
 *   - the detected source is on config.autoTranslate.languages, when that
 *     list is non-empty
 *   - normalized translation differs from normalized input
 *
 * That single gate replaces ~80 lines of previously-stacked heuristic patches
 * (English chat-token allowlist, suspicious-language blacklist, CJK fraction
 * math, confidence gates, dominance checks). It's strict — with no allowlist
 * it WILL miss legit translations (e.g. German or Spanish typed without
 * umlauts/accents, very short CJK, pinyin/romaji). Naming the languages you
 * want recovers the undiacriticized ones; the rest is the trade-off you
 * signed up for.
 *
 * config.autoTranslate.languages is an allowlist of ISO-639 source codes, e.g.
 * ["de"]. Empty or absent means "every language but English", the original
 * behaviour. Setting it does two things at once: it silences the languages not
 * on it, and it lets plain-ASCII text past the pre-filter. The second is only
 * safe because of the first — Google's verdict then has to name a language the
 * channel actually asked for, which is what keeps English and Singlish out.
 * Measured on 80 real ASCII-only messages from a Singlish-heavy channel, 0 were
 * detected as German (spread: en 75, ms/mi/kha/da/id 1 each).
 */

import gtrans from 'googletrans';
import { CommandFn, AutoTranslateConfig } from '../types';
import { wasRecentBotOutput } from '../recent-bot-outputs';
import { isBotSender } from '../bot-identity';
import { sendToBroadcaster } from '../cross-channel-send';

const KICK_MESSAGE_LIMIT = 500;
const TRANSLATE_TIMEOUT_MS = 8000;

// Floors for plain-ASCII Latin text, which carries no script evidence at all and
// is admitted only when an allowlist is set. Detection on three words of chat
// slang is a coin flip, so short ASCII messages stay out either way.
const ASCII_MIN_LEN = 12;
const ASCII_MIN_WORDS = 3;

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

/**
 * The channel's source-language allowlist, normalised to base ISO codes.
 * Empty means no restriction — every language but English, as before.
 */
function allowedLanguages(settings: AutoTranslateConfig): string[] {
    if (!Array.isArray(settings.languages)) return [];
    return settings.languages
        .map(l => String(l).trim().toLowerCase().split('-')[0])
        .filter(l => l.length > 0);
}

function passesStrictGate(text: string, allowAsciiOnly: boolean): boolean {
    const hasAsciiLatin = ASCII_LATIN_LETTER.test(text);
    const hasNonLatin = NON_LATIN_SCRIPT.test(text);
    // Mixed script — silence
    if (hasAsciiLatin && hasNonLatin) return false;
    if (!NON_ASCII.test(text)) {
        // No umlaut, no accent, no non-Latin script: nothing in the text itself
        // says this isn't English. Only an allowlist makes it safe to ask Google,
        // because the answer then has to name a language the channel asked for.
        if (!allowAsciiOnly) return false;
        if (text.length < ASCII_MIN_LEN) return false;
        if (text.split(/\s+/).filter(Boolean).length < ASCII_MIN_WORDS) return false;
        return true;
    }
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

    const allowed = allowedLanguages(settings);

    if (isLowSignal(text)) return;
    if (!passesStrictGate(text, allowed.length > 0)) return;

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

        // A language the channel didn't ask for. Checked on the resolved label so
        // the script fallback is filtered too: with ["de"] set, Chinese stays silent
        // even when Google mislabels it English and the Han fallback names it zh.
        if (allowed.length > 0 && !allowed.includes(sourceLabel)) return;

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
