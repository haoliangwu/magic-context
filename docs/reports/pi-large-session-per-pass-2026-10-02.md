# Pi large-session per-pass costs

## Scope and isolation

This change concerns Magic Context only. The requested Pi/provider wall-time
split was withdrawn by the owner; it is not inferred from JSONL timestamps.

The private session and `context.db` (including WAL/SHM) were cloned with macOS
`cp -c` into a task-specific directory beneath `$TMPDIR/magic-context/`. Each
replay then cloned that database seed again into an independent throwaway data
root. No live session, configuration, or database was written. Private inputs,
served arrays, timing JSON and mutation logs remain outside Git.

The baseline was archived from `df31b3819bf7922c2832bcc4426486207c92c0e2`.
Both handlers used the same augmented replay runner, database seed and fixture.
The runner clones messages before each context event, matching Pi's hook
isolation rather than letting a transform mutate later fixture passes.

The lane is `historian-low` (25% pressure, mock historian, headless), with
accumulation points 69750, 69752, 69754, 69756, the fixture's final point, and
five repeats of the final point. This is ten real-context-handler passes,
not a microbenchmark of a replacement implementation. The cloned database
contained 44,563 session tags, substantially more than the visible wire's tags.
The run uses Bun and the repository's Pi SDK fixture projection; it is not a
live Pi 0.99/Node/provider experiment. Auto-search and remote embeddings are
not enabled in this deterministic lane.

Reproduction (all paths below must point to throwaway copies):

```sh
bun packages/pi-plugin/scripts/experiments/perf/run.ts \
  --fixture "$COPY/session.jsonl" --database "$COPY/context.db" \
  --points 69750,69752,69754,69756 --repeat-final 5 \
  --lane historian-low --output "$COPY/timings.json" \
  --wire-output "$COPY/served"
```

`--wire-output` stores exact `JSON.stringify` bytes for each served array. All ten
baseline/final arrays compared byte-for-byte equal; all ten persisted behavioral
tag-row hashes also matched. This is stronger than comparing canonicalized arrays
alone. The comparison covers the replayed lane, not arbitrary remote search
results or provider timing.

## Initial single-pair measurements (superseded by the alternating rerun)

Milliseconds, medians over all ten passes, including the first cold pass:

| Stage | Baseline median | Final median | Baseline max | Final max |
| --- | ---: | ---: | ---: | ---: |
| `lkgCapture` | 171.405 | 32.757 | 248.640 | 308.488 |
| `getTagsBySessionSnapshot` | 44.950 | 3.473 | 48.671 | 132.280 |
| `historianScheduling` | 235.631 | 281.956 | 17840.319 | 15458.550 |
| `applyPendingOperations` | 323.119 | 262.123 | 323.119 | 262.123 |
| `runPipeline` | 178.481 | 176.638 | 11180.261 | 16557.009 |
| `postTransformPhase` | 30.494 | 41.039 | 97.989 | 387.235 |
| `entryParseAndBranchResolution` | 16.950 | 21.360 | 567.250 | 607.502 |
| `total` | 475.705 | 549.022 | 29935.514 | 33341.226 |

`lkgCapture` is deferred capture work and is outside the handler's reported
`total`. Do not add overlapping stage totals or present a reduction in deferred
work as a measured reduction in `total`. The stable final passes reuse all 1,170
input fingerprints. Shared-machine scheduling and cold database costs vary
substantially; the data demonstrates the LKG and tag-snapshot improvements,
not a statistically established historian or end-to-end speedup.

## Changes and validity fences

### LKG

The existing Pi path already reused input digests on ordinary append-only passes.
However, cache-busting captures discarded both the replay slot and the input
reuse state, forcing prefix hashing again. Replay invalidation still happens
immediately for changed representations, but detached accepted input fingerprints
now survive that invalidation for capture-only reuse. Exact entry IDs and field
tokens, plus model/provider identity, must match before any digest is reused.

Output serialization also reuses an exact unchanged prefix, independent of host
object identity. Only new/changed messages are serialized. Fully unchanged arrays
reuse their captured JSON string. Non-plain values, custom serializers, accessors
and sparse arrays retain whole-array JSON serialization; field tokens alone do
not prove their JSON representation. An unchanged valid slot skips persistence,
including on a nominal cache-busting pass whose actual bytes/fences did not change.
Failed persistence still requires retry. Deferred work never reads live messages.

### Tag snapshot

