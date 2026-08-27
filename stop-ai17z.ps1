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

$PidFile = Join-Path $PSScriptRoot 'storage\native-worker.pid'

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

# ── The native worker ───────────────────────────────────────────────────────
if (Test-Path $PidFile) {
  $workerPid = Get-Content $PidFile | Select-Object -First 1
  try {
    $process = Get-Process -Id ([int]$workerPid) -ErrorAction Stop
    Write-Step "Stopping the native worker (pid $workerPid)..."
    # The worker traps this and closes its browsers before exiting; killing the
    # tree outright can leave a Chromium profile locked by a dead process.
    Stop-Process -Id $process.Id -ErrorAction Stop
    $process.WaitForExit(10000) | Out-Null
    Write-Done 'Native worker stopped.'
  } catch {
    Write-Warn "No native worker was running under pid $workerPid."
  }
  Remove-Item $PidFile -ErrorAction SilentlyContinue
} else {
  Write-Warn 'No native worker to stop.'
}

# ── The stack ───────────────────────────────────────────────────────────────
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
    Invoke-Native docker @('compose', 'down', '-v') | Out-Null
    Write-Done 'Stopped. All data removed.'
  } else {
    Write-Warn 'Nothing was deleted. Stopping normally instead.'
    Invoke-Native docker @('compose', 'down') | Out-Null
    Write-Done 'Stopped. Data kept.'
  }
} else {
  Write-Step 'Stopping the stack...'
  Invoke-Native docker @('compose', 'down') | Out-Null
  Write-Done 'Stopped. Data kept; start again with .\start-ai17z.ps1'
}

Write-Host ''
