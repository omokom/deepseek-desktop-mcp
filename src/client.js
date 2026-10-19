#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BRIDGE_VERSION, readToken, resolveTokenFile } from './config.js';

function usage() {
  console.error(`Usage: node src/client.js [options]

Options:
  --url <url>            MCP endpoint (default http://127.0.0.1:47821/mcp; loopback only)
  --token-file <path>    External token file (default $DSH_HOME/desktop-mcp/token or ~/.dsh/desktop-mcp/token)
  --limit <n>            list_sessions limit, 1..50 (default 20)
  --call <tool>          Call one MCP tool instead of the default list/diagnostics flow
  --args <json>          JSON object arguments for --call
  --args-file <path>     Read --call arguments from a JSON file
  --poll <sessionId>     Poll get_task for this session (or a --call submit_task result)
  --cursor <json>        Initial get_task cursor, e.g. {"seq":12,"offset":0}
  --max-polls <n>        Maximum polling calls, 1..100 (default 20)
  --interval-ms <n>      Delay between polls, 0..60000 (default 1000)
  --max-events <n>       get_task maxEvents, 1..200
  --max-chars <n>        get_task maxChars, 1..60000
  --skip-diagnostics     Default flow: only initialize and list sessions
  -h, --help             Show this help

The token is read from the file and sent only in the Authorization header.
It is never printed. This client only calls the MCP endpoint; it is not an
execution engine.`);
}

function parseInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function parseJson(value, name) {
  try {
    const parsed = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('must be an object');
    return parsed;
  } catch (error) {
    throw new Error(`${name} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:47821/mcp',
    tokenFile: undefined,
    limit: 20,
    call: undefined,
    args: undefined,
    argsFile: undefined,
    poll: undefined,
    cursor: undefined,
    maxPolls: 20,
    intervalMs: 1000,
    maxEvents: undefined,
    maxChars: undefined,
    skipDiagnostics: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index];
    else if (arg === '--token-file') options.tokenFile = argv[++index];
    else if (arg === '--limit') options.limit = Number(argv[++index]);
    else if (arg === '--call') options.call = argv[++index];
    else if (arg === '--args') options.args = argv[++index];
    else if (arg === '--args-file') options.argsFile = argv[++index];
    else if (arg === '--poll') options.poll = argv[++index];
    else if (arg === '--cursor') options.cursor = parseJson(argv[++index], '--cursor');
    else if (arg === '--max-polls') options.maxPolls = Number(argv[++index]);
    else if (arg === '--interval-ms') options.intervalMs = Number(argv[++index]);
    else if (arg === '--max-events') options.maxEvents = Number(argv[++index]);
    else if (arg === '--max-chars') options.maxChars = Number(argv[++index]);
    else if (arg === '--skip-diagnostics') options.skipDiagnostics = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const url = new URL(options.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('--url must use http or https');
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '[::1]') {
    throw new Error('--url must address a loopback host');
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50) throw new Error('--limit must be an integer from 1 to 50');
  options.maxPolls = parseInteger(options.maxPolls, '--max-polls', 1, 100);
  options.intervalMs = parseInteger(options.intervalMs, '--interval-ms', 0, 60000);
  if (options.maxEvents !== undefined) options.maxEvents = parseInteger(options.maxEvents, '--max-events', 1, 200);
  if (options.maxChars !== undefined) options.maxChars = parseInteger(options.maxChars, '--max-chars', 1, 60000);
  if (options.args !== undefined && options.argsFile !== undefined) throw new Error('Use --args or --args-file, not both');
  if (options.poll !== undefined && options.poll.trim() === '') throw new Error('--poll requires a session id');
  if (options.args !== undefined) options.args = parseJson(options.args, '--args');
  return options;
}

function toolText(result) {
  if (!result || !Array.isArray(result.content)) return null;
  const text = result.content.find((entry) => entry && entry.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function callArgs(options) {
  if (options.args !== undefined) return options.args;
  if (options.argsFile !== undefined) return parseJson(await readFile(options.argsFile, 'utf8'), '--args-file');
  return {};
}

async function callTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const value = toolText(result);
  console.log(`CALL ${name}`);
  console.log(JSON.stringify(value, null, 2));
  return { result, value };
}

async function pollTask(client, sessionId, options) {
  let cursor = options.cursor;
  for (let attempt = 1; attempt <= options.maxPolls; attempt += 1) {
    const args = { sessionId };
    if (cursor !== undefined) args.cursor = cursor;
    if (options.maxEvents !== undefined) args.maxEvents = options.maxEvents;
    if (options.maxChars !== undefined) args.maxChars = options.maxChars;
    const { result, value } = await callTool(client, 'get_task', args);
    if (result?.isError || value?.ok === false) return { ok: false, value };
    if (value?.cursor !== undefined) cursor = value.cursor;
    const state = value?.status?.state;
    if (['finished', 'failed', 'canceled', 'blocked'].includes(state)) return { ok: true, value };
    if (attempt < options.maxPolls && options.intervalMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs));
    }
  }
  const last = cursor;
  console.log('POLL_LIMIT_REACHED');
  console.log(JSON.stringify({ maxPolls: options.maxPolls, cursor: last }, null, 2));
  return { ok: true, value: null };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const tokenFile = options.tokenFile ?? resolveTokenFile({});
  const { token } = await readToken({ tokenFile });

  const transport = new StreamableHTTPClientTransport(new URL(options.url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'deepseek-desktop-mcp-client', version: BRIDGE_VERSION },
    { capabilities: {} },
  );

  let failed = false;
  try {
    await client.connect(transport);
    console.log('INITIALIZE ok');
    console.log(JSON.stringify({
      server: client.getServerVersion() ?? null,
      capabilities: client.getServerCapabilities() ?? null,
    }, null, 2));

    const tools = await client.listTools();
    console.log('TOOLS');
    console.log(JSON.stringify(tools.tools.map((tool) => tool.name), null, 2));

    if (options.poll !== undefined && options.call === undefined) {
      const polled = await pollTask(client, options.poll, options);
      if (!polled.ok) {
        failed = true;
        process.exitCode = 1;
      }
      return;
    }

    if (options.call !== undefined) {
      const args = await callArgs(options);
      const called = await callTool(client, options.call, args);
      if (called.result?.isError || called.value?.ok === false) {
        failed = true;
        process.exitCode = 1;
        return;
      }
      const pollSession = options.poll ?? called.value?.sessionId;
      if (options.poll !== undefined || (options.call === 'submit_task' && pollSession !== undefined)) {
        if (typeof pollSession !== 'string' || pollSession.length === 0) throw new Error('polling requires a sessionId');
        const polled = await pollTask(client, pollSession, options);
        if (!polled.ok) {
          failed = true;
          process.exitCode = 1;
        }
      }
      return;
    }

    const list = await client.callTool({ name: 'list_sessions', arguments: { limit: options.limit } });
    const listValue = toolText(list);
    console.log('LIST_SESSIONS');
    console.log(JSON.stringify(listValue, null, 2));
    if (list?.isError || listValue?.ok === false) failed = true;

    if (!options.skipDiagnostics) {
      const diagnostics = await client.callTool({ name: 'diagnostics', arguments: {} });
      const diagnosticsValue = toolText(diagnostics);
      console.log('DIAGNOSTICS');
      console.log(JSON.stringify(diagnosticsValue, null, 2));
      if (diagnostics?.isError || diagnosticsValue?.ok === false) failed = true;
    }
  } catch (error) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CLIENT_ERROR ${message}`);
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`CLIENT_ERROR ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
