<#
.SYNOPSIS
  Installs AI17Z on Windows, and everything AI17Z needs, in one action.

.DESCRIPTION
  This file is the whole installer. There is no compiled logic anywhere else:
  the .exe on the releases page is a wrapper that extracts this exact script and
  runs it, and its SHA-256 is published beside it so you can prove the two are
  the same. Read it before you run it. That is the point of it being a script.

  What it does, in order, and nothing else:

    1. Looks at this PC: Windows version, 64-bit, virtualisation, whether a
       restart is already pending.
    2. Makes sure WSL 2 is present, because Docker Desktop runs on it.
    3. Makes sure Docker Desktop is installed AND its engine actually answers.
    4. Makes sure Google Chrome and Node.js are present.
    5. Downloads one file from AI17Z's own GitHub release, checks its SHA-256,
       and extracts it.
    6. Starts AI17Z and checks it really works before saying so.

  Everything it installs comes from **winget**, Microsoft's own package manager,
  or from **wsl --install**, Microsoft's own command. It never downloads an
  executable from a URL of its own, and the only thing it fetches directly is
  AI17Z itself, from AI17Z's GitHub release, verified by hash.

  It changes nothing it does not have to. A dependency that is already present
  and good enough is left alone. Run it twice and the second run installs
  nothing.

  ASCII only, on purpose. A .ps1 without a BOM is read as ANSI, and one smart
  quote from a pasted em dash terminates a string somewhere unrelated.

.PARAMETER Release
  The release tag to install, for example v1.0.0-beta.16. The wrapper .exe
  passes the tag it was built for, so an .exe installs exactly one version.
  Given nothing, this asks GitHub for the newest published release.

.PARAMETER ExpectedSha256
  The SHA-256 the downloaded AI17Z package must have. The wrapper .exe passes
  the hash of the package built alongside it, which is what makes a signed .exe
  a pin on the payload rather than a pin on a filename. Given nothing, the hash
  is read from the release's own SHA256SUMS.txt, which is weaker and says so.

.PARAMETER InstanceName
  What this installation is called. Decides the program folder, the data folder,
  the Start Menu group and the uninstall entry, all from one name. Default
  AI17Z. A second installation with its own name shares nothing with the first.

.PARAMETER ProgramDir
  Where the program goes. Default %LOCALAPPDATA%\Programs\<InstanceName>.

.PARAMETER DataDir
  Where your data goes. Default %LOCALAPPDATA%\<InstanceName>. Never replaced,
  never regenerated, and not touched by an update.

.PARAMETER LocalPackage
  Install from an AI17Z-App-<version>.zip already on disk instead of downloading
  one. For an offline install, and for the verification harness.

.PARAMETER Update
  Update the installation that is already here rather than making a new one.

.PARAMETER SkipDependencies
  Check the prerequisites and report them, but install none of them. For a
  machine where somebody else manages Docker and Node.

.PARAMETER NoStart
  Install, and leave AI17Z stopped. Start it later from the Start Menu.

.PARAMETER NoBrowser
  Do not open AI17Z when it is ready.

.PARAMETER ShowDetails
  Print what each step runs and what it printed. Everything goes to the log
  either way; this puts it on the screen as well.

.PARAMETER WhatIfOnly
  Look at the machine, say exactly what would happen, and change nothing.

.PARAMETER Resume
  Continue after the restart that WSL asked for. What the "Continue AI17Z Setup"
  shortcut runs.

.PARAMETER Manifest
  Print what this script is allowed to do, as JSON: the hosts it may reach, the
  packages it may install, the files it writes, the privileged operations it
  performs. Derived from the same values the code uses, so the audit document
  cannot drift from the code. Changes nothing.

.PARAMETER LoadOnly
  Define the functions and return without doing anything. What the tests
  dot-source, so they exercise the shipped code rather than a copy of it.
