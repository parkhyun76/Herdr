param([ValidateSet('codex', 'claude')][string]$Agent)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$lease = $null
try {
    $root = Join-Path $env:LOCALAPPDATA 'Herdr/session-restore/links'
    $eventTime = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $inputText = [Console]::In.ReadToEnd()
        if ($inputText.Length -gt 1048576) { throw 'Session hook payload is too large' }
        $payload = $inputText | ConvertFrom-Json
        if ($payload.agent_id -or $payload.agent_type -eq 'subagent') { exit 0 }
        $sid = $payload.session_id
        if ($sid -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { exit 0 }
        $eventName = $payload.hook_event_name
        if ($eventName -notin @('SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop')) { exit 0 }
        $path = Join-Path $root ($Agent + '-' + $sid + '.json')
        $data = $null
        if ($eventName -in @('UserPromptSubmit','Stop') -and $env:HC_TERMINAL_ID -and (Test-Path -LiteralPath $path)) {
            $previous = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($previous.terminal_id -eq $env:HC_TERMINAL_ID -and -not $previous.ended) {
                try {
                    $owner = Get-Process -Id ([int]$previous.pid) -ErrorAction Stop
                    if ([Math]::Abs($owner.StartTime.ToUniversalTime().Ticks - [long]$previous.start) -lt 10000) {
                        $data = $previous
                        $data.cwd = [string]$payload.cwd
                        $data.transcript = [string]$payload.transcript_path
                        $data.model = [string]$payload.model
                        $data.updated_ms = $eventTime
                    }
                } catch { $data = $null }
            }
        }
        if ($eventName -eq 'SessionEnd') {
            # Windows shutdown is loss, not an intentional close of a conversation.
            Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class HerdrSessionShutdown { [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index); }'
            if ([HerdrSessionShutdown]::GetSystemMetrics(0x2000) -ne 0) { exit 0 }
            if (Test-Path -LiteralPath $path) {
                $data = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
                $data.ended = $true
                $data.updated_ms = $eventTime
            }
        }
        if (-not $data) {
        # Locate the actual TUI, never a daemon's unrelated sibling by folder.
        $all = @(Get-CimInstance Win32_Process)
        $byId = @{}
        foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }
        $current = $byId[$PID]
        $anchor = $null
        $daemonPattern = '(?i)^(?:"[^"]+"|\S+)\s+(?:app-server|exec-server)(?:\s|$)'
        for ($depth = 0; $depth -lt 12 -and $current; $depth++) {
            if ($current.Name -eq ($Agent + '.exe') -and $current.CommandLine -notmatch $daemonPattern) { $anchor = $current; break }
            $current = $byId[[int]$current.ParentProcessId]
        }
        $title = if ($Agent -eq 'codex') { $env:CODEX_TITLE_FILE } else { $null }
        if (-not $anchor -and $title) {
            $normalizedTitle = $title.Replace('\', '/')
            $owners = @($all | Where-Object { $_.Name -eq 'codex.exe' -and $_.CommandLine -and $_.CommandLine.Replace('\', '/').Contains($normalizedTitle) })
            if ($owners.Count -eq 1) { $anchor = $owners[0] }
        }
        if (-not $anchor) { exit 0 }
        $lineage = @()
        $current = $anchor
        for ($depth = 0; $depth -lt 16 -and $current; $depth++) {
            if ($depth -gt 0 -and $current.Name -in @('claude.exe', 'codex.exe') -and $current.CommandLine -notmatch $daemonPattern) { exit 0 }
            $lineage += @{ pid = [int]$current.ProcessId; start = $current.CreationDate.ToUniversalTime().Ticks.ToString() }
            $parent = $byId[[int]$current.ParentProcessId]
            if ($parent -and $parent.CreationDate -gt $current.CreationDate) { break }
            $current = $parent
        }
        $ended = $eventName -eq 'SessionEnd'
        $data = [ordered]@{ agent = $Agent; session_id = $sid; cwd = [string]$payload.cwd;
            transcript = [string]$payload.transcript_path; pid = $(if ($anchor) { [int]$anchor.ProcessId } else { 0 });
            start = $(if ($anchor) { $anchor.CreationDate.ToUniversalTime().Ticks.ToString() } else { '' });
            title_path = $title; terminal_id = [string]$env:HC_TERMINAL_ID; lineage = $lineage; model = [string]$payload.model; ended = $ended; updated_ms = $eventTime }
    }
    [void][IO.Directory]::CreateDirectory($root)
    for ($attempt = 0; $attempt -lt 20 -and -not $lease; $attempt++) {
        try { $lease = [IO.File]::Open($path + '.lock', [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 20 }
    }
    if (-not $lease) { throw 'Session metadata is busy' }
    if (Test-Path -LiteralPath $path) {
        $previous = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        if ([long]$previous.updated_ms -gt $eventTime) { exit 0 }
    }
    $temporary = $path + '.' + $PID + '.tmp'
    [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $path) }
} catch { [Console]::Error.WriteLine('[Herdr session restore] ' + $_.Exception.Message) }
finally { if ($lease) { $lease.Dispose() } }
