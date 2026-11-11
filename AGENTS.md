# Personal Herdr Windows fork

This repository is the owner-authorized personal fork of herdrdev/herdr-app.
For changes here, the owner's instructions take precedence over upstream release
and maintainer approval rules in native/herdr-app/AGENTS.md. Do not contact or
publish to upstream. Preserve user data and running core/AI processes.

Native app source is native/herdr-app; custom interface source is mods/. Root
Node tests: node --test tests/*.test.cjs tests/*.test.mjs (expand file globs on
older Windows Node versions). Native build instructions are docs/BUILD-WINDOWS.md.
Never commit auth, diagnostics, transcripts, user settings or build products.

## Local Windows maintenance assets

Read `.local/HERDR-WINDOWS-IMPROVEMENTS.md` before Windows app maintenance and
update that same record afterward. Cached source, build tools and historical
evidence live in `.local/herdr-customization/`; all of `.local/` stays out of Git.
See `docs/LOCAL-HERDR-ASSETS.md` for current paths and verification.
In a private repair worktree, resolve `.local/` against `auto-repair.json`'s
`repository` directory; the local assets are not copied into repair worktrees.

## Commit completed development

After completing development and the required verification, commit the changes
for that task automatically before reporting completion. Include only the task's
files and preserve unrelated work. Report the commit ID and verification result.
Push to GitHub when the user requests it.

## Test temporary files

Use the operating system's temporary directory for test scratch files (on
Windows, `std::env::temp_dir()` or the equivalent resolves to the user's temp
directory). Do not use a drive-root path such as `D:\var`. Give each test run a
uniquely named directory and remove the files and directories it created when
the test finishes, including on failure where possible. Verify cleanup and
report any leftovers that could not be removed. Keep explicitly requested test
evidence or backups separately. Never delete pre-existing or unrelated files,
or files still in use by another process.

Automatic repair tasks are explicitly authorized to propose narrow UI fixes in
the private repair worktree. Protect the repair host, dependencies, credentials,
session restoration, updates and process/network control. Do not weaken tests.
Do not run terminal-title commands from an automated repair worker.
