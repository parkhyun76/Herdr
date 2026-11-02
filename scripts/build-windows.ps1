param([switch]$Test,[string]$Zig,[string]$Libclang)
$ErrorActionPreference = 'Stop'
if ($Zig) { $env:ZIG = (Resolve-Path -LiteralPath $Zig).Path }
if ($Libclang) { $env:LIBCLANG_PATH = (Resolve-Path -LiteralPath $Libclang).Path }
$env:HERDR_APP_RELEASE = '1'
$env:CARGO_BUILD_JOBS = '6'
$source = Join-Path $PSScriptRoot '../native/herdr-app'
Push-Location $source
try {
    if ($Test) {
        & cargo +1.95.0 test --release --locked --bin herdr-app -- --test-threads=1 --skip window::tests::fitted_popups_use_their_rendered_size_at_the_window_edge
        if ($LASTEXITCODE -ne 0) { throw 'Native tests failed.' }
    }
    & cargo +1.95.0 build --release --locked
    if ($LASTEXITCODE -ne 0) { throw 'Native release build failed.' }
    Write-Output "Built: $source/target/release/herdr-app.exe"
} finally { Pop-Location }
