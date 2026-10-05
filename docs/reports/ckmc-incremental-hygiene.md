# ck-mc production-equivalent per-pass breakdown

| Fixture | Mode | Handler total | State evolution | Hygiene | Native attach |
| --- | --- | ---: | ---: | ---: | ---: |
| ALF (7,501 messages) | warm_delta | 249.39 / 255.68 | 68.46 / 69.33 | 59.37 / 60.16 | 5.63 / 5.65 |
| ALF | warm_full | 542.29 / 556.11 | 65.94 / 66.18 | 56.36 / 56.65 | 124.74 / 125.27 |
| ALF | evicted_full | 606.28 / 614.06 | 63.27 / 63.55 | 54.36 / 54.58 | 212.89 / 213.36 |
| CEREB-sized (1,876 messages) | warm_delta | 72.87 / 76.94 | 15.25 / 15.27 | 13.17 / 13.19 | 1.58 / 1.59 |
| CEREB-sized | warm_full | 160.71 / 167.48 | 15.85 / 15.92 | 13.35 / 13.42 | 36.69 / 37.04 |
| CEREB-sized | evicted_full | 175.55 / 180.48 | 15.65 / 15.68 | 13.30 / 13.34 | 56.33 / 56.50 |
| Small (569 messages) | warm_delta | 32.14 / 37.21 | 6.35 / 6.36 | 5.52 / 5.53 | 0.87 / 0.87 |
| Small | warm_full | 84.99 / 94.97 | 6.47 / 6.52 | 5.59 / 5.62 | 28.00 / 28.11 |
| Small | evicted_full | 84.05 / 88.78 | 6.45 / 6.47 | 5.59 / 5.62 | 29.04 / 29.27 |

All cells are **thread CPU / wall milliseconds**, separate medians of 20 samples.
These are direct references-off measurements, not subtraction estimates. Hygiene
is the largest identified ordinary ALF CPU substage (59.37 ms), about 24% of
handler CPU and 87% of evolution. CEREB's hygiene narrowly exceeds rendering;
rendering is first on the small fixture.

**Step 1 delivered; Step 2 deferred by reviewer decision.** Although hygiene is a
real cost, the reviewer supplied a live ALF envelope of approximately 600 ms
inside ck-mc at similar load, versus this fixture's approximately 250 ms CPU / 256
ms wall. Even eliminating all 60 ms would leave most of that gap. Investigate
matched recorded inputs before adding a byte-preserving cache. No incremental
hygiene implementation or production optimization saving is claimed.

## Measurement conditions and isolation

Measured source: `cf8d3487e022f35838e645deaae3194b61c5bcf4`, cargo/rustc 1.99.0,
release profile, current-thread Tokio. After an initial missing-backup blocker,
the user supplied fresh snapshots taken at 17:44Z. The existing
`$TMPDIR/magic-context/ckmc-perf/backups/{context,store}.db` were 6,155,116,544 and
1,108,799,488 bytes, mode 0444 (confirmed after profiling). The harness checks
read-only permissions before any profiling store open and opens sources
immutable/read-only; only throwaway writable clones are migrated and committed.
No live databases were opened; no backups were recreated, written or removed.

After a 26m48s release compilation/compile-slot wait, the release CPU-clock test
passed (one test). The references-off command below passed in 65.25s: three
warmups plus 20 samples for each of nine session/mode combinations, **180 measured
passes**. All measured samples were SOFT+, every reported stage has n=20, and no
projection/native differential span was present. All 120 full-mode outputs
matched their 60 delta-mode counterparts as complete serialized CK and assembled
native arrays. A separate references-**on** run passed in 97.00s, again 180 samples,
with native references in all modes and projection references for acknowledged
deltas. Complete CK/native output digests matched **180/180 across the off/on
runs**, not just cache keys or null native placeholders. This proves the harness
switch's parity on these scale fixtures, not a cache candidate's recorded-session
parity. Logs remain private temporary artifacts; only statistics are committed.

### Mode-start load lines

These are loaded-host, not quiet-host measurements. References-off:

