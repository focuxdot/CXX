param(
  [string]$SourceRoot = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"

if (!$SourceRoot) {
  $SourceRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
}
$SourceRoot = [System.IO.Path]::GetFullPath($SourceRoot)

if (!$OutFile) {
  $OutFile = Join-Path $SourceRoot "dist\win\CXX\CXX.exe"
}

$SourceFile = Join-Path $SourceRoot "shell\windows\CXXTray.cs"
$IconFile = Join-Path $SourceRoot "packaging\windows\cxx.ico"

if (!(Test-Path $SourceFile)) {
  throw "CXXTray.cs not found: $SourceFile"
}

$Candidates = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
)

$Csc = $Candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (!$Csc) {
  $Command = Get-Command csc.exe -ErrorAction SilentlyContinue
  if ($Command) {
    $Csc = $Command.Source
  }
}

if (!$Csc) {
  throw "csc.exe not found. Install .NET Framework developer tools or .NET SDK."
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null

$Args = @(
  "/nologo",
  "/target:winexe",
  "/platform:x64",
  "/optimize+",
  "/codepage:65001",
  "/reference:System.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Web.Extensions.dll",
  "/out:$OutFile"
)

if (Test-Path $IconFile) {
  $Args += "/win32icon:$IconFile"
}

$Args += $SourceFile

& $Csc @Args

if ($LASTEXITCODE -ne 0) {
  throw "CXX.exe compile failed with exit code $LASTEXITCODE."
}
if (!(Test-Path $OutFile)) {
  throw "CXX.exe was not created: $OutFile"
}

Get-Item $OutFile | Select-Object FullName,Length,LastWriteTime
