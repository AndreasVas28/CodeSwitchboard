# CodeSwitchboard installer for Windows.
#
# Public repo, from any PowerShell window:
#   irm https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.ps1 | iex
#
# Private repo (uses your saved git credentials):
#   git clone https://github.com/AndreasVas28/CodeSwitchboard.git "$env:USERPROFILE\CodeSwitchboard"
#   powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\CodeSwitchboard\install.ps1"
#
# Running the script from inside an existing checkout skips the clone step.
# If winget is unavailable (Windows Sandbox, stripped-down systems), the
# official Git and Node.js installers are downloaded and run silently instead.

param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE 'CodeSwitchboard')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.ServicePointManager]::SecurityProtocol } catch { }

$repoUrl = 'https://github.com/AndreasVas28/CodeSwitchboard.git'

# If this script file lives inside a checkout, operate on that checkout.
if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot 'package.json')) -and (Test-Path (Join-Path $PSScriptRoot 'install.ps1'))) {
  $InstallDir = $PSScriptRoot
}
$installDir = $InstallDir

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-WingetCommand {
  if (Test-Command 'winget') { return 'winget' }
  # Some elevated or restricted sessions lack the WindowsApps alias on PATH.
  $direct = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path $direct) { return $direct }
  return $null
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
  # Cover installers whose PATH edit is not visible to this session yet.
  foreach ($dir in @("$env:ProgramFiles\Git\cmd", "${env:ProgramFiles(x86)}\Git\cmd", "$env:ProgramFiles\nodejs")) {
    if ($dir -and (Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$env:Path;$dir" }
  }
}

function Get-NodeMajor {
  try { return [int]((node --version) -replace '^v', '' -replace '\..*$', '') } catch { return 0 }
}

function Invoke-InstallerDownload($url, $outFile) {
  Write-Host "==> Downloading $url" -ForegroundColor Cyan
  Invoke-WebRequest -Uri $url -OutFile $outFile -UseBasicParsing
}

function Get-LatestNodeLtsMsiUrl {
  $releases = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
  $lts = @($releases | Where-Object { $_.lts })[0]
  if (-not $lts) { throw 'Could not determine the latest Node.js LTS version.' }
  # version already includes the leading "v" (e.g. "v24.21.0").
  return "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
}

function Get-LatestGitInstallerUrl {
  # Assets are version-named (Git-2.x.y-64-bit.exe), so resolve via the API.
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/git-for-windows/git/releases/latest' -UseBasicParsing
  $asset = @($release.assets | Where-Object { $_.name -match '^Git-[\d.]+-64-bit\.exe$' })[0]
  if (-not $asset) { throw 'Could not find the latest Git for Windows installer asset.' }
  return $asset.browser_download_url
}

function Install-GitWithoutWinget {
  Write-Host '==> winget unavailable; installing Git from the official installer...' -ForegroundColor Yellow
  $installer = Join-Path $env:TEMP 'CodeSwitchboard-Git-installer.exe'
  Invoke-InstallerDownload (Get-LatestGitInstallerUrl) $installer
  $process = Start-Process -FilePath $installer -ArgumentList '/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES', '/NOCANCEL', '/SP-' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "The Git installer exited with code $($process.ExitCode)." }
}

function Install-NodeWithoutWinget {
  Write-Host '==> winget unavailable; installing Node.js LTS from the official installer...' -ForegroundColor Yellow
  $msi = Join-Path $env:TEMP 'CodeSwitchboard-Node-LTS.msi'
  Invoke-InstallerDownload (Get-LatestNodeLtsMsiUrl) $msi
  $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "The Node.js installer exited with code $($process.ExitCode)." }
}

Write-Host '==> CodeSwitchboard installer' -ForegroundColor Cyan

