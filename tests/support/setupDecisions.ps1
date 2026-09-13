# Runs AI17Z Setup's own decision functions and reports what they answered.
#
# The installer is PowerShell, and the machine states worth testing -- WSL
# absent, WSL too old, Docker installed but not running, Docker running Windows
# containers, a restart pending, a package whose path escapes the installation
# directory -- are states nobody can produce on a test machine. They can be
# produced as arguments.
#
# So the shipped script is dot-sourced with -LoadOnly, which defines its
# functions and does nothing else, and this passes the arguments in and the
# answers back as JSON. What is under test is the code that ships, not a
# TypeScript transcription of it that can drift.
#
# ASCII only, like every other PowerShell file here.
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Script
)

$ErrorActionPreference = 'Stop'

. $Script -LoadOnly

# What may be called. An allow-list rather than "whatever the JSON says",
# because this reads from a pipe and dispatching arbitrary names off a pipe is
# the shape of a thing that should never be written even in a test.
$Allowed = @(
  'Get-Ai17zWindowsVerdict',
  'Get-Ai17zWslVerdict',
  'Get-Ai17zDockerVerdict',
  'Get-Ai17zNodeVerdict',
  'Get-Ai17zChromeVerdict',
  'Get-Ai17zLayout',
  'Test-Ai17zLayoutConsistent',
  'Test-Ai17zArchiveEntryPath',
  'Test-Ai17zVersionAtLeast',
  'Protect-Ai17zSecret',
  'Get-Ai17zGlyphs'
)

# Not $input: that is PowerShell's own pipeline enumerator, and assigning to it
# works until the day something reads it.
$raw = [Console]::In.ReadToEnd()
# Assigned first and wrapped second, in two statements rather than one.
# Windows PowerShell's ConvertFrom-Json writes an array as a single object, so
# `@($raw | ConvertFrom-Json)` produces one element containing the array -- and
# then `$case.fn` reads every fn at once through member enumeration, which looks
# like every case having been merged into one.
$parsed = $raw | ConvertFrom-Json
$cases = @($parsed)

$results = @()
foreach ($case in $cases) {
  $name = '' + $case.fn
  $arguments = @()
  if ($null -ne $case.args) { $arguments = @($case.args) }

  if ($name -eq '__ports') {
    # A scriptblock cannot cross JSON, so the one function that takes one gets
    # its predicate built here from the list of ports to treat as taken.
    $taken = @()
    if ($arguments.Count -gt 0 -and $null -ne $arguments[0]) { $taken = @($arguments[0]) }
    $predicate = { param($p) return ($taken -contains $p) }.GetNewClosure()
    $chosen = Select-Ai17zPorts -IsTaken $predicate
    $results += [pscustomobject]@{ ok = $true; value = $chosen }
    continue
  }

  if ($name -eq '__watched') {
    # The long step's progress reporting, run against a child that prints the
    # lines a real start prints. Everything else about it -- reading a file
    # another process still holds open, ending when the child does, carrying the
    # exit code back -- is mechanism that only running it can check.
    $script:Ai17zSetupHome = [System.IO.Path]::GetTempPath()
    # An ArrayList rather than an array: a closure captures the variable by
    # value, and `$said += x` inside one rebinds a copy that nobody out here
    # ever sees. A list is a reference, so adding to it is visible.
    $said = New-Object System.Collections.ArrayList
    $summarise = {
      param([string] $Line)
      if ($Line -match 'Building images') { [void]$said.Add('building'); return 'building' }
      if ($Line -match 'Waiting for the API') { [void]$said.Add('waiting'); return 'waiting' }
      return ''
    }.GetNewClosure()
    $child = '' + $arguments[0]
    # Whatever PowerShell is running this, rather than `powershell.exe`: on a
    # Linux runner that name does not exist, and the failure would be a test
    # about watching a child process that never started one.
    #
    # Not `$host`, which is PowerShell's own automatic variable for the host
    # object and cannot be assigned to.
    $shellPath = (Get-Process -Id $PID).Path
    if (-not $shellPath) { $shellPath = 'powershell.exe' }
    # The step key names a row nothing declared, so Set-Ai17zStep finds no such
    # row and returns without drawing anything -- which is what keeps this
    # output clean JSON, while the summariser is still called for every line.
    #
    # No comment between the continued lines below: a backtick continuation
    # followed by a comment ends the command, and the next line is then read as
    # a command of its own.
    $result = Invoke-Ai17zWatched -Exe $shellPath `
      -Arguments @('-NoProfile', '-NonInteractive', '-Command', $child) `
      -StepKey 'test' -Summarise $summarise -TimeoutSeconds ([int]$arguments[1])
    $results += [pscustomobject]@{
      ok = $true
      value = [pscustomobject]@{
        code = $result.Code
        timedOut = $result.TimedOut
        sawBuilding = ($result.Output -match 'Building images')
        sawLast = ($result.Output -match 'Waiting for the API')
        summarised = @($said)
      }
    }
    continue
  }

  if ($name -eq '__glyphs') {
    # Code points rather than characters. The marks a console draws are not
    # things that survive a pipe through a Windows code page, and what is being
    # tested is that the five states have five different shapes -- which is a
    # question about the code points and not about this machine's console.
    $set = Get-Ai17zGlyphs ([bool]$arguments[0])
    $points = @()
    foreach ($key in @('Done', 'Active', 'Pending', 'Action', 'Failed')) {
      $points += [int][char]('' + $set[$key])
    }
    $spinner = @()
    foreach ($mark in $set['Spinner']) { $spinner += [int][char]('' + $mark) }
    $results += [pscustomobject]@{ ok = $true; value = [pscustomobject]@{ marks = $points; spinner = $spinner } }
    continue
  }

  if ($name -eq '__resume') {
    # Two things JSON cannot carry either: a parsed object with a real
    # timestamp in it, and "now".
    $state = $null
    if ($arguments[0]) { $state = $arguments[0] | ConvertTo-Json -Depth 5 | ConvertFrom-Json }
    $instance = '' + $arguments[1]
    $ageHours = [double]$arguments[2]
    $now = Get-Date
    if ($state -and $state.savedAt -eq 'AGE') {
      $state.savedAt = $now.AddHours(-$ageHours).ToUniversalTime().ToString('o')
    }
    $results += [pscustomobject]@{ ok = $true; value = (Test-Ai17zResumeUsable $state $instance $now) }
    continue
  }

  if ($Allowed -notcontains $name) {
    $results += [pscustomobject]@{ ok = $false; error = ('not allowed: ' + $name) }
    continue
  }

  try {
    $value = & (Get-Command -Name $name -CommandType Function) @arguments
    $results += [pscustomobject]@{ ok = $true; value = $value }
  } catch {
    $results += [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
  }
}

# -InputObject with an explicit array, because piping one result to
# ConvertTo-Json produces an object rather than an array of one, and the caller
# would then be parsing a different shape depending on how many cases it asked
# about.
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
