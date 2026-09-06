<#
.SYNOPSIS
  Checks whether this machine can run AI17Z, and says what is missing.

.DESCRIPTION
  Reports on every part AI17Z needs, and distinguishes three different things
  that all look like failure to a new user:

    PASS            it works
    NOT CONFIGURED  it works, you have not set it up yet
    FAIL            it is broken and here is what to do

  A fresh installation with no X account and no AI provider is not broken. It is
  a fresh installation. Reporting that as an error is how somebody concludes the
  software does not work and stops.

  Reads only. Starts nothing, changes nothing.

.PARAMETER Json
  Emit machine-readable output instead of the summary.
#>
[CmdletBinding()]
param([switch] $Json)

$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot

$results = New-Object System.Collections.ArrayList

function Add-Result($Name, $Status, $Detail, $Fix) {
  [void]$results.Add([pscustomobject]@{
    name   = $Name
    status = $Status
    detail = $Detail
    fix    = $Fix
  })
}

# Where the environment file lives.
#
# AI17Z.cmd sets AI17Z_ENV_FILE before handing over, but the Start Menu runs
# some of these scripts directly -- "Stop AI17Z" and "AI17Z diagnostics" are
# shortcuts to powershell.exe, not to AI17Z.cmd -- so the variable is absent
# exactly when somebody is trying to stop or fix something. `data-location.txt`
# is what the installer wrote for that case. A clone has neither and keeps the
# .env beside the script, which is what a developer expects.
function Resolve-Ai17zEnvFile($Root) {
  if ($env:AI17Z_ENV_FILE) { return $env:AI17Z_ENV_FILE }
  if ($env:XBAM_ENV_FILE) { return $env:XBAM_ENV_FILE }
  $pointer = Join-Path $Root 'data-location.txt'
  if (Test-Path $pointer) {
    $dataDir = (Get-Content $pointer -First 1).Trim()
    if ($dataDir) { return (Join-Path $dataDir '.env') }
  }
  return (Join-Path $Root '.env')
}

# The paths AI17Z.cmd exports, for the scripts a shortcut runs directly.
#
# The Start Menu runs "AI17Z diagnostics" and "Stop AI17Z" through powershell.exe
# with a script path, so they inherit none of them -- and anything they call
# then falls back to a relative default that resolves against the program
# directory. The diagnostics did exactly that: its browser check created
# storage\browser-profiles beside the program, in the directory an upgrade
# replaces and the uninstaller empties. A signed-in browser profile written
# there would be lost on the next upgrade.
#
# Only for an installed copy, and only where nothing is set already: in a clone
# the data directory *is* the script directory, and the conventional ./storage
# layout is what a developer already has.
function Set-Ai17zDataPaths($EnvFile, $Root) {
  $dataDir = Split-Path -Parent $EnvFile
  if (-not $dataDir) { return }
  if ($dataDir.TrimEnd('\') -ieq $Root.TrimEnd('\')) { return }
  if (-not $env:AI17Z_STORAGE_DIR) { $env:AI17Z_STORAGE_DIR = Join-Path $dataDir 'storage' }
  if (-not $env:XBAM_STORAGE_DIR) { $env:XBAM_STORAGE_DIR = $env:AI17Z_STORAGE_DIR }
  if (-not $env:AI17Z_BROWSER_PROFILE_DIR) { $env:AI17Z_BROWSER_PROFILE_DIR = Join-Path $dataDir 'browser-profiles' }
  if (-not $env:XBAM_BROWSER_PROFILE_DIR) { $env:XBAM_BROWSER_PROFILE_DIR = $env:AI17Z_BROWSER_PROFILE_DIR }
}

$EnvFile = Resolve-Ai17zEnvFile $PSScriptRoot
Set-Ai17zDataPaths $EnvFile $PSScriptRoot

function Get-EnvValue($Key) {
  if (-not (Test-Path $EnvFile)) { return $null }
  foreach ($line in Get-Content $EnvFile) {
    if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.*)$") {
      return $matches[1].Trim().Trim('"')
    }
  }
  return $null
}

# -- Instance ----------------------------------------------------------------
$instance = Get-EnvValue 'AI17Z_INSTANCE'
if (-not $instance) { $instance = 'xbam (default)' }
Add-Result 'Instance' 'INFO' $instance ''

