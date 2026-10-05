# ck-mc per-pass cost: whole-session work behind a small served tail

## Measured results (2026-10-04)

> **Correction.** These numbers include two full-reference self-checks that only run in test builds: the prefix projection differential and the native attachment differential. Both turn on under `cfg(test)`, including a release `cargo test`. They account for about 150 ms of the unattributed transform time and about 113 ms of native attach on the ALF delta pass. Without them, the estimate for ALF's ordinary pass is about 258 ms, and native attach is about 6 ms. See [ckmc-per-pass-cost-plan.md](ckmc-per-pass-cost-plan.md) for the per-step breakdown. Read the table below as test-harness cost, not production cost.

The harness below ran on read-only copies of the live stores, with build `545d5f22`, release profile, 20 samples per mode, at load average 40–44. Values are the median per pass, given as thread CPU / wall ms. `warm_delta` is an ordinary acknowledged pass, `warm_full` is a full request with warm caches, and `evicted_full` is a full request after the projection and native caches are dropped.

| Session (messages, frozen units) | warm_delta | warm_full | evicted_full |
| --- | ---: | ---: | ---: |
| ALF (7,501, 36,749) | 507 / 512 | 681 / 697 | 739 / 754 (max 2,887) |
| CEREB-sized (1,876, 12,017) | 162 / 170 | 180 / 189 | 198 / 209 |
| small (569, 878) | 62 / 62 | 97 / 99 | 96 / 98 |

What the numbers say:

- **Cost grows with session size, not with the work a pass does.** An ordinary pass costs about 0.07 ms per message in the session, even though it adds 2–4 messages. CPU and wall agree, so this is computation, not waiting.
- **The module's own time explains about 0.5 s of ALF's live 1.2 s median.** The rest is outside the handler: transport, queueing behind other requests, and load.
- **Losing the projection and native caches costs about 0.24 s on ALF, not seconds.** The 25.8 s and 8.5 s live spikes therefore did not come from re-projection work itself; they came from waiting (the live trace showed 8 s of queueing on the ALF spike).
- **Where an ordinary ALF pass goes** (CPU ms): native attach 117 (inside post-attach 119), state evolution 69 (of which hygiene 60), build output 32, finalize 25, seed/sync 23, store commit 21, tag overlay about 20. About 150 ms inside `transform_execute` is not covered by any child span yet.
- **Native attach is a bigger target than this report's ranking assumed.** It reuses 331 of 333 messages from its cache and encodes only 2, yet still costs 117 ms on a delta pass and 270 ms on a full one.

## Status and evidence boundary

**Report/design only. No cache algorithm, persistence format, or production wire
path is changed. The accompanying CPU clocks are test-only; the profiling test
is opt-in. Release measurements are blocked, not completed.**

Code references below are to the task's `d673754e2405381b87818532c803fd7fa317aa20`
baseline with the adjacent test-only clock annotations in this delivery. The
incident measurements supplied by ALF were taken on deployed ck-mc `1f066a87`;
these are not measurements of a new optimized implementation.

There are three distinct evidence classes:

1. **Measured, supplied live-log evidence:** last 30 slow ALF passes, about 7,500
   ingress messages, load average 40–55; reported module median 1.2 s, maximum
   3.7 s. The stage wall medians and work counters are listed below. They do not
   measure CPU time and are selected slow passes, not a quiet-run distribution.
2. **Measured in this investigation:** read-only `.backup` copies succeeded:
   context.db **7,559,360,512 bytes**, store.db **1,086,177,280 bytes**. Copy-only
   SQL counted ALF **34,837 frozen units**, AFT **36,875**, CEREB **12,096**, and
   the selected small session **876**. These are state-size observations, not
   pass timings. ALF has 26,713 persisted message identity rows; historical
   identity history is larger than the current 7.5k-message request.
3. **Estimated:** all proposed savings. No proposal was implemented or measured.
   No release thread-CPU medians, scaling fit, or differential pass is claimed.

An initial 120-second backup timed out; its partial ~5 GB destination was deleted
before retrying with a 600-second cap. Completed copies were chmod 0400; SQL
inspection used immutable, read-only connections to those standalone backups,
not live databases. The completed **8.65 GB pair was deleted before delivery**, at
ALF's request. No file was written back. No live configuration or OpenCode DB was
opened. No other process was stopped.

The first release compilation attempts spent their bounded runs queued behind
six shared compile slots. A fleet launcher failure was separately identified and
repaired; that is **not a performance finding**. Subsequent bounded compilation
still queued and did not reach the profiling test. ALF directed a coherent partial
delivery instead of further retries. ALF also identified the current sibling
dependency blocker: local `subc-protocol` 0.29 versus crates.io
`cortexkit-role-tool-provider` 0.4.5 / its conformance crate requiring ^0.28,
which produces two incompatible `ErrorBody` types. This investigation did not
reach that compiler diagnostic itself. Aligning the tool-provider release and
absorbing protocol 0.29 is prerequisite work, not included here. The lockfile
retains the baseline sibling versions and adds only the test clock dependency;
temporary resolutions of newer sibling versions are not part of this report.

### Live wall-time inputs (measured by the deployed build, supplied by ALF)

| Stage | Median ms | Important nesting |
| --- | ---: | --- |
| transform_execute | 1182 | Transform umbrella, not self-time |
| state_evolution | 504 | Includes hygiene, composition/transition-post, overlays, todo |
| handler_prepare | 313 | Includes delta_expand |
| delta_expand | 313 | Outside transform_execute |
| finalize | 184 | Includes store_commit and divergence |
| store_commit | 148 | Do not add to finalize |
| trigger_ms / handler_followup | 126 | Approximately equal on these passes; trigger is a child |
| tag_overlay | 101 | Tag mint + two tag-number map builds, **not** all overlay work |
| build_output | 86 | Includes output-preparation and renderer subspans |
| seed_or_sync | 71 | Includes store_cache_state (~70) and overlay reads |
| trigger_boundary_build | 50 | Child of trigger_ms |
| planning | 30 | Includes selection/decide and revision reads |
| post_attach | 28 | Native attach and cache/snapshot/accounting work |
| projection | 26 | Warm prefix reuse still builds whole-array containers |
| temporal | 24 | Separate from the tag mint subspan |
| transition_detection | 22 | Sum of pre-plan and state-evolution post-detection |

