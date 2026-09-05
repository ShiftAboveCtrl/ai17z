<#
.SYNOPSIS
  Starts AI17Z and opens it.

.DESCRIPTION
  What the Start Menu entry runs, and what to double-click.

  Everything here is also available as separate scripts. This one exists because
  somebody who wants to use their agents should not have to know that starting
  the stack and opening a browser are two different things, nor have to find the
  address in the output of a console window that has already scrolled.

  Starting is idempotent, so running this when AI17Z is already up simply opens
  it.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# The port this installation publishes the web app on, which is not necessarily
# the default: a machine running two installations moves one of them, and an
# icon that opens the other one's window is worse than no icon.
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

# Read from the owner's environment file, not from a .env beside this script.
# An installed copy has none here, so every lookup fell through to its default
# and this opened http://localhost:8080 for somebody who had chosen 8092 -- the
# one screen the whole installation exists to reach.
function Get-EnvValue($Name, $Fallback) {
  $envFile = Resolve-Ai17zEnvFile $PSScriptRoot
  if (Test-Path $envFile) {
    foreach ($line in Get-Content $envFile) {
      if ($line -match "^\s*$Name\s*=\s*(.+?)\s*$") { return $matches[1] }
    }
  }
  return $Fallback
}

& (Join-Path $PSScriptRoot 'start-ai17z.ps1')
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Write-Host '  AI17Z did not start, so nothing was opened. The output above says why.' -ForegroundColor Red
  Write-Host '  For a fuller check:  .\doctor-ai17z.ps1' -ForegroundColor Yellow
  Write-Host ''
  # Held open, because an icon that flashes a window and vanishes tells nobody
  # anything. A script run from a console is unaffected.
  if ($Host.Name -eq 'ConsoleHost' -and -not $env:CI) {
    Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
    [void](Read-Host)
  }
  exit 1
}

$webPort = Get-EnvValue 'AI17Z_WEB_PORT' (Get-EnvValue 'XBAM_WEB_PORT' '8080')
$url = "http://localhost:$webPort"
Write-Host ''
Write-Host "  Opening $url" -ForegroundColor Cyan
Start-Process $url
