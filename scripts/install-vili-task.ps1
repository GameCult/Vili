param(
  [string]$TaskName = "GameCult\Vili",
  [int]$Port = 8824,
  [string]$HostName = "0.0.0.0",
  [string]$StateRoot = "E:\Projects\Vili\.vili",
  [string]$IdunnRudpHealth = "10.77.0.2:17870",
  [string]$IdunnDaemon = "vili",
  [string]$IdunnHealthContract = "vili.cultnet-rudp-animation-health",
  [int]$IdunnHealthIntervalSeconds = 15
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$HiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"
$RunScript = Join-Path $PSScriptRoot "start-vili-daemon.ps1"
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$HiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`" -Port $Port -HostName `"$HostName`" -StateRoot `"$StateRoot`" -IdunnRudpHealth `"$IdunnRudpHealth`" -IdunnDaemon `"$IdunnDaemon`" -IdunnHealthContract `"$IdunnHealthContract`" -IdunnHealthIntervalSeconds $IdunnHealthIntervalSeconds"
$Trigger = New-ScheduledTaskTrigger -AtStartup
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Write-Host "Installed scheduled task $TaskName"
