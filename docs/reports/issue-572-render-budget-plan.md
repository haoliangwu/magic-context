# Issue 572: render-budget identity diagnosis and plan

## Confirmed source

The reporter's follow-up shows an unconfigured ninfer model going from catalog input limit 229376 to proven accepted input 261171 between two `render_config` folds. That successful-input high-water mark can keep rising. The history identity was computed from the *derived* token budget, so a new window observation masqueraded as a render-config edit.

The configured-window control did **not** reproduce: OpenCode 1.18.30, OpenAI Responses mock, non-catalog `mock-ninfer/Qwen3.8-27B`, context 262144/output 8192. Its stable usable window 253952 produced `m4000-h15237` before and after restart. Mural=false throughout. The persisted API cache seeded successfully.

A separate fallback probe did reproduce `h12000 → h60000 → h12000`: the first-pass pressure reset zeros usage, and `loadPersistedUsage` then hides the persisted denominator. A metadata-only getter fix was considered, but would not stop the reporter's repeated proven-floor increases. It is **not implemented**.

## Selected cache-change plan

- History identity records the effective MC policy: history fraction plus the selected execute percentage or configured token threshold. Resolve per-model overrides with the existing threshold resolver, canonical aliases and fallback rules. A fixed large denominator selects the unclamped configured token override; live-window caps are still applied by the runtime budget resolver.
- Absolute memory injection budget remains the memory component. Mural remains the boot-resolved boolean, not a capability observation.
- Runtime history budgeting, pressure, overflow handling, and natural HARD folds keep using the live window. A catalog, proven-input, learned-overflow, or host `limit.context` edit alone rides the next natural HARD. An explicit MC budget-policy edit folds once.
- Legacy numeric history identities have no recorded policy: compare their absolute memory component but adopt history policy only on the next natural HARD. Do not migrate, bump epochs, or change prompt tags. Direct callers without policy retain absolute-budget semantics.
- OpenCode fast marker refresh, uncached marker reads, materialization, fallback rendering and every postprocess preflight receive the same policy. Pi's normal and compaction-off pipelines receive the same shared policy identity; Pi also derives token budgets from a live window and needs the same separation.
- Split off-wire reasons into `render_config:memory_disabled`, `render_config:mural(old→new)`, and `render_config:budget(old→new)`. Preserve trigger order and null-component legacy behavior.

## Adversarial review inputs

The pre-edit adversarial reads identified: unknown-to-known model-key recovery, selected token versus percentage mode, unrelated model overrides, legacy memory edits, fast/uncached marker consistency, and both Pi pipelines. Tests pin canonical alias selection, selected token overrides, legacy adoption on a natural system-hash HARD, memory edits, and one-fold policy edits. The old memory-off and mural tests retain their behavioral claims; only diagnostic expectations change.

The initial policy candidate left host-window edit semantics ambiguous. The task-giver explicitly selected ride-only window observations after the reporter's confirmation. No window/source freezing or pressure getter changes are included. A separate adversarial cache review is still required before merge.

## Real host reproduction

Harness: `packages/e2e-tests/scripts/issue-572-probe.ts`. Run with `TMPDIR` under a throwaway `magic-context/issue-572` root. Modes are `configured`, `fallback`, `learned`, and `proven`; the last optionally accepts `baseline` or `stable` as an assertion gate. `MC_E2E_PLUGIN_ENTRY` selects an archived master source for the baseline.

Every spawned host uses isolated XDG data/config/state/runtime/cache directories, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR. `lsof -p <pid> -Fn` asserts every open database is below that fixture's real data path. No live store was opened. The harness performs its normal fresh-fixture schema initialization and legacy config relocation; no migration code is changed.

