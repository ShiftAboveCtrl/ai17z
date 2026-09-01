<#
.SYNOPSIS
  Points the documentation and bootstrap scripts at your repository.

.DESCRIPTION
  Four URLs appear across the README, CONTRIBUTING, the publishing notes and the
  two bootstrap scripts: the clone URL, the zip, and the raw URL of each
  bootstrap script. They are all derivable from one, so this asks for one.

  Run it once, after creating the repository on GitHub and before the first
  push. Safe to run again if you rename or move the repository.

.PARAMETER Url
  The repository URL, in any of the forms GitHub shows you:
    https://github.com/you/ai17z
    https://github.com/you/ai17z.git
    git@github.com:you/ai17z.git

.PARAMETER Branch
  The default branch. Defaults to main.

.EXAMPLE
  .\scripts\set-repo-url.ps1 -Url https://github.com/you/ai17z
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Url,
  [string] $Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Accept whichever form was pasted, and reduce it to owner/repo.
$clean = $Url.Trim().TrimEnd('/')
if ($clean -match '^git@github\.com:(?<owner>[^/]+)/(?<repo>.+?)(\.git)?$') {
  $owner = $Matches.owner; $repo = $Matches.repo
} elseif ($clean -match '^https?://github\.com/(?<owner>[^/]+)/(?<repo>[^/]+?)(\.git)?$') {
  $owner = $Matches.owner; $repo = $Matches.repo
} else {
  Write-Host ''
  Write-Host "  That does not look like a GitHub repository URL: $Url" -ForegroundColor Red
  Write-Host '  Expected something like https://github.com/you/ai17z' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}

$cloneUrl = "https://github.com/$owner/$repo.git"
$zipUrl = "https://github.com/$owner/$repo/archive/refs/heads/$Branch.zip"
$rawPs1 = "https://raw.githubusercontent.com/$owner/$repo/$Branch/bootstrap.ps1"
$rawSh = "https://raw.githubusercontent.com/$owner/$repo/$Branch/bootstrap.sh"

$replacements = @{
  'https://github.com/ShiftAboveCtrl/ai17z.git'           = $cloneUrl
  'https://github.com/ShiftAboveCtrl/ai17z/archive/refs/heads/main.zip'              = $zipUrl
  'https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.ps1'    = $rawPs1
  'https://raw.githubusercontent.com/ShiftAboveCtrl/ai17z/main/bootstrap.sh' = $rawSh
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
    # other direction -- without it every run adds a blank line.
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
  Write-Host "  $touched file(s) now point at $owner/$repo on branch $Branch." -ForegroundColor Green
}
Write-Host ''
Write-Host '  Check it over with: git diff' -ForegroundColor Gray
Write-Host ''
