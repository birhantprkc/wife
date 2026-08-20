import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { wifeHome } from './paths.js';

const LOCK_NAME = '.state.lock';
const STALE_AFTER_MS = 5 * 60_000;

export const stateLockPath = () => path.join(wifeHome(), LOCK_NAME);

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to a context we cannot signal.
    return error?.code === 'EPERM';
  }
}

function staleLock(file) {
  try {
    const stat = fs.statSync(file);
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* malformed owner */ }
    const oldEnough = Date.now() - stat.mtimeMs > STALE_AFTER_MS;
    // A newly-created lock is briefly empty between open('wx') and writing its
    // owner record. Treating every malformed/empty file as stale lets a second
    // process steal that live lock in exactly that window. A crashed partial
    // lock is still recoverable, but only after the normal stale timeout.
    if (!owner?.pid) return oldEnough;
    if (owner?.pid && processIsAlive(Number(owner.pid))) return false;
    return oldEnough || !processIsAlive(Number(owner.pid));
  } catch {
    return false;
  }
}

function acquire() {
  const file = stateLockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      const token = crypto.randomBytes(12).toString('hex');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), 'utf8');
      return { fd, file, token };
    } catch (error) {
      if (error?.code !== 'EEXIST' || !staleLock(file) || attempt > 0) return null;
      // Rename the stale lock atomically. If another contender already claimed
      // it, the rename fails and this process simply defers its mutation.
      const stale = `${file}.stale.${process.pid}.${Date.now()}`;
      try {
        fs.renameSync(file, stale);
        try { fs.unlinkSync(stale); } catch { /* best effort */ }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function release(lock) {
  try { fs.closeSync(lock.fd); } catch { /* best effort */ }
  try {
    const owner = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    if (owner?.token === lock.token) fs.unlinkSync(lock.file);
  } catch {
    /* A missing lock is already released. */
  }
}

/**
 * Run one state mutation under a cross-process lock.
 *
 * Lock contention never blocks an agent hook. The caller gets `acquired:false`
 * and can leave its session buffer for the next lifecycle event to harvest.
 */
export async function withStateLock(fn) {
  const lock = acquire();
  if (!lock) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: await fn() };
  } finally {
    release(lock);
  }
}

export function withStateLockSync(fn) {
  const lock = acquire();
  if (!lock) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: fn() };
  } finally {
    release(lock);
  }
}
