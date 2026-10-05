# CEREB `need_full_sync`: investigation and scratch measurements

## Conclusion

Ship diagnostic logging, not a speculative protocol change. The existing logs identify **ingress tail-delta expansion** as the rejecting path, but do not distinguish a missing/evicted cache from an overwritten fingerprint. They cannot prove that an old message changed, or that a particular timed-out request committed after its caller gave up.

The lost-response hypothesis is real and reproduced: the module installs the next ingress base before the host receives its response; the host advances its wire cache only after successfully applying a response. An undelivered completion can therefore leave the host on base A and the module on base B. A subsequent delta against A is refused. This is **not** the plugin prematurely advancing an uncommitted base. Accepting that delta against B without retaining A would be unsafe.

However, this does **not establish one common cause for all three historical incidents**. The immediately preceding CEREB pass before 22:11 was successful, with an LKG capture. Cache eviction remains a separate plausible explanation. Native sidecar degradation alone is not a reason to request full ingress.

No live store was written, no live daemon restarted, no migration or protocol acceptance rule changed. The worktree has `commons` and `subconscious` siblings. Measurements use generated PNGs and temporary stores, not CEREB's private content.

## Incident chronology (UTC)

Sources read: OpenCode's `magic-context.log` under `getconf DARWIN_USER_TEMP_DIR`, and `~/.local/share/cortexkit/magic-context/logs/magic-context.2026-09-28.log`.

| Incident | Evidence immediately before the refusal | Refusal/retry | Interpretation |
| --- | --- | --- | --- |
| CEREB 21:56 | 21:55:17.903 SOFT+, row 7470, applied; LKG captured 21:55:18.543. Then a delta with input=2 at 21:55:28.363 timed out at 21:55:43.431. Module admitted that page at 21:55:36.438 and reached pending-drops handling at 21:55:36.755. | 21:56:29.188 delta input=4, prefix guard 1.7 ms; transport 82.9 ms; need-full at 21:56:29.272. Full retry succeeded 21:56:39.437, SOFT+, row 7472; LKG captured 21:56:40.195. | Fits an undelivered completion advancing the module base, but no completion/row-version log proves when row 7471 committed. |
| CEREB 22:08 | Module restart; earlier 21:58 request had timed out. | 22:08:35.339 delta input=4, prefix guard 2.8 ms; transport 21.7 ms; full retry succeeded SOFT+, row 7477, LKG captured. | Expected cold-process cache loss. |
| CEREB 22:11 | 22:10:54.448 delta input=2; 22:10:56.976 SOFT+, row 7482, applied; LKG captured 22:10:59.238. Other preceding successful rows were 7478, 7480, 7481. | 22:11:19.566 delta input=2, prefix guard 3.4 ms; transport 3921.0 ms; need-full at 22:11:23.489. Full build 22:11:23.510; module page 22:11:24.747; pending drops 22:11:25.221; host timeout 22:11:39.556. | Does not fit an *immediately preceding* lost completion. An older timeout is insufficient by itself after several successful delta/LKG passes. Eviction, epoch/context change, or an unobserved concurrent request remain possible. |
| ALF 22:42 | 22:41:35.120 SOFT+, row 21897. Delta admitted by module 22:42:19.758; pending drops 22:42:21.909; host timed out 22:42:28.897 (15.55 s). | Next delta admitted 22:42:51.023; host received need-full 22:42:55.640 after 7451 ms. Full page 7,390,246 bytes at 22:42:57.857; host timed out 22:43:13.566 (whole pass 25.46 s). | Again fits lost completion/base skew, but existing module log contains no corresponding completed row-version evidence. |

`rust.prefix_guard` logs duration, not a boolean. The following `mode=tail_delta` proves the guard accepted the reusable prefix. A substantive edit detected by that guard would instead have selected a full send before contacting the module. This makes a detected old-message edit an unlikely explanation of these *module* refusals, but is not proof against all concurrent writers.

The logs contain no per-pass completion record with fingerprint/row version for the timed-out requests. `pending drops held` is an intermediate scheduling decision, **not a commit or completion marker**. Do not infer a late commit from it. The current durable session row would likewise not recover the missing historical completion chronology.

