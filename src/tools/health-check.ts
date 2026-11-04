// The server's own health check, run by cron every 5 minutes, apart from the bots so it still
// speaks when they can't: the enrollment service answering, the public dashboard loading, every
// Kick process running, and disk space. Problems go to Telegram through the same once-per-problem
// alerts as the bots' (health-alerts.ts), and a "fixed" message follows.
//
// The dashboard and webhook are checked twice: on the box (straight to the port nginx proxies to)
// and through mr-ai.dev, which resolves to this server's own public IP and so goes out through the
// provider's network and back in. A failure only alerts when it's ours to act on:
//   - on the box down: the service itself is broken, alert;
//   - on the box fine, public failing, and the internet reachable: nginx/DNS/cert/firewall, alert
//     once it has failed CONFIRM_RUNS runs in a row (a reload or a blip isn't worth a page);
//   - the server can't reach the internet at all: the provider's network is down, nothing to fix
//     here, so the public checks are skipped (neither alerted nor cleared). If it lasts, the
//     dead-man's switch below notices the missing pings from outside.
//
// With HEALTHCHECK_PING_URL set (a dead-man's switch such as healthchecks.io) it's pinged on every
// healthy run and told /fail otherwise, so a server that's down altogether, and so sends nothing,
// gets noticed too.
//
//   node dist/tools/health-check.js

import 'dotenv/config';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as net from 'net';
import * as tls from 'tls';
import axios from 'axios';
import { clearAlert, raiseAlert } from '../health-alerts';

// Node gives each address only 250ms to connect before trying the next; healthchecks.io's servers
// are in Germany, ~320ms away, so every attempt was cut short and the ping never landed.
net.setDefaultAutoSelectFamilyAttemptTimeout(2_000);

const ENROLLMENT = `http://127.0.0.1:${process.env.ENROLLMENT_PORT || 3006}/health`;
const DASHBOARD = process.env.HEALTH_DASHBOARD_URL || 'https://mr-ai.dev/kick/login';
/** The same page straight from the dashboard's port (nginx's /kick/ proxy target), skipping the network. */
const DASHBOARD_LOCAL = process.env.HEALTH_DASHBOARD_LOCAL_URL || 'http://127.0.0.1:3008/kick/login';
const DISK_ALERT_PERCENT = 90;
/** Where Kick delivers events; a GET there answers { ok: true } (mr-ai-bot-enrollment.ts). */
const WEBHOOK = process.env.HEALTH_WEBHOOK_URL || 'https://mr-ai.dev/kick-webhook';
const WEBHOOK_LOCAL = `http://127.0.0.1:${process.env.ENROLLMENT_PORT || 3006}/kick-webhook`;
/** Big, unrelated sites: if none of them answers, it's the server's own connection that's down. */
const INTERNET_PROBES = ['https://www.google.com/generate_204', 'https://1.1.1.1/', 'https://kick.com/'];
/** A public-path failure must last this many runs in a row (5 min apart) before it alerts. */
const CONFIRM_RUNS = 2;
/** Failures in a row per check, kept between cron runs. */
const STATE_FILE = path.join(__dirname, '..', '..', 'data', 'health-check-state.json');
/** Warn this long before the HTTPS certificate runs out. */
const CERT_WARN_DAYS = 10;
/** Processes that must be online, besides every kick-<channel> bot. */
const REQUIRED = ['Kick-Bot-Enrollment', 'kpp-dashboard'];

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))));

/** What failed this run, for the dead-man's ping (shown in healthchecks.io's log). */
const failures: string[] = [];

/** A probe's answer meaning "can't tell this run": neither alert nor clear. */
const SKIP = Symbol('skip');
/** A problem that only alerts once it has come up `confirm` runs in a row (a string alerts at once). */
type Unconfirmed = { unconfirmed: string };
type Probe = () => Promise<string | Unconfirmed | null | typeof SKIP>;

function loadState(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}
const streaks = loadState();

/**
 * Runs a probe and alerts or clears. An Unconfirmed problem alerts only once it has come up
 * `confirm` runs in a row; until then it's only logged. A skipped run breaks the streak.
 */
async function check(name: string, key: string, fixedText: string, probe: Probe, confirm = 1): Promise<boolean> {
  let result: string | Unconfirmed | null | typeof SKIP;
  try {
    result = await probe();
  } catch (e) {
    result = e instanceof Error ? e.message : String(e);
  }
  if (result === SKIP) {
    delete streaks[key];
    return true;
  }
  if (result) {
    const needsConfirm = typeof result !== 'string';
    const problem = typeof result === 'string' ? result : result.unconfirmed;
    const streak = (streaks[key] ?? 0) + 1;
    streaks[key] = streak;
    if (needsConfirm && streak < confirm) {
      console.log(`[HEALTH] ${name} (failed ${streak}/${confirm}, not alerting yet): ${problem}`);
      return true;
    }
    console.log(`[HEALTH] ${name}: ${problem}`);
    failures.push(`${name}: ${problem}`);
    raiseAlert(key, name, problem);
    return false;
  }
  delete streaks[key];
  clearAlert(key, `${name}: fixed`, fixedText);
  return true;
}

