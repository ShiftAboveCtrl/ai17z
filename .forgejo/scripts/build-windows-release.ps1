# Build the Windows half of a release.
#
#   . .\.forgejo\scripts\build-windows-release.ps1 -Version 1.2.3
#
# Run by the `package windows` job after setup-windows-job.ps1, which put Node
# on PATH and found Inno Setup's compiler as $iscc. Writes everything the
# publish job attaches into build\windows, and release.env, which carries the
# release's name to the publish job.
#
# Built on AI17Z Code's Windows release runner from the tagged commit, where the
# log of what happened is part of the release. Nothing is built by hand on a
# maintainer's machine and uploaded.
#
# ASCII only: Windows PowerShell reads a script with no byte order mark as ANSI.
param([Parameter(Mandatory = $true)][string] $Version)
$ErrorActionPreference = 'Stop'

'--- install'
npm ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm ci failed with $LASTEXITCODE" }

'--- stage the application'
# --zip as well as the stage, because there are two ways to install AI17Z and
# they must lay down the same bytes. The installer carries the staged
# directory; AI17Z Setup downloads the zip of it. One build, two shapes.
$env:AI17Z_VERSION = $Version
# Continue, not Stop, around the one native command whose output is captured.
# Under Windows PowerShell 5.1, `2>&1` on a native program turns each stderr
# line into an error record, and with Stop the first one ends the build of a
# packager that succeeded. PowerShell 7 does not do this; which one a hosted
# runner gives is not this script's to assume. The exit code decides.
$ErrorActionPreference = 'Continue'
$out = npm run package:windows -- --zip 2>&1 | ForEach-Object { "$_" }
$code = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$out | ForEach-Object { $_ }
if ($code -ne 0) { throw "Staging failed with $code" }

# The packager prints the release name it derived. Read rather than recomposed
# here: two implementations of the same grammar is how the uninstall list and
# the version screen end up disagreeing, and a release that calls itself two
# things looks like two releases.
$line = $out | Select-String -Pattern '^AI17Z_RELEASE_NAME=(.+)$' | Select-Object -Last 1
if (-not $line) { throw 'The packager did not print AI17Z_RELEASE_NAME.' }
$name = $line.Matches[0].Groups[1].Value.Trim()
if (-not $name) { throw 'AI17Z_RELEASE_NAME was empty.' }
"release name: $name"

# The hash of the package, which goes into the audit document and into
# SHA256SUMS.txt. It is what the setup program checks the download against
# before it unpacks a byte of it.
$hash = $out | Select-String -Pattern '^AI17Z_PACKAGE_SHA256=([0-9a-f]{64})$' | Select-Object -Last 1
if (-not $hash) { throw 'The packager did not print AI17Z_PACKAGE_SHA256.' }
"package sha256: $($hash.Matches[0].Groups[1].Value)"

'--- check the staged application is really there'
# Inno fails with "no files found" when the stage is empty, which reads like a
# compiler problem and is not one. Fail here instead, saying what is wrong.
$stage = 'build\windows\app'
if (-not (Test-Path $stage)) { throw "Nothing was staged at $stage" }
$files = Get-ChildItem $stage -Recurse -File -ErrorAction SilentlyContinue
$mb = [math]::Round((($files | Measure-Object Length -Sum).Sum) / 1MB, 1)
"staged files: $($files.Count)  size: ${mb}MB"
# A file count is not evidence. The sources alone are hundreds of files and sail
# past any threshold worth setting, so this once counted a stage with no
# dependencies in it as complete: an installer that installs and then cannot
# start. Name the things the host process loads instead.
foreach ($proof in @('node_modules\fastify', 'node_modules\pg', 'node_modules\@xbam')) {
  if (-not (Test-Path (Join-Path $stage $proof))) {
    throw "The staged application has no dependencies: $proof is missing. It would install and fail to start."
  }
}
if ($mb -lt 40) { throw "Only ${mb}MB staged; a complete application is around 75MB." }

'--- compile the installer'
& $iscc "/DAppVersion=$Version" packaging\windows\ai17z.iss
if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with $LASTEXITCODE" }

'--- the setup script and its audit declaration beside it'
$script = 'packaging\windows\Setup-AI17Z.ps1'
# The installer, published as the script it is. `install.ps1` fetches exactly
# this file and refuses to run it unless its SHA-256 matches what
# SHA256SUMS.txt says.
Copy-Item $script "build\windows\Install-AI17Z-$Version.ps1" -Force
# And the command from the README, as a file. It is served from the branch,
# which is the one link in the chain whose bytes cannot be checked before they
# run; publishing it per release means anybody can compare the two, or pin.
Copy-Item 'install.ps1' 'build\windows\install.ps1' -Force
# What it says it is allowed to do, printed by the script itself so the
# declaration cannot drift from the code it describes. The publish job adds the
# hashes of the files people download.
$manifest = & powershell.exe -NoProfile -File $script -Manifest
if ($LASTEXITCODE -ne 0) { throw "The setup script could not print its manifest ($LASTEXITCODE)" }
$parsed = $manifest | ConvertFrom-Json
if (-not $parsed.allowedHosts) { throw 'The manifest has no allowedHosts in it.' }
$manifest | Set-Content 'build\windows\setup-declaration.json' -Encoding utf8

'--- the legacy installer metadata'
# One executable. The recommended route publishes no .exe at all; this one is
# still built because installations made with it update by running a newer one.
$exe = "build\windows\AI17Z-Setup-$Version.exe"
if (-not (Test-Path $exe)) { throw "Not produced: $exe" }
$info = (Get-Item $exe).VersionInfo
# Windows pads version-resource strings, so ProductName comes back as "AI17Z"
# followed by 55 spaces and an exact comparison fails on a file that is
# perfectly correct. Trim before comparing, and print the length so the next
# surprise here is one line of output away.
$product = $info.ProductName.Trim()
$productVersion = $info.ProductVersion.Trim()
"  ProductName    : '$product' (raw length $($info.ProductName.Length))"
"  ProductVersion : '$productVersion'"
if ($product -ne 'AI17Z') { throw "Wrong product name: '$product'" }
if ($productVersion -ne $Version) { throw "Wrong product version: '$productVersion' (expected '$Version')" }

'--- what the publish job gets'
Get-ChildItem build\windows -File | Select-Object Name, Length | Format-Table -AutoSize
# The name crosses to the publish job, which sources it in bash. So it is
# quoted (unquoted, "AI17Z Beta 9.6" ran `Beta` as a command) and ends in a
# bare newline (Out-File's CRLF put a carriage return inside the title).
if ($name -match "'") { throw "The release name has a quote in it: $name" }
[IO.File]::WriteAllText((Join-Path (Get-Location) 'release.env'), "RELEASE_NAME='$name'`n", (New-Object Text.ASCIIEncoding))
