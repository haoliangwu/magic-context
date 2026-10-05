# ck-mc write amplification: measurements and design

Status: design r2, for review. No product code changes with this note. r1 was reviewed adversarially in `docs/reports/ckmc-write-amplification-review.md` (kept under `refs/alfonso/accepted/bg_9068ce3192b33008`; "the review" below). Its verdict was that the direction is right but r1 could not be implemented as written: its migration SQL corrupted every non-empty session, it missed readers that query a moved key in SQL, and its fail-closed rule had no code path behind it. Appendix A maps every review item to the section of this note that answers it.

## Summary

- **The write is almost all one table.** In a 17-pass run of a real ck-mc on clones (r1, section 2.2), the session's `mc_cache_state` row, together with the copies of it that the next commit freed, took 94.5% of the `store.db` WAL frames: 15,362 of 16,252.
- **Every new message rewrites the whole row.** `commit_transform` rewrites the full row on any byte change, and a new agent step always appends to `core_state.frozen_units`. On AFT's 8.0 MB row that is about 8.2 MB of WAL per commit, two commits on most passes, for about 200 bytes of real change.
- **The fix is a structural split, now specified to the code path.** `frozen_units` moves to fixed-size positional chunk rows. `resolved_compartment_boundaries` and `tail_hygiene_baseline` move to hashed section rows (review N11). The small row keeps the `row_version` compare-and-set (CAS) and gains a `section_index` with a sections version and digests that only the codec can advance (section 4).
- **The migration SQL is now exact, measured through the SQL itself.** The migration text in `scripts/ckmc-write-probe/migcheck/migration63.sql`, run with SQLite 3.46.0 on a clone of the whole store, round-trips **1,400 of 1,400** `mc_cache_state` rows exactly, and every moved value is byte-identical to a serde re-serialization. The same verifier reports 1,237 of 1,400 rows corrupted when the aggregate drops `json()`, so it can fail (section 4.1).
- **Every reader of a moved key is listed with its post-split read** (section 4.5), including `cached_context_boundaries` and `load_state_sync_inventory`, and a source-scan test fails on any new SQL read of a moved key.
- **Fail-closed has a code path.** The decoder returns a per-section `Discarded` result; the transform forces HARD and the commit rewrites the discarded sections in full. Digests are checked on every full load and their trust no longer depends on `row_version` (section 4.6).
- **Load cost goes down, not up.** On AFT a pass does one full decode (+3.6 ms against today's blob, digest included) instead of two, and the boundary read drops from 3.95 ms to 0.01 ms per call (section 4.7).
- **The plugin's own `context.db` writes are now measured and are as large as ck-mc's.** On the CEREB clone, every new-message pass rewrites the 2.2 MB `lkg_slots` row once and the 1.1 MB `session_meta` record once, because a 40-character append to its 0.53 MB `trailing_blank_decisions` document changes the record's length. That is about 3.4 MB of `context.db` WAL against 3.0 to 3.2 MB of `store.db` WAL from ck-mc in the same pass. Section 7 proposes the plugin-side slice, which needs a `context.db` schema change.
- **The migration is v63** on both `master` and `alfonso/v93-merge-check`. It is a `store.db` fence move: older binaries refuse the store, and `scripts/place-ck-mc.sh` refuses a binary rollback. It took 14.9 to 26.5 s on a clone of the live store at a load average of 54 to 100, during which sessions can park (section 8).

## 1. Method

Sessions are named by the agent seat that owns them: AFT is `ses_313660571ffe…` (the largest cache row, 8.0 MB), ALF is `ses_227ce5788ffe…` (7.1 MB) and CEREB is `ses_0758f6ce7ffe…` (2.65 MB). "The brief" is the task that asked for r1; its live figures (36.4 GB written in 11 h 10 min; 46 commits and 370 MB in one 120 s window) were measured on the running module before this work started.

**Isolation.** Nothing in this work opened a live store. The live `context.db`, `store.db` and `opencode.db` were read only through `cp -c` (APFS clones): r1 into `$TMPDIR/magic-context/ckmc-writes/`, r2 into `$TMPDIR/magic-context/ckmc-writes-r2/` with `scripts/ckmc-write-probe/prep.sh golden`. Every run used fresh clones of those clones. In r2:

- `lsof -p` on the migration probe while it ran the migration listed only the probe binary, the clone (`mig/store.db`, `-wal`, `-shm`), its output file, an SQLite sort spill (`etilqs_*`) and the tool runner's own `io/` files. The verify run listed only the two clones and their `-wal` and `-shm` files.
- `lsof -p` on every process of the plugin run (`bun drive.ts`, `pin.py`, the private `ck-subc` and `ck-mc`, and the hermetic historian producer) listed only files under `ckmc-writes-r2/n12a/` besides binaries, libraries and the tool runner's `io/` files.
- A sampler recorded, every 2 s for the whole session (554 samples), every process holding a live store file open. Its log (`ckmc-writes-r2/live-lsof.log`) lists the operator's `opencode` and `ck-mc` in every sample, the Magic Context dashboard, and five short-lived `bun` processes of other sessions. None of them is a PID this work started; those are recorded in `n12a/lsof.txt` and `n12b/lsof.txt`.

The tools are committed under `scripts/ckmc-write-probe/`, and its README has the exact commands.

The measurements come from four sources:

1. **A real module behind a real daemon.** `drive.ts` starts a private `ck-subc` and `ck-mc`, copies of the installed binaries, and drives the plugin's real Rust-mode transform (`createRustModeTransform`) with the session's real messages since its newest compaction. r1 drove `ck-mc 0.1.0 (3ebd5c0659…)`. r2 drove the binary installed on 2026-09-30, on CEREB: 589 messages in the wire, a 2.66 MB cache row and a 104 KB pass-trace row.

   For each pass it records:
   - the module's own disk-write counter (`proc_pid_rusage`, `ri_diskio_byteswritten`);
   - the WAL frames appended to each store, and the table or index that owns every written page (`dbstat` over a clone);
   - each committed transaction's size (`walcommits.py`);
   - the SHA-256 of the served messages;
   - new in r2, with `PROBE_SQL_TRACE=1`: every write statement the plugin process runs against `context.db`, with its pass, its bound bytes, the columns it sets and the WAL frames it appended.

   Runs are pinned (`PROBE_PIN=1`: a reader holds a snapshot so the WAL is never reset and every frame is attributable) or unpinned (the live configuration, where the write counter includes checkpoint copies). The historian ran against the hermetic Broca producer, `packages/e2e-tests/src/rust-runner/fake-broca.ts`.
2. **An SQL-level replay on AFT's real row** (`sqlexp.py`, r1). It runs the statements `commit_transform` issues, with a ck-mc connection's pragmas, on per-scenario clones of `store.db`. It is a cost model only: its `migrate()` is a Python split, not the migration, and r2 no longer quotes it for the migration.
3. **The migration probe** (`migcheck`, new in r2). A Rust binary built against `rusqlite =0.32.1` with `bundled`, which pulls in `libsqlite3-sys 0.30.1` as `Cargo.lock` does, so it runs **the same SQLite as ck-mc: 3.46.0**. It runs `migration63.sql` unchanged in one transaction on a clone, verifies every moved value against the serde-parsed original, runs shape fixtures, and times the read paths of both layouts.
4. **Live evidence without touching the live store** (r1): 24 clones of `store.db` taken 10 s apart and diffed field by field (`sampler.sh`, `diffsamples.py`), and the live module's write counter compared with commits counted between two clones (`reconcile.sh`).

The clone runs used one setup step: the copied `cortexkit_fence` epoch was reset to 0 in the clone. A clone at a new path gets a new lease file starting at epoch 1, and the live writer's epoch would otherwise fence the probe out.

The machine was heavily loaded throughout r2: 1-minute load averages of 26 to 100. Timings are quoted as minimums, with medians where they matter.

### SQLite settings

| Setting | Value | Source |
|---|---|---|
| `page_size` | 4096 | the store file |
| `journal_mode` | WAL | `cortexkit_store::open_sqlite` (`commons/crates/cortexkit-store/src/lib.rs:305-367`) |
| `wal_autocheckpoint` | 1000 pages (SQLite default) | not set by `open_sqlite` or by mc-store |
| `synchronous` | FULL (SQLite default) | not set by `open_sqlite`; the bundled `libsqlite3-sys 0.30.1` build passes no `SQLITE_DEFAULT_*SYNCHRONOUS` |
| `auto_vacuum` | NONE | the store file |
| store size | 965 MB at the r2 clone | the store file |

Largest b-trees in `store.db`, from `dbstat` on the r1 clone:

| B-tree | Size |
|---|---|
| `mc_tags` | 443 MB |
| `mc_chunk_transcripts` | 161 MB |
| `mc_block_identities` | 104 MB |
| `mc_cache_state` | 98 MB |
| `mc_served_output_fingerprints` | 41 MB |
| `mc_pass_trace` | 13 MB |

## 2. Where the bytes go

### 2.1 Live evidence

**Which fields change.** Across 24 clones over 303 s there were 46 cache commits: AFT 6, ALF 2, and 38 on small sessions of about 50 KB. Every one of them changed the same fields:

- `core.frozen_units`: 1 to 5 units appended, with the stored prefix unchanged;
- `meta.last_committed_pass_at_ms`;
- `meta.last_usage.current_total_input_tokens`;
- `meta.newest_live_block_id` and `meta.newest_live_ordinal`;
- on AFT and ALF, also `meta.historian.recent_decisions` and `meta.historian.last_no_fire`.

`meta.tail_hygiene_baseline` (AFT 1.13 MB at the r2 clone) and `meta.resolved_compartment_boundaries` (AFT 1.06 MB) did not change in any sampled commit. AFT's `row_version` advanced by 2 for most new-message passes, which is the second commit described in section 3.3.

**Write rate.** The live module's counter read 38,153,654,272 bytes at 09:19 on the r1 day, against 36.4 GB in the brief. In a separate 181 s window in which AFT and ALF happened to be idle, it wrote 16.6 MB for 37 commits, all on rows under 60 KB. That is 449 KB per commit, about nine times the rows' own bytes: the pass trace and the WAL plus checkpoint double write make up the rest.

### 2.2 A real module, per pass type (CEREB, 2.65 MB row)

All numbers are measured. "Commits" is the number of `row_version` steps in the pass. WAL bytes come from pinned runs. "Written, live config" is the unpinned module counter, which includes checkpoints. The first table is r1's binary.

| Pass | Commits | store.db WAL | Written, live config |
|---|---|---|---|
| Stable defer, no new message | 0 | 0.17 to 0.35 MB, 5 txns, all pass-trace | 0.26 to 0.36 MB |
| New message, historian decision unchanged | 1 | 2.7 to 3.2 MB | 12.6 MB (one sample) |
| New message, historian no-fire changed (the common case) | 2 | 5.7 to 6.0 MB | 15.4 MB (mean of 5) |
| Execute (usage 80%, coverage fold) | 2 | 6.7 MB; `meta` grew 96 KB | 18.1 MB (85% run) |
| HARD rebuild (model switch) | 2 | 6.0 MB: 777 + 611 frames, the first with 134 served-fingerprint pages | (pinned only) |
| Historian run and publish during a pass | 7 | 15.5 MB, 13 txns | 18.8 MB, with deferred checkpoints |
| First pass after a module restart | 3 to 8 | 8.6 MB without a historian run, 19.7 MB with one | 18.1 MB |

The r2 run (run `n12a`, pinned, the 2026-09-30 binary, the same 17-pass plan) shows the same shape with one commit per new message: 3.0 to 3.2 MB of `store.db` WAL per new-message pass at `row_version` +1, 21.5 MB for the execute pass (+8 commits) and 0.35 MB for a pass that commits nothing.

The ratio of live-config bytes to WAL bytes is 2.6. The CEREB two-commit pass gives 15.44 / 5.99 = 2.58, and the AFT SQL replay gives 21.30 / 8.23 = 2.59. Each page is written once to the WAL and once more at checkpoint, and the rest is fsync and filesystem overhead.

Transaction breakdown of r1's historian pass, from `walcommits.py` (frames per transaction):

| Frames | What it is |
|---|---|
| 1, 28 | trace received |
| 653 | transform commit, with chunk transcripts |
| 613 | no-fire record |
| 1, 28 | trace completed |
| 604, 604, 604 | claim and heartbeat meta updates, each a full record |
| 4 | a same-length meta update, done in place |
| 631 | publish, with 36 chunk-transcript pages |
| 2 | single-store pending-publish row |

**What `ck-mc` writes to `context.db`.** Within a pass, the module's own write counter matched its `store.db` WAL to within 0.1 to 0.2 MB. Its only `context.db` writes were the historian publish (`compartments`: 4 frames plus 6 index frames). The plugin's own `context.db` writes are measured in section 7.

Per-table attribution across r1's whole pinned run (17 passes, 16,252 frames):

| B-tree | Frames | Share |
|---|---|---|
| `mc_cache_state` and the copies of it freed by later commits | 15,362 | 94.5% |
| `mc_pass_trace` | 409 | 2.5% |
| `mc_served_output_fingerprints` and its index | 204 | 1.3% |
| `mc_tags` and its indexes | 106 | 0.7% |
| `sqlite_schema` (page 1, once per transaction) | 58 | 0.4% |
| `mc_block_identities` and its index | 43 | 0.3% |
| `mc_cache_state_digest` | 21 | 0.1% |
| `mc_transform_session_roots` | 12 | 0.1% |

`mc_chunk_transcripts` appears only on historian runs: 587 frames in r1's run3.

### 2.3 AFT's row, SQL-level replay

Per commit, ten commits per scenario:

| Scenario | WAL frames | WAL bytes | Written, live config |
|---|---|---|---|
| Today, new-message commit: two units appended, pass scalars moved, with digest and pass-trace upsert | 1,997 | 8.23 MB | 21.3 MB |
| Today, same-length `meta`-only update | 2 | 8 KB | 18 KB |
| Today, byte-identical state (the commit is skipped) | 0 | 0 | 0 |
| Split layout, frozen units in 64-unit chunks | 46.7 | 192 KB | 212 KB |
| Split layout, one row per frozen unit | 47.5 | 196 KB | 218 KB |
| Split layout plus pass-trace ring rows | 7.7 | 32 KB | 53 KB |

In the split rows, about 40 of the 47 frames are the 163 KB pass-trace row, which every append re-serializes whole. That is why section 4.8 moves the trace histories to ring rows. The review re-measured the meta-only case on AFT: a length-changing `meta` update costs 2,002 frames (8.25 MB) today and 5 frames after the split.

## 3. Why unchanged fields are rewritten

### 3.1 The commit writes the whole record whenever any byte differs

- **The pass commits on any change.** `run_transform` sets `state_changed = core != loaded.core || meta != loaded.meta` (`crates/mc-module/src/transform.rs:6487-6490`) and calls `store.commit_transform` (`:6501-6519`). The compaction-off path (`:3325-3334`) and the two pending-rewrite pass-through paths (`:3875-3884`, `:3994-4000`) follow the same pattern.
- **Both blobs are serialized whole.** `McStore::commit_transform` (`crates/mc-store/src/lib.rs:10331`) serializes the entire `CoreState` and `ModuleMeta` to JSON (`:10384-10388`).
- **The CAS check comes first.** Inside the fenced transaction it compares `row_version` against `expected` (`:10427-10440`).
- **Byte-identical state is the only skip.** It compares the stored blobs byte for byte (`cache_state_blobs_unchanged`, `:16311-16337`). If anything differs, it upserts `core_state` and `meta` together (`:10489-10502`).
- **SQLite then rewrites the full record.** It writes a record in place only when the new record is exactly as long as the old one, and then writes only the pages whose bytes differ; that is why the same-length replay costs 2 frames. Otherwise it frees the old overflow chain and writes a new one of about 1,950 pages for AFT.
- **Appending a frozen unit always changes the record length**, so every new-message pass pays for the whole record, including the two `meta` sections that did not change.

### 3.2 The large fields ride along as passengers

| Field (AFT, r2 clone) | Size | When it actually changes |
|---|---|---|
| `core.frozen_units` | 5.97 MB, 32,292 units; unit 0 (`m0`) is about 383 KB | Units are appended on every new message; all are re-minted on HARD |
| `meta.tail_hygiene_baseline` | 1.13 MB, nearly all `baseline_parts` | On a bust pass, or when its prefix no longer matches (`transform.rs:5924-5986`) |
| `meta.resolved_compartment_boundaries` | 1.06 MB, 1,995 entries | When a historian publish or state sync adds or truncates a boundary |
| Everything else | about 11.5 KB of `meta`, about 100 B of `core` | Every pass |

### 3.3 More writers rewrite the same record outside the transform commit

- **The historian no-fire record.** `record_no_fire` (`crates/mc-module/src/lib.rs:6821-6858`, called from 13 sites in `prepare_historian_fire`) commits `loaded.core` together with a `meta` whose `historian.recent_decisions` and `last_no_fire` changed. It goes through `McStore::commit` (`crates/mc-store/src/lib.rs:10286-10294`), which calls `commit_transform`. That is the second full rewrite on most of r1's new-message passes, and live AFT shows `row_version` +2 per pass.
- **Historian claim, heartbeat and publish.** `historian_claim.rs` `store_meta` (`:311-337`) and `publish_historian_chunk` (`crates/mc-store/src/lib.rs:13415-13443`) issue `UPDATE mc_cache_state SET row_version = ?, meta = ?`. Only `meta` changes, but `core_state` lives in the same record, so each update rewrites the whole record whenever `meta` changes length. That is six of the seven commits in the historian pass above.
- **The pass trace, written even on stable passes.** `trace_pass_received` (`lib.rs:8571-8606`) and `trace_pass_completed` (`:8683-8718`) each upsert `mc_pass_trace` and then rewrite the request history through `mutate_pass_request_history` (`:3753-3776`), which re-serializes the whole `scheduler_interesting_history` array. `trace_pass_stable` (`:8611-8678`), or the upsert inside `commit_transform`, appends to `scheduler_history` with `json_insert`. Each statement is its own autocommit transaction, and the row is 104 KB for CEREB and 163 KB for AFT.

## 4. Proposed change

### 4.1 Layout and the migration (store.db migration 63)

The full text is `scripts/ckmc-write-probe/migcheck/migration63.sql`. It is plain SQL because `cortexkit-store` migrations are static batches (`Migration { version, statements: &'static str }`, run with `execute_batch` in one transaction with their version record: `commons/crates/cortexkit-store/src/lib.rs:27-39`, `:411-436`). The cache-state part:

```sql
-- Shape guards: any count other than zero fails the CHECK and rolls the whole migration back.
CREATE TEMP TABLE mc_migration_63_guard (problem TEXT NOT NULL, bad_rows INTEGER NOT NULL CHECK (bad_rows = 0));
INSERT INTO mc_migration_63_guard SELECT 'a frozen unit is not a JSON object', COUNT(*)
  FROM mc_cache_state AS s, json_each(s.core_state, '$.frozen_units') AS e
 WHERE json_type(s.core_state, '$.frozen_units') = 'array' AND e.type <> 'object';
-- ... four more: frozen_units not an array, boundaries not an array (null is allowed),
-- a boundary not an object, tail_hygiene_baseline not an object (null is allowed).

CREATE TABLE mc_cache_frozen_chunks (session_id TEXT NOT NULL, chunk INTEGER NOT NULL, body TEXT NOT NULL,
                                     PRIMARY KEY (session_id, chunk));
INSERT INTO mc_cache_frozen_chunks (session_id, chunk, body)
SELECT s.session_id, e.key / 64, json_group_array(json(e.value) ORDER BY e.key)
  FROM mc_cache_state AS s, json_each(s.core_state, '$.frozen_units') AS e
 GROUP BY s.session_id, e.key / 64;

CREATE TABLE mc_cache_sections (session_id TEXT NOT NULL, section TEXT NOT NULL, body TEXT NOT NULL,
                                PRIMARY KEY (session_id, section));
-- one row per non-empty 'resolved_compartment_boundaries' (json_type = 'array', length > 0)
-- and per 'tail_hygiene_baseline' (json_type = 'object'); no row means absent

ALTER TABLE mc_cache_state ADD COLUMN section_index TEXT NOT NULL DEFAULT '{}';
UPDATE mc_cache_state SET
    section_index = json_patch('{}', json_object('sv', 0,
        'f', json_object('n', <unit count>, 'c', (<unit count> + 63) / 64),
        'b', CASE WHEN <boundary count> > 0 THEN json_object('n', <boundary count>) END,
        't', CASE WHEN json_type(meta, '$.tail_hygiene_baseline') = 'object' THEN json('{}') END)),
    core_state = json_remove(core_state, '$.frozen_units'),
    meta = json_remove(meta, '$.resolved_compartment_boundaries', '$.tail_hygiene_baseline');
```

Four rules in that text answer the review's first blocking finding and N9:

- **`json(e.value)` inside the aggregate.** Under `GROUP BY`, SQLite's sorter drops the JSON subtype of `json_each.value`, and `json_group_array(value ORDER BY key)` then stores every unit as a JSON string. ck-mc's own pass-trace trim already uses the `json(value)` form (`crates/mc-store/src/lib.rs:8645`, `:8660`).
- **Guards with `json_type(...)`.** The tail and boundary sections are selected with `json_type = 'object'` and `= 'array'`, so a JSON `null` can never reach `body NOT NULL` and abort the migration. A shape the codec cannot represent (a scalar unit or boundary, a non-array `frozen_units`, a non-object tail) fails the guard and rolls the migration back, leaving the store at 62 for the previous binary. A JSON `null` list or tail is treated as absent, which is how serde already reads a `null` `Option`.
- **`ORDER BY chunk` restores order.** `chunk` is an INTEGER key and `e.key / 64` is integer division.
- **Boundaries are a section, not chunks** (review N11). Only 5 of 1,400 rows have any, they changed in none of the 46 live commits, and as one row they give `cached_context_boundaries` a single-row read and the v93 cache a content hash for its key.

**Measured round trip through the migration SQL itself.** `migcheck migrate` ran the file unchanged on an APFS clone of the whole live store (`golden/mc/store.db`, WAL folded in). `migcheck verify` then parsed every original row with serde and compared, per row: the units reassembled from chunks in `ORDER BY chunk` with no gap, both section rows, the stripped `core_state` and `meta`, the `section_index` counts, and that no small blob still carries a moved key. It ran with `serde_json`'s `arbitrary_precision` and `preserve_order`, so numbers compare by their text and object key order is kept:

```
migrate sqlite_version=3.46.0 seconds=26.54 wal_bytes=138576232 chunk_rows=4608 chunk_body_bytes=84615028
        section_rows=289 section_body_bytes=8077142 small_core_bytes=109419 small_meta_bytes=3992714 trace_history_rows=75117
verify rows=1400 exact=1400 mismatched=0 shadow_rows=417 rows_with_u0000=281 empty_frozen_units=163
       rows_with_boundaries=5 rows_with_tail=284 units=233235 chunks=4608 index_mismatch=0 moved_key_in_small_blob=0
bytes: chunks_byte_identical=4608/4608 sections_byte_identical=289/289 small_core_byte_identical=1400/1400 small_meta_byte_identical=1400/1400
verify_trace rows=930 exact=930 entries=75117 first_mismatch=None
```

- **All 1,400 rows round-trip exactly**, including 417 `shadow:` rows, 281 rows with `\u0000`, 163 empty `frozen_units`, the 1,395 rows without boundaries and the 1,116 without a tail.
- **Every moved value is byte-identical** to `serde_json::to_string` of the original value. The encoder in section 4.3 relies on this: a chunk the migration wrote hashes the same as the encoder's serialization of the same units, so the first commit after the migration rewrites only the chunks that really changed.
- **The verifier can fail.** With only the aggregate changed to `json_group_array(e.value ORDER BY e.key)`, the same verifier reports `exact=163 mismatched=1237` and `chunks_byte_identical=0/4608`; the first mismatch (`003022e6-…`) fails on `frozen_units` alone. The 163 "exact" rows are the 163 with no units. That matches the review's probe 1.

**Shape fixtures** (`migcheck fixtures`, in-memory stores through the same SQL):

| Fixture | Result |
|---|---|
| Objects with `0.30000000000000004`, `u64::MAX`, `1e400` nested, and a `\u0000` key | migrated; the chunk keeps every number's text and the `\u0000` escape |
| A scalar frozen unit (`0.30000000000000004` at the top level) | refused by the guard; rolled back cleanly |
| A scalar boundary | refused; rolled back |
| `frozen_units` is an object | refused; rolled back |
| `tail_hygiene_baseline` is a string | refused; rolled back |
| `tail_hygiene_baseline` is JSON `null` | migrated as absent: no section row, key stripped |
| `resolved_compartment_boundaries` is JSON `null` | migrated as absent |
| `frozen_units` missing | migrated with `n = 0` and no chunk rows |

A top-level scalar element loses precision through `json_each` (review, probe 1), so the guard refuses it rather than move it. The codec's own round-trip property test (section 5) carries the same fixtures.

**Cost on the clone.** 26.5 s for the whole migration, including the pass-trace ring of section 4.8, at a 1-minute load average of 60 to 100; a second run of the same statements took 14.9 s. It appended 138.6 MB to the WAL, about 360 MB written once checkpointed. The review measured the cache-state part alone at 5.6 to 12.6 s and 104 to 108 MB of WAL. After the migration:

| Table | Size |
|---|---|
| `mc_cache_frozen_chunks` | 4,608 rows, 84.6 MB |
| `mc_cache_sections` | 289 rows, 8.1 MB |
| `mc_cache_state` blobs | `core_state` 0.11 MB, `meta` 4.0 MB in total |
| `mc_pass_trace_history` | 75,117 rows |

The file does not shrink (`auto_vacuum` is NONE); the freed pages are reused by later writes.

### 4.2 `section_index`: the sections version and the digests

The small row's `section_index` column records what the chunk and section rows must hold:

```json
{"sv": 41,
 "f": {"n": 32292, "c": 505, "h": "<32 hex digits>"},
 "b": {"n": 1995, "h": "<32 hex digits>"},
 "t": {"h": "<32 hex digits>"}}
```

- **`sv`, the sections version.** Only the codec's section writers advance it, by one, in the same transaction as the rows they write. No other writer touches the column: `commit_meta`, `historian_claim::store_meta`, `publish_historian_chunk`, the two historian failure writers, `truncate_compartments_for_revert` and the single-store `meta` editors all set `row_version` and `meta` only. A meta-only write therefore never changes `sv` or a digest.
- **`f`** is the frozen-unit list: `n` units in `c` chunks, and `h`, a 128-bit digest over the per-chunk digests in chunk order. Each per-chunk digest is `row_state_hash_128` (`crates/mc-store/src/lib.rs:16405-16439`) of the chunk's stored body.
- **`b` and `t`** are present exactly when the section row exists. Absent means an empty boundary list or no tail baseline; `ModuleMeta` cannot tell an empty list from a missing one (`skip_serializing_if = "Vec::is_empty"`, `lib.rs:4483`).
- **`sv = 0` with no `h` keys** is written only by migration 63. It is the explicit "migrated, not yet hashed" flag the review asked for, in place of r1's `row_version` mismatch. A decoder that meets it checks the structure (`n`, `c`, chunk positions, parseability), computes the digests from the stored bytes, and hands them to the next codec commit, which writes them with `sv = 1`. Codec writers never write `sv = 0`, so this state exists only between the migration and a session's first commit, and the migration's exactness is proven by section 4.1.

### 4.3 The codec

The split stays inside mc-store's row codec. `CoreState` (from `cortexkit-cache-core` in `commons`) and `ModuleMeta` keep their shapes, and the transform logic does not change.

**Decoding.** `decode_row(small, index, chunk_rows, section_rows) -> Result<DecodedRow, CodecError>`:

```rust
struct DecodedRow { row_version: u64, core: CoreState, meta: ModuleMeta, sections: SectionsBase }
struct SectionsBase { sv: u64, frozen: SectionState<FrozenBase>, boundaries: SectionState<HashBase>, tail: SectionState<HashBase> }
enum SectionState<T> { Intact(T), Discarded(DiscardReason) }
struct FrozenBase { chunk_digests: Vec<u128> }      // one per stored chunk, from its stored bytes
struct HashBase { digest: Option<u128> }             // None when the section is absent
enum DiscardReason { IndexUnreadable, LengthMismatch, ChunkCountMismatch, ChunkGap, ChunkUnparseable,
                     DigestMismatch, SectionMissing, SectionUnexpected, SectionUnparseable }
```

- A `Discarded` section decodes to its empty value: no units, no boundaries, `tail_hygiene_baseline = None`. Section 4.6 says what the caller then does.
- `CodecError::MovedKeyInSmallBlob { key }` is a hard error, not a discard: a small blob that still carries `frozen_units`, `resolved_compartment_boundaries` or `tail_hygiene_baseline` means a writer bypassed the codec, and neither copy can be preferred safely. This is the review's N13 option of rejecting such a blob. The pre-split test fixtures that insert raw rows (`crates/mc-module/src/single_store_migrate_tests.rs:264`, `:840`, `:866`; `crates/mc-module/src/single_store_repair_tests.rs:202`; the test at `crates/mc-store/src/lib.rs:17823`; on the v93 branch, `context_boundaries.rs:513` and `:518`, which `json_set` the boundaries) are rewritten to insert small blobs plus chunk and section rows, or to commit through the codec.
- Orphan chunks (rows at or past `c`) are a `ChunkCountMismatch`, so a test that deletes only the `mc_cache_state` row (`crates/mc-module/src/transform.rs:16096`, `:16234`) cannot leave rows that a later decode would silently trust.

**Encoding: a hash diff against the decoded base.** For the frozen list, the encoder serializes every 64-unit slice of the new state, hashes it, and writes chunk `i` only when that digest differs from `base.chunk_digests[i]` (or the base has no chunk `i`). For a section it serializes, hashes, and writes the row only when the digest differs from the base's. Deciding from the serialized bytes rather than from a slice comparison means:

- a chunk is skipped only when the bytes it would write equal the bytes stored at load time, so no index arithmetic can skip a changed chunk;
- the new `f.h` is a digest of the intended content, so a chunk the diff skipped wrongly would still fail the next load's digest check.

This serializes every chunk on every commit, as today's commit serializes the whole `core` (`lib.rs:10384-10388`). Measured on AFT: 6.27 ms minimum to serialize and hash all 505 chunks, against 4.35 ms for today's single `core` serialization (section 4.7).

**The transform commit.** `commit_transform` takes the base it loaded (`TransformCommit::base: Option<&SectionsBase>`) and runs, inside the one `with_conn_fenced` transaction:

1. **Every refusal first** (review N3). `with_conn_fenced` commits whenever the closure returns `Ok` (`commons/crates/cortexkit-store/src/lib.rs:221-264`), and the refusals return `Ok(enum)`, so each must run before the first write:
   - the `row_version` CAS, as today (`lib.rs:10427-10440`);
   - **the sections CAS**: the stored `sv` must equal `base.sv`, or the commit returns `CasConflict` and the pass reloads, through the existing retry (`transform.rs:2428-2467`);
   - `UnhydratedBlockIdentities`, as today (`lib.rs:10447-10450`);
   - **the explicit-clear refusal**: an empty `frozen_units` over a base with `n > 0` is refused unless the caller passes `FrozenClear::Explicit`. This is the rule `refuse_unhydrated_block_identities_tx` (`lib.rs:16269-16291`) applies to identities.
2. **Section writes.** Write each changed chunk and section. Then, unconditionally (review N4):
   - `DELETE FROM mc_cache_frozen_chunks WHERE session_id = ?1 AND chunk >= ?2`, with the new chunk count, not one derived from the base;
   - `DELETE FROM mc_cache_sections WHERE session_id = ?1 AND section = ?2` for each section that is now absent, so a tail baseline going from `Some` to `None`, or the boundaries emptying, deletes the row.
3. **Full rewrites.** A bootstrap commit (`expected = None`) first deletes every chunk and section row of the session, as does reset. A section whose base is `Discarded` is rewritten in full: delete all its rows, then insert. A diff against an empty base would leave a corrupt chunk in place wherever the new content happened to equal it.
4. **The small row.** Upsert `core_state` and `meta` without the moved keys, and `section_index` with `sv = base.sv + 1` whenever any chunk, section or digest changed (otherwise `sv` is kept). The byte-identical skip (`cache_state_blobs_unchanged`) extends to the small blobs and the index.

Any write error returns `Err`, which rolls the whole transaction back.

**The revert re-cut** (review N2). On a revert, `run_transform` adopts the `row_version` returned by `truncate_compartments_for_revert` (`commit_expected = Some(outcome.row_version)`, `transform.rs:5209-5220`) while keeping the base loaded at the earlier version (`:4907`). Under the split this is safe because the truncate is meta-only, and it is pinned two ways:

- the pass counts the version steps it adopted from meta-only writers, and the commit asserts `expected == base_row_version + meta_only_steps`; today that is exactly +1 on a re-cut;
- the sections CAS refuses the commit if anything advanced `sv` since the load. A test asserts that `truncate_compartments_for_revert` leaves `section_index` byte-identical, so it fails the day the truncate starts writing a section.

**Meta-only writers: `commit_meta` and `load_meta`** (review N1). The production callers of `McStore::commit` all follow `load → edit meta → commit(loaded.row_version, &loaded.core, &meta)` and never change `core`:

| Caller | Site |
|---|---|
| `record_fire_decision` | `crates/mc-module/src/lib.rs:6799-6809` |
| `record_no_fire` (13 call sites in `prepare_historian_fire`) | `:6821-6850` |
| `guidance_date_for_session` | `:9462-9488` |
| `record_historian_connect_failure` | `:17908-17937` |
| `persist_historian_state` | `crates/mc-module/src/historian.rs:747-758` |
| `persist_idle_runner_refusal_detail` | `historian.rs:1846-1869` |
| `record_admission_refusal` | `historian.rs:1935-1945` |
| the oversize-admission refusal in `run_historian_firing_on_host` | `historian.rs:2486-2516` |
| `record_reasoning_native_evidence` | `crates/mc-module/src/reasoning_native_evidence.rs:60-77` |

The review counted six; there are nine at this base. They move to a pair of new APIs:

- `load_meta(session) -> MetaSnapshot { row_version, meta }` reads the small row only, with no section and no row-stored identity hydration: 0.04 ms on AFT, against 21 ms for a full load.
- `commit_meta(session, expected, &meta)` encodes `meta` through the codec's small encoder, which drops any moved field a caller might carry, and issues `UPDATE mc_cache_state SET row_version = ?, meta = ?, last_activity_at = ? WHERE session_id = ? AND row_version = ?`. It never touches `section_index`, the chunk and section tables, or the identity tables.

`McStore::commit` stays for tests and bootstraps as a full codec write. A source-scan test pins that production code outside mc-store no longer calls it.

**`prepare_historian_fire` needs `core` only in one branch.** Traced at this base: it reads `loaded.meta` throughout (`lib.rs:6037-6043`, `:6087`, `:6150`, `:6199-6224`, `:6394-6398`, and `HistorianDecisionContext::from_request` at `:3921-3938`). It reads `loaded.core` in two places only:

- `projected_post_drop_percentage` (`:6183-6189`), which returns early when there are no pending agent drops (`:17847-17849`) and otherwise uses only the `red:` units' payload sizes (`:17851-17861`);
- a `debug_assert!` that a fold-only profile has no `red:` units (`:6452-6462`).

It moves to `load_meta`. A full load happens only when `load_pending_agent_drops` returns rows, which is rare, and the debug assertion moves into the transform, which holds `core` already. That removes one full decode from every pass: 21 ms minimum on AFT.

### 4.4 Writers that create, copy or reset state

All of them go through the codec, both to read and to write (review N5):

- **`reset_session_for_recomp`** (`lib.rs:12271-12364`) writes `CoreState::default()`. It becomes a codec full rewrite: delete every chunk and section row, write `{"sv": stored + 1, "f": {"n": 0, "c": 0, "h": …}}`, next to the existing `clear_meta_row_state_tx` (`:12331-12334`). This is the same class of bug migration 55 caused before that clear was added.
- **`apply_state_sync`** (`lib.rs:10751-11114`) reads the raw blobs (`:10807-10841`) and sets `meta.resolved_compartment_boundaries` (`:10854-10856`). It decodes through the codec, writes the boundaries section by hash, and passes `SectionWrite::Keep` for the frozen list, which it does not own, so a state sync never rewrites chunks.
- **`descend_lineage`** (`lib.rs:11430-12077`) copies a source's `core` with filtered frozen units (`:11872-11878`). It decodes the source in full and encodes the target against the target's own base. Its meta-only reads (`:11603`, `:11848`) use `load_meta`. If the source's frozen section is `Discarded`, it copies no units and sets `materialization_required`, which already forces HARD on the target (`transform.rs:3556-3583`, `:4811-4812`).
- **Session deletion** needs no change: `delete_session` deletes from every table with a `session_id` column (`lib.rs:8108-8135`).
- **A writer pin.** A test lists every SQL statement in mc-store and mc-module that writes `mc_cache_state`, `mc_cache_frozen_chunks` or `mc_cache_sections`, and fails when one outside the codec module sets `core_state`, `section_index`, or either new table.

### 4.5 Every reader of a moved key, and how it reads after the split

The search covered every SQL `json_extract`, `json_set`, `json_each`, `json_remove`, `json_type` and `->`/`->>` on `meta` or `core_state`, every raw `SELECT core_state` or `SELECT meta`, and every use of the three field names in Rust, TypeScript, Python and shell. The readers of a moved key:

| Reader | Today | After the split |
|---|---|---|
| `cached_context_boundaries` (`crates/mc-store/src/context_boundaries.rs:169-195`; `:201-235` on `alfonso/v93-merge-check`) | `json_extract(meta, '$.resolved_compartment_boundaries')` over the whole 8 MB record, 3.95 ms on AFT | reads `json_extract(section_index, '$.b')` from the small row (0.01 ms). No `b`: returns empty with no body read. Otherwise the v93 validation cache keys on `(session, b.h, domain, revision)` instead of the 1 MB JSON string, and the body (`SELECT body FROM mc_cache_sections …`, 0.23 ms) is read only on a cache miss. On master, which has no cache, it reads the body |
| `load_compartments`, `load_compartment_boundaries`, `max_compartment_end_ordinal`, `load_compartments_for_range` (`lib.rs:11145-11303`) and the post-sync snapshot check (`:11080-11095`) | through `cached_context_boundaries` | unchanged callers, fixed through it |
| `load_state_sync_inventory` (`lib.rs:8208-8235`) and `handle_session_status_value` (`crates/mc-module/src/lib.rs:8135-8162`), which passes `meta.resolved_compartment_boundaries` to `context_boundaries_resolved` | the boundaries arrive inside the small `meta` | the inventory returns the boundaries read from their section row in the same read transaction, and the status handler passes those. Without this the host is told `context_boundaries_resolved: false` and re-resolves boundaries on every reconnect (`packages/plugin/src/hooks/magic-context/module-state-sync.ts:943-946`) |
| `load_transform_snapshot` (`lib.rs:8241-8382`) | full blob | full codec decode in the same read transaction; returns `SectionsBase` |
| `McStore::load` (`lib.rs:8142-8202`) | full blob | full codec decode; production meta-only callers move to `load_meta` (4.3) |
| `load_session_status_snapshot` (`lib.rs:8386-8445`); status reads `core.boundary_id` and `meta.tail_hygiene_baseline` (`crates/mc-module/src/lib.rs:8332`, `:17629-17635`) | full blob | small row plus the tail section only: 3.41 ms on AFT, against 21 ms. A discarded tail is reported as `cache_sections_discarded` |
| `apply_state_sync` and `descend_lineage` | raw blobs | codec decode (4.4) |
| `scripts/audit-transform-wire-parity-live.ts:691-705` (`rustCavemanCandidate`) | parses raw `core_state` and walks `frozen_units` | reads the chunk rows in `chunk` order, or the read-only view below |
| `scripts/ckmc-write-probe/sqlexp.py` | the r1 cost model | a probe; allowlisted |

Readers of keys that stay in the small row are unaffected: `revert_epoch` (`lib.rs:12581`), `boundary_id` (`:8215-8224`), the meta-only readers at `:10060-10080`, `:11346-11393`, `:12422-12445`, `:13081-13104`, `:13172`, `:13305-13332` and `historian_claim.rs:287-309`, the single-store editors (`single_store_schema.rs:237-267`, `single_store_repair.rs:956-975`, `single_store_migrate.rs:720-726`, `:2596-2613`, `:3621-3627`), `packages/plugin/scripts/cache-parity-baseline.ts:722-723`, `scripts/audit-transform-wire-parity.py:2511-2526`, `scripts/audit-transform-wire-parity-live.ts:1140-1155` and `:1622-1662`, the e2e tests (`rust-maintenance-contract.test.ts:68`, `thinking-block-safety.test.ts:493`, `rust-timeout-epoch-recovery.test.ts:13`, `rust-timeout-double-hard.test.ts:41`, `rust-restart-variant-double-hard.test.ts:37`), and the dashboard, which reads only `session_id` (`packages/dashboard/src-tauri/src/db.rs:3579-3591`). None of the Rust meta-only readers uses a moved field: outside the transform and tests, the only Rust uses of `.resolved_compartment_boundaries` and `.tail_hygiene_baseline` are the ones in the table.

For diagnostics, the migration may also ship a read-only view, `mc_cache_state_full`, that reassembles `core_state` and `meta` with `json_group_array(json(u.value) ORDER BY c.chunk, u.key)` and `json_set`. No product code reads it.

**The test that fails on any SQL read of a moved key.** `no_sql_reads_moved_cache_state_keys` scans `crates/`, `packages/` and `scripts/` and fails, naming the path and line:

- on any JSON path literal starting `$.frozen_units`, `$.resolved_compartment_boundaries` or `$.tail_hygiene_baseline`, in any quoting, outside the migration 63 text;
- on any non-Rust file that names `mc_cache_state` together with one of the three keys, outside `scripts/ckmc-write-probe/`;
- on any Rust `SELECT` of `core_state`, or of `meta` together with a moved key, outside the codec module.

It would have caught `cached_context_boundaries` and `rustCavemanCandidate`, and it catches the v93 tests' `json_set` above.

### 4.6 Fail-closed: from a bad section to a HARD rebuild

Today a load error fails the pass (`transform.rs:3635`, propagated at `:2428-2467` and `:2163-2179`). The plugin counts it toward its three-failure park (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:164`, `:1805-1821`), and nothing turns it into HARD. The split adds an explicit path:

1. **Every full decode checks every digest.** `f.h` is recomputed from the per-chunk digests of the stored bytes, and `b.h` and `t.h` from the section bodies: 2.21 ms on AFT, 1.89 ms on the 731-chunk session (section 4.7). There is no untrusted state other than `sv = 0`.
2. **A mismatch discards the section.** Any `DiscardReason` produces `SectionState::Discarded`, and the decoded state has that section empty. The module logs `mc-cache-sections-discarded` with the session, section and reason, and counts it in session status.
3. **The transform forces HARD.** When `load_transform_snapshot` returns any discarded section, `apply_once` (`transform.rs:3635-3646`) sets the same flag that lineage descent uses to force `PassPlan::Hard` (`lineage_state.force_hard`, `:4811-4812`), with a distinct reason, `cache_sections_discarded`, for the diagnostics. HARD rebuilds the frame from the messages, so the pass serves a correct prefix rather than failing. Any discarded section forces HARD, not only the frozen list, because the frozen frame may have been built against boundaries or a tail baseline that are now unknown.
4. **The commit rewrites the discarded sections in full** (4.3, step 3): delete all their rows, insert the new content, write fresh digests with `sv = stored + 1`. The sections CAS still applies, so a race with another codec writer is a conflict, not a blind overwrite.
5. **The host re-supplies the boundaries.** With the boundary section empty, session status reports `context_boundaries_resolved: false`, and the plugin's next seeding sync resolves and sends them (`module-state-sync.ts:943-946`). Until it does, compartment coordinates fall back to their raw values, the state of a session the host has not synced yet.

**Why a meta-only write can no longer bless a corrupted chunk** (the review's question 3). Digest trust is fenced on `sv`, and only codec writers advance `sv`, in the same transaction as the rows the digest covers. A historian heartbeat bumps `row_version` but leaves `sv` and every digest alone, so a chunk corrupted before the heartbeat still fails the digest on the next load. The one state in which a decoder computes digests from stored bytes, `sv = 0`, is written only by the migration.

The other full loaders handle a discard without forcing anything: status reports it; `prepare_historian_fire` reads the small row only; `apply_state_sync` keeps the frozen section untouched; `descend_lineage` sets `materialization_required`.

### 4.7 Load cost: a budget per pass

Measured with `migcheck loadcost` on the r2 clone, 60 iterations, at a load average of 54 to 60. Parsing goes into `serde_json::Value`, a proxy for the typed structs, so compare the layouts, not the absolute milliseconds.

| AFT (`ses_313660571ffe…`, 505 chunks) | Minimum | Median |
|---|---|---|
| Today: full read | 1.93 ms | 2.13 ms |
| Today: full read and parse | 20.97 ms | 37.15 ms |
| Today: `cached_context_boundaries`' `json_extract` | 3.95 ms | 4.51 ms |
| Today: serialize `core` for a commit | 4.35 ms | 5.24 ms |
| Split: full read (small row, 505 chunks, 2 sections) | 2.26 ms | 2.62 ms |
| Split: full read and parse | 22.43 ms | 54.50 ms |
| Split: digest every chunk and section | 2.21 ms | 2.75 ms |
| Split: small row only (`load_meta`) | 0.04 ms | 0.04 ms |
| Split: small row and tail section (status) | 3.41 ms | 3.80 ms |
| Split: boundary key only (`section_index.b`) | 0.01 ms | 0.01 ms |
| Split: boundary section body | 0.23 ms | 0.27 ms |
| Split: serialize and hash every chunk (encoder) | 6.27 ms | 9.88 ms |

The 731-chunk session (`ses_12a4fa38dffe…`, 46,744 units, the most units of any session) gives 21.93 ms today against 23.13 ms plus 1.89 ms of digest after the split, and 6.89 ms against 7.91 ms to serialize.

**The budget, per new-message pass, AFT:**

| Step | Today | After | Change |
|---|---|---|---|
| `load_transform_snapshot` | 21.0 ms | 22.4 + 2.2 = 24.6 ms | +3.6 ms |
| `prepare_historian_fire`'s load | 21.0 ms (full) | 0.04 ms (`load_meta`) | −21.0 ms |
| Each `cached_context_boundaries` call | 3.95 ms | 0.01 ms (a cache hit) or 0.24 ms (a miss) | −3.7 to −3.9 ms per call |
| The commit's serialization | 4.4 ms | 6.3 ms | +1.9 ms |
| Total, without boundary calls | | | about −15.5 ms |
| Total on v93 (about five boundary calls per pass, per its planning report) | | | about −34 ms |

The rules that keep it there:

- **Exactly one full decode per pass**, in `load_transform_snapshot`. A `#[cfg(test)]` counter on `decode_row` lets a transform test assert one full decode for a new-message pass and none for the historian bookkeeping.
- **The full decode costs at most 5 ms more than today's blob load on AFT** (measured: +3.6 ms with the digest), re-measured with `migcheck loadcost` when the codec lands.
- **`cached_context_boundaries` never decodes the row.** It reads the hash from the small row and the body from the section row only on a cache miss, so planning gets faster than today. Built on the full decode instead it would cost about 21 ms per call (review, question 4).

### 4.8 Also in migration 63: the pass-trace histories as ring rows

`scheduler_history`, `scheduler_interesting_history` and the request history carried inside it (`lib.rs:3711-3776`) become rows of `mc_pass_trace_history(session_id, kind, slot, seq, entry)`, with `kind` one of `scheduler`, `interesting` or `request`, `slot = seq % 256` (32 for `request`), and caps as today. The next sequence per kind lives in three new `mc_pass_trace` columns. Readers order by `seq`, never by `slot`. The migration moves the arrays with `json(e.value)`, drops the two array columns so a reader that names them fails loudly, and creates a read-only view, `mc_pass_trace_history_arrays`, that rebuilds the three arrays with `json_group_array(json(h.entry) ORDER BY h.seq)`. On the clone all 930 trace rows rebuild exactly through the view: 75,117 entries (section 4.1).

Receive and complete then write one ring slot and one small row each, instead of re-serializing about 160 KB. On AFT's SQL replay this takes the split-layout commit from 46.7 frames to 7.7. It changes nothing about cache state or the CAS, because these writes are already outside the cache transaction. It belongs in the same migration so the fleet takes one fence move, not two.

**External readers move in the same slice** (review N10):

- **`packages/plugin/scripts/cache-bust-sentinel.ts:586-610`** selects `*` from `mc_pass_trace` and skips a history column that is not a string, so it would go dark silently. It switches to a join with `mc_pass_trace_history_arrays` when the view exists, falls back to the old columns when it does not, and records a sentinel error, not zero rows, when a trace row has neither. Its test (`cache-bust-sentinel.test.ts:599-633`) builds only the old schema. It gains a fixture created from migration 63's DDL that asserts the sentinel reads scheduler entries from ring rows, and a fixture with neither shape that asserts the error.
- **`scripts/audit-transform-wire-parity.py:2527-2573`** and **`scripts/audit-transform-wire-parity-live.ts:1746-1773`** select the array columns by name. They read the view instead. The Python test fixture (`audit-transform-wire-parity.test.py:1183-1189`, `:1256-1285`) gains a ring-schema variant, and `zero_scheduler_history_rows` (`.py:4319-4328`) becomes a failure when `mc_pass_trace` has rows but the view returns no entries.
- `packages/plugin/scripts/cache-parity-baseline.ts:692` reads counters only and is unaffected.

### 4.9 Interactions

- **LKG.** The plugin's last-known-good replay lives in `context.db` (`lkg_slots`, section 7) and is keyed on the served prefix. Pi keeps its own digests (`pi-lkg.ts`). Neither reads `store.db`'s layout, and the split changes no served bytes.
- **B2 single-store rules.** `store.db` stays a rebuildable cache, and domain rows stay in `context.db` (`docs/architecture/single-store-b2-offline.md:1-12`). The new tables are cache state, so they must not join the moved-table set that `first_populated_moved_table` checks before migration 61 (`lib.rs:7547-7562`). Migration 63 runs after 61 in the ordinary chain. The two single-store `meta` editors edit the small `meta` JSON in place and keep unknown keys; neither touches a moved field or `section_index`.
- **Pi and Claude Code.** One `ck-mc` serves every serializer profile (`opencode-aisdk`, `pi`, `claude-code-anthropic`; `docs/architecture/rust-module.md:78`) from one `store.db` behind one writer lease, keyed by session id, including the `shadow:` rows. The migration and the codec are profile-agnostic.

### 4.10 Alternatives considered

AFT, MB of WAL per event. The first three rows are the review's section 7.

| Option | New-message pass (common) | Historian run (7 commits) | Verdict |
|---|---|---|---|
| Today | 16.8 | about 58 | |
| Fold `record_no_fire` into the transform commit and make the other writers meta-only, keeping one blob | 8.5 | about 58 | a length-changing meta-only `UPDATE` still costs the whole record (2,002 frames) |
| Chunk `frozen_units`, leave the two `meta` sections in the blob | about 2.4 | about 15 | 7x and 4x |
| r1: chunk both lists, tail as a section | 0.56 | about 0.5 | two chunked codec paths |
| **This design: chunk `frozen_units`, both `meta` sections hashed, `commit_meta`** | 0.56 | about 0.5, or about 1.6 when a run changes the boundaries (+1.06 MB, about 260 pages) | one chunked list |
| One row per frozen unit | same as chunks (47.5 against 46.7 frames) | same | a load ten times slower (37 ms) and 8% more storage |
| Pad the blob to a constant length, for SQLite's in-place overwrite | | | `frozen_units` grows without bound, so the record must be re-sized and rewritten anyway |
| Compress the blobs | | | still a whole-record rewrite each pass, plus CPU |
| `synchronous=NORMAL`, or a larger `wal_autocheckpoint` | | | trims the 2.6x multiplier, not the 8 MB |

Positional chunks earn their complexity only for `frozen_units`, which grows by appends. An insert or removal before the tail shifts every later chunk and becomes a full rewrite. That happens on HARD and with the legacy reasoning-unit `retain` (`transform.rs:6485-6486`); it is no worse than today (review N6).

## 5. Invariants and how each will be proven

1. **No wire change.** The change is store-internal, and the transform computes from the same in-memory state.
   - **Proof:** run `drive.ts` against the same golden clone with the same plan under today's binary and the new one. The `served_sha256` of every pass must be equal.
   - **A round-trip property test:** `decode_row(encode_row(core, meta)) == (core, meta)` over fixtures that include AFT-shaped rows with `\u0000` keys, nested edge numbers, empty sessions, a scalar list (which the codec must refuse, as the migration guard does), and random edit sequences: append, truncate, insert before the tail, HARD re-mint, tail `Some → None`, boundaries emptied.
   - **A migration test:** migration 63 on a fixture store with every shape in section 4.1's fixture table, then a codec decode equal to the pre-migration serde parse. `migcheck verify` is the same check on the live clone: 1,400 of 1,400.
2. **Defer passes stay byte-identical.** The stable-pass skip (`transform.rs:6487-6538`) is unchanged. The probe's `defer` passes must keep the same served hash across binaries and must still produce no cache commit. The existing transform tests that assert stable passes do not commit must pass unchanged.
3. **The CAS behaviour is unchanged, and the sections CAS is new.** `row_version` stays in the small row, and every refusal stays before the first write (4.3, step 1).
   - The existing CAS tests in `crates/mc-store` (for example `tests/gate_a1_b0.rs`) pass unchanged.
   - `conflicting_commit_leaves_sections_untouched`: a conflicting pass that carries chunk and section changes leaves every `mc_cache_frozen_chunks` and `mc_cache_sections` row and `section_index` byte-identical. One case each for a `row_version` conflict, an `sv` conflict, `UnhydratedBlockIdentities` and the explicit-clear refusal.
   - `revert_recut_commits_over_a_meta_only_bump` and `truncate_for_revert_leaves_section_index_untouched` (4.3).
4. **No stale section is ever served after a restart or crash.** Atomicity comes from the single transaction; staleness and corruption are caught by `section_index`.
   - A test kills the writer between statements, using the existing `#[cfg(test)]` attempt hook pattern (`transform.rs:6503`), and asserts that the reload equals the pre-commit state.
   - `corrupt_chunk_forces_hard_and_full_rewrite`: overwrite one chunk body, run a pass, assert a HARD pass, a served frame equal to a clean HARD, every chunk rewritten, and fresh digests.
   - `digest_mismatch_survives_meta_only_writes`: corrupt a chunk, run `commit_meta`, a historian claim and a heartbeat, then load: the mismatch is still reported. This is the test r1's trust rule would fail.
   - `orphan_chunks_are_discarded_and_deleted`, `bootstrap_commit_clears_all_session_rows`, `absent_section_deletes_its_row`.
   - `moved_key_in_small_blob_is_rejected`.
5. **No new reader of a moved key, and no writer outside the codec.** `no_sql_reads_moved_cache_state_keys` (4.5) and the writer pin (4.4).
6. **One full decode per pass** (4.7).

The before and after byte claims are re-measured with the same probe: `PROBE_PIN=1` for the per-table split and `PROBE_PIN=0` for live-config bytes, on the CEREB clone, and through `sqlexp.py` on AFT's row.

## 6. Expected result per pass

AFT's row is 7.99 MB. One full-row commit is 8.23 MB of WAL (measured), and one pass-trace rewrite is about 41 frames (163 KB row). Live-config bytes are WAL × 2.6 (measured). These columns are `store.db` only; section 7 adds the plugin's `context.db` writes.

| Pass (AFT) | Today: WAL / written | After split: WAL / written | Split + ring trace: WAL |
|---|---|---|---|
| Stable defer, no new message | about 0.5 MB / 1.3 MB (trace only) | same | about 20 KB |
| New message, historian decision unchanged (1 commit) | 8.5 MB / 22 MB | 0.53 MB / 1.4 MB | about 0.06 MB |
| New message, no-fire changed (2 commits, the common case) | 16.8 MB / 43 MB | 0.56 MB / 1.45 MB | about 0.08 MB |
| Execute with a tail-baseline refresh | about 17 MB / 44 MB | about 1.7 MB / 4.4 MB (the 1.13 MB baseline section, one or two chunks) | about 1.2 MB |
| HARD rebuild | about 16.5 MB / 43 MB | at most 7.4 MB / 19 MB (every chunk plus the baseline; less where re-minted chunks hash the same) | at most 7.2 MB |
| Historian run and publish (7 commits) | about 58 MB / 150 MB | about 0.5 MB / 1.3 MB; about 1.6 MB when the run changes the boundaries | about 0.25 MB, or 1.35 MB |

For CEREB the r2 probe measured the "today" column directly: 3.0 to 3.2 MB of WAL per new-message pass with the current binary's one commit. The after column scales by the same factor.

Applied to the brief's live window (370 MB in 120 s, 46 commits), and assuming roughly 17 large-row commits at 21.3 MB plus 29 small ones at 0.45 MB, as observed:

- **After the split:** about 17 × 0.73 + 29 × 0.45 ≈ 26 MB, around 14x less for ck-mc.
- **With ring rows:** 17 × about 0.2 MB + 29 × about 0.1 MB ≈ 6 MB, around 60x less for ck-mc. The 0.1 MB for a small session is projected, not measured.

These are ck-mc's numbers. The machine's number is bounded by the plugin's own writes until section 7 lands; the review put the combined gain at about 5x, and section 7.3 recomputes it from measurements.

## 7. The plugin's own `context.db` writes (review N12)

### 7.1 Measured on the CEREB clone

Two pinned runs of `drive.ts` with `PROBE_SQL_TRACE=1` on fresh CEREB clones: `n12a`, r1's 17-pass plan with the historian producer, and `n12b`, `first`, six `newmsg` and one `defer`. The trace wraps `bun:sqlite`, which is what the plugin's `Database` is under Bun (`packages/plugin/src/shared/sqlite.ts:320-374`), so it sees every statement the plugin runs. It records each write against `context.db` and the WAL frames each autocommit statement appended (`scripts/ckmc-write-probe/sqlsum.py` prints the per-pass table, and `pluginrows.py` the row sizes in 7.2).

Every new-message pass in both runs:

| Row | Upserts per pass | Bound bytes | WAL frames | What it is |
|---|---|---|---|---|
| `lkg_slots` | 1 | 2.20 to 2.23 MB | 541 to 548 (2.2 MB) | `saveLkgSlotToDb` (`packages/plugin/src/hooks/magic-context/lkg-persist.ts:159-234`): the fingerprint changes, so the whole slot is upserted |
| `session_meta` | 1 effective write, out of 5 statements | 1.05 MB (the 0.53 MB document, bound twice) | 278 (1.15 MB) | `updateReplayDocument` (`packages/plugin/src/features/magic-context/storage-replay-document.ts:233-279`) rewrites the whole `trailing_blank_decisions` document, binding it twice (new value and the compare-and-swap's old value) |
| the other 4 `session_meta` statements | `INSERT OR IGNORE`, `memory_block_ids`, `channel2_nudge_*` | under 1.3 KB | 0 | no-ops or same-length writes |

- **These two rows are the whole `context.db` write of a pass.** A new-message pass appended 820 to 826 frames to `context.db`; the two rows account for 820 to 826 of them. Across `n12a`'s 17 passes, `dbstat` attributes 8,204 of the 8,248 frames (99.5%) to `session_meta`, `lkg_slots` and the pages their earlier versions freed. ck-mc's own `context.db` writes were 12 frames of compartments.
- **The plugin writes more than ck-mc in a pass.** The same new-message pass appended 3.0 to 3.2 MB to `store.db` from ck-mc and 3.38 to 3.40 MB to `context.db` from the plugin.
- **Any length-changing write to `session_meta` rewrites the whole record.** In `n12a`'s execute pass, `UPDATE session_meta SET pending_compaction_marker_state = NULL` bound 123 bytes and appended 278 frames, the whole 1.1 MB record. In the defer pass after it, a 60-byte `note_nudge_trigger_message_id` update inside a transaction cost the same 278 frames at its commit. The replay document is only the most frequent such write.
- **A same-length write is nearly free.** A `defer` pass whose LKG slot keeps its length still upserts it, and SQLite's in-place overwrite then writes only the changed page: 1 frame for 2.2 MB of bound data.
- **The changes are tiny appends.** For each new-message pass, `n12b` compared every bound string of 64 KiB or more with the same statement's previous value. The LKG `json_prefix` grew by 4,400 characters, and its common prefix with the previous value was the whole previous string except the closing `]`: 1 of 33 or 34 positional 64 KiB chunks changed (2 when the string crossed a chunk boundary). The replay document grew by 40 characters per message, and 1 of its 9 chunks changed.

### 7.2 Row sizes for AFT, ALF and CEREB

From the r2 clone of `context.db`, the bytes one write of each row rewrites:

| Session | `lkg_slots` row | of which `json_prefix` | `session_meta` row | of which `trailing_blank_decisions` | `cached_m0_bytes` | Other columns over 10 KB |
|---|---|---|---|---|---|---|
| AFT | 1.45 MB | 1.32 MB | 2.38 MB | 1.42 MB (34,748 decisions) | 0.61 MB | mural data URL 118 KB, `stripped_placeholder_ids` 101 KB, `memory_block_cache` 46 KB, `note_nudge_anchors` 28 KB, `stale_reduce_stripped_ids` 26 KB, `merged_reasoning_stripped_ids` 17 KB, `auto_search_hint_decisions` 15 KB |
| ALF | 2.49 MB | 2.31 MB | 3.05 MB | 2.12 MB (52,046 decisions) | 0.50 MB | `stripped_placeholder_ids` 136 KB, mural 118 KB, `merged_reasoning_stripped_ids` 70 KB, `note_nudge_anchors` 43 KB, `stale_reduce_stripped_ids` 25 KB, `cached_m1_bytes` 19 KB |
| CEREB | 2.20 MB | 2.15 MB | 1.13 MB | 0.53 MB (12,870 decisions) | 0.48 MB | `stripped_placeholder_ids` 38 KB, `merged_reasoning_stripped_ids` 21 KB, mural 19 KB, `note_nudge_anchors` 13 KB, `auto_search_hint_decisions` 11 KB |

`session_meta` has 119 columns. Every stored replay document is the v2 envelope with `trailingBlank` as its only namespace. Store-wide, `lkg_slots` holds 1,349 rows and 698 MB of `json_prefix` (the largest 7.3 MB), and 12,254 `session_meta` rows hold 17.7 MB of replay documents and 17.1 MB of `cached_m0_bytes`.

Assuming AFT and ALF write each row once per new-message pass, the pattern measured on CEREB, a pass costs AFT 1.45 + 2.38 = 3.8 MB and ALF 2.5 + 3.05 = 5.5 MB of `context.db` WAL. The per-pass counts on AFT and ALF themselves were not driven.

### 7.3 What the plugin's writes do to the machine-wide gain

| Common new-message pass, WAL | ck-mc `store.db` | plugin `context.db` | Total | Gain |
|---|---|---|---|---|
| CEREB today (r2, measured) | 3.0 MB | 3.4 MB | 6.4 MB | |
| CEREB, ck-mc split only | about 0.2 MB | 3.4 MB | 3.6 MB | 1.8x |
| CEREB, ck-mc split and the plugin slice | about 0.2 MB | about 0.2 MB | about 0.4 MB | about 16x |
| AFT today (2 commits, one write of each plugin row) | 16.8 MB | 3.8 MB | 20.6 MB | |
| AFT, ck-mc split only | 0.56 MB | 3.8 MB | 4.4 MB | 4.7x |
| AFT, ck-mc split, ring rows and the plugin slice | 0.08 MB | about 0.3 MB | about 0.4 MB | about 50x |

The plugin slice's "after" figures are projected from the measured appends in 7.1: one or two 64 KiB LKG chunks (about 17 to 34 pages), the LKG row's remaining metadata (54 KB on CEREB, 126 KB on AFT), one replay-decision row, and no `session_meta` record rewrite. They are not measured.

### 7.4 The plugin-side slice

A separate slice in the TypeScript plugin, with its own `context.db` migration. It is independent of `store.db` migration 63 in code, process, store and artifact, but the machine-wide gain needs both.

**It needs a `context.db` schema change.** No write pattern inside today's schema avoids the rewrites: SQLite rewrites the whole record whenever its length changes, and both rows grow on every message. ck-mc reads neither table (no Rust code references `lkg_slots` or `session_meta.trailing_blank_decisions`), so the change is plugin-only. `context.db` is at 92 on master and 93 on `alfonso/v93-merge-check` (`packages/plugin/src/features/magic-context/migrations.ts:3160`). The slice takes the next version after whichever lands first, and it can ride the v93 coordinated restart, which already rebuilds the plugin and restarts ck-mc together.

1. **LKG prefix as positional chunks.**
   - New table `lkg_slot_chunks(session_id TEXT NOT NULL, chunk INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY (session_id, chunk))`. `lkg_slots` keeps the metadata, and gains `json_prefix_chars`, `json_prefix_chunks` and `json_prefix_hash` in place of `json_prefix`.
   - Chunks are 64 KiB slices of the exact `jsonPrefix` string, so the single-stringify rule (`lkg-persist.ts:18-20`) holds: the string is cut and concatenated, never re-serialized.
   - `saveLkgSlotToDb` keeps a hash per chunk next to the fingerprint it already keeps (`lkg-persist.ts:157-180`), and in one transaction writes only the chunks whose hash changed, deletes chunks at or past the new count, and upserts the small row. After a process restart, `loadPersistedLkgSlot` computes those hashes as it reads, so the first save does not rewrite every chunk.
   - On load, the chunks are concatenated in `chunk` order and checked against the count, length and hash. A mismatch is treated like today's malformed row: the slot is cleared and not replayed (`lkg-persist.ts:253-260`).
   - The input arrays (`input_id_seq`, `input_content_digests`, `input_content_signatures`: 53 KB on CEREB, 126 KB on AFT, 174 KB on ALF) stay in the small row for now. They are rewritten on each pass and are the next target if they grow.
   - The migration moves existing rows with `substr` in SQL, or simply drops the slots: the LKG is a recovery cache that the next applied pass recaptures.
2. **Replay decisions as rows.**
   - New table `session_replay_decisions(session_id TEXT NOT NULL, message_id TEXT NOT NULL, decision TEXT NOT NULL, PRIMARY KEY (session_id, message_id)) WITHOUT ROWID`. The rows are small, which is the case `WITHOUT ROWID` suits.
   - `updateReplayDocument`'s whole-document compare-and-swap becomes per-key upserts that keep a per-key compare: `INSERT … ON CONFLICT(session_id, message_id) DO UPDATE SET decision = excluded.decision WHERE decision IS NOT excluded.decision`. Mutators already touch a handful of keys per pass.
   - `readReplayTrailingBlankSubset` (`storage-replay-document.ts:170-212`) reads the ids it needs with `IN (…)` instead of parsing a document of up to 2.1 MB.
   - The migration moves the map with `json_each(trailing_blank_decisions, '$.trailingBlank')` for v2 documents and over the top level for v1. It must replicate `parseReplayDocument`'s v1/v2 test, because a v1 map may contain an assistant id named `version` (`storage-replay-document.ts:106-108`). Every stored document is v2 today. Namespaces other than `trailingBlank` (`piNative` on Pi) stay in the column, which then holds only the envelope.
3. **The other cold blobs out of `session_meta`.** Because any length-changing update rewrites the whole record (7.1), moving only the replay document still leaves AFT's record at about 1 MB. `cached_m0_bytes` and `cached_m0_mural_data_url` (0.5 to 0.7 MB together) move to a side table keyed by `(session_id, name)`, and the id-set columns over 10 KB can follow. That leaves a `session_meta` record of a few tens of KB on these sessions, so the small per-pass updates (nudge state, compaction markers, memory block ids) stop costing a megabyte each.

Order: 1 and 2 first, since they are the per-pass writes measured in 7.1; then 3. Each is proven the same way as the ck-mc slice: the SQL write trace on a clone shows the per-pass frames, and the plugin's existing LKG replay and replay-document tests pass unchanged.

### 7.5 Items 1 and 2 as built: `context.db` migration 94

Items 1 and 2 shipped as `context.db` migration 94 (`packages/plugin/src/features/magic-context/migration-v94-write-split.ts`). Item 3, moving the cached m[0] blobs out of `session_meta`, is deferred (7.6). Where the build differs from 7.4:

- **Each slice stores its own hash.** `lkg_slot_chunks` is `(session_id, chunk, hash, body)`. A save reads the stored slice hashes, which sit before `body` so the read never walks overflow pages, and writes only the slices that differ. The first save after a restart is therefore small even when nothing loaded the slot first, and a save after another connection's save cannot skip a slice it wrongly believes is unchanged. A load checks the count, the total length, each slice against its hash, and the whole-prefix hash.
- **The migration moves only slots captured in the last 24 hours.** Older slots are dropped, and the next applied pass recaptures them. On a 2026-10-01 clone of the live `context.db` (1,343 slots, 704 MB), moving every slot took 34 to 73 s at load averages of 40 to 60, while holding the write lock every starting process needs. Moving the last day's slots (276 to 280 slots, 195 to 199 MB) and the replay decisions (376,588 rows, 951 sessions) took 3.2 s warm and about 21 s cold at a load average of 50. End to end, the first open (v92 to v94) took 16.5 to 46.5 s. The first plugin start after placement pays this cost once, so place in a quiet window, as for store.db migration 63.
- **A replay document that does not parse strictly stays in the column, unchanged.** Readers overlay the decision rows on whatever map the column still carries, so such a session keeps today's behaviour: lenient readers see its valid entries and strict writers refuse it.
- **Each decision write compares against the value it read.** Instead of the `WHERE decision IS NOT excluded.decision` upsert in 7.4, a decision is inserted only if absent, or updated only `WHERE decision IS` the value the mutator saw. On a conflict the batch rolls back and is decided again, so a concurrent strip is never overwritten.

Measured on CEREB clones with `drive.ts` (`PROBE_PIN=1`, plan `first`, six `newmsg`, one `defer`). The synthetic message clock was fixed for both runs, so the served hashes are comparable:

| Pass | `context.db` WAL, v93 | after v94 | Served SHA-256 |
|---|---|---|---|
| `first` | 875 frames (3.60 MB) | 477 frames (1.97 MB): 30 of 37 slices differ from the slot captured on the live host | equal |
| `newmsg` ×6 | 876 to 882 frames (3.61 to 3.63 MB) | 21 to 29 frames (0.09 to 0.12 MB) | equal on every pass |
| `defer` | 1 frame | 1 frame | equal |

On a new-message pass after v94, the LKG write is one changed slice plus the metadata row (4 to 24 frames), and the replay decision is one row (1 frame). No `session_meta` record is rewritten. That is under the 0.2 MB projected in 7.3.

### 7.6 Follow-up: item 3 needs a coordinated change

`cached_m0_bytes` and `cached_m0_mural_data_url` cannot move out of `session_meta` in a plugin-only change, because writers outside the plugin set them directly:

- ck-mc's `single-store-repair-history` clears both columns on `context.db` (`crates/mc-module/src/single_store_repair.rs:61-63`, applied at `:834-849`). After a move it would leave the side table's stale m[0] in place, and the next pass would replay it.
- The dashboard reads `cached_m0_bytes` for its token breakdown (`packages/dashboard/src-tauri/src/db.rs:1505`) and clears it (`:5827`).
- `packages/cli` `migrate-session.ts:391` clears it too.

Item 3 is therefore one change across ck-mc, the dashboard and the CLI together with the plugin. A trigger that keeps the external writers correct was rejected, because it hides SQL behaviour. Until item 3 lands, a length-changing `session_meta` update still rewrites the whole record. Section 7.1 measured these only on execute and nudge passes, not on the common new-message pass.

## 8. Rollout

- **The fence.** `store.db` goes from 62 to 63. Migration 63 is the next number on both `master` and `alfonso/v93-merge-check` (`window/b0-v92-v93` is at 60, and no branch defines 63; review, section 5). If another `store.db` migration lands first, renumber at merge time. The plugin slice of section 7 moves the `context.db` fence separately.
- **Placement.**
  - Take `scripts/backup-live-stores.sh` first. A rollback is the previous binary together with both stores from the same backup (`docs/architecture/rust-module.md:57`).
  - `scripts/place-ck-mc.sh` accepts the staged binary because staged 63 ≥ live 62 (`:57-79`). After placement it refuses any binary whose fence is below 63.
  - The first open runs the migration inside `McStore::open`, as one transaction with its version record. On a clone of the live store it took 14.9 to 26.5 s at a load average of 54 to 100 (section 4.1).
- **What sessions see during that open** (review N8). This is not like an ordinary ck-mc restart, whose store opens in milliseconds:
  - the store opens in a `spawn_blocking` task after HELLO_ACK, so the module's runtime and ck-subc's health probe stay responsive (review, section 5: the first probe is due 30 to 33 s after registration, with a 5 s deadline and three failures before a restart);
  - each request waits at most 500 ms for the open (`STORE_OPENING_REQUEST_WAIT`, `crates/mc-module/src/lib.rs:266`) and is then refused with `store_opening` (`:475`);
  - the OpenCode plugin counts each refused transform as a failure and serves LKG replay where a slot exists (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3984-4017`, `markFailure` at `:1805-1821`);
  - three consecutive failures (`RUST_FAILURE_PARK_THRESHOLD`, `:164`) park the session with "Magic Context's engine is reconnecting". A parked session retries every fifth pass (`RUST_PARK_RETRY_INTERVAL`, `:165`), or sooner under pressure (`:167`, `:2441-2459`).

  So a session that sends three transforms inside the 15 to 27 s window parks and recovers on a later retry. No state is lost, because the migration commits or rolls back as one transaction. Place in a quiet window.
  - Check `ck health magic-context` afterwards, plus a probe pass on a clone of the migrated store.
- **An older ck-mc against the new schema** refuses to open. `McStore::open` returns `StoreAheadOfBinary { db_version: 63, binary_max: 62 }` before reading or writing a row (`lib.rs:7563-7581`), and health reports `open_refused_store_ahead` (`docs/architecture/rust-module.md:59-65`). It never sees a `core_state` without `frozen_units`, so it cannot mistake a migrated session for an empty one. A migration that fails a shape guard leaves the store at 62, so the previous binary still opens it.
- **Order of slices.**
  1. The codec, `load_meta` and `commit_meta`, and migration 63's cache-state part, with the tests of section 5.
  2. The readers of section 4.5, with `no_sql_reads_moved_cache_state_keys`.
  3. The pass-trace ring rows and their external readers (4.8), in the same migration but a separate commit.
  4. The probe evidence: equal served hashes and the before and after bytes, attached to the review.
  5. The plugin slice of section 7, separately, with its own `context.db` migration.

## 9. Not covered here

- **No implementation exists**, so nothing drives a real ck-mc through the split. The served-hash invariant and the crash, CAS and fail-closed tests of section 5 remain to be proven with the code.
- **Parse costs are proxies.** `migcheck loadcost` parses into `serde_json::Value`, not the typed `CoreState` and `ModuleMeta`, and every timing comes from a machine at a load average of 26 to 100.
- **AFT was not driven through a real module.** Its ck-mc numbers come from the SQL replay; its plugin numbers assume one write of each row per pass, as measured on CEREB.
- **The HARD "after" figure is an upper bound.** How many re-minted chunks come out byte-identical is not measured.
- **The plugin slice's "after" numbers are projected** from the measured appends, not measured.
- **The v93 planning call count** (about five `cached_context_boundaries` calls per pass) comes from the v93 report, as in the review.

## Appendix A. The review's items and where this note answers them

| Review item | Where |
|---|---|
| Blocking 1: the migration SQL corrupts rows; re-run the round trip through the real SQL | 4.1: `json(e.value)`, `json_type` guards, 1,400 of 1,400 exact through `migration63.sql`, and the 1,237-row failure of the old aggregate |
| Blocking 2: unlisted readers of moved keys (`cached_context_boundaries`, `load_state_sync_inventory`) | 4.5: every reader and its post-split read; the v93 cache keyed on the section digest; `no_sql_reads_moved_cache_state_keys` |
| Blocking 3: fail-closed has no code path; digest trust erased by meta-only writes | 4.2 (`sv`), 4.3 (`SectionState::Discarded`, full rewrite), 4.6 (HARD path) |
| N1: `commit_meta`; `prepare_historian_fire` and `core` | 4.3: nine callers, `load_meta`, the traced `core` use |
| N2: the revert re-cut's version step | 4.3: `meta_only_steps` and the sections CAS |
| N3: refusals before the first write | 4.3, step 1 |
| N4: unconditional deletes; bootstrap clears; `Some → None` | 4.3, steps 2 and 3 |
| N5: reset, state sync and lineage through the codec | 4.4 |
| N6: positional chunks and non-tail edits | 4.10 |
| N7: a load-cost budget with numbers | 4.7 |
| N8: the open-time park | 8 |
| N9: guards and a scalar fixture | 4.1 |
| N10: the sentinel and wire-parity scripts | 4.8 |
| N11: boundaries as a hashed section | 4.1, 4.2 |
| N12: the plugin's `context.db` writes | 7 |
| N13: pre-split fixtures | 4.3: the decoder rejects a moved key, and the fixtures are listed |
