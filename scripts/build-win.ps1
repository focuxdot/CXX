param(
  [string]$ProjectRoot = "",
  [string]$StageRoot = ""
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

function Require-Path {
  param([string]$Path, [string]$Message)
  if (!(Test-Path -LiteralPath $Path)) {
    throw "$Message`: $Path"
  }
}

function Copy-File {
  param([string]$Source, [string]$Destination)
  Require-Path $Source "Required file not found"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -Force -LiteralPath $Source -Destination $Destination
}

$Package = Get-Content -Raw -LiteralPath (Join-Path $ProjectRoot "package.json") | ConvertFrom-Json
$Version = [string]$Package.version

Push-Location $ProjectRoot
try {
  npm run build:sea
} finally {
  Pop-Location
}

if (Test-Path -LiteralPath $StageRoot) {
  Remove-Item -Force -Recurse -LiteralPath $StageRoot
}
New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null

Copy-File (Join-Path $ProjectRoot "dist\sea\cxx-daemon.exe") (Join-Path $StageRoot "resources\cxx-daemon.exe")
Copy-File (Join-Path $ProjectRoot "shell\windows\run-hidden.vbs") (Join-Path $StageRoot "resources\run-hidden.vbs")
Copy-File (Join-Path $ProjectRoot "web\icons\menubar.png") (Join-Path $StageRoot "resources\menubar.png")
Copy-File (Join-Path $ProjectRoot "README.md") (Join-Path $StageRoot "README.md")
Copy-File (Join-Path $ProjectRoot "README.en.md") (Join-Path $StageRoot "README.en.md")
Copy-File (Join-Path $ProjectRoot "LICENSE") (Join-Path $StageRoot "LICENSE")

& (Join-Path $ProjectRoot "shell\windows\Build-CXXTray.ps1") -SourceRoot $ProjectRoot -OutFile (Join-Path $StageRoot "CXX.exe")
if ($LASTEXITCODE -ne 0) {
  throw "CXX.exe build failed with exit code $LASTEXITCODE."
}

$Files = [ordered]@{}
foreach ($name in @("CXX.exe", "resources\cxx-daemon.exe", "resources\run-hidden.vbs", "resources\menubar.png", "README.md", "README.en.md", "LICENSE")) {
  $p = Join-Path $StageRoot $name
  $Files[$name] = [ordered]@{
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant()
    bytes = (Get-Item -LiteralPath $p).Length
  }
}

$Manifest = [ordered]@{
  name = "CXX"
  version = $Version
  platform = "win32"
  arch = "x64"
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  node = (& node -v)
  files = $Files
}

($Manifest | ConvertTo-Json -Depth 8) + "`n" | Set-Content -LiteralPath (Join-Path $StageRoot "build-manifest.json") -Encoding UTF8

[ordered]@{
  stageRoot = $StageRoot
  version = $Version
  files = $Files.Keys
} | ConvertTo-Json -Depth 4
