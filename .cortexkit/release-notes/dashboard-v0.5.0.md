# Dashboard v0.5.0 — Historian v2 support, faster navigation, richer Dreamer insight

This release brings the dashboard in line with the Historian v2 architecture shipped in plugin v0.22.0, makes navigation noticeably snappier on large databases, and adds new visibility into what the Dreamer actually changed.

## Historian v2 support

- **Compartment viewer understands the new tiered model.** Compartments now display their importance score and episode types, with an expandable P1–P4 tier view that mirrors the runtime renderer's tier-resolution logic. Legacy v1 compartments are clearly marked.
- **Memory mutation parity.** The dashboard mirrors the plugin's memory supersede-delta behavior: editing, archiving, merging, or deleting a memory records the same mutation-log rows and epoch handling as the plugin, so the cache stays consistent across both. Memory content editing now surfaces a friendly conflict message instead of a raw SQLite error when a duplicate exists.
- **Token breakdown corrected for v2.** The session token view extracts the actual `<session-history>` slice that's on the wire instead of over-counting full compartment text, and the retired "Facts" category is gone.

## Faster navigation

- **DB and filesystem reads run off the UI thread.** All 52 SQLite/FS commands moved to background worker threads, so opening sessions, switching tabs, and loading large projects no longer freeze the window.
- **Instant History re-entry.** The project dropdown is cached, and the session list no longer scans the entire message table just to show a per-session count — navigating back into History is immediate.

## Richer Dreamer insight

- **Memory Changes drill-down.** Each Dreamer run is now expandable to show exactly which memories were written, archived, or merged during that run.
- **Honest token costs.** Dreamer and subagent token usage is shown as `input: X · output: Y` (the meaningful fresh tokens) instead of a cache-inflated total that double-counted re-read context across turns. The full breakdown remains in the row tooltip.
- **Correct project names.** The Dreamer panel resolves real project names instead of showing bare `git:<hash>` identifiers.

## Fixes & hardening

- Project-identity resolution between the dashboard (Rust) and plugin (TypeScript) is now byte-equivalent, including the git-error fallback policy, so projects group consistently across both.
- Key-files and smart-notes panels resolve symlinked / legacy project paths correctly.
- Cache Hit Timeline caps to the most-recent N steps (200/400/600 selectable) instead of rendering every step.
- Several correctness fixes from the full-codebase audit sweep (path normalization, fail-closed identity handling, mutation-log integrity).

## Upgrade

The Tauri auto-updater handles this release. Existing installations should pick it up on next launch or via Help → Check for Updates.
