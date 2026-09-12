import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE: string = path.join(__dirname, '.session.json');
// Sanctum tokens on Kick expire after ~24h; refresh proactively at 20h
const TOKEN_TTL_MS: number = 20 * 60 * 60 * 1000;

class KickSessionAuth {
  private _token: string | null = null;
  private _savedAt: number | null = null;

  constructor() {
    this._token = null;
    this._savedAt = null;
  }

  _load(): void {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')) as { token: string; savedAt: number };
        this._token = data.token;
        this._savedAt = data.savedAt;
      }
    } catch (e) {
      if (e instanceof Error) {
        console.warn('[SESSION] Failed to load session from', SESSION_FILE + ':', e.message);
      }
      console.warn('[SESSION] Bot will attempt fresh login on next getToken() call');
    }
  }

  _save(token: string): void {
    this._token = token;
    this._savedAt = Date.now();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ token, savedAt: this._savedAt }, null, 2));
  }

  _isExpired(): boolean {
    if (!this._token || !this._savedAt) return true;
    return (Date.now() - this._savedAt) > TOKEN_TTL_MS;
  }

  async login(): Promise<string> {
    const email = process.env.KICK_BOT_EMAIL;
    const password = process.env.KICK_BOT_PASSWORD;

    if (!email || !password) {
      throw new Error('[SESSION] KICK_BOT_EMAIL or KICK_BOT_PASSWORD not set');
    }

    console.log('[SESSION] Logging in to Kick...');
    const response = await axios.post('https://kick.com/mobile/login', {
      email,
      password
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const token: string | undefined = response.data?.token;
    if (!token) {
      throw new Error('[SESSION] Login succeeded but no token in response: ' + JSON.stringify(response.data).substring(0, 200));
    }

    this._save(token);
    console.log('[SESSION] Login successful, token cached');
    return token;
  }

  async getToken(): Promise<string | null> {
    this._load();
    if (!this._isExpired()) return this._token;
    return await this.login();
  }

  _sanitize(content: string): string {
    // Session API enforces MAX_SPECIAL_CHARS_ERROR for non-alphanumeric, non-space ASCII chars
    const MAX_SPECIAL = 10;
    let specialCount = 0;
    let result = '';
    for (const char of Array.from(content)) {
      const cp = char.codePointAt(0);
      if (cp === undefined) continue;  // guard: codePointAt returns number | undefined
      const isAlphanumOrSpace = (cp >= 48 && cp <= 57) ||  // 0-9
                                (cp >= 65 && cp <= 90) ||  // A-Z
                                (cp >= 97 && cp <= 122) || // a-z
                                cp === 32;                 // space
      if (!isAlphanumOrSpace) {
        if (specialCount < MAX_SPECIAL) {
          result += char;
          specialCount++;
        }
        // Drop chars over the limit
      } else {
        result += char;
      }
    }
    return result.trim();
  }

  async sendMessage(chatroomId: number | string, content: string): Promise<unknown> {
    const sanitized = this._sanitize(content);
    const token = await this.getToken();

    try {
      const response = await axios.post(`https://kick.com/api/v2/messages/send/${chatroomId}`, {
        content: sanitized,
        type: 'message',
        message_ref: String(Date.now())
      }, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return response.data;
    } catch (err) {
      // If 401, token may be expired — re-login once and retry
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        console.log('[SESSION] Token rejected (401), re-logging in...');
        await this.login();
        const freshToken = this._token;
        const retryResponse = await axios.post(`https://kick.com/api/v2/messages/send/${chatroomId}`, {
          content,
          type: 'message',
          message_ref: String(Date.now())
        }, {
          headers: {
            'Authorization': `Bearer ${freshToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        return retryResponse.data;
      }
      throw err;
    }
  }

  /** Forget the cached token so the next getToken() logs in again — call this after a 401. */
  clearCache(): void {
    this._token = null;
    this._savedAt = null;
    try {
      if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
    } catch (e) {
      if (e instanceof Error) console.warn('[SESSION] Could not remove', SESSION_FILE + ':', e.message);
    }
  }
}

export = KickSessionAuth;
