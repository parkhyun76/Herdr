# Personal Herdr Windows fork

This repository is the owner-authorized personal fork of herdrdev/herdr-app.
For changes here, the owner's instructions take precedence over upstream release
and maintainer approval rules in native/herdr-app/AGENTS.md. Do not contact or
publish to upstream. Preserve user data and running core/AI processes.

Native app source is native/herdr-app; custom interface source is mods/. Root
Node tests: node --test tests/*.test.cjs tests/*.test.mjs (expand file globs on
older Windows Node versions). Native build instructions are docs/BUILD-WINDOWS.md.
Never commit auth, diagnostics, transcripts, user settings or build products.

Automatic repair tasks are explicitly authorized to propose narrow UI fixes in
the private repair worktree. Protect the repair host, dependencies, credentials,
session restoration, updates and process/network control. Do not weaken tests.
Do not run terminal-title commands from an automated repair worker.
