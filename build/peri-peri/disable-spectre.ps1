# Disable Spectre-mitigation requirement in VS Code's native module binding.gyp
# files. Run this AFTER `npm install` if you do not have the Spectre-mitigated
# MSVC libraries installed.
#
# WARNING: This produces native binaries that are NOT hardened against the
# Spectre family of CPU side-channel attacks. The proper fix is to install
# "MSVC v143 ... Spectre-mitigated libs" via the Visual Studio Installer.
# This script is offered as a stopgap only.
#
# Usage:
#   pwsh -ExecutionPolicy Bypass -File build\peri-peri\disable-spectre.ps1
#
# After running, re-run the gyp builds:
#   pwsh -File build\peri-peri\build-installer.ps1 -SkipInstall

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$targets = @(
    "node_modules\@vscode\policy-watcher\binding.gyp",
    "node_modules\@vscode\spdlog\binding.gyp",
    "node_modules\@vscode\sqlite3\binding.gyp",
    "node_modules\@vscode\windows-ca-certs\binding.gyp",
    "node_modules\@vscode\windows-mutex\binding.gyp",
    "node_modules\@vscode\windows-process-tree\binding.gyp",
    "node_modules\@vscode\windows-registry\binding.gyp",
    "node_modules\@vscode\native-watchdog\binding.gyp",
    "node_modules\@vscode\deviceid\binding.gyp",
    "node_modules\kerberos\binding.gyp",
    "node_modules\native-keymap\binding.gyp",
    "node_modules\node-pty\binding.gyp",
    "node_modules\native-is-elevated\binding.gyp"
)

$patched = 0
foreach ($rel in $targets) {
    $path = Join-Path $RepoRoot $rel
    if (-not (Test-Path $path)) { continue }
    $orig = Get-Content -Raw -LiteralPath $path
    # Remove lines that set SpectreMitigation = "Spectre"
    $new = $orig -replace "(?m)^\s*['""]SpectreMitigation['""]\s*:\s*['""]Spectre['""],?\s*\r?\n", ""
    if ($new -ne $orig) {
        # Create a one-shot backup next to the file.
        Copy-Item -LiteralPath $path -Destination "$path.bak" -Force -ErrorAction SilentlyContinue
        Set-Content -LiteralPath $path -Value $new -NoNewline
        Write-Host "  patched: $rel" -ForegroundColor Green
        $patched++
    }
}

Write-Host ""
Write-Host "Patched $patched binding.gyp files." -ForegroundColor Cyan
Write-Host "Now rebuild native modules:" -ForegroundColor Cyan
Write-Host "  npm rebuild  (under a vcvars64 cmd shell, or via build-installer.ps1)" -ForegroundColor Cyan
