# ck-mc state split: implementation evidence

This note records how the store.db migration 63 split (design: `docs/reports/ckmc-write-amplification-design.md`, r2, slices 1 to 4 of section 8) was checked. Every measurement ran on APFS clones under `$TMPDIR/magic-context/ckmc-split/`. The live stores were read only by `cp -c`. The machine's 1-minute load average was 31 to 51 throughout, so timings are minimums and medians from a busy machine.

## Isolation

- **Golden clones.** `scripts/ckmc-write-probe/prep.sh golden` with `CKMC_PROBE_DIR=$TMPDIR/magic-context/ckmc-split`. The store clone was at version 62. AFT's row is 8.19 MB, ALF's 7.18 MB and CEREB's 2.67 MB.
- **Drive runs.** A sampler ran `lsof -p` every 2 s on every `ck-mc` and `ck-subc` started from each run's `bin/`. It flagged any `.db`, `-wal` or `-shm` file outside the run directory.
  - Pinned runs: 304, 410 and 252 samples. Unpinned runs: 150 and 198 samples.
  - No run had a violation. The only database files open were the run's own `store.db` and `context.db` with their `-wal` and `-shm` files.
- **Clone profile.** The ignored test `cache_codec::tests::cloned_split_store_profile` asserts that every database its own process has open is under the clone root, and prints that list.

## 1. Served bytes are unchanged

`drive.ts` drove CEREB (`ses_0758f6ce7ffe…`) with one 15-pass plan:

`first,defer,newmsg,newmsg,newmsg,defer,hard,newmsg,defer,historian,wait_historian,newmsg,execute,newmsg,defer`

It used the hermetic historian producer. `PROBE_CLOCK_BASE_MS` pins the synthetic messages' ids and timestamps, which is the one probe change needed to compare runs.

The two binaries were built from the same tree:
- **Base** is `bd480c8`, the base of this branch.
- **New** is this branch at its first split commit (`f24fa9e`). Later commits move three more meta-only store readers (`set_todo_state`, `arm_soft_refresh`, `historian_state`) to the small row and add tests; none of them is on the transform path.

Five runs: base pinned, new pinned, base pinned a second time (a determinism control), base unpinned and new unpinned. In all five, `served_sha256`, the decision and the returned `row_version` are equal on every one of the 15 passes. That includes the HARD pass (index 6), the historian run and publish (9 to 10) and the execute pass (12).

**Defer passes.** Defer passes 1, 5 and 8 of the new binary write only `mc_pass_trace` and `mc_pass_trace_history`. They write no `mc_cache_state`, chunk or section page. Defer pass 14 writes 3 `mc_cache_state` pages; the base binary writes 614 on the same pass. That write is a meta-only historian no-fire record, and it is the same commit in both binaries, since `row_version` is equal.

## 2. Bytes before and after

### CEREB, a real module (WAL bytes from the pinned runs, module bytes written from the unpinned runs)

| Pass | Base WAL | New WAL | Base written (live config) | New written (live config) |
|---|---|---|---|---|
| new message (2, 3, 4) | 3.05 to 3.08 MB | 0.115 to 0.152 MB | 3.2 to 12.8 MB | 0.18 to 0.23 MB |
| defer (1, 5, 8) | 0.280 MB | 0.025 MB | 0.36 MB | 0.07 to 0.08 MB |
| HARD (6) | 6.36 MB | 3.58 MB | 17.8 MB | 10.2 MB |
| historian run (9) | 16.40 MB | 1.47 MB | 42.3 MB | 1.64 MB |
| historian publish observed (10) | 5.38 MB | 0.082 MB | 14.1 MB | 0.15 MB |
| execute (12) | 10.78 MB | 0.38 MB | 27.7 MB | 0.52 MB |
| whole plan | 71.6 MB | 7.3 MB | 180.0 MB | 15.0 MB |

The plugin's own `context.db` WAL is identical in both binaries. It is untouched by this change, and it is section 7's separate slice.

Against section 6:
- **New-message pass.** CEREB's 3.0 to 3.2 MB becomes 0.12 to 0.15 MB, against the "about 0.2 MB" projected for CEREB in section 7.3. This already includes the ring-row pass trace.
- **HARD pass.** It rewrites every chunk plus the tail baseline: 501 chunk pages and 130 section pages. That is the upper bound section 6 states.

### AFT, ALF and CEREB, the real codec on clones (`cloned_split_store_profile`, release build)

"Today" is the same session row rewritten whole with raw SQL after appending two units, which is what `commit_transform` did before the split. "Split" is `McStore::commit_transform` with the loaded base, after `McStore::open` ran migration 63 on the clone. WAL bytes are measured from an empty WAL.

| Commit | AFT | ALF | CEREB |
|---|---|---|---|
| Today: append 2 units | 8.26 MB | 7.25 MB | 2.70 MB |
| Split: first commit after the migration (append 2, digests recorded) | 41 KB | 33 KB | 29 KB |
| Split: append 2 units | 45 KB | 17 KB | 29 KB |
| Split: tail-baseline refresh | 17 KB | 17 KB | 17 KB |
| Split: every unit re-minted (HARD upper bound) | 6.86 MB | 5.72 MB | 2.45 MB |
| Split: `commit_meta` (historian bookkeeping) | 25 KB | 29 KB | 25 KB |