A connection-local TEMP revision table and TEMP insert/update/delete triggers
observe tag writes through that connection, including direct SQL. SQLite
`data_version` observes commits through other connections. Unrelated local
metadata writes do not invalidate the snapshot. The cache is bounded to 100
sessions per database handle and returns fresh shallow tag records, preventing
heuristic edits from contaminating later reads. Nothing changes the durable
schema or stores revision records in the main database.

### Historian/raw branch

The provider now counts folded raw ordinals without materializing content, exposes
that count to bounded consumers, and avoids copying the entire branch-reference
array for full conversion. Historian trigger inspection can read from the durable
compartment anchor onward, provided the anchor ID matches at its absolute ordinal.
Missing/mismatched anchors retain the authoritative full-conversion fallback.
Historical tool payloads outside a requested page are no longer synthesized just
to advance ordinals.

**Correction:** an earlier analysis reported that the durable end ID did not
match the raw message at its stored ordinal. That analysis was wrong: it converted
the whole JSONL inventory, including off-branch messages, rather than the active
parent-ID chain. The replay already used the correct branch. `fixtures.ts:218-234` follows
`parentId` from the selected leaf; production `context-handler.ts:1829-1963` does
the same through `SessionManager.getEntry`, with `getBranch` as its fallback.
The durable anchor matches raw ordinal **59,777** on the current branch. No
anchor or boundary was changed to obtain a match.

Five alternating full/paged measurements on that real branch hydrated **60,569
versus 793** messages. Their median was **39.208 versus 27.614 ms**; all ten
returned identical tail bytes, the same absolute count, and zero paging
fallbacks. The private `historian-tail-profile.json` records each run and the
tail hash. Paging is therefore exercised on the real copy, not just a synthetic
test. These are reader timings, not the entire historian scheduling stage.

`applyPendingOperations` remains unchanged: its transaction admits the writer
before reading canonical state and mutating wire bytes. Hoisting a cached tag
read ahead of admission would introduce a race. Only one replay pass applied
operations, so its table entry is a single observation, not a distribution.

## Spike attribution and remaining costs

Read-only inspection of the supplied Magic Context log found:

- 07:59:37Z: `postTransformPhase` 12618.7 ms, of which `autoSearch` was 12587.7 ms.
- 08:00:53Z: `postTransformPhase` 5432.6 ms, `autoSearch` 5394.4 ms.
- 12:53:12Z: `postTransformPhase` 7002.6 ms, `autoSearch` 6925.7 ms.

These are awaited search work, not LKG capture or screenshot tokenization. Moving
search after the hook would change the served hints, so this change does not do
that. The deterministic replay does not reproduce remote embedding/search latency.

The 22:39:55Z `runPipeline` spike was 10314.0 ms, including 2548.6 ms in heuristic
cleanup. A roughly 5.6-second gap between tagging and pending-operation timing
was not subdivided in that deployed log. It cannot honestly be assigned to GC,
lock admission or image tokenization from those timestamps alone.

In the baseline cloned cold pass, pipeline time was 11180.3 ms and measured
synchronous database operations across the pass consumed 10425.3 ms. The visible
`token:bpe` sample was only 160.5 ms; historian scheduling separately took
17840.3 ms. These observations identify cold database/full-raw inspection costs,
but do not prove which individual SQL statement or GC event explains every
historical spike. No live lock contention was recreated. Additional per-query
and GC tracing would be needed for that stronger attribution.

## Five alternating full-transform pairs

The private cloned session and database were replayed through
`packages/pi-plugin/scripts/experiments/perf/run.ts` in five fresh processes per
arm, using the ten-pass `historian-low` configuration defined above. Pair order was AB, BA, AB, BA, AB. Each arm cloned the same database
seed; the machine's shared OS/disk cache was not purged. Values below are each
run's median in milliseconds, not a pooled sample that hides between-run drift.

| Pair | Arm | Handler total | LKG capture | Tag snapshot | Historian scheduling | Pipeline | Post-transform | Entry/branch |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Before | 462.379 | 175.721 | 41.034 | 233.691 | 182.148 | 30.635 | 15.593 |
| 1 | After | 469.850 | 13.067 | 3.136 | 209.407 | 180.319 | 27.032 | 15.786 |
| 2 | After | 392.351 | 13.371 | 2.435 | 191.917 | 145.743 | 26.553 | 18.594 |
| 2 | Before | 399.870 | 147.732 | 39.145 | 199.401 | 147.712 | 23.894 | 13.774 |
| 3 | Before | 418.751 | 140.201 | 38.131 | 200.119 | 149.736 | 28.851 | 14.181 |
| 3 | After | 446.700 | 12.973 | 2.988 | 220.458 | 178.421 | 27.006 | 16.734 |
| 4 | After | 299.558 | 11.083 | 1.702 | 132.158 | 82.266 | 19.191 | 10.017 |
| 4 | Before | 392.623 | 253.157 | 30.283 | 191.636 | 145.889 | 22.630 | 12.705 |
| 5 | Before | 565.422 | 331.637 | 32.461 | 274.451 | 168.445 | 27.125 | 12.254 |
| 5 | After | 1027.769 | 43.855 | 2.536 | 605.495 | 316.538 | 56.173 | 29.619 |

