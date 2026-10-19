import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createDesktopAdapter } from '../src/adapter.js';
import { bearerFromHeader, tokenMatches } from '../src/auth.js';
import { createAdmissionLedger } from '../src/ledger.js';
import {
  MAX_TITLE_CHARS,
  readToken,
  resolveConfig,
  resolveTokenFile,
} from '../src/config.js';
import { inject } from '../src/plugin.js';
import { makeHarness } from './helpers.js';

const LONG_TEXT = `${'A'.repeat(9000)}-TAIL`;

test('auth: bearer parsing and constant-time token comparison', () => {
  assert.equal(bearerFromHeader('Bearer abc'), 'abc');
  assert.equal(bearerFromHeader('bearer   abc  '), 'abc');
  assert.equal(bearerFromHeader('Basic abc'), undefined);
  assert.equal(bearerFromHeader(undefined), undefined);
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('', 'abc'), false);
  assert.equal(tokenMatches('abc', ''), false);
});

test('config: token path defaults, absolute path, cwd-relative path, and required dependencies', () => {
  assert.equal(resolveTokenFile({}, { DSH_HOME: 'C:/fake/home' }), join('C:/fake/home', 'desktop-mcp', 'token'));
  assert.equal(resolveTokenFile({ tokenFile: 'C:/private/mcp-token' }, {}), resolve('C:/private/mcp-token'));
  assert.equal(resolveTokenFile({ tokenFile: 'relative/token' }, {}), resolve('relative/token'));
  assert.throws(() => resolveTokenFile({ tokenFile: '   ' }, {}), /non-empty path/i);
  assert.deepEqual(inject, ['sessionController', 'workspaceRegistry', 'agentDefaultModel', 'sessionQuery', 'agents']);
});

test('config: missing, empty, and short tokens fail closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-token-'));
  try {
    await assert.rejects(readToken({ tokenFile: join(dir, 'missing') }), /unavailable/i);
    await writeFile(join(dir, 'empty'), '  \n');
    await assert.rejects(readToken({ tokenFile: join(dir, 'empty') }), /empty/i);
    await writeFile(join(dir, 'short'), 'short-token');
    await assert.rejects(readToken({ tokenFile: join(dir, 'short') }), /at least/i);
    await writeFile(join(dir, 'valid'), `${'x'.repeat(40)}\n`);
    const value = await readToken({ tokenFile: join(dir, 'valid') });
    assert.equal(value.token.length, 40);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('config: workspace default and loopback bind', () => {
  const config = resolveConfig({});
  assert.equal(config.workspaceId, '3261eb3a-9083-4ce6-b18f-89cb7e6d1746');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 47821);
  assert.throws(() => resolveConfig({ host: '0.0.0.0' }), /fixed to 127\.0\.0\.1/);
  assert.throws(() => resolveConfig({ port: 0 }), /1 to 65535/);
});

test('list_sessions: workspace/archive fence and bounded metadata', async () => {
  const harness = await makeHarness();
  try {
    const result = await harness.adapter.listSessions(1);
    assert.equal(result.ok, true);
    assert.equal(result.total, 2);
    assert.equal(result.limit, 1);
    assert.equal(result.hasMore, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].sessionId, 'fake-session-a');
    assert.equal(harness.fake.calls.some((call) => call.operation === 'observeSession'), false);
  } finally {
    await harness.cleanup();
  }
});

test('list_sessions: malformed membership/controller result stays structured failure', async () => {
  const harness = await makeHarness();
  try {
    harness.fake.ctx.sessionController.list = async () => ({ items: null });
    const malformed = await harness.adapter.listSessions(20);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error.code, 'controller_list_malformed');

    harness.fake.ctx.sessionController.list = async () => ({
      items: [{ sessionId: 'fake-session-a', updatedAt: 1, running: false, agentAvailable: true, projections: { values: { title: 'x' } } }],
    });
    Object.defineProperty(harness.fake.workspace, 'sessionIds', {
      configurable: true,
      get() {
        throw new Error('fake membership failure');
      },
    });
    const membership = await harness.adapter.listSessions(20);
    assert.equal(membership.ok, false);
    assert.equal(membership.error.code, 'workspace_session_membership_failed');
  } finally {
    await harness.cleanup();
  }
});

test('submit_task: admits, returns actual id, is idempotent, and stores no task text', async () => {
  const harness = await makeHarness({
    onPrompt: async ({ raw }) => {
      raw.append('turn/start', { turn: 1 });
      raw.append('request/header', {
        header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } },
        reason: 'initial',
      });
      raw.append('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'PONG' }] } });
      raw.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    },
  });
  try {
    const first = await harness.adapter.submitTask({ requestId: 'req-1', task: 'Reply PONG with secret-text-not-to-persist' });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.admitted, true);
    assert.equal(first.completion, false);
    assert.match(first.sessionId, /^fake-created-/);
    assert.equal(first.admission, 'accepted');

    const second = await harness.adapter.submitTask({ requestId: 'req-1', task: 'Reply PONG with secret-text-not-to-persist' });
    assert.equal(second.ok, true);
    assert.equal(second.admission, 'already_admitted');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt').length, 1);

    const persisted = await readFile(harness.stateFile, 'utf8');
    assert.equal(persisted.includes('secret-text-not-to-persist'), false);
    assert.equal(persisted.includes(first.sessionId), true);
  } finally {
    await harness.cleanup();
  }
});

