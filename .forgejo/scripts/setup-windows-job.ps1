# Make a Windows release job able to build the Windows release.
#
#   . .\.forgejo\scripts\setup-windows-job.ps1
#
# Dot-sourced, not run as a child: a job's script lines share one
# PowerShell session, so PATH and $iscc set here are there for the steps after.
#
# The Node every package carries, from nodejs.org, checked against its published
# SHASUMS256.txt before it is unpacked: the same rule as the Ubuntu jobs and the
# packages themselves. Then Inno Setup, installed deliberately rather than
# assumed, because hoping an image carried it once produced a failure whose only
# message was that the compiler was missing.
#
# ASCII only: Windows PowerShell reads a script with no byte order mark as ANSI.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$pins = Get-Content -Raw 'packaging\node-runtime.json' | ConvertFrom-Json
$version = '' + $pins.version
if (-not $version) { throw 'packaging\node-runtime.json names no Node version.' }
$name = "node-$version-win-x64.zip"
$work = Join-Path $env:TEMP ('ai17z-node-' + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $work | Out-Null
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/$name" -OutFile (Join-Path $work $name)
Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -OutFile (Join-Path $work 'SHASUMS256.txt')
$line = Get-Content (Join-Path $work 'SHASUMS256.txt') | Where-Object { $_ -match ('\s+' + [regex]::Escape($name) + '$') } | Select-Object -First 1
if (-not $line) { throw "nodejs.org publishes no hash for $name." }
$expected = ($line -split '\s+')[0].ToLowerInvariant()
$actual = (Get-FileHash (Join-Path $work $name) -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Node $name hashes $actual and nodejs.org says $expected." }
Expand-Archive -Path (Join-Path $work $name) -DestinationPath $work -Force
$nodeDir = Join-Path $work ("node-$version-win-x64")
$env:Path = $nodeDir + ';' + $env:Path
"node $(node -v), npm $(npm -v), checked against nodejs.org"

$paths = @(
  (Join-Path $env:ProgramFiles 'Inno Setup 6'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6')
)
function Find-Iscc { $paths | ForEach-Object { Join-Path $_ 'ISCC.exe' } | Where-Object { Test-Path $_ } | Select-Object -First 1 }
$iscc = Find-Iscc
if (-not $iscc) {
  if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    throw 'Inno Setup is not on this image and there is no Chocolatey to install it with.'
  }
  'Inno Setup is not on this image; installing it.'
  choco install innosetup --no-progress --yes --no-color
  if ($LASTEXITCODE -ne 0) { throw "choco install innosetup failed with $LASTEXITCODE" }
  $iscc = Find-Iscc
}
# Say where it looked. "Not available" on its own is not actionable.
if (-not $iscc) { throw "ISCC.exe not found after installing. Looked in: $($paths -join '; ')" }
"ISCC: $iscc"
