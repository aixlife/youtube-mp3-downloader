param(
  [string]$Config = "config.windows.json",
  [string]$Date,
  [ValidateSet("ai", "business")]
  [string]$Kind
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$configPath = if ([IO.Path]::IsPathRooted($Config)) { $Config } else { Join-Path $root $Config }
if (-not (Test-Path $configPath)) { throw "Monitor config not found: $configPath" }
if (($Date -and -not $Kind) -or ($Kind -and -not $Date)) { throw "Date and Kind must be provided together." }
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$env:PATH = @(
  (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"),
  (Join-Path $env:ProgramFiles "nodejs"),
  $env:PATH
) -join ";"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "monitor-$stamp.log"
Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] config={1} start" -f (Get-Date -Format o), $Config)

Push-Location $root
try {
  $ErrorActionPreference = "Continue"
  & node.exe "scripts\preflight-runtime.mjs" --config $configPath --repair --slot monitor 2>&1 |
    ForEach-Object { $line = "$_"; Write-Host $line; Add-Content -Path $logPath -Encoding UTF8 -Value $line }
  $exitCode = $LASTEXITCODE
  if ($exitCode -eq 0) {
    $monitorArgs = @("scripts\run-scheduled-monitor.mjs", "--config", $configPath)
    if ($Date) { $monitorArgs += @("--date", $Date, "--kind", $Kind) }
    & node.exe $monitorArgs 2>&1 |
      ForEach-Object { $line = "$_"; Write-Host $line; Add-Content -Path $logPath -Encoding UTF8 -Value $line }
    $exitCode = $LASTEXITCODE
  } else {
    Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] monitor-skipped=runtime-preflight-failed" -f (Get-Date -Format o))
  }
} catch {
  $exitCode = 1
  Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] launch-error={1}" -f (Get-Date -Format o), $_.Exception.Message)
} finally {
  Pop-Location
}

Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] exit={1}" -f (Get-Date -Format o), $exitCode)
exit $exitCode