Against section 6 for AFT:
- A new-message commit falls from 8.3 MB to 0.045 MB, against 0.53 MB projected without ring rows.
- A meta-only write falls from about 8.25 MB to 25 KB.
- The HARD upper bound is 6.86 MB, against "at most 7.4 MB".

### The migration

On a clone of the whole store, `McStore::open` took 7.9 s, 10.4 s and 32.0 s across three clones at load 31 to 51. Design r2 measured 14.9 to 26.5 s.

## 3. Load cost

From `cloned_split_store_profile`, release build, 13 iterations each:

| | AFT | ALF | CEREB |
|---|---|---|---|
| Today: read and parse both blobs into the typed structs | 9.9 ms min, 12.2 median | 9.4 / 12.5 | 3.3 / 3.9 |
| Split: `read_decoded` (small row, chunks, sections, every digest checked, typed parse) | 12.3 ms min, 14.0 median | 11.6 / 12.6 | 3.8 / 4.2 |
| Split: `load_meta` | 0.13 ms | 0.14 ms | 0.09 ms |
| Split: `load_transform_snapshot` (includes the identity rows and the overlays) | 39.7 ms min | 36.7 ms | 11.9 ms |
| v93 planning (2 × `cached_context_boundaries` + `max_compartment_end_ordinal`, warm median) | 10.6 ms | 9.0 ms | 1.4 ms |

- **The full decode** costs AFT 2.3 ms more than today's read and parse (minimums). The budget in section 4.7 is 5 ms.
- **v93 planning** stays under 20 ms on AFT and ALF. That context.db clone was migrated to v93 by the plugin's own `runMigrations`. Against a v92 context.db, which has no revision counter, the same calls validate uncached every time (390 to 500 ms on AFT); that is the pre-v93 path, not a regression.
- **One full decode per pass.**
  - `a_new_message_pass_runs_exactly_one_full_decode` counts full decodes on the transform's thread.
  - The handler's revert-epoch reads, the historian preflight, the historian bookkeeping and the guidance-date read now use `load_meta`.
  - `historian_preflight_reuses_transform_tag_snapshot...` now pins zero full `McStore::load` calls per handler pass; before this change there were two.

## 4. Mutation controls

Each control staged the file, applied one mutation marked `NON-VACUITY BREAK`, ran the named test alone, and restored the file. `git diff --stat` was empty after every restore.

| Invariant | Mutation | Named test | Outcome |
|---|---|---|---|
| Digests fail closed | decoder accepts any stored frozen digest | `digest_mismatch_survives_meta_only_writes` | red |
| Meta-only never re-blesses | `commit_meta` marks the index unhashed (sv 0) | `digest_mismatch_survives_meta_only_writes` | red |
| Sections CAS | the sv check removed | `conflicting_commit_leaves_sections_untouched` | red |
| Delete past the new length | chunk delete bound set to `i64::MAX` | `edit_sequences_round_trip_through_the_store` | red |
| Some → None deletes the row | the absent-section delete matches nothing | `absent_section_deletes_its_row` | red |
| No commit for unchanged state (defer) | `sv` always advances | `an_unchanged_commit_writes_nothing` | red |
| Revert re-cut step pinned | the base/expected check removed | `revert_recut_commits_over_a_meta_only_bump` | red |
| No SQL read of a moved key | a planted `json_extract(meta, '$.resolved_compartment_boundaries')` in `context_boundaries.rs` | `no_sql_reads_moved_cache_state_keys` | red |
| Migration round trip | `json(e.value)` removed from the aggregate | `migration_63_moves_every_shape_and_the_codec_reads_it_back` | red |
| Fail-closed HARD | both the plan override and `force_hard` disabled for a discard | `corrupt_chunk_forces_hard_and_full_rewrite` | red: the pass fails inside the test's `run` helper instead of serving |
| Fail-closed HARD | only the explicit plan override disabled | `corrupt_chunk_forces_hard_and_full_rewrite` | not red: `force_hard` alone already selects HARD for a non-subagent pass; the override is for subagent passes |
| Bootstrap clears all rows | the bootstrap's `clear_session_rows` removed | `bootstrap_commit_clears_all_session_rows` | not red: the unconditional chunk delete and section delete already remove every leftover row, so the clear is defense in depth |
| One full decode per pass | an extra `store.load` in `apply_once` | `a_new_message_pass_runs_exactly_one_full_decode` | red |
| Sentinel reads ring rows | the view read forced off | `reads rust scheduler history from migration 63 ring rows` (bun) | red |

## 5. Not proven here

- **Not driven end to end on AFT or ALF.** Their byte and load figures come from the codec on clones, not from a real module behind a daemon.
- **Planning before the change was not measured.** v93 planning was measured only after the split, so the "~20 ms or better" check compares against the figure in the v93 report.
- **The "today" commit cost** in the clone profile is the raw row rewrite alone. It leaves out the pass-trace upsert and the row-state digest that today's `commit_transform` also writes. The drive runs carry the full per-pass cost.
- **Status reads the whole frozen list.** `load_session_status_snapshot` still does a full decode, because status reports the session-history size from frozen unit `m0` and the raw-passthrough state from the whole list. Design 4.5 projected a small-row-plus-tail read; that would need status to stop reading those.
- **The live-evidence tools** `sampler.sh`, `reconcile.sh` and `diffsamples.py` in `scripts/ckmc-write-probe/` still read the pre-split columns. They were not used for this evidence.
