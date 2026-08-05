param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][string]$PrivateKeyPath,
  [string]$SecretDir = (Join-Path $env:LOCALAPPDATA "AIMAX\LiveReplay\secrets")
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "This importer must run on Windows." }
Add-Type -AssemblyName System.Security

function Test-FixedTimeEqual([byte[]]$Left, [byte[]]$Right) {
  if ($Left.Length -ne $Right.Length) { return $false }
  $difference = 0
  for ($index = 0; $index -lt $Left.Length; $index++) {
    $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
  }
  return $difference -eq 0
}

$bundle = Get-Content -Raw -Encoding UTF8 $BundlePath | ConvertFrom-Json
if ($bundle.version -ne 1) { throw "Unsupported encrypted bundle version." }

$rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
$rsa.FromXmlString((Get-Content -Raw -Encoding UTF8 $PrivateKeyPath))
[byte[]]$wrappedKey = [Convert]::FromBase64String([string]$bundle.wrappedKey)
[byte[]]$keyMaterial = $rsa.Decrypt($wrappedKey, $true)
if ($keyMaterial.Length -ne 64) { throw "Invalid decrypted key material." }

$aesKey = New-Object byte[] 32
$hmacKey = New-Object byte[] 32
[Buffer]::BlockCopy($keyMaterial, 0, $aesKey, 0, 32)
[Buffer]::BlockCopy($keyMaterial, 32, $hmacKey, 0, 32)
[byte[]]$iv = [Convert]::FromBase64String([string]$bundle.iv)
[byte[]]$ciphertext = [Convert]::FromBase64String([string]$bundle.ciphertext)
[byte[]]$expectedMac = [Convert]::FromBase64String([string]$bundle.hmac)
[byte[]]$prefix = [Text.Encoding]::UTF8.GetBytes("aimax-live-replay-v1")
[byte[]]$macInput = New-Object byte[] ($prefix.Length + $iv.Length + $ciphertext.Length)
[Buffer]::BlockCopy($prefix, 0, $macInput, 0, $prefix.Length)
[Buffer]::BlockCopy($iv, 0, $macInput, $prefix.Length, $iv.Length)
[Buffer]::BlockCopy($ciphertext, 0, $macInput, ($prefix.Length + $iv.Length), $ciphertext.Length)
$hmac = [Security.Cryptography.HMACSHA256]::new($hmacKey)
$actualMac = $hmac.ComputeHash($macInput)
if (-not (Test-FixedTimeEqual $actualMac $expectedMac)) { throw "Encrypted bundle integrity check failed." }

$aes = [Security.Cryptography.Aes]::Create()
$aes.KeySize = 256
$aes.Mode = [Security.Cryptography.CipherMode]::CBC
$aes.Padding = [Security.Cryptography.PaddingMode]::PKCS7
$aes.Key = $aesKey
$aes.IV = $iv
$decryptor = $aes.CreateDecryptor()
$plainBytes = $decryptor.TransformFinalBlock($ciphertext, 0, $ciphertext.Length)
$payload = [Text.Encoding]::UTF8.GetString($plainBytes) | ConvertFrom-Json
if ([DateTimeOffset]::Parse($payload.expiresAt) -lt [DateTimeOffset]::UtcNow) { throw "Encrypted secret bundle has expired." }

New-Item -ItemType Directory -Path $SecretDir -Force | Out-Null
$count = 0
foreach ($secret in $payload.secrets) {
  if ($secret.service -notmatch '^[a-zA-Z0-9._-]+$') { throw "Invalid secure credential service name." }
  $bytes = [Text.Encoding]::UTF8.GetBytes([string]$secret.value)
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $bytes,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [IO.File]::WriteAllBytes((Join-Path $SecretDir ($secret.service + ".dpapi")), $protected)
  [Array]::Clear($bytes, 0, $bytes.Length)
  $count += 1
}

[Array]::Clear($keyMaterial, 0, $keyMaterial.Length)
[Array]::Clear($aesKey, 0, $aesKey.Length)
[Array]::Clear($hmacKey, 0, $hmacKey.Length)
[Array]::Clear($plainBytes, 0, $plainBytes.Length)
Write-Output ("Imported {0} credentials into Windows user-protected storage." -f $count)
