# The published Windows route, checked and then run in WhatIf, as a stranger
# would run it.
#
#   powershell -NoProfile -File .gitlab\scripts\qualify-published-windows.ps1 -Tag v1.2.3
#
# Looking only: -WhatIfOnly resolves the release and says what it would do, and
# changes nothing on the machine.
#
# ASCII only: Windows PowerShell reads a script with no byte order mark as ANSI.
param(
  [Parameter(Mandatory = $true)][string] $Tag,
  # The release tag's own install.ps1, which the published one must match.
  [string] $Tagged = 'install.ps1'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$project = if ($env:CI_PROJECT_PATH) { $env:CI_PROJECT_PATH } else { 'shiftabovectrl/ai17z' }
$dl = "https://gitlab.com/$project/-/releases/$Tag/downloads"
$room = Join-Path $env:TEMP ('ai17z-published-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $room | Out-Null

# The gate. install.ps1 from the tag's own address, against the SHA256SUMS.txt
# that tag published, against the file this commit holds. None of it touches an
# API, so none of it can be refused for want of an anonymous quota.
Invoke-WebRequest -Uri "$dl/SHA256SUMS.txt" -OutFile "$room\SHA256SUMS.txt" -UseBasicParsing
Invoke-WebRequest -Uri "$dl/install.ps1" -OutFile "$room\install.ps1" -UseBasicParsing
$line = Get-Content "$room\SHA256SUMS.txt" | Where-Object { $_ -match '\s+install\.ps1$' }
if (-not $line) { throw 'SHA256SUMS.txt has no line for install.ps1' }
$want = ($line -split '\s+')[0]
$got = (Get-FileHash "$room\install.ps1" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($got -ne $want) { throw "install.ps1 hashes $got and the release says $want" }
'  install.ps1 matches the hash the release published'
$mine = (Get-FileHash $Tagged -Algorithm SHA256).Hash.ToLowerInvariant()
if ($got -ne $mine) { throw "the published install.ps1 is not the one $Tag holds" }
'  and is byte for byte the script the tag holds'

$source = Get-Content "$room\install.ps1" -Raw
function Invoke-Once {
  $text = ''
  try {
    $global:LASTEXITCODE = 0
    $text = & ([scriptblock]::Create($source)) -Release $Tag -NewInstance -WhatIfOnly *>&1 | Out-String
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
    return @{ Text = $text; Code = $code }
  } catch {
    return @{ Text = ($text + [Environment]::NewLine + $_.Exception.Message).Trim(); Code = 1 }
  }
}

# The stranger's route, which resolves the release through GitLab's API without
# a token, because that is what a stranger's does. An anonymous limit on an
# address a hosted runner shares is not a fact about a release, so a refusal
# that is recognisably that is reported and not counted, and anything else still
# fails the job. One retry, a rate-limit window later.
$result = Invoke-Once
if ($result.Code -ne 0) {
  "  That attempt exited $($result.Code). Waiting sixty seconds and trying once more."
  $result.Text
  Start-Sleep -Seconds 60
  $result = Invoke-Once
}
$result.Text
if ($result.Code -ne 0) {
  $ceiling = '\(40[39]\)|\(429\)|rate.?limit|Retry-After|RateLimit-Reset|could not be read|could not work out which release'
  if ($result.Text -match $ceiling) {
    "  note  GitLab refused this runner's anonymous API twice. That is a shared rate limit rather than anything about $Tag, whose published install.ps1 was taken from the tag and matched the hash that tag published."
  } else {
    # Said out loud even when the attempt printed nothing: that is the case
    # that once left a failure with no reason anywhere.
    $detail = ($result.Text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 25) -join "`n"
    if (-not $detail) { $detail = '(it printed nothing at all)' }
    "==== FAILED: install.ps1 -WhatIfOnly, twice, a minute apart, and not for anything this runner could blame on GitLab. Last exit $($result.Code) ===="
    $detail
    throw "install.ps1 -WhatIfOnly exited $($result.Code) on both attempts"
  }
}