test('submit_task: reused request id with different input is rejected', async () => {
  const harness = await makeHarness();
  try {
    assert.equal((await harness.adapter.submitTask({ requestId: 'same', task: 'first' })).ok, true);
    const conflict = await harness.adapter.submitTask({ requestId: 'same', task: 'second' });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, 'request_id_conflict');
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('submit_task: concurrent duplicate request admits exactly once', async () => {
  const harness = await makeHarness();
  try {
    const [left, right] = await Promise.all([
      harness.adapter.submitTask({ requestId: 'race', task: 'one task' }),
      harness.adapter.submitTask({ requestId: 'race', task: 'one task' }),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(left.sessionId, right.sessionId);
    assert.deepEqual(new Set([left.admission, right.admission]), new Set(['accepted', 'already_admitted']));
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('submit_task: prompt failure remains retryable with the same admitted session', async () => {
  let fail = true;
  const harness = await makeHarness({
    onPrompt: async () => {
      if (fail) {
        fail = false;
        throw new Error('synthetic prompt failure');
      }
    },
  });
  try {
    const first = await harness.adapter.submitTask({ requestId: 'retry', task: 'retry me' });
    assert.equal(first.ok, false);
    assert.equal(first.error.code, 'prompt_failed');
    const persisted = await readFile(harness.stateFile, 'utf8');
    assert.equal(persisted.includes('"phase": "prepared"'), true);

    const second = await harness.adapter.submitTask({ requestId: 'retry', task: 'retry me' });
    assert.equal(second.ok, true);
    assert.equal(second.admission, 'accepted');
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'create').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('submit_task: reload with the same state file deduplicates', async () => {
  const harness = await makeHarness();
  try {
    const first = await harness.adapter.submitTask({ requestId: 'reload', task: 'reload task' });
    assert.equal(first.ok, true);
    const reloaded = createDesktopAdapter({
      sessionController: harness.fake.ctx.sessionController,
      workspaceRegistry: harness.fake.ctx.workspaceRegistry,
      sessionQuery: harness.fake.ctx.sessionQuery,
      agents: harness.fake.ctx.agents,
      agentDefaultModel: harness.fake.ctx.agentDefaultModel,
      workspaceId: harness.fake.workspaceId,
      stateFile: harness.stateFile,
      getProfileContext: () => ({ name: 'desktop' }),
      env: {},
    });
    const second = await reloaded.submitTask({ requestId: 'reload', task: 'reload task' });
    assert.equal(second.ok, true);
    assert.equal(second.admission, 'already_admitted');
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt').length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('ledger: arbitrary own request-id keys survive retry and reload; ordinary constructor remains valid', async () => {
  const special = await makeHarness();
  try {
    const first = await special.adapter.submitTask({ requestId: '__proto__', task: 'proto task' });
    assert.equal(first.ok, true);
    const retry = await special.adapter.submitTask({ requestId: '__proto__', task: 'proto task' });
    assert.equal(retry.ok, true);
    assert.equal(retry.admission, 'already_admitted');
    assert.equal(retry.sessionId, first.sessionId);

    const reloaded = createDesktopAdapter({
      sessionController: special.fake.ctx.sessionController,
      workspaceRegistry: special.fake.ctx.workspaceRegistry,
      sessionQuery: special.fake.ctx.sessionQuery,
      agents: special.fake.ctx.agents,
      agentDefaultModel: special.fake.ctx.agentDefaultModel,
      workspaceId: special.fake.workspaceId,
      stateFile: special.stateFile,
      getProfileContext: () => ({ name: 'desktop' }),
      env: {},
    });
    const afterReload = await reloaded.submitTask({ requestId: '__proto__', task: 'proto task' });
    assert.equal(afterReload.ok, true);
    assert.equal(afterReload.admission, 'already_admitted');
    assert.equal(afterReload.sessionId, first.sessionId);
    assert.equal(special.fake.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(special.fake.calls.filter((call) => call.operation === 'prompt').length, 1);

    const persisted = JSON.parse(await readFile(special.stateFile, 'utf8'));
    assert.equal(Object.hasOwn(persisted.entries, '__proto__'), true);
    assert.equal(persisted.entries.__proto__.sessionId, first.sessionId);
  } finally {
    await special.cleanup();
  }

  const control = await makeHarness();
  try {
    const first = await control.adapter.submitTask({ requestId: 'constructor', task: 'control task' });
    const retry = await control.adapter.submitTask({ requestId: 'constructor', task: 'control task' });
    assert.equal(first.ok, true);
    assert.equal(retry.ok, true);
    assert.equal(retry.admission, 'already_admitted');
    assert.equal(retry.sessionId, first.sessionId);
  } finally {
    await control.cleanup();
  }
});

test('ledger: corrupt state fails new admissions closed without overwriting state', async () => {
  const harness = await makeHarness();
  try {
    const corrupt = '{"version":1,"entries":null}\n';
    await writeFile(harness.stateFile, corrupt, 'utf8');
    const result = await harness.adapter.submitTask({ requestId: 'corrupt', task: 'must not run' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'admission_state_corrupt');
    assert.equal(harness.fake.calls.some((call) => call.operation === 'prompt'), false);
    assert.equal(await readFile(harness.stateFile, 'utf8'), corrupt);
  } finally {
    await harness.cleanup();
  }
});

test('ledger: failed replacement fails closed on retry and admits exactly once after recovery (Windows read-only target)', { skip: process.platform !== 'win32' }, async () => {
  const harness = await makeHarness();
  try {
    const first = await harness.adapter.submitTask({ requestId: 'good', task: 'first' });
    assert.equal(first.ok, true);
    const before = await readFile(harness.stateFile, 'utf8');
    const blockedPrompts = () => harness.fake.calls.filter((call) => call.operation === 'prompt' && call.requestId === 'blocked').length;
    await chmod(harness.stateFile, 0o444);

    const second = await harness.adapter.submitTask({ requestId: 'blocked', task: 'second' });
    assert.equal(second.ok, false);
    assert.equal(second.error.code, 'admission_state_write_failed');
    assert.equal(blockedPrompts(), 0);
    assert.equal(await readFile(harness.stateFile, 'utf8'), before);

    // Same adapter, same request id, storage still unwritable: the in-memory
    // prepared entry must not be prompted and must not be treated as durable.
    const retryWhileClosed = await harness.adapter.submitTask({ requestId: 'blocked', task: 'second' });
    assert.equal(retryWhileClosed.ok, false);
    assert.equal(retryWhileClosed.error.code, 'admission_state_write_failed');
    assert.equal(blockedPrompts(), 0);
    assert.equal(await readFile(harness.stateFile, 'utf8'), before);
    assert.equal((await readdir(harness.dir)).some((name) => name.includes('.tmp-')), false);

    // Recover storage, reload, and retry. Exactly one actual blocked task is
    // admitted; a further retry is the durable already_admitted path.
    await chmod(harness.stateFile, 0o644);
    const reloaded = createDesktopAdapter({
      sessionController: harness.fake.ctx.sessionController,
      workspaceRegistry: harness.fake.ctx.workspaceRegistry,
      sessionQuery: harness.fake.ctx.sessionQuery,
      agents: harness.fake.ctx.agents,
      agentDefaultModel: harness.fake.ctx.agentDefaultModel,
      workspaceId: harness.fake.workspaceId,
      stateFile: harness.stateFile,
      getProfileContext: () => ({ name: 'desktop' }),
      env: {},
    });
    const recovered = await reloaded.submitTask({ requestId: 'blocked', task: 'second' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.admission, 'accepted');
    assert.equal(blockedPrompts(), 1);
    const repeated = await reloaded.submitTask({ requestId: 'blocked', task: 'second' });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.admission, 'already_admitted');
    assert.equal(repeated.sessionId, recovered.sessionId);
    assert.equal(blockedPrompts(), 1);
  } finally {
    await chmod(harness.stateFile, 0o644).catch(() => {});
    await harness.cleanup();
  }
});

test('get_task: transient error becomes historical when a later queued turn starts running (actual next-offset equality)', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-history-running',
      title: 'History while running',
      status: 'running',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'first' }], source: { kind: 'user', rpcId: 'first' } }, seq: 1, time: 2 },
      ],
    });

    // Captured seq is the next-free offset 2; turn 1 closes at durable seq 2.
    harness.adapter.recordSessionError(session.id, 'provider stream failed: ECONNRESET');
    harness.fake.append(session.id, 'turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { name: 'LlmError', code: 'ECONNRESET', message: 'provider stream failed' } },
    });
    harness.fake.append(session.id, 'turn/start', { turn: 2 });
    harness.fake.append(session.id, 'assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'still running' }] },
    });
    harness.fake.setStatus(session.id, 'running');

    const running = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(running.ok, true);
    assert.equal(running.status.state, 'running');
    assert.equal(running.errors.some((entry) => entry.message.includes('ECONNRESET')), false);
    const old = running.historicalErrors.find((entry) => entry.message.includes('ECONNRESET'));
    assert.equal(old?.historical, true);
    assert.deepEqual(old?.anchor, { kind: 'current-turn-start', seq: 3 });

    // A current error inside the running turn remains current until that turn closes.
    harness.adapter.recordSessionError(session.id, 'current turn failure');
    const current = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(current.errors.some((entry) => entry.message === 'current turn failure'), true);
    assert.equal(current.historicalErrors.some((entry) => entry.message.includes('ECONNRESET')), true);

    harness.fake.append(session.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    harness.fake.setStatus(session.id, 'idle');
    const completed = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(completed.status.state, 'finished');
    assert.equal(completed.errors.some((entry) => entry.message === 'current turn failure'), false);
    assert.equal(completed.historicalErrors.some((entry) => entry.message === 'current turn failure'), true);

    // An error after the current terminal remains current, not historical.
    harness.adapter.recordSessionError(session.id, 'post-terminal error');
    const post = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(post.errors.some((entry) => entry.message === 'post-terminal error'), true);
    assert.equal(post.historicalErrors.some((entry) => entry.message.includes('ECONNRESET')), true);
  } finally {
    await harness.cleanup();
  }
});

test('get_task: stale transient error is historical after a later completed turn, while a current error stays visible', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-stale',
      title: 'Stale transient',
      status: 'running',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'first' }], source: { kind: 'user', rpcId: 'first' } }, seq: 1, time: 2 },
      ],
    });
    const admitted = await harness.adapter.continueTask({
      sessionId: session.id,
      requestId: 'queued-1',
      text: 'queued follow-up',
      mode: 'followup',
    });
    assert.equal(admitted.ok, true, JSON.stringify(admitted));

    harness.adapter.recordSessionError(session.id, 'provider stream failed: ECONNRESET');
    harness.fake.append(session.id, 'turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { name: 'LlmError', code: 'ECONNRESET', message: 'provider stream failed' } },
    });
    harness.fake.append(session.id, 'turn/start', { turn: 2 });
    harness.fake.append(session.id, 'assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'QUEUED-FOLLOWUP-SURVIVED' }] },
    });
    harness.fake.append(session.id, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
    harness.fake.setStatus(session.id, 'idle');

    const historical = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(historical.ok, true);
    assert.equal(historical.status.state, 'finished');
    assert.equal(historical.status.success, true);
    assert.equal(historical.errors.some((entry) => entry.source === 'transient' && entry.message.includes('ECONNRESET')), false);
    assert.equal(historical.historicalErrors.some((entry) => entry.historical === true && entry.message.includes('ECONNRESET')), true);

    harness.adapter.recordSessionError(session.id, 'new current failure');
    const current = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(current.errors.some((entry) => entry.source === 'transient' && entry.message === 'new current failure'), true);
    assert.equal(current.historicalErrors.some((entry) => entry.message.includes('ECONNRESET')), true);
  } finally {
    await harness.cleanup();
  }
});

