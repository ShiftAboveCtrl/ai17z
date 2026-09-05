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

# Where the environment file lives.
#
# An installed AI17Z keeps it with the owner's data, because the program
# directory is replaced on every upgrade and this file holds the master key
# every provider credential is sealed with. The launcher says where, via
# AI17Z_ENV_FILE. A clone has no launcher and no data directory, so it falls
# back to the .env beside this script, which is what a developer expects.
$EnvFile = $env:AI17Z_ENV_FILE
if (-not $EnvFile) { $EnvFile = $env:XBAM_ENV_FILE }
if (-not $EnvFile) { $EnvFile = Join-Path $PSScriptRoot '.env' }

# docker compose reads .env from the compose file's directory unless told
# otherwise, so every compose call has to carry this. Without it the containers
# would get a different configuration from the rest of the application, and the
# ports the installer wrote would apply to half the system.
$ComposeEnv = @('--env-file', $EnvFile)

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

# Something the owner can fix, said plainly and then stopped.
#
# `throw` prints the message under a CategoryInfo block, a FullyQualifiedErrorId
# and the source line that raised it. That is right for a bug and wrong for
# "Docker is not running", which is not a fault -- it is a thing to go and do.
# The message was already clear; it was buried under a stack trace.
function Stop-WithReason($Message, $Fix) {
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Red
  if ($Fix) { Write-Host "  $Fix" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'AI17Z' -ForegroundColor White
Write-Host ''

# -- Prerequisites -----------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-WithReason 'Docker is not on PATH.' 'Install Docker Desktop, start it, then run this again.'
}
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) {
  Stop-WithReason 'Docker is installed but not running.' 'Start Docker Desktop, wait for the whale to settle, then run this again.'
}

# -- Ports -------------------------------------------------------------------
# Checked before Docker is asked to bind them, because the alternative is
# "Bind for 127.0.0.1:55433 failed: port is already allocated" from a daemon,
# which tells somebody running a second installation nothing they can act on.
function Get-EnvPort($Key, $Default) {
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
      if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.+)$") { $value = $matches[1].Trim() }
    }
  }
  if ($value) { return $value }
  return $Default
}

function Test-PortTaken($Port) {
  return [bool](Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue)
}

$ourContainers = @()
try { $ourContainers = @(docker compose @ComposeEnv ps --format '{{.Name}}' 2>$null) } catch { }
$alreadyOurs = $ourContainers.Count -gt 0

if (-not $alreadyOurs) {
  $wanted = @(
    @{ Name = 'API';      Key = 'AI17Z_API_PORT';  Port = (Get-EnvPort 'AI17Z_API_PORT' '8787') },
    @{ Name = 'Web';      Key = 'AI17Z_WEB_PORT';  Port = (Get-EnvPort 'AI17Z_WEB_PORT' '8080') },
    @{ Name = 'Postgres'; Key = 'POSTGRES_PORT';   Port = (Get-EnvPort 'POSTGRES_PORT' '55432') }
  )
  $taken = @($wanted | Where-Object { Test-PortTaken $_.Port })
  if ($taken.Count -gt 0) {
    $lines = ($taken | ForEach-Object { "    $($_.Name) wants $($_.Port). Set $($_.Key) in .env to something else." }) -join "`n"
    $extra = "`n`n  If that something is another AI17Z, give this one its own name too:`n    AI17Z_INSTANCE=second"
    if ($taken | Where-Object { $_.Key -eq 'POSTGRES_PORT' }) {
      # Moving POSTGRES_PORT alone moves the published port and nothing else.
      # DATABASE_URL is what the migrator and the native worker dial, and it
      # carries its own port, so a second installation with only POSTGRES_PORT
      # changed runs its migrations against the first installation's database.
      $extra += "`n`n  Changing POSTGRES_PORT is only half of it: DATABASE_URL carries its own`n  port and is what migrations dial. Change both, to the same number."
    }
    Stop-WithReason "Something is already using $($taken.Count) of the ports AI17Z needs." "$lines$extra"
  }
}

