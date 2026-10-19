# DeepSeek Harness Desktop MCP

Loopback-only MCP bridge that lets a local MCP client drive an **already-open**
DeepSeek Harness Desktop session: create standard-mode tasks, read bounded output,
continue, cancel, and inspect compatibility diagnostics. The Desktop runs the model;
the bridge exposes tools and requires a Bearer token from a dedicated external file.

Tested on Windows with Node.js 24 and DeepSeek Harness Desktop `0.2.1-rc.2`. Other
platforms and Desktop versions are unverified. MIT licensed.

## Capabilities

- Loopback-only HTTP MCP endpoint at `http://127.0.0.1:47821/mcp` (host fixed to
  `127.0.0.1`) with mandatory Bearer authentication.
- Six MCP tools:
  - `list_sessions` — bounded metadata for the configured default workspace only;
  - `submit_task` — creates a fresh standard-mode session (configured default
    workspace, or one explicitly enrolled project directory) and admits a task with
    an explicit idempotent `requestId`;
  - `get_task` — bounded visible output with a resumable `{seq, offset}` cursor,
    status, and durable completion evidence;
  - `continue_task` — steer or follow up on the same authorized session with an
    explicit `requestId`;
  - `cancel_task` — official active-turn cancel; it does not dispose the session or
    clear its inbox;
  - `diagnostics` — bridge/protocol, model-route, workspace, and tool-limit facts.
- Fixed route `deepseek-official` / `deepseek-flash` / `reasoningEffort: max`.
  Bridge-side checks fail closed on a mismatch; there is no model fallback.
- Sessions are created with `agentPreset: standard`; non-standard or unknown presets
  are not silently adopted on continuation or resume.
- Admission is not completion. Success requires consumed-input and completion
  evidence newer than the request baseline. No headless fallback and no background
  auto-updater are built in.

## Requirements

- Windows (tested; other platforms unverified).
- Node.js 24 or newer.
- DeepSeek Harness Desktop `0.2.1-rc.2` or a compatible build providing
  `ctx.sessionController`, `ctx.sessionQuery`, `ctx.agents`,
  `ctx.workspaceRegistry`, and `ctx.agentDefaultModel`.
- Desktop open and configured with the fixed model route above. The bridge runs
  inside the Desktop process; it does not start a Host.
- A private writable location for the token and non-secret bridge state, outside Git.

## Install

1. Install dependencies (network access to the npm registry is required):

   ```powershell
   npm ci
   ```

   `npm ci` uses the committed lockfile. The repository `.npmrc` disables install
   scripts; no lifecycle scripts are required.

2. Create the dedicated bearer token in a private external file:

   ```powershell
   npm run create-token
   ```

   Default path: `%DSH_HOME%\desktop-mcp\token`, otherwise
   `%USERPROFILE%\.dsh\desktop-mcp\token`. To choose another path:

   ```powershell
   node scripts/create-token.mjs --token-file "C:\secure\deepseek-desktop-mcp.token"
   ```

   The script refuses to overwrite an existing file, prints only the path, and never
   prints the token. Keep the file private; never commit it or paste its value into
   logs or chat. The plugin requires at least 32 characters and fails closed
   otherwise.

3. Configure the Desktop plugin. Edit [cordis.patch.yml](cordis.patch.yml) so
   `workspaceId` is your Desktop's **default workspace id**. The id committed in
   this repository is the author's local example and is not portable; `src/config.js`
   also carries the same local value as a fallback, so set `workspaceId` explicitly.
   Keep `port: 47821` unless it is already in use. `tokenFile` and `workspacesFile`
   are optional; their defaults are `$DSH_HOME/desktop-mcp/token` and
   `$DSH_HOME/desktop-mcp/workspaces.json`.

4. Install this checkout as a local bundle through the Desktop **Plugins** UI. The
   bundle patch inserts the `deepseek-desktop-mcp` listener row; enable the row, then
   toggle it Off/On after changes. If Desktop reports that a restart is required,
   restart it. Do not hand-edit `app.asar` or the Desktop's reserved profile.