test('foreign session is denied for get/continue/cancel despite valid workspace path', async () => {
  const harness = await makeHarness();
  try {
    const foreign = 'fake-session-other-workspace';
    for (const result of [
      await harness.adapter.getTask({ sessionId: foreign }),
      await harness.adapter.continueTask({ sessionId: foreign, requestId: 'foreign-1', text: 'x' }),
      await harness.adapter.cancelTask({ sessionId: foreign }),
    ]) {
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'session_not_authorized');
    }
    assert.equal(harness.fake.calls.some((call) => call.operation === 'prompt' && call.sessionId === foreign), false);
    assert.equal(harness.fake.calls.some((call) => call.operation === 'cancel' && call.sessionId === foreign), false);
  } finally {
    await harness.cleanup();
  }
});

test('model mismatch rejects submission before prompt and never calls selectModel', async () => {
  const harness = await makeHarness({ model: { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'high' } });
  try {
    const result = await harness.adapter.submitTask({ requestId: 'route', task: 'do not run' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'model_route_mismatch');
    assert.equal(harness.fake.calls.some((call) => call.operation === 'prompt'), false);
    assert.equal(harness.fake.saveSelectionCalls.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('ledger: two adapters sharing one state file admit identical request exactly once', async () => {
  const harness = await makeHarness();
  try {
    const second = createDesktopAdapter({
      sessionController: harness.fake.ctx.sessionController,
      workspaceRegistry: harness.fake.ctx.workspaceRegistry,
      sessionQuery: harness.fake.ctx.sessionQuery,
      agents: harness.fake.ctx.agents,
      agentDefaultModel: harness.fake.ctx.agentDefaultModel,
      workspaceId: harness.fake.workspaceId,
      stateFile: harness.stateFile,
      getProfileContext: () => ({ name: 'desktop' }),
      env: {},
    });
    const [left, right] = await Promise.all([
      harness.adapter.submitTask({ requestId: 'shared-race', task: 'same task' }),
      second.submitTask({ requestId: 'shared-race', task: 'same task' }),
    ]);
    assert.equal(left.ok, true, JSON.stringify(left));
    assert.equal(right.ok, true, JSON.stringify(right));
    assert.equal(left.sessionId, right.sessionId);
    assert.deepEqual(new Set([left.admission, right.admission]), new Set(['accepted', 'already_admitted']));
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'create').length, 1);
    assert.equal(harness.fake.calls.filter((call) => call.operation === 'prompt').length, 1);
    assert.equal((await readdir(harness.dir)).includes('admissions.json.lock'), false);
  } finally {
    await harness.cleanup();
  }
});

test('ledger: held lock fails closed with state_locked and does not remove the owner lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-lock-'));
  const stateFile = join(dir, 'admissions.json');
  const lockFile = `${stateFile}.lock`;
  try {
    const lock = JSON.stringify({ pid: 999999, nonce: 'other-owner', createdAt: new Date().toISOString() });
    await writeFile(lockFile, `${lock}\n`, 'utf8');
    const ledger = createAdmissionLedger(stateFile, { lockWaitMs: 40, lockPollMs: 10 });
    let called = false;
    await assert.rejects(
      ledger.transaction(async () => { called = true; }),
      (error) => error?.code === 'state_locked' && /pid 999999/.test(error.message),
    );
    assert.equal(called, false);
    assert.equal(await readFile(lockFile, 'utf8'), `${lock}\n`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('get_task: maxChars 60000 always progresses and reassembles escaped/astral text exactly', async () => {
  const harness = await makeHarness();
  try {
    const text = `${'A'.repeat(50000)}${'\\'.repeat(10000)}${'😀'.repeat(100)}-TAIL`;
    const session = harness.fake.addSession({
      sessionId: 'fake-ceiling',
      title: 'Ceiling',
      modelSelection: { lastUsed: { ...harness.fake.model }, next: { ...harness.fake.model } },
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, seq: 1, time: 2 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 2, time: 3 },
      ],
    });
    let cursor = { seq: 1, offset: 0 };
    let visible = '';
    let pages = 0;
    let first = null;
    let last = null;
    do {
      last = await harness.adapter.getTask({ sessionId: session.id, cursor, maxChars: 60000, maxEvents: 1 });
      assert.equal(last.ok, true, JSON.stringify(last));
      if (first === null) first = last;
      const assistant = last.items.find((item) => item.type === 'assistant_message');
      if (assistant !== undefined) visible += assistant.text;
      cursor = last.cursor;
      pages += 1;
      assert.ok(pages < 20, 'ceiling cursor should converge');
    } while (last.hasMore);
    assert.equal(first.items.length > 0, true);
    assert.equal(first.hasMore, true);
    assert.notDeepEqual(first.cursor, { seq: 1, offset: 0 });
    assert.equal(visible, text);
    assert.equal(last.status.state, 'finished');
  } finally {
    await harness.cleanup();
  }
});

test('get_task: legacy ask_user_question pending is inferred only for the open turn; result or turn end clears it', async () => {
  const harness = await makeHarness();
  try {
    const args = JSON.stringify({
      questions: [{ id: 'pick', question: 'Choose one', header: 'Pick', options: [{ label: '甲' }, { label: '乙' }] }],
    });
    const base = [
      { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
      { type: 'tool/call', data: { callId: 'call-q', name: 'ask_user_question', arguments: args }, seq: 1, time: 2 },
    ];
    const pending = harness.fake.addSession({
      sessionId: 'fake-legacy-pending',
      status: 'running',
      events: base,
    });
    const pendingView = await harness.adapter.getTask({ sessionId: pending.id });
    assert.equal(pendingView.pendingAction.pending, true);
    assert.equal(pendingView.pendingAction.questions.active.length, 1);
    assert.equal(pendingView.pendingAction.questions.active[0].source, 'legacy-tool-call');
    assert.equal(pendingView.pendingAction.questions.active[0].questions[0].id, 'pick');
    assert.equal(pendingView.pendingAction.questions.active[0].questions[0].options.length, 2);

    const resolved = harness.fake.addSession({
      sessionId: 'fake-legacy-resolved',
      status: 'running',
      events: [
        ...base,
        { type: 'tool/result', data: { message: { toolCallId: 'call-q', content: [{ type: 'text', text: 'answered' }] } }, seq: 2, time: 3 },
      ],
    });
    const resolvedView = await harness.adapter.getTask({ sessionId: resolved.id });
    assert.equal(resolvedView.pendingAction.pending, false);
    assert.equal(resolvedView.pendingAction.questions.active.length, 0);

    const canceled = harness.fake.addSession({
      sessionId: 'fake-legacy-canceled',
      status: 'idle',
      events: [
        ...base,
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, seq: 2, time: 3 },
      ],
    });
    const canceledView = await harness.adapter.getTask({ sessionId: canceled.id });
    assert.equal(canceledView.status.state, 'canceled');
    assert.equal(canceledView.pendingAction.pending, false);
    assert.equal(canceledView.pendingAction.questions.active.length, 0);
  } finally {
    await harness.cleanup();
  }
});

test('get_task: bounded cursor preserves a large message remainder with no skipped text', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-large',
      title: 'Large output',
      modelSelection: { lastUsed: { ...harness.fake.model }, next: { ...harness.fake.model } },
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'go' }], source: { kind: 'user', rpcId: 'large' } }, seq: 1, time: 2 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: LONG_TEXT }] } }, seq: 2, time: 3 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 3, time: 4 },
      ],
    });
    let cursor;
    let visible = '';
    let pages = 0;
    let last;
    do {
      last = await harness.adapter.getTask({ sessionId: session.id, cursor, maxChars: 1000, maxEvents: 20 });
      assert.equal(last.ok, true, JSON.stringify(last));
      for (const item of last.items) if (item.type === 'assistant_message') visible += item.text;
      cursor = last.cursor;
      pages += 1;
      assert.ok(pages < 30, 'cursor should converge');
    } while (last.hasMore);
    assert.equal(visible, LONG_TEXT);
    assert.equal(last.status.state, 'finished');
    assert.equal(last.status.success, true);
    assert.equal(last.items.some((item) => item.type === 'turn_end'), true);
  } finally {
    await harness.cleanup();
  }
});

