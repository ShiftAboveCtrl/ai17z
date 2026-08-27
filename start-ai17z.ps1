<#
.SYNOPSIS
  Starts AI17Z: the Docker stack, and a native worker that can drive real Chrome.

.DESCRIPTION
  The containerised worker has no browser and no display, so it handles jobs and
  leaves anything browser-backed alone. A second worker runs here on Windows,
  where Chrome actually is, and picks that work up. Both read the same database,
  so this is a division of labour rather than two systems.

  Run this from the repository root. It is safe to run again while things are
  already up: nothing is recreated that does not need to be.

.PARAMETER NoBrowser
  Skip the native worker. The stack still runs; browser-backed accounts will
  wait rather than fail, and the reason is shown in the UI.

.PARAMETER Rebuild
  Rebuild the images first. Needed after changing a Dockerfile or adding a
  workspace, not after an ordinary code change.
#>
[CmdletBinding()]
param(
  [switch] $NoBrowser,
  [switch] $Rebuild
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$WorkerLog = Join-Path $PSScriptRoot 'storage\native-worker.log'
$PidFile   = Join-Path $PSScriptRoot 'storage\native-worker.pid'

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
Write-Host 'AI17Z' -ForegroundColor White
Write-Host ''

# ── Prerequisites ───────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker is not on PATH. Install Docker Desktop and start it, then run this again.'
}
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) {
  throw 'Docker is installed but not running. Start Docker Desktop, wait for it to settle, then run this again.'
}

if (-not (Test-Path '.env')) {
  Write-Warn 'No .env found. Creating one from .env.example with a fresh master key.'
  Copy-Item '.env.example' '.env'
  # The master key seals every provider API key. Generating one here means a
  # first run works; losing it later means those keys cannot be decrypted.
  $key = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
  (Get-Content '.env') -replace '^AI17Z_MASTER_KEY=.*$', "AI17Z_MASTER_KEY=$key" | Set-Content '.env' -Encoding utf8
  Write-Warn "A master key was written to .env. Back that file up: without it, stored API keys are unreadable."
}

# ── The stack ───────────────────────────────────────────────────────────────
if ($Rebuild) {
  Write-Step 'Rebuilding images...'
  Invoke-Native docker @('compose', 'build', 'api', 'web', 'worker') 'The image build failed. The output above says why.' | Out-Null
}

Write-Step 'Starting Postgres, API, worker and web...'
Invoke-Native docker @('compose', 'up', '-d') 'docker compose could not start the stack. The output above says why.' | Out-Null

Write-Step 'Applying migrations...'
Invoke-Native npm @('run', 'migrate') 'Migrations failed. The database is unchanged; the output above says why.' | Out-Null

# Wait for the API rather than assuming: the first start pulls images and
# compiles, and "it is not up yet" reads exactly like "it is broken".
Write-Step 'Waiting for the API...'
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri 'http://localhost:8787/api/health/live' -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    Start-Sleep -Milliseconds 800
  }
}
if (-not $ready) {
  Write-Warn 'The API did not answer within 90 seconds. Check: docker compose logs api'
} else {
  Write-Done 'API is up.'
}

# ── The native worker ───────────────────────────────────────────────────────
if ($NoBrowser) {
  Write-Warn 'Skipping the native worker. Browser-backed accounts will wait for one.'
} else {
  $existing = if (Test-Path $PidFile) { Get-Content $PidFile | Select-Object -First 1 } else { $null }
  $alive = $false
  if ($existing) {
    try { $alive = $null -ne (Get-Process -Id ([int]$existing) -ErrorAction Stop) } catch { $alive = $false }
  }

  if ($alive) {
    Write-Done "Native worker already running (pid $existing)."
  } else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Warn 'Node is not on PATH, so the native worker cannot start. Browser-backed accounts will wait.'
    } else {
      Write-Step 'Starting the native worker (this one can see your Chrome)...'
      New-Item -ItemType Directory -Force -Path (Split-Path $WorkerLog) | Out-Null

      # Only browser work. The containerised worker already takes everything
      # else, and two workers claiming the same jobs is just contention.
      $env:AI17Z_WORKER_ROLE = 'browser'
      $env:AI17Z_WORKER_ID = "native-$env:COMPUTERNAME"

      # On Windows npm is a shell script, not an executable, so Start-Process
      # cannot launch it directly: it has to be the .cmd shim.
      $npm = (Get-Command npm).Source
      if ($npm -notmatch '\.(cmd|bat|exe)$') {
        $shim = Join-Path (Split-Path $npm) 'npm.cmd'
        if (Test-Path $shim) { $npm = $shim }
      }

      $process = Start-Process -FilePath $npm -ArgumentList 'run', 'dev:worker' `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $WorkerLog -RedirectStandardError "$WorkerLog.err"
      $process.Id | Set-Content $PidFile -Encoding utf8
      Start-Sleep -Seconds 2

      if ($process.HasExited) {
        Write-Warn "The native worker exited immediately. See $WorkerLog.err"
      } else {
        Write-Done "Native worker running (pid $($process.Id)). Log: $WorkerLog"
      }
    }
  }
}

Write-Host ''
Write-Host '  Open  ' -NoNewline; Write-Host 'http://localhost:8080' -ForegroundColor White
Write-Host '  Stop  ' -NoNewline; Write-Host '.\stop-ai17z.ps1' -ForegroundColor White
Write-Host ''
