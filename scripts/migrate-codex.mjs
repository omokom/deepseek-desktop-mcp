#!/usr/bin/env node
/**
 * Reversible Codex integration migration for the Desktop executor (C staging).
 *
 * Default is a dry run. `--apply`:
 *   - fingerprints the live inputs and refuses to continue if they changed;
 *   - backs up `.codex/config.toml` and the legacy skill directory under the
 *     project-private directory (never Git);
 *   - moves the legacy `.codex/skills/deepseek-executor` directory away, installs
 *     the canonical `.agents/skills/deepseek-executor` tree, and leaves a thin
 *     compatibility shim at the old `scripts/invoke-harness.ps1` path (no
 *     duplicate SKILL.md);
 *   - inserts/replaces only `[mcp_servers.deepseek_desktop]` in config.toml and
 *     preserves every unrelated setting byte-for-byte;
 *   - seeds the non-secret workspace allowlist with the default Workspace and
 *     the current Codex workdir, preserving existing entries.
 *
 * `--rollback` restores only when the current files still match the recorded
 * after-fingerprints; a concurrent edit aborts instead of being overwritten.
 * The token file is never read or copied.
 */
import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspacesFile } from '../src/config.js';
import { enrollWorkspace, readWorkspaceAllowlist } from '../src/workspaces.js';

const MIGRATION_VERSION = 1;
const REGISTRATION_TABLE = 'mcp_servers.deepseek_desktop';
const DEEP_ROOT = 'C:\\Users\\Administrator\\Documents\\Codex\\2026-10-18\\deep';
const SKILL_NAME = 'deepseek-executor';
const JOURNAL_FILE = 'migration-journal.json';
const MANIFEST_FILE = 'manifest.json';

export class MigrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

