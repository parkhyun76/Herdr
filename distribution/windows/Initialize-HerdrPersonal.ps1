param(
    [string]$AppDir,
    [switch]$CheckRunning,
    [switch]$ActivateLayout,
    [switch]$EnableAI
)
$ErrorActionPreference = 'Stop'

function Get-HerdrConfigHome {
    if ($env:HERDR_APP_HOME) { return $env:HERDR_APP_HOME }
    if ($env:XDG_CONFIG_HOME) { return Join-Path $env:XDG_CONFIG_HOME 'herdr-app' }
    return Join-Path $env:USERPROFILE '.config/herdr-app'
}

function Read-JsonObject([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return [pscustomobject]@{} }
    $value = Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($null -eq $value -or $value -isnot [pscustomobject]) { throw "Expected a JSON object: $Path" }
    return $value
}

function Install-HerdrCustomizations {
    param([string]$PayloadRoot, [string]$ConfigHome, [string]$BackupRoot, [switch]$ActivateLayout)
    $PayloadRoot = (Resolve-Path -LiteralPath $PayloadRoot).Path
    $files = @(Get-ChildItem -LiteralPath (Join-Path $PayloadRoot 'mods') -Recurse -File)
    $files += @(Get-ChildItem -LiteralPath (Join-Path $PayloadRoot 'layouts') -File -Filter '*.json')
    $sharedPath = Join-Path $ConfigHome 'shared.json'
    # Validate before copying anything. Preserve every unrelated shared key.
    $shared = if ($ActivateLayout) { Read-JsonObject $sharedPath } else { $null }
    $written = [Collections.Generic.List[object]]::new()
    try {
        foreach ($file in $files) {
            $relative = $file.FullName.Substring($PayloadRoot.TrimEnd('\', '/').Length + 1)
            $target = Join-Path $ConfigHome $relative
            $saved = Join-Path $BackupRoot $relative
            $existed = Test-Path -LiteralPath $target
            if ($existed -and -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Expected a file: $target" }
            if ($existed) {
                New-Item -ItemType Directory -Path (Split-Path $saved) -Force | Out-Null
                Copy-Item -LiteralPath $target -Destination $saved
            }
            $written.Add(@{ Target = $target; Saved = $saved; Existed = $existed })
            New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
            Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        }
        if ($ActivateLayout) {
            $saved = Join-Path $BackupRoot 'shared.json'
            $existed = Test-Path -LiteralPath $sharedPath
            if ($existed) {
                New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
                Copy-Item -LiteralPath $sharedPath -Destination $saved
            }
            $written.Add(@{ Target = $sharedPath; Saved = $saved; Existed = $existed })
            $shared | Add-Member -NotePropertyName layout -NotePropertyValue 'main-worktree-folding' -Force
            [IO.File]::WriteAllText($sharedPath, ($shared | ConvertTo-Json -Depth 100), [Text.UTF8Encoding]::new($false))
        }
    } catch {
        for ($i = $written.Count - 1; $i -ge 0; $i--) {
            $entry = $written[$i]
            if ($entry.Existed) { Copy-Item -LiteralPath $entry.Saved -Destination $entry.Target -Force }
            elseif (Test-Path -LiteralPath $entry.Target -PathType Leaf) { Remove-Item -LiteralPath $entry.Target }
        }
        throw
    }
}

function Install-HerdrIdentityHooks {
    param([string]$AppDir, [string]$LocalData, [string]$ProfileRoot, [string]$BackupRoot)
    $helper = Join-Path $LocalData 'Herdr/session-restore/hook.ps1'
    $plans = @()
    foreach ($agent in @('codex', 'claude')) {
        $agentHome = Join-Path $ProfileRoot ".$agent"
        if ($agent -eq 'codex' -and $env:CODEX_HOME) { $agentHome = $env:CODEX_HOME }
        if ($agent -eq 'claude' -and $env:CLAUDE_CONFIG_DIR) { $agentHome = $env:CLAUDE_CONFIG_DIR }
        # An AI that has not been set up yet can be configured later with this script.
        if (-not (Test-Path -LiteralPath $agentHome -PathType Container)) { continue }
        $name = if ($agent -eq 'codex') { 'hooks.json' } else { 'settings.json' }
        $path = Join-Path $agentHome $name
        $config = Read-JsonObject $path
        if (-not $config.hooks) { $config | Add-Member -NotePropertyName hooks -NotePropertyValue ([pscustomobject]@{}) -Force }
        if ($config.hooks -isnot [pscustomobject]) { throw "Expected a hooks object: $path" }
        $command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -Agent ' + $agent
        foreach ($event in @('SessionStart', 'UserPromptSubmit', 'Stop', 'SessionEnd')) {
            $groups = @($config.hooks.$event | Where-Object { $null -ne $_ })
            $owned = @($groups | ForEach-Object { $_.hooks } | Where-Object { $_.command -eq $command })
            if ($owned.Count -eq 0) {
                $timeout = if ($agent -eq 'codex' -and $event -eq 'SessionEnd') { 3 } else { 10 }
                $groups += [pscustomobject]@{ hooks = @([pscustomobject]@{ type = 'command'; command = $command; timeout = $timeout }) }
                $config.hooks | Add-Member -NotePropertyName $event -NotePropertyValue $groups -Force
            }
        }
        $plans += @{ Path = $path; Saved = "$agent-$name"; Json = ($config | ConvertTo-Json -Depth 100) }
    }
    if ($plans.Count -gt 0) {
        New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
        if (Test-Path -LiteralPath $helper) { Copy-Item -LiteralPath $helper -Destination (Join-Path $BackupRoot 'hook.ps1') }
        New-Item -ItemType Directory -Path (Split-Path $helper) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $AppDir 'session-tools/hook.ps1') -Destination $helper -Force
        foreach ($plan in $plans) {
            if (Test-Path -LiteralPath $plan.Path) { Copy-Item -LiteralPath $plan.Path -Destination (Join-Path $BackupRoot $plan.Saved) }
            [IO.File]::WriteAllText($plan.Path, $plan.Json, [Text.UTF8Encoding]::new($false))
        }
    }
}

if ($MyInvocation.InvocationName -eq '.') { return }
try {
    if ($CheckRunning) {
        $running = Get-Process -Name 'herdr-app' -ErrorAction SilentlyContinue |
            Where-Object { $_.SessionId -eq (Get-Process -Id $PID).SessionId }
        if ($running) { throw 'Close the Herdr window, then retry. Core and AI terminals may keep running.' }
        exit 0
    }
    if (-not $AppDir) { throw 'AppDir is required.' }
    $backup = Join-Path $env:LOCALAPPDATA ('herdr-app-backups/personal-setup-' + [guid]::NewGuid().ToString('N'))
    Install-HerdrCustomizations -PayloadRoot (Join-Path $AppDir 'customizations') -ConfigHome (Get-HerdrConfigHome) -BackupRoot $backup -ActivateLayout:$ActivateLayout
    if ($EnableAI) {
        Install-HerdrIdentityHooks -AppDir $AppDir -LocalData $env:LOCALAPPDATA -ProfileRoot $env:USERPROFILE -BackupRoot $backup
    }
    Write-Host 'Herdr Personal configuration installed.'
} catch {
    Write-Error $_
    exit 1
}
