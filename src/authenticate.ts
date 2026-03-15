import 'dotenv/config';
import KickAuth = require('./auth');

async function authenticate(): Promise<void> {
  console.log('[AUTH] Starting Kick OAuth authentication...');
  const auth = new KickAuth();

  try {
    await auth.startOAuthFlow();
    console.log('[AUTH] \u2713 Authentication successful!');
    console.log('[AUTH] Tokens saved. You can now run the bot.');
    process.exit(0);
  } catch (error) {
    if (error instanceof Error) {
      console.error('[AUTH ERROR] Authentication failed:', error.message);
    }
    process.exit(1);
  }
}

authenticate();
