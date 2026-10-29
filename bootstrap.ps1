<#
.SYNOPSIS
  Gets AI17Z onto this machine and running, in one command.

.DESCRIPTION
  Clones the repository (or downloads and extracts it, if git is not installed),
  then hands over to install-ai17z.ps1 and start-ai17z.ps1.

  Meant to be run this way:

    irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.ps1 | iex

  That pattern -- fetch a script and run it -- asks you to trust whatever the
  server sends. If you would rather look first, and you should, download it,
  read it, and run the file:

    irm https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.ps1 -OutFile bootstrap.ps1
    notepad bootstrap.ps1
    .\bootstrap.ps1

  It installs nothing on your system. It clones into a folder and runs the
  scripts already in the repository, which check for Docker, Node and Chrome and
  tell you where to get whatever is missing.

.PARAMETER Directory
  Where to put it. Defaults to .\ai17z under the current folder.

.PARAMETER Ref
  Branch or tag to check out. Defaults to the repository's default branch.

.PARAMETER NoStart
  Clone and set up, but do not start it.
#>
[CmdletBinding()]
param(
  [string] $Directory = 'ai17z',
  [string] $Ref = '',
  [switch] $NoStart
)

$ErrorActionPreference = 'Stop'

# GitHub first, then AI17Z Code, AI17Z's own server, which has the same
# history: the order every installer uses, so GitHub being down is never the
# end of an install. Each pair is what git clones and what a browser downloads.
$RepoUrls = @('https://github.com/ShiftAboveCtrl/ai17z.git', 'https://code.ai17z.io/AI17Z/ai17z.git')
$ZipUrls  = @('https://github.com/ShiftAboveCtrl/ai17z/archive/refs/heads/main.zip', 'https://code.ai17z.io/AI17Z/ai17z/archive/main.zip')

function Write-Step($Message) { Write-Host "  $Message" -ForegroundColor Cyan }
function Write-Done($Message) { Write-Host "  $Message" -ForegroundColor Green }
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

if (Test-Path $Directory) {
  $existing = Get-ChildItem -Force $Directory -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-WithReason "$Directory already exists and is not empty." 'Move it, delete it, or pass -Directory somewhere else.'
  }
}

# Checked here as well as in the installer, because this is where the directory
# is chosen and the clone has not happened yet. Cloning five megabytes into a
# folder that cannot host the project is a slower way to be told the same thing.
#
# On Windows the Desktop is inside OneDrive by default, so "run it from my
# Desktop" is both the natural thing to do and the thing that fails.
$target = [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $Directory))
$syncRoots = @(
  @{ Name = 'OneDrive'; Path = $env:OneDrive },
  @{ Name = 'OneDrive'; Path = $env:OneDriveCommercial },
  @{ Name = 'OneDrive'; Path = $env:OneDriveConsumer },
  @{ Name = 'Dropbox'; Path = (Join-Path $env:USERPROFILE 'Dropbox') },
  @{ Name = 'Google Drive'; Path = (Join-Path $env:USERPROFILE 'Google Drive') },
  @{ Name = 'iCloud Drive'; Path = (Join-Path $env:USERPROFILE 'iCloudDrive') }
) | Where-Object { $_.Path -and (Test-Path $_.Path) }

$inSync = $syncRoots | Where-Object { $target.StartsWith($_.Path, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
if ($inSync) {
  Stop-WithReason `
    "$target is inside $($inSync.Name)." `
    ("npm links each package into node_modules with a symlink, and a syncing folder refuses those while it reconciles.`n" +
     "  The install fails several minutes in with `"EBUSY: resource busy or locked, symlink`".`n`n" +
     "  Run this from somewhere that is not synced. For example:`n" +
     "    cd $env:USERPROFILE`n" +
     "    irm <this url> | iex")
}

# -- Fetch -------------------------------------------------------------------
# git if it is here, a zip if it is not. Nothing in AI17Z needs git afterwards,
# so somebody without it is not a second-class installation -- they just cannot
# pull updates with one command later.
if (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Step "Cloning into $Directory..."
  $cloned = $false
  foreach ($url in $RepoUrls) {
    if ($Ref) { git clone --quiet --branch $Ref $url $Directory }
    else { git clone --quiet $url $Directory }
    if ($LASTEXITCODE -eq 0) { $cloned = $true; break }
    # A half-made clone would make the next attempt refuse the directory.
    Remove-Item -LiteralPath $Directory -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  Could not clone from $url; trying the next copy." -ForegroundColor Yellow
  }
  if (-not $cloned) { Stop-WithReason 'The clone failed from GitHub and from AI17Z Code.' 'Check your connection and run this again.' }
} else {
  Write-Step 'Git is not installed, downloading a zip instead...'
  $zip = Join-Path ([System.IO.Path]::GetTempPath()) "ai17z-$([guid]::NewGuid()).zip"
  $unpack = Join-Path ([System.IO.Path]::GetTempPath()) "ai17z-$([guid]::NewGuid())"
  try {
    $fetched = $false
    foreach ($url in $ZipUrls) {
      try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing; $fetched = $true; break }
      catch { Write-Host "  Could not download $url; trying the next copy." -ForegroundColor Yellow }
    }
    if (-not $fetched) { Stop-WithReason 'The download failed from GitHub and from AI17Z Code.' 'Check your connection and run this again.' }
    Expand-Archive -Path $zip -DestinationPath $unpack -Force
    # The archive wraps the tree in one folder named after the project.
    $inner = Get-ChildItem -Directory $unpack | Select-Object -First 1
    if (-not $inner) { Stop-WithReason 'The download did not contain what was expected.' 'Try the git route, or clone by hand.' }
    Move-Item -Path $inner.FullName -Destination $Directory
  } finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
  }
}
Write-Done "Downloaded to $((Resolve-Path $Directory).Path)"

# -- Set up and run ----------------------------------------------------------
Set-Location $Directory
if ($NoStart) {
  & .\install-ai17z.ps1
} else {
  & .\install-ai17z.ps1 -Start
}
