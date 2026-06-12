param(
  [int]$Port = 8824,
  [string]$HostName = "0.0.0.0",
  [string]$StateRoot = "E:\Projects\Vili\.vili"
)

$ErrorActionPreference = "Stop"
$PidPath = Join-Path $StateRoot "vili-daemon.pid"
$TaskName = "GameCult\Vili"

if (Test-Path $PidPath) {
  $existingPid = (Get-Content $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($existingPid) {
    $process = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($process) {
      Stop-Process -Id $process.Id -Force
      Start-Sleep -Seconds 1
    }
  }
}

if (Get-ScheduledTask -TaskName "Vili" -TaskPath "\GameCult\" -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName "Vili" -TaskPath "\GameCult\" -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-ScheduledTask -TaskName "Vili" -TaskPath "\GameCult\"
  Start-Sleep -Seconds 3
  node (Join-Path (Split-Path -Parent $PSScriptRoot) "scripts\vili-daemon.mjs") --health --host 127.0.0.1 --port $Port --state-root $StateRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Vili scheduled task started but health check failed."
  }
  Write-Host "Vili restarted through scheduled task $TaskName"
} else {
  & (Join-Path $PSScriptRoot "start-vili-daemon.ps1") -Port $Port -HostName $HostName -StateRoot $StateRoot
}
