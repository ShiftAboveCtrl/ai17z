<#
.SYNOPSIS
  Starts a real Chrome (or Edge) with remote debugging so XBAM can attach to it.

.DESCRIPTION
  XBAM attaches over the DevTools protocol rather than launching its own browser.
  The window this opens uses a dedicated profile directory, which means:

    - You sign in to the platform once, in that window, and the session persists.
    - It does not touch your everyday browser profile, and does not require you
      to close the browser you are already using.

  Leave the window open while XBAM is working. Set the account to CDP mode in
  XBAM and give it the URL this prints.

.PARAMETER Port
  Debug port. One port per account if you run several.

.PARAMETER Profile
  Profile directory. Defaults to storage/browser-profiles/cdp-<port>.

.PARAMETER Browser
  chrome (default) or edge.

.EXAMPLE
  .\scripts\launch-chrome-cdp.ps1
  .\scripts\launch-chrome-cdp.ps1 -Port 9223 -Browser edge
#>
[CmdletBinding()]
param(
  [int]$Port = 9222,
  [string]$Profile,
  [ValidateSet('chrome', 'edge')][string]$Browser = 'chrome'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

if (-not $Profile) {
  $Profile = Join-Path $repoRoot "storage\browser-profiles\cdp-$Port"
}

$candidates = if ($Browser -eq 'edge') {
  @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
} else {
  @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
}

$exe = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $exe) {
  Write-Error "Could not find $Browser. Looked in: $($candidates -join '; ')"
  exit 1
}

# A port already in use usually means a previous window is still open. Reusing it
# is the right outcome, so say so rather than starting a second one.
$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Host ""
  Write-Host "Something is already listening on port $Port." -ForegroundColor Yellow
  Write-Host "If that is a browser you started earlier, XBAM can attach to it as-is:"
  Write-Host "  http://127.0.0.1:$Port" -ForegroundColor Cyan
  Write-Host ""
  exit 0
}

if (-not (Test-Path $Profile)) {
  New-Item -ItemType Directory -Path $Profile -Force | Out-Null
}

$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=$Profile",
  '--no-first-run',
  '--no-default-browser-check'
)

Start-Process -FilePath $exe -ArgumentList $arguments
Start-Sleep -Seconds 2

Write-Host ""
Write-Host "Browser started." -ForegroundColor Green
Write-Host "  Executable : $exe"
Write-Host "  Profile    : $Profile"
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Sign in to the platform in the window that just opened."
Write-Host "  2. In XBAM, open the account, set the browser mode to 'Attach over CDP',"
Write-Host "     and set the CDP URL to:"
Write-Host "       http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "  3. Run the worker on THIS machine, not in Docker:"
Write-Host "       npm run dev:worker" -ForegroundColor Cyan
Write-Host ""
Write-Host "Leave this browser window open while XBAM is working."
Write-Host ""