Whole-pass counters: frozen_units ~34,750, projection_blocks ~22,900,
trigger_token_cache_hits ~22,700, tag_mint_candidates ~8,700,
projection_reused_messages ~7,520, tail_messages_emitted median 74.

**74 emitted messages is not 74 changed messages.** `tail_messages_emitted` counts
non-synthetic messages in the *served* array (`transform.rs:6590–6593`). Normally
only 2–4 messages are newly projected, according to ALF's additional observations.
Likewise a tag candidate can already have a tag, and a cache hit still costs a
lookup and surrounding traversal. Counters describe work domains, not proof of
zero work.

Do not sum these medians. The reported module 1.2 s and transform_execute 1.182 s
are not sufficient to reconstruct RPC latency when preparation and followup are
also nonzero. Use per-pass handler_total plus response encoding/transport for
that calculation; the stage medians are inclusive and may come from different
passes.

## 1. Stage map, nesting, and complexity

Notation: **M** = ingress messages, **B** = their flat blocks, **F** = stored frozen
units, **I** = persisted identity history, **T** = stored tag rows, **A** = persisted
overlay rows, **S** = served messages/blocks, **D** = replaced/appended ingress
suffix. “Whole” includes the relevant session collection, not necessarily every
message the host has ever stored. Byte lengths matter as well as counts.

### Timing tree on an ordinary successful primary-session pass

```text
handler_total (ends before respond_transform)
├─ request_decode
├─ handler_prepare
│  ├─ trace_received
│  ├─ delta_expand
│  ├─ projection_cache_lookup
│  └─ side_channel_drain
├─ transform_execute (wrapper + retries/normalization)
│  └─ apply_once total
│     ├─ projection
│     ├─ seed_or_sync
│     │  └─ store_cache_state, store_temporal, store_user_hints,
│     │     store_channel1, store_overlay_frontier
│     ├─ store_tags
│     ├─ transition_detection [pre-plan portion]
│     ├─ coverage_resolve, identity_enforce
│     ├─ tag_overlay [tag-number maps + tag mint], temporal
│     ├─ planning
│     │  └─ pending_drops, store_memories/store_notes, decide, selection
│     ├─ state_clone
│     ├─ state_evolution
│     │  ├─ ingress_meta, user_hint, unit_mint, caveman, todo
│     │  ├─ compose_m0m1 (includes transition_detection [post portion])
│     │  └─ channel1 prune, overlay maps, hygiene measurement/refresh/nudge
│     ├─ build_output
│     │  ├─ reasoning/strip/blank-decision preparation
│     │  └─ renderer: build_frozen_unit_index, blocks_by_mid,
│     │     full_drop_tool_ids, build_tail_loop
│     │       └─ build_identity (includes build_frozen_unit_scan),
│     │          build_cache_lookup, build_serialize_misses
│     └─ finalize
│        ├─ divergence
│        └─ store_commit, output-cache replacement, result bookkeeping
├─ handler_followup
│  └─ trigger_ms (prepare_historian_fire, including early-return paths)
│     └─ trigger_boundary_build, trigger_eval, trigger_cache_store
└─ post_attach
   └─ projection_cache_store, native_attach, trace_complete,
      response_observation, retained_size, snapshot_store

response_encode (outside handler_total, logged at serialization)
└─ response_meta_encode, response_size_account, response_splice
request_observed_to_handler = queue/dispatch age, not a nested CPU stage
```

Emergency95 can wait for a producer/publication and invoke the transform again
inside followup (`lib.rs:10445–10594`). Its followup is not just trigger CPU, and
transform_execute measures the initial invocation, not those later executions.
Compaction-off, subagent, pending-rewrite, lineage, and deterministic rejection
branches do not run the entire ordinary timing tree. Stage zeros are not evidence
that a session collection is empty.

### Handler and transport-facing stages

All paths in this table are under `crates/mc-module/src/`.

| Stage | Code / timing boundary | Work per pass now |
| --- | --- | --- |
| handler_total | `lib.rs:9927–10743`, transform handler | Whole umbrella; nesting above |
| request_decode | `lib.rs:9929–9968`, serde from_value into TransformRequest | O(D bytes) for tail delta; O(M bytes) for a full request |
| request_observed_to_handler | `lib.rs:9951–9956` | O(1) clock difference; includes time before handler entry, not transform CPU |
| handler_prepare | `lib.rs:9969–10375` | Whole on delta expansion; otherwise small route/config/domain reads plus lookup |
| delta_expand | `lib.rs:10100–10104`, `expand_transform_tail_delta` at `4985–5144`; `ck_wire.rs:129–169` | **Whole O(M bytes)**: reconstruct CK prefix, clone native prefix Values, append D; caller sent a suffix but callee reconstructs an owned full array |
| trace_received / side_channel_drain | `lib.rs:10049–10051`, `10198–10204` | O(1) trace row / bounded pending side-channel batch; SQLite waits possible |
| projection_cache_lookup | `lib.rs:10189–10195`, `lookup_full_projection_cache:5154` / validator `14378` | Small persisted meta/key lookup and Arc snapshot; no deep prefix payload copy here |
| transform_execute | `lib.rs:10376–10389`; cached transform wrapper `transform.rs:2425–2498` | Whole umbrella; can include more than one attempt |
| handler_followup | `lib.rs:10390–10598` | Whole trigger path normally; potentially producer I/O/wait + extra transforms in emergency |
| trigger_ms | `lib.rs:6163–…`, `HistorianTriggerTimer`; boundary builder `17994–18051` | **Whole O(M+B)** even with cached token counts; conditional frozen-state load if pending drops exist (`6357–6363`) |
| trigger_boundary_build | `lib.rs:6283–6306`; `cached_boundary_messages:17994` | Whole B range index + M BoundaryMsgs/blocks. 22.7k token hits still require 22.7k lookups |
| trigger_eval | `lib.rs:6368–6412`; `boundary.rs:741` and protected/semantic boundary resolution | Whole candidate/arc/boundary traversal, with ordering/index work; not O(D) |
| trigger_cache_store | `lib.rs:6413–6421`; BoundaryTokenCache replace `3103–…` | Whole retained-map charge; removal can make Arc ownership unique, avoiding a deep clone, but counting/charging still walks the maps |
| post_attach | `lib.rs:10599–10742` | Mixed: whole cache/accounting loops plus small metadata writes |
| projection_cache_store | `lib.rs:10608–10618`; `store_projection_cache:5186–5228` | New message charges can be suffix-only; prefix charge Vec copy, projection retained-byte charge and sum remain whole |
| native_attach | `lib.rs:10638–10681`; incremental attachment `14756–15115` | Warm: sidecar suffix decoding but whole sidecar-position/ingress maps and served-key loops. Full ingress / untrusted prefix: whole native sidecar decode and hashing. Encoding is changed served suffix rounded back to a merge-chunk boundary |
| trace_complete / response_observation | `lib.rs:10682–10687` | O(1) rows / clock observation |
| retained_size / snapshot_store | `lib.rs:10692–10709` | Uses cached message/native charges when available; snapshot admission/eviction proportional to cache entries, not payload traversal again |
| response_encode | `lib.rs:15526–15616` | O(S bytes) output materialization; not removable if those bytes must be sent |
| response_meta_encode | `lib.rs:15535–15560` | Response metadata **and native full/delta arrays**, CK placeholder removed; can be large on native full fallback |
| response_size_account / response_splice | `lib.rs:15586–15606` | Sum canonical CK lengths / copy canonical CK bytes: O(S), O(S bytes). No need to re-serialize cached CK blocks |

