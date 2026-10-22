# One sample line per interval: {"quns":n,"freeMiB":n,"util3d":n}. Numbers only; no process identity is read.
param([int]$ParentPid, [int]$IntervalMs = 15000)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Vili -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'
while ($true) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  try {
    $quns = 0
    if ([Vili.Shell]::SHQueryUserNotificationState([ref]$quns) -ne 0) { throw 'quns' }
    $free = nvidia-smi.exe --query-gpu=memory.free --format=csv,noheader,nounits | Select-Object -First 1
    if ($LASTEXITCODE -ne 0) { throw 'smi' }
    $sum = (Get-Counter '\GPU Engine(*engtype_3D)\Utilization Percentage' -SampleInterval 1 -MaxSamples 1).CounterSamples | Measure-Object -Property CookedValue -Sum
    $line = [ordered]@{ quns = [int]$quns; freeMiB = [int]$free; util3d = [math]::Min(100, [math]::Round([double]$sum.Sum, 1)) } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch { }
  $rest = $IntervalMs - $clock.ElapsedMilliseconds
  if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}
