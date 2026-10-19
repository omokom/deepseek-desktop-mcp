import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { apply } from '../src/plugin.js';
import { createFakeDesktop } from '../src/testing.js';

const TOKEN = 'fake-startup-token-not-a-real-secret-0123456789';

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('startup: missing token refuses to bind (FAKE stand-in)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'desktop-mcp-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const fake = createFakeDesktop();
    await assert.rejects(
      apply(fake.ctx, { workspaceId: fake.workspaceId, port: await freePort() }),
      /token file is unavailable/i,
    );
    assert.equal(fake.effects.length, 0);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('startup: missing workspace refuses to bind (FAKE stand-in)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-token-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  try {
    const fake = createFakeDesktop();
    fake.ctx.workspaceRegistry.get = () => undefined;
    await assert.rejects(
      apply(fake.ctx, { workspaceId: fake.workspaceId, port: await freePort(), tokenFile }),
      /was not found/i,
    );
    assert.equal(fake.effects.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('startup: successful fake startup binds loopback, logs no token, and cleans up (FAKE stand-in)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-token-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`);
  const port = await freePort();
  const fake = createFakeDesktop();
  try {
    await apply(fake.ctx, {
      workspaceId: fake.workspaceId,
      port,
      tokenFile,
      workspacesFile: join(dir, 'workspaces.json'),
    });
    assert.equal(fake.effects.length, 2);
    assert.equal(fake.logs.some((entry) => entry.level === 'info' && String(entry.args[0]).includes('127.0.0.1')), true);
    assert.equal(JSON.stringify(fake.logs).includes(TOKEN), false);

    const response = await fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert.equal(value.ok, true);
    assert.equal(value.workspace.id, fake.workspaceId);
    assert.equal(value.model.matchesRequired, true);

    await fake.ctx.dispose();
    assert.equal(fake.effects.length, 0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/diagnostics`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    }));
  } finally {
    await fake.ctx.dispose().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
