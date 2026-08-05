param(
  [Parameter(Mandatory = $true)][string]$ServerBase
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
if ($env:OS -ne "Windows_NT") { throw "This bootstrap must run on Windows." }

$installRoot = Join-Path $env:LOCALAPPDATA "AIMAX\LiveReplay"
$tempRoot = Join-Path $env:TEMP ("aimax-live-bootstrap-" + [Guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tempRoot "package.zip"
$extractPath = Join-Path $tempRoot "package"
$privateKeyPath = Join-Path $tempRoot "private.xml"
$publicKeyPath = Join-Path $tempRoot "public.xml"
$bundlePath = Join-Path $tempRoot "secret-bundle.json"

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
  Invoke-WebRequest -UseBasicParsing -Uri ($ServerBase + "/package.zip") -OutFile $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force
  New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
  Copy-Item -Path (Join-Path $extractPath "*") -Destination $installRoot -Recurse -Force

  Push-Location $installRoot
  try {
    $dependenciesReady = `
      (Test-Path (Join-Path $installRoot "node_modules\@prisma\client")) -and `
      (Test-Path (Join-Path $installRoot "node_modules\googleapis")) -and `
      (Test-Path (Join-Path $installRoot "node_modules\playwright-core"))
    if (-not $dependenciesReady) {
      & npm.cmd ci --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }
    & npx.cmd prisma generate
    if ($LASTEXITCODE -ne 0) { throw "Prisma client generation failed." }
  } finally {
    Pop-Location
  }

  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider(4096)
  [IO.File]::WriteAllText($privateKeyPath, $rsa.ToXmlString($true), (New-Object Text.UTF8Encoding($false)))
  [IO.File]::WriteAllText($publicKeyPath, $rsa.ToXmlString($false), (New-Object Text.UTF8Encoding($false)))
  Invoke-WebRequest -UseBasicParsing -Method Put -Uri ($ServerBase + "/public-key") -InFile $publicKeyPath -ContentType "text/plain" | Out-Null

  $downloaded = $false
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri ($ServerBase + "/secret-bundle") -OutFile $bundlePath
      if ((Get-Item $bundlePath).Length -gt 0) { $downloaded = $true; break }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  if (-not $downloaded) { throw "Timed out waiting for the encrypted credential bundle." }

  & (Join-Path $installRoot "scripts\import-windows-secrets.ps1") `
    -BundlePath $bundlePath `
    -PrivateKeyPath $privateKeyPath
  & (Join-Path $installRoot "scripts\install-windows.ps1") -InstallRoot $installRoot

  Invoke-WebRequest -UseBasicParsing -Method Post -Uri ($ServerBase + "/complete") -Body "ok" | Out-Null
  Write-Output "AIMAX live replay Windows setup complete."
} finally {
  Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
