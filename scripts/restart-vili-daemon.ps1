param(
  [int]$Port = 8824,
  [string]$HostName = "0.0.0.0",
  [string]$StateRoot = "E:\Projects\Vili\.vili"
)

$ErrorActionPreference = "Stop"
$PidPath = Join-Path $StateRoot "vili-daemon.pid"

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

& (Join-Path $PSScriptRoot "start-vili-daemon.ps1") -Port $Port -HostName $HostName -StateRoot $StateRoot
