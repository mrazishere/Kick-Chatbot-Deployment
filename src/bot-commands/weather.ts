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

import fetch from 'node-fetch';
import { CommandFn, LocationSubfields } from '../types';

// ─── Section 1: Module-level constants and Maps ────────────────────────────────

interface WeatherResult {
  city: string;
  country: string;
  tempC: string;
  tempF: string;
  desc: string;
  humidity: string;
  windKmph: string;
  windDir: string;
  weatherCode: string;
}

const WEATHER_CACHE = new Map<string, { data: WeatherResult; expiresAt: number }>();
const WEATHER_RATE_LIMIT_MAP = new Map<string, number[]>();
const WEATHER_CACHE_TTL = 1800000;    // 30 minutes ms
const WEATHER_RATE_LIMIT_WINDOW = 60000; // 60 seconds ms
const WEATHER_MAX_REQUESTS = 5;
const WEATHER_MAX_CACHE_SIZE = 100;

// ─── Section 2: Rate limiting ──────────────────────────────────────────────────

function checkWeatherRateLimit(username: string): boolean {
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

function getCachedWeather(key: string): WeatherResult | null {
    const entry = WEATHER_CACHE.get(key);
    if (entry && entry.expiresAt > Date.now()) {
        return entry.data;
    }
    if (entry) {
        WEATHER_CACHE.delete(key);
    }
    return null;
}

function setCachedWeather(key: string, data: WeatherResult): void {
    if (WEATHER_CACHE.size >= WEATHER_MAX_CACHE_SIZE) {
        const oldestKey = WEATHER_CACHE.keys().next().value;
        if (oldestKey !== undefined) {
            WEATHER_CACHE.delete(oldestKey);
        }
    }
    WEATHER_CACHE.set(key, { data, expiresAt: Date.now() + WEATHER_CACHE_TTL });
}

// ─── Section 4: Location object to query string ───────────────────────────────

function locationObjToString(loc: LocationSubfields | undefined): string | null {
    if (!loc) return null;
    return loc.city || loc.state || loc.province || loc.country || null;
}

// ─── Section 5: Weather condition emoji ───────────────────────────────────────

function weatherCodeToEmoji(code: string): string {
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

// ─── Section 6: Weather API response shape ────────────────────────────────────

interface WttrCondition {
    temp_C?: string;
    temp_F?: string;
    weatherDesc?: Array<{ value?: string }>;
    humidity?: string;
    windspeedKmph?: string;
    winddir16Point?: string;
    weatherCode?: string;
}

interface WttrAreaEntry {
    value?: string;
}

interface WttrArea {
    areaName?: WttrAreaEntry[];
    country?: WttrAreaEntry[];
}

interface WttrResponse {
    current_condition?: WttrCondition[];
    nearest_area?: WttrArea[];
}

// ─── Section 7: Weather fetcher ───────────────────────────────────────────────

async function fetchWeather(locationQuery: string): Promise<WeatherResult> {
    const cacheKey = locationQuery.toLowerCase();
    const cached = getCachedWeather(cacheKey);
    if (cached) return cached;

    const url = `https://wttr.in/${encodeURIComponent(locationQuery)}?format=j1`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
        response = await fetch(url, { signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new Error(`[WEATHER] API ${response.status} for "${locationQuery}"`);
    }

    const data = await response.json() as WttrResponse;
    const condition = data.current_condition?.[0];
    if (!condition) {
        throw new Error(`[WEATHER] No condition data for "${locationQuery}"`);
    }

    const area = data.nearest_area?.[0];
    const resolvedCity = area?.areaName?.[0]?.value || '';
    const resolvedCountry = area?.country?.[0]?.value || '';

    const result: WeatherResult = {
        city: resolvedCity,
        country: resolvedCountry,
        tempC: condition.temp_C || '',
        tempF: condition.temp_F || '',
        desc: condition.weatherDesc?.[0]?.value || 'Unknown',
        humidity: condition.humidity || '',
        windKmph: condition.windspeedKmph || '',
        windDir: condition.winddir16Point || '',
        weatherCode: condition.weatherCode || ''
    };

    setCachedWeather(cacheKey, result);
    return result;
}

// ─── Section 8: Exported weather() function ───────────────────────────────────

export const weather: CommandFn = async function weather(client, message, channel, tags, config) {
    let username: string | undefined;
    try {
        username = tags.username;

        // 0. Prefix guard — only respond to !weather messages
        const input = message.trim().split(/\s+/);
        if (input[0] !== '!weather') return;

        // 1. Rate limit check — silent ignore on excess
        if (!checkWeatherRateLimit(username)) return;

        // 2. Determine location query
        let locationQuery: string;

        if (input.length > 1) {
            // Explicit place: !weather <place>
            locationQuery = input.slice(1).join(' ');
        } else {
            // Use channel's current location
            const locationStr = locationObjToString(config.location?.current);
            if (!locationStr) {
                await client.say(channel, `@${username}, current location not set. Use !location current set <place>.`);
                return;
            }
            locationQuery = locationStr;
        }

        // 3. Fetch weather
        const w = await fetchWeather(locationQuery);

        // 4. Format and send response
        const emoji = weatherCodeToEmoji(w.weatherCode);
        const location = [w.city, w.country].filter(Boolean).join(', ') || locationQuery;
        await client.say(channel, `@${username}, ${location} ${emoji}: ${w.tempC}°C / ${w.tempF}°F, ${w.desc}, Humidity: ${w.humidity}%, Wind: ${w.windKmph} km/h ${w.windDir}`);

    } catch (err) {
        if (err instanceof Error) {
            console.error('[WEATHER] Unhandled error:', err.message);
        }
        try {
            await client.say(channel, `@${username || 'user'}, weather service temporarily unavailable.`);
        } catch (_) {}
    }
};