Each arm had only one applied-operation pass. These `applyPendingOperations`
observations are not ten-pass distributions:

| Pair | Before ms | After ms |
| --- | ---: | ---: |
| 1 | 274.060 | 228.825 |
| 2 | 210.675 | 188.396 |
| 3 | 208.099 | 166.421 |
| 4 | 384.399 | 687.023 |
| 5 | 1082.419 | 562.528 |

Median of the five run medians: total **418.751 → 446.700**, deferred LKG
**175.721 → 13.067**, tags **38.131 → 2.536**, historian **200.119 → 209.407**,
post-transform **27.125 → 27.006** ms. The *paired* median total delta is
+7.471 ms; historian is -7.484 ms, with three of five pairs improving. Thus the
initial historian/post-transform increases do not reproduce as a consistent
paired regression, but these five pairs also do **not** establish a handler-wall
speedup. Pair 5's after arm slowed across entry/branch, pipeline, historian and
post-transform, rather than only the new reader. Its median synchronous DB time
rose 82.46 → 129.52 ms, insufficient to explain the 462.35 ms handler increase.
The measurements do not distinguish shared-machine scheduling from GC in that
remaining interval; attributing it exclusively to either would be speculation.

For context, per-pass `total + observed deferred lkgCapture` medians were
634.27/486.15, 533.10/396.52, 560.16/477.94, 701.29/427.88 and
932.11/1085.23 ms before/after. That explicitly includes work outside handler
`total`; it is not a provider-turn wall-time measurement.

**All 50 before/after served arrays were byte-identical**, and all 50 behavioral
tag-row hashes matched. Raw arrays, per-pass stage data and SQL timings are in
the private `full-pairs/` artifact directory. Auto-search was disabled in this
lane. With search enabled, intentionally dropped late hints would differ from
the old behavior; disabling search keeps this equality check about the transform.

## Auto-search deadline and measured root cause

Pi already had the same 3000 ms timer race as OpenCode; lack of a timer was not
the bug. Both implementations performed project preparation before starting the
race. More importantly, synchronous SQLite can occupy the event loop beyond
3000 ms. An already-resolved search promise can then beat the overdue timer and
serve a late result. This explains why the log's awaited search stages exceed
the nominal cap.

The two hosts now share `hooks/magic-context/auto-search-deadline.ts`:

- The fresh operation's budget starts at caller entry and covers preparation,
  snapshot lookup and search, rather than resetting after preparation.
- Async preparation is raced against the remaining budget. Checkpoints after
  preparation and embedding abort overdue continuations before further database
  work, even when the timer has not run yet.
- A result's elapsed deadline is checked before hint persistence. Late search
  results never become hints or permanent no-hint decisions; later user turns
  remain eligible to retry. Cached historical decisions are replayed unchanged.
- `unifiedSearch` also stops an already-aborted request, and checks cancellation
  again before the embedding-dependent lanes. A provider ignoring cancellation
  cannot turn its late vector into another synchronous history-vector scan.

**A strict 3-second wall cap remains unsolved.** JavaScript cannot interrupt a
synchronous SQLite call or a blocked preparation write. The elapsed guard fixes
late-result correctness, not preemption. Cached replay and post-search canonical
hint-decision writes also remain ordinary synchronous operations. No worker,
schema migration, global timestamp/threshold change, or provider change is
included in this delivery.

### Real-prompt phase measurements

The four prompts in the following corpus table were replayed as fresh latest-user
anchors on independent copied stores. The effective minimum is **20 characters**;
all four qualify. No word-count or eligibility policy was changed. Query embedding
used the currently configured remote OpenAI-compatible provider, not an assumed
reproduction of the historical provider. All standalone probes below returned
4096-dimensional vectors, except the initial P3 probe, which timed out at 30 s.

Initial baseline search-call probe, milliseconds. P1–P4 follow the corpus-table
order. SQL lane times are synchronous; the embedding promise is concurrent, so
these columns must not be added as independent wall-time components.

