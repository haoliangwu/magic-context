# AFT mural adoption on a scheduler defer — 2026-09-22

## Scope and live-store safety

This investigation used read-only SQLite URI connections for the live `context.db` and `store.db`, plus the already-merged provider/pass report. No live store was modified. All regression tests use temporary in-memory or temporary-directory stores.

Session: `ses_313660571ffeZTsf4koSJwk50Q` (OpenCode Rust transform lane). Project: `git:3fba0e3dcc1cb26da9af7a0ccbd98b749e46219b`.

## Answer 1: when the mural was presented and adopted

The adapter first sent mural hash `2968692fda8986d691c132d0efe0bbcfa7ab51d5badefe5844eb658414056330` on the defer pass observed at `2026-09-22T03:10:00.268Z`, bound to assistant message `msg_0c7177c1b00113bFkmUO2AzUZP`. The host manifest records `rendered_at=2026-09-22T03:10:00.439Z`; the module artifact row records `updated_at=2026-09-22T03:10:00.449Z`. The ten-millisecond host/module timestamp gap proves that this pass transported the new artifact. Its durable transform-decision row is `decision=defer, materialized=0`.

The adapter therefore did **not** first present this hash at 11:55. It had presented it 8 h 45 min earlier. Before this change, `resolveMuralForPass` memoized on process-local generation, mirrored cue-pool version, project/model/budget, and the model's image-support verdict. The memo was cleared on module-generation/full-sync recovery and after an asynchronous mirror pull observed a new cue-pool version (`rust-mode-transform.ts:1740-1782`, `:3214-3215`, `:3865-3867`). A durable `mural_manifest` update made outside those events was not itself a key input. The adapter now reads only `content_hash` and `rendered_at`—not PNG bytes—into that key (`rust-mode-transform.ts:1750-1781`), so the next pass carries an externally updated artifact rather than a stale memo.

On the module boundary, OpenCode host input is normalized and upserted into `mc_project_mural_artifacts` immediately before transform dispatch (`crates/mc-module/src/lib.rs:9494-9505`). Claude Code, which has no host image input, reads that project artifact back before transform (`lib.rs:9508-9515`). A status refresh does neither. For OpenCode composition, the transform consumes the request candidate; the module-store artifact is the cross-harness durable copy, not a status-triggered identity refresh.

The 11:54 pass did not adopt the mural because it was `SOFT coverage_fold`, not an m0 rebuild:

- observed `2026-09-22T11:54:36.701Z`, completed `11:54:37.372Z`;
- assistant `msg_0c8f7c6e50012zFrKBylTIZCau`;
- `decision=execute, materialized=0, materialize_reason=coverage_fold`;
- 513 raw OpenCode messages.

Only `PassPlan::Hard | PassPlan::MigrateHard` enters m0 composition (`transform.rs:4861-4877`). A priced SOFT may refresh/fold volatile state without replacing the frozen m0 mural. The markerless pass at `11:55:00.553Z` remained `SOFT+` with 12,746 messages and byte-identical provider-prefix blocks.

The identity changed on the pass observed at `2026-09-22T11:55:13.792Z` (durable row `11:55:13.792Z`, assistant `msg_0c8f853c6001KtVENcHqVZW9Xw`), which completed/logged through `11:55:23.973Z`: `HARD epoch_change`, scheduler `defer`, 12,747 messages. The provider request was written at `11:55:29.581Z`. That pass replaced the prior frozen mural identity with `mur:64:2968692f…`.

## Answer 2: whether mural content is a HARD trigger

In the corrected/current module source, a request mural content change is **not** a `mustMaterialize` trigger. The decision identity deliberately folds the hash from the mural already frozen in the loaded baseline:

```text
transform.rs:3605-3616
persisted_mural_hash = frozen_mural_hash(&loaded.core)
effective_render_config = fold_mural_content_identity(..., persisted_mural_hash)
```

The request's newer candidate is read only after another reason has selected the HARD composition branch (`transform.rs:4861-4895`), and its hash is then committed with the rebuilt baseline. Thus `fold_mural_content_identity` participates in the persisted cache identity, but a candidate mural does not change the pre-decision identity. The 11:55 specimen's mural-only `epoch_change` on a scheduler defer was the defect: the deployed path treated the candidate/durable artifact as a live epoch input and let background work originate a HARD.

The module fixture now makes the distinction explicit. Replacing the frozen-hash operand with the request hash makes `mural_changes_wait_for_a_natural_hard_and_then_replay_byte_identically` fail with `left: "HARD", right: "SOFT+"`. With the corrected operand, the candidate remains deferred.

## TypeScript lane parity

OpenCode and Pi TypeScript modes already follow the desired contract. OpenCode `mustMaterialize` compares mural **enablement** as render configuration (`inject-compartments.ts:1616-1623`), but it never compares `cachedM0MuralHash` with the current hash. The deliberate non-trigger list immediately below includes the analogous m0 project-docs hash (`:1727-1730`). Pi has the same shape: `mustMaterializePi` compares `muralEnabled` at `inject-compartments-pi.ts:1084-1090`, never the mural content hash, returns no trigger at `:1226`, and calls `resolveMuralForM0Pi` only while rebuilding m0 (`:671-692`). The cached mural hash is a record of bytes already frozen into m0, not a HARD predicate.

`inject-compartments-mural.test.ts:104` pins the OpenCode behavior: mural A is materialized, mural B on a non-busting pass returns `{ value: false, reason: null }` and replays mural A byte-identically, and a subsequent independent `system_hash` HARD adopts mural B. `inject-compartments-pi-mural.test.ts:82` now proves the same sequence for Pi: a changed durable manifest replays the frozen image on defer, then an independent `system_hash` HARD adopts the new image.

## Sentinel attribution

Rust responses now expose the changed render-identity components, and the adapter records them as `identity_delta=` on the pass line. `cache-bust-scheduler-log.ts` carries that field into `CacheBustDecisionAttribution`. An `epoch_change` HARD with no restart/deploy/config epoch is `self_inflicted_epoch` when its only component is `mur`, independently of the existing ≥4× raw-input-step fallback (`cache-bust-attribution.ts:350-360`). An external epoch continues to classify as `accounted_hard_epoch`.

## Before and after decisions

| Sequence | Defective specimen / red control | Corrected hermetic fixture |
| --- | --- | --- |
| Baseline mural A | already frozen | `HARD` first render |
| Defer before update | defer | `SOFT+`, byte-identical |
| Mural B appears | 03:10 defer transported it | next defer remains `SOFT+`, byte-identical; identity still mural A |
| Priced non-HARD pass | 11:54 `SOFT coverage_fold`, mural not adopted | unchanged by design; only a HARD rebuilds m0 |
| Scheduler defer | 11:55 `HARD epoch_change` from mural-only identity | remains `SOFT+`; request mural cannot originate a HARD |
| Next independent HARD | not reached before the self-bust | `HARD` from external render-config/system cause; adopts `mur:…:mural-hash-b` |
| Replay | later defers | `SOFT+`, byte-identical to the adopted mural-B prefix |

The adapter fixture separately records request hashes `[mural-hash-a, mural-hash-b]` across a durable artifact update. Neutralizing `content_hash`/`rendered_at` in the memo key makes that fixture fail with `[mural-hash-a, mural-hash-a]`, proving the invalidation guard is non-vacuous.
