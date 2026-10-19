# Dashboard v0.9.1

A patch release fixing model discovery for pnpm-installed OpenCode on Windows.

## Fixes

- **Finds a pnpm-installed OpenCode CLI on Windows (#149).** pnpm places global binaries at `%LOCALAPPDATA%\pnpm\bin\opencode.cmd`, which is not on the GUI process's PATH and was not in the set of locations the dashboard checks, so model dropdowns came up empty for pnpm users. That path (and the pnpm store location) is now included, so the dashboard discovers and queries a pnpm-installed OpenCode. Verified on Windows. Thanks to @nielpattin for the report and diagnosis.

## Maintenance

- The updater manifest now pins download URLs to each release tag, so Desktop auto-update keeps working regardless of which package release is GitHub's "latest" (the earlier broken manifest was already corrected in place).
