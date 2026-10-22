# One sample line per interval: {"quns":n,"freeMiB":n,"util3d":n,"engines":n}. Numbers only; no process
# identity is read. engines is how many 3D-engine counters the path resolved: zero means the path is
# wrong, and the gate treats that as a probe fault.
param([int]$ParentPid, [int]$IntervalMs = 15000, [string]$Util3dPath)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Vili -Name Shell -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'
while ($true) {
  $clock = [Diagnostics.Stopwatch]::StartNew()
  if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit }
  try {
    $quns = 0
    if ([Vili.Shell]::SHQueryUserNotificationState([ref]$quns) -ne 0) { throw 'quns' }
    $smi = @(nvidia-smi.exe --query-gpu=memory.free --format=csv,noheader,nounits)
    if ($LASTEXITCODE -ne 0) { throw 'smi' }
    $free = $smi[0]
    $counters = @((Get-Counter $Util3dPath -SampleInterval 1 -MaxSamples 1).CounterSamples)
    $sum = $counters | Measure-Object -Property CookedValue -Sum
    $line = [ordered]@{ quns = [int]$quns; freeMiB = [int]$free; util3d = [math]::Min(100, [math]::Round([double]$sum.Sum, 1)); engines = $counters.Count } | ConvertTo-Json -Compress
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
  } catch { }
  $rest = $IntervalMs - $clock.ElapsedMilliseconds
  if ($rest -gt 0) { Start-Sleep -Milliseconds $rest }
}