| Fixture | Mode | Uptime / load line |
| --- | --- | --- |
| ALF | warm_delta | 20:12 up 8:03, 5 users, load averages: 35.64 36.35 36.93 |
| ALF | warm_full | 20:12 up 8:03, 5 users, load averages: 37.37 36.67 37.04 |
| ALF | evicted_full | 20:12 up 8:04, 5 users, load averages: 35.49 36.31 36.90 |
| CEREB | warm_delta | 20:12 up 8:04, 5 users, load averages: 32.91 35.66 36.65 |
| CEREB | warm_full | 20:12 up 8:04, 5 users, load averages: 32.91 35.66 36.65 |
| CEREB | evicted_full | 20:12 up 8:04, 5 users, load averages: 31.48 35.31 36.53 |
| Small | warm_delta | 20:13 up 8:04, 5 users, load averages: 32.40 35.44 36.57 |
| Small | warm_full | 20:13 up 8:04, 5 users, load averages: 32.40 35.44 36.57 |
| Small | evicted_full | 20:13 up 8:04, 5 users, load averages: 31.32 35.17 36.46 |

Separate references-on correctness run:

| Fixture | Mode | Uptime / load line |
| --- | --- | --- |
| ALF | warm_delta | 20:17 up 8:08, 5 users, load averages: 20.40 28.36 33.27 |
| ALF | warm_full | 20:17 up 8:09, 5 users, load averages: 16.92 27.20 32.77 |
| ALF | evicted_full | 20:17 up 8:09, 5 users, load averages: 15.24 26.15 32.26 |
| CEREB | warm_delta | 20:18 up 8:09, 5 users, load averages: 20.83 26.48 32.20 |
| CEREB | warm_full | 20:18 up 8:09, 5 users, load averages: 21.49 26.52 32.18 |
| CEREB | evicted_full | 20:18 up 8:10, 5 users, load averages: 23.62 26.84 32.23 |
| Small | warm_delta | 20:18 up 8:10, 5 users, load averages: 22.21 26.50 32.07 |
| Small | warm_full | 20:18 up 8:10, 5 users, load averages: 21.15 26.21 31.94 |
| Small | evicted_full | 20:18 up 8:10, 5 users, load averages: 20.02 25.89 31.79 |

### Ordinary acknowledged pass: main stages and hygiene children

Inclusive CPU / wall medians in ms; do not sum parents with children:

| Stage | ALF | CEREB-sized | Small |
| --- | ---: | ---: | ---: |
| handler_total | 249.39 / 255.68 | 72.87 / 76.94 | 32.14 / 37.21 |
| request_decode | 0.02 / 0.02 | 0.02 / 0.02 | 0.03 / 0.03 |
| handler_prepare | 23.28 / 25.19 | 8.38 / 8.46 | 3.72 / 5.87 |
| delta_expand | 22.93 / 23.19 | 5.53 / 5.56 | 2.38 / 2.39 |
| transform_execute | 200.09 / 204.09 | 51.67 / 53.74 | 25.48 / 26.12 |
| projection | 4.43 / 4.49 | 1.21 / 1.22 | 0.40 / 0.40 |
| ingress_validation | 3.54 / 3.64 | 0.70 / 0.70 | 0.26 / 0.26 |
| seed_or_sync | 20.71 / 21.09 | 5.51 / 5.51 | 1.70 / 1.70 |
| store_tags | 0.01 / 0.01 | 0.01 / 0.01 | 0.01 / 0.01 |
| transition_pre | 4.69 / 4.80 | 0.94 / 0.94 | 0.38 / 0.38 |
| coverage_and_reconciliation | 0.36 / 0.37 | 0.04 / 0.04 | 0.01 / 0.01 |
| identity_enforce | 1.50 / 1.51 | 0.34 / 0.34 | 0.29 / 0.29 |
| tag_overlay | 15.88 / 16.50 | 4.06 / 4.06 | 0.61 / 0.61 |
| temporal | 1.13 / 1.14 | 0.26 / 0.26 | 0.02 / 0.02 |
| planning | 11.45 / 12.01 | 2.36 / 2.39 | 1.20 / 1.20 |
| state_clone | 2.37 / 2.41 | 0.65 / 0.65 | 0.25 / 0.25 |
| state_evolution | 68.46 / 69.33 | 15.25 / 15.27 | 6.35 / 6.36 |
| evolution_channel1 | 1.03 / 1.06 | 0.17 / 0.17 | 0.10 / 0.10 |
| evolution_overlay_maps | 0.96 / 0.96 | 0.25 / 0.25 | 0.02 / 0.02 |
| evolution_hygiene | 59.37 / 60.16 | 13.17 / 13.19 | 5.52 / 5.53 |
| hygiene_tag_rows | 5.13 / 5.22 | 0.96 / 0.96 | 0.11 / 0.11 |
| hygiene_measure | 52.72 / 53.68 | 11.95 / 11.97 | 5.28 / 5.28 |
| hygiene_indexes | 11.44 / 11.58 | 1.89 / 1.89 | 0.53 / 0.53 |
| hygiene_parts | 35.95 / 36.37 | 8.86 / 8.89 | 4.20 / 4.20 |
| hygiene_signature | 4.84 / 4.89 | 1.18 / 1.18 | 0.53 / 0.53 |
| hygiene_refresh | 1.04 / 1.06 | 0.24 / 0.24 | 0.11 / 0.11 |
| build_output | 35.13 / 36.08 | 12.34 / 12.38 | 10.37 / 10.39 |
| tail_match_diagnostics | 0.66 / 0.67 | 0.25 / 0.25 | 0.07 / 0.07 |
| finalize | 23.53 / 24.38 | 6.31 / 7.21 | 2.74 / 3.46 |
| store_commit | 19.98 / 20.72 | 5.28 / 6.10 | 2.10 / 2.82 |
| handler_followup | 16.11 / 16.25 | 10.15 / 10.21 | 1.48 / 1.48 |
| trigger_ms | 16.11 / 16.25 | 10.15 / 10.21 | 1.48 / 1.48 |
| trigger_boundary_build | 7.05 / 7.13 | 1.54 / 1.54 | 0.56 / 0.57 |
| trigger_eval | 3.98 / 4.03 | 1.23 / 1.23 | 0.65 / 0.65 |
| post_attach | 8.13 / 9.54 | 2.53 / 4.06 | 1.39 / 1.95 |
| native_attach | 5.63 / 5.65 | 1.58 / 1.59 | 0.87 / 0.87 |

