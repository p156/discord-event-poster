# Run manually in a private local console. No credential arguments, files or environment variables.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$process = $null
$payload = $null
$values = @{}
function Read-Hidden([string]$label) {
    $secure = Read-Host $label -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr); $secure.Dispose() }
}
try {
    if ($args.Count -ne 0 -or [Console]::IsInputRedirected) { throw 'STOP' }
    $confirm = Read-Host 'Fixed Cloudflare production metadata GET only. Type READ to connect'
    if ($confirm -cne 'READ') { throw 'STOP' }
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $values.account = Read-Hidden 'Existing Cloudflare Account ID (hidden)'
    $values.token = Read-Hidden 'Existing read-only API token (hidden; no creation/refresh)'
    if ($values.account -cnotmatch '^[a-f0-9]{32}$' -or $values.token.Length -gt 4096 -or $values.token -match '[\s\x00-\x1f\x7f]' -or $values.token.Length -eq 0) { throw 'STOP' }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.Arguments = '"' + (Join-Path $PSScriptRoot 'owner-readonly-evidence.cjs') + '"'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    # Prevent inherited Node hooks/debug options from observing stdin credentials.
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE','SSLKEYLOGFILE')) { $info.EnvironmentVariables.Remove($key) }
    $process = [Diagnostics.Process]::Start($info)
    $payload = ConvertTo-Json -InputObject $values -Compress
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $payload = $null
    $values.Clear()
    $output = $process.StandardOutput.ReadToEnd()
    $null = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) { throw 'STOP' }
    Write-Output $output.Trim()
} catch {
    # Never print exception records, raw stderr, input, response bodies or URLs.
    Write-Output 'OWNER_EVIDENCE_STOPPED'
    exit 1
} finally {
    $payload = $null
    $values.Clear()
    if ($null -ne $process) { $process.Dispose() }
}