function migrationError(code, message) {
  return new MigrationError(code, message);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fileSha(file) {
  return sha256(await readFile(file));
}

async function pathInfo(path) {
  try {
    const info = await lstat(path);
    return { exists: true, isDirectory: info.isDirectory(), isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, isDirectory: false, isFile: false, isSymbolicLink: false };
    throw migrationError('path_unreadable', `cannot inspect ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw migrationError('file_unreadable', `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function walkTree(root) {
  const info = await pathInfo(root);
  if (!info.exists) return null;
  if (!info.isDirectory) throw migrationError('tree_not_directory', `expected a directory: ${root}`);
  if (info.isSymbolicLink) throw migrationError('tree_symlink', `refusing to migrate a symlinked directory: ${root}`);
  const files = [];
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      if (entry.isSymbolicLink()) throw migrationError('tree_symlink', `refusing to migrate a symlinked entry: ${absolute}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) files.push({ relative: relative(root, absolute).replace(/\\/g, '/'), absolute, sha256: await fileSha(absolute), size: (await stat(absolute)).size });
    }
  }
  await walk(root);
  return { root: resolve(root), files, digest: treeDigest(files) };
}

function treeDigest(files) {
  return sha256(files.map((file) => `${file.relative}\0${file.sha256}`).join('\n'));
}

async function copyTree(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: false });
}

async function uniqueBackupDir(base) {
  for (let suffix = 0; suffix < 100; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if ((await pathInfo(candidate)).exists === false) return candidate;
  }
  throw migrationError('backup_dir_exists', `cannot allocate a fresh backup directory under ${base}`);
}

async function removeEmptyDirectory(path) {
  try {
    await rmdir(path);
  } catch {
    // Not empty or already gone: leave it for the operator.
  }
}

async function readJsonIfExists(path) {
  const text = await readTextIfExists(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text.replace(/^\uFEFF/u, ''));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw migrationError('journal_write_failed', `cannot write migration journal ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function rollbackCommandFor(productRoot, flag, path) {
  return `node "${join(productRoot, 'scripts', 'migrate-codex.mjs')}" --rollback --${flag} "${path}"`;
}

/**
 * Find a migration backup directory that did not reach a completed
 * manifest/journal. A journal is authoritative (status in-progress); a backup
 * directory without both journal+manifest is treated as an orphan interrupted
 * before the journal existed (older/partial layouts) and can be adopted.
 *
 * @param {ReturnType<typeof normalizeOptions>} paths
 * @param {string} sourceDigest
 */
async function detectIncompleteMigration(paths, sourceDigest) {
  const entries = await readdir(paths.privateRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('c-migration-'))
    .map((entry) => join(paths.privateRoot, entry.name))
    .sort()
    .reverse();
  if (dirs.length === 0) return null;
  const liveLegacyTree = await walkTree(paths.legacySkillDir);
  const liveLegacyHasSkill = liveLegacyTree !== null && liveLegacyTree.files.some((file) => file.relative === 'SKILL.md');
  const liveCanonical = await walkTree(paths.canonicalSkillDir);
  const liveCanonicalMatchesSource = liveCanonical !== null && liveCanonical.digest === sourceDigest;
  for (const backupDir of dirs) {
    const journalPath = join(backupDir, JOURNAL_FILE);
    const journal = await readJsonIfExists(journalPath);
    if (journal !== null) {
      if (journal.status === 'complete' || journal.status === 'rolled-back') continue;
      return {
        mode: 'journal',
        backupDir,
        journalPath,
        journal,
        legacyBackupPath: journal.original?.legacySkill?.backupPath ?? join(backupDir, 'legacy-skill'),
        legacyDigest: journal.original?.legacySkill?.digest ?? null,
        configBackupPath: journal.original?.config?.backupPath ?? join(backupDir, 'config.toml'),
        configBackupSha256: journal.original?.config?.sha256 ?? null,
        expectedConfigAfterSha256: journal.expected?.configAfterSha256 ?? null,
        sourceDigest,
        rollbackCommand: rollbackCommandFor(paths.productRoot, 'journal', journalPath),
      };
    }
    const manifestPath = join(backupDir, MANIFEST_FILE);
    const manifest = await readJsonIfExists(manifestPath);
    if (manifest !== null && manifest.ok === true) continue;
    const legacyBackupPath = join(backupDir, 'legacy-skill');
    const legacyBackupTree = await walkTree(legacyBackupPath);
    const configBackupPath = join(backupDir, 'config.toml');
    const configBackupInfo = await pathInfo(configBackupPath);
    const orphanEvidence = legacyBackupTree !== null || configBackupInfo.exists;
    const legacyWasMoved = !liveLegacyHasSkill;
    const canonicalConsistent = liveCanonical === null || liveCanonicalMatchesSource;
    if (orphanEvidence && legacyWasMoved && canonicalConsistent) {
      return {
        mode: 'orphan-backup',
        backupDir,
        journalPath: null,
        journal: null,
        legacyBackupPath: legacyBackupTree === null ? null : legacyBackupPath,
        legacyDigest: legacyBackupTree?.digest ?? null,
        configBackupPath: configBackupInfo.exists ? configBackupPath : null,
        configBackupSha256: configBackupInfo.exists ? await fileSha(configBackupPath) : null,
        expectedConfigAfterSha256: null,
        sourceDigest,
        rollbackCommand: rollbackCommandFor(paths.productRoot, 'journal', join(backupDir, JOURNAL_FILE)),
      };
    }
  }
  return null;
}

/**
 * Durable intent/progress journal. It is written after non-mutating checks and
 * backups but BEFORE the first mutation (legacy skill move), so an interrupted
 * apply always leaves exact original identity + backup paths + rollback command.
 */
function buildJournal(plan, backupDir) {
  const journalPath = join(backupDir, JOURNAL_FILE);
  return {
    version: 1,
    kind: 'migration-journal',
    migrationVersion: MIGRATION_VERSION,
    status: 'in-progress',
    createdAt: plan.paths.now.toISOString(),
    paths: {
      codexHome: plan.paths.codexHome,
      configPath: plan.paths.configPath,
      legacySkillDir: plan.paths.legacySkillDir,
      canonicalSkillDir: plan.paths.canonicalSkillDir,
      shimPath: plan.paths.shimPath,
      skillSource: plan.paths.skillSource,
      workspacesFile: plan.paths.workspacesFile,
      productRoot: plan.paths.productRoot,
      privateBackupDir: backupDir,
    },
    original: {
      config: {
        existed: plan.checks.config.exists,
        sha256: plan.checks.config.sha256,
        backupPath: plan.checks.config.exists ? join(backupDir, 'config.toml') : null,
      },
      legacySkill: {
        existed: plan.checks.legacySkill.exists,
        digest: plan.checks.legacySkill.digest,
        backupPath: plan.checks.legacySkill.exists ? join(backupDir, 'legacy-skill') : null,
      },
      canonicalSkill: {
        existed: plan.checks.canonicalSkill.exists,
        digest: plan.checks.canonicalSkill.digest,
      },
    },
    expected: {
      configAfterSha256: plan.checks.config.updatedSha256,
      skillSourceDigest: plan.checks.skillSource.digest,
      registrationMode: plan.checks.config.registrationMode,
    },
    progress: { backupConfig: false, legacyMoved: false, canonicalInstalled: false, shimWritten: false, configSpliced: false, allowlistSeeded: false },
    rollback: { command: rollbackCommandFor(plan.paths.productRoot, 'journal', journalPath) },
    tokenPolicy: 'Dedicated MCP token file is never read, printed, or copied.',
  };
}

async function updateJournal(journalPath, journal, progress) {
  journal.progress = { ...journal.progress, ...progress };
  journal.updatedAt = new Date().toISOString();
  await writeJsonAtomic(journalPath, journal);
}

async function moveDirectory(source, destination) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    await rename(source, destination);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw migrationError('move_failed', `cannot move ${source} to ${destination}: ${error instanceof Error ? error.message : String(error)}`);
    await copyTree(source, destination);
    const sourceTree = await walkTree(source);
    const destinationTree = await walkTree(destination);
    if (sourceTree.digest !== destinationTree.digest) throw migrationError('move_verify_failed', 'copied skill tree does not match its source; refusing to delete the source');
    await rm(source, { recursive: true, force: true });
  }
}

/**
 * Split one TOML document around the managed `[mcp_servers.deepseek_desktop]`
 * table block. The block ends at the next table header (or EOF).
 *
 * @param {string} content
 * @returns {{ before: string, block: string | null, after: string, start: number, end: number }}
 */
export function splitRegistration(content) {
  const header = new RegExp(`^\\[${REGISTRATION_TABLE.replace(/\./g, '\\.')}\\][ \\t]*$`, 'm');
  const match = header.exec(content);
  if (match === null) return { before: content, block: null, after: '', start: -1, end: -1 };
  const start = match.index;
  const headerLineEnd = content.indexOf('\n', start);
  const afterHeader = headerLineEnd === -1 ? content.length : headerLineEnd + 1;
  const rest = content.slice(afterHeader);
  const nextTable = rest.search(/^\[/m);
  const end = nextTable === -1 ? content.length : afterHeader + nextTable;
  return {
    before: content.slice(0, start),
    block: content.slice(start, end),
    after: content.slice(end),
    start,
    end,
  };
}

/**
 * Insert or replace the managed registration table. Everything outside the
 * managed block is byte-identical; the only allowed addition is the block plus
 * one separating newline.
 *
 * @param {string} original
 * @param {string} block
 * @returns {{ content: string, mode: 'insert'|'replace' }}
 */
export function applyRegistrationToToml(original, block) {
  if (typeof original !== 'string' || typeof block !== 'string' || block.trim() === '') {
    throw migrationError('registration_invalid', 'registration block is empty');
  }
  if (!block.startsWith(`[${REGISTRATION_TABLE}]`)) throw migrationError('registration_invalid', 'registration block must start with the managed table name');
  if (/\bBearer\b/i.test(block)) throw migrationError('registration_secret', 'registration block must not contain a bearer value; the helper reads the external token file');
  const parts = splitRegistration(original);
  if (parts.block !== null) {
    return { content: `${parts.before}${block}${parts.after}`, mode: 'replace' };
  }
  const separator = original === '' || original.endsWith('\n') ? '' : '\n';
  return { content: `${original}${separator}${block}`, mode: 'insert' };
}

/**
 * Assert that the only difference introduced is our managed block.
 *
 * @param {string} original
 * @param {string} updated
 * @param {string} block
 */
export function assertUnrelatedSettingsPreserved(original, updated, block) {
  const originalParts = splitRegistration(original);
  const updatedParts = splitRegistration(updated);
  if (updatedParts.block === null) throw migrationError('registration_missing', 'updated config has no managed registration block');
  if (updatedParts.block !== block) throw migrationError('registration_mismatch', 'updated config managed block is not the expected block');
  const strip = (parts) => (parts.block === null ? parts.before + parts.after : parts.before + parts.after);
  if (strip(originalParts) !== strip(updatedParts)) {
    throw migrationError('registration_unrelated_change', 'unrelated configuration lines would change; refusing to write config.toml');
  }
}

function normalizeOptions(options = {}) {
  const env = options.env ?? process.env;
  const productRoot = resolve(options.productRoot ?? join(DEEP_ROOT, 'outputs', 'deepseek-desktop-mcp'));
  const codexHome = resolve(options.codexHome ?? join(homedir(), '.codex'));
  const agentsSkillsDir = resolve(options.agentsSkillsDir ?? join(homedir(), '.agents', 'skills'));
  const legacySkillDir = join(codexHome, 'skills', SKILL_NAME);
  const canonicalSkillDir = join(agentsSkillsDir, SKILL_NAME);
  return {
    env,
    productRoot,
    codexHome,
    configPath: join(codexHome, 'config.toml'),
    agentsSkillsDir,
    canonicalSkillDir,
    legacySkillDir,
    shimPath: join(legacySkillDir, 'scripts', 'invoke-harness.ps1'),
    skillSource: resolve(options.skillSource ?? join(productRoot, 'integration', 'skill', SKILL_NAME)),
    registrationTemplate: resolve(options.registrationTemplate ?? join(productRoot, 'integration', 'codex', 'mcp-registration.toml.template')),
    shimTemplate: resolve(options.shimTemplate ?? join(productRoot, 'integration', 'codex', 'invoke-harness-shim.ps1')),
    headerHelperPath: join(canonicalSkillDir, 'scripts', 'header-helper.ps1'),
    canonicalLauncherPath: join(canonicalSkillDir, 'scripts', 'invoke-desktop.ps1'),
    privateRoot: resolve(options.privateRoot ?? join(DEEP_ROOT, 'work', 'harness', 'desktop-mcp-implementation', 'private')),
    workdir: resolve(options.workdir ?? DEEP_ROOT),
    defaultWorkspace: resolve(options.defaultWorkspace ?? join(process.env.USERPROFILE ?? homedir(), 'Documents', 'deepseek-harness', 'default-workspace')),
    workspacesFile: resolve(options.workspacesFile ?? resolveWorkspacesFile({}, env)),
    now: options.now === undefined ? new Date() : new Date(options.now),
  };
}

function registrationBlock(template, headerHelperPath) {
  const escaped = headerHelperPath.replace(/"/g, '');
  return template.replaceAll('{{HEADER_HELPER}}', escaped);
}

function shimContent(template, canonicalLauncherPath) {
  return template.replaceAll('{{CANONICAL_LAUNCHER}}', canonicalLauncherPath.replace(/'/g, "''"));
}

function backupDirName(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `c-migration-${stamp}`;
}

async function checkSkillSource(skillSource) {
  const skillFile = join(skillSource, 'SKILL.md');
  const content = await readTextIfExists(skillFile);
  if (content === null) throw migrationError('skill_source_invalid', `canonical skill source is missing SKILL.md: ${skillSource}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (frontmatter === null) throw migrationError('skill_source_invalid', 'canonical SKILL.md has no YAML frontmatter');
  if (!new RegExp(`^name:\\s*${SKILL_NAME}\\s*$`, 'm').test(frontmatter[1])) {
    throw migrationError('skill_source_invalid', `canonical SKILL.md name must be "${SKILL_NAME}"`);
  }
  for (const required of ['scripts/invoke-desktop.ps1', 'scripts/header-helper.ps1', 'scripts/invoke-harness-recovery.ps1', 'agents/openai.yaml']) {
    if ((await pathInfo(join(skillSource, required))).exists !== true) {
      throw migrationError('skill_source_invalid', `canonical skill source is missing ${required}`);
    }
  }
  return walkTree(skillSource);
}

/**
 * Dry-run plan. No live file is modified.
 *
 * @param {object} [options]
 */
export async function planMigration(options = {}) {
  const paths = normalizeOptions(options);
  const sourceTree = await checkSkillSource(paths.skillSource);
  const template = await readTextIfExists(paths.registrationTemplate);
  if (template === null) throw migrationError('template_missing', `registration template is missing: ${paths.registrationTemplate}`);
  const block = registrationBlock(template, paths.headerHelperPath);
  if (/\bBearer\b/i.test(block)) throw migrationError('registration_secret', 'registration template must not contain a bearer value');

  const originalConfig = await readTextIfExists(paths.configPath);
  const configExists = originalConfig !== null;
  const config = configExists
    ? { path: paths.configPath, exists: true, sha256: sha256(Buffer.from(originalConfig, 'utf8')), size: Buffer.byteLength(originalConfig, 'utf8') }
    : { path: paths.configPath, exists: false, sha256: null, size: 0 };
  const update = applyRegistrationToToml(originalConfig ?? '', block);
  if (configExists) assertUnrelatedSettingsPreserved(originalConfig, update.content, block);

  const legacyTree = await walkTree(paths.legacySkillDir);
  const legacyIsRealSkill = legacyTree !== null && legacyTree.files.some((file) => file.relative === 'SKILL.md');
  const legacy = legacyIsRealSkill ? legacyTree : null;
  const legacyShimOnly = legacyTree !== null && !legacyIsRealSkill;
  const canonical = await walkTree(paths.canonicalSkillDir);
  const shimInfo = await pathInfo(paths.shimPath);
  const shimSha = shimInfo.exists ? await fileSha(paths.shimPath) : null;
  const shimTemplate = await readTextIfExists(paths.shimTemplate);
  if (shimTemplate === null) throw migrationError('template_missing', `shim template is missing: ${paths.shimTemplate}`);

  let allowlist = null;
  try {
    allowlist = await readWorkspaceAllowlist({ file: paths.workspacesFile, env: paths.env });
  } catch (error) {
    throw migrationError('workspace_allowlist_invalid', `existing workspace allowlist cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const seed = [];
  for (const candidate of [paths.defaultWorkspace, paths.workdir]) {
    const info = await pathInfo(candidate);
    seed.push({
      path: candidate,
      status: info.exists && info.isDirectory ? (allowlist.entries.some((entry) => entry.path.toLowerCase() === candidate.toLowerCase()) ? 'present' : 'to-add') : 'missing',
    });
  }

  const backupDir = join(paths.privateRoot, backupDirName(paths.now));
  const plan = {
    ok: true,
    action: 'plan',
    migrationVersion: MIGRATION_VERSION,
    createdAt: paths.now.toISOString(),
    paths,
    checks: {
      skillSource: { root: sourceTree.root, digest: sourceTree.digest, fileCount: sourceTree.files.length },
      legacySkill: legacy === null
        ? { exists: false, digest: null, fileCount: 0, shimOnly: legacyShimOnly }
        : { exists: true, digest: legacy.digest, fileCount: legacy.files.length, shimOnly: false },
      canonicalSkill: canonical === null ? { exists: false, digest: null, fileCount: 0 } : { exists: true, digest: canonical.digest, fileCount: canonical.files.length },
      config: { ...config, registrationMode: update.mode, updatedSha256: sha256(Buffer.from(update.content, 'utf8')) },
      shim: { path: paths.shimPath, exists: shimInfo.exists, sha256: shimSha },
    },
    backups: {
      root: backupDir,
      config: configExists ? join(backupDir, 'config.toml') : null,
      legacySkill: legacy === null ? null : join(backupDir, 'legacy-skill'),
    },
    registration: { table: REGISTRATION_TABLE, mode: update.mode, helperCommand: block.split('\n').find((line) => line.startsWith('http_headers_helper')) ?? null },
    registrationBlock: block,
    workspaces: { file: paths.workspacesFile, seed },
    steps: [
      'verify input fingerprints again (concurrent-change guard)',
      configExists ? 'back up .codex/config.toml to the private backup directory' : 'no existing config.toml to back up',
      legacy === null
        ? (legacyShimOnly ? 'existing legacy path contains only the compatibility shim; no skill move needed' : 'no legacy .codex skill directory to move')
        : 'move legacy .codex skill directory into the private backup directory',
      `install canonical skill to ${paths.canonicalSkillDir}`,
      `write thin compatibility shim at ${paths.shimPath} (no SKILL.md)`,
      `insert ${REGISTRATION_TABLE} into config.toml, preserving all unrelated settings`,
      `seed workspace allowlist ${paths.workspacesFile}`,
      'record manifest with before/after fingerprints and rollback instructions',
    ],
    tokenPolicy: 'The dedicated MCP token file is never read, printed, or copied; config.toml receives only an http_headers_helper command string.',
  };
  const incomplete = await detectIncompleteMigration(paths, plan.checks.skillSource.digest);
  plan.incompleteMigration = incomplete === null ? null : {
    mode: incomplete.mode,
    backupDir: incomplete.backupDir,
    journalPath: incomplete.journalPath,
    legacyBackupPath: incomplete.legacyBackupPath,
    legacyDigest: incomplete.legacyDigest,
    configBackupPath: incomplete.configBackupPath,
    configBackupSha256: incomplete.configBackupSha256,
    expectedConfigAfterSha256: incomplete.expectedConfigAfterSha256,
    rollbackCommand: incomplete.rollbackCommand,
    action: incomplete.mode === 'journal'
      ? 'fail closed: an interrupted migration journal exists; roll back with the listed command before applying again'
      : 'recover: adopt this orphaned backup directory during apply so rollback keeps the legacy restore linkage',
  };
  plan.recovery = incomplete;
  if (incomplete !== null) {
    plan.steps.unshift(
      incomplete.mode === 'journal'
        ? `incomplete migration detected (${incomplete.backupDir}); --apply will fail closed with the rollback command`
        : `orphaned interrupted migration backup detected (${incomplete.backupDir}); --apply will adopt it and record the legacy restore linkage`,
    );
  }
  return plan;
}

function publicPlan(plan) {
  const { registrationBlock, ...rest } = plan;
  return {
    ...rest,
    paths: {
      codexHome: plan.paths.codexHome,
      configPath: plan.paths.configPath,
      legacySkillDir: plan.paths.legacySkillDir,
      canonicalSkillDir: plan.paths.canonicalSkillDir,
      shimPath: plan.paths.shimPath,
      skillSource: plan.paths.skillSource,
      privateRoot: plan.paths.privateRoot,
      privateBackupDir: plan.backups.root,
      workspacesFile: plan.paths.workspacesFile,
      headerHelperPath: plan.paths.headerHelperPath,
    },
  };
}

/**
 * Apply a planned migration after re-verifying every fingerprinted input.
 *
 * @param {Awaited<ReturnType<typeof planMigration>>} plan
 */
export async function applyMigration(plan, applyOptions = {}) {
  const paths = plan.paths;
  const current = await planMigration({
    productRoot: paths.productRoot,
    codexHome: paths.codexHome,
    agentsSkillsDir: paths.agentsSkillsDir,
    skillSource: paths.skillSource,
    privateRoot: paths.privateRoot,
    workdir: paths.workdir,
    defaultWorkspace: paths.defaultWorkspace,
    workspacesFile: paths.workspacesFile,
    now: paths.now,
  });
  const concurrent = [];
  if (current.checks.config.sha256 !== plan.checks.config.sha256) concurrent.push('config.toml');
  if (current.checks.legacySkill.digest !== plan.checks.legacySkill.digest) concurrent.push('legacy .codex skill directory');
  if (current.checks.canonicalSkill.digest !== plan.checks.canonicalSkill.digest) concurrent.push('canonical .agents skill directory');
  if (current.checks.shim.sha256 !== plan.checks.shim.sha256) concurrent.push('legacy launcher shim path');
  if (current.checks.skillSource.digest !== plan.checks.skillSource.digest) concurrent.push('canonical skill source');
  if (concurrent.length > 0) {
    throw migrationError('concurrent_change', `refusing to migrate: these inputs changed after the plan: ${concurrent.join(', ')}`);
  }
  if (plan.recovery?.mode === 'journal') {
    throw migrationError(
      'incomplete_migration',
      `an interrupted migration journal already exists (${plan.recovery.journalPath}); --apply will not treat the partially migrated state as a new baseline. Roll back first with: ${plan.recovery.rollbackCommand}`,
    );
  }
  if (plan.recovery?.mode === 'orphan-backup') {
    return recoverOrphanedApply(plan, applyOptions);
  }
  return applyFreshMigration(plan, applyOptions);
}

async function seedAllowlist(paths, seedItems) {
  const seeded = [];
  for (const item of seedItems) {
    if (item.status === 'missing') {
      seeded.push({ path: item.path, status: 'missing', skipped: true });
      continue;
    }
    try {
      const result = await enrollWorkspace({
        path: item.path,
        source: 'migration-seed',
        file: paths.workspacesFile,
        env: paths.env,
      });
      seeded.push({ path: result.canonicalPath, status: result.added ? 'added' : 'present' });
    } catch (error) {
      seeded.push({ path: item.path, status: 'failed', error: error instanceof Error ? error.message : String(error) });
    }
  }
  return seeded;
}

function maybeInjectFailure(applyOptions, point) {
  if (applyOptions?.failAt === point) {
    throw migrationError('injected_failure', `injected test failure at ${point}; the journal/backups must keep the original recoverable`);
  }
}

/**
 * Finish the mutation set: shim, config splice, allowlist seed, final manifest,
 * and mark the journal complete. Shared by fresh and recovered-orphan applies.
 */
async function finalizeMigration({ plan, paths, backupDir, journal, journalPath, backupConfigPath, backupLegacyPath, legacyExisted, legacyDigest, preexistingCanonicalBackup, applyOptions }) {
  const template = await readTextIfExists(paths.shimTemplate);
  const shim = shimContent(template, paths.canonicalLauncherPath);
  await mkdir(dirname(paths.shimPath), { recursive: true, mode: 0o700 });
  await writeFile(paths.shimPath, shim, { encoding: 'utf8', mode: 0o600 });
  await updateJournal(journalPath, journal, { shimWritten: true });

  const currentConfig = await readTextIfExists(paths.configPath);
  const updated = applyRegistrationToToml(currentConfig ?? '', plan.registrationBlock);
  if (currentConfig !== null) assertUnrelatedSettingsPreserved(currentConfig, updated.content, plan.registrationBlock);
  const temporary = `${paths.configPath}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(dirname(paths.configPath), { recursive: true, mode: 0o700 });
  await writeFile(temporary, updated.content, { encoding: 'utf8' });
  await rename(temporary, paths.configPath);
  const afterConfigSha = await fileSha(paths.configPath);
  await updateJournal(journalPath, journal, { configSpliced: true });
  maybeInjectFailure(applyOptions, 'afterConfigSplice');

  const seeded = await seedAllowlist(paths, plan.workspaces.seed);
  await updateJournal(journalPath, journal, { allowlistSeeded: true });

  const manifest = {
    ok: true,
    action: 'apply',
    migrationVersion: MIGRATION_VERSION,
    createdAt: plan.paths.now.toISOString(),
    recoveredFrom: journal.recoveredFrom ?? null,
    journalPath,
    paths: {
      codexHome: paths.codexHome,
      configPath: paths.configPath,
      legacySkillDir: paths.legacySkillDir,
      canonicalSkillDir: paths.canonicalSkillDir,
      shimPath: paths.shimPath,
      skillSource: paths.skillSource,
      workspacesFile: paths.workspacesFile,
      productRoot: paths.productRoot,
    },
    config: {
      beforeSha256: journal.original.config.sha256,
      afterSha256: afterConfigSha,
      backupPath: journal.original.config.backupPath,
      registrationMode: updated.mode,
      registrationTable: REGISTRATION_TABLE,
    },
    skill: {
      sourceDigest: plan.checks.skillSource.digest,
      installedDigest: (await walkTree(paths.canonicalSkillDir))?.digest ?? null,
      installedPath: paths.canonicalSkillDir,
      legacy: legacyExisted
        ? { existed: true, backupPath: backupLegacyPath, digest: legacyDigest }
        : { existed: false, backupPath: null, digest: null },
      preexistingCanonicalBackup,
    },
    shim: {
      path: paths.shimPath,
      sha256: sha256(Buffer.from(shim, 'utf8')),
      noSkillFile: (await pathInfo(join(paths.legacySkillDir, 'SKILL.md'))).exists !== true,
    },
    workspaces: { file: paths.workspacesFile, results: seeded },
    tokenPolicy: 'Dedicated MCP token file was not read, printed, or copied. The MCP registration contains only an http_headers_helper command string.',
    rollback: {
      command: `node "${join(paths.productRoot, 'scripts', 'migrate-codex.mjs')}" --rollback --manifest "${join(backupDir, MANIFEST_FILE)}"`,
    },
  };
  await writeFile(join(backupDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  journal.status = 'complete';
  journal.completedAt = new Date().toISOString();
  journal.manifestPath = join(backupDir, MANIFEST_FILE);
  await writeJsonAtomic(journalPath, journal);
  return { ok: true, action: 'apply', backupDir, manifestPath: join(backupDir, MANIFEST_FILE), manifest };
}

async function applyFreshMigration(plan, applyOptions = {}) {
  const paths = plan.paths;
  const backupDir = await uniqueBackupDir(plan.backups.root);
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const journalPath = join(backupDir, JOURNAL_FILE);
  const backupConfigPath = join(backupDir, 'config.toml');
  const backupLegacyPath = join(backupDir, 'legacy-skill');

  const originalConfig = await readTextIfExists(paths.configPath);
  const originalConfigSha = originalConfig === null ? null : sha256(Buffer.from(originalConfig, 'utf8'));
  if (originalConfigSha !== plan.checks.config.sha256) {
    throw migrationError('concurrent_change', 'refusing to migrate: config.toml changed after the plan');
  }

  // Non-mutating backup first, then the durable intent journal BEFORE the first
  // mutation (legacy skill move). A failure/interruption from here on is
  // script-recoverable via --rollback --journal.
  if (originalConfig !== null) {
    await writeFile(backupConfigPath, originalConfig, { encoding: 'utf8', mode: 0o600 });
    if ((await fileSha(backupConfigPath)) !== originalConfigSha) throw migrationError('backup_verify_failed', 'config.toml backup does not match the fingerprinted input');
  }
  const journal = buildJournal(plan, backupDir);
  journal.original.config.backupPath = originalConfig === null ? null : backupConfigPath;
  journal.original.legacySkill.backupPath = plan.checks.legacySkill.exists ? backupLegacyPath : null;
  await writeJsonAtomic(journalPath, journal);
  await updateJournal(journalPath, journal, { backupConfig: originalConfig !== null });

  // 1. Move the legacy skill directory away (verified move).
  if (plan.checks.legacySkill.exists) {
    await moveDirectory(paths.legacySkillDir, backupLegacyPath);
    const movedTree = await walkTree(backupLegacyPath);
    if (movedTree === null || movedTree.digest !== plan.checks.legacySkill.digest) {
      throw migrationError('move_verify_failed', 'moved legacy skill tree does not match its recorded fingerprint');
    }
    await updateJournal(journalPath, journal, { legacyMoved: true });
  }
  maybeInjectFailure(applyOptions, 'afterLegacyMove');

  // 2. Install the canonical skill.
  let preexistingCanonicalBackup = null;
  if (plan.checks.canonicalSkill.exists) {
    if (plan.checks.canonicalSkill.digest === plan.checks.skillSource.digest) {
      // Already the canonical source; leave it in place.
    } else {
      preexistingCanonicalBackup = join(backupDir, `canonical-skill-preexisting-${randomUUID().slice(0, 8)}`);
      await moveDirectory(paths.canonicalSkillDir, preexistingCanonicalBackup);
    }
  }
  if ((await pathInfo(paths.canonicalSkillDir)).exists !== true) {
    await copyTree(paths.skillSource, paths.canonicalSkillDir);
  }
  const installedTree = await walkTree(paths.canonicalSkillDir);
  if (installedTree === null || installedTree.digest !== plan.checks.skillSource.digest) {
    throw migrationError('install_verify_failed', 'installed canonical skill does not match the canonical source tree');
  }
  journal.original.canonicalSkill.preexistingBackupPath = preexistingCanonicalBackup;
  await updateJournal(journalPath, journal, { canonicalInstalled: true });
  maybeInjectFailure(applyOptions, 'afterCanonicalInstall');

  return finalizeMigration({
    plan,
    paths,
    backupDir,
    journal,
    journalPath,
    backupConfigPath,
    backupLegacyPath,
    legacyExisted: plan.checks.legacySkill.exists,
    legacyDigest: plan.checks.legacySkill.digest,
    preexistingCanonicalBackup,
    applyOptions,
  });
}

/**
 * Recover an interrupted apply whose backup directory predates the journal (an
 * orphaned backup). The adoption journal is written BEFORE any further
 * mutation, so the original legacy/config restore linkage is recorded even if
 * this recovery is itself interrupted.
 */
async function recoverOrphanedApply(plan, applyOptions = {}) {
  const paths = plan.paths;
  const recovery = plan.recovery;
  const backupDir = recovery.backupDir;
  const journalPath = join(backupDir, JOURNAL_FILE);

  const liveCanonical = await walkTree(paths.canonicalSkillDir);
  if (liveCanonical !== null && liveCanonical.digest !== plan.checks.skillSource.digest) {
    throw migrationError('concurrent_change', `refusing to recover: the canonical skill directory differs from both the planned source and an interrupted install: ${paths.canonicalSkillDir}`);
  }
  const liveLegacy = await walkTree(paths.legacySkillDir);
  if (liveLegacy !== null && liveLegacy.files.some((file) => file.relative === 'SKILL.md')) {
    throw migrationError('concurrent_change', 'refusing to recover: a legacy SKILL.md is present again at the old path');
  }
  if (recovery.legacyBackupPath !== null && (await walkTree(recovery.legacyBackupPath))?.digest !== recovery.legacyDigest) {
    throw migrationError('backup_verify_failed', 'orphaned legacy backup tree does not match the recorded plan fingerprint');
  }
  if (recovery.configBackupPath !== null && (await fileSha(recovery.configBackupPath)) !== recovery.configBackupSha256) {
    throw migrationError('backup_verify_failed', 'orphaned config backup does not match its fingerprint');
  }

  const journal = buildJournal(plan, backupDir);
  journal.recoveredFrom = 'orphan-backup';
  journal.original.config = {
    existed: recovery.configBackupPath !== null,
    sha256: recovery.configBackupSha256,
    backupPath: recovery.configBackupPath,
  };
  journal.original.legacySkill = {
    existed: recovery.legacyBackupPath !== null,
    digest: recovery.legacyDigest,
    backupPath: recovery.legacyBackupPath,
  };
  journal.expected.configAfterSha256 = null;
  await writeJsonAtomic(journalPath, journal);

  if (liveCanonical === null) {
    await copyTree(paths.skillSource, paths.canonicalSkillDir);
  }
  const installedTree = await walkTree(paths.canonicalSkillDir);
  if (installedTree === null || installedTree.digest !== plan.checks.skillSource.digest) {
    throw migrationError('install_verify_failed', 'recovered canonical skill does not match the canonical source tree');
  }
  await updateJournal(journalPath, journal, { legacyMoved: true, canonicalInstalled: true, recoveredOrphan: true });
  maybeInjectFailure(applyOptions, 'afterCanonicalInstall');

  return finalizeMigration({
    plan,
    paths,
    backupDir,
    journal,
    journalPath,
    backupConfigPath: recovery.configBackupPath,
    backupLegacyPath: recovery.legacyBackupPath,
    legacyExisted: recovery.legacyBackupPath !== null,
    legacyDigest: recovery.legacyDigest,
    preexistingCanonicalBackup: null,
    applyOptions,
  });
}

/**
 * Roll back a recorded migration or an interrupted one.
 *
 * Resolution order:
 * 1. explicit `manifestPath` → complete rollback;
 * 2. explicit `journalPath` → incomplete rollback from the durable journal;
 * 3. explicit `backupDir` (+ path options) → orphaned backup rollback;
 * 4. auto-discovery under the private root: the newest incomplete journal wins;
 *    otherwise the newest completed manifest is used. An orphaned backup
 *    without a journal fails closed with scripted recovery instructions instead
 *    of pretending the shim is a new baseline.
 *
 * Complete rollback refuses when current files no longer match the recorded
 * after-fingerprints. Incomplete rollback verifies the original fingerprints and
 * backups and refuses to overwrite a concurrently edited config.
 *
 * @param {{ manifestPath?: string, journalPath?: string, backupDir?: string, privateRoot?: string }} options
 */
export async function rollbackMigration(options = {}) {
  const privateRoot = resolve(options.privateRoot ?? join(DEEP_ROOT, 'work', 'harness', 'desktop-mcp-implementation', 'private'));
  if (options.manifestPath !== undefined) return rollbackCompleteManifest(resolve(options.manifestPath));
  if (options.journalPath !== undefined) return rollbackIncompleteJournal(resolve(options.journalPath), options);
  if (options.backupDir !== undefined) {
    const backupDir = resolve(options.backupDir);
    const journalPath = join(backupDir, JOURNAL_FILE);
    if ((await pathInfo(journalPath)).exists) return rollbackIncompleteJournal(journalPath, options);
    return rollbackOrphanBackup(backupDir, options);
  }

  const entries = await readdir(privateRoot, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('c-migration-'))
    .map((entry) => join(privateRoot, entry.name))
    .sort()
    .reverse();
  const completedManifests = [];
  for (const dir of dirs) {
    const journalPath = join(dir, JOURNAL_FILE);
    const journal = await readJsonIfExists(journalPath);
    if (journal !== null) {
      if (journal.status === 'complete' || journal.status === 'rolled-back') {
        const manifestPath = join(dir, MANIFEST_FILE);
        if ((await pathInfo(manifestPath)).exists) completedManifests.push(manifestPath);
        continue;
      }
      return rollbackIncompleteJournal(journalPath, options);
    }
    const manifestPath = join(dir, MANIFEST_FILE);
    const manifest = await readJsonIfExists(manifestPath);
    if (manifest !== null && manifest.ok === true) {
      completedManifests.push(manifestPath);
      continue;
    }
    const hasOrphanEvidence = (await pathInfo(join(dir, 'config.toml'))).exists
      || (await pathInfo(join(dir, 'legacy-skill'))).exists;
    if (hasOrphanEvidence) {
      throw migrationError(
        'incomplete_migration',
        `found an orphaned interrupted migration backup without a journal: ${dir}. Re-run --apply with the same paths to adopt it and record the legacy restore linkage (then roll back the printed manifest), or pass --backup-dir "${dir}" together with the same --codex-home/--agents-skills/--workspaces-file used for apply.`,
      );
    }
  }
  if (completedManifests.length === 0) throw migrationError('manifest_missing', `no migration manifest or incomplete journal found under ${privateRoot}`);
  return rollbackCompleteManifest(completedManifests[0]);
}

async function writeRollbackReceipt(backupDir, receipt) {
  const path = join(backupDir, `rollback-receipt-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return path;
}

async function restoreConfigFromBackup({ configPath, backupPath, beforeSha, currentSha }) {
  if (beforeSha === null) {
    if (currentSha !== null) await rm(configPath, { force: true });
    return null;
  }
  const backup = await readTextIfExists(backupPath);
  if (backup === null) throw migrationError('backup_missing', `config backup is missing: ${backupPath}`);
  if (sha256(Buffer.from(backup, 'utf8')) !== beforeSha) {
    throw migrationError('backup_verify_failed', 'config backup does not match its recorded before-fingerprint');
  }
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const temporary = `${configPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, backup, { encoding: 'utf8' });
  await rename(temporary, configPath);
  return beforeSha;
}

async function archiveCanonicalSkill(paths, backupDir) {
  if ((await pathInfo(paths.canonicalSkillDir)).exists !== true) return null;
  const archived = join(backupDir, `rollback-canonical-skill-${randomUUID().slice(0, 8)}`);
  await moveDirectory(paths.canonicalSkillDir, archived);
  return archived;
}

async function restoreLegacyTree(paths, backupPath, expectedDigest, existed) {
  await rm(paths.shimPath, { force: true });
  await removeEmptyDirectory(join(paths.legacySkillDir, 'scripts'));
  await removeEmptyDirectory(paths.legacySkillDir);
  if (!existed || backupPath === null) return false;
  const backupTree = await walkTree(backupPath);
  if (backupTree === null || backupTree.digest !== expectedDigest) {
    throw migrationError('backup_verify_failed', `legacy skill backup does not match its recorded fingerprint: ${backupPath}`);
  }
  await copyTree(backupPath, paths.legacySkillDir);
  const restored = await walkTree(paths.legacySkillDir);
  if (restored === null || restored.digest !== expectedDigest) {
    throw migrationError('restore_verify_failed', 'restored legacy skill tree does not match its recorded fingerprint');
  }
  return true;
}

async function rollbackCompleteManifest(manifestPath) {
  const manifestRaw = await readTextIfExists(manifestPath);
  if (manifestRaw === null) throw migrationError('manifest_missing', `migration manifest is missing: ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    throw migrationError('manifest_corrupt', 'migration manifest is not valid JSON');
  }
  const paths = manifest.paths;
  const checks = [];
  const currentConfigSha = (await pathInfo(paths.configPath)).exists ? await fileSha(paths.configPath) : null;
  if (currentConfigSha !== manifest.config.afterSha256) checks.push('config.toml');
  const currentSkill = await walkTree(paths.canonicalSkillDir);
  if (currentSkill === null || currentSkill.digest !== manifest.skill.installedDigest) checks.push('canonical skill tree');
  const currentShimSha = (await pathInfo(paths.shimPath)).exists ? await fileSha(paths.shimPath) : null;
  if (currentShimSha !== manifest.shim.sha256) checks.push('legacy launcher shim');
  if (checks.length > 0) {
    throw migrationError('concurrent_change', `refusing to roll back: these files no longer match the recorded post-migration state: ${checks.join(', ')}`);
  }

  // Restore config.toml from the verified backup.
  await restoreConfigFromBackup({
    configPath: paths.configPath,
    backupPath: manifest.config.backupPath,
    beforeSha: manifest.config.beforeSha256,
    currentSha: currentConfigSha,
  });

  // Archive the installed canonical skill, then restore the legacy directory
  // (and any pre-existing canonical skill that was moved aside).
  const backupDir = dirname(manifestPath);
  await archiveCanonicalSkill(paths, backupDir);
  if (typeof manifest.skill.preexistingCanonicalBackup === 'string' && manifest.skill.preexistingCanonicalBackup !== null) {
    await moveDirectory(manifest.skill.preexistingCanonicalBackup, paths.canonicalSkillDir);
  }
  const restoredLegacy = await restoreLegacyTree(
    paths,
    manifest.skill.legacy.backupPath,
    manifest.skill.legacy.digest,
    manifest.skill.legacy.existed,
  );

  const receipt = {
    ok: true,
    action: 'rollback',
    mode: 'complete',
    createdAt: new Date().toISOString(),
    manifestPath,
    configRestoredFrom: manifest.config.backupPath,
    configSha256: (await pathInfo(paths.configPath)).exists ? await fileSha(paths.configPath) : null,
    canonicalSkillArchivedTo: join(backupDir, 'rollback-canonical-skill-*'),
    legacySkillRestored: restoredLegacy,
    workspacesNote: `Workspace allowlist entries under ${paths.workspacesFile} were preserved; it is non-secret and outside Git.`,
  };
  receipt.receiptPath = await writeRollbackReceipt(backupDir, receipt);
  return receipt;
}

async function rollbackIncompleteJournal(journalPath, options = {}) {
  const journal = await readJsonIfExists(journalPath);
  if (journal === null) throw migrationError('journal_missing', `migration journal is missing or unreadable: ${journalPath}`);
  if (journal.status === 'complete') {
    const manifestPath = join(dirname(journalPath), MANIFEST_FILE);
    if ((await pathInfo(manifestPath)).exists) return rollbackCompleteManifest(manifestPath);
    throw migrationError('manifest_missing', `journal is complete but its manifest is missing: ${manifestPath}`);
  }
  if (journal.status === 'rolled-back') {
    throw migrationError('already_rolled_back', `this interrupted migration was already rolled back: ${journalPath}`);
  }
  const paths = journal.paths;
  if (paths === null || typeof paths !== 'object' || typeof paths.configPath !== 'string') {
    throw migrationError('journal_corrupt', 'migration journal has no usable paths');
  }
  const backupDir = dirname(journalPath);
  const originalConfig = journal.original?.config ?? {};
  const originalLegacy = journal.original?.legacySkill ?? {};
  const beforeSha = originalConfig.sha256 ?? null;
  const currentConfig = await readTextIfExists(paths.configPath);
  const currentSha = currentConfig === null ? null : sha256(Buffer.from(currentConfig, 'utf8'));
  const expectedAfter = journal.expected?.configAfterSha256 ?? null;
  const configUnchanged = currentSha === beforeSha;
  const configMigrated = expectedAfter !== null && currentSha === expectedAfter;
  if (!configUnchanged && !configMigrated) {
    throw migrationError(
      'concurrent_change',
      `refusing incomplete rollback: config.toml (${currentSha ?? 'absent'}) matches neither the original (${beforeSha ?? 'absent'}) nor the migration-written (${expectedAfter ?? 'unknown'}) fingerprint; the concurrent edit was preserved. Restore manually or re-run --apply after resolving. Journal: ${journalPath}`,
    );
  }
  if (beforeSha !== null) {
    const backup = await readTextIfExists(originalConfig.backupPath);
    if (backup === null) throw migrationError('backup_missing', `config backup is missing: ${originalConfig.backupPath}`);
    if (sha256(Buffer.from(backup, 'utf8')) !== beforeSha) throw migrationError('backup_verify_failed', 'config backup does not match the journal before-fingerprint');
  }
  if (originalLegacy.existed === true) {
    const legacyTree = await walkTree(originalLegacy.backupPath);
    if (legacyTree === null || legacyTree.digest !== originalLegacy.digest) {
      throw migrationError('backup_verify_failed', 'legacy skill backup does not match the journal fingerprint');
    }
  }

  const configRestoredSha = await restoreConfigFromBackup({
    configPath: paths.configPath,
    backupPath: originalConfig.backupPath,
    beforeSha,
    currentSha,
  });
  const archivedCanonical = await archiveCanonicalSkill(paths, backupDir);
  // A journal update crash between moving a pre-existing canonical skill aside
  // and recording its path is recoverable from the uniquely named backup entry.
  let preexistingCanonicalBackupPath = journal.original?.canonicalSkill?.preexistingBackupPath;
  if (typeof preexistingCanonicalBackupPath !== 'string') {
    const candidates = (await readdir(backupDir).catch(() => []))
      .filter((name) => name.startsWith('canonical-skill-preexisting-'));
    if (candidates.length === 1) preexistingCanonicalBackupPath = join(backupDir, candidates[0]);
  }
  if (typeof preexistingCanonicalBackupPath === 'string' && (await pathInfo(preexistingCanonicalBackupPath)).exists) {
    await moveDirectory(preexistingCanonicalBackupPath, paths.canonicalSkillDir);
  }
  const restoredLegacy = await restoreLegacyTree(paths, originalLegacy.backupPath, originalLegacy.digest, originalLegacy.existed === true);

  journal.status = 'rolled-back';
  journal.rolledBackAt = new Date().toISOString();
  journal.rollbackReceipt = {
    mode: 'incomplete-journal',
    configRestoredSha,
    legacySkillRestored: restoredLegacy,
    canonicalSkillArchivedTo: archivedCanonical,
  };
  await writeJsonAtomic(journalPath, journal);
  const receipt = {
    ok: true,
    action: 'rollback',
    mode: 'incomplete-journal',
    createdAt: new Date().toISOString(),
    journalPath,
    configRestoredFrom: originalConfig.backupPath ?? null,
    configSha256: (await pathInfo(paths.configPath)).exists ? await fileSha(paths.configPath) : null,
    canonicalSkillArchivedTo: archivedCanonical,
    legacySkillRestored: restoredLegacy,
    workspacesNote: `Workspace allowlist entries under ${paths.workspacesFile} were preserved; it is non-secret and outside Git.`,
  };
  receipt.receiptPath = await writeRollbackReceipt(backupDir, receipt);
  return receipt;
}

async function rollbackOrphanBackup(backupDir, options = {}) {
  const paths = normalizeOptions(options);
  const configBackupPath = join(backupDir, 'config.toml');
  const legacyBackupPath = join(backupDir, 'legacy-skill');
  const configBackupInfo = await pathInfo(configBackupPath);
  const legacyTree = await walkTree(legacyBackupPath);
  if (!configBackupInfo.exists && legacyTree === null) {
    throw migrationError('backup_missing', `no config/legacy backup material found in ${backupDir}`);
  }
  const beforeSha = configBackupInfo.exists ? await fileSha(configBackupPath) : null;
  const currentConfig = await readTextIfExists(paths.configPath);
  const currentSha = currentConfig === null ? null : sha256(Buffer.from(currentConfig, 'utf8'));
  const configUnchanged = currentSha === beforeSha;
  const registered = typeof currentConfig === 'string' && currentConfig.includes(`[${REGISTRATION_TABLE}]`);
  if (!configUnchanged && !registered) {
    throw migrationError('concurrent_change', `refusing orphan recovery: config.toml changed and does not contain the managed registration block; the edit was preserved. Backup: ${backupDir}`);
  }
  // Adopt the orphan into a durable journal first so this rollback is itself
  // script-recoverable if it is interrupted.
  const journalPath = join(backupDir, JOURNAL_FILE);
  const journal = {
    version: 1,
    kind: 'migration-journal',
    migrationVersion: MIGRATION_VERSION,
    status: 'in-progress',
    createdAt: new Date().toISOString(),
    recoveredFrom: 'orphan-backup',
    paths: {
      codexHome: paths.codexHome,
      configPath: paths.configPath,
      legacySkillDir: paths.legacySkillDir,
      canonicalSkillDir: paths.canonicalSkillDir,
      shimPath: paths.shimPath,
      skillSource: paths.skillSource,
      workspacesFile: paths.workspacesFile,
      productRoot: paths.productRoot,
      privateBackupDir: backupDir,
    },
    original: {
      config: { existed: beforeSha !== null, sha256: beforeSha, backupPath: configBackupInfo.exists ? configBackupPath : null },
      legacySkill: { existed: legacyTree !== null, digest: legacyTree?.digest ?? null, backupPath: legacyTree === null ? null : legacyBackupPath },
      canonicalSkill: { existed: false, digest: null },
    },
    expected: { configAfterSha256: null, skillSourceDigest: null, registrationMode: 'orphan-recovery' },
    progress: { orphanAdopted: true },
    rollback: { command: `node "${join(paths.productRoot, 'scripts', 'migrate-codex.mjs')}" --rollback --journal "${journalPath}"` },
  };
  await writeJsonAtomic(journalPath, journal);
  return rollbackIncompleteJournal(journalPath, options);
}

function parseArgs(argv) {
  const options = { action: 'plan' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--plan') options.action = 'plan';
    else if (arg === '--apply') options.action = 'apply';
    else if (arg === '--rollback') options.action = 'rollback';
    else if (arg === '--manifest') options.manifestPath = argv[++index];
    else if (arg === '--journal') options.journalPath = argv[++index];
    else if (arg === '--backup-dir') options.backupDir = argv[++index];
    else if (arg === '--product-root') options.productRoot = argv[++index];
    else if (arg === '--private-root') options.privateRoot = argv[++index];
    else if (arg === '--codex-home') options.codexHome = argv[++index];
    else if (arg === '--agents-skills') options.agentsSkillsDir = argv[++index];
    else if (arg === '--skill-source') options.skillSource = argv[++index];
    else if (arg === '--workdir') options.workdir = argv[++index];
    else if (arg === '--default-workspace') options.defaultWorkspace = argv[++index];
    else if (arg === '--workspaces-file') options.workspacesFile = argv[++index];
    else if (arg === '-h' || arg === '--help') options.action = 'help';
    else throw migrationError('usage', `Unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`MIGRATION_ERROR ${error.code ?? 'usage'} ${error.message}`);
    process.exitCode = 1;
    return;
  }
  if (options.action === 'help') {
    console.log(`Usage: node scripts/migrate-codex.mjs [--plan|--apply|--rollback] [options]

Dry run (default) prints the plan and modifies nothing. --apply performs the
journaled, backed-up migration; --rollback restores a completed, interrupted or
orphaned migration (see below). Options:
  --manifest <path>         complete rollback manifest
  --journal <path>          rollback from an interrupted migration journal
  --backup-dir <path>       adopt/rollback an orphaned backup directory (needs
                            the same --codex-home/--agents-skills/--workspaces-file)
  --product-root <dir>      product checkout containing integration/ and src/
  --private-root <dir>      project work/private backup directory (never Git)
  --codex-home <dir>        default %USERPROFILE%/.codex
  --agents-skills <dir>     default %USERPROFILE%/.agents/skills
  --skill-source <dir>      canonical skill source (default <product>/integration/skill/deepseek-executor)
  --workdir <dir>           current Codex project workdir to seed in the allowlist
  --default-workspace <dir> existing default Desktop workspace path to seed
  --workspaces-file <path>  non-secret workspace allowlist (default $DSH_HOME/desktop-mcp/workspaces.json)

--apply writes a migration journal with original fingerprints and backup paths
BEFORE the first mutation; if it is interrupted, --rollback auto-discovers the
incomplete journal. A retry --apply fails closed with that rollback command
instead of recording a shim-only state; an orphaned backup directory (no journal)
is adopted by a retry --apply so rollback keeps the legacy restore linkage.
The dedicated token file is never read or copied.`);
    return;
  }
  try {
    if (options.action === 'rollback') {
      const receipt = await rollbackMigration(options);
      console.log(`ROLLBACK ${JSON.stringify(receipt)}`);
    } else if (options.action === 'apply') {
      const plan = await planMigration(options);
      console.log(`PLAN ${JSON.stringify(publicPlan(plan))}`);
      const applied = await applyMigration(plan);
      console.log(`APPLIED ${JSON.stringify({ backupDir: applied.backupDir, manifestPath: applied.manifestPath, configAfter: applied.manifest.config.afterSha256, skillDigest: applied.manifest.skill.installedDigest })}`);
    } else {
      const plan = await planMigration(options);
      console.log(`PLAN ${JSON.stringify(publicPlan(plan))}`);
    }
  } catch (error) {
    console.error(`MIGRATION_ERROR ${error.code ?? 'unexpected'} ${error.message}`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