### Full-ingress stages

Each cell is warm_full **;** evicted_full, each pair CPU / wall ms. Full ingress
does not invoke `delta_expand`:

| Stage | ALF | CEREB-sized | Small |
| --- | ---: | ---: | ---: |
| request_decode | 35.48 / 36.50 ; 33.88 / 33.93 | 9.30 / 9.31 ; 9.41 / 9.42 | 4.02 / 4.04 ; 4.02 / 4.04 |
| handler_prepare | 0.39 / 0.48 ; 0.45 / 1.21 | 5.32 / 6.39 ; 5.47 / 6.96 | 2.68 / 6.22 ; 2.60 / 2.92 |
| transform_execute | 347.89 / 356.26 ; 335.07 / 338.31 | 92.33 / 94.90 ; 91.20 / 92.62 | 45.95 / 49.79 ; 45.55 / 46.01 |
| projection | 146.44 / 148.20 ; 140.01 / 140.17 | 36.39 / 36.52 ; 36.03 / 36.17 | 17.25 / 17.45 ; 16.88 / 16.93 |
| seed_or_sync | 20.44 / 20.62 ; 20.26 / 20.41 | 5.52 / 5.53 ; 5.53 / 5.55 | 1.83 / 1.84 ; 1.78 / 1.78 |
| state_clone | 2.34 / 2.35 ; 2.27 / 2.27 | 0.63 / 0.63 ; 0.63 / 0.63 | 0.24 / 0.24 ; 0.24 / 0.24 |
| tag_overlay | 26.47 / 26.60 ; 25.73 / 25.80 | 6.90 / 6.92 ; 6.85 / 6.87 | 1.83 / 1.83 ; 1.81 / 1.81 |
| temporal | 1.05 / 1.06 ; 0.97 / 0.98 | 0.26 / 0.26 ; 0.26 / 0.26 | 0.02 / 0.02 ; 0.02 / 0.02 |
| planning | 10.50 / 10.82 ; 9.93 / 10.05 | 2.43 / 2.47 ; 2.37 / 2.37 | 1.32 / 1.33 ; 1.28 / 1.28 |
| build_output | 35.69 / 36.08 ; 32.55 / 32.65 | 13.38 / 13.42 ; 13.43 / 13.46 | 12.44 / 12.48 ; 12.41 / 12.47 |
| finalize | 23.23 / 24.12 ; 22.94 / 23.98 | 6.32 / 7.43 ; 6.37 / 7.05 | 2.74 / 6.73 ; 2.74 / 2.84 |
| store_commit | 19.81 / 20.60 ; 19.70 / 20.88 | 5.34 / 6.46 ; 5.38 / 6.09 | 2.09 / 6.07 ; 2.10 / 2.17 |
| handler_followup | 15.61 / 15.75 ; 14.96 / 15.04 | 10.22 / 10.29 ; 10.27 / 10.31 | 1.60 / 1.62 ; 1.53 / 1.53 |
| trigger_boundary_build | 6.81 / 6.84 ; 6.36 / 6.38 | 1.58 / 1.58 ; 1.63 / 1.63 | 0.63 / 0.63 ; 0.60 / 0.60 |
| post_attach | 146.93 / 148.48 ; 222.30 / 223.85 | 43.00 / 45.21 ; 58.87 / 60.37 | 30.65 / 33.88 ; 30.33 / 31.04 |
| hygiene_tag_rows | 4.61 / 4.63 ; 4.35 / 4.37 | 0.95 / 0.95 ; 0.97 / 0.98 | 0.11 / 0.11 ; 0.11 / 0.11 |
| hygiene_indexes | 10.88 / 10.95 ; 9.72 / 9.73 | 1.99 / 2.00 ; 2.06 / 2.06 | 0.58 / 0.58 ; 0.58 / 0.59 |
| hygiene_parts | 34.81 / 34.93 ; 34.61 / 34.74 | 8.90 / 8.91 ; 8.87 / 8.89 | 4.20 / 4.21 ; 4.26 / 4.27 |
| hygiene_signature | 4.82 / 4.83 ; 4.69 / 4.71 | 1.17 / 1.17 ; 1.16 / 1.16 | 0.53 / 0.53 ; 0.53 / 0.53 |
| hygiene_refresh | 1.05 / 1.05 ; 0.96 / 0.96 | 0.23 / 0.23 ; 0.23 / 0.23 | 0.11 / 0.11 ; 0.11 / 0.11 |

