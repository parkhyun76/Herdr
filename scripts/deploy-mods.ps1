# Copies this repo's mods into Herdr (~/.config/herdr-app/mods), where Herdr hot-reloads them.
# The repo is the source of truth; edit here, then run:  pwsh scripts/deploy-mods.ps1
# Files Herdr writes into mod folders (jsconfig.json, gpui-kit.d.ts) are neither copied nor deleted.
$ErrorActionPreference = "Stop"

$source = Join-Path $PSScriptRoot "..\mods"
$herdrMods = Join-Path $HOME ".config\herdr-app\mods"
if (-not (Test-Path $herdrMods)) { throw "Herdr mods folder not found: $herdrMods" }

foreach ($mod in Get-ChildItem -LiteralPath $source -Directory) {
    $dest = Join-Path $herdrMods $mod.Name
    # /MIR also removes files deleted from the repo; /XF keeps Herdr's own files out of it.
    robocopy $mod.FullName $dest /MIR /XF jsconfig.json gpui-kit.d.ts /NJH /NJS /NP /NDL | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy failed for $($mod.Name) (exit $LASTEXITCODE)" }
    Write-Output "deployed $($mod.Name) -> $dest"
}
$global:LASTEXITCODE = 0
