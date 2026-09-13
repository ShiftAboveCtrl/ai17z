<#
.SYNOPSIS
  Installs AI17Z. One command, from the official repository.

.DESCRIPTION
  This is the file behind the command on the AI17Z README:

      irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex

  It is deliberately small, and deliberately not the installer. All it does is
  work out which AI17Z release to install, fetch that release's setup program,
  **check its SHA-256 before running any of it**, write it somewhere you can
  read it, and then run the bytes it just checked.

  ---------------------------------------------------------------------------
  Why a command and not a download
  ---------------------------------------------------------------------------

  AI17Z is not a signed application. Code-signing for open-source projects is
  granted on the strength of an existing user base, and AI17Z does not have one
  yet -- so an AI17Z `.exe` would be an unsigned executable that Windows has
  never seen before, and Windows would say so, loudly, and be right to.

  The answer is not to talk anybody past that warning. It is to not ask for it:
  nothing here is an executable, nothing is double-clicked, and no Windows
  security feature is touched, turned off, or argued with.

  ---------------------------------------------------------------------------
  Why this runs without changing your execution policy
  ---------------------------------------------------------------------------

  Windows' default policy for scripts on a client machine is `Restricted`,
  which -- in Microsoft's words -- "permits individual commands, but doesn't
  allow scripts". Piping this into `iex` is individual commands, so it runs on
  a stock machine as it is. The setup program it fetches is then run **the same
  way**, from bytes already checked, rather than saved as a `.ps1` and launched.

  So **your machine's policy is never changed**: `Set-ExecutionPolicy` is not
  run here or anywhere else in AI17Z, and nothing asks you to run it.

  Said exactly, because the difference matters: the Start Menu shortcuts AI17Z
  creates for its own installed scripts -- start, stop, diagnostics, update,
  uninstall -- do start their process with `-ExecutionPolicy Bypass`. That is a
  setting on one process, applying to AI17Z's own files, and it changes nothing
  about this machine or about anything else that runs on it.

  ---------------------------------------------------------------------------
  What to trust, and what not to
  ---------------------------------------------------------------------------

  Be honest about the one weak link: **this file is fetched from a branch, over
  HTTPS, and its own hash cannot be checked before it runs** -- there is nothing
  to check it against yet. That is the bootstrapping problem every installer of
  this shape has. What this file does about it:

    - it is short, and it is the file you just fetched: read it at the URL above
      before you paste anything
    - everything it then installs comes from a **release**, whose assets do not
      change once published, and is refused unless its SHA-256 matches what that
      release published
    - the checked setup program is written to disk before it runs, so you can
      read afterwards exactly what ran
    - `-Release` pins it to a version of your choosing rather than the newest

  If you would rather look first -- and that is a reasonable thing to want:

      irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 -OutFile install.ps1
      notepad install.ps1

  See docs/SETUP_AUDIT.md for everything the setup program can change, and how
  to check it yourself.

  ASCII only, like every other PowerShell file here: a .ps1 without a BOM is
  read as ANSI, and one smart quote from a pasted em dash terminates a string
  somewhere unrelated.

.PARAMETER Release
  The release tag to install, for example v1.0.0-beta.16. Default: the newest
  published release.

.PARAMETER Instance
  Install (or update) the AI17Z installation of this name. One name settles the
  program folder, the data folder, the Start Menu group and the uninstall
  identity together. Default: AI17Z, or -- when exactly one installation is
  already here and you did not name one -- that one.

.PARAMETER Update
  Update an installation that is already here rather than making a new one.

.PARAMETER NewInstance
  Install another, independent AI17Z beside the ones already here. Its program
  folder, data folder, database, ports and browser profile are its own.

.PARAMETER List
  Print the AI17Z installations on this machine and change nothing.

.PARAMETER WhatIfOnly
  Look at this PC, say what would happen, and change nothing.

.PARAMETER ShowDetails
  Put what each step runs on the screen as well as in the log.

.PARAMETER KeepDownload
  Leave the checked setup program on disk after it has run. It is kept anyway
  when anything goes wrong.
