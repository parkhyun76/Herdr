param(
    [Parameter(Mandatory=$true)][string]$Folder,
    [Parameter(Mandatory=$true)][string]$AppHome
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# Query the same Shell association service as Explorer, outside the UI process.
# https://learn.microsoft.com/windows/win32/api/shellapi/nf-shellapi-shgetfileinfow
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

public static class HerdrFileIcons {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct FileInfo {
        public IntPtr Icon;
        public int Index;
        public uint Attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string path, uint attributes,
        out FileInfo info, uint size, uint flags);
    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    public static string Read(string path, bool directory, bool actual, bool open, string cache) {
        FileInfo info;
        uint flags = 0x100u | (actual ? 0u : 0x10u) | (open ? 0x2u : 0u);
        // SHGFI_OPENICON is 0x2. Large (32px) icons stay sharp on scaled displays.
        IntPtr result = SHGetFileInfo(path, directory ? 0x10u : 0x80u, out info,
            (uint)Marshal.SizeOf(typeof(FileInfo)), flags);
        if (result == IntPtr.Zero || info.Icon == IntPtr.Zero)
            throw new IOException("Windows Shell could not retrieve this file type's icon.");
        try {
            using (Icon icon = Icon.FromHandle(info.Icon))
            using (Bitmap bitmap = icon.ToBitmap())
            using (MemoryStream stream = new MemoryStream())
            using (SHA256 hash = SHA256.Create()) {
                bitmap.Save(stream, ImageFormat.Png);
                byte[] bytes = stream.ToArray();
                string name = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant() + ".png";
                string destination = Path.Combine(cache, name);
                if (!File.Exists(destination)) {
                    string temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try {
                        File.WriteAllBytes(temporary, bytes);
                        try { File.Move(temporary, destination); }
                        catch (IOException) { if (!File.Exists(destination)) throw; }
                    } finally { if (File.Exists(temporary)) File.Delete(temporary); }
                }
                return "data/files-utf8/windows-icons-v1/" + name;
            }
        } finally { DestroyIcon(info.Icon); }
    }
}
'@

$items = @(Get-ChildItem -LiteralPath $Folder -Force -ErrorAction Stop |
    Where-Object Name -ne '.git' | Select-Object -First 501)
$cache = Join-Path $AppHome 'data/files-utf8/windows-icons-v1'
$iconError = $null
try { [IO.Directory]::CreateDirectory($cache) | Out-Null }
catch { $iconError = $_.Exception.Message }
$types = @{}
$result = @(foreach ($item in $items) {
    $directory = $item.PSIsContainer
    $entry = @{
        name = $item.Name
        # Cloud-backed directories are also reparse points; only filesystem links
        # need the existing no-traversal treatment to avoid following cycles.
        dir = ($directory -and $item.LinkType -notin @('SymbolicLink', 'Junction'))
    }
    if (-not $iconError) {
        try {
            $extension = $item.Extension.ToLowerInvariant()
            $actual = $directory -or $extension -in @('.exe', '.ico', '.lnk')
            # Type lookups never open file contents (including OneDrive placeholders).
            if ($actual) {
                $entry.icon = [HerdrFileIcons]::Read($item.FullName, $directory, $true, $false, $cache)
                if ($entry.dir) { $entry.openIcon = [HerdrFileIcons]::Read($item.FullName, $true, $true, $true, $cache) }
            } else {
                if (-not $types.ContainsKey($extension)) {
                    $types[$extension] = [HerdrFileIcons]::Read(('file' + $extension), $false, $false, $false, $cache)
                }
                $entry.icon = $types[$extension]
            }
        } catch { $entry.iconError = $_.Exception.Message }
    } else { $entry.iconError = $iconError }
    $entry
})
ConvertTo-Json -InputObject $result -Compress
