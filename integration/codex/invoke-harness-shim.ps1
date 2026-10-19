# Compatibility shim kept at the former launcher path.
#
# The canonical skill is now C:\Users\Administrator\.agents\skills\deepseek-executor
# and its normal launcher is scripts\invoke-desktop.ps1 there. This old path
# forwards to that launcher for callers that still use it; it deliberately has
# no SKILL.md, so it is not a second skill.
param(
    [string]$TaskFile,
    [string]$Workspace,
    [string]$LogFile,
    [string]$SessionId,
    [string]$StateFile,
    [string]$ResumeState,
    [switch]$Check,
    [switch]$Cancel
)
$ErrorActionPreference = 'Stop'
$canonical = '{{CANONICAL_LAUNCHER}}'
if (-not (Test-Path -LiteralPath $canonical -PathType Leaf)) {
    throw "Canonical Desktop launcher missing: $canonical"
}
$forward = @('-File', $canonical)
if ($TaskFile) { $forward += @('-TaskFile', $TaskFile) }
if ($Workspace) { $forward += @('-Workspace', $Workspace) }
if ($LogFile) { $forward += @('-LogFile', $LogFile) }
if ($SessionId) { $forward += @('-SessionId', $SessionId) }
if ($StateFile) { $forward += @('-StateFile', $StateFile) }
if ($ResumeState) { $forward += @('-ResumeState', $ResumeState) }
if ($Check) { $forward += '-Check' }
if ($Cancel) { $forward += '-Cancel' }
& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass @forward
exit $LASTEXITCODE
