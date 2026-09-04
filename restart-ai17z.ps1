<#
.SYNOPSIS
  Stops AI17Z and starts it again.

.DESCRIPTION
  Your data survives this, and so does your signed-in Chrome: the stop script
  does not touch the browser, which is the point of spawning it rather than
  letting Playwright launch it. Starting again reattaches to the tabs that are
  already open instead of opening more.

  This exists because "stop then start" is two commands that have to be run in
  order and in the same folder, and getting that wrong leaves a half-stopped
  installation that is harder to reason about than either state.

.PARAMETER KeepStack
  Restart only the native worker and leave the containers running. Much faster,
  and enough for anything that is not a container change.
#>
[CmdletBinding()]
param(
  [switch] $KeepStack
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host ''
Write-Host 'AI17Z restart' -ForegroundColor White
Write-Host ''

if ($KeepStack) {
  & (Join-Path $PSScriptRoot 'stop-ai17z.ps1') -KeepStack
} else {
  & (Join-Path $PSScriptRoot 'stop-ai17z.ps1')
}

# A moment for ports and the profile lock to be released. Chrome in particular
# holds its profile until its renderers are gone, and a start that races that
# hands off to the old instance and exits without opening a port.
Start-Sleep -Seconds 2

& (Join-Path $PSScriptRoot 'start-ai17z.ps1')
