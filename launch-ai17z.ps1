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
function Get-EnvValue($Name, $Fallback) {
  $envFile = Join-Path $PSScriptRoot '.env'
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
