<#
.SYNOPSIS
  Starts AI17Z: the Docker stack, and a native worker that can drive real Chrome.

.DESCRIPTION
  The containerised worker has no browser and no display, so it handles jobs and
  leaves anything browser-backed alone. A second worker runs here on Windows,
  where Chrome actually is, and picks that work up. Both read the same database,
  so this is a division of labour rather than two systems.

  Run this from the repository root. It is safe to run again while things are
  already up: nothing is recreated that does not need to be.

.PARAMETER NoBrowser
  Skip the native worker. The stack still runs; browser-backed accounts will
  wait rather than fail, and the reason is shown in the UI.

.PARAMETER Rebuild
  Rebuild the images first. Needed after changing a Dockerfile or adding a
  workspace, not after an ordinary code change.
#>
[CmdletBinding()]
param(
  [switch] $NoBrowser,
  [switch] $Rebuild
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Where the environment file lives.
#
# An installed AI17Z keeps it with the owner's data, because the program
# directory is replaced on every upgrade and this file holds the master key
# every provider credential is sealed with.
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

# The paths AI17Z.cmd exports, for the scripts a shortcut runs directly.
#
# The Start Menu runs "AI17Z diagnostics" and "Stop AI17Z" through powershell.exe
# with a script path, so they inherit none of them -- and anything they call
# then falls back to a relative default that resolves against the program
# directory. The diagnostics did exactly that: its browser check created
# storage\browser-profiles beside the program, in the directory an upgrade
# replaces and the uninstaller empties. A signed-in browser profile written
# there would be lost on the next upgrade.
#
# Only for an installed copy, and only where nothing is set already: in a clone
# the data directory *is* the script directory, and the conventional ./storage
# layout is what a developer already has.
function Set-Ai17zDataPaths($EnvFile, $Root) {
  $dataDir = Split-Path -Parent $EnvFile
  if (-not $dataDir) { return }
  if ($dataDir.TrimEnd('\') -ieq $Root.TrimEnd('\')) { return }
  if (-not $env:AI17Z_STORAGE_DIR) { $env:AI17Z_STORAGE_DIR = Join-Path $dataDir 'storage' }
  if (-not $env:XBAM_STORAGE_DIR) { $env:XBAM_STORAGE_DIR = $env:AI17Z_STORAGE_DIR }
  if (-not $env:AI17Z_BROWSER_PROFILE_DIR) { $env:AI17Z_BROWSER_PROFILE_DIR = Join-Path $dataDir 'browser-profiles' }
  if (-not $env:XBAM_BROWSER_PROFILE_DIR) { $env:XBAM_BROWSER_PROFILE_DIR = $env:AI17Z_BROWSER_PROFILE_DIR }
}

$EnvFile = Resolve-Ai17zEnvFile $PSScriptRoot
Set-Ai17zDataPaths $EnvFile $PSScriptRoot

# The native worker's log and pid, beside the owner's data rather than beside
# the program.
#
# They were under the program directory, which is replaced on every upgrade and
# emptied by the uninstaller -- so the log somebody was reading to find out why
# their worker died went with it, and a file left open there was what stopped
# the directory being removed at all.
#
# Worse, `Stop-ForUninstall.ps1` has always looked for the pid under the *data*
# directory. The two never agreed, so an uninstall never once found the worker
# it was trying to stop.
#
# Derived from the environment file, which is already the one thing that knows
# which of the two directories this installation keeps its data in.
$StorageDir = Join-Path (Split-Path -Parent $EnvFile) 'storage'
$WorkerLog = Join-Path $StorageDir 'native-worker.log'
$PidFile   = Join-Path $StorageDir 'native-worker.pid'

# docker compose reads .env from the compose file's directory unless told
# otherwise, so every compose call has to carry this. Without it the containers
# would get a different configuration from the rest of the application, and the
# ports the installer wrote would apply to half the system.
$ComposeEnv = @('--env-file', $EnvFile)

# Docker writes its progress to stderr. Under Windows PowerShell with
# ErrorActionPreference = Stop, that is promoted to a terminating error even
# when the command succeeded, so native commands are run with the preference
# relaxed and judged by their exit code instead.
function Invoke-Native {
  param([Parameter(Mandatory)] [string] $Exe, [string[]] $Arguments = @(), [string] $FailureMessage)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
  } finally {
    $ErrorActionPreference = $previous
  }
  if ($LASTEXITCODE -ne 0 -and $FailureMessage) { throw $FailureMessage }
  return $LASTEXITCODE
}

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Done($Message) { Write-Host "  $Message" -ForegroundColor Green }
function Write-Warn($Message) { Write-Host "  $Message" -ForegroundColor Yellow }

# Something the owner can fix, said plainly and then stopped.
#
# `throw` prints the message under a CategoryInfo block, a FullyQualifiedErrorId
# and the source line that raised it. That is right for a bug and wrong for
# "Docker is not running", which is not a fault -- it is a thing to go and do.
# The message was already clear; it was buried under a stack trace.
function Stop-WithReason($Message, $Fix) {
  Write-Host ''
  Write-Host "  $Message" -ForegroundColor Red
  if ($Fix) { Write-Host "  $Fix" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'AI17Z' -ForegroundColor White
Write-Host ''

# -- Prerequisites -----------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-WithReason 'Docker is not on PATH.' 'Install Docker Desktop, start it, then run this again.'
}
$ErrorActionPreference = 'Continue'
docker info *> $null
$dockerUp = $LASTEXITCODE -eq 0
$ErrorActionPreference = 'Stop'
if (-not $dockerUp) {
  Stop-WithReason 'Docker is installed but not running.' 'Start Docker Desktop, wait for the whale to settle, then run this again.'
}

# -- Configuration -----------------------------------------------------------
# Completed before it is checked. The installer writes the ports somebody chose
# into this file, so it exists long before it is usable, and the port check
# below used to run against whatever three lines were in it.

if (-not (Test-Path $EnvFile)) {
  # An older installation kept its environment file beside the program. Move it
  # rather than leaving two to diverge, and rather than generating a second
  # master key that cannot read the credentials sealed with the first.
  $legacy = Join-Path $PSScriptRoot '.env'
  if (($legacy -ne $EnvFile) -and (Test-Path $legacy)) {
    Write-Warn "Moving your existing .env to $EnvFile so an upgrade cannot replace it."
    $parent = Split-Path -Parent $EnvFile
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Move-Item -LiteralPath $legacy -Destination $EnvFile
  }
}

# Complete, not merely present.
#
# The check used to be "does the file exist", and the installer writes the
# ports somebody chose into that same file before this ever runs. So the file
# existed with three lines in it, this decided there was nothing to do, and the
# installation ran with no DATABASE_URL and no master key -- which fails much
# later and somewhere else, exactly the class of failure ensure-env.mjs was
# written to prevent.
#
# So every key the template defines is filled in from the template when it is
# missing, and anything already in the file is left exactly as it is.
$template = Join-Path $PSScriptRoot '.env.example'
if (-not (Test-Path $template)) {
  # This was the installed copy's first-run failure: the template was not in
  # the package, so the very first thing a new install did was crash naming a
  # file nobody could be expected to find.
  Stop-WithReason `
    'AI17Z has no .env.example to build its configuration from.' `
    "Expected the template at:`n    $template`n  This installation looks incomplete. Reinstalling AI17Z will restore it."
}

$utf8 = New-Object System.Text.UTF8Encoding($false)
$parent = Split-Path -Parent $EnvFile
if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }

$existing = ''
if (Test-Path $EnvFile) { $existing = [System.IO.File]::ReadAllText($EnvFile, $utf8) }

# Which keys the file already sets, so nothing already chosen is touched.
$have = @{}
foreach ($line in ($existing -split "`r?`n")) {
  if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { $have[$matches[1]] = $true }
}

# Whether this installation has ever had a database, asked before the merge
# fills the key in. Used further down to decide whether this copy can safely
# be given its own Docker project name.
$hadDatabaseUrl = $have.ContainsKey('DATABASE_URL')

# The port already chosen, which the template does not know about.
$chosenPort = ''
if ($existing -match '(?m)^[ \t]*POSTGRES_PORT[ \t]*=[ \t]*(\d+)') { $chosenPort = $matches[1] }

$added = @()
$additions = New-Object System.Text.StringBuilder
foreach ($line in ([System.IO.File]::ReadAllText($template, $utf8) -split "`r?`n")) {
  if ($line -notmatch '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=') { continue }
  $key = $matches[1]
  if ($have.ContainsKey($key)) { continue }
  # The template's DATABASE_URL carries the default port and the installer has
  # already written the one somebody picked, so copying the template line
  # verbatim leaves the two disagreeing -- and the check further down then
  # refuses to start, correctly, over a conflict this script had just created.
  # Only ever the port: everything else in that line is the template's.
  if (($key -eq 'DATABASE_URL') -and $chosenPort) {
    $line = [regex]::Replace($line, '(?<=@[^/@]*:)\d+(?=/)', $chosenPort)
  }
  [void]$additions.AppendLine($line)
  $added += $key
  $have[$key] = $true
}

if ($added.Count -gt 0) {
  if ($existing -and -not $existing.EndsWith("`n")) { $existing += "`n" }
  $existing = $existing + $additions.ToString()
  [System.IO.File]::WriteAllText($EnvFile, $existing, $utf8)
  Write-Warn "Filled in $($added.Count) missing setting(s) in $EnvFile."
}

# The master key seals every provider API key. Generating one here means a
# first run works; losing it later means those keys cannot be decrypted.
#
# From the cryptographic RNG rather than Get-Random, which is seeded and is not
# meant for anything that has to be unguessable.
# [ \t] rather than \s in every pattern here, because .NET's \s matches a
# newline. Written the obvious way, "KEY=" at the end of one line ran on into
# the first character of the next and the file looked like it already had a
# value. The template ships with AI17Z_MASTER_KEY empty, so that was every
# fresh installation: no key generated, and the first provider credential
# somebody stored failing much later with "AI17Z_MASTER_KEY is not set".
$current = [System.IO.File]::ReadAllText($EnvFile, $utf8)
if ($current -notmatch '(?m)^[ \t]*(AI17Z|XBAM)_MASTER_KEY[ \t]*=[ \t]*\S') {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = [Convert]::ToBase64String($bytes)

  # Read and write the bytes explicitly rather than through Get-Content and
  # Set-Content. On Windows PowerShell 5.1 those default to the system codepage
  # for reading and add a BOM when writing, which turns the template's box-
  # drawing comments into mojibake and puts three bytes in front of the first
  # line.
  if ($current -match '(?m)^[ \t]*AI17Z_MASTER_KEY[ \t]*=') {
    $current = [regex]::Replace($current, '(?m)^[ \t]*AI17Z_MASTER_KEY[ \t]*=.*$', "AI17Z_MASTER_KEY=$key")
  } else {
    if ($current -and -not $current.EndsWith("`n")) { $current += "`n" }
    $current += "AI17Z_MASTER_KEY=$key`n"
  }
  [System.IO.File]::WriteAllText($EnvFile, $current, $utf8)
  Write-Warn "A master key was written to $EnvFile. Back that file up: without it, stored API keys are unreadable."
}

# One installation, one Docker project.
#
# The project name is what Docker derives container and volume names from, and
# it defaulted to `xbam` in every copy. So an installed AI17Z and a developer's
# checkout on the same machine were the same project: `docker compose up` from
# one adopted the other's containers, republished them on its own ports, and
# ran both against a single database volume. Nothing warned about it, because
# from Docker's side that is an ordinary recreate.
#
# An installed copy therefore names its project after its own data directory.
#
# Written only when this installation has never had a database -- the
# DATABASE_URL that was missing above is what says so -- because renaming the
# project of a working installation points it at an empty volume, and an
# installation that comes up as if it were new looks exactly like one that lost
# everything.
$dataDir = Split-Path -Parent $EnvFile
if ((-not $hadDatabaseUrl) -and $dataDir -and ($dataDir.TrimEnd('\') -ine $PSScriptRoot.TrimEnd('\'))) {
  $current = [System.IO.File]::ReadAllText($EnvFile, $utf8)
  if ($current -notmatch '(?m)^[ \t]*AI17Z_INSTANCE[ \t]*=[ \t]*\S') {
    # Unique per installation, and recognisable.
    #
    # The folder's name alone is neither. Somebody who picks their own data
    # folder usually calls it "data", so two installations that both did shared
    # a project again -- which is the entire thing this exists to prevent. The
    # verification harness hit exactly that on its second run, having installed
    # to two different directories that both ended in \data.
    #
    # So the name carries a short digest of the full path. The folder name is
    # kept in front of it because `docker ps` is read by people: four containers
    # called `data-api-1` and `data-web-1` said nothing about whose they were.
    $leaf = [regex]::Replace((Split-Path -Leaf $dataDir).ToLowerInvariant(), '[^a-z0-9_-]', '-').Trim('-', '_')

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
      # Case-insensitively, because Windows paths are, and the same directory
      # spelled two ways is one installation.
      $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($dataDir.TrimEnd('\').ToLowerInvariant()))
    } finally {
      $sha.Dispose()
    }
    $digest = ([BitConverter]::ToString($bytes) -replace '-', '').Substring(0, 6).ToLowerInvariant()

    if ($leaf -and $leaf -notlike 'ai17z*') { $instance = "ai17z-$leaf-$digest" }
    else { $instance = "ai17z-$digest" }
    if ($current -and -not $current.EndsWith("`n")) { $current += "`n" }
    $current += "AI17Z_INSTANCE=$instance`n"
    [System.IO.File]::WriteAllText($EnvFile, $current, $utf8)
    Write-Warn "Docker project name: $instance. This copy of AI17Z cannot share containers with another one."
  }
}

# -- Ports -------------------------------------------------------------------
# Checked before Docker is asked to bind them, because the alternative is
# "Bind for 127.0.0.1:55433 failed: port is already allocated" from a daemon,
# which tells somebody running a second installation nothing they can act on.
function Get-EnvPort($Key, $Default) {
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
      if ($line -match "^\s*$([regex]::Escape($Key))\s*=\s*(.+)$") { $value = $matches[1].Trim() }
    }
  }
  if ($value) { return $value }
  return $Default
}

function Test-PortTaken($Port) {
  return [bool](Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue)
}

$ourContainers = @()
try { $ourContainers = @(docker compose @ComposeEnv ps --format '{{.Name}}' 2>$null) } catch { }
$alreadyOurs = $ourContainers.Count -gt 0

# Whose containers those are.
#
# `docker compose ps` matches on the project name and nothing else, so
# containers a different directory created answer to this one as readily as its
# own. That is how an installed copy came to adopt a developer checkout's
# database: same default project name, different directory, no complaint from
# anybody -- and because the containers looked like this copy's own, the port
# check below was skipped as well, so the one thing that would have noticed the
# ports moving was the one thing that never ran.
#
# Said plainly and stopped, rather than taking them over: recreating another
# copy's containers on this copy's ports is not something to do by accident.
if ($alreadyOurs) {
  $project = Get-EnvPort 'AI17Z_INSTANCE' 'xbam'
  $startedIn = ''
  try {
    # `{{json .Config.Labels}}` rather than `{{index .Config.Labels "..."}}`,
    # because a double quote inside a native command's argument does not
    # survive Windows PowerShell's argument passing: docker received a broken
    # template, printed an empty line, and the guard concluded the containers
    # were this copy's own. Whichever way that goes it is silent, which is the
    # worst property a check like this can have.
    $labels = docker inspect $ourContainers[0] --format '{{json .Config.Labels}}' 2>$null | Select-Object -First 1
    if ($labels) { $startedIn = ($labels | ConvertFrom-Json).'com.docker.compose.project.working_dir' }
  } catch { }
  if ($startedIn -and ($startedIn.Trim().TrimEnd('\') -ine $PSScriptRoot.TrimEnd('\'))) {
    Stop-WithReason `
      "Another copy of AI17Z is already running as Docker project '$project'." `
      ("Its containers were started from:`n    $($startedIn.Trim())`n  This copy is at:`n    $PSScriptRoot`n`n" +
       "  Starting here would take those containers over and republish them on this copy's`n" +
       "  ports, with both copies sharing one database.`n`n" +
       "  Either stop the other copy, or give this one its own name by adding a line to`n    $EnvFile`n    AI17Z_INSTANCE=something-else`n" +
       "  A new name means a new, empty database: this copy's data lives under its old name.")
  }
}

if (-not $alreadyOurs) {
  $wanted = @(
    @{ Name = 'API';      Key = 'AI17Z_API_PORT';  Port = (Get-EnvPort 'AI17Z_API_PORT' '8787') },
    @{ Name = 'Web';      Key = 'AI17Z_WEB_PORT';  Port = (Get-EnvPort 'AI17Z_WEB_PORT' '8080') },
    @{ Name = 'Postgres'; Key = 'POSTGRES_PORT';   Port = (Get-EnvPort 'POSTGRES_PORT' '55432') }
  )
  $taken = @($wanted | Where-Object { Test-PortTaken $_.Port })
  if ($taken.Count -gt 0) {
    $lines = ($taken | ForEach-Object { "    $($_.Name) wants $($_.Port). Set $($_.Key) in .env to something else." }) -join "`n"
    $extra = "`n`n  If that something is another AI17Z, give this one its own name too:`n    AI17Z_INSTANCE=second"
    if ($taken | Where-Object { $_.Key -eq 'POSTGRES_PORT' }) {
      # Moving POSTGRES_PORT alone moves the published port and nothing else.
      # DATABASE_URL is what the migrator and the native worker dial, and it
      # carries its own port, so a second installation with only POSTGRES_PORT
      # changed runs its migrations against the first installation's database.
      $extra += "`n`n  Changing POSTGRES_PORT is only half of it: DATABASE_URL carries its own`n  port and is what migrations dial. Change both, to the same number."
    }
    Stop-WithReason "Something is already using $($taken.Count) of the ports AI17Z needs." "$lines$extra"
  }
}

# The two must agree, whether or not there was ever a conflict.
#
# `POSTGRES_PORT` publishes the container's port; `DATABASE_URL` is what the
# migrator and the native worker actually connect to. Nothing keeps them in
# step, so editing one is a silent way to point this installation's migrations
# at a different installation's database. Refused rather than guessed at: this
# script does not get to decide which of the two somebody meant.
$pgPort = Get-EnvPort 'POSTGRES_PORT' '55432'
$dbUrl = Get-EnvPort 'DATABASE_URL' ''
if ($dbUrl -and $dbUrl -match '^postgres(ql)?://[^/]*@(localhost|127\.0\.0\.1):(?<port>\d+)/') {
  if ($matches.port -ne $pgPort) {
    Stop-WithReason `
      "POSTGRES_PORT is $pgPort but DATABASE_URL points at port $($matches.port)." `
      "Migrations and the native worker use DATABASE_URL, so this would touch a database on $($matches.port) while the containers publish $pgPort.`n  Set both to the same port in .env."
  }
}

# -- The stack ---------------------------------------------------------------

# Which release this is, handed to the containers.
#
# A container has no BUILD_INFO.json and no repository, and package.json says
# 0.1.0 through every release candidate -- so without this the update check
# compares 0.1.0 against v0.1.0-rc.4 and cannot say which is newer. The packager
# writes the stamp; this is the only thing that can pass it on.
$stamp = Join-Path $PSScriptRoot 'BUILD_INFO.json'
if (Test-Path $stamp) {
  try {
    $version = (Get-Content -Raw $stamp | ConvertFrom-Json).version
    if ($version) { $env:AI17Z_VERSION = $version }
    # And that this is an installed copy rather than a checkout, which is what
    # decides whether the update screen offers an installer to run or
    # `update-ai17z.ps1`. The stamp exists beside an installed application and
    # nowhere else.
    $env:AI17Z_INSTALLED = '1'
  } catch {
    # A stamp that cannot be read is not worth stopping a start for: the
    # version is then reported as the package version, which is only wrong
    # about release candidates.
  }
}
# Run a native command for its output, and tolerate it not being there.
#
# Everything below runs on every start, so none of it may stop one. Under
# ErrorActionPreference = Stop a native command writing to stderr -- or not
# existing at all, which is git on a machine that only ever installed AI17Z --
# is promoted to a terminating error even when nothing is wrong.
function Invoke-Quiet {
  param([Parameter(Mandatory)] [string] $Exe, [string[]] $Arguments = @())
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $Exe @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($output | Out-String).Trim()
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $previous
  }
}

# What the code on disk is, for stamping into the images and comparing against
# what they already hold.
#
# The commit where there is a repository, the packager's stamp where there is
# not, and the newest source file as a last resort -- a developer editing a
# checkout without committing still has to get their changes rebuilt.
function Get-SourceStamp {
  $commit = Invoke-Quiet git @('-C', $PSScriptRoot, 'rev-parse', 'HEAD')
  if ($commit -and $commit.Length -ge 12) {
    # A working tree with edits in it is not the commit it sits on. Hashing
    # what differs means every save produces a new stamp, and a rebuild.
    $dirty = Invoke-Quiet git @('-C', $PSScriptRoot, 'status', '--porcelain')
    if ($dirty) {
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($dirty)
        $digest = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
      } finally {
        $sha.Dispose()
      }
      return "$($commit.Substring(0, 12))-dirty-$($digest.Substring(0, 12))"
    }
    return $commit.Substring(0, 12)
  }

  # An installed copy: no repository, but a stamp the packager wrote.
  $info = Join-Path $PSScriptRoot 'BUILD_INFO.json'
  if (Test-Path $info) {
    try {
      $parsed = Get-Content -Raw $info | ConvertFrom-Json
      if ($parsed.version -and $parsed.commit) { return "$($parsed.version)-$($parsed.commit)" }
      if ($parsed.version) { return $parsed.version }
    } catch {
      # Falls through to the file times, which are always available.
    }
  }

  # Neither. The newest source file is a poor identity and a correct one: it
  # moves whenever anything the images are built from is edited.
  $roots = @('apps', 'packages') | ForEach-Object { Join-Path $PSScriptRoot $_ } | Where-Object { Test-Path $_ }
  if ($roots) {
    $newest = Get-ChildItem -Path $roots -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch 'node_modules' } |
      Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if ($newest) { return "mtime-$($newest.LastWriteTimeUtc.Ticks)" }
  }
  return 'unknown'
}

# What an image says it was built from, or $null if it cannot say.
#
# `docker inspect --format '{{index .Config.Labels "x"}}'` cannot be used here:
# a double quote does not survive Windows PowerShell's native argument passing,
# so docker receives a broken template and prints an empty line -- which reads
# exactly like a missing label, and would mean never rebuilding.
# `{{json .Config.Labels}}` has no quotes in it.
function Get-ImageStamp {
  param([Parameter(Mandatory)] [string] $Image)
  $labels = Invoke-Quiet docker @('inspect', '--format', '{{json .Config.Labels}}', $Image)
  if (-not $labels -or $labels -eq 'null') { return $null }
  try {
    $parsed = $labels | ConvertFrom-Json
  } catch {
    return $null
  }
  if (-not $parsed) { return $null }
  return $parsed.'ai17z.built-from'
}

# Rebuild when the images are not the code that is installed.
#
# `docker compose up -d` builds only when an image is *missing*. It has no idea
# the source changed, so an installation upgraded over the top went on serving
# the images built for the version before it: somebody downloaded a fix, ran
# the installer, launched AI17Z, and saw exactly the same fault, with nothing
# anywhere saying why. The Docker project name is derived from the data
# directory, so it is stable across an upgrade and across a reinstall too --
# which is why uninstalling and installing again did not help either.
#
# Asked of the images rather than remembered in a file beside them. A file can
# claim an image that somebody has since deleted; an image cannot be wrong
# about what it holds.
$env:AI17Z_BUILD_STAMP = Get-SourceStamp
# The same value reaches the application as its commit, which is what the
# version screen and the worker heartbeat report.
$env:AI17Z_BUILD_COMMIT = $env:AI17Z_BUILD_STAMP

$composeProject = Get-EnvPort 'AI17Z_INSTANCE' 'xbam'
$needsBuild = [bool]$Rebuild
$why = 'asked for with -Rebuild'
if (-not $needsBuild) {
  foreach ($service in @('api', 'web', 'worker')) {
    $built = Get-ImageStamp "$composeProject-$service"
    if (-not $built) {
      $needsBuild = $true
      $why = "the $service image is missing, or does not say what it was built from"
      break
    }
    if ($built -ne $env:AI17Z_BUILD_STAMP) {
      $needsBuild = $true
      $why = "the $service image holds $built and this is $($env:AI17Z_BUILD_STAMP)"
      break
    }
  }
}

if ($needsBuild) {
  Write-Step "Building images: $why..."
  Invoke-Native docker (@('compose') + $ComposeEnv + @('build', 'api', 'web', 'worker')) 'The image build failed. The output above says why.' | Out-Null
} else {
  Write-Step "Images are up to date ($($env:AI17Z_BUILD_STAMP))."
}

Write-Step 'Starting Postgres, API, worker and web...'
Invoke-Native docker (@('compose') + $ComposeEnv + @('up', '-d')) 'docker compose could not start the stack. The output above says why.' | Out-Null

Write-Step 'Applying migrations...'
Invoke-Native npm @('run', 'migrate') 'Migrations failed. The database is unchanged; the output above says why.' | Out-Null

# Wait for the API rather than assuming: the first start pulls images and
# compiles, and "it is not up yet" reads exactly like "it is broken".
# The port the API is actually published on, not the one it listens on inside
# the container. Hardcoding 8787 here made an installation on any other port
# report 'The API did not answer within 90 seconds' while the API was up and
# healthy the whole time -- the same mistake the Open line above already had.
$apiPort = Get-EnvPort 'AI17Z_API_PORT' '8787'
Write-Step 'Waiting for the API...'
$deadline = (Get-Date).AddSeconds(90)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri "http://localhost:$apiPort/api/health/live" -TimeoutSec 2 -UseBasicParsing
    if ($response.StatusCode -eq 200) { $ready = $true; break }
  } catch {
    Start-Sleep -Milliseconds 800
  }
}
if (-not $ready) {
  Write-Warn 'The API did not answer within 90 seconds. Check: docker compose logs api'
} else {
  Write-Done 'API is up.'
}