### Transform and store stages

`transform.rs` is under `crates/mc-module/src/`; `store/lib.rs` and `cache_codec.rs`
below mean `crates/mc-store/src/lib.rs` and `crates/mc-store/src/cache_codec.rs`.

| Stage | Code / timing boundary | Work per pass now |
| --- | --- | --- |
| total | `transform.rs:3539–6808`, apply_once | Whole umbrella excluding handler preparation/followup/attachment |
| projection | `transform.rs:3545–3570`; projector `ck_wire.rs:373–406` | **Whole containers even when reused:** copy prefix flat blocks (Arc payloads), identity vectors, message metadata, frontiers, then project D. Cold: O(B bytes) serialization/hashing |
| seed_or_sync | `transform.rs:3697–3701`; store load_transform_snapshot `8617–8720` | Whole F/I/sections/A load. Name does not imply this is only host seeding |
| store_cache_state | store `8631–8656`; codec `458–497`, `decode_row:525` | Read all frozen chunks and sections, verify/decode them, hydrate row identities/served fingerprints. Whole F/I/section bytes each pass |
| store_tags | `transform.rs:3703–3706`; load_cached_tags `9363–9424` | Generation/summary validated cache exists already; warm Arc baseline is cheap, cold/repaired/reset/tag-append paths hydrate rows. Later consumers still walk T |
| store_temporal / store_user_hints / store_channel1 | store `8659–8712` | Whole A session rows, sorted; inside seed_or_sync, not additive sibling times |
| store_overlay_frontier | store `8713–…` | O(1) session scalar read; inside seed_or_sync |
| coverage_resolve | `transform.rs:3891–3894`; resolve_boundary_state `8880–8982` | Whole ingress/boundary checks in relevant branches; coordinate cache already avoids wide summary revalidation on a warm key |
| identity_enforce | `transform.rs:4158–4167`; enforce_block_identity `6927–7008` | Walk incoming identities against durable pins; whole current M/B. Frozen-target checks can scan F on drift paths |
| tag_overlay | `transform.rs:3864–3868`, `4192–4204`; tag mint `10472–10517` | **Whole T/F/B index and key preparation**, despite incremental tag-mint frontier and tokenizer filtering. Rebuild tag_number_by_message twice. Not the later overlay-map build |
| temporal | `transform.rs:10518–10649` | Whole T/A/M sets, timestamp/first-text derivation and frontier validation, even when only a suffix can mint decisions |
| planning | `transform.rs:4206–4962` | Small revision reads plus whole request/tag/protection/reduction inputs; selection may be tail-filtered, but building its inputs is not generally suffix-only |
| store_memories / store_notes | timed m1 revision signal during planning; `m1_compose.rs:231–254`, store load_m1_revision_snapshot | Revision-head/domain queries (project/workspace scope), not full frozen-session walks; full bodies are consumed on composition paths. The complete snapshot is attributed to store_memories; store_notes remains zero on this implementation, not a separately timed notes query |
| pending_drops | `transform.rs:4208–4214` | Pending queue rows for session + target set; O(pending), not all F |
| decide | scheduler at `transform.rs:4370–4407` + classifier around `4826–4902` | Small scalar/state decision after inputs are prepared; accumulated inside planning |
| selection | `transform.rs:4727–4795`, selection.rs | Eligible tail/block/tag input traversal when priced; zero/limited on ordinary defer. Surrounding candidate construction is in planning |
| transition_detection | `transform.rs:3747–3780`, `5999–6018`; renderer_transition_shapes | Whole projection/F classification. Second portion overlaps compose_m0m1/state_evolution |
| state_clone | `transform.rs:4963–4987` | Deep clone of core and meta: whole F/I and large sections. **Outside** state_evolution |
| state_evolution | `transform.rs:4988–6252` | **Whole session**: ingress pin checks, core step, post-transition scan, channel1 rebuild, overlay maps, hygiene. Composition/bust work is conditional; this stage is expensive even on defer |
| ingress_meta | `transform.rs:5046–5055`, apply_ingress_meta `7051–7094` | Whole identity map and newest block scan; only actual pin insertion/usage mutation is changed work |
| user_hint | `transform.rs:5132–5165`, maybe_decide_live_user_hint | Eligible newest authored user decision only; optional project-memory lexical query. Cached decisions prevent repeated query; determining eligibility can scan M |
| unit_mint / caveman | `transform.rs:5174–5195` | Bust-only chosen strip/caveman adoption; candidate computation is already in planning. Caveman age basis can scan T |
| compose_m0m1 | `transform.rs:5275–6041` | HARD/SOFT read/render relevant history/memory bodies, can be whole persisted history; on DEFER the timer still spans core.step and post-transition detection |
| compose subfields | `m0_compose.rs:364–369,420–421,548,561,586`, decay_render.rs / memory_render.rs: `decay_render_ms`, `tier_tokenize_ms`, `memory_render_ms`, `mural_ms`, `user_profile_ms` | Conditional composition; subspans, not ordinary replay siblings or evidence that per-pass tokenization is always expensive. tier_tokenize is nested inside decay_render |
| todo | capture inside state_evolution (`5264`, `5583`) + advance (`6057–6068`) | Conditional bust capture / tail-state advancement; accumulated in state_evolution, with one capture also inside compose_m0m1 |
| build_output | `transform.rs:6253–6587`; renderer `14892–15403` | Whole F/B/M preparation and indexes + served tail rendering/lookup; cached bytes eliminate much serialization, not index-building |
| build_frozen_unit_index | `transform.rs:14897–14904`, FrozenUnitIndex | Whole F rebuilt once per renderer invocation (already prevents F scans per served message) |
| blocks_by_mid / full_drop_tool_ids | `transform.rs:14962–15005` | Whole projection/arc walks + filtered output-mid index; full-drop lookup uses frozen index |
| build_tail_loop | `transform.rs:15046–15374` | Walk M to skip covered rows, process emitted S; not only D |
| build_identity / build_identity_max | `transform.rs:15088–15107`; message_output_identity | Hash relevant units, per-message projection identity and overlay/role/exemption state for each served message; max is the largest single-message sample, not an additive stage |
| build_frozen_unit_scan | `transform.rs:13944–13952` | Relevant units per served mid when indexed, not all F per mid; child of build_identity |
| build_cache_lookup / build_serialize_misses | `transform.rs:13998–14014`, `15109–…` | Lookup for S; canonical serialization only on missed/dirty output entries |
| finalize | `transform.rs:6596–6806` | **Whole F/I** scans/sets/comparison and conditional commit + output cache publication; divergence itself is served-array work |
| divergence | `transform.rs:6600–6604`; served_output_fingerprints `2558–2616` | O(S bytes) fingerprint generation/comparison, includes large m0/m1 bytes; not full ingress M |
| store_commit | `transform.rs:6705–6754`; store commit_transform `10536–…` | If needed, whole F/section serialization + row-state fingerprint I/S; changed-only SQL chunk/row writes **already exist**. A no-op pass may skip this stage's commit entirely |

