param(
  [string]$TaskName = "GameCult\ViliTray",
  [int]$Port = 8824
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$HiddenLauncher = Join-Path $PSScriptRoot "run-hidden-powershell.vbs"
$TrayScript = Join-Path $PSScriptRoot "vili-gpu-tray.ps1"
$UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$Action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "//B //nologo `"$HiddenLauncher`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -STA -File `"$TrayScript`" -Port $Port"
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$Principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Write-Host "Installed scheduled task $TaskName"
