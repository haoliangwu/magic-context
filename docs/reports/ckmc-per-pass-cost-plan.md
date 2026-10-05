# ck-mc changed-message pass plan

## Decision and evidence boundary

**Plan, not a shipped optimization.** This change adds only test-only clocks and
an ignored, test-only SHA-256 checkpoint prototype. The request/response schema,
cache algorithms, invalidation rules, persistence format and production behavior
are unchanged. `profile_start!` / `profile_end!` erase their clock operations
outside `cfg(test)`.

The new breakdown materially changes the interpretation of the earlier measured
results in [ckmc-per-pass-cost.md](ckmc-per-pass-cost.md):

- The unattributed ~150 ms is mostly the **prefix projection differential**, not
  unexplained production transform work. It rebuilds the entire projection,
  serializes both projections and compares their state.
- Most of the ordinary pass's ~117 ms native attachment is the **native
  differential**, which decodes the entire native ingress and encodes a fresh
  reference even when the incremental encoder only changes two messages.
- Both predicates explicitly return true under `cfg!(test)`, including a release
  `cargo test`. Setting their environment variables to `0` does **not** disable
  them in this harness. Outside tests they are opt-in through
  `MC_PREFIX_PROJECTION_DIFFERENTIAL=1` and
  `MC_NATIVE_ATTACHMENT_DIFFERENTIAL=1`. No toggle or guard was changed here.

Therefore do not budget 117 ms of *production delta* savings for a native cache
rewrite, or count removal of a correctness reference as an optimization. Tail
hygiene remains a real whole-session target. Implement hygiene first, then native
index/container reuse; keep the independent references for parity validation.
The older ranking's 350–425 ms hygiene estimate was based on live wall times, not
this experiment's CPU costs, and is not a prediction for this workload.

## Release measurements

### Reproduction and isolation

Base: `0cd19e6fcf5bf4a2cfcb0e433ff5afc0c4fcceff`. Final instrumentation measured on
2026-10-04, macOS, cargo 1.99.0 / rustc 1.99.0. Command, unmodified:

```sh
timeout 3000 cargo test --release --locked -j 2 -p mc-module --lib \
  copied_sessions_per_pass_cost -- --ignored --nocapture --test-threads=1
```

The existing read-only `$TMPDIR/magic-context/ckmc-perf/backups/{context,store}.db`
were reused, not recreated or removed. The existing harness opens backup SQL
sources immutable/read-only and uses writable throwaway clones for migrations and
commits. No live stores were opened. Only statistics are recorded here; logs and
databases are not committed.

There were three warmups and 20 measured passes per session/mode: **180 measured
passes, nine summaries**, one passing ignored test. Every measured pass asserted
SOFT+, and all 120 non-delta samples matched the corresponding 60 delta samples'
complete serialized CK and assembled native arrays. All passes also retained the
existing full native reference; acknowledged projection passes retained the full
projection reference. These are synthesized, scrubbed *scale* fixtures, not
captured live requests or a recorded-session proof of a new implementation.

The final run took 80.83 s after compilation. One-minute load averages at the
nine mode starts were 40.00, 39.26, 38.52, 34.73, 34.73, 35.87, 37.92, 37.92,
40.33. These are **loaded-host**, not quiet-host measurements. An earlier clock
build hit its 3000 s limit while compiling dependencies through the six shared
compile slots. After diagnosing the slot queue, the first harness build completed
in 9m48s; final clock/prototype instrumentation compilation completed in 9m08s.
No slot limiter was bypassed and no simultaneous manual native builds were run.

### Session totals (thread CPU / wall ms, median of 20)

