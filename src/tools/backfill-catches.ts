/**
 * Fill the catches table (points schema v6) from a channel's bot log, for the
 * fish landed before the bot recorded them. Casts come from the
 * "[FISH] <user> caught <fish> in <channel>" lines. Trap hauls come from the bot's
 * "You drag the traps out..." replies, which list every catch. Lengths aren't
 * recovered.
 *
 *   npx tsx src/tools/backfill-catches.ts sukasblood [--dry-run] [oldname=newname ...]
 *
 * A viewer who renamed since is only in the database under the new name; pass
 * old=new so their catches count.
 *
 * Only log lines older than the first catch the bot recorded itself are used, so
 * nothing is counted twice. It runs once per channel; a meta row marks it done.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ITEMS } from '../community/fishing';
import { openPointsDb, runWrite } from '../points/db';
import { findUserByName } from '../points/store';

const META_KEY = 'catches_backfilled';

function main(): void {
  const channel = (process.argv[2] ?? '').toLowerCase();
  const dryRun = process.argv.includes('--dry-run');
  const aliases = new Map(process.argv.slice(3).filter(a => a.includes('=')).map(a => a.toLowerCase().split('=') as [string, string]));
  if (!/^[a-z0-9_]{2,25}$/.test(channel)) {
    console.error('Usage: npx tsx src/tools/backfill-catches.ts <channel> [--dry-run] [oldname=newname ...]');
    process.exit(1);
  }
  const logFile = path.resolve(__dirname, '..', '..', 'logs', `kick-${channel}-out.log`);
  if (!fs.existsSync(logFile)) {
    console.error(`No log at ${logFile}`);
    process.exit(1);
  }
  const db = openPointsDb(channel, { create: false });
  if (!db) {
    console.error(`${channel} has no points database`);
    process.exit(1);
  }
  const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined;
  if (done) {
    console.error(`${channel} was already backfilled (${done.value})`);
    process.exit(1);
  }
  const first = db.prepare('SELECT MIN(ts) AS ts FROM catches').get() as { ts: number | null };
  const cutoff = first.ts ?? Date.now();

  const fishNames = new Set(ITEMS.filter(i => i.type === 'fish').map(i => i.name));
  const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const castRe = new RegExp(`^(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d): \\[FISH\\] (\\w+) caught (\\S+) in ${channel}$`);
  const trapRe = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d): \[COMMAND RESPONSE\] @(\w+) You drag the traps out of the water\.\.\. and you spot some fish! (\S+)/;

  const found: Array<{ ts: number; user: string; name: string; source: 'cast' | 'trap' }> = [];
  for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
    const cast = castRe.exec(line);
    const trap = cast ? null : trapRe.exec(line);
    const m = cast ?? trap;
    if (!m) continue;
    // pm2 stamps log lines in the server's local time, as this runs.
    const ts = new Date(m[1].replace(' ', 'T')).getTime();
    if (!(ts < cutoff)) continue;
    const names = cast ? [m[3]] : Array.from(graphemes.segment(m[3]), s => s.segment);
    for (const name of names) {
      if (fishNames.has(name)) found.push({ ts, user: m[2], name, source: cast ? 'cast' : 'trap' });
    }
  }

  const unknown = new Set<string>();
  const rows = found.flatMap(f => {
    const lc = f.user.toLowerCase();
    const user = findUserByName(db, aliases.get(lc) ?? lc);
    if (!user) { unknown.add(f.user); return []; }
    return [{ ...f, userId: user.user_id }];
  });

  const tally: Record<string, number> = {};
  for (const r of rows) tally[r.name] = (tally[r.name] ?? 0) + 1;
  console.log(`${channel}: ${rows.length} fish before ${new Date(cutoff).toISOString()} (${rows.filter(r => r.source === 'cast').length} cast, ${rows.filter(r => r.source === 'trap').length} trap)`);
  console.log(Object.entries(tally).sort((a, b) => a[1] - b[1]).map(([n, c]) => `${n}×${c}`).join('  '));
  if (unknown.size) console.log(`Skipped, no such viewer in the database: ${[...unknown].join(', ')}`);
  if (dryRun) return;

  runWrite(db, () => {
    const insert = db.prepare('INSERT INTO catches (ts, user_id, name, source, cm) VALUES (?, ?, ?, ?, NULL)');
    for (const r of rows) insert.run(r.ts, r.userId, r.name, r.source);
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(META_KEY, `${new Date().toISOString()}: ${rows.length} rows from ${path.basename(logFile)}`);
  });
  console.log('Written.');
}

main();
