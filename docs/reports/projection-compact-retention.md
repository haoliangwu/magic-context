# Compact retained projections

## Fixture and allocation accounting

No live store or configuration was opened. The synthetic ALF-shaped admission fixture
uses 9,268 messages, 30,000 canonical text blocks, and production wire
serialization/deserialization. Its request is **118,842,881 bytes**, including
the CK and native forms. These measurements use the same allocator-oriented
`ProjectionCacheSnapshot::retained_bytes` estimate as admission, not RSS.

| Retained component | Before (bytes) | Compact (bytes) |
| --- | ---: | ---: |
| Canonical serialized block allocations | 58,675,560 | 58,675,560 |
| Typed wire, including inline shell storage | 63,175,560 | 7,200,000 |
| Lossless original block JSON, including nodes/keys | 66,295,560 | 8,640,000 |
| Flat block vectors/identifiers, identity maps, message shells, frontiers, cache wrapper and charge memo | 23,031,120 | 23,031,120 |
| **Total admission charge** | **211,177,800** | **97,546,680** |

The primary text allocations formerly occupied 57,655,560 bytes in each of the
typed and original views, independently of the canonical JSON allocation.
Both payload copies are gone. The new shell includes range/Arc metadata, which
is charged in full; the second Arc reference does not allocate another text
buffer. The reduction is **113,631,120 bytes (53.81%)**; charge/wire drops from
**1.777x to 0.821x**. Native bytes in the request denominator are not retained
by the projection, so 0.821x is not a claim of compressing the CK text itself.

The large-fixture test checks empty typed/original text fields, borrowed text
addresses within the canonical allocation, `charge >= payload allocations`,
bounded structural overhead, the 1.1x target, admission, neighbor co-residency,
and an actual handler tail-delta expansion with native-prefix reattachment.
The memo vector's allocation is counted; its numeric request charges are not
added to projection admission. All independent native/output charges remain
unchanged.

## Ownership and lossless replay

`ProjectedWireBlock` retains a typed/lossless **shell**, not another payload.
Text, reasoning, redacted reasoning, and scalar text/error-text tool outputs
keep a range into `FlatBlock::bytes`, shared through `Arc<str>`. Unescaped text
is a borrowed slice. Escaped JSON text is decoded only for a consumer needing
the payload. Unknown fields, omitted defaults, provider extras, signatures and
output variants remain in the lossless shell. A typed/original mismatch falls
back to the full retained block rather than silently choosing one view.

Metadata consumers use the explicitly documented `wire_shape` view; text
predicates and tag/hygiene scans use `scalar_text`. Replay constructs a full
wire block only when a request prefix actually needs one. The new doc-hidden
`CkWireBlock::replay_validated_shell` accepts an existing validated block with
its own original JSON, not independently supplied arbitrary parts. It can
replace only a scalar string field, updates typed and original views together,
and rejects unsupported or missing fields. This avoids re-deserializing every
block. Its small mc-store scope extension was approved by the parent, with
constructor parity tests and mc-store gates required.

Fingerprint reuse compares the scalar payload and all typed/lossless metadata
without materializing an owned block. Renderer paths already holding a full
ingress block use that block rather than reconstructing another copy.

**Remaining copies:** complex JSON tool arguments/results, content-array tool
outputs, media/opaque trees, and strings embedded in provider/unknown fields
retain their existing typed/original allocations. Tool calls also retain the
indexed `tool_input` tree. Their callers inspect nested typed trees repeatedly;
replacing those with serialized-only storage would require a separate borrowed
tree interface or repeated parses in selection/historian/rendering. The size
estimator still charges all these allocations, and JSON-heavy sessions can
still hit admission limits. The single-copy result and measured ratio apply to
the scalar-text-heavy fixture, not arbitrary JSON-heavy sessions.

## Timing

Release-mode timings on the same host/toolchain measure prefix reattachment
plus projection of one appended tail message, including the actual recreated
ingress messages and incremental projection. Nine samples are taken, with
the median reported; destruction is outside the measured interval in both
runs. This is the projection seam of a delta pass, not a full tokenizer,
historian or transport benchmark.

- Before: **18.250 ms** (samples 17.378–31.827 ms).
- Initial compact implementation using serde reconstruction: **25.820 ms**
  (+41.5%). This was rejected as the final replay path.
- Validated-shell reconstruction: **14.823 ms** (samples 14.524–27.201 ms),
  **18.8% faster** than the 18.250 ms baseline. The median is under the 10%
  regression limit; replacing serde construction removed the initial regression.

## Served-byte proof

`compact_projection_multi_pass_served_bytes_match_baseline` runs independent
temporary-store handlers with compact retention and a test-only reference that
retains the former complete typed/original wire block. It compares the complete
serialized **CK plus reassembled native output arrays**, not timings or hashes
of the input. The current-thread scoped reference guard restores on drop.

The replay covers cold full sync, two distinct acknowledged tail-delta defers,
a priced execute/config-change pass, then a real `publish_historian_chunk`
transaction and the pass rendering its summary. It includes signed reasoning,
tool calls/results, Unicode, newline, quote and backslash text. Publication is
seeded deterministically in a temporary store; no real model is invoked.