| Session (messages, frozen units) | Mode | Handler total | Transform execute | Native attach | Hygiene |
| --- | --- | ---: | ---: | ---: | ---: |
| ALF (7,501, 36,749) | warm_delta | 524.86 / 530.11 | 364.95 / 369.04 | 119.54 / 121.37 | 62.76 / 62.87 |
| ALF | warm_full | 594.38 / 608.18 | 281.09 / 286.03 | 236.26 / 240.10 | 58.75 / 59.83 |
| ALF | evicted_full | 702.65 / 722.05 | 290.00 / 294.64 | 343.39 / 352.77 | 61.25 / 61.61 |
| CEREB-sized (1,876, 12,017) | warm_delta | 152.87 / 157.56 | 98.24 / 101.81 | 32.13 / 33.20 | 15.40 / 15.64 |
| CEREB-sized | warm_full | 197.36 / 206.16 | 85.77 / 87.64 | 73.53 / 76.80 | 16.78 / 17.49 |
| CEREB-sized | evicted_full | 206.44 / 210.29 | 79.28 / 80.23 | 92.81 / 93.32 | 14.25 / 14.49 |
| Small (569, 878) | warm_delta | 69.40 / 70.26 | 45.33 / 46.04 | 17.38 / 17.55 | 6.07 / 6.13 |
| Small | warm_full | 101.64 / 103.05 | 41.88 / 42.57 | 48.12 / 48.53 | 6.22 / 6.35 |
| Small | evicted_full | 106.50 / 112.17 | 42.72 / 44.49 | 51.12 / 54.00 | 6.30 / 6.51 |

ALF has 23,273 projection blocks. Delta projection reuses 7,499 ingress messages
and projects two. Native attachment reuses 331 served messages and encodes two
(333 total, including synthetic frames); eviction encodes all 333. Full ingress
requests do not have a trusted native prefix, even with warm output caches.

### Closing the transform gap

New gap spans on ALF's delta pass, CPU / wall ms:

| Span | Median | Scope |
| --- | ---: | --- |
| ingress_validation | 157.228 / 158.483 | Includes the following projection differential |
| ↳ projection_differential | 153.507 / 154.764 | Full reference, comparisons and destruction |
| ↳ ↳ projection_differential_project | 73.166 / 74.102 | Project all ingress messages |
| ↳ ↳ projection_differential_bytes | 59.811 / 60.385 | Serialize both projections and compare bytes |
| ↳ ↳ projection_differential_state | 10.278 / 10.297 | Compare full projected state |
| transition_pre | 5.270 / 5.302 | Frozen renderer shapes and temporal transition detection |
| identity_enforce | 1.662 / 1.691 | Durable block-identity enforcement |
| tail_match_diagnostics | 0.741 / 0.747 | Match frozen units to tail for a counter |
| coverage_and_reconciliation | 0.370 / 0.370 | Boundary resolution and reconciliation branches |
| transform_wrapper_prepare | 0.150 / 0.150 | Legacy synthetic treatment and retry inputs |
| apply_result_build | 0.145 / 0.145 | Result/response construction, not later destruction |
| overlay_inputs | 0.110 / 0.111 | Channel-1 rows and overlay input selection |
| render_context | 0.102 / 0.102 | Content/render epochs and surface setup |
| transform_context | 0.086 / 0.086 | Handler's producer context |
| store_tags | 0.013 / 0.014 | Cached tag hydration |
| lineage_validation | 0.001 / 0.001 | Continuation/anchor/surface validation |
| stable_pass_trace | <0.001 / <0.001 | Post-transform stable trace, inactive on committed samples |

The `apply_once` lifetime span (364.707 / 368.755) starts before other locals so
it includes destruction after the existing wall `total` timer. On each sample,
subtract the original disjoint children (projection, seed/sync, tag overlay,
temporal, planning, state clone, evolution, build output, finalize) from
`transform_execute`: median old gap **171.093 ms**. Adding the new disjoint gap
spans and wrapper/context spans leaves **4.452 ms** of residual self-time,
bookkeeping and local destruction. The differential is a child of ingress
validation, not an extra sibling to subtract. Ingress validation excluding its
differential is **3.659 ms** (median of per-sample differences).

Child medians do not sum to parent medians. In particular the projection
differential's residual includes releasing the full reference projection; it is
not another 153 ms hidden under the named steps. The old ~150 ms is now explained
without attributing it to state evolution or a production cache miss.

### Native attachment partition

ALF CPU medians, ms; names correspond directly to test-only spans in `lib.rs`:

