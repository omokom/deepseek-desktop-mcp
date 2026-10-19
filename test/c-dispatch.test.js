import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { createDesktopAdapter } from '../src/adapter.js';
import { BRIDGE_PROTOCOL, BRIDGE_VERSION } from '../src/config.js';
import {
  DispatchError,
  EXIT,
  assertBridgeCompatible,
  parseDispatchArgs,
  readTaskFile,
  runCancel,
  runCheck,
  runDispatch,
  writeJsonFile,
} from '../src/dispatch.js';
import { startHttpServer } from '../src/mcp.js';
import { createFakeDesktop } from '../src/testing.js';
import { canonicalDirectoryPath, readWorkspaceAllowlist, sameWorkspacePath } from '../src/workspaces.js';

const TOKEN = 'fake-dispatch-test-token-not-a-real-secret-0123456789';

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function completedEvents({ priorTurn = 1 } = {}) {
  const events = [];
  let seq = 0;
  for (let turn = 1; turn <= priorTurn; turn += 1) {
    events.push({ type: 'turn/start', data: { turn }, seq: seq++, time: 1 });
    events.push({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: `prior-${turn}` }] } }, seq: seq++, time: 1 });
    events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } }, seq: seq++, time: 1 });
  }
  return events;
}

function completeOnPrompt(text = 'DONE-C-MARKER') {
  return async ({ session, raw }) => {
    session.status = 'running';
    raw.append('turn/start', { turn: 2 });
    raw.append('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text }] } });
    raw.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    session.status = 'idle';
  };
}

async function makeEnv(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'c-dispatch-env-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  const workspacesFile = join(dir, 'workspaces.json');
  const taskFile = join(dir, 'task.md');
  // A routing fixture may need a real existing directory as the configured
  // default workspace, because the launcher canonicalizes the diagnostic path.
  const realDefaultWorkspace = options.realDefaultWorkspace === true
    ? join(dir, 'default-workspace')
    : undefined;
  if (realDefaultWorkspace !== undefined) await mkdir(realDefaultWorkspace);
  const fake = createFakeDesktop({
    onPrompt: options.onPrompt,
    onCancel: options.onCancel,
    ...(realDefaultWorkspace === undefined ? {} : { workspacePath: realDefaultWorkspace }),
  });
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
  const listener = await startHttpServer({ adapter, token: TOKEN, port: 0 });
  const project = join(dir, 'project');
  await mkdir(project);
  const env = {
    dir,
    tokenFile,
    workspacesFile,
    taskFile,
    project,
    defaultWorkspacePath: realDefaultWorkspace ?? null,
    fake,
    adapter,
    listener,
    url: `http://127.0.0.1:${listener.port}/mcp`,
    logFile: join(dir, 'run.log'),
    async cleanup() {
      await listener.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  env.options = (overrides = {}) => ({
    taskFile: env.taskFile,
    workspace: env.project,
    logFile: env.logFile,
    url: env.url,
    tokenFile: env.tokenFile,
    workspacesFile: env.workspacesFile,
    waitMs: 1500,
    pollMs: 20,
    maxEvents: 40,
    maxChars: 5000,
    env: { DSH_HOME: join(env.dir, '.dsh') },
    ...overrides,
  });
  return env;
}

async function run(env, overrides = {}) {
  try {
    return await runDispatch(env.options(overrides));
  } catch (error) {
    return { thrown: error };
  }
}

function readLogLines(logFile) {
  return readFile(logFile, 'utf8').then((text) => text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)));
}

test('dispatch: UTF-8 task files with and without BOM admit the exact task text', async () => {
  let captured = null;
  const env = await makeEnv({ onPrompt: async ({ request, session, raw }) => {
    captured = request.content[0].text;
    session.status = 'running';
    raw.append('turn/start', { turn: 1 });
    raw.append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '中文-DONE' }] } });
    raw.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    session.status = 'idle';
  } });
  try {
    const taskText = '请写一个中文文件，标记 C-中文-OK。\r\n第二行内容。';
    await writeFile(env.taskFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(taskText, 'utf8')]));
    const first = await run(env);
    assert.equal(first.exitCode, EXIT.completed, JSON.stringify(first.summary ?? first.thrown));
    assert.equal(captured, taskText);

    const state = JSON.parse((await readFile(`${env.logFile}.state.json`, 'utf8')).replace(/^\uFEFF/u, ''));
    assert.equal(state.taskSha256, sha256(taskText));
    assert.equal(state.phase, 'terminal');

    const logText = await readFile(env.logFile, 'utf8');
    assert.notEqual(logText.charCodeAt(0), 0xfeff);
    assert.match(logText, /中文-DONE/u);
    assert.equal(logText.includes('\uFFFD'), false);
    const lines = await readLogLines(env.logFile);
    assert.equal(lines[0].event, 'start');
    assert.equal(lines.some((line) => line.event === 'admission'), true);
    assert.equal(lines.some((line) => line.event === 'terminal'), true);

    // Same task, no BOM, new invocation/log: still exact text and success.
    await writeFile(env.taskFile, taskText, 'utf8');
    const secondLog = join(env.dir, 'run-2.log');
    const second = await run(env, { logFile: secondLog, maxChars: 5000 });
    assert.equal(second.exitCode, EXIT.completed);
    assert.equal(captured, taskText);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: state is persisted before admission with request id and baseline', async () => {
  const env = await makeEnv({ onPrompt: completeOnPrompt() });
  let observed = null;
  try {
    await writeFile(env.taskFile, 'state-before-network task');
    const originalOnPrompt = env.fake.ctx.sessionController.prompt;
    env.fake.ctx.sessionController.prompt = async (...args) => {
      observed = JSON.parse((await readFile(`${env.logFile}.state.json`, 'utf8')).replace(/^\uFEFF/u, ''));
      return originalOnPrompt(...args);
    };
    const result = await run(env);
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.ok(observed, 'state should be readable before the prompt is admitted');
    assert.equal(observed.phase, 'prepared');
    assert.equal(observed.requestId, result.summary.requestId);
    assert.equal(observed.baselineLatestSeq, -1);
    assert.deepEqual(observed.cursor, { seq: -1, offset: 0 });
    assert.equal(observed.workspacePath, await canonicalDirectoryPath(env.project));
    const allowlist = await readWorkspaceAllowlist({ file: env.workspacesFile });
    assert.equal(allowlist.entries.some((entry) => entry.path === observed.workspacePath), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: continuation baseline rejects an older finished turn and accepts a newer completion', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const priorEvents = completedEvents({ priorTurn: 1 });
    const priorLatest = priorEvents.at(-1).seq;

    function newSession(sessionId) {
      const session = env.fake.addSession({
        sessionId,
        workspaceId: workspace.id,
        cwd: canonical,
        events: completedEvents({ priorTurn: 1 }),
        modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
      });
      return session;
    }

    // Scenario A: the previous completed turn must not count as completion.
    const stale = newSession('c-cont-stale');
    env.fake.ctx.sessionController.prompt = async (request) => {
      stale.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq: stale.events.at(-1).seq + 1, time: 1 });
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'continue stale turn');
    const staleResult = await run(env, { sessionId: 'c-cont-stale', waitMs: 250, logFile: join(env.dir, 'stale.log') });
    assert.equal(staleResult.exitCode, EXIT.running, JSON.stringify(staleResult.summary ?? staleResult.thrown));
    assert.equal(staleResult.summary.status.state, 'finished');
    assert.equal(staleResult.summary.status.completion.seq, priorLatest);
    const staleState = JSON.parse(await readFile(join(env.dir, 'stale.log.state.json'), 'utf8'));
    assert.equal(staleState.baselineLatestSeq, priorLatest);
    assert.equal(staleState.kind, 'continue');

    // Scenario B: a completion after the captured baseline is the new request's completion.
    const fresh = newSession('c-cont-fresh');
    env.fake.ctx.sessionController.prompt = async (request) => {
      fresh.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq: fresh.events.at(-1).seq + 1, time: 1 });
      fresh.status = 'running';
      const base = fresh.events.at(-1).seq;
      fresh.events.push({ type: 'turn/start', data: { turn: 2 }, seq: base + 1, time: 1 });
      fresh.events.push({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'CONTINUED-OK' }] } }, seq: base + 2, time: 1 });
      fresh.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: base + 3, time: 1 });
      fresh.status = 'idle';
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'continue fresh turn');
    const freshResult = await run(env, { sessionId: 'c-cont-fresh', logFile: join(env.dir, 'fresh.log') });
    assert.equal(freshResult.exitCode, EXIT.completed, JSON.stringify(freshResult.summary ?? freshResult.thrown));
    assert.equal(freshResult.summary.baselineLatestSeq, priorLatest);
    assert.ok(freshResult.summary.status.completion.seq > priorLatest);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: terminal tail is drained with bounded pages and the final marker is not lost', async () => {
  const longText = `START-${'x'.repeat(4000)}-FINAL-MARKER`;
  const env = await makeEnv({ onPrompt: completeOnPrompt(longText) });
  try {
    await writeFile(env.taskFile, 'tail drain');
    const result = await run(env, { maxChars: 300, maxEvents: 5 });
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.outputPartial, false);
    const lines = await readLogLines(env.logFile);
    const pageTexts = lines.filter((line) => line.event === 'page' || line.event === 'drain_page')
      .flatMap((line) => (line.items ?? []).filter((item) => item.type === 'assistant_message').map((item) => item.text));
    assert.equal(pageTexts.join('').includes('FINAL-MARKER'), true);
    assert.equal(lines.some((line) => line.event === 'drain_page'), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: pending question exits blocked, failed exits 2, canceled exits 4', async () => {
  const pending = await makeEnv({
    onPrompt: async ({ session, raw }) => {
      session.status = 'running';
      raw.append('turn/start', { turn: 1 });
      session.projections.values.userQuestions = {
        active: [{ callId: 'q1', state: 'open', questions: [{ id: 'q1', question: 'pick one' }] }],
        settled: [],
      };
    },
  });
  try {
    await writeFile(pending.taskFile, 'pending question');
    const result = await run(pending, { waitMs: 5000 });
    assert.equal(result.exitCode, EXIT.blocked, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.pendingAction.pending, true);
    const state = JSON.parse(await readFile(`${pending.logFile}.state.json`, 'utf8'));
    assert.equal(state.phase, 'blocked');
  } finally {
    await pending.cleanup();
  }

  const failed = await makeEnv({ onPrompt: async ({ session, raw }) => {
    session.status = 'running';
    raw.append('turn/start', { turn: 1 });
    raw.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'E_BOOM' } } });
    session.status = 'idle';
  } });
  try {
    await writeFile(failed.taskFile, 'fail task');
    const result = await run(failed);
    assert.equal(result.exitCode, EXIT.failed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.status.state, 'failed');
  } finally {
    await failed.cleanup();
  }

  const canceled = await makeEnv({ onPrompt: async ({ session, raw }) => {
    session.status = 'running';
    raw.append('turn/start', { turn: 1 });
    raw.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
    session.status = 'idle';
  } });
  try {
    await writeFile(canceled.taskFile, 'cancel task');
    const result = await run(canceled);
    assert.equal(result.exitCode, EXIT.canceled, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.status.state, 'canceled');
  } finally {
    await canceled.cleanup();
  }
});

