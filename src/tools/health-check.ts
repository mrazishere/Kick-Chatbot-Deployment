// The server's own health check, run by cron every 5 minutes, apart from the bots so it still
// speaks when they can't: the enrollment service answering, the public dashboard loading, every
// Kick process running, and disk space. Problems go to Telegram through the same once-per-problem
// alerts as the bots' (health-alerts.ts), and a "fixed" message follows.
//
// With HEALTHCHECK_PING_URL set (a dead-man's switch such as healthchecks.io) it's pinged on every
// healthy run and told /fail otherwise, so a server that's down altogether, and so sends nothing,
// gets noticed too.
//
//   node dist/tools/health-check.js

import 'dotenv/config';
import { execFile } from 'child_process';
import * as net from 'net';
import * as tls from 'tls';
import axios from 'axios';
import { clearAlert, raiseAlert } from '../health-alerts';

// Node gives each address only 250ms to connect before trying the next; healthchecks.io's servers
// are in Germany, ~320ms away, so every attempt was cut short and the ping never landed.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_000);

const ENROLLMENT = `http://127.0.0.1:${process.env.ENROLLMENT_PORT || 3006}/health`;
const DASHBOARD = process.env.HEALTH_DASHBOARD_URL || 'https://mr-ai.dev/kick/login';
const DISK_ALERT_PERCENT = 90;
/** Where Kick delivers events; a GET there answers { ok: true } (mr-ai-bot-enrollment.ts). */
const WEBHOOK = process.env.HEALTH_WEBHOOK_URL || 'https://mr-ai.dev/kick-webhook';
/** Warn this long before the HTTPS certificate runs out. */
const CERT_WARN_DAYS = 10;
/** Processes that must be online, besides every kick-<channel> bot. */
const REQUIRED = ['Kick-Bot-Enrollment', 'kpp-dashboard'];

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));

/** What failed this run, for the dead-man's ping (shown in healthchecks.io's log). */
const failures: string[] = [];

async function check(name: string, key: string, fixedText: string, probe: () => Promise<string | null>): Promise<boolean> {
  let problem: string | null;
  try {
    problem = await probe();
  } catch (e) {
    problem = e instanceof Error ? e.message : String(e);
  }
  if (problem) {
    console.log(`[HEALTH] ${name}: ${problem}`);
    failures.push(`${name}: ${problem}`);
    raiseAlert(key, name, problem);
    return false;
  }
  clearAlert(key, `${name}: fixed`, fixedText);
  return true;
}

