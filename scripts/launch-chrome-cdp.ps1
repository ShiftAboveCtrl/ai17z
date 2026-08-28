<#
.SYNOPSIS
  Starts a real Chrome (or Edge) with remote debugging so AI17Z can attach to it.

.DESCRIPTION
  AI17Z attaches over the DevTools protocol rather than launching its own
  browser, so what it drives is a real Chrome with real history.

  Chrome has refused --remote-debugging-port on the default profile directory
  since version 136, so this uses a dedicated directory instead. A dedicated
  directory starts empty, and a browser with no cookies and no history is
  exactly what a platform flags as suspicious on first sign-in.

  The recommended answer to an empty profile is not to copy one: it is to sign
  in once in the dedicated window and let the profile persist. AI17Z reuses the
  same directory on every run, so that sign-in is a one-off.

  Leave the window open while AI17Z is working. Set the account to CDP mode and
  give it the URL this prints.

.PARAMETER SeedFromProfile
  EXPERIMENTAL, and on Windows it usually does not work.

  Copies an existing Chrome profile into the debugging directory. Since Chrome
  127, App-Bound Encryption ties cookies to Chrome's own identity rather than to
  the Windows user, and Chrome discards cookies it finds in a directory they
  were not encrypted for. Copying Local State does not change that.

  Kept for the cases where it does help - history, bookmarks, preferences, and
  older or non-Windows builds - and because proving it fails on a given machine
  is quicker than arguing about it. Do not rely on it to carry a login.

.PARAMETER Reseed
  Copy again even though the debugging profile already has a session,
  replacing it.

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
  [ValidateSet('chrome', 'edge')][string]$Browser = 'chrome',
  [string]$SeedFromProfile,
  [switch]$Reseed
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

# -- Seeding from a real profile ---------------------------------------------
#
# A dedicated debugging directory starts with no cookies and no history, which
# is what a platform flags on a first sign-in. Copying an existing profile in
# gives the debugging window the session you already have.
if ($SeedFromProfile) {
  $userData = if ($Browser -eq 'edge') {
    Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data'
  } else {
    Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
  }
  $source = Join-Path $userData $SeedFromProfile

  if (-not (Test-Path $source)) {
    Write-Host ''
    Write-Host "No profile called '$SeedFromProfile' under $userData." -ForegroundColor Red
    Write-Host 'Available:' -ForegroundColor Yellow
    Get-ChildItem $userData -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -eq 'Default' -or $_.Name -match '^Profile \d+$' } |
      ForEach-Object { Write-Host "  $($_.Name)" }
    Write-Host ''
    Write-Host "Chrome shows which is which at chrome://version, under 'Profile Path'." -ForegroundColor DarkGray
    exit 1
  }

  # The cookie database is locked while the browser is running, and a
  # half-copied profile is worse than none: Chrome opens it and quietly
  # discards the session rather than reporting a problem.
  $processName = if ($Browser -eq 'edge') { 'msedge' } else { 'chrome' }
  if (Get-Process -Name $processName -ErrorAction SilentlyContinue) {
    Write-Host ''
    Write-Host "$processName is running. Close it completely before seeding," -ForegroundColor Red
    Write-Host 'including any background windows, then run this again.' -ForegroundColor Red
    Write-Host ''
    Write-Host "  Get-Process $processName | Stop-Process" -ForegroundColor DarkGray
    Write-Host ''
    exit 1
  }

  $target = Join-Path $Profile 'Default'
  $seeded = Test-Path (Join-Path $target 'Network\Cookies')
  if ($seeded -and -not $Reseed) {
    Write-Host 'The debugging profile already has a session. Pass -Reseed to replace it.' -ForegroundColor Yellow
  } else {
      Write-Host ''
    Write-Host 'EXPERIMENTAL: on Windows this usually will not carry your login.' -ForegroundColor Yellow
    Write-Host 'Chrome 127+ App-Bound Encryption ties cookies to Chrome itself, and' -ForegroundColor Yellow
    Write-Host 'Chrome discards cookies found in a directory they were not encrypted' -ForegroundColor Yellow
    Write-Host 'for. History, bookmarks and preferences do come across.' -ForegroundColor Yellow
    Write-Host ''
    Write-Host "Copying '$SeedFromProfile' into the debugging profile..." -ForegroundColor Cyan
    New-Item -ItemType Directory -Path $target -Force | Out-Null

    # Local State sits at the User Data root and holds the key the cookies are
    # encrypted with. Without it they copy across and decrypt to nothing.
    $localState = Join-Path $userData 'Local State'
    if (Test-Path $localState) {
      Copy-Item $localState (Join-Path $Profile 'Local State') -Force -ErrorAction SilentlyContinue
    }

    # Everything needed to still be signed in. Deliberately not the caches,
    # which are large and worth nothing here.
    $wanted = @(
      'Network', 'Local Storage', 'Session Storage', 'IndexedDB',
      'Cookies', 'Cookies-journal', 'Login Data', 'Login Data For Account',
      'Web Data', 'Preferences', 'Secure Preferences', 'History', 'Bookmarks'
    )
    foreach ($item in $wanted) {
      $from = Join-Path $source $item
      if (Test-Path $from) {
        Copy-Item $from -Destination $target -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    Write-Host 'Copied. Your original profile is untouched.' -ForegroundColor Green
    Write-Host 'If the window opens signed out, that is App-Bound Encryption doing' -ForegroundColor DarkGray
    Write-Host 'its job. Sign in once in that window instead; the profile persists.' -ForegroundColor DarkGray
  }
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
if ($SeedFromProfile) {
  Write-Host "  1. Check the window is already signed in to X. If it is, nothing to do here."
} else {
  Write-Host "  1. Sign in to X in the window that just opened. You only do this once:"
  Write-Host "     the profile persists and AI17Z reuses it on every run."
  Write-Host "     If X says it has temporarily limited the login, wait rather than"
  Write-Host "     retrying - repeated attempts are usually what caused it."
}
Write-Host "  2. In AI17Z, open the account, set the browser mode to 'Attach over CDP',"
Write-Host "     and set the CDP URL to:"
Write-Host "       http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "  3. Make sure a worker is running on THIS machine:"
Write-Host "       .\start-ai17z.ps1" -ForegroundColor Cyan
Write-Host ""
Write-Host "Leave this browser window open while AI17Z is working."
Write-Host ""