# -- The native worker -------------------------------------------------------
if ($NoBrowser) {
  Write-Warn 'Skipping the native worker. Browser-backed accounts will wait for one.'
} else {
  $existing = if (Test-Path $PidFile) { Get-Content $PidFile | Select-Object -First 1 } else { $null }
  $alive = $false
  if ($existing) {
    try { $alive = $null -ne (Get-Process -Id ([int]$existing) -ErrorAction Stop) } catch { $alive = $false }
  }

  # A worker from an earlier cycle counts, whether or not the pid file knows
  # about it. Two workers means two of everything, including browsers.
  #
  # Whose worker it is matters, and the first version did not ask. It swept for
  # any node process running apps/worker, found one belonging to a completely
  # different checkout, announced "already running (pid )" -- empty, because the
  # pid file it was interpolating did not exist -- and left. The doctor then
  # said NOT RUNNING, because it looks at this installation's pid file. Two
  # scripts, one machine, opposite answers.
  $adopted = $null
  $foreign = $null
  if (-not $alive) {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -and $_.CommandLine -like '*apps?worker*' })
    foreach ($proc in $running) {
      if ($proc.CommandLine -like "*$PSScriptRoot*") { $adopted = $proc; break }
    }
    if (-not $adopted -and $running.Count -gt 0) { $foreign = $running[0] }
  }

  if ($adopted) {
    # Ours, started by an earlier run that did not get to write the file.
    Set-Content -Path $PidFile -Value $adopted.ProcessId
    $alive = $true
    Write-Done "Native worker already running (pid $($adopted.ProcessId))."
  } elseif ($foreign) {
    $alive = $true
    Write-Warn "Another AI17Z installation is already running a native worker (pid $($foreign.ProcessId))."
    Write-Warn 'Not starting a second one: two native workers on one machine means two browsers for the same account.'
    Write-Warn 'Stop the other installation first if you want this one to drive Chrome.'
  }

  if ($alive) {
    if (-not $adopted -and -not $foreign) { Write-Done "Native worker already running (pid $existing)." }
  } else {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      Write-Warn 'Node is not on PATH, so the native worker cannot start. Browser-backed accounts will wait.'
    } else {
      Write-Step 'Starting the native worker (this one can see your Chrome)...'
      New-Item -ItemType Directory -Force -Path (Split-Path $WorkerLog) | Out-Null

      # Only browser work. The containerised worker already takes everything
      # else, and two workers claiming the same jobs is just contention.
      $env:AI17Z_WORKER_ROLE = 'browser'
      # The pid matters. Two native workers on one machine sharing an id is two
      # processes with one identity, and every guarantee that hangs off the
      # worker id stops holding between them: `jobs.locked_by` says the job is
      # taken by "native-FRACTAL", the other native worker is also
      # "native-FRACTAL", and it takes it too. The account lease is deliberately
      # reentrant for the worker already holding it, so the lock that exists to
      # stop two browsers driving one account waves the second one through.
      #
      # It happens in the ordinary way: `.\start-ai17z.ps1` and then
      # `npm run dev`, which starts a worker of its own. The worker's own
      # default is hostname-pid and was already unique; this overrode it with
      # something that was not.
      $env:AI17Z_WORKER_ID = "native-$env:COMPUTERNAME-$PID"

      # On Windows npm is a shell script, not an executable, so Start-Process
      # cannot launch it directly: it has to be the .cmd shim.
      $npm = (Get-Command npm).Source
      if ($npm -notmatch '\.(cmd|bat|exe)$') {
        $shim = Join-Path (Split-Path $npm) 'npm.cmd'
        if (Test-Path $shim) { $npm = $shim }
      }

      # Supervised rather than bare. The native worker is the only process that
      # can drive a real browser, and started directly it had nothing watching
      # it: when it died the agent stopped, with no restart and, until health
      # learned about workers, no sign either.
      #
      # The supervisor restarts a worker that had been running and then failed,
      # and deliberately gives up on one that cannot start at all -- five
      # attempts in, the problem is the configuration and another thousand
      # identical failures say nothing the first one did not.
      $process = Start-Process -FilePath $npm -ArgumentList 'run', 'worker:supervised' `
        -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $WorkerLog -RedirectStandardError "$WorkerLog.err"
      $process.Id | Set-Content $PidFile -Encoding utf8
      Start-Sleep -Seconds 2

      if ($process.HasExited) {
        Write-Warn "The native worker exited immediately. See $WorkerLog.err"
      } else {
        Write-Done "Native worker running (pid $($process.Id)). Log: $WorkerLog"
      }
    }
  }
}

Write-Host ''
# The port this installation actually published, not the default. A second
# installation was told to open 8080 while serving on 8090, which is the first
# installation's address: the last line of a successful start pointed at
# somebody else's copy.
Write-Host '  Open  ' -NoNewline; Write-Host "http://localhost:$(Get-EnvPort 'AI17Z_WEB_PORT' '8080')" -ForegroundColor White
Write-Host '  Stop  ' -NoNewline; Write-Host '.\stop-ai17z.ps1' -ForegroundColor White
Write-Host ''
