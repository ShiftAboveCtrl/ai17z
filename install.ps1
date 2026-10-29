<#
.SYNOPSIS
  Installs AI17Z. One command, from the official repository.

.DESCRIPTION
  This is the file behind the command on the AI17Z README:

      irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/install.ps1 | iex

  The same file is on AI17Z Code, AI17Z's own server, for when GitHub is
  down:

      irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/install.ps1 | iex

  Either way, the release itself is fetched from GitHub first and from AI17Z
  Code when GitHub cannot provide it, and checked the same way.

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
$Project = 'AI17Z/ai17z'
# Where somebody is sent to read about a release. AI17Z Code, because it is
# the one host that is always there: GitHub restricted this account once.
$ProjectUrl = 'https://code.ai17z.io/' + $Project
# Where a release is fetched from, in order. GitHub first, because that is the
# copy people know; AI17Z Code when GitHub does not answer, refuses, or lacks a
# file. One source serves the whole run. The same list as RELEASE_SOURCES in
# packages/shared/src/releaseManifest.ts, held there by a test.
$Sources = @(
  [pscustomobject]@{ Name = 'GitHub';     Api = 'https://api.github.com/repos/ShiftAboveCtrl/ai17z'; ListQuery = '?per_page=20' },
  [pscustomobject]@{ Name = 'AI17Z Code'; Api = 'https://code.ai17z.io/api/v1/repos/AI17Z/ai17z';    ListQuery = '?limit=20' }
)
# Every host a request may start at or be redirected to. GitHub answers a
# release download with a redirect to its own storage host, so the host that
# answered is checked as well as the one asked.
$AllowedHosts = @('api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'code.ai17z.io')
$SetupAssetPattern = 'Install-AI17Z-{0}.ps1'
$ChecksumAsset = 'SHA256SUMS.txt'

function Write-Line {
  param([string] $Text = '', [string] $Colour = 'Gray')
  if ($Text) { Write-Host ('  ' + $Text) -ForegroundColor $Colour } else { Write-Host '' }
}

# What a deliberate refusal throws, so the boundary at the bottom can tell one
# from a genuine bug. `throw 'a string'` puts that string in .TargetObject and
# a real fault leaves it empty, so nothing has to be remembered between runs --
# a flag set by a refusal would still be set the next time somebody pasted the
# command into the same session.
$StopSentinel = 'AI17Z_SETUP_STOPPED'

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
  # Not `exit`: this runs inside somebody's own PowerShell session, and `exit`
  # from a piped-in command closes the window they were working in.
  #
  # Not a bare `throw` left to reach the top either. Unhandled, it prints
  # `At line:`, `CategoryInfo` and `FullyQualifiedErrorId` underneath the
  # message above -- a stack trace for something that is not a crash. A refusal
  # is a decision this program made on purpose, and it should read like one.
  # The sentinel unwinds to the boundary, which knows the message is already on
  # screen and says nothing more.
  throw $StopSentinel
}

# The releases that could be installed with this command, newest first.
#
# An older release only counts if its own assets say so. Suggesting "try an
# earlier one" without checking is advice that wastes somebody's afternoon:
# during the move to the terminal command, no earlier release has the asset at
# all, and every one of them would fail exactly the same way.
function Get-CompatibleTags {
  param($Releases)
  $tags = @()
  foreach ($candidate in @($Releases)) {
    if ($candidate.draft) { continue }
    $candidateTag = '' + $candidate.tag_name
    if (-not (Test-ReleaseTag $candidateTag)) { continue }
    $wanted = [string]::Format($SetupAssetPattern, ($candidateTag -replace '^v', ''))
    foreach ($asset in @($candidate.assets)) { if ($asset.name -ieq $wanted) { $tags += $candidateTag; break } }
  }
  return $tags
}

