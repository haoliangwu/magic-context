# CEREB Rust planning growth, 2026-09-28

## Finding and scope

The clear local cause is **repeated token estimation of untagged image carriers**, not growth in frozen units or a held-drop × history join. `sel_item_from_flat` built `served_token_count` for every live-tail block, including Media and Opaque. Missing a persisted tag fell through to `mc_tokenizer::estimate_tokens(&block.bytes)`. `FlatBlock.bytes` is serialized CK JSON (`ck_wire::flatten_block`), so this includes the entire image data URL. This happened even when the selection producer gate was closed and the scheduler deferred.

CEREB accumulated six PNG carriers with **3,624,692 bytes of data URLs** between 17:43:54 and 17:52:41 UTC. They were not tag-token-cache hits. A fold removes old messages from the live tail, so the cost disappears without a material change in the frozen-unit population. Pending drops and historian publications explain why material remains resident, but are not the expensive inner operation.

This is a correction to the browser-output hypothesis: the queried OpenCode session has **zero `part` rows whose tool is `browser_use`**. The decisive arrivals are standalone `file` parts (`image/png`, `data:image/png;base64,...`), not newly arriving multi-megabyte DOM text outputs. This does not rule out a browser as the external origin of screenshots, or deleted historical rows; it identifies the carriers actually present in the store.

Only the unused selection estimate is removed. No scheduler, coverage policy, renderer, migration, plugin timeout, tag cache, or tokenizer cache policy is changed. The parent explicitly authorized separate one-line Cargo.lock refreshes from subc-client-rs 0.21.0 to the supplied sibling's 0.22.0 and, after another sibling release during verification, subc-core 0.20.40 to 0.20.41.

## What planning measures

In `crates/mc-module/src/transform.rs`, `planning_started_at` starts immediately before `load_pending_agent_drops`; `timings.planning` ends immediately before cloning core state. The interval includes:

- pending-drop hydration and target-set construction;
- m1 revision signals, boundary-divergence checks, scheduler/classifier decisions;
- conditional HARD composition for marker/cache-bust pricing;
- persisted token lookup construction, **live-tail selection item construction**, todo pending detection and protection-window construction;
- gated reduction selection, monotonicity/reduction-pending checks, caveman/strip planning and materialization-reason classification.

Selection item construction is outside the producer gate. Its work scales with live-tail blocks, tool input cloning and the bytes of **untagged** blocks, not just block count. The fallback BPE also has content-dependent cost. `tail_sel_items` uses applied `coverage_ordinal`, not the newest historian publication's end. Covered-but-unfolded media therefore remains exposed. There are set-building scans over frozen/live/pending populations; no held-drop cross-product is needed to explain the observed slow defers. The selection timer was 0.0 ms on the decisive slow passes.

## Read-only evidence

Sources were the OpenCode MC log and its available rotations under `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context`, plus SQLite connections opened with `sqlite3 -readonly` or Python `file:...?mode=ro` to:

- `~/.local/share/cortexkit/magic-context/store.db`
- `~/.local/share/opencode/opencode.db`

No live store was written; no daemon was restarted. Raw image URLs were exported only to a local `/tmp/cereb-media-urls.json` for measurement, not committed. Stores are current-state evidence, not an exact pre-timeout snapshot.

### Actual image arrivals

| UTC | OpenCode part | URL bytes | Cumulative URL bytes |
|---|---|---:|---:|
| 17:43:54 | `prt_0e91db341002qPJBTypGYDDg7a` | 528,986 | 528,986 |
| 17:44:32 | `prt_0e91e2a47002DUbuSvFYilCE8P` | 378,546 | 907,532 |
| 17:46:47 | `prt_0e9205aa9002A8yDWG810dVxkw` | 521,426 | 1,428,958 |
| 17:52:40 | `prt_0e925b613002RSXiTeRwH80sx3` | 593,206 | 2,022,164 |
| 17:52:41 | `prt_0e925b6130030PJ1IHEqw6Cmot` | 824,314 | 2,846,478 |
| 17:52:41 | `prt_0e925b613004vIYvkCOXzNevpX` | 778,214 | 3,624,692 |

The six full part JSON rows total 3,625,152 bytes. Their four owning messages have persisted `mc_tags` only for `#0` text, with source lengths **31, 0, 179, 777** bytes and token counts **7, 0, 44, 187**. The images themselves have no persisted tag counts. Current CEREB tags consist of message and tool_result rows, not media rows.

Representative independently extracted full stage records:

| UTC | Planning ms | Pending drops ms | Selection ms | State evolution ms | Transform execute ms |
|---|---:|---:|---:|---:|---:|
| 17:38:17 | 216.9 | 0.2 | 0.0 | 114.8 | 1,166.6 |
| 17:38:40 | **10.8** | 3.7 | 0.0 | 612.8 | 1,710.6 |
| 17:58:49 | 5,017.9 | 0.2 | 0.0 | 1,138.1 | 6,784.4 |
| 18:01:48 | 3,121.2 | 0.2 | 0.0 | 557.0 | 3,847.3 |
| 18:23:08 fold | 2,794.2 | 0.0 | 4.4 | 1,060.1 | 5,132.8 |

The 17:38 pair matters: the growth is not a smooth 400× law. Scheduling load and cache contention introduce substantial variation. The supplied 17:30 baseline was 7.7 ms with 7,104 frozen units; 18:01 had 7,210. The post-image seconds-scale cost is consistent with bytes, while the 17:38 excursion alone is not evidence of monotonic history growth.

Persisted compartment rows independently show new publications while the old tail was still served: sequence 218 ends at ordinal 20857 (created 17:53:12), 219 at 20917 (17:58:17), 220 at 20986 (18:00:05), 221 at 21073 (18:03:05), 222 at 21152 (18:05:24), and 223 at 21164 (18:22:56). Creation times are not historian completion times. The daemon log `~/.local/share/cortexkit/magic-context/logs/magic-context.2026-09-28.log` independently confirms `pending drops held ... scheduler=Execute historian_active=true` at 18:03:30.047 and historian completion at 18:06:52.206 (row_version 7361). These explain deferred application; they are not measurements of the tokenizer itself.

The later current-state read found row_version 7408, 7,155 frozen units, applied coverage 21152, folded compartment sequence 221 and one pending drop. It cannot reconstruct the queue length at 18:01, nor establish which timed-out request committed. Do not mistake this for a pre-fold snapshot.

### Replay of actual payload bytes

The ignored diagnostic test `transform::tests::planning_carrier_live_payload_timing` accepts a JSON array of data URLs through `CEREB_MEDIA_FIXTURE`. It projects those URLs into CK media blocks and compares the previous unconditional estimate with the fixed selection-item conversion. It does not send traffic to the live module.

A debug-build run on the shared loaded machine produced:

| Carriers | Projected carrier bytes | Legacy estimate ms | Fixed conversion ms |
|---:|---:|---:|---:|
| 0 | 0 | 0.005 | 0.000 |
| 1 | 529,071 | 4,200.448 | 0.029 |
| 2 | 907,702 | 1,918.869 | 0.007 |
| 3 | 1,429,213 | 2,418.768 | 0.011 |
| 4 | 2,022,504 | 2,429.136 | 0.015 |
| 5 | 2,846,903 | 4,477.517 | 0.008 |
| 6 | 3,625,202 | 4,312.339 | 0.013 |

This is mechanism isolation, not an exact replay of the lost historical request/store pair and not a release benchmark. The first estimate includes cold tokenizer initialization, later rows mix cached and new inputs, and machine load varies. Consequently these timings are not a linear regression. They do demonstrate the costly operation on the actual image bytes, its cumulative multi-megabyte input, and its removal. The deterministic cost pin, rather than wall-clock thresholds, is the regression gate.

## Fix and cache neutrality

`sel_item_from_flat` now leaves `served_token_count` absent for Media/Opaque. All existing consumers support this:

- calibrated `selection::active_floor_tokens` explicitly excludes both kinds;
- uncalibrated floor accounting uses `byte_size`, not this field;
- emergency before/after reclaim estimates filter to ToolCall/ToolResult;
- Media/Opaque cannot be reduction targets.

The block, its byte_size, persisted token_count, arc identity and provider output are untouched. Text/tool/reasoning estimation and persisted tag lookup remain unchanged. The injectable estimator helper is the production conversion path, not a proxy model.

Tests:

- `planning_carrier_tokenization_cost_is_bounded`: zero fallback estimator calls with 1 and 64 unfolded image/opaque pairs, image payloads growing from 64 to 65,536 bytes (4 MiB total at the larger size), with tagged text beside them. It went red before the fix. The post-fix controlled mutation restoring unconditional estimation failed this test alone: `left: 2, right: 0` at the first pair.
- `planning_text_still_estimates_and_respects_tags`: untagged prose still invokes the estimator once, and a stored tag count bypasses it.
- `planning_carrier_replay_bytes`: a real temporary-store transform bootstrap and two replay passes pin serialized CK response bytes to the **pre-fix** SHA-256 `116dd7f9afc3d7bef3de4f2520945161fa244ecb7e4134f5bc1187e377668083`. Actions remain HARD, SOFT+, SOFT+. The byte test stayed green when the cost optimization was neutralized. This is a synthetic pass with an image, not a claim to have reconstructed the historical CEREB native request. It proves byte identity for the exercised replay; source-level consumer analysis supports neutrality on selection classes beyond that fixture.

## Why the recovery fold took 10.6 seconds

