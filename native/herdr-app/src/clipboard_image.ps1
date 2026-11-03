$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# A short unkept core terminal gives this helper the AI's Windows station.
$source = [IO.Path]::GetFullPath($env:HERDR_CLIPBOARD_IMAGE)
if (-not [IO.File]::Exists($source)) { throw 'Clipboard image file is unavailable' }
$image = [Drawing.Image]::FromFile($source)
try {
    $copy = [Drawing.Bitmap]::new($image)
    try {
        [System.Windows.Forms.Clipboard]::SetDataObject($copy, $true, 10, 25)
        if (-not [System.Windows.Forms.Clipboard]::ContainsImage()) { throw 'AI-session clipboard did not accept the image' }
    } finally { $copy.Dispose() }
} finally { $image.Dispose() }
