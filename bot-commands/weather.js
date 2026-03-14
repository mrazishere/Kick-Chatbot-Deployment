/**
 * Kick chat weather command
 *
 * Description: Shows current weather for the channel's current location (or a named place).
 *              Uses wttr.in (free, no API key required).
 *
 * Permission required: All users (rate-limited: 5 requests per 60 seconds)
 *
 * Usage:
 *   !weather              — current weather at channel's current location
 *   !weather <place>      — current weather at a named place (city, country, etc.)
 */

// ─── Section 1: Module-level constants and Maps ────────────────────────────────

const WEATHER_CACHE = new Map();      // key: location string (lowercased), value: { data, expiresAt }
const WEATHER_RATE_LIMIT_MAP = new Map();
const WEATHER_CACHE_TTL = 1800000;    // 30 minutes ms
const WEATHER_RATE_LIMIT_WINDOW = 60000; // 60 seconds ms
const WEATHER_MAX_REQUESTS = 5;
const WEATHER_MAX_CACHE_SIZE = 100;

// ─── Section 2: Rate limiting ──────────────────────────────────────────────────

function checkWeatherRateLimit(username) {
    const now = Date.now();
    const userRequests = WEATHER_RATE_LIMIT_MAP.get(username) || [];
    const validRequests = userRequests.filter(ts => now - ts < WEATHER_RATE_LIMIT_WINDOW);

    if (validRequests.length >= WEATHER_MAX_REQUESTS) {
        return false; // Rate limited
    }

    validRequests.push(now);
    WEATHER_RATE_LIMIT_MAP.set(username, validRequests);
    return true; // Not rate limited
}

// ─── Section 3: Weather cache (30-minute TTL, 100-entry cap) ──────────────────

function getCachedWeather(key) {
    const entry = WEATHER_CACHE.get(key);
    if (entry && entry.expiresAt > Date.now()) {
        return entry.data;
    }
    if (entry) {
        WEATHER_CACHE.delete(key);
    }
    return null;
}

function setCachedWeather(key, data) {
    if (WEATHER_CACHE.size >= WEATHER_MAX_CACHE_SIZE) {
        const oldestKey = WEATHER_CACHE.keys().next().value;
        WEATHER_CACHE.delete(oldestKey);
    }
    WEATHER_CACHE.set(key, { data, expiresAt: Date.now() + WEATHER_CACHE_TTL });
}

// ─── Section 4: Location object to query string ───────────────────────────────

function locationObjToString(loc) {
    if (!loc) return null;
    return loc.city || loc.state || loc.province || loc.country || null;
}

// ─── Section 5: Weather condition emoji ───────────────────────────────────────

function weatherCodeToEmoji(code) {
    const n = parseInt(code, 10);
    if (n === 113) return '☀️';
    if (n === 116) return '⛅';
    if (n === 119 || n === 122) return '☁️';
    if ([143, 248, 260].includes(n)) return '🌫️';
    if ([200, 386, 389, 392, 395].includes(n)) return '⛈️';
    if ([179, 227, 230, 323, 326, 329, 332, 335, 338, 368, 371, 374, 377].includes(n)) return '❄️';
    if ([176, 293, 296, 299, 302, 305, 308, 353, 356, 359].includes(n)) return '🌧️';
    return '🌡️';
}

// ─── Section 6: Weather fetcher ───────────────────────────────────────────────

async function fetchWeather(locationQuery) {
    const cacheKey = locationQuery.toLowerCase();
    const cached = getCachedWeather(cacheKey);
    if (cached) return cached;

    const fetchFn = globalThis.fetch ?? require('node-fetch');
    const url = `https://wttr.in/${encodeURIComponent(locationQuery)}?format=j1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
        response = await fetchFn(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(`[WEATHER] API ${response.status} for "${locationQuery}"`);
    }

    const data = await response.json();
    const condition = data.current_condition?.[0];
    if (!condition) {
        throw new Error(`[WEATHER] No condition data for "${locationQuery}"`);
    }

    const area = data.nearest_area?.[0];
    const resolvedCity = area?.areaName?.[0]?.value || '';
    const resolvedCountry = area?.country?.[0]?.value || '';

    const result = {
        city: resolvedCity,
        country: resolvedCountry,
        tempC: condition.temp_C,
        tempF: condition.temp_F,
        desc: condition.weatherDesc?.[0]?.value || 'Unknown',
        humidity: condition.humidity,
        windKmph: condition.windspeedKmph,
        windDir: condition.winddir16Point,
        weatherCode: condition.weatherCode
    };

    setCachedWeather(cacheKey, result);
    return result;
}

// ─── Section 7: Exported weather() function ───────────────────────────────────

exports.weather = async function weather(client, message, channel, tags, config) {
    let username;
    try {
        username = tags.username;

        // 0. Prefix guard — only respond to !weather messages
        const input = message.trim().split(/\s+/);
        if (input[0] !== '!weather') return;

        // 1. Rate limit check — silent ignore on excess
        if (!checkWeatherRateLimit(username)) return;

        // 2. Determine location query
        let locationQuery;

        if (input.length > 1) {
            // Explicit place: !weather <place>
            locationQuery = input.slice(1).join(' ');
        } else {
            // Use channel's current location
            const locationStr = locationObjToString(config?.location?.current);
            if (!locationStr) {
                client.say(channel, `@${username}, current location not set. Use !location current set <place>.`);
                return;
            }
            locationQuery = locationStr;
        }

        // 3. Fetch weather
        const w = await fetchWeather(locationQuery);

        // 4. Format and send response
        const emoji = weatherCodeToEmoji(w.weatherCode);
        const location = [w.city, w.country].filter(Boolean).join(', ') || locationQuery;
        client.say(channel, `@${username}, ${location} ${emoji}: ${w.tempC}°C / ${w.tempF}°F, ${w.desc}, Humidity: ${w.humidity}%, Wind: ${w.windKmph} km/h ${w.windDir}`);

    } catch (err) {
        console.error('[WEATHER] Unhandled error:', err.message);
        try {
            client.say(channel, `@${username || 'user'}, weather service temporarily unavailable.`);
        } catch (_) {}
    }
};