### Work counters and measured fixture ranking

Warm-delta medians on the fresh snapshots:

| Counter | ALF | CEREB-sized | Small |
| --- | ---: | ---: | ---: |
| restored initial frozen units | 38,878 | 12,753 | 878 |
| measured frozen units | 41,229 | 12,800 | 2,088 |
| projection blocks | 22,944 | 5,797 | 2,590 |
| reused / projected messages | 7,499 / 2 | 1,874 / 2 | 567 / 2 |
| native reused / encoded messages | 305 / 2 | 355 / 2 | 569 / 2 |
| emitted non-synthetic messages | 305 | 355 | 569 |
| tag candidates / newly minted | 8,669 / 0 | 2,110 / 0 | 95 / 0 |
| trigger token-cache hits | 22,943 | 5,796 | 2,589 |

ALF ordinary-pass measured CPU envelope ranking: hygiene 59.37 ms; rendering
35.13; finalize 23.53 (including store commit 19.98); delta expansion 22.93;
seed/sync 20.71; historian followup 16.11; tag overlay 15.88; planning 11.45;
native attachment 5.63; projection 4.43. These are **costs, not savings promises**.
Hygiene's dominant work is parts/hashes, not its approximately 1 ms refresh. The
next investigation priority is explaining the live-vs-shape gap with recorded
inputs, not implementing this ranking as a cache roadmap.

## Harness-only scoped override

The existing ignored `copied_sessions_per_pass_cost` test now accepts
`MC_PER_PASS_REFERENCES=off`. The default, or explicit `on`, retains both full
correctness references. Other values are rejected rather than silently profiling
the wrong mode. The setting is read only by this harness, not by production or
other tests. A private, thread-bound RAII guard suppresses the two predicates only
on the current-thread harness runtime, including normalization and warmups, and
restores the previous setting on scope exit or unwind. Concurrent tests on other
threads retain their default references. The meanings of
`MC_PREFIX_PROJECTION_DIFFERENTIAL` and `MC_NATIVE_ATTACHMENT_DIFFERENTIAL` are
unchanged; all override code is under `cfg(test)`.

`COST_CONFIG`, `COST_RUN`, `COST_SAMPLE`, and `COST_SUMMARY` explicitly print
`references`. References-off passes also assert that neither differential span
appears. The existing SOFT+ assertions and complete serialized CK / assembled
native-array comparisons across delta, warm-full and evicted-full modes are
retained. Those independent cross-mode comparisons are outside the timed spans;
they are not disabled by the override. Each mode still has three warmups and at
least 20 samples, for nine summaries / 180 measured passes on the default shapes.

To reproduce with the supplied read-only snapshots inside the isolated worktree:

