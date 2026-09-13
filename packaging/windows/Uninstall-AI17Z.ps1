<#
.SYNOPSIS
  Removes an AI17Z installed by AI17Z Setup.

.DESCRIPTION
  What the Add/Remove Programs entry and the "Uninstall AI17Z" shortcut run.

  Two decisions, kept apart on purpose, because they are not the same decision:

    the program   always goes
    your data     only if you say so, and the default answer is no

  The data directory holds your agents, their memories and relationships, your
  saved browser session, and the key your provider credentials are sealed with.
  Removing AI17Z and losing all of that should not be one click, and reinstalling
  after keeping it picks up exactly where you left off.

  It never removes Docker, Node.js, Chrome or WSL. AI17Z may have helped install
  them, which is not the same as owning them: something else on this machine may
  be using any of them, and a program that uninstalls a dependency it did not
  own is a program nobody installs twice.

  ASCII only, for the same reason as every other script here.

.PARAMETER Quiet
  Remove the program without asking anything. The data is kept, because an
  unanswered question about deleting data has exactly one safe answer.

.PARAMETER RemoveData
  Also delete the data directory. There is no undo.
#>
[CmdletBinding()]
param(
  [switch] $Quiet,
  [switch] $RemoveData
)

$ErrorActionPreference = 'Stop'

$ProgramDir = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Write-Line($Message, $Colour = 'Gray') { Write-Host ('  ' + $Message) -ForegroundColor $Colour }

# What this installation is, read from the file the setup program wrote rather
# than guessed at from where this script happens to be.
$instance = Split-Path -Leaf $ProgramDir
$dataDir = ''
$infoPath = Join-Path $ProgramDir 'INSTALL_INFO.json'
if (Test-Path $infoPath) {
  try {
    $info = Get-Content -Raw -LiteralPath $infoPath | ConvertFrom-Json
    if ($info.instance) { $instance = $info.instance }
    if ($info.dataDir) { $dataDir = $info.dataDir }
  } catch { }
}
if (-not $dataDir) {
  $pointer = Join-Path $ProgramDir 'data-location.txt'
  if (Test-Path $pointer) { $dataDir = (Get-Content -LiteralPath $pointer -First 1).Trim() }
}

Write-Host ''
Write-Host ('  Removing ' + $instance) -ForegroundColor White
Write-Host ''

# -- Stop it first -----------------------------------------------------------
#
# Removing files under a running worker leaves a half-deleted installation and
# a Chrome still holding a profile. The purpose-built script is used rather than
# stop-ai17z.ps1 because this can run with no console: that one is interactive
# in one branch and waits on Docker in others, and a prompt nobody can answer
# hangs for ever.
$stop = Join-Path $PSScriptRoot 'Stop-ForUninstall.ps1'
if (Test-Path $stop) {
  Write-Line 'Stopping AI17Z...'
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $stop | Out-Null
}

# -- The question, asked once ------------------------------------------------
$alsoData = [bool]$RemoveData
if (-not $Quiet -and -not $RemoveData -and $dataDir -and (Test-Path $dataDir)) {
  Write-Host ''
  Write-Host '  Remove your AI17Z data as well?' -ForegroundColor Yellow
  Write-Host ('    ' + $dataDir) -ForegroundColor Gray
  Write-Host ''
  Write-Host '  It holds your agents, their memories and relationships, your knowledge' -ForegroundColor Gray
  Write-Host '  sources, your saved browser session, and the key your provider credentials' -ForegroundColor Gray
  Write-Host '  are encrypted with. Keeping it means reinstalling AI17Z picks up where you' -ForegroundColor Gray
  Write-Host '  left off. There is no undo.' -ForegroundColor Gray
  Write-Host ''
  Write-Host '  Delete it? [y/N] ' -NoNewline -ForegroundColor White
  $answer = Read-Host
  $alsoData = ($answer -and $answer.Trim().ToLowerInvariant() -like 'y*')
}

# -- The program -------------------------------------------------------------
Write-Line 'Removing the program...'

# The Start Menu group and the uninstall entry, both derived from the instance
# name exactly as the setup program derived them.
$group = Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') $instance
if (Test-Path $group) { Remove-Item -LiteralPath $group -Recurse -Force -ErrorAction SilentlyContinue }

$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8F3B2A41-6C7E-4E51-9C2B-AI17Z0000001}_' + $instance + '_setup'
if (Test-Path $key) { Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue }

try {
  $installs = 'HKCU:\Software\AI17Z\Installs'
  if (Test-Path $installs) { Remove-ItemProperty -Path $installs -Name $ProgramDir -Force -ErrorAction SilentlyContinue }
} catch { }

# This script is inside the directory it is deleting, so the directory goes
# after the process that is reading it has finished with it. A scheduled delete
# through cmd rather than a self-deleting PowerShell: the .ps1 is held open for
# as long as this process lives.
$data = $dataDir
$removeProgram = @"
@echo off
ping -n 3 127.0.0.1 >nul
rmdir /s /q "$ProgramDir"
(goto) 2>nul & del "%~f0"
"@
$batch = Join-Path ([System.IO.Path]::GetTempPath()) ('ai17z-remove-' + [guid]::NewGuid().ToString('N') + '.cmd')
Set-Content -LiteralPath $batch -Value $removeProgram -Encoding ascii

# -- The data, only if asked -------------------------------------------------
if ($alsoData -and $data -and (Test-Path $data)) {
  Write-Line 'Removing your data, as asked...' 'Yellow'
  Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
  try { Remove-ItemProperty -Path 'HKCU:\Software\AI17Z' -Name 'DataDir' -Force -ErrorAction SilentlyContinue } catch { }
} elseif ($data) {
  Write-Line ('Your data is kept at ' + $data) 'Green'
  Write-Line 'Reinstalling AI17Z will pick up where you left off.'
}

Write-Host ''
Write-Line 'Docker, Node.js, Chrome and WSL were left alone.' 'DarkGray'
Write-Line 'AI17Z does not remove things other programs may be using.' 'DarkGray'
Write-Host ''
Write-Line ($instance + ' has been removed.') 'Green'
Write-Host ''

if (-not $Quiet -and $Host.Name -eq 'ConsoleHost') {
  Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
  [void](Read-Host)
}

Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $batch + '"') -WindowStyle Hidden
exit 0
