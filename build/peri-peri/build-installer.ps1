# PeriPeri Windows installer build
#
# Drives the same gulp pipeline VS Code uses on Azure Pipelines, minus the
# code-signing steps. Output: .build\win32-x64\system-setup\PeriPeri-Setup.exe
#
# Prerequisites:
#   - Node 22.x (matches .nvmrc)
#   - Python 3.x on PATH
#   - Visual Studio 2022 Build Tools with the "Desktop development with C++"
#     workload (needed for kerberos / native-keymap / node-pty native modules)
#   - ~10 GB free disk
#
# Usage (from repo root):
#   pwsh -ExecutionPolicy Bypass -File build\peri-peri\build-installer.ps1
#
# Optional flags:
#   -Arch x64|arm64       (default: x64)
#   -Target system|user   (default: system)
#   -SkipInstall          skip `npm install`
#   -SkipCompile          skip `gulp core-ci`
#
[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Arch = 'x64',
    [ValidateSet('system', 'user')]
    [string]$Target = 'system',
    [switch]$SkipInstall,
    [switch]$SkipCompile
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $RepoRoot

# Allow running with the Node version we have on this box (22.13.1) instead
# of the strict version pinned in .nvmrc (22.22.1). The actual API surface
# is compatible - preinstall just enforces the floor.
$env:VSCODE_SKIP_NODE_VERSION_CHECK = '1'

function Step($msg) {
    Write-Host ""
    Write-Host "==========================================================" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "==========================================================" -ForegroundColor Cyan
}

function Run($cmd) {
    Write-Host ">>> $cmd" -ForegroundColor Yellow
    & cmd /c "$cmd"
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $cmd"
    }
}

function RunUnderVcvars($cmd) {
    # node-gyp on Windows fails to locate Visual Studio via PowerShell on
    # some machines; sourcing vcvars64.bat sets VCINSTALLDIR so node-gyp
    # skips its own VS-detection logic.
    $vcvars = "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
    if (-not (Test-Path $vcvars)) {
        throw "vcvars64.bat not found. Install Visual Studio Build Tools 2022 with the C++ workload."
    }
    Write-Host ">>> (vcvars64) $cmd" -ForegroundColor Yellow
    & cmd /c "call `"$vcvars`" >NUL && $cmd"
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $cmd"
    }
}

Step "PeriPeri build pipeline  (arch=$Arch  target=$Target)"

# ---------- 1. Sanity checks ----------
Step "1. Environment"
node --version
npm --version
python --version

# ---------- 2. npm install ----------
if (-not $SkipInstall) {
    Step "2. npm install (this is slow, can take 5-15 minutes)"
    RunUnderVcvars "npm install"
} else {
    Write-Host "Skipping npm install (-SkipInstall)" -ForegroundColor DarkGray
}

# ---------- 3. compile core ----------
if (-not $SkipCompile) {
    Step "3. Compile core  (npm run gulp core-ci) - 10-30 min"
    Run "npm run gulp core-ci"
} else {
    Write-Host "Skipping compile (-SkipCompile)" -ForegroundColor DarkGray
}

# ---------- 4. package into ..\VSCode-win32-<arch> ----------
Step "4. Package client  (vscode-win32-$Arch-min-ci)"
Run "npm run gulp vscode-win32-$Arch-min-ci"

# ---------- 5. inno-updater (copies tool + sets icon) ----------
Step "5. Stage inno-updater  (vscode-win32-$Arch-inno-updater)"
Run "npm run gulp vscode-win32-$Arch-inno-updater"

# ---------- 6. Inno Setup -> .exe installer ----------
Step "6. Build installer  (vscode-win32-$Arch-$Target-setup)"
Run "npm run gulp vscode-win32-$Arch-$Target-setup"

# ---------- 7. Report ----------
$out = Join-Path $RepoRoot ".build\win32-$Arch\$Target-setup"
Step "Done. Output dir:"
Write-Host $out
if (Test-Path $out) {
    Get-ChildItem $out -Filter *.exe | ForEach-Object {
        $outputLine = '  {0}  ({1:N0} bytes)' -f $_.FullName, $_.Length
        Write-Host $outputLine -ForegroundColor Green
    }
} else {
    Write-Host "(output directory not found - inspect log above for errors)" -ForegroundColor Red
}
