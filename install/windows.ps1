# Local Windows installer for the portable Canvas Notebook server CLI.
# Run from a repository checkout in PowerShell. Release packaging can reuse this
# flow with a prebuilt dist-cli artifact.

$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "This installer is for Windows only."
}

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$BinDir = if ($env:CANVAS_CLI_BIN_DIR) { $env:CANVAS_CLI_BIN_DIR } else { Join-Path $env:LOCALAPPDATA "Canvas Notebook\bin" }
$BinPath = Join-Path $BinDir "canvas-notebook.cmd"

function Require-Command($Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "$Name is required. Install it and re-run this installer."
  }
}

function Test-Docker {
  docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Wait-For-Docker {
  if (Test-Docker) {
    return
  }

  $dockerDesktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dockerDesktop) {
    Write-Host "Starting Docker Desktop..."
    Start-Process $dockerDesktop | Out-Null
  }

  $maxAttempts = if ($env:CANVAS_DOCKER_WAIT_ATTEMPTS) { [int]$env:CANVAS_DOCKER_WAIT_ATTEMPTS } else { 90 }
  for ($attempt = 0; $attempt -lt $maxAttempts; $attempt++) {
    if (Test-Docker) {
      return
    }
    Start-Sleep -Seconds 2
  }

  throw "Docker Desktop is not reachable. Start Docker Desktop and re-run this installer."
}

Require-Command node
Require-Command docker

Wait-For-Docker

$MainJs = Join-Path $RootDir "dist-cli\main.js"
if (-not (Test-Path $MainJs)) {
  Require-Command npm
  Push-Location $RootDir
  try {
    npm run cli:build
  } finally {
    Pop-Location
  }
}

New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Set-Content -Path $BinPath -Encoding ASCII -Value "@echo off`r`nnode `"$MainJs`" %*`r`n"

Write-Host "Installed CLI wrapper: $BinPath"
Write-Host "If needed, add this directory to PATH: $BinDir"

$env:CANVAS_CLI_PATH = $BinPath
node $MainJs install

if ($env:CANVAS_INSTALL_SERVICE -ne "false") {
  node $MainJs service install
}

Write-Host ""
Write-Host "Canvas Notebook is available at http://localhost:3456"
