# Pi context-transform performance harness

This directory drives the same `registerPiContextHandler()` callback that Pi registers in production. It reconstructs Pi's `ContextEvent.messages` with `buildSessionContext()`, supplies the matching branch entries by reference, and uses a temporary on-disk `context.db` under `MAGIC_CONTEXT_TEST_DATA_DIR`. It never opens the production Magic Context database.

## Benchmark

```bash
cd packages/pi-plugin
bun scripts/experiments/perf/benchmark.ts --synthetic --messages 4000 --step 500
bun scripts/experiments/perf/benchmark.ts --fixture ~/.pi/agent/sessions/<project>/<session>.jsonl --step 500
```

Without `--fixture` or `--synthetic`, `benchmark.ts` selects the largest JSONL file under `MC_PI_PERF_FIXTURES`. The default directory is `~/.pi/agent/sessions`. Pass `--all` to benchmark every JSONL fixture. Private session data is only read at runtime and is never copied into the repository.

Use `--points 500,1000,2000,4000,5725` for fixed checkpoints. Add `--repeat-final 1` to measure a steady-state pass over a fresh clone of the final message projection after all caches are warm. The synthetic generator includes text, thinking, images, tool-call/result arcs, and call IDs deliberately reused across turns.

The phase table reports transform phases plus DB I/O. DB time is cross-cutting and therefore overlaps the phase that issued each query. Per-part timing is activated only while the harness observer is installed; production does not pay those timers.

Use `--lane` to exercise hot paths that the default cache-stable pass does not reach:

```bash
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane historian-low
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane historian-high
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane execute-compacted
bun scripts/experiments/perf/benchmark.ts --synthetic --points 1000,3000,5725 --lane auto-search-sticky
```

Each pass measures output serialization and then waits 150 ms before sampling deferred DB work. Historian lanes use a fail-soft local runner so trigger and scheduling costs are measured without making a model request. The execute lane marks all but the newest tag window compacted between accumulation passes; the auto-search lane persists a no-hint decision on the first pass and measures sticky replay afterward.

### Production-shaped append passes

Four `run.ts` flags reproduce conditions that a single-connection synthetic run never shows:

- `--pi087`: the branch starts with a persisted system message entry, and the event omits system messages, as Pi 0.87's `emitContext` does.
- `--external-writes`: a second connection commits before every pass, so `PRAGMA data_version` advances as it does when other OpenCode or Pi processes share `context.db`.
- `--lingering-fallback`: seeds one `pi-msg-*` message tag that no live message can adopt.
- `--historical-tags N`: seeds N compacted tags for history outside the current projection; `--tool-result-repeat N` enlarges tool results.

```bash
bun scripts/experiments/perf/run.ts --messages 12040 \
  --points 3000,6000,9000,12000,12001,12002,12003 \
  --pi087 --external-writes --lingering-fallback --historical-tags 45000 \
  --tool-result-repeat 200 --output /tmp/pi-append.json
```

Warm the session in steps of at most about 3,000 messages: a first pass that tags 12,000 messages exceeds the 25-second pass budget.

## Byte-identity comparison

Commit the harness before the optimization so the baseline revision contains `run.ts`, then run:

```bash
bun scripts/experiments/perf/compare.ts --fixture <path>
```

Passing a directory to `--fixture` recursively compares every JSONL fixture and fails on the first mismatch. The default baseline is the first commit containing this harness; override it with `--baseline <git-ref>`. `compare.ts` archives that revision into a temporary directory, runs both real handlers against independently initialized copies of the same empty DB seed, and compares canonical-JSON SHA-256 hashes for every output message array and every persisted behavioral tag row on every accumulation pass. Timing/creation columns are excluded from the tag-row comparison. Any mismatch exits non-zero.

## Settled defer measurements and complete-handler cost

The default synthetic runner has no successful provider response. Without
`--settled-usage`, a session can remain on the scheduler's first-response execute
path, even after its caches are warm. Do not label repeated final passes as
ordinary defers without checking their recorded `decision`.

Use `--settled-usage` to record simulated successful usage between passes. The
runner reads the real transform-decision log afterward and records each decision
in the JSON report. Both compared revisions execute the same current measurement
driver; their product modules still come from their respective revisions.

```bash
bun scripts/experiments/perf/compare.ts \
  --baseline cc654a68fd0441d245712be76eb23087e70b7ef0 \
  --messages 13800 --step 2300 --repeat-final 200 \
  --context-window 10000000 --settled-usage --interleave \
  --report-dir /tmp/pi-fit-comparison
```

The larger synthetic window keeps this message-count fixture far from genuine
capacity pressure; it is not a claim about a real model's supported window.
`--interleave` alternates AB/BA process steps, never running both handlers at once.
Each process has its own HOME, temporary directories, store and log. On Linux,
launch the comparison with `taskset` if both processes should use one CPU.

Reports include `handlerMs`, measured around the complete handler call, and
`fullArrayClones`/`fullArrayCloneMs` for clones at least as long as the input.
`fitEnvelopeReads` counts actual tool-registry reads. The older `phases.total`
ends before fit admission and publication, so it is not a substitute for full
handler wall time. Input fixture cloning, output serialization and the 150 ms
post-handler drain are outside `handlerMs`.

The comparison prints p50, p95 and p99 for the final repeated passes using linear
interpolation. `--report-dir` retains both JSON reports. It compares literal
served-JSON `wireHash` values in addition to canonical output and persisted-tag
hashes. Use `--lane execute-compacted` for a separate execute-pass differential.
The performance driver's dedicated typecheck is:

```bash
bun run tsc --noEmit -p scripts/experiments/perf/tsconfig.json
```
