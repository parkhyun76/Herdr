$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../distribution/windows/Initialize-HerdrPersonal.ps1')
function Assert($condition, $message) { if (-not $condition) { throw $message } }
$root = Join-Path ([IO.Path]::GetTempPath()) ('herdr-installer-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
$oldCodexHome = $env:CODEX_HOME
$oldClaudeHome = $env:CLAUDE_CONFIG_DIR
try {
    $env:CODEX_HOME = ''; $env:CLAUDE_CONFIG_DIR = ''
    $payload = Join-Path $root 'payload'
    $config = Join-Path $root ([string][char]0xD55C + [char]0xAE00 + ' user/config')
    $backup = Join-Path $root 'backup'
    New-Item -ItemType Directory -Path "$payload/mods/demo", "$payload/layouts", "$config/mods/demo" -Force | Out-Null
    [IO.File]::WriteAllText("$payload/mods/demo/main.js", 'new mod')
    [IO.File]::WriteAllText("$payload/layouts/main-worktree-folding.json", '{}')
    [IO.File]::WriteAllText("$config/mods/demo/main.js", 'my edited mod')
    [IO.File]::WriteAllText("$config/mods/demo/local.json", 'private local state')
    [IO.File]::WriteAllText("$config/shared.json", '{"layout":"main","unrelated":{"keep":42}}')
    Install-HerdrCustomizations -PayloadRoot $payload -ConfigHome $config -BackupRoot $backup -ActivateLayout
    Assert ((Get-Content "$config/mods/demo/main.js" -Raw) -eq 'new mod') 'Updated mod missing'
    Assert ((Get-Content "$backup/mods/demo/main.js" -Raw) -eq 'my edited mod') 'Original mod backup missing'
    Assert ((Get-Content "$config/mods/demo/local.json" -Raw) -eq 'private local state') 'Local mod state changed'
    $shared = Read-JsonObject "$config/shared.json"
    Assert ($shared.layout -eq 'main-worktree-folding' -and $shared.unrelated.keep -eq 42) 'Shared keys lost'
    $fresh = Join-Path $root 'fresh'
    Install-HerdrCustomizations -PayloadRoot $payload -ConfigHome $fresh -BackupRoot "$root/fresh-backup" -ActivateLayout
    Assert ((Read-JsonObject "$fresh/shared.json").layout -eq 'main-worktree-folding') 'Fresh layout not activated'
    [IO.File]::WriteAllText("$config/shared.json", '{invalid json')
    [IO.File]::WriteAllText("$config/mods/demo/main.js", 'must remain')
    $failed = $false
    try { Install-HerdrCustomizations -PayloadRoot $payload -ConfigHome $config -BackupRoot "$root/bad" -ActivateLayout } catch { $failed = $true }
    Assert $failed 'Malformed JSON accepted'
    Assert ((Get-Content "$config/mods/demo/main.js" -Raw) -eq 'must remain') 'Modified files before JSON validation'
    # Force a copy failure after the first write and verify the old mod is restored.
    Remove-Item -LiteralPath "$config/shared.json"
    Remove-Item -LiteralPath "$config/layouts/main-worktree-folding.json"
    New-Item -ItemType Directory -Path "$config/layouts/main-worktree-folding.json" -Force | Out-Null
    [IO.File]::WriteAllText("$config/layouts/main-worktree-folding.json/blocker", 'keep')
    $failed = $false
    try { Install-HerdrCustomizations -PayloadRoot $payload -ConfigHome $config -BackupRoot "$root/rollback" -ActivateLayout } catch { $failed = $true }
    Assert $failed 'Invalid destination accepted'
    Assert ((Get-Content "$config/mods/demo/main.js" -Raw) -eq 'must remain') 'Failed installation did not roll back'
    $app = Join-Path $root 'app'
    $profile = Join-Path $root 'profile'
    $localData = Join-Path $root 'local'
    New-Item -ItemType Directory -Path "$app/session-tools", "$profile/.codex", "$profile/.claude" -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot '../native/herdr-app/src/session_restore/hook.ps1') -Destination "$app/session-tools/hook.ps1"
    [IO.File]::WriteAllText("$profile/.codex/config.toml", 'unchanged trust settings')
    [IO.File]::WriteAllText("$profile/.claude/settings.json", '{"permissions":{"allow":["Read"]},"hooks":{"Stop":[{"hooks":[{"type":"command","command":"my-hook"}]}]}}')
    Install-HerdrIdentityHooks -AppDir $app -LocalData $localData -ProfileRoot $profile -BackupRoot "$root/hooks-backup"
    Install-HerdrIdentityHooks -AppDir $app -LocalData $localData -ProfileRoot $profile -BackupRoot "$root/hooks-backup2"
    $codex = Read-JsonObject "$profile/.codex/hooks.json"
    $claude = Read-JsonObject "$profile/.claude/settings.json"
    Assert (@($codex.hooks.SessionStart).Count -eq 1) 'Duplicate identity hook'
    Assert (@($claude.hooks.Stop).Count -eq 2) 'Existing hooks lost or new hook duplicated'
    Assert ($claude.permissions.allow[0] -eq 'Read') 'Permissions changed'
    Assert ($codex.hooks.SessionEnd[0].hooks[0].timeout -eq 3) 'Codex exit timeout changed'
    Assert ((Get-Content "$profile/.codex/config.toml" -Raw) -eq 'unchanged trust settings') 'Trust settings changed'
    # Validate every AI configuration before writing any of them.
    $before = Get-Content "$profile/.codex/hooks.json" -Raw
    [IO.File]::WriteAllText("$profile/.claude/settings.json", '[]')
    $failed = $false
    try { Install-HerdrIdentityHooks -AppDir $app -LocalData $localData -ProfileRoot $profile -BackupRoot "$root/bad-hooks" } catch { $failed = $true }
    Assert $failed 'Invalid AI settings accepted'
    Assert ((Get-Content "$profile/.codex/hooks.json" -Raw) -eq $before) 'Changed Codex before validating Claude'
    Write-Host 'PASS: fresh install, backups, data preservation, rollback, hooks, idempotence and trust preservation'
} finally {
    $env:CODEX_HOME = $oldCodexHome; $env:CLAUDE_CONFIG_DIR = $oldClaudeHome
    $resolved = [IO.Path]::GetFullPath($root)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolved -Leaf) -notmatch '^herdr-installer-test-[a-f0-9]{32}$') { throw 'Unexpected test path; not deleting it.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    Assert (-not (Test-Path -LiteralPath $resolved)) 'Test temporary folder remains'
}
