import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDesktopAdapter } from '../src/adapter.js';
import { BRIDGE_PROTOCOL, BRIDGE_VERSION } from '../src/config.js';
import { startHttpServer } from '../src/mcp.js';
import { createFakeDesktop } from '../src/testing.js';
import {
  canonicalDirectoryPath,
  enrollWorkspace,
  readWorkspaceAllowlist,
  sameWorkspacePath,
  writeWorkspaceAllowlist,
} from '../src/workspaces.js';

const TEST_TOKEN = 'fake-workspace-test-token-not-a-real-secret-0123456789';
const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = resolve(HERE, '..');

async function tempDir(prefix = 'c-workspace-') {
  return mkdtemp(join(tmpdir(), prefix));
}

async function makeHarness() {
  const dir = await tempDir();
  const workspacesFile = join(dir, 'workspaces.json');
  const fake = createFakeDesktop();
  const adapter = createDesktopAdapter({
    sessionController: fake.ctx.sessionController,
    workspaceRegistry: fake.ctx.workspaceRegistry,
    sessionQuery: fake.ctx.sessionQuery,
    agents: fake.ctx.agents,
    agentDefaultModel: fake.ctx.agentDefaultModel,
    workspaceId: fake.workspaceId,
    stateFile: join(dir, 'admissions.json'),
    workspacesFile,
    getProfileContext: () => ({ name: 'desktop' }),
    env: { DSH_CLIENT_VERSION: '0.2.1-rc.2' },
  });
  return { dir, workspacesFile, fake, adapter, async cleanup() { await rm(dir, { recursive: true, force: true }); } };
}

