Adds Oh My Pi session support, fixes duplicated Claude Code usage rows, and closes a config-security hole.

## Added

**Oh My Pi (OMP) sessions.** The dashboard now discovers and reads OMP session directories alongside the harnesses it already supported, so OMP sessions appear in the session list and cache views with the same detail as the rest.

## Fixed

**Claude Code usage was counted twice per step.** Claude Code writes a separate transcript entry for each content block of the same API message, and the dashboard treated each entry as its own request — so a single step showed up as several rows, and totals were inflated. Usage records are now deduplicated per message, keeping the final block's figures.

**Repository config could bypass project-tier security checks.** A repository's own `.cortexkit/magic-context.jsonc` could smuggle settings past the untrusted-config strip via a prototype-pollution key, reaching fields meant to be user-tier only. Config parsing now rejects those keys outright and merges are prototype-safe. Opening an untrusted repository was enough to trigger it.

**A missing build-time dependency could fail the release build.** Corrected so the packaged build resolves it.
