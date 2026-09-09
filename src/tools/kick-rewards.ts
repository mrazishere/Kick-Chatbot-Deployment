/**
 * List a channel's channel-point rewards and pending redemptions.
 *
 *   node dist/tools/kick-rewards.js sukasblood
 *
 * Used to fill in `rewardActions[].rewardId` in the channel config. Requires
 * the channel's streamer token to carry `channel:rewards:write` — a grant made
 * before that scope was added returns 401 and the channel must re-authorize.
 */

import 'dotenv/config';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ChannelConfig } from '../types';

const API = 'https://api.kick.com/public/v1';

async function main(): Promise<void> {
  const channel = process.argv[2];
  if (!channel) {
    console.error('Usage: node dist/tools/kick-rewards.js <channel>');
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), 'data', 'channel-configs', `${channel}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`No config at ${configPath}`);
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as ChannelConfig;
  const token = config.oauth?.accessToken;
  if (!token) {
    console.error(`${channel} has no streamer OAuth token — it must enroll or re-authorize.`);
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${token}` };

  const introspect = await axios.post(`${API}/token/introspect`, null, { headers }).catch(() => null);
  const scopes = (introspect?.data as { data?: { scope?: string } } | undefined)?.data?.scope ?? '(unknown)';
  console.log(`Granted scopes: ${scopes}\n`);

  try {
    const rewards = await axios.get(`${API}/channels/rewards`, { headers });
    const rows = (rewards.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    if (rows.length === 0) {
      console.log('No rewards configured on this channel.');
    } else {
      console.log('Rewards:');
      for (const r of rows) {
        console.log(`  ${String(r['id'])}  ${String(r['cost']).padStart(6)} pts  "${String(r['title'])}"` +
          `  [input_required=${String(r['is_user_input_required'])}, skips_queue=${String(r['should_redemptions_skip_request_queue'])}, enabled=${String(r['is_enabled'])}]`);
      }
    }
  } catch (err) {
    console.error('Failed to list rewards:',
      axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)}` : err);
    process.exit(1);
  }

  try {
    const redemptions = await axios.get(`${API}/channels/rewards/redemptions`, { headers, params: { status: 'pending' } });
    const rows = (redemptions.data as { data?: Array<Record<string, unknown>> }).data ?? [];
    console.log(`\nPending redemptions: ${rows.length}`);
    for (const r of rows) {
      const reward = r['reward'] as { title?: string } | undefined;
      const redeemer = r['redeemer'] as { username?: string } | undefined;
      console.log(`  ${String(r['id'])}  "${reward?.title ?? '?'}" by ${redeemer?.username ?? '?'} — input: ${JSON.stringify(r['user_input'] ?? '')}`);
    }
  } catch (err) {
    console.error('Failed to list redemptions:',
      axios.isAxiosError(err) ? `${err.response?.status} ${JSON.stringify(err.response?.data)}` : err);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