# Whether a release tag is one this will build a name from.
#
# A tag is either typed by whoever ran this or read out of a document AI17Z Code
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
    Stop-Install ('AI17Z will not download from ' + $uri.Host + '.') 'It only downloads its own releases, from GitHub or AI17Z Code.' `
      ('Stop, and install AI17Z from ' + $ProjectUrl)
  }
}

# The address that actually answered, after any redirect. Windows PowerShell
# keeps it on the underlying HttpWebResponse; PowerShell 7 on the request.
function Get-AnsweredUrl {
  param($Response)
  $base = $Response.BaseResponse
  if ($base -and $base.PSObject.Properties['ResponseUri'] -and $base.ResponseUri) { return '' + $base.ResponseUri.AbsoluteUri }
  if ($base -and $base.PSObject.Properties['RequestMessage'] -and $base.RequestMessage) { return '' + $base.RequestMessage.RequestUri.AbsoluteUri }
  return ''
}

function Invoke-Allowed {
  param([string] $Url, [hashtable] $Headers)
  Assert-AllowedUrl $Url
  $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -Headers $Headers -MaximumRedirection 5
  # Judged again where it landed: an allow-list checked only on the first
  # address says nothing about a redirect.
  $answered = Get-AnsweredUrl $response
  if ($answered) { Assert-AllowedUrl $answered }
  return $response
}

function Get-Text {
  param([string] $Url, [string] $Accept = 'application/json')
  $response = Invoke-Allowed $Url @{ 'Accept' = $Accept; 'User-Agent' = 'AI17Z-Install' }
  # Windows PowerShell decides the shape of .Content from the response's content
  # type, not from anything asked for here: a string for text, bytes for
  # anything it thinks is binary. Assuming either one is how this failed the
  # first time it was run against the real API -- with the whole JSON document
  # in the error message.
  if ($response.Content -is [byte[]]) { return [System.Text.Encoding]::UTF8.GetString($response.Content) }
  return [string]$response.Content
}

# ---------------------------------------------------------------------------
# Everything below runs inside one boundary
#
# Deliberately not indented. `try` is not a scope in PowerShell, so every
# variable assigned inside this block is the same variable it would be without
# it -- and leaving the body where it was keeps this change readable as what it
# is, which matters for a file whose whole argument is that you can read it.
#
# The boundary exists so a refusal reads like a decision instead of a crash.
# ---------------------------------------------------------------------------
try {

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
    ('On Linux or macOS, follow the source install in ' + $ProjectUrl)
}

# TLS 1.2 at the least. Windows PowerShell defaults to whatever was current when
# it shipped, and neither GitHub nor AI17Z Code accepts that.
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
    ('Pick one from ' + $ProjectUrl + '/releases and pass it to -Release.')
}

# One attempt at one source: which release, its checksums, and the checked
# setup program, all from the same host.
#
# A source that cannot provide any of that says why and hands the run to the
# next one. Two answers are not handed on, because neither is an outage: a tag
# that is not a version number, and bytes that do not match their published
# hash. Both stop everything, exactly as they did with one source.
function Get-FromSource {
  param($Source)
  $result = [pscustomobject]@{
    Ok = $false; Source = $Source.Name; Kind = ''; Why = ''; Tag = ''; Version = ''; SetupName = ''
    All = @(); Expected = ''; Bytes = $null
  }
  $base = $Source.Api + '/releases'
  # Deliberately not named after what it holds.
  #
  # PowerShell variable names are case-insensitive, so a lower-case one here
  # would be the -Release parameter -- which is [string], so assigning a
  # release object to it converts the object to a string without complaining,
  # and every field read afterwards is empty. It fails as a wrong answer rather
  # than as an error.
  $chosen = $null
  try {
    if ($Release) {
      $chosen = Get-Text ($base + '/tags/' + $Release) | ConvertFrom-Json
      # The list as well, but only to answer "was there one that would have
      # worked" if the named release turns out not to carry what this needs.
      # Advice is not worth failing an install over, so this one is allowed to
      # come back empty.
      try {
        $fetched = Get-Text ($base + $Source.ListQuery) | ConvertFrom-Json
        $result.All = @($fetched)
      } catch { $result.All = @() }
    } else {
      # Not /releases/latest: that is the server choosing, and here the list
      # is read and the choice made in the open. GitHub's Latest label decides
      # nothing.
      #
      # Assigned first and wrapped second, never `@(... | ConvertFrom-Json)`:
      # Windows PowerShell hands an array down the pipeline as one object, so
      # wrapping in the same statement produces a one-element array containing
      # the array -- and every release then reads as a single release with
      # twenty of everything.
      $fetched = Get-Text ($base + $Source.ListQuery) | ConvertFrom-Json
      $result.All = @($fetched)
      $chosen = @($result.All | Where-Object { -not $_.draft } | Select-Object -First 1)[0]
    }
  } catch {
    if ($_.TargetObject -eq $StopSentinel) { throw }
    $why = '' + $_.Exception.Message
    $result.Why = $why
    $result.Kind = 'unreachable'
    # A named release that is not there.
    if ($Release -and $why -match '\(404\)') { $result.Kind = 'no-such-release' }
    # A refusal is the one case where the connection is provably fine: a
    # shared office, a university or a cloud box can reach an anonymous rate
    # limit without anybody doing anything unusual.
    elseif ($why -match '\(40[39]\)' -or $why -match '\(429\)') { $result.Kind = 'refused' }
    return $result
  }
  if (-not $chosen) { $result.Kind = 'no-release'; return $result }

  $tag = '' + $chosen.tag_name
  # The tag a server just handed over, before an asset name is built from it.
  # Refused rather than sanitised: a release named something this does not
  # recognise is a release this does not understand, not one to guess at.
  if (-not (Test-ReleaseTag $tag)) {
    Stop-Install ('The newest release on ' + $Source.Name + ' is called "' + $tag + '", which is not a version number.') `
      'Nothing was written and nothing was run.' `
      ('Install a release by name with -Release <tag>, and report this at ' + $ProjectUrl + '/issues')
  }
  $result.Tag = $tag
  $result.Version = $tag -replace '^v', ''
  $result.SetupName = [string]::Format($SetupAssetPattern, $result.Version)

  $setupAsset = $null
  $sumsAsset = $null
  foreach ($asset in @($chosen.assets)) {
    if ($asset.name -ieq $result.SetupName) { $setupAsset = $asset }
    if ($asset.name -ieq $ChecksumAsset) { $sumsAsset = $asset }
  }
  if (-not $setupAsset) { $result.Kind = 'no-setup'; return $result }
  if (-not $sumsAsset) { $result.Kind = 'no-sums'; return $result }

  try {
    foreach ($line in ((Get-Text $sumsAsset.browser_download_url 'text/plain') -split "`r?`n")) {
      $match = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
      if ($match.Success -and ($match.Groups[2].Value.Trim() -ieq $result.SetupName)) {
        $result.Expected = $match.Groups[1].Value.ToLowerInvariant()
      }
    }
  } catch {
    if ($_.TargetObject -eq $StopSentinel) { throw }
    $result.Kind = 'download'; $result.Why = '' + $_.Exception.Message; return $result
  }
  if (-not $result.Expected) { $result.Kind = 'no-hash'; return $result }

  try {
    $response = Invoke-Allowed $setupAsset.browser_download_url @{ 'User-Agent' = 'AI17Z-Install' }
  } catch {
    if ($_.TargetObject -eq $StopSentinel) { throw }
    $result.Kind = 'download'; $result.Why = '' + $_.Exception.Message; return $result
  }
  $bytes = $response.Content
  if ($bytes -isnot [byte[]]) { $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$bytes) }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($actual -ne $result.Expected) {
    # Fail closed, and do not offer a way past it. Not handed to the next
    # source either: a file that does not match what its own release
    # published is something to think about, not to route around.
    Stop-Install 'The setup program does not match its published SHA-256.' `
      ("expected  " + $result.Expected + "`ngot       " + $actual + "`nfrom      " + $Source.Name + "`n`nNothing was written and nothing was run.") `
      ("Do not try again on the same network without thinking about why.`nIf it happens twice, stop and report it at " + $ProjectUrl + '/issues')
  }
  $result.Bytes = $bytes
  $result.Ok = $true
  return $result
}

