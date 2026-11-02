param([Parameter(Mandatory)][string]$Diagnostics,[Parameter(Mandatory)][string]$Executable,[Parameter(Mandatory)][int]$ParentPid)
$ErrorActionPreference = 'Stop'
function FileHash([string]$Path) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}
$pending = Join-Path $Diagnostics 'pending-native.json'
if (-not (Test-Path -LiteralPath $pending)) { exit 0 }
$repair = Get-Content -LiteralPath $pending -Raw | ConvertFrom-Json
$candidate = [IO.Path]::GetFullPath($repair.candidate)
$jobs = [IO.Path]::GetFullPath((Join-Path $Diagnostics 'jobs')) + [IO.Path]::DirectorySeparatorChar
if (-not $candidate.StartsWith($jobs,[StringComparison]::OrdinalIgnoreCase)) { throw 'Candidate is outside repair jobs.' }
if ([IO.Path]::GetFullPath($Executable) -ne [IO.Path]::GetFullPath($repair.executable)) { throw 'Installed executable changed.' }
if ((FileHash $candidate) -ne $repair.sha256) { throw 'Candidate checksum mismatch.' }
$config = Get-Content -LiteralPath (Join-Path $Diagnostics 'auto-repair.json') -Raw | ConvertFrom-Json
if (-not $config.enabled -or $config.repository -ne $repair.repository -or $config.executable -ne $Executable) { throw 'Repair is disabled or source changed.' }
$head = & git -C $repair.repository rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $repair.commit) { throw 'Source changed since verification.' }
if (& git -C $repair.repository status --porcelain --untracked-files=normal) { throw 'Source has local edits; repair deferred.' }
$parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
if ($parent) { if (-not $parent.WaitForExit(60000)) { throw 'App is still running.' } }
if ((FileHash $Executable) -ne $repair.expected_sha256) { throw 'Installed binary changed; repair deferred.' }
$backup = Join-Path (Split-Path -Parent $candidate) 'before-herdr-app.exe'
Copy-Item -LiteralPath $Executable -Destination $backup
$stage = "$Executable.repair"
$rollback = "$Executable.repair-backup"
if (Test-Path -LiteralPath $rollback) { throw 'A previous replacement backup needs inspection.' }
try {
    Copy-Item -LiteralPath $candidate -Destination $stage -Force
    [IO.File]::Replace($stage,$Executable,$rollback)
    if ((FileHash $Executable) -ne $repair.sha256) { throw 'Installed checksum mismatch.' }
    Move-Item -LiteralPath $pending -Destination (Join-Path (Split-Path -Parent $candidate) 'installed-native.json')
    Remove-Item -LiteralPath $rollback
} catch { Copy-Item -LiteralPath $backup -Destination $Executable -Force; throw }
# The next user launch uses the repaired binary. Core and AI processes stay alive.
