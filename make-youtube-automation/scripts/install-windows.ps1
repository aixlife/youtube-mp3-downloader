param(
  [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer must run on Windows." }

$node = Get-Command node.exe -ErrorAction Stop
$ytDlp = Get-Command yt-dlp.exe -ErrorAction Stop
$invokeScript = Join-Path $InstallRoot "scripts\invoke-scheduled.ps1"
if (-not (Test-Path $invokeScript)) { throw "Scheduled runner not found: $invokeScript" }

$secretDir = Join-Path $env:LOCALAPPDATA "AIMAX\LiveReplay\secrets"
$requiredSecrets = @(
  "make-youtube-oauth-client-json.dpapi",
  "make-youtube-oauth-token-json.dpapi",
  "make-youtube-database-url.dpapi"
)
foreach ($file in $requiredSecrets) {
  if (-not (Test-Path (Join-Path $secretDir $file))) { throw "Secure credential is missing: $file" }
}

$principal = New-ScheduledTaskPrincipal `
  -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
  -LogonType Interactive `
  -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -WakeToRun `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 8)

function Register-LiveReplayTask {
  param(
    [string]$TaskName,
    [string]$At,
    [string]$Slot
  )
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Slot {1}' -f $invokeScript, $Slot
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $InstallRoot
  $trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Wednesday,Friday -At $At
  $task = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "AIMAX live replay automation. The Windows user must remain signed in; the screen may be locked."
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

Register-LiveReplayTask -TaskName "AIMAX-Live-Replay-Primary" -At "10:00" -Slot "primary"
Register-LiveReplayTask -TaskName "AIMAX-Live-Replay-Retry" -At "14:00" -Slot "retry"

$result = foreach ($name in @("AIMAX-Live-Replay-Primary", "AIMAX-Live-Replay-Retry")) {
  $task = Get-ScheduledTask -TaskName $name
  $info = Get-ScheduledTaskInfo -TaskName $name
  [PSCustomObject]@{
    TaskName = $name
    State = [string]$task.State
    NextRunTime = $info.NextRunTime
    Node = $node.Source
    YtDlp = $ytDlp.Source
  }
}
$result | ConvertTo-Json -Depth 3