# What one failed attempt is called on screen, in a few words.
function Get-FailureWords {
  param($Attempt)
  switch ($Attempt.Kind) {
    'no-such-release' { return 'it has no release called ' + $Release }
    'refused'         { return 'it refused the request' }
    'no-release'      { return 'it lists no release' }
    'no-setup'        { return $Attempt.Tag + ' there has no ' + $Attempt.SetupName }
    'no-sums'         { return $Attempt.Tag + ' there publishes no SHA256SUMS.txt' }
    'no-hash'         { return $Attempt.Tag + ' there publishes no hash for ' + $Attempt.SetupName }
    'download'        { return 'a download did not finish' }
    default           { return 'it did not answer' }
  }
}

$attempt = $null
for ($i = 0; $i -lt $Sources.Count; $i++) {
  $attempt = Get-FromSource $Sources[$i]
  if ($attempt.Ok) { break }
  if ($i + 1 -lt $Sources.Count) {
    Write-Line ($Sources[$i].Name + ' could not provide it (' + (Get-FailureWords $attempt) + '). Trying ' + $Sources[$i + 1].Name + '...') 'DarkGray'
  }
}

if (-not $attempt.Ok) {
  # Every source failed. The last one is AI17Z Code, the source of truth, so
  # its answer is the one explained. GitHub's half is in the line above.
  $tag = $attempt.Tag
  $setupName = $attempt.SetupName
  switch ($attempt.Kind) {
    'no-such-release' {
      # It worked out which release to install perfectly well; that release
      # does not exist.
      Stop-Install ('There is no release called "' + $Release + '".') `
        'Nothing on this PC was changed.' `
        ('Pick one from ' + $ProjectUrl + '/releases, or leave -Release off to take the newest.')
    }
    'no-release' {
      Stop-Install 'That release does not exist.' '' ('Look at ' + $ProjectUrl + '/releases and pass -Release <tag>.')
    }
    'no-setup' {
      # Two different situations wearing the same shape, and telling somebody
      # the wrong one sends them looking for a release that does not exist.
      $compatible = @(Get-CompatibleTags $attempt.All | Where-Object { $_ -ine $tag })
      $advice = ''
      if ($compatible.Count -gt 0) {
        $advice = 'Install the newest one that does with:' + "`n  -Release " + $compatible[0]
      }
      if ($Release) {
        # Somebody named this release. It exists; it just predates the command.
        if (-not $advice) { $advice = 'See ' + $ProjectUrl + '/releases' }
        Stop-Install ('Release ' + $tag + ' cannot be installed with this command.') `
          ("It does not contain " + $setupName + ", which is the setup program this`ncommand checks and runs." +
           "`n`nReleases from before the terminal install command carry an installer on`ntheir own page instead." +
           "`n`nNothing on this PC was changed.") `
          $advice
      }
      # No release was named, so this is the newest there is. Nothing newer
      # exists to suggest, and saying "try an earlier one" would be worse than
      # saying nothing: every earlier one fails here for the same reason.
      if (-not $advice) { $advice = 'Watch ' + $ProjectUrl + '/releases' }
      Stop-Install 'AI17Z Setup is newer than the latest published release.' `
        ("The latest release is " + $tag + ", which does not contain the new terminal`nsetup package (" + $setupName + ")." +
         "`n`nNothing on this PC was changed." +
         "`n`nA compatible AI17Z release has not been published yet.") `
        $advice
    }
    'no-sums' {
      Stop-Install ('Release ' + $tag + ' publishes no SHA256SUMS.txt.') `
        'AI17Z will not run a setup program it cannot check.' `
        ('See ' + $ProjectUrl + '/releases')
    }
    'no-hash' {
      Stop-Install ('Release ' + $tag + ' does not publish a hash for ' + $setupName + '.') `
        'AI17Z will not run a setup program it cannot check.' `
        ('See ' + $ProjectUrl + '/releases')
    }
    default {
      # What to go and look at, decided by what actually happened. A refusal
      # from both is almost always a rate limit for addresses that are not
      # signed in, which a shared network can reach on its own.
      $advice = 'Check your internet connection and run the command again.'
      if ($attempt.Kind -eq 'refused') {
        $advice = 'GitHub and AI17Z Code both refused the request. That is usually a rate limit for addresses that are not signed in, which a shared network can reach on its own. Wait a few minutes and run the command again.'
      }
      Stop-Install 'AI17Z could not work out which release to install.' `
        ("Neither GitHub nor AI17Z Code could provide it. Nothing on this PC was changed.`n" + $attempt.Why) `
        $advice
    }
  }
}

$tag = $attempt.Tag
$version = $attempt.Version
$setupName = $attempt.SetupName
$expected = $attempt.Expected
$bytes = $attempt.Bytes
Write-Line ('Fetched AI17Z Setup ' + $version + ' from ' + $attempt.Source + '.') 'DarkGray'

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
# Where it is *while it runs*, and what happens to it afterwards. This said
# "Reading it afterwards: <path>", which is true only when something goes wrong:
# a clean run removes the file, so anybody who took that line at its word went
# looking for a file that was not there and drew the wrong conclusion.
Write-Line ('Written to ' + $setupPath + ' and run from there.') 'DarkGray'
Write-Line 'Removed when the install finishes cleanly. Pass -KeepDownload to keep it.' 'DarkGray'

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
# A fixed word, never text off the network: setup starts where this succeeded,
# so one install fetches its files from one host.
$env:AI17Z_SETUP_SOURCE = if ($attempt.Source -eq 'GitHub') { 'github' } else { 'forgejo' }
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
foreach ($name in @('AI17Z_SETUP_FILE', 'AI17Z_SETUP_SHA256', 'AI17Z_SETUP_RELEASE', 'AI17Z_SETUP_SOURCE', 'AI17Z_SETUP_INSTANCE',
    'AI17Z_SETUP_UPDATE', 'AI17Z_SETUP_NEW_INSTANCE', 'AI17Z_SETUP_LIST', 'AI17Z_SETUP_WHATIF', 'AI17Z_SETUP_DETAILS')) {
  Remove-Item -Path ('Env:' + $name) -ErrorAction SilentlyContinue
}
if ($code -ne 0) {
  Write-Line 'AI17Z Setup did not finish. The message above says why.' 'Yellow'
  Write-Line ('What ran is still at ' + $setupPath) 'DarkGray'
  Write-Line
  $global:LASTEXITCODE = $code
}

} catch {
  if ($_.TargetObject -eq $StopSentinel) {
    # A refusal. Stop-Install has already said what happened, why, and what to
    # do about it; anything printed here would be a second version of that, and
    # an error record would be the thing this boundary exists to prevent.
  } else {
    # Not a refusal: something went wrong that nobody planned for. Say so in a
    # sentence, and keep the detail rather than swallowing it -- a silent catch
    # here would turn a bug into "the command did nothing".
    $detail = ('' + $_.Exception.Message)
    Write-Host ''
    Write-Host '  AI17Z could not finish, and not for a reason it recognises.' -ForegroundColor Red
    if ($detail) { Write-Host ('  ' + $detail.Split("`n")[0]) -ForegroundColor Gray }
    Write-Host '  Nothing was installed.' -ForegroundColor Gray
    try {
      $logHome = Join-Path $env:LOCALAPPDATA 'AI17Z-setup'
      if (-not (Test-Path $logHome)) { New-Item -ItemType Directory -Path $logHome -Force | Out-Null }
      $logPath = Join-Path $logHome 'install-command.log'
      # Bytes rather than Out-File: `-Encoding utf8` in Windows PowerShell puts
      # a byte-order mark on the front, and this repository has been caught by
      # that in a file another program had to read.
      $entry = @(
        '--- ' + (Get-Date).ToUniversalTime().ToString('o'),
        $detail,
        ('' + $_.ScriptStackTrace),
        ('' + $_.InvocationInfo.PositionMessage),
        ''
      ) -join "`r`n"
      [System.IO.File]::AppendAllText($logPath, $entry, (New-Object System.Text.UTF8Encoding($false)))
      Write-Host ''
      Write-Host ('  Written down in full at ' + $logPath) -ForegroundColor DarkGray
      Write-Host ('  Please report it at ' + $ProjectUrl + '/issues') -ForegroundColor Yellow
    } catch {
      # Could not write the log. The sentence above is still on screen, which is
      # the part that matters; failing to record a failure must not become a
      # second failure.
    }
    Write-Host ''
  }
  # An observable result for anything driving this, without ending the session
  # somebody is sitting in: `exit` here would close their terminal. A caller
  # that wants a process exit code asks for one --
  #   powershell -Command "irm ... | iex; exit $LASTEXITCODE"
  $global:LASTEXITCODE = 1
}
