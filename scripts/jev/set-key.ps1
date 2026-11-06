param([string]$StateDirectory = (Join-Path $env:LOCALAPPDATA 'Herdr/jev'))
$ErrorActionPreference = 'Stop'
# Interactive only: neither the key nor its decrypted value is a command argument.
$secret = Read-Host 'TypeSafe API key (hidden)' -AsSecureString
try {
    if ($secret.Length -lt 8) { throw 'No valid key was entered. Nothing was saved.' }
    [void][IO.Directory]::CreateDirectory($StateDirectory)
    $destination = Join-Path $StateDirectory 'credential.dpapi'
    $temporary = $destination + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary, ($secret | ConvertFrom-SecureString), [Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $destination) { [IO.File]::Replace($temporary, $destination, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $destination) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
    Write-Host 'Key saved with Windows user encryption. Herdr does not need to restart.'
} finally { $secret.Dispose() }
