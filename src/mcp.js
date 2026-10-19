import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { bearerFromHeader, tokenMatches } from './auth.js';
import { BRIDGE_NAME, BRIDGE_VERSION, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, MAX_WORKSPACE_PATH_CHARS } from './config.js';
import { MAX_CONTINUE_CHARS, MAX_REQUEST_ID_CHARS, MAX_TASK_CHARS } from './adapter.js';
import {
  DEFAULT_GET_MAX_CHARS,
  DEFAULT_GET_MAX_EVENTS,
  MAX_GET_MAX_CHARS,
  MAX_GET_MAX_EVENTS,
} from './task-view.js';

const MCP_PATH = '/mcp';
const DIAGNOSTICS_PATH = '/diagnostics';
const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res, status, value, extraHeaders = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        const error = new Error('request body exceeds the 1 MiB limit');
        error.code = 'body_too_large';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        const error = new Error('request body is empty');
        error.code = 'empty_body';
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        const error = new Error('request body is not valid JSON');
        error.code = 'invalid_json';
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function hostIsLoopback(req, port) {
  const host = req.headers.host;
  if (typeof host !== 'string' || host.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const effectivePort = parsed.port === '' ? 80 : Number(parsed.port);
  return (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && effectivePort === port;
}

function remoteIsLoopback(req) {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function originIsApproved(req, port) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function toolError(error, fallbackCode, operation) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : 'Operation failed';
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message, operation } }) }],
    isError: true,
  };
}

function toolResult(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    ...(result?.ok === false ? { isError: true } : {}),
  };
}

function unauthorized(res) {
  sendJson(res, 401, { ok: false, error: { code: 'unauthorized', message: 'A valid bearer token is required.' } }, {
    'www-authenticate': 'Bearer realm="deepseek-desktop-mcp"',
  });
}

/**
 * Build one MCP server for one HTTP request. Stateless Streamable HTTP keeps
 * request state isolated; tool handlers share only the Host adapter.
 *
 * @param {ReturnType<import('./adapter.js').createDesktopAdapter>} adapter
 */