# -- Docker ------------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Add-Result 'Docker' 'FAIL' 'Not on PATH.' 'Install Docker Desktop, then run this again.'
} else {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) {
    Add-Result 'Docker' 'PASS' 'Running.' ''
    docker compose version *> $null
    if ($LASTEXITCODE -eq 0) {
      Add-Result 'Compose' 'PASS' 'Available.' ''
    } else {
      Add-Result 'Compose' 'FAIL' 'docker compose is not available.' 'Update Docker Desktop; Compose v2 ships with it.'
    }
  } else {
    Add-Result 'Docker' 'FAIL' 'Installed but not running.' 'Start Docker Desktop and wait for it to settle.'
  }
}

# -- Configuration -----------------------------------------------------------
# Named, because "no .env file yet" is useless without saying which one was
# looked for. This read the program directory, where an installed copy has no
# environment file at all -- so the diagnostics tool, the thing somebody opens
# when they are already stuck, told a perfectly healthy installation it was not
# configured and sent them to a script that is not even shipped.
if (-not (Test-Path $EnvFile)) {
  Add-Result 'Configuration' 'NOT CONFIGURED' "No environment file at $EnvFile." 'Start AI17Z once: it writes this file, with a fresh master key, on its first run.'
} else {
  Add-Result 'Configuration' 'PASS' "Present at $EnvFile." ''
}

$masterKey = Get-EnvValue 'AI17Z_MASTER_KEY'
if (-not $masterKey) { $masterKey = Get-EnvValue 'XBAM_MASTER_KEY' }
if (-not $masterKey) {
  Add-Result 'Master key' 'NOT CONFIGURED' 'Not set.' 'Start AI17Z once: it writes one on its first run. Provider keys cannot be stored without it.'
} else {
  # Length only. The value is never printed, and never logged.
  try {
    $bytes = [Convert]::FromBase64String($masterKey)
    if ($bytes.Length -eq 32) {
      Add-Result 'Master key' 'PASS' 'Present, 32 bytes.' ''
    } else {
      Add-Result 'Master key' 'FAIL' "Decodes to $($bytes.Length) bytes, not 32." 'Generate a new one only if nothing is stored yet: an existing key cannot be replaced without losing every saved provider credential.'
    }
  } catch {
    Add-Result 'Master key' 'FAIL' 'Not valid base64.' 'See .env.example for how to generate one.'
  }
}

# -- Ports -------------------------------------------------------------------
function Test-PortFree($Port) {
  $inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return -not $inUse
}

$apiPort = Get-EnvValue 'AI17Z_API_PORT'; if (-not $apiPort) { $apiPort = '8787' }
$webPort = Get-EnvValue 'AI17Z_WEB_PORT'; if (-not $webPort) { $webPort = '8080' }
$pgPort  = Get-EnvValue 'POSTGRES_PORT';  if (-not $pgPort)  { $pgPort  = '55432' }

# A port in use by AI17Z itself is not a conflict, so this only reports.
$busy = @()
foreach ($p in @($apiPort, $webPort, $pgPort)) {
  if (-not (Test-PortFree ([int]$p))) { $busy += $p }
}
if ($busy.Count -eq 0) {
  Add-Result 'Ports' 'PASS' "$apiPort, $webPort, $pgPort free." ''
} else {
  Add-Result 'Ports' 'INFO' "In use: $($busy -join ', '). Fine if that is AI17Z already running." 'If it is something else, set AI17Z_API_PORT / AI17Z_WEB_PORT / POSTGRES_PORT in .env.'
}