`frozen_units_matched_to_tail` (`transform.rs:7862–7890`) is itself an O(M+F)
diagnostic count between build_output and finalize, not covered by either child
timer. There are therefore real unassigned gaps; a tree of named stage values is
not an exhaustive partition of CPU time. Numeric counters such as cache_hits,
tag_mint_new, native_cache_encoded_messages and retry_attempts are counts, not ms.

## 2. Why a single pass re-projects the entire session

### Measured observations supplied by ALF

- **ALF, 16:43:43Z:** 25.8 s reported pass; request_observed_to_handler 8.0 s,
  native_attach 6.0 s inside post_attach 6.2 s, projection 3.0 s,
  projection_projected_messages **7,578**, request_decode 1.5 s,
  state_evolution 2.75 s. Subsequent passes returned to about 1 s.
- **CEREB, 16:45:35Z:** projection_projected_messages **1,874** of 1,875 messages,
  native_attach 1.77 s, state_evolution 1.73 s, transform_execute 3.4 s.
  Previous pass 16:43:08Z projected 3; next 16:45:43Z projected 2.

### Code-supported answer: byte-budget LRU and validity fences, not a cache TTL

**Neither ProjectionCache nor NativeAttachmentCache has a time-expiry field or
idle timer.** The 2.5-minute gap is not an input to their snapshot/replace methods.
`cache_ttl` controls provider-prefix folding, not these in-memory caches.

The specific cross-session eviction mechanism is **byte-budget LRU admission**:

- Projection cache: **256 MiB shared total / 192 MiB per-entry cap**, constants
  `lib.rs:1450–1451`; admission and oldest-session removal at
  `lib.rs:3678–3708`. A rejected oversized entry is not newly installed; the
  method returns before removing its previous entry. Thus a size-rejected update
  can also leave a previous fingerprint that will no longer match.
- Native cache: **a separate** 256 MiB shared total / 192 MiB full-entry target,
  `lib.rs:3143–3144`; `evict_lru_for_core` at `3421–3438` is called by
  `replace:3490–3546`. All sessions served by the handler compete within each
  budget; projection and native are not one combined 256 MiB pool. Optional raw
  sidecar trees can be discarded (`3498–3523`) while preserving the delta core.
  A single oversized native core is retained honestly over budget (`3525–3529`)
  after evicting others; it is not rejected like an oversized projection entry.
- Raw request fallback snapshot: another **64 MiB** ready budget,
  `lib.rs:1445`, `TransformSnapshotCache::finish_ready:2760–2800`; oversized
  requests are not retained. This does **not** independently erase the dedicated
  projection/native caches, but can remove the fallback that would have rescued
  a prefix after their eviction.

Other exact invalidators matter; they are not “any store write”:

| Invalidator | Projection | Native attachment |
| --- | --- | --- |
| Persisted revert_epoch changes | snapshot removes session, `lib.rs:3660–3666`; delta reads epoch before trusting cached prefix `5014–5024` | snapshot / delta_native_prefix removes mismatched epoch `3446–3455`, `3466–3472` |
| Fingerprint missing/mismatch | full lookup requires fingerprint `5158`; validator rejects `14385–14387` | delta prefix requires previous fingerprint (`validated_native_prefix:14411–14424`); fallback also checks fingerprint `14793–14795` |
| Serializer/render context/profile epoch changes | validator rejects `14388–14390`, context fields `14363–14371` | context additionally includes transition_consumed, `14349–14359`; incompatible context makes reusable output prefix zero `14909–14923` |
| No trustworthy delta frontier | projection can still use a matching full fingerprint; otherwise full projection | trusted native prefix zero → full sidecar decode even if some *output* messages will hit (`native_sidecar:14426–14446`) |
| lineage_switched / invalid message frontier | transform filters out reuse `transform.rs:3552–3556`; projector missing pins falls back `ck_wire.rs:378–395` | invalid frontier/context results in native full fallback, `lib.rs:14789–14807` |
| Last route closes / process restarts | last-binding teardown explicitly removes cache `lib.rs:5240–5317` | same teardown; bind replacement also removes native state `4816–4861` |
| Recomp / reset / session delete | recomp's epoch subsequently invalidates projection; delete explicitly removes it | explicit removal on recomp `lib.rs:7911–7922` and session deletion |

The native cache's per-message key also includes served canonical identity,
sidecar hash, tag/reasoning-clear/exemption state and position. An early key
change forces re-encoding from the affected merge-chunk boundary
(`lib.rs:14847–14945`), not necessarily just the altered message. Native sidecar
work and native output encoding must be distinguished: a 6-second native_attach
span alone does not prove every served message missed.

On an ordinary full request with a **new** fingerprint, full projection lookup
asks for that new fingerprint against the *previous* snapshot (`5154–5173`). It
misses; native trusted-prefix validation has no delta frontier and decodes the
whole native ingress. After a successful full pass the new cores are installed,
so the next acknowledged delta is warm. `expand_transform_tail_delta` can return
NEED_FULL_SYNC for missing/epoch/context/fingerprint/frontier state; the plugin's
full retry builds new full fingerprints (`rust-mode-transform.ts:3640–3666`).
This explains the **one-cold-pass then warm** shape without any TTL.

**Incident attribution limit:** the supplied counters establish lost/unusable
projection reuse (CEREB still reused one message), not the eviction cause.
Byte-budget LRU competition is a concrete supported explanation; so are route
teardown, epoch change or a host full-sync/fingerprint change. There is no
per-pass projection miss-reason/eviction log in this code, and no preceding
native eviction, route or epoch event was supplied for either timestamp.
Consequently it would be false to assert that one particular LRU removal or
store write definitely occurred at those timestamps. The definite answer is
**not a projection/native cache time limit; shared byte-budget LRU and explicit
validity fences are the mechanisms to investigate**.

For decisive attribution, correlate the existing native log
`native-attachment-cache evicted ... reason=delta_core_admission` with those
timestamps. Add diagnostic-only projection admission/eviction/miss reason
counters, old/new epoch and context *digests*, route teardown reason, cache entry
charges and full-sync reason; never raw payloads. That instrumentation is proposed,
not deployed by this report. Inspect whether ALF/AFT/CEREB combined charges exceed
each independent budget before considering a budget increase. A budget increase
alone does not address the steady whole-session work or preserve a memory bound.

## 3. Ranked incremental designs

The following **estimates** price only ordinary warm passes using the supplied
rounded medians: state_evolution 500 ms, delta_expand 310, finalize 180,
store_commit 150, trigger 125, tag_overlay 100. Ranges deliberately do not imply
all measured time is avoidable. They are savings targets for future experiments,
not results. Any new cache must be bounded and fall back to the current path.

### 1 — Incremental hygiene and state indexes (largest steady CPU target)

**Estimated saving: 350–425 ms/pass from the 500 ms state_evolution envelope
(70–85% target). Risk: medium/high.**

The defer path calls `prune_channel1_units`, reconstructs channel1 rows and
overlay maps, then measures and refreshes hygiene over **all projection blocks**
(`transform.rs:6070–6178`). `tail_hygiene.rs:499–662` constructs tag/block/arc
indexes, reduction/caveman sets, excluded parts even for covered blocks, content
hashes, token measurements and a whole content signature. Refresh then computes
token buckets, compares the baseline prefix and clones it
(`tail_hygiene.rs:838–938`). “Delta” describes its arithmetic, not its cost.

Maintain a generation-scoped immutable measurement/index snapshot:

- Per-block measurement identity includes projected content hash/kind/ordinal,
  **effective** red/caveman payload, coverage, tag status/number, queued-drop and
  protection membership. Keep the baseline cut before the newest mutable message.
- A reverse index maps frozen units/overlay/tag/queue changes to mids and tool
  arcs. Dirty the changed suffix, its adjacent tool/role seam, protection-window
  crossings, newly covered range and affected queue members, not every block.
- Reuse unchanged excluded-part hashes and measurements, ordered prefix segments,
  token buckets and signature segments. Preserve the baseline generation and
  compared_field mismatch semantics; replacing the signature with an unrelated
  aggregate is not automatically equivalent.
- Maintain key/type/mid/arc indexes of frozen units, channel1 candidates and live
  message ordinals once per frozen/projection generation. Reuse them in evolution,
  renderer and finalize. Immutable Arc-backed sections avoid deep state clones;
  mutation must be copy-on-write and abort-safe.

**Safety:** keyed by store namespace, session, validated sections generation,
revert epoch, ordered projection fingerprint/frontier, calibration, coverage and
protection/queue/overlay revisions. A generation hit does not authorize a new
overlay or reduction: all current bust gates still apply. Protection exit and
queue changes must adjust U exactly even if content is unchanged; don't cache
solely on message bytes. Unknown identity, middle rewrite, prefix contraction,
reset or corruption falls back to full measurement. Differential tests must
compare baseline parts/signature/U/T/mismatch fields and resulting channel1/2
wire directives, not just totals.

### 2 — Stop re-materializing an acknowledged full ingress prefix

**Estimated saving: 250–280 ms/pass from delta_expand's 310 ms (80–90% target).
Risk: high, broad representation change.**

