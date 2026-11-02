# Herdr error logging and automatic improvement

User-authorized work: publish the complete customized Herdr source to the private
`parkhyun76/Herdr` repository, and implement detailed local error logging plus
automatic detection, recovery, and verified improvements.

## Implementation contract

1. Structured, rotating local diagnostics: timestamp/run/build/platform, source
   location, error chain, current layout and pane IDs, and recent command names,
   argument names and outcomes. Never collect terminal output, user prompts,
   clipboard contents, credentials, or automatic screenshots. Mask credentials in
   error strings. Deduplicate repeated errors into incident files.
2. Capture command failures, load/render/callback errors, settings error files,
   tracing warnings/errors and panics. Expose diagnostics and repair state through
   native status/commands. GPU/script fallback banners must also be logged.
3. Retry interrupted mod rendering with a bounded cooldown, retaining the native
   terminal/model state. Recurring or non-transient eligible incidents enter a
   repair queue; expected validation/network failures do not launch code changes.
4. One repair worker at a time in a private, persistent Git worktree. Logs are
   untrusted diagnostic data. Codex receives sanitized incident data and Herdr
   source only and returns structured edits in read-only mode. No GitHub push, no changes to AI credentials, no user project/core
   control. Bound attempts and runtime; preserve failure artifacts.
5. Verify patches with an allowlist, tests and clean/source-head checks. Apply
   validated mod fixes through the existing hot reload. Stage validated native
   binaries with checksum/rollback protection for installation after the app exits.
   Never stop user AI terminals to apply a repair.

## Working surfaces

- Existing build/test surface:
  `../Project-conductor/herdr-customization/herdr-app-source`.
- Complete publishable source snapshot: `native/herdr-app` in this repository;
  includes vendored libraries and a pinned Ghostty submodule at
  `291fd050b9e9c293c8adb6a140742649b7e42d3a`.
- Keep runtime code changes synchronized into the publishable snapshot before
  committing. Keep user session/config/auth/log/backup data outside Git.
- Required live maintenance record:
  `../Project-conductor/HERDR-WINDOWS-IMPROVEMENTS.md`.
- GitHub CLI authenticated as `parkhyun76`; destination is empty and private.
- Never use the separate SSH account `DigitalAdvencedSensors` for this push.

## Verification and delivery

- Unit tests for redaction, rotation, fingerprints, retry bounds, queue leases and
  patch/path validation; negative tests for failed checks and stale source heads.
- Isolated runtime errors exercise logging and recovery without breaking user mods.
- Build/install a native binary, retain all user terminals, and verify status.
- Generalize packaging paths, add build/installation documentation, scan staged
  files/history for secrets, commit and push main without force, verify remote SHA.
- This plan is an implementation checklist, not a claim that the new feature has
  already been completed.

## Implementation verification (2026-11-02)

- Native diagnostics installed in the interactive Windows desktop; SHA256
  `1AAD9E25B3F7064D571C0F69132B062FBEADC41320946A0908D2829D5D5217DC`.
- Native suite: 213 passed, one environment-specific test ignored and one known
  upstream release-only bounds test excluded. Sequential execution avoids an
  upstream GPUI scheduler overlap failure seen in the initial parallel run.
- Root tests: 17 passed, one process-owner integration test opt-in. That opt-in
  Windows hook test was separately run successfully.
- Real Codex integration: disposable null-list defect fixed via structured proposal,
  new regression test passed, source fast-forward applied, independent null/undefined/
  array checks passed. No user app/terminal changed by that probe.
- Live GUI probe: temporary render error captured and redacted, one automatic
  refresh restored the view, incident marked recovered, no screen errors. Temporary
  space/mod removed and original pane restored.
- Installed GUI restarted normally, all 33 existing terminals retained (missing 0),
  31 live AI identities retained, restore issues and current app errors empty.
- Native candidate installer verified against a disposable executable: checksum
  rejection and successful lease-checked replacement with backup both passed.
- Full source snapshot matches the tested native runtime source. GitHub upload and
  repair activation are the remaining delivery steps; runtime artifacts stay local.