# --- 1. Prerequisites -------------------------------------------------------
  if (-not (Test-Command 'git')) {
  Write-Host '==> Git not found. Installing...' -ForegroundColor Yellow
  $winget = Get-WingetCommand
  if ($winget) {
    & $winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    Update-SessionPath
  }
  if (-not (Test-Command 'git')) { Install-GitWithoutWinget; Update-SessionPath }
  if (-not (Test-Command 'git')) {
    throw 'Git installation did not complete. Install it from https://git-scm.com/download/win and run the installer again.'
  }
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  Write-Host "==> Node.js 20+ not found (found: $(if ($nodeMajor) { $nodeMajor } else { 'none' })). Installing LTS..." -ForegroundColor Yellow
  $winget = Get-WingetCommand
  if ($winget) {
    & $winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    Update-SessionPath
  }
  if ((Get-NodeMajor) -lt 20) { Install-NodeWithoutWinget; Update-SessionPath }
  if ((Get-NodeMajor) -lt 20) {
    throw 'Node.js 20+ is still unavailable. Install it from https://nodejs.org and run the installer again.'
  }
}

# --- 2. Clone or update the repository -------------------------------------
$runningInsideCheckout = ($installDir -eq $PSScriptRoot)
if (-not $runningInsideCheckout -and -not (Test-Path (Join-Path $installDir 'package.json')) -and (Test-Path $installDir)) {
  throw "The target directory $installDir already exists but is not a CodeSwitchboard checkout. Remove it or pass -InstallDir."
}
if ($runningInsideCheckout) {
  Write-Host "==> Using the current checkout at $installDir" -ForegroundColor Cyan
} elseif (Test-Path (Join-Path $installDir '.git')) {
  Write-Host "==> Updating existing checkout at $installDir" -ForegroundColor Cyan
  git -C $installDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed. Resolve the checkout state and run the installer again.' }
} else {
  Write-Host "==> Cloning into $installDir" -ForegroundColor Cyan
  git clone $repoUrl $installDir
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
}

# --- 3. Dependencies + the global csb command -------------------------------
# PowerShell prefers npm.ps1 over npm.cmd, and the default Restricted
# execution policy blocks every .ps1 - so npm is invoked via npm.cmd.
function Get-NpmCommand {
  $cmd = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $shim = Join-Path $env:APPDATA 'npm\npm.cmd'
  if (Test-Path $shim) { return $shim }
  return $null
}

$npmCmd = Get-NpmCommand
if (-not $npmCmd) { throw 'npm.cmd was not found although Node.js is installed. Open a new PowerShell window and run the installer again.' }

Push-Location $installDir
try {
  Write-Host '==> Installing dependencies (npm ci)...' -ForegroundColor Cyan
  & $npmCmd ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. If a native build failed, install the Visual Studio C++ build tools and Python, then run the installer again.' }

  Write-Host '==> Linking the csb command (npm link)...' -ForegroundColor Cyan
  & $npmCmd link
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm link failed. You can still start CodeSwitchboard with: node bin\csb.js open' -ForegroundColor Yellow
  }

  # PowerShell prefers csb.ps1 over csb.cmd, and the default Restricted
  # execution policy blocks every .ps1. Removing the .ps1 shim makes the
  # bare `csb` command resolve to csb.cmd, which any policy allows.
  $globalPrefix = (& $npmCmd prefix -g 2>$null | Select-Object -First 1)
  if (-not $globalPrefix) { $globalPrefix = Join-Path $env:APPDATA 'npm' }
  $ps1Shim = Join-Path $globalPrefix 'csb.ps1'
  if (Test-Path $ps1Shim) {
    Remove-Item $ps1Shim -Force
    Write-Host 'Removed the csb.ps1 shim so csb works under any execution policy.' -ForegroundColor DarkGray
  }
} finally {
  Pop-Location
}

Write-Host ''
Write-Host 'CodeSwitchboard installed.' -ForegroundColor Green
Write-Host '  Start it:        csb open'
Write-Host '  Check status:    csb info'
Write-Host '  Install targets: csb install --recommended --yes'
Write-Host ''
if ((Get-ExecutionPolicy) -eq 'Restricted') {
  $prefixForNote = (& $npmCmd prefix -g 2>$null | Select-Object -First 1)
  if (-not $prefixForNote) { $prefixForNote = Join-Path $env:APPDATA 'npm' }
  if (Test-Path (Join-Path $prefixForNote 'csb.ps1')) {
    Write-Host 'NOTE: csb.ps1 could not be removed; under the Restricted policy use: csb.cmd open' -ForegroundColor Yellow
  }
}