test('dispatch: running timeout exits 5 and explicit cancel writes a separate receipt without rewriting state', async () => {
  const env = await makeEnv({ onPrompt: async ({ session, raw }) => {
    session.status = 'running';
    raw.append('turn/start', { turn: 1 });
  } });
  try {
    await writeFile(env.taskFile, 'long running task');
    const result = await run(env, { waitMs: 200 });
    assert.equal(result.exitCode, EXIT.running, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.outcome, 'timeout');
    assert.equal(result.summary.inputConsumed, true);
    assert.match(result.summary.note, /after this request input was consumed/u);
    assert.equal(/not proven consumed/u.test(result.summary.note), false, 'timeout note must not contradict inputConsumed:true');
    assert.equal(env.fake.calls.some((call) => call.operation === 'cancel'), false);
    const stateFile = `${env.logFile}.state.json`;
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.phase, 'timeout');
    assert.equal(typeof state.sessionId, 'string');
    assert.equal(typeof state.consumedInputSeq, 'number');

    const canceled = await runCancel({ stateFile, url: env.url, tokenFile: env.tokenFile, env: { DSH_HOME: join(env.dir, '.dsh') } });
    assert.equal(canceled.exitCode, EXIT.completed);
    assert.equal(canceled.summary.cancel.accepted, true);
    assert.equal(canceled.summary.stateWritten, false);
    assert.equal(canceled.summary.cancelReceiptPath, `${stateFile}.cancel.json`);
    assert.equal(env.fake.calls.some((call) => call.operation === 'cancel'), true);
    const receipt = JSON.parse(await readFile(canceled.summary.cancelReceiptPath, 'utf8'));
    assert.equal(receipt.kind, 'cancel-receipt');
    assert.equal(receipt.accepted, true);
    assert.equal(receipt.sessionId, state.sessionId);
    const after = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(after.cancel, undefined, 'cancel must not rewrite the dispatch-owned state snapshot');
    assert.equal(after.phase, 'timeout');
    assert.equal(after.sessionId, state.sessionId);
    assert.equal(after.cursor.seq, state.cursor.seq);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: Ctrl-C interruption preserves state and never cancels the desktop task', async () => {
  const controller = new AbortController();
  const env = await makeEnv({ onPrompt: async ({ session, raw }) => {
    session.status = 'running';
    raw.append('turn/start', { turn: 1 });
    setTimeout(() => controller.abort(), 20);
  } });
  try {
    await writeFile(env.taskFile, 'interrupt task');
    const result = await run(env, { waitMs: 5000, signal: controller.signal });
    assert.equal(result.exitCode, EXIT.interrupted, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(env.fake.calls.some((call) => call.operation === 'cancel'), false);
    const state = JSON.parse(await readFile(`${env.logFile}.state.json`, 'utf8'));
    assert.equal(state.phase, 'admitted');
    assert.equal(typeof state.interruptedAt, 'string');
    const lines = await readLogLines(env.logFile);
    assert.equal(lines.some((line) => line.event === 'interrupted'), true);
  } finally {
    await env.cleanup();
  }
});

function makeLegacyAdapter() {
  const state = { submits: 0 };
  const diagnostics = {
    ok: true,
    host: { pid: 1, appVersion: '0.2.1-rc.2' },
    model: {
      configured: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      required: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      matchesRequired: true,
      credentialsRead: false,
    },
    workspace: { id: '3261eb3a-9083-4ce6-b18f-89cb7e6d1746', path: 'C:/legacy/default-workspace' },
    capabilities: { list_sessions: 'implemented', submit_task: 'implemented', get_task: 'implemented', continue_task: 'implemented', cancel_task: 'implemented' },
  };
  return {
    state,
    adapter: {
      diagnostics: () => diagnostics,
      listSessions: async () => ({ ok: true, items: [] }),
      submitTask: async () => { state.submits += 1; return { ok: true, sessionId: 'legacy-session' }; },
      getTask: async () => ({ ok: true, items: [], cursor: { seq: -1, offset: 0 }, hasMore: false, latestSeq: -1, status: { state: 'unknown', running: false, success: false, completion: null }, pendingAction: { pending: false } }),
      continueTask: async () => ({ ok: true, sessionId: 'legacy-session' }),
      cancelTask: async () => ({ ok: true, sessionId: 'legacy-session', cancelRequested: true }),
    },
  };
}

test('dispatch: stale bridge code is refused before any submission; a compatible bridge check passes', async () => {
  const legacy = makeLegacyAdapter();
  const listener = await startHttpServer({ adapter: legacy.adapter, token: TOKEN, port: 0 });
  const dir = await mkdtemp(join(tmpdir(), 'c-dispatch-stale-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  const project = join(dir, 'project');
  await mkdir(project);
  const taskFile = join(dir, 'task.md');
  await writeFile(taskFile, 'stale task');
  try {
    const url = `http://127.0.0.1:${listener.port}/mcp`;
    const check = await runCheck({ url, tokenFile, env: { DSH_HOME: join(dir, '.dsh') } }).catch((error) => ({ thrown: error }));
    assert.equal(check.thrown instanceof DispatchError, true);
    assert.equal(check.thrown.code, 'stale_bridge');

    const result = await runDispatch({
      taskFile,
      workspace: project,
      logFile: join(dir, 'run.log'),
      url,
      tokenFile,
      workspacesFile: join(dir, 'workspaces.json'),
      env: { DSH_HOME: join(dir, '.dsh') },
      waitMs: 500,
    }).catch((error) => ({ thrown: error }));
    assert.equal(result.thrown instanceof DispatchError, true);
    assert.equal(result.thrown.code, 'stale_bridge');
    assert.equal(legacy.state.submits, 0);
    assert.equal((await readWorkspaceAllowlist({ file: join(dir, 'workspaces.json') })).entries.length, 0);
  } finally {
    await listener.close();
    await rm(dir, { recursive: true, force: true });
  }

  // Unit-level compatibility matrix.
  assert.throws(() => assertBridgeCompatible({
    bridge: { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, workspacePath: false },
    model: { matchesRequired: true },
  }), { code: 'stale_bridge' });
  assert.throws(() => assertBridgeCompatible({ bridge: null, model: { matchesRequired: true } }), { code: 'stale_bridge' });
  assert.throws(() => assertBridgeCompatible({
    bridge: { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, workspacePath: true, standardMode: true },
    model: { matchesRequired: false, configured: null },
  }), { code: 'model_route_mismatch' });

  const compatible = await makeEnv({ onPrompt: completeOnPrompt('CHECK-OK') });
  try {
    const checked = await runCheck({ url: compatible.url, tokenFile: compatible.tokenFile, env: { DSH_HOME: join(compatible.dir, '.dsh') } });
    assert.equal(checked.exitCode, EXIT.completed);
    assert.equal(checked.summary.bridge.protocol, BRIDGE_PROTOCOL);
    assert.equal(checked.summary.bridge.workspacePath, true);
    assert.equal(checked.summary.tools.includes('submit_task'), true);
  } finally {
    await compatible.cleanup();
  }
});

test('dispatch: retry resume reuses the request id, verifies identity, and never duplicates admission', async () => {
  const env = await makeEnv({ onPrompt: completeOnPrompt('RESUMED-OK') });
  try {
    await writeFile(env.taskFile, 'resume identity task');
    let failOnce = true;
    let attempts = 0;
    const originalPrompt = env.fake.ctx.sessionController.prompt;
    env.fake.ctx.sessionController.prompt = async (...args) => {
      attempts += 1;
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated network loss before prompt admission');
      }
      return originalPrompt(...args);
    };
    const first = await run(env);
    assert.equal(first.thrown instanceof DispatchError, true);
    assert.equal(first.thrown.code, 'prompt_failed');
    const stateFile = `${env.logFile}.state.json`;
    const prepared = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(prepared.phase, 'prepared');
    assert.equal(typeof prepared.requestId, 'string');

    const resumeLog = join(env.dir, 'resume.log');
    const resumed = await run(env, { resumeState: stateFile, logFile: resumeLog });
    assert.equal(resumed.exitCode, EXIT.completed, JSON.stringify(resumed.summary ?? resumed.thrown));
    assert.equal(resumed.summary.requestId, prepared.requestId);
    assert.equal(attempts, 2);
    const prompts = env.fake.calls.filter((call) => call.operation === 'prompt' && call.requestId === prepared.requestId);
    assert.equal(prompts.length, 1);
    const userMessages = [...env.fake.sessions.values()]
      .flatMap((session) => session.events)
      .filter((event) => event.type === 'user/message' && event.data?.source?.rpcId === prepared.requestId);
    assert.equal(userMessages.length, 1);
    const resumeState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(resumeState.requestId, prepared.requestId);
    const resumeLines = await readLogLines(resumeLog);
    assert.equal(resumeLines.some((line) => line.event === 'resume'), true);

    // Identity checks refuse a mismatched task or workspace.
    const mismatchedTask = join(env.dir, 'mismatch.md');
    await writeFile(mismatchedTask, 'different task text');
    const taskMismatch = await run(env, { taskFile: mismatchedTask, resumeState: stateFile, logFile: join(env.dir, 'mismatch.log') });
    assert.equal(taskMismatch.thrown.code, 'resume_task_mismatch');
    const otherProject = join(env.dir, 'other-project');
    await mkdir(otherProject);
    const workspaceMismatch = await run(env, { workspace: otherProject, resumeState: stateFile, logFile: join(env.dir, 'ws-mismatch.log') });
    assert.equal(workspaceMismatch.thrown.code, 'resume_workspace_mismatch');
    const kindMismatch = await run(env, { resumeState: stateFile, logFile: join(env.dir, 'kind-mismatch.log'), sessionId: 'any-session' });
    assert.equal(kindMismatch.thrown.code, 'resume_task_mismatch');
  } finally {
    await env.cleanup();
  }
});

test('dispatch: new invocation refuses an existing state or log file instead of overwriting evidence', async () => {
  const env = await makeEnv({ onPrompt: completeOnPrompt() });
  try {
    await writeFile(env.taskFile, 'evidence task');
    const first = await run(env);
    assert.equal(first.exitCode, EXIT.completed);
    const stateFile = `${env.logFile}.state.json`;
    const reusedState = await run(env, { logFile: join(env.dir, 'new.log'), stateFile });
    assert.equal(reusedState.thrown.code, 'state_exists');
    const existingLog = await run(env, { logFile: env.logFile, stateFile: join(env.dir, 'fresh-state.json') });
    assert.equal(existingLog.thrown.code, 'log_exists');
    assert.equal(typeof JSON.parse(await readFile(stateFile, 'utf8')).requestId, 'string');
  } finally {
    await env.cleanup();
  }
});

test('dispatch: visible answer >2000 chars is fully reconstructable from bounded log pages (no silent cursor loss)', async () => {
  const longText = `VISIBLE-HEAD-${'x'.repeat(2600)}-UNIQUE-TAIL-7F3A`;
  const env = await makeEnv({ onPrompt: completeOnPrompt(longText) });
  try {
    await writeFile(env.taskFile, 'long visible answer task');
    const reconstruct = async (logFile, maxChars) => {
      const result = await run(env, { logFile, maxChars, pollMs: 20 });
      assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
      assert.equal(result.summary.outputPartial, false);
      const lines = await readLogLines(logFile);
      const pageItems = lines
        .filter((line) => line.event === 'page' || line.event === 'drain_page')
        .flatMap((line) => (line.items ?? []));
      for (const item of pageItems) {
        assert.equal(Array.from(item.text ?? '').length <= maxChars, true, `logged item exceeds bounded page maxChars ${maxChars}`);
      }
      const assistantText = pageItems
        .filter((item) => item.type === 'assistant_message')
        .map((item) => item.text)
        .join('');
      return { result, assistantText, pageCount: lines.filter((line) => line.event === 'page' || line.event === 'drain_page').length };
    };

    // Default bounded page (maxChars 5000) contains the whole >2000-char answer.
    const single = await reconstruct(join(env.dir, 'long-visible-single.log'), 5000);
    assert.equal(single.assistantText, longText, 'exact reconstruction from the log page text');
    assert.equal(single.assistantText.includes('UNIQUE-TAIL-7F3A'), true);

    // Smaller bounded pages must not lose any text either; outputPartial stays
    // false only when the bounded pages fully covered the visible output.
    const paged = await reconstruct(join(env.dir, 'long-visible-paged.log'), 1200);
    assert.equal(paged.pageCount > 1, true, 'small maxChars should split the answer across bounded pages');
    assert.equal(paged.assistantText, longText, 'exact cross-page reconstruction from the log');
    assert.equal(paged.assistantText.includes('UNIQUE-TAIL-7F3A'), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: task file decoding rejects invalid UTF-8 and empty tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-dispatch-task-'));
  try {
    const invalid = join(dir, 'invalid.md');
    await writeFile(invalid, Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    await assert.rejects(readTaskFile(invalid), { code: 'task_not_utf8' });
    const empty = join(dir, 'empty.md');
    await writeFile(empty, '\r\n   \n');
    await assert.rejects(readTaskFile(empty), { code: 'task_file_empty' });
    await assert.rejects(readTaskFile(join(dir, 'missing.md')), { code: 'task_file_unavailable' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispatch: queued continuation is never completed by a previous running turn (F1 regression)', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-queued-race',
      workspaceId: workspace.id,
      cwd: canonical,
      status: 'running',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'prior-running' }] } }, seq: 1, time: 1 },
        { type: 'turn/start', data: { turn: 2 }, seq: 2, time: 1 },
        { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'still-running' }] } }, seq: 3, time: 1 },
      ],
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    // Admission accepted, but the new input is retained pending and no
    // user_message carries this requestId; the previous running turn ends.
    env.fake.ctx.sessionController.prompt = async (request) => {
      const lastSeq = session.events.at(-1).seq;
      session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: lastSeq + 1, time: 1 });
      session.status = 'idle';
      session.inbox.nextTurn.push({ content: request.content });
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'queued continuation race');
    const logFile = join(env.dir, 'queued.log');
    const result = await run(env, { sessionId: 'c-queued-race', waitMs: 300, pollMs: 20, logFile });
    assert.notEqual(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.ok, false);
    assert.notEqual(result.summary.outcome, 'completed');
    assert.equal(result.summary.inputConsumed, false);
    assert.equal(result.summary.consumedInputSeq, null);
    assert.equal(result.summary.sawCompletionWithoutConsumedInput, true);
    assert.equal(result.summary.pendingInbox.nextTurnCount, 1);
    const state = JSON.parse(await readFile(`${logFile}.state.json`, 'utf8'));
    assert.notEqual(state.phase, 'terminal');
    assert.equal(state.consumedInputSeq, null);
    const lines = await readLogLines(logFile);
    assert.equal(lines.some((line) => line.event === 'completion_without_consumed_input'), true);
    assert.equal(lines.some((line) => line.event === 'input_consumed'), false);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: consumed continuation control completes and durably records the request-id seq', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-consumed-control',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    let userMessageSeq = null;
    env.fake.ctx.sessionController.prompt = async (request) => {
      let seq = session.events.at(-1).seq;
      seq += 1;
      userMessageSeq = seq;
      session.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq, time: 1 });
      session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
      session.events.push({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'CONSUMED-CONTROL-OK' }] } }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: ++seq, time: 1 });
      session.projections.asOfSeq = seq;
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'consumed continuation control');
    const logFile = join(env.dir, 'consumed.log');
    const result = await run(env, { sessionId: 'c-consumed-control', logFile });
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.ok, true);
    assert.equal(result.summary.inputConsumed, true);
    assert.equal(result.summary.consumedInputSeq, userMessageSeq);
    assert.equal(result.summary.sawCompletionWithoutConsumedInput, false);
    const state = JSON.parse(await readFile(`${logFile}.state.json`, 'utf8'));
    assert.equal(state.consumedInputSeq, userMessageSeq);
    assert.equal(state.phase, 'terminal');
    const lines = await readLogLines(logFile);
    assert.equal(lines.some((line) => line.event === 'input_consumed'), true);
    const correlated = lines
      .filter((line) => line.event === 'page')
      .flatMap((line) => line.items ?? [])
      .filter((item) => item.type === 'user_message' && item.meta?.requestId === result.summary.requestId);
    assert.equal(correlated.length > 0, true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: paginated small maxChars finds the request-id message on an earlier page and completes after it', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-paged-consumed',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    let userMessageSeq = null;
    env.fake.ctx.sessionController.prompt = async (request) => {
      let seq = session.events.at(-1).seq;
      // A large visible preamble forces the request-id message onto a later
      // page even though the durable completion status is already available.
      for (let index = 0; index < 3; index += 1) {
        seq += 1;
        session.events.push({
          type: 'assistant/message',
          data: { turn: 1, step: 2 + index, message: { content: [{ type: 'text', text: `PREAMBLE-${index}-${'z'.repeat(400)}` }] } },
          seq,
          time: 1,
        });
      }
      seq += 1;
      userMessageSeq = seq;
      session.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq, time: 1 });
      session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
      for (let index = 0; index < 2; index += 1) {
        seq += 1;
        session.events.push({ type: 'assistant/message', data: { turn: 2, step: index + 1, message: { content: [{ type: 'text', text: `TURN-2-CHUNK-${index}-${'q'.repeat(400)}` }] } }, seq, time: 1 });
      }
      session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: ++seq, time: 1 });
      session.projections.asOfSeq = seq;
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'paged consumed continuation');
    const logFile = join(env.dir, 'paged.log');
    const result = await run(env, { sessionId: 'c-paged-consumed', logFile, maxChars: 200, maxEvents: 10 });
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.consumedInputSeq, userMessageSeq);
    const lines = await readLogLines(logFile);
    const pages = lines.filter((line) => line.event === 'page');
    const userPage = pages.findIndex((line) => (line.items ?? []).some((item) => item.type === 'user_message' && item.meta?.requestId === result.summary.requestId));
    const finalSeq = session.events.at(-1).seq;
    const tailEvents = lines.filter((line) => line.event === 'page' || line.event === 'drain_page');
    const terminalIndex = tailEvents.findIndex((line) => (line.items ?? []).some((item) => item.seq === finalSeq && item.type === 'turn_end'));
    assert.equal(pages.length > 1, true, 'small maxChars should split the output across pages');
    assert.equal(userPage > 0, true, 'request-id message should be on a later page, not page 0');
    assert.equal(terminalIndex > userPage, true, `request-id page ${userPage} should precede the completion tail page ${terminalIndex}`);
    assert.equal(pages.some((line) => line.consumedInputSeq === userMessageSeq), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: resume with a saved cursor backfills an earlier-page request-id and re-verifies success', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const requestId = 'manual-resume-request';
    const session = env.fake.addSession({
      sessionId: 'c-resume-saved-cursor',
      workspaceId: workspace.id,
      cwd: canonical,
      events: [
        ...completedEvents({ priorTurn: 1 }),
        { type: 'user/message', data: { content: [{ type: 'text', text: 'resume task' }], source: { kind: 'user', rpcId: requestId } }, seq: 3, time: 1 },
        { type: 'turn/start', data: { turn: 2 }, seq: 4, time: 1 },
        { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'RESUMED-SAVED-CURSOR' }] } }, seq: 5, time: 1 },
        { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: 6, time: 1 },
      ],
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    const taskText = 'saved cursor resume task';
    await writeFile(env.taskFile, taskText);
    const oldSchemaState = {
      version: 1,
      protocol: BRIDGE_PROTOCOL,
      bridgeVersion: BRIDGE_VERSION,
      requestId,
      kind: 'continue',
      taskPath: resolve(env.taskFile),
      taskSha256: sha256(taskText),
      workspacePath: canonical,
      sessionId: session.id,
      baselineLatestSeq: 2,
      cursor: { seq: 6, offset: 0 },
      phase: 'admitted',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const stateFile = join(env.dir, 'old-schema.state.json');
    await writeFile(stateFile, `${JSON.stringify(oldSchemaState, null, 2)}\n`, 'utf8');
    const result = await run(env, {
      sessionId: session.id,
      resumeState: stateFile,
      logFile: join(env.dir, 'saved-cursor.log'),
      waitMs: 1000,
    });
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.inputConsumed, true);
    assert.equal(result.summary.consumedInputSeq, 3);
    const resumedState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(resumedState.consumedInputSeq, 3);
    const lines = await readLogLines(join(env.dir, 'saved-cursor.log'));
    assert.equal(lines.some((line) => line.event === 'input_consumed' && line.consumedInputSeq === 3), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: stale terminal success resume without consumed proof is not reported as success', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const requestId = 'manual-stale-terminal';
    const session = env.fake.addSession({
      sessionId: 'c-stale-terminal',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 2 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    const taskText = 'stale terminal resume task';
    await writeFile(env.taskFile, taskText);
    const staleState = {
      version: 1,
      protocol: BRIDGE_PROTOCOL,
      bridgeVersion: BRIDGE_VERSION,
      requestId,
      kind: 'continue',
      taskPath: resolve(env.taskFile),
      taskSha256: sha256(taskText),
      workspacePath: canonical,
      sessionId: session.id,
      baselineLatestSeq: 2,
      cursor: { seq: 6, offset: 0 },
      phase: 'terminal',
      lastStatus: { state: 'finished', running: false, success: true, completion: { seq: 5, reason: { kind: 'completed' } } },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const stateFile = join(env.dir, 'stale-terminal.state.json');
    await writeFile(stateFile, `${JSON.stringify(staleState, null, 2)}\n`, 'utf8');
    const result = await run(env, {
      sessionId: session.id,
      resumeState: stateFile,
      logFile: join(env.dir, 'stale-terminal.log'),
      waitMs: 250,
      pollMs: 20,
    });
    assert.notEqual(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.ok, false);
    assert.equal(result.summary.inputConsumed, false);
    assert.equal(result.summary.resumedTerminalState, undefined);
    const lines = await readLogLines(join(env.dir, 'stale-terminal.log'));
    assert.equal(lines.some((line) => line.event === 'resume_terminal_reverify'), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: a timed-out state resumes polling with the same request/cursor (F3 regression)', async () => {
  const env = await makeEnv({
    onPrompt: async ({ session, raw }) => {
      session.status = 'running';
      raw.append('turn/start', { turn: 1 });
    },
  });
  try {
    await writeFile(env.taskFile, 'long timeout resumable task');
    const stateFile = `${env.logFile}.state.json`;
    const first = await run(env, { waitMs: 120, pollMs: 20 });
    assert.equal(first.exitCode, EXIT.running, JSON.stringify(first.summary ?? first.thrown));
    const stateBefore = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(stateBefore.phase, 'timeout');
    assert.equal(typeof stateBefore.sessionId, 'string');
    const observationsBefore = env.fake.calls.filter((call) => call.operation === 'observeSession').length;

    // The live Host turn finishes while the helper is not waiting; resuming the
    // timeout state must poll (not return the cached exit 5) and then complete.
    env.fake.append(stateBefore.sessionId, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'DONE-AFTER-TIMEOUT' }] },
    });
    env.fake.append(stateBefore.sessionId, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
    env.fake.setStatus(stateBefore.sessionId, 'idle');

    const resumed = await run(env, { resumeState: stateFile, logFile: join(env.dir, 'resume-after-timeout.log'), waitMs: 800, pollMs: 20 });
    assert.equal(resumed.exitCode, EXIT.completed, JSON.stringify(resumed.summary ?? resumed.thrown));
    assert.equal(resumed.summary.resumedTerminalState, undefined);
    assert.equal(resumed.summary.inputConsumed, true);
    const observationsAfter = env.fake.calls.filter((call) => call.operation === 'observeSession').length;
    assert.equal(observationsAfter > observationsBefore, true, 'timeout resume must poll again');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.phase, 'terminal');
    const lines = await readLogLines(join(env.dir, 'resume-after-timeout.log'));
    assert.equal(lines.some((line) => line.event === 'resume_after_timeout'), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: cancel while a dispatcher owns the state writes only a separate receipt (F4 regression)', async () => {
  const env = await makeEnv({});
  try {
    await writeFile(env.taskFile, 'cancel race task');
    const stateFile = `${env.logFile}.state.json`;
    const dispatchPromise = runDispatch(env.options({ waitMs: 900, pollMs: 40 }));
    let admittedState = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const candidate = JSON.parse(await readFile(stateFile, 'utf8'));
        if (candidate.phase === 'admitted') {
          admittedState = candidate;
          break;
        }
      } catch {
        // not written yet
      }
      await sleep(20);
    }
    assert.ok(admittedState, 'dispatcher should reach admitted state');
    assert.equal(await readFile(`${stateFile}.lock`, 'utf8').then(() => true).catch(() => false), true);

    const cancelResult = await runCancel({ stateFile, url: env.url, tokenFile: env.tokenFile, env: { DSH_HOME: join(env.dir, '.dsh') } });
    assert.equal(cancelResult.exitCode, EXIT.completed);
    assert.equal(cancelResult.summary.stateWritten, false);
    const receiptPath = cancelResult.summary.cancelReceiptPath;
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    assert.equal(receipt.kind, 'cancel-receipt');
    assert.equal(receipt.accepted, true);
    assert.equal(await readFile(`${stateFile}.lock`, 'utf8').then(() => true).catch(() => false), true, 'cancellation must not wait for or remove the dispatcher lifetime lock');

    await sleep(250);
    const duringDispatch = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(duringDispatch.cancel, undefined, 'dispatcher keeps sole state-writer ownership');
    assert.equal(duringDispatch.sessionId, admittedState.sessionId);
    const dispatchResult = await dispatchPromise;
    // The fake Host records the cancellation as an aborted turn, so the
    // dispatcher honestly reports canceled; the point is that the separate
    // receipt, not a state rewrite, carried the cancel acknowledgement.
    assert.equal(dispatchResult.exitCode, EXIT.canceled);
    assert.equal(dispatchResult.summary.cancelReceiptPath, receiptPath);
    const finalState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(finalState.cancel, undefined);
    assert.equal(finalState.phase, 'canceled');
    assert.equal(JSON.parse(await readFile(receiptPath, 'utf8')).accepted, true);
    assert.equal(env.fake.calls.filter((call) => call.operation === 'cancel').length, 1);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: consumed max-tokens finished turn is terminal failed, not a running timeout', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-max-tokens',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    env.fake.ctx.sessionController.prompt = async (request) => {
      let seq = session.events.at(-1).seq;
      session.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } }, seq: ++seq, time: 1 });
      session.projections.asOfSeq = seq;
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'max tokens task');
    const startedAt = Date.now();
    const result = await run(env, { sessionId: 'c-max-tokens', waitMs: 5000, pollMs: 20, logFile: join(env.dir, 'max-tokens.log') });
    const elapsed = Date.now() - startedAt;
    assert.equal(result.exitCode, EXIT.failed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.outcome, 'failed');
    assert.equal(result.summary.ok, false);
    assert.equal(result.summary.inputConsumed, true);
    assert.equal(result.summary.status.state, 'finished');
    assert.equal(result.summary.status.success, false);
    assert.equal(result.summary.status.completion.reason.kind, 'max-tokens');
    assert.match(result.summary.note, /max-tokens/u);
    assert.match(result.summary.note, /terminal non-success/u);
    assert.equal(elapsed < 3000, true, `consumed max-tokens must terminate immediately, took ${elapsed}ms`);
    const state = JSON.parse(await readFile(join(env.dir, 'max-tokens.log.state.json'), 'utf8'));
    assert.equal(state.phase, 'failed');
  } finally {
    await env.cleanup();
  }
});

