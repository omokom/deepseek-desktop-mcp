import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDesktopAdapter } from '../src/adapter.js';
import { createFakeDesktop } from '../src/testing.js';

export async function makeHarness(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-b-'));
  const fake = createFakeDesktop(options);
  const stateFile = join(dir, 'admissions.json');
  const workspacesFile = options.workspacesFile ?? join(dir, 'workspaces.json');
  const adapter = createDesktopAdapter({
    sessionController: fake.ctx.sessionController,
    workspaceRegistry: fake.ctx.workspaceRegistry,
    sessionQuery: fake.ctx.sessionQuery,
    agents: fake.ctx.agents,
    agentDefaultModel: fake.ctx.agentDefaultModel,
    workspaceId: fake.workspaceId,
    stateFile,
    workspacesFile,
    getProfileContext: () => ({ name: 'desktop' }),
    env: { DSH_CLIENT_VERSION: '0.2.1-rc.2' },
  });
  return {
    dir,
    stateFile,
    workspacesFile,
    fake,
    adapter,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

export async function makeHarnessWithState(stateFile, options = {}) {
  const fake = createFakeDesktop(options);
  const adapter = createDesktopAdapter({
    sessionController: fake.ctx.sessionController,
    workspaceRegistry: fake.ctx.workspaceRegistry,
    sessionQuery: fake.ctx.sessionQuery,
    agents: fake.ctx.agents,
    agentDefaultModel: fake.ctx.agentDefaultModel,
    workspaceId: fake.workspaceId,
    stateFile,
    workspacesFile: options.workspacesFile,
    getProfileContext: () => ({ name: 'desktop' }),
    env: { DSH_CLIENT_VERSION: '0.2.1-rc.2' },
  });
  return { fake, adapter };
}
