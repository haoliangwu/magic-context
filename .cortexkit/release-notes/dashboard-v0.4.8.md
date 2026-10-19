# Dashboard v0.4.8 — Memories project picker fix

## What's Fixed

- **Memories tab project picker showed raw `git:<hash>` / `dir:<hash>` identifiers instead of project names.** A regression from the v0.4.7 Memories filter fix: when the plugin started writing resolved project identities into memory rows, the dashboard's project picker still tried to resolve those identities as filesystem paths. With no path match, the OpenCode/Pi project lookup was skipped and the dropdown rendered the bare identifier.

  Fixed by normalizing each memory's project value to its identity (handling both already-resolved identifiers and legacy raw paths), then matching against the full enumerated project list from OpenCode/Pi by identity. Picker now shows real project names like "magic-context" or "AFT".

## Upgrade

The Tauri auto-updater handles this release. Existing installations should pick it up on next launch or via Help → Check for Updates.
