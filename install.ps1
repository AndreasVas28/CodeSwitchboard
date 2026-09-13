# CodeSwitchboard installer for Windows.
#
# Run from any PowerShell window:
#   irm https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$repoUrl    = 'https://github.com/AndreasVas28/CodeSwitchboard.git'
$installDir = Join-Path $env:USERPROFILE 'CodeSwitchboard'

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Update-SessionPath {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-NodeMajor {
  try { return [int]((node --version) -replace '^v', '' -replace '\..*$', '') } catch { return 0 }
}

Write-Host '==> CodeSwitchboard installer' -ForegroundColor Cyan

# --- 1. Prerequisites -------------------------------------------------------
if (-not (Test-Command 'git')) {
  Write-Host '==> Git not found. Installing with winget...' -ForegroundColor Yellow
  if (Test-Command 'winget') {
    winget install --id Git.Git -e --source winget --accept-source-agreements --accept-package-agreements
    Update-SessionPath
  } else {
    throw 'Git is required. Install it from https://git-scm.com/download/win and run the installer again.'
  }
  if (-not (Test-Command 'git')) {
    throw 'Git was installed but is not on PATH yet. Open a new PowerShell window and run the installer again.'
  }
}

$nodeMajor = Get-NodeMajor
if ($nodeMajor -lt 20) {
  Write-Host "==> Node.js 20+ not found (found: $(if ($nodeMajor) { $nodeMajor } else { 'none' })). Installing LTS with winget..." -ForegroundColor Yellow
  if (Test-Command 'winget') {
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements
    Update-SessionPath
  } else {
    throw 'Node.js 20 or newer is required. Install it from https://nodejs.org and run the installer again.'
  }
  if ((Get-NodeMajor) -lt 20) {
    throw 'Node.js 20+ is still unavailable. Open a new PowerShell window and run the installer again.'
  }
}

# --- 2. Clone or update the repository -------------------------------------
if (Test-Path (Join-Path $installDir '.git')) {
  Write-Host "==> Updating existing checkout at $installDir" -ForegroundColor Cyan
  git -C $installDir pull --ff-only
  if ($LASTEXITCODE -ne 0) { throw 'git pull failed. Resolve the checkout state and run the installer again.' }
} else {
  Write-Host "==> Cloning into $installDir" -ForegroundColor Cyan
  git clone $repoUrl $installDir
  if ($LASTEXITCODE -ne 0) { throw 'git clone failed.' }
}

# --- 3. Dependencies + the global csb command -------------------------------
Push-Location $installDir
try {
  Write-Host '==> Installing dependencies (npm ci)...' -ForegroundColor Cyan
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. If a native build failed, install the Visual Studio C++ build tools and Python, then run the installer again.' }

  Write-Host '==> Linking the csb command (npm link)...' -ForegroundColor Cyan
  npm link
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'npm link failed. You can still start CodeSwitchboard with: node bin\csb.js open' -ForegroundColor Yellow
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
Write-Host 'If csb is not found, open a new PowerShell window first.'