## All module paths and checks

At this revision there are three call sites of `need_full_sync_response` in `crates/mc-module/src/lib.rs`:

1. Historian producer namespace with a tail delta: producer passthrough requires the full array.
2. Registered/bound dreamer producer with a tail delta: same restriction. Binding errors are errors, not need-full replies.
3. Ordinary session: `expand_transform_tail_delta` cannot reconstruct full ingress. CEREB and ALF take this path, not either producer exemption.

`TransformResponse::need_full_sync` is the shared response constructor in `transform.rs`; it omits CK/native arrays and returns `status=need_full_sync`, `committed=false`. It does not itself validate anything.

Expansion prerequisites, in order:

- Delta must be an object with string `after`, unsigned/in-range `replace_from` and `native_replace_from`; current `full_array_fingerprint` must exist.
- Store must be available and the session load must succeed, to get the current **revert epoch**.
- Projection snapshot must belong to that session/epoch; its **whole ingress fingerprint** must equal `after`, its projection context must match, and its message prefix must be reattachable/in bounds. A ready full-request snapshot with the same fingerprint can supply the prefix instead.
- For nonzero native prefix length: native attachment cache must have the same session/revert epoch/fingerprint and enough ingress chunks/retained-size entries. A same-fingerprint full-request snapshot with enough native messages can supply it instead.
- Current `native_messages` must be present; append the supplied CK/native suffixes and clear `tail_delta`.

Important distinctions:

- There is **no row-version equality test** that rejects an ingress delta here. Row versions serve store CAS, telemetry, and mirror bookkeeping elsewhere.
- There is **no ordinal-memo equality test** on this module path. The memo is plugin-owned; keeping it across need-full avoids an unrelated full host-store scan.
- The wire `after` is the cached whole-array fingerprint, not a numeric transform generation. Page-series generation/id/digest validation is a separate transport gate that emits typed page errors, not need-full.
- `tail_units_matched` is a render work counter, not a need-full predicate. Outgoing native delta cache validation happens later and can fall back to **full native output**, not full ingress.
- The module does not recompute a hash over current screenshot bytes and compare it with `after`. It compares stored fingerprint labels supplied by the plugin. Current hashes and prefix snapshots are computed on the plugin side.

### Plugin base selection

In `rust-mode-transform.ts`, `previousWireCache` is the last successfully installed request cache. Delta selection requires no forced-full/emergency request, nonshrinking raw count, an intact provider-relevant prefix, and available CK/native rolling prefix hashes. It usually resends the prior visible last message plus new messages. `after` is `previousWireCache.fingerprint` (CK rolling hash joined with native rolling hash), while the new fingerprint is advanced over the replacement suffix.

`buildWireFingerprint` hashes `JSON.stringify` bytes; the content guard compares copied primitive field tokens. `contentSnapshotValue` excludes the known empty OpenCode user diff-summary noise. Substantive text/tool/image changes remain meaningful. Existing tests exercise older-message edits, equal-length tool argument changes, empty summaries, and byte-identical replay.

`heapHolder.wireCaches.set(sessionId, pendingWireCache)` runs only after successful response application/bookkeeping. `lkg_snapshot_async` is separate durability work; it is not an ingress-base acknowledgement to the module. Neither SOFT+ nor `committed=false` means that ingress caches stayed on the old request: `store_projection_cache`, native cache replacement, and `finish_ready` run for successful transforms independently of the priced-render commit flag.

## Lost response reproduction and next protocol step

New regression `undelivered_transform_advances_delta_base_without_host_ack`:

1. Apply full ingress A.
2. Let the module finish full ingress B, but simulate losing its reply.
3. Submit a delta against A: it returns `projection_fingerprint_mismatch`, without changing the durable row on rejection.
4. Replay the full B request and compare serialized CK output bytes with the undelivered B result: identical. Success omits the diagnostic reason field.