5. Run the read-only compatibility check:

   ```powershell
   $env:DEEPSEEK_DESKTOP_MCP_ROOT = "<checkout>"
   powershell -NoProfile -ExecutionPolicy Bypass -File "<checkout>\integration\skill\deepseek-executor\scripts\invoke-desktop.ps1" -Check
   ```

   The launcher resolves the checkout from `-ProductRoot <checkout>` or
   `DEEPSEEK_DESKTOP_MCP_ROOT`; set one of them. A successful `CHECK` line reports
   the tool list, `bridge.protocol` (`deepseek-desktop-mcp/bridge/2`), the
   `workspacePath` and `standardMode` capabilities, the configured model route, and
   the configured default workspace. `stale_bridge` means the loaded bundle is
   older than the checked-out code; `model_route_mismatch` means Desktop's route is
   not the required route. The check never submits a task. After `npm ci`,
   `node src/dispatch.js --check` is the equivalent direct form.

## CLI: run and control tasks

The launcher is [invoke-desktop.ps1](integration/skill/deepseek-executor/scripts/invoke-desktop.ps1),
a wrapper around [src/dispatch.js](src/dispatch.js) with the same options, exit codes,
and per-request state/log files. Set up paths once:

```powershell
$Repo = "<checkout>"
$Launcher = Join-Path $Repo "integration\skill\deepseek-executor\scripts\invoke-desktop.ps1"
$env:DEEPSEEK_DESKTOP_MCP_ROOT = $Repo
```

New projectless task (configured default workspace):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -TaskFile .\task.md -LogFile .\run-1.log
```

New task in an exact project directory (explicit opt-in):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -TaskFile .\task.md -Workspace "C:\work\my-project" -LogFile .\run-2.log
```

Continue the same Desktop session:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -TaskFile .\task.md -SessionId <sessionId> -LogFile .\run-3.log
```

Resume after exit 3 or 5, using a new log file:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -TaskFile .\task.md -ResumeState .\run-3.log.state.json -LogFile .\run-4.log
```

For a continuation resume, add `-SessionId <sessionId>` to the resume command.

