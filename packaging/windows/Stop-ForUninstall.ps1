<#
.SYNOPSIS
  Stops what would hold files open, so an uninstall can remove them.

.DESCRIPTION
  Purpose-built for the uninstaller rather than reusing stop-ai17z.ps1, for two
  reasons found by testing this:

  The general stop script is interactive in one branch and talks to Docker in
  others. An uninstaller runs it with no console, so anything that reads input
  or waits on a daemon can block forever, and a hung uninstaller is worse than
  an untidy one -- the person cannot even retry.

  And uninstalling the *program* is not the same decision as tearing down the
  *data*. The containers hold the database in a Docker volume; nothing they own
  lives in the program directory. So this stops the native worker, which does
  hold files there, asks the containers to stop as a courtesy, and gives up
  quickly on anything that does not answer.

  Never prompts. Never fails the uninstall. Bounded by construction.
#>
[CmdletBinding()]
param(
  [int] $TimeoutSeconds = 20
)

# Nothing here is worth failing an uninstall for.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Stop-Tree([int] $ProcessId) {
  # Trees, not processes. npm starts tsx which starts the worker, so killing the
  # recorded pid leaves the one that actually holds the files.
  & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
}

# -- The native worker, which is what holds files under the program directory --
$pidFile = Join-Path $env:LOCALAPPDATA 'AI17Z\storage\native-worker.pid'
if (Test-Path $pidFile) {
  $recorded = (Get-Content $pidFile -Raw).Trim()
  if ($recorded -match '^\d+$') { Stop-Tree ([int] $recorded) }
  Remove-Item $pidFile -Force
}

# Anything still running out of the program directory, whatever started it.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$root*" } |
  ForEach-Object { Stop-Tree $_.ProcessId }

# -- The containers, as a courtesy, and only if Docker answers quickly --------
if (Get-Command docker -ErrorAction SilentlyContinue) {
  $compose = Join-Path $root 'docker-compose.yml'
  if (Test-Path $compose) {
    # `stop`, never `down -v`: the database is the owner's and removing it is a
    # separate, explicit decision the uninstaller asks about on its own.
    # The env file decides the compose project name: docker-compose.yml says
    # `name: ${AI17Z_INSTANCE:-xbam}`. Without it, this stops a project that was
    # never started and leaves the owner's containers running after they
    # uninstalled.
    $envFile = Join-Path $root 'data-location.txt'
    $composeEnv = @()
    if (Test-Path $envFile) {
      $dataDir = (Get-Content $envFile -First 1).Trim()
      if ($dataDir) {
        $candidate = Join-Path $dataDir '.env'
        if (Test-Path $candidate) { $composeEnv = @('--env-file', $candidate) }
      }
    }
    if ($composeEnv.Count -eq 0) {
      $beside = Join-Path $root '.env'
      if (Test-Path $beside) { $composeEnv = @('--env-file', $beside) }
    }

    $job = Start-Job -ScriptBlock {
      param($dir, $envArgs)
      Set-Location $dir
      & docker compose @envArgs stop 2>$null
    } -ArgumentList $root, $composeEnv

    if (Wait-Job $job -Timeout $TimeoutSeconds) { Receive-Job $job | Out-Null }
    else { Stop-Job $job }
    Remove-Job $job -Force
  }
}

exit 0
