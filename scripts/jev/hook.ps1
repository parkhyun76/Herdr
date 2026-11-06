param(
    [ValidateSet('claude','codex')][string]$Agent = 'codex',
    [ValidateSet('hook','probe')][string]$Mode = 'hook'
)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
$secret = $null
$pointer = [IntPtr]::Zero
$env:HERDR_JEV_CREDENTIAL_ERROR = $null
$env:HERDR_JEV_CREDENTIAL_ERROR_CODE = $null
try {
    $runtime = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime.json') -Encoding UTF8 -Raw | ConvertFrom-Json
    $credential = Join-Path $PSScriptRoot 'credential.dpapi'
    if (Test-Path -LiteralPath $credential) {
        try {
            # Git Bash/PowerShell 7 can pass a module search path that cannot load
            # Windows PowerShell's security module. Load the matching built-in one.
            Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
            $secret = Get-Content -LiteralPath $credential -Encoding UTF8 -Raw | ConvertTo-SecureString
            $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
            $env:TYPESAFE_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        } catch {
            $env:TYPESAFE_API_KEY = ''; $env:HERDR_JEV_CREDENTIAL_ERROR = '1'
            $env:HERDR_JEV_CREDENTIAL_ERROR_CODE = ($_.FullyQualifiedErrorId -replace '[^a-zA-Z0-9_.:,\-]', '').Substring(0, [Math]::Min(160, ($_.FullyQualifiedErrorId -replace '[^a-zA-Z0-9_.:,\-]', '').Length))
        }
    } elseif (-not $env:TYPESAFE_API_KEY) {
        $env:TYPESAFE_API_KEY = [Environment]::GetEnvironmentVariable('TYPESAFE_API_KEY', 'User')
    }
    # The node process inherits stdin directly; no PowerShell pipeline re-encodes Korean JSON.
    & $runtime.node (Join-Path $PSScriptRoot 'jev.cjs') $Mode $Agent
    if ($LASTEXITCODE -ne 0 -and $Mode -eq 'probe') { exit $LASTEXITCODE }
} catch {
    [Console]::Out.WriteLine('{"systemMessage":"Herdr Jev could not start; continuing without Jev."}')
    if ($Mode -eq 'probe') { exit 1 }
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    if ($secret) { $secret.Dispose() }
    $env:TYPESAFE_API_KEY = $null
}
