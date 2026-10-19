import assert from 'node:assert/strict';
import { closeSync, openSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { startHttpServer } from '../src/mcp.js';
import { makeHarness } from './helpers.js';

const TOKEN = 'fake-client-exit-token-not-a-real-secret-0123456789';
const projectRoot = resolve(import.meta.dirname, '..');
const clientPath = resolve(projectRoot, 'src/client.js');

async function runClient({ tokenFile, base, args, logPath }) {
  const fd = openSync(logPath, 'w');
  let child;
  try {
    child = spawn(process.execPath, [clientPath, '--token-file', tokenFile, '--url', base, ...args], {
      cwd: projectRoot,
      stdio: ['ignore', fd, fd],
      timeout: 30000,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  const outcome = await new Promise((resolvePromise) => {
    child.once('close', (status, signal) => resolvePromise({ status, signal }));
    child.once('error', (error) => resolvePromise({ status: null, signal: null, error: String(error) }));
  });
  const output = await readFile(logPath, 'utf8');
  return { ...outcome, output, tokenLeaked: output.includes(TOKEN) };
}

test('client: successful tool exits 0; failed call and failed poll exit nonzero without token leak (FAKE endpoint)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-mcp-client-'));
  const tokenFile = join(dir, 'token');
  await writeFile(tokenFile, `${TOKEN}\n`, 'utf8');
  const harness = await makeHarness();
  const listener = await startHttpServer({ adapter: harness.adapter, token: TOKEN, port: 0 });
  const base = `http://127.0.0.1:${listener.port}/mcp`;
  try {
    const success = await runClient({
      tokenFile,
      base,
      logPath: join(dir, 'success.log'),
      args: ['--call', 'get_task', '--args', '{"sessionId":"fake-session-a"}'],
    });
    assert.equal(success.status, 0, success.output);
    assert.equal(success.output.includes('CALL get_task'), true);
    assert.equal(success.tokenLeaked, false);

    const failedCall = await runClient({
      tokenFile,
      base,
      logPath: join(dir, 'failed-call.log'),
      args: ['--call', 'continue_task', '--args', '{"sessionId":"fake-session-other-workspace","requestId":"client-fail","text":"x"}'],
    });
    assert.notEqual(failedCall.status, 0, failedCall.output);
    assert.equal(failedCall.output.includes('"ok": false'), true);
    assert.equal(failedCall.output.includes('session_not_authorized'), true);
    assert.equal(failedCall.tokenLeaked, false);

    const failedPoll = await runClient({
      tokenFile,
      base,
      logPath: join(dir, 'failed-poll.log'),
      args: ['--poll', 'fake-session-other-workspace', '--max-polls', '1', '--interval-ms', '0'],
    });
    assert.notEqual(failedPoll.status, 0, failedPoll.output);
    assert.equal(failedPoll.output.includes('"ok": false'), true);
    assert.equal(failedPoll.tokenLeaked, false);
  } finally {
    await listener.close();
    await harness.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});
