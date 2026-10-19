import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveWorkspacesFile } from './config.js';

/**
 * Non-secret workspace allowlist beside the token. The bridge refuses a
 * `workspacePath` that is absent here, so a pure native MCP caller cannot point
 * the executor at an arbitrary directory. A trusted local launcher may add one
 * exact existing directory before submit; nothing is enrolled at startup except
 * the already-configured default Workspace.
 */
const VERSION = 1;
const LOCK_WAIT_MS = 10000;
const LOCK_POLL_MS = 25;

function workspaceError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Comparison key for one canonical Windows/POSIX directory spelling. Paths are
 * stored canonicalized (`fs.realpath`), so this only absorbs separator and
 * case differences. It is never used to authorize a directory on its own.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function normalizePathKey(value) {
  if (typeof value !== 'string') return '';
  let normalized = value.replace(/\//g, '\\');
  if (normalized.length > 3) normalized = normalized.replace(/\\+$/u, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
export function sameWorkspacePath(left, right) {
  const a = normalizePathKey(left);
  const b = normalizePathKey(right);
  return a !== '' && a === b;
}

/**
 * Validate and canonicalize a directory named as a Workspace. Rejects relative
 * paths, wildcard spellings, nonexistent paths, non-directories, and filesystem
 * roots. Symlinks resolve to their canonical target: authorization is always
 * against the canonical path, so a symlink cannot escape the allowlist.
 *
 * @param {unknown} input
 * @returns {Promise<string>}
 */
export async function canonicalDirectoryPath(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw workspaceError('workspace_path_invalid', 'workspacePath must be a non-empty string');
  }
  if (input !== input.trim()) {
    throw workspaceError('workspace_path_invalid', 'workspacePath must not have leading or trailing whitespace');
  }
  if (input.includes('\0') || /[*?]/u.test(input)) {
    throw workspaceError('workspace_path_invalid', 'workspacePath must be one exact directory path, not a glob or wildcard');
  }
  if (!isAbsolute(input)) {
    throw workspaceError('workspace_path_invalid', `workspacePath must be fully qualified: "${input}"`);
  }
  let canonical;
  try {
    canonical = await realpath(input);
  } catch (error) {
    throw workspaceError('workspace_path_not_found', `workspacePath does not resolve to an existing directory: "${input}"`);
  }
  let info;
  try {
    info = await stat(canonical);
  } catch {
    throw workspaceError('workspace_path_not_found', `workspacePath is not readable as a directory: "${canonical}"`);
  }
  if (!info.isDirectory()) {
    throw workspaceError('workspace_path_not_directory', `workspacePath is not a directory: "${canonical}"`);
  }
  if (parse(canonical).root === canonical) {
    throw workspaceError('workspace_path_root', 'refusing to enroll a filesystem/drive root as a workspace');
  }
  return canonical;
}

function validEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && typeof entry.path === 'string' && entry.path.trim() !== ''
    && (entry.title === undefined || typeof entry.title === 'string')
    && (entry.source === undefined || typeof entry.source === 'string')
    && (entry.addedAt === undefined || typeof entry.addedAt === 'string');
}

/**
 * Read the allowlist. A missing file is an empty allowlist (the bridge still
 * serves the configured default Workspace by id); a corrupt file fails closed
 * because silently dropping entries would silently widen or narrow authority.
 *
 * @param {{ file?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ file: string, version: number, entries: Array<{path: string, title?: string, source?: string, addedAt?: string}> }>}
 */
export async function readWorkspaceAllowlist(options = {}) {
  const file = options.file ?? resolveWorkspacesFile(options.env ?? process.env);
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { file, version: VERSION, entries: [] };
    }
    throw workspaceError('workspace_allowlist_unavailable', `workspace allowlist is unreadable (${String(error?.code ?? 'read-error')})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''));
  } catch {
    throw workspaceError('workspace_allowlist_corrupt', 'workspace allowlist is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || parsed.version !== VERSION || !Array.isArray(parsed.entries)) {
    throw workspaceError('workspace_allowlist_corrupt', 'workspace allowlist has an unsupported shape');
  }
  const entries = [];
  for (const entry of parsed.entries) {
    if (!validEntry(entry)) throw workspaceError('workspace_allowlist_corrupt', 'workspace allowlist holds an invalid entry');
    if (!isAbsolute(entry.path)) throw workspaceError('workspace_allowlist_corrupt', `workspace allowlist entry is not fully qualified: "${entry.path}"`);
    entries.push({
      path: entry.path,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.source === undefined ? {} : { source: entry.source }),
      ...(entry.addedAt === undefined ? {} : { addedAt: entry.addedAt }),
    });
  }
  return { file, version: VERSION, entries };
}

/**
 * Find the allowlist entry authorizing one canonical directory path.
 *
 * @param {{ entries: Array<{path: string}> }} allowlist
 * @param {string} canonicalPath
 * @returns {{ path: string } | undefined}
 */
export function findAllowlistEntry(allowlist, canonicalPath) {
  return allowlist.entries.find((entry) => sameWorkspacePath(entry.path, canonicalPath)
    || entry.path === canonicalPath);
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

async function acquireLock(lockPath, waitMs = LOCK_WAIT_MS, pollMs = LOCK_POLL_MS) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
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
        throw workspaceError('workspace_allowlist_lock_failed', 'workspace allowlist lock could not be written');
      }
      await handle.close();
      return owner;
    } catch (error) {
      if (error && error.code === 'workspace_allowlist_lock_failed') throw error;
      if (!error || error.code !== 'EEXIST') {
        throw workspaceError('workspace_allowlist_lock_failed', `workspace allowlist lock could not be acquired: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (Date.now() >= deadline) {
        const existing = await readLockOwner(lockPath);
        const detail = existing === null ? 'owner metadata unreadable' : `pid ${existing.pid} since ${existing.createdAt}`;
        throw workspaceError('workspace_allowlist_locked', `workspace allowlist is locked (${detail}); no stale lock was removed`);
      }
      await delay(pollMs);
    }
  }
}

