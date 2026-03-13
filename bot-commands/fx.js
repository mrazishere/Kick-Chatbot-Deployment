/**
 * Kick chat currency exchange (!fx) command
 *
 * Description: Converts currencies using live exchange rates with 1-hour caching.
 *              Resolves location names to ISO 4217 currency codes via Claude Haiku.
 *
 * Permission required: All users (rate-limited: 5 requests per 60 seconds)
 *
 * Usage:
 *   !fx                         — convert 100 units, current location → home location
 *   !fx <amount>                — convert <amount> units, current → home
 *   !fx <place> [amount]        — convert from place's currency to home currency
 *   !fx <FROM> <TO> [amount]    — convert FROM currency code to TO currency code
 */

// ─── Section 1: Module-level constants and Maps ────────────────────────────────

const EXCHANGERATE_API_KEY = 'process.env.EXCHANGERATE_API_KEY';
const RATE_CACHE = new Map();        // key: 'USD/THB', value: { conversionRate, rateDate, expiresAt }
const LOCATION_CACHE = new Map();    // key: 'bangkok' (lowercased), value: { isoCode, expiresAt }
const RATE_LIMIT_MAP = new Map();    // key: username, value: [timestamp, ...]
const RATE_CACHE_TTL = 3600000;      // 1 hour ms
const LOCATION_CACHE_TTL = 86400000; // 24 hours ms
const RATE_LIMIT_WINDOW = 60000;     // 60 seconds ms
const MAX_REQUESTS = 5;
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY', 'KRW', 'ISK']);
const MAX_CACHE_SIZE = 100;

// ─── Section 2: Rate limiting ──────────────────────────────────────────────────

function checkRateLimit(username) {
    const now = Date.now();
    const userRequests = RATE_LIMIT_MAP.get(username) || [];

    // Remove old requests outside the window
    const validRequests = userRequests.filter(ts => now - ts < RATE_LIMIT_WINDOW);

    if (validRequests.length >= MAX_REQUESTS) {
        return false; // Rate limited
    }

    validRequests.push(now);
    RATE_LIMIT_MAP.set(username, validRequests);
    return true; // Not rate limited
}

// ─── Section 3: Rate cache (1-hour TTL, 100-entry cap) ────────────────────────

function getCachedRate(key) {
    const entry = RATE_CACHE.get(key);
    if (entry && entry.expiresAt > Date.now()) {
        return entry;
    }
    if (entry) {
        RATE_CACHE.delete(key);
    }
    return null;
}

function setCachedRate(key, value) {
    if (RATE_CACHE.size >= MAX_CACHE_SIZE) {
        const oldestKey = RATE_CACHE.keys().next().value;
        RATE_CACHE.delete(oldestKey);
    }
    RATE_CACHE.set(key, { ...value, expiresAt: Date.now() + RATE_CACHE_TTL });
}

// ─── Section 3b: Location cache (24-hour TTL, 100-entry cap) ──────────────────

function getCachedLocation(key) {
    const entry = LOCATION_CACHE.get(key);
    if (entry && entry.expiresAt > Date.now()) {
        return entry.isoCode;
    }
    if (entry) {
        LOCATION_CACHE.delete(key);
    }
    return null;
}

function setCachedLocation(key, isoCode) {
    if (LOCATION_CACHE.size >= MAX_CACHE_SIZE) {
        const oldestKey = LOCATION_CACHE.keys().next().value;
        LOCATION_CACHE.delete(oldestKey);
    }
    LOCATION_CACHE.set(key, { isoCode, expiresAt: Date.now() + LOCATION_CACHE_TTL });
}

// ─── Section 4: Amount formatter ──────────────────────────────────────────────

