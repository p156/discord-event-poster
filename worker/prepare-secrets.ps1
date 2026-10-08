# Run interactively on your own machine. Never run in a recorded agent console.
$ErrorActionPreference = 'Stop'
$destination = Join-Path $PSScriptRoot 'work\new-secrets.json'
if (Test-Path -LiteralPath $destination) { throw 'Existing secret file found. Move it safely before generating new values.' }
$secure = Read-Host 'App password (at least 16 characters)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  if ($plain.Length -lt 16 -or $plain.Length -gt 256) { throw 'Use 16 to 256 characters.' }
  $salt = New-Object byte[] 16
  $signing = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($salt); $rng.GetBytes($signing)
  $pbkdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($plain,$salt,600000,[Security.Cryptography.HashAlgorithmName]::SHA256)
  $digest = $pbkdf.GetBytes(32)
  $saltHex = [BitConverter]::ToString($salt).Replace('-','').ToLowerInvariant()
  $hashHex = [BitConverter]::ToString($digest).Replace('-','').ToLowerInvariant()
  $keyHex = [BitConverter]::ToString($signing).Replace('-','').ToLowerInvariant()
  $payload = @{ APP_PASSWORD_HASH = 'pbkdf2-sha256$600000$' + $saltHex + '$' + $hashHex; SESSION_SIGNING_KEY = $keyHex }
  New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
  [IO.File]::WriteAllText($destination,($payload | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
  Write-Host 'Created worker/work/new-secrets.json. Values were not printed. Keep private and remove after configuration.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plain = $null
  if ($pbkdf) { $pbkdf.Dispose() }; if ($rng) { $rng.Dispose() }
}
