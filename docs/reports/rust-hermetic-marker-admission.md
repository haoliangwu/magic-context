# Rust hermetic drift: pre-cut admission regression

## Two-variable control, before any fix

Same `rust-fold-under-pressure.test.ts` test, current hermetic runner, Bun 1.4.2
(`744846f84`), OpenCode 1.18.32, release binaries built with Cargo 1.99.0 and
`-j 2`. The MC column selects both the plugin bundle and the module binary.
Daemon sources are detached worktrees of a private public-repository clone.

| MC revision | ck-subc ab4f6dfd (0.20.56) | ck-subc b5aba1a1 (0.20.57) |
| --- | --- | --- |
| 7068e095 | PASS: 1 test, 4 assertions | PASS: 1 test, 4 assertions |
| 1a2a63fb (worker's master baseline) | FAIL: native output admission | FAIL: native output admission |

The daemon change is not the cause. The old module was built against the green
run's commons `79788539ad67f0604463c21215f516a49ac07444` and subconscious
`ab4f6dfd264d765ab0783c1e345aa82ab0997ed3`; the current module uses its committed
registry/Git dependencies. The selected pressure test is unchanged between MC
revisions. The old source lockfile updates its path-package version labels to
the selected green sibling versions, just as Cargo did in that CI lane.

All runs used fresh roots below `$TMPDIR/magic-context/bg_134ac8c3a6b9bcc2/`.
XDG config/data/state/runtime, OpenCode DB, and MC storage were isolated.
`lsof -p <host pid> -Fn` snapshots listed only database paths below that root
(4–5 distinct snapshots per matrix cell; zero violations). No live stores were
opened. Retained raw logs and fixture databases are below that throwaway root;
build sources/binaries and the isolation driver are ignored E2E cache artifacts.

## Exact failures

The pressure-fold test fails at `rust.apply`, before any marker application or
durable fence, with `RustTransformProtocolError` / `rust_transform_protocol_error`:
`native output admission was not proven before marker application`.
Its full native output estimate is **43,736**, trusted, versus usable context
limit **23,000**. The mock model's unknown-model fit envelope doubles its fixed
system/tool floor: tools alone estimate **31,456**, system raw **3,567** and
prose raw **2,573**. This is not a malformed native history head or a lost daemon
request. The module completed its historian publication and returned
`SOFT / coverage_fold / scheduler=execute / committed=true`.

The separately run ctx-reduce test has the same pre-cut throw (estimate 43,734,
limit 23,000). OpenCode 2 fold cadence has the same throw followed by MC-S06
(`blocking-transform-error`); the historian publishes coverage, but no host
boundary is admitted, so its polling assertion says it never produced a boundary.
The failed CI log also contains **rust maintenance command contract**, shard 2,
in addition to the four reported names; it is included in verification below.

The sparse-gap test is different: the synthetic-only control advances to ordinal
140, then the real-gap control correctly refuses in the module's projection:
`coverage gap: live item ... (ordinal 85) sits at or below coverage end Some(140)
but no compartment covers it; composing m0 would silently drop it from the tail`.
That test already requires `applied=false`, `servedFrom=refused`, no provider
request, this exact coverage-gap diagnosis, and an unchanged ordinal-50 marker.
Its unconditional `await sendPrompt` aborts on the host rejection before those
assertions can execute. Expecting the rejection is a correction of test control
flow, not permission to serve uncovered content.

## Contract decision

The reviewer explicitly selected pre-cut **deferral**, not strict turn refusal:
a host cut is an optimization. A rebuilding output without proven local fit
must still be served as before the marker change, with no cut/fence, pending
target retained, and one fit-number diagnostic per pass. Admission proven on a
later rebuilding pass may cut. All existing post-cut fail-closed, durable fence,
restart/recomposition and final-fit controls remain required.

The regular fixed-floor regression was run before the production fix and failed
with the native-admission protocol error (then `RAW_FALLBACK_CONTEXT_LIMIT`).
It requires the fresh output to be served, no cut/fence, durable pending target,
SOFT+ retention, and eventual real host cut after room returns.

## Why the marker work missed it

Its admission unit fixtures used minimal tool definitions, system prompt 100,
and a 200k limit; its real marker fixture used a 1M window. None exercised a
healthy fold in a window smaller than the fixed tool/system fit floor. Its report
explicitly says the daemon was reused ck-subc 0.20.55. The matrix above proves
that daemon age did not cause this regression: both green and red daemon heads
produce the same MC-dependent result. The reused daemon and narrow marker-only
host selection were not equivalent to running CI's four drift shards. The
sparse-gap negative control's intended refusal was not explicitly awaited as a
rejection, so real host error-envelope behavior also escaped that coverage.

## Fix and fixture scope

The adapter measures the candidate once. If fit is over/unproven or capture
inputs cannot be proven coherent, it logs `rust compaction-marker admission
deferred` with reason, fit, estimate, trust, proxy tokens/bytes and limit. Host
postprocess still records the newest pending boundary, but returns before
strategy application, retry accounting, quarantine or fencing. The newly
transformed request is postprocessed and served normally. SOFT+ leaves the
pending target alone; a later rebuilding pass with proven fit can drain it.
The post-cut final-fit and durable-fence paths are unchanged, including recovery
when a previous pass already may have moved the cut.

Only **OpenCode 2 fold cadence** changes its mock window (24k → 40k). After the
production fix, its 24k run served every turn without refusals, but its fixed
prompt **plus protected 3k-turn tail** still measured 30,664–31,066 against a
usable limit of 22,976 on every rebuilding pass. This is the minimum retained
fixture content after each fold, not merely transient pre-fold pressure; that
fixture cannot admit a moving boundary under its old window. The window change
keeps the execute trigger near 9.3k usable tokens (40% → 24%) and keeps the second
scenario above the host trigger (reported usage 20k → 36k). No fold, shrink, drop,
three-boundary, actual-trim, checkpoint-source, or failed-turn assertion is removed
or relaxed. The final run records final input 15 versus untrimmed equivalent 29,
increasing trim drops 2/6/10/14, and seven answered module-backed checkpoints in
the forced-pressure scenario. V1 pressure-fold, ctx-reduce and maintenance retain
their original small windows and pass through pre-cut deferral.

## Verification and mutation proof

Tools: Bun 1.4.2 (`744846f84`), TypeScript 5.9.3, Biome 2.5.1, Cargo 1.99.0
(`5f94df478`), OpenCode 1.18.32 and workspace-pinned OpenCode 2.0.22.
All host commands had outer timeouts and the same retained-fixture/lsof driver.
All native builds were serialized with `-j 2`.

- `bun run typecheck` in `packages/plugin`: pass (all three compiler invocations).
- Targeted Biome check: pass, 3 edited plugin files.
- Regular adapter, postprocess, marker-lock, LKG persistence and V2 boundary
  suites: **437 pass / 0 fail / 4,539 assertions**, 5 files. This includes the
  existing post-cut faults, restart fence, uncertain cut, no-cut recovery,
  queued-capture invalidation and rejected native-head controls, plus the new
  real-estimator fixed-floor, untrusted-estimator and throwing-estimator cases.
- Plugin build: pass, including 4 V2 loader tests / 19 assertions.
- E2E project `tsc --noEmit`: pre-existing errors in untouched probe, harness,
  adapter/RPC/conversion/todo/timeout and imported plugin files; no diagnostics
  in either edited E2E file. A TypeScript compiler-API program rooted at those
  two files verifies **2 roots / 0 edited-file diagnostics**, with 2 unchanged
  dependency diagnostics. No unrelated source fixes are included.

The non-vacuity mutation bypassed `admissionProven === false` in
`transform-postprocess-phase.ts`, marked `NON-VACUITY BREAK`. The staged live
baseline had an empty working diff; mutation produced **1 file, +1/-1**. The named
fixed-floor regression alone went red with post-cut final-admission refusal;
`post-cut capture fault refuses instead of old replay, then recomposes
successfully` stayed green. Restoring from the staged index and touching the
file produced an empty working diff. No mutant was committed.

### Four drift shards, sequentially

Each uses `MC_E2E_SHARD=N/4 scripts/run-rust-hermetic-e2e.sh`, the current-tree
plain/fault module pair, and exact CI daemon b5aba1a1. Counts include the runner's
existing manifest/host skips; the actual Rust regression tests are not skipped.

| Shard | Final result | Files | Pass / fail / skip | Assertions | lsof snapshots |
| --- | --- | --- | --- | --- | --- |
| 0/4 | PASS | 15 | 39 / 0 / 60 | 383 | retained log verified |
| 1/4 | PASS | 14 | 23 / 0 / 17 | 149 | 66 |
| 2/4 | PASS | 14 | 28 / 0 / 65 | 405 | 92 |
| 3/4 | PASS | 14 | 25 / 0 / 12 | 279 | 119 |

The shard-0 tool reply was lost during a tool-daemon/Broca restart; the command
had completed. Its retained log contains all 15 passing file summaries and the
final `hermetic:end status=pass`; no runner process remained. That result was
recovered rather than silently rerunning it. All four final logs were independently
checked for nonzero passes, zero failures and the final group pass marker.

Initial shard 1 still failed the impossible 24k OC2 fixture; its unrelated large
tail-delta host startup lost a race and recovered on the runner's standard retry.
The final shard-1 rerun passes every file without retries. Initial shard 2 spent
two ten-minute test budgets building the slow health-probe example under shared
compile-slot contention and then hit its outer timeout. Prebuilding that same
current-tree example with `cargo build --release -j 2 -p mc-module --example
slow_transform_probe`, selecting it through the existing prebuilt-probe option,
and rerunning shard 2 made both health tests pass (the slow test in 3.38 seconds).
No timeout or test expectation was weakened. No product Rust source changed.

After all four shards, a separate `bun test --timeout 600000 --max-concurrency=1
tests/opencode2/rust-mode-fold-cadence.test.ts` passed **2 tests / 15 assertions**
with 2 host lsof snapshots. Across the matrix, reproductions and verification,
**16 lsof logs / 6,293 database-path observations** resolve only below the task's
throwaway root. Detailed raw evidence remains there as `shard-0.log`,
`shard-1-room.log`, `shard-2-prebuilt-probe.log`, `shard-3.log`,
`final-oc2-fold.log`, their `*-lsof.log` companions, and the kept host/module/plugin
fixture logs.
