# One-time migration of already-running Codex TUIs that predate the identity hooks.
# Restart Manager is used only to query file owners; no shutdown/restart API is imported.
param([string]$AppSource = (Join-Path $PSScriptRoot '../native/herdr-app'))
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HerdrSessionFileOwners {
    [StructLayout(LayoutKind.Sequential)] public struct Owner {
        public uint Pid;
        public System.Runtime.InteropServices.ComTypes.FILETIME Birth;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Info {
        public Owner Process;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string App;
        [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string Service;
        public uint Type, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle,uint flags,StringBuilder key);
    [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle,uint files,string[] names,uint apps,IntPtr processes,uint services,IntPtr serviceNames);
    [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle,out uint needed,ref uint count,[In,Out] Info[] info,ref uint reasons);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
    public static Owner[] Query(string file) {
        uint handle;
        int result=RmStartSession(out handle,0,new StringBuilder(33));
        if(result!=0) throw new InvalidOperationException("Cannot start file-owner query: "+result);
        try {
            result=RmRegisterResources(handle,1,new[]{file},0,IntPtr.Zero,0,IntPtr.Zero);
            if(result!=0) throw new InvalidOperationException("Cannot register file-owner query: "+result);
            uint needed=0,count=0,reasons=0;
            result=RmGetList(handle,out needed,ref count,null,ref reasons);
            if(result==0) return new Owner[0];
            if(result!=234) throw new InvalidOperationException("Cannot query file owners: "+result);
            for(int attempt=0;attempt<3;attempt++) {
                var info=new Info[needed];count=needed;
                result=RmGetList(handle,out needed,ref count,info,ref reasons);
                if(result==234) continue;
                if(result!=0) throw new InvalidOperationException("Cannot read file owners: "+result);
                var owners=new Owner[count];
                for(int i=0;i<count;i++) owners[i]=info[i].Process;
                return owners;
            }
            throw new InvalidOperationException("File owners kept changing");
        } finally {RmEndSession(handle);}
    }
    public static long Birth(Owner owner) {return ((long)(uint)owner.Birth.dwHighDateTime<<32)|(uint)owner.Birth.dwLowDateTime;}
}
'@
$wrapper = Join-Path (Split-Path $AppSource -Parent) 'herdr-command.cjs'
$view = node $wrapper ls | ConvertFrom-Json
$memoryPath = Join-Path $env:LOCALAPPDATA 'Herdr/session-restore.json'
$memory = Get-Content -LiteralPath $memoryPath -Raw -Encoding UTF8 | ConvertFrom-Json
$unknown = @($memory.unresolved.PSObject.Properties.Name)
$bindings = @()
$hc = Join-Path $env:LOCALAPPDATA 'Programs/herdr-core/hc.exe'
foreach ($space in $view.spaces) { foreach ($tab in $space.tabs) { foreach ($terminal in $tab.terminals) {
    if ($unknown -notcontains $terminal.pane) { continue }
    $record = & $hc get $terminal.terminal --json | ConvertFrom-Json
    $bindings += @{ root_pid = [int]$record.pid; cwd = [string]$record.foreground.cwd }
} } }
if (-not $bindings.Count) { @{captured=0;remaining=0}|ConvertTo-Json; return }
$links = Join-Path $env:LOCALAPPDATA 'Herdr/session-restore/links'
$snapshot = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppSource 'src/session_restore/scan.ps1') -Roots (($bindings.root_pid) -join ',') -Links $links | ConvertFrom-Json
$targets = @($snapshot.agents | Where-Object { $_.agent -eq 'codex' -and -not $_.session_id -and @($_.ancestors | Where-Object { $bindings.root_pid -contains $_ }).Count -gt 0 })
$all = @(Get-CimInstance Win32_Process)
$byId = @{}; foreach ($process in $all) { $byId[[int]$process.ProcessId] = $process }
$captured = 0
$verified = @()
$files = @()
$codexRoot = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
foreach ($day in -2..0) {
    $directory = Join-Path $codexRoot ('sessions/' + [DateTime]::UtcNow.AddDays($day).ToString('yyyy/MM/dd',[Globalization.CultureInfo]::InvariantCulture))
    $files += @(Get-ChildItem -LiteralPath $directory -Filter '*.jsonl' -File -ErrorAction SilentlyContinue)
}
foreach ($file in $files) {
    try { $header = Get-Content -LiteralPath $file.FullName -TotalCount 1 -Encoding UTF8 | ConvertFrom-Json } catch { continue }
    if ($header.type -ne 'session_meta') { continue }
    $cwd = [string]$header.payload.cwd
    if (-not @($bindings | Where-Object { $_.cwd.Replace('\','/').TrimEnd('/') -eq $cwd.Replace('\','/').TrimEnd('/') }).Count) { continue }
    $owners = [HerdrSessionFileOwners]::Query($file.FullName)
    foreach ($target in $targets) {
        $process = $byId[[int]$target.pid]
        $owner = @($owners | Where-Object { $_.Pid -eq $target.pid -and [Math]::Abs([HerdrSessionFileOwners]::Birth($_) - $process.CreationDate.ToFileTimeUtc()) -lt 10000 })
        if ($owner.Count -ne 1) { continue }
        $sid = [string]$header.payload.id
        if ($sid -notmatch '^[0-9a-fA-F-]{36}$') { continue }
        $lineage = @(); $current = $process
        while ($current) {
            $lineage += @{pid=[int]$current.ProcessId;start=$current.CreationDate.ToUniversalTime().Ticks.ToString()}
            $parent = $byId[[int]$current.ParentProcessId]
            if ($parent -and $parent.CreationDate -gt $current.CreationDate) { break }
            $current = $parent
        }
        $claim = @{ agent='codex';session_id=$sid;cwd=$cwd;transcript=$file.FullName;pid=[int]$process.ProcessId
            start=$process.CreationDate.ToUniversalTime().Ticks.ToString();lineage=$lineage;model='';ended=$false;updated_ms=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
        $verified += $claim
    }
}
foreach ($group in ($verified | Group-Object pid)) {
    # One process can retain multiple /new conversations. That is ambiguous;
    # file ownership alone must never choose between several open root sessions.
    if (@($group.Group | Select-Object -ExpandProperty session_id -Unique).Count -ne 1) { continue }
    $claim = $group.Group[0]
    $destination = Join-Path $links ('codex-'+$claim.session_id+'.json')
    if (Test-Path -LiteralPath $destination) { throw 'A newer identity hook already owns this conversation; rerun the query' }
    $temporary = $destination + '.migration.tmp'
    [IO.File]::WriteAllText($temporary,($claim|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
    [IO.File]::Move($temporary,$destination)
    $captured++
}
@{captured=$captured;previously_unresolved=$unknown.Count}|ConvertTo-Json
