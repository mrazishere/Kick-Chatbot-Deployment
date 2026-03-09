require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, '.session.json');
// Sanctum tokens on Kick expire after ~24h; refresh proactively at 20h
const TOKEN_TTL_MS = 20 * 60 * 60 * 1000;

class KickSessionAuth {
  constructor() {
    this._token = null;
    this._savedAt = null;
  }

  _load() {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        this._token = data.token;
        this._savedAt = data.savedAt;
      }
    } catch (e) {
      console.warn('[SESSION] Failed to load session from', SESSION_FILE + ':', e.message);
      console.warn('[SESSION] Bot will attempt fresh login on next getToken() call');
    }
  }

  _save(token) {
    this._token = token;
    this._savedAt = Date.now();
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ token, savedAt: this._savedAt }, null, 2));
  }

  _isExpired() {
    if (!this._token || !this._savedAt) return true;
    return (Date.now() - this._savedAt) > TOKEN_TTL_MS;
  }

  async login() {
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

    const token = response.data?.token;
    if (!token) {
      throw new Error('[SESSION] Login succeeded but no token in response: ' + JSON.stringify(response.data).substring(0, 200));
    }

    this._save(token);
    console.log('[SESSION] Login successful, token cached');
    return token;
  }

  async getToken() {
    this._load();
    if (!this._isExpired()) return this._token;
    return await this.login();
  }

  _sanitize(content) {
    // Session API enforces MAX_SPECIAL_CHARS_ERROR for non-alphanumeric, non-space ASCII chars
    const MAX_SPECIAL = 10;
    let specialCount = 0;
    let result = '';
    for (const char of Array.from(content)) {
      const cp = char.codePointAt(0);
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

  async sendMessage(chatroomId, content) {
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
      if (err.response?.status === 401) {
        console.log('[SESSION] Token rejected (401), re-logging in...');
        await this.login();
        const freshToken = this._token;
        const response = await axios.post(`https://kick.com/api/v2/messages/send/${chatroomId}`, {
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
        return response.data;
      }
      throw err;
    }
  }
}

module.exports = KickSessionAuth;