/** An error's message, for logs and alerts. */
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Whether the server can reach the internet at all: any one of the probes answering is enough. */
async function internetUp(): Promise<boolean> {
  const tries = INTERNET_PROBES.map(u => axios.get(u, { timeout: 8_000, maxRedirects: 0, validateStatus: () => true }).then(() => true));
  return Promise.any(tries).catch(() => false);
}

/**
 * Checks a page on the box first, then through its public URL; ok says whether an answer is good.
 * A public failure is skipped when the server can't reach the internet at all.
 */
function localAndPublic(localUrl: string, publicUrl: string, ok: (status: number, data: unknown) => boolean, onBoxDown: string, publicDown: string, online: Promise<boolean>): Probe {
  return async () => {
    try {
      const r = await axios.get(localUrl, { timeout: 10_000, maxRedirects: 0, validateStatus: () => true });
      if (!ok(r.status, r.data)) return `${localUrl} answered ${r.status} on the server itself. ${onBoxDown}`;
    } catch (e) {
      return `${localUrl} doesn't answer on the server itself (${errText(e)}). ${onBoxDown}`;
    }
    let why: string;
    try {
      const r = await axios.get(publicUrl, { timeout: 15_000, maxRedirects: 0, validateStatus: () => true });
      if (ok(r.status, r.data)) return null;
      why = `answered ${r.status}`;
    } catch (e) {
      why = `doesn't answer (${errText(e)})`;
    }
    if (!(await online)) {
      console.log(`[HEALTH] ${publicUrl} ${why}, but the server can't reach the internet at all: provider network down, not alerting.`);
      return SKIP;
    }
    return { unconfirmed: `${publicUrl} ${why} from outside, though it works on the server itself and the internet is reachable. ${publicDown}` };
  };
}

async function main(): Promise<void> {
  // Started once and shared: only awaited when a public check fails.
  const online = internetUp();
  const results = await Promise.all([
    check('Enrollment Service Not Answering', 'health:enrollment', 'The enrollment service answers again: webhooks, the dashboard\'s bot pages and the overlays work.', async () => {
      const r = await axios.get(ENROLLMENT, { timeout: 10_000, validateStatus: () => true });
      return r.status === 200 ? null : `It answered ${r.status}. Without it Kick's webhooks (follows, subs, Kicks, rewards), the dashboard's bot pages and the overlays all stop.`;
    }),
    check('Dashboard Down', 'health:dashboard', `${DASHBOARD} loads again.`, localAndPublic(
      DASHBOARD_LOCAL, DASHBOARD, status => status < 400,
      'The dashboard process is broken: the dashboard and the stream overlays (fishing, video) are down. Check pm2 logs kpp-dashboard.',
      'So the dashboard and stream overlays can\'t be reached: check nginx (sudo nginx -t), the DNS record and the certificate.',
      online,
    ), CONFIRM_RUNS),
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
    check('Kick Can\'t Reach The Webhook', 'health:webhook', `${WEBHOOK} answers again: Kick's events get through.`, localAndPublic(
      WEBHOOK_LOCAL, WEBHOOK, (status, data) => status === 200 && (data as { ok?: boolean })?.ok === true,
      'The enrollment service\'s webhook route is broken, so Kick\'s events (follows, subs, Kicks, rewards, live status) are lost. Check pm2 logs Kick-Bot-Enrollment.',
      'So Kick\'s events (follows, subs, Kicks, rewards, live status, and chat when the socket is down) can\'t get in. Check nginx\'s /kick-webhook route, the DNS record and the certificate.',
      online,
    ), CONFIRM_RUNS),
    check('Certificate Expiring', 'health:cert', 'The HTTPS certificate was renewed.', async () => {
      const host = new URL(DASHBOARD).hostname;
      // Reaching our own public IP goes through the provider's network: when that's down this can't tell.
      if (!(await online)) return SKIP;
      let validTo: string;
      try {
        validTo = await new Promise<string>((resolve, reject) => {
          const sock = tls.connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
            resolve(sock.getPeerCertificate().valid_to);
            sock.end();
          });
          sock.on('error', reject);
          sock.on('timeout', () => { sock.destroy(); reject(new Error('timed out')); });
        });
      } catch (e) {
        return { unconfirmed: `Couldn't read the HTTPS certificate for ${host}: ${errText(e)}` };
      }
      const days = (Date.parse(validTo) - Date.now()) / 86_400_000;
      return days < CERT_WARN_DAYS
        ? `The HTTPS certificate for ${host} runs out in ${Math.max(0, Math.floor(days))} day(s) (${validTo}). After that the dashboard, the stream overlays and Kick's webhooks all stop. Its automatic renewal (certbot) seems to be failing: sudo certbot renew.`
        : null;
    }, CONFIRM_RUNS),
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

  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(streaks));
  } catch (e) {
    console.error('[HEALTH] Couldn\'t save state:', errText(e));
  }

  const ping = process.env.HEALTHCHECK_PING_URL;
  // With no internet the ping can't land anyway; its absence is the signal.
  if (ping && (await online)) {
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
