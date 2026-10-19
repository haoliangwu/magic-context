# Dashboard v0.14.0

Companion release for plugin v0.39.0's per-harness model configuration.

## Per-harness model configuration

- **Historian and Dreamer tabs are now per-harness**: OpenCode and Pi each get their own model configuration, using each harness's native vocabulary — reasoning `variant` on OpenCode, `thinking_level` on Pi.
- **Harness-scoped model pickers**: comboboxes list only the models registered for the harness you are editing, instead of a mixed OpenCode/Pi list.
- **Per-entry fallback qualifiers**: each fallback model carries its own variant or thinking level, matching the new config schema.
- The editor reads and writes the migrated per-harness config shape introduced in plugin v0.39.0. If you still run an older plugin, the dashboard keeps your existing flat keys untouched until the plugin migrates them.

## Fixes

- Project config writes preserve surrounding formatting and comments in more edge cases.
- Log viewer fixes for project-scoped entries.
