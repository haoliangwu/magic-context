# Rust-mode plugin todo and mural stage caches

## Scope and reads

Only the OpenCode adapter and its tests change. No Rust code, module request/response contract, schema, manifest or lockfile changes. `ARCHITECTURE.md` and `STRUCTURE.md` are untouched. Measurements use fixtures, not either live daemon's sessions.

`rust-mode-transform.ts` has two distinct costs:

- `todo_probe` is the parallel SDK `app.agents()` / `session.get()` permission read, followed by OpenCode's last-rule permission evaluator. The tools-map availability is frozen from the first user message (or, before messages arrive, a read-only OpenCode-store query). `context.db` supplies/persists the last successful denial. `todo_verdict` includes that probe and adapter bookkeeping. Its old identity also serialized unrelated render inputs, including the entire mural data URL, and read two project-state rows. Full-wire sends and frozen replay were independent probe reasons.
- `mural_resolve` selects active/permanent, unexpired project memories from `context.db`, reads cues, hashes their source contents, tokenizes the budget selection, resolves ordered entries, and checks the stored mural image. Even the render-cache hit reads and compares the PNG BLOB. A miss can plan/render/upsert a PNG and base64-encode it. Existing adapter caching skipped ordinary defers, but every predicted HARD opportunity re-resolved an unchanged candidate.

## Change

The todo verdict identity is now the active agent, frozen tools-map verdict, compaction-off setting, persisted todo snapshot, and todo-only message signatures. Signatures survive wire-cache eviction; delta passes inspect the tail, and full passes inspect only tool parts for todo signatures, never serialize the full wire or mural into the permission key. New calls, in-place/late todo completions, removals and agent changes invalidate it. Existing denial persistence/failure retention remains unchanged.

Cold/missing verdicts still prime the cache. Bust predictors (model/system/marker/floor change, pressure, explicit refresh, memory sync, module hint, emergency, queued drops and idle expiry) revalidate when a todo snapshot exists. Full-wire transport and frozen replay alone do not. A full retry can still revalidate when it could need a synthetic reminder. Unexpected module-owned busts retain the existing audit signal; no protocol semantics were changed.

Mural candidates remain frozen on ordinary defer passes, as before. At a refresh opportunity, a compact source SHA-256 plus the stored manifest's `content_hash` / `rendered_at` determines reuse. The source includes exact content/cues, category, importance, status, reinforcement timestamps, eligible-set ordering and expiry filtering. It therefore observes deletions, stale cues and budget-selection changes even before a new mural has been published. Vision capability, model, project and budget remain cache-key inputs. Publishing a render records the post-write manifest identity.

The source check is still O(project source text) at a refresh opportunity: there is no authoritative cue epoch to use without a schema change. It is one prepared SQLite JSON aggregation/hash, not hydration, tokenization, cue-resolution, PNG reading/comparison or base64 encoding. Unsupported-vision models do not scan the source. Manifest identity follows the existing writer revision convention; this does not detect an out-of-contract hand edit of a PNG that preserves both identity fields.

## Byte equality and measurements

Baseline: the actual pre-change adapter at `a669d7bcdbcdf0112f34fd04fe6c46877d50fe70`, plus the pre-change bundle from the prepared worktree build. Bun 1.4.2; OpenCode 1.18.30. Timings below are milliseconds, as logged (0.1 ms precision). They are not a reproduction of a loaded live ALF process's 204 ms SDK latency.

### Adapter fixture

64 paired passes, each arm receiving the same 2,000-message input sequence and 400-memory cue pool. Exercises full-wire eviction, unrelated old-message edits, pressure, a changed cue, late todo completion, permission denial/allow flips and a bust dropping the origin todowrite. A deterministic materializer consumes the actual todo/mural candidates rather than returning a fixed echo. Complete serialized native arrays and the candidate inputs match on all passes; explicit assertions check absence of the origin, presence of the synthetic pair, removal under denial and restoration under allow.

- Permission probes: **64 -> 11**.
- Mural resolutions: **10 -> 2** (bootstrap and the changed cue).
- `todo_probe`: median 0 -> 0, p90 0 -> 0 (in-process permission fixture; no artificial delay).
- `todo_verdict`: median 0.1 -> 0.2, p90 0.2 -> 0.7; the fixture does not model SDK latency.
- `mural_resolve`: median 0 -> 0, p90 **5.1 -> 0.9**. Cold-render max 123.4 -> 283.7 is noisy; no cold-render speedup is claimed.

### Real module, real SDK, same inputs

48 paired passes through separate hermetic modules with the same 2,000-message sequence, 100-memory pool and fixed memory timestamps (reinforcement timestamps affect selection). All full serialized outputs compare equal, without omitting fields or normalizing IDs. Pass 8 drops the origin on a priced rebuild and explicitly verifies the synthetic todo pair. The final 24 passes clear the todo snapshot and maintain pressure, checking that pressure without todo state does not poll permissions or re-resolve an unchanged mural. Calls use the real throwaway OpenCode permission APIs.

