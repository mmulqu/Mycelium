$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sam2Dir = Join-Path $PSScriptRoot "sam2-server"
$sam2Url = "http://127.0.0.1:7861/health"
$pythonExe = if ($env:SAM2_PYTHON) { $env:SAM2_PYTHON } else { "python" }
$modelSize = if ($env:SAM2_MODEL) { $env:SAM2_MODEL } else { "small" }

function Test-Sam2Health {
  try {
    $response = Invoke-RestMethod -Uri $sam2Url -TimeoutSec 2
    return $response.ok -eq $true
  } catch {
    return $false
  }
}

if (-not (Test-Sam2Health)) {
  Write-Host "SAM2 is not running. Starting local server..." -ForegroundColor Yellow

  $serverCommand = "Set-Location '$sam2Dir'; & '$pythonExe' server.py --model $modelSize --port 7861"
  Start-Process powershell -ArgumentList @(
    "-NoExit",
    "-ExecutionPolicy", "Bypass",
    "-Command", $serverCommand
  ) | Out-Null

  $ready = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Sam2Health) {
      $ready = $true
      break
    }
  }

  if (-not $ready) {
    throw "SAM2 server did not become ready at $sam2Url"
  }

  Write-Host "SAM2 is ready." -ForegroundColor Green
} else {
  Write-Host "SAM2 already running." -ForegroundColor Green
}

Write-Host "Starting Vite dev server..." -ForegroundColor Cyan
Set-Location $projectRoot
npm run dev
