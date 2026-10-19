import assert from 'node:assert/strict';
import test from 'node:test';
import { makeHarness } from './helpers.js';
import { assertBridgeCompatible } from '../src/dispatch.js';

test('standard mode: explicit selection ignores Dudu default and preserves idempotency', async () => {
  const h = await makeHarness({ defaultAgentPreset: 'dudu' });
  try {
    const request = { requestId: 'standard-create', task: 'Read-only review' };
    const first = await h.adapter.submitTask(request);
    assert.equal(first.ok, true);
    assert.equal(first.agentPreset, 'standard');
    assert.equal((await h.adapter.getTask({ sessionId: first.sessionId })).agentPreset, 'standard');
    const again = await h.adapter.submitTask(request);
    assert.equal(again.sessionId, first.sessionId);
    assert.equal(h.fake.calls.filter(x => x.operation === 'create').length, 1);
    assert.equal(h.fake.calls.filter(x => x.operation === 'prompt').length, 1);
    assert.deepEqual(h.fake.saveSelectionCalls, []);
  } finally { await h.cleanup(); }
});

test('standard mode: reject wrong or unknown actual presets before any prompt', async () => {
  for (const preset of ['dudu', undefined]) {
    const h = await makeHarness();
    try {
      h.fake.sessions.get('fake-session-a').agentPreset = preset;
      const result = await h.adapter.continueTask({ sessionId: 'fake-session-a', requestId: 'blocked-continue', text: 'Do not execute' });
      assert.equal(result.error.code, 'agent_preset_mismatch');
      assert.equal(h.fake.calls.filter(x => x.operation === 'prompt').length, 0);
      // Read and cancel remain available; the guard does not strand existing tasks.
      assert.equal((await h.adapter.getTask({ sessionId: 'fake-session-a' })).ok, true);
      assert.equal((await h.adapter.cancelTask({ sessionId: 'fake-session-a' })).ok, true);
    } finally { await h.cleanup(); }
  }
});

test('standard mode: latest preset event overrides stored header and blocks replay', async () => {
  const h = await makeHarness();
  try {
    const request = { requestId: 'changed-preset', task: 'Read-only review' };
    const first = await h.adapter.submitTask(request);
    const session = h.fake.sessions.get(first.sessionId);
    session.events.push({ type: 'agent-preset/selected', seq: 100, data: { agentPreset: 'dudu' } });
    const result = await h.adapter.submitTask(request);
    assert.equal(result.error.code, 'agent_preset_mismatch');
    assert.equal(h.fake.calls.filter(x => x.operation === 'prompt').length, 1);
  } finally { await h.cleanup(); }
});

test('standard mode: launcher rejects a bridge lacking the capability', async () => {
  const h = await makeHarness();
  try {
    const diagnostics = h.adapter.diagnostics();
    assert.doesNotThrow(() => assertBridgeCompatible(diagnostics));
    delete diagnostics.bridge.standardMode;
    assert.throws(() => assertBridgeCompatible(diagnostics), { code: 'stale_bridge' });
  } finally { await h.cleanup(); }
});

test('standard mode: a Host ignoring the selection cannot consume the task', async () => {
  const h = await makeHarness();
  try {
    const create = h.fake.ctx.sessionController.create;
    h.fake.ctx.sessionController.create = args => create({ ...args, agentPreset: 'dudu' });
    const result = await h.adapter.submitTask({ requestId: 'ignored-preset', task: 'Do not execute' });
    assert.equal(result.error.code, 'agent_preset_mismatch');
    assert.equal(h.fake.calls.filter(x => x.operation === 'prompt').length, 0);
  } finally { await h.cleanup(); }
});