| Prompt | Preparation | Snapshot | Message FTS | History vectors | Memory FTS | Memory vectors/pool | Git FTS | Git vectors/pool |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 | 57.727 | 0.013 | 5904.783 | 306.685 | 117.665 | 127.559 | 9.554 | 171.730 |
| P2 | 32.614 | 0.003 | 4649.972 | 255.844 | 344.907 | 20.249 | 19.387 | 170.104 |
| P3 | 36.720 | 0.002 | 5972.089 | 0 | 344.702 | 18.459 | 15.279 | 12.654 |
| P4 | 48.670 | 0.002 | 5024.744 | 283.445 | 347.427 | 20.653 | 16.023 | 168.025 |

| Prompt | Isolated embedding | Embedding observed during search | Baseline served probe | Initial explicit-search probe |
| --- | ---: | ---: | ---: | ---: |
| P1 | 3399.439 | 5905.817 | 6714.327 | 6336.459 |
| P2 | 11698.286 | 4650.702 | 5504.834 | 10253.126 |
| P3 | 30002.274 (null) | 5973.500 (aborted/null) | 6010.100 | 7930.436 |
| P4 | 512.571 | 5025.486 | 5920.351 | 3199.290 |

Final actual Pi hint-handler probe, with the unchanged original message SQL and
shared deadline checkpoints. Cold setup and standalone embedding are measured
separately before the handler; its preparation callback therefore sees an already
registered project. `ctx` executes the explicit diagnostic `unifiedSearch` path
with the stored ordinal cutoff and visible-memory filter; it is not tool-output
formatting and disables retrieval-count/measurement side effects.

| Prompt | Cold setup | Handler preparation | Snapshot | Isolated embedding | Message FTS | Hint handler served | Explicit diagnostic ctx |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| P1 | 73.769 | 1.225 | 0.008 | 3391.566 | 5258.526 | 5264.214 | 6550.582 |
| P2 | 28.545 | 1.036 | 0.002 | 13067.955 | 4534.497 | 4537.916 | 9664.513 |
| P3 | 43.603 | 1.184 | 0.002 | 3506.518 | 6342.714 | 6347.061 | 12700.834 |
| P4 | 40.075 | 1.234 | 0.003 | 5903.242 | 5154.602 | 5159.740 | 10781.186 |

All four late searches skipped the hint; every post-embedding SQL lane measured
**0 ms**. P1–P3's abort timers actually fired at 5263.193, 4537.062 and 6345.390 ms,
well past the nominal budget because FTS had blocked the event loop. P4's vector
resolved before the overdue timer fired, but the elapsed checkpoint aborted it
and no hint or vector SQL followed. This is the formerly unsafe timer-race case.
Embedding observed within these operations took 5260.653, 4535.828, 6345.034 and
5155.755 ms (first three null, final one vector); callback starvation makes those
numbers **not pure provider latency**. Isolated embeddings and explicit searches
are separate requests, not controlled before/after provider samples. The full
private JSON retains per-query timings for the explicit diagnostic searches.

Vector-loading SQL was also inspected: history is constrained by session,
project and current model (`compartment-chunk-embedding.ts:915-1015`); memory and
git pools are project/model scoped. The evidence does not support blaming a
full global vector-BLOB load for the reproduced multi-second stalls.

### Corpus and candidates

`storage-db.ts:1674-1681` declares `session_id` and message identity columns
`UNINDEXED`; the undated statements in `search.ts` constrain session ownership
outside `MATCH`. FTS therefore walks global matching postings and must seek
content rows to read the unindexed session field before rejecting other sessions.
It is not restricted to the current session's documents before that work.

The copied store has **335,770 indexed FTS rows across all sessions**, but this
session has **802 indexed rows**, compared with **60,569 raw branch messages**.
The sidecar has **335,745 rows globally** and **802 for this session**. An actual
anti-join found **zero missing sidecar rowids for this session**. This corrects
an earlier inference that 802 sidecar rows meant the session's *indexed* history
was mostly uncovered: raw branch size and indexed FTS size are different things.
The global difference is 25 rows and must not be silently discarded by a future
unconditional sidecar filter. Sidecar cardinality alone is not a completeness
proof; its key is `(session_id, message_ordinal)` and its upsert replaces the
mapped rowid (`message-fts-rowid-map.ts:33-45`).

