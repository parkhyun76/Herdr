# Packages an already verified personal executable; does not build or run the app.
param(
    [string]$Binary = (Join-Path $env:LOCALAPPDATA 'Programs/herdr-app/herdr-app.exe'),
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedBinarySha256,
    [string]$Compiler = 'C:/Program Files (x86)/Inno Setup 6/ISCC.exe',
    [string]$RuntimeDll,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '../dist'),
    [ValidatePattern('^[0-9A-Za-z._-]+$')][string]$BuildLabel = '0.1.12-personal.2-20261106'
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$Binary = (Resolve-Path -LiteralPath $Binary).Path
if ((Get-FileHash -LiteralPath $Binary -Algorithm SHA256).Hash -ne $ExpectedBinarySha256) { throw 'Executable does not match the verified SHA256.' }
if ((Get-Item -LiteralPath $Binary).VersionInfo.ProductVersion -notlike '*-personal.*') { throw 'A personal build is required.' }
if (-not (Test-Path -LiteralPath $Compiler -PathType Leaf)) { throw "Inno Setup compiler not found: $Compiler" }
if (-not $RuntimeDll) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $visualStudio = & $vswhere -latest -property installationPath
    if (-not $visualStudio) { throw 'Visual Studio redistributable files not found; supply RuntimeDll.' }
    $versions = Get-ChildItem -LiteralPath (Join-Path $visualStudio 'VC/Redist/MSVC') -Directory |
        Where-Object Name -Match '^\d+(\.\d+){1,3}$' | Sort-Object { [version]$_.Name } -Descending
    $RuntimeDll = $versions | ForEach-Object { Join-Path $_.FullName 'x64/Microsoft.VC143.CRT/vcruntime140.dll' } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $RuntimeDll) { throw 'The x64 Visual C++ redistributable runtime is required.' }
$signature = Get-AuthenticodeSignature -LiteralPath $RuntimeDll
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') { throw 'RuntimeDll must be an unmodified Microsoft-signed redistributable.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('herdr-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $app = Join-Path $scratch 'app'
    New-Item -ItemType Directory -Path $app | Out-Null
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $app 'herdr-app.exe')
    Copy-Item -LiteralPath $RuntimeDll -Destination (Join-Path $app 'vcruntime140.dll')
    Copy-Item -LiteralPath (Join-Path $repo 'distribution/windows/Microsoft-VCRuntime-NOTICE.txt') -Destination $app
    foreach ($name in @('LICENSE', 'THIRD-PARTY-NOTICES')) {
        Copy-Item -LiteralPath (Join-Path $repo "native/herdr-app/$name") -Destination $app
    }
    Copy-Item -LiteralPath (Join-Path $repo 'native/herdr-app/assets/icons/herdr-ui-icon-clean.svg') -Destination (Join-Path $app 'herdr-app.svg')
    Copy-Item -LiteralPath (Join-Path $repo 'native/herdr-app/assets/icons/herdr-app.ico') -Destination $scratch
    # Only version-controlled UI files: never collect anything from the user's config.
    $tracked = @(& git -C $repo ls-files -- mods layouts)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate tracked customizations.' }
    foreach ($relative in $tracked) {
        $target = Join-Path $scratch "customizations/$relative"
        New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $target
    }
    $tools = Join-Path $scratch 'session-tools'
    New-Item -ItemType Directory -Path $tools | Out-Null
    Copy-Item -LiteralPath (Join-Path $repo 'native/herdr-app/src/session_restore/hook.ps1') -Destination $tools
    foreach ($name in @('Initialize-HerdrPersonal.ps1', 'INSTALL.txt')) {
        Copy-Item -LiteralPath (Join-Path $repo "distribution/windows/$name") -Destination $scratch
    }
    $sourceCommit = & git -C $repo rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the source commit.' }
    $payloadFiles = @(Get-ChildItem -LiteralPath $scratch -Recurse -File | ForEach-Object {
        @{ path = $_.FullName.Substring($scratch.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    $metadata = @{ version = $BuildLabel; sourceCommit = $sourceCommit; binarySha256 = $ExpectedBinarySha256.ToLowerInvariant(); files = $payloadFiles }
    [IO.File]::WriteAllText((Join-Path $scratch 'package.json'), ($metadata | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    & $Compiler "/DPayloadDir=$scratch" "/DPackageOutput=$OutputDirectory" "/DBuildLabel=$BuildLabel" (Join-Path $repo 'distribution/windows/setup.iss')
    if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed ($LASTEXITCODE)." }
    $setup = Join-Path $OutputDirectory "Herdr-Personal-$BuildLabel-Setup.exe"
    $checksum = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + (Split-Path $setup -Leaf)
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), "$checksum`r`n", [Text.UTF8Encoding]::new($false))
    Copy-Item -LiteralPath (Join-Path $scratch 'INSTALL.txt') -Destination $OutputDirectory -Force
    Copy-Item -LiteralPath (Join-Path $scratch 'package.json') -Destination $OutputDirectory -Force
    Get-Item -LiteralPath $setup | Select-Object FullName, Length
} finally {
    # Delete only this run's checked, uniquely named OS temporary directory.
    $resolved = [IO.Path]::GetFullPath($scratch)
    $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolved.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        (Split-Path $resolved -Leaf) -notmatch '^herdr-package-[a-f0-9]{32}$') { throw 'Unexpected staging path; not deleting it.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
    if (Test-Path -LiteralPath $resolved) { throw "Staging directory remains: $resolved" }
}
