/**
 * Cross-process file locking and atomic JSON writes.
 *
 * Every Kick process (the enrollment service and one bot per channel) shares
 * files such as dist/.tokens.json. Node has no flock, so a lock is a sibling
 * file created with O_EXCL: whoever creates it holds it. A holder that dies
 * leaves the file behind, so a lock older than `staleMs` is taken over.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';

export interface LockOptions {
  /** A lock untouched for this long belongs to a process that died holding it. */
  staleMs: number;
  /** Give up waiting after this long. Keep it above staleMs so a dead holder is always outlived. */
  waitMs: number;
}

export class LockTimeoutError extends Error {}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Run `fn` while holding `lockPath`.
 *
 * Takeover of a stale lock re-reads its owner first and only removes it if
 * that owner hasn't changed, which keeps two waiters from both "clearing" the
 * same dead lock and deleting the fresh one the first of them just created.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions): Promise<T> {
  const owner = `${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
  const deadline = Date.now() + opts.waitMs;

  for (;;) {
    try {
      fs.writeFileSync(lockPath, owner, { flag: 'wx' });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }

    try {
      const held = fs.readFileSync(lockPath, 'utf8');
      const age = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (age > opts.staleMs && fs.readFileSync(lockPath, 'utf8') === held) {
        console.warn(`[LOCK] Taking over ${lockPath} from ${held || 'an unknown process'} (held ${Math.round(age / 1000)}s)`);
        fs.unlinkSync(lockPath);
        continue;
      }
    } catch (err) {
      // Released between the failed create and this check: try again straight away.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    if (Date.now() > deadline) {
      throw new LockTimeoutError(`Timed out after ${opts.waitMs}ms waiting for ${lockPath}`);
    }
    // Jittered, so processes woken together don't retry in lockstep.
    await sleep(50 + Math.floor(Math.random() * 100));
  }

  try {
    return await fn();
  } finally {
    try {
      // Only our own lock: after a takeover the file may belong to someone else.
      if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Write JSON through a rename, so a reader never sees half a file. The temp
 * name is unique per writer: a shared `.tmp` let two processes clobber each
 * other's half-written file before either renamed it.
 */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
}
