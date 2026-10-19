import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, readdir, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  MigrationError,
  applyMigration,
  applyRegistrationToToml,
  assertUnrelatedSettingsPreserved,
  planMigration,
  rollbackMigration,
  splitRegistration,
} from '../scripts/migrate-codex.mjs';
import { enrollWorkspace, readWorkspaceAllowlist, sameWorkspacePath, canonicalDirectoryPath } from '../src/workspaces.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STAGE = resolve(HERE, '..');
const SKILL_SOURCE = join(STAGE, 'integration', 'skill', 'deepseek-executor');
const UNRELATED_SECRET = 'Bearer fake-unrelated-secret-not-real-0123456789';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push(absolute);
    }
  }
  await walk(root);
  return files.sort();
}

async function makeSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'c-migration-'));
  const codexHome = join(root, '.codex');
  const agentsSkillsDir = join(root, '.agents', 'skills');
  const privateRoot = join(root, 'private');
  const workdir = join(root, 'workdir');
  const defaultWorkspace = join(root, 'default-workspace');
  const otherWorkspace = join(root, 'other-workspace');
  const workspacesFile = join(root, 'dsh', 'desktop-mcp', 'workspaces.json');
  const configPath = join(codexHome, 'config.toml');
  const legacySkill = join(codexHome, 'skills', 'deepseek-executor');
  await mkdir(join(legacySkill, 'scripts'), { recursive: true });
  await mkdir(join(legacySkill, 'agents'), { recursive: true });
  await mkdir(workdir);
  await mkdir(defaultWorkspace);
  await mkdir(otherWorkspace);
  await writeFile(join(legacySkill, 'SKILL.md'), '---\nname: deepseek-executor\ndescription: legacy skill\n---\n\nLegacy body.\n');
  await writeFile(join(legacySkill, 'scripts', 'invoke-harness.ps1'), '# legacy headless launcher\nparam([string]$TaskFile)\n');
  await writeFile(join(legacySkill, 'agents', 'openai.yaml'), 'interface:\n  display_name: "legacy"\n');
  const config = [
    'model = "gpt-6.1-sol"',
    'notify = [ "C:\\\\tools\\\\notify.exe", "turn-ended" ]',
    '',
    '[mcp_servers.weknora]',
    'url = "https://example.invalid/mcp"',
    '',
    '[mcp_servers.weknora.http_headers]',
    `Authorization = "${UNRELATED_SECRET}"`,
    '',
    '[features]',
    'memories = false',
    '',
  ].join('\r\n');
  await writeFile(configPath, config, 'utf8');
  await enrollWorkspace({ path: otherWorkspace, file: workspacesFile, source: 'test' });
  const options = () => ({
    productRoot: STAGE,
    codexHome,
    agentsSkillsDir,
    skillSource: SKILL_SOURCE,
    privateRoot,
    workdir,
    defaultWorkspace,
    workspacesFile,
    env: { DSH_HOME: join(root, 'dsh') },
  });
  return {
    root,
    options,
    codexHome,
    configPath,
    legacySkill,
    agentsSkillsDir,
    canonicalSkill: join(agentsSkillsDir, 'deepseek-executor'),
    privateRoot,
    workspacesFile,
    workdir,
    defaultWorkspace,
    otherWorkspace,
    originalConfig: config,
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('migration plan: dry run, exact flags, and unchanged live inputs', async () => {
  const sandbox = await makeSandbox();
  try {
    const configBefore = await readFile(sandbox.configPath, 'utf8');
    const legacyBefore = await readFile(join(sandbox.legacySkill, 'SKILL.md'), 'utf8');
    const plan = await planMigration(sandbox.options());
    assert.equal(plan.ok, true);
    assert.equal(plan.registration.mode, 'insert');
    assert.equal(plan.checks.config.sha256, sha256(Buffer.from(configBefore, 'utf8')));
    assert.notEqual(plan.checks.config.updatedSha256, plan.checks.config.sha256);
    assert.equal(plan.checks.legacySkill.exists, true);
    assert.equal(plan.checks.canonicalSkill.exists, false);
    assert.equal(plan.backups.root.startsWith(sandbox.privateRoot), true);
    assert.match(plan.registration.helperCommand, /powershell\.exe/u);
    assert.match(plan.registration.helperCommand, /header-helper\.ps1/u);
    assert.equal(/Bearer/iu.test(plan.registration.helperCommand), false);
    assert.equal(/Bearer/iu.test(plan.registrationBlock), false);
    assert.deepEqual(plan.workspaces.seed.map((entry) => entry.status), ['to-add', 'to-add']);
    assert.equal(await readFile(sandbox.configPath, 'utf8'), configBefore);
    assert.equal(await readFile(join(sandbox.legacySkill, 'SKILL.md'), 'utf8'), legacyBefore);
    assert.equal(await pathExists(sandbox.canonicalSkill), false);
    assert.equal(await pathExists(plan.backups.root), false);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration apply: backs up, moves legacy skill, installs canonical skill, shim, config, allowlist, manifest', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    const applied = await applyMigration(plan);
    assert.equal(applied.ok, true);
    assert.equal(await pathExists(applied.manifestPath), true);

    const configAfter = await readFile(sandbox.configPath, 'utf8');
    const parts = splitRegistration(configAfter);
    assert.notEqual(parts.block, null);
    assert.equal(configAfter.match(/\[mcp_servers\.deepseek_desktop\]/gu)?.length, 1);
    const originalParts = splitRegistration(sandbox.originalConfig);
    assert.equal(parts.before + parts.after, originalParts.before + originalParts.after);
    assert.match(parts.block, /url = "http:\/\/127\.0\.0\.1:47821\/mcp"/u);
    assert.match(parts.block, /required = false/u);
    assert.match(parts.block, /http_headers_helper = 'powershell\.exe /u);
    assert.match(parts.block, /header-helper\.ps1/u);
    assert.equal(/Bearer/iu.test(parts.block), false);
    assert.equal(configAfter.includes(UNRELATED_SECRET), true, 'unrelated settings (including their existing values) must be preserved');
    assert.equal(configAfter.includes('memories = false'), true);

    // Legacy skill moved to private backup and the old launcher path is a shim
    // without a duplicate SKILL.md.
    assert.equal(await pathExists(join(sandbox.legacySkill, 'SKILL.md')), false);
    const shim = await readFile(join(sandbox.legacySkill, 'scripts', 'invoke-harness.ps1'), 'utf8');
    assert.match(shim, /Compatibility shim/u);
    assert.match(shim, /invoke-desktop\.ps1/u);
    assert.match(shim, /\.agents/u);
    const backupLegacy = join(applied.backupDir, 'legacy-skill');
    assert.equal(await pathExists(join(backupLegacy, 'SKILL.md')), true);
    assert.match(await readFile(join(backupLegacy, 'scripts', 'invoke-harness.ps1'), 'utf8'), /legacy headless launcher/u);

    // Canonical skill installed byte-equivalently.
    const sourceFiles = await walkFiles(SKILL_SOURCE);
    const installedFiles = await walkFiles(sandbox.canonicalSkill);
    assert.equal(installedFiles.length, sourceFiles.length);
    for (const file of sourceFiles) {
      const relative = file.slice(SKILL_SOURCE.length + 1);
      assert.equal(sha256(await readFile(file)), sha256(await readFile(join(sandbox.canonicalSkill, relative))), relative);
    }
    assert.equal(await pathExists(join(sandbox.canonicalSkill, 'scripts', 'invoke-harness-recovery.ps1')), true);

    // Backups + manifest.
    assert.equal(await pathExists(join(applied.backupDir, 'config.toml')), true);
    assert.equal(sha256(await readFile(join(applied.backupDir, 'config.toml'))), sha256(Buffer.from(sandbox.originalConfig, 'utf8')));
    const manifest = JSON.parse(await readFile(applied.manifestPath, 'utf8'));
    assert.equal(manifest.config.afterSha256, sha256(Buffer.from(configAfter, 'utf8')));
    assert.equal(manifest.skill.installedDigest, plan.checks.skillSource.digest);
    assert.equal(manifest.shim.noSkillFile, true);
    assert.match(manifest.rollback.command, /--rollback --manifest/u);
    assert.equal(JSON.stringify(manifest).includes(UNRELATED_SECRET), false, 'manifest stores fingerprints, not secret values');

    // Non-secret allowlist: pre-existing entry preserved; default + workdir added.
    const allowlist = await readWorkspaceAllowlist({ file: sandbox.workspacesFile });
    assert.equal(allowlist.entries.length, 3);
    const [otherCanonical, defaultCanonical, workdirCanonical] = await Promise.all([
      canonicalDirectoryPath(sandbox.otherWorkspace),
      canonicalDirectoryPath(sandbox.defaultWorkspace),
      canonicalDirectoryPath(sandbox.workdir),
    ]);
    assert.equal(allowlist.entries.some((entry) => sameWorkspacePath(entry.path, otherCanonical)), true);
    assert.equal(allowlist.entries.some((entry) => sameWorkspacePath(entry.path, defaultCanonical)), true);
    assert.equal(allowlist.entries.some((entry) => sameWorkspacePath(entry.path, workdirCanonical)), true);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration rollback: restores config and legacy skill, archives the installed canonical skill', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    const applied = await applyMigration(plan);
    const legacyDigestBefore = plan.checks.legacySkill.digest;
    const receipt = await rollbackMigration({ manifestPath: applied.manifestPath });
    assert.equal(receipt.ok, true);
    assert.equal(await readFile(sandbox.configPath, 'utf8'), sandbox.originalConfig);
    assert.equal(await pathExists(sandbox.canonicalSkill), false);
    const restoredLegacy = await readFile(join(sandbox.legacySkill, 'SKILL.md'), 'utf8');
    assert.match(restoredLegacy, /Legacy body/u);
    const restoredScript = await readFile(join(sandbox.legacySkill, 'scripts', 'invoke-harness.ps1'), 'utf8');
    assert.match(restoredScript, /legacy headless launcher/u);
    assert.equal(sha256(await readFile(sandbox.configPath)), plan.checks.config.sha256);
    const archived = (await readdir(applied.backupDir)).filter((name) => name.startsWith('rollback-canonical-skill-'));
    assert.equal(archived.length, 1);
    assert.notEqual(legacyDigestBefore, null);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration apply: concurrent config edit aborts without writing the block', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    const edited = `${sandbox.originalConfig}\r\n[extra]\r\nchanged = true\r\n`;
    await writeFile(sandbox.configPath, edited, 'utf8');
    await assert.rejects(applyMigration(plan), (error) => error instanceof MigrationError && error.code === 'concurrent_change');
    const current = await readFile(sandbox.configPath, 'utf8');
    assert.equal(current, edited);
    assert.equal(current.includes('[mcp_servers.deepseek_desktop]'), false);
    assert.equal(await pathExists(sandbox.canonicalSkill), false);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration rollback: concurrent post-migration edit aborts', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    const applied = await applyMigration(plan);
    const skillFile = join(sandbox.canonicalSkill, 'SKILL.md');
    await writeFile(skillFile, `${await readFile(skillFile, 'utf8')}\nconcurrent edit\n`, 'utf8');
    await assert.rejects(rollbackMigration({ manifestPath: applied.manifestPath }), (error) => error instanceof MigrationError && error.code === 'concurrent_change');
    assert.notEqual(await readFile(sandbox.configPath, 'utf8'), sandbox.originalConfig);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration: applied twice replaces only the managed block and keeps one registration', async () => {
  const sandbox = await makeSandbox();
  try {
    const first = await applyMigration(await planMigration(sandbox.options()));
    const configAfterFirst = await readFile(sandbox.configPath, 'utf8');
    const second = await applyMigration(await planMigration(sandbox.options()));
    const configAfterSecond = await readFile(sandbox.configPath, 'utf8');
    assert.equal(configAfterSecond.match(/\[mcp_servers\.deepseek_desktop\]/gu)?.length, 1);
    assert.equal(splitRegistration(configAfterFirst).before + splitRegistration(configAfterFirst).after,
      splitRegistration(configAfterSecond).before + splitRegistration(configAfterSecond).after);
    assert.equal(await pathExists(second.manifestPath), true);
    assert.equal(await pathExists(first.manifestPath), true);
    assert.equal(second.manifest.skill.installedDigest, first.manifest.skill.installedDigest);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration: TOML splice inserts/replaces only the managed block and refuses secrets', () => {
  const original = 'model = "x"\r\n\r\n[features]\r\nmemories = false\r\n';
  const block = '[mcp_servers.deepseek_desktop]\nurl = "http://127.0.0.1:47821/mcp"\nrequired = false\nhttp_headers_helper = \'powershell.exe -File "C:\\x\\header-helper.ps1"\'\n';
  const inserted = applyRegistrationToToml(original, block);
  assert.equal(inserted.mode, 'insert');
  assert.equal(inserted.content.startsWith(original), true);
  assert.equal(inserted.content.length > original.length, true);
  assert.equal(splitRegistration(inserted.content).before + splitRegistration(inserted.content).after, original);
  const replaced = applyRegistrationToToml(inserted.content, block);
  assert.equal(replaced.mode, 'replace');
  assert.equal(replaced.content, inserted.content);
  assert.equal(splitRegistration(replaced.content).before + splitRegistration(replaced.content).after, original);
  assert.throws(() => applyRegistrationToToml(original, `${block}http_headers = "Bearer secret"\n`), { code: 'registration_secret' });
  assert.throws(() => applyRegistrationToToml(original, ''), { code: 'registration_invalid' });
  const altered = original.replace('memories = false', 'memories = true');
  assert.throws(() => assertUnrelatedSettingsPreserved(altered, inserted.content, block), { code: 'registration_unrelated_change' });
  assert.equal(assertUnrelatedSettingsPreserved(original, inserted.content, block), undefined);
});

async function replayThroughLegacyMove(sandbox, plan) {
  const backupDir = plan.backups.root;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const configBackupPath = join(backupDir, 'config.toml');
  await writeFile(configBackupPath, sandbox.originalConfig, 'utf8');
  const legacyBackupPath = join(backupDir, 'legacy-skill');
  await rename(sandbox.legacySkill, legacyBackupPath);
  const moved = await walkFiles(legacyBackupPath);
  return { backupDir, configBackupPath, legacyBackupPath, moved, plan };
}

async function replayThroughShim(sandbox, plan) {
  const replay = await replayThroughLegacyMove(sandbox, plan);
  await cp(SKILL_SOURCE, sandbox.canonicalSkill, { recursive: true, errorOnExist: true, force: false });
  const template = await readFile(join(STAGE, 'integration', 'codex', 'invoke-harness-shim.ps1'), 'utf8');
  const shim = template.replaceAll('{{CANONICAL_LAUNCHER}}', join(sandbox.canonicalSkill, 'scripts', 'invoke-desktop.ps1'));
  const shimPath = join(sandbox.legacySkill, 'scripts', 'invoke-harness.ps1');
  await mkdir(dirname(shimPath), { recursive: true, mode: 0o700 });
  await writeFile(shimPath, shim, 'utf8');
  return { ...replay, shimPath };
}

test('migration: failure injection at move/install/config-splice is script-recoverable from the journal (F2)', async () => {
  for (const failAt of ['afterLegacyMove', 'afterCanonicalInstall', 'afterConfigSplice']) {
    const sandbox = await makeSandbox();
    try {
      const plan = await planMigration(sandbox.options());
      await assert.rejects(
        applyMigration(plan, { failAt }),
        (error) => error instanceof MigrationError && error.code === 'injected_failure',
        failAt,
      );
      const journalPath = join(plan.backups.root, 'migration-journal.json');
      assert.equal(await pathExists(journalPath), true, `${failAt}: journal must exist before/after mutation`);
      const journal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(journal.status, 'in-progress');
      assert.equal(journal.original.legacySkill.existed, true);
      assert.equal(journal.original.legacySkill.digest, plan.checks.legacySkill.digest);
      assert.equal(typeof journal.original.legacySkill.backupPath, 'string');
      assert.equal(typeof journal.rollback.command, 'string');
      assert.match(journal.rollback.command, /--rollback --journal/u);
      assert.equal(await pathExists(join(plan.backups.root, 'manifest.json')), false, `${failAt}: no final manifest yet`);

      // A retry apply must fail closed with the exact journal rollback command,
      // not treat the shim/partial state as a fresh baseline.
      const retryPlan = await planMigration(sandbox.options());
      assert.equal(retryPlan.recovery?.mode, 'journal');
      await assert.rejects(
        applyMigration(retryPlan),
        (error) => error instanceof MigrationError && error.code === 'incomplete_migration' && error.message.includes('--rollback --journal'),
        failAt,
      );

      // Auto-discovered incomplete rollback restores original config + legacy skill.
      const receipt = await rollbackMigration({ privateRoot: sandbox.privateRoot });
      assert.equal(receipt.ok, true);
      assert.equal(receipt.mode, 'incomplete-journal');
      const restoredConfig = await readFile(sandbox.configPath, 'utf8');
      assert.equal(sha256(Buffer.from(restoredConfig, 'utf8')), plan.checks.config.sha256);
      assert.equal(restoredConfig, sandbox.originalConfig);
      const restoredLegacy = await walkFiles(sandbox.legacySkill).catch(() => null);
      assert.ok(restoredLegacy);
      assert.equal(await pathExists(join(sandbox.legacySkill, 'SKILL.md')), true);
      assert.equal(await pathExists(sandbox.canonicalSkill), false);
      assert.equal(await pathExists(journalPath), true);
      const completedJournal = JSON.parse(await readFile(journalPath, 'utf8'));
      assert.equal(completedJournal.status, 'rolled-back');
    } finally {
      await sandbox.cleanup();
    }
  }
});

test('migration: orphaned interrupted backup is adopted by retry apply so rollback keeps the legacy linkage', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    // Simulate an interruption after install+shim but before the journal existed
    // (pre-journal/partial layout): only backup artifacts remain.
    const replay = await replayThroughShim(sandbox, plan);
    assert.equal(await pathExists(join(replay.backupDir, 'migration-journal.json')), false);

    const retryPlan = await planMigration(sandbox.options());
    assert.equal(retryPlan.recovery?.mode, 'orphan-backup');
    assert.equal(retryPlan.recovery.legacyDigest, plan.checks.legacySkill.digest);
    const applied = await applyMigration(retryPlan);
    assert.equal(applied.ok, true);
    const manifest = JSON.parse(await readFile(applied.manifestPath, 'utf8'));
    assert.equal(manifest.skill.legacy.existed, true, 'retry must not record legacy.existed=false');
    assert.equal(manifest.skill.legacy.digest, plan.checks.legacySkill.digest);
    assert.equal(manifest.skill.legacy.backupPath, replay.legacyBackupPath);
    assert.equal(manifest.recoveredFrom, 'orphan-backup');
    const journal = JSON.parse(await readFile(join(applied.backupDir, 'migration-journal.json'), 'utf8'));
    assert.equal(journal.status, 'complete');

    const receipt = await rollbackMigration({ manifestPath: applied.manifestPath });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.legacySkillRestored, true);
    assert.equal(await readFile(sandbox.configPath, 'utf8'), sandbox.originalConfig);
    assert.equal(await pathExists(join(sandbox.legacySkill, 'SKILL.md')), true);
    const restoredLegacyDigest = (await walkFiles(sandbox.legacySkill)).length > 0;
    assert.equal(restoredLegacyDigest, true);
    assert.equal(await pathExists(sandbox.canonicalSkill), false);
  } finally {
    await sandbox.cleanup();
  }
});

test('migration: rollback of an orphaned backup with explicit verified paths restores config + legacy skill', async () => {
  const sandbox = await makeSandbox();
  try {
    const plan = await planMigration(sandbox.options());
    const replay = await replayThroughLegacyMove(sandbox, plan);
    // Auto-discovery cannot know the live paths for a journal-less orphan and
    // must fail closed with actionable scripted recovery (not manifest_missing,
    // and not treat the shim as a new baseline).
    await assert.rejects(
      rollbackMigration({ privateRoot: sandbox.privateRoot }),
      (error) => error instanceof MigrationError && error.code === 'incomplete_migration' && error.message.includes('--backup-dir'),
    );
    const receipt = await rollbackMigration({
      privateRoot: sandbox.privateRoot,
      backupDir: replay.backupDir,
      codexHome: sandbox.codexHome,
      agentsSkillsDir: sandbox.agentsSkillsDir,
      skillSource: SKILL_SOURCE,
      productRoot: STAGE,
      workdir: sandbox.workdir,
      defaultWorkspace: sandbox.defaultWorkspace,
      workspacesFile: sandbox.workspacesFile,
      env: { DSH_HOME: join(sandbox.root, 'dsh') },
    });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.mode, 'incomplete-journal');
    assert.equal(await readFile(sandbox.configPath, 'utf8'), sandbox.originalConfig);
    assert.equal(await pathExists(join(sandbox.legacySkill, 'SKILL.md')), true);
    assert.equal(await pathExists(join(replay.backupDir, 'migration-journal.json')), true);
  } finally {
    await sandbox.cleanup();
  }
});
