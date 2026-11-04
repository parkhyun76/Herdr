param([Parameter(Mandatory = $true)][string]$Path)

$ErrorActionPreference = 'Stop'
try {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw 'File not found.' }
    Start-Process -FilePath $Path -ErrorAction Stop
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
