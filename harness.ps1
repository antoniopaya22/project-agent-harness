# Shim so that `harness <cmd>` is the same command name on PowerShell and POSIX (D2).
# Usage:  ./harness status
$ErrorActionPreference = 'Stop'
$entry = Join-Path $PSScriptRoot '.harness/bin/harness.mjs'
if (-not (Test-Path $entry)) {
  Write-Error "harness entry point not found at $entry"
  exit 4
}
& node $entry @args
exit $LASTEXITCODE
