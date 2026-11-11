# Local Herdr maintenance assets

The authoritative application source is `native/herdr-app`; custom UI source is
`mods/`. The owner's existing Windows build cache and maintenance evidence are
local assets under this repository's Git-ignored `.local/` directory.
The owner's repository root is `D:/SW_Project/5_VibeCording/Herdr_Upgrade`.
Private repair worktrees resolve these paths against the configured source
`repository` in `auto-repair.json`, not their own checkout directory.

| Asset | Current path, relative to the repository root |
| --- | --- |
| Live maintenance record | `.local/HERDR-WINDOWS-IMPROVEMENTS.md` |
| Cached build checkout, including its Git history and target cache | `.local/herdr-customization/herdr-app-source/` |
| Zig executable | `.local/herdr-customization/build-tools/zig-x86_64-windows-0.16.0/zig.exe` |
| libclang directory | `.local/herdr-customization/build-tools/libclang/clang/native/` |
| Historical scripts, patches, screenshots and logs | `.local/herdr-customization/` |
| Historical handoff | `.local/CONTINUE.md` |

Read and update the same live maintenance record for every Windows app change.
Historical paths in old evidence describe where a check originally ran; they
are not instructions to recreate the retired folder. The historical handoff
and old migration scripts do not supersede this document or current sources.

The automatic repair configuration remains at
`%USERPROFILE%/.config/herdr-app/diagnostics/auto-repair.json`. Its `zig` and
`libclang` paths, including the `.bak` configuration, must point to the paths
above. Repository, credentials, sessions, repair limits and executable settings
are independent of the local build-cache location.

## HRD-001 relocation

On 2026-11-11 the existing customization directory, maintenance record and
historical handoff were moved here on the same drive. They were not copied.
The original parent directory and the ProjectMaster view were left intact.

The relocation preserves all files and Git metadata. Verification covers the
file manifest, tool execution, cached checkout/submodule discovery, repair
configuration, current path references and unchanged running app/core/AI
processes. Machine-specific manifests and results are kept under
`.local/relocation-HRD-001/`, outside Git. No application rebuild or reinstall is
needed for this path-only change.

Verified results: 35,833 moved files (4,482,697,363 bytes) matched their original
SHA256 values before the maintenance notes were updated. Eighteen old current
references in twelve files were redirected, including both repair configurations,
both repair plans, the global maintenance rule, relevant memories and five
retained PowerShell wrappers. The five wrappers passed syntax parsing.
Zig 0.16.0 ran successfully; offline locked Cargo metadata resolved the new
workspace and target paths, and Git discovered the same checkout and Ghostty
submodule. Current source/configuration scans found no retired-path dependency;
the intentionally untouched ProjectMaster entry in `view.json` and historical
records are excluded. All 49 existing terminals and 29 observed app/core/AI
processes remained running. Automatic repair returned to its original enabled
state; its backup configuration retained its original disabled state.

The old parent still contains its own project/skill files and an existing shell
whose working directory is that parent. Its owner must handle those separately
before deleting the parent; Herdr maintenance assets no longer reside there.
