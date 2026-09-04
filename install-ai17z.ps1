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

.PARAMETER Start
  Start AI17Z as soon as setup finishes, so the whole thing is one command.

.PARAMETER AllowSyncedFolder
  Install even though this folder is inside OneDrive, Dropbox or similar.
  npm's symlinks fail intermittently there; only use this if yours is known to
  work.
#>
[CmdletBinding()]
param([switch] $SkipInstall, [switch] $Start, [switch] $AllowSyncedFolder, [switch] $NoShortcut)

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
  Stop-WithReason 'Node.js is not installed.' 'AI17Z needs Node 22 or newer for the worker that drives Chrome. Get it from nodejs.org, then run this again.'
}
$nodeMajor = [int](((node --version) -replace '^v', '') -split '\.')[0]
if ($nodeMajor -lt 22) {
  Stop-WithReason "Node $nodeMajor is too old." 'AI17Z needs Node 22 or newer. Update from nodejs.org, then run this again.'
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

# -- Where this is being installed -------------------------------------------
#
# npm workspaces link every package into node_modules with a real symlink, and
# a file-syncing folder will not reliably let that happen. OneDrive, Dropbox,
# Google Drive and iCloud all put a filter driver in front of the directory;
# while it is reconciling a freshly created tree, the symlink call comes back
# EBUSY. It is not deterministic, which is worse than if it were: an install can
# work, and the next one in the same place fails on a different package.
#
# This matters more on Windows than it sounds, because Desktop and Documents are
# inside OneDrive by default on a new machine, so "clone it to my Desktop" is
# the normal thing to do and the thing that breaks.
#
# Refused rather than warned. The failure it prevents arrives several minutes
# later as `EBUSY: resource busy or locked, symlink`, which says nothing about
# folders or syncing and sends people looking at npm.
$here = (Get-Location).Path
$syncRoots = @(
  @{ Name = 'OneDrive'; Path = $env:OneDrive },
  @{ Name = 'OneDrive'; Path = $env:OneDriveCommercial },
  @{ Name = 'OneDrive'; Path = $env:OneDriveConsumer },
  @{ Name = 'Dropbox'; Path = (Join-Path $env:USERPROFILE 'Dropbox') },
  @{ Name = 'Google Drive'; Path = (Join-Path $env:USERPROFILE 'Google Drive') },
  @{ Name = 'iCloud Drive'; Path = (Join-Path $env:USERPROFILE 'iCloudDrive') }
) | Where-Object { $_.Path -and (Test-Path $_.Path) }

$inSync = $syncRoots | Where-Object { $here.StartsWith($_.Path, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
if ($inSync -and -not $AllowSyncedFolder) {
  Stop-WithReason `
    "This folder is inside $($inSync.Name), which cannot host a Node project reliably." `
    ("npm links each package into node_modules with a symlink, and a syncing folder refuses those while it reconciles: you get`n" +
     "  EBUSY: resource busy or locked, symlink`n`n" +
     "  Move it somewhere outside $($inSync.Name) and run this again. Anywhere on the disk that is not synced will do:`n" +
     "    C:\dev\ai17z    or    $env:USERPROFILE\ai17z`n`n" +
     "  If you are certain your setup is fine, re-run with -AllowSyncedFolder.")
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
  # Named after the folder it was installed into.
  #
  # The compose project name decides which Docker volumes an installation uses,
  # and it defaulted to `xbam` for everybody. Two checkouts on one machine
  # therefore shared a database, browser profiles and storage without either of
  # them saying so -- so a throwaway clone made for testing quietly attached to
  # the signed-in account and the real data of a working installation.
  #
  # Only ever written into a NEW .env. An existing installation keeps whatever
  # name it already had, so updating in place with `git pull` still finds its own
  # data, which is the reason the default was `xbam` in the first place.
  $folder = (Split-Path -Leaf (Get-Location)).ToLower() -replace '[^a-z0-9]+', '-'
  $folder = $folder.Trim('-')
  if (-not $folder) { $folder = 'ai17z' }
  if ($out -notmatch '^\s*AI17Z_INSTANCE\s*=\s*\S') {
    $out += ''
    $out += "# This installation's own Docker volumes and container names."
    $out += "AI17Z_INSTANCE=$folder"
  }

  $out | Set-Content '.env' -Encoding utf8

  Write-Done ".env created. This installation is named '$folder'."
  Write-Warn 'Its database and browser profiles are its own; no other checkout shares them.'
  Write-Warn 'Back it up. Losing the master key makes every stored provider credential unreadable.'
}

# -- Dependencies ------------------------------------------------------------
if ($SkipInstall) {
  Write-Warn 'Skipping npm install, as asked.'
} else {
  Write-Step 'Installing dependencies (this takes a few minutes the first time)...'
  npm install
  if ($LASTEXITCODE -ne 0) {
    Stop-WithReason 'npm install failed.' ("The output above says why. Two common causes:`n" +
      "    EBUSY / symlink   the folder is inside OneDrive or another syncing folder. Move it out.`n" +
      "    anything else     a stale node_modules. Delete it and run this again.")
  }
  Write-Done 'Dependencies installed.'
}

# -- Something to click ------------------------------------------------------
#
# A Start Menu entry rather than a desktop one: a desktop littered by every
# tool somebody tried is its own small unkindness, and the Start Menu is where
# Windows users look for a program by name.
#
# It points at launch-ai17z.ps1 rather than at start-ai17z.ps1, because
# somebody double-clicking an icon wants the app open, not a console that
# finishes and leaves them to find the address themselves.
if (-not $NoShortcut) {
  try {
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    $linkPath = Join-Path $startMenu "AI17Z ($folder).lnk"
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = (Get-Command powershell).Source
    $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'launch-ai17z.ps1')`""
    $link.WorkingDirectory = $PSScriptRoot
    $link.Description = 'Start AI17Z and open it'
    $link.Save()
    Write-Done "Added 'AI17Z ($folder)' to the Start Menu."
  } catch {
    # Never a reason to fail an install. The scripts work without it.
    Write-Warn 'Could not add a Start Menu shortcut. Everything else is fine; use the scripts below.'
  }
}

Write-Host ''
Write-Host '  Setup finished.' -ForegroundColor Green
Write-Host ''

# Started from here when asked, so somebody can install and run in one command
# rather than reading which script comes next. Setup is idempotent and start is
# idempotent, so this is safe to repeat.
if ($Start) {
  & (Join-Path $PSScriptRoot 'start-ai17z.ps1')
  exit $LASTEXITCODE
}

Write-Host '  Next:' -ForegroundColor White
Write-Host '    .\launch-ai17z.ps1    start it and open it' -ForegroundColor Gray
Write-Host '    .\start-ai17z.ps1     start everything' -ForegroundColor Gray
Write-Host '    .\doctor-ai17z.ps1    check it over' -ForegroundColor Gray
Write-Host ''