test('get_task: genuine kind=user messages are public; injected runtime-context and skill-catalog sources are omitted', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-source-filter',
      title: 'Source filter',
      modelSelection: { lastUsed: { ...harness.fake.model }, next: { ...harness.fake.model } },
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        {
          type: 'request/header',
          data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' } }, reason: 'initial' },
          seq: 1,
          time: 2,
        },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'INJECTED-RUNTIME-CONTEXT' }], source: { kind: 'runtime-context', form: 'snapshot', sections: ['work'] } },
          seq: 2,
          time: 3,
        },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'INJECTED-SKILL-CATALOG' }], source: { kind: 'system-prompt' } },
          seq: 3,
          time: 4,
        },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'INJECTED-OTHER-SOURCE' }], source: { kind: 'working-directory' } },
          seq: 4,
          time: 5,
        },
        {
          type: 'user/message',
          data: { content: [{ type: 'text', text: 'real controller prompt' }], source: { kind: 'user', rpcId: 'req-genuine' } },
          seq: 5,
          time: 6,
        },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'real assistant answer' }] } },
          seq: 6,
          time: 7,
        },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 7, time: 8 },
      ],
    });
    const view = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    const users = view.items.filter((item) => item.type === 'user_message');
    assert.equal(users.length, 1);
    assert.deepEqual(users[0], {
      seq: 5,
      time: 6,
      type: 'user_message',
      text: 'real controller prompt',
      meta: { sourceKind: 'user', requestId: 'req-genuine' },
    });
    const serialized = JSON.stringify(view.items);
    for (const leaked of ['INJECTED-RUNTIME-CONTEXT', 'INJECTED-SKILL-CATALOG', 'INJECTED-OTHER-SOURCE']) {
      assert.equal(serialized.includes(leaked), false);
    }
    // Filtering is projection-only: the raw events still drive route and status.
    assert.equal(view.modelRoute.basis, 'request-header');
    assert.equal(view.modelRoute.actual.provider, 'deepseek-official');
    assert.equal(view.status.state, 'finished');
    assert.equal(view.status.success, true);
    assert.equal(view.latestSeq, 7);
  } finally {
    await harness.cleanup();
  }
});