At 18:23:08, `module=10602.2 ms`, outer elapsed was 12,736.6 ms and transport 12,173.6 ms. Input/output message counts changed **556 → 75**. Useful breakdown (nested timers must not be added twice):

- Transform execution: **5,132.8 ms**. Planning was **2,794.2 ms**, state evolution **1,060.1 ms**, output construction **704.3 ms**; composition was **650.0 ms** within the broader work.
- Handler follow-up: **4,481.9 ms**, dominated by **trigger_boundary_build=4402.5 ms**. There were **0 trigger token-cache hits and 1,714 tokenized blocks**.
- Post-attachment: **932.2 ms**, including native attachment **923.4 ms**, 74 encoded messages, zero native reuse, three evictions and one degraded store.
- Projection was **276.7 ms**, with 555 projected messages and zero reused messages; it is nested within transform preparation/work, not an extra additive bill.

Thus the fold pays both the old planning fallback and a cold trigger boundary build. In `lib.rs::cached_boundary_messages`, every non-synthetic block is passed to `BoundaryTokenCacheSnapshot::token_count`, including media/opaque. This is another raw-carrier tokenizer entry point. Unlike selection's unused field, boundary token counts participate in coverage/trigger budgeting, so substituting zero is **not** proven cache-neutral and is not changed here. A separate media-aware boundary-accounting/caching investigation should measure it; the logged aggregate cannot assign all 4.4 seconds to images alone.

There is also raw-block estimation in `transform::protected_tail_floor_ordinal`. Its caller requires an already initialized HARD/MigrateHard pass with coverage but no frozen publication floor. It is not eligible on the logged SOFT coverage-fold or ordinary defers, so it does not explain this event; it remains a possible one-time HARD cost. State evolution also estimates frozen m0 payloads and composed m1 text, which is summary work rather than the six raw image carriers.

Native encoding is different: `attach_native_messages_incremental` / the codec encoders serialize provider-native values and preserve sidecar fields. No corresponding BPE call was found in that path. On a cold fold, re-encoding changed output and retaining source bytes is real work. The supplied degraded-store charge `47,092,580` is a retained cache-accounting number, not evidence that 47 MB was tokenized. The actual fold's daemon record at 18:23:07.322 has `requested_byte_charge=53428779`, `stored_byte_charge=22872123`, `dropped_sidecar_trees=true`, `delta_core_preserved=true`. Do not turn off fidelity-preserving re-encoding to improve this timer.

### Related copy costs (reported, not fixed)

The external audit's two findings are real in this checkout:

1. `append_tag_mint_rows(Arc::make_mut(tag_rows), ...)` clones a shared cached row vector even with no new inputs; `tag_rows_for_hygiene` clones surviving `McTagRow`s again. CEREB's currently retained rows created before 17:30 contain **6,875,749 source bytes across 5,837 rows**; before 18:03, **7,013,333 bytes across 5,935 rows**, max row **51,478 bytes**. That is about 2% byte growth, not 400×. The six new image carriers are **not** in those source bytes; their owning text tags total only 987 bytes. These copies contribute allocation/load to tag-overlay/hygiene/state work, but do not explain image-linked planning growth. The tag copy paths are outside the measured planning interval. Historical deletion could affect the retrospective population; these are current surviving rows filtered by creation time.
2. `mc-tokenizer::HistoryCounts::count` updates its LRU age map with `text.to_owned()` even on a count hit. Selection's repeated image estimate therefore has a real byte-proportional allocation cost even when BPE itself hits the process-wide history cache. The 3.6 MB is spread across six inputs, not one string. The 8 MiB history-cache budget, other sessions' traffic, and `try_lock` fallback to uncached BPE mean a hit is not guaranteed. The local fix removes both this hit-copy and any miss BPE for selection carriers. The same cache behavior can still affect boundary or other estimator callers. No historical cache-hit trace exists to split the observed planning milliseconds between copying, BPE and scheduling delay.

## Other sessions exposed

Every Rust serializer profile building live selection items is exposed when untagged Media/Opaque remains beyond applied coverage, even on defer. Frozen-unit count is a poor risk metric. There is no magic byte threshold, but this machine already showed seconds-scale work at roughly 0.5–3.6 MB of new image carriers.

Indexed read-only queries of the two comparison sessions found these **same-day file-part JSON** populations:

| Session | Parts created 2026-09-28 | Total bytes | Largest part |
|---|---:|---:|---:|
| CEREB `ses_0758f6ce7ffeJ0A9sV8Qvema7d` | 6 | 3,625,152 | 824,412 |
| ALF `ses_227ce5788ffeRPA9THoPLOQreO` | 12 | 5,194,024 | 1,346,024 |
| AFT `ses_313660571ffeZTsf4koSJwk50Q` | 6 | 3,348,504 | 1,147,980 |

