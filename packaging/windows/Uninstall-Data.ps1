<#
.SYNOPSIS
  Removes AI17Z's data directory.

.DESCRIPTION
  The uninstaller asks about this and does it for you. This script exists for
  the other cases: somebody who kept their data at uninstall and later changed
  their mind, or who wants to start clean without reinstalling.

  It is deliberately separate from removing the application. Those are different
  decisions with different consequences, and an uninstaller that silently took
  the second one would delete agents, memories, saved browser sessions and the
  key that provider credentials are sealed with.

.PARAMETER Yes
  Skip the confirmation. For scripted teardown; there is no undo either way.
#>
[CmdletBinding()]
param([switch] $Yes)

$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:LOCALAPPDATA 'AI17Z'

if (-not (Test-Path $dataDir)) {
  Write-Host "  Nothing to remove. There is no AI17Z data at $dataDir" -ForegroundColor DarkGray
  exit 0
}

# Say what is actually there rather than warning in the abstract. Somebody
# deciding this should be able to see what they are deciding about.
$parts = @()
foreach ($item in @(
  @{ Path = 'storage';          What = 'stored files, screenshots and knowledge' },
  @{ Path = 'browser-profiles'; What = 'saved browser sessions, including signed-in X accounts' },
  @{ Path = '.env';             What = 'the key your provider credentials are encrypted with' }
)) {
  $full = Join-Path $dataDir $item.Path
  if (Test-Path $full) { $parts += "    - $($item.Path): $($item.What)" }
}

Write-Host ''
Write-Host "  This will permanently delete $dataDir" -ForegroundColor Yellow
if ($parts.Count -gt 0) {
  Write-Host ''
  $parts | ForEach-Object { Write-Host $_ -ForegroundColor DarkGray }
}
Write-Host ''
Write-Host '  Your agents live in the database, which is a Docker volume and is not' -ForegroundColor DarkGray
Write-Host '  removed by this. Use "docker compose down -v" for that, separately.' -ForegroundColor DarkGray
Write-Host ''

if (-not $Yes) {
  $answer = Read-Host '  Type REMOVE to confirm'
  if ($answer -ne 'REMOVE') {
    Write-Host '  Nothing was removed.' -ForegroundColor Green
    exit 0
  }
}

Remove-Item -LiteralPath $dataDir -Recurse -Force
Write-Host "  Removed $dataDir" -ForegroundColor Green
