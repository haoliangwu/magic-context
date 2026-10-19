# Dashboard v0.5.4

Companion release for plugin v0.23.0 — keeps the config editor in sync with the new context-reduction system.

## Changes

- **Config editor updated for v0.23.0.** The removed context-reduction keys (`auto_drop_tool_age`, `drop_tool_structure`, `nudge_interval_tokens`, `iteration_nudge_threshold`) are gone from the editor, so editing a config from the dashboard can no longer re-introduce keys the plugin removed. The schema parity guard now covers the new surface.
- **Dependency updates**: `tar` and `openssl` bumped in the Tauri backend (dependabot security updates).

## Compatibility

Works with plugin v0.23.0 databases (schema v32). If you edit configs from the dashboard, update both around the same time.
