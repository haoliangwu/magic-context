# Pi / OMP performance audit results

Baseline: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46` (the supplied worker base).
Measurements use Bun 1.4.2, synthetic native Pi entries, temporary on-disk databases,
and 1k / 10k / 60k messages. The microbenchmark gives tool results about 4 KiB each
(60k messages serialize to 62,951,378 bytes), warms each operation, and reports the
median of five samples. The full-handler fixture is the existing mixed
text/thinking/image/tool corpus. No live host, live store, or private session was used.

The machine is shared: absolute timings varied substantially between invocations.
Prefer the same-process paired ledger/probe/branch numbers and operation counts;
the LKG before/after runs use the same fixture and algorithm benchmark but are not
a claim about stable end-to-end latency. Initial 60k tag creation dominates the
full-handler run (about 167 seconds); that write/transaction work belongs to DB-4,
not this section. The handler's `total` timer excludes the final assertion and ledger,
and its `lkgCapture` timer covers deferred digest work, not synchronous preparation.

## Reproduction

```sh
timeout 600 bun packages/plugin/scripts/perf-audit/pi.ts
timeout 600 bun packages/pi-plugin/scripts/experiments/perf/run.ts \
  --messages 60000 --points 1000,10000,60000 --repeat-final 1 --output /tmp/pi-report.json