test('get_task: genuine user text that looks like runtime context stays visible', async () => {
  const harness = await makeHarness();
  try {
    const text = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nThis is a real user message and must stay visible.';
    const session = harness.fake.addSession({
      sessionId: 'fake-lookalike',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'req-lookalike' } }, seq: 1, time: 2 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ack' }] } }, seq: 2, time: 3 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 3, time: 4 },
      ],
    });
    const view = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    const users = view.items.filter((item) => item.type === 'user_message');
    assert.equal(users.length, 1);
    assert.equal(users[0].text, text);
    assert.equal(users[0].meta.sourceKind, 'user');
    assert.equal(users[0].meta.requestId, 'req-lookalike');
  } finally {
    await harness.cleanup();
  }
});

test('get_task: missing or unknown user/message sources are omitted safely', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-unknown-source',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'NO-SOURCE' }] }, seq: 1, time: 2 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'NULL-SOURCE' }], source: null }, seq: 2, time: 3 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'STRING-SOURCE' }], source: 'user' }, seq: 3, time: 4 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'EMPTY-SOURCE' }], source: {} }, seq: 4, time: 5 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'NONSTRING-KIND' }], source: { kind: 42 } }, seq: 5, time: 6 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'UNKNOWN-KIND' }], source: { kind: 'cordis-host-runner' } }, seq: 6, time: 7 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'SAFE-USER' }], source: { kind: 'user' } }, seq: 7, time: 8 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'SAFE-ASSISTANT' }] } }, seq: 8, time: 9 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 9, time: 10 },
      ],
    });
    const view = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    const users = view.items.filter((item) => item.type === 'user_message');
    assert.equal(users.length, 1);
    assert.equal(users[0].seq, 7);
    assert.equal(users[0].text, 'SAFE-USER');
    assert.deepEqual(users[0].meta, { sourceKind: 'user' });
    const serialized = JSON.stringify(view.items);
    for (const omitted of ['NO-SOURCE', 'NULL-SOURCE', 'STRING-SOURCE', 'EMPTY-SOURCE', 'NONSTRING-KIND', 'UNKNOWN-KIND']) {
      assert.equal(serialized.includes(omitted), false);
    }
    assert.equal(view.items.some((item) => item.type === 'assistant_message' && item.text === 'SAFE-ASSISTANT'), true);
    assert.equal(view.status.state, 'finished');
  } finally {
    await harness.cleanup();
  }
});

