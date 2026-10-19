## Dashboard v0.15.0

### Turn detection matches the harness
Turns are now reconstructed from OpenCode's own assistant `parentID` instead of `tool-calls` finish strings. Interrupted tool turns, queued user messages, and tool continuations no longer split or merge turns differently from what OpenCode shows.

### OMP as a first-class harness
The config editor gains `historian.omp` and `dreamer.omp` blocks with OMP's own thinking vocabulary, harness-scoped model comboboxes, and OMP session scanning in the sessions view.

### Per-repository config profiles
User-level `profiles` (historian, dreamer, sidekick model overlays) and the repo-level `profile` selector are editable, with project-over-user precedence shown as resolved.

### Dreamer failure detail
Failed dreamer runs now show why: a closed failure class (`provider_timeout`, `provider_error`, `empty_completion`, `no_models`, `child_aborted`, `parse_failed`, `unknown`) with the attempted model, the provider's first error line, the timeout in effect, and the child session ID. Legacy rows keep their old text.

### Config problems are visible
An unparseable `magic-context.jsonc` (for example a stray character on line 1) is reported in the dashboard instead of silently loading defaults. `cache_ttl` status shows the value resolved from live config and model identity, labeled with its provenance, rather than the stored seed.

### Storage location
The dashboard honors `MAGIC_CONTEXT_STORAGE_DIR` and reports whether the storage path came from the environment or the platform default.
