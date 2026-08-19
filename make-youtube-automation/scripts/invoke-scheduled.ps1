param(
  [ValidateSet("primary", "retry", "final", "manual")]
  [string]$Slot = "manual"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "logs"
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$env:PATH = @(
  (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links"),
  (Join-Path $env:ProgramFiles "nodejs"),
  $env:PATH
) -join ";"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "scheduled-$Slot-$stamp.log"
Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] slot={1} start" -f (Get-Date -Format o), $Slot)

Push-Location $root
try {
  # 러너의 stderr는 실패 원인 그 자체이므로 종료 오류로 승격시키지 않는다.
  # Stop 유지 시 첫 stderr 줄에서 파이프라인이 끊겨 원인이 로그에 남지 않는다.
  $ErrorActionPreference = "Continue"
  & node.exe "scripts\run-scheduled-live.mjs" --config "config.windows.json" --slot $Slot 2>&1 |
    ForEach-Object { $line = "$_"; Write-Host $line; Add-Content -Path $logPath -Encoding UTF8 -Value $line }
  $exitCode = $LASTEXITCODE
} catch {
  $exitCode = 1
  Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] launch-error={1}" -f (Get-Date -Format o), $_.Exception.Message)
} finally {
  Pop-Location
}

Add-Content -Path $logPath -Encoding UTF8 -Value ("[{0}] exit={1}" -f (Get-Date -Format o), $exitCode)
exit $exitCode
