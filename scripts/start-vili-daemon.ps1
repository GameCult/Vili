param(
  [int]$Port = 8824,
  [string]$HostName = "0.0.0.0",
  [string]$StateRoot = "E:\Projects\Vili\.vili",
  [string]$IdunnRudpHealth = "10.77.0.2:17870",
  [string]$IdunnDaemon = "vili",
  [string]$IdunnHealthContract = "vili.cultnet-rudp-animation-health",
  [int]$IdunnHealthIntervalSeconds = 15
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$LogDir = Join-Path $StateRoot "logs"
$PidPath = Join-Path $StateRoot "vili-daemon.pid"
$OutLog = Join-Path $LogDir "vili-daemon.out.log"
$ErrLog = Join-Path $LogDir "vili-daemon.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (Test-Path $PidPath) {
  $existingPid = (Get-Content $PidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($existingPid -and (Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue)) {
    & $Node (Join-Path $Root "scripts\vili-daemon.mjs") --health --host 127.0.0.1 --port $Port --state-root $StateRoot
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Vili already healthy on port $Port with PID $existingPid"
      exit 0
    }
  }
}

$args = @(
  (Join-Path $Root "scripts\vili-daemon.mjs"),
  "--host", $HostName,
  "--port", "$Port",
  "--state-root", $StateRoot,
  "--idunn-rudp-health", $IdunnRudpHealth,
  "--idunn-daemon", $IdunnDaemon,
  "--idunn-health-contract", $IdunnHealthContract,
  "--idunn-health-interval-seconds", "$IdunnHealthIntervalSeconds"
)

$process = Start-Process -FilePath $Node -ArgumentList $args -WorkingDirectory $Root -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -PassThru
Set-Content -Path $PidPath -Value $process.Id
Start-Sleep -Seconds 2
& $Node (Join-Path $Root "scripts\vili-daemon.mjs") --health --host 127.0.0.1 --port $Port --state-root $StateRoot
if ($LASTEXITCODE -ne 0) {
  throw "Vili did not become healthy. See $ErrLog"
}
Write-Host "Vili started on $HostName`:$Port with PID $($process.Id)"