| Actual prompt | Global MATCH candidates | Matching rows in this session |
| --- | ---: | ---: |
| Pi reloaded, we can continue. | 1901 | 1 |
| What's the current status ? | 1961 | 1 |
| Let me know where we are for the anthropic side. | 2195 | 1 |
| Let's go with the implementation. | 1890 | 2 |

For the actual sanitized current-status prompt, independent fresh clones and
connections produced: filtered `COUNT(*)` **5468.528 ms** (876.189 ms process
CPU), original ranked query **5716.472 ms** (911.240 ms CPU), and the same ranked
query additionally restricted through the verified-complete session sidecar
**1551.130 ms** (1260.159 ms CPU). The ranked rows compared byte-for-byte equal.
A count without sorting was already slow, so removing the ranking sort is not
the root fix. This is a single controlled attribution probe, not proof that an
unconditional map filter is correct for all stores, nor a new production query.

### Rejected query experiment

A warm probe incorrectly suggested native `ORDER BY rank` would remove the large
cost. Five alternating cold comparisons instead used fresh `cp -c` clones and a
fresh SQLite connection/cache for each query. The OS cache was not purged. Each
of four prompts ran once per arm per repetition in both the auto-message path
and explicit diagnostic `ctx_search` message path: 80 samples, with identical
result/diagnostic bytes throughout. Prompt medians in milliseconds:

| Prompt | Original auto | Native-rank auto | Original diagnostic ctx | Native-rank diagnostic ctx |
| --- | ---: | ---: | ---: | ---: |
| Pi reloaded, we can continue. | 7573.688 | 5973.976 | 15028.359 | 11130.130 |
| What's the current status ? | 5783.242 | 6002.067 | 19781.094 | 15326.057 |
| Let me know where we are for the anthropic side. | 8219.058 | 9037.125 | 19325.105 | 16195.945 |
| Let's go with the implementation. | 7718.877 | 6936.663 | 7171.409 | 6265.705 |

There was no reliable cold auto-search improvement or 3-second bound. The owner
rejected the native-rank candidate; it and its experimental probes are **not
shipped**. The existing message SQL, ordering and tie behavior are unchanged.
The rejected patch and cold data remain private artifacts.

### Structural follow-up constraints

Two options remain outside this delivery:

1. **Session-first FTS filtering.** Existing rowid metadata can help this verified
   session, but a general fix needs trustworthy completeness/invalidation and
   handling of legacy unmapped rows and ordinal collisions. Backfill must preserve
   physical row identities or explicitly declare any deduplication contract
   change. Preserve ordinal/date cutoffs, live-tail diagnostics and tie ordering.
   Partitioning the corpus or indexing a new session-token column can change BM25
   corpus statistics/ranking; filtering the existing corpus is not equivalent to
   silently switching to per-session scoring. This reduces work but cannot impose
   an absolute bound on SQLite, lock waits or other synchronous preparation.
2. **Shared off-thread execution.** Cover preparation/registration writes as well
   as search; moving only FTS leaves an unbounded write on the caller. Preserve
   project/provider identities, config refresh, model generations, visibility,
   primary/shadow routing, query caches and local-provider lifecycle. Closures and
   live handles cannot simply be transferred to a worker. Timeout/cancellation
   must contain late fetches and SQL, with correct canonical hint-decision
   publication so a dropped hint does not later rewrite an older cached prefix.
   Worker startup, termination and packaging must work for both Pi and OpenCode.
   Off-thread execution protects caller latency but does not eliminate expensive
   global scans or solve legacy index completeness on its own.

## Verification and non-vacuity

The complete Pi suite, Pi TypeScript check, Pi lint and Pi build passed. Shared
search/deadline/OpenCode runner tests, shared TypeScript/lint/build gates and an
explicit TypeScript configuration covering the replay/profiler scripts also
passed. Three existing harness typing mismatches were corrected without changing
replay behavior: the synthetic entry assertion, the disabled-fresh-search lane's
required threshold, and an ignored close argument. Pi lint retains its existing
mural-test warning; shared lint retains an existing storage warning and script
info. Added and moved comments were checked for standalone clarity; ambiguous
history-setting and primer-cache wording was rewritten.

The two Pi deadline regressions were first run against the old implementation:
`does not serve a synchronous search result after the whole-operation deadline`
and `caps preparation and ignores its late completion before retrying the next
turn` were both red. They are green with the shared deadline.

Seven staged-state mutations were marked `NON-VACUITY BREAK`, tested, restored
from the index and touched. Each produced a non-empty diff while applied and an
empty diff after restore. Each failed exactly the named regression while the
remaining tests stayed green:

