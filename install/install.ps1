# pglens installation script for Windows
# Usage: iwr https://pglens.org/install.ps1 -useb | iex
#
# Installs a self-contained pglens under %USERPROFILE%\.pglens (bundled Node if
# needed), a launcher at .pglens\bin\pglens.cmd, and prepends that dir to the
# User PATH so the curl-managed copy always wins. Re-run any time to upgrade.

$ErrorActionPreference = 'Stop'

$InstallDir = "$HOME\.pglens"
$BinDir = "$InstallDir\bin"
$NodeDir = "$InstallDir\node"
$NodeVersion = "v20.11.0"
$RequiredNodeVersion = 18
$LauncherPath = "$BinDir\pglens.cmd"

Write-Host "Installing pglens..."

# Warn about any pre-existing pglens that isn't this launcher (e.g. a global
# `npm i -g pglens`). Two copies on PATH is the #1 cause of "upgrade didn't
# take". Non-fatal.
$Existing = (Get-Command pglens -ErrorAction SilentlyContinue).Source
if ($Existing -and ($Existing -ne $LauncherPath)) {
    Write-Host ""
    Write-Host "  WARNING: Another pglens is already on your PATH:"
    Write-Host "       $Existing"
    Write-Host "     After this install, run 'pglens doctor' to find and remove"
    Write-Host "     the duplicate so the two copies don't shadow each other."
    Write-Host ""
}

# Create directories
if (-not (Test-Path -Path $InstallDir)) { New-Item -ItemType Directory -Path $InstallDir | Out-Null }
if (-not (Test-Path -Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }

# 1. Check for Node.js
$InstallNode = $false
$NodeCmd = "node"
$NpmCmd = "npm"

if (Get-Command node -ErrorAction SilentlyContinue) {
    try {
        $CurrentVersionStr = node -v
        $CurrentVersion = [int]($CurrentVersionStr -replace 'v', '' -replace '\..*', '')
        if ($CurrentVersion -ge $RequiredNodeVersion) {
            Write-Host "OK: Node.js $CurrentVersionStr detected."
        } else {
            Write-Host "Node.js detected but version $CurrentVersionStr is older than required ($RequiredNodeVersion)."
            $InstallNode = $true
        }
    } catch {
        $InstallNode = $true
    }
} else {
    Write-Host "Node.js not found."
    $InstallNode = $true
}

if ($InstallNode) {
    Write-Host "Installing standalone Node.js $NodeVersion to $NodeDir..."

    if (Test-Path -Path $NodeDir) { Remove-Item -Path $NodeDir -Recurse -Force }
    New-Item -ItemType Directory -Path $NodeDir | Out-Null

    $NodeDist = "node-$NodeVersion-win-x64"
    $NodeUrl = "https://nodejs.org/dist/$NodeVersion/$NodeDist.zip"
    $ZipPath = "$InstallDir\node.zip"

    Write-Host "Downloading Node.js from $NodeUrl..."
    Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath

    Write-Host "Extracting..."
    Expand-Archive -Path $ZipPath -DestinationPath $InstallDir -Force
    Remove-Item -Path $ZipPath

    # Rename extracted folder to 'node'
    $Extracted = Get-ChildItem -Path "$InstallDir\$NodeDist"
    if ($Extracted) {
        Rename-Item -Path $Extracted.FullName -NewName "node"
    }

    $NodeCmd = "$NodeDir\node.exe"
    $NpmCmd = "$NodeDir\npm.cmd"

    Write-Host "OK: Node.js installed locally."
}

# 2. Install (or upgrade) pglens via npm. @latest makes a re-run a clean upgrade.
Write-Host "Installing pglens via npm..."
Set-Location -Path $InstallDir
# Suppress the package's postinstall doctor notice: the launcher and PATH
# entry aren't written until later in this script, so it would otherwise warn
# that the install "isn't on PATH" mid-run. We print our own status below.
$env:PGLENS_NO_POSTINSTALL = "1"
& $NpmCmd install --prefix "$InstallDir" pglens@latest
Remove-Item Env:\PGLENS_NO_POSTINSTALL -ErrorAction SilentlyContinue

# 3. Create launcher script
$TargetScript = "$InstallDir\node_modules\pglens\bin\pglens"
if (-not (Test-Path $TargetScript)) {
    $TargetScript = "$InstallDir\node_modules\.bin\pglens"
}

Write-Host "Creating launcher at $LauncherPath..."
$BatchContent = @"
@echo off
"$NodeCmd" "$TargetScript" %*
"@
Set-Content -Path $LauncherPath -Value $BatchContent

# 4. Add to PATH (prepend, so the curl-managed pglens takes precedence over any
# other copy).
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$BinDir*") {
    $NewPath = "$BinDir;$UserPath"
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    Write-Host "Added $BinDir to the front of your User PATH."
    Write-Host "Restart your terminal for the change to take effect."
} else {
    Write-Host "$BinDir is already in PATH. Restart your terminal to pick up the upgrade."
}

Write-Host ""
Write-Host "Successfully installed pglens!"
Write-Host "Open a new terminal, then run 'pglens start' to launch the server."