This proves the mechanism, not attribution of historical network timeouts. A local shortcut that relabels A as B would silently attach the caller's suffix to the wrong prefix. Keeping two giant bases changes bounded-cache policy and still needs an acknowledgement/revert/concurrency contract. The safer protocol follow-up is to recover the prior **exact content-addressed page result** (or poll its in-progress completion) before constructing a new delta, coordinated with the separate storage-busy/polling worker. Do not import/reseed durable state or reset ordinals on a missing base.

## Degradation versus eviction

At 21:56:38.864 the native cache logged requested charge 40,176,741, retained charge 20,373,423, `dropped_sidecar_trees=true`, `delta_core_preserved=true`. This is **after** the 21:56:29 refusal. It cannot cause that earlier refusal. The following 21:56:54 delta succeeded, as did 21:57:04 and 21:57:39: there was no immediate full/degraded/full loop.

`NativeAttachmentCache::replace` removes the old generation, evicts *other sessions* to admit the new core, and drops optional raw sidecar trees if the full snapshot does not fit. The retained core includes ingress chunks and fingerprint required by `delta_native_prefix`. Sidecar trees can be re-decoded from expanded native ingress. Existing `giant_degraded_snapshot_accepts_tail_delta_and_reuses_projection` and `cold_soft_plus_full_sync_primes_the_next_tail_delta` tests passed.

Eviction is different: another session can remove this session's native core. If the full-request fallback is also absent/over-budget, expansion legitimately cannot reconstruct the prefix. Native eviction records were debug-only; they are now info-level. The old 22:11 logs cannot rule eviction in or out.

`NativeDeltaFallbackReason::MissingCacheState` and `MissingNativeContent` belong to **outgoing native-response construction**. `finalize_native_messages_response` preserves or encodes a complete native array when a suffix cannot be used. These enums do not themselves answer `need_full_sync`. Conflating outgoing suffix fallback with missing ingress is misleading.

## The unaccounted 14 seconds

Historical bounds:

- Full wire build 22:11:23.510 → page timing log 22:11:24.747: **1237 ms**.
- That includes a measured **349.8 ms digest** and **8.9 ms page-size JSON re-encode**, as well as unknown host paging/stringify, transport, admission, parse, and scheduling time. It is not a pure socket transfer measurement.
- Page timing → pending drops: 474 ms.
- Pending drops → host timeout: approximately **14,335 ms**.

`mc-transform-page-timing` is emitted by `handle_transform_page` after digest validation, page-size serialization, and `TransformPageCache::stage`, **before** final assembly/transform execution. It does not delimit completion.

Previously `emit_pass_timing` logged stages at **debug only**, after response serialization/splicing and before returning response bytes to transport. Absence from the info log does not establish that the caller timeout suppressed it. This change logs passes whose handler-plus-response-encode time is at least 1000 ms at info, with action, row version, commit flag and ingress fingerprint. The emission does not depend on a client acknowledgement or successful socket write. A process kill or cancellation before that code is reached still cannot produce a completed-pass line.

### Reproducible scratch fixture

`packages/plugin/scripts/cereb-full-sync-probe.ts` generates 174 native messages, including ten deterministic valid noisy 300×300 PNG data URLs, and uses the production `encodeOpenCodeMessagesToCk` and `buildPagedModuleTransformPayloads`. The page is **9,223,536 bytes**, with **3,606,220 bytes of image carriers in the native form**. Unique test page IDs shorten the measured socket requests to 9,223,481 bytes. This is deliberately synthetic, not a replay of CEREB's store.

Run the generator with `MC_SYNC_PROBE_FIXTURE=/tmp/<unique>.json`. For the direct measurement, start the ignored library test `cereb_full_sync_socket_probe` with `MC_SYNC_PROBE_SOCKET=/tmp/<unique>.sock`, wait for its socket to exist, then run the script with that socket variable. For the daemon measurement, run ignored integration test `cereb_full_sync_through_real_daemon` with the fixture variable. The latter reuses `real_daemon.rs` lifecycle helpers: isolated runtime/config/data homes, empty store, no OpenCode, no production connection file. All subsequent cargo commands were serialized and capped with `CARGO_BUILD_JOBS=2` and `-j 2` after that limit was requested.