`reattach_messages_prefix` clones CK blocks and metadata
(`ck_wire.rs:129–169`), then `expand_transform_tail_delta` clones every native
prefix JSON tree (`lib.rs:5115–5120`), after already obtaining Arc prefix owners.
Use an immutable segmented request view: retained prefix + owned changed suffix,
with borrowed iteration/random access. Arc-backed native Values remain shared.
Compute the suffix projection and extend persistent/range indexes; retain complete
history access for coverage, lineage, reasoning and tool-arc consumers.

Do not simply pass only the 74 served messages into apply_once. Many guards need
covered/history context. The public request/response JSON schema can remain
identical; the internal `Vec` ownership model changes. Full-sync fallback must
remain available for missing/untrusted cores.

**Safety:** preserve all current after-fingerprint, context, epoch, length and
frontier checks before borrowing any prefix. Prefix state must be immutable until
the pass commits; a rejected attempt cannot mutate the prior snapshot. Retain
message order, original unknown JSON/provider metadata, tool-call state at the
prefix/suffix seam, newest signed-reasoning exemption and retained-byte accounting.
Compare full projection differential bytes and reconstructed full native wire
against an owned full request for the same inputs. Cold full requests still cost
O(M bytes); this proposal addresses ordinary admitted deltas, not all cold events.

### 3 — Serialize/hash only changed cache chunks and row collections

**Estimated saving: 90–125 ms/pass from store_commit's 150 ms (60–83% target).
It is already part of finalize's 180 ms. Risk: medium/high persistence/CAS risk.**

Migration 63 **already** writes only changed frozen chunks/sections. The remaining
cost is preparing the diff: `commit_transform` calls `encode_row` and
`row_state_fingerprint` before the transaction (`store/lib.rs:10599–10601`);
`cache_codec.rs:726–745` serializes/hashes every 64-unit chunk and the full meta;
`store/lib.rs:16577–16610` walks all identity and served fingerprint entries.
SQL write volume is not a proxy for that work.

Pass explicit dirty chunk/section and inserted/re-adopted/deleted identity ranges
with a verified base. Reuse exact encoded bodies/digests of immutable unchanged
chunks. Meta-only writes must not cause re-encoding F. Patch the rows that actually
changed rather than recomputing the combined identity+served fingerprint from I.
If the existing digest format is retained, cache its exact prepared representation;
an incremental replacement digest requires separately priced format migration and
must not masquerade as the old value.

**Safety:** retain row_version CAS, sections sv CAS, loaded-base/meta-only-step
checks (`store/lib.rs:10589–10597`, `10666–10672`), explicit frozen-clear refusal,
unhydrated identity refusal and atomic overlay/pending-drop writes. Publish cached
encoded bodies only after accepted commit; rollback/CAS retry discards tentative
versions. Unknown writer, schema change, bad section digest or repair uses full
codec validation/rewrite. Don't substitute pointer identity for a validated base.

### 4 — Index the residual finalize work, without weakening divergence

**Estimated incremental saving: 15–25 ms/pass of the ~30 ms residual envelope.
Together with #3, target 105–150 ms of finalize's 180 ms, not 180+150.
Risk: medium.**

Finalize builds frozen-red sets twice, selects/clones all reasoning-clear units,
retains away legacy units and compares complete core/meta
(`transform.rs:6662–6696`). Keep generation-scoped red/reasoning-clear indexes and
explicit mutation flags/deltas. Preserve output construction before commit and
unchanged pure-defer no-write behavior. Reuse each ServedMessage's canonical block
fingerprints where the message identity is unchanged; update ordered served
fingerprints only for changed positions and the merge/role seam.

**Safety:** retain *first* divergence ordering, serialized lengths, pinned m0/m1
baseline behavior on an unpriced divergence, drop-consumption/first-command
semantics and the old state equality result. A dirty flag missing one meta writer
would incorrectly skip a commit; test all mutations against old equality. An
unchanged ingress fingerprint alone is insufficient when overlays/epochs change.
The divergent-pass trace and directives must agree as well as served bytes.

### 5 — Incremental tag-number and overlay indexes

**Estimated saving: 60–85 ms/pass of tag_overlay's 100 ms (60–85% target).
Risk: medium.**

Reuse tag_by_block_id, tag_number_by_message and resolved candidate membership by
validated tag generation. Append the pass's new rows to these indexes once, not
build the message map twice. The tag baseline cache and mint-frontier memo already
exist; optimize the still-whole `existing_tag_ids`, frozen-target keys, candidate
counting and related lookups (`transform.rs:10472–10517`, `9464–9660`). Keep a
per-projection candidate prefix count and exact frontier/context identity.
The later overlay-map construction is inside state_evolution and belongs to #1,
not another additive saving here.

**Safety:** include store namespace, validated tag count/max/generation and
mutable-row generation (drop/reset/repair), frozen-target generation and
mutation-exempt/lineage mids. Preserve tag numbering and candidate counts, source
bytes/token counts, first-sight temporal decisions and pending overlays on already
served blocks. Tentative minted rows are private until CAS; do not make a rejected
pass's memo authoritative. Test direct SQL tag repair, reset/remint, interleaved
sessions, inactive/active surface transitions and restored earlier ordinals.

### 6 — Incremental historian boundary messages and aggregates

**Estimated saving: 50–95 ms/pass of trigger's 125 ms (40–76% target), including
35–45 ms of the 50 ms boundary-build child. Risk: medium/high policy risk.**

Cache ordered immutable BoundaryMsgs/arc membership and prefix token aggregates
against the validated projection identity. Replace D plus seam-crossing arcs;
maintain the message block-range index instead of reconstructing it at
`lib.rs:18004–18042`. Share the unchanged token-map core and charge/update only
changed entries. Re-evaluate cheap trigger policy every pass with fresh usage,
historian state, publication/boundary/protected-floor, pending-drop and cooldown
inputs. Incremental evaluation must reproduce complete semantic/commit-cluster
and protected-boundary decisions, not merely token totals.

