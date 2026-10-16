<#
.SYNOPSIS
  Points the documentation and bootstrap scripts at your project.

.DESCRIPTION
  Four URLs appear across the README, CONTRIBUTING, the publishing notes and the
  two bootstrap scripts: the clone URL, the source zip, and the raw URL of each
  bootstrap script. They are all derivable from one, so this asks for one.

  Run it once, after creating the project on GitLab and before the first push.
  Safe to run again if you rename or move the project.

.PARAMETER Url
  The project URL, in any of the forms GitLab shows you:
    https://gitlab.com/you/ai17z
    https://gitlab.com/you/ai17z.git
    git@gitlab.com:you/ai17z.git

.PARAMETER Branch
  The default branch. Defaults to main.

.EXAMPLE
  .\scripts\set-repo-url.ps1 -Url https://gitlab.com/you/ai17z
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Url,
  [string] $Branch = 'main'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Accept whichever form was pasted, and reduce it to namespace/project. A GitLab
# namespace can be a group with subgroups, so everything before the last segment
# is the namespace.
$clean = $Url.Trim().TrimEnd('/')
if ($clean -match '^git@gitlab\.com:(?<path>.+?)(\.git)?$') {
  $path = $Matches.path
} elseif ($clean -match '^https?://gitlab\.com/(?<path>[^?#]+?)(\.git)?$') {
  $path = $Matches.path
} else {
  Write-Host ''
  Write-Host "  That does not look like a GitLab project URL: $Url" -ForegroundColor Red
  Write-Host '  Expected something like https://gitlab.com/you/ai17z' -ForegroundColor Yellow
  Write-Host ''
  exit 1
}
if ($path -notmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$') {
  Write-Host ''
  Write-Host "  $path is not a namespace/project path." -ForegroundColor Red
  Write-Host ''
  exit 1
}
$project = ($path -split '/')[-1]

$cloneUrl = "https://gitlab.com/$path.git"
$zipUrl = "https://gitlab.com/$path/-/archive/$Branch/$project-$Branch.zip"
$rawPs1 = "https://gitlab.com/$path/-/raw/$Branch/bootstrap.ps1"
$rawSh = "https://gitlab.com/$path/-/raw/$Branch/bootstrap.sh"

$replacements = @{
  'https://gitlab.com/shiftabovectrl/ai17z.git'                          = $cloneUrl
  'https://gitlab.com/shiftabovectrl/ai17z/-/archive/main/ai17z-main.zip' = $zipUrl
  'https://gitlab.com/shiftabovectrl/ai17z/-/raw/main/bootstrap.ps1'      = $rawPs1
  'https://gitlab.com/shiftabovectrl/ai17z/-/raw/main/bootstrap.sh'       = $rawSh
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
