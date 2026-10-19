#!/usr/bin/env node
/**
 * Trusted local dispatch launcher for the already-open Desktop MCP bridge.
 *
 * It is an ordinary official-SDK MCP client: it never starts a Host, never
 * invokes `dsh headless`, never falls back to another transport, and never
 * mutates model/permission settings. One execution state file carries the
 * request id, task identity, workspace, pre-admission latestSeq baseline, and
 * read cursor so a network uncertainty can be retried explicitly instead of
 * generating a second request.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  BRIDGE_PROTOCOL,
  BRIDGE_VERSION,
  resolveTokenFile,
  resolveWorkspacesFile,
} from './config.js';
import { readToken } from './config.js';
import { enrollWorkspace, sameWorkspacePath, canonicalDirectoryPath } from './workspaces.js';

export const STATE_VERSION = 1;

export const EXIT = Object.freeze({
  completed: 0,
  failed: 2,
  blocked: 3,
  canceled: 4,
  running: 5,
  dispatchError: 6,
  interrupted: 130,
});

/**
 * Terminal phases that a resume may report without polling again:
 * - `failed`/`blocked`/`canceled` are decisive Host turn evidence (reported with
 *   an explicit inputConsumed flag for honesty);
 * - `terminal` (a success claim) is only trusted when the state also carries a
 *   consumed-input requestId correlation; otherwise the resume re-verifies.
 * `timeout` is deliberately absent: a timed-out dispatch is resumable polling
 * with the same request id/cursor, never a cached permanent exit 5.
 */
const RESUMED_TERMINAL_PHASES = new Set(['terminal', 'failed', 'blocked', 'canceled']);
const DEFAULT_URL = 'http://127.0.0.1:47821/mcp';
const DEFAULT_WAIT_MS = 600000;
const DEFAULT_POLL_MS = 2000;
const DEFAULT_MAX_EVENTS = 40;
const DEFAULT_MAX_CHARS = 12000;
const MAX_DRAIN_PAGES = 200;
/** Bounded backfill scan for the admission user_message of this request. */
const MAX_CONSUMED_SCAN_PAGES = 50;
const CONSUMED_SCAN_MAX_EVENTS = 50;
const CONSUMED_SCAN_MAX_CHARS = 60000;
const CANCEL_RECEIPT_SUFFIX = '.cancel.json';
/**
 * Windows rename-over-target can transiently return EPERM/EACCES/EBUSY while a
 * reader handle is open on the last-good state file (Node read handles do not
 * grant delete-share). Retry only the SAME owned temp rename with a short
 * bounded backoff (<1 s total); never delete or rename-away the last-good target.
 * Non-sharing errors fail immediately; persistent contention fails closed.
 */
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 12;
const RENAME_BACKOFF_MIN_MS = 10;
const RENAME_BACKOFF_MAX_MS = 60;
const RENAME_TOTAL_CAP_MS = 500;
const MAX_BASELINE_SEQ = 2147483647;
const REQUIRED_TOOLS = ['submit_task', 'get_task', 'continue_task', 'cancel_task', 'diagnostics', 'list_sessions'];

export class DispatchError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(code, message, exitCode = EXIT.dispatchError) {
    super(message);
    this.name = 'DispatchError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function fail(code, message, exitCode) {
  throw new DispatchError(code, message, exitCode);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Decode one UTF-8 task file. A leading BOM is stripped; invalid UTF-8 fails
 * closed instead of being silently replaced.
 *
 * @param {Buffer} buffer
 * @returns {string}
 */
export function decodeTaskBuffer(buffer) {
  let bytes = buffer;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('task_not_utf8', 'task file is not valid UTF-8');
  }
}

/**
 * @param {string} taskFile
 * @returns {Promise<{ taskPath: string, text: string, sha256: string }>}
 */
