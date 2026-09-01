<#
.SYNOPSIS
  Gets AI17Z onto this machine and running, in one command.

.DESCRIPTION
  Clones the repository (or downloads and extracts it, if git is not installed),
  then hands over to install-ai17z.ps1 and start-ai17z.ps1.

  Meant to be run this way:

    irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.ps1 | iex

  That pattern -- fetch a script and run it -- asks you to trust whatever the
  server sends. If you would rather look first, and you should, download it,
  read it, and run the file:

    irm https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.ps1 -OutFile bootstrap.ps1
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

# Replaced when the repository is published. Both point at the same repository:
# the first is what git clones, the second is what a browser downloads.
$RepoUrl = 'https://github.com/ShiftAboveCtrl/ai17z.git'
$ZipUrl  = 'https://github.com/ShiftAboveCtrl/ai17z/archive/refs/heads/main.zip'

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

# -- Fetch -------------------------------------------------------------------
# git if it is here, a zip if it is not. Nothing in AI17Z needs git afterwards,
# so somebody without it is not a second-class installation -- they just cannot
# pull updates with one command later.
if (Get-Command git -ErrorAction SilentlyContinue) {
  Write-Step "Cloning into $Directory..."
  if ($Ref) { git clone --quiet --branch $Ref $RepoUrl $Directory }
  else { git clone --quiet $RepoUrl $Directory }
  if ($LASTEXITCODE -ne 0) { Stop-WithReason 'The clone failed.' 'Check the URL above and your connection.' }
} else {
  Write-Step 'Git is not installed, downloading a zip instead...'
  $zip = Join-Path ([System.IO.Path]::GetTempPath()) "ai17z-$([guid]::NewGuid()).zip"
  $unpack = Join-Path ([System.IO.Path]::GetTempPath()) "ai17z-$([guid]::NewGuid())"
  try {
    Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $unpack -Force
    # GitHub wraps the tree in one folder named after the repository and branch.
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
