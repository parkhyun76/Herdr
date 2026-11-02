param([string]$Roots, [string]$Links)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HerdrRestoreArgs {
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CommandLineToArgvW(string text, out int count);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
    public static string[] Split(string text) {
        int count; IntPtr pointer=CommandLineToArgvW(text,out count);
        if(pointer==IntPtr.Zero) throw new InvalidOperationException("Cannot read process arguments");
        try {
            var result=new string[count];
            for(int i=0;i<count;i++) result[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));
            return result;
        } finally { LocalFree(pointer); }
    }
}
'@
$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
function Stamp($process) { $process.CreationDate.ToUniversalTime().Ticks.ToString() }
function Ancestors($process) {
    $result = @()
    $seen = @{}
    while ($process -and -not $seen.ContainsKey([int]$process.ProcessId)) {
        $seen[[int]$process.ProcessId] = $true
        $result += [int]$process.ProcessId
        $parent = $byId[[int]$process.ParentProcessId]
        if ($parent -and $parent.CreationDate -gt $process.CreationDate) { break }
        $process = $parent
    }
    return $result
}
$claims = @()
if (Test-Path -LiteralPath $Links) {
    foreach ($file in Get-ChildItem -LiteralPath $Links -Filter '*.json' -File) {
        try { $claims += Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch {}
    }
}
$agents = @()
$claudeRoot = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
foreach ($process in $processes) {
    $agent = switch ($process.Name.ToLowerInvariant()) { 'codex.exe' { 'codex' }; 'claude.exe' { 'claude' }; default { $null } }
    if (-not $agent) { continue }
    $command = $process.CommandLine
    if (-not $command) { continue }
    $arguments = [HerdrRestoreArgs]::Split($command)
    if ($arguments.Count -gt 1 -and $arguments[1] -in @('app-server', 'exec-server', 'exec', 'review', 'mcp-server')) { continue }
    if ($agent -eq 'claude' -and ($arguments -contains '--print' -or $arguments -contains '-p')) { continue }
    $ancestors = @(Ancestors $process)
    $stamp = Stamp $process
    $sid = $null; $cwd = $null; $transcript = $null; $titlePath = $null
    if ($agent -eq 'claude') {
        $sessionFile = Join-Path $claudeRoot ('sessions/' + $process.ProcessId + '.json')
        if (Test-Path -LiteralPath $sessionFile) {
            try {
                $session = Get-Content -LiteralPath $sessionFile -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($session.pid -eq $process.ProcessId -and $session.kind -eq 'interactive' -and
                    [Math]::Abs([long]$session.procStart - $process.CreationDate.ToFileTimeUtc()) -lt 10000) {
                    $sid = $session.sessionId; $cwd = $session.cwd
                }
            } catch {}
        }
    } else {
        # The title launcher gives each TUI a unique state file; never select by cwd.
        if ($command -match '(?i)CODEX_TITLE_FILE=\\?"?([^"\r\n]*?CodexTerminalTitles[/\\][0-9a-f]{32}\.json)') {
            $titlePath = $Matches[1].Replace('\\"', '').Trim('"')
            if (Test-Path -LiteralPath $titlePath) {
                try { $sid = (Get-Content -LiteralPath $titlePath -Raw -Encoding UTF8 | ConvertFrom-Json).thread } catch {}
            }
        }
        if (-not $sid) {
            # A resumed TUI can display history before its next turn/start hook.
            # Its explicit UUID is authoritative until a later hook reports a switch.
            for ($i = 1; $i + 1 -lt $arguments.Count; $i++) {
                if ($arguments[$i] -eq 'resume' -and $arguments[$i + 1] -match '^[0-9a-fA-F-]{36}$') { $sid = $arguments[$i + 1]; break }
            }
        }
    }
    $matching = @($claims | Where-Object {
        $_.agent -eq $agent -and [int]$_.pid -eq $process.ProcessId -and $_.start -eq $stamp
    } | Sort-Object updated_ms -Descending)
    if ($matching.Count -gt 0) {
        $claim = $matching[0]
        # A start hook is authoritative across /new and /resume in the same TUI.
        $sid = $claim.session_id; $cwd = $claim.cwd; $transcript = $claim.transcript
    }
    if ($sid -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { $sid = $null }
    $days = @()
    if ($sid -and $agent -eq 'codex') {
            # UUIDv7 contains the creation time. Search its day, then adjacent UTC days.
            try {
                $hex = $sid.Replace('-', '').Substring(0, 12)
                $day = [DateTimeOffset]::FromUnixTimeMilliseconds([Convert]::ToInt64($hex, 16)).UtcDateTime
                foreach ($offset in @(0, -1, 1)) {
                    $days += Join-Path $codexRoot ('sessions/' + $day.AddDays($offset).ToString('yyyy/MM/dd', [Globalization.CultureInfo]::InvariantCulture))
                }
            } catch {}
    }
    # Only recognized launch settings are retained, never the original task/prompt.
    $options = @()
    $resumeId = $false
    for ($index = 1; $index -lt $arguments.Count; $index++) {
        $flag = $arguments[$index]
        if ($flag -eq 'resume') { $resumeId = $true; continue }
        if ($flag -in @('--resume', '-r')) { $index++; continue }
        if ($flag -in @('--model', '-m', '--effort', '--permission-mode', '--sandbox', '-s', '--ask-for-approval', '-a')) {
            if ($index + 1 -lt $arguments.Count) { $options += $flag; $options += $arguments[++$index] }
        } elseif ($flag -in @('--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox')) { $options += $flag }
        elseif ($flag -in @('-c', '--config')) {
            $index++
            if ($index -lt $arguments.Count -and $arguments[$index] -match '^model_reasoning_effort="?([a-z]+)"?$') {
                $options += '-c'; $options += ('model_reasoning_effort="' + $Matches[1] + '"')
            }
        } elseif ($flag -in @('-C', '--cd', '--profile', '--add-dir', '--session-id', '--name', '-n')) { $index++ }
        elseif (-not $flag.StartsWith('-')) {
            if ($resumeId) { $resumeId = $false; continue }
            break # The first task/prompt is opaque; never interpret options inside it.
        }
    }
    $agents += @{ pid = [int]$process.ProcessId; start = $stamp; ancestors = $ancestors; agent = $agent;
        session_id = $sid; cwd = $cwd; transcript = $transcript; options = $options; days = $days }
}
$rootsOut = @()
foreach ($rootText in $Roots.Split(',')) {
    $rootId = 0
    if (-not [int]::TryParse($rootText, [ref]$rootId)) { continue }
    $root = $byId[$rootId]
    if (-not $root) { continue }
    $children = @($processes | Where-Object { $_.ParentProcessId -eq $rootId -and $_.CreationDate -ge $root.CreationDate })
    $holder = $byId[[int]$root.ParentProcessId]
    $holderId = if ($holder -and $holder.Name -in @('herdr-core.exe', 'hc.exe') -and $holder.CommandLine -match '\shold\s') { [int]$holder.ProcessId } else { 0 }
    $rootsOut += @{ pid = $rootId; start = (Stamp $root); holder_pid = $holderId;
        idle_shell = ($root.Name -in @('pwsh.exe', 'powershell.exe', 'cmd.exe') -and $children.Count -eq 0) }
}
@{ roots = $rootsOut; agents = $agents; claude_projects = (Join-Path $claudeRoot 'projects'); claims = $claims } | ConvertTo-Json -Depth 7 -Compress