| Neutralized control | Exact red test |
| --- | --- |
| Capture-only prefix fingerprints | `reuses input fingerprints across a cache-busting capture while invalidating replay` |
| Output serialization prefix reuse | `reuses cloned output serialization and skips unchanged LKG persistence` |
| Unchanged persistence skip | `reuses cloned output serialization and skips unchanged LKG persistence` |
| Plain-JSON serialization fence | `preserves JSON serialization for non-plain output values` |
| Tag snapshot cache | `tag snapshots reuse unchanged rows and invalidate local, external and rollback changes` |
| Proven historian anchor paging | `historian tail pages from the proven anchor without hydrating historical tool content` |
| Out-of-page tool synthesis avoidance | `historian tail pages from the proven anchor without hydrating historical tool content` |

Six additional controls were neutralized, failed their named tests, then restored
from the index with an empty diff. The shared deadline helper's elapsed-result and
exhausted-budget controls each left its other three tests green. Caller-filtered
runs executed only the named regression, with no other failures.

| Neutralized control | Exact red test |
| --- | --- |
| Elapsed check on returned results | `rejects an overdue synchronous result even before its timer fires` |
| Exhausted initial-budget admission | `does not start search after preparation has already exhausted the budget` |
| Pi preparation inside the shared race | `caps preparation and ignores its late completion before retrying the next turn` |
| Pi embedding deadline checkpoint | `aborts at the embedding checkpoint before an overdue search can scan vectors` |
| OpenCode preparation inside the shared race | `caps project preparation before OpenCode search and drops its late continuation` |
| Abort fence before vector SQL | `does not scan vector lanes when a late embedding ignores cancellation` |

No mutation is present in the delivered tree.

## Measured resend compatibility after merging master

Master `e661094edb755239ce9ac1a99542262954a0ac49` added provider-measured fit to
Pi's storage-busy resend. Its captured request must match the replay slot's
`captureSequence` and `capturedAt`, as well as its bytes, model and provider.
A textual merge would publish a new request while unchanged-write skipping kept
an older slot identity, silently discarding the measured fit.

The merged coordinator retains both incremental capture state and measured
request state. Once an unchanged pass is proven by exact inputs, output ownership,
bytes, model and provider, it refreshes the slot's sequence and timestamp through
`captureSlot`, which installs only an in-memory copy. It does this synchronously
before returning from the context hook, not in the deferred commit: provider
usage can be noted before that callback runs. `getSlot` returns a copy, so merely
mutating the returned object would not update the replay slot. The deferred
unchanged commit still returns without `saveLkgSlotToDb`.

Every new captured request starts without usage. Older usage therefore remains
superseded even when request bytes happen to match; new usage correlates with the
fresh request identity. Durable identity may lag while bytes are unchanged, but
provider measurements are process-local and cannot be borrowed after restart.
Existing parent, envelope, model/provider, accepted-reply and timestamp fences
remain intact. Failure to install the in-memory slot forces synchronous capture
rather than pretending the identities agree.

New tests cover both flushed and still-pending deferred capture callbacks. They
note fresh provider usage, replay an image-containing prefix using the measured
fit, and assert SQLite `total_changes()` is unchanged. A separate real-hook test
runs an unchanged steady-state pass, notes 300000 provider input tokens, then
holds a writer lock in another process. Its storage-busy resend must refuse via
`lkg_fit_basis=provider_input`, despite the small local text estimate; the naive
merge instead admitted the request through the estimate. These tests were red
on the naive merge. Neutralizing the synchronous identity refresh again failed
only `a production-timeout busy turn refuses steady-state measured usage`; the
staged live state had an empty diff before the mutation, a 2-insertion/1-deletion
diff during it, and an empty diff after index restore and touch.

A fresh ten-pass comparison against archived current-master source, using the
same cloned session/database seed and identical replay harness, retained **10/10
byte-identical served arrays and behavioral tag hashes**. Artifacts are private
under `master-merged-replay/`. Master's new temporary-directory policy also exposed
an older allocation in the tag-cache regression; it now uses the registered
fixture helper without changing the cache test's assertions.

After integration, the full Pi suite passed 1449 tests (3 existing skips), and the
full plugin suite passed 6391 tests (4 existing skips). Both package typechecks and
lints passed. The initial plugin run found only the temporary-directory policy
violation described above; after switching the fixture helper, the full suite was
rerun successfully. Frozen-lockfile installation installed 29 packages from the
merged dependency state without editing its manifests or lockfile.