test('dispatch: timeout note reflects unconsumed input (no contradiction)', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    env.fake.addSession({
      sessionId: 'c-unconsumed-timeout',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    env.fake.ctx.sessionController.prompt = async () => ({ accepted: true });
    await writeFile(env.taskFile, 'unconsumed timeout task');
    const result = await run(env, { sessionId: 'c-unconsumed-timeout', waitMs: 200, pollMs: 20, logFile: join(env.dir, 'unconsumed.log') });
    assert.equal(result.exitCode, EXIT.running, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.outcome, 'timeout');
    assert.equal(result.summary.inputConsumed, false);
    assert.equal(result.summary.consumedInputSeq, null);
    assert.match(result.summary.note, /before this request input was proven consumed/u);
    assert.equal(/after this request input was consumed/u.test(result.summary.note), false);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: retained-inbox pending state resumes to completion with the same request (G5)', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-pending-inbox',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    let promptCalls = 0;
    env.fake.ctx.sessionController.prompt = async (request) => {
      promptCalls += 1;
      session.inbox.nextTurn.push({ content: request.content });
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'pending inbox task');
    const logFile = join(env.dir, 'pending-inbox.log');
    const first = await run(env, { sessionId: 'c-pending-inbox', waitMs: 200, pollMs: 20, logFile });
    assert.equal(first.exitCode, EXIT.blocked, JSON.stringify(first.summary ?? first.thrown));
    assert.equal(first.summary.outcome, 'pending');
    assert.equal(first.summary.pendingReason, 'inbox');
    assert.equal(first.summary.inputConsumed, false);
    assert.match(first.summary.note, /not proven consumed/u);
    const stateFile = `${logFile}.state.json`;
    const pendingState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(pendingState.phase, 'blocked');
    assert.equal(pendingState.pendingReason, 'inbox');

    // The Host later consumes the queued input and completes the turn; the
    // resume must re-poll the same request (no second admission/new request).
    session.inbox.nextTurn.length = 0;
    let seq = session.events.at(-1).seq;
    const userMessageSeq = seq + 1;
    session.events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'pending inbox task' }], source: { kind: 'user', rpcId: pendingState.requestId } }, seq: ++seq, time: 1 });
    session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
    session.events.push({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'PENDING-RESUMED-OK' }] } }, seq: ++seq, time: 1 });
    session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: ++seq, time: 1 });
    session.projections.asOfSeq = seq;
    session.status = 'idle';

    const observationsBefore = env.fake.calls.filter((call) => call.operation === 'observeSession').length;
    const resumed = await run(env, {
      sessionId: 'c-pending-inbox',
      resumeState: stateFile,
      logFile: join(env.dir, 'pending-inbox-resume.log'),
      waitMs: 1200,
      pollMs: 20,
    });
    assert.equal(resumed.exitCode, EXIT.completed, JSON.stringify(resumed.summary ?? resumed.thrown));
    assert.equal(resumed.summary.inputConsumed, true);
    assert.equal(resumed.summary.consumedInputSeq, userMessageSeq);
    assert.equal(resumed.summary.resumedTerminalState, undefined);
    assert.equal(promptCalls, 1, 'resume must not dispatch a new request just to keep waiting');
    const observationsAfter = env.fake.calls.filter((call) => call.operation === 'observeSession').length;
    assert.equal(observationsAfter > observationsBefore, true);
    const lines = await readLogLines(join(env.dir, 'pending-inbox-resume.log'));
    assert.equal(lines.some((line) => line.event === 'resume_after_pending' && line.pendingReason === 'inbox'), true);
    assert.equal(lines.some((line) => line.event === 'resume_polling'), true);
    const finalState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(finalState.phase, 'terminal');
    assert.equal(finalState.pendingReason, null);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: pending question state resumes after the answer and completes (G5)', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-pending-question',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    let promptCalls = 0;
    env.fake.ctx.sessionController.prompt = async (request) => {
      promptCalls += 1;
      let seq = session.events.at(-1).seq;
      session.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
      session.status = 'running';
      session.projections.asOfSeq = seq;
      session.projections.values.userQuestions = {
        active: [{ callId: 'q1', state: 'open', questions: [{ id: 'q1', question: 'pick one' }] }],
        settled: [],
      };
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'pending question task');
    const logFile = join(env.dir, 'pending-question.log');
    const first = await run(env, { sessionId: 'c-pending-question', waitMs: 5000, pollMs: 20, logFile });
    assert.equal(first.exitCode, EXIT.blocked, JSON.stringify(first.summary ?? first.thrown));
    assert.equal(first.summary.outcome, 'pending');
    assert.equal(first.summary.pendingReason, 'action');
    const stateFile = `${logFile}.state.json`;
    const pendingState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(pendingState.phase, 'blocked');

    // The user answers in the Desktop; the question projection clears and the
    // running turn completes.
    session.projections.values.userQuestions = { active: [], settled: [{ callId: 'q1', state: 'settled' }] };
    let seq = session.events.at(-1).seq;
    session.events.push({ type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'QUESTION-RESUMED-OK' }] } }, seq: ++seq, time: 1 });
    session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } }, seq: ++seq, time: 1 });
    session.projections.asOfSeq = seq;
    session.status = 'idle';

    const resumed = await run(env, {
      sessionId: 'c-pending-question',
      resumeState: stateFile,
      logFile: join(env.dir, 'pending-question-resume.log'),
      waitMs: 1500,
      pollMs: 20,
    });
    assert.equal(resumed.exitCode, EXIT.completed, JSON.stringify(resumed.summary ?? resumed.thrown));
    assert.equal(resumed.summary.inputConsumed, true);
    assert.equal(promptCalls, 1);
    const lines = await readLogLines(join(env.dir, 'pending-question-resume.log'));
    assert.equal(lines.some((line) => line.event === 'resume_after_pending' && line.pendingReason === 'action'), true);
  } finally {
    await env.cleanup();
  }
});

