#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { resolveTokenFile } from '../src/config.js';

function usage() {
  console.error(`Usage: node scripts/create-token.mjs [--token-file <absolute-path>]

Creates a new dedicated MCP bearer token in an external private file.
It refuses to overwrite an existing file and prints only the path, never
the token value. Default path: $DSH_HOME/desktop-mcp/token, else
~/.dsh/desktop-mcp/token.`);
}

async function main() {
  const args = process.argv.slice(2);
  let tokenFile;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--token-file') tokenFile = args[++index];
    else if (args[index] === '-h' || args[index] === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  const path = resolveTokenFile(tokenFile === undefined ? {} : { tokenFile });
  try {
    await access(path);
    throw new Error(`Refusing to overwrite existing token file: ${path}`);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      // Expected: the file does not exist yet.
    } else {
      throw error;
    }
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('base64url');
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  console.log(`Token written to ${path} (value not printed).`);
  console.log('Keep this file private. Do not commit it or paste its value into logs or chat.');
}

main().catch((error) => {
  console.error(`TOKEN_ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
