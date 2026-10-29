# Run manually in a private local console. No credential arguments, files or environment variables.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$process = $null
$payload = $null
$values = @{}
$stage = 'CONSOLE'
$childDiagnostic = $null
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
    $stage = 'NODE_LOOKUP'
    $node = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $stage = 'ACCOUNT_INPUT'
    $values.account = Read-Hidden 'Existing Cloudflare Account ID (hidden)'
    $stage = 'TOKEN_INPUT'
    $values.token = Read-Hidden 'Existing read-only API token (hidden; no creation/refresh)'
    $stage = 'ACCOUNT_FORMAT'
    if ($values.account -cnotmatch '^[a-f0-9]{32}$') { throw 'STOP' }
    $stage = 'TOKEN_FORMAT'
    if ($values.token.Length -gt 4096 -or $values.token -match '[\s\x00-\x1f\x7f]' -or $values.token.Length -eq 0) { throw 'STOP' }
    $stage = 'PROCESS_START'
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
    $stage = 'STDIN_WRITE'
    $payload = ConvertTo-Json -InputObject $values -Compress
    $process.StandardInput.Write($payload)
    $process.StandardInput.Close()
    $payload = $null
    $values.Clear()
    $stage = 'CHILD_WAIT'
    $output = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        if ($stderr.Trim() -cmatch '\AOWNER_EVIDENCE_STOPPED phase=(INPUT|COLLECT) apiAttempted=(YES|NO) code=(CREDENTIALS_UNAVAILABLE|AUTHORIZATION_REJECTED|REDIRECT_REJECTED|HTTP_REJECTED|NETWORK_OR_TIMEOUT|RESPONSE_INVALID|RESPONSE_TOO_LARGE|API_RESULT_REJECTED|VALIDATION_OR_INTERNAL)( api=(ACCOUNT|SERVICE|VERSIONS|DEPLOYMENTS|ENVIRONMENT|BINDINGS|ROUTES|DOMAINS|SUBDOMAIN|SCHEDULES|NAMESPACES|UNKNOWN) http=(NONE|[1-5][0-9]{2}) request=([1-9]|1[0-9]|2[0-6]))?\z') { $childDiagnostic = $stderr.Trim() }
        throw 'STOP'
    }
    Write-Output $output.Trim()
} catch {
    # Never print exception records, raw stderr, input, response bodies or URLs.
    Write-Output 'OWNER_EVIDENCE_STOPPED'
    if ($null -ne $childDiagnostic) { Write-Output $childDiagnostic }
    else { Write-Output ('OWNER_EVIDENCE_DIAGNOSTIC stage=' + $stage + ' apiAttempted=' + $(if ($stage -eq 'CHILD_WAIT' -or $stage -eq 'STDIN_WRITE') { 'UNKNOWN' } else { 'NO' })) }
    exit 1
} finally {
    $payload = $null
    $values.Clear()
    if ($null -ne $process) { $process.Dispose() }
}
