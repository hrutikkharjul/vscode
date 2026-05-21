# Disable Spectre-mitigation requirement in ALL binding.gyp files in the repo
# (top-level node_modules and remote/node_modules). Replaces the value
# "Spectre" with "false" rather than removing the key, which works regardless
# of whether the setting is on its own line or inline inside an object.
#
# WARNING: produces native binaries NOT hardened against Spectre. Use only
# for local dev / personal builds.

[CmdletBinding()]
param([switch]$Quiet)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$files = Get-ChildItem -LiteralPath $RepoRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.Extension -eq '.gyp' -or $_.Extension -eq '.gypi') -and
        $_.FullName -notmatch '\.bak$' -and
        ((Get-Content -Raw -LiteralPath $_.FullName -ErrorAction SilentlyContinue) -match '"?SpectreMitigation"?\s*:\s*"?Spectre"?')
    }

if (-not $Quiet) { Write-Host ("Found " + $files.Count + " binding.gyp file(s) with Spectre") }

$patched = 0
foreach ($f in $files) {
    $orig = Get-Content -Raw -LiteralPath $f.FullName
    # Match: 'SpectreMitigation' or "SpectreMitigation" : 'Spectre' or "Spectre"
    $new = $orig -replace "(['""])SpectreMitigation\1\s*:\s*(['""])Spectre\2", '$1SpectreMitigation$1: $2false$2'
    if ($new -ne $orig) {
        if (-not (Test-Path "$($f.FullName).bak")) {
            Copy-Item -LiteralPath $f.FullName -Destination "$($f.FullName).bak" -Force -ErrorAction SilentlyContinue
        }
        Set-Content -LiteralPath $f.FullName -Value $new -NoNewline
        $rel = $f.FullName.Substring($RepoRoot.Path.Length + 1)
        if (-not $Quiet) { Write-Host "  patched: $rel" -ForegroundColor Green }
        $patched++
    }
}

if (-not $Quiet) { Write-Host ("Patched $patched file(s).") }
return $patched
