# Native attachment retention: static diagnosis

Inspected at `e50e2b52e71d871dcc5afc3ea046a8dacc774bbe` (the relevant cache
code is also present in deployed `e2b6abeb`). **No cache, budget, or served-output
changes are proposed in this delivery.** The investigation was narrowed after
the host's stale compaction marker was identified separately.

## Findings and limits

The incident's ALF charge of 164–173 MB is an **admission estimate**, not a
measurement of allocated or resident memory. The eviction log reports only its
total. A numerical component split of that live entry was **not obtained**;
the component table below is a static decomposition, not an invented split of
173 MB.

The follow-up host measurements supplied for the incident are decisive:

| Session | Ingress messages per pass | Served messages |
| --- | ---: | ---: |
| ALF | 12,943 | 226 |
| AFT | 6,272 | 646 |
| CEREB | 2,599 | 541 |

The native cache retains the **acknowledged ingress**, not just the served
array. Already-summarized native history therefore continues to occupy its
delta-required core until the host actually advances its compaction marker.
The independently identified plugin guard, `hasPartialCompartmentEndThrough`,
prevents that advance when an earlier compartment ends inside a message.
Increasing the cache budget would mask this input-window problem.

Read-only `VACUUM INTO` copies of the MC stores yielded these storage counts
(not native-window counts or native memory measurements):

| Session | `message_history_source` rows | Maximum ordinal | Persisted coverage ordinal | `mc_block_identities` rows |
| --- | ---: | ---: | ---: | ---: |
| ALF | 134,659 | 134,659 | 134,446 | 31,977 |
| AFT | 55,182 | 140,237 | 139,595 | 29,874 |
| CEREB | 23,719 | 24,938 | 24,399 | 9,210 |

The whole-host OpenCode `VACUUM INTO` failed after creating approximately
24 GB of incomplete output; the source was 39,277,285,376 bytes. The release
profiler build also failed with `No space left on device`. No profiler ran,
and no real-session before/after wire comparison was completed. On instruction,
all copies and incomplete output were deleted, no new copies were made, and
`du -sh "$TMPDIR/magic-context/native-cache"` confirmed **0B**. Temporary
profiling code was removed. In particular, the incomplete OpenCode output was
not a usable, credential-scrubbed database.

## What the native entry charges (static)

`crates/mc-module/src/lib.rs:3235–3371`,
`NativeAttachmentCacheSnapshot::retained_bytes`, adds these components:

| Component | Charge and retained ownership |
| --- | --- |
| Encoded chunks | Chunk-vector capacity plus a 16-byte Arc header and `native_value_retained_bytes` for each output `Arc<Value>`. These are parsed provider JSON trees, **not just encoded byte buffers**; they contain only served output. |
| Ingress chunks | Arc-vector and size-vector capacities plus each distinct ingress `Arc<Value>` allocation not already charged as output. This retains the entire acknowledged raw ingress, including history omitted from served output. |
| Sidecar keys | Sidecar structure, harness string, order-vector capacity and ID strings, mid-pin BTreeMap nodes/strings, sidecar-hash HashMap capacity and ID strings. |
| Optional sidecar trees | Message-map nodes/key strings/Arc headers, size-map capacity/key strings, and recorded per-message metadata estimates. These can be absent in a degraded entry; an eviction total alone does not establish whether ALF retained them. |
| Cache keys/structure | Message-key vector capacity (32-byte hashes), context strings, fingerprint, session structure, session-key/LRU allowances. |
| **Unowned served-message proxy** | **Twice the total canonical served-message byte length**, added independently of the components above. The snapshot has **no `ServedMessage` field or owner**. This is an accounting defect, not an actual retained copy in this cache. |

`retained_size.rs:17–62` estimates native JSON allocations from string/vector
capacities and BTreeMap entries with a three-word node/slack allowance. Thus
native JSON can cost substantially more than its wire byte length. Neither
these estimates nor the budgets measure RSS or allocator fragmentation.

