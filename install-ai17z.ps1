<#
.SYNOPSIS
  Prepares this machine to run AI17Z.

.DESCRIPTION
  Checks what AI17Z needs, creates a configuration file with a freshly generated
  master key, and installs dependencies. It does not install Docker, Node or
  Chrome for you -- it tells you exactly what is missing and where to get it,
  because silently installing software on somebody's machine is not a thing a
  setup script should do.

  Safe to run more than once. It never overwrites an existing .env, because that
  file holds the key your stored provider credentials are encrypted with.

.PARAMETER SkipInstall
  Check the machine and write configuration, but do not run npm install.
#>
[CmdletBinding()]
param([switch] $SkipInstall)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Done($Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn($Message) { Write-Host "  $Message" -ForegroundColor Yellow }

function Stop-WithReason($Message, $Fix) {
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Red
  if ($Fix) { Write-Host "  $Fix" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'AI17Z setup' -ForegroundColor White
Write-Host ''

# -- What has to be here -----------------------------------------------------
Write-Step 'Checking what this machine has...'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-WithReason 'Docker is not installed.' 'Get Docker Desktop from docker.com/products/docker-desktop, then run this again.'
}
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) {
  Stop-WithReason 'Docker is installed but not running.' 'Start Docker Desktop, wait for the whale to settle, then run this again.'
}
Write-Done 'Docker is running.'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithReason 'Node.js is not installed.' 'AI17Z needs Node 20 or newer for the worker that drives Chrome. Get it from nodejs.org, then run this again.'
}
$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 20) {
  Stop-WithReason "Node $nodeMajor is too old." 'AI17Z needs Node 20 or newer. Update from nodejs.org, then run this again.'
}
Write-Done "Node $(node --version) is fine."

$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) {
  Write-Done "Google Chrome found: $((Get-Item $chrome).VersionInfo.ProductVersion)"
} else {
  # Not fatal. Everything except connecting an X account works without it, and
  # somebody may be setting up on a machine before installing a browser.
  Write-Warn 'Google Chrome was not found.'
  Write-Warn 'AI17Z will install and run, but connecting an X account needs real Chrome.'
  Write-Warn 'Get it from google.com/chrome. Chromium and Edge are not substitutes.'
}

# -- Configuration -----------------------------------------------------------
if (Test-Path '.env') {
  Write-Done '.env already exists, leaving it alone.'
  Write-Warn 'It holds the key your stored provider credentials are encrypted with.'
} else {
  Write-Step 'Creating .env with a fresh master key...'
  if (-not (Test-Path '.env.example')) {
    Stop-WithReason '.env.example is missing.' 'This checkout looks incomplete. Clone the repository again.'
  }

  # Generated here, never shipped. Every installation gets its own.
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes)

  $lines = Get-Content '.env.example'
  $written = $false
  $out = foreach ($line in $lines) {
    if ($line -match '^\s*#?\s*AI17Z_MASTER_KEY\s*=') {
      $written = $true
      "AI17Z_MASTER_KEY=$key"
    } else {
      $line
    }
  }
  if (-not $written) { $out += "AI17Z_MASTER_KEY=$key" }
  $out | Set-Content '.env' -Encoding utf8

  Write-Done '.env created.'
  Write-Warn 'Back it up. Losing the master key makes every stored provider credential unreadable.'
}

# -- Dependencies ------------------------------------------------------------
if ($SkipInstall) {
  Write-Warn 'Skipping npm install, as asked.'
} else {
  Write-Step 'Installing dependencies (this takes a few minutes the first time)...'
  npm install
  if ($LASTEXITCODE -ne 0) {
    Stop-WithReason 'npm install failed.' 'The output above says why. A stale node_modules is the usual cause: delete it and run this again.'
  }
  Write-Done 'Dependencies installed.'
}

Write-Host ''
Write-Host '  Setup finished.' -ForegroundColor Green
Write-Host ''
Write-Host '  Next:' -ForegroundColor White
Write-Host '    .\start-ai17z.ps1     start everything' -ForegroundColor Gray
Write-Host '    .\doctor-ai17z.ps1    check it over' -ForegroundColor Gray
Write-Host ''