| Stage | Median before / after | p90 before / after | Max before / after |
|---|---:|---:|---:|
| `todo_probe` (48 passes) | **3.9 / 0** | **8.9 / 0** | 16.4 / 69.7 |
| `todo_verdict` (48 passes) | **4.0 / 0.1** | **9.6 / 0.4** | 21.2 / 71.4 |
| `mural_resolve` (48 passes) | **0.9 / 0.2** | **2.3 / 0.5** | 14.8 / 7.1 |
| `todo_probe` (24 pressure passes, no snapshot) | **5.6 / 0** | **7.5 / 0** | 9.7 / 4.6 |
| `todo_verdict` (same pressure passes) | **5.9 / 0.1** | **7.6 / 0.4** | 9.7 / 4.8 |
| `mural_resolve` (same pressure passes) | **1.3 / 0.3** | **2.5 / 0.6** | 2.8 / 0.8 |

Required probes: **33 -> 3**. Cold/changed-state probes remain network-dependent; their max is not improved by caching.

### Actual OpenCode hooks

Each arm also sends 16 normal prompts through the OpenCode process's plugin hooks, transport and serializer. These steady defers already cached well before the change: medians remain `todo_probe=0`, `todo_verdict=0.1`, `mural_resolve=0`. Max before/after: probe 6.3/3.6, verdict 518.7/4.1 (one noisy before-pass bookkeeping outlier), mural 15.8/11.8. These are smoke/isolation evidence, not a live-load performance prediction.

## Isolation and provisioning

Artifacts live at `$TMPDIR/magic-context/bg_162f33427ad78173/host/`: `summary.json`, before/after adapter and plugin logs, `*-isolation.json`, and `*-lsof.txt`. The host inventories contain only throwaway `opencode.db`, `context.db` and their WAL/SHM files. `ps eww` verifies HOME, CFFIXED_USER_HOME, all five XDG directories, OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR beneath that root. The harness creates its own subc connection/run directory and never connects to the live socket. Fixture processes are disposed after evidence collection.

The initial local release build timed out after 900 seconds behind shared native compile slots, before a host/daemon started. The parent supplied verified placed binaries, stating that Rust/Cargo.lock were identical between the task base and their module build. Both were **copied** to `$TMPDIR/magic-context/bg_162f33427ad78173/bin/` before execution:

- `ck-mc 0.1.0 (5d7bce016dbd8942080c05e6485240ee84ff7bce)`, SHA-256 `5caaa0b0fe6cc7fec5face04dd1b24fc1bfee1de3a5e29cc856fdf7b367297a3`.
- `ck-subc 0.20.58`, SHA-256 `6773e48c871eaa9d46c08d9cfd2625268578932c38ed923a437dd6f72af2495c`.

Only the copies were executed, through the normal hermetic test setup. No production binary was executed in place.

The opt-in e2e test uses `MC_RUST_STAGE_BASELINE` (absolute path to the pre-change source extracted beside the current transform, preserving imports), `MC_RUST_STAGE_BASELINE_BUNDLE`, `MC_RUST_STAGE_ROOT`, and the harness's copied prebuilt module/daemon variables. Run it from `packages/e2e-tests` with `bun test --timeout 900000 tests/rust-plugin-stage-cache.test.ts`. The 64-pass fixture takes `MAGIC_CONTEXT_RUST_STAGE_BASELINE=./rust-mode-transform.baseline.ts` and `MAGIC_CONTEXT_HOTPATH_MEASURE=1` when run from `packages/plugin`. Baseline extraction files are temporary and are not committed.

## Gates and non-vacuity

- Plugin full suite: 7,254 pass, 6 skip, 3 fail initially. The task-related failure expected five full mural resolutions; it now checks five source revisions, one resolution, one render, and the original stable-artifact/vision assertions. This is an instrumentation expectation change, not a relaxation of served-byte correctness. Two unrelated failures were npm-pack and git-init resource timeouts. The corrected mural and both timeout suites then passed: 9 tests, 0 failures. Final impacted adapter suite: **201 pass, 1 existing skip, 0 fail** across three files.
- Existing synthetic-todo and mural coverage: **58 pass**, 0 failures across nine files.
- Workspace typecheck and final plugin build passed; TypeScript 5.9.3. Build also ran four server tests (all passed).
- `bun run lint` reaches the plugin's 1,259 files and fails solely on pre-existing formatting in `src/config/removed-agent-source-fence.test.ts:55`. That file is byte-identical to HEAD and intentionally not fixed. `bun run --cwd packages/plugin lint -- --staged` passes for all five changed plugin files (Biome 2.5.1), with two existing unused-parameter warnings in the large adapter test.
- Four Rust hermetic shards are not required: no module contract or Rust change. The additional real-module/host differential above passed **1 test, 136 assertions**.
- AFT TypeScript diagnostics found no runtime errors; its checkout graph/Biome analysis was unavailable, and the final e2e analysis did not publish within the inspect budget. An additional scoped TypeScript 5.9.3 check of the e2e entry and its dependencies reports only the existing `src/rust-harness.ts:800` error: its `SdkClient.session` interface omits `get`. No error is reported in the new test. The harness interface is outside scope and unchanged; the actual host gate passes. The temporary typecheck configuration is removed.

Two staged-state mutation proofs use the exact `NON-VACUITY BREAK` token, record a non-empty working diff, run two named tests, then restore from the staged live file and confirm an empty working diff:

1. Neutralizing the mural source revision reddens only `keeps all served bytes identical across 64 todo and mural cache passes`; the todo invalidation test stays green. The first failure is full output equality after the changed cue.
2. Neutralizing todo part signatures reddens only `probes changed todowrites and agent identity, not full-wire retries or unrelated refreshes`; the 64-pass output differential stays green. The failed assertion expects two SDK reads after a late completion and receives one.

Both tests pass again after restoration. No mutant is committed.
