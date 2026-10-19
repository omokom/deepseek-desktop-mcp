import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const REQUIRED_WORKSPACE_ID = '3261eb3a-9083-4ce6-b18f-89cb7e6d1746';
export const REQUIRED_PROVIDER = 'deepseek-official';
export const REQUIRED_MODEL = 'deepseek-flash';
export const REQUIRED_REASONING = 'max';
export const DEFAULT_PORT = 47821;
export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 50;
export const MAX_TITLE_CHARS = 200;
export const MAX_WORKSPACE_PATH_CHARS = 1024;
export const MIN_TOKEN_CHARS = 32;

/**
 * First-version hot-replacement marker: a promoted/hot-loaded bridge reports the
 * same protocol string through `diagnostics`, so a local client can refuse stale
 * code instead of silently falling back to the single configured workspace.
 * This is a marker only; there is no update framework.
 */
export const BRIDGE_NAME = 'deepseek-desktop-mcp';
export const BRIDGE_PROTOCOL = 'deepseek-desktop-mcp/bridge/2';
export const BRIDGE_VERSION = '0.2.0-c.1';

/**
 * Resolve the DSH home directory. The bridge never reads credentials from here.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveDshHome(env = process.env) {
  return typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? resolve(env.DSH_HOME)
    : join(homedir(), '.dsh');
}

/**
 * Dedicated non-secret bridge state directory (token, admissions, workspace
 * allowlist). Outside Git and distinct from the profile.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveStateDir(env = process.env) {
  return join(resolveDshHome(env), 'desktop-mcp');
}

/**
 * Resolve the external token file. Config may name a path resolved against the
 * current working directory; otherwise the dedicated file lives under
 * $DSH_HOME/desktop-mcp/token (or ~/.dsh/desktop-mcp/token). This never reads
 * .credentials.yaml.
 *
 * @param {{ tokenFile?: unknown }} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveTokenFile(config = {}, env = process.env) {
  if (config.tokenFile !== undefined) {
    if (typeof config.tokenFile !== 'string' || config.tokenFile.trim() === '') {
      throw new Error('tokenFile must be a non-empty path');
    }
    return resolve(config.tokenFile);
  }
  return join(resolveStateDir(env), 'token');
}

/**
 * Resolve the workspace allowlist file. It is non-secret and deliberately
 * separate from the token so the admission state and directory authority can be
 * inspected without exposing credentials.
 *
 * @param {{ workspacesFile?: unknown }} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
export function resolveWorkspacesFile(config = {}, env = process.env) {
  if (config.workspacesFile !== undefined) {
    if (typeof config.workspacesFile !== 'string' || config.workspacesFile.trim() === '') {
      throw new Error('workspacesFile must be a non-empty path');
    }
    return resolve(config.workspacesFile);
  }
  return join(resolveStateDir(env), 'workspaces.json');
}

/**
 * Read the dedicated MCP token. Missing, empty, short, or non-UTF8 tokens fail
 * closed with an error that does not include the token value.
 *
 * @param {{ tokenFile?: unknown }} config
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ token: string, tokenFile: string }>}
 */
export async function readToken(config = {}, env = process.env) {
  const tokenFile = resolveTokenFile(config, env);
  let raw;
  try {
    raw = await readFile(tokenFile, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'read-error';
    throw new Error(`MCP token file is unavailable (${code}); create a dedicated token at the configured external path`);
  }
  const token = raw.replace(/^\uFEFF/, '').trim();
  if (token.length === 0) throw new Error('MCP token file is empty');
  if (token.length < MIN_TOKEN_CHARS) throw new Error(`MCP token must contain at least ${MIN_TOKEN_CHARS} characters`);
  return { token, tokenFile };
}

/**
 * Validate the plugin row config without importing host config libraries.
 *
 * @param {unknown} raw
 * @returns {{ workspaceId: string, port: number, host: '127.0.0.1', tokenFile?: string, workspacesFile?: string }}
 */
export function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const workspaceId = config.workspaceId ?? REQUIRED_WORKSPACE_ID;
  if (typeof workspaceId !== 'string' || workspaceId.trim() === '') throw new Error('workspaceId must be a non-empty string');
  const port = config.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be an integer from 1 to 65535');
  if (config.host !== undefined && config.host !== '127.0.0.1') throw new Error('host is fixed to 127.0.0.1; broad binds are refused');
  if (config.tokenFile !== undefined && (typeof config.tokenFile !== 'string' || config.tokenFile.trim() === '')) {
    throw new Error('tokenFile must be a non-empty path when provided');
  }
  if (config.workspacesFile !== undefined && (typeof config.workspacesFile !== 'string' || config.workspacesFile.trim() === '')) {
    throw new Error('workspacesFile must be a non-empty path when provided');
  }
  return {
    workspaceId,
    port,
    host: '127.0.0.1',
    ...(config.tokenFile === undefined ? {} : { tokenFile: config.tokenFile }),
    ...(config.workspacesFile === undefined ? {} : { workspacesFile: config.workspacesFile }),
  };
}

/**
 * Return configured non-secret model facts and the required-route comparison.
 * No credential value is read or requested.
 *
 * @param {{ currentSelection?: () => unknown } | undefined} agentDefaultModel
 */
export function modelDiagnostics(agentDefaultModel) {
  let configured = null;
  let error = null;
  try {
    const value = agentDefaultModel?.currentSelection?.();
    if (value && typeof value === 'object') {
      configured = {
        provider: typeof value.provider === 'string' ? value.provider : null,
        model: typeof value.model === 'string' ? value.model : null,
        reasoningEffort: typeof value.reasoningEffort === 'string' ? value.reasoningEffort : null,
      };
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }
  const required = {
    provider: REQUIRED_PROVIDER,
    model: REQUIRED_MODEL,
    reasoningEffort: REQUIRED_REASONING,
  };
  return {
    configured,
    required,
    matchesRequired: configured !== null
      && configured.provider === required.provider
      && configured.model === required.model
      && configured.reasoningEffort === required.reasoningEffort,
    ...(error === null ? {} : { error }),
    credentialsRead: false,
  };
}