```sh
cargo test --release --locked -j 2 -p mc-module --lib \
  thread_cpu_clock_records_work_and_stays_opt_in -- --nocapture
MC_PER_PASS_REFERENCES=off cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1
# Separate reference-on parity run; never subtract its medians and call the
# result a measured production-equivalent run.
MC_PER_PASS_REFERENCES=on cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1
```

Collect each summary's `thread_cpu_p50_ms` / `wall_p50_ms` by stage, especially
`evolution_hygiene`, its tag/index/parts/signature/refresh children,
`state_evolution`, `delta_expand`, `finalize`, `store_commit`, `build_output`,
`seed_or_sync`, `tag_overlay`, `handler_followup`, and `native_attach`. Record each
mode's load line. The new samples above, not subtraction of reference-on timings,
are the performance basis.

## Why the old harness and live breakdown need not agree

The prior plan's references-on ALF delta medians were 524.86 / 530.11 ms handler,
62.76 / 62.87 ms hygiene, and 119.54 / 121.37 ms native attach. Its subtraction
estimate was 257.635 ms handler CPU without references, **not a references-off
measurement**. Removing the projection and native correctness references explains
that test-only cost. It does **not** by itself explain the earlier live wall
medians of 504 ms state evolution, 313 ms delta expansion, 184 ms finalize and
148 ms store commit. Those production stages still do whole-session work.

Stage medians are inclusive and drawn from different passes: store commit is
inside finalize, hygiene inside evolution, and delta expansion outside transform.
Do not add those medians or use them as an exact latency partition. The directly
measured references-off ALF CPU is now 249.39 ms, near the old 257.635 ms estimate,
but with a newer backup and different retained-state size. This is not a paired
speedup experiment or proof that the fixture represents live passes. The detailed
code-level hypotheses and missing recording controls follow.

## Recorded-input provenance and live capture controls

**Correction to a possible reading of the earlier plan: `CADENCE_REPLAY_DIR` and
`MC_PLANNING_FIXTURES` are input selectors for tests, not live recording switches.
There is no checked-in producer for either complete input format.** Source
inspection found the consumers and the offline raw-tail reader below, but no
writer of the cadence manifest/transform bundles or the planning input JSON.
The exact private cadence recorder / one-off planning JSON assembly program used
in the earlier investigations is not present in this checkout; do not invent a
command or claim its capture coverage.

| Input | What the checked-in code does | How it is produced / evidence limit |
| --- | --- | --- |
| `CADENCE_REPLAY_DIR` | `crates/mc-module/src/boundary.rs:2954–2968` loads `manifest.json`, iterates `exchanges`, and reads `transform_files[0]` as a `TransformRequest` and `[2]` as its response. `:3033–3045` separately reads `captures/<exchange>-fwd-body` as the forwarded provider body. | An externally assembled private capture bundle must supply both module request/response and provider-forwarded bytes, plus `selected_publications`. The test expects six selected publications (`:3088`) and even one specific exchange (`:3064`); it is a historical measurement fixture, not a generic recording service. No in-repo writer of this manifest/bundle was found. |
| `MC_PLANNING_FIXTURES` | `crates/mc-module/tests/real_daemon.rs:1274–1277` reads a JSON array; `:1319–1335` takes each object's `raw_messages`, decodes OpenCode parts, restores `absolute_ordinal`, and constructs CK/native inputs. | The earlier report says the array was assembled offline using `readRawSeedTailFromDb` against a cloned OpenCode database, plus persisted session/render/provider/model/system fields (`docs/reports/rust-planning-regression-2026-09-30.md:262–268,286–291`). `packages/plugin/src/hooks/magic-context/read-session-raw.ts:851–901` implements that **reader**, returning a Map of raw parts/roles/ordinals; it does not write the fixture file. No checked-in JSON assembly writer was found. |

The planning probe writes **outputs**, not its input recording:
`crates/mc-module/tests/real_daemon.rs:1359–1365` writes served/response JSON into
the caller's guarded scratch clone. Its next requests are generated by changing
the nonce and appending a synthetic user every third pass (`:1337–1342,1372–1384`).
Thus it preserves more real part content than the shape harness, but is still not
a recording of the live event/publication/drop sequence or provider-forwarded
wire. The current two supplied MC backups have no raw OpenCode request stream;
no OpenCode database was opened to recreate one here.

### Can recording be enabled for one live Rust-mode session?

