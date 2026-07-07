# Windows installer for the portable Canvas Notebook server CLI.
# Works from a repository checkout, from the packaged CLI bundle, or via:
#   irm https://raw.githubusercontent.com/canvascoding/canvas-notebook/main/install/windows.ps1 | iex

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "This installer is for Windows only."
}

$Repo = if ($env:CANVAS_REPO) { $env:CANVAS_REPO } else { "canvascoding/canvas-notebook" }
$Version = if ($env:CANVAS_VERSION) { $env:CANVAS_VERSION } elseif ($env:CANVAS_CLI_VERSION) { $env:CANVAS_CLI_VERSION } else { "latest" }
$CliAssetName = "canvas-notebook-cli.tar.gz"
$ChecksumAssetName = "canvas-notebook-cli.sha256"
$CliInstallDir = if ($env:CANVAS_CLI_INSTALL_DIR) { $env:CANVAS_CLI_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "Canvas Notebook\cli" }
$BinDir = if ($env:CANVAS_CLI_BIN_DIR) { $env:CANVAS_CLI_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Canvas Notebook\bin" }
$BinPath = Join-Path $BinDir "canvas-notebook.cmd"
$AutoInstallDeps = if ($env:CANVAS_AUTO_INSTALL_DEPS) { $env:CANVAS_AUTO_INSTALL_DEPS -ne "false" } else { $true }

function Fail($Message) {
  throw $Message
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = @($machinePath, $userPath, $env:Path) -join ";"
}

function Get-AssetUrl($AssetName) {
  if ($env:CANVAS_CLI_BASE_URL) {
    $baseUrl = [string]$env:CANVAS_CLI_BASE_URL
    return "$($baseUrl.TrimEnd('/'))/$AssetName"
  }
  if ($env:CANVAS_CLI_URL -and $AssetName -eq $CliAssetName) {
    return $env:CANVAS_CLI_URL
  }
  if ($env:CANVAS_CLI_SHA256_URL -and $AssetName -eq $ChecksumAssetName) {
    return $env:CANVAS_CLI_SHA256_URL
  }
  if ($Version -eq "latest" -or [string]::IsNullOrWhiteSpace($Version)) {
    return "https://github.com/$Repo/releases/latest/download/$AssetName"
  }
  $tag = $Version -replace "^refs/tags/", ""
  return "https://github.com/$Repo/releases/download/$tag/$AssetName"
}

function Invoke-Download($Url, $OutputPath) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Invoke-WebRequest -Uri $Url -OutFile $OutputPath -UseBasicParsing
      return
    } catch {
      $lastError = $_
      Start-Sleep -Seconds 2
    }
  }
  throw $lastError
}

function Find-LocalRoot {
  if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
    return $null
  }

  $candidate = Resolve-Path (Join-Path $PSScriptRoot "..") -ErrorAction SilentlyContinue
  if (-not $candidate) {
    return $null
  }

  $root = $candidate.Path
  if ((Test-Path (Join-Path $root "dist-cli\main.js")) -or (Test-Path (Join-Path $root "package.json"))) {
    return $root
  }

  return $null
}

function Verify-Checksum($ArchivePath, $ChecksumPath) {
  $line = Get-Content -Path $ChecksumPath | Select-Object -First 1
  $expected = (($line -split "\s+") | Where-Object { $_ })[0].ToLowerInvariant()
  $actual = (Get-FileHash -Path $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    Fail "CLI checksum verification failed."
  }
  Write-Host "Checksum verified: $CliAssetName"
}

