# Native Codex MCP header helper.
#
# Prints exactly one JSON object of HTTP headers for the local Desktop MCP
# endpoint. The bearer token is read from the dedicated external token file and
# is written only to this process's stdout so Codex can attach it to MCP
# requests; the value is never logged, echoed elsewhere, or written to a file.
# Do not run this helper interactively in a terminal whose output is captured.
param(
    [string]$TokenFile
)
$ErrorActionPreference = 'Stop'

try {
    if (-not $TokenFile) {
        $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
        $TokenFile = Join-Path (Join-Path $dshHome 'desktop-mcp') 'token'
    }
    if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
        throw "token file not found at the configured external path"
    }
    $token = [IO.File]::ReadAllText($TokenFile, [Text.Encoding]::UTF8)
    $token = $token.TrimStart([char]0xFEFF).Trim()
    if ($token.Length -lt 32) { throw 'token file is empty or shorter than 32 characters' }
    if ($token -match '[\r\n\t ]') { throw 'token file contains whitespace or line breaks' }
    $headers = [ordered]@{ Authorization = "Bearer $token" }
    $json = $headers | ConvertTo-Json -Compress
    [Console]::Out.Write($json)
    exit 0
}
catch {
    [Console]::Error.WriteLine("header-helper: $($_.Exception.Message)")
    exit 1
}
