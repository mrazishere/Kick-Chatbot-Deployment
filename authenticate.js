require('dotenv').config();
const KickAuth = require('./auth');

async function authenticate() {
  console.log('[AUTH] Starting Kick OAuth authentication...');
  const auth = new KickAuth();

  try {
    await auth.startOAuthFlow();
    console.log('[AUTH] ✓ Authentication successful!');
    console.log('[AUTH] Tokens saved. You can now run the bot.');
    process.exit(0);
  } catch (error) {
    console.error('[AUTH ERROR] Authentication failed:', error.message);
    process.exit(1);
  }
}

authenticate();