| Disjoint step within native_attach | warm_delta | warm_full | evicted_full |
| --- | ---: | ---: | ---: |
| native_snapshot_validate | 0.001 | 0.001 | 0.001 |
| native_sidecar_decode | 1.238 | 93.682 | 93.988 |
| native_indexes | 0.877 | 0.997 | 0.969 |
| native_message_keys | 0.326 | 7.358 | 7.326 |
| native_remaining_hashes | 0.759 | 0.878 | 116.518 |
| native_reuse_frontier | 0.002 | 0.002 | <0.001 |
| native_suffix_prepare (including degraded raw restoration) | 0.011 | 0.010 | 0.194 |
| native_suffix_encode | 0.015 | 0.015 | 2.187 |
| native_suffix_reasoning | 0.339 | 0.324 | 0.642 |
| native_reencode_drift | 0.002 | 0.002 | <0.001 |
| native_output_assemble_validate | 0.057 | 0.057 | 0.209 |
| native_ingress_chunks | 0.033 | 7.078 | 7.224 |
| native_differential | 113.514 | 106.576 | 111.096 |
| native_publish | 1.818 | 2.252 | 2.094 |
| Residual (per-sample subtraction) | 0.485 | 16.768 | 0.230 |

The full warm residual includes destroying the old cached sidecar after decoding
its replacement; it is not encoding of the two-message suffix. The warm delta
partition accounts for the ~117 ms asked about to within 0.5 ms.

The **native_differential** delta children, CPU / wall ms, are:

- `native_reference_decode`: **98.076 / 99.093**;
- `native_reference_prepare`: 0.143 / 0.147;
- `native_reference_encode`: 2.318 / 2.358;
- `native_reference_reasoning`: 0.438 / 0.444;
- `native_differential_bytes`: 0.570 / 0.583.

The remaining differential self-time releases the large reference sidecar and
other temporary reference data. `native_publish` contains `native_cache_replace`
(1.815 / 1.818): requested charge 0.420, core clone 0.287, optional-tree degradation
0.602, core charge 0.291, admission 0.001 CPU ms, plus temporary destruction.
Even a fitting full snapshot pays clone/degrade today; this is small but avoidable.

Median **per-sample** `native_attach - native_differential` is **6.180 ms delta,
129.990 ms warm full, 232.270 ms evicted full**. Similarly subtracting both
differentials from handler_total gives 257.635 ms on ALF's delta pass (81.800 ms
CEREB-sized, 36.066 ms small). These are arithmetic estimates of the measured
non-reference work, **not timings from a non-test binary or a references-off
experiment**: running references changes allocation/cache pressure. The 0.07 ms
per message test slope cannot be assumed to be the production slope.

### Hygiene partition

ALF delta CPU / wall medians:

```text
evolution_hygiene                 62.760 / 62.872
  hygiene_tag_rows                 4.854 /  4.899
  hygiene_measure                 56.997 / 57.087
    hygiene_indexes               11.143 / 11.309
    hygiene_parts                 38.818 / 39.178
    hygiene_signature              5.177 /  5.185
  hygiene_refresh                  1.178 /  1.192
    hygiene_refresh_buckets         .030 /   .030
    hygiene_refresh_compare         .205 /   .205
    hygiene_refresh_baseline        .640 /   .644
```

Measurement includes teardown of temporary indexes. Refresh includes teardown of
the measured parts. Covered, synthetic and reasoning blocks still get excluded
parts and content hashes. The dominant work is constructing/hashing *all* parts,
not baseline comparison or tokenizer calls on two new messages.

## Shared implementation constraints for the future candidates

Define changed work as **D input/served replacements plus A messages whose
effective semantics changed** (coverage, tag, arc, protection, queue, exemption or
overlay changes). An ordinary admitted append/stream update should cost
O((D+A) log M), with A normally the tool/role seam and old/new newest assistant.
A fold covering thousands of messages legitimately has large A. Untrusted full
requests and arbitrary earlier rewrites may retain O(M) fallbacks. Sending a full
provider array still costs O(served bytes); move that lower bound to explicit
materialization, not a hidden whole-session key/index walk.

For both designs use a concrete immutable page tree, not `Arc<Vec<T>>` followed
by `Arc::make_mut` (which copies the prefix):

- `Seq<T>`: an Arc-rooted, path-copy B+ sequence tree, at most **64 entries per
  leaf**, **32 children per branch**, with subtree lengths and aggregates;
- `Map<K,V>`: the same fanout keyed B+ tree, sorted keys and path-copy updates;
- `Set<K> = Map<K,()>`. Leaves hold Arc-backed payloads/strings; roots clone O(1).

