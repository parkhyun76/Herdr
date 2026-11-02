# Checks that Herdr still runs this repo's customizations (run it after a Herdr update).
#   pwsh scripts/check-herdr.ps1        report only
#   pwsh scripts/check-herdr.ps1 -Fix   redeploy mods/layout and switch back to our layout, then re-check
# Exit code: 0 = all good, 1 = something needs attention.
param([switch]$Fix)
$ErrorActionPreference = "Stop"

$repo = Resolve-Path (Join-Path $PSScriptRoot "..")
$herdr = Join-Path $HOME ".config\herdr-app"
$layoutName = "main-worktree-folding"
# Files Herdr writes into every mod folder itself; never part of the comparison.
$herdrOwn = @("jsconfig.json", "gpui-kit.d.ts")

function Get-Files($dir) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $dir)) { return $map }
    Get-ChildItem -LiteralPath $dir -Recurse -File |
        Where-Object { $herdrOwn -notcontains $_.Name -and $_.Extension -ne ".error" } |
        ForEach-Object { $map[$_.FullName.Substring($dir.Length + 1)] = (Get-FileHash -LiteralPath $_.FullName).Hash }
    return $map
}

# Differences between two folders: "+x" only in $b, "-x" only in $a, "~x" differs.
function Compare-Folders($a, $b) {
    $fa = Get-Files $a; $fb = Get-Files $b; $out = @()
    foreach ($k in $fa.Keys) { if (-not $fb.ContainsKey($k)) { $out += "-$k" } elseif ($fa[$k] -ne $fb[$k]) { $out += "~$k" } }
    foreach ($k in $fb.Keys) { if (-not $fa.ContainsKey($k)) { $out += "+$k" } }
    return $out
}

function Invoke-Check {
    $problems = [System.Collections.Generic.List[string]]::new()
    # The exe's own version (`herdr-app --version` intermittently loses its stdout when piped).
    $exe = Get-Command herdr-app -ErrorAction SilentlyContinue
    if (-not $exe) { $problems.Add("herdr-app not found on PATH"); return $problems }
    Write-Host "Herdr version: $((Get-Item -LiteralPath $exe.Source).VersionInfo.ProductVersion)"

    foreach ($mod in Get-ChildItem -LiteralPath (Join-Path $repo "mods") -Directory) {
        $deployed = Join-Path $herdr "mods\$($mod.Name)"
        if (-not (Test-Path -LiteralPath $deployed)) { $problems.Add("mod $($mod.Name): missing in Herdr"); continue }
        $diff = Compare-Folders $mod.FullName $deployed
        if ($diff) { $problems.Add("mod $($mod.Name): differs from repo ($($diff -join ', '))") }
        Get-ChildItem -LiteralPath $deployed -Filter *.error -File | ForEach-Object { $problems.Add("mod $($mod.Name): $($_.Name) = $((Get-Content -Raw -LiteralPath $_.FullName).Trim())") }

        # The shipped mod this clone came from: has Herdr changed it since we cloned?
        $base = (Get-Content -Raw -LiteralPath (Join-Path $mod.FullName "mod.json") | ConvertFrom-Json).cloned_from
        if (-not $base) { continue }
        $snapshot = Join-Path $repo "upstream\$($base.version)\mods\$($base.name)"
        if (-not (Test-Path -LiteralPath $snapshot)) { $problems.Add("mod $($mod.Name): no upstream snapshot for $($base.name) $($base.version)"); continue }
        $upstream = Compare-Folders $snapshot (Join-Path $herdr "mods\$($base.name)")
        if ($upstream) { $problems.Add("mod $($mod.Name): shipped '$($base.name)' changed since $($base.version) - merge upstream changes into the clone ($($upstream -join ', '))") }
    }

    foreach ($layout in Get-ChildItem -LiteralPath (Join-Path $repo "layouts") -Filter *.json -File) {
        $deployed = Join-Path $herdr "layouts\$($layout.Name)"
        if (-not (Test-Path -LiteralPath $deployed)) { $problems.Add("layout $($layout.Name): missing in Herdr") }
        elseif ((Get-FileHash -LiteralPath $layout.FullName).Hash -ne (Get-FileHash -LiteralPath $deployed).Hash) { $problems.Add("layout $($layout.Name): differs from repo") }
    }

    Get-ChildItem -LiteralPath $herdr -Filter *.error -File | ForEach-Object { $problems.Add("$($_.Name) = $((Get-Content -Raw -LiteralPath $_.FullName).Trim())") }
    Get-ChildItem -LiteralPath (Join-Path $herdr "layouts") -Filter *.error -File | ForEach-Object { $problems.Add("layouts\$($_.Name) = $((Get-Content -Raw -LiteralPath $_.FullName).Trim())") }
    # Left behind when Herdr restored a shipped file someone edited, or by the escape-hatch reset.
    Get-ChildItem -LiteralPath (Join-Path $herdr "mods"), (Join-Path $herdr "layouts"), $herdr |
        Where-Object { $_.Name -match "-edited|\.reset-|\.old-" } |
        ForEach-Object { $problems.Add("leftover from a Herdr restore/reset: $($_.Name)") }

    $status = $null
    try { $status = herdr-app status 2>$null | Out-String | ConvertFrom-Json } catch {}
    if (-not $status) { Write-Host "Herdr window not running: skipped the active-layout and live-error checks" }
    else {
        if ($status.layout -ne $layoutName) { $problems.Add("active layout is '$($status.layout)', not '$layoutName'") }
        foreach ($e in $status.errors) { $problems.Add("Herdr error: $($e | ConvertTo-Json -Compress)") }
    }
    return $problems
}

$problems = Invoke-Check
if ($Fix -and $problems.Count) {
    Write-Output "Fixing: redeploying from the repo"
    & (Join-Path $PSScriptRoot "deploy-mods.ps1")
    $active = $null
    try { $active = (herdr-app status 2>$null | Out-String | ConvertFrom-Json).layout } catch {}
    if ($active -and $active -ne $layoutName) { herdr-app do layout.switch --name $layoutName | Out-Null }
    Start-Sleep -Seconds 2  # hot reload and the layout switch apply within a second
    $problems = Invoke-Check
}

if ($problems.Count) {
    Write-Output "NEEDS ATTENTION:"
    $problems | ForEach-Object { Write-Output "  - $_" }
    exit 1
}
Write-Output "OK: Herdr runs this repo's mods and layout"
exit 0
