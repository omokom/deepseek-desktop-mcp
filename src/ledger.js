import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const VERSION = 1;
const LOCK_WAIT_MS = 10000;
const LOCK_POLL_MS = 25;

function emptyEntries() {
  return Object.create(null);
}

function cloneEntries(source) {
  const copy = emptyEntries();
  for (const key of Object.keys(source)) copy[key] = source[key];
  return copy;
}

function hashInput(kind, sessionId, text, mode) {
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(sessionId ?? '')
    .update('\0')
    .update(text)
    .update('\0')
    .update(mode ?? '')
    .digest('hex');
}

function validEntry(value) {
  return value !== null && typeof value === 'object'
    && typeof value.kind === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.inputHash === 'string'
    && typeof value.phase === 'string';
}

function lockError(message, code = 'state_locked') {
  return Object.assign(new Error(message), { code });
}

async function readLockOwner(lockPath) {
  try {
    const parsed = JSON.parse(await readFile(lockPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object'
      && Number.isInteger(parsed.pid) && typeof parsed.nonce === 'string'
      && typeof parsed.createdAt === 'string') {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Minimal durable admission ledger. Entries are request-id keys only; task
 * text is never persisted. One filesystem lock serializes transactions across
 * adapters sharing this state file, and state is reloaded under that lock so a
 * lifetime in-memory cache cannot hide another instance's durable write.
 */
export function createAdmissionLedger(stateFile, options = {}) {
  if (typeof stateFile !== 'string' || stateFile.trim() === '') throw new Error('admission state file is missing');
  const lockPath = `${stateFile}.lock`;
  const lockWaitMs = Number.isInteger(options.lockWaitMs) && options.lockWaitMs >= 0 ? options.lockWaitMs : LOCK_WAIT_MS;
  const lockPollMs = Number.isInteger(options.lockPollMs) && options.lockPollMs > 0 ? options.lockPollMs : LOCK_POLL_MS;
  let entries = emptyEntries();
  let durableEntries = emptyEntries();
  let queue = Promise.resolve();

  async function loadState() {
    let raw;
    try {
      raw = await readFile(stateFile, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return emptyEntries();
      }
      throw Object.assign(new Error(`admission state is unreadable: ${String(error?.code ?? error)}`), {
        code: 'admission_state_unreadable',
      });
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION
        || parsed.entries === null || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        throw new Error('unsupported admission state shape');
      }
      const next = emptyEntries();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!validEntry(entry)) throw new Error(`invalid admission entry ${key}`);
        next[key] = entry;
      }
      return next;
    } catch (error) {
      throw Object.assign(new Error(`admission state is corrupt: ${error instanceof Error ? error.message : String(error)}`), {
        code: 'admission_state_corrupt',
      });
    }
  }

  async function acquireLock() {
    await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + lockWaitMs;
    for (;;) {
      let owner;
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        owner = { pid: process.pid, nonce: randomUUID(), createdAt: new Date().toISOString() };
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
          await handle.sync();
        } catch (error) {
          await handle.close().catch(() => {});
          await unlink(lockPath).catch(() => {});
          throw lockError(`admission state lock could not be written: ${error instanceof Error ? error.message : String(error)}`, 'state_lock_failed');
        }
        await handle.close();
        return owner;
      } catch (error) {
        if (error?.code === 'state_lock_failed') throw error;
        if (error?.code !== 'EEXIST') {
          throw lockError(`admission state lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`, 'state_lock_failed');
        }
        const existing = await readLockOwner(lockPath);
        if (Date.now() >= deadline) {
          const detail = existing === null
            ? 'owner metadata unreadable'
            : `pid ${existing.pid} since ${existing.createdAt}`;
          throw lockError(`admission state is locked (${detail}); no stale lock was removed`, 'state_locked');
        }
        await delay(lockPollMs);
      }
    }
  }

  async function releaseLock(owner) {
    try {
      const current = await readLockOwner(lockPath);
      if (current !== null && current.nonce === owner.nonce) await unlink(lockPath);
    } catch {
      // Leave an uncertain lock in place rather than deleting another owner's.
    }
  }

  async function persist() {
    const temporary = `${stateFile}.tmp-${process.pid}-${randomUUID()}`;
    const body = `${JSON.stringify({ version: VERSION, entries }, null, 2)}\n`;
    try {
      await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, stateFile);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch {
        // Cleanup of our own temporary file is best-effort only.
      }
      throw Object.assign(new Error(`admission state replacement failed: ${error instanceof Error ? error.message : String(error)}`), {
        code: 'admission_state_write_failed',
        cause: error,
      });
    }
  }

  return {
    stateFile,
    /**
     * Serialize one admission transaction with a cross-instance filesystem
     * lock. Durable state is reloaded under the lock; a failed flush rolls the
     * in-memory snapshot back to the last durable entries.
     */
    async transaction(callback) {
      const run = queue.then(async () => {
        const owner = await acquireLock();
        try {
          entries = await loadState();
          durableEntries = cloneEntries(entries);
          let changed = false;
          const flush = async () => {
            if (!changed) return;
            try {
              await persist();
              durableEntries = cloneEntries(entries);
              changed = false;
            } catch (error) {
              entries = cloneEntries(durableEntries);
              changed = false;
              throw error;
            }
          };
          try {
            const result = await callback({
              get(requestId) {
                return Object.hasOwn(entries, requestId) ? { ...entries[requestId] } : undefined;
              },
              put(requestId, entry) {
                if (!validEntry(entry)) throw new Error('invalid admission entry');
                entries[requestId] = { ...entry };
                changed = true;
              },
              flush,
              hashInput,
            });
            await flush();
            return result;
          } catch (error) {
            entries = cloneEntries(durableEntries);
            changed = false;
            throw error;
          }
        } finally {
          await releaseLock(owner);
        }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}