Split/truncate/concatenate by ordinal, replacing only suffix leaves and paths.
No pass-level collection clone, map rebuild, `.retain` over the whole session or
unbounded chain of delta overlays. Charge page allocations, payloads and indexes
to the existing session LRU budgets; admission failure falls back to the old path.
Persistent nodes are immutable; tentative roots publish only after acceptance.

## Design 1: native attachment as an indexed generation plus dirty suffix

### Exact retained state

Extend the session's `NativeAttachmentCacheSnapshot` concept to:

```text
NativeGeneration {
  basis: (store_namespace, session_id, revert_epoch, NativeAttachmentContext,
          acknowledged_full_array_fingerprint),
  order: Seq<Arc<str>>,                  // native index -> slot mid
  positions: Map<Arc<str>, usize>,       // slot mid -> native index
  mid_pins: Map<Arc<str>, Arc<str>>,      // preserve codec pin semantics
  slots: Map<Arc<str>, Slot>,
  ingress_ordinals: Map<Arc<str>, u64>,
  ingress: Seq<ChargedNativeValue>,
  served_keys: Seq<KeyRecord>,
  chunks: Seq<NativeEncodedChunk>,
  served_by_slot: Map<Arc<str>, Set<usize>>,
  chunk_by_start: Map<usize, ChunkIndex>,
  tool_uses: Map<Arc<str>, Map<ChunkIndex, usize>>,
  shared_values: Map<AllocationId, (reference_count, retained_bytes)>,
  optional_raw: Map<Arc<str>, Arc<HarnessMessageMeta>>,
}
Slot = (exact sidecar SHA-256, retained charge, stable native index)
KeyRecord = (existing native key, bound slot, existing identity inputs)
ChargedNativeValue = (Arc<Value>, allocation_id, retained_bytes)
```

Keep optional raw trees separately, so fitting full admissions do not construct
and destroy a degraded copy. Subtree charge aggregates plus allocation reference
counts replace whole pointer-dedup/sum walks. Allocation IDs follow actual shared
owners, not content hashes; sharing equal-but-distinct Values is not assumed.
Do not change the budget constants or claim an uncharged optional sidecar is free.
The exact charged bytes will reflect the new representation, but eviction must
remain bounded and byte parity must hold under either eviction decision.

### Ordinary-pass algorithm

1. Apply the existing epoch/context/after-fingerprint/frontier checks **before**
   using any prefix. Native and CK frontiers index different arrays; do not equate
   native indexes with message ordinals or served positions.
2. Decode only the changed native suffix with retained pins/base. Path-copy its
   order, slots, positions and pin changes; hash/charge only new metadata. Remove
   replaced suffix membership by its retained index, not a whole-map retain.
3. The renderer supplies a validated `ServedDelta` alongside its output root:
   unchanged-prefix length, replacement suffix and explicit dirty mids/reasons.
   This must be derived from actual output identities, not raw ingress bytes.
   Without that contract, the native function's current whole served-key walk
   cannot honestly become changed-only. Dirty old/new reasoning exemptions,
   lineage/mutation exemptions, native-keep mids, tag/clear changes and every
   served slot whose raw metadata changed. Position shifts dirty their suffix.
4. Recompute the **same** key bytes on dirty records. Find the first actual key
   mismatch from dirty positions and truncation/append, not just the first event.
   Reproduce exact-hit/common-prefix logic, then restart at the chunk containing
   `common.saturating_sub(1)` as today. Same-role merges can reach back across the
   seam. Restore degraded raw trees only for slots being encoded, preserving slot
   binding even for synthetic-only harness messages.
5. Run the existing encoder/reasoning clear/keep operations on that suffix.
   Preserve chunk boundaries and unknown JSON/provider fields. Patch tool-use
   multiplicity indexes to implement the existing duplicate-ID assertion without
   scanning all unchanged chunks. Compare re-encoded unchanged-key chunks against
   retained values exactly as the existing drift detector does.
6. Splice persistent chunk/ingress roots, adjust charges and publish. Materialize
   the identical ordered full native array or existing native delta envelope at
   the response boundary. No earlier dirty prefix is silently omitted to make a
   suffix smaller. Full reconstruction is the byte contract, including under
   eviction/degradation; cache counters/timings are not provider bytes.