test('get_task: real assistant text and tool results remain intact beside filtered sources', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-tool-intact',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'HIDDEN-BEFORE-TOOLS' }], source: { kind: 'runtime-context' } }, seq: 1, time: 2 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'run the file check' }], source: { kind: 'user', rpcId: 'req-tools' } }, seq: 2, time: 3 },
        { type: 'assistant/message', data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'I will run it.' }] } }, seq: 3, time: 4 },
        { type: 'tool/call', data: { callId: 'call-fs', name: 'read' }, seq: 4, time: 5 },
        {
          type: 'tool/result',
          data: {
            message: { toolCallId: 'call-fs', content: [{ type: 'text', text: 'ENOENT: no such file or directory' }], isError: true },
            error: { name: 'ToolError', code: 'FS_NOT_FOUND', message: 'no such file or directory' },
          },
          seq: 5,
          time: 6,
        },
        { type: 'assistant/message', data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'The read failed.' }] } }, seq: 6, time: 7 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 7, time: 8 },
      ],
    });
    const view = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    assert.deepEqual(
      view.items.filter((item) => item.type === 'assistant_message').map((item) => item.text),
      ['I will run it.', 'The read failed.'],
    );
    const call = view.items.find((item) => item.type === 'tool_call');
    assert.equal(call.meta.name, 'read');
    assert.equal(call.meta.toolCallId, 'call-fs');
    const result = view.items.find((item) => item.type === 'tool_result');
    assert.equal(result.meta.isError, true);
    assert.equal(result.meta.error.code, 'FS_NOT_FOUND');
    assert.equal(result.text, 'ENOENT: no such file or directory');
    assert.equal(view.items.some((item) => item.type === 'user_message' && item.text === 'run the file check'), true);
    assert.equal(JSON.stringify(view.items).includes('HIDDEN-BEFORE-TOOLS'), false);
    assert.equal(view.status.state, 'finished');
  } finally {
    await harness.cleanup();
  }
});

