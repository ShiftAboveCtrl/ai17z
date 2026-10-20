<#
.SYNOPSIS
  Points the documentation and bootstrap scripts at your project.

.DESCRIPTION
  Four URLs appear across the README, CONTRIBUTING, the publishing notes and the
  two bootstrap scripts: the clone URL, the source zip, and the raw URL of each
  bootstrap script. They are all derivable from one, so this asks for one.

  AI17Z lives on AI17Z Code, its own Forgejo. A fork on any Forgejo (Codeberg,
  or one of your own) uses the same URL shapes, so any host works here.

  Run it once, after creating the project and before the first push. Safe to
  run again if you rename or move the project.

.PARAMETER Url
  The project URL, in any of the forms a Forgejo shows you:
    https://code.example.org/you/ai17z
    https://code.example.org/you/ai17z.git

.PARAMETER Branch
  The default branch. Defaults to main.

.EXAMPLE
  .\scripts\set-repo-url.ps1 -Url https://codeberg.org/you/ai17z
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Url,
  [string] $Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Accept either form that was pasted, and reduce it to host and owner/project.
$clean = $Url.Trim().TrimEnd('/')
if ($clean -match '^https://(?<host>[A-Za-z0-9.-]+)/(?<path>[^?#]+?)(\.git)?$') {
  $hostName = $Matches.host
  $path = $Matches.path
} else {
  Write-Host ''
  Write-Host "  That does not look like an https project URL: $Url" -ForegroundColor Red
  Write-Host '  Expected something like https://codeberg.org/you/ai17z' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}
if ($path -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
  Write-Host ''
  Write-Host "  $path is not an owner/project path." -ForegroundColor Red
  Write-Host ''
  exit 1
}

$cloneUrl = "https://$hostName/$path.git"
$zipUrl = "https://$hostName/$path/archive/$Branch.zip"
$rawPs1 = "https://$hostName/$path/raw/branch/$Branch/bootstrap.ps1"
$rawSh = "https://$hostName/$path/raw/branch/$Branch/bootstrap.sh"

$replacements = @{
  'https://code.ai17z.io/AI17Z/ai17z.git'                          = $cloneUrl
  'https://code.ai17z.io/AI17Z/ai17z/archive/main.zip'             = $zipUrl
  'https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.ps1' = $rawPs1
  'https://code.ai17z.io/AI17Z/ai17z/raw/branch/main/bootstrap.sh'  = $rawSh
}

# Only files that are actually part of the repository, and never node_modules.
$targets = git ls-files |
  Where-Object { $_ -match '\.(md|ps1|sh)$' } |
  Where-Object { Test-Path $_ }

$touched = 0
foreach ($file in $targets) {
  $text = Get-Content -Raw -LiteralPath $file
  $before = $text
  foreach ($key in $replacements.Keys) { $text = $text.Replace($key, $replacements[$key]) }
  if ($text -ne $before) {
    # Written as bytes, with no byte order mark and nothing appended.
    #
    # `Set-Content -Encoding utf8` writes a BOM on Windows PowerShell 5.1, and a
    # BOM in front of `#!/usr/bin/env bash` is three bytes before the shebang:
    # Linux stops reading it as a script and reports something that has nothing
    # to do with the cause. `-NoNewline` matters for the same reason in the
    # other direction: without it every run adds a blank line.
    [System.IO.File]::WriteAllText(
      (Join-Path $root $file),
      $text,
      (New-Object System.Text.UTF8Encoding $false)
    )
    Write-Host "  updated $file" -ForegroundColor Green
    $touched += 1
  }
}

Write-Host ''
if ($touched -eq 0) {
  Write-Host '  Nothing to replace. Either it is already set, or the placeholders are gone.' -ForegroundColor Yellow
} else {
  Write-Host "  $touched file(s) now point at $path on branch $Branch." -ForegroundColor Green
}
Write-Host ''
Write-Host '  Check it over with: git diff' -ForegroundColor Gray
Write-Host ''
