param(
  [string]$InstallRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$Config = "config.windows.json"
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This installer must run on Windows." }

$node = Get-Command node.exe -ErrorAction Stop
$ytDlp = Get-Command yt-dlp.exe -ErrorAction Stop
$invokeScript = Join-Path $InstallRoot "scripts\invoke-scheduled.ps1"
if (-not (Test-Path $invokeScript)) { throw "Scheduled runner not found: $invokeScript" }

$configPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $InstallRoot $Config }
if (-not (Test-Path $configPath)) { throw "Windows config not found: $configPath" }
$config = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
$cafeEnabled = [bool]($config.cafePublisher -and $config.cafePublisher.enabled)
$cafePython = $null
if ($cafeEnabled) {
  $cafePython = [string]$config.cafePublisher.python
  $cafeScript = [string]$config.cafePublisher.script
  $expectedClubId = [string]$config.cafePublisher.expectedClubId
  $expectedMenuId = [string]$config.cafePublisher.expectedMenuId
  if (-not $cafePython -or -not (Test-Path $cafePython)) {
    throw "Cafe publisher Python is missing: $cafePython"
  }
  if (-not $cafeScript -or -not (Test-Path $cafeScript)) {
    throw "Cafe publisher script is missing: $cafeScript"
  }
  if (-not $expectedClubId -or -not $expectedMenuId) {
    throw "Cafe publisher expectedClubId/expectedMenuId are required."
  }
  Push-Location (Split-Path -Parent $cafeScript)
  try {
    & $cafePython -c "import importlib.metadata as m; import notebook_cafe_auto; assert m.version('notebooklm-py') == '0.7.3'; print('Cafe publisher dependencies: OK')"
    if ($LASTEXITCODE -ne 0) { throw "Cafe publisher dependency probe failed." }
  } finally {
    Pop-Location
  }
}

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
    [string]$WednesdayAt,
    [string]$FridayAt,
    [string]$Slot
  )
  $arguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Slot {1} -Config "{2}"' -f $invokeScript, $Slot, $configPath
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $InstallRoot
  $triggers = @(
    New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Wednesday -At $WednesdayAt
    New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Friday -At $FridayAt
  )
  $task = New-ScheduledTask `
    -Action $action `
    -Trigger $triggers `
    -Principal $principal `
    -Settings $settings `
    -Description "AIMAX live replay automation. The Windows user must remain signed in; the screen may be locked."
  Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
}

Register-LiveReplayTask -TaskName "AIMAX-Live-Replay-Primary" -WednesdayAt "03:10" -FridayAt "01:10" -Slot "primary"
Register-LiveReplayTask -TaskName "AIMAX-Live-Replay-Retry" -WednesdayAt "05:10" -FridayAt "03:10" -Slot "retry"
Register-LiveReplayTask -TaskName "AIMAX-Live-Replay-Final" -WednesdayAt "10:10" -FridayAt "08:10" -Slot "final"

$cafeLabel = if ($cafeEnabled) { "Enabled" } else { "Disabled" }
$result = foreach ($name in @("AIMAX-Live-Replay-Primary", "AIMAX-Live-Replay-Retry", "AIMAX-Live-Replay-Final")) {
  $task = Get-ScheduledTask -TaskName $name
  $info = Get-ScheduledTaskInfo -TaskName $name
  [PSCustomObject]@{
    TaskName = $name
    State = [string]$task.State
    NextRunTime = $info.NextRunTime
    Node = $node.Source
    YtDlp = $ytDlp.Source
    CafePublisher = $cafeLabel
    CafePython = $cafePython
  }
}
$result | ConvertTo-Json -Depth 3