test('get_task: reasoning/tool-call-only assistant settlements are omitted; real markers stay', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-empty-assistant',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        {
          type: 'assistant/message',
          data: {
            turn: 1,
            step: 1,
            message: {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'PRIVATE-REASONING-NOT-EMITTED' },
                { type: 'tool-call', id: 'call-a', name: 'pwsh', arguments: '{}' },
              ],
            },
          },
          seq: 1,
          time: 2,
        },
        { type: 'tool/call', data: { callId: 'call-a', name: 'pwsh' }, seq: 2, time: 3 },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 2, message: { role: 'assistant', content: [] } },
          seq: 3,
          time: 4,
        },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }] } },
          seq: 4,
          time: 5,
        },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 4, message: { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', data: 'AA==' } }] } },
          seq: 5,
          time: 6,
        },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 5, message: { role: 'assistant', content: [{ type: 'file', filename: 'proof.txt' }] } },
          seq: 6,
          time: 7,
        },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 7, time: 8 },
      ],
    });
    const view = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(view.ok, true, JSON.stringify(view));
    const assistants = view.items.filter((item) => item.type === 'assistant_message');
    assert.deepEqual(assistants.map((item) => item.text), ['Visible answer', '[image]', '[file]']);
    const serialized = JSON.stringify(view.items);
    assert.equal(serialized.includes('[assistant message without text]'), false);
    assert.equal(serialized.includes('PRIVATE-REASONING-NOT-EMITTED'), false);
    assert.equal(view.items.some((item) => item.type === 'tool_call' && item.meta.name === 'pwsh'), true);
    assert.equal(view.status.state, 'finished');
  } finally {
    await harness.cleanup();
  }
});

test('get_task: a cursor at a filtered event advances to the next visible output without losing text', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-hidden-cursor',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'HIDDEN-RUNTIME' }], source: { kind: 'runtime-context' } }, seq: 1, time: 2 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'VISIBLE-USER' }], source: { kind: 'user', rpcId: 'req-cursor' } }, seq: 2, time: 3 },
        {
          type: 'assistant/message',
          data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'VISIBLE-ASSISTANT' }] } },
          seq: 3,
          time: 4,
        },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'HIDDEN-SKILL' }], source: { kind: 'skill-invocation' } }, seq: 4, time: 5 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } }, seq: 5, time: 6 },
      ],
    });
    // A cursor inside the filtered event (any offset) resumes at the next visible event.
    for (const offset of [0, 4]) {
      const first = await harness.adapter.getTask({ sessionId: session.id, cursor: { seq: 1, offset }, maxEvents: 1 });
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.deepEqual(first.items.map((item) => [item.seq, item.text]), [[2, 'VISIBLE-USER']]);
      assert.deepEqual(first.cursor, { seq: 3, offset: 0 });
      assert.equal(first.hasMore, true);
    }

    let cursor = { seq: 1, offset: 0 };
    const texts = [];
    let pages = 0;
    let last;
    do {
      last = await harness.adapter.getTask({ sessionId: session.id, cursor, maxEvents: 1 });
      assert.equal(last.ok, true, JSON.stringify(last));
      texts.push(...last.items.map((item) => item.text));
      cursor = last.cursor;
      pages += 1;
      assert.ok(pages < 10, 'hidden-event cursor should converge');
    } while (last.hasMore);
    assert.deepEqual(texts, ['VISIBLE-USER', 'VISIBLE-ASSISTANT', 'Turn 1 ended: completed']);
    assert.equal(texts.join('|').includes('HIDDEN'), false);

    // A cursor on a now-hidden trailing event advances past it instead of stalling.
    const tail = harness.fake.addSession({
      sessionId: 'fake-hidden-tail',
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'user/message', data: { content: [{ type: 'text', text: 'HIDDEN-TAIL' }], source: { kind: 'runtime-context' } }, seq: 1, time: 2 },
      ],
    });
    const advance = await harness.adapter.getTask({ sessionId: tail.id, cursor: { seq: 1, offset: 0 } });
    assert.equal(advance.ok, true, JSON.stringify(advance));
    assert.deepEqual(advance.items, []);
    assert.equal(advance.hasMore, false);
    assert.deepEqual(advance.cursor, { seq: 2, offset: 0 });
  } finally {
    await harness.cleanup();
  }
});