### Invalidators and fallback

Retain all current fences: missing cache/fingerprint, after mismatch, context
(session/profile/render config/profile epoch/transition consumed) change, revert
epoch, invalid native frontier/length/pins, lineage switch, route replacement or
last-route teardown, recomp/reset/delete, restart, eviction. An unknown dirty
event, earlier synthetic-frame/position rewrite, or contraction before the trusted
prefix invokes the old full path. A full request with a new fingerprint and no
acknowledged frontier still decodes/hashes all input; the design must not "trust"
it just because some output keys happen to match. Degraded raw loss alone does
not invalidate core order, pins or hashes; it requires restoration for changed
encoding, not fresh whole-session decoding.

### Expected saving

**Estimated 3–5 ms CPU of the corrected ~6.18 ms ALF ordinary native cost**, not
100+ ms. Targets: suffix-only sidecar container updates, ~0.88 ms index build,
~0.76 ms remaining-hash/map membership walk, incremental charging/admission
(~1.82 ms publication), plus old snapshot teardown. Full request decoding and
cold hash work remain priced separately. No credible cheap isolated prototype
can establish this saving: it requires codec, renderer-delta and accounting
contracts together. No native optimization prototype was installed.

## Design 2: incremental hygiene measurements with the same baseline/signature

### Exact retained state

```text
HygieneGeneration {
  basis: (store_namespace, session_id, revert_epoch, validated projection token,
          frozen/overlay/tag generations, persisted baseline digest/generation),
  parts: Seq<PartRecord>,
  blocks: Map<BlockId, Seq<PartIndex>>,   // preserve first-block-wins lookup
  mids: Map<Mid, Range<PartIndex>>,
  arcs: Map<ArcId, Set<PartIndex>>,
  call_arcs: Map<RawCallId, Set<ArcId>>,
  tags_by_block: Map<BlockId, TagNumber>,
  tags_by_arc: Map<ArcId, TagNumber>,
  tag_members: Map<TagNumber, Set<PartIndex>>,
  message_tag_bounds: Map<MessageIndex, (min_tag, max_tag)>,
  orphan_dependencies: Map<RawCallId, OrphanAttribution>,
  red_targets: Set<BlockId>, caveman: Map<BlockId, Arc<str>>,
  protected_blocks: Set<BlockId>, protected_tags: Set<TagNumber>,
  queued_tags: Set<TagNumber>,
  frozen_baseline_parts: Seq<TailHygienePartMeasurement>,
  signature_checkpoints: Seq<(message_boundary, Sha256)>,
  baseline_cut: usize, newest_message_cut: usize,
}
PartRecord = (exact effective-input identity, TailHygienePartMeasurement,
              comparison against frozen baseline at that index)
```

Each part leaf aggregates T/U, tools/prose T/U buckets and the ordered
baseline-comparison result (first mismatch, protection-release U, queued-drop U).
Keep scalar baseline/calibration/grace metadata alongside the shared frozen root.
The persisted baseline representation and serialized field order remain the same;
an internal shared view must not reserialize/deep-clone baseline_parts merely to
construct each ephemeral refresh. Materialize the old Vec only on a new baseline
or at the existing persistence boundary that really requires it. The store still
performs its current validation reads; this is not a proposal to bypass digest or
same-length repair checks.

### Dirty computation and exact arithmetic

1. Reuse validated projection/tag/frozen indexes, and incrementally maintain the
   effective hygiene tag rows. Identity includes key/kind/bytes, role, synthetic,
   ordinal/coverage, effective caveman text, arc attribution, tag number/status,
   protection and queue membership. Cache excluded parts too: their current
   content hashes are observable baseline/signature inputs even with zero tokens.
   Preserve reminder stripping, sentinel detection and media/tool serialization.
2. Dirty the replaced/appended message blocks and seam arcs; expand red/sentinel,
   protected-block, tag and queue changes through reverse arc/tag indexes. Dirty
   the coverage interval and protection-window crossings, not every covered block.
   Preserve first caveman unit wins, tag row ordering and block-before-arc lookup.