### Direct Unix socket split (debug/test build, overloaded machine)

Milliseconds, one sequential run. Passes are cold HARD, warm full SOFT+, and SOFT+ after explicitly clearing projection/native/request/serialized caches. No artificial delay was added.

| Stage | Cold | Warm full | Cache-cleared full |
| --- | ---: | ---: | ---: |
| Bun page building/hashing (once) | 354.9 | — | — |
| Bun final page stringify + UTF-8 buffer (once) | 2.84 | — | — |
| Client socket write completion | 1398.0 | 955.9 | 765.3 |
| Server body read (same overlapping transfer) | 1396.3 | 955.3 | 760.2 |
| Server JSON parse | 64.3 | 59.9 | 60.2 |
| Module page digest | 4788.3 | 2131.0 | 1909.4 |
| Module page size re-encode | 1400.9 | 928.2 | 590.9 |
| Module projection | 2189.0 | 0.3 | 679.4 |
| Native attachment stage | 13982.1 | 11115.5 | 14362.1 |
| Native messages re-encoded | 176 | 0 | 176 |
| Store commit | 8.3 | ~0 | ~0 |
| Handler follow-up / historian trigger work | 3360.7 | 389.1 | 1111.1 |
| CK output building | 2518.3 | 1430.1 | 2509.9 |
| Response serialization/splice, from completion log | 436.2 | 639.9 | 496.5 |
| Entire handler including page admission/response | 34097.4 | 21669.9 | 23799.2 |
| Reply body transfer observed by client | 662.8 | 1027.6 | 613.4 |
| Client response parse | 17.1 | 5.6 | 3.8 |
| Client round trip, excluding response parse | 36354.3 | 23914.2 | 25442.3 |

Read and write timing intervals overlap: do **not** add them as independent costs. The socket write callback includes backpressure and scheduling; this is measured transfer wall time, not pure kernel CPU time. Server read ends before JSON parse starts. Response timing also excludes the scratch harness's diagnostic response parse before writing it back.

The native attachment stage includes sidecar decode, cache-key/hash work, encoding/replay and reasoning evidence/finalization; it is **not pure PNG decoding** (the module does not decode the PNG pixels). Zero encoded messages on the warm pass still took substantial time. These stage intervals are nested: projection/output/commit are inside transform execution, and native attachment is inside handler total. Do not sum all table rows.

**Comparison caveat:** the direct library test has `cfg!(test)` native differential checking enabled automatically, so it performs additional reference encoding/verification. The actual daemon binary does not. These are useful isolated transfer and handler measurements, but not an apples-to-apples throughput benchmark or a claim that production spends 14 s exclusively encoding images. Debug builds and rapidly changing machine load are further confounders.

### Isolated Subconscious daemon comparison

Production handler in a debug `ck-mc`, differential flags explicitly off, same fixture, fresh scratch store, three full requests with distinct page IDs (cold then two warm full passes). Latest run:

| Stage (ms) | Cold | Warm 1 | Warm 2 |
| --- | ---: | ---: | ---: |
| Rust consumer request serialization, before call | 355.2 | 312.6 | 271.6 |
| Consumer round trip, serialized request → reply bytes | 8446.4 | 3607.5 | 3325.7 |
| Page digest | 973.4 | 916.7 | 969.1 |
| Page size re-encode | 416.6 | 381.4 | 350.1 |
| Handler total (after page admission, before response encode) | 6711.3 | 2035.8 | 1775.5 |
| Projection | 513.6 | 0.2 | 0.2 |
| Native attachment | 2475.1 | 1460.3 | 1259.7 |
| Store commit | 8.6 | ~0 | ~0 |
| Follow-up/trigger | 1317.3 | 202.9 | 167.5 |
| CK output build | 491.6 | 8.8 | 42.0 |
| Response encode | 233.4 | 217.2 | 171.2 |
| Consumer response parse, after call | 50.1 | 44.2 | 46.0 |
| Residual: round trip minus page digest/size, handler total and response encode | ~112 | ~56 | ~60 |