# -- Services ----------------------------------------------------------------
function Test-Endpoint($Url) {
  try {
    $r = Invoke-WebRequest -Uri $Url -TimeoutSec 6 -UseBasicParsing -ErrorAction Stop
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Test-Endpoint "http://localhost:$apiPort/api/health") {
  Add-Result 'API' 'PASS' "Answering on $apiPort." ''
} else {
  Add-Result 'API' 'NOT RUNNING' "Nothing on $apiPort." 'Run .\start-ai17z.ps1.'
}

if (Test-Endpoint "http://localhost:$webPort") {
  Add-Result 'Web' 'PASS' "Serving on $webPort." ''
} else {
  Add-Result 'Web' 'NOT RUNNING' "Nothing on $webPort." 'Run .\start-ai17z.ps1.'
}

# -- Native worker -----------------------------------------------------------
# Looked for the same way the start script decides, or the two disagree in
# front of somebody trying to work out whether their installation is healthy.
$workerPidFile = Join-Path (Join-Path (Split-Path -Parent $EnvFile) 'storage') 'native-worker.pid'
$workerAlive = $false
if (Test-Path $workerPidFile) {
  $wpid = (Get-Content $workerPidFile | Select-Object -First 1).Trim()
  if ($wpid -and (Get-Process -Id ([int]$wpid) -ErrorAction SilentlyContinue)) { $workerAlive = $true }
}
$workerElsewhere = $null
if (-not $workerAlive) {
  $others = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*apps?worker*' })
  foreach ($proc in $others) {
    if ($proc.CommandLine -like "*$PSScriptRoot*") { $workerAlive = $true; break }
  }
  if (-not $workerAlive -and $others.Count -gt 0) { $workerElsewhere = $others[0] }
}

if ($workerAlive) {
  Add-Result 'Native worker' 'PASS' 'Running. This is the one that can see Chrome.' ''
} elseif ($workerElsewhere) {
  Add-Result 'Native worker' 'WARN' "Another installation is running one (pid $($workerElsewhere.ProcessId))." 'Only one native worker runs per machine. Stop the other installation if you want this one to drive Chrome.'
} else {
  Add-Result 'Native worker' 'NOT RUNNING' 'Not started.' 'Run .\start-ai17z.ps1. Without it, X accounts cannot be used: a container cannot drive a browser on your machine.'
}

# -- Google Chrome -----------------------------------------------------------
$chromePaths = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($chrome) {
  $version = (Get-Item $chrome).VersionInfo
  # Both signals, because a Chrome-shaped path is not proof of Chrome.
  if ($version.ProductName -match 'Chrome') {
    Add-Result 'Google Chrome' 'PASS' "$($version.ProductName) $($version.ProductVersion)" ''
  } else {
    Add-Result 'Google Chrome' 'FAIL' "Found a binary at a Chrome path that reports itself as '$($version.ProductName)'." 'AI17Z drives real Google Chrome and never substitutes another browser.'
  }
} else {
  Add-Result 'Google Chrome' 'FAIL' 'Not found.' 'Install Google Chrome from google.com/chrome. Chromium and Edge are not substitutes for the X runtime.'
}

# -- Storage -----------------------------------------------------------------
#
# The process environment first. AI17Z.cmd exports this, and Set-Ai17zDataPaths
# above exports it for a shortcut that never went through AI17Z.cmd -- which is
# how the Start Menu runs this script.
#
# Three things were wrong with reading it from the file instead. It asked only
# for the XBAM_ spelling while the installer writes the AI17Z_ one, so it always
# fell through. The fallback was the program directory. And the template's value
# is *relative*, so resolving it against this script pointed there too. The
# result: every run of the diagnostics created storage\browser-profiles beside
# the program -- the directory an upgrade replaces and the uninstaller empties,
# which is the last place a signed-in browser profile should live.
$dataRoot = Split-Path -Parent $EnvFile
$profileRoot = $env:AI17Z_BROWSER_PROFILE_DIR
if (-not $profileRoot) { $profileRoot = $env:XBAM_BROWSER_PROFILE_DIR }
if (-not $profileRoot) { $profileRoot = Get-EnvValue 'AI17Z_BROWSER_PROFILE_DIR' }
if (-not $profileRoot) { $profileRoot = Get-EnvValue 'XBAM_BROWSER_PROFILE_DIR' }
if (-not $profileRoot) { $profileRoot = 'storage\browser-profiles' }
# A relative path belongs to the data directory, never to this script.
if (-not [System.IO.Path]::IsPathRooted($profileRoot)) {
  $profileRoot = Join-Path $dataRoot ($profileRoot -replace '^\.[\\/]', '')
}
try {
  New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
  $probe = Join-Path $profileRoot '.doctor-write-probe'
  Set-Content -Path $probe -Value 'ok' -Encoding utf8
  Remove-Item $probe -Force
  Add-Result 'Storage' 'PASS' "Writable: $profileRoot" ''
} catch {
  Add-Result 'Storage' 'FAIL' "Cannot write to $profileRoot" 'Check permissions, or set XBAM_BROWSER_PROFILE_DIR to a writable location.'
}

# -- What is configured inside the app ---------------------------------------
# Only asked when the API is up, and only ever counted. No names, no keys.
if (Test-Endpoint "http://localhost:$apiPort/api/health") {
  try {
    $health = Invoke-WebRequest -Uri "http://localhost:$apiPort/api/health" -TimeoutSec 6 -UseBasicParsing |
      Select-Object -ExpandProperty Content | ConvertFrom-Json
    $db = $health.data.components | Where-Object { $_.name -eq 'Database' }
    if ($db -and $db.status -eq 'healthy') {
      Add-Result 'Database' 'PASS' $db.detail ''
    } else {
      Add-Result 'Database' 'FAIL' 'Not reachable from the API.' 'Check the postgres container: docker compose ps'
    }
    # Counted by what they are, not by whether a fault in them is fatal.
    # `optional` was read as "is a provider", and with nothing configured the
    # only optional component is the browser -- so a fresh installation was told
    # it had one AI provider when it had none.
    $providers = @($health.data.components | Where-Object { $_.kind -eq 'provider' })
    if ($providers.Count -eq 0) {
      Add-Result 'AI providers' 'NOT CONFIGURED' 'None yet. An agent cannot think without one.' "Open http://localhost:$webPort, go to Settings, add a provider."
    } else {
      $bad = @($providers | Where-Object { $_.status -eq 'offline' -or $_.status -eq 'degraded' })
      if ($bad.Count -gt 0) {
        Add-Result 'AI providers' 'WARN' "$($providers.Count) configured, $($bad.Count) not answering." 'Check the key in Settings.'
      } else {
        Add-Result 'AI providers' 'PASS' "$($providers.Count) configured." ''
      }
    }

    $accounts = @($health.data.components | Where-Object { $_.kind -eq 'account' })
    if ($accounts.Count -eq 0) {
      Add-Result 'Accounts' 'NOT CONFIGURED' 'None yet. Nothing to read or reply to.' 'Create an agent, then connect an account to it.'
    } else {
      Add-Result 'Accounts' 'PASS' "$($accounts.Count) connected." ''
    }
  } catch {
    Add-Result 'Database' 'FAIL' 'Health endpoint unreadable.' 'Check the api container: docker compose logs api'
  }
} else {
  Add-Result 'Database' 'NOT RUNNING' 'API is down, so this could not be checked.' 'Run .\start-ai17z.ps1.'
  Add-Result 'AI providers' 'NOT RUNNING' 'API is down, so this could not be checked.' ''
  Add-Result 'Accounts' 'NOT RUNNING' 'API is down, so this could not be checked.' ''
}

# -- Report ------------------------------------------------------------------
if ($Json) {
  $results | ConvertTo-Json -Depth 4
  exit 0
}

Write-Host ''
Write-Host 'AI17Z Doctor' -ForegroundColor White
Write-Host ''

foreach ($r in $results) {
  $colour = switch ($r.status) {
    'PASS'           { 'Green' }
    'FAIL'           { 'Red' }
    'NOT CONFIGURED' { 'Yellow' }
    'NOT RUNNING'    { 'Yellow' }
    default          { 'Gray' }
  }
  Write-Host ('  {0,-16}' -f $r.name) -NoNewline
  Write-Host ('{0,-16}' -f $r.status) -ForegroundColor $colour -NoNewline
  Write-Host $r.detail -ForegroundColor Gray
}

$failed = @($results | Where-Object { $_.status -eq 'FAIL' })
$unconfigured = @($results | Where-Object { $_.status -eq 'NOT CONFIGURED' -or $_.status -eq 'NOT RUNNING' })

Write-Host ''
if ($failed.Count -gt 0) {
  Write-Host '  Needs fixing before AI17Z can run:' -ForegroundColor Red
  foreach ($r in $failed) { Write-Host "    $($r.name): $($r.fix)" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

if ($unconfigured.Count -gt 0) {
  Write-Host '  Nothing is broken. Still to do:' -ForegroundColor Yellow
  foreach ($r in $unconfigured) { if ($r.fix) { Write-Host "    $($r.name): $($r.fix)" -ForegroundColor Gray } }
  Write-Host ''
  exit 0
}

Write-Host '  AI17Z is ready.' -ForegroundColor Green
Write-Host ''
exit 0
