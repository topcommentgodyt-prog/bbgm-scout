# Installs (or removes) the Windows scheduled task that keeps this Courtside folder up to date with GitHub.
#   Install:  powershell -ExecutionPolicy Bypass -File scripts\install-auto-update.ps1
#   Remove:   powershell -ExecutionPolicy Bypass -File scripts\install-auto-update.ps1 -Remove
# The task runs scripts\auto-update.ps1 every 30 minutes (and at sign-in) as you, hidden, with no admin rights.
param([switch]$Remove)

$name = "Courtside auto-update"
if ($Remove) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  Write-Output "Removed the '$name' task."
  exit 0
}

$script = Join-Path $PSScriptRoot "auto-update.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 30)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$opts = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$who = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger @($every, $logon) -Settings $opts -Principal $who -Description "Keeps Courtside (Basketball GM extension) up to date with GitHub. Removes with scripts\install-auto-update.ps1 -Remove." -Force | Out-Null
Write-Output "Installed '$name': checks GitHub every 30 minutes and at sign-in. Log: $env:LOCALAPPDATA\Courtside\auto-update.log"
