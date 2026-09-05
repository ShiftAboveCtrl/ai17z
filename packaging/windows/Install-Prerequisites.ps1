# Installs what AI17Z needs, with the owner watching.
#
# ASCII only, on purpose. A .ps1 without a BOM is read as ANSI, and one smart
# quote from a pasted em dash terminates a string somewhere unrelated.
#
# ---------------------------------------------------------------------------
# What this does, and what it deliberately does not
# ---------------------------------------------------------------------------
#
# AI17Z needs three things it cannot ship: Node.js to run, Docker Desktop to
# hold the database, and Google Chrome to act as. Telling somebody to go and
# find three installers is a bad first ten minutes, so this offers to fetch
# them.
#
# It fetches them through **winget**, Microsoft's own package manager, and
# nothing else. That matters more than it sounds: winget resolves each package
# from the Microsoft-run community repository and verifies the installer hash
# before running it. Downloading an .exe from a URL this script had baked in
# would mean trusting a link that could rot, redirect, or be replaced, and
# nobody would notice.
#
# If winget is not available, this **opens the vendor's own download page** and
# stops. It never falls back to fetching a binary itself. A setup program that
# silently downloads and runs executables is the exact shape of the thing people
# are right to be afraid of.
#
# Everything is opt-in per item, everything is named before it happens, and the
# script says what it is doing while it does it.

[CmdletBinding()]
param(
  # Which to install, comma separated: "node,docker,chrome".
  #
  # A single string rather than a string array, because powershell.exe -File
  # cannot pass an array: "-Install node,docker,chrome" arrives as one value
  # that fails ValidateSet, and spelling it with spaces is a positional
  # parameter error. -File is how the installer calls this, so the calling
  # convention has to be the one that survives it.
  [string] $Install = '',

  # Print what would happen and change nothing.
  [switch] $WhatIfOnly,

  # Set by the installer so a failure does not leave a window nobody reads.
  [switch] $Pause
)

$ErrorActionPreference = 'Stop'

# The lowest Node this project runs on. Kept in step with package.json engines
# and the version test that pins CI, the Dockerfiles and the types together.
$MinimumNodeMajor = 22

$Packages = @{
  node   = @{ Id = 'OpenJS.NodeJS.LTS';    Name = 'Node.js (LTS)';   Page = 'https://nodejs.org/en/download';                     Why = 'runs AI17Z itself' }
  docker = @{ Id = 'Docker.DockerDesktop'; Name = 'Docker Desktop';  Page = 'https://www.docker.com/products/docker-desktop/';    Why = 'runs the PostgreSQL database AI17Z stores everything in' }
  chrome = @{ Id = 'Google.Chrome';        Name = 'Google Chrome';   Page = 'https://www.google.com/chrome/';                     Why = 'is the browser AI17Z drives; no other browser substitutes for it' }
}