#>
[CmdletBinding()]
param(
  [string] $Release = '',
  [string] $Instance = '',
  [switch] $Update,
  [switch] $NewInstance,
  [switch] $List,
  [switch] $WhatIfOnly,
  [switch] $ShowDetails,
  [switch] $KeepDownload
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# What this file is allowed to reach
#
# The same list the setup program declares, because this is the first half of
# the same journey. A request that does not start at one of these is refused
# rather than followed.
# ---------------------------------------------------------------------------
$Repository = 'ShiftAboveCtrl/ai17z'
$AllowedHosts = @('api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
$SetupAssetPattern = 'Install-AI17Z-{0}.ps1'
$ChecksumAsset = 'SHA256SUMS.txt'

function Write-Line {
  param([string] $Text = '', [string] $Colour = 'Gray')
  if ($Text) { Write-Host ('  ' + $Text) -ForegroundColor $Colour } else { Write-Host '' }
}

function Stop-Install {
  param([string] $What, [string] $Why = '', [string] $Do = '')
  Write-Host ''
  Write-Host ('  ' + $What) -ForegroundColor Red
  # Capped, because one of these lines is an exception message and an exception
  # message can be a whole HTTP response body.
  if ($Why) { foreach ($line in ($Why -split "`n")) { if ($line.Length -gt 200) { $line = $line.Substring(0, 200) + '...' }; Write-Host ('  ' + $line) -ForegroundColor Gray } }
  if ($Do) {
    Write-Host ''
    foreach ($line in ($Do -split "`n")) { Write-Host ('  ' + $line) -ForegroundColor Yellow }
  }
  Write-Host ''
  # `throw`, not `exit`: this runs inside somebody's own PowerShell session, and
  # `exit` from a piped-in command closes the window they were working in.
  throw $What
}

# Whether a release tag is one this will build a name from.
#
# A tag is either typed by whoever ran this or read out of a document GitHub
# served, and what gets derived from it is an asset name. **A value off the
# network has no business becoming a path**, and a tag also goes into a URL
# path, where the host allow-list cannot tell that the path underneath it is
# the one that was meant.
#
# Semver, optionally with the leading v this project tags with, and nothing
# that is a path: no separator, no colon, no drive letter.
function Test-ReleaseTag {
  param([string] $Tag)
  if (-not $Tag -or $Tag.Length -gt 64) { return $false }
  return [bool]([regex]::IsMatch($Tag, '^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'))
}

function Assert-AllowedUrl {
  param([string] $Url)
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    Stop-Install 'That download address is not a valid URL.' '' 'This is a fault in the AI17Z install command. Report it.'
  }
  if ($uri.Scheme -ne 'https') {
    Stop-Install 'A download was about to be made over plain HTTP.' 'AI17Z only ever downloads over HTTPS.' 'Report this.'
  }
  if ($AllowedHosts -notcontains $uri.Host) {
    Stop-Install ('AI17Z will not download from ' + $uri.Host + '.') 'It only downloads from its own GitHub release.' `
      ('Stop, and install AI17Z from https://github.com/' + $Repository)
  }
}

function Get-Text {
  param([string] $Url, [string] $Accept = 'application/vnd.github+json')
  Assert-AllowedUrl $Url
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers @{ 'Accept' = $Accept; 'User-Agent' = 'AI17Z-Install' }
  # Windows PowerShell decides the shape of .Content from the response's content
  # type, not from anything asked for here: a string for text, bytes for
  # anything it thinks is binary. Assuming either one is how this failed the
  # first time it was run against the real API -- with the whole JSON document
  # in the error message.
  if ($response.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($response.Content) }
  return [string]$response.Content
}

# ---------------------------------------------------------------------------
# Enough of a machine to install on
# ---------------------------------------------------------------------------

if ($PSVersionTable.PSVersion.Major -lt 5) {
  Stop-Install 'This needs Windows PowerShell 5.1 or newer.' `
    ('This is PowerShell ' + $PSVersionTable.PSVersion + '.') `
    'Windows 10 and Windows 11 both ship with a new enough version. Open Windows Terminal or "Windows PowerShell" and try again.'
}
# $IsWindows exists in PowerShell 6+; in 5.1 there is no such variable and the
# answer is always yes.
if ((Get-Variable -Name IsWindows -ErrorAction SilentlyContinue) -and -not $IsWindows) {
  Stop-Install 'AI17Z Setup installs on Windows.' 'This is not a Windows machine.' `
    ('On Linux or macOS, follow the source install in https://github.com/' + $Repository)
}

# TLS 1.2 at the least. Windows PowerShell defaults to whatever was current when
# it shipped, and GitHub has not accepted that for years.
try {
  $protocols = [Net.SecurityProtocolType]::Tls12
  try { $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13 } catch { }
  [Net.ServicePointManager]::SecurityProtocol = $protocols
} catch { }

Write-Host ''
Write-Host '  AI17Z' -ForegroundColor White
Write-Line 'Looking up the newest release...' 'DarkGray'

# ---------------------------------------------------------------------------
# Which release, and what it published
# ---------------------------------------------------------------------------

if ($Release -and -not (Test-ReleaseTag $Release)) {
  Stop-Install ('"' + $Release + '" is not a release version.') `
    'Releases are named like v1.0.0 or v1.0.0-beta.1.' `
    ('Pick one from https://github.com/' + $Repository + '/releases and pass it to -Release.')
}

$base = 'https://api.github.com/repos/' + $Repository + '/releases'
# Deliberately not named after what it holds.
#
# PowerShell variable names are case-insensitive, so a lower-case one here would
# be the -Release parameter -- which is [string], so assigning a release object
# to it converts the object to a string without complaining, and every field
# read afterwards is empty. It fails as a wrong answer rather than as an error.
$chosen = $null
try {
  if ($Release) {
    $chosen = Get-Text ($base + '/tags/' + $Release) | ConvertFrom-Json
  } else {
    # Not /releases/latest: that hides prereleases, and every AI17Z release so
    # far is one.
    $all = Get-Text ($base + '?per_page=10') | ConvertFrom-Json
    $chosen = @($all | Where-Object { -not $_.draft } | Select-Object -First 1)[0]
  }
} catch {
  Stop-Install 'AI17Z could not work out which release to install.' `
    ("Nothing on this PC was changed.`n" + $_.Exception.Message) `
    'Check your internet connection and run the command again.'
}
if (-not $chosen) {
  Stop-Install 'That release does not exist.' '' ('Look at https://github.com/' + $Repository + '/releases and pass -Release <tag>.')
}

$tag = '' + $chosen.tag_name
# The tag GitHub just handed over, before an asset name is built from it.
# Refused rather than sanitised: a release named something this does not
# recognise is a release this does not understand, not one to guess at.
if (-not (Test-ReleaseTag $tag)) {
  Stop-Install ('The newest release is called "' + $tag + '", which is not a version number.') `
    'Nothing was written and nothing was run.' `
    ('Install a release by name with -Release <tag>, and report this at https://github.com/' + $Repository + '/issues')
}
$version = $tag -replace '^v', ''
$setupName = [string]::Format($SetupAssetPattern, $version)

$setupAsset = $null
$sumsAsset = $null
foreach ($asset in $chosen.assets) {
  if ($asset.name -ieq $setupName) { $setupAsset = $asset }
  if ($asset.name -ieq $ChecksumAsset) { $sumsAsset = $asset }
}
if (-not $setupAsset) {
  Stop-Install ('Release ' + $tag + ' does not contain ' + $setupName + '.') `
    'Nothing on this PC was changed.' `
    ('Install an earlier release with -Release <tag>, or see https://github.com/' + $Repository + '/releases')
}
if (-not $sumsAsset) {
  Stop-Install ('Release ' + $tag + ' publishes no SHA256SUMS.txt.') `
    'AI17Z will not run a setup program it cannot check.' `
    ('See https://github.com/' + $Repository + '/releases')
}

# ---------------------------------------------------------------------------
# The setup program, checked before a line of it runs
# ---------------------------------------------------------------------------

Write-Line ('Fetching AI17Z Setup ' + $version + '...') 'DarkGray'

$expected = ''
foreach ($line in ((Get-Text $sumsAsset.browser_download_url 'text/plain') -split "`r?`n")) {
  $match = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
  if ($match.Success -and ($match.Groups[2].Value.Trim() -ieq $setupName)) {
    $expected = $match.Groups[1].Value.ToLowerInvariant()
  }
}
if (-not $expected) {
  Stop-Install ('Release ' + $tag + ' does not publish a hash for ' + $setupName + '.') `
    'AI17Z will not run a setup program it cannot check.' `
    ('See https://github.com/' + $Repository + '/releases')
}

Assert-AllowedUrl $setupAsset.browser_download_url
$response = Invoke-WebRequest -Uri $setupAsset.browser_download_url -UseBasicParsing -Headers @{ 'User-Agent' = 'AI17Z-Install' }
$bytes = $response.Content
if ($bytes -isnot [byte[]]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$bytes) }

$sha = [System.Security.Cryptography.SHA256]::Create()
try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }

