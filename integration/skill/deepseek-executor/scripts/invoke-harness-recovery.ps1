# RECOVERY ONLY — legacy `dsh headless` executor.
#
# This is preserved solely as an explicit recovery path when the user directly
# asks to use the old headless executor (for example when Desktop cannot be
# opened). It is never an automatic fallback: it requires -IUnderstandRecovery
# (or DEEPSEEK_EXECUTOR_RECOVERY=1), it is a separate headless session, and it
# is not the Desktop executor. The normal executor is scripts/invoke-desktop.ps1.
param(
    [string]$TaskFile,
    [string]$Workspace,
    [string]$LogFile,
    [string]$SessionId,
    [switch]$Check,
    [switch]$IUnderstandRecovery
)
$ErrorActionPreference = 'Stop'

if (-not $IUnderstandRecovery -and $env:DEEPSEEK_EXECUTOR_RECOVERY -ne '1') {
    [Console]::Error.WriteLine('RECOVERY_ONLY: the headless executor is explicit recovery only. Use scripts/invoke-desktop.ps1 for the Desktop executor, or re-run with -IUnderstandRecovery when the user has directed headless recovery.')
    exit 3
}

$launcher = Join-Path $env:LOCALAPPDATA 'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "Harness launcher missing: $launcher" }
if ($Check) {
    & $launcher headless --help
    exit $LASTEXITCODE
}
if (-not $TaskFile -or -not $Workspace -or -not $LogFile) { throw 'TaskFile, Workspace and LogFile are required.' }
$taskPath = (Resolve-Path -LiteralPath $TaskFile).Path
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be a directory.' }
$logPath = [IO.Path]::GetFullPath($LogFile)
if (Test-Path -LiteralPath $logPath) { throw 'Use a new log filename to preserve earlier execution evidence.' }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($logPath)) | Out-Null
$taskText = [IO.File]::ReadAllText($taskPath)
if ([string]::IsNullOrWhiteSpace($taskText)) { throw 'Task file is empty.' }
$cliArgs = @('headless')
if ($SessionId) { $cliArgs += @('--session-id', $SessionId) }
$cliArgs += '-'
Push-Location -LiteralPath $workspacePath
try {
    $taskText | & $launcher @cliArgs *> $logPath
    $runExitCode = $LASTEXITCODE
} finally { Pop-Location }
Write-Output "Harness exit code: $runExitCode; log: $logPath"
exit $runExitCode