test('get_task: durable failure, transient error, pending question and approval are visible', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-failed',
      title: 'Failed task',
      modelSelection: { lastUsed: { ...harness.fake.model }, next: { ...harness.fake.model } },
      userQuestions: {
        active: [{ callId: 'q1', state: 'open', questions: [{ id: 'confirm', question: 'Proceed?' }] }],
        settled: [],
      },
      events: [
        { type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 },
        { type: 'approval/asked', data: { id: 'a1', toolName: 'shell', reason: 'needs approval' }, seq: 1, time: 2 },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { name: 'LlmError', code: 'bad_route', message: 'synthetic provider failure' } } }, seq: 2, time: 3 },
      ],
    });
    harness.adapter.recordSessionError(session.id, 'transient failure before admission');
    const result = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status.state, 'failed');
    assert.equal(result.status.success, false);
    assert.equal(result.errors.some((entry) => entry.source === 'turn-end' && entry.error.message === 'synthetic provider failure'), true);
    assert.equal(result.errors.some((entry) => entry.source === 'transient' && entry.message === 'transient failure before admission'), true);
    assert.equal(result.pendingAction.pending, true);
    assert.equal(result.pendingAction.questions.active.length, 1);
    assert.equal(result.pendingAction.approvals.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test('get_task: idle without terminal turn evidence is unknown, not success', async () => {
  const harness = await makeHarness();
  try {
    const session = harness.fake.addSession({
      sessionId: 'fake-idle',
      title: 'Idle no evidence',
      events: [{ type: 'turn/start', data: { turn: 1 }, seq: 0, time: 1 }],
    });
    const result = await harness.adapter.getTask({ sessionId: session.id });
    assert.equal(result.ok, true);
    assert.equal(result.status.state, 'unknown');
    assert.equal(result.status.success, false);
  } finally {
    await harness.cleanup();
  }
});

test('cancel_task: requested vs observed stop and pending inbox retention', async () => {
  const harness = await makeHarness({
    onCancel: async ({ session, raw }) => {
      raw.setStatus('idle');
      raw.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
      session.inbox.nextTurn = [{ id: 'queued', content: [{ type: 'text', text: 'queued correction' }] }];
      session.projections.values.inbox['next-turn'] = session.inbox.nextTurn;
    },
  });
  try {
    const result = await harness.adapter.cancelTask({ sessionId: 'fake-session-b' });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.cancelRequested, true);
    assert.equal(result.accepted, true);
    assert.equal(result.runningBefore, true);
    assert.equal(result.stopObserved, true);
    assert.equal(result.pendingInbox.nextTurnCount, 1);
    assert.match(result.note, /pending inbox work remains/i);
    assert.equal(harness.fake.sessions.get('fake-session-b').status, 'idle');
    assert.equal(harness.fake.sessions.get('fake-session-b').inbox.nextTurn.length, 1);
    assert.equal(harness.fake.calls.some((call) => call.operation === 'cancel' && call.sessionId === 'fake-session-b'), true);
  } finally {
    await harness.cleanup();
  }
});

test('continue_task: steer/followup selection and route rejection', async () => {
  const harness = await makeHarness();
  try {
    const running = await harness.adapter.continueTask({ sessionId: 'fake-session-b', requestId: 'c1', text: 'correction' });
    assert.equal(running.ok, true, JSON.stringify(running));
    assert.equal(running.mode, 'steer');
    const followup = await harness.adapter.continueTask({ sessionId: 'fake-session-a', requestId: 'c2', text: 'next' });
    assert.equal(followup.ok, true);
    assert.equal(followup.mode, 'followup');

    const changedFake = await makeHarness({ model: { provider: 'deepseek-account', model: 'deepseek-v4', reasoningEffort: 'high' } });
    try {
      const changed = await changedFake.adapter.continueTask({ sessionId: 'fake-session-a', requestId: 'c4', text: 'x' });
      assert.equal(changed.ok, false);
      assert.equal(changed.error.code, 'model_route_mismatch');
    } finally {
      await changedFake.cleanup();
    }
  } finally {
    await harness.cleanup();
  }
});

test('diagnostics: five capabilities, sessionQuery, and no default model save', async () => {
  const harness = await makeHarness();
  try {
    const value = harness.adapter.diagnostics();
    assert.equal(value.ok, true);
    assert.equal(value.capabilities.submit_task, 'implemented');
    assert.equal(value.capabilities.get_task, 'implemented');
    assert.equal(value.capabilities.continue_task, 'implemented');
    assert.equal(value.capabilities.cancel_task, 'implemented');
    assert.equal(value.sessionQuery.observeSession, true);
    assert.equal(value.model.matchesRequired, true);
    assert.equal(harness.fake.saveSelectionCalls.length, 0);
    assert.equal(JSON.stringify(value).includes('fake-session-a'), false);
  } finally {
    await harness.cleanup();
  }
});
