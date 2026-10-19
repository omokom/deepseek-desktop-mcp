import { dirname, join } from 'node:path';
import { createDesktopAdapter } from './adapter.js';
import { readToken, resolveConfig, resolveWorkspacesFile } from './config.js';
import { startHttpServer } from './mcp.js';
import { enrollWorkspace, readWorkspaceAllowlist, sameWorkspacePath } from './workspaces.js';

export const name = 'deepseek-desktop-mcp';
export const inject = ['sessionController', 'workspaceRegistry', 'agentDefaultModel', 'sessionQuery', 'agents'];

/**
 * Plain namespace Cordis plugin. It consumes the Host's existing services and
 * never imports a Host class singleton. Startup is fail-closed: a missing
 * workspace or token prevents the listener from binding. The only allowlist
 * seeding at startup is the already-configured default Workspace path; extra
 * directories are enrolled only by an explicit submit or the trusted launcher.
 *
 * @param {any} ctx
 * @param {unknown} rawConfig
 */
export async function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const { token, tokenFile } = await readToken(config, process.env);
  const stateFile = join(dirname(tokenFile), 'admissions.json');
  const workspacesFile = resolveWorkspacesFile(config, process.env);

  const workspace = ctx.workspaceRegistry.get(config.workspaceId);
  if (workspace === undefined || workspace === null) {
    const error = new Error(`configured workspace "${config.workspaceId}" was not found; refusing to start`);
    error.code = 'workspace_not_found';
    throw error;
  }

  // Seed only the configured default workspace into the non-secret allowlist so
  // the trusted launcher can pass its canonical path as workspacePath. This
  // creates no extra workspace; a corrupt/unavailable allowlist is reported and
  // leaves explicit workspacePath submissions failing closed.
  let allowlistWarning = null;
  try {
    const allowlist = await readWorkspaceAllowlist({ file: workspacesFile, env: process.env });
    const present = allowlist.entries.some((entry) => sameWorkspacePath(entry.path, workspace.path) || entry.path === workspace.path);
    if (!present) {
      await enrollWorkspace({
        path: workspace.path,
        title: workspace.title,
        source: 'configured-default',
        file: workspacesFile,
        env: process.env,
      });
    }
  } catch (error) {
    allowlistWarning = error instanceof Error ? error.message : String(error);
    ctx.logger?.warn?.(`deepseek-desktop-mcp: workspace allowlist is unavailable (${allowlistWarning}); explicit workspacePath submissions will fail closed`);
  }

  const adapter = createDesktopAdapter({
    sessionController: ctx.sessionController,
    workspaceRegistry: ctx.workspaceRegistry,
    sessionQuery: ctx.sessionQuery,
    agents: ctx.agents,
    agentDefaultModel: ctx.agentDefaultModel,
    workspaceId: config.workspaceId,
    stateFile,
    workspacesFile,
    getProfileContext: typeof ctx.get === 'function' ? () => ctx.get('profileContext') : undefined,
    env: process.env,
  });

  ctx.effect(() => {
    const detach = typeof ctx.on === 'function'
      ? ctx.on('api-session/error', (sessionId, message) => adapter.recordSessionError(sessionId, message), { global: true })
      : undefined;
    return () => {
      try {
        if (typeof detach === 'function') detach();
        else if (Array.isArray(detach)) for (const dispose of detach) dispose();
      } catch {
        // Listener cleanup must not block plugin unload.
      }
    };
  }, 'deepseek-desktop-mcp: authorized transient error capture');

  let listenerPromise;
  ctx.effect(() => {
    listenerPromise = startHttpServer({
      adapter,
      token,
      port: config.port,
      logger: ctx.logger,
    });
    return async () => {
      const listener = await listenerPromise.catch(() => undefined);
      if (listener !== undefined) await listener.close();
      ctx.logger?.info?.('deepseek-desktop-mcp listener closed; user sessions were not touched');
    };
  }, 'deepseek-desktop-mcp: loopback authenticated MCP listener');

  const listener = await listenerPromise;
  try {
    ctx.fiber?.assertActive?.();
  } catch (error) {
    await listener.close();
    throw error;
  }
  ctx.logger?.info?.(`deepseek-desktop-mcp listening on http://127.0.0.1:${String(listener.port)}/mcp (workspace ${config.workspaceId}; allowlist ${workspacesFile}${allowlistWarning === null ? '' : ' unavailable'})`);
}