export async function readTaskFile(taskFile) {
  const taskPath = resolve(taskFile);
  let buffer;
  try {
    buffer = await readFile(taskPath);
  } catch (error) {
    fail('task_file_unavailable', `task file is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = decodeTaskBuffer(buffer);
  if (text.trim() === '') fail('task_file_empty', 'task file is empty');
  return { taskPath, text, sha256: sha256(text) };
}

/**
 * Atomic JSON write with an explicit UTF-8 (no BOM) encoding.
 *
 * @param {string} file
 * @param {unknown} value
 */
export async function writeJsonFile(file, value) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const startedAt = Date.now();
    let lastError = null;
    for (let attempt = 0; attempt < RENAME_MAX_ATTEMPTS; attempt += 1) {
      try {
        await rename(temporary, file);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        const code = error?.code;
        if (!RENAME_RETRY_CODES.has(code)) break;
        const elapsed = Date.now() - startedAt;
        if (attempt === RENAME_MAX_ATTEMPTS - 1 || elapsed >= RENAME_TOTAL_CAP_MS) break;
        const delay = Math.min(
          RENAME_BACKOFF_MIN_MS * (attempt + 1),
          RENAME_BACKOFF_MAX_MS,
          Math.max(1, RENAME_TOTAL_CAP_MS - elapsed),
        );
        await sleep(delay);
      }
    }
    if (lastError !== null) throw lastError;
  } catch (error) {
    // Only the write's own temp is removed; the last-good target is never
    // deleted/renamed-away to force the replacement.
    await rm(temporary, { force: true }).catch(() => {});
    fail('state_write_failed', `could not write dispatch state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validCursor(cursor) {
  return cursor !== null && typeof cursor === 'object'
    && Number.isInteger(cursor.seq) && cursor.seq >= -1
    && Number.isInteger(cursor.offset) && cursor.offset >= 0;
}

function validState(state) {
  return state !== null && typeof state === 'object'
    && state.version === STATE_VERSION
    && state.protocol === BRIDGE_PROTOCOL
    && typeof state.requestId === 'string' && state.requestId.length > 0
    && (state.kind === 'submit' || state.kind === 'continue')
    && typeof state.taskPath === 'string' && state.taskPath.length > 0
    && typeof state.taskSha256 === 'string' && /^[a-f0-9]{64}$/u.test(state.taskSha256)
    && typeof state.workspacePath === 'string' && state.workspacePath.length > 0
    && (state.baselineLatestSeq === null || (Number.isInteger(state.baselineLatestSeq) && state.baselineLatestSeq >= -1))
    && validCursor(state.cursor)
    && typeof state.phase === 'string';
}

async function readStateFile(stateFile) {
  let raw;
  try {
    raw = await readFile(stateFile, 'utf8');
  } catch (error) {
    fail('state_unavailable', `dispatch state is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''));
  } catch {
    fail('state_corrupt', 'dispatch state is not valid JSON');
  }
  if (!validState(parsed)) fail('state_corrupt', 'dispatch state has an unsupported shape');
  // Backward-compatible in-place normalization of additive v1 fields.
  parsed.consumedInputSeq = Number.isInteger(parsed.consumedInputSeq) && parsed.consumedInputSeq >= -1
    ? parsed.consumedInputSeq
    : null;
  // A state written before this correction always named an explicit --workspace
  // target and enrolled it, so a missing source normalizes to 'explicit' (never
  // to the default workspace). Existing states stay readable; a resume keeps the
  // stored request id/path instead of re-resolving anything.
  parsed.workspaceSource = parsed.workspaceSource === 'explicit'
    || parsed.workspaceSource === 'default'
    || parsed.workspaceSource === 'session'
    ? parsed.workspaceSource
    : 'explicit';
  parsed.workspaceId = typeof parsed.workspaceId === 'string' && parsed.workspaceId.length > 0
    ? parsed.workspaceId
    : null;
  return parsed;
}

/** Path of the separate atomic cancellation audit receipt (never the state). */
export function cancelReceiptPath(stateFile) {
  return `${stateFile}${CANCEL_RECEIPT_SUFFIX}`;
}

async function readCancelReceipt(stateFile) {
  try {
    const raw = await readFile(cancelReceiptPath(stateFile), 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/u, ''));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True when a projected genuine `user_message` carries this request's persisted
 * requestId. Current Host projection exposes `data.source.rpcId` as
 * `meta.requestId`; text is never matched.
 *
 * @param {unknown} items
 * @param {string} requestId
 * @returns {number | null} the smallest matching event seq
 */
export function findConsumedInputSeq(items, requestId) {
  if (!Array.isArray(items)) return null;
  let found = null;
  for (const item of items) {
    if (item === null || typeof item !== 'object') continue;
    if (item.type !== 'user_message') continue;
    if (typeof item.meta?.requestId !== 'string' || item.meta.requestId !== requestId) continue;
    if (!Number.isInteger(item.seq)) continue;
    if (found === null || item.seq < found) found = item.seq;
  }
  return found;
}

async function recordConsumedInput(context, seq) {
  const { state, stateFile, log } = context;
  if (!Number.isInteger(seq) || seq < 0) return;
  if (Number.isInteger(state.consumedInputSeq) && state.consumedInputSeq <= seq) return;
  state.consumedInputSeq = seq;
  state.inputConsumedAt = new Date().toISOString();
  await writeJsonFile(stateFile, state);
  await log.event('input_consumed', {
    requestId: state.requestId,
    consumedInputSeq: seq,
    baselineLatestSeq: state.baselineLatestSeq,
  });
}

/**
 * Backfill the consumed-input seq when a saved cursor may already be past the
 * admission message (resume) or an old state lacks the additive field. Bounded
 * by page count; failure to prove consumption is reported honestly, never
 * treated as success.
 */
async function backfillConsumedInput(client, context) {
  const { state, log, options } = context;
  if (Number.isInteger(state.consumedInputSeq)) return state.consumedInputSeq;
  const baseline = Number.isInteger(state.baselineLatestSeq) ? state.baselineLatestSeq : -1;
  let cursor = { seq: Math.max(-1, baseline), offset: 0 };
  for (let page = 0; page < MAX_CONSUMED_SCAN_PAGES; page += 1) {
    let view;
    try {
      view = await callTool(client, 'get_task', {
        sessionId: state.sessionId,
        cursor,
        maxEvents: CONSUMED_SCAN_MAX_EVENTS,
        maxChars: CONSUMED_SCAN_MAX_CHARS,
      });
    } catch (error) {
      await log.event('input_scan_failed', { page, error: error instanceof DispatchError ? error.code : 'scan_failed' });
      return null;
    }
    const found = findConsumedInputSeq(view.items, state.requestId);
    if (found !== null) {
      await recordConsumedInput(context, found);
      return found;
    }
    if (view.hasMore !== true) return null;
    if (!validCursor(view.cursor)) return null;
    if (view.cursor.seq === cursor.seq && view.cursor.offset <= cursor.offset) return null;
    cursor = { seq: view.cursor.seq, offset: view.cursor.offset };
  }
  await log.event('input_scan_limited', {
    pages: MAX_CONSUMED_SCAN_PAGES,
    baseline,
    note: 'could not prove this request was consumed within the bounded scan; not claiming success',
  });
  return null;
}


async function acquireStateLock(stateFile, waitMs = 2000) {
  const lockPath = `${stateFile}.lock`;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      const nonce = randomUUID();
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, nonce, createdAt: new Date().toISOString() })}\n`, 'utf8');
      await handle.close();
      return async () => {
        try {
          const owner = JSON.parse(await readFile(lockPath, 'utf8'));
          if (owner?.nonce === nonce) await unlink(lockPath);
        } catch {
          // Leave an uncertain lock rather than deleting another owner's lock.
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        fail('state_lock_failed', `dispatch state lock is unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (Date.now() >= deadline) {
        fail('state_locked', `dispatch state is in use by another process (${lockPath}); no first version scheduler or parallel dispatch is implemented`);
      }
      await sleep(50);
    }
  }
}

function isLoopbackUrl(url) {
  const host = url.hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function toolValue(result) {
  const text = Array.isArray(result?.content)
    ? result.content.find((entry) => entry && entry.type === 'text')?.text
    : undefined;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callTool(client, name, args) {
  let result;
  try {
    result = await client.callTool({ name, arguments: args });
  } catch (error) {
    fail('network_error', `${name} failed before a response: ${error instanceof Error ? error.message : String(error)}`);
  }
  const value = toolValue(result);
  if (result?.isError === true || value === null || value.ok === false) {
    const code = value?.error?.code ?? 'tool_error';
    const message = value?.error?.message ?? `${name} returned an error`;
    fail(code, `${name}: ${message}`);
  }
  return value;
}

async function createClient(options = {}) {
  const tokenFile = options.tokenFile ?? resolveTokenFile({}, options.env ?? process.env);
  let token;
  try {
    ({ token } = await readToken({ tokenFile }, options.env ?? process.env));
  } catch (error) {
    fail('token_unavailable', error instanceof Error ? error.message : String(error));
  }
  const url = new URL(options.url ?? DEFAULT_URL);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('endpoint_invalid', 'endpoint must be an http(s) loopback URL');
  if (!isLoopbackUrl(url)) fail('endpoint_invalid', 'endpoint must address 127.0.0.1/localhost');
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'deepseek-desktop-mcp-dispatch', version: BRIDGE_VERSION },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close().catch(() => {});
    fail('desktop_unreachable', `Desktop MCP bridge is not reachable at ${url.origin}; open Desktop and confirm the bridge plugin is enabled: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    client,
    url,
    async close() {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}

/**
 * Refuse stale bridge code. The capability marker, not an echoed request field,
 * is what proves the loaded bridge can create/resolve an extra workspace.
 *
 * @param {any} diagnostics
 */
export function assertBridgeCompatible(diagnostics) {
  const bridge = diagnostics?.bridge;
  if (bridge === null || typeof bridge !== 'object'
    || bridge.protocol !== BRIDGE_PROTOCOL
    || bridge.workspacePath !== true
    || bridge.standardMode !== true) {
    const reported = bridge === null || bridge === undefined || typeof bridge !== 'object'
      ? 'no bridge marker'
      : JSON.stringify({
        protocol: bridge.protocol ?? null,
        version: bridge.version ?? null,
        workspacePath: bridge.workspacePath ?? null,
        standardMode: bridge.standardMode ?? null,
      });
    fail(
      'stale_bridge',
      `loaded Desktop bridge does not report ${BRIDGE_PROTOCOL} + workspacePath=true + standardMode=true (${reported}). The loaded bridge lacks required capabilities; promote/hot-reload the current bridge (Plugins Off/On) before dispatching. The launcher never falls back to another workspace or an inferred cwd.`,
    );
  }
  if (diagnostics?.model?.matchesRequired !== true) {
    const configured = diagnostics?.model?.configured ?? null;
    fail(
      'model_route_mismatch',
      `configured model route is not the required deepseek-official/deepseek-flash/max (${JSON.stringify(configured)}); the launcher does not change model settings`,
    );
  }
}

async function preflight(client) {
  let tools;
  try {
    tools = await client.listTools();
  } catch (error) {
    fail('preflight_failed', `MCP tool listing failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const names = Array.isArray(tools?.tools) ? tools.tools.map((tool) => tool.name) : [];
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) fail('preflight_failed', `MCP bridge is missing tools: ${missing.join(', ')}`);
  const diagnostics = await callTool(client, 'diagnostics', {});
  assertBridgeCompatible(diagnostics);
  return { tools: names, diagnostics };
}

/**
 * Canonicalize one explicitly supplied `--workspace` directory, or fail with a
 * clear dispatch error. An unusable explicit project path never silently falls
 * back to the default workspace or an inferred cwd.
 *
 * @param {unknown} input
 * @returns {Promise<string>}
 */
async function resolveExplicitWorkspace(input) {
  try {
    return await canonicalDirectoryPath(input);
  } catch (error) {
    fail(
      typeof error?.code === 'string' ? error.code : 'workspace_path_invalid',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The configured default workspace is read from authenticated bridge
 * diagnostics and canonicalized locally. Its path is the persisted target for a
 * projectless task; nothing is inferred from process.cwd, the task file, or the
 * log directory, and the directory is never enrolled.
 *
 * @param {any} diagnostics
 * @returns {Promise<{ path: string, reportedPath: string, workspaceId: string | null, source: 'default' }>}
 */
async function resolveDefaultTarget(diagnostics) {
  const workspace = diagnostics?.workspace;
  if (workspace === null || typeof workspace !== 'object'
    || typeof workspace.path !== 'string' || workspace.path.trim() === '') {
    fail(
      'default_workspace_unavailable',
      'Desktop bridge diagnostics did not report a configured default workspace path; refusing to guess a cwd and refusing to fall back',
    );
  }
  let canonicalPath;
  try {
    canonicalPath = await canonicalDirectoryPath(workspace.path);
  } catch (error) {
    fail(
      'default_workspace_invalid',
      `configured default workspace "${workspace.path}" is not an existing usable directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path: canonicalPath,
    reportedPath: workspace.path,
    workspaceId: typeof workspace.id === 'string' && workspace.id.length > 0 ? workspace.id : null,
    source: 'default',
  };
}

/**
 * Derive the existing target session's actual workspace from read-only
 * `get_task` data. This is the same bounded probe the continuation baseline
 * already required, so the verified target and baseline come from one call and
 * the session is never re-homed.
 *
 * @param {any} client
 * @param {string} sessionId
 * @returns {Promise<{ path: string, reportedPath: string, workspaceId: string | null, latestSeq: number }>}
 */
function assertStandardPreset(view) {
  if (view?.agentPreset !== 'standard') {
    fail('agent_preset_mismatch', `Session preset ${view?.agentPreset ?? '?'} is not standard; refusing continuation or acceptance`);
  }
}

async function resolveSessionTarget(client, sessionId) {
  const view = await callTool(client, 'get_task', {
    sessionId,
    maxEvents: 1,
    maxChars: 1,
    cursor: { seq: MAX_BASELINE_SEQ, offset: 0 },
  });
  assertStandardPreset(view);
  if (!Number.isInteger(view.latestSeq)) fail('protocol_error', 'get_task did not report latestSeq for the continuation baseline');
  if (typeof view.workspacePath !== 'string' || view.workspacePath.trim() === '') {
    fail(
      'session_workspace_unavailable',
      `get_task for session "${sessionId}" did not report its workspace path; refusing to continue without a verified target`,
    );
  }
  let canonicalPath;
  try {
    canonicalPath = await canonicalDirectoryPath(view.workspacePath);
  } catch (error) {
    fail(
      'session_workspace_invalid',
      `session "${sessionId}" workspace "${view.workspacePath}" is not an existing usable directory: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path: canonicalPath,
    reportedPath: view.workspacePath,
    workspaceId: typeof view.workspaceId === 'string' && view.workspaceId.length > 0 ? view.workspaceId : null,
    latestSeq: view.latestSeq,
  };
}

/**
 * Compare one persisted canonical target with a Host-reported workspace path.
 * Exact/case/separator comparison first; a canonical re-resolution only absorbs
 * alternative spellings of the same directory, never a different one.
 *
 * @param {unknown} persisted
 * @param {unknown} reported
 * @returns {Promise<boolean>}
 */
async function workspacePathAgrees(persisted, reported) {
  if (sameWorkspacePath(persisted, reported)) return true;
  if (typeof reported !== 'string' || reported.trim() === '') return false;
  try {
    return sameWorkspacePath(persisted, await canonicalDirectoryPath(reported));
  } catch {
    return false;
  }
}

/**
 * One new request state. The persisted workspacePath is always the true target
 * resolved from an explicit directory, authenticated diagnostics, or read-only
 * session data — never a placeholder.
 *
 * @param {{ kind: 'submit'|'continue', task: { taskPath: string, sha256: string }, workspacePath: string, workspaceSource: 'explicit'|'default'|'session', workspaceId: string | null, sessionId: string | null, baselineLatestSeq: number | null }} input
 */
function newState(input) {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    protocol: BRIDGE_PROTOCOL,
    bridgeVersion: BRIDGE_VERSION,
    requestId: `desktop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    kind: input.kind,
    taskPath: input.task.taskPath,
    taskSha256: input.task.sha256,
    workspacePath: input.workspacePath,
    workspaceSource: input.workspaceSource,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    baselineLatestSeq: input.baselineLatestSeq,
    consumedInputSeq: null,
    cursor: { seq: -1, offset: 0 },
    phase: 'preparing',
    createdAt: now,
    updatedAt: now,
  };
}

async function logStart(log, state, stateFile) {
  await log.event('start', {
    requestId: state.requestId,
    kind: state.kind,
    taskPath: state.taskPath,
    taskSha256: state.taskSha256,
    workspacePath: state.workspacePath,
    workspaceSource: state.workspaceSource,
    workspaceId: state.workspaceId ?? null,
    sessionId: state.sessionId ?? null,
    stateFile,
  });
}

function boundItem(item, limit) {
  const points = Array.from(typeof item.text === 'string' ? item.text : '');
  return {
    seq: item.seq,
    type: item.type,
    ...(typeof item.partial === 'boolean' ? { partial: item.partial } : {}),
    text: points.length <= limit ? points.join('') : `${points.slice(0, limit).join('')}…[truncated]`,
    ...(item.meta === undefined ? {} : { meta: item.meta }),
  };
}

function boundedStatus(view) {
  const status = view?.status;
  if (status === null || typeof status !== 'object') return null;
  return {
    state: typeof status.state === 'string' ? status.state : null,
    running: status.running === true,
    success: status.success === true,
    completion: status.completion ?? null,
    ...(typeof status.note === 'string' ? { note: status.note } : {}),
  };
}

/**
 * Poll one session and append bounded output pages to the log.
 *
 * A `finished` success is claimed only when BOTH hold:
 *   1. durable completion.seq is newer than the pre-admission baseline, AND
 *   2. a projected genuine user_message with `meta.requestId` equal to this
 *      dispatch's persisted requestId was observed at/after admission, and
 *      completion.seq is newer than that consumed-input seq.
 * A previous turn's completion therefore cannot complete this request, and an
 * unconsumed/queued continuation never reports success. `failed`/`canceled`/
 * `blocked` turn evidence is still reported honestly (with `inputConsumed`).
 * After the verified terminal page the tail is drained until `hasMore` is false
 * (or explicitly reported partial).
 */
async function pollToTerminal(client, context) {
  const { state, stateFile, log, options, baseline } = context;
  const deadline = Date.now() + options.waitMs;
  let finalView = null;
  let outcome = null;
  let pendingReason = null;
  let sawCompletionWithoutConsumedInput = false;

  // A resumed saved cursor may already be past this request's admission
  // message; bounded backfill before polling keeps the proof durable.
  if (!Number.isInteger(state.consumedInputSeq) && Number.isInteger(state.cursor?.seq) && state.cursor.seq >= 0) {
    await backfillConsumedInput(client, context);
  }

  for (let pageIndex = 0; ; pageIndex += 1) {
    if (options.signal?.aborted) {
      await log.event('interrupted', {
        sessionId: state.sessionId,
        cursor: state.cursor,
        latestSeq: state.latestSeq ?? null,
        consumedInputSeq: state.consumedInputSeq ?? null,
      });
      state.interruptedAt = new Date().toISOString();
      await writeJsonFile(stateFile, state);
      return { outcome: 'interrupted', exitCode: EXIT.interrupted, view: finalView, outputPartial: false, sawCompletionWithoutConsumedInput };
    }
    let view;
    try {
      view = await callTool(client, 'get_task', {
        sessionId: state.sessionId,
        cursor: state.cursor,
        maxEvents: options.maxEvents,
        maxChars: options.maxChars,
      });
    } catch (error) {
      await writeJsonFile(stateFile, state);
      throw error;
    }
    assertStandardPreset(view);
    finalView = view;
    if (!validCursor(view.cursor)) fail('protocol_error', 'get_task returned a malformed cursor');
    state.cursor = { seq: view.cursor.seq, offset: view.cursor.offset };
    if (Number.isInteger(view.latestSeq)) state.latestSeq = view.latestSeq;
    state.lastStatus = boundedStatus(view);
    state.pending = view.pendingAction?.pending === true;

    const foundInput = findConsumedInputSeq(view.items, state.requestId);
    const newlyFound = foundInput !== null && !Number.isInteger(state.consumedInputSeq);
    if (newlyFound) {
      state.consumedInputSeq = foundInput;
      state.inputConsumedAt = new Date().toISOString();
    }

    await log.event('page', {
      page: pageIndex,
      cursor: view.cursor,
      latestSeq: view.latestSeq ?? null,
      hasMore: view.hasMore === true,
      status: state.lastStatus,
      pendingAction: state.pending,
      consumedInputSeq: Number.isInteger(state.consumedInputSeq) ? state.consumedInputSeq : null,
      // The bridge page is already bounded by get_task maxChars; log the full
      // bounded page text so a long visible answer is never silently dropped
      // while the durable cursor advances past it. The final summary tail keeps
      // its small 500-char preview separately.
      items: Array.isArray(view.items) ? view.items.map((item) => boundItem(item, options.maxChars)) : [],
    });
    await writeJsonFile(stateFile, state);
    if (newlyFound) {
      await log.event('input_consumed', {
        requestId: state.requestId,
        consumedInputSeq: state.consumedInputSeq,
        baselineLatestSeq: baseline,
      });
    }

    const completion = view?.status?.completion;
    const completionSeq = Number.isInteger(completion?.seq) ? completion.seq : null;
    const statusState = view?.status?.state;
    const completionAfterBaseline = completionSeq !== null && completionSeq > baseline
      && (statusState === 'finished' || statusState === 'failed' || statusState === 'canceled' || statusState === 'blocked');
    const consumedSeq = Number.isInteger(state.consumedInputSeq) ? state.consumedInputSeq : null;
    const successProven = completionAfterBaseline
      && consumedSeq !== null
      && completionSeq > consumedSeq
      && statusState === 'finished'
      && view.status.success === true;

    if (completionAfterBaseline && statusState === 'finished' && view.status.success === true && !successProven) {
      sawCompletionWithoutConsumedInput = true;
      if (context.loggedUnconsumed !== true) {
        context.loggedUnconsumed = true;
        await log.event('completion_without_consumed_input', {
          completionSeq,
          consumedInputSeq: consumedSeq,
          note: 'a finished completion is newer than the baseline, but this request input is not proven consumed; not claiming success',
        });
      }
    }

    if (successProven) {
      outcome = 'completed';
      break;
    }
    // A consumed-input `finished` completion with success:false (the Host maps
    // max-tokens to finished/success:false) is a durable terminal NON-success:
    // report it immediately as failed instead of polling until the wait deadline.
    const consumedNonSuccess = completionAfterBaseline
      && statusState === 'finished'
      && view.status.success !== true
      && consumedSeq !== null
      && completionSeq > consumedSeq;
    if (consumedNonSuccess) {
      outcome = 'failed';
      break;
    }
    if (completionAfterBaseline && statusState !== 'finished') {
      // Genuine Host failure/cancel/blocked evidence is reported honestly,
      // with inputConsumed exposed in the summary so callers see whether this
      // request's own input had been consumed.
      if (statusState === 'blocked') outcome = 'blocked';
      else if (statusState === 'canceled') outcome = 'canceled';
      else outcome = 'failed';
      break;
    }

    if (view.pendingAction?.pending === true) {
      outcome = 'pending';
      pendingReason = 'action';
      break;
    }

    if (Date.now() >= deadline) {
      const inbox = view.pendingInbox;
      const retainedInbox = inbox?.known === true
        && (inbox.nextTurnCount + inbox.nextStepCount) > 0;
      if (retainedInbox) {
        outcome = 'pending';
        pendingReason = 'inbox';
      } else {
        outcome = 'timeout';
      }
      break;
    }
    await sleep(Math.min(options.pollMs, Math.max(10, deadline - Date.now())));
  }

  let outputPartial = false;
  if (finalView?.hasMore === true) {
    let drainPages = 0;
    for (;;) {
      if (drainPages >= MAX_DRAIN_PAGES) {
        outputPartial = true;
        await log.event('partial_output', {
          sessionId: state.sessionId,
          cursor: state.cursor,
          reason: `tail still had hasMore after ${MAX_DRAIN_PAGES} drain pages; last output was not silently dropped, it is reported partial`,
        });
        break;
      }
      drainPages += 1;
      let view;
      try {
        view = await callTool(client, 'get_task', {
          sessionId: state.sessionId,
          cursor: state.cursor,
          maxEvents: options.maxEvents,
          maxChars: options.maxChars,
        });
      } catch (error) {
        await writeJsonFile(stateFile, state);
        throw error;
      }
      assertStandardPreset(view);
      finalView = view;
      if (!validCursor(view.cursor)) fail('protocol_error', 'get_task returned a malformed cursor');
      state.cursor = { seq: view.cursor.seq, offset: view.cursor.offset };
      if (Number.isInteger(view.latestSeq)) state.latestSeq = view.latestSeq;
      await log.event('drain_page', {
        page: drainPages,
        cursor: view.cursor,
        hasMore: view.hasMore === true,
        items: Array.isArray(view.items) ? view.items.map((item) => boundItem(item, options.maxChars)) : [],
      });
      await writeJsonFile(stateFile, state);
      if (view.hasMore !== true) break;
    }
  }

  const exitCode = outcome === 'completed' ? EXIT.completed
    : outcome === 'failed' ? EXIT.failed
      : outcome === 'blocked' || outcome === 'pending' ? EXIT.blocked
        : outcome === 'canceled' ? EXIT.canceled
          : EXIT.running;
  state.phase = outcome === 'pending' ? 'blocked'
    : outcome === 'timeout' ? 'timeout'
      : outcome === 'completed' ? 'terminal'
        : outcome;
  // Persist why a pending outcome was reported so a later -ResumeState can
  // re-poll a retained-inbox/question wait instead of caching exit 3 forever. A
  // genuine Host turn-end "blocked" has lastStatus.state === 'blocked' and stays
  // decisive.
  state.pendingReason = outcome === 'pending' ? pendingReason : null;
  state.finishedAt = new Date().toISOString();
  state.outputPartial = outputPartial;
  state.inputConsumed = Number.isInteger(state.consumedInputSeq);
  state.sawCompletionWithoutConsumedInput = sawCompletionWithoutConsumedInput;
  await writeJsonFile(stateFile, state);
  context.cancelReceipt = await readCancelReceipt(stateFile);
  if (context.cancelReceipt !== null) {
    await log.event('cancel_receipt_preserved', {
      cancelReceiptPath: cancelReceiptPath(stateFile),
      accepted: context.cancelReceipt.accepted === true,
    });
  }
  await log.event('terminal', {
    outcome,
    exitCode,
    cursor: state.cursor,
    baseline,
    status: state.lastStatus,
    outputPartial,
    inputConsumed: state.inputConsumed,
    consumedInputSeq: state.consumedInputSeq ?? null,
    sawCompletionWithoutConsumedInput,
  });
  return { outcome, exitCode, view: finalView, outputPartial, sawCompletionWithoutConsumedInput };
}

function boundedSummary(result, context) {
  const view = result.view;
  const items = Array.isArray(view?.items) ? view.items.slice(-5) : [];
  const inputConsumed = Number.isInteger(context.state.consumedInputSeq);
  const viewStatus = boundedStatus(view);
  const note = result.outcome === 'completed'
    ? 'completion is newer than both the pre-admission baseline and the consumed request input'
    : result.outcome === 'pending'
      ? (inputConsumed
        ? 'not a completion: this request input was consumed, but the turn is waiting on user input or retained inbox work; resume with --resume-state after the answer/processing'
        : 'not a completion: pending inbox/action work remains and this request input is not proven consumed; resume with --resume-state')
      : result.outcome === 'timeout'
        ? (inputConsumed
          ? 'not a completion: wait expired after this request input was consumed; the Desktop task may still be running — resume with --resume-state'
          : 'not a completion: wait expired before this request input was proven consumed; the Desktop task may still be running — resume with --resume-state')
        : result.outcome === 'failed' && viewStatus?.state === 'finished'
          ? `Host turn ended finished without success${viewStatus.completion?.reason?.kind === 'max-tokens' ? ' (max-tokens)' : ''}; this request input was ${inputConsumed ? 'consumed' : 'not proven consumed'}; terminal non-success`
          : result.outcome === 'failed' || result.outcome === 'canceled' || result.outcome === 'blocked'
            ? `Host turn ended ${result.outcome}; this request input was ${inputConsumed ? 'consumed' : 'not proven consumed'}`
            : null;
  const summary = {
    ok: result.outcome === 'completed',
    outcome: result.outcome,
    exitCode: result.exitCode,
    requestId: context.state.requestId,
    kind: context.state.kind,
    sessionId: context.state.sessionId,
    workspaceId: result.workspaceId ?? context.state.workspaceId ?? null,
    workspacePath: context.state.workspacePath,
    workspaceSource: context.state.workspaceSource,
    agentPreset: view?.agentPreset ?? null,
    baselineLatestSeq: context.baseline,
    consumedInputSeq: inputConsumed ? context.state.consumedInputSeq : null,
    inputConsumed,
    pendingReason: context.state.pendingReason ?? null,
    sawCompletionWithoutConsumedInput: result.sawCompletionWithoutConsumedInput === true
      && result.outcome !== 'completed',
    cursor: context.state.cursor,
    latestSeq: context.state.latestSeq ?? null,
    status: viewStatus,
    pendingAction: view?.pendingAction ?? null,
    pendingInbox: view?.pendingInbox ?? null,
    modelRoute: view?.modelRoute ?? null,
    outputPartial: result.outputPartial,
    stateFile: context.stateFile,
    logFile: context.logFile,
    cancelReceiptPath: context.cancelReceipt === undefined || context.cancelReceipt === null ? null : cancelReceiptPath(context.stateFile),
    note,
    tailItems: items.map((item) => boundItem(item, 500)),
  };
  return summary;
}

/**
 * @param {object} options
 * @returns {Promise<{ exitCode: number, summary: object }>}
 */
export async function runDispatch(options) {
  const env = options.env ?? process.env;
  const task = await readTaskFile(options.taskFile);
  // An explicit --workspace is the project opt-in and is resolved locally now.
  // Its absence means "configured default workspace" for a new task and "the
  // existing session workspace" for a continuation; process.cwd, the task file
  // directory and the log directory are never treated as a project identity.
  const explicitWorkspace = options.workspace === undefined || options.workspace === null
    ? null
    : await resolveExplicitWorkspace(options.workspace);
  const logFile = resolve(options.logFile);
  const kind = options.sessionId ? 'continue' : 'submit';
  const sessionId = options.sessionId ?? null;
  const resumePath = options.resumeState ? resolve(options.resumeState) : null;
  const stateFile = resumePath ?? resolve(options.stateFile ?? `${logFile}.state.json`);
  if (resumePath === null) {
    try {
      await readFile(stateFile);
      fail('state_exists', `dispatch state already exists; a new invocation must be a new request. Reuse it explicitly with --resume-state <path> and a new log file: ${stateFile}`);
    } catch (error) {
      if (error instanceof DispatchError) throw error;
      if (!error || error.code !== 'ENOENT') fail('state_unavailable', `dispatch state cannot be inspected: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const releaseLock = await acquireStateLock(stateFile);
  try {
    try {
      await open(logFile, 'wx', 0o600).then((handle) => handle.close());
    } catch (error) {
      if (error && error.code === 'EEXIST') fail('log_exists', `log file already exists; use a new log filename to preserve earlier evidence: ${logFile}`);
      fail('log_unavailable', `log file cannot be created: ${error instanceof Error ? error.message : String(error)}`);
    }
    const logHandle = await open(logFile, 'a', 0o600);
    const log = {
      async event(name, data) {
        await logHandle.write(`${JSON.stringify({ time: new Date().toISOString(), event: name, ...data })}\n`, 'utf8');
      },
      async close() {
        await logHandle.close().catch(() => {});
      },
    };

    try {
    let state;
    // Whether this run already proved the continuation target's workspace from
    // read-only get_task data; a resumed prepared state may need one check
    // before continue_task instead.
    let sessionWorkspaceVerified = false;
    if (resumePath !== null) {
      state = await readStateFile(resumePath);
      if (state.taskPath !== task.taskPath) fail('resume_task_mismatch', `resume state belongs to task "${state.taskPath}", not "${task.taskPath}"`);
      if (state.taskSha256 !== task.sha256) fail('resume_task_mismatch', 'resume state task text hash does not match the current task file; refusing to reuse the request id');
      if (state.kind !== kind) fail('resume_task_mismatch', `resume state is a ${state.kind} request, but this invocation is a ${kind} request`);
      if (explicitWorkspace !== null && !sameWorkspacePath(state.workspacePath, explicitWorkspace)) {
        fail('resume_workspace_mismatch', `resume state is pinned to workspace "${state.workspacePath}"; explicit --workspace "${explicitWorkspace}" would rehome it`);
      }
      if (kind === 'continue') {
        const stored = state.sessionId;
        if (typeof stored !== 'string' || stored.length === 0) fail('resume_task_mismatch', 'continuation resume state has no sessionId');
        if (sessionId !== null && sessionId !== stored) fail('resume_task_mismatch', `resume state targets session "${stored}", not "${sessionId}"`);
      }
      await log.event('resume', {
        stateFile: resumePath,
        phase: state.phase,
        requestId: state.requestId,
        sessionId: state.sessionId ?? null,
        baseline: state.baselineLatestSeq,
        consumedInputSeq: Number.isInteger(state.consumedInputSeq) ? state.consumedInputSeq : null,
      });
      if (RESUMED_TERMINAL_PHASES.has(state.phase)) {
        const storedOutcome = state.phase;
        const successVerified = storedOutcome === 'terminal'
          && Number.isInteger(state.consumedInputSeq)
          && Number.isInteger(state.lastStatus?.completion?.seq)
          && state.lastStatus.completion.seq > state.consumedInputSeq;
        // A pending/queued/question wait is resumable polling: it must re-poll the
        // same request/baseline/cursor instead of caching exit 3 forever. A
        // genuine Host turn-end "blocked" has lastStatus.state === 'blocked' and
        // remains decisive stored evidence.
        const resumablePending = storedOutcome === 'blocked'
          && (typeof state.pendingReason === 'string' || state.lastStatus?.state !== 'blocked');
        const decisiveNonSuccess = storedOutcome === 'failed'
          || storedOutcome === 'canceled'
          || (storedOutcome === 'blocked' && !resumablePending);
        if (decisiveNonSuccess || (storedOutcome === 'terminal' && successVerified)) {
          const exitCode = storedOutcome === 'terminal' ? EXIT.completed
            : storedOutcome === 'failed' ? EXIT.failed
              : storedOutcome === 'blocked' ? EXIT.blocked
                : EXIT.canceled;
          const summary = {
            ok: exitCode === EXIT.completed,
            outcome: storedOutcome,
            exitCode,
            requestId: state.requestId,
            kind: state.kind,
            sessionId: state.sessionId ?? null,
            workspaceId: state.workspaceId ?? null,
            workspacePath: state.workspacePath,
            workspaceSource: state.workspaceSource,
            baselineLatestSeq: state.baselineLatestSeq,
            consumedInputSeq: Number.isInteger(state.consumedInputSeq) ? state.consumedInputSeq : null,
            inputConsumed: Number.isInteger(state.consumedInputSeq),
            pendingReason: state.pendingReason ?? null,
            cursor: state.cursor,
            latestSeq: state.latestSeq ?? null,
            outputPartial: state.outputPartial === true,
            stateFile,
            logFile,
            resumedTerminalState: true,
            cancelReceiptPath: (await readCancelReceipt(stateFile)) === null ? null : cancelReceiptPath(stateFile),
            note: storedOutcome === 'terminal'
              ? 'resumed verified terminal state: completion is newer than both baseline and consumed request input'
              : `resumed stored ${storedOutcome} Host evidence; this request input was ${Number.isInteger(state.consumedInputSeq) ? 'consumed' : 'not proven consumed'}`,
          };
          await log.event('result', summary);
          console.log(`RESULT ${JSON.stringify(summary)}`);
          return { exitCode, summary };
        }
        if (resumablePending) {
          await log.event('resume_after_pending', {
            pendingReason: state.pendingReason ?? null,
            lastStatusState: state.lastStatus?.state ?? null,
            cursor: state.cursor,
            baselineLatestSeq: state.baselineLatestSeq,
            note: 'retained-inbox/question wait is resumable polling; re-polling with the stored request id/baseline/cursor',
          });
        } else {
          // A stale/old-schema success claim without durable consumed-request
          // proof is NOT reported as success; fall through and re-verify by
          // polling the durable events for this persisted requestId.
          await log.event('resume_terminal_reverify', {
            phase: state.phase,
            consumedInputSeq: state.consumedInputSeq ?? null,
            completionSeq: state.lastStatus?.completion?.seq ?? null,
            note: 'success claim lacks durable consumed-requestId proof; re-verifying before any success',
          });
        }
      } else if (state.phase === 'timeout') {
        // Resumable polling: a timed-out dispatch keeps its request id, session,
        // baseline and cursor and continues waiting instead of caching exit 5.
        await log.event('resume_after_timeout', {
          cursor: state.cursor,
          baselineLatestSeq: state.baselineLatestSeq,
          note: 're-entering polling with the stored request id/cursor; not a terminal state',
        });
      }
      if (kind === 'submit' && typeof state.sessionId !== 'string' && state.phase === 'admitted') {
        fail('state_corrupt', 'admitted submit state has no sessionId');
      }
    } else {
      if (kind === 'continue' && (typeof sessionId !== 'string' || sessionId.length === 0)) {
        fail('usage', 'SessionId must not be empty');
      }
      // An explicit project target is verified locally offline, so the request
      // state can be persisted before the first network call (keeping the
      // durable request id over an unresolved preflight/network error). A
      // projectless task or continuation is resolved from trusted diagnostics /
      // get_task data after preflight, before the FIRST state and before any
      // admission; a failure there leaves no request id and no admission risk.
      if (explicitWorkspace !== null) {
        state = newState({
          kind,
          task,
          workspacePath: explicitWorkspace,
          workspaceSource: 'explicit',
          workspaceId: null,
          sessionId,
          baselineLatestSeq: kind === 'submit' ? -1 : null,
        });
        await writeJsonFile(stateFile, state);
        await logStart(log, state, stateFile);
      } else {
        state = null;
      }
    }

    const client = await createClient({ url: options.url, tokenFile: options.tokenFile, env });
    try {
      const { diagnostics } = await preflight(client.client);
      await log.event('preflight', {
        server: client.client.getServerVersion() ?? null,
        bridge: diagnostics.bridge,
        model: diagnostics.model,
        configuredWorkspace: diagnostics.workspace ?? null,
      });

      // Read-only target resolution for a new request happens before the FIRST
      // state/admission: the default target comes from authenticated diagnostics
      // (never process.cwd/task/log dirs); a continuation derives the existing
      // session workspace and pre-admission baseline from get_task. A failure
      // here leaves no state, no request id and no admission to duplicate.
      if (state === null) {
        if (kind === 'submit') {
          const target = await resolveDefaultTarget(diagnostics);
          state = newState({
            kind,
            task,
            workspacePath: target.path,
            workspaceSource: 'default',
            workspaceId: target.workspaceId,
            sessionId: null,
            baselineLatestSeq: -1,
          });
          await writeJsonFile(stateFile, state);
          await logStart(log, state, stateFile);
          await log.event('workspace_resolved', {
            source: 'default',
            workspacePath: target.path,
            reportedPath: target.reportedPath,
            workspaceId: target.workspaceId,
            submitWorkspacePath: 'omitted',
            note: 'configured default workspace from authenticated bridge diagnostics; not enrolled and never inferred from cwd/task/log directories',
          });
        } else {
          // state === null only happens when no explicit workspace was given
          // (an explicit target creates its state offline before preflight), so
          // this continuation always derives the existing session workspace.
          const target = await resolveSessionTarget(client.client, sessionId);
          sessionWorkspaceVerified = true;
          state = newState({
            kind,
            task,
            workspacePath: target.path,
            workspaceSource: 'session',
            workspaceId: target.workspaceId,
            sessionId,
            baselineLatestSeq: target.latestSeq,
          });
          await writeJsonFile(stateFile, state);
          await logStart(log, state, stateFile);
          await log.event('workspace_resolved', {
            source: 'session',
            workspacePath: target.path,
            reportedPath: target.reportedPath,
            workspaceId: target.workspaceId,
            baselineLatestSeq: target.latestSeq,
            note: 'continuation target derived from get_task session data before admission; the session is never rehomed',
          });
        }
      }
      const context = { state, stateFile, logFile, log, options };

      // Only an explicit project opt-in is locally enrolled (backward
      // compatible). Enrollment must precede the continuation baseline probe:
      // the Host authorizes an enrolled (non-default) session through this
      // allowlist. The configured default workspace and a derived session
      // workspace are Host-owned: nothing is enrolled for those targets, and a
      // default submit omits workspacePath entirely.
      if (state.workspaceSource === 'explicit') {
        const enrollment = await enrollWorkspace({
          path: state.workspacePath,
          source: 'launcher',
          file: options.workspacesFile ?? resolveWorkspacesFile({}, env),
          env,
        });
        await log.event('workspace_enrolled', { file: enrollment.file, canonicalPath: enrollment.canonicalPath, added: enrollment.added });
      } else {
        await log.event('workspace_not_enrolled', {
          source: state.workspaceSource,
          workspacePath: state.workspacePath,
          workspaceId: state.workspaceId ?? null,
          submitWorkspacePath: state.kind === 'submit' ? 'omitted' : null,
          note: 'default/session target is Host-owned; no allowlist enrollment and no local workspace registration',
        });
      }

      let baseline = state.baselineLatestSeq;
      if (baseline === null) {
        const current = await callTool(client.client, 'get_task', {
          sessionId: state.sessionId,
          maxEvents: 1,
          maxChars: 1,
          cursor: { seq: MAX_BASELINE_SEQ, offset: 0 },
        });
        if (!Number.isInteger(current.latestSeq)) fail('protocol_error', 'get_task did not report latestSeq for the continuation baseline');
        // An explicit continuation is checked against the session's actual
        // workspace before continue_task; a re-admitted resume is checked too.
        if (!(await workspacePathAgrees(state.workspacePath, current.workspacePath))) {
          fail('workspace_path_mismatch', `session "${state.sessionId}" reports workspace "${current.workspacePath ?? '?'}", not the persisted target "${state.workspacePath}"; refusing to continue or poll a wrong-cwd session`);
        }
        baseline = current.latestSeq;
        state.baselineLatestSeq = baseline;
        sessionWorkspaceVerified = true;
        await log.event('baseline', { baselineLatestSeq: baseline, phase: state.phase, workspacePath: state.workspacePath });
      }

      // A resumed request that still needs admission is re-bound to its
      // persisted target BEFORE submit_task/continue_task. A default submit
      // omits workspacePath, so the Host would use its current default: if that
      // default changed since this request was prepared, fail here with no new
      // prompt instead of submitting to a different workspace and rejecting the
      // receipt afterwards. An already-admitted/terminal resume never runs this
      // check and keeps its original target without consulting the current
      // default at all.
      const admissionPending = state.phase === 'preparing' || state.phase === 'prepared';
      if (admissionPending && state.workspaceSource === 'default') {
        const currentDefault = await resolveDefaultTarget(diagnostics);
        const samePath = sameWorkspacePath(state.workspacePath, currentDefault.path);
        const sameId = typeof state.workspaceId !== 'string'
          || currentDefault.workspaceId === null
          || state.workspaceId === currentDefault.workspaceId;
        if (!samePath || !sameId) {
          fail(
            'default_workspace_changed',
            `this request is pinned to default workspace "${state.workspacePath}" (id ${state.workspaceId ?? '?'}), but Desktop now reports "${currentDefault.path}" (id ${currentDefault.workspaceId ?? '?'}); refusing to submit to a changed default workspace`,
          );
        }
        await log.event('default_target_verified', {
          workspacePath: state.workspacePath,
          workspaceId: state.workspaceId ?? null,
        });
      } else if (admissionPending && state.kind === 'continue' && !sessionWorkspaceVerified) {
        const current = await resolveSessionTarget(client.client, state.sessionId);
        if (!sameWorkspacePath(state.workspacePath, current.path)) {
          fail(
            'workspace_path_mismatch',
            `session "${state.sessionId}" now reports workspace "${current.path}", not the persisted target "${state.workspacePath}"; refusing to continue before admission`,
          );
        }
        sessionWorkspaceVerified = true;
        await log.event('session_target_verified', {
          workspacePath: state.workspacePath,
          reportedPath: current.reportedPath,
        });
      }

      if (state.phase === 'preparing') {
        // Durable "prepared" marker with the baseline must exist before any
        // admission call, so a retry reuses this request id and baseline.
        state.phase = 'prepared';
        state.updatedAt = new Date().toISOString();
        await writeJsonFile(stateFile, state);
        await log.event('prepared', { baselineLatestSeq: baseline });
      }
      context.baseline = baseline;

      const previousPhase = state.phase;
      const needsAdmission = state.phase === 'preparing' || state.phase === 'prepared';
      if (needsAdmission) {
        let admission;
        if (state.kind === 'submit') {
          const submitArgs = {
            requestId: state.requestId,
            task: task.text,
          };
          // The default workspace is chosen by the Host when workspacePath is
          // absent; only an explicit project opt-in sends one.
          if (state.workspaceSource === 'explicit') submitArgs.workspacePath = state.workspacePath;
          admission = await callTool(client.client, 'submit_task', submitArgs);
          if (typeof admission.sessionId !== 'string' || admission.sessionId.length === 0) {
            fail('protocol_error', 'submit_task returned no sessionId');
          }
          if (!(await workspacePathAgrees(state.workspacePath, admission.workspacePath))) {
            fail('workspace_path_mismatch', `submit_task accepted workspace "${admission.workspacePath ?? '?'}" instead of "${state.workspacePath}"; not polling a wrong-cwd session`);
          }
          if (typeof state.workspaceId === 'string' && typeof admission.workspaceId === 'string'
            && state.workspaceId !== admission.workspaceId) {
            fail('workspace_id_mismatch', `submit_task accepted workspace id "${admission.workspaceId}" instead of the resolved target id "${state.workspaceId}"; not polling a re-homed session`);
          }
          state.sessionId = admission.sessionId;
          state.workspaceId = admission.workspaceId ?? state.workspaceId ?? null;
        } else {
          admission = await callTool(client.client, 'continue_task', {
            sessionId: state.sessionId,
            requestId: state.requestId,
            text: task.text,
          });
          if (!(await workspacePathAgrees(state.workspacePath, admission.workspacePath))) {
            fail('workspace_path_mismatch', `continue_task reports workspace "${admission.workspacePath ?? '?'}" instead of "${state.workspacePath}"; refusing to poll`);
          }
          if (typeof state.workspaceId === 'string' && typeof admission.workspaceId === 'string'
            && state.workspaceId !== admission.workspaceId) {
            fail('workspace_id_mismatch', `continue_task reports workspace id "${admission.workspaceId}" instead of the resolved target id "${state.workspaceId}"; refusing to poll a re-homed session`);
          }
          state.workspaceId = admission.workspaceId ?? state.workspaceId ?? null;
        }
        state.phase = 'admitted';
        state.admittedAt = new Date().toISOString();
        state.updatedAt = state.admittedAt;
        await writeJsonFile(stateFile, state);
        await log.event('admission', {
          admission: admission.admission ?? null,
          admitted: admission.admitted === true,
          sessionId: state.sessionId,
          workspaceId: state.workspaceId,
          workspacePath: state.workspacePath,
          workspaceSource: state.workspaceSource,
        });
        console.log(`ADMITTED ${JSON.stringify({
          sessionId: state.sessionId,
          requestId: state.requestId,
          workspaceId: state.workspaceId,
          workspacePath: state.workspacePath,
          workspaceSource: state.workspaceSource,
          stateFile,
        })}`);
      } else {
        // Already admitted (or re-entering a timeout / unverified-terminal
        // resume). Never re-admit; continue polling with the stored request id,
        // baseline and cursor. The state phase becomes "admitted" while this
        // process owns the poll, so a crash mid-resume stays resumable.
        context.baseline = baseline = Number.isInteger(state.baselineLatestSeq) ? state.baselineLatestSeq : -1;
        if (Number.isInteger(state.consumedInputSeq) && state.consumedInputSeq > baseline) {
          // kept for clarity: consumed proof belongs after the baseline
        }
        if (state.phase !== 'admitted') {
          state.phase = 'admitted';
          state.resumedAt = new Date().toISOString();
          state.updatedAt = state.resumedAt;
          await writeJsonFile(stateFile, state);
        }
        await log.event('resume_polling', {
          sessionId: state.sessionId,
          previousPhase,
          baseline,
          cursor: state.cursor,
          consumedInputSeq: Number.isInteger(state.consumedInputSeq) ? state.consumedInputSeq : null,
        });
      }

      const result = await pollToTerminal(client.client, context);
      const summary = boundedSummary(result, context);
      await log.event('result', summary);
      console.log(`RESULT ${JSON.stringify(summary)}`);
      return { exitCode: result.exitCode, summary };
    } finally {
      await client.close();
      await log.close();
    }
    } finally {
      await log.close();
    }
  } finally {
    await releaseLock();
  }
}

/**
 * Read-only compatibility check used by `-Check`. Never submits a task.
 *
 * @param {object} options
 * @returns {Promise<{ exitCode: number, summary: object }>}
 */
export async function runCheck(options) {
  const env = options.env ?? process.env;
  const client = await createClient({ url: options.url, tokenFile: options.tokenFile, env });
  try {
    const { tools, diagnostics } = await preflight(client.client);
    const summary = {
      ok: true,
      server: client.client.getServerVersion() ?? null,
      tools,
      bridge: diagnostics.bridge,
      model: diagnostics.model,
      workspace: diagnostics.workspace ?? null,
      workspaces: diagnostics.workspaces ?? null,
    };
    console.log(`CHECK ${JSON.stringify(summary)}`);
    return { exitCode: EXIT.completed, summary };
  } catch (error) {
    if (error instanceof DispatchError) {
      console.error(`CHECK_FAILED ${error.code} ${error.message}`);
    }
    throw error;
  } finally {
    await client.close();
  }
}

/**
 * Explicit cancel for a previously admitted dispatch.
 *
 * It is deliberately immediate and non-destructive:
 * - never takes or waits for the lifetime `<state>.lock` held by a live
 *   dispatcher (cancellation is the normal action while it is still polling);
 * - never rewrites the execution state, so it cannot overwrite a newer cursor or
 *   phase snapshot owned by the active writer;
 * - persists the Host acknowledgement as one atomic audit receipt next to the
 *   state (`<stateFile>.cancel.json`), merges nothing, deletes nothing.
 *
 * @param {object} options
 * @returns {Promise<{ exitCode: number, summary: object }>}
 */
export async function runCancel(options) {
  const env = options.env ?? process.env;
  const stateFile = options.stateFile ? resolve(options.stateFile) : null;
  if (stateFile === null) fail('usage', 'cancel requires --state-file (or the state path printed by a previous dispatch)');
  const state = await readStateFile(stateFile);
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) {
    fail('state_corrupt', 'dispatch state has no session to cancel');
  }
  const client = await createClient({ url: options.url, tokenFile: options.tokenFile, env });
  try {
    const response = await callTool(client.client, 'cancel_task', { sessionId: state.sessionId });
    const receipt = {
      version: 1,
      kind: 'cancel-receipt',
      createdAt: new Date().toISOString(),
      requestId: state.requestId,
      kindOfRequest: state.kind,
      sessionId: state.sessionId,
      workspacePath: state.workspacePath,
      stateFile,
      action: 'cancel',
      accepted: response.accepted === true,
      runningBefore: response.runningBefore ?? null,
      runningAfter: response.runningAfter ?? null,
      stopObserved: response.stopObserved ?? null,
      turnEndObserved: response.turnEndObserved ?? null,
      pendingInbox: response.pendingInbox ?? null,
      note: response.note ?? null,
    };
    const receiptPath = cancelReceiptPath(stateFile);
    await writeJsonFile(receiptPath, receipt);
    const summary = {
      ok: true,
      action: 'cancel',
      sessionId: state.sessionId,
      requestId: state.requestId,
      workspacePath: state.workspacePath,
      cancel: receipt,
      cancelReceiptPath: receiptPath,
      stateFile,
      stateWritten: false,
    };
    console.log(`RESULT ${JSON.stringify(summary)}`);
    return { exitCode: EXIT.completed, summary };
  } finally {
    await client.close();
  }
}

function parseIntegerOption(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    fail('usage', `${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

/**
 * @param {string[]} argv
 */
export function parseDispatchArgs(argv) {
  const options = {
    mode: 'dispatch',
    taskFile: undefined,
    workspace: undefined,
    logFile: undefined,
    sessionId: undefined,
    stateFile: undefined,
    resumeState: undefined,
    url: undefined,
    tokenFile: undefined,
    workspacesFile: undefined,
    waitMs: DEFAULT_WAIT_MS,
    pollMs: DEFAULT_POLL_MS,
    maxEvents: DEFAULT_MAX_EVENTS,
    maxChars: DEFAULT_MAX_CHARS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--task-file') options.taskFile = argv[++index];
    else if (arg === '--workspace') {
      const value = argv[++index];
      if (typeof value !== 'string' || value.trim() === '') fail('usage', '--workspace requires exactly one directory path');
      options.workspace = value;
    }
    else if (arg === '--log-file') options.logFile = argv[++index];
    else if (arg === '--session-id') options.sessionId = argv[++index];
    else if (arg === '--state-file') options.stateFile = argv[++index];
    else if (arg === '--resume-state') options.resumeState = argv[++index];
    else if (arg === '--url') options.url = argv[++index];
    else if (arg === '--token-file') options.tokenFile = argv[++index];
    else if (arg === '--workspaces-file') options.workspacesFile = argv[++index];
    else if (arg === '--wait-ms') options.waitMs = parseIntegerOption(argv[++index], '--wait-ms', 0, 86400000);
    else if (arg === '--poll-ms') options.pollMs = parseIntegerOption(argv[++index], '--poll-ms', 10, 60000);
    else if (arg === '--max-events') options.maxEvents = parseIntegerOption(argv[++index], '--max-events', 1, 200);
    else if (arg === '--max-chars') options.maxChars = parseIntegerOption(argv[++index], '--max-chars', 1, 60000);
    else if (arg === '--check') options.mode = 'check';
    else if (arg === '--cancel') options.mode = 'cancel';
    else if (arg === '-h' || arg === '--help') options.mode = 'help';
    else fail('usage', `Unknown argument: ${arg}`);
  }
  return options;
}

export function usage() {
  return `Usage: node src/dispatch.js [options]

Modes (default: dispatch):
  --check                       Read-only bridge/tool/model compatibility check; never submits.
  --cancel                      Cancel the active turn of the session in --state-file. Immediate:
                                it never waits for the dispatcher lifetime lock and never rewrites
                                the execution state; the acknowledgement is written atomically to
                                <state-file>.cancel.json (reported as cancelReceiptPath).

Dispatch:
  --task-file <path>            UTF-8 task file (BOM allowed). Required.
  --workspace <dir>             Optional explicit project opt-in: one exact existing project
                                directory. Omit it for a projectless task: the configured default
                                workspace is used and submit_task is sent without workspacePath.
                                With --session-id, an explicit directory must equal the existing
                                session workspace; omit it to derive that workspace instead.
  --log-file <path>             New log file (must not exist). Required.
  --session-id <id>             Continue this existing Desktop session instead of a new one.
  --state-file <path>           State file (default: <log-file>.state.json). Must not exist for a new request.
  --resume-state <path>         Explicitly reuse one prior state file with a new log file; the
                                request id, task hash, stored workspace and target session are
                                verified. Omit --workspace to keep the stored target; a different
                                explicit directory is refused rather than re-homing the request.
                                Timed-out (exit 5) and retained-inbox/pending (exit 3) states
                                re-enter polling with the same request id/baseline/cursor; no new
                                request is dispatched to keep waiting. A success state is
                                re-verified for consumed-input evidence before being reported, and
                                a genuine Host turn-end blocked state re-reports if unchanged.
                                For a continuation resume, repeat -SessionId with the stored id.
  --wait-ms <n>                 Finite wait before returning "running" (default 600000; 0 returns
                                after admission). Exit 5 is resumable with --resume-state.
  --poll-ms <n>                 Poll interval (default 2000).
  --max-events <n>              get_task maxEvents per page (1..200, default 40).
  --max-chars <n>               get_task maxChars per page (1..60000, default 12000).
  --url <url>                   Loopback MCP endpoint (default http://127.0.0.1:47821/mcp).
  --token-file <path>           External token file (default $DSH_HOME/desktop-mcp/token).
  --workspaces-file <path>      External non-secret workspace allowlist (default $DSH_HOME/desktop-mcp/workspaces.json).

Success requires durable completion newer than BOTH the pre-admission baseline
and the projected genuine user_message carrying this requestId; an unconsumed or
queued request is reported as timeout/pending, never completed. A finished turn
with success:false (max-tokens) after consumed input is a terminal non-success
(exit 2 failed), not a running timeout.

Exit codes:
  0 completed success; 2 task failed; 3 blocked/pending (resumable with
  --resume-state when it is a retained-inbox/question wait); 4 canceled;
  5 still running / wait timeout (resumable with --resume-state);
  6 dispatch/preflight/state/network error;
  130 interrupted by Ctrl-C (the Desktop task keeps running; use --cancel).
The token is read from its file and only sent as the Authorization header; it is never printed.`;
}

async function main() {
  let options;
  try {
    options = parseDispatchArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`DISPATCH_ERROR ${error.code ?? 'usage'} ${error.message}`);
    process.exitCode = EXIT.dispatchError;
    return;
  }
  if (options.mode === 'help') {
    console.log(usage());
    return;
  }
  const controller = new AbortController();
  const onInterrupt = () => {
    controller.abort();
  };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onInterrupt);
  try {
    let result;
    if (options.mode === 'check') {
      result = await runCheck(options);
    } else if (options.mode === 'cancel') {
      result = await runCancel(options);
    } else {
      if (typeof options.taskFile !== 'string' || options.taskFile.trim() === '') fail('usage', '--task-file is required');
      if (typeof options.logFile !== 'string' || options.logFile.trim() === '') fail('usage', '--log-file is required');
      if (options.resumeState !== undefined && options.stateFile !== undefined) fail('usage', 'Use --resume-state or --state-file, not both');
      result = await runDispatch({ ...options, signal: controller.signal });
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof DispatchError) {
      console.error(`DISPATCH_ERROR ${error.code} ${error.message}`);
      process.exitCode = error.exitCode;
    } else {
      console.error(`DISPATCH_ERROR unexpected ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = EXIT.dispatchError;
    }
  } finally {
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onInterrupt);
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