3. Legacy raw-call-id orphan attribution needs more than seam invalidation. Keep
   prefix-max/suffix-min aggregates on message tag bounds for the existing
   neighborhood test, plus dependencies of orphan owners on those bounds. A new
   repeated call ID or new neighboring tag can change an old orphan's attribution;
   dirty those arcs. Unknown legacy dependency or repair falls back to full
   attribution, never "active" by assumption.
4. Re-measure dirty parts with the **unchanged** measurement functions. Compare
   them to the *frozen baseline*, not last pass's parts. Unchanged leaves keep
   accumulated protection-release/queue contributions relative to that baseline.
   The tail beyond baseline_cut contributes in full each pass, not only D. Match
   `compared_field` priority, calibration retention, grace, computed_at_ms,
   generation_invalidated/evaluable and the baseline_generation bump exactly.
   Test shortening first: the current reference reports `shorter` immediately if
   current length is below frozen length, before checking other field mismatches.
5. Nonnegative token/bucket sums can use saturating subtree aggregates. Signed
   queued-drop deltas cannot be repaired by subtracting saturated totals or by
   regrouping arbitrary i64 additions. Retain ordered saturating-add transducers
   (`x -> clamp(x + offset, low, high)`, composed in reference iteration order)
   with checked i128 bookkeeping; fall back to the ordered reference fold on
   overflow. Include tests near i64 limits as well as ordinary token sizes.
6. The signature is still SHA-256 of **exactly** `key:content_hash\0` in part order.
   Keep a cloned SHA-256 continuation state at each message boundary. For a
   streaming suffix, resume from the last unchanged boundary and hash the new
   suffix. Protection/queue-only changes keep key/hash bytes and need no rehash.
   An earlier key/hash mutation invalidates checkpoints from that boundary onward;
   rehash its suffix (or full fallback). A Merkle root or XOR digest is **not**
   byte-equivalent to the existing content_signature.
7. Use the resulting identical effective baseline for existing Channel-1/2 policy
   and wire construction. Do not cache a nudge decision across changed usage,
   delivery acknowledgments, time, suppression or grace state. Publish tentative
   measurement roots only after accepted state commit; discard on CAS retry.

### Invalidators and fallback

Revert/reset/recomp/delete/lineage, cache eviction/restart, untrusted projection
prefix, message reorder/contraction/middle rewrite, serializer/content-unit
version, baseline generation/digest change, HARD/SOFT freeze, coverage movement,
tag remint/drop/reorder/repair, frozen red/caveman changes, reminder/overlay
changes, sentinel/arc changes, protection enter/exit and queued/consumed drops
invalidate the relevant ranges or the complete generation. Use revisions/events
already validated by the store, not row_version alone or pointer identity before
validation. If any writer lacks a complete dirty event, use full measurement.
External SQL repair and corruption must continue to force the current rebuild.

### Expected saving and bounded prototype

**Estimated 50–58 ms CPU of ALF's measured ~62.76 ms hygiene envelope**, targeting
the 38.82 ms parts walk, 11.14 ms indexes, 4.85 ms tag rows and 5.18 ms signature.
Budget several ms for changed parts/index paths, invalidation and policy inputs;
do not promise all evolution (72.16 ms) disappears. The cache must also avoid
whole parts/baseline clones on refresh, or it merely moves the cost.

The cheap signature-only prototype is the ignored
`tail_hygiene::tests::signature_checkpoint_prototype_matches_full_hash`, entirely
inside `cfg(test)`. It uses 23,000 synthetic key/hash parts, a 2,127,797-byte stable
prefix and a changing last part, compares the old full-format SHA with continued
SHA **on all 23 passes**, and samples the last 20:

| Operation | Thread CPU median |
| --- | ---: |
| Rebuild complete signature string and hash | 5.1101 ms |
| Clone 112-byte SHA checkpoint and hash changed suffix | 0.0016 ms |

This measures **~5.11 ms synthetic signature saving only**. It does not prototype
measurement/tag/protection invalidation, prove provider output parity, or justify
the 50–58 ms total estimate by itself. The initial checkpoint construction is cold
work, outside the steady timing. Retaining one checkpoint per message would cost
about 0.80 MiB of SHA states for 7,501 messages, plus page/index overhead, and must
be charged. No prototype runs on the production path or inside the measured
copied-session harness.

## Required byte-identity proof before implementing either design