function Write-Step($Message) { Write-Host ""; Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Note($Message) { Write-Host "  $Message" -ForegroundColor DarkGray }
function Write-Good($Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Bad($Message)  { Write-Host "  $Message" -ForegroundColor Yellow }

function Get-NodeMajor {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try {
    $raw = & node --version 2>$null
    if ($raw -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return $null
}

function Test-ChromeInstalled {
  $paths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($p in $paths) { if (Test-Path $p) { return $true } }
  return $false
}

function Test-DockerInstalled {
  if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
  return (Test-Path "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe")
}

# What is present, what is missing, and what is present but too old.
function Get-Status {
  $nodeMajor = Get-NodeMajor
  [pscustomobject]@{
    NodeMajor   = $nodeMajor
    NodeOk      = ($null -ne $nodeMajor -and $nodeMajor -ge $MinimumNodeMajor)
    NodeTooOld  = ($null -ne $nodeMajor -and $nodeMajor -lt $MinimumNodeMajor)
    DockerOk    = (Test-DockerInstalled)
    ChromeOk    = (Test-ChromeInstalled)
    HasWinget   = ($null -ne (Get-Command winget -ErrorAction SilentlyContinue))
  }
}

function Show-Status($s) {
  Write-Step "What AI17Z found on this machine"
  if ($s.NodeOk) {
    Write-Good "Node.js $($s.NodeMajor).x is installed."
  } elseif ($s.NodeTooOld) {
    Write-Bad "Node.js $($s.NodeMajor).x is installed, but AI17Z needs $MinimumNodeMajor or newer."
  } else {
    Write-Bad "Node.js is not installed. It $($Packages.node.Why)."
  }
  if ($s.DockerOk) { Write-Good "Docker Desktop is installed." }
  else { Write-Bad "Docker Desktop is not installed. It $($Packages.docker.Why)." }
  if ($s.ChromeOk) { Write-Good "Google Chrome is installed." }
  else { Write-Bad "Google Chrome is not installed. It $($Packages.chrome.Why)." }
}

# One package, through winget, with the whole command shown first.
function Install-One($Key) {
  $pkg = $Packages[$Key]
  $args = @(
    'install', '--exact', '--id', $pkg.Id,
    # Silent where the vendor's installer supports it, so this is one flow
    # rather than three nested setup wizards.
    '--silent',
    # Only the Microsoft-run repository. Never an arbitrary source somebody
    # added to this machine, which would defeat the point of using winget.
    '--source', 'winget',
    '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity'
  )

  Write-Step "Installing $($pkg.Name)"
  Write-Note "Package : $($pkg.Id)"
  Write-Note "Source  : winget, Microsoft's package repository"
  Write-Note "Command : winget $($args -join ' ')"
  Write-Note "winget checks the installer's hash before running it."

  if ($WhatIfOnly) { Write-Note 'Nothing was installed (-WhatIfOnly).'; return $true }

  & winget @args
  $code = $LASTEXITCODE

  # Ask the machine, do not read the exit code.
  #
  # winget has a large table of negative codes and several of them mean
  # success: already installed, no applicable upgrade. Trying to enumerate them
  # is how this went wrong once already -- -1978335212 looks like "already
  # there" and actually means "no such package", so a typo in a package id
  # would have been reported as a successful install.
  #
  # Detection is the same check that decided the item was missing in the first
  # place, so a pass means the thing is genuinely present now.
  $now = Get-Status
  $present = switch ($Key) {
    'node'   { $now.NodeOk }
    'docker' { $now.DockerOk }
    'chrome' { $now.ChromeOk }
    default  { $false }
  }

  if ($present) {
    Write-Good "$($pkg.Name) is installed."
    return $true
  }

  Write-Bad "$($pkg.Name) is still not installed (winget exit code $code)."
  Write-Note "You can install it yourself from $($pkg.Page)"
  return $false
}

function Open-VendorPage($Key) {
  $pkg = $Packages[$Key]
  Write-Step "$($pkg.Name) has to be installed by hand on this machine"
  Write-Note "winget is not available here, and AI17Z will not download an"
  Write-Note "installer from a link of its own instead."
  Write-Note "Opening $($pkg.Page)"
  if (-not $WhatIfOnly) { Start-Process $pkg.Page }
}

# ---------------------------------------------------------------------------

Write-Host ""
Write-Host "  AI17Z prerequisites" -ForegroundColor White
Write-Host "  -------------------" -ForegroundColor DarkGray

$status = Get-Status
Show-Status $status

$known = @('node', 'docker', 'chrome')
$wanted = @()
foreach ($item in ($Install -split ',')) {
  $name = $item.Trim().ToLowerInvariant()
  if (-not $name) { continue }
  if ($known -contains $name) { $wanted += $name }
  else { Write-Bad "Ignoring '$name': not one of $($known -join ', ')." }
}

if ($wanted.Count -eq 0) {
  Write-Step "Nothing was asked for, so nothing was changed."
  Write-Note "Run this again from the Start Menu, or install the items above yourself."
  if ($Pause) { Write-Host ""; Read-Host '  Press Enter to close' }
  exit 0
}

# Never reinstall something already good. An installer that reinstalls Chrome
# because a checkbox was left ticked is an installer nobody trusts twice.
$todo = @()
foreach ($key in $wanted) {
  switch ($key) {
    'node'   { if (-not $status.NodeOk)   { $todo += $key } else { Write-Note "Skipping Node.js: already $($status.NodeMajor).x" } }
    'docker' { if (-not $status.DockerOk) { $todo += $key } else { Write-Note 'Skipping Docker Desktop: already installed' } }
    'chrome' { if (-not $status.ChromeOk) { $todo += $key } else { Write-Note 'Skipping Google Chrome: already installed' } }
  }
}

if ($todo.Count -eq 0) {
  Write-Step 'Everything asked for is already installed.'
  if ($Pause) { Write-Host ""; Read-Host '  Press Enter to close' }
  exit 0
}

Write-Step ("About to install: " + (($todo | ForEach-Object { $Packages[$_].Name }) -join ', '))
Write-Note 'Each one comes from its own vendor, through winget. Nothing else is changed.'

$failed = @()
foreach ($key in $todo) {
  if (-not $status.HasWinget) { Open-VendorPage $key; $failed += $key; continue }
  if (-not (Install-One $key)) { $failed += $key }
}

Write-Host ""
if ($failed.Count -eq 0) {
  Write-Good 'All done. Start AI17Z from the Start Menu or the desktop.'
  Write-Note 'If Node.js was just installed, open a new window first so it is on PATH.'
} else {
  Write-Bad ("Still missing: " + (($failed | ForEach-Object { $Packages[$_].Name }) -join ', '))
  Write-Note 'AI17Z will start and tell you what it cannot do until these are present.'
}
Write-Host ""

if ($Pause) { Read-Host '  Press Enter to close' }
# Zero even when something failed: this is an optional convenience, and a
# non-zero exit here would fail the installation that called it.
exit 0