The served proxy is calculated at `lib.rs:15242–15265`. Its comment says
canonical bytes stand in for shared served-message allocations, but
`NativeAttachmentCacheSnapshot` stores hashes and native JSON, not those
canonical owners. Canonical output belongs to other holders. Charging this
proxy to the native LRU can cause eviction without corresponding native
retention. With 226 served messages it must not be confused with a charge for
all 12,943 ingress messages; its actual byte contribution was not measured.

## Actual duplication and Arc accounting (static)

* **Ingress versus sidecar:** `native_ingress_chunks` (`lib.rs:14823–14867`)
  retains a clone of raw ingress unless it can share an identical output Arc.
  OpenCode decoding separately deep-clones that whole native message into
  `HarnessMessageMeta.raw` (`codec/opencode.rs:247–256`). Keeping the sidecar
  therefore keeps another copy of ingress text and provider metadata.
* **Two raw copies inside the sidecar:** the whole-message raw tree already
  contains `parts`, but `push_block` also deep-clones each decoded part into
  `BlockMeta.raw` (`codec/opencode.rs:616–636`). Completed tool parts can feed
  multiple canonical blocks, so a part can be cloned more than once there.
  These are genuine independent `Value` trees, not shared Arc payloads.
* **Optional, reconstructible trees:** admission can clear `sidecar.messages`
  and `sidecar_sizes`, preserving order, pins, hashes, encoded output, and
  ingress (`lib.rs:3373–3379, 3502–3539`). Missing sidecar trees are decoded
  again **only for the suffix to re-encode** from expanded ingress
  (`restore_degraded_sidecar_raw`, `lib.rs:14564–14634`). They are useful for
  warm re-encoding but not required permanently for delta transport. Clearing
  `sidecar_sizes` does not release its HashMap capacity; the charge includes it.
* **The compact projection does not deduplicate native strings.** The earlier
  “one text copy” work (`f0fc1e21b4` / `38a47f7abe`) compacted the CK projection.
  Native ingress/output/sidecar use ordinary `serde_json::Value` strings, not
  references into that projection. Matching text in these independent trees
  remains separately allocated. Projection retention is charged by its own
  cache, not directly by this LRU.
* **Shared native Arcs are counted once across output and ingress:** accounting
  seeds a pointer set with output Arcs, then charges an ingress Arc only when
  inserting its pointer succeeds (`lib.rs:3273–3299`). Distinct equal trees
  correctly remain separate charges. Output chunks are summed individually;
  the current construction creates a new Arc per newly encoded chunk and
  clones each reusable chunk once, rather than aliasing one Arc across several
  output slots. This is not a general all-holder/global Arc deduplicator.
* **Sharing is positional and conservative:** ingress shares an output Arc
  only for a single-message chunk at the same start index whose entire Value
  is equal (`lib.rs:14846–14862`). Synthetic served prefixes and summarized
  history shift those coordinates, so equality elsewhere does not yield
  sharing. Preserving ingress separately is necessary: `native_replace_from`
  indexes the adapter's input, not the transformed output.
* **Sidecar accounting is heuristic:** `native_sidecar_hash_and_size`
  (`lib.rs:14670–14674`) uses `size_of(meta) + 2 * serialized_meta_length`,
  not a recursive allocation walk. That serialized metadata already contains
  the raw-message and raw-block copies. The multiplier is an estimate of their
  allocations, not proof of yet another retained serialization buffer; the
  temporary buffer is dropped. The outer sidecar Arc header is also not
  explicitly charged. These facts preclude treating the total as exact RSS.

## After the host window shrinks to roughly 250 messages

The optional sidecar's whole-message/part duplication, ingress-versus-output
copies, and the unowned served proxy still exist at that scale. Their cost
depends on payload bytes and provider metadata, not merely message count; a
few very large tool results can still matter. However, the stale thousands of
ingress messages are the demonstrated amplification. Fix the marker first,
then measure small-window entries before considering a separate representation
or accounting change. No budget increase, cache fix, or parity claim is part
of this report.
