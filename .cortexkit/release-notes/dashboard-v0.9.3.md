# Dashboard v0.9.3

Config editor alignment with plugin v0.31.0.

## Changed

- Removed the retired `ctx_reduce_enabled` toggle from the General section. Agent-controlled reduction is always on as of plugin v0.31.0.
- Caveman Text Compression no longer shows the "has no effect while Agent Controlled Reduction is enabled" warning; the setting is independent now and the description reflects that (active for primary sessions when enabled, never for subagents).
- The bundled configuration schema matches plugin v0.31.0.
