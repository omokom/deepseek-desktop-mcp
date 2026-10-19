import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = resolve(HERE, '..');
const HELPER = join(STAGE, 'integration', 'skill', 'deepseek-executor', 'scripts', 'header-helper.ps1');
const FAKE_TOKEN = 'fake-header-token-not-a-real-secret-0123456789abcdef';

function runHelper(args, env = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, ...args],
      { env: { ...process.env, ...env }, windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectRun);
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

test('header helper: prints only the JSON Authorization object for a fake token', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-header-'));
  try {
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, `${FAKE_TOKEN}\n`, 'utf8');
    const result = await runHelper(['-TokenFile', tokenFile]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.notEqual(result.stdout.charCodeAt(0), 0xfeff);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed, { Authorization: `Bearer ${FAKE_TOKEN}` });
    assert.equal(result.stdout.includes('"Authorization"'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('header helper: BOM and surrounding whitespace in the token file are stripped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-header-'));
  try {
    const tokenFile = join(dir, 'token');
    await writeFile(tokenFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`  ${FAKE_TOKEN}\r\n`, 'utf8')]));
    const result = await runHelper(['-TokenFile', tokenFile]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { Authorization: `Bearer ${FAKE_TOKEN}` });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('header helper: default $DSH_HOME token path works without printing the token elsewhere', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-header-'));
  try {
    const dshHome = join(dir, 'dsh');
    await mkdir(join(dshHome, 'desktop-mcp'), { recursive: true });
    await writeFile(join(dshHome, 'desktop-mcp', 'token'), `${FAKE_TOKEN}\n`, 'utf8');
    const result = await runHelper([], { DSH_HOME: dshHome });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { Authorization: `Bearer ${FAKE_TOKEN}` });
    assert.equal(result.stderr.includes(FAKE_TOKEN), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('header helper: missing and short token files fail without leaking values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'c-header-'));
  try {
    const missing = await runHelper(['-TokenFile', join(dir, 'missing-token')]);
    assert.equal(missing.code, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /token file not found/u);

    const shortFile = join(dir, 'short-token');
    await writeFile(shortFile, 'short\n', 'utf8');
    const short = await runHelper(['-TokenFile', shortFile]);
    assert.equal(short.code, 1);
    assert.equal(short.stdout, '');
    assert.match(short.stderr, /shorter than 32/u);
    assert.equal(short.stderr.includes('short'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('native registration template: string header helper, no inline secret', async () => {
  const template = await readFile(join(STAGE, 'integration', 'codex', 'mcp-registration.toml.template'), 'utf8');
  assert.match(template, /^\[mcp_servers\.deepseek_desktop\]$/mu);
  assert.match(template, /^url = "http:\/\/127\.0\.0\.1:47821\/mcp"$/mu);
  assert.match(template, /^required = false$/mu);
  assert.match(template, /^http_headers_helper = 'powershell\.exe .*\{\{HEADER_HELPER\}\}"'$/mu);
  assert.equal(/Bearer/iu.test(template), false);
  assert.equal(template.includes('{{HEADER_HELPER}}'), true);
});
