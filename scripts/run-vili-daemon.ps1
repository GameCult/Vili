param(
  [int]$Port = 8824,
  [string]$HostName = "0.0.0.0",
  [string]$StateRoot = "E:\Projects\Vili\.vili"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$LogDir = Join-Path $StateRoot "logs"
$OutLog = Join-Path $LogDir "vili-daemon.out.log"
$ErrLog = Join-Path $LogDir "vili-daemon.err.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

Set-Location $Root
& $Node (Join-Path $Root "scripts\vili-daemon.mjs") --host $HostName --port $Port --state-root $StateRoot 1>> $OutLog 2>> $ErrLog
