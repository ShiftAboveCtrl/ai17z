<#
.SYNOPSIS
  Stops AI17Z: the native worker and the Docker stack.

.DESCRIPTION
  Data survives this. Postgres, stored files and browser profiles live in named
  Docker volumes and are untouched, so starting again picks up where this left
  off. Use -Volumes only when you actually mean to delete all of it.

.PARAMETER KeepStack
  Stop only the native worker and leave the containers running.

.PARAMETER Volumes
  Also delete the Docker volumes. This erases the database, every stored API
  key, every browser session, and every agent. There is no undo.
#>
[CmdletBinding()]
param(
  [switch] $KeepStack,
  [switch] $Volumes
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# The environment file, which is also where the compose project name comes from.
#
# docker-compose.yml says `name: ${AI17Z_INSTANCE:-xbam}`, so a compose command
# run without this resolves that to the default and acts on a different project
# than the one that was started. Stopping would report success and leave the
# containers running.
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
$ComposeEnv = @()
if (Test-Path $EnvFile) { $ComposeEnv = @('--env-file', $EnvFile) }


# Beside the owner's data, which is where start-ai17z.ps1 writes it. Under the
# program directory the two agreed only by accident, and an installation whose
# data lives elsewhere left a worker running after being told to stop.
$PidFile = Join-Path (Join-Path (Split-Path -Parent $EnvFile) 'storage') 'native-worker.pid'

# Docker writes its progress to stderr. Under Windows PowerShell with
# ErrorActionPreference = Stop, that is promoted to a terminating error even
# when the command succeeded, so native commands are run with the preference
# relaxed and judged by their exit code instead.
function Invoke-Native {
  param([Parameter(Mandatory)] [string] $Exe, [string[]] $Arguments = @(), [string] $FailureMessage)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0 -and $FailureMessage) { throw $FailureMessage }
  return $LASTEXITCODE
}

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Done($Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn($Message) { Write-Host "  $Message" -ForegroundColor Yellow }

Write-Host ''

# -- The native worker -------------------------------------------------------
if (Test-Path $PidFile) {
  $workerPid = Get-Content $PidFile | Select-Object -First 1
  try {
    $process = Get-Process -Id ([int]$workerPid) -ErrorAction Stop
    Write-Step "Stopping the native worker (pid $workerPid)..."
    # /T for the whole tree. npm run dev:worker starts tsx, which starts the
    # actual worker; killing only the recorded pid leaves that grandchild
    # running. Every start/stop cycle then leaked a worker, and each leaked one
    # kept polling and launching its own browsers.
    Invoke-Native taskkill @('/PID', "$workerPid", '/T', '/F') | Out-Null
    $process.WaitForExit(10000) | Out-Null
    Write-Done 'Native worker stopped.'
  } catch {
    Write-Warn "No native worker was running under pid $workerPid."
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
} else {
  Write-Warn 'No native worker recorded.'
}

# Belt and braces: a worker from an earlier cycle that outlived its pid file is
# still a worker, and it will still poll and open browsers.
# The supervisor counts too, and first: it exists to restart a worker that
# stops, so killing the worker while it is still running just produces
# another worker. Its own kill is a signal it recognises as deliberate.
#
# Scoped to this installation, and that scoping is the whole point. Matching on
# the script name alone matched every AI17Z on the machine and killed its tree,
# so stopping one installation stopped the browser worker of every other one --
# and with it the signed-in Chrome that worker was holding, which is the single
# most expensive thing on the machine to get back. Two installations are two
# installations, and that has to be true of stopping one.
#
# The program directory tells them apart: every worker process an installation
# starts runs out of its own node_modules and carries that path. Compared with
# separators normalised, because tsx passes the same directory back as a
# file:/// URL with forward slashes in the same command line that has
# backslashes. doctor-ai17z.ps1 and Stop-ForUninstall.ps1 already ask this
# question the same way.
$Here = $PSScriptRoot.TrimEnd('\').ToLowerInvariant()
$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -like '*supervise-worker*' -or $_.CommandLine -like '*apps?worker*') -and
    $_.CommandLine.Replace('/', '\').ToLowerInvariant().Contains($Here)
  }
if ($stray) {
  Write-Step "Stopping $($stray.Count) leftover worker process(es)..."
  foreach ($proc in $stray) {
    Invoke-Native taskkill @('/PID', "$($proc.ProcessId)", '/T', '/F') | Out-Null
  }
  # Killing a tree takes its children with it, so later entries in this list are
  # often already gone. taskkill says so and returns non-zero; that is the
  # expected outcome here, not a failure of the script.
  $global:LASTEXITCODE = 0
  Write-Done 'Leftovers stopped.'
}

# -- The stack ---------------------------------------------------------------
if ($KeepStack) {
  Write-Warn 'Leaving the containers running.'
} elseif ($Volumes) {
  Write-Host ''
  Write-Host '  This deletes the database, every stored API key, every browser session,' -ForegroundColor Red
  Write-Host '  and every agent. It cannot be undone.' -ForegroundColor Red
  Write-Host ''
  $answer = Read-Host '  Type DELETE to confirm'
  if ($answer -ceq 'DELETE') {
    Write-Step 'Stopping and removing volumes...'
    Invoke-Native docker (@('compose') + $ComposeEnv + @('down', '-v')) | Out-Null
    Write-Done 'Stopped. All data removed.'
  } else {
    Write-Warn 'Nothing was deleted. Stopping normally instead.'
    Invoke-Native docker (@('compose') + $ComposeEnv + @('down')) | Out-Null
    Write-Done 'Stopped. Data kept.'
  }
} else {
  Write-Step 'Stopping the stack...'
  Invoke-Native docker (@('compose') + $ComposeEnv + @('down')) | Out-Null
  Write-Done 'Stopped. Data kept; start again with .\start-ai17z.ps1'
}

Write-Host ''