**Safety:** cached data is only a derived index, never authority to fire or skip a
historian. Covered history can be summarized by exact aggregates, but cannot be
blindly removed if it influences arc fencing, semantic snap or commit-cluster
classification. Validate range endpoints and retained crossing arcs; a middle
rewrite, coverage/revert move or dynamic queue change invalidates affected ranges.
Compare trigger decision/reason/progress/chunk bounds to the full path and keep
its durable no-fire records/firing CAS behavior.

### 7 — Persisted-generation decode/clone reuse (follow-on, not first experiment)

**Estimated saving: 40–60 ms of seed_or_sync's 71 ms, plus unpriced state_clone
savings. Risk: high until repair/corruption invalidation is proved.**

Cache immutable decoded chunks/sections by store namespace/session, section sv
and digests, row-state collection generation, schema/build and revert epoch.
Metadata-only row_version bumps should not invalidate frozen chunks. Current
`cache_codec::read_sections` reads all chunk bodies on every pass before decode.

**Safety boundary:** persisted row_version/sv alone does not prove raw body bytes
have not changed through direct SQL repair. Use an observer connection's
`PRAGMA data_version`/file generation as a conservative external-write fence,
and invalidate on every own-connection repair/import/reset that can bypass the
versioned writer. A changed/unknown token requires full verification. This fence
may over-invalidate under unrelated writers; never hide that with a timeout cache.
Silent filesystem corruption without a SQLite generation change cannot be
excluded by data_version. If parity with current per-pass corruption detection
cannot be established under the supported storage threat model, **retain the
verification read** and only cache parsing/index construction. Existing
same-length repair and corrupt-chunk tests must keep forcing the same rebuild.

### Ordering and aggregate expectations

Start with diagnostic miss attribution and subspans, then #1, #3/#4 and #5 as
independent measured experiments. #2 has a large latency target but touches many
consumers; stage it behind a full-view reference implementation. #6 needs policy
goldens, not only perf counters. #7 comes last because reducing validation is a
correctness change unless its generation fence is complete.

The **estimated** combined targets for #1, #3/#4 and #5 are 515–660 ms within
transform_execute, before shared-index overlap, invalidation overhead and output
lower bounds. #2's 250–280 ms is preparation, #6's 50–95 ms is followup. These are
not additive measured RPC savings or a promise of a particular final latency.
Full-sync cold spikes remain a separate admission/working-set problem. Making
logical computation O(changed) does not make sending provider-visible S bytes
O(changed) when the wire contract still requires a full served array.

## 4. Byte-identity proof required before any cache-path merge

For each proposal, baseline and candidate must receive identical request sequences,
persisted starting state, clock evidence, config/epochs, and producer publications.
Measure with debug differentials **off**; run separate parity passes with them on.

1. Run `packages/e2e-tests/scripts/pure-replay-differential.ts <base-ref> <candidate-ref>`
   without `--ts-only` for the Rust lane. It compares defer provider message bytes,
   system and tools (`:471–480`), but its ordinary four-defer fixture alone is not
   enough for all bust/repair cases. Future scratch/XDG inputs must obey the same
   copy-only isolation; never invoke an unreviewed live-store replay setup.
2. Add/reference byte tests comparing **complete serialized CK and assembled
   native/provider arrays**, not just decoded structs or expected values derived
   from the optimized cache key. Preserve unknown fields, JSON numeric/key bytes,
   signed/reasoning blocks, tag/temporal/user/channel hints, m0/m1, synthetic todo,
   role merges and tools. Output deltas must be assembled before comparing to full
   output; comparing `native_messages: null` placeholders is vacuous.
3. Compare cached and uncached paths at every pass: unchanged defer, append,
   streaming last assistant, middle rewrite/contraction/revert, dropped/reminted
   tags, protection crossing, queued/consumed drops, changed coverage, hard/soft
   fold, renderer epoch, legacy adoption, single-store repair, restart, cross-session
   interleaving, cache degradation/refusal/eviction, CAS conflict and corruption.
   Verify durable state/decisions as well as bytes so a hidden stale index cannot
   fail only on a later pass.
4. Existing reference gates include
   `indexed_temporal_overlays_match_scanning_reference`,
   `serialized_output_cache_reuses_steady_state_and_matches_fresh_bytes`,
   `same_length_sql_repair_without_mutation_log_reloads_the_next_managed_pass`,
   `corrupt_chunk_forces_hard_and_full_rewrite`, native-cache full/incremental
   tests in `lib.rs`, and tail-hygiene parity goldens. Keep independent scanning
   references; don't compute both sides from the same cached digest.
5. For future silent guards/invalidation tests, perform a staged, restored
   NON-VACUITY BREAK that removes one relevant fence/index delta. Require the
   named parity/repair test to fail and unrelated controls to remain green.
   **No mutation proof was run in this report-only, build-blocked investigation.**

## 5. Reproducible release profiling harness (not yet run)

Files:

- `crates/mc-module/src/tests/per_pass_cost.rs`: ignored current-thread Tokio test,
  drives the real in-process handler (including trigger and native attachment).
- `crates/mc-module/src/per_pass_profile.rs`: opt-in thread-local inclusive spans
  using `cpu_time::ThreadTime`; `cpu-time` 1.0.0 is **dev-only**. An active profile
  cannot migrate across worker threads. Production builds compile out every span.
- Clock anchors next to existing handler/transform timers; additional evolution
  subspans separate channel1 prune, overlay maps and hygiene. The clocks do not
  alter the cache decisions. Child stages overlap their parents.

The backups do **not** contain full captured native requests. This harness
reconstructs the last requested number of identities using absolute ordinals and
roles from context message_history_source, block kinds from store identities, and
text lengths from stored tag sources. Text is filler, tool inputs are simplified,
unmatched cross-message calls/results are repaired in the fixture, and native
messages are synthesized with the module's codec. It preserves original IDs and
the original historical frozen-unit vector/overlays in a writable clone. After a
render-normalization pass it reinstates those historical units with normalized
m0/m1 frames, so a bootstrap prune cannot erase the very state scale being
profiled. This is a **controlled scale experiment**, not exact continuation of the
live session or proof of its wire bytes. Larger historic I may also be replaced
by the reconstructed request's identity pins; log both domains on a real run.
The copied historian state is made idle and the host model chain is empty to
prevent reattachment/production tasks racing this offline experiment. Trigger
boundary construction and policy evaluation still run; producer model time is
not part of this experiment.