The proven case has no configured `limit` object and no catalog model metadata. Growing roughly million-byte user prompts receive mock provider usage 261171, 270000 and 280000. Usage is scripted telemetry, not a claim about a real tokenizer. A fourth turn consumes the final high-water observation. Each turn asserts a provider request occurred. The fixture seeds a compartment and project memory before restart. It uses `compaction.enabled=false` to isolate identity folds from mandatory high-pressure scheduler/force folds: historical rows exist but are not rendered in this mode. Full history rendering and byte replay are separately covered by unit tests and differential replay.

### Archived master (9859430857ff1ccb8bc6c6c6bbb5c05a0f4063b7)

Root: `opencode-e2e-1790718154090-9ln7lr` under the throwaway root. Each restart pass folded with `reason=render_config`:

| Pass | Cached history | Current history | Source |
| --- | ---: | ---: | --- |
| 1 | 12000 | 60000 | pressure reset hides persisted fallback denominator; renderer default |
| 2 | 60000 | 15670 | accepted input 261171 × 0.40 × 0.15 |
| 3 | 15670 | 16200 | accepted input 270000 × 0.40 × 0.15 |
| 4 | 16200 | 16800 | accepted input 280000 × 0.40 × 0.15 |

Memory=4000, mural=false, upgrade=ready, compartment epoch=cre2 and memory epoch=mre3 throughout. The stable configured control and learned-only overflow case distinguish these sources: the learned case's `prepared prompt exceeds Engine max_context 262144` uses the detected-limit arm on the first restart pass, yielding one expected transition to history=15728 without a second fold.

This small compaction-off fixture's m[0] hash stayed the same even on the redundant baseline folds; the proof here is repeated materialization, not a claimed 130K-token prefill. The reporter's larger rendered history explains the production byte/prefill impact.

### Candidate

Root: `opencode-e2e-1790718172758-whicpr` under the same throwaway root. Restart passes 1–4 all replayed `m4000-hp0.15:percentage:40` with `rematerialized=false, reason=cache_hit`, while accepted input rose to 261171, 270000, then 280000. No restart rebuild was needed. The prefix SHA-256 was constant: `cf7f69ed2f43d4029b84525d7dcc762b6db0544d1fc79902cd250fba8e6f0db0`.

Editing `history_budget_percentage` from 0.15 to 0.2 and restarting produced exactly one fold:

```
render_config:budget(m4000-hp0.15:percentage:40→m4000-hp0.2:percentage:40)
```

The next two turns were cache hits. The gate checks that no `render_config:` diagnostic occurs in any captured provider request.

## Verification gates

- OpenCode targeted materialization, mural, history policy/resolver, epoch and postprocess tests: 339 passed.
- Pi targeted materialization, mural and history-budget tests: 77 passed.
- Both package typechecks pass.
- Restoring the old volatile identity function makes exactly the new OpenCode regression fail; restoring the Pi equivalent makes exactly the new Pi regression fail. Both controls were staged first, showed a nonempty mutation diff, then restored to an empty diff. The restored tests pass.
- OpenCode and Pi production builds pass; targeted lint passes (two existing non-null-assertion warnings in Pi mural tests).
- E2E-wide `tsc --noEmit` has unrelated existing failures in retina import resolution, command-handler SDK types, issue-564 probe, Rust harness/replay and OpenCode 2 tests. After correcting the new probe's compartment-input shape, it has no diagnostics in that run. The changed runtime packages' authoritative typechecks both pass.
- Pure replay against master reports `RESULT IDENTICAL defer_passes=4`: 588/754/920/1088 bytes, with equal message, system and tool hashes on each pass. The final master comparison uses master `7107b47a8f8e5a17b40fc3d6ab6a1f40a0cf5a2c`; the earlier host baseline intentionally remains the task's starting master snapshot `9859430857ff1ccb8bc6c6c6bbb5c05a0f4063b7`.

The differential replay script actually lives at `packages/e2e-tests/scripts/pure-replay-differential.ts` (not the plugin scripts directory). All replay hosts use the throwaway TMPDIR root. Replay isolation is audited concurrently with lsof, as well as by the probe's built-in isolation gate.