**Not through a supported env/config/ck-mc flag in this checkout.** Neither test
variable is read by the production path. The Rust adapter builds/pages the
transform and sends it (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:
3402–3406,3445–3461`); `module-transport.ts:589–618,628–663` serializes/sends it and
assembles the response, without a session-filtered file recorder. The installed
`@cortexkit/subc-client` 0.11.1 source was also inspected: no request-dump writer
or capture env switch was found. This conclusion is scoped to these inspected
components, not uninspected provider/proxy software outside this repository.

- `ck-mc`'s entrypoint handles version/fences/migration/repair and `--subc`, then
  serves through the SDK (`crates/mc-module/src/main.rs:23–41,57–76,80–92`); it has
  no transform-recording flag. Its `trace_received` / `trace_complete` stages call
  metadata-only durable breadcrumbs (`crates/mc-module/src/lib.rs:10046–10048,
  10682–10684`; `crates/mc-store/src/lib.rs:8926–8967,9009–9039`), not raw payload
  files. `mc-pass-timing` logs cannot reconstruct signatures/native unknown fields.
- `debug_rpc=true` / `MAGIC_CONTEXT_DEBUG_RPC=1` is a different facility:
  `packages/plugin/src/plugin/rpc-handlers.ts:1199–1204,1481–1484` enables memory
  counters and heap snapshots, **not** these transform recordings. Its config is
  user-tier/startup-only (`packages/plugin/src/config/schema/magic-context.ts:
  1393–1397`). Enabling it and restarting OpenCode would not produce either corpus.
- `MC_PURE_REPLAY_CAPTURE` is test-only: it writes synthetic **served** requests
  from `packages/plugin/src/hooks/magic-context/transform-degraded-pass.test.ts:
  273–287`, not live Rust module input/events.
  The `MC_REPLAY_DIR` Rust diagnostic is another **reader** of externally captured
  `*-module-req.json` files (`crates/mc-module/src/lib.rs:20396–20421`), not a writer.

Consequently **restarting either process alone cannot turn on a nonexistent
recorder**. For a future approved capture task, a bounded, default-off,
session-filtered hook at the adapter's logical full/delta request and assembled
response boundary would require deploying/reloading the plugin (normally an
OpenCode host restart); restarting ck-mc alone would not install that host hook.
A recorder added inside ck-mc would instead require a ck-mc restart, but would
not capture later provider framing/host changes. Either design needs explicit
event/publication association, delta assembly, privacy controls and off-switches.
This is a recommendation, not an implemented or enabled feature. **No live
configuration, environment, recorder, or process was changed or restarted.**

## Ranked code-level explanation of the live-vs-shape gap

**Measured:** the new ALF delta wall medians are state evolution 69.33 ms, delta
expansion 23.19, finalize 24.38 and store commit 20.72. The supplied earlier
selected-slow live wall medians were 504, 313, 184 and 148 respectively. The
reviewer's more recent ordinary live envelope is approximately 600 ms; the
shape handler is 255.68 ms wall. These are different captures/distributions, not
paired requests or a live CPU profile. There is no measured allocation of the
remaining approximately 344 ms. Do not subtract or add the inclusive stage
medians to manufacture one.

**Reasoned from code:** prioritize the byte-volume/structure domains below for
the next matched recording. Stage order within each row is likely sensitivity,
not measured feature attribution. Unless fully qualified, Rust references in
this table are under `crates/mc-module/src/` (for example, `lib.rs` means
`crates/mc-module/src/lib.rs`); `mc-store/src/` references are under `crates/`:

| Live feature absent or simplified in the shape fixture | Likely stage order and reason |
| --- | --- |
| Large signed/redacted reasoning | **`delta_expand` → `state_evolution` → `build_output` / `post_attach`**, plus cold `projection`. Native-prefix JSON is deeply cloned on every admitted delta (`lib.rs:5153–5156`); real signatures/redacted data add copied bytes. Hygiene excludes reasoning from U/T but still hashes its full block bytes (`tail_hygiene.rs:638–640,250–259`), so "zero tokens" is not zero work. Historical reasoning strip/clear selection and output healing inspect real shapes. The fixture explicitly substitutes unsigned 64-byte reasoning and 32-byte redacted filler (`tests/per_pass_cost.rs:178–182`). Signed content does not automatically enlarge `store_commit`: durable identity rows hold fingerprints, not every raw signature. |
| Real nested tool arguments/results, attachments and recurring cross-message call IDs | **`state_evolution` ≈ `delta_expand` → `build_output` → `native_attach` / `projection` on untrusted/full inputs.** Hygiene serializes each tool input and measures output content (`tail_hygiene.rs:591–620`); tool attribution/protection depends on whole arcs, including legacy recurring IDs (`:299–385`). Delta reconstruction clones CK blocks and native trees (`ck_wire.rs:369–395`; `lib.rs:5096–5106,5153–5161`). The fixture replaces arguments with a tiny `{filePath:...}` object, media with tiny base64, and broken cross-message calls/results with text (`tests/per_pass_cost.rs:183–227`). Output lengths for tagged results are retained as filler; missing sources fall back to 64 bytes (`:153–175`), so neither actual argument structure nor exact overall byte volume is preserved. |
| Unknown native/provider/harness fields | **`delta_expand` → full/untrusted `native_attach` → `projection` / `build_output` where CK extras participate.** Deep prefix cloning is proportional to the retained native tree, not two changed messages. Native sidecar decode/hashing/replay carries unknown metadata; a warm suffix attach can still be cheap while expansion already copied the entire prefix. The fixture starts bare blocks and empty provider/harness extras (`tests/per_pass_cost.rs:212,229–235`) and synthesizes native arrays from an empty sidecar (`:248–259`), so it cannot reproduce real metadata clone/decode cost. Raw native fields are not directly serialized into the store's identity collection; do not attribute them indiscriminately to `store_commit`. |
| Drop sentinels, pending/consumed drops and many frozen reductions | **`state_evolution` → `finalize` / `store_commit` → `build_output`**, then `planning` / `trigger_ms`. Hygiene builds red/sentinel arc sets (`tail_hygiene.rs:519–560`) and strips/excludes sentinel outputs. Finalize walks drop consumption, red targets, reasoning-clear units and full state equality (`transform.rs:6748–6783`), then commits pending-drop/overlay effects (`:6796–6834`). Real arc/protection/queue transitions are missing from the steady streaming sequence. Historical frozen reductions are retained, however; sentinels often **reduce** bytes and should not be assumed to slow every pass. Their branch/dependency pattern, not just their presence, needs measurement. |
| Reminder spans and changing Channel-1/2 state | **`state_evolution` → `build_output` → `delta_expand`**, and `store_commit` only when durable decisions change. Measurement strips reminder spans, yet still traverses the source and derives effective content (`tail_hygiene.rs:152–161,575–578,607–610`); evolution prunes channel1 units and rebuilds overlay maps (`transform.rs:6147–6162`). Actual host reminders/native metadata are not reproduced by filler; copied durable channel1 rows alone do not reconstruct the live input stream. Larger already-retained reminder strings also cost prefix cloning. |
| Many historical blocks, identity-history rows, frozen payloads and actual fold/publication composition | **`state_evolution` → `store_commit` (inside `finalize`) → `seed_or_sync` / `state_clone` → `build_output` / `trigger_ms`.** Every projection block, even covered ones, gets a hygiene part/hash. Store preparation serializes every frozen chunk and whole meta (`mc-store/src/cache_codec.rs:726–745`) and fingerprints all identity/served rows (`mc-store/src/lib.rs:16632–16656`); finalize separately compares full state. The fixture deletes identity history before normalization (`tests/per_pass_cost.rs:326–334`) and seeds only its requested last-message cap. The earlier report observed 26,713 identity-history rows versus 7.5k current request messages; that is a plausible missing domain, not a current live count. It preserves original non-frame frozen units but normalizes m0/m1 (`:380–397`) and disables producer activity/uses 1% usage (`:347–373`), so it lacks live composition/publication events. |

**Best working hypothesis:** real prefix byte/metadata volume is the most direct
explanation for underpriced `delta_expand`; actual tool/covered-block bytes and
arc shapes are the strongest candidates within `state_evolution`; historical
identity/section/payload domains and SQLite contention are the strongest
candidates for `store_commit` / `finalize`. Investigate these before assuming the
fixture's hygiene ranking explains live CPU. This is an investigation order,
not an optimization ranking established on live recordings.

The fixture does **not** simply omit all history, tags or overlays: ALF still
has 22,944 projection blocks and 41,229 measured frozen units, actually exceeding
the earlier supplied ~22,900 / ~34,750 counts. Original historical frozen payloads
are retained. Missing counts alone therefore cannot explain the gap; record
bytes/kinds, identity-history size, real native metadata, m0/m1 frame sizes and
actual decisions/publications on matched passes. The isolated handler also lacks
live cross-session cache competition, writer waits and queued requests. Similar
load average does not equal identical thread CPU, allocator pressure or SQLite
waiting; no live per-stage CPU clocks were supplied. No code-level hypothesis
above proves those effects caused a particular slow pass.

## Final scope decision

Design 2 is not started, by the reviewer's explicit decision after Step 1: even
the entire fixture hygiene envelope is only approximately 60 ms, and the roughly
600 ms live ALF envelope needs a more representative investigation first. No
epochs, wire/schema/migration, cache algorithm, baseline semantics or signature
format were changed. No mc-core changes.

Verification on cargo 1.99.0 (5f94df478 2026-08-27), rustc 1.99.0
(b940084d7 2026-09-28), clippy 0.1.99 (b940084d7e 2026-09-28),
rustfmt 1.10.0-stable:

- `cargo fmt --all --check`: passed (silent-success formatting gate).
- `CARGO_BUILD_JOBS=2 cargo clippy --locked -p mc-module --all-targets -- -D warnings`:
  passed, one all-targets package check, no warnings (19m24s including shared-slot
  queueing). This is authoritative compilation/typechecking of the change.
- `CARGO_BUILD_JOBS=2 cargo test --locked -p mc-module`: passed, **1,582 tests
  passed / 22 ignored / 0 failures**, including 1,558 library tests and 24
  binary/integration tests. The first attempt reached passing library and several
  integration suites but timed out at 30 minutes after 24m27s compiling/queueing;
  no test failure was observed. After confirming no owned child build/test
  survived, the cached rerun with a longer cap completed all targets, including
  real-daemon integration tests (about 14m30s total).
- Restored-state `CARGO_BUILD_JOBS=2 cargo test --locked -p mc-module --lib
  per_pass_ -- --nocapture --test-threads=1`: **4 passed / 1 ignored / 0 failures**.
  Covers clock opt-in, existing model-cache-TTL behavior, scoped/thread-local
  suppression (including nested scopes and unwind), and strict/default-on mode
  parsing. The copied-session harness is the one ignored test.
- Scoped editor inspection: partial/unknown while Rust analyzer was still
  checking; no clean-editor-diagnostics claim. Use the successful clippy/test
  compilation above.
- Release `thread_cpu_clock_records_work_and_stays_opt_in`: 1 passed. Both
  references-off and separate references-on release `copied_sessions_per_pass_cost`
  runs: 1 passed each, 180 measured samples / nine summaries each, plus all warmups.
  Output-digest comparison across the two runs: 180/180 matched. The missing-backup
  blocker is resolved; the measurements and load lines are above.
- Report transcription check: Python 3.9.6 compared all **264 CPU/wall pairs** in
  the lead, delta and full-ingress tables directly to the references-off summary
  JSON, requiring n=20 for every cell; all matched. This checks the actual run's
  summaries, not values recomputed from this report.
- Step 2's recorded-session/provider-byte candidate differential, one-unit
  measurement mutation, before/after optimization timings and pure replay:
  **not run**, because the reviewer deferred the production candidate. No cache
  parity or optimization saving is implied by the harness-switch comparison.

### Scoped-override non-vacuity

The implementation was staged before applying a `NON-VACUITY BREAK` that made
`differentials_disabled()` always return false. The non-empty diff was
`crates/mc-module/src/tests/per_pass_cost.rs | 4 +++-` (one file, three insertions,
one deletion). Running the `per_pass_` gate made exactly
`tests::per_pass_cost::per_pass_differential_override_is_scoped_and_thread_local`
fail: actual `(true, true)` versus expected `(false, false)`. These independent
controls stayed green:

- `per_pass_profile::thread_cpu_clock_records_work_and_stays_opt_in`
- `tests::claude_code_response_resolves_per_pass_model_cache_ttl_from_module_config`
- `tests::per_pass_cost::per_pass_reference_mode_defaults_on_and_rejects_unknown_values`

The copied-session harness stayed ignored, not green. Restoring with
`git checkout -- crates/mc-module/src/tests/per_pass_cost.rs` and touching that
file restored an empty `git diff --stat`; the four runnable controls then passed.
A tool-service restart interrupted delivery of the first restore/check response;
the restored file and staged-state diff were independently confirmed and the
narrow gate was rerun to obtain a recorded result. No mutation remains. This
proves the test-only switch is defended, **not** incremental measurement parity.
