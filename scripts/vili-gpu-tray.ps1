# The household's switch for Raven's GPU: one tray icon in the interactive session. It shows whether
# Vili may use the GPU and flips it with one click. It holds no state of its own: the icon and tooltip
# are a lowering of GET /gpu-permission, and the click is one POST with an absolute value.
param([int]$Port = 8824, [int]$PollMs = 5000)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mutex = New-Object System.Threading.Mutex($false, 'Local\GameCult.ViliGpuTray')
if (-not $mutex.WaitOne(0)) { exit 0 }

$base = "http://127.0.0.1:$Port/gpu-permission"
$script:state = 'down'
$script:jobRunning = $false
$clock = [Diagnostics.Stopwatch]::StartNew()
$script:lastToggleMs = -10000

function New-TrayIcon([string]$kind) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  if ($kind -eq 'on') {
    $g.FillEllipse([System.Drawing.Brushes]::LimeGreen, 1, 1, 13, 13)
  } elseif ($kind -eq 'off') {
    $g.FillEllipse([System.Drawing.Brushes]::Crimson, 1, 1, 13, 13)
    $g.FillRectangle([System.Drawing.Brushes]::White, 4, 7, 8, 2)
  } else {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::Gray), 2
    $g.DrawEllipse($pen, 2, 2, 11, 11)
    $pen.Dispose()
  }
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  return $icon
}

$icons = @{ on = (New-TrayIcon 'on'); off = (New-TrayIcon 'off'); down = (New-TrayIcon 'down') }

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$item = $menu.Items.Add('Let Vili use the GPU')
$tray.ContextMenuStrip = $menu

function Show-State {
  $tray.Icon = $icons[$script:state]
  $item.Checked = ($script:state -eq 'on')
  $item.Enabled = ($script:state -ne 'down')
  if ($script:state -eq 'on' -and $script:jobRunning) { $tray.Text = 'Vili may use the GPU (making a clip). Click to stop.' }
  elseif ($script:state -eq 'on') { $tray.Text = 'Vili may use the GPU. Click to stop.' }
  elseif ($script:state -eq 'off') { $tray.Text = 'Vili may not use the GPU. Click to allow.' }
  else { $tray.Text = 'Vili is not running, so it is not using the GPU.' }
}

function Update-State {
  try {
    $r = Invoke-RestMethod -Uri $base -Method Get -TimeoutSec 2
    if ($r.allowed -eq $true) { $script:state = 'on' } elseif ($r.allowed -eq $false) { $script:state = 'off' } else { $script:state = 'down' }
    $script:jobRunning = ($r.jobRunning -eq $true)
  } catch {
    $script:state = 'down'
    $script:jobRunning = $false
  }
  Show-State
}

function Switch-Permission {
  try {
    if ($clock.ElapsedMilliseconds - $script:lastToggleMs -lt 1000) { return }
    $script:lastToggleMs = $clock.ElapsedMilliseconds
    if ($script:state -eq 'down') {
      $tray.ShowBalloonTip(3000, 'Vili', 'Vili is not running. Nothing to change.', 'Info')
      return
    }
    $body = ConvertTo-Json -Compress @{ allowed = ($script:state -ne 'on') }
    try {
      [void](Invoke-RestMethod -Uri $base -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 2)
    } catch {
      $tray.ShowBalloonTip(3000, 'Vili', 'Could not reach Vili. Nothing changed.', 'Warning')
    }
    Update-State
  } catch {
  }
}

$tray.Add_MouseUp({
  param($sender, $e)
  try { if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Switch-Permission } } catch {}
})
$item.Add_Click({ try { Switch-Permission } catch {} })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick({ try { Update-State } catch {} })

Update-State
$tray.Visible = $true
$timer.Start()
[System.Windows.Forms.Application]::Run()
