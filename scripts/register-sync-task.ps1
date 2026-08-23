#requires -Version 7
<#
  Registers the "OLX home sync" scheduled task: twice daily (default 09:00 +
  21:00 = 12 h cadence), runs whether you are logged on or not (S4U - no
  stored password), WAKES THE PC from sleep, never overlaps itself, hard
  limit 2 h per run. Progress lands in logs\sync.log.

  Windows must allow wake timers: Power Options -> plan -> advanced settings
  -> Sleep -> "Allow wake timers" -> Important Wake Timers Only (or Enable),
  ideally for both "Plugged in" and "On battery".

  Usage:  pwsh -File scripts\register-sync-task.ps1 [-At1 09:00] [-At2 21:00]
#>
param([string]$At1 = '09:00', [string]$At2 = '21:00')
$ErrorActionPreference = 'Stop'

# Creating an S4U (run-whether-logged-on-or-not) task needs an admin token once.
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Output 'elevation needed to register the task - accepting the UAC prompt...'
  $relaunch = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  foreach ($p in 'At1', 'At2') {
    if ($PSBoundParameters[$p]) { $relaunch += "-$p"; $relaunch += $PSBoundParameters[$p] }
  }
  try {
    Start-Process pwsh -Verb RunAs -Wait -ArgumentList $relaunch
  } catch {
    throw "elevation was declined - task not registered ($($_.Exception.Message))"
  }
  if (Get-ScheduledTask -TaskName 'OLX home sync' -ErrorAction SilentlyContinue) {
    Write-Output 'task registered.'
  } else {
    throw 'task still missing after elevation - check the elevated window output'
  }
  return
}

$repo   = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'sync-to-instance.ps1'

$action    = New-ScheduledTaskAction -Execute 'pwsh.exe' `
               -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" `
               -WorkingDirectory $repo
$triggers  = @( (New-ScheduledTaskTrigger -Daily -At $At1),
                (New-ScheduledTaskTrigger -Daily -At $At2) )
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun `
               -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
               -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
               -LogonType S4U -RunLevel Limited

Register-ScheduledTask -TaskName 'OLX home sync' -Action $action -Trigger $triggers `
  -Settings $settings -Principal $principal -Force |
  Out-Null

$info = Get-ScheduledTaskInfo -TaskName 'OLX home sync'
Write-Output ("task registered · next run: {0} · wake-to-run: {1}" -f `
  $info.NextRunTime, (Get-ScheduledTask 'OLX home sync').Settings.WakeToRun)
Write-Output "logs will land in $(Join-Path $repo 'logs\sync.log')"