if ($actual -ne $expected) {
  # Fail closed, and do not offer a way past it.
  Stop-Install 'The setup program does not match its published SHA-256.' `
    ("expected  " + $expected + "`ngot       " + $actual + "`n`nNothing was written and nothing was run.") `
    ("Do not try again on the same network without thinking about why.`nIf it happens twice, stop and report it at https://github.com/" + $Repository + '/issues')
}

# Written where the setup program keeps its own log, so everything setup owns is
# in one folder somebody can read and delete. Written *after* the check, so a
# file that failed it never reaches the disk at all.
#
# The name carries no part of the release tag: that tag came off the network,
# and a value from the network has no business becoming a path.
$setupHome = Join-Path $env:LOCALAPPDATA 'AI17Z-setup'
if (-not (Test-Path $setupHome)) { New-Item -ItemType Directory -Path $setupHome -Force | Out-Null }
$setupPath = Join-Path $setupHome 'Setup-AI17Z.checked.ps1'
[System.IO.File]::WriteAllBytes($setupPath, $bytes)

Write-Line ('Checked: SHA-256 matches ' + $tag + "'s published hash.") 'Green'
Write-Line ('Reading it afterwards: ' + $setupPath) 'DarkGray'

# ---------------------------------------------------------------------------
# Run the bytes that were checked
#
# Three decisions here, and each of them is the answer to something that goes
# wrong the obvious way:
#
#   **In memory, not as a launched file.** Windows' default policy does not run
#   script files, and the fix for that is emphatically not to tell somebody to
#   change their execution policy. The bytes are already here and already
#   checked; running them as a script block is the same kind of thing as the
#   command that was pasted, and needs nothing switched off.
#
#   **In a child process.** `exit` inside a script block ends the *host*, and
#   the host here is the terminal somebody is sitting in. Setup ending with a
#   tidy "AI17Z is ready" and then closing their window is not a good last
#   impression. The child gets the console, so every question setup asks still
#   works, and its exit code comes back.
#
#   **Checked again by the child, out of its own file.** Between the hash above
#   and the read below there is a moment where the file exists and has been
#   approved. Checking it once more where it is used closes that, and costs a
#   few milliseconds.
#
# Everything that varies travels in the environment. The program below is a
# constant: no release tag, no path and no name is ever pasted into text that
# is about to be executed, which is the only way to be sure none of them can be
# anything other than data.
# ---------------------------------------------------------------------------