# The two must agree, whether or not there was ever a conflict.
#
# `POSTGRES_PORT` publishes the container's port; `DATABASE_URL` is what the
# migrator and the native worker actually connect to. Nothing keeps them in
# step, so editing one is a silent way to point this installation's migrations
# at a different installation's database. Refused rather than guessed at: this
# script does not get to decide which of the two somebody meant.
$pgPort = Get-EnvPort 'POSTGRES_PORT' '55432'
$dbUrl = Get-EnvPort 'DATABASE_URL' ''
if ($dbUrl -and $dbUrl -match '^postgres(ql)?://[^/]*@(localhost|127\.0\.0\.1):(?<port>\d+)/') {
  if ($matches.port -ne $pgPort) {
    Stop-WithReason `
      "POSTGRES_PORT is $pgPort but DATABASE_URL points at port $($matches.port)." `
      "Migrations and the native worker use DATABASE_URL, so this would touch a database on $($matches.port) while the containers publish $pgPort.`n  Set both to the same port in .env."
  }
}

if (-not (Test-Path $EnvFile)) {
  # An older installation kept its environment file beside the program. Move it
  # rather than leaving two to diverge, and rather than generating a second
  # master key that cannot read the credentials sealed with the first.
  $legacy = Join-Path $PSScriptRoot '.env'
  if (($legacy -ne $EnvFile) -and (Test-Path $legacy)) {
    Write-Warn "Moving your existing .env to $EnvFile so an upgrade cannot replace it."
    $parent = Split-Path -Parent $EnvFile
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Move-Item -LiteralPath $legacy -Destination $EnvFile
  }
}

if (-not (Test-Path $EnvFile)) {
  $template = Join-Path $PSScriptRoot '.env.example'
  if (-not (Test-Path $template)) {
    # This was the installed copy's first-run failure: the template was not in
    # the package, so the very first thing a new install did was crash naming a
    # file nobody could be expected to find.
    Stop-WithReason `
      'AI17Z has no .env and no .env.example to build one from.' `
      "Expected the template at:`n    $template`n  This installation looks incomplete. Reinstalling AI17Z will restore it."
  }

  Write-Warn "No environment file yet. Creating one at $EnvFile with a fresh master key."
  $parent = Split-Path -Parent $EnvFile
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  Copy-Item $template $EnvFile

  # The master key seals every provider API key. Generating one here means a
  # first run works; losing it later means those keys cannot be decrypted.
  #
  # From the cryptographic RNG rather than Get-Random, which is seeded and is
  # not meant for anything that has to be unguessable.
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes)

  # Read and write the bytes explicitly rather than through Get-Content and
  # Set-Content. On Windows PowerShell 5.1 those default to the system codepage
  # for reading and add a BOM when writing, which turns the template's box-
  # drawing comments into mojibake and puts three bytes in front of the first
  # line. Both are cosmetic until something parses the file strictly.
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $text = [System.IO.File]::ReadAllText($EnvFile, $utf8)
  $text = [regex]::Replace($text, '(?m)^AI17Z_MASTER_KEY=.*$', "AI17Z_MASTER_KEY=$key")
  [System.IO.File]::WriteAllText($EnvFile, $text, $utf8)
  Write-Warn "A master key was written to $EnvFile. Back that file up: without it, stored API keys are unreadable."
}

# -- The stack ---------------------------------------------------------------
if ($Rebuild) {
  Write-Step 'Rebuilding images...'
  # Stamped into the images, because a container has no git and otherwise
  # cannot say which source it is running.
  $env:AI17Z_BUILD_COMMIT = (git rev-parse --short=12 HEAD 2>$null)
  Invoke-Native docker (@('compose') + $ComposeEnv + @('build', 'api', 'web', 'worker')) 'The image build failed. The output above says why.' | Out-Null
}

Write-Step 'Starting Postgres, API, worker and web...'
Invoke-Native docker (@('compose') + $ComposeEnv + @('up', '-d')) 'docker compose could not start the stack. The output above says why.' | Out-Null

Write-Step 'Applying migrations...'
Invoke-Native npm @('run', 'migrate') 'Migrations failed. The database is unchanged; the output above says why.' | Out-Null

# Wait for the API rather than assuming: the first start pulls images and
# compiles, and "it is not up yet" reads exactly like "it is broken".
# The port the API is actually published on, not the one it listens on inside
# the container. Hardcoding 8787 here made an installation on any other port
# report 'The API did not answer within 90 seconds' while the API was up and
# healthy the whole time -- the same mistake the Open line above already had.
$apiPort = Get-EnvPort 'AI17Z_API_PORT' '8787'
Write-Step 'Waiting for the API...'
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:$apiPort/api/health/live" -TimeoutSec 2 -UseBasicParsing
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

