# Dashboard v0.6.0

Adds the Workspaces panel and fixes model dropdowns for version-manager installs.

## New: Workspaces panel

Manage cross-project workspaces directly from the dashboard. Create a workspace, add member projects, and choose which memory categories members share with each other (Constraints only, by default). Edits are staged per card — add and remove members, toggle categories, then **Save** once, so the change applies as a single update instead of one per click.

Memories from other workspace members appear in each member session labelled by their source project. (Requires the v0.23.2 plugin, which owns the workspace schema; the panel degrades gracefully on older plugin versions.)

## Fixes

- **Model dropdowns were empty for version-manager installs.** If your `pi` or `opencode` binary is installed by a version manager (mise, nvm, fnm, volta, asdf), the dashboard couldn't find it — the desktop app doesn't inherit your shell `PATH` — so the model comboboxes came up empty. The dashboard now resolves the binary through your login shell (and known version-manager directories), bounded by a short timeout.
- **Workspaces panel layout** — corrected double padding on the panel and tidied the shared-categories checkboxes to match the dark theme; Save/Discard now appear only when there are unsaved edits.