For **each** candidate retain the old scanning/reference implementation, not an
expected value computed from the new keys. Add a recorded-session differential
test that executes **every pass**, including warmups, against two isolated stores
seeded identically and a deterministic clock/publication/config event stream:

- Native candidate: old `attach_native_messages_incremental` vs candidate on the
  same served CK identities, clear units, tags, sidecars and exemptions; also
  compare both against `encode_full_native_messages` on every pass. Serialize the
  complete ordered CK arrays and **assembled** native/provider arrays after
  applying deltas to the previously acknowledged array. Compare actual bytes,
  system, tools and Channel-1/2 directives, not JSON struct equality, cache-hit
  counts, or null native placeholders. Verify merges/chunk envelopes when both
  paths have the same cache availability.
- Hygiene candidate: compare every measurement part/field, ordered parts, U/T,
  newest cut, signature, all baseline/bucket/calibration/grace/generation fields
  and exact prefix mismatch `(index, mid, field, lengths)` to the old path on every
  pass. Then compare complete CK/provider bytes, nudge/directive bytes and durable
  decisions after the transform. Equal U/T alone is insufficient.

Use a scrubbed **recorded request + event sequence**, including actual unknown
native fields, signed/redacted reasoning, tool metadata, numeric values, synthetic
reminders and role merges. Backups contain no such recording; the current shape
harness is not its replacement. Include unchanged replay, append/stream, tag
mint/remint/loss, old/new newest assistant, orphan recurring call IDs, early/middle
rewrite, shrink/revert, coverage advance/shrink, protection crossing, queued and
consumed drops, caveman/reduction changes, HARD/SOFT fold, epochs, direct SQL
repair, corruption, CAS rejection/retry, restart, interleaved sessions and
forced tiny-budget degradation/eviction. Compare durable decisions as well as
bytes so a stale root cannot pass now and fail on the next pass.

Additionally run, separately for **each** candidate commit:

```sh
bun packages/e2e-tests/scripts/pure-replay-differential.ts <old-ref> <candidate-ref>
```

Do **not** pass `--ts-only`: use the Rust lane and compare every defer's provider
messages, system and tools. Inspect scratch/XDG setup for copy-only isolation
first. The existing four-defer pure replay is required but insufficient for all
invalidators above; extend the recorded-session corpus rather than silently
claiming that replay covers repair/bust behavior. Performance runs should later
use a test-only references-off mode, separate from mandatory references-on parity
runs, with the mode explicitly printed and correctness gates left on by default.

Future silent invalidation tests must prove non-vacuity: stage candidate state,
apply a labeled NON-VACUITY BREAK removing one relevant dirty/fence update, capture
the non-empty diff, require its named parity test to fail while unrelated controls
stay green, restore from the staged state and capture an empty diff. No such guard
was added or neutralized in this plan-only change.

## Verification of this delivery

- `cargo fmt --all --check`: passed, rustfmt 1.10.0-stable.
- Release package test compilation typechecked the changed Rust files; no
  production cache candidate, dependency or lockfile change.
- `thread_cpu_clock_records_work_and_stays_opt_in`: 1 passed.
- `signature_checkpoint_prototype_matches_full_hash -- --ignored --nocapture`:
  1 passed, 23 byte comparisons / 20 timing samples.
- `tail_hygiene::tests::`: 15 passed, 2 ignored (scaling and the separately run
  prototype), including TS parity goldens and prefix/queue/protection cases.
- `native_cache`: 4 passed, including byte-affecting invalidation, degraded replay,
  complex prefix reuse and multiple large sessions under the total budget.
- `copied_sessions_per_pass_cost -- --ignored --nocapture --test-threads=1`:
  1 passed, 180 measured samples / 9 summaries after final span edits.
- Scoped editor diagnostics were incomplete while the Rust analyzer warmed;
  authoritative verification is the successful release package test compilation.
- Pure replay candidate comparison is **planned, not run**: there is no
  production-path candidate in this change. The signature prototype is not that
  candidate and claims no complete-session parity.

Acceptance for subsequent optimization work: run the recorded-session and pure
replay gates above, demonstrate invalidation non-vacuity, measure with references
off and on separately, and report ordinary-pass work counters against D+A at
matched session sizes. Do not roll unrelated projection/store/renderer rewrites
into either first implementation just to hide remaining whole-session costs.
