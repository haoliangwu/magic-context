# dsh integration: no shipped-preset patching — stock compaction + audit

Date: 2026-09-20 · Supersedes the compaction half of `0001-dsh-host-plane-preset-patch.md` (the host-plane agent row stays).

## Context

ADR 0001 made the host entry patch the shipped preset files in place so every
session's `compaction-basic` row mounted `MagicCompactionEngine`. Two problems:

1. **Shared-file blast radius.** The patched files (0.1:
   `@deepseek-ai/dsh-agent-presets` preset files; 0.2: the
   `@deepseek-ai/dsh-web-app` preset declarations) are shared by EVERY profile
   on the machine and ship with the DSH install — they are not ours to
   modify. Profiles without the plugin loaded the patched row too (ADR 0001
   accepted this via engine degradation), and uninstall/reinstall rotation
   left rows pointing at missing paths.
2. **0.2 makes it unsound anyway.** DSH 0.2 moved preset declarations into
   `dsh-web-app`'s `presets/<id>.patch.yml` entry patches: the
   `compaction-basic` row sits nested inside the inserted
   `@deepseek-ai/dsh-agent-preset` row's `config.plugins`. Entry patches can
   only address top-level rows and `cordis:group` subtrees
   (`applyEntryPatches`/`buildMap` in `cordis-plugin-include`), so the row is
   unreachable from any patch layer — host plane included. The only way to
   reach it was editing the shipped files themselves.

Research (reading the 0.1/0.2 runtime sources) also established:

- Removing the patch does NOT disable native compaction: the stock
  `compaction-basic` rows keep folding with stock LLM summaries.
- Magic's planes (historian, dreamer, tags/drops, coordinator CAS, m0/m1
  baseline) do NOT depend on the engine mount; they survive stock folds
  through their own reconciliation. The minimal preset proves sessions run
  fine with no compaction service at all, so an unwired Magic fold path is
  harmless.
- Magic's own fold wiring on DSH was never completed anyway
  (`applyDshCompactionMarkerIfCovered` has no production caller; the
  recomp/wrapup/emergency mutation stages "arrive with later slices").

## Decision

1. **Never write shipped presets.** Delete the in-place patcher entirely
   (`patchShippedPresets` / rewrite / atomic-write paths). Shipped
   `standard` / `ptc` / `cordis` / `minimal` (and any future preset) stay
   byte-stock on disk.
2. **Keep native compaction untouched.** The stock engine owns the fold
   transaction; Magic reconciles after each fold.
3. **Keep the optional mounting path.** `MagicCompactionEngine`
   (`entries/compaction.ts`) plus the `registerSummarizeHook` host-service
   API stay shipped and are harmless when unmounted. Users who want
   Magic-aware fold summaries mount the engine from a USER-OWNED preset
   (recipe in the package README, "Compaction").
4. **Audit instead of heal.** `doctor`/`setup`/status report a read-only
   audit of both layouts: `stock` (ok), `mc-patched` /
   `mc-patched-rotted` (fail — leftovers from ≤ 0.45, with restore
   instructions), `foreign` (warn). The only boot-time write left is deleting
   the plugin-OWNED legacy `magic-standard` thin preset
   (shape-verified first).

## Consequences

- Uninstall is fully clean: nothing outside the plugin's own artifacts was
  ever modified (post-migration machines).
- Machines that ran ≤ 0.45 get a `fail` audit row with exact restore
  instructions (row `name` back to `@deepseek-ai/dsh-compaction-basic`, drop
  the `config: { auto: true }` line) — or reinstall the DSH packages.
- Sessions without the optional user preset lose only Magic-flavored fold
  summaries; durability guarantees are identical (stock summaries).
- The DSH-side fold stages (marker drain, recomp/wrapup integration) remain
  future work; nothing in this ADR depends on them.
