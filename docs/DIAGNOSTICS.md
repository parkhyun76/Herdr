# Error records and automatic repair

The Windows personal app writes to `<app-home>/diagnostics` (normally
`%USERPROFILE%/.config/herdr-app/diagnostics`). `herdr-app status` reports the
directory, incident count, queue, current repair, daily budget and last result.

`events.jsonl` records command names, argument **names**, result/duration, source
file/line, errors/backtraces, current layout/pane IDs and recent actions. It does
not directly collect terminal output, prompts, clipboard or screenshots.
Credential patterns and sensitive JSON fields are redacted; error strings from
third-party scripts can still contain incidental user text, so review logs before
sharing. Logs rotate at 5 MiB with four archives; at most 200 current incidents
are retained. Worker reports and build artifacts stay local, outside Git.

Interrupted rendering gets at most two automatic refresh attempts per incident,
at least 10 seconds apart. Repeated or non-transient eligible script/render/panic
errors enter the repair queue. Ordinary validation/configuration/network errors
are recorded without launching AI code repair.

Enable or configure repairs after committing a clean checkout:

```powershell
./scripts/install-auto-repair.ps1 -Zig C:/tools/zig/zig.exe -Libclang C:/tools/clang/bin
# Stop automatic AI repairs while retaining logging:
./scripts/install-auto-repair.ps1 -Disable
```

The local Codex CLI uses your existing sign-in. It runs ephemeral, without user
config/MCP or web search, with a read-only sandbox and no interactive approval
requests. The model receives bounded relevant source and returns structured exact
edits plus a new regression test. It does not need shell tools; the host validates
and writes the proposal in the private worktree. Incident text is explicitly
treated as untrusted data. It has one private
Git worktree, a 15-minute model timeout, a persisted budget of 3 jobs/day and a
15-minute cooldown. Native compilation/test commands have a 60-minute limit each.
Model/API usage follows your account's normal limits and billing.

The host rejects protected paths, dependencies, host scripts, credentials,
process/network operations, links, binary patches, deletions and large patches.
Existing host tests cannot be weakened. It runs root Node tests and, for native
changes, over 200 native tests plus a production build. If source HEAD or user
files change during the repair, automatic application stops and preserves the
report. This is a bounded repair mechanism, not a guarantee that every error is
fixable or every model proposal is correct.

Verified mod changes hot reload only when installed files match the source base;
failures restore the backed-up files. Native changes stage a candidate with hashes
and a commit lease. The fixed install helper applies it after the GUI exits,
keeping an executable backup; the next user launch uses that binary. It does not
close user terminals, restart core, schedule boot tasks or push commits to GitHub.
Changes to protected components remain local reports for deliberate maintenance.

`jobs/<timestamp>-<incident>/result.json`, `proposed.patch`, test output and backups
explain each decision. `last-repair.json` is shown by status. If a worker is killed,
check that its PID is gone before manually removing `repair-worker.lock`; an active
lock deliberately prevents a second repair. Old job artifacts are retained for
inspection and can be removed manually after keeping any required backups.