CEREB's lifetime file-part total is 7,780,384 bytes (12 parts); ALF's is 158,913,633 (248). These are exposure inventories, **not assertions that all those parts are currently in the live tail**, nor that all peer file parts are PNG. Different applied coverage explains why larger sessions need not show CEREB's same growth. The observed 20k–27k frozen units in peers do not measure this workload. A fleet-wide unindexed part scan was abandoned after a timeout; no claim of a complete fleet census is made.

## Deadline recommendation to the plugin owner

Recommend a **60-second module request deadline for execute/fold/recovery or uncertain full-wire requests**, while retaining **15 seconds for positively known ordinary defer** requests after this fix. Do not shorten defer to 2 seconds: the 18:01 defer had module time 4.22 s but outer elapsed 13.50 s, and the 17:38:40 defer had module 2.76 s but outer elapsed 13.70 s. Queue/transport wait is material and a module-only timer understates the request budget.

The successful fold used 10.60 s inside the module and 12.74 s end-to-end; the supplied three 15-second timeout observations show that 15 s is an unsafe recovery ceiling under the reported load. Sixty seconds is a conservative operational recommendation (about 4.7× this successful end-to-end fold), **not a measured p99 or a guarantee**. Thirty seconds would supply only about 2.4× headroom and has not been validated under the same load. Record separate queue/request-to-handler, transform and follow-up histograms before tuning down. If the plugin cannot know the server's classification before dispatch, use the longer budget for requests that may fold rather than attempting to recover only after a short deadline has expired. Keep deadlines finite and distinguish waiting from cancellation; avoid assuming a timeout means the module did not commit.

## Reproduction and verification

The targeted SQL can be reproduced with `sqlite3 -readonly` (replace `$SID` with the session above):

```sql
SELECT id, message_id, datetime(time_created/1000,'unixepoch'),
       json_extract(data,'$.mime'), length(json_extract(data,'$.url'))
FROM part
WHERE session_id='$SID' AND json_extract(data,'$.type')='file'
  AND time_created BETWEEN unixepoch('2026-09-28 17:30')*1000
                       AND unixepoch('2026-09-28 18:03')*1000
ORDER BY time_created;

SELECT kind, count(*), sum(length(source_bytes)), max(length(source_bytes))
FROM mc_tags WHERE session_id='$SID' GROUP BY kind;

SELECT sequence, start_message, end_message,
       datetime(created_at/1000,'unixepoch')
FROM mc_compartments WHERE session_id='$SID' ORDER BY sequence DESC LIMIT 12;
```

The opt-in measurement command is:

```sh
CEREB_MEDIA_FIXTURE=/tmp/cereb-media-urls.json \
  cargo test --locked -p mc-module --lib planning_carrier_live_payload_timing -- --ignored --nocapture
```

Normal regression tests do not require live stores or private fixtures. Final gate results are recorded with the delivery. The requested Clippy spelling is passed through Cargo's argument separator: `cargo clippy --locked -- -D warnings`.

### Final gate outcomes

- `cargo fetch --locked --offline`: passed (dependencies resolved/installed from local cache).
- `cargo fmt --check`: passed.
- `cargo clippy --locked -- -D warnings`: passed, including after the authorized subc-core lock refresh.
- `cargo test --locked -p mc-module -p mc-store`: **not fully green**. Module unit tests: 1,419 passed, 13 ignored, one failed: `tests::handler_stuck_historian_is_bounded_and_next_transform_succeeds`, on its pre-existing `<5 seconds` assertion at `lib.rs:37667`. This fixture contains 80 text messages, no Media/Opaque. It failed again alone (17.32 s total), and also on the retained legacy-estimation control executable from the mutation run (13.35 s total). No assertion or deadline was weakened. The machine was heavily contended; this is not evidence of an output regression from the carrier skip.
- `cargo test --locked -p mc-store`: separately passed all 198 tests and doc tests after the combined command stopped at the module failure.
- `cargo test --locked -p mc-module -p mc-store --test '*'`: boundary durability (1), cold-flip adversarial (5), fleet logging (1), and protection-window golden (1) passed. The enclosing 600-second command budget then expired during `real_daemon::mc_transform_spine_through_real_daemon`; later integration binaries were not reached. The budget included the prior isolated check and store build/tests, so this is **not** a 600-second per-test measurement. No live daemon was restarted. Full integration verification remains incomplete.
- The final fixed module unit executable reran `planning_`: three passed, the opt-in private-payload timing test ignored. The opt-in test had already been run successfully against the six exported URLs.
- Comment review passed after clarifying the pre-fix digest's meaning; `git diff --check` passed.
- AFT diagnostics did not complete: `inspect_request_timeout: lsp_quiescence could not complete within the 120000ms request budget`. Successful Clippy compilation is the authoritative typecheck here.

The failure/timeout limitations above are retained rather than converting them into a claim that all required gates passed.