That residual includes **all** request/reply socket traffic, daemon admission/multiplexing, module byte-to-Value parse, page assembly, response caching, and uninstrumented scheduling. It is an upper bound on daemon-specific overhead in this unloaded scratch route, not a direct queue timer. It does not show a multi-second daemon penalty. It cannot exclude production admission delay under fleet load. An earlier run on the same fixture was 16.22/6.77/5.13 s total, with handler totals 13.28/3.36/3.04 s: absolute times vary dramatically with load.

These measurements support looking inside handler/native attachment work rather than attributing every missed deadline to moving 9 MB across a socket. They **do not reconstruct the missing historical 14 s**. The new completion logs make the next occurrence attributable.

## What makes the page 9 MB?

Exact generated-page accounting; string payload categories are UTF-8 bytes before JSON escaping. Structural overhead includes keys, punctuation, numeric/boolean literals and quotes, and makes the accounting sum exactly to 9,223,536. CK and native are both transmitted by design.

| Category | CK bytes | Native bytes | Other bytes |
| --- | ---: | ---: | ---: |
| Image data URLs | 3,606,220 | 3,606,220 | 0 |
| Text | 929,400 | 929,400 | 0 |
| Metadata string values | 2,878 | 2,632 | 186 envelope |
| Tool inputs/outputs | 0 | 0 | 0 |
| Reasoning/signatures | 0 | 0 | 0 |
| Additional JSON escaping | — | — | 90,828 |
| JSON structure, keys, numeric fields | — | — | 55,772 |

Images comprise **78.2%** of this page; text 20.2%; escaping/structure/metadata about 1.6%. The dominant expansion is **duplicating content in CK plus native trees**, not envelope overhead. One native image corpus of 3.61 MB becomes 7.21 MB on the wire. The fixture intentionally has no tool/reasoning material; zeroes must not be read as measured zeroes for CEREB. CEREB's actual per-kind split cannot be recovered from a page byte count and `proxy_bytes=3989555`, and this report does not claim otherwise. A raw-fallback content proxy is not serialized protocol size; it excludes at least the second representation and wire structure.

## Shipped diagnostics and verification

- Additive optional `need_full_sync_reason`, omitted on success/older-compatible constructors. Reasons distinguish producer passthrough, malformed delta fields, store availability/load, missing/reverted projection cache, projection fingerprint/context/prefix mismatch, missing native cache, native epoch/fingerprint/prefix mismatch, and absent native suffix.
- Module rejection log includes session, reason, requested old fingerprint and new fingerprint. Plugin retains its grep-compatible retry prefix and appends reason (or `unknown` for old modules).
- Native-cache eviction is now info-level. Slow completion stage log is info-level, before transport delivery, with action/row version/commit/fingerprint.
- Tests preserve rejection's no-store-write/omitted-array contract, exercise cache loss and undelivered-response skew, and compare replay bytes. Existing large degraded-cache and plugin native-byte identity tests passed.
- Diagnostic mutation control: removing the reason assignment made only `tests::tail_delta_returns_need_full_sync_success_without_store_write` fail (`Null` versus `invalid_replace_from`); restored from a staged snapshot before final gates.
- `cargo fmt --check` and `cargo clippy --locked -j 2 --all-targets -- -D warnings` passed with `CARGO_BUILD_JOBS=2`.
- Requested module/store suite: module 1420 passed, 14 ignored, one unrelated wall-clock assertion failed under load (`handler_stuck_historian_is_bounded_and_next_transform_succeeds`, elapsed <5 s). That exact test passed alone in 3.58 s. Store's 198 tests and module integration suites then passed separately; ignored manual fixtures remain ignored except both scratch probes, which were run explicitly.
- Plugin typecheck passed (including the new probe after moving it into plugin scripts); affected transform suite: 142 passed, 0 failed, including original SHA256 identity checks. Frozen install changed no manifests/lockfiles.
- Comment review completed; both flagged comments clarified. AFT diagnostics were incomplete in this worktree; compiler/typecheck gates above are the authority.

No deadline expansion, fallback relaxation, previous-base retention, or result-polling protocol change is included. Those belong with the coordinated recovery work, informed by the newly observable reasons and completion records.
