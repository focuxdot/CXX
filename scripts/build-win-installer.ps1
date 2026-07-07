param(
  [string]$ProjectRoot = "",
  [string]$StageRoot = "",
  [string]$OutputDir = "",
  [string]$Version = ""
)

$ErrorActionPreference = "Stop"

if (!$ProjectRoot) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)

if (!$StageRoot) {
  $StageRoot = Join-Path $ProjectRoot "dist\win\CXX"
}
$StageRoot = [System.IO.Path]::GetFullPath($StageRoot)

if (!$OutputDir) {
  $OutputDir = Join-Path $ProjectRoot "dist\win\installer"
}
$OutputDir = [System.IO.Path]::GetFullPath($OutputDir)

if (!$Version) {
  $Package = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
  $Version = [string]$Package.version
}

$IssPath = Join-Path $ProjectRoot "packaging\CXX.iss"
$IconFile = Join-Path $ProjectRoot "packaging\windows\cxx.ico"
if (!(Test-Path -LiteralPath $StageRoot)) {
  throw "StageRoot not found: $StageRoot. Run scripts\build-win.ps1 first."
}
foreach ($name in @("CXX.exe", "resources\cxx-daemon.exe", "resources\run-hidden.vbs", "resources\menubar.png")) {
  if (!(Test-Path -LiteralPath (Join-Path $StageRoot $name))) {
    throw "Required staged file missing: $name"
  }
}
if (!(Test-Path -LiteralPath $IssPath)) {
  throw "ISS file not found: $IssPath"
}
if (!(Test-Path -LiteralPath $IconFile)) {
  throw "Icon file not found: $IconFile"
}

$Candidates = @(
  "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
  "C:\Program Files\Inno Setup 6\ISCC.exe"
)
$Iscc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$Iscc) {
  $Command = Get-Command iscc.exe -ErrorAction SilentlyContinue
  if ($Command) {
    $Iscc = $Command.Source
  }
}
if (!$Iscc) {
  throw "ISCC.exe not found. Install Inno Setup 6 first."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$OutputBaseFilename = "CXX-$Version-win-x64"

& $Iscc "/DSourceRoot=$StageRoot" "/DOutputDir=$OutputDir" "/DMyAppVersion=$Version" "/DOutputBaseFilename=$OutputBaseFilename" "/DIconFile=$IconFile" $IssPath
if ($LASTEXITCODE -ne 0) {
  throw "Inno Setup failed with exit code $LASTEXITCODE."
}

$Installer = Join-Path $OutputDir "$OutputBaseFilename.exe"
if (!(Test-Path -LiteralPath $Installer)) {
  throw "Installer was not created: $Installer"
}

$Hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Installer).Hash.ToLowerInvariant()
$ShaPath = "$Installer.sha256"
"$Hash  $(Split-Path -Leaf $Installer)" | Set-Content -LiteralPath $ShaPath -Encoding ASCII

[ordered]@{
  installer = $Installer
  sha256 = $Hash
  sha256File = $ShaPath
  signatureStatus = (Get-AuthenticodeSignature $Installer).Status.ToString()
  outputBaseFilename = $OutputBaseFilename
} | ConvertTo-Json -Depth 4
