# Dashboard v0.4.7 — Memories tab project filter fix

## What's Fixed

- **Memories tab returned zero results when filtering by project (#87).** The frontend sends the resolved project identity (e.g. `git:<commit-hash>`) as the filter value, but the backend was querying `memories WHERE project_path = ?` against raw filesystem paths stored on each memory row. The two never matched, so filtering any project showed no memories even when memories existed for that project.

  Fixed by resolving the incoming identity to all stored paths that belong to it (a single `git:` identity can cover multiple worktrees and clones writing into the same shared memory pool) and querying with an `IN (...)` clause across the full set. Identical to the path History already used, so both tabs now agree on what "this project" means.

## Upgrade

The Tauri auto-updater handles this release. Existing installations should pick it up on next launch or via Help → Check for Updates.