test('dispatch: a genuine Host turn-end blocked state re-reports immediately on resume', async () => {
  const env = await makeEnv({});
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    const workspace = env.fake.addWorkspace({ path: canonical });
    const session = env.fake.addSession({
      sessionId: 'c-host-blocked',
      workspaceId: workspace.id,
      cwd: canonical,
      events: completedEvents({ priorTurn: 1 }),
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    env.fake.ctx.sessionController.prompt = async (request) => {
      let seq = session.events.at(-1).seq;
      session.events.push({ type: 'user/message', data: { content: request.content, source: { kind: 'user', rpcId: request.requestId } }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/start', data: { turn: 2 }, seq: ++seq, time: 1 });
      session.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } }, seq: ++seq, time: 1 });
      session.projections.asOfSeq = seq;
      return { accepted: true };
    };
    await writeFile(env.taskFile, 'host blocked task');
    const logFile = join(env.dir, 'host-blocked.log');
    const first = await run(env, { sessionId: 'c-host-blocked', logFile });
    assert.equal(first.exitCode, EXIT.blocked, JSON.stringify(first.summary ?? first.thrown));
    assert.equal(first.summary.outcome, 'blocked');
    assert.equal(first.summary.status.state, 'blocked');
    assert.equal(first.summary.pendingReason, null);
    const stateFile = `${logFile}.state.json`;
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).phase, 'blocked');

    const observationsBefore = env.fake.calls.filter((call) => call.operation === 'observeSession').length;
    const resumed = await run(env, { sessionId: 'c-host-blocked', resumeState: stateFile, logFile: join(env.dir, 'host-blocked-resume.log'), waitMs: 1500, pollMs: 20 });
    assert.equal(resumed.exitCode, EXIT.blocked);
    assert.equal(resumed.summary.resumedTerminalState, true);
    const observationsAfter = env.fake.calls.filter((call) => call.operation === 'observeSession').length;
    assert.equal(observationsAfter, observationsBefore, 'durable Host blocked evidence re-reports without re-polling');
  } finally {
    await env.cleanup();
  }
});

