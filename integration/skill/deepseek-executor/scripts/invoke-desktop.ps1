# DeepSeek Desktop executor launcher (canonical skill entry).
#
# Calls the real already-open Desktop MCP bridge through the official MCP SDK
# client in the product checkout. It never invokes `dsh headless` and never
# starts a Host. The token is read by the client from its external file and is
# never printed.
param(
    [string]$TaskFile,
    [string]$Workspace,
    [string]$LogFile,
    [string]$SessionId,
    [string]$StateFile,
    [string]$ResumeState,
    [switch]$Check,
    [switch]$Cancel,
    [int]$WaitMs = 600000,
    [int]$PollMs = 2000,
    [int]$MaxEvents = 40,
    [int]$MaxChars = 12000,
    [string]$Url,
    [string]$TokenFile,
    [string]$WorkspacesFile,
    [string]$ProductRoot
)
$ErrorActionPreference = 'Stop'

function Resolve-ProductRoot {
    param([string]$Explicit)
    $candidates = @()
    if ($Explicit) { $candidates += $Explicit }
    if ($env:DEEPSEEK_DESKTOP_MCP_ROOT) { $candidates += $env:DEEPSEEK_DESKTOP_MCP_ROOT }
    $candidates += 'C:\Users\Administrator\Documents\Codex\2026-10-18\deep\outputs\deepseek-desktop-mcp'
    foreach ($candidate in $candidates) {
        $dispatch = Join-Path $candidate 'src\dispatch.js'
        if (Test-Path -LiteralPath $dispatch -PathType Leaf) { return $candidate }
    }
    throw "Desktop MCP product checkout not found. Set DEEPSEEK_DESKTOP_MCP_ROOT or pass -ProductRoot. Last candidate: $($candidates[-1])"
}

function Resolve-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command -and $command.Source) { return $command.Source }
    $fallbacks = @(
        "$env:ProgramFiles\nodejs\node.exe",
        "$env:LOCALAPPDATA\OpenAI\Codex\runtimes\cua_node\78fb63cda1a9e2b2\bin\node.exe"
    )
    foreach ($candidate in $fallbacks) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return $candidate }
    }
    throw 'Node.js 24+ was not found on PATH; install Node or expose it on PATH for the executor launcher.'
}

$root = Resolve-ProductRoot -Explicit $ProductRoot
$dispatch = Join-Path $root 'src\dispatch.js'
$node = Resolve-Node

$arguments = @($dispatch)
if ($Check) { $arguments += '--check' }
if ($Cancel) { $arguments += '--cancel' }
if ($TaskFile) { $arguments += @('--task-file', $TaskFile) }
if ($Workspace) { $arguments += @('--workspace', $Workspace) }
if ($LogFile) { $arguments += @('--log-file', $LogFile) }
if ($SessionId) { $arguments += @('--session-id', $SessionId) }
if ($StateFile) { $arguments += @('--state-file', $StateFile) }
if ($ResumeState) { $arguments += @('--resume-state', $ResumeState) }
if ($Url) { $arguments += @('--url', $Url) }
if ($TokenFile) { $arguments += @('--token-file', $TokenFile) }
if ($WorkspacesFile) { $arguments += @('--workspaces-file', $WorkspacesFile) }
$arguments += @('--wait-ms', [string]$WaitMs, '--poll-ms', [string]$PollMs)
$arguments += @('--max-events', [string]$MaxEvents, '--max-chars', [string]$MaxChars)

& $node @arguments
exit $LASTEXITCODE