function Install-CliBundle {
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("canvas-cli-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $archivePath = Join-Path $tmpDir $CliAssetName
  $checksumPath = Join-Path $tmpDir $ChecksumAssetName

  Write-Host "Downloading Canvas Notebook CLI bundle..."
  Invoke-Download (Get-AssetUrl $CliAssetName) $archivePath
  Invoke-Download (Get-AssetUrl $ChecksumAssetName) $checksumPath
  Verify-Checksum $archivePath $checksumPath

  if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
    Fail "tar.exe is required to extract the CLI bundle."
  }

  New-Item -ItemType Directory -Force -Path $CliInstallDir | Out-Null
  $bundleDir = Join-Path $CliInstallDir "canvas-notebook-cli"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $bundleDir
  tar.exe -xzf $archivePath -C $CliInstallDir

  $mainJs = Join-Path $bundleDir "dist-cli\main.js"
  if (-not (Test-Path $mainJs)) {
    Fail "Downloaded CLI bundle is missing dist-cli\main.js."
  }

  return $bundleDir
}

function Get-NodeCommand {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) {
    return $node.Source
  }
  return $null
}

function Get-WindowsArch {
  if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64" -or $env:PROCESSOR_ARCHITEW6432 -eq "ARM64") {
    return "arm64"
  }
  return "x64"
}

function Install-NodeDirect {
  $arch = Get-WindowsArch
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("canvas-node-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $shasumsPath = Join-Path $tmpDir "SHASUMS256.txt"

  Write-Host "Downloading Node.js latest v22.x for Windows $arch..."
  Invoke-Download "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" $shasumsPath
  $line = (Get-Content -Path $shasumsPath | Where-Object { $_ -match "node-v.*-win-$arch\.msi" } | Select-Object -First 1)
  if (-not $line) {
    Fail "Could not resolve Node.js MSI for Windows $arch."
  }
  $parts = ($line.Trim() -split "\s+") | Where-Object { $_ }
  $expected = $parts[0].ToLowerInvariant()
  $packageName = $parts[1]
  $msiPath = Join-Path $tmpDir $packageName

  Invoke-Download "https://nodejs.org/dist/latest-v22.x/$packageName" $msiPath
  $actual = (Get-FileHash -Path $msiPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    Fail "Node.js checksum verification failed."
  }

  $process = Start-Process msiexec.exe -ArgumentList @("/i", $msiPath, "/quiet", "/norestart") -Wait -PassThru
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    Fail "Node.js MSI installer exited with code $($process.ExitCode)."
  }
  Refresh-Path
}

function Ensure-Node {
  if (Get-NodeCommand) {
    return
  }

  if (-not $AutoInstallDeps) {
    Fail "Node.js is required. Install Node.js or unset CANVAS_AUTO_INSTALL_DEPS=false."
  }

  if (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Installing Node.js with winget..."
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -eq 0) {
      Refresh-Path
    } else {
      Write-Warning "winget Node.js install failed with exit code $LASTEXITCODE; falling back to direct MSI download."
      Install-NodeDirect
    }
  } else {
    Install-NodeDirect
  }

  if (-not (Get-NodeCommand)) {
    Fail "Node.js installation did not add node to PATH. Open a new PowerShell window and re-run this installer."
  }
}

function Add-DockerCliToPath {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"),
    (Join-Path $env:ProgramFiles "Docker\Docker\resources"),
    (Join-Path $env:LOCALAPPDATA "Docker\resources\bin")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path (Join-Path $candidate "docker.exe"))) {
      if ($env:Path -notlike "*$candidate*") {
        $env:Path = "$candidate;$env:Path"
      }
    }
  }
}

function Test-DockerReady {
  Add-DockerCliToPath
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if (-not $docker) {
    return $false
  }
  & $docker.Source info *> $null
  return $LASTEXITCODE -eq 0
}