Cancel the active turn:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $Launcher -Cancel -StateFile .\run-3.log.state.json
```

The first dispatch prints `ADMITTED {...}` with the `sessionId`, `requestId`,
resolved workspace, and state path, then a bounded `RESULT {...}`. A new request
needs a new `-LogFile`; state defaults to `<log>.state.json`. Cancel writes a
separate `<state>.cancel.json` receipt and does not delete the execution state.
Exit codes: `0` completed, `2` failed, `3` blocked/pending, `4` canceled,
`5` running or wait timeout, `6` preflight/state/network error, and `130`
interrupted by Ctrl-C (the Desktop task keeps running). Exit 3 and 5 are resumable
with `-ResumeState`; they are not success. Run `node src/dispatch.js --help` after
`npm ci` for the raw option list.

## Workspace routing

| Request | Target workspace | Behavior |
|---|---|---|
| New task, no `-Workspace` | Configured default workspace | Submits without `workspacePath`; enrolls nothing and creates no extra workspace. |
| New task, explicit `-Workspace <dir>` | That exact existing project directory | Launcher canonicalizes and adds the directory to the non-secret allowlist; the bridge resolves or reuses the workspace. |
| Continuation, no `-Workspace` | The session's existing workspace | Derived from the session; the session is never re-homed. |
| Continuation with `-Workspace` | Must equal the session workspace | A mismatch is refused before `continue_task`. |
| `-ResumeState`, no explicit workspace | The workspace stored in that state | Request id, task hash, workspace, and target session are verified; default changes do not re-home a stored request. |

Notes:

- The configured default workspace is **not** a fallback for an invalid explicit
  project path or an unavailable default diagnostic.
- There is **no automatic Codex project detection**. A cwd, task-book directory, log
  directory, or artifact directory is an execution location, never project identity;
  only an explicit `-Workspace` selects a project workspace for a new task.
- `list_sessions` lists only the configured default workspace. Use `get_task`,
  `continue_task`, and `cancel_task` with session ids for enrolled project sessions.
- The allowlist is non-secret and holds exact canonical directories only. Roots,
  parents, globs, wildcards, unknown directories, and symlink escapes are refused.

## Standard mode and model route

- `submit_task` creates the session with an explicit `agentPreset: standard`; it
  never uses the default agent and never changes the global default.
- Continuation and resume reject non-standard or unknown presets before prompting.
- The required route is `deepseek-official` / `deepseek-flash` /
  `reasoningEffort: max`. Diagnostics reports the configured route and whether it
  matches; a mismatch fails closed. The bridge does not change Desktop model
  settings and has no account or model fallback.

## Optional: register as a native Codex MCP server

Copy [mcp-registration.toml.template](integration/codex/mcp-registration.toml.template)
and replace `{{HEADER_HELPER}}` with the absolute path to
`integration/skill/deepseek-executor/scripts/header-helper.ps1`:

```toml
[mcp_servers.deepseek_desktop]
url = "http://127.0.0.1:47821/mcp"
required = false
http_headers_helper = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "C:\path\to\integration\skill\deepseek-executor\scripts\header-helper.ps1"'
```

The helper reads the token from the default external token path and prints only the
`Authorization` header as JSON; no secret is stored in the TOML. If you configured a
custom `tokenFile`, append `-TokenFile "<absolute-path>"` to the helper command.
Start a fresh Codex session/turn after changing MCP configuration so the server and
its tools are loaded.

Any MCP client can also connect directly to the endpoint with an
`Authorization: Bearer <token>` header, reading the token from the external token
file.

## CLI or MCP?

Both interfaces use the same bridge, runtime, token, and Desktop session. Choose the
one that fits the caller:

| Interface | Good fit | What you get |
|---|---|---|
| CLI launcher (`invoke-desktop.ps1`) | Scripted executor lifecycle, retries, resumes, local orchestration | `ADMITTED`/`RESULT` output, JSONL logs, explicit exit codes, per-request state files |
| Native MCP tools | MCP-capable clients and agent integrations | Direct tool calls with structured results and idempotent `requestId` handling |

Routine CLI/MCP calls need no Computer Use. Computer Use is only for Desktop UI
installation or reload.

## Token, allowlist, and state

- The bearer token is external, private, and never committed or printed. Missing,
  empty, short, or unreadable token files fail closed. The plugin listener binds only
  to loopback.
- The workspace allowlist (`workspaces.json`) is non-secret. The configured default
  workspace is seeded; an explicit project opt-in appends that exact canonical
  directory before submit. A corrupt or unreadable allowlist makes explicit project
  submissions fail closed.
- Admission state (`admissions.json`) holds request/session ids, input hashes, modes,
  phases, and resolved workspace facts — never task text. State/log writes are
  atomic; corrupt reads fail new admissions closed.
- Each dispatch uses one `<log>.state.json` plus a UTF-8 JSONL log. Logs may contain
  visible task output, including sensitive content; treat logs and state as private.
  A cancel receipt is written separately and never overwrites the execution state.

## Migration and legacy helpers (optional, environment-specific)

- [scripts/migrate-codex.mjs](scripts/migrate-codex.mjs) is an optional migration
  helper for a legacy local Codex MCP registration/skill setup. It is not required
  for normal use, is not portable as-is, and this repository does not ship an
  applied migration state.
- The default mode prints a dry-run plan. `--apply` journals original fingerprints
  and backups before mutating anything; `--rollback` restores from a manifest,
  interrupted journal, or orphaned backup directory. Review
  `node scripts/migrate-codex.mjs --help` and the machine-specific defaults
  (`--codex-home`, `--agents-skills`, `--skill-source`, `--workdir`,
  `--default-workspace`, `--product-root`, `--private-root`, `--workspaces-file`)
  before applying anything, and keep the plan and backups outside Git.
- [invoke-harness-shim.ps1](integration/codex/invoke-harness-shim.ps1) is an optional
  compatibility shim; replace `{{CANONICAL_LAUNCHER}}` with the canonical launcher
  path before use. [invoke-harness-recovery.ps1](integration/skill/deepseek-executor/scripts/invoke-harness-recovery.ps1)
  is an explicit legacy headless recovery path only; it requires
  `-IUnderstandRecovery` (or `DEEPSEEK_EXECUTOR_RECOVERY=1`) and is never an
  automatic fallback. Normal use is the Desktop bridge.

## Honest limitations

- Desktop must stay running; the plugin lives inside the Desktop process and cannot
  start or revive a Host. Closing Desktop stops control.
- The fixed model route is mandatory. Change Desktop's route yourself if needed; the
  bridge never changes model settings and has no model or account fallback.
- `list_sessions` is scoped to the configured default workspace. Enrolled project
  sessions require explicit session ids.
- There is no automatic Codex project detection and no cwd-based project guess; an
  explicit project must be the exact existing directory you intend to use.
- There is no background auto-updater or update framework. Upgrade by replacing the
  checkout and reloading the bundle (Plugins Off/On; restart if Desktop requests it).
- Admission is not completion, and cancellation does not dispose a session or clear
  its inbox. No performance or cross-platform claims are made beyond the tested
  Windows/Node 24/Desktop context above.

## Development checks

```powershell
npm run check
npm test
```

## License

MIT — see [LICENSE](LICENSE).