#>
[CmdletBinding()]
param(
  [string] $Release = '',
  [string] $ExpectedSha256 = '',
  [string] $InstanceName = 'AI17Z',
  [string] $ProgramDir = '',
  [string] $DataDir = '',
  [string] $LocalPackage = '',
  [switch] $Update,
  [switch] $SkipDependencies,
  [switch] $NoStart,
  [switch] $NoBrowser,
  [switch] $ShowDetails,
  [switch] $WhatIfOnly,
  [switch] $Resume,
  [switch] $Manifest,
  [switch] $LoadOnly,
  # Not for people. The parent runs one elevated child for one named job and
  # then goes back to being an ordinary user; this is how it says which job.
  [ValidateSet('', 'wsl', 'packages')] [string] $ElevatedTask = '',
  [string] $ElevatedArgument = '',
  # Passed to the elevated child explicitly rather than inherited. An elevated
  # process is started through the consent broker and cannot be relied on to
  # carry this process's environment, and a child that logs somewhere else is a
  # child whose failure nobody can read.
  [string] $LogPath = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# What this script is allowed to do
#
# One declaration, read by the code below and printed by -Manifest. The audit
# document quotes these values and a test fails when the two disagree, so the
# documentation cannot quietly stop describing the program.
# ---------------------------------------------------------------------------

$script:Ai17zSetup = [ordered]@{
  # Where AI17Z itself comes from. Nothing else is ever downloaded.
  Repository = 'ShiftAboveCtrl/ai17z'
  # The hosts a request may start at. GitHub redirects asset downloads to its
  # own storage host, which is why the hash and not the hostname is what makes
  # the bytes trustworthy -- but a request that does not begin at one of these
  # is refused outright.
  AllowedHosts = @('api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com')
  # Windows 10 22H2. Below this, Docker Desktop's own requirements are not met
  # and nothing here can fix that.
  MinimumWindowsBuild = 19045
  # Kept in step with package.json engines and tests/unit/nodeVersion.test.ts.
  MinimumNodeMajor = 22
  # Everything installable, and the exact winget package it comes from. winget
  # resolves each of these from the Microsoft-run community repository and
  # checks the installer's hash before running it.
  Packages = [ordered]@{
    node   = [ordered]@{ Id = 'OpenJS.NodeJS.LTS';    Name = 'Node.js';         Page = 'https://nodejs.org/en/download';                  Why = 'runs the part of AI17Z that drives your browser' }
    docker = [ordered]@{ Id = 'Docker.DockerDesktop'; Name = 'Docker Desktop';  Page = 'https://www.docker.com/products/docker-desktop/'; Why = 'runs the database AI17Z keeps your agents in' }
    chrome = [ordered]@{ Id = 'Google.Chrome';        Name = 'Google Chrome';   Page = 'https://www.google.com/chrome/';                  Why = 'is the browser AI17Z acts through; no other browser substitutes for it' }
  }
  # The two Microsoft commands this runs with administrator rights, and nothing
  # else ever runs elevated.
  PrivilegedOperations = @(
    'wsl --install --no-distribution   (enables the Windows features Docker Desktop needs)',
    'wsl --update                      (updates WSL to a version Docker Desktop supports)',
    'winget install --exact --id <one of the packages above> --source winget'
  )
  # Every path this writes to, relative to the folders named in the audit doc.
  Writes = @(
    '<program>\  the application, replaced on every update',
    '<data>\.env  created once, never overwritten',
    '<data>\storage, <data>\browser-profiles  created if missing, never emptied',
    '<program>\data-location.txt, <program>\INSTALL_INFO.json, <program>\BUILD_INFO.json',
    '%LOCALAPPDATA%\AI17Z-setup\  the log, and the resume note while a restart is pending',
    'Start Menu\Programs\<instance>\  shortcuts',
    'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\...  the Add/Remove Programs entry',
    'HKCU\Software\AI17Z\Installs  so the next run finds this installation'
  )
  # Anything that outlives the run, so "what did it leave behind" has an answer.
  Persistence = @(
    'A Start Menu shortcut named "Continue AI17Z Setup", created only when Windows asks for a restart and deleted the moment setup finishes. There is no Run key, no scheduled task and no service.'
  )
  # What it never does.
  Never = @(
    'download an executable from a URL of its own',
    'disable or exclude anything from Defender, SmartScreen or any antivirus',
    'accept a vendor agreement on your behalf',
    'send anything about you, this machine or your agents anywhere',
    'overwrite an existing .env, master key, database, browser profile or Docker volume',
    'uninstall Docker, Node, Chrome or WSL, even when AI17Z is removed'
  )
}

# The release asset names, which the workflow and this script must agree on.
$script:Ai17zAssets = [ordered]@{
  Package  = 'AI17Z-App-{0}.zip'
  Checksums = 'SHA256SUMS.txt'
}

# A cap on what will be accepted from the network, so a wrong URL or a hostile
# redirect cannot fill somebody's disk before the hash is ever checked.
$script:Ai17zMaxDownloadBytes = 400MB

# ---------------------------------------------------------------------------
# Saying things
# ---------------------------------------------------------------------------

# Symbols that will actually render.
#
# The file stays ASCII and the glyphs are built from code points at run time, so
# a console that can draw them gets the good ones and a console that cannot gets
# letters instead of boxes. Never colour alone: every state has a distinct shape
# as well, because a red cross and a green tick are the same dot to a lot of
# people and to every screen reader.
function Get-Ai17zGlyphs {
  param([bool] $Unicode)
  if ($Unicode) {
    return [ordered]@{
      Done    = [char]0x2713            # check mark
      Active  = [char]0x25CF            # filled circle
      Pending = [char]0x25CB            # hollow circle
      Action  = '!'
      Failed  = [char]0x00D7            # multiplication sign
      Spinner = @([char]0x280B, [char]0x2819, [char]0x2839, [char]0x2838, [char]0x283C, [char]0x2834, [char]0x2826, [char]0x2827, [char]0x2807, [char]0x280F)
    }
  }
  return [ordered]@{
    Done    = '+'
    Active  = '>'
    Pending = '-'
    Action  = '!'
    Failed  = 'x'
    Spinner = @('|', '/', '-', '\')
  }
}

function Test-Ai17zUnicodeConsole {
  # Windows Terminal and PowerShell 7 draw these correctly. The old console host
  # on a legacy code page draws a question mark, which looks like a fault.
  if ($env:WT_SESSION) { return $true }
  if ($PSVersionTable.PSVersion.Major -ge 6) { return $true }
  try { return ([Console]::OutputEncoding.CodePage -eq 65001) } catch { return $false }
}

$script:Ai17zLogPath = ''
$script:Ai17zSteps = @()
$script:Ai17zDrawnLines = 0
$script:Ai17zLastDraw = [DateTime]::MinValue
$script:Ai17zGlyph = Get-Ai17zGlyphs $false
$script:Ai17zInteractive = $false
$script:Ai17zSpin = 0

<#
  Anything that looks like a secret, blanked before it can reach a log.

  The log is the whole diagnostic story of an install and it is a file on
  somebody's disk that they may well paste into an issue. A master key, a
  provider key or a bot token appearing in it once is once too often, so the
  redaction happens at the point of writing rather than at the point of
  reading.
#>
function Protect-Ai17zSecret {
  param([string] $Text)
  if (-not $Text) { return $Text }
  $out = $Text
  # KEY=value, KEY: value, "token": "value", Authorization: Bearer <token>.
  #
  # The value runs to the end of the line rather than to the next space. Written
  # the obvious way -- stop at whitespace -- `Authorization: Bearer sk-...`
  # redacted the word "Bearer" and left the credential standing next to it,
  # because the shortest match is the one a lazy quantifier finds. Redacting the
  # rest of the line costs a little context in a log and is the only version of
  # this that cannot leave half a secret behind.
  $out = [regex]::Replace($out, '(?i)((?:master[_-]?key|api[_-]?key|secret|password|passwd|token|bearer|cookie|authorization)[^\r\n]{0,20}?[=:][ \t]*)("?)[^\r\n]+', '$1$2<redacted>')
  # A long base64 run on its own is a key more often than it is anything else.
  $out = [regex]::Replace($out, '\b[A-Za-z0-9+/]{40,}={0,2}\b', '<redacted>')
  return $out
}

function Write-Ai17zLog {
  param([string] $Message, [string] $Level = 'info')
  if (-not $script:Ai17zLogPath) { return }
  $line = '{0} {1,-5} {2}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Level, (Protect-Ai17zSecret $Message)
  try { Add-Content -LiteralPath $script:Ai17zLogPath -Value $line -Encoding utf8 } catch { }
}

function Write-Ai17zDetail {
  param([string] $Message)
  Write-Ai17zLog $Message 'trace'
  if ($ShowDetails -and $Message) {
    foreach ($line in ($Message -split "`r?`n")) {
      if ($line.Trim()) { Write-Host ('      ' + (Protect-Ai17zSecret $line)) -ForegroundColor DarkGray }
    }
  }
}

<#
  The status rows.

  A step is one thing a person would recognise -- "Docker Desktop" -- and it has
  one state and one line of detail. Everything a subprocess prints goes to the
  log, not to the screen, because sixty lines of npm output is not progress, it
  is noise with progress hidden in it.
#>
function Add-Ai17zStep {
  param([string] $Key, [string] $Label)
  $script:Ai17zSteps += [pscustomobject]@{ Key = $Key; Label = $Label; State = 'pending'; Detail = ''; Started = $null }
}

function Get-Ai17zStep {
  param([string] $Key)
  return ($script:Ai17zSteps | Where-Object { $_.Key -eq $Key } | Select-Object -First 1)
}

function Set-Ai17zStep {
  param(
    [string] $Key,
    [ValidateSet('pending', 'active', 'done', 'action', 'failed')] [string] $State,
    [string] $Detail = $null
  )
  $step = Get-Ai17zStep $Key
  if (-not $step) { return }
  if ($State -eq 'active' -and $step.State -ne 'active') { $step.Started = Get-Date }
  $step.State = $State
  if ($null -ne $Detail) { $step.Detail = $Detail }
  if ($State -eq 'done' -or $State -eq 'failed' -or $State -eq 'action') {
    Write-Ai17zLog ("step {0}: {1} {2}" -f $step.Label, $State, $step.Detail)
  }
  # A run whose output is going somewhere other than a console -- a pipe, a
  # file, the verification harness -- cannot have rows rewritten under it. It
  # gets one line per settled step instead, which is the same information in the
  # form that survives being redirected.
  if (-not $script:Ai17zInteractive -and $State -ne 'pending' -and $State -ne 'active') {
    $mark = switch ($State) { 'done' { $script:Ai17zGlyph.Done } 'action' { $script:Ai17zGlyph.Action } default { $script:Ai17zGlyph.Failed } }
    Write-Host ('  {0} {1,-30}{2}' -f $mark, $step.Label, $step.Detail)
  }
  Show-Ai17zProgress -Force
}

# How long an active step has been running, once that stops being instant.
#
# No percentage. Nothing here knows how long a Docker engine takes to start, and
# a progress bar that guesses is a progress bar that lies.
function Format-Ai17zElapsed {
  param([DateTime] $Since)
  $span = (Get-Date) - $Since
  if ($span.TotalSeconds -lt 3) { return '' }
  return ('{0}:{1:00}' -f [int]$span.TotalMinutes, $span.Seconds)
}

function Show-Ai17zProgress {
  param([switch] $Force)
  if (-not $script:Ai17zInteractive) { return }
  # Throttled. A screen that redraws forty times a second flickers, and the
  # spinner is there to say "still working", not to be watched.
  if (-not $Force -and ((Get-Date) - $script:Ai17zLastDraw).TotalMilliseconds -lt 120) { return }
  $script:Ai17zLastDraw = Get-Date
  $script:Ai17zSpin += 1

  $width = 80
  try { $width = [Math]::Max(48, $Host.UI.RawUI.WindowSize.Width - 1) } catch { }

  $lines = @()
  foreach ($step in $script:Ai17zSteps) {
    $mark = switch ($step.State) {
      'done'   { $script:Ai17zGlyph.Done }
      'active' { $script:Ai17zGlyph.Spinner[$script:Ai17zSpin % $script:Ai17zGlyph.Spinner.Count] }
      'action' { $script:Ai17zGlyph.Action }
      'failed' { $script:Ai17zGlyph.Failed }
      default  { $script:Ai17zGlyph.Pending }
    }
    $colour = switch ($step.State) {
      'done'   { 'Green' }
      'active' { 'Cyan' }
      'action' { 'Yellow' }
      'failed' { 'Red' }
      default  { 'DarkGray' }
    }
    $detail = $step.Detail
    if ($step.State -eq 'active' -and $step.Started) {
      $elapsed = Format-Ai17zElapsed $step.Started
      if ($elapsed) { $detail = ($detail + '  ' + $elapsed).Trim() }
    }
    $text = '  {0} {1}' -f $mark, $step.Label
    if ($detail) { $text = '{0,-34}{1}' -f $text, $detail }
    if ($text.Length -gt $width) { $text = $text.Substring(0, $width - 1) + '.' }
    $lines += [pscustomobject]@{ Text = $text; Colour = $colour }
  }

  # Rewind over what was drawn last time rather than clearing the screen, so
  # anything printed above the rows -- a question, a warning -- stays put.
  if ($script:Ai17zDrawnLines -gt 0) {
    try {
      $pos = $Host.UI.RawUI.CursorPosition
      $pos.Y = [Math]::Max(0, $pos.Y - $script:Ai17zDrawnLines)
      $pos.X = 0
      $Host.UI.RawUI.CursorPosition = $pos
    } catch {
      $script:Ai17zInteractive = $false
      return
    }
  }
  foreach ($line in $lines) {
    Write-Host ($line.Text.PadRight($width)) -ForegroundColor $line.Colour
  }
  $script:Ai17zDrawnLines = $lines.Count
}

# A step that takes a while, with the spinner turning while it waits.
function Wait-Ai17zUntil {
  param(
    [Parameter(Mandatory)] [scriptblock] $Condition,
    [int] $TimeoutSeconds = 120,
    [scriptblock] $OnTick = $null
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (& $Condition) { return $true }
    if ($OnTick) { & $OnTick }
    Show-Ai17zProgress
    Start-Sleep -Milliseconds 700
  }
  return $false
}

function Write-Ai17zSay {
  param([string] $Message, [string] $Colour = 'Gray')
  # Anything printed outside the rows has to end the rewind, or the next redraw
  # writes over it.
  $script:Ai17zDrawnLines = 0
  Write-Host ''
  foreach ($line in ($Message -split "`n")) { Write-Host ('  ' + $line) -ForegroundColor $Colour }
  Write-Host ''
}

<#
  A stop somebody can act on.

  Four things, always in the same order, because a failure message that is
  missing any one of them sends people to a search engine: what happened, why it
  matters, what to do, and what happens after they have done it.
#>
function Stop-Ai17z {
  param([string] $What, [string] $Why = '', [string] $Do = '', [string] $Then = '')
  Show-Ai17zProgress -Force
  $script:Ai17zDrawnLines = 0
  Write-Host ''
  Write-Host ('  ' + $What) -ForegroundColor Red
  if ($Why) { foreach ($line in ($Why -split "`n")) { Write-Host ('  ' + $line) -ForegroundColor Gray } }
  if ($Do) {
    Write-Host ''
    foreach ($line in ($Do -split "`n")) { Write-Host ('  ' + $line) -ForegroundColor Yellow }
  }
  if ($Then) { Write-Host ('  ' + $Then) -ForegroundColor DarkGray }
  if ($script:Ai17zLogPath) {
    Write-Host ''
    Write-Host ('  The full log is at ' + $script:Ai17zLogPath) -ForegroundColor DarkGray
  }
  Write-Host ''
  Write-Ai17zLog ("stopped: {0} :: {1}" -f $What, $Do) 'error'
  Wait-Ai17zForKey
  exit 1
}

function Wait-Ai17zForKey {
  # An icon that flashes a window and vanishes tells nobody anything. A run with
  # nobody watching must never wait for a key that is not coming.
  if ($env:CI -or $env:AI17Z_NO_BROWSER -or $WhatIfOnly) { return }
  if ($Host.Name -ne 'ConsoleHost') { return }
  try { if ([Console]::IsInputRedirected) { return } } catch { return }
  Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
  [void](Read-Host)
}

function Read-Ai17zYesNo {
  param([string] $Question, [bool] $DefaultYes = $true)
  if ($env:CI -or $WhatIfOnly) { return $false }
  try { if ([Console]::IsInputRedirected) { return $false } } catch { return $false }
  $suffix = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
  $script:Ai17zDrawnLines = 0
  Write-Host ''
  Write-Host ('  ' + $Question + ' ' + $suffix + ' ') -NoNewline -ForegroundColor White
  $answer = Read-Host
  if (-not $answer) { return $DefaultYes }
  return ($answer.Trim().ToLowerInvariant() -like 'y*')
}

# ---------------------------------------------------------------------------
# Running things
# ---------------------------------------------------------------------------

<#
  A native command, judged by its exit code and never by its stderr.

  Docker, npm and winget all write ordinary progress to stderr, and under
  ErrorActionPreference = Stop that is promoted to a terminating error even when
  the command succeeded.
#>
function Invoke-Ai17zNative {
  param(
    [Parameter(Mandatory)] [string] $Exe,
    [string[]] $Arguments = @(),
    [string] $WorkingDirectory = '',
    [int] $TimeoutSeconds = 0
  )
  Write-Ai17zLog ('run: {0} {1}' -f $Exe, ($Arguments -join ' '))
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = ''
  $code = -1
  try {
    if ($WorkingDirectory) { Push-Location $WorkingDirectory }
    $raw = & $Exe @Arguments 2>&1
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    $output = ($raw | Out-String)
  } catch {
    $output = $_.Exception.Message
    $code = -1
  } finally {
    if ($WorkingDirectory) { Pop-Location }
    $ErrorActionPreference = $previous
    $global:LASTEXITCODE = 0
  }
  Write-Ai17zDetail $output
  return [pscustomobject]@{ Code = $code; Output = $output }
}

function Test-Ai17zCommand {
  param([string] $Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

<#
  Whatever a running process has written to its log since the last look.

  Opened with ReadWrite sharing, because the process writing it still holds it
  open and the default sharing would fail every read.
#>
function Read-Ai17zNewText {
  param([string] $Path, [ref] $Offset)
  if (-not (Test-Path $Path)) { return '' }
  $stream = $null
  try {
    $stream = New-Object System.IO.FileStream(
      $Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    if ($stream.Length -le $Offset.Value) { return '' }
    [void]$stream.Seek($Offset.Value, [System.IO.SeekOrigin]::Begin)
    $buffer = New-Object byte[] ($stream.Length - $Offset.Value)
    $read = $stream.Read($buffer, 0, $buffer.Length)
    $Offset.Value = $Offset.Value + $read
    return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
  } catch {
    return ''
  } finally {
    if ($stream) { $stream.Dispose() }
  }
}

<#
  A child process watched rather than waited on.

  `Invoke-Ai17zNative` blocks until its command finishes and collects the output
  in one go. For the long step -- the first start, which builds three images,
  applies every migration and waits for the API -- that is several minutes with
  a spinner that does not turn and a row that does not change. Everywhere else
  in AI17Z that is called a bug; it would be one here too, and on the one screen
  somebody watches while nothing appears to happen.

  So the output goes to a file, the file is read as it is written, and the step
  says which part of the long thing is happening. `$Summarise` turns a line of
  the child's output into a few words for the row; anything it does not
  recognise leaves the row as it was.
#>
function Invoke-Ai17zWatched {
  param(
    [Parameter(Mandatory)] [string] $Exe,
    [string[]] $Arguments = @(),
    [string] $WorkingDirectory = '',
    [string] $StepKey = '',
    [scriptblock] $Summarise = $null,
    # An hour. Not for ever: "never spin indefinitely" is the rule, and a build
    # that has not finished in an hour is not a build somebody should be
    # watching a spinner for.
    [int] $TimeoutSeconds = 3600
  )
  Write-Ai17zLog ('run: ' + $Exe + ' ' + ($Arguments -join ' '))
  $stdout = [System.IO.Path]::Combine($script:Ai17zSetupHome, 'run-' + [guid]::NewGuid().ToString('N') + '.out')
  $stderr = $stdout + '.err'

  $options = @{
    FilePath = $Exe
    PassThru = $true
    # Not a hidden window: a redirected child needs no window at all, and a
    # hidden one still flashes on some machines.
    NoNewWindow = $true
    RedirectStandardOutput = $stdout
    RedirectStandardError = $stderr
  }
  if ($Arguments.Count -gt 0) { $options['ArgumentList'] = $Arguments }
  if ($WorkingDirectory) { $options['WorkingDirectory'] = $WorkingDirectory }

  $process = Start-Process @options
  # Touched, not used. `Start-Process -PassThru` hands back a process object
  # whose ExitCode stays null unless its handle has been cached, and reading
  # .Handle is what caches it. Without this the code below cannot tell a start
  # that failed from one that worked.
  $null = $process.Handle

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $offset = 0
  $collected = New-Object System.Text.StringBuilder
  $timedOut = $false

  # Whatever has been written since the last look: kept, logged, and turned into
  # something the row can say. One block, used inside the loop and again after
  # it, because the last thing a process prints is usually the interesting part
  # and it arrives after the loop has noticed the process ending.
  $consume = {
    $text = Read-Ai17zNewText $stdout ([ref]$offset)
    if (-not $text) { return }
    [void]$collected.Append($text)
    Write-Ai17zDetail $text.TrimEnd()
    if ($StepKey -and $Summarise) {
      foreach ($line in ($text -split "`r?`n")) {
        if (-not $line.Trim()) { continue }
        $said = & $Summarise $line
        if ($said) { Set-Ai17zStep $StepKey 'active' $said }
      }
    }
  }

  while (-not $process.HasExited) {
    if ((Get-Date) -ge $deadline) { $timedOut = $true; break }
    & $consume
    Show-Ai17zProgress
    Start-Sleep -Milliseconds 400
  }

  & $consume
  if (Test-Path $stderr) {
    $errors = Get-Content -Raw -LiteralPath $stderr -ErrorAction SilentlyContinue
    if ($errors) { [void]$collected.Append($errors); Write-Ai17zDetail $errors.TrimEnd() }
  }
  Remove-Item -LiteralPath $stdout, $stderr -Force -ErrorAction SilentlyContinue

  if ($timedOut) {
    # Deliberately not killed. A docker build carries on inside the daemon
    # whatever happens to the process that asked for it, so killing this would
    # tidy away the only thing reporting on it and change nothing else.
    return [pscustomobject]@{ Code = 1460; Output = $collected.ToString(); TimedOut = $true }
  }

  try { $process.WaitForExit() } catch { }
  $code = $process.ExitCode
  # An exit code that cannot be read is not a zero. Defaulting it to one turns
  # "AI17Z did not start" into "AI17Z is ready", which is the worst answer this
  # function has available to it.
  if ($null -eq $code) { $code = 1 }
  return [pscustomobject]@{ Code = $code; Output = $collected.ToString(); TimedOut = $false }
}

# ---------------------------------------------------------------------------
# Deciding things
#
# Everything below this line is a pure function: it takes what was measured and
# returns what to do about it, and it touches nothing. That is what makes the
# twenty-odd machine states testable without twenty-odd machines --
# tests/unit/bootstrapDecisions.test.ts dot-sources this file and calls these.
# ---------------------------------------------------------------------------

function Test-Ai17zVersionAtLeast {
  param([string] $Version, [string] $Minimum)
  if (-not $Version) { return $false }
  $clean = ($Version -replace '[^0-9.].*$', '')
  if (-not $clean) { return $false }
  $left = @($clean -split '\.' | ForEach-Object { [int]($_ -replace '\D', '0') })
  $right = @($Minimum -split '\.' | ForEach-Object { [int]$_ })
  for ($i = 0; $i -lt [Math]::Max($left.Count, $right.Count); $i++) {
    $l = 0; if ($i -lt $left.Count) { $l = $left[$i] }
    $r = 0; if ($i -lt $right.Count) { $r = $right[$i] }
    if ($l -gt $r) { return $true }
    if ($l -lt $r) { return $false }
  }
  return $true
}

<#
  Whether AI17Z can run on this machine at all.

  Refused rather than attempted. Docker Desktop's own requirement is Windows 10
  22H2 or Windows 11, and an installation that gets halfway through enabling
  Windows features on an unsupported build leaves the machine changed and AI17Z
  not working.
#>
function Get-Ai17zWindowsVerdict {
  param(
    [int] $Build,
    [bool] $Is64Bit,
    [bool] $HypervisorPresent,
    [bool] $VirtualizationFirmwareEnabled
  )
  if (-not $Is64Bit) {
    return [pscustomobject]@{ State = 'UNSUPPORTED'; Message = 'This is a 32-bit Windows.'; Fix = 'AI17Z needs 64-bit Windows, because Docker Desktop does.' }
  }
  if ($Build -lt $script:Ai17zSetup.MinimumWindowsBuild) {
    return [pscustomobject]@{
      State = 'UNSUPPORTED'
      Message = ('This is Windows build {0}.' -f $Build)
      Fix = ('AI17Z needs build {0} or newer -- Windows 10 22H2, or any Windows 11. Update Windows and run this again.' -f $script:Ai17zSetup.MinimumWindowsBuild)
    }
  }
  # Not fatal on its own: the hypervisor shows as absent on a machine where
  # nothing has started it yet, and WSL turning it on is exactly what the next
  # step does. Firmware virtualisation being off is the one that cannot be
  # fixed from here, and it is a BIOS setting rather than a Windows one.
  if (-not $HypervisorPresent -and -not $VirtualizationFirmwareEnabled) {
    return [pscustomobject]@{
      State = 'NO_VIRTUALISATION'
      Message = 'Virtualisation is turned off in this PC firmware.'
      Fix = "Docker Desktop cannot run without it. Turn on Intel VT-x or AMD-V (sometimes called SVM) in your BIOS or UEFI settings, then run this again.`nOn most machines: restart, press the setup key your PC shows at startup, and look under CPU or Advanced."
    }
  }
  # A restart pending from something else is deliberately not judged here. It
  # matters only when Windows features are about to change, which is the WSL
  # step's business -- and refusing to install AI17Z on a machine that merely
  # has an update waiting would refuse most machines.
  return [pscustomobject]@{ State = 'OK'; Message = ('Windows build {0}, 64-bit' -f $Build); Fix = '' }
}

<#
  What to do about WSL.

  Docker Desktop runs on WSL 2 and needs version 2.1.5 or newer of it. AI17Z
  needs no Linux distribution of its own -- Docker Desktop brings the only one
  it uses -- so this installs WSL with --no-distribution and leaves the user's
  distributions, if they have any, completely alone.
#>
function Get-Ai17zWslVerdict {
  param(
    [bool] $CommandPresent,
    [string] $WslVersion,
    [bool] $RebootPending,
    [bool] $FeatureEnabled
  )
  # 2.1.5 is Docker Desktop's stated minimum. A WSL that meets it is ready
  # whatever else the machine has pending: a restart waiting on somebody else's
  # update does not un-ready a subsystem that is already running.
  if ($WslVersion -and (Test-Ai17zVersionAtLeast $WslVersion '2.1.5')) {
    return [pscustomobject]@{ State = 'READY'; Action = 'NONE'; Message = ('WSL ' + $WslVersion); Fix = '' }
  }

  # From here something has to change, and changing Windows features on top of a
  # restart Windows is already waiting for is how an install ends up half
  # applied -- the features report enabled, the platform is not there, and the
  # next step installs Docker onto nothing.
  if ($RebootPending) {
    return [pscustomobject]@{
      State = 'RESTART_FIRST'; Action = 'RESTART'
      Message = 'Windows is waiting for a restart'
      Fix = 'Restart this PC and run AI17Z Setup again. WSL 2 cannot be set up on top of a restart Windows is already waiting for.'
    }
  }

  if (-not $CommandPresent) {
    return [pscustomobject]@{ State = 'ABSENT'; Action = 'INSTALL'; Message = 'not installed'; Fix = '' }
  }
  if (-not $WslVersion) {
    # wsl.exe exists on every Windows 10 and 11 whether or not WSL is set up, so
    # its presence proves nothing. `wsl --version` answering is what says the
    # modern, updatable WSL is actually here.
    if ($FeatureEnabled) {
      return [pscustomobject]@{ State = 'NEEDS_UPDATE'; Action = 'UPDATE'; Message = 'an older WSL is present'; Fix = '' }
    }
    return [pscustomobject]@{ State = 'ABSENT'; Action = 'INSTALL'; Message = 'not set up yet'; Fix = '' }
  }
  return [pscustomobject]@{ State = 'NEEDS_UPDATE'; Action = 'UPDATE'; Message = ('WSL ' + $WslVersion + ' is too old'); Fix = '' }
}

<#
  What to do about Docker.

  The distinction this exists for: installed, running, and healthy are three
  different things, and the previous installer treated the first as all three.
  Somebody with Docker Desktop installed but never started got told AI17Z was
  ready and then watched it fail on a database that was not there.
#>
function Get-Ai17zDockerVerdict {
  param(
    [bool] $CliPresent,
    [bool] $DesktopInstalled,
    [bool] $DesktopRunning,
    [bool] $EngineAnswers,
    [string] $OsType,
    [bool] $RebootPending
  )
  if (-not $DesktopInstalled -and -not $CliPresent) {
    return [pscustomobject]@{ State = 'ABSENT'; Action = 'INSTALL'; Message = 'not installed'; Fix = '' }
  }
  if ($EngineAnswers) {
    if ($OsType -and $OsType -ne 'linux') {
      return [pscustomobject]@{
        State = 'WRONG_MODE'; Action = 'SWITCH'
        Message = ('running ' + $OsType + ' containers')
        Fix = "AI17Z's database is a Linux container. In Docker Desktop, right-click the whale in the notification area and choose `"Switch to Linux containers`", then run this again."
      }
    }
    return [pscustomobject]@{ State = 'READY'; Action = 'NONE'; Message = 'engine is up'; Fix = '' }
  }
  if ($RebootPending) {
    return [pscustomobject]@{ State = 'NEEDS_RESTART'; Action = 'RESTART'; Message = 'needs a restart to finish'; Fix = '' }
  }
  if ($DesktopRunning) {
    return [pscustomobject]@{ State = 'STARTING'; Action = 'WAIT'; Message = 'starting the engine'; Fix = '' }
  }
  return [pscustomobject]@{ State = 'NOT_RUNNING'; Action = 'START'; Message = 'installed, not running'; Fix = '' }
}

function Get-Ai17zNodeVerdict {
  param([int] $Major)
  if ($Major -le 0) { return [pscustomobject]@{ State = 'ABSENT'; Action = 'INSTALL'; Message = 'not installed' } }
  if ($Major -lt $script:Ai17zSetup.MinimumNodeMajor) {
    return [pscustomobject]@{ State = 'TOO_OLD'; Action = 'INSTALL'; Message = ('Node ' + $Major + ' is too old') }
  }
  return [pscustomobject]@{ State = 'READY'; Action = 'NONE'; Message = ('Node ' + $Major) }
}

<#
  Real Google Chrome, or nothing.

  AI17Z drives the browser somebody is signed in to X with, and Chromium and
  Edge are not substitutes: the product refuses them everywhere else and this
  must not be the one place that quietly accepts one. The version resource is
  what says which browser a chrome.exe actually is, and a Chrome-shaped path is
  not evidence.
#>
function Get-Ai17zChromeVerdict {
  param([string] $Path, [string] $ProductName, [string] $Version)
  if (-not $Path) { return [pscustomobject]@{ State = 'ABSENT'; Action = 'INSTALL'; Message = 'not installed' } }
  if ($ProductName -and $ProductName -notmatch 'Google Chrome') {
    return [pscustomobject]@{ State = 'NOT_CHROME'; Action = 'INSTALL'; Message = ('found ' + $ProductName + ', which is not Google Chrome') }
  }
  return [pscustomobject]@{ State = 'READY'; Action = 'NONE'; Message = ('Chrome ' + $Version) }
}

<#
  Where this installation goes, and the rule that stopped a published installer
  putting one instance's files inside another's.

  A name given on the command line settles the program folder, the data folder,
  the Start Menu group and the uninstall identity together. Nothing discovered
  on the machine may move any of them afterwards. Beta 1.0.0 (14) shipped an
  installer where an invisible wizard page did exactly that: everything built
  from the name said AI17Z-probe and the files went into AI17Z-test.
#>
function Get-Ai17zLayout {
  param(
    [string] $InstanceName,
    [string] $ProgramDir,
    [string] $DataDir,
    [string] $LocalAppData
  )
  $name = $InstanceName
  if (-not $name) { $name = 'AI17Z' }
  $name = ($name -replace '[\\/:*?"<>|]', '').Trim()
  if (-not $name) { throw 'The instance name is empty once the characters Windows forbids in a folder name are removed.' }

  # [IO.Path]::Combine rather than Join-Path: Join-Path resolves the drive
  # qualifier through PowerShell's provider, so `C:\...` is an error anywhere
  # there is no C: drive -- which is every Linux machine, including the one CI
  # runs these functions on. Combine is string arithmetic and gives the same
  # answer on Windows, where this actually runs.
  $program = $ProgramDir
  if (-not $program) { $program = [System.IO.Path]::Combine($LocalAppData, 'Programs', $name) }
  $data = $DataDir
  if (-not $data) { $data = [System.IO.Path]::Combine($LocalAppData, $name) }

  return [pscustomobject]@{
    Instance = $name
    ProgramDir = $program
    DataDir = $data
    # The identity Windows uses, derived from the name and from nothing else.
    UninstallKey = ('{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}_' + $name + '_setup')
    StartMenuGroup = $name
  }
}

<#
  Whether the name asked for and the place chosen still agree.

  The regression guard for the defect above, in the one place both values exist
  at once. An explicit name and a destination whose last segment is a different
  name is not a thing to correct: it is a thing to refuse.
#>
function Test-Ai17zLayoutConsistent {
  param([string] $RequestedName, [string] $ProgramDir, [bool] $ProgramDirExplicit)
  if (-not $RequestedName) { return $true }
  if ($ProgramDirExplicit) { return $true }
  # Split on both separators rather than through Split-Path. A path can arrive
  # with a forward slash in it -- somebody typing one, a value that has been
  # through a JSON document -- and Split-Path answers according to the platform
  # it is running on, which for the tests is not always this one.
  $leaf = @(($ProgramDir -replace '[\\/]+$', '') -split '[\\/]') | Select-Object -Last 1
  return ($leaf -ieq $RequestedName)
}

<#
  Whether a zip entry may be written.

  A zip stores whatever path its maker put in it, including `..\..\Windows\` and
  `C:\`. Checked entry by entry rather than trusting the extractor, because
  which extractor validates what has changed between .NET versions and this must
  not depend on that.
#>
function Test-Ai17zArchiveEntryPath {
  param([string] $Name)
  if (-not $Name) { return $false }
  if ($Name -match '^[A-Za-z]:') { return $false }
  if ($Name.StartsWith('/') -or $Name.StartsWith('\')) { return $false }
  $parts = $Name -split '[\\/]'
  foreach ($part in $parts) {
    if ($part -eq '..') { return $false }
  }
  # A null byte or a control character in a path is never legitimate and is a
  # classic way to make one name look like another.
  if ($Name -match '[\x00-\x1f]') { return $false }
  return $true
}

<#
  Ports for a new installation.

  Only ever for one that has never run: an installation that already has a .env
  keeps the ports in it, because changing them moves its database.
#>
function Select-Ai17zPorts {
  param(
    [Parameter(Mandatory)] [scriptblock] $IsTaken,
    [int] $Web = 8080,
    [int] $Api = 8787,
    # Not `Db`: PowerShell gives every advanced function a -Debug parameter
    # whose alias is `db`, and a parameter of that name is refused at call time
    # rather than at definition time -- so it parses, and fails the first time
    # anybody runs it.
    [int] $Postgres = 55432
  )
  $chosen = @{}
  foreach ($want in @(@{ Key = 'Web'; Port = $Web }, @{ Key = 'Api'; Port = $Api }, @{ Key = 'Db'; Port = $Postgres })) {
    $port = $want.Port
    $tries = 0
    while ((& $IsTaken $port) -or ($chosen.Values -contains $port)) {
      $port += 1
      $tries += 1
      if ($tries -gt 200) { throw ('No free port could be found near ' + $want.Port + '.') }
    }
    $chosen[$want.Key] = $port
  }
  return [pscustomobject]@{ Web = $chosen['Web']; Api = $chosen['Api']; Db = $chosen['Db'] }
}

<#
  What a resume note is worth.

  Re-probed rather than trusted: the note says where setup had got to, and every
  step still asks the machine what is actually true. A note from a different
  version, a different instance, or a week ago is discarded rather than
  followed.
#>
function Test-Ai17zResumeUsable {
  param([psobject] $State, [string] $Instance, [datetime] $Now)
  if (-not $State) { return $false }
  if ($State.schema -ne 1) { return $false }
  if ($State.instance -and $Instance -and ($State.instance -ne $Instance)) { return $false }
  if (-not $State.savedAt) { return $false }
  try { $saved = [datetime]::Parse($State.savedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } catch { return $false }
  # A restart happens in minutes. A note older than a day is somebody's
  # abandoned attempt, and continuing from it would skip checks that matter.
  return (($Now - $saved).TotalHours -lt 24)
}

if ($LoadOnly) { return }

# ---------------------------------------------------------------------------
# Measuring things
# ---------------------------------------------------------------------------

function Get-Ai17zPendingReboot {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending',
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired'
  )
  foreach ($key in $keys) {
    if (Test-Path $key) { return $true }
  }
  try {
    $pending = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue
    if ($pending -and $pending.PendingFileRenameOperations) { return $true }
  } catch { }
  return $false
}

function Get-Ai17zWindowsBuild {
  $build = 0
  try { $build = [int][Environment]::OSVersion.Version.Build } catch { }
  try {
    # The registry is the value that does not depend on the process manifest.
    $reg = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name CurrentBuildNumber -ErrorAction SilentlyContinue).CurrentBuildNumber
    if ($reg) { $build = [Math]::Max($build, [int]$reg) }
  } catch { }
  return $build
}

function Measure-Ai17zMachine {
  $hyper = $false
  $firmware = $true
  try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs) { $hyper = [bool]$cs.HypervisorPresent }
  } catch { }
  try {
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    # Only believed when it says no. The property is absent on some machines and
    # $null must not read as "virtualisation is off".
    if ($cpu -and $null -ne $cpu.VirtualizationFirmwareEnabled) { $firmware = [bool]$cpu.VirtualizationFirmwareEnabled }
  } catch { }
  return [pscustomobject]@{
    Build = Get-Ai17zWindowsBuild
    Is64Bit = [Environment]::Is64BitOperatingSystem
    HypervisorPresent = $hyper
    VirtualizationFirmwareEnabled = $firmware
    RebootPending = Get-Ai17zPendingReboot
  }
}

function Measure-Ai17zWsl {
  $present = Test-Ai17zCommand 'wsl'
  $version = ''
  $feature = $false
  if ($present) {
    $result = Invoke-Ai17zNative 'wsl' @('--version')
    if ($result.Code -eq 0) {
      # wsl.exe writes UTF-16, which arrives here with a null byte between every
      # character when the console code page is not UTF-8. Strip them rather
      # than parse mojibake.
      $text = ($result.Output -replace "`0", '')
      $match = [regex]::Match($text, 'WSL version:\s*([0-9]+(?:\.[0-9]+)+)')
      if ($match.Success) { $version = $match.Groups[1].Value }
    }
  }
  try {
    $optional = Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Services\LxssManager' -ErrorAction SilentlyContinue
    if ($optional) { $feature = $true }
  } catch { }
  return [pscustomobject]@{ CommandPresent = $present; Version = $version; FeatureEnabled = $feature }
}

function Get-Ai17zDockerDesktopPath {
  foreach ($candidate in @(
      (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
      (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe'),
      (Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe'))) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return ''
}

function Measure-Ai17zDocker {
  $cli = Test-Ai17zCommand 'docker'
  $desktop = Get-Ai17zDockerDesktopPath
  $running = [bool](Get-Process 'Docker Desktop' -ErrorAction SilentlyContinue)
  $engine = $false
  $osType = ''
  if ($cli) {
    # `docker info` rather than `docker version`: the client answers on its own
    # and says nothing about whether there is a daemon behind it.
    $result = Invoke-Ai17zNative 'docker' @('info', '--format', '{{.OSType}}')
    if ($result.Code -eq 0) {
      $osType = ($result.Output -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
      if ($osType) { $osType = $osType.Trim().ToLowerInvariant() }
      $engine = $true
    }
  }
  return [pscustomobject]@{
    CliPresent = $cli
    DesktopInstalled = [bool]$desktop
    DesktopPath = $desktop
    DesktopRunning = $running
    EngineAnswers = $engine
    OsType = $osType
  }
}

function Measure-Ai17zNode {
  if (-not (Test-Ai17zCommand 'node')) { return 0 }
  $result = Invoke-Ai17zNative 'node' @('--version')
  if ($result.Code -ne 0) { return 0 }
  $match = [regex]::Match($result.Output, 'v(\d+)\.')
  if (-not $match.Success) { return 0 }
  return [int]$match.Groups[1].Value
}

function Measure-Ai17zChrome {
  $paths = @(
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
    (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
  )
  foreach ($path in $paths) {
    if ($path -and (Test-Path $path)) {
      $info = (Get-Item $path).VersionInfo
      return [pscustomobject]@{ Path = $path; ProductName = ('' + $info.ProductName).Trim(); Version = ('' + $info.ProductVersion).Trim() }
    }
  }
  return [pscustomobject]@{ Path = ''; ProductName = ''; Version = '' }
}

function Test-Ai17zPortTaken {
  param([int] $Port)
  try { return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) } catch { return $false }
}

function Test-Ai17zAdministrator {
  try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  } catch { return $false }
}

# ---------------------------------------------------------------------------
# Changing things
# ---------------------------------------------------------------------------

<#
  One elevated child, for one named job, explained before the prompt appears.

  Not the whole run. Everything after the Windows features are in place is
  ordinary-user work, and an installer that keeps administrator rights for the
  rest of its life is one that had no reason to ask for them in the first place.
#>
function Invoke-Ai17zElevated {
  param([string] $Task, [string] $Argument, [string] $Explanation)
  if ($WhatIfOnly) {
    Write-Ai17zSay ('Would ask for administrator approval to: ' + $Explanation) 'Yellow'
    return 0
  }
  $script:Ai17zDrawnLines = 0
  Write-Host ''
  Write-Host '  Windows needs administrator approval' -ForegroundColor White
  Write-Host ('  ' + $Explanation) -ForegroundColor Gray
  Write-Host '  You will see the standard Windows prompt. AI17Z never sees your password.' -ForegroundColor DarkGray
  Write-Host ''

  $self = $script:Ai17zScriptPath
  $arguments = @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $self + '"'),
    '-ElevatedTask', $Task
  )
  if ($Argument) { $arguments += @('-ElevatedArgument', $Argument) }
  if ($script:Ai17zLogPath) { $arguments += @('-LogPath', ('"' + $script:Ai17zLogPath + '"')) }

  Write-Ai17zLog ('elevating for ' + $Task + ' ' + $Argument)
  try {
    $process = Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -Verb RunAs -Wait -PassThru
    return $process.ExitCode
  } catch {
    # A refused UAC prompt is a decision, not a crash.
    Write-Ai17zLog ('elevation refused: ' + $_.Exception.Message) 'warn'
    return 1223
  }
}

function Install-Ai17zWsl {
  # Microsoft's own command, with the one flag that matters here: AI17Z needs
  # the WSL platform, not a Linux distribution. Docker Desktop installs the only
  # one it uses, and putting Ubuntu on somebody's machine because an unrelated
  # program needed a kernel is not a thing to do quietly.
  $result = Invoke-Ai17zNative 'wsl' @('--install', '--no-distribution')
  if ($result.Code -ne 0) {
    # Older builds do not know --no-distribution. Rather than install Ubuntu
    # instead, say so: a wrong distribution is somebody else's disk space and
    # somebody else's Start Menu.
    Write-Ai17zLog ('wsl --install --no-distribution failed with ' + $result.Code) 'warn'
  }
  return $result.Code
}

function Update-Ai17zWsl {
  $result = Invoke-Ai17zNative 'wsl' @('--update')
  return $result.Code
}

<#
  One package, through winget, and never anything else.

  winget resolves the package from the Microsoft-run community repository and
  verifies the installer's hash before running it. A URL baked into this file
  would be a link that can rot, redirect or be replaced, with nobody the wiser.

  Judged by asking the machine again afterwards rather than by winget's exit
  code: winget has a large table of negative codes, several of which mean
  success, and one of which looks like "already installed" and actually means
  "no such package".
#>
function Install-Ai17zPackage {
  param([string] $Key)
  $package = $script:Ai17zSetup.Packages[$Key]
  if (-not (Test-Ai17zCommand 'winget')) {
    return [pscustomobject]@{ Ok = $false; Reason = 'NO_WINGET'; Page = $package.Page; Name = $package.Name }
  }
  $arguments = @(
    'install', '--exact', '--id', $package.Id,
    '--silent',
    # Only the Microsoft-run repository. Never a source somebody added to this
    # machine, which would defeat the point of using winget at all.
    '--source', 'winget',
    # winget's own agreements, not the vendor's. Docker's subscription agreement
    # is accepted by the person in Docker Desktop's own first-run screen, and
    # AI17Z does not answer it for them.
    '--accept-package-agreements', '--accept-source-agreements',
    '--disable-interactivity'
  )
  Write-Ai17zLog ('winget ' + ($arguments -join ' '))
  $result = Invoke-Ai17zNative 'winget' $arguments
  return [pscustomobject]@{ Ok = ($result.Code -eq 0); Reason = ('exit ' + $result.Code); Page = $package.Page; Name = $package.Name }
}

# ---------------------------------------------------------------------------
# The elevated child
#
# It does one thing and exits. Everything it can be asked to do is in the list
# above, and nothing it is asked to do comes from the network.
# ---------------------------------------------------------------------------

if ($ElevatedTask) {
  $script:Ai17zLogPath = $LogPath
  if (-not $script:Ai17zLogPath) { $script:Ai17zLogPath = $env:AI17Z_SETUP_LOG }
  Write-Host ''
  switch ($ElevatedTask) {
    'wsl' {
      Write-Host '  Setting up WSL 2. This is Microsoft''s own installer.' -ForegroundColor Cyan
      $code = 0
      if ($ElevatedArgument -eq 'update') { $code = Update-Ai17zWsl } else { $code = Install-Ai17zWsl }
      exit $code
    }
    'packages' {
      $wanted = @($ElevatedArgument -split ',' | Where-Object { $_ })
      $failed = 0
      foreach ($key in $wanted) {
        if (-not $script:Ai17zSetup.Packages.Contains($key)) { continue }
        Write-Host ('  Installing ' + $script:Ai17zSetup.Packages[$key].Name + ' through winget.') -ForegroundColor Cyan
        $outcome = Install-Ai17zPackage $key
        if (-not $outcome.Ok) { $failed += 1 }
      }
      exit $failed
    }
  }
  exit 0
}

# ---------------------------------------------------------------------------
# The manifest
# ---------------------------------------------------------------------------

if ($Manifest) {
  $document = [ordered]@{
    schema = 1
    script = 'packaging/windows/Setup-AI17Z.ps1'
    repository = $script:Ai17zSetup.Repository
    allowedHosts = $script:Ai17zSetup.AllowedHosts
    minimumWindowsBuild = $script:Ai17zSetup.MinimumWindowsBuild
    minimumNodeMajor = $script:Ai17zSetup.MinimumNodeMajor
    packages = @($script:Ai17zSetup.Packages.Keys | ForEach-Object {
        [ordered]@{ key = $_; id = $script:Ai17zSetup.Packages[$_].Id; name = $script:Ai17zSetup.Packages[$_].Name; why = $script:Ai17zSetup.Packages[$_].Why; page = $script:Ai17zSetup.Packages[$_].Page }
      })
    privilegedOperations = $script:Ai17zSetup.PrivilegedOperations
    writes = $script:Ai17zSetup.Writes
    persistence = $script:Ai17zSetup.Persistence
    never = $script:Ai17zSetup.Never
    assets = [ordered]@{ package = $script:Ai17zAssets.Package; checksums = $script:Ai17zAssets.Checksums }
  }
  $document | ConvertTo-Json -Depth 6
  exit 0
}

# ---------------------------------------------------------------------------
# Everything from here is the install itself
# ---------------------------------------------------------------------------

$script:Ai17zScriptPath = $PSCommandPath
if (-not $script:Ai17zScriptPath) { $script:Ai17zScriptPath = $MyInvocation.MyCommand.Path }

$script:Ai17zSetupHome = Join-Path $env:LOCALAPPDATA 'AI17Z-setup'
$script:Ai17zStatePath = Join-Path $script:Ai17zSetupHome 'resume.json'

function Initialize-Ai17zLog {
  if ($env:AI17Z_SETUP_LOG) { $script:Ai17zLogPath = $env:AI17Z_SETUP_LOG; return }
  try {
    if (-not (Test-Path $script:Ai17zSetupHome)) { New-Item -ItemType Directory -Path $script:Ai17zSetupHome -Force | Out-Null }
    $script:Ai17zLogPath = Join-Path $script:Ai17zSetupHome ('setup-' + (Get-Date).ToString('yyyyMMdd-HHmmss') + '.log')
    $env:AI17Z_SETUP_LOG = $script:Ai17zLogPath
    Write-Ai17zLog ('AI17Z setup, script ' + $script:Ai17zScriptPath)
    Write-Ai17zLog ('windows ' + [Environment]::OSVersion.VersionString + ', powershell ' + $PSVersionTable.PSVersion)
  } catch {
    $script:Ai17zLogPath = ''
  }
}

function Save-Ai17zResume {
  param([string] $Stage, [psobject] $Layout)
  $state = [ordered]@{
    schema = 1
    stage = $Stage
    instance = $Layout.Instance
    programDir = $Layout.ProgramDir
    dataDir = $Layout.DataDir
    release = $Release
    savedAt = (Get-Date).ToUniversalTime().ToString('o')
  }
  if (-not (Test-Path $script:Ai17zSetupHome)) { New-Item -ItemType Directory -Path $script:Ai17zSetupHome -Force | Out-Null }
  Set-Ai17zText $script:Ai17zStatePath ($state | ConvertTo-Json -Depth 4)
  Write-Ai17zLog ('resume note saved at stage ' + $Stage)
}

function Read-Ai17zResume {
  if (-not (Test-Path $script:Ai17zStatePath)) { return $null }
  try { return (Get-Content -Raw -LiteralPath $script:Ai17zStatePath | ConvertFrom-Json) } catch { return $null }
}

function Clear-Ai17zResume {
  # Removed the moment it is not needed. A setup that leaves a shortcut and a
  # note behind after it has finished looks like something that wants to run
  # again, and nothing here does.
  try { Remove-Item -LiteralPath $script:Ai17zStatePath -Force -ErrorAction SilentlyContinue } catch { }
  try { Remove-Item -LiteralPath (Join-Path (Get-Ai17zStartMenuRoot) 'Continue AI17Z Setup.lnk') -Force -ErrorAction SilentlyContinue } catch { }
}

function Get-Ai17zStartMenuRoot {
  return (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs')
}

<#
  A text file, with no byte-order mark on the front of it.

  Windows PowerShell's `Set-Content -Encoding utf8` writes one. Three bytes
  nobody sees, and then:

    data-location.txt   `set /p` in AI17Z.cmd reads the mark as part of the
                        path, so the launcher looks for the owner's data in a
                        directory whose name begins with an invisible
                        character. It finds nothing there and makes a new,
                        empty one -- which looks exactly like having lost every
                        agent, memory and credential
    INSTALL_INFO.json   PowerShell's own parser tolerates it and everything
                        else refuses the document. The verification harness
                        found this, having been handed one

  So the bytes are written explicitly, the way start-ai17z.ps1 already writes
  the environment file, and for the same reason.
#>
function Set-Ai17zText {
  param([string] $Path, [string] $Text)
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

function New-Ai17zShortcut {
  param([string] $Path, [string] $Target, [string] $Arguments = '', [string] $WorkingDirectory = '', [string] $Description = '', [string] $Icon = '')
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($Path)
  $link.TargetPath = $Target
  if ($Arguments) { $link.Arguments = $Arguments }
  if ($WorkingDirectory) { $link.WorkingDirectory = $WorkingDirectory }
  if ($Description) { $link.Description = $Description }
  if ($Icon -and (Test-Path $Icon)) { $link.IconLocation = $Icon }
  $link.Save()
}

<#
  The restart, asked for honestly and continued afterwards.

  A Start Menu shortcut and a note in one folder, both removed when setup
  finishes. Not a Run key and not a scheduled task: a setup program that adds
  itself to a machine's startup is indistinguishable from something that should
  not be there, and the one-restart case does not justify looking like it.
#>
function Request-Ai17zRestart {
  param([string] $Reason, [psobject] $Layout, [string] $Stage)
  Save-Ai17zResume $Stage $Layout

  $copy = Join-Path $script:Ai17zSetupHome 'Setup-AI17Z.ps1'
  try { Copy-Item -LiteralPath $script:Ai17zScriptPath -Destination $copy -Force } catch { $copy = $script:Ai17zScriptPath }

  $arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $copy + '" -Resume'
  if ($InstanceName -and $InstanceName -ne 'AI17Z') { $arguments += ' -InstanceName "' + $InstanceName + '"' }
  try {
    New-Ai17zShortcut `
      -Path (Join-Path (Get-Ai17zStartMenuRoot) 'Continue AI17Z Setup.lnk') `
      -Target (Get-Command powershell).Source `
      -Arguments $arguments `
      -WorkingDirectory $script:Ai17zSetupHome `
      -Description 'Finish setting up AI17Z after the restart'
  } catch {
    Write-Ai17zLog ('could not create the continue shortcut: ' + $_.Exception.Message) 'warn'
  }

  Show-Ai17zProgress -Force
  $script:Ai17zDrawnLines = 0
  Write-Host ''
  Write-Host '  Windows needs one restart' -ForegroundColor Yellow
  Write-Host ''
  Write-Host ('  ' + $Reason) -ForegroundColor Gray
  Write-Host '  Nothing of yours is affected. Your AI17Z setup is saved and picks up' -ForegroundColor Gray
  Write-Host '  where it left off.' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  After the restart, open "Continue AI17Z Setup" from the Start Menu.' -ForegroundColor White
  Write-Host ''

  if (Read-Ai17zYesNo 'Restart this PC now?' $false) {
    Write-Ai17zLog 'restarting at the owner request'
    Restart-Computer -Force
    exit 0
  }
  Write-Host ''
  Write-Host '  Restart when you are ready, then open "Continue AI17Z Setup".' -ForegroundColor Gray
  Write-Host ''
  Wait-Ai17zForKey
  exit 0
}

# ---------------------------------------------------------------------------
# Getting AI17Z itself
# ---------------------------------------------------------------------------

function Assert-Ai17zAllowedUrl {
  param([string] $Url)
  $uri = $null
  if (-not [Uri]::TryCreate($Url, [UriKind]::Absolute, [ref]$uri)) {
    Stop-Ai17z 'That download address is not a valid URL.' '' 'This is a fault in AI17Z Setup. Report it with the log below.'
  }
  if ($uri.Scheme -ne 'https') {
    Stop-Ai17z 'A download was about to be made over plain HTTP.' 'AI17Z Setup only ever downloads over HTTPS.' 'This is a fault in AI17Z Setup. Report it with the log below.'
  }
  if ($script:Ai17zSetup.AllowedHosts -notcontains $uri.Host) {
    Stop-Ai17z ('AI17Z Setup will not download from ' + $uri.Host + '.') ("It only downloads from AI17Z's own GitHub release.") 'Stop, and download AI17Z from https://github.com/ShiftAboveCtrl/ai17z/releases instead.'
  }
}

function Get-Ai17zHttpClient {
  # TLS 1.2 at least, and 1.3 where the framework has it. Windows PowerShell
  # defaults to whatever was current when it shipped.
  try {
    $protocols = [Net.SecurityProtocolType]::Tls12
    try { $protocols = $protocols -bor [Net.SecurityProtocolType]::Tls13 } catch { }
    [Net.ServicePointManager]::SecurityProtocol = $protocols
  } catch { }
  Add-Type -AssemblyName System.Net.Http | Out-Null
  $client = New-Object System.Net.Http.HttpClient
  $client.Timeout = [TimeSpan]::FromMinutes(20)
  $client.DefaultRequestHeaders.UserAgent.ParseAdd('AI17Z-Setup')
  $client.DefaultRequestHeaders.Accept.ParseAdd('application/octet-stream')
  return $client
}

function Get-Ai17zText {
  param([string] $Url, [string] $Accept = 'application/json')
  Assert-Ai17zAllowedUrl $Url
  Write-Ai17zLog ('GET ' + $Url)
  $client = Get-Ai17zHttpClient
  try {
    $client.DefaultRequestHeaders.Accept.Clear()
    $client.DefaultRequestHeaders.Accept.ParseAdd($Accept)
    $response = $client.GetAsync($Url).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      return [pscustomobject]@{ Ok = $false; Status = [int]$response.StatusCode; Body = '' }
    }
    return [pscustomobject]@{ Ok = $true; Status = [int]$response.StatusCode; Body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() }
  } finally {
    $client.Dispose()
  }
}

<#
  A file, with a size cap and a running total.

  The cap exists because the hash is checked after the bytes are on disk, and a
  wrong address should not be able to fill somebody's drive before anybody finds
  out it was wrong.
#>
function Save-Ai17zDownload {
  param([string] $Url, [string] $Destination, [string] $StepKey)
  Assert-Ai17zAllowedUrl $Url
  Write-Ai17zLog ('download ' + $Url + ' -> ' + $Destination)
  $client = Get-Ai17zHttpClient
  $stream = $null
  $file = $null
  try {
    $response = $client.GetAsync($Url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
      throw ('the download answered ' + [int]$response.StatusCode + ' ' + $response.ReasonPhrase)
    }
    $total = 0
    if ($response.Content.Headers.ContentLength) { $total = [long]$response.Content.Headers.ContentLength }
    if ($total -gt $script:Ai17zMaxDownloadBytes) {
      throw ('the download is ' + [int]($total / 1MB) + 'MB, which is larger than AI17Z Setup will accept')
    }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $file = [System.IO.File]::Create($Destination)
    $buffer = New-Object byte[] (1MB)
    $read = 0
    $done = 0L
    while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $file.Write($buffer, 0, $read)
      $done += $read
      if ($done -gt $script:Ai17zMaxDownloadBytes) {
        throw 'the download is larger than AI17Z Setup will accept'
      }
      if ($StepKey) {
        $detail = if ($total -gt 0) {
          '{0} of {1} MB' -f [int]($done / 1MB), [int]($total / 1MB)
        } else {
          '{0} MB' -f [int]($done / 1MB)
        }
        Set-Ai17zStep $StepKey 'active' $detail
      }
    }
    return $done
  } finally {
    if ($file) { $file.Dispose() }
    if ($stream) { $stream.Dispose() }
    $client.Dispose()
  }
}

function Get-Ai17zRelease {
  param([string] $Tag)
  $base = 'https://api.github.com/repos/' + $script:Ai17zSetup.Repository + '/releases'
  $url = if ($Tag) { $base + '/tags/' + $Tag } else { $base + '?per_page=10' }
  $answer = Get-Ai17zText $url 'application/vnd.github+json'
  if (-not $answer.Ok) {
    return [pscustomobject]@{ Ok = $false; Status = $answer.Status; Release = $null }
  }
  $parsed = $answer.Body | ConvertFrom-Json
  $release = $parsed
  if (-not $Tag) {
    # The newest published release, prereleases included: every AI17Z release so
    # far is one, and /releases/latest excludes them entirely.
    $release = @($parsed | Where-Object { -not $_.draft } | Select-Object -First 1)[0]
  }
  if (-not $release) { return [pscustomobject]@{ Ok = $false; Status = 404; Release = $null } }
  return [pscustomobject]@{ Ok = $true; Status = 200; Release = $release }
}

function Find-Ai17zAsset {
  param([psobject] $Release, [string] $Name)
  foreach ($asset in $Release.assets) {
    if ($asset.name -ieq $Name) { return $asset }
  }
  return $null
}

<#
  The hash the package is expected to have.

  Three sources, in the order they are worth anything:

    1. -ExpectedSha256, passed by the signed .exe and fixed at build time. A
       signature on the .exe is then a signature on the payload as well.
    2. SHA256SUMS.txt from the same release. This catches a truncated or
       corrupted download and a mismatched asset. It is published by the same
       release as the package, so it is not a defence against a release that has
       itself been tampered with -- and docs/SETUP_AUDIT.md says so plainly
       rather than implying otherwise.
    3. Nothing, which is refused.
#>
function Resolve-Ai17zExpectedHash {
  param([psobject] $Release, [string] $AssetName, [string] $Given)
  if ($Given) { return [pscustomobject]@{ Hash = $Given.Trim().ToLowerInvariant(); Source = 'pinned by the setup program' } }
  $sums = Find-Ai17zAsset $Release $script:Ai17zAssets.Checksums
  if (-not $sums) { return [pscustomobject]@{ Hash = ''; Source = '' } }
  $answer = Get-Ai17zText $sums.browser_download_url 'text/plain'
  if (-not $answer.Ok) { return [pscustomobject]@{ Hash = ''; Source = '' } }
  foreach ($line in ($answer.Body -split "`r?`n")) {
    $match = [regex]::Match($line.Trim(), '^([0-9a-fA-F]{64})\s+\*?(.+)$')
    if ($match.Success -and ($match.Groups[2].Value.Trim() -ieq $AssetName)) {
      return [pscustomobject]@{ Hash = $match.Groups[1].Value.ToLowerInvariant(); Source = ('SHA256SUMS.txt in release ' + $Release.tag_name) }
    }
  }
  return [pscustomobject]@{ Hash = ''; Source = '' }
}

<#
  Extract, entry by entry, refusing anything that would land outside.

  Nothing is written until every entry has been judged, so a hostile archive
  cannot get half of itself onto the disk before the entry that gives it away.
#>
function Expand-Ai17zPackage {
  param([string] $ZipPath, [string] $Destination, [string] $StepKey)
  Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $archive.Entries) {
      if (-not (Test-Ai17zArchiveEntryPath $entry.FullName)) {
        throw ('the package contains an entry that would be written outside the installation folder: ' + $entry.FullName)
      }
    }
    $root = [System.IO.Path]::GetFullPath($Destination)
    if (-not $root.EndsWith('\')) { $root += '\' }
    $count = 0
    $total = $archive.Entries.Count
    foreach ($entry in $archive.Entries) {
      $target = [System.IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
      # Belt and braces: the name passed the check above, and this proves the
      # resolved path as well, after Windows has had its say about it.
      if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('the package contains an entry that resolves outside the installation folder: ' + $entry.FullName)
      }
      if (-not $entry.Name) {
        if (-not (Test-Path $target)) { New-Item -ItemType Directory -Path $target -Force | Out-Null }
        continue
      }
      $parent = Split-Path -Parent $target
      if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
      $count += 1
      if ($StepKey -and ($count % 250 -eq 0)) {
        Set-Ai17zStep $StepKey 'active' ('{0} of {1} files' -f $count, $total)
      }
    }
    return $count
  } finally {
    $archive.Dispose()
  }
}

# ---------------------------------------------------------------------------
# Laying it down
# ---------------------------------------------------------------------------

<#
  The environment file: completed, never replaced.

  It holds the master key every stored provider credential is sealed with, the
  ports somebody chose and the name of this installation's Docker project. An
  update that rewrote it would be an update that lost every API key on the
  machine, so nothing here writes a key that is already there.
#>
function Initialize-Ai17zEnvironment {
  param([string] $DataDir, [psobject] $Ports)
  $envPath = Join-Path $DataDir '.env'
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $existing = ''
  if (Test-Path $envPath) { $existing = [System.IO.File]::ReadAllText($envPath, $utf8) }

  # [ \t] rather than \s in every pattern: .NET's \s matches a newline, so
  # "KEY=" at the end of one line runs on into the next and reads as a value
  # that is already set. That exact mistake made every fresh installation start
  # with no master key.
  $additions = ''
  if ($existing -notmatch '(?m)^[ \t]*AI17Z_WEB_PORT[ \t]*=[ \t]*\S') { $additions += ('AI17Z_WEB_PORT=' + $Ports.Web + "`r`n") }
  if ($existing -notmatch '(?m)^[ \t]*AI17Z_API_PORT[ \t]*=[ \t]*\S') { $additions += ('AI17Z_API_PORT=' + $Ports.Api + "`r`n") }
  if ($existing -notmatch '(?m)^[ \t]*POSTGRES_PORT[ \t]*=[ \t]*\S') { $additions += ('POSTGRES_PORT=' + $Ports.Db + "`r`n") }
  if ($additions) {
    if ($existing -and -not $existing.EndsWith("`n")) { $existing += "`r`n" }
    [System.IO.File]::WriteAllText($envPath, $existing + $additions, $utf8)
  }
  # The master key, the DATABASE_URL and the project name are start-ai17z.ps1's
  # to complete: it owns that merge, it is what runs on every start, and a
  # second implementation of it here is a second place for them to disagree.
  return $envPath
}

<#
  What an installation is, so the application can say how it was installed.

  Guessing from the shape of the directory is how the update screen came to
  offer `git pull` to somebody with no repository. This is the metadata the
  guess should have been.
#>
function Write-Ai17zInstallInfo {
  param(
    [psobject] $Layout,
    [string] $Version,
    [string] $Tag,
    [hashtable] $Dependencies
  )
  $info = [ordered]@{
    schema = 1
    channel = 'BOOTSTRAP'
    instance = $Layout.Instance
    programDir = $Layout.ProgramDir
    dataDir = $Layout.DataDir
    release = $Tag
    version = $Version
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
    setupScript = 'packaging\windows\Setup-AI17Z.ps1'
    # Whether AI17Z installed a dependency or found it. For the diagnostics, and
    # so nothing later assumes AI17Z owns Docker because it helped install it.
    dependencies = $Dependencies
  }
  Set-Ai17zText (Join-Path $Layout.ProgramDir 'INSTALL_INFO.json') (($info | ConvertTo-Json -Depth 5) + "`r`n")
}

function Write-Ai17zShortcuts {
  param([psobject] $Layout)
  $group = Join-Path (Get-Ai17zStartMenuRoot) $Layout.StartMenuGroup
  $icon = Join-Path $Layout.ProgramDir 'packaging\windows\ai17z.ico'
  $powershell = (Get-Command powershell).Source

  New-Ai17zShortcut -Path (Join-Path $group ($Layout.Instance + '.lnk')) `
    -Target (Join-Path $Layout.ProgramDir 'AI17Z.cmd') -WorkingDirectory $Layout.ProgramDir `
    -Description 'Start AI17Z and open it' -Icon $icon

  New-Ai17zShortcut -Path (Join-Path $group ($Layout.Instance + ' diagnostics.lnk')) `
    -Target $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + (Join-Path $Layout.ProgramDir 'doctor-ai17z.ps1') + '"') `
    -WorkingDirectory $Layout.ProgramDir -Description 'Check what AI17Z needs and what is missing' -Icon $icon

  New-Ai17zShortcut -Path (Join-Path $group ('Stop ' + $Layout.Instance + '.lnk')) `
    -Target $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Layout.ProgramDir 'stop-ai17z.ps1') + '"') `
    -WorkingDirectory $Layout.ProgramDir -Description 'Stop AI17Z' -Icon $icon

  New-Ai17zShortcut -Path (Join-Path $group ('Update ' + $Layout.Instance + '.lnk')) `
    -Target $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + (Join-Path $Layout.ProgramDir 'update-ai17z.ps1') + '"') `
    -WorkingDirectory $Layout.ProgramDir -Description 'Update AI17Z to the newest version' -Icon $icon

  New-Ai17zShortcut -Path (Join-Path $group ('Uninstall ' + $Layout.Instance + '.lnk')) `
    -Target $powershell -Arguments ('-NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Layout.ProgramDir 'packaging\windows\Uninstall-AI17Z.ps1') + '"') `
    -WorkingDirectory $Layout.ProgramDir -Description 'Remove AI17Z. Your data is kept unless you say otherwise' -Icon $icon
}

<#
  The Add/Remove Programs entry.

  Per user, under HKCU, because nothing here installs machine-wide. The key name
  carries the instance so a second installation appears as a second entry rather
  than taking over the first one's -- which is the same identity rule the
  program folder and the Start Menu group follow.
#>
function Write-Ai17zUninstallEntry {
  param([psobject] $Layout, [string] $Version, [string] $ReleaseName)
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $Layout.UninstallKey
  if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
  $uninstall = '"' + (Get-Command powershell).Source + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $Layout.ProgramDir 'packaging\windows\Uninstall-AI17Z.ps1') + '"'
  $values = @{
    DisplayName = ($Layout.Instance + ' ' + $ReleaseName)
    DisplayVersion = $Version
    Publisher = 'AI17Z'
    InstallLocation = ($Layout.ProgramDir + '\')
    UninstallString = $uninstall
    QuietUninstallString = ($uninstall + ' -Quiet')
    DisplayIcon = (Join-Path $Layout.ProgramDir 'packaging\windows\ai17z.ico')
    URLInfoAbout = ('https://github.com/' + $script:Ai17zSetup.Repository)
    NoModify = 1
    NoRepair = 1
    InstallDate = (Get-Date).ToString('yyyyMMdd')
  }
  foreach ($name in $values.Keys) {
    $type = if ($values[$name] -is [int]) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $key -Name $name -Value $values[$name] -PropertyType $type -Force | Out-Null
  }
  # And the list the installer and this script both read, so each can find
  # installations the other made.
  try {
    $installs = 'HKCU:\Software\AI17Z\Installs'
    if (-not (Test-Path $installs)) { New-Item -Path $installs -Force | Out-Null }
    New-ItemProperty -Path $installs -Name $Layout.ProgramDir -Value $Layout.ProgramDir -PropertyType String -Force | Out-Null
    if (-not (Test-Path 'HKCU:\Software\AI17Z')) { New-Item -Path 'HKCU:\Software\AI17Z' -Force | Out-Null }
    New-ItemProperty -Path 'HKCU:\Software\AI17Z' -Name 'DataDir' -Value $Layout.DataDir -PropertyType String -Force | Out-Null
  } catch {
    Write-Ai17zLog ('could not record the installation: ' + $_.Exception.Message) 'warn'
  }
}

<#
  Stop only this installation, and only the part that holds files open.

  The native worker holds esbuild under the program directory, so replacing the
  program with it running fails halfway. The containers hold the owner's
  database and an update has no reason to interrupt them.
#>
function Stop-Ai17zForUpdate {
  param([psobject] $Layout)
  $script = Join-Path $Layout.ProgramDir 'packaging\windows\Stop-ForUninstall.ps1'
  if (-not (Test-Path $script)) { return }
  Invoke-Ai17zNative 'powershell.exe' @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script, '-WorkerOnly') $Layout.ProgramDir | Out-Null
}

<#
  Replace the program, keep everything else.

  Only the directories the package owns are cleared, and the data directory is
  never one of them. `data-location.txt` is rewritten afterwards because an
  upgrade that lost it would send the next launch to the default data folder --
  an empty one, which looks exactly like having lost every agent.
#>
function Install-Ai17zProgram {
  param([string] $ZipPath, [psobject] $Layout, [string] $StepKey)
  $staging = $Layout.ProgramDir + '.incoming'
  if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Path $staging -Force | Out-Null

  # Unpacked beside the installation and moved into place, so a download that
  # turns out to be broken halfway through extraction has not touched the copy
  # that works.
  $files = Expand-Ai17zPackage $ZipPath $staging $StepKey
  Write-Ai17zLog ('extracted ' + $files + ' files')

  if (-not (Test-Path (Join-Path $staging 'package.json'))) {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    throw 'the package did not contain an AI17Z application'
  }

  if (Test-Path $Layout.ProgramDir) {
    # Everything the package replaces, removed first so a file that left the
    # project does not survive an update. Never the whole directory: the
    # uninstaller, the data pointer and anything an owner put there are not the
    # package's to delete.
    foreach ($name in @('apps', 'packages', 'node_modules', 'migrations', 'docker', 'docs', 'tools', 'scripts')) {
      $path = Join-Path $Layout.ProgramDir $name
      if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } else {
    New-Item -ItemType Directory -Path $Layout.ProgramDir -Force | Out-Null
  }

  Get-ChildItem -LiteralPath $staging -Force | ForEach-Object {
    $target = Join-Path $Layout.ProgramDir $_.Name
    if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
    Move-Item -LiteralPath $_.FullName -Destination $target -Force
  }
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue

  # The launcher lives at the root; the package carries it under packaging so
  # one copy ships and both installers put it in the same place.
  $cmd = Join-Path $Layout.ProgramDir 'packaging\windows\AI17Z.cmd'
  if (Test-Path $cmd) { Copy-Item -LiteralPath $cmd -Destination (Join-Path $Layout.ProgramDir 'AI17Z.cmd') -Force }

  Set-Ai17zText (Join-Path $Layout.ProgramDir 'data-location.txt') $Layout.DataDir
}

# ---------------------------------------------------------------------------
# Proving it works
# ---------------------------------------------------------------------------

function Get-Ai17zEnvValue {
  param([string] $EnvFile, [string] $Name, [string] $Fallback)
  if (Test-Path $EnvFile) {
    $value = ''
    foreach ($line in Get-Content -LiteralPath $EnvFile) {
      if ($line -match ('^\s*' + [regex]::Escape($Name) + '\s*=\s*(.+?)\s*$')) { $value = $matches[1] }
    }
    if ($value) { return $value }
  }
  return $Fallback
}

function Test-Ai17zHttp {
  param([string] $Url, [int] $TimeoutSeconds = 5)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSeconds -UseBasicParsing
    return [pscustomobject]@{ Ok = $true; Status = [int]$response.StatusCode; Body = ('' + $response.Content) }
  } catch {
    return [pscustomobject]@{ Ok = $false; Status = 0; Body = '' }
  }
}

<#
  Whether AI17Z actually works, rather than whether a port answered.

  `GET /` returning 200 is nginx handing over an index.html with an empty div in
  it, which is just as true of an interface that crashes the instant it runs.
  Beta 1.0.0 shipped exactly that. So this asks the API what it thinks of
  itself, checks the database is behind it, and checks the interface it serves
  is the application rather than a placeholder.
#>
function Test-Ai17zHealthy {
  param([int] $ApiPort, [int] $WebPort)
  $problems = @()
  $health = Test-Ai17zHttp ('http://localhost:' + $ApiPort + '/api/health') 10
  if (-not $health.Ok) {
    $problems += 'the API did not answer'
  } else {
    try {
      $parsed = $health.Body | ConvertFrom-Json
      $components = $parsed.data.components
      foreach ($component in $components) {
        if (-not $component.optional -and $component.status -ne 'healthy') {
          $problems += ($component.name + ' is ' + $component.status + ': ' + $component.detail)
        }
      }
      if (-not $components) { $problems += 'the API answered with no health of its own' }
    } catch {
      $problems += 'the API answered with something that is not its health'
    }
  }
  $web = Test-Ai17zHttp ('http://localhost:' + $WebPort + '/') 10
  if (-not $web.Ok) {
    $problems += 'the interface did not answer'
  } elseif ($web.Body -notmatch '<script' -or $web.Body.Length -lt 200) {
    # The page nginx serves has to carry the application, not an empty shell.
    $problems += 'the interface answered with a page that has no application in it'
  }
  return [pscustomobject]@{ Ok = ($problems.Count -eq 0); Problems = $problems }
}

# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

Initialize-Ai17zLog
$script:Ai17zGlyph = Get-Ai17zGlyphs (Test-Ai17zUnicodeConsole)
try {
  $script:Ai17zInteractive = ($Host.Name -eq 'ConsoleHost') -and -not [Console]::IsOutputRedirected
} catch {
  $script:Ai17zInteractive = $false
}

$layout = Get-Ai17zLayout $InstanceName $ProgramDir $DataDir $env:LOCALAPPDATA
if (-not (Test-Ai17zLayoutConsistent $InstanceName $layout.ProgramDir ([bool]$ProgramDir))) {
  Stop-Ai17z ('The name and the folder do not agree.') `
    ('Asked for the instance "' + $InstanceName + '" and would install into ' + $layout.ProgramDir + '.') `
    'This is a fault in AI17Z Setup. Report it with the log below rather than continuing.'
}

# An update has somewhere to update. Told apart from a first install rather than
# inferred, because the two differ in what they are allowed to assume: an update
# knows the data directory already holds a master key and a database, and a
# first install must not act as though it does.
if ($Update -and -not (Test-Path (Join-Path $layout.ProgramDir 'package.json'))) {
  Stop-Ai17z ('There is no AI17Z at ' + $layout.ProgramDir + ' to update.') `
    'Nothing was changed.' `
    'Run AI17Z Setup without -Update to install it, or pass -InstanceName for the copy you meant.'
}

# A resume note is read, never obeyed. Everything below re-probes the machine,
# so the note only says which instance was being set up and stops the second
# run asking the questions again.
if ($Resume) {
  $saved = Read-Ai17zResume
  if (Test-Ai17zResumeUsable $saved $layout.Instance (Get-Date)) {
    if ($saved.release -and -not $Release) { $Release = $saved.release }
    if ($saved.programDir) { $layout = Get-Ai17zLayout $saved.instance $saved.programDir $saved.dataDir $env:LOCALAPPDATA }
    Write-Ai17zLog ('resuming at stage ' + $saved.stage)
  } else {
    Write-Ai17zLog 'the resume note was stale or for something else; starting from the beginning' 'warn'
  }
}

Write-Host ''
Write-Host '  AI17Z Setup' -ForegroundColor White
if ($WhatIfOnly) { Write-Host '  Looking only. Nothing on this PC will be changed.' -ForegroundColor Yellow }
Write-Host ''

Add-Ai17zStep 'machine' 'Checking this PC'
Add-Ai17zStep 'wsl'     'Preparing Windows'
Add-Ai17zStep 'docker'  "AI17Z's local engine"
Add-Ai17zStep 'chrome'  'Browser'
Add-Ai17zStep 'node'    'Runtime'
Add-Ai17zStep 'app'     'Installing AI17Z'
Add-Ai17zStep 'start'   'Starting AI17Z'
Add-Ai17zStep 'verify'  'Checking it works'
Show-Ai17zProgress -Force

$dependencyOwnership = @{}

# -- 1. This PC --------------------------------------------------------------
Set-Ai17zStep 'machine' 'active' 'looking'
$machine = Measure-Ai17zMachine
$verdict = Get-Ai17zWindowsVerdict $machine.Build $machine.Is64Bit $machine.HypervisorPresent $machine.VirtualizationFirmwareEnabled
if ($verdict.State -ne 'OK') {
  Set-Ai17zStep 'machine' 'failed' $verdict.Message
  Stop-Ai17z $verdict.Message 'AI17Z cannot run on this PC as it is.' $verdict.Fix
}
Set-Ai17zStep 'machine' 'done' $verdict.Message

# -- 2. WSL 2 ----------------------------------------------------------------
Set-Ai17zStep 'wsl' 'active' 'looking'
$wsl = Measure-Ai17zWsl
$wslVerdict = Get-Ai17zWslVerdict $wsl.CommandPresent $wsl.Version $machine.RebootPending $wsl.FeatureEnabled
$dependencyOwnership['wsl'] = if ($wslVerdict.State -eq 'READY') { 'found' } else { 'missing' }

if ($wslVerdict.State -eq 'RESTART_FIRST' -and -not $SkipDependencies -and -not $WhatIfOnly) {
  Set-Ai17zStep 'wsl' 'action' $wslVerdict.Message
  Stop-Ai17z 'Windows needs a restart before WSL 2 can be set up.' `
    'Something else on this PC has already asked for one -- an update, or another program that has just been installed.' `
    $wslVerdict.Fix `
    'Nothing on this PC was changed.'
}

if ($wslVerdict.Action -ne 'NONE' -and $wslVerdict.Action -ne 'RESTART' -and -not $SkipDependencies) {
  if ($WhatIfOnly) {
    Set-Ai17zStep 'wsl' 'action' ('would run wsl --' + $wslVerdict.Action.ToLowerInvariant())
  } else {
    Set-Ai17zStep 'wsl' 'active' 'asking Windows to set up WSL 2'
    $task = if ($wslVerdict.Action -eq 'UPDATE') { 'update' } else { 'install' }
    $code = Invoke-Ai17zElevated 'wsl' $task 'Windows needs to turn on WSL 2, which is what Docker Desktop runs on.'
    if ($code -eq 1223) {
      Set-Ai17zStep 'wsl' 'action' 'not approved'
      Stop-Ai17z 'Setting up WSL 2 was not approved.' `
        'Docker Desktop runs on WSL 2, and AI17Z keeps your agents in a database Docker runs.' `
        'Run AI17Z Setup again and choose Yes at the Windows prompt.' `
        'Nothing on this PC was changed.'
    }
    $dependencyOwnership['wsl'] = 'installed by AI17Z'
    $wsl = Measure-Ai17zWsl
    $machine = Measure-Ai17zMachine
    $wslVerdict = Get-Ai17zWslVerdict $wsl.CommandPresent $wsl.Version $machine.RebootPending $wsl.FeatureEnabled
    if ($wslVerdict.State -ne 'READY') {
      # Windows enabled the features and wants a restart before they are usable.
      # Pretending setup can continue is how somebody ends up installing Docker
      # onto a platform that is not there yet.
      Set-Ai17zStep 'wsl' 'action' 'ready after a restart'
      Request-Ai17zRestart 'Windows has finished adding WSL 2, and it becomes usable after one restart.' $layout 'wsl'
    }
  }
}
if ($wslVerdict.State -eq 'READY') { Set-Ai17zStep 'wsl' 'done' $wslVerdict.Message }
elseif ($SkipDependencies) { Set-Ai17zStep 'wsl' 'action' ($wslVerdict.Message + ' (not installed, as asked)') }
elseif ($WhatIfOnly) { Set-Ai17zStep 'wsl' 'action' $wslVerdict.Message }

# -- 3. Docker Desktop -------------------------------------------------------
Set-Ai17zStep 'docker' 'active' 'looking'
$docker = Measure-Ai17zDocker
$dockerVerdict = Get-Ai17zDockerVerdict $docker.CliPresent $docker.DesktopInstalled $docker.DesktopRunning $docker.EngineAnswers $docker.OsType $machine.RebootPending
$dependencyOwnership['docker'] = if ($docker.DesktopInstalled) { 'found' } else { 'missing' }

if ($dockerVerdict.State -eq 'ABSENT' -and -not $SkipDependencies) {
  if ($WhatIfOnly) {
    Set-Ai17zStep 'docker' 'action' ('would install ' + $script:Ai17zSetup.Packages.docker.Id + ' through winget')
  } else {
    Set-Ai17zStep 'docker' 'active' 'installing Docker Desktop'
    $code = Invoke-Ai17zElevated 'packages' 'docker' 'Docker Desktop installs for everyone on this PC, which Windows requires approval for.'
    if ($code -eq 1223) {
      Stop-Ai17z 'Installing Docker Desktop was not approved.' `
        'AI17Z keeps your agents, memories and credentials in a database that Docker runs.' `
        ("Run AI17Z Setup again and choose Yes at the Windows prompt, or install Docker Desktop yourself from`n  " + $script:Ai17zSetup.Packages.docker.Page + "`nand run AI17Z Setup again.") `
        'Nothing on this PC was changed.'
    }
    $dependencyOwnership['docker'] = 'installed by AI17Z'
    $docker = Measure-Ai17zDocker
    $machine = Measure-Ai17zMachine
    $dockerVerdict = Get-Ai17zDockerVerdict $docker.CliPresent $docker.DesktopInstalled $docker.DesktopRunning $docker.EngineAnswers $docker.OsType $machine.RebootPending
    if ($dockerVerdict.State -eq 'ABSENT') {
      Stop-Ai17z 'Docker Desktop could not be installed.' `
        'Nothing else on this PC was changed.' `
        ("Install it yourself from`n  " + $script:Ai17zSetup.Packages.docker.Page + "`nthen run AI17Z Setup again -- it will pick up from here.")
    }
  }
}

if (-not $WhatIfOnly -and -not $SkipDependencies) {
  if ($dockerVerdict.State -eq 'NEEDS_RESTART') {
    Request-Ai17zRestart 'Docker Desktop has been installed and Windows wants one restart before it will run.' $layout 'docker'
  }

  if ($dockerVerdict.State -eq 'NOT_RUNNING' -and $docker.DesktopPath) {
    Set-Ai17zStep 'docker' 'active' 'starting Docker Desktop'
    try { Start-Process -FilePath $docker.DesktopPath | Out-Null } catch { Write-Ai17zLog ('could not start Docker Desktop: ' + $_.Exception.Message) 'warn' }
    Start-Sleep -Seconds 3
  }

  # Installed is not running, and running is not healthy. This is the wait that
  # the old "install Docker, then restart your PC and run the installer again"
  # advice existed instead of.
  #
  # Bounded, and then explained. Docker Desktop asks the person to accept its
  # own subscription agreement the first time it runs, and AI17Z does not answer
  # that for them -- so a wait that never ends is a wait that is hiding a
  # question somebody needs to see.
  if ($dockerVerdict.State -ne 'READY') {
    Set-Ai17zStep 'docker' 'active' 'waiting for the Docker engine'
    $ready = Wait-Ai17zUntil -TimeoutSeconds 240 -Condition {
      $probe = Measure-Ai17zDocker
      $script:Ai17zDockerProbe = $probe
      return ($probe.EngineAnswers -and ($probe.OsType -eq 'linux' -or -not $probe.OsType))
    }
    $docker = if ($script:Ai17zDockerProbe) { $script:Ai17zDockerProbe } else { Measure-Ai17zDocker }
    $dockerVerdict = Get-Ai17zDockerVerdict $docker.CliPresent $docker.DesktopInstalled $docker.DesktopRunning $docker.EngineAnswers $docker.OsType $machine.RebootPending
    if (-not $ready) {
      if ($dockerVerdict.State -eq 'WRONG_MODE') {
        Set-Ai17zStep 'docker' 'action' $dockerVerdict.Message
        Stop-Ai17z 'Docker is set to Windows containers.' $dockerVerdict.Message $dockerVerdict.Fix
      }
      Set-Ai17zStep 'docker' 'action' 'waiting for you'
      Stop-Ai17z 'Docker Desktop is not ready yet.' `
        ("It is installed, and its engine has not answered in four minutes.`nThe usual reason is that Docker Desktop is open and waiting for you to accept`nits own terms, which AI17Z does not answer on your behalf.") `
        ("Open Docker Desktop, finish whatever it is asking for, and wait until it says`nit is running. Then run AI17Z Setup again -- it continues from here and installs`nnothing twice.") `
        'Nothing of yours was changed.'
    }
  }
}

if ($dockerVerdict.State -eq 'READY') {
  Set-Ai17zStep 'docker' 'done' 'Docker engine is up'
} elseif ($WhatIfOnly -or $SkipDependencies) {
  Set-Ai17zStep 'docker' 'action' $dockerVerdict.Message
} else {
  Set-Ai17zStep 'docker' 'failed' $dockerVerdict.Message
  Stop-Ai17z 'The Docker engine is not answering.' $dockerVerdict.Message ('Open Docker Desktop and wait for it to say it is running, then run AI17Z Setup again.')
}

# -- 4. Chrome ---------------------------------------------------------------
Set-Ai17zStep 'chrome' 'active' 'looking'
$chrome = Measure-Ai17zChrome
$chromeVerdict = Get-Ai17zChromeVerdict $chrome.Path $chrome.ProductName $chrome.Version
$dependencyOwnership['chrome'] = if ($chromeVerdict.State -eq 'READY') { 'found' } else { 'missing' }
if ($chromeVerdict.Action -eq 'INSTALL' -and -not $SkipDependencies -and -not $WhatIfOnly) {
  Set-Ai17zStep 'chrome' 'active' 'installing Google Chrome'
  # Not elevated: Chrome installs per user, and asking for administrator rights
  # to do something that does not need them is how people learn to click through
  # prompts.
  $outcome = Install-Ai17zPackage 'chrome'
  $chrome = Measure-Ai17zChrome
  $chromeVerdict = Get-Ai17zChromeVerdict $chrome.Path $chrome.ProductName $chrome.Version
  if ($chromeVerdict.State -eq 'READY') { $dependencyOwnership['chrome'] = 'installed by AI17Z' }
  elseif (-not $outcome.Ok -and $outcome.Reason -eq 'NO_WINGET') { Write-Ai17zLog 'winget is not available on this machine' 'warn' }
}
if ($chromeVerdict.State -eq 'READY') {
  Set-Ai17zStep 'chrome' 'done' $chromeVerdict.Message
} else {
  # Not fatal. Everything except acting on X works without it, and saying so is
  # better than refusing to install over a browser somebody can add later.
  Set-Ai17zStep 'chrome' 'action' ($chromeVerdict.Message + ' -- connecting an X account needs it')
}

# -- 5. Node -----------------------------------------------------------------
Set-Ai17zStep 'node' 'active' 'looking'
$nodeMajor = Measure-Ai17zNode
$nodeVerdict = Get-Ai17zNodeVerdict $nodeMajor
$dependencyOwnership['node'] = if ($nodeVerdict.State -eq 'READY') { 'found' } else { 'missing' }
if ($nodeVerdict.Action -eq 'INSTALL' -and -not $SkipDependencies -and -not $WhatIfOnly) {
  Set-Ai17zStep 'node' 'active' 'installing Node.js'
  $outcome = Install-Ai17zPackage 'node'
  # A just-installed Node is not on this process's PATH: the installer changes
  # the machine's, and this process inherited its copy at launch. Rather than
  # tell somebody to open a new window, take the new value.
  try {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
  } catch { }
  $nodeMajor = Measure-Ai17zNode
  $nodeVerdict = Get-Ai17zNodeVerdict $nodeMajor
  if ($nodeVerdict.State -eq 'READY') { $dependencyOwnership['node'] = 'installed by AI17Z' }
}
if ($nodeVerdict.State -eq 'READY') {
  Set-Ai17zStep 'node' 'done' $nodeVerdict.Message
} elseif ($WhatIfOnly -or $SkipDependencies) {
  Set-Ai17zStep 'node' 'action' $nodeVerdict.Message
} else {
  Set-Ai17zStep 'node' 'failed' $nodeVerdict.Message
  Stop-Ai17z ('Node.js ' + $script:Ai17zSetup.MinimumNodeMajor + ' or newer is needed and could not be installed.') `
    'It runs the part of AI17Z that drives your browser.' `
    ("Install it from`n  " + $script:Ai17zSetup.Packages.node.Page + "`nthen run AI17Z Setup again.")
}

if ($WhatIfOnly) {
  # Which version this would be, asked for rather than left blank: "would
  # install AI17Z" is not an answer somebody deciding whether to update can use.
  # A read of the releases page changes nothing.
  $wouldBe = 'would install AI17Z'
  if ($LocalPackage) {
    $wouldBe = 'would install from ' + (Split-Path -Leaf $LocalPackage)
  } else {
    $preview = Get-Ai17zRelease $Release
    if ($preview.Ok) { $wouldBe = 'would install ' + $preview.Release.tag_name }
    else { $wouldBe = 'could not reach GitHub to see which version' }
  }
  Set-Ai17zStep 'app' 'action' $wouldBe
  Set-Ai17zStep 'start' 'action' 'would start it'
  Set-Ai17zStep 'verify' 'action' 'would check it works'
  Show-Ai17zProgress -Force
  Write-Ai17zSay 'Nothing was changed. Run without -WhatIfOnly to install.' 'Yellow'
  exit 0
}

# -- 6. AI17Z itself ---------------------------------------------------------
Set-Ai17zStep 'app' 'active' 'finding the release'

$tag = $Release
$version = ''
$zipPath = ''
$temporaryZip = ''

if ($LocalPackage) {
  if (-not (Test-Path $LocalPackage)) { Stop-Ai17z ('There is no package at ' + $LocalPackage + '.') '' 'Check the path and run AI17Z Setup again.' }
  $zipPath = (Resolve-Path $LocalPackage).Path
  $match = [regex]::Match((Split-Path -Leaf $zipPath), 'AI17Z-App-(.+)\.zip$')
  if ($match.Success) { $version = $match.Groups[1].Value }
  if (-not $tag) { $tag = if ($version) { 'v' + $version } else { 'local' } }

  # A hash given for a file already on disk is still checked. Nothing forces
  # one here -- an offline install from a file somebody downloaded themselves is
  # the case this exists for -- but a flag that is silently ignored in one of
  # the two paths is worse than not having it, because the one place it would
  # matter is the place somebody thought they were being careful.
  if ($ExpectedSha256) {
    Set-Ai17zStep 'app' 'active' 'checking the package'
    $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.Trim().ToLowerInvariant()) {
      Set-Ai17zStep 'app' 'failed' 'the package did not match its hash'
      Stop-Ai17z 'That package does not match the SHA-256 it was given.' `
        ("expected  " + $ExpectedSha256.Trim().ToLowerInvariant() + "`ngot       " + $actual + "`n`nNothing was installed.") `
        "Do not install that file. Download AI17Z again from`n  https://github.com/$($script:Ai17zSetup.Repository)/releases"
    }
    Write-Ai17zLog ('local package sha256 ' + $actual + ' matched the hash it was given')
  }
  Set-Ai17zStep 'app' 'active' 'using the package on disk'
} else {
  $found = Get-Ai17zRelease $tag
  if (-not $found.Ok) {
    Set-Ai17zStep 'app' 'failed' 'could not reach GitHub'
    Stop-Ai17z 'AI17Z could not be downloaded.' `
      ('GitHub answered ' + $found.Status + '.' + "`nNothing on this PC was changed.") `
      'Check your internet connection and run AI17Z Setup again.'
  }
  $release = $found.Release
  $tag = '' + $release.tag_name
  $version = $tag -replace '^v', ''
  $assetName = [string]::Format($script:Ai17zAssets.Package, $version)
  $asset = Find-Ai17zAsset $release $assetName
  if (-not $asset) {
    Set-Ai17zStep 'app' 'failed' ('release ' + $tag + ' has no package')
    Stop-Ai17z ('Release ' + $tag + ' does not contain ' + $assetName + '.') `
      'Nothing on this PC was changed.' `
      ("Download AI17Z from`n  https://github.com/" + $script:Ai17zSetup.Repository + '/releases')
  }

  $expected = Resolve-Ai17zExpectedHash $release $assetName $ExpectedSha256
  if (-not $expected.Hash) {
    Set-Ai17zStep 'app' 'failed' 'no published hash'
    Stop-Ai17z 'There is no published SHA-256 for this release.' `
      'AI17Z Setup will not install a package it cannot check.' `
      ("Download AI17Z from`n  https://github.com/" + $script:Ai17zSetup.Repository + '/releases')
  }

  $temporaryZip = Join-Path $script:Ai17zSetupHome $assetName
  Set-Ai17zStep 'app' 'active' 'downloading'
  try {
    Save-Ai17zDownload $asset.browser_download_url $temporaryZip 'app' | Out-Null
  } catch {
    Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
    Set-Ai17zStep 'app' 'failed' 'the download did not finish'
    Stop-Ai17z 'AI17Z could not be downloaded.' `
      ('Nothing on this PC was changed.' + "`n" + $_.Exception.Message) `
      'Check your internet connection and run AI17Z Setup again.'
  }

  Set-Ai17zStep 'app' 'active' 'checking the download'
  $actual = (Get-FileHash -LiteralPath $temporaryZip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected.Hash) {
    Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue
    Set-Ai17zStep 'app' 'failed' 'the download did not match its hash'
    # Fail closed, and say what it means rather than offering a way past it.
    Stop-Ai17z 'The download does not match its published SHA-256.' `
      ("expected  " + $expected.Hash + "`ngot       " + $actual + "`n`nThe file has been deleted and nothing was installed.") `
      "Do not try to install that file. Download AI17Z again from`n  https://github.com/$($script:Ai17zSetup.Repository)/releases`nand if it happens twice, stop and report it."
  }
  Write-Ai17zLog ('package sha256 ' + $actual + ' verified against ' + $expected.Source)
  $zipPath = $temporaryZip
}

Set-Ai17zStep 'app' 'active' 'installing'
$existingInstall = Test-Path (Join-Path $layout.ProgramDir 'package.json')
if ($existingInstall) { Stop-Ai17zForUpdate $layout }

foreach ($directory in @($layout.DataDir, (Join-Path $layout.DataDir 'storage'), (Join-Path $layout.DataDir 'browser-profiles'))) {
  if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
}

# Ports are chosen once, for an installation that has never run. One that has an
# .env keeps whatever is in it, because a port is where its database is.
$envPath = Join-Path $layout.DataDir '.env'
$ports = Select-Ai17zPorts -IsTaken { param($p) Test-Ai17zPortTaken $p }
if (Test-Path $envPath) {
  $ports = [pscustomobject]@{
    Web = [int](Get-Ai17zEnvValue $envPath 'AI17Z_WEB_PORT' $ports.Web)
    Api = [int](Get-Ai17zEnvValue $envPath 'AI17Z_API_PORT' $ports.Api)
    Db  = [int](Get-Ai17zEnvValue $envPath 'POSTGRES_PORT' $ports.Db)
  }
}

try {
  Install-Ai17zProgram $zipPath $layout 'app'
} catch {
  Set-Ai17zStep 'app' 'failed' 'could not be installed'
  Stop-Ai17z 'AI17Z could not be installed.' `
    ($_.Exception.Message + "`nYour existing data was not touched.") `
    'Run AI17Z Setup again. If it happens twice, report it with the log below.'
} finally {
  if ($temporaryZip -and (Test-Path $temporaryZip)) { Remove-Item -LiteralPath $temporaryZip -Force -ErrorAction SilentlyContinue }
}

Initialize-Ai17zEnvironment $layout.DataDir $ports | Out-Null
if (-not $version) {
  try { $version = (Get-Content -Raw (Join-Path $layout.ProgramDir 'BUILD_INFO.json') | ConvertFrom-Json).version } catch { $version = '' }
}
$displayName = $version
try {
  $stamped = (Get-Content -Raw (Join-Path $layout.ProgramDir 'BUILD_INFO.json') | ConvertFrom-Json).name
  if ($stamped) { $displayName = $stamped -replace '^AI17Z ', '' }
} catch { }

Write-Ai17zInstallInfo $layout $version $tag $dependencyOwnership
try { Write-Ai17zShortcuts $layout } catch { Write-Ai17zLog ('shortcuts: ' + $_.Exception.Message) 'warn' }
try { Write-Ai17zUninstallEntry $layout $version $displayName } catch { Write-Ai17zLog ('uninstall entry: ' + $_.Exception.Message) 'warn' }
$installedDetail = 'installed'
if ($version) { $installedDetail = 'version ' + $version }
Set-Ai17zStep 'app' 'done' $installedDetail

# -- 7. Start ----------------------------------------------------------------
if ($NoStart) {
  Set-Ai17zStep 'start' 'action' 'not started, as asked'
  Set-Ai17zStep 'verify' 'action' 'not checked'
  Clear-Ai17zResume
  Write-Ai17zSay ('AI17Z is installed at ' + $layout.ProgramDir + "`nStart it from the Start Menu, or run AI17Z.cmd in that folder.") 'Green'
  exit 0
}

Set-Ai17zStep 'start' 'active' 'starting'

# The first start builds three images from source, applies every migration and
# waits for the API. It is the long step -- minutes, on a machine that has never
# run it -- so it is watched rather than waited on, and the row says which part
# of it is happening in words somebody who has never heard of a container can
# read.
$whatStartIsDoing = {
  param([string] $Line)
  if ($Line -match 'Building images') { return 'building AI17Z (a few minutes, the first time only)' }
  if ($Line -match 'Images are up to date') { return 'AI17Z is already built' }
  if ($Line -match 'Starting Postgres') { return 'starting AI17Z' }
  if ($Line -match 'Applying migrations') { return 'setting up the database' }
  if ($Line -match 'Waiting for the API') { return 'waiting for AI17Z to answer' }
  if ($Line -match 'native worker') { return 'starting the part that drives your browser' }
  return ''
}

$start = Invoke-Ai17zWatched `
  -Exe 'powershell.exe' `
  -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $layout.ProgramDir 'start-ai17z.ps1')) `
  -WorkingDirectory $layout.ProgramDir `
  -StepKey 'start' `
  -Summarise $whatStartIsDoing

if ($start.TimedOut) {
  Set-Ai17zStep 'start' 'failed' 'took more than an hour'
  Stop-Ai17z 'AI17Z is taking longer to start than anything should.' `
    ("It has been an hour. Nothing has been lost and it may still be working.`nThe usual cause is Docker being unable to download what it builds from.") `
    ('Look at Docker Desktop, then open "' + $layout.Instance + ' diagnostics" from the Start Menu.')
}
if ($start.Code -ne 0) {
  Set-Ai17zStep 'start' 'failed' 'did not start'
  Stop-Ai17z 'AI17Z was installed but did not start.' `
    ("Your data is where it was and nothing was lost.`nThe last lines of the start are in the log below.") `
    ('Open "' + $layout.Instance + ' diagnostics" from the Start Menu, which says what is missing.')
}
Set-Ai17zStep 'start' 'done' 'running'

# -- 8. Prove it -------------------------------------------------------------
Set-Ai17zStep 'verify' 'active' 'asking AI17Z how it is'
$apiPort = [int](Get-Ai17zEnvValue $envPath 'AI17Z_API_PORT' $ports.Api)
$webPort = [int](Get-Ai17zEnvValue $envPath 'AI17Z_WEB_PORT' $ports.Web)
$healthy = $null
$ok = Wait-Ai17zUntil -TimeoutSeconds 180 -Condition {
  $script:Ai17zHealth = Test-Ai17zHealthy $apiPort $webPort
  return $script:Ai17zHealth.Ok
}
$healthy = $script:Ai17zHealth
if (-not $ok) {
  Set-Ai17zStep 'verify' 'failed' 'not everything is working'
  $detail = ''
  if ($healthy) { $detail = ($healthy.Problems -join "`n") }
  Stop-Ai17z 'AI17Z started but is not fully working yet.' `
    ($detail + "`n`nNothing of yours was lost. Everything installed is still installed.") `
    ('Open "' + $layout.Instance + ' diagnostics" from the Start Menu, or try again in a minute: the first start compiles a good deal.')
}
Set-Ai17zStep 'verify' 'done' 'everything answered'
Clear-Ai17zResume
Show-Ai17zProgress -Force

$url = 'http://localhost:' + $webPort
Write-Host ''
Write-Host ('  AI17Z ' + $displayName + ' is ready.') -ForegroundColor Green
Write-Host ''
Write-Host ('  Open      ' + $url) -ForegroundColor White
Write-Host ('  Your data ' + $layout.DataDir) -ForegroundColor Gray
Write-Host ('  Log       ' + $script:Ai17zLogPath) -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Everything AI17Z knows stays on this computer.' -ForegroundColor DarkGray
Write-Host ''

if (-not $NoBrowser -and -not $env:AI17Z_NO_BROWSER) {
  try { Start-Process $url } catch { }
}
exit 0
