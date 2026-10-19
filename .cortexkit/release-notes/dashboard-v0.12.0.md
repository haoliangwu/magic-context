# Magic Context Dashboard v0.12.0

## Configuration editor

- Full support for the v0.35.0 configuration surface: `prompt_surface` presets (full/light with per-model routing), `compaction.enabled`, `output_reserve`, `cache_ttl: "never"`, the top-level `mural` block, `storage.enforce_private_permissions`, `allow_home_project`, embedding dtype, and `pi.subagent_extensions`.
- User-tier-only settings are no longer offered when editing project-level configuration.
- Removed the deprecated `experimental.mural` reference.

## Dreamer

- Task cards now match the current task set, including `compress-cues`; removed the retired `render-mural` card (murals render automatically on context folds).
- `verify-broad` cycles with banked progress display as in-progress instead of failed.

## Fixes

- Cache page handles never-expiring cache lanes correctly.
- Updated stale threshold copy to reflect the raised 90% execute-threshold cap with explicit output reservation.