function Get-DockerDesktopPath {
  $candidates = @(
    (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
    (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) {
      return $candidate
    }
  }
  return $null
}

function Install-DockerDirect {
  $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("canvas-docker-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $installerPath = Join-Path $tmpDir "DockerDesktopInstaller.exe"

  Write-Host "Downloading Docker Desktop for Windows..."
  Invoke-Download "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe" $installerPath
  $process = Start-Process -FilePath $installerPath -ArgumentList @("install", "--quiet") -Wait -PassThru
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    Fail "Docker Desktop installer exited with code $($process.ExitCode)."
  }
  Refresh-Path
}

function Ensure-DockerDesktop {
  if (Test-DockerReady) {
    return
  }

  $dockerDesktop = Get-DockerDesktopPath
  if (-not $dockerDesktop) {
    if (-not $AutoInstallDeps) {
      Fail "Docker Desktop is required. Install Docker Desktop or unset CANVAS_AUTO_INSTALL_DEPS=false."
    }

    if (Get-Command winget -ErrorAction SilentlyContinue) {
      Write-Host "Installing Docker Desktop with winget..."
      winget install --id Docker.DockerDesktop -e --silent --accept-package-agreements --accept-source-agreements
      if ($LASTEXITCODE -eq 0) {
        Refresh-Path
      } else {
        Write-Warning "winget Docker Desktop install failed with exit code $LASTEXITCODE; falling back to direct installer download."
        Install-DockerDirect
      }
    } else {
      Install-DockerDirect
    }
    $dockerDesktop = Get-DockerDesktopPath
  }

  if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    wsl.exe --status *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "WSL2 is not ready. Docker Desktop may ask you to finish WSL setup."
    }
  } else {
    Write-Warning "wsl.exe was not found. Docker Desktop with WSL2 backend may need additional setup."
  }

  if ($dockerDesktop) {
    Write-Host "Starting Docker Desktop..."
    Start-Process $dockerDesktop | Out-Null
  }

  $maxAttempts = if ($env:CANVAS_DOCKER_WAIT_ATTEMPTS) { [int]$env:CANVAS_DOCKER_WAIT_ATTEMPTS } else { 90 }
  for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
    if (Test-DockerReady) {
      return
    }
    Start-Sleep -Seconds 2
  }

  Fail "Docker Desktop is not reachable. Start Docker Desktop and re-run this installer."
}

function Ensure-CliRoot {
  $localRoot = Find-LocalRoot
  if ($localRoot) {
    $mainJs = Join-Path $localRoot "dist-cli\main.js"
    if (-not (Test-Path $mainJs)) {
      if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Fail "npm is required to build the local portable CLI."
      }
      Push-Location $localRoot
      try {
        npm run cli:build
      } finally {
        Pop-Location
      }
    }
    return $localRoot
  }

  return Install-CliBundle
}

function Add-UserPath($Directory) {
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if ($current) {
    $parts = $current -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }
  $exists = $parts | Where-Object { $_.TrimEnd("\") -ieq $Directory.TrimEnd("\") }
  if (-not $exists) {
    $next = (@($parts) + $Directory) -join ";"
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
  }
  if ($env:Path -notlike "*$Directory*") {
    $env:Path = "$Directory;$env:Path"
  }
}

function Install-Wrapper($MainJs) {
  $nodePath = Get-NodeCommand
  if (-not $nodePath) {
    Fail "Node.js command not found."
  }

  New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
  Set-Content -Path $BinPath -Encoding ASCII -Value "@echo off`r`n`"$nodePath`" `"$MainJs`" %*`r`n"
  Add-UserPath $BinDir
}

Ensure-Node
Ensure-DockerDesktop

$RootDir = Ensure-CliRoot
$MainJs = Join-Path $RootDir "dist-cli\main.js"
if (-not (Test-Path $MainJs)) {
  Fail "Portable CLI entrypoint not found: $MainJs"
}

Install-Wrapper $MainJs
Write-Host "Installed CLI wrapper: $BinPath"

$env:CANVAS_CLI_PATH = $BinPath
& (Get-NodeCommand) $MainJs install

if ($env:CANVAS_INSTALL_SERVICE -ne "false") {
  & (Get-NodeCommand) $MainJs service install
}

if ($env:CANVAS_OPEN_BROWSER -ne "false") {
  Start-Process "http://localhost:3456" | Out-Null
}

Write-Host ""
Write-Host "Canvas Notebook is available at http://localhost:3456"