timeout 30 bun packages/plugin/scripts/perf-audit/pi.ts --report /tmp/pi-report.json
timeout 900 bun packages/plugin/scripts/perf-audit/pi-wire-compare.ts ee9d82912cd8105322672a1f5dd1bbb7172a2f46
```

`pi.ts` also reports a stress case with one memory per message and one compartment
per 100 messages (five approximately 4 KiB bodies per compartment). Those are
separate cardinalities, not a claim that a normal 60k-message session has 60k memories.
The metadata stress case has a 15 KiB m0 and a 1 MiB frozen mural payload.

## Findings

| ID | Classification | Before → after (60k fixture unless noted) | Commit | Regression evidence / notes |
|---|---|---|---|---|
| PI-1 | CONFIRMED, fixed | Independent ledger 225.210 ms → same-pass LKG reuse 41.345 ms | `8d742f85f6` | Ledger exact SHA/body tests; no extra head serialization. Digest format and unconditional observability retained. Session state is released on teardown. |
| PI-2 | CONFIRMED, fixed in output preparation | 199.187 ms → 87.736 ms synchronously | `ddb5d8fe6a` | Nested same-length rewrite, sparse/custom JSON, one-shot accessor, cloned serialization and measured-resend tests. Validation and token detachment share a walk. Input/output equality remains exact, not digest-only or reference-only. |
| PI-3 | CONFIRMED, fixed on defer | 120 source queries / 36.744 ms → 0 queries / 0 ms on the warm full handler | `5ba4052814` | Ordinary/frozen defer, uppercase reminder, stripped legacy body, and temporal-only legacy source tests. Bust passes intentionally retain legacy-source reads: they can freeze decisions even when the current projection has nothing removable. No cross-pass source cache added. |
| PI-4 | CONFIRMED, fixed | Assertion 206.803 ms → disabled gate <0.001 ms | `c3317ae6aa` | Both environment-gate tests and three-leg hygiene parity. `MAGIC_CONTEXT_DEBUG_ASSERTIONS=1` independently enables assertions, including in production. Same flag as TX-3; its worker owns the TypeScript twin. The real accounting walk remains unconditional. |
| PI-5 | POLICY; measured cost remains | Warm legacy identity plan 69.144 ms (1k: 1.100 ms; 10k: 8.773 ms) | — | Do not treat an already-tagged id as proof of unchanged text. Existing deletion/in-place identity tests require exact vectors. The source cache is session-scoped and already cleared at teardown; its per-session size remains unbounded. A bounded/re-keyed replacement must separately prove legacy projection and external source-update semantics. No cache epoch/format change attempted. |
| PI-6 | NEGLIGIBLE for measured pass | Four empty-row reads 0.122 ms; four reads with 1 MiB mural 0.655 ms → unchanged | — | Full handler: four metadata reads cost 0.221 ms. Leave fresh watermark/after-fold reads intact. A binary comparison is not a drop-in replacement for decoded UTF-8 equality on invalid legacy blobs. |
| PI-7 | POLICY; stress cost remains | 60k validated memory rows just for count: 122.254 ms → unchanged | — | A plain `COUNT(*)` is not equivalent to the current loader: it filters `isMemoryRow`, expiry, and workspace foreign visibility. The schema does not constrain every enum/type that `isMemoryRow` checks. No constraint migration or count-cache epoch was introduced. This is a remaining hotspot for projects with very large memory sets; a validated count API needs separate design. |
| PI-8 | CONFIRMED, fixed for stable probes | Three raw negative probes 6.691 ms → revision-cached 0.007 ms (paired run) | `06dbc63c4c` | Local/sibling/rollback changes and the existing stale-negative adoption race pass. Keep case-insensitive LIKE semantics (including uppercase legacy ids); no index/migration/GLOB behavior change. Lingering real fallback rows still require exact fingerprints. |
| PI-9 | NEGLIGIBLE / safety policy | Cached defensive tag copies 0.911 ms initially, 1.331 ms final; <1% of the measured handler stage → unchanged | — | Heuristics can mutate their working entries; never expose the cached objects. External `data_version` invalidation remains conservative. Only the existing revision accessor was exposed for PI-8; no cached-array contract changed. |
| PI-10 | CONFIRMED, fixed for message-end indexing | Full branch conversion 27.543 ms → located assistant 1.519 ms (paired run) | `063a69a9bd` | Deferred publication tests and independent full-conversion comparison preserve folded ordinals, versions and timestamps, without reading historical bodies. One current branch read per deferred resolver. Context-event branch reads were already coalesced and remain so. |
| PI-11 | NOT REPRODUCIBLE as “costs about as much as recounting” | Warm token cache 43.063 ms vs uncached 478.317 ms (about 9%) → unchanged | — | Plain-data checking is necessary for custom getters/toJSON. A compact hash alone cannot replace exact equality without admitting a stale entry. |
| PI-12 | POLICY / duplicate-decision premise not reproduced on prepared-prefix replay | 600-compartment pass snapshot 5.830 ms; with mural 6.239 ms → unchanged | — | `injectM0M1Pi` returns `preparedPrefix` before a second decision when preflight prepared it. Full-handler empty compartment load: 0.027 ms. The complete snapshot pins the publish sequence across the decision and replay; existing contention/sibling-pair tests defend it. Body/marker laziness remains future work, not a metadata-only snapshot change here. |
| PI-13 | CONFIRMED, fixed | Retained hygiene key accounting: 189,022 / 1,839,326 / 11,081,916 bytes at 1k / 10k / 60k → 0 on teardown; mural presence true → false | `be74ed2e5d`, `8d742f85f6` | Teardown test reloads the frozen persisted mural and compares the full message array byte-for-byte. Ledger releases previous strings without discarding queued records. Full-content memo keys retained for exact invalidation; the shared memo is flushed at teardown. |
| PI-14 | NEGLIGIBLE | Three repeated metadata SQL calls 0.034 ms → unchanged | — | Full-handler individual writes 0.006–0.097 ms. Do not add sibling-invalidatable value caches to remove a sub-millisecond cost. |
| PI-15 | NEGLIGIBLE for measured stage | 10 floor queries: 0.146 ms; five calibration reads: 0.555 ms; pending peek/count: 2.326 ms combined (<1% of pipeline) → unchanged | — | Todo/anchor/state reads each <0.1 ms in the warm full handler. Reads separated by durable mutations/publication are not automatically interchangeable. |
| PI-16 | CONFIRMED for kept-entry materialization, fixed; remainder mixed | Kept-entry lookup 20.930 ms → 4.727 ms; prefix clone twice 0.027 ms unchanged; reference mapping 1.202 ms vs cloned mapping 71.869 ms unchanged | `063a69a9bd` | Existing kept-entry system/empty/synthetic boundary tests pass. The iterator skips old bodies and stops at the first legal kept entry. Clone fingerprint matching is an intentional host identity safeguard, not a blind positional mapping opportunity. Stale-reduce edit scans do not execute in the no-reduction full-handler fixture; their high-cardinality worst case was not established. Logging was not independently attributed. |

The policy rows are **not claims that their CPU/memory costs have disappeared**.
In particular PI-5's per-session source retention, PI-7's validated memory count,
PI-12's complete bodies/markers, lingering fallback fingerprints, and PI-16's
cloned identity path remain optimization opportunities. This delivery stops short
of a schema migration, persistent cache-format/epoch change, or a semantics-changing
shortcut to those checks.

## Cache and byte-identity evidence

* `pi-wire-compare.ts` archives the actual baseline revision and runs both real Pi
  handlers against independent temporary DBs. It compares raw `JSON.stringify`
  output files, **not canonicalized message hashes**. All four passes (1k, 10k,
  60k, repeated 60k) were exactly equal; authoritative behavioral tag rows also
  matched on each pass (1k / 10k / 60k / 60k rows).
* Exact 60k wire: 19,889,713 bytes,
  SHA-256 `6d3dbe3c4518aed376aa394ca20454e3e1de7d62b217f4b35842ea22764ac286`.
* Existing execute/defer, durable content-decision, legacy reminder, contention,
  thinking-edit and TypeScript/Pi/Rust-consumed golden parity tests passed.
* Issue 601 attribution is preserved: `unchanged capture preserves provider-measured
  resend without a database write (deferred commit flushed)` and its `pending`
  twin passed. The in-memory slot's timestamp/sequence refresh and `capturedRequest`
  association were not changed. The supplied `d406ec3f` ref is absent here, but the
  relevant protection and both regression tests exist at the worker base.
* The ledger reuses only the freshly detached serialization returned by this very
  pass's LKG capture, immediately, before returning to other host extensions. It
  falls back to its original serializer when capture did not provide plain output.
* The fallback cache has at most 100 sessions per weakly-held connection. Its key
  includes the local TEMP tag revision and external `main.data_version`; transactions
  bypass it. Both preflight and later adoption observe revisions, so a sibling
  insert between them is not hidden. No persisted table/cache format changed.
* Only PI-4 has a TX twin in this change. No Rust code or Rust wire format changed.

## Verification

* Pi full suite: `timeout 1200 bun run --cwd packages/pi-plugin test` — **1524 pass,
  3 skip, 0 fail**, 142 files, Bun 1.4.2. Install checked 995 installs / 1250 packages,
  unchanged lockfile. The first run found the source-contract test's obsolete
  `readMessages` wiring assertion; the test now preserves deferred-id scheduling
  while requiring branch-only input, with behavioral conversion tests retained.
* Pi typecheck: `timeout 300 bun run --cwd packages/pi-plugin typecheck` — passed,
  TypeScript 5.9.3 (retina build project and Pi no-emit project).
* Pi lint: `timeout 180 bun run --cwd packages/pi-plugin lint` — passed, 231 files,
  one pre-existing non-null-assertion warning in the mural test.
* Pi build: `timeout 300 bun run --cwd packages/pi-plugin build` — passed,
  Bun 1.4.2, 22 browser modules and 969 runtime modules bundled.
* Core full suite: `timeout 1200 bun run --cwd packages/plugin test` — **6766 pass,
  4 skip, 1 unrelated 30s timeout**, 651 files, Bun 1.4.2. The timeout was
  `readGitCommits (smoke) > returns empty array for a non-git directory without
  throwing`; isolated rerun of its file: **10 pass, 0 fail**. No production core
  files were changed by this delivery.
* Core typecheck: `timeout 300 bun run --cwd packages/plugin typecheck` — passed,
  TypeScript 5.9.3 (retina, core, scripts). Script imports of sibling Pi code are
  runtime paths so Pi's alias/root configuration does not leak into core's project.
* Core lint: `timeout 300 bun run --cwd packages/plugin lint` — passed, 1199 files,
  one pre-existing warning and two infos.
* Core build: `timeout 600 bun run --cwd packages/plugin build` — passed;
  browser/core/v2 bundles built; v2 loader gate **4 pass, 0 fail**. No generated drift.
* Benchmark: final `timeout 600 bun packages/plugin/scripts/perf-audit/pi.ts` —
  completed all three sizes and five warm samples per measured operation.
* Debug-fence non-vacuity: staged live files, neutralized opt-in with the exact
  `NON-VACUITY BREAK` marker, observed a non-empty 1-file diff, and ran its two
  tests. Only `Pi debug assertions do not walk content without explicit opt-in`
  failed; the explicit production drift test passed. Restored from the staged
  live version, touched the file, and confirmed an empty unstaged diff.
* Fallback-cache non-vacuity: staged live files, removed external-version invalidation
  with the `NON-VACUITY BREAK` marker, captured a non-empty 1-file diff, and ran
  fallback-probe plus tag-snapshot tests. Only `Pi fallback probes cache metadata-only
  passes and see local, sibling and rollback tag changes` failed (the uppercase sibling
  insertion remained invisible); all three tag-snapshot tests passed. Restored from
  the staged live version, touched the file, and confirmed an empty unstaged diff.

## Tool issues

* AFT inspection was partial: unavailable Biome/higher-tier analysis, and the last
  scoped request did not receive authoritative diagnostics for four Pi files within
  its budget. Package typechecks and named lint scripts supplied authoritative gates
  instead. The borrowed call graph was stale at the worker base.
* A formatter invoked at repo root rejected the nested package Biome root; from
  the owning package it reported that the audit scripts are intentionally ignored.
  Named lint scripts pass; no configuration was changed to bypass a gate.
* No todo tool was exposed in this worker tool set. Work was split into isolated,
  verified finding commits instead.
