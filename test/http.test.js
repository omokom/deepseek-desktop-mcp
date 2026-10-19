import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startHttpServer } from '../src/mcp.js';
import { makeHarness } from './helpers.js';

const TEST_TOKEN = 'fake-test-token-not-a-real-secret-0123456789';

function rawRequest({ port, path, method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = raw === '' ? null : JSON.parse(raw);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

test('http: loopback listener, auth boundary, and private diagnostics path (FAKE stand-in)', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  try {
    assert.equal(listener.address, '127.0.0.1');
    const base = `http://127.0.0.1:${listener.port}`;

    assert.equal((await fetch(`${base}/diagnostics`)).status, 401);
    assert.equal((await fetch(`${base}/diagnostics`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
    const ok = await fetch(`${base}/diagnostics`, { headers: { Authorization: `Bearer ${TEST_TOKEN}` } });
    assert.equal(ok.status, 200);
    const diagnostics = await ok.json();
    assert.equal(diagnostics.ok, true);
    assert.equal(diagnostics.workspace.id, harness.fake.workspaceId);
    assert.equal(JSON.stringify(diagnostics).includes(TEST_TOKEN), false);

    const spoofed = await rawRequest({
      port: listener.port,
      path: '/diagnostics',
      headers: { host: 'evil.example', Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.equal(spoofed.status, 421);
  } finally {
    await listener.close();
    await harness.cleanup();
  }
});

test('http: Origin is absent for native clients or exactly an approved loopback origin (FAKE stand-in)', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  const base = `http://127.0.0.1:${listener.port}`;
  const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
  try {
    assert.equal((await rawRequest({ port: listener.port, path: '/diagnostics', headers: auth })).status, 200);
    assert.equal((await rawRequest({ port: listener.port, path: '/diagnostics', headers: { ...auth, Origin: base } })).status, 200);
    assert.equal((await rawRequest({ port: listener.port, path: '/diagnostics', headers: { ...auth, Origin: `http://localhost:${listener.port}` } })).status, 200);

    for (const origin of [
      'https://evil.example',
      `http://127.0.0.1:${listener.port + 1}`,
      `http://localhost:${listener.port + 1}`,
      'null',
      'not an origin',
      `${base}/`,
    ]) {
      const rejected = await rawRequest({ port: listener.port, path: '/diagnostics', headers: { ...auth, Origin: origin } });
      assert.equal(rejected.status, 403, `Origin should be rejected: ${origin}`);
      assert.equal(rejected.body?.error?.code, 'forbidden_origin');
    }

    const mcpRejected = await rawRequest({
      port: listener.port,
      path: '/mcp',
      method: 'POST',
      headers: { ...auth, Origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcpRejected.status, 403);
  } finally {
    await listener.close();
    await harness.cleanup();
  }
});

test('http: official SDK initializes the five tools and drives submit/get/continue/cancel (FAKE stand-in)', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
  });
  const client = new Client({ name: 'fake-stand-in-test', version: '0.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.name, 'deepseek-desktop-mcp');
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((tool) => tool.name).sort(),
      ['cancel_task', 'continue_task', 'diagnostics', 'get_task', 'list_sessions', 'submit_task'],
    );

    const list = JSON.parse((await client.callTool({ name: 'list_sessions', arguments: { limit: 1 } })).content[0].text);
    assert.equal(list.ok, true);
    assert.equal(list.total, 2);

    const submitted = JSON.parse((await client.callTool({
      name: 'submit_task',
      arguments: { requestId: 'mcp-submit-1', task: 'Reply PONG' },
    })).content[0].text);
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.admitted, true);

    const task = JSON.parse((await client.callTool({
      name: 'get_task',
      arguments: { sessionId: submitted.sessionId, maxEvents: 20 },
    })).content[0].text);
    assert.equal(task.ok, true, JSON.stringify(task));
    assert.equal(task.sessionId, submitted.sessionId);
    assert.equal(task.completion, undefined);
    assert.equal(JSON.stringify(task).includes(TEST_TOKEN), false);

    const continued = JSON.parse((await client.callTool({
      name: 'continue_task',
      arguments: { sessionId: submitted.sessionId, requestId: 'mcp-continue-1', text: 'one more' },
    })).content[0].text);
    assert.equal(continued.ok, true, JSON.stringify(continued));

    harness.fake.setStatus(submitted.sessionId, 'running');
    const cancelled = JSON.parse((await client.callTool({
      name: 'cancel_task',
      arguments: { sessionId: submitted.sessionId },
    })).content[0].text);
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.equal(cancelled.cancelRequested, true);
    assert.equal(harness.fake.calls.some((call) => call.operation === 'cancel'), true);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await listener.close();
    await harness.cleanup();
  }
});

test('http: MCP list/get return structured errors when the workspace fence fails (FAKE stand-in)', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TEST_TOKEN}` } },
  });
  const client = new Client({ name: 'fake-failure-test', version: '0.0.0' }, { capabilities: {} });
  const originalGet = harness.fake.ctx.workspaceRegistry.get;
  try {
    await client.connect(transport);
    harness.fake.ctx.workspaceRegistry.get = () => undefined;

    const missing = await client.callTool({ name: 'list_sessions', arguments: { limit: 10 } });
    assert.equal(missing.isError, true);
    assert.equal(JSON.parse(missing.content[0].text).error.code, 'workspace_not_found');

    const missingTask = await client.callTool({ name: 'get_task', arguments: { sessionId: 'fake-session-a' } });
    assert.equal(missingTask.isError, true);
    assert.equal(JSON.parse(missingTask.content[0].text).error.code, 'workspace_not_found');

    const missingDiagnostics = await client.callTool({ name: 'diagnostics', arguments: {} });
    assert.equal(missingDiagnostics.isError, true);
    assert.equal(JSON.parse(missingDiagnostics.content[0].text).error.code, 'workspace_not_found');
  } finally {
    harness.fake.ctx.workspaceRegistry.get = originalGet;
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await listener.close();
    await harness.cleanup();
  }
});

test('http: bearer is required for the MCP endpoint too (FAKE stand-in)', async () => {
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TEST_TOKEN, port: 0 });
  try {
    const response = await fetch(`http://127.0.0.1:${listener.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'unauthorized');
  } finally {
    await listener.close();
    await harness.cleanup();
  }
});