test('workspace path: canonical existing absolute directory only', async () => {
  const dir = await tempDir();
  try {
    const workspace = join(dir, 'project');
    await mkdir(workspace);
    const file = join(dir, 'file.txt');
    await writeFile(file, 'x');
    assert.equal(await canonicalDirectoryPath(workspace), await canonicalDirectoryPath(workspace));
    await assert.rejects(canonicalDirectoryPath('relative/project'), { code: 'workspace_path_invalid' });
    await assert.rejects(canonicalDirectoryPath(join(dir, 'missing')), { code: 'workspace_path_not_found' });
    await assert.rejects(canonicalDirectoryPath(file), { code: 'workspace_path_not_directory' });
    await assert.rejects(canonicalDirectoryPath('C:\\'), { code: 'workspace_path_root' });
    await assert.rejects(canonicalDirectoryPath('C:\\Users\\*'), { code: 'workspace_path_invalid' });
    await assert.rejects(canonicalDirectoryPath(''), { code: 'workspace_path_invalid' });
    assert.equal(sameWorkspacePath('C:/Users/Example/Project/', 'c:\\users\\example\\project'), true);
    assert.equal(sameWorkspacePath('C:\\a', 'C:\\b'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace allowlist: missing is empty, corrupt fails closed, entries are validated', async () => {
  const dir = await tempDir();
  try {
    const workspacesFile = join(dir, 'workspaces.json');
    const missing = await readWorkspaceAllowlist({ file: workspacesFile });
    assert.deepEqual(missing.entries, []);

    await writeFile(workspacesFile, '{not json');
    await assert.rejects(readWorkspaceAllowlist({ file: workspacesFile }), { code: 'workspace_allowlist_corrupt' });
    await writeFile(workspacesFile, JSON.stringify({ version: 99, entries: [] }));
    await assert.rejects(readWorkspaceAllowlist({ file: workspacesFile }), { code: 'workspace_allowlist_corrupt' });
    await writeFile(workspacesFile, JSON.stringify({ version: 1, entries: [{ path: 'relative' }] }));
    await assert.rejects(readWorkspaceAllowlist({ file: workspacesFile }), { code: 'workspace_allowlist_corrupt' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace allowlist: enrollment is canonical, idempotent, preserving, and concurrent-safe', async () => {
  const dir = await tempDir();
  try {
    const workspacesFile = join(dir, 'workspaces.json');
    const first = join(dir, 'first');
    const second = join(dir, 'second');
    const third = join(dir, 'third');
    await mkdir(first);
    await mkdir(second);
    await mkdir(third);
    const added = await enrollWorkspace({ path: first, file: workspacesFile, source: 'test' });
    assert.equal(added.added, true);
    assert.equal(added.canonicalPath, await canonicalDirectoryPath(first));
    const again = await enrollWorkspace({ path: first, file: workspacesFile, source: 'test' });
    assert.equal(again.added, false);
    const results = await Promise.all([
      enrollWorkspace({ path: second, file: workspacesFile, source: 'test' }),
      enrollWorkspace({ path: third, file: workspacesFile, source: 'test' }),
      enrollWorkspace({ path: second, file: workspacesFile, source: 'test' }),
    ]);
    assert.equal(results.length, 3);
    const allowlist = await readWorkspaceAllowlist({ file: workspacesFile });
    assert.equal(allowlist.entries.length, 3);
    const paths = allowlist.entries.map((entry) => entry.path).sort();
    assert.deepEqual(paths, [await canonicalDirectoryPath(first), await canonicalDirectoryPath(second), await canonicalDirectoryPath(third)].sort());

    await writeWorkspaceAllowlist(allowlist.entries, { file: workspacesFile });
    assert.equal((await readWorkspaceAllowlist({ file: workspacesFile })).entries.length, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace allowlist: a symlinked path is authorized only through its canonical target', async (t) => {
  const dir = await tempDir();
  try {
    const target = join(dir, 'target');
    const other = join(dir, 'other');
    const link = join(dir, 'link');
    await mkdir(target);
    await mkdir(other);
    try {
      const { symlink } = await import('node:fs/promises');
      await symlink(target, link, 'junction');
    } catch {
      t.skip('directory junctions are not available in this environment');
      return;
    }
    const canonicalTarget = await canonicalDirectoryPath(target);
    assert.equal(await canonicalDirectoryPath(link), canonicalTarget);
    const workspacesFile = join(dir, 'workspaces.json');
    await enrollWorkspace({ path: target, file: workspacesFile, source: 'test' });
    const harness = await makeHarness();
    try {
      const { writeFile: write } = await import('node:fs/promises');
      await write(harness.workspacesFile, await (await import('node:fs/promises')).readFile(workspacesFile, 'utf8'));
      const viaLink = await harness.adapter.submitTask({ requestId: 'symlink-admit', task: 'via link', workspacePath: link });
      assert.equal(viaLink.ok, true, JSON.stringify(viaLink));
      assert.equal(sameWorkspacePath(viaLink.workspacePath, canonicalTarget), true);

      // A symlink whose target is not allowlisted must be refused, not followed
      // into a different workspace by spelling.
      const otherLink = join(dir, 'other-link');
      const { symlink } = await import('node:fs/promises');
      await symlink(other, otherLink, 'junction');
      const denied = await harness.adapter.submitTask({ requestId: 'symlink-denied', task: 'denied', workspacePath: otherLink });
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, 'workspace_not_enrolled');
    } finally {
      await harness.cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('submit_task(workspacePath): enrolled path creates a real workspace and resolves membership + stored cwd', async () => {
  const harness = await makeHarness();
  try {
    const project = await tempDir('c-project-');
    await enrollWorkspace({ path: project, file: harness.workspacesFile, source: 'test' });
    const canonical = await canonicalDirectoryPath(project);
    const submitted = await harness.adapter.submitTask({ requestId: 'c-workspace-submit', task: 'do the thing', workspacePath: project });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(sameWorkspacePath(submitted.workspacePath, canonical), true);
    const workspace = [...harness.fake.workspaces.values()].find((entry) => entry.id === submitted.workspaceId);
    assert.ok(workspace, 'real workspace record should exist');
    assert.equal(workspace.path, canonical);
    const session = harness.fake.sessions.get(submitted.sessionId);
    assert.equal(session.cwd, canonical);

    const view = await harness.adapter.getTask({ sessionId: submitted.sessionId });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.equal(view.workspaceId, submitted.workspaceId);
    assert.equal(sameWorkspacePath(view.workspacePath, canonical), true);

    const continued = await harness.adapter.continueTask({ sessionId: submitted.sessionId, requestId: 'c-workspace-continue', text: 'again' });
    assert.equal(continued.ok, true, JSON.stringify(continued));

    harness.fake.setStatus(submitted.sessionId, 'running');
    const canceled = await harness.adapter.cancelTask({ sessionId: submitted.sessionId });
    assert.equal(canceled.ok, true, JSON.stringify(canceled));
    assert.equal(canceled.workspaceId, submitted.workspaceId);

    const retry = await harness.adapter.submitTask({ requestId: 'c-workspace-submit', task: 'do the thing', workspacePath: project });
    assert.equal(retry.ok, true, JSON.stringify(retry));
    assert.equal(retry.admission, 'already_admitted');
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt' && call.requestId === 'c-workspace-submit').length, 1);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'createWorkspace').length, 1);
    await rm(project, { recursive: true, force: true });
  } finally {
    await harness.cleanup();
  }
});

test('submit_task(workspacePath): unenrolled, invalid, or different-workspace retries are refused', async () => {
  const harness = await makeHarness();
  try {
    const notEnrolled = await tempDir('c-not-enrolled-');
    const denied = await harness.adapter.submitTask({ requestId: 'c-denied', task: 'x', workspacePath: notEnrolled });
    assert.equal(denied.ok, false);
    assert.equal(denied.error.code, 'workspace_not_enrolled');
    assert.match(denied.error.message, /enroll exactly this existing directory from the trusted local launcher/i);

    const relative = await harness.adapter.submitTask({ requestId: 'c-relative', task: 'x', workspacePath: 'relative/dir' });
    assert.equal(relative.error.code, 'workspace_path_invalid');
    const missing = await harness.adapter.submitTask({ requestId: 'c-missing', task: 'x', workspacePath: join(notEnrolled, 'missing') });
    assert.equal(missing.error.code, 'workspace_path_not_found');

    assert.equal(harness.fake.calls.some((call) => call.operation === 'createWorkspace'), false);

    const project = await tempDir('c-project-change-');
    await enrollWorkspace({ path: project, file: harness.workspacesFile, source: 'test' });
    const other = await tempDir('c-project-other-');
    await enrollWorkspace({ path: other, file: harness.workspacesFile, source: 'test' });
    const first = await harness.adapter.submitTask({ requestId: 'c-workspace-reuse', task: 'x', workspacePath: project });
    assert.equal(first.ok, true, JSON.stringify(first));
    const different = await harness.adapter.submitTask({ requestId: 'c-workspace-reuse', task: 'x', workspacePath: other });
    assert.equal(different.ok, false);
    assert.equal(different.error.code, 'request_id_conflict');
    await rm(project, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
    await rm(notEnrolled, { recursive: true, force: true });
  } finally {
    await harness.cleanup();
  }
});

test('existing session: stored header cwd must agree with the workspace path', async () => {
  const harness = await makeHarness();
  try {
    const project = await tempDir('c-cwd-project-');
    await enrollWorkspace({ path: project, file: harness.workspacesFile, source: 'test' });
    const canonical = await canonicalDirectoryPath(project);
    const submitted = await harness.adapter.submitTask({ requestId: 'c-cwd-submit', task: 'x', workspacePath: project });
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    const sessionId = submitted.sessionId;

    harness.fake.sessions.get(sessionId).cwd = join(project, 'elsewhere');
    const get = await harness.adapter.getTask({ sessionId });
    assert.equal(get.ok, false);
    assert.equal(get.error.code, 'session_cwd_mismatch');
    const cont = await harness.adapter.continueTask({ sessionId, requestId: 'c-cwd-continue', text: 'x' });
    assert.equal(cont.error.code, 'session_cwd_mismatch');
    harness.fake.setStatus(sessionId, 'running');
    const cancel = await harness.adapter.cancelTask({ sessionId });
    assert.equal(cancel.error.code, 'session_cwd_mismatch');

    harness.fake.sessions.get(sessionId).cwd = null;
    const unverified = await harness.adapter.getTask({ sessionId });
    assert.equal(unverified.error.code, 'session_cwd_unverified');

    harness.fake.sessions.get(sessionId).cwd = canonical;
    const recovered = await harness.adapter.getTask({ sessionId });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    await rm(project, { recursive: true, force: true });
  } finally {
    await harness.cleanup();
  }
});

test('existing session: a workspace that is not configured or enrolled is not authorized', async () => {
  const harness = await makeHarness();
  try {
    const project = await tempDir('c-unenrolled-ws-');
    const workspace = harness.fake.addWorkspace({ path: await canonicalDirectoryPath(project) });
    const session = harness.fake.addSession({ sessionId: 'c-unenrolled-session', workspaceId: workspace.id });
    harness.fake.setStatus(session.id, 'running');
    for (const result of [
      await harness.adapter.getTask({ sessionId: session.id }),
      await harness.adapter.continueTask({ sessionId: session.id, requestId: 'c-unenrolled-continue', text: 'x' }),
      await harness.adapter.cancelTask({ sessionId: session.id }),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'session_not_authorized');
    }
    assert.equal(harness.fake.calls.some((call) => call.operation === 'cancel'), false);
    await rm(project, { recursive: true, force: true });
  } finally {
    await harness.cleanup();
  }
});

test('existing session: an unreadable allowlist is surfaced, not masked as authorization failure (F5)', async () => {
  const harness = await makeHarness();
  try {
    // Configured-workspace members still resolve from configured membership.
    const configuredView = await harness.adapter.getTask({ sessionId: 'fake-session-a' });
    await writeFile(harness.workspacesFile, '{corrupt allowlist', 'utf8');
    const stillAuthorized = await harness.adapter.getTask({ sessionId: 'fake-session-a' });
    assert.equal(stillAuthorized.ok, true, JSON.stringify(stillAuthorized));

    // A session outside the configured workspace cannot be matched, so the
    // captured allowlist error must be surfaced instead of session_not_authorized.
    const unmatched = await harness.adapter.getTask({ sessionId: 'fake-session-other-workspace' });
    assert.equal(unmatched.ok, false);
    assert.equal(unmatched.error.code, 'workspace_allowlist_corrupt');
    assert.match(unmatched.error.message, /allowlist/i);
    const continued = await harness.adapter.continueTask({
      sessionId: 'fake-session-other-workspace',
      requestId: 'c-corrupt-allowlist-continue',
      text: 'x',
    });
    assert.equal(continued.error.code, 'workspace_allowlist_corrupt');
    assert.equal(configuredView.ok, true);
  } finally {
    await harness.cleanup();
  }
});

test('diagnostics: bridge marker, workspacePath capability, and allowlist path', async () => {
  const harness = await makeHarness();
  try {
    const value = harness.adapter.diagnostics();
    assert.equal(value.ok, true);
    assert.equal(value.bridge.name, 'deepseek-desktop-mcp');
    assert.equal(value.bridge.version, BRIDGE_VERSION);
    assert.equal(value.bridge.protocol, BRIDGE_PROTOCOL);
    assert.equal(value.bridge.workspacePath, true);
    assert.equal(value.capabilities.workspacePath, 'implemented');
    assert.equal(value.workspaces.allowlistFile, harness.workspacesFile);
  } finally {
    await harness.cleanup();
  }
});

test('MCP schema advertises optional workspacePath on submit_task and keeps the five tools', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
  });
  const client = new Client({ name: 'c-schema-test', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'deepseek-desktop-mcp');
    assert.equal(client.getServerVersion()?.version, BRIDGE_VERSION);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      'cancel_task', 'continue_task', 'diagnostics', 'get_task', 'list_sessions', 'submit_task',
    ]);
    const submit = tools.tools.find((tool) => tool.name === 'submit_task');
    assert.deepEqual(submit.inputSchema.required, ['requestId', 'task']);
    assert.ok(submit.inputSchema.properties.workspacePath);
    assert.equal(submit.inputSchema.properties.workspacePath.type, 'string');
    const diagnostics = JSON.parse((await client.callTool({ name: 'diagnostics', arguments: {} })).content[0].text);
    assert.equal(diagnostics.bridge.protocol, BRIDGE_PROTOCOL);
    assert.equal(diagnostics.bridge.workspacePath, true);
    assert.equal(JSON.stringify(diagnostics).includes(TEST_TOKEN), false);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await listener.close();
    await harness.cleanup();
  }
});

test('staged migration inputs exist (skill, templates, declared product files)', async () => {
  for (const relative of [
    'integration/skill/deepseek-executor/SKILL.md',
    'integration/skill/deepseek-executor/scripts/invoke-desktop.ps1',
    'integration/skill/deepseek-executor/scripts/header-helper.ps1',
    'integration/skill/deepseek-executor/scripts/invoke-harness-recovery.ps1',
    'integration/skill/deepseek-executor/agents/openai.yaml',
    'integration/codex/mcp-registration.toml.template',
    'integration/codex/invoke-harness-shim.ps1',
    'scripts/migrate-codex.mjs',
  ]) {
    const { stat } = await import('node:fs/promises');
    const info = await stat(join(STAGE, relative));
    assert.equal(info.isFile(), true, relative);
  }
});