Default sessions/shape caps:

| Session | Requested persisted messages | Observed original F (backup SQL only) |
| --- | ---: | ---: |
| ALF `ses_227ce5788ffeRPA9THoPLOQreO` | 7500 | 34837 |
| CEREB `ses_0758f6ce7ffeJ0A9sV8Qvema7d` | 1875 | 12096 |
| Small `ses_f6f7af30bffeayPgWk5XJtq5YW` | 568 | 876 |

Each appends one provisional assistant. Every pass changes only that assistant,
with a two-message transport suffix. Configurations: `warm_delta`, `warm_full`
(full request/new fingerprint, existing output caches), `evicted_full`
(explicitly discard just this experiment handler's projection/native cores
before each full request). Three warmups then **20 samples/config/session**:
180 measured passes planned. Assert measured passes are SOFT+; do not silently
mix repair/HARD passes into medians. Compare canonical serialized complete CK
and reconstructed native arrays across all three configurations for each numbered
sample. This comparison is not a substitute for the raw-wire differential above.

`COST_RUN` prints uptime/load, message/F counts; `COST_SAMPLE` prints inclusive
stage wall and **thread CPU** ms, normal stage counters and a canonical-array
digest; `COST_SUMMARY` prints stage n, separate medians and max wall. Input fixture
assembly, output comparison, backup copying and normalization are outside stage
spans. Current source is formatter-checked but **not compiler- or run-verified**;
first successful run must validate fixture normalization, cache admission and all
180 parity checks before trusting any numbers. The clock calibration unit test
must run first.

### Recreate copies and run after dependency alignment

Run in an isolated worktree with aligned sibling Rust crates; all opens except
the explicitly read-only SQLite backup sources are inside the scratch tree.
No source WAL/SHM copying, no live migrations, no config reads and no write-back:

```sh
# Each backup target must be absent; a timeout's partial target is not usable.
timeout 10 sh -c 'umask 077; mkdir -p "$TMPDIR/magic-context/ckmc-perf/backups"'
timeout 600 sh -c '
  set -eu
  root="$TMPDIR/magic-context/ckmc-perf/backups"
  test ! -e "$root/context.db" && test ! -e "$root/store.db"
  sqlite3 -readonly "$HOME/.local/share/cortexkit/magic-context/context.db" \
    ".backup \"$root/context.db\""
  sqlite3 -readonly "$HOME/.local/share/cortexkit/magic-context/store.db" \
    ".backup \"$root/store.db\""
  chmod 400 "$root/context.db" "$root/store.db"
'
# The baseline lockfile in this delivery assumes the original sibling versions.
# Align/absorb the protocol/tool-provider dependency fix first; don't patch around
# the type mismatch or bypass the machine's shared compiler-slot limiter.
timeout 120 cargo fetch --locked
timeout 2400 cargo test --release --locked -j 2 -p mc-module --lib \
  thread_cpu_clock_records_work_and_stays_opt_in -- --nocapture
timeout 2400 cargo test --release --locked -j 2 -p mc-module --lib \
  copied_sessions_per_pass_cost -- --ignored --nocapture --test-threads=1 \
  > "$TMPDIR/magic-context/ckmc-perf/profile.log" 2>&1
```

The test canonicalizes/guards its scratch paths, reads only immutable backups,
and copies them into throwaway writable scratch directories before McStore opens
or migrates anything. Only the clones reset the writer fence and content identity
pins. On macOS clone copying uses `cp -c` on the **backups**, not the live files.
The test's temporary directories clean up on ordinary exit; inspect scratch after
an external timeout, which can bypass Rust Drop. Protect logs with umask 077 and
never commit private captures, DBs, WALs or outputs.

Optional overrides, still requiring >=20 samples:

```sh
MC_PER_PASS_SESSIONS='ses_227ce5788ffeRPA9THoPLOQreO:7500,ses_0758f6ce7ffeJ0A9sV8Qvema7d:1875,ses_f6f7af30bffeayPgWk5XJtq5YW:568' \
MC_PER_PASS_SAMPLES=30 timeout 2400 cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
-- --ignored --nocapture --test-threads=1
```

### Verification of this partial delivery

- `timeout 120 cargo fetch` installed the new dev-only cpu-time 1.0.0 dependency.
  A later offline fetch resolved then-current sibling versions for the attempted
  build; those unrelated lockfile resolutions were removed from the delivery.
- `timeout 60 cargo fmt --all --check` and `git diff --check` passed after final
  formatting (rustfmt 1.10.0-stable, rustc/cargo 1.99.0). Formatting is a syntax
  gate, **not** typechecking or a profiling run.
- Scoped AFT diagnostics were incomplete: Rust could not obtain locked Cargo
  metadata against the advanced sibling checkout. No clean Rust diagnostics
  claim is made.
- Release clock/test compilation and the 180-pass profile are **blocked/skipped**
  for the shared-slot/dependency conditions above; no test ran. Stop retrying until
  the dependency alignment is absorbed. Pure replay differential was not run:
  there is no cache-path candidate here and the release prerequisite is blocked.

Do not call load-tagged wall medians quiet. Record each configuration's uptime
line and use thread CPU to distinguish descheduling/SQLite waits. CPU is still
affected by frequency/cache pressure; repeat in reverse session order on a quiet
host later. Plot CPU against **B/F/I/T and request bytes**, not only M, since real
sessions vary in all those dimensions. A stronger matched-size experiment varies
the reconstruction cap on one fixed persisted session (e.g. 500/2000/7500) to
separate projection size from its fixed F/T cost. No such scaling result is
available yet.

After recording only non-private statistics, remove the completed/partial
backups and any abandoned `run-*` directories **under this exact scratch root**.
Do not remove or clean up the task worktree. A `.backup` failure must be diagnosed
and its partial target deleted before a fresh-destination retry.
