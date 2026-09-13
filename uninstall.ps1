# CodeSwitchboard uninstaller for Windows.
#
# From inside the repository folder:
#   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
#
# Options:
#   -Purge     also delete saved settings and bridge state
#   -KeepApps  skip restoring Codex and Claude Desktop to their normal accounts

param(
  [switch]$Purge,
  [switch]$KeepApps
)

$ErrorActionPreference = 'Stop'

$installDir = Join-Path $env:USERPROFILE 'CodeSwitchboard'

# If this script lives inside a real checkout, operate on that checkout.
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json')) -and (Test-Path (Join-Path $PSScriptRoot 'uninstall.ps1')) -and (Test-Path (Join-Path $PSScriptRoot '.git'))) {
  $installDir = $PSScriptRoot
}

Write-Host '==> CodeSwitchboard uninstaller' -ForegroundColor Cyan

# --- 1. Let csb uninstall do the app restores, server stop, purge, and link removal ---
$csb = Join-Path $installDir 'bin\csb.js'
if (Test-Path $csb) {
  $csbArgs = @('uninstall', '--yes')
  if ($Purge) { $csbArgs += '--purge' }
  if ($KeepApps) { $csbArgs += '--keep-apps' }
  & node $csb @csbArgs
  if ($LASTEXITCODE -ne 0) { throw "csb uninstall failed with exit code $LASTEXITCODE." }
} else {
  Write-Host "==> No csb.js found at $csb; removing the npm link only." -ForegroundColor Yellow
  & npm uninstall -g codeswitchboard
}

# --- 2. Remove the repository folder ---
$scriptIsInsideInstall = ($installDir -eq $PSScriptRoot)
if (-not $scriptIsInsideInstall -and (Test-Path $installDir)) {
  Write-Host "==> Removing $installDir" -ForegroundColor Cyan
  Remove-Item -Recurse -Force $installDir
}

Write-Host ''
Write-Host 'CodeSwitchboard uninstalled.' -ForegroundColor Green
if ($scriptIsInsideInstall) {
  Write-Host "The repository folder ($installDir) is the folder this script ran from; delete it yourself when you are done."
}
