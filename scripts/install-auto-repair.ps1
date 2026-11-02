param(
    [string]$AppHome = (Join-Path $env:USERPROFILE '.config/herdr-app'),
    [string]$Executable = (Join-Path $env:LOCALAPPDATA 'Programs/herdr-app/herdr-app.exe'),
    [string]$Zig,
    [string]$Libclang,
    [switch]$Disable
)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$codexCommand = Get-Command codex.exe -ErrorAction SilentlyContinue
if (-not $codexCommand) {
    $npmRoot = & npm root -g
    $codexPath = Join-Path $npmRoot '@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'
    if (-not (Test-Path -LiteralPath $codexPath)) { throw 'Native Codex executable was not found. Install the Codex CLI first.' }
} else { $codexPath = $codexCommand.Source }
$nodeCommand = Get-Command node.exe -ErrorAction Stop
$diagnostics = Join-Path $AppHome 'diagnostics'
New-Item -ItemType Directory -Path $diagnostics -Force | Out-Null
$configFile = Join-Path $diagnostics 'auto-repair.json'
if (Test-Path -LiteralPath $configFile) { Copy-Item -LiteralPath $configFile -Destination "$configFile.bak" -Force }
$config = [ordered]@{
    enabled = -not $Disable
    repository = $repository
    node = $nodeCommand.Source
    codex = $codexPath
    app_home = [IO.Path]::GetFullPath($AppHome)
    executable = [IO.Path]::GetFullPath($Executable)
    max_jobs_per_day = 3
    cooldown_seconds = 900
    zig = $Zig
    libclang = $Libclang
}
[IO.File]::WriteAllText("$configFile.tmp",($config | ConvertTo-Json),(New-Object Text.UTF8Encoding $false))
Move-Item -LiteralPath "$configFile.tmp" -Destination $configFile -Force
Write-Output "Automatic repair enabled=$($config.enabled); diagnostics=$diagnostics"