async function main(): Promise<void> {
  const results = await Promise.all([
    check('Enrollment Service Not Answering', 'health:enrollment', 'The enrollment service answers again: webhooks, the dashboard\'s bot pages and the overlays work.', async () => {
      const r = await axios.get(ENROLLMENT, { timeout: 10_000, validateStatus: () => true });
      return r.status === 200 ? null : `It answered ${r.status}. Without it Kick's webhooks (follows, subs, Kicks, rewards), the dashboard's bot pages and the overlays all stop.`;
    }),
    check('Dashboard Down', 'health:dashboard', `${DASHBOARD} loads again.`, async () => {
      const r = await axios.get(DASHBOARD, { timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
      return r.status < 400 ? null : `${DASHBOARD} answered ${r.status}: the dashboard and the stream overlays (fishing, video) may be down.`;
    }),
    check('Kick Processes Down', 'health:pm2', 'Every Kick process is running again.', async () => {
      const procs = JSON.parse(await run('pm2', ['jlist'])) as Array<{ name?: string; pm2_env?: { status?: string } }>;
      const names = [...REQUIRED, ...procs.map(p => p.name ?? '').filter(n => n.startsWith('kick-'))];
      const down = [...new Set(names)].filter(n => procs.find(p => p.name === n)?.pm2_env?.status !== 'online');
      // A channel bot stopped on purpose is the enrollment service's to judge (its bot watch): only say so here
      // when that service is down too, as then nothing else will.
      const bots = down.filter(n => n.startsWith('kick-'));
      const core = down.filter(n => !n.startsWith('kick-'));
      if (core.length) return `Not running: ${down.join(', ')}. pm2 restart ${core.join(' ')}`;
      return bots.length && down.includes('Kick-Bot-Enrollment') ? `Not running: ${bots.join(', ')}` : null;
    }),
    check('Kick Can\'t Reach The Webhook', 'health:webhook', `${WEBHOOK} answers again: Kick's events get through.`, async () => {
      const r = await axios.get(WEBHOOK, { timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
      return r.status === 200 && (r.data as { ok?: boolean })?.ok === true
        ? null
        : `${WEBHOOK} answered ${r.status} from outside, so Kick's events (follows, subs, Kicks, rewards, live status, and chat when the socket is down) can't get in. Check nginx's /kick-webhook route and the enrollment service.`;
    }),
    check('Certificate Expiring', 'health:cert', 'The HTTPS certificate was renewed.', async () => {
      const host = new URL(DASHBOARD).hostname;
      const validTo = await new Promise<string>((resolve, reject) => {
        const sock = tls.connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
          resolve(sock.getPeerCertificate().valid_to);
          sock.end();
        });
        sock.on('error', reject);
        sock.on('timeout', () => { sock.destroy(); reject(new Error('timed out')); });
      });
      const days = (Date.parse(validTo) - Date.now()) / 86_400_000;
      return days < CERT_WARN_DAYS
        ? `The HTTPS certificate for ${host} runs out in ${Math.max(0, Math.floor(days))} day(s) (${validTo}). After that the dashboard, the stream overlays and Kick's webhooks all stop. Its automatic renewal (certbot) seems to be failing: sudo certbot renew.`
        : null;
    }),
    check('Disk Filling Up', 'health:disk', 'Disk use is back under the limit.', async () => {
      const line = (await run('df', ['-P', '/'])).trim().split('\n').pop() ?? '';
      const used = Number(line.split(/\s+/)[4]?.replace('%', ''));
      return used >= DISK_ALERT_PERCENT ? `The disk is ${used}% full. Points databases, backups and logs stop being written when it fills.` : null;
    }),
  ]);

  // The alerts above go through our Telegram bot: if it can't send (token revoked, say), they all
  // vanish. That can't be said through the bot itself, so it fails the dead-man's ping instead,
  // and healthchecks.io's own bot says the check is down; this log says why.
  const telegramOk = await telegramWorks();
  if (!telegramOk) {
    console.log('[HEALTH] Telegram bot not working: alerts can\'t be sent');
    failures.push('Our Telegram bot is rejected (token revoked?): no alerts can reach you.');
  }

  const ping = process.env.HEALTHCHECK_PING_URL;
  if (ping) {
    const ok = results.every(Boolean) && telegramOk;
    await axios.post(ok ? ping : `${ping.replace(/\/$/, '')}/fail`, ok ? 'all checks passed' : failures.join('\n\n'), { timeout: 10_000, headers: { 'Content-Type': 'text/plain' } }).catch(e =>
      console.error('[HEALTH] Ping failed:', e instanceof Error ? e.message : String(e)));
  }
  // Alerts go out without being awaited: give them a moment to land.
  await new Promise(r => setTimeout(r, 5_000));
}

/** Whether our alert bot is accepted by Telegram (getMe); true when no bot is set up at all. */
async function telegramWorks(): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !process.env.TELEGRAM_CHAT_ID) return true;
  try {
    const r = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 10_000, validateStatus: () => true });
    if (r.status === 200) return true;
    // 401/404: the token is no good. Anything else is Telegram having a moment: not worth a page.
    return r.status !== 401 && r.status !== 404;
  } catch {
    return true;
  }
}

main().catch(e => {
  console.error('[HEALTH] Check failed:', e);
  process.exitCode = 1;
});