export function createMcpServer(adapter) {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool('list_sessions', {
    title: 'List Desktop sessions in the configured workspace',
    description: 'Read-only. Lists bounded session metadata for the one configured workspace. It does not read session event bodies or mutate sessions.',
    inputSchema: {
      limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional()
        .describe(`Maximum rows to return (default ${DEFAULT_LIST_LIMIT}, max ${MAX_LIST_LIMIT}).`),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ limit }, extra) => {
    try {
      return toolResult(await adapter.listSessions(limit ?? DEFAULT_LIST_LIMIT, extra?.signal));
    } catch (error) {
      return toolError(error, 'session_list_failed', 'sessionController.list');
    }
  });

  server.registerTool('submit_task', {
    title: 'Submit a task into a fresh Desktop session in an enrolled workspace',
    description: 'Creates one fresh standard-mode session (explicit agentPreset: standard; never the default agent) in the configured default workspace, or in the exact enrolled workspace named by workspacePath, and admits the task text with an explicit requestId. A workspacePath must be an existing canonical directory already present in the local non-secret workspace allowlist; an unknown path is refused with registration guidance and never silently falls back to the default workspace. An extra workspace record is created only at this explicit submit through workspaceRegistry.create. Returns the actual Desktop sessionId and admission state promptly; admission is not completion. Duplicate requestIds are idempotent for identical input and rejected for different input.',
    inputSchema: {
      requestId: z.string().min(1).max(MAX_REQUEST_ID_CHARS)
        .describe('Explicit idempotency key. Reuse only for the same task text and workspace.'),
      task: z.string().min(1).max(MAX_TASK_CHARS)
        .describe('Non-empty task instructions. The session cwd is the selected enrolled workspace, never an arbitrary supplied path.'),
      workspacePath: z.string().min(1).max(MAX_WORKSPACE_PATH_CHARS).optional()
        .describe('Optional exact existing directory path that is already in the local workspace allowlist. Omitted uses the configured default workspace. The session cwd and its stored session-header cwd are verified against this path.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ requestId, task, workspacePath }) => {
    try {
      return toolResult(await adapter.submitTask({ requestId, task, workspacePath }));
    } catch (error) {
      return toolError(error, 'submit_failed', 'admission');
    }
  });

  server.registerTool('get_task', {
    title: 'Read bounded task output and status from an authorized Desktop session',
    description: 'Read-only. Returns bounded visible assistant/tool/turn output with a resumable {seq,offset} cursor, current running/idle/pending/error state, durable completion evidence, retained inbox, and model route facts. The session must belong to the configured default workspace or an enrolled workspace, and its own stored session-header cwd must agree with that workspace path. The returned workspaceId/workspacePath are the actual resolved workspace. Does not return reasoning, raw request headers, or unrelated sessions. Idle alone is never success.',
    inputSchema: {
      sessionId: z.string().min(1).describe('Session id returned by submit_task or an authorized workspace session.'),
      cursor: z.object({
        seq: z.number().int().min(-1).describe('Last fully consumed event seq; -1 starts at the beginning.'),
        offset: z.number().int().min(0).describe('Code-point offset inside a partially returned event text.'),
      }).optional(),
      maxEvents: z.number().int().min(1).max(MAX_GET_MAX_EVENTS).optional()
        .describe(`Maximum visible items to return (default ${DEFAULT_GET_MAX_EVENTS}, max ${MAX_GET_MAX_EVENTS}).`),
      maxChars: z.number().int().min(1).max(MAX_GET_MAX_CHARS).optional()
        .describe(`Maximum visible text characters to return (default ${DEFAULT_GET_MAX_CHARS}, max ${MAX_GET_MAX_CHARS}).`),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ sessionId, cursor, maxEvents, maxChars }) => {
    try {
      return toolResult(await adapter.getTask({ sessionId, cursor, maxEvents, maxChars }));
    } catch (error) {
      return toolError(error, 'get_task_failed', 'get_task');
    }
  });

  server.registerTool('continue_task', {
    title: 'Continue or steer an authorized Desktop session',
    description: 'Adds text to the same authorized standard-mode session with an explicit requestId; other or unknown presets are rejected. The session workspace is derived from actual membership plus its stored session-header cwd; there is no supplied-cwd bypass. Uses official steer when the session is running (unless followup is explicitly requested) and followup otherwise. Rejects a configured/session model route that is unknown or not the required route. Duplicate requestIds are idempotent for identical input and rejected for different input.',
    inputSchema: {
      sessionId: z.string().min(1).describe('Authorized session id.'),
      requestId: z.string().min(1).max(MAX_REQUEST_ID_CHARS)
        .describe('Explicit idempotency key for this continuation.'),
      text: z.string().min(1).max(MAX_CONTINUE_CHARS).describe('Non-empty correction or follow-up text.'),
      mode: z.enum(['steer', 'followup']).optional()
        .describe('Steer requires a running session. Omitted chooses steer while running, followup otherwise.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async ({ sessionId, requestId, text, mode }) => {
    try {
      return toolResult(await adapter.continueTask({ sessionId, requestId, text, mode }));
    } catch (error) {
      return toolError(error, 'continue_failed', 'admission');
    }
  });

  server.registerTool('cancel_task', {
    title: 'Cancel the active turn of an authorized Desktop session',
    description: 'Calls the official session controller cancel for one authorized session after verifying actual membership and its stored session-header cwd. Reports the request separately from observed stopping and retained pending inbox. Does not dispose the session, clear the inbox, or claim the whole session is stopped.',
    inputSchema: {
      sessionId: z.string().min(1).describe('Authorized session id.'),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  }, async ({ sessionId }) => {
    try {
      return toolResult(await adapter.cancelTask({ sessionId }));
    } catch (error) {
      return toolError(error, 'cancel_failed', 'cancel_task');
    }
  });

  server.registerTool('diagnostics', {
    title: 'Authenticated compatibility diagnostics',
    description: 'Read-only. Reports bridge name/version/protocol and workspacePath capability, host pid/version, configured model identifiers, configured default workspace, controller/sessionQuery presence, and tool limits. A client must verify bridge.protocol plus bridge.workspacePath before submitting a non-default workspace; missing marker means stale bridge code. Does not read credentials or session bodies.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }, async () => {
    try {
      return { content: [{ type: 'text', text: JSON.stringify(adapter.diagnostics()) }] };
    } catch (error) {
      return toolError(error, 'diagnostics_failed', 'diagnostics');
    }
  });

  return server;
}

/**
 * Start the loopback-only authenticated HTTP listener.
 *
 * @param {{
 *   adapter: ReturnType<import('./adapter.js').createDesktopAdapter>,
 *   token: string,
 *   port: number,
 *   logger?: { info?: Function, error?: Function },
 * }} input
 * @returns {Promise<{ server: import('node:http').Server, port: number, address: string, close: () => Promise<void> }>}
 */
export async function startHttpServer({ adapter, token, port, logger }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('MCP token is missing or too short');
  let boundPort = port;

  const server = createServer((req, res) => {
    (async () => {
      if (!remoteIsLoopback(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'Loopback clients only.' } });
        return;
      }
      if (!hostIsLoopback(req, boundPort)) {
        sendJson(res, 421, { ok: false, error: { code: 'misdirected_request', message: 'Host header is not the loopback listener.' } });
        return;
      }
      if (!originIsApproved(req, boundPort)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden_origin', message: 'Origin is not an approved loopback origin.' } });
        return;
      }

      const path = new URL(req.url ?? '/', `http://127.0.0.1:${String(boundPort)}`).pathname;
      if (path !== MCP_PATH && path !== DIAGNOSTICS_PATH) {
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Not found.' } });
        return;
      }

      const presented = bearerFromHeader(req.headers.authorization);
      if (!tokenMatches(presented, token)) {
        unauthorized(res);
        return;
      }

      if (path === DIAGNOSTICS_PATH) {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use GET.' } }, { allow: 'GET' });
          return;
        }
        try {
          sendJson(res, 200, adapter.diagnostics());
        } catch (error) {
          const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'diagnostics_failed';
          const message = error instanceof Error ? error.message : 'Diagnostics failed';
          sendJson(res, 500, { ok: false, error: { code, message, operation: 'diagnostics' } });
        }
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'This stateless endpoint does not open server-initiated streams.' } }, { allow: 'POST, DELETE' });
        return;
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { ok: true, closed: false, note: 'Stateless endpoint: no server-side MCP session to delete.' });
        return;
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Use POST.' } }, { allow: 'POST, DELETE' });
        return;
      }

      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        const status = error && error.code === 'body_too_large' ? 413 : 400;
        sendJson(res, status, { ok: false, error: { code: error?.code ?? 'bad_request', message: error instanceof Error ? error.message : 'Bad request' } });
        return;
      }

      const mcp = createMcpServer(adapter);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      let closed = false;
      const closeTransport = async () => {
        if (closed) return;
        closed = true;
        await Promise.allSettled([transport.close(), mcp.close()]);
      };
      res.once('close', () => {
        closeTransport().catch((error) => logger?.error?.('deepseek-desktop-mcp transport cleanup failed', error));
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        logger?.error?.('deepseek-desktop-mcp request failed', error);
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'MCP request failed.' } });
        } else {
          res.destroy();
        }
        await closeTransport();
      }
    })().catch((error) => {
      logger?.error?.('deepseek-desktop-mcp request handler failed', error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal', message: 'Request failed.' } });
      else res.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('HTTP listener did not report a TCP address'));
        return;
      }
      boundPort = address.port;
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('HTTP listener did not bind a TCP address');
  server.on('error', (error) => {
    logger?.error?.('deepseek-desktop-mcp listener error', error);
  });

  let closePromise;
  const close = () => {
    closePromise ??= new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
    return closePromise;
  };

  return {
    server,
    port: address.port,
    address: address.address,
    close,
  };
}