function formatAmount(amount, currencyCode) {
    if (ZERO_DECIMAL_CURRENCIES.has(currencyCode)) {
        return Math.round(amount).toLocaleString('en-US');
    }
    return amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Section 5: Location object to string ─────────────────────────────────────

function locationObjToString(loc) {
    if (!loc) return null;
    return loc.city || loc.state || loc.province || loc.country || null;
}

// ─── Section 6: Argument parser ───────────────────────────────────────────────

function parseArgs(message) {
    const parts = message.trim().split(/\s+/);
    // Remove '!fx' prefix
    const args = parts.slice(1);

    const defaultAmount = 100;

    if (args.length === 0) {
        return { form: 'implicit', locationTokens: [], amount: defaultAmount };
    }

    const last = args[args.length - 1];
    const parsedLast = parseFloat(last.replace(/,/g, ''));
    const lastIsNumber = !isNaN(parsedLast) && parsedLast > 0;

    let amount = defaultAmount;
    let tokens = args;

    if (lastIsNumber) {
        amount = parsedLast;
        tokens = args.slice(0, args.length - 1);
    }

    if (tokens.length === 0) {
        return { form: 'implicit', locationTokens: [], amount };
    }

    // Check if exactly 2 tokens and both look like ISO currency codes
    if (tokens.length === 2 && /^[A-Z]{3}$/i.test(tokens[0]) && /^[A-Z]{3}$/i.test(tokens[1])) {
        return {
            form: 'pair',
            fromToken: tokens[0].toUpperCase(),
            toToken: tokens[1].toUpperCase(),
            amount
        };
    }

    return { form: 'single', locationTokens: tokens, amount };
}

// ─── Section 7: Claude Haiku location resolver ────────────────────────────────

async function resolveLocationToIso(locationString) {
    if (!locationString) return null;

    const cacheKey = locationString.toLowerCase();
    const cached = getCachedLocation(cacheKey);
    if (cached) return cached;

    const fetchFn = globalThis.fetch ?? require('node-fetch');

    const systemPrompt =
        'You are a currency code resolver. Given a place name (country, city, region, or state), ' +
        'return ONLY the ISO 4217 currency code for that place ' +
        "(e.g., 'Bangkok' → 'THB', 'Germany' → 'EUR', 'New Zealand' → 'NZD'). " +
        'Return ONLY the 3-letter ISO code. If unknown, return UNKNOWN.';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
        const response = await fetchFn('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                system: systemPrompt,
                messages: [{ role: 'user', content: locationString }]
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        const data = await response.json();
        const isoCode = data.content?.[0]?.text?.trim().toUpperCase();

        if (isoCode && /^[A-Z]{3}$/.test(isoCode) && isoCode !== 'UNKNOWN' && isoCode !== 'UNK') {
            setCachedLocation(cacheKey, isoCode);
            return isoCode;
        }

        return null;
    } catch (err) {
        clearTimeout(timer);
        console.error('[FX] Claude resolution error:', err.message);
        return null;
    }
}

// ─── Section 8: Exchange rate fetcher ─────────────────────────────────────────

async function fetchRate(fromCode, toCode) {
    const cacheKey = `${fromCode}/${toCode}`;
    const cached = getCachedRate(cacheKey);
    if (cached) return cached;

    const fetchFn = globalThis.fetch ?? require('node-fetch');
    const url = `https://v6.exchangerate-api.com/v6/${EXCHANGERATE_API_KEY}/pair/${fromCode}/${toCode}`;

    const response = await fetchFn(url);

    if (!response.ok) {
        throw new Error(`[FX] API ${response.status}: ${fromCode}→${toCode}`);
    }

    const data = await response.json();
    const rateDate = new Date(data.time_last_update_utc).toISOString().slice(0, 10);
    const entry = { conversionRate: data.conversion_rate, rateDate };

    setCachedRate(cacheKey, entry);
    return entry;
}

// ─── Section 9: Exported fx() function ────────────────────────────────────────

exports.fx = async function fx(client, message, channel, tags, config) {
    let username;
    try {
        username = tags.username;

        // 1. Rate limit check — silent ignore on excess
        if (!checkRateLimit(username)) return;

        // 2. Parse the message
        const parsed = parseArgs(message);

        // 3. Resolve fromCode and toCode based on form
        let fromCode, toCode;

        if (parsed.form === 'implicit') {
            const fromStr = locationObjToString(config.location?.current);
            const toStr = locationObjToString(config.location?.home);

            if (!fromStr) {
                client.say(channel, `@${username}, current location not set. Use !location current set <place>.`);
                return;
            }
            if (!toStr) {
                client.say(channel, `@${username}, home location not set. Use !location home set <place>.`);
                return;
            }

            fromCode = await resolveLocationToIso(fromStr);
            toCode = await resolveLocationToIso(toStr);

            if (!fromCode) {
                client.say(channel, `@${username}, could not resolve current location to a currency.`);
                return;
            }
            if (!toCode) {
                client.say(channel, `@${username}, could not resolve home location to a currency.`);
                return;
            }

        } else if (parsed.form === 'pair') {
            fromCode = parsed.fromToken;
            toCode = parsed.toToken;

        } else {
            // form === 'single'
            const locationStr = parsed.locationTokens.join(' ');
            fromCode = await resolveLocationToIso(locationStr);

            const toStr = locationObjToString(config.location?.home);

            if (!fromCode) {
                client.say(channel, `@${username}, could not resolve "${locationStr}" to a currency.`);
                return;
            }
            if (!toStr) {
                client.say(channel, `@${username}, home location not set. Use !location home set <place>.`);
                return;
            }

            toCode = await resolveLocationToIso(toStr);

            if (!toCode) {
                client.say(channel, `@${username}, could not resolve home location to a currency.`);
                return;
            }
        }

        // 4. Same-currency short circuit
        if (fromCode === toCode) {
            const fmt = formatAmount(parsed.amount, fromCode);
            client.say(channel, `@${username}, ${fmt} ${fromCode} = ${fmt} ${toCode} (same currency)`);
            return;
        }

        // 5. Fetch exchange rate and format output
        const { conversionRate, rateDate } = await fetchRate(fromCode, toCode);
        const result = conversionRate * parsed.amount;
        const fromFormatted = formatAmount(parsed.amount, fromCode);
        const toFormatted = formatAmount(result, toCode);

        client.say(channel, `@${username}, ${fromFormatted} ${fromCode} = ${toFormatted} ${toCode} (${rateDate})`);

    } catch (err) {
        console.error('[FX] Unhandled error:', err.message);
        try {
            client.say(channel, `@${username || 'user'}, exchange rate service temporarily unavailable.`);
        } catch (_) {}
    }
};
