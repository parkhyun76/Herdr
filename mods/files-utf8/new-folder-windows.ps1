param(
    [Parameter(Mandatory = $true)][string]$Parent,
    [Parameter(Mandatory = $true)][string]$Name
)
$ErrorActionPreference = 'Stop'
# Korean OS messages reach Herdr's notification as UTF-8.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
    # Only a single folder name; the mod checks the same rules before calling.
    if ($Name -in @('.', '..') -or $Name.Length -gt 255 -or $Name -match '[\x00-\x1f\\/:*?"<>|]' -or $Name -match '[ .]$' -or
        $Name -match '^(?i)(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$') { throw '사용할 수 없는 폴더 이름입니다.' }
    if (-not [IO.Directory]::Exists($Parent)) { throw '폴더를 만들 위치가 없습니다.' }
    $target = [IO.Path]::Combine($Parent, $Name)
    if ([IO.Directory]::Exists($target) -or [IO.File]::Exists($target)) { throw '같은 이름의 폴더나 파일이 이미 있습니다.' }
    [IO.Directory]::CreateDirectory($target) | Out-Null
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
