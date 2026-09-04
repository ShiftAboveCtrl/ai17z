<#
.SYNOPSIS
  Updates this AI17Z installation to the latest published version.

.DESCRIPTION
  Stops the stack, fetches the new code, installs whatever it needs, applies
  pending migrations, and starts everything again.

  Your data is not touched. The database, stored API keys, browser profiles and
  agents live in named Docker volumes that this never removes. Your .env is
  never overwritten either, so ports, keys and settings survive.

  It refuses to run over uncommitted changes. If you have edited anything in the
  installation folder, that edit is yours and this will not throw it away: it
  says what is modified and stops.

  Migrations only ever move forward. There is no downgrade, so if you need to be
  able to go back, take a copy of the Docker volume first -- the -SkipStart
  switch exists so you can do that between the update and the restart.

.PARAMETER SkipStart
  Update, but leave everything stopped. Use when you want to look at something
  before it starts running again.

.PARAMETER Check
  Say what an update would bring and change nothing at all.
#>
[CmdletBinding()]
param(
  [switch] $SkipStart,
  [switch] $Check
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

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
function Stop-WithReason($Problem, $Remedy) {
  Write-Host ''
  Write-Host "  $Problem" -ForegroundColor Red
  if ($Remedy) { Write-Host "  $Remedy" -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

Write-Host ''
Write-Host 'AI17Z update' -ForegroundColor White
Write-Host ''

# -- Is this something that can be updated at all? ---------------------------
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Stop-WithReason 'Git is not installed, so there is nothing to update from.' 'Install Git, or download the new version and copy your .env into it.'
}
if (-not (Test-Path (Join-Path $PSScriptRoot '.git'))) {
  Stop-WithReason 'This folder is not a git checkout, so there is nothing to update from.' 'Download the new version and copy your .env and storage folder into it.'
}

# -- Anything of yours that an update would destroy --------------------------
#
# A pull over local edits either fails halfway or silently discards work.
# Neither is acceptable for a folder somebody has been editing, so this stops
# and says exactly which files, rather than guessing what was deliberate.
$dirty = @(git status --porcelain --untracked-files=no 2>$null)
if ($dirty.Count -gt 0) {
  Write-Host ''
  Write-Host '  These files have been changed here and are not committed:' -ForegroundColor Yellow
  foreach ($line in $dirty | Select-Object -First 20) { Write-Host "    $line" -ForegroundColor DarkGray }
  if ($dirty.Count -gt 20) { Write-Host "    ...and $($dirty.Count - 20) more" -ForegroundColor DarkGray }
  Stop-WithReason 'Updating would throw those changes away.' 'Commit them, or move them somewhere else, then run this again. Your .env is not in this list; it is never tracked and never touched.'
}

$branch = (git rev-parse --abbrev-ref HEAD 2>$null)
$before = (git rev-parse --short HEAD 2>$null)
Write-Step "Checking for a newer version on $branch..."
Invoke-Native git @('fetch', '--quiet', '--tags') 'Could not reach the remote. The output above says why.' | Out-Null

$behind = (git rev-list --count "HEAD..origin/$branch" 2>$null)
if (-not $behind) { $behind = '0' }

if ([int]$behind -eq 0) {
  Write-Done "Already up to date (at $before)."
  Write-Host ''
  exit 0
}

# Whether the update can actually be applied, asked before anything is
# stopped. The merge is fast-forward only, so a checkout carrying its own
# commits cannot take it -- and finding that out after stopping the stack
# leaves somebody with an installation that is down for a reason that was
# knowable a second earlier.
git merge-base --is-ancestor HEAD "origin/$branch" 2>$null
if ($LASTEXITCODE -ne 0) {
  $ahead = (git rev-list --count "origin/$branch..HEAD" 2>$null)
  Stop-WithReason "This checkout has $ahead commit(s) the published version does not, so it cannot simply take the update." 'Nothing was stopped and nothing was changed. Push or remove those commits, or move this folder aside and install fresh, keeping your .env.'
}

Write-Host ''
Write-Host "  $behind change(s) to apply:" -ForegroundColor White
Invoke-Native git @('--no-pager', 'log', '--oneline', '--no-decorate', "-15", "HEAD..origin/$branch") | Out-Null

# Migrations are the part that cannot be undone, so they are named before
# anything happens rather than mentioned afterwards.
# Additions only. `git diff --name-only HEAD..origin/branch` lists every file
# that DIFFERS, which includes migrations this checkout has and the remote
# does not -- so an installation slightly ahead of the remote was told three
# migrations were about to be applied when none were coming at all.
$newMigrations = @(git diff --name-only --diff-filter=A "HEAD..origin/$branch" -- migrations 2>$null)
if ($newMigrations.Count -gt 0) {
  Write-Host ''
  Write-Host "  $($newMigrations.Count) database migration(s) will be applied:" -ForegroundColor Yellow
  foreach ($file in $newMigrations) { Write-Host "    $(Split-Path $file -Leaf)" -ForegroundColor DarkGray }
  Write-Host '  Migrations only move forward. There is no downgrade.' -ForegroundColor Yellow
}

if ($Check) {
  Write-Host ''
  Write-Done 'Nothing was changed. Run without -Check to apply it.'
  Write-Host ''
  exit 0
}

# -- Apply it ----------------------------------------------------------------
Write-Host ''
Write-Step 'Stopping AI17Z...'
& (Join-Path $PSScriptRoot 'stop-ai17z.ps1') | Out-Null

Write-Step 'Fetching the new version...'
# Fast-forward only. A merge here would produce a state that is neither the old
# version nor the new one, in a folder nobody is going to debug.
Invoke-Native git @('merge', '--ff-only', "origin/$branch") 'Could not fast-forward to the new version. Your checkout has diverged from the remote; the output above says how.' | Out-Null
$after = (git rev-parse --short HEAD 2>$null)
Write-Done "Now at $after (was $before)."

Write-Step 'Installing dependencies...'
Invoke-Native npm @('install', '--no-audit', '--no-fund') 'npm install failed. The output above says why.' | Out-Null

Write-Step 'Rebuilding the containers...'
Invoke-Native docker @('compose', 'build', 'api', 'web', 'worker') 'The image build failed. The output above says why.' | Out-Null

if ($SkipStart) {
  Write-Host ''
  Write-Done "Updated to $after and left stopped, as asked."
  Write-Warn 'Migrations have NOT been applied yet. Starting will apply them.'
  Write-Host '  Start  .\start-ai17z.ps1' -ForegroundColor White
  Write-Host ''
  exit 0
}

# start-ai17z.ps1 runs the migrations itself and waits for the API, so this does
# not repeat either. One script owns starting.
Write-Step 'Starting AI17Z again...'
& (Join-Path $PSScriptRoot 'start-ai17z.ps1')

Write-Host ''
Write-Done "Updated from $before to $after."
Write-Host ''