test('dispatch: state write retries the same owned temp rename when a Windows reader releases within the bounded window', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-state-retry-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"old":true}\n', 'utf8');
    const handle = await open(file, 'r');
    const releaseTimer = setTimeout(() => {
      handle.close().catch(() => {});
    }, 80);
    const startedAt = Date.now();
    await writeJsonFile(file, { new: true });
    const elapsed = Date.now() - startedAt;
    clearTimeout(releaseTimer);
    await handle.close().catch(() => {});
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { new: true });
    assert.equal(elapsed < 1500, true, `bounded retry must finish promptly, took ${elapsed}ms`);
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith('state.json.tmp-'));
    assert.deepEqual(leftovers, [], 'owned temp must not be left behind after a successful retry');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispatch: persistent non-sharing reader fails closed after the bounded cap without touching the last-good state', { skip: process.platform !== 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-state-retry-cap-'));
  try {
    const file = join(dir, 'state.json');
    const original = '{"old":true}\n';
    await writeFile(file, original, 'utf8');
    const reader = await open(file, 'r');
    let caught = null;
    const startedAt = Date.now();
    try {
      await writeJsonFile(file, { new: true });
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - startedAt;
    await reader.close().catch(() => {});
    assert.equal(caught instanceof DispatchError, true, 'persistent contention must fail closed with DispatchError');
    assert.equal(caught.code, 'state_write_failed');
    assert.match(caught.message, /could not write dispatch state/u);
    assert.equal(await readFile(file, 'utf8'), original, 'last-good state must be byte-identical');
    assert.equal(elapsed < 2500, true, `bounded cap must not turn into an unbounded wait, took ${elapsed}ms`);
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith('state.json.tmp-'));
    assert.deepEqual(leftovers, [], "only the write's own temp may be cleaned; it must not remain");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dispatch: bounded state writes survive concurrent async readFile stress without aborting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-state-stress-'));
  try {
    const file = join(dir, 'state.json');
    await writeFile(file, '{"v":0}\n', 'utf8');
    let reading = true;
    const reader = (async () => {
      while (reading) {
        await readFile(file, 'utf8').catch(() => {});
        await sleep(2);
      }
    })();
    try {
      for (let index = 1; index <= 30; index += 1) {
        await writeJsonFile(file, { v: index });
        await sleep(5);
      }
    } finally {
      reading = false;
      await reader.catch(() => {});
    }
    assert.equal(JSON.parse(await readFile(file, 'utf8')).v, 30);
    const leftovers = (await readdir(dir)).filter((name) => name.startsWith('state.json.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workspace routing: projectless new task uses the configured default workspace without enrollment or workspace creation', async () => {
  const env = await makeEnv({ realDefaultWorkspace: true, onPrompt: completeOnPrompt('DEFAULT-OK') });
  try {
    await writeFile(env.taskFile, 'projectless default task');
    const defaultPath = await canonicalDirectoryPath(env.defaultWorkspacePath);
    let submitArgs = null;
    const originalSubmit = env.adapter.submitTask;
    env.adapter.submitTask = async (args) => {
      submitArgs = args;
      return originalSubmit(args);
    };
    const result = await run(env, { workspace: undefined });
    assert.equal(result.exitCode, EXIT.completed, JSON.stringify(result.summary ?? result.thrown));
    assert.equal(result.summary.workspacePath, defaultPath);
    assert.equal(result.summary.workspaceSource, 'default');
    assert.equal(result.summary.workspaceId, env.fake.workspaceId);
    assert.ok(submitArgs !== null, 'submit_task must have been called');
    assert.equal(submitArgs.workspacePath, undefined, 'default submit must not name a workspacePath');
    const state = JSON.parse(await readFile(`${env.logFile}.state.json`, 'utf8'));
    assert.equal(state.workspaceSource, 'default');
    assert.equal(state.workspacePath, defaultPath);
    assert.equal(state.workspaceId, env.fake.workspaceId);
    const allowlist = await readWorkspaceAllowlist({ file: env.workspacesFile });
    assert.equal(allowlist.entries.length, 0, 'a default dispatch must not enroll any directory');
    assert.equal(env.fake.calls.some((call) => call.operation === 'createWorkspace'), false, 'no workspace may be registered');
    const session = env.fake.sessions.get(result.summary.sessionId);
    assert.equal(session.workspaceId, env.fake.workspaceId);
    assert.equal(await canonicalDirectoryPath(session.cwd), defaultPath);
    const lines = await readLogLines(env.logFile);
    assert.equal(lines.some((line) => line.event === 'workspace_resolved' && line.submitWorkspacePath === 'omitted'), true);
    assert.equal(lines.some((line) => line.event === 'workspace_not_enrolled' && line.source === 'default'), true);
    assert.equal(lines.some((line) => line.event === 'workspace_enrolled'), false);
    // The persisted target is the configured default, never a generated cwd.
    assert.notEqual(defaultPath, await canonicalDirectoryPath(env.dir));
    assert.notEqual(defaultPath, resolve(process.cwd()));
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: projectless continuation derives the existing session workspace and never rehomes it', async () => {
  const env = await makeEnv({ realDefaultWorkspace: true, onPrompt: completeOnPrompt('DEFAULT-CONT-OK') });
  try {
    await writeFile(env.taskFile, 'default session task');
    const first = await run(env, { workspace: undefined });
    assert.equal(first.exitCode, EXIT.completed, JSON.stringify(first.summary ?? first.thrown));
    env.fake.setProjections(first.summary.sessionId, {
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    const defaultPath = await canonicalDirectoryPath(env.defaultWorkspacePath);
    const contLog = join(env.dir, 'default-cont.log');
    const cont = await run(env, {
      workspace: undefined,
      sessionId: first.summary.sessionId,
      logFile: contLog,
      waitMs: 5000,
    });
    assert.equal(cont.exitCode, EXIT.completed, JSON.stringify(cont.summary ?? cont.thrown));
    assert.equal(cont.summary.workspaceSource, 'session');
    assert.equal(cont.summary.workspacePath, defaultPath);
    assert.equal(cont.summary.workspaceId, env.fake.workspaceId);
    const contState = JSON.parse(await readFile(`${contLog}.state.json`, 'utf8'));
    assert.equal(contState.workspaceSource, 'session');
    assert.equal(contState.workspacePath, defaultPath);
    assert.equal(Number.isInteger(contState.baselineLatestSeq), true);
    const allowlist = await readWorkspaceAllowlist({ file: env.workspacesFile });
    assert.equal(allowlist.entries.length, 0, 'a derived session target must not enroll a directory');
    assert.equal(env.fake.calls.some((call) => call.operation === 'createWorkspace'), false);
    const session = env.fake.sessions.get(first.summary.sessionId);
    assert.equal(session.workspaceId, env.fake.workspaceId);
    assert.equal(await canonicalDirectoryPath(session.cwd), defaultPath);
    const lines = await readLogLines(contLog);
    assert.equal(lines.some((line) => line.event === 'workspace_resolved' && line.source === 'session'), true);
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: explicit project dispatch still enrolls and reuses exactly that workspace', async () => {
  const env = await makeEnv({ onPrompt: completeOnPrompt('PROJECT-OK') });
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    let submitArgs = null;
    const originalSubmit = env.adapter.submitTask;
    env.adapter.submitTask = async (args) => {
      submitArgs = args;
      return originalSubmit(args);
    };
    await writeFile(env.taskFile, 'explicit project task');
    const first = await run(env);
    assert.equal(first.exitCode, EXIT.completed, JSON.stringify(first.summary ?? first.thrown));
    assert.equal(first.summary.workspacePath, canonical);
    assert.equal(first.summary.workspaceSource, 'explicit');
    assert.equal(submitArgs.workspacePath, canonical, 'explicit opt-in must still send its workspacePath');
    const allowlist = await readWorkspaceAllowlist({ file: env.workspacesFile });
    assert.equal(allowlist.entries.length, 1);
    assert.equal(sameWorkspacePath(allowlist.entries[0].path, canonical), true);
    const createWorkspaceCalls = () => env.fake.calls.filter((call) => call.operation === 'createWorkspace');
    assert.equal(createWorkspaceCalls().length, 1);

    await writeFile(env.taskFile, 'explicit project task second');
    const second = await run(env, { logFile: join(env.dir, 'second.log') });
    assert.equal(second.exitCode, EXIT.completed, JSON.stringify(second.summary ?? second.thrown));
    assert.equal(createWorkspaceCalls().length, 1, 'the same explicit project is reused, not created twice');
    assert.equal((await readWorkspaceAllowlist({ file: env.workspacesFile })).entries.length, 1);
    assert.equal(env.fake.workspaces.size, 2, 'only the configured default plus the explicit project exist');
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: continuation without Workspace derives the enrolled session workspace and a mismatched explicit project is rejected before continue_task', async () => {
  const env = await makeEnv({ onPrompt: completeOnPrompt('PROJECT-CONT-OK') });
  try {
    const canonical = await canonicalDirectoryPath(env.project);
    await writeFile(env.taskFile, 'enrolled session task');
    const first = await run(env);
    assert.equal(first.exitCode, EXIT.completed, JSON.stringify(first.summary ?? first.thrown));
    const sessionId = first.summary.sessionId;
    env.fake.setProjections(sessionId, {
      modelSelection: { lastUsed: { ...env.fake.model }, next: { ...env.fake.model } },
    });
    const projectWorkspace = [...env.fake.workspaces.values()].find((workspace) => sameWorkspacePath(workspace.path, canonical));
    assert.ok(projectWorkspace !== undefined);
    let promptCalls = 0;
    const originalPrompt = env.fake.ctx.sessionController.prompt;
    env.fake.ctx.sessionController.prompt = async (...args) => {
      promptCalls += 1;
      return originalPrompt(...args);
    };

    const contLog = join(env.dir, 'cont-derive.log');
    const cont = await run(env, { workspace: undefined, sessionId, logFile: contLog, waitMs: 5000 });
    assert.equal(cont.exitCode, EXIT.completed, JSON.stringify(cont.summary ?? cont.thrown));
    assert.equal(cont.summary.workspaceSource, 'session');
    assert.equal(cont.summary.workspacePath, canonical);
    assert.equal(promptCalls, 1);
    assert.equal(env.fake.sessions.get(sessionId).workspaceId, projectWorkspace.id);

    const otherProject = join(env.dir, 'other-project');
    await mkdir(otherProject);
    const mismatchLog = join(env.dir, 'cont-mismatch.log');
    const mismatch = await run(env, { workspace: otherProject, sessionId, logFile: mismatchLog });
    assert.equal(mismatch.thrown instanceof DispatchError, true);
    assert.equal(mismatch.thrown.code, 'workspace_path_mismatch');
    assert.equal(promptCalls, 1, 'a mismatched explicit project must be rejected before continue_task');
    assert.equal(env.fake.sessions.get(sessionId).workspaceId, projectWorkspace.id, 'the session is never rehomed');
    const mismatchState = JSON.parse(await readFile(`${mismatchLog}.state.json`, 'utf8'));
    assert.equal(mismatchState.phase, 'preparing');
    assert.equal(mismatchState.sessionId, sessionId);
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: prepared default request resumed after the default changed fails before submit_task', async () => {
  const env = await makeEnv({ realDefaultWorkspace: true, onPrompt: completeOnPrompt('DEFAULT-RESUME-OK') });
  try {
    await writeFile(env.taskFile, 'prepared default task');
    let failOnce = true;
    const originalPrompt = env.fake.ctx.sessionController.prompt;
    env.fake.ctx.sessionController.prompt = async (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('simulated network loss before default admission');
      }
      return originalPrompt(...args);
    };
    const first = await run(env, { workspace: undefined });
    assert.equal(first.thrown instanceof DispatchError, true);
    assert.equal(first.thrown.code, 'prompt_failed');
    const stateFile = `${env.logFile}.state.json`;
    const prepared = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.workspaceSource, 'default');
    assert.equal(prepared.workspacePath, await canonicalDirectoryPath(env.defaultWorkspacePath));

    const otherDefault = join(env.dir, 'other-default');
    await mkdir(otherDefault);
    env.fake.workspace.path = otherDefault;
    let submitCalls = 0;
    const originalSubmit = env.adapter.submitTask;
    env.adapter.submitTask = async (args) => {
      submitCalls += 1;
      return originalSubmit(args);
    };
    const resumeLog = join(env.dir, 'default-changed.log');
    const resumed = await run(env, { workspace: undefined, resumeState: stateFile, logFile: resumeLog });
    assert.equal(resumed.thrown instanceof DispatchError, true);
    assert.equal(resumed.thrown.code, 'default_workspace_changed');
    assert.equal(submitCalls, 0, 'a changed default must be refused before submit_task');
    const after = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(after.phase, 'prepared');
    assert.equal(after.workspacePath, prepared.workspacePath);
    assert.equal(env.fake.calls.some((call) => call.operation === 'prompt'), false);
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: offline terminal resume keeps the stored target and refuses an explicit redirect', async () => {
  const env = await makeEnv({ realDefaultWorkspace: true, onPrompt: completeOnPrompt('DEFAULT-CACHE-OK') });
  try {
    await writeFile(env.taskFile, 'offline cache task');
    const first = await run(env, { workspace: undefined });
    assert.equal(first.exitCode, EXIT.completed, JSON.stringify(first.summary ?? first.thrown));
    const stateFile = `${env.logFile}.state.json`;
    const terminal = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(terminal.phase, 'terminal');
    assert.equal(terminal.workspaceSource, 'default');

    let promptCalls = 0;
    const originalPrompt = env.fake.ctx.sessionController.prompt;
    env.fake.ctx.sessionController.prompt = async (...args) => {
      promptCalls += 1;
      return originalPrompt(...args);
    };
    const otherDefault = join(env.dir, 'other-default');
    await mkdir(otherDefault);
    env.fake.workspace.path = otherDefault;
    const resumed = await run(env, { workspace: undefined, resumeState: stateFile, logFile: join(env.dir, 'offline-resume.log') });
    assert.equal(resumed.exitCode, EXIT.completed, JSON.stringify(resumed.summary ?? resumed.thrown));
    assert.equal(resumed.summary.resumedTerminalState, true);
    assert.equal(resumed.summary.requestId, terminal.requestId);
    assert.equal(resumed.summary.workspacePath, terminal.workspacePath);
    assert.equal(resumed.summary.workspaceSource, 'default');
    assert.equal(promptCalls, 0, 'the offline cache must not dispatch or consult the changed default');
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).workspacePath, terminal.workspacePath);

    const redirect = await run(env, {
      workspace: env.project,
      resumeState: stateFile,
      logFile: join(env.dir, 'redirect.log'),
    });
    assert.equal(redirect.thrown instanceof DispatchError, true);
    assert.equal(redirect.thrown.code, 'resume_workspace_mismatch');
    assert.equal(promptCalls, 0);
  } finally {
    await env.cleanup();
  }
});

test('workspace routing: invalid default diagnostics, unreachable bridge, and invalid explicit paths fail clearly before state or admission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-routing-errors-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  const workspacesFile = join(dir, 'workspaces.json');
  const taskFile = join(dir, 'task.md');
  await writeFile(taskFile, 'routing error task');
  const env = { DSH_HOME: join(dir, '.dsh') };
  let listener = null;
  const makeStub = (workspace) => {
    const state = { submits: 0 };
    const adapter = {
      diagnostics: () => ({
        ok: true,
        bridge: { protocol: BRIDGE_PROTOCOL, version: BRIDGE_VERSION, workspacePath: true, standardMode: true },
        model: { configured: null, matchesRequired: true },
        workspace,
      }),
      listSessions: async () => ({ ok: true, items: [] }),
      submitTask: async () => {
        state.submits += 1;
        return { ok: true, sessionId: 'stub-session', workspaceId: 'stub-workspace', workspacePath: 'stub-path' };
      },
      getTask: async () => ({
        ok: true,
        items: [],
        cursor: { seq: -1, offset: 0 },
        hasMore: false,
        latestSeq: -1,
        status: { state: 'unknown', running: false, success: false, completion: null },
        pendingAction: { pending: false },
        workspaceId: 'stub-workspace',
        workspacePath: 'stub-path',
      }),
      continueTask: async () => ({ ok: true, sessionId: 'stub-session', workspaceId: 'stub-workspace', workspacePath: 'stub-path' }),
      cancelTask: async () => ({ ok: true, sessionId: 'stub-session', cancelRequested: true }),
    };
    return { state, adapter };
  };
  try {
    // Missing default workspace diagnostic.
    let stub = makeStub(null);
    listener = await startHttpServer({ adapter: stub.adapter, token: TOKEN, port: 0 });
    let url = `http://127.0.0.1:${listener.port}/mcp`;
    let logFile = join(dir, 'missing-default.log');
    const missing = await runDispatch({ taskFile, logFile, url, tokenFile, workspacesFile, env }).catch((error) => ({ thrown: error }));
    assert.equal(missing.thrown instanceof DispatchError, true);
    assert.equal(missing.thrown.code, 'default_workspace_unavailable');
    assert.equal(stub.state.submits, 0);
    await assert.rejects(readFile(`${logFile}.state.json`), { code: 'ENOENT' });

    // Default diagnostic path that is not an existing usable directory.
    await listener.close();
    stub = makeStub({ id: 'stub-default', path: join(dir, 'missing-default-dir') });
    listener = await startHttpServer({ adapter: stub.adapter, token: TOKEN, port: 0 });
    url = `http://127.0.0.1:${listener.port}/mcp`;
    logFile = join(dir, 'invalid-default.log');
    const invalid = await runDispatch({ taskFile, logFile, url, tokenFile, workspacesFile, env }).catch((error) => ({ thrown: error }));
    assert.equal(invalid.thrown instanceof DispatchError, true);
    assert.equal(invalid.thrown.code, 'default_workspace_invalid');
    assert.equal(stub.state.submits, 0);
    await assert.rejects(readFile(`${logFile}.state.json`), { code: 'ENOENT' });

    // Unreachable bridge: no state, no fallback to cwd.
    const unreachable = await runDispatch({
      taskFile,
      logFile: join(dir, 'unreachable.log'),
      url: 'http://127.0.0.1:1/mcp',
      tokenFile,
      workspacesFile,
      env,
    }).catch((error) => ({ thrown: error }));
    assert.equal(unreachable.thrown instanceof DispatchError, true);
    assert.equal(unreachable.thrown.code, 'desktop_unreachable');
    await assert.rejects(readFile(join(dir, 'unreachable.log.state.json')), { code: 'ENOENT' });

    // Unusable explicit project directory.
    const invalidExplicit = await runDispatch({
      taskFile,
      workspace: join(dir, 'missing-project'),
      logFile: join(dir, 'invalid-explicit.log'),
      url,
      tokenFile,
      workspacesFile,
      env,
    }).catch((error) => ({ thrown: error }));
    assert.equal(invalidExplicit.thrown instanceof DispatchError, true);
    assert.equal(invalidExplicit.thrown.code, 'workspace_path_not_found');
    await assert.rejects(readFile(join(dir, 'invalid-explicit.log.state.json')), { code: 'ENOENT' });

    assert.equal((await readWorkspaceAllowlist({ file: workspacesFile })).entries.length, 0);
    // Omitted --workspace is the default target; a bare flag is a usage error.
    assert.equal(parseDispatchArgs([]).workspace, undefined);
    assert.throws(() => parseDispatchArgs(['--workspace']), { code: 'usage' });
    assert.equal(parseDispatchArgs(['--workspace', dir]).workspace, dir);
  } finally {
    if (listener !== null) await listener.close();
    await rm(dir, { recursive: true, force: true });
  }
});
