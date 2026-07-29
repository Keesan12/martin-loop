# SPDX-FileCopyrightText: MartinLoop contributors
# SPDX-License-Identifier: Apache-2.0

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$Repository = "Keesan12/martin-loop"
$Version = if ($env:MARTIN_VERSION) { $env:MARTIN_VERSION } else { "latest" }
$InstallDirectory = if ($env:MARTIN_INSTALL_DIR) {
  $env:MARTIN_INSTALL_DIR
} else {
  Join-Path $env:LOCALAPPDATA "martin-loop\bin"
}

function Write-InstallerMessage([string]$Message) {
  if ($env:MARTIN_QUIET -ne "1") {
    Write-Output $Message
  }
}

function Stop-Installer([string]$Message) {
  throw "martin-loop install failed: $Message"
}

$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
if ($Architecture -ne "X64") {
  Stop-Installer "Windows native releases currently support x64 only"
}
$Target = "win-x64"

if ($Version -eq "latest") {
  try {
    $Release = Invoke-RestMethod `
      -Uri "https://api.github.com/repos/$Repository/releases/latest" `
      -Headers @{
        Accept = "application/vnd.github+json"
        "User-Agent" = "martin-loop-installer"
      }
    $Version = $Release.tag_name -replace "^v", ""
  } catch {
    Stop-Installer "could not resolve the latest release: $($_.Exception.Message)"
  }
}
if ($Version -notmatch "^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$") {
  Stop-Installer "invalid release version: $Version"
}

$Asset = "martin-loop-$Target.exe"
$BaseUrl = "https://github.com/$Repository/releases/download/v$Version"
$TemporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) (
  "martin-loop-" + [System.Guid]::NewGuid().ToString("N")
)
$DownloadPath = Join-Path $TemporaryDirectory $Asset
$ChecksumPath = "$DownloadPath.sha256"
$InstallPath = Join-Path $InstallDirectory "martin-loop.exe"
$AliasPath = Join-Path $InstallDirectory "martin.exe"
$Nonce = [System.Guid]::NewGuid().ToString("N")
$StagedPath = Join-Path $InstallDirectory ".$Nonce.stage.exe"
$StagedAliasPath = Join-Path $InstallDirectory ".$Nonce.alias.exe"
$BackupPath = Join-Path $InstallDirectory ".$Nonce.backup.exe"
$AliasBackupPath = Join-Path $InstallDirectory ".$Nonce.alias-backup.exe"
$HadInstall = $false
$HadAlias = $false

try {
  New-Item -ItemType Directory -Path $TemporaryDirectory -Force | Out-Null
  Write-InstallerMessage "Downloading $Asset..."
  try {
    Invoke-WebRequest -Uri "$BaseUrl/$Asset" -OutFile $DownloadPath -UseBasicParsing
    Invoke-WebRequest -Uri "$BaseUrl/$Asset.sha256" -OutFile $ChecksumPath -UseBasicParsing
  } catch {
    Stop-Installer "release asset or checksum download failed: $($_.Exception.Message)"
  }

  $ChecksumLine = (Get-Content $ChecksumPath -Raw).Trim()
  if ($ChecksumLine -notmatch "^([a-fA-F0-9]{64})\s+\*?(.+)$") {
    Stop-Installer "checksum file is missing or malformed"
  }
  if ($Matches[2] -ne $Asset) {
    Stop-Installer "checksum file does not name $Asset"
  }
  $Expected = $Matches[1].ToLowerInvariant()
  $Actual = (Get-FileHash -Path $DownloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Expected -ne $Actual) {
    Stop-Installer "checksum mismatch for $Asset"
  }
  if ((Get-Item $DownloadPath).Length -lt 1024) {
    Stop-Installer "downloaded asset is too small"
  }

  New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
  Copy-Item $DownloadPath $StagedPath
  & $StagedPath --version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Stop-Installer "downloaded executable failed verification"
  }

  $HadInstall = Test-Path $InstallPath
  $HadAlias = Test-Path $AliasPath
  if ($HadInstall) { Move-Item $InstallPath $BackupPath }
  if ($HadAlias) { Move-Item $AliasPath $AliasBackupPath }
  Move-Item $StagedPath $InstallPath
  Copy-Item $InstallPath $StagedAliasPath
  Move-Item $StagedAliasPath $AliasPath
  & $InstallPath --version | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Stop-Installer "installed executable failed verification"
  }

  if ($HadAlias -and (Test-Path $AliasBackupPath)) {
    Remove-Item $AliasBackupPath -Force
  }
  Write-InstallerMessage "Installed martin-loop $Version to $InstallPath"
} catch {
  Remove-Item $StagedPath, $StagedAliasPath -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallPath) { Remove-Item $InstallPath -Force }
  if (Test-Path $AliasPath) { Remove-Item $AliasPath -Force }
  if ($HadInstall -and (Test-Path $BackupPath)) { Move-Item $BackupPath $InstallPath }
  if ($HadAlias -and (Test-Path $AliasBackupPath)) { Move-Item $AliasBackupPath $AliasPath }
  throw
} finally {
  Remove-Item $TemporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
