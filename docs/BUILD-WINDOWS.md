# Windows source build

This personal fork includes the complete Herdr app source and vendored Rust/GPUI
libraries under `native/herdr-app`. It is based on `herdrdev/herdr-app` commit
`4aa3460749947e7771aa39a8a2cec58d46649926` (`v0.1.12`), under Apache-2.0.
The personal package is `0.1.12-personal.6`; previous native clipboard,
background, conversation memory and diagnostic changes are preserved.
Ghostty is a public pinned submodule at
`291fd050b9e9c293c8adb6a140742649b7e42d3a`; its own license applies.
`herdr-core` is a separate runtime dependency and is not copied into this repo.

Requirements: Windows x64, Visual Studio C++ build tools and Windows SDK, Git,
Rust MSVC toolchain 1.95.0, Zig 0.16.0, libclang DLL, Node.js, PowerShell.

```powershell
git clone --recurse-submodules https://github.com/parkhyun76/Herdr.git
cd Herdr
rustup toolchain install 1.95.0
git submodule update --init --recursive
./scripts/build-windows.ps1 -Test -Zig C:/tools/zig/zig.exe -Libclang C:/tools/clang/bin
$tests = Get-ChildItem tests -File | Where-Object Name -Match '\.test\.(mjs|cjs)$'
node --test $tests.FullName
```

One upstream release-only popup/debug-bounds test is excluded explicitly. GPUI
tests run sequentially because its scheduler can fail when test threads overlap.
The process-owner hook integration test is opt-in:
`$env:HERDR_HOOK_INTEGRATION_TEST='1'` from an actual Codex-owned Windows session.

Before replacing an installed binary, close the GUI normally, back up
`%LOCALAPPDATA%/Programs/herdr-app/herdr-app.exe`, copy the built executable there,
then reopen the GUI in your normal Windows desktop session. Closing the GUI
leaves core/AI terminals running. Do not stop herdr-core to install the app.
Deploy the custom interface with `./scripts/deploy-mods.ps1`.

Versions marked `-personal.*` disable official app executable checks and swaps,
including pending updates on startup and explicit `app.update`. The Settings
Updates page explains this protection. Core update checks remain available.
Merge upstream changes into this fork, retain the personal version marker, then
test, rebuild and install the verified personal executable. Installing an official
binary manually still replaces the native personal features. Personal mods and
the custom layout have distinct names and can be re-deployed separately.

The source snapshot was built/tested on the original local build checkout with
the same runtime source bytes to reuse its existing compilation cache. Build
tools, compiled binaries, user settings and AI history are excluded from Git.

On the owner's PC the existing build checkout and portable tools now live under
`.local/herdr-customization/` in this repository. Current local paths and the
maintenance record are documented in [Local Herdr assets](LOCAL-HERDR-ASSETS.md).