# Only a name a folder can be called, checked before it goes anywhere near
# another process.
if ($Instance -and ($Instance -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$')) {
  Stop-Install ('"' + $Instance + '" is not a name an AI17Z installation can have.') `
    'Letters, digits, dot, dash and underscore, up to 48 characters.' `
    'Choose another name and run the command again.'
}

$env:AI17Z_SETUP_FILE = $setupPath
$env:AI17Z_SETUP_SHA256 = $expected
$env:AI17Z_SETUP_RELEASE = $tag
if ($Instance) { $env:AI17Z_SETUP_INSTANCE = $Instance }
if ($Update) { $env:AI17Z_SETUP_UPDATE = '1' }
if ($NewInstance) { $env:AI17Z_SETUP_NEW_INSTANCE = '1' }
if ($List) { $env:AI17Z_SETUP_LIST = '1' }
if ($WhatIfOnly) { $env:AI17Z_SETUP_WHATIF = '1' }
if ($ShowDetails) { $env:AI17Z_SETUP_DETAILS = '1' }

# Single quotes throughout and not one double quote in it: a double quote does
# not survive Windows PowerShell's native argument passing, and this whole
# string crosses that boundary.
$driver = @'
$ErrorActionPreference = 'Stop'
$file = $env:AI17Z_SETUP_FILE
$want = $env:AI17Z_SETUP_SHA256
$bytes = [System.IO.File]::ReadAllBytes($file)
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $got = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
if ($got -ne $want) {
  Write-Host ''
  Write-Host '  The setup program changed after it was checked. Nothing was run.' -ForegroundColor Red
  Write-Host ''
  exit 9
}
& ([scriptblock]::Create([System.Text.Encoding]::UTF8.GetString($bytes)))
exit $LASTEXITCODE
'@

Write-Line
& powershell.exe -NoProfile -Command $driver
$code = $LASTEXITCODE
if ($null -eq $code) { $code = 1 }

# Kept when anything went wrong, so there is something to read, and kept when
# asked for. Removed on success because it is a copy of a published file and
# nothing needs it afterwards.
if (-not $KeepDownload -and $code -eq 0) {
  Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue
}
foreach ($name in @('AI17Z_SETUP_FILE', 'AI17Z_SETUP_SHA256', 'AI17Z_SETUP_RELEASE', 'AI17Z_SETUP_INSTANCE',
    'AI17Z_SETUP_UPDATE', 'AI17Z_SETUP_NEW_INSTANCE', 'AI17Z_SETUP_LIST', 'AI17Z_SETUP_WHATIF', 'AI17Z_SETUP_DETAILS')) {
  Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
}
if ($code -ne 0) {
  Write-Line 'AI17Z Setup did not finish. The message above says why.' 'Yellow'
  Write-Line ('What ran is still at ' + $setupPath) 'DarkGray'
  Write-Line
}
