# dsh integration: host-plane agent row + in-place shipped-preset patch

The dsh-plugin mounted its whole agent-side surface (memory gate, ctx_* tools, context plane, guidance) inside a generated `magic-standard` agent preset, so Magic Context only existed for sessions that picked that preset — unlike OpenCode, where the plugin is host-wide. We moved the agent rows to the **host plane** (a `dsh-magic-context` row in the package's `cordis.patch.yml`, mounted process-globally by the profile bundle): dsh's scope admission lets untagged host-plane listeners receive every agent's `agent/pre-step` events, and tool/command registrations are global layers, so every preset gets Magic Context. The one thing that cannot be done from the host plane is replacing the compaction engine — it must be a row inside each preset's isolated `compaction` realm, preset compositions mount without external patches, and shipped preset ids cannot be shadowed from roster roots — so the compaction-basic row is patched **in place in the shipped preset files** (tmp+rename atomic writes, never in-place content edits: pnpm node_modules files are hardlinks and in-place writes would pierce the shared store).

## Considered Options

- **Thin preset per stock composition** (`magic-standard` including the stock preset with row patches): the pre-existing approach; only covers sessions that pick it, user-authored presets get nothing. Rejected.
- **Roster config override** (`includeShippedRoot: false` + MC-managed preset copies): no node_modules mutation, but MC snapshots the entire shipped preset set (stale on every dsh update) and clobbers deployment roots config. Rejected.
- **Stable-path indirection wrapper** (fixed path that re-exports MC's engine, falls back to stock): survives MC uninstall/update without preset breakage, at the cost of a runtime file outside package management. Rejected — uninstall is an explicit, rare action; single-user deployment.

## Consequences

- A boot-time self-heal in the host entry patches the shipped preset files **synchronously during `apply()`** (before any session can mount an unpatched preset), anchored by a tiered resolution chain (first tier that verifies as a genuine `@deepseek-ai/dsh-agent-presets` package root wins):
  1. **live roster service** — `ctx.get('agentPresets')` → runtime-read `resolvedRoots` system entries; `SHIPPED_PRESET_ROOT` is derived from the roster module's real location, which under a global-CLI profile boot resolves to the **global pnpm store copy** of the package — the copy the running composition actually loads. A profile's `node_modules/.pnpm` sibling copies are NOT read at runtime by the roster.
  2. **composition base URL** — plain Node resolution from `ctx.baseUrl` (covers flat/hoisted installs).
  3. **MC's own module context** — correct for normal published installs; under a dev symlink install it resolves the repo's `node_modules` copy (harmless no-op when tier 1 already applied).
  The heal re-applies after pnpm store rotation or MC entry path changes.
- Because tier 1 patches the global store copy, sibling profiles **without** MC load the patched row too. `MagicCompactionEngine` therefore **degrades to stock** (`super.summarize`) whenever `magicContextHost` is absent from the composition; when the host is present but the agent-plane hook is unwired it still fails loudly (fail-closed only inside MC profiles).
- Contract-scan failure (dsh changed the compaction group shape) fails **open**: one warning line, no patch, stock compaction runs; doctor reports it persistently. Magic Context's remaining surface keeps working.
- User-root presets (`~/.agent-presets/`) are never touched.
- Legacy `magic-standard` presets are removed at boot (shape-verified as MC-generated before deletion).
- Removing MC from a profile leaves the patched name pointing at a missing path — the affected preset mounts broken until reinstalled or `pnpm update` rotates the files. Accepted: single-user deployment; doctor surfaces the state.

## Live verification (2026-09-19, mc profile)

End-to-end verified on the real mc profile (browser-driven): stock `standard` preset session with host-plane MC active — `§N§` tag prefix injected on the user turn, all `/ctx-*` commands registered, "Magic Context 状态" header + Context tab rendering, storage `ok · schema v84/84`, full LLM turn completing (DeepSeek-V4-Flash via rakuten-in-house-llm). Legacy `magic-standard` absent from the roster. Residual: the status panel's `preset` row still reports `missing` — it probes for the legacy thin preset and should report shipped-preset patch state instead (follow-up ticket).

Migration operations performed on the mc profile during verification (all idempotent):
- deleted the empty stale draft `session-76a56a60` (0 messages) and its `workspace.json` listing;
- rewrote `agentPreset: "magic-standard" → "standard"` in all 16 session header lines (zstd repair: first frame must contain exactly the one header line) and in `storages/session_projcache/sessions/*.json` preset rows — the web composer reads the preset from the projcache, not the session log;
- fixed the stale `agent-default-model.provider` `vision-toolkit-rakuten-in-house-llm → rakuten-in-house-llm` in `~/.dsh/settings.yaml` (the old id resolves to no route in any profile's catalog → composer blocked with "model unavailable"; the actual registered provider id is `rakuten-in-house-llm` in both mc and web profiles).