async function releaseLock(lockPath, owner) {
  try {
    const current = await readLockOwner(lockPath);
    if (current !== null && current.nonce === owner.nonce) await unlink(lockPath);
  } catch {
    // Leave an uncertain lock rather than deleting another owner's lock.
  }
}

async function writeAllowlist(file, entries) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const body = `${JSON.stringify({ version: VERSION, entries }, null, 2)}\n`;
  try {
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw workspaceError('workspace_allowlist_write_failed', `workspace allowlist replacement failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Atomically add one exact existing directory to the allowlist while preserving
 * every existing entry. The short filesystem lock serializes concurrent
 * launcher enrollments so no entry is lost.
 *
 * @param {{ path: unknown, title?: string, source?: string, file?: string, env?: NodeJS.ProcessEnv }} input
 * @returns {Promise<{ file: string, canonicalPath: string, added: boolean, entry: object, entries: Array<object> }>}
 */
export async function enrollWorkspace(input) {
  const canonicalPath = await canonicalDirectoryPath(input.path);
  const file = input.file ?? resolveWorkspacesFile(input.env ?? process.env);
  const lockPath = `${file}.lock`;
  const owner = await acquireLock(lockPath);
  try {
    const allowlist = await readWorkspaceAllowlist({ file });
    const existing = findAllowlistEntry(allowlist, canonicalPath);
    if (existing !== undefined) {
      return { file, canonicalPath, added: false, entry: existing, entries: allowlist.entries };
    }
    const entry = {
      path: canonicalPath,
      title: typeof input.title === 'string' && input.title.trim() !== '' ? input.title.trim() : basename(canonicalPath),
      source: typeof input.source === 'string' && input.source.trim() !== '' ? input.source.trim() : 'launcher',
      addedAt: new Date().toISOString(),
    };
    const entries = [...allowlist.entries, entry];
    await writeAllowlist(file, entries);
    return { file, canonicalPath, added: true, entry, entries };
  } finally {
    await releaseLock(lockPath, owner);
  }
}

/**
 * Replace the entire allowlist under the same lock. Used by migration seeding
 * and tests; the caller supplies entries that are already canonical.
 *
 * @param {Array<{path: string, title?: string, source?: string, addedAt?: string}>} entries
 * @param {{ file?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {Promise<{ file: string, entries: Array<object> }>}
 */
export async function writeWorkspaceAllowlist(entries, options = {}) {
  const file = options.file ?? resolveWorkspacesFile(options.env ?? process.env);
  const lockPath = `${file}.lock`;
  const owner = await acquireLock(lockPath);
  try {
    await readWorkspaceAllowlist({ file }); // fail closed on a corrupt existing file
    await writeAllowlist(file, entries);
    return { file, entries };
  } finally {
    await releaseLock(lockPath, owner);
  }
}
