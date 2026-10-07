# Runs the launcher's own pure decision functions and reports what they answered.
#
# `start-ai17z.ps1` is a top-to-bottom script with no -LoadOnly, and giving it
# one would be a behaviour change to the thing that starts the product. So the
# functions under test are lifted out of the shipped file by name and defined
# here instead. What is under test is still the code that ships, byte for byte,
# rather than a TypeScript transcription of it that drifts the first time
# somebody edits one and not the other -- and if a function is renamed or
# removed, extraction finds nothing and the test fails rather than passing.
#
# ASCII only, like every other PowerShell file here.
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $Script
)

$ErrorActionPreference = 'Stop'

$source = Get-Content -Raw -LiteralPath $Script

# An allow-list of names, not "whatever the JSON says". This reads from a pipe,
# and both lifting arbitrary text out of a file and dispatching arbitrary names
# off a pipe are shapes that should not be written even in a test.
$Allowed = @('Read-ReservedPortRanges', 'Get-PortReservation')

foreach ($name in $Allowed) {
  # Each function from its own `function <name>` to the closing brace in column
  # zero. The shipped file writes them that way; a match that fails leaves the
  # function undefined and the case below reports it.
  $pattern = '(?ms)^function ' + [regex]::Escape($name) + '\(.*?^\}'
  $found = [regex]::Match($source, $pattern)
  if ($found.Success) { Invoke-Expression $found.Value }
}

$raw = [Console]::In.ReadToEnd()
# Two statements, not one: Windows PowerShell's ConvertFrom-Json writes an
# array as a single object, so wrapping the pipeline inline produces one
# element containing the array.
$parsed = $raw | ConvertFrom-Json
$cases = @($parsed)

$results = @()
foreach ($case in $cases) {
  $name = '' + $case.fn
  if ($Allowed -notcontains $name) {
    $results += [pscustomobject]@{ ok = $false; error = ('not allowed: ' + $name) }
    continue
  }
  $command = Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue
  if (-not $command) {
    $results += [pscustomobject]@{ ok = $false; error = ('not found in the shipped script: ' + $name) }
    continue
  }

  $arguments = @()
  if ($null -ne $case.args) { $arguments = @($case.args) }

  try {
    if ($name -eq 'Get-PortReservation') {
      # The ranges cross JSON as objects with Low and High; the function
      # compares against .Low and .High, which a PSCustomObject answers to.
      $value = & $command $arguments[0] @($arguments[1])
      if ($null -eq $value) {
        $results += [pscustomobject]@{ ok = $true; value = $null }
      } else {
        $results += [pscustomobject]@{ ok = $true; value = [pscustomobject]@{ Low = $value.Low; High = $value.High } }
      }
      continue
    }
    # Hashtables do not survive ConvertTo-Json the way a caller expects here,
    # so each range is reshaped into an object with the two fields named.
    $ranges = & $command @($arguments[0])
    $shaped = @()
    foreach ($range in $ranges) { $shaped += [pscustomobject]@{ Low = $range.Low; High = $range.High } }
    $results += [pscustomobject]@{ ok = $true; value = $shaped }
  } catch {
    $results += [pscustomobject]@{ ok = $false; error = $_.Exception.Message }
  }
}

ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