# -- The native worker -------------------------------------------------------
if ($NoBrowser) {
  Write-Warn 'Skipping the native worker. Browser-backed accounts will wait for one.'
} else {
  $existing = if (Test-Path $PidFile) { Get-Content $PidFile | Select-Object -First 1 } else { $null }
  $alive = $false
  if ($existing) {
    try { $alive = $null -ne (Get-Process -Id ([int]$existing) -ErrorAction Stop) } catch { $alive = $false }
  }

  # A worker from an earlier cycle counts, whether or not the pid file knows
  # about it. Two workers means two of everything, including browsers.
  #
  # Whose worker it is matters, and the first version did not ask. It swept for
  # any node process running apps/worker, found one belonging to a completely
  # different checkout, announced "already running (pid )" -- empty, because the
  # pid file it was interpolating did not exist -- and left. The doctor then
  # said NOT RUNNING, because it looks at this installation's pid file. Two
  # scripts, one machine, opposite answers.
  $adopted = $null
  $foreign = $null
  if (-not $alive) {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*apps?worker*' })
    foreach ($proc in $running) {
      if ($proc.CommandLine -like "*$PSScriptRoot*") { $adopted = $proc; break }
    }
    if (-not $adopted -and $running.Count -gt 0) { $foreign = $running[0] }
  }

  if ($adopted) {
    # Ours, started by an earlier run that did not get to write the file.
    Set-Content -Path $PidFile -Value $adopted.ProcessId
    $alive = $true
    Write-Done "Native worker already running (pid $($adopted.ProcessId))."
  } elseif ($foreign) {
    $alive = $true
    Write-Warn "Another AI17Z installation is already running a native worker (pid $($foreign.ProcessId))."
    Write-Warn 'Not starting a second one: two native workers on one machine means two browsers for the same account.'
    Write-Warn 'Stop the other installation first if you want this one to drive Chrome.'
  }

  if ($alive) {
    if (-not $adopted -and -not $foreign) { Write-Done "Native worker already running (pid $existing)." }
  } else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Warn 'Node is not on PATH, so the native worker cannot start. Browser-backed accounts will wait.'
    } else {
      Write-Step 'Starting the native worker (this one can see your Chrome)...'
      New-Item -ItemType Directory -Force -Path (Split-Path $WorkerLog) | Out-Null

      # Only browser work. The containerised worker already takes everything
      # else, and two workers claiming the same jobs is just contention.
      $env:AI17Z_WORKER_ROLE = 'browser'
      # The pid matters. Two native workers on one machine sharing an id is two
      # processes with one identity, and every guarantee that hangs off the
      # worker id stops holding between them: `jobs.locked_by` says the job is
      # taken by "native-FRACTAL", the other native worker is also
      # "native-FRACTAL", and it takes it too. The account lease is deliberately
      # reentrant for the worker already holding it, so the lock that exists to
      # stop two browsers driving one account waves the second one through.
      #
      # It happens in the ordinary way: `.\start-ai17z.ps1` and then
      # `npm run dev`, which starts a worker of its own. The worker's own
      # default is hostname-pid and was already unique; this overrode it with
      # something that was not.
      $env:AI17Z_WORKER_ID = "native-$env:COMPUTERNAME-$PID"

      # On Windows npm is a shell script, not an executable, so Start-Process
      # cannot launch it directly: it has to be the .cmd shim.
      $npm = (Get-Command npm).Source
      if ($npm -notmatch '\.(cmd|bat|exe)$') {
        $shim = Join-Path (Split-Path $npm) 'npm.cmd'
        if (Test-Path $shim) { $npm = $shim }
      }

      # Supervised rather than bare. The native worker is the only process that
      # can drive a real browser, and started directly it had nothing watching
      # it: when it died the agent stopped, with no restart and, until health
      # learned about workers, no sign either.
      #
      # The supervisor restarts a worker that had been running and then failed,
      # and deliberately gives up on one that cannot start at all -- five
      # attempts in, the problem is the configuration and another thousand
      # identical failures say nothing the first one did not.
      $process = Start-Process -FilePath $npm -ArgumentList 'run', 'worker:supervised' `
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
# The port this installation actually published, not the default. A second
# installation was told to open 8080 while serving on 8090, which is the first
# installation's address: the last line of a successful start pointed at
# somebody else's copy.
Write-Host '  Open  ' -NoNewline; Write-Host "http://localhost:$(Get-EnvPort 'AI17Z_WEB_PORT' '8080')" -ForegroundColor White
Write-Host '  Stop  ' -NoNewline; Write-Host '.\stop-ai17z.ps1' -ForegroundColor White
Write-Host ''
