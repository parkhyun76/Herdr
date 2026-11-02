# Copies this repo's mods and layouts into Herdr (~/.config/herdr-app), where Herdr hot-reloads them.
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

# Our layout files, one by one: the shipped layouts and layouts/.state live in the same folder.
$herdrLayouts = Join-Path $HOME ".config\herdr-app\layouts"
foreach ($layout in Get-ChildItem -LiteralPath (Join-Path $PSScriptRoot "..\layouts") -Filter *.json -File) {
    Copy-Item -LiteralPath $layout.FullName -Destination $herdrLayouts -Force
    Write-Output "deployed layout $($layout.Name) -> $herdrLayouts"
}
$global:LASTEXITCODE = 0
