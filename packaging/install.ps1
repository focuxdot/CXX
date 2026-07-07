$ErrorActionPreference = "Stop"

$DefaultBaseUrl = "https://github.com/focuxdot/CXX/releases/latest/download"
$BaseUrl = if ($env:CXX_BASE_URL) { $env:CXX_BASE_URL } else { $DefaultBaseUrl }
$BaseUrl = $BaseUrl.TrimEnd("/")
$PackageRevision = if ($env:CXX_PACKAGE_REVISION) { $env:CXX_PACKAGE_REVISION } else { "latest" }
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cxx-installer-" + [System.Guid]::NewGuid().ToString("N"))
$ChecksumsFile = $null

function Write-Log {
  param([string]$Message)
  Write-Host $Message
}

function Fail {
  param([string]$Message)
  Write-Error "cxx installer: $Message"
  exit 1
}

function Download-File {
  param([string]$Url, [string]$Output)
  Write-Log "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Output -UseBasicParsing
}

function Download-Checksums {
  if ($script:ChecksumsFile) {
    return
  }
  $script:ChecksumsFile = Join-Path $TempDir "checksums.txt"
  Download-File "$BaseUrl/checksums.txt?v=$PackageRevision" $script:ChecksumsFile
}

function Verify-Artifact {
  param([string]$Path)
  Download-Checksums
  $Name = Split-Path -Leaf $Path
  $Line = Get-Content -LiteralPath $script:ChecksumsFile | Where-Object {
    $Parts = $_ -split "\s+", 2
    $Parts.Length -eq 2 -and $Parts[1] -eq $Name
  } | Select-Object -First 1
  if (!$Line) {
    Fail "checksums.txt does not contain $Name"
  }
  $Expected = (($Line -split "\s+", 2)[0]).ToLowerInvariant()
  $Actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) {
    Fail "checksum mismatch for $Name"
  }
  Write-Log "Verified $Name"
}

function Install-Windows {
  New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
  $Installer = Join-Path $TempDir "CXX-win-x64.exe"
  Download-File "$BaseUrl/CXX-win-x64.exe?v=$PackageRevision" $Installer
  Verify-Artifact $Installer

  Write-Log "Installing CXX"
  $Args = @("/SP-", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/TASKS=desktopicon")
  $Process = Start-Process -FilePath $Installer -ArgumentList $Args -Wait -PassThru
  if ($Process.ExitCode -ne 0) {
    Fail "installer exited with code $($Process.ExitCode)"
  }

  $App = Join-Path $env:LOCALAPPDATA "Programs\CXX\CXX.exe"
  if (Test-Path -LiteralPath $App) {
    Write-Log "Opening CXX"
    Start-Process -FilePath $App -ArgumentList "--pair" | Out-Null
  }
  Write-Log "CXX installed. Open CXX from the desktop or Start menu to pair your phone."
}

try {
  Install-Windows
} finally {
  if (Test-Path -LiteralPath $TempDir) {
    Remove-Item -Recurse -Force -LiteralPath $TempDir -ErrorAction SilentlyContinue
  }
}
