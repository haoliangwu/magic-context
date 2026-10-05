# Rust transform performance audit

## Evidence boundary

The audit baseline is `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. The baseline
release harness completed all **180 measured passes**, plus **30 normalization
and warmup passes** per run. The intermediate candidate, final candidate, and
separate correctness-reference run each passed **210 raw wire/store/context
comparisons** against the baseline: 630 comparisons in total. Release clippy and
the full module package suite passed. Five confirmed local fixes have separate
commits; RT-2 was explicitly deferred by the parent after measurement.

The measurement-only changes extend the existing `copied_sessions_per_pass_cost`
harness. They preserve its ALF-, CEREB-, and small-sized reconstructed fixtures,
three warmups, twenty samples per configuration, and complete CK/native-array
comparison across warm-delta, warm-full, and evicted-full configurations. These
are scrubbed scale fixtures, not exact captured live requests.

## Finding coverage

All times below are release thread-CPU milliseconds. Operation microbenchmarks are
not estimates of how often a conditional operation runs. Per-pass span counts
distinguish actual exposure from a potentially expensive but unexecuted branch.

| Finding | Classification | Measurement / scope | Before → after | Commit / regression test |
| --- | --- | --- | --- | --- |
| RT-1 | POLICY | Ordinary delta probes + Value decode total 0.016 ms; ALF full capability probe 8.831 ms, Value decode 22.720 ms | Unchanged | Raw SDK/module boundary retained, with independent transport capability validation. The claimed 3–4 raw parses are narrower in practice: byte-cap probe skips under-cap bodies and transport reply-page dispatch only parses bodies ≤1 KiB (`transport_handler.rs:77`). |
| RT-2 | CONFIRMED, deferred by parent | ALF/CEREB/small prefix reattachment 15.636/4.464/1.735 ms, plus incremental projection 4.300/1.418/0.481 ms | Unchanged | A shared/segmented ingress follow-up must preserve compact projection memory bounds; see below. |
| RT-3 | CONFIRMED | ALF warm-delta part hashing 38.110 ms, 22,944 parts; hygiene measurement 58.024 ms | Final per-pass 41.214 / 65.019 ms; paired same-run hash operation ALF 43.569 → 42.049 ms | `e1f1139a94`; `streamed_part_hash_matches_concatenated_reference_for_every_kind`; exact digest bytes retained. Safe local gain is modest; no claim of an ALF steady-pass win. |
| RT-4 | NEGLIGIBLE | ALF selection inputs 0.416 ms; unconditional todo-capture clone 0.035 ms | Unchanged | Do not delete the quick-win clone merely because it exists. |
| RT-5 | NEGLIGIBLE | ALF full kind-only walk 0.271 ms, active tags 1.232 ms (1.7% of evolution); escaped-read count zero | Unchanged | Classification is fixture-limited: reconstructed filler does not model heavily escaped native text. No universal escaped-text cost claim. |
| RT-6 | NEGLIGIBLE | Warm live-block tokenization ALF/CEREB/small 0.263/0.344/0.923 ms; 0.55/0.67/2.01 MB live input | Unchanged | Preserve bounded exact-text cache. Serial fixtures do not establish contention cost or >4 MiB thrashing. |
| RT-7 | CONFIRMED | ALF warm-full parts copy 6.652 ms; decoded fingerprint 67.145 ms; sidecar decode 118.301 ms | Final 0.883 / 50.378 / 91.856 ms | `0d18b7115f`; `borrowed_decoded_fingerprint_matches_owned_sorted_reference`, streamed-value and all-byte hex tests. Borrow parts/typed fields; sorted Value key order retained. |
| RT-8 | NEGLIGIBLE | ALF snapshot 0.024 ms; CEREB 0.030 ms; small 0.038 ms | Unchanged | Snapshot already shares large served payloads via Arc. |
| RT-9 | CONFIRMED | ALF/CEREB/small warm-delta identity 0.894/1.083/2.196 ms | Final 0.992/1.016/2.102 ms | `f11c5c9a89`; `borrowed_overlay_identity_fields_match_owned_reference`. Allocation removal is exact; elapsed savings are small/noisy and absent on ALF. Length-prefixed metadata serialization remains unchanged. |
| RT-10 | NOT REPRODUCIBLE as recurring work | Exactly one renderer invocation on every measured pass; ALF legacy check 0.237 ms | Unchanged | Rebuilds are conditional repair/strip paths, not a mandatory six-render ordinary pass. |
| RT-11 | NEGLIGIBLE | ALF/CEREB/small warm served-message encode 0.009/0.009/0.009 ms, one new message | Unchanged | Retained projection hashes and output-cache entries are already reused. No digest storage format change. |
| RT-12 | CONFIRMED | ALF empty pending-drop consumption 1.810 ms; all three consumers total about 2.172 ms; 13 red-set builds per pass | ALF consumption → 0.0001 ms; 13 → 7 builds. Isolated empty helpers 1.841 → 0.000958 ms | `b53c5a7dc8`; `empty_pending_drop_helpers_skip_frozen_and_projection_indexes`, independently reddened. Nonempty CEREB queues still perform all original work. |
| RT-13 | NEGLIGIBLE | ALF/CEREB/small normalization 0.181/0.050/0.020 ms | Unchanged | `req.clone()` only runs for an unmarked synthetic-todo pair (`transform.rs`, `normalize_synthetic_todo_ingress`), not every request. |
| RT-14 | CONFIRMED | ALF 6.40 MB import: canonicalization 8.195 ms, size serialization 3.433 ms, cloned typed decode 1.993 ms; ordinary sync canonicalization 0.042 ms | Import canonicalization → 4.459 ms, typed decode → 1.021 ms; byte-limit serialization unchanged | `45c021b6dc`; `streamed_canonical_value_matches_joined_reference_and_numeric_contract`, `borrowed_state_wire_decode_matches_owned_values_and_errors`. No digest/number/key/escaping change. |
| RT-15 | NOT REPRODUCIBLE as ordinary scans / conditional cost | Frozen-mid drift scan absent on every measured pass. Isolated worst-case strip lookup across all ALF messages is 185.877 ms | Unchanged | Renderer uses FrozenUnitIndex; force-band, drift and bust-only paths are not ordinary defer loops. Do not treat the micro bound as per-pass work. |
| RT-16 | POLICY | ALF/CEREB/small isolated floor 0.350/0.386/1.090 ms; zero calls on measured defers | Unchanged | Ordinal is deliberately frozen only on an initialized HARD with coverage and no prior publication floor. |
| RT-17 | NEGLIGIBLE | ALF/CEREB/small surrogate encoder 0.025/0.032/0.015 ms | Unchanged | No memmem dependency or wire rewrite justified. |
| RT-18 | NEGLIGIBLE | ALF/CEREB/small tag maps 0.932/0.278/0.022 ms | Unchanged | No new tag-generation memo or repair invalidation fence. |
| RT-19 | NOT REPRODUCIBLE in ordinary path | Zero fallback tag-load calls in all 180 measured passes | Unchanged | Normal handler supplies the hydrated Arc tag snapshot; fallback is for earlier-return paths. |
| RT-20 | NEGLIGIBLE | Zero warm-delta ALF input copies; full input copy 1.077 ms, <1% of 172.008 ms projection; isolated whole-projection copies 0.781 ms | Unchanged | Do not widen projection ownership just to remove this allocation. |

### Cross-fixture before/after results

Each entry is the median CPU ms from twenty samples. The baseline and final runs
had different fleet load/frequency/cache-pressure conditions: baseline load
averages about 37–51, final about 12–15. Neither is a quiet-host benchmark.
Thread CPU removes descheduling time, not frequency or cache contention. Do not
sum inclusive spans or attribute the entire pass change to these fixes.

| Operation | ALF before → final | CEREB before → final | Small before → final |
| --- | ---: | ---: | ---: |
| Handler warm delta | 239.307 → 267.955 | 84.439 → 73.709 | 29.666 → 27.832 |
| Handler warm full | 658.705 → 577.331 | 175.283 → 162.842 | 88.136 → 82.376 |
| Handler evicted full | 779.205 → 661.519 | 211.780 → 172.668 | 102.104 → 87.553 |
| RT-3 paired excluded-part hash, old concat → stream/table in same final run | 43.569 → 42.049 | 10.360 → 10.070 | 4.763 → 4.537 |
| RT-7 warm-full sidecar decode | 118.301 → 91.856 | 28.637 → 23.282 | 12.489 → 10.223 |
| RT-9 warm-delta identity | 0.894 → 0.992 | 1.083 → 1.016 | 2.196 → 2.102 |
| RT-12 isolated empty pending consumers | 1.841 → 0.000958 | 0.463 → 0.000917 | 0.237 → 0.000958 |
| RT-14 import canonicalization | 8.195 → 4.459 | 1.303 → 0.488 | 0.000750 → 0.000375 |
| RT-14 import typed decode | 1.993 → 1.021 | 0.272 → 0.093 | 0.000250 → 0.000166 |

RT-3's concurrent, alternating-order microbenchmark makes the limited safe gain
explicit. Streaming alone was 43.203 ms on ALF versus 43.569 ms for concatenation;
most whole-projection hashing remains. No coverage-skipping, part memo, units-version
bump, or new cache was introduced. RT-9 has no material measured ALF improvement;
its independent digest reference and fixture parity prove correctness, not a
large speedup. The ALF warm-delta total is slower in the final run, so this report
does **not** claim an overall steady-pass speedup.

### RT-2 follow-up boundary

The parent explicitly deferred this confirmed finding after measurement. Retaining
a second full `Arc<CkWireMessage>` prefix would retain scalar payloads that the
compact projection deliberately discards, changing cache admission/eviction under
the existing 192 MiB entry cap. A segmented/shared ingress view must preserve
lossless history access, provider metadata, tool-arc seam state, immutable
validated prefixes, rejection/CAS isolation, current epoch/context/fingerprint/
frontier fences, and honest retained-byte accounting. It needs full cold/delta/
rewrite/contraction/revert/eviction parity and memory-pressure tests before any
representation change. No budget increase or format migration was attempted.

`COST_CLOCK` records empty-span overhead. High-frequency child clocks add work to
their parents; do not present their inclusive totals as uninstrumented production
latency. The profiler records invocation counts as well as CPU/wall time. Its
production-equivalent mode now disables the serialized-output fresh reference
too, not just the full projection and native-attachment references. All three
references remain enabled by default in ordinary tests.

## Byte-identity protocol

The harness freezes the module-owned clock on its current-thread runtime and
uses a stable empty scratch route root between runs. Database clones still have
fresh throwaway paths. `lsof` on the test executable's PID must show database
opens only below the existing temporary `magic-context/ckmc-perf` root.

Every pass, including normalization and warmups, emits `COST_IDENTITY` containing
three SHA-256 digests: complete CK plus assembled native arrays, stored rows in
store.db, and stored rows in context.db. The persisted-state digests hash raw
SQLite TEXT/BLOB values, not decoded/re-serialized JSON. Thus a stored `1` versus
`1.0`, JSON key order, and escaping changes remain observable. Session-scoped
tables are discovered from their `session_id` column, including trace tables;
every other column in those rows is compared. The wire comparison extracts the
actual response array bytes and assembles native deltas from raw message slices;
it does not normalize them through `serde_json::Value`. A negative test proves
that key-order and string-escape changes remain detectable even when decoded
values are equal.

The sole exclusion is **`mc_cache_state.last_activity_at`**, which the store
updates using its own wall clock. No store clock override is added. All other
columns, including unknown columns, and timestamps embedded in JSON are kept.
Unmodified non-session-scoped tables and physical SQLite/WAL layout are outside
this per-session decision comparison. No decision field is normalized or omitted.

The comparator rejects empty/uninstrumented logs, malformed digests, duplicate
passes, missing passes, and comparison of a log file to itself. It requires at
least three warmups and twenty samples in every measured mode. A separate Rust
test proves that changing raw cache JSON or trace content changes the persisted
digest and that only the named housekeeping timestamp is ignored.

### Completed identity and regression evidence

- Baseline and final production-equivalent profiles: 180 measured SOFT+ passes
  each, plus 30 normalization/warmup passes; all three configurations agree on
  complete raw CK and reconstructed native message arrays.
- Before → intermediate candidate, before → final candidate, and before →
  final with references enabled: **210/210 wire/store/context comparisons each**.
  The references-enabled run separately executes the full prefix projection,
  fresh serialized-output, and native-attachment correctness references. Its
  inflated timings are not used for performance claims.
- Existing module byte/parity tests all pass, including native incremental/full
  cache tests, tail-hygiene TS golden corpus, serialized-output cache parity,
  direct-SQL repair/corrupt-chunk tests and cross-profile replay tests. The raw
  before/after fixture comparison is the equivalent wire comparison used here;
  the separate TypeScript `pure-replay-differential.ts` launcher was not run.
- No memo/cache was added. No new invalidation rule, persisted format, epoch,
  config setting or public production CLI flag was introduced. These are Rust
  ownership, hashing and empty-input optimizations; the TypeScript/Pi algorithms
  and served decisions have no changed twin to synchronize. Existing shared
  byte/parity goldens remain the cross-lane contract.

Four staged/restored NON-VACUITY BREAK controls were run. Each named test alone
failed, and all unrelated controls in its test run stayed green:

| Neutralized control | Expected and observed red | Other controls |
| --- | --- | --- |
| Ignore wire digest mismatch in comparator | `test_changed_wire_is_rejected` | Other seven Python tests green |
| Ignore store.db digest mismatch | `test_changed_store_state_is_rejected` | Other seven Python tests green |
| Ignore context.db digest mismatch | `test_changed_context_state_is_rejected` | Other seven Python tests green |
| Remove empty-queue consumption fast return | `transform::perf_audit_metadata::empty_pending_drop_helpers_skip_frozen_and_projection_indexes` | Canonical bytes, borrowed state decode, raw wire and owned-overlay references green |

Every control was applied only after staging the live files and recording an
empty unstaged diff. The mutant diff was nonempty (one file, one insertion and
one deletion); checkout/touch restored an empty diff. The restored five-test
Rust audit group and eight-test Python comparator suite passed. No mutant is
committed.

## Full-suite verification

Tool versions: cargo/rustc **1.99.0**, rustfmt **1.10.0-stable**, Python **3.9.6**,
GNU timeout **9.11**. All test/benchmark commands had an outer timeout.

- `timeout 3600 cargo clippy --release --locked -j 2 -p mc-module --all-targets -- -D warnings`:
  passed, all package library/binary/integration-test targets checked.
- `timeout 3600 cargo test --release --locked -j 2 -p mc-module -- --test-threads=2`:
  passed, **1,605 tests**, **22 opt-in tests ignored**, zero failures, including
  real-daemon and package integration targets. No Cargo.lock changes.
- `timeout 1200 cargo test --release --locked -j 2 -p mc-module --lib perf_audit -- --test-threads=1`:
  restored control passed, **5 tests**.
- Release `copied_sessions_per_pass_cost`, `MC_PER_PASS_REFERENCES=off` and `on`:
  each passed **1 profiling test**, 180 measured passes, 210 complete identity
  records and three observed scratch-only `lsof` checks. The compiled test
  executable from the verified release build was reused to avoid unrelated
  sibling rebuilds during profiling.
- `timeout 60 python3 crates/mc-module/tests/perf_audit_compare.py --self-test`:
  **8 tests passed**. Baseline/candidate log comparison commands each checked
  **210 passes**.
- `timeout 60 cargo fmt --all --check` and `git diff --check`: passed.
- No TypeScript/Pi package source or manifest changed; their full Bun suites
  are outside this Rust-only delivery. No mc-core/mc-tokenizer source changed.
- AFT diagnostics remained partial while rust-analyzer's separate cargo check
  ran. The authoritative Rust compile/full-suite/clippy gates above passed;
  no complete AFT diagnostic claim is made.

## Re-run commands

Use the existing scrubbed read-only backups. Never open a live store or recreate
these backups from a live store for this harness.

```sh
# Build once; on a congested fleet launch this with the tool's background mode
# and an explicit tool timeout longer than this outer deadline.
timeout 10800 cargo test --release --locked -j 2 -p mc-module --lib --no-run
timeout 600 cargo test --release --locked -j 2 -p mc-module --lib per_pass -- --nocapture
umask 077
MC_PER_PASS_REFERENCES=off timeout 2400 cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1 > /tmp/rt-before.log 2>&1
# Repeat the identical harness/fixtures after a measured, byte-preserving fix.
MC_PER_PASS_REFERENCES=off timeout 2400 cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1 > /tmp/rt-after.log 2>&1
timeout 60 python3 crates/mc-module/tests/perf_audit_compare.py /tmp/rt-before.log /tmp/rt-after.log
timeout 60 python3 crates/mc-module/tests/perf_audit_compare.py --self-test
```

Run correctness references separately with `MC_PER_PASS_REFERENCES=on`, then the
full module suite and clippy. Any candidate touching the tokenizer/core also
requires that crate's full suite and clippy. A transform candidate additionally
needs the raw-wire replay differential or equivalent before/after comparison.
No format/epoch/schema changes, migrations, or user-facing flags are authorized.

## Tool issues

The initial foreground release clock gate reached no test: AFT terminated it at
its thirty-minute execution limit while shared compiler slots were occupied.
The resumed background release build finished in 66 minutes. Early full clippy
checking spent a forty-minute attempt queued on dependencies; the next attempt
reached local lint errors, which were corrected and rerun successfully. AFT
restarted once during a foreground compile, and a provider stream interruption
left the staged work intact. An auxiliary process-exit waiter selected the wrong
shell and did not notice an already-finished gate; the parent terminated it.
Final work used ordinary bounded foreground Cargo calls, not polling/wait loops.
These orchestration delays are not performance findings. The three original
read-only backups were pre-existing, were never changed, and remain available to
other workers; harness-created writable clones cleaned up normally.