The first four output hashes were also captured **before any retention edits**:

| Pass | Output bytes | SHA-256 |
| --- | ---: | --- |
| Cold | 1,407 | `44e6c96da02972ffb728ac3e84cbcc7367e7cc907a80dc348bfb520f5b1d2ee3` |
| Defer 1 | 2,093 | `48be75604d237c4c5d166ce849670b9c6ca0f1441349e403b9bf74bd4bf3b789` |
| Defer 2 | 3,293 | `0545fea19343e3bb11358897ff80fa974b5b37992515617423c22b6493e87e15` |
| Execute | 5,450 | `b7405b3032dd3b08e721edc579173ac316385a80d626f7937173a9b084cbe217` |

After the seeded historian publication, both retention models serve **6,218
bytes**, hash `cb4609b33cc655bfd5e91701e627833f10143341e753edcb26d84cb09177c33a`;
the test also asserts that the published summary is actually present.

Separate roundtrip tests preserve unknown block/kind fields and distinguish
original JSON from constructed blocks. Matching tests reject payload, unknown
field and typed-only changes. The constructor parity test independently
deserializes empty shells and compares replay to the original serde result for
text, signed reasoning, redacted reasoning, tool calls/results, error text and
an image with unknown fields. It checks both value equality and original JSON
serialization.

Two staged-index **NON-VACUITY BREAK** controls were restored immediately after
their red runs (non-empty working diff during each break, empty after checkout
and touch):

1. In `ServedMessage::from_message_reusing`, change `start` to `Start` only for
   compact projected text. `compact_projection_multi_pass_served_bytes_match_baseline`
   failed at **retention differential on pass 0**. The scalar roundtrip and
   unknown-field matching tests stayed green (**1 failed / 2 passed**). This
   mutates production serving, not the oracle or comparator.
2. In `replay_validated_shell`, append `x` to only the original JSON text field,
   leaving the typed text unchanged. `projection_replay_constructor_matches_serde_for_validated_shells`
   failed with the original field `雪\n"text"x` versus `雪\n"text"`.
   `projection_replay_constructor_rejects_non_scalar_replacement` stayed green
   (**1 failed / 1 passed**).

## Bounded cache policy

Use **160 MiB per entry / 224 MiB total**, not the 288/384 MiB stopgap.
The measured projection is 93.03 MiB; the entry limit gives about 72% growth
headroom. Its former ~73 MiB constructed-text neighbor is now ~36 MiB, and the
fixture proves both survive together. The total still allows a substantial
second session without alternating evictions. This is a bounded policy, not
a promise that arbitrary sessions fit forever. Admission warnings, fallback,
revert fencing and LRU eviction are unchanged.

Native attachments and serialized output remain independently budgeted at
256 MiB each. The ordinary three-cache target is now **736 MiB**. Active Arcs,
requests, stores and the existing native oversized-core exception are not
bounded by that target; it is not a whole-process memory cap.

No wire protocol, schema, migration or render/profile epoch changed. Architecture
and structure documents are untouched.

## Final verification

Toolchain: **cargo 1.99.0 (5f94df478 2026-08-27)**,
**rustc 1.99.0 (b940084d7 2026-09-28)**,
**clippy 0.1.99 (b940084d7e 2026-09-28)**,
**rustfmt 1.10.0-stable (b940084d7e 2026-09-28)**.

- `cargo fmt --all --check`: passed.
- `cargo clippy --locked -p mc-module --all-targets -- -D warnings`: passed,
  all **15 package targets**, including the example and integration targets.
- `cargo clippy --locked -p mc-store --all-targets -- -D warnings`: passed,
  **1 package target**.
- `cargo test --locked -p mc-module`: passed, **1,556 library tests + 24
  binary/integration tests**, 0 failures. The **22 pre-existing ignored**
  private/opt-in tests were not changed or newly skipped.
- `cargo test --locked -p mc-store`: passed, **222 tests**, 0 failures,
  **2 pre-existing ignored** tests unchanged.
- `cargo test --locked --release -p mc-module --lib compact_projection_ -- --nocapture`:
  **3 passed**, including all five replay passes.
- `cargo test --locked --release -p mc-module --lib alf_scale_projection_is_retained_and_next_pass_accepts_tail_delta -- --nocapture`:
  **1 passed**, charge and nine delta timing samples printed above.
- `git diff --check`: passed.

The first combined format/clippy/test command exhausted its 30-minute aggregate
shell limit after both clippy gates and the module library tests passed, while
the real-daemon integration tests were still running. Shared compile slots were
heavily queued. The module test command was rerun **alone with the same timeout**
and passed completely (its real-daemon target took 852 seconds); the store gate
then ran separately. No timeout, test, or runner setting was increased.

Rust-analyzer inspection remained partial because its producer was still
indexing/timing out. The locked clippy/all-target compilation and complete
package tests supply authoritative Rust verification instead. The lockfile and
package manifests are unchanged; no installation or deployment was needed.

Timing limitations: the admission fixture uses long unescaped scalar text.
Escaped text correctness is covered in replay/roundtrip tests, but a heavily
escaped large payload may pay additional per-pass decoding cost. The measured
delta seam improvement is not a claim of an 18.8% whole-pass speedup.
