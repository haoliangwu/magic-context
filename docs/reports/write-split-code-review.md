# Adversarial review: the ck-mc state split (store.db 63) and the plugin write split (context.db 94)

Reviewed tree: `alfonso/restart-window` at `a2ee94ef7b`. It merges master, context.db v93, the reasoning-removal change, the plugin write split (`a3272501ee`, context.db v94) and the ck-mc state split (`047acf798d`, store.db 63). Specs: `docs/reports/ckmc-write-amplification-design.md` (r2, section 7 for the plugin) and `docs/reports/ckmc-state-split-results.md`.

This is a read-only review. Every probe was throwaway: the Rust probes were added to test files and removed with `git checkout -- <path>`, and the bun probes lived in an untracked directory that was deleted. `git diff --stat` was empty afterwards. Building the probes also rewrote `Cargo.lock` (a `cortexkit-log` 0.3.3/0.3.4 resolution flip); that was reverted too. Live stores were read only through `cp -c` into `$TMPDIR/magic-context/split-review/`. Probe 1 printed `lsof -p` for its own process, and the only database files open were that directory's `context.db`, `-wal` and `-shm` (output below). The Rust probes used `tempfile` directories.

Verdict legend: **OK** means the claim holds, **RISK** means it holds with a caveat worth fixing, and **FINDING** means it does not hold as stated.

---

## ck-mc (crates/mc-store, crates/mc-module)

### 1. Writers and readers of `mc_cache_state`, chunks and sections

**Atomicity: OK.** Every store.db writer runs inside `with_conn_fenced`. That is an IMMEDIATE transaction that commits only when the closure returns `Ok`, and an `Err` rolls it back (`~/.cargo/registry/.../cortexkit-store-0.2.0/src/lib.rs:217-265`). The chunk and section writes (`cache_codec::write_sections`, `cache_codec.rs:849-985`) and the small-row upsert (`upsert_small_row`, `cache_codec.rs:786-814`) always run in the same closure:
- `commit_transform` (`lib.rs:10716-10752`)
- `write_cache_state_tx`, used by lineage descent and reset (`lib.rs:16640-16683`)
- `apply_state_sync` (`lib.rs:11281-11298`)

Every full read happens inside one read transaction, so a reader never pairs rows from two commits: `load` (`lib.rs:8387-8402`), `load_transform_snapshot` (`lib.rs:8605`), `load_session_status_snapshot` (`lib.rs:8728-8781`), `load_state_sync_inventory` (`lib.rs:8546-8564`) and `read_boundary_body_consistently` (`context_boundaries.rs:205-223`).

**Chunks without the small row, or the reverse: OK.** Any chunk or section write sets `wrote`, which advances `sv` (`cache_codec.rs:968-970`). The index then differs from the stored one, so `blobs_changed` is true and the small row is written with the new index and `row_version` (`lib.rs:10735-10753`). The "unchanged, skip the upsert" branch (`lib.rs:10754-10762`) can therefore only run when no chunk or section row was written. The test-only `FAIL_COMMIT_AFTER_SECTION_WRITES` hook returns `Err` between the section writes and the small row (`lib.rs:10726-10729`); because `Err` rolls the transaction back, `a_writer_killed_between_statements_reloads_the_pre_commit_state` covers the crash case.

**Writers outside the codec (meta only) never touch chunks, sections or `section_index`. OK, with a caveat.** These writers rewrite `meta` with `serde_json::to_string(&ModuleMeta)`, not `encode_small_meta`:
- `truncate_compartments_for_revert` (`lib.rs:12640`)
- the two historian abandon paths (`lib.rs:13307`, `:13364`)
- `publish_historian_chunk` (`lib.rs:13600`)

They do not write the moved keys back into the small blob only because `ModuleMeta` declares `skip_serializing_if` on both moved fields (`lib.rs:4620-4621`, `:4890-4891`) and the meta they edit was parsed from a small blob that has neither key. That coupling is implicit, so I removed the attribute on `resolved_compartment_boundaries` (mutation below). Thirteen mc-store tests went red, including `truncate_compartments_for_revert_deletes_suffix_and_bumps_epoch` and `publish_historian_chunk_is_cas_gated_and_double_publish_conflicts`. The coupling is defended, though only indirectly.

**A stale section served after a crash: OK.** There are no torn writes, and a value that fails its index is discarded (see 3). One caveat (**RISK**): a row migration 63 wrote carries `sv = 0` and no digests. Until that session's first codec commit, the decoder trusts its bytes as they are (`cache_codec.rs:617-618`, `:656`). The first commit then records digests computed from whatever is stored (pinned by `a_migrated_row_is_trusted_from_its_bytes_until_its_first_commit`). A bypass write during that window would be blessed. The only plausible bypass writer is an older binary, and `McStore::open` refuses older binaries (design 8), so the practical risk is low. The comment at `store_063_cache_split.sql:72-73` says the digests "are filled in by the open-time backfill", but no backfill exists. The comment is stale.

**Base-diff ABA (RISK, fail-closed).** `sv` restarts at 1 after a delete and bootstrap, because there is no stored index (`cache_codec.rs:858`, `:968-969`). A pass that loaded `(row_version 1, sv 1)` before a `delete_session` and a fresh bootstrap would pass both checks and diff against the wrong base. It still cannot serve corruption: the index digest is computed from the encoded chunks, not the stored ones (`cache_codec.rs:906-911`), so any chunk the diff skipped wrongly fails `DigestMismatch` on the next load, and the pass goes HARD. The same ABA existed on `row_version` before the split.

### 2. The base-diff invariant and every `row_version` bump

| Writer | Where | Touches chunks/sections/index? | Verdict |
|---|---|---|---|
| `commit_transform` | `lib.rs:10614-10646` (row_version CAS, then `sv == base.sv` when a base is passed), `:10702-10715` (no base: the base is decoded inside the transaction) | yes, through `write_sections` | OK |
| `commit_meta` | `lib.rs:8485-8533` | no (`meta`, `row_version`, `last_activity_at`) | OK |
| historian claim, heartbeat and the other `store_meta` callers | `historian_claim.rs:312-340` | no | OK (does not update `last_activity_at`, a cosmetic difference from `commit_meta`) |
| `truncate_compartments_for_revert` (the revert re-cut) | `lib.rs:12535-12650`; adopted by the pass at `transform.rs:5272-5282` | no; changes only `revert_epoch` and `last_recut`, both of which the pass adopts | OK. `meta_only_steps` is checked at `lib.rs:10562-10571` |
| historian abandon and publish-failure | `lib.rs:13290-13330`, `:13350-13390` | no | OK |
| `publish_historian_chunk` | `lib.rs:13585-13625` | no | OK |
| lineage descent | `lib.rs:11791`, `:11864`, `:11922`, `:12201` | yes, through `write_cache_state_tx` | OK |
| `reset_session_for_recomp` | `lib.rs:12503` | yes: no base, so every row is cleared first | OK |
| `apply_state_sync` | `lib.rs:11041-11298` | yes, decoding and writing in one transaction | OK (see 3) |
| `reset_cache_state_for_single_store` | `single_store_schema.rs:260` | no (in-place JSON edit of `meta`); offline migration | OK |
| `reset_store_caches` | `single_store_repair.rs:972` | no; offline repair | OK |

Every writer that bumps `row_version` without touching the split rows leaves a loaded base valid for those rows. Every writer that does touch them advances `sv`. The sections CAS (`lib.rs:10642-10646`) therefore catches every way the stored rows could stop matching the loaded base, and the row_version CAS catches every meta change the pass did not adopt.

**`commit_meta` carries the row-state digest forward: safe, and it cannot re-bless corrupted chunks.** `advance_row_state_digest_tx` (`lib.rs:16688-16700`) moves `mc_cache_state_digest.row_version` only when it described the version being replaced. That digest is `row_state_fingerprint(meta)` (`lib.rs:16523-`), a fingerprint of the block-identity and served-output rows. It does not cover the chunks, and `commit_meta` touches none of the rows it covers. The chunk digests live in `section_index`, which `commit_meta` never writes.

Probe 3 below corrupted a chunk and then ran `commit_meta`:
- `digest_rv` moved from 1 to 2;
- `section_index` and the chunk rows were byte-identical before and after;
- the next load still reported `Discarded(DigestMismatch)`.

The digest does not verify the stored identity rows against their bytes. That was already true before this change: carrying the digest forward adds no exposure.

Several bumps do not advance the digest: `apply_state_sync`, truncate, abandon and publish. The next transform then walks every identity row once. That is a performance cost only ("untrusted, not wrong", `lib.rs:16608-16614`).

### 3. Fail-closed

**Digest mismatch → discard → HARD → full rewrite: OK on the main path.** End to end:
1. `load_transform_snapshot` decodes the row (`lib.rs:8605`).
2. `decode_frozen` returns `Discarded(DigestMismatch)` and an empty list (`cache_codec.rs:614-620`), and the discard is logged (`lib.rs:16704-16714`).
3. `transform.rs:3667-3673` sets `force_hard`; `:4858-4863` sets `plan = Hard` (unconditionally for a discard, including subagent passes); `:4888-4890` sets the reason `cache_sections_discarded`.
4. The commit at `transform.rs:6572-6585` passes `base = loaded.sections` and `FrozenClear::Explicit`. `commit_transform` runs the sections CAS (`lib.rs:10642-10646`).
5. `write_sections` sees the discarded base, deletes every chunk and upserts every chunk (`cache_codec.rs:877-899`). The index records fresh digests at `sv + 1`.
6. On a CAS conflict the pass reloads, finds the value still discarded, and retries, bounded by `MAX_CAS_RETRIES` (`transform.rs:2452-2461`).

`corrupt_chunk_forces_hard_and_full_rewrite` (`transform.rs:30390`) pins this.

**FINDING (fail-closed but wedged): the compaction-off path never repairs a discarded frozen list.** `apply_once` hands compaction-off sessions to `apply_additive_only` (`transform.rs:3489-3490`). That function loads with `store.load` (`:2954`) and never consults `SectionsBase::any_discarded`. An empty list on an initialized session is neither a valid m0/m1 shape nor "m1 missing", so `classify` returns `Reject("unknown frozen-set shape")` (`mc-core/src/lib.rs:124-130`), and the pass errors at `transform.rs:3094-3096` before it reaches the commit. Nothing ever rewrites the chunks, so every later pass rejects the same way. Probe 4 below shows three consecutive `UnknownShape` errors and a list still `Discarded(DigestMismatch)` afterwards. Nothing wrong is served, but the session needs a manual reset. The fix is to route a discard on that path to its HARD arm (or `MigrateHard`), as `apply_once` does.

**`apply_state_sync` over a discarded list keeps the stored chunks (`lib.rs:11273-11280`): safe, lossy, and misreported.** Probe 3 confirmed each part:
- The frozen index entry and the chunk rows are unchanged, and `sv` stays 1 because nothing in the split rows was written.
- The next load still reports `Discarded(DigestMismatch)`, so the next transform still goes HARD. It does not freeze a truncated list as intact. This is the safe direction.
- The drop seed in the request is lost: `seed_unit_present=false`.
- The result reports `drop_seeds_skipped=0` for the seed it just discarded.

The loss is bounded: the HARD rebuild re-derives the reductions it can from current state, and a discard needs corruption or a bypass writer in the first place. The misreported counter is worth fixing, so a host can tell that its seeds did not land. There is no test for the Keep branch.

### 4. `FrozenClear::Explicit` on transform commits

**OK.** The two transform commits that pass `Explicit` are `transform.rs:3345-3348` (compaction-off) and `:6581-6585` (main). Both diff against the `loaded` they derived the core from.

The empty-frozen-list refusal exists for one case: a non-empty stored list that is empty in memory. In a full decode that happens only through a discard. `decode_frozen` returns `Intact` only when the unit count equals the index's `n` and every chunk passes the count and digest checks (`cache_codec.rs:596-638`). A missing `f` entry with an `sv >= 1` also discards, because `h` is then `None` with a non-zero `sv`.

- **Main path:** a discard forces HARD, which always produces m0 and m1, so an empty commit cannot happen. If it did, it would only delete chunks that are already untrusted.
- **Compaction-off path:** a discard is rejected before the commit (the finding in 3), so `Explicit` is never reached with an empty list.

I found no transform path whose in-memory list is legitimately empty while the store holds units that are trusted.

### 5. Migration 63

**Shape guards: OK.** Five zero-count guards on a temporary table with `CHECK (bad_rows = 0)` (`store_063_cache_split.sql:9-36`):
- `frozen_units`, when present, must be an array, and each element must be an object;
- the boundaries, when present, must be an array or null, with object elements;
- the tail baseline, when present, must be an object or null.

An absent key passes, because `json_type` is SQL NULL and `NULL NOT IN (...)` is not true.

Row shapes:
- an absent or empty `frozen_units` gives no chunks and `f:{n:0,c:0}`;
- absent, null or empty boundaries give no section row and no `b` entry;
- a null or absent tail gives no row and no `t` entry (`:47-90`).

Malformed JSON in `core_state` or `meta` makes `json_type` raise an error. That also aborts the batch.

A unit that is an object but not a valid `FrozenUnit` passes the guard, and the codec later discards it as `ChunkUnparseable` (decoded empty, then HARD). Before the split the same row was a hard decode error, so this is an improvement.

**Leave-at-62: OK.** A guard failure fails the one batch, which runs in one transaction with its version record, so the store stays at 62. This is pinned by `a_failed_migration_63_guard_leaves_the_store_at_62` (`cache_codec/tests.rs:1021`). The previous binary then opens the store. The new binary fails every open until it is rolled back. That is the intended trade-off, but operators should expect it.

**The `include_str` split: OK, verified byte for byte.** `MIGRATIONS[63].statements` is `concat!(store_063_cache_split.sql, store_063_pass_trace_ring.sql)` (`lib.rs:3152-3170`). `migration_63_is_the_text_migcheck_verified` asserts it equals `scripts/ckmc-write-probe/migcheck/migration63.sql` (`cache_codec/tests.rs:881-890`). I checked the concatenation independently:

```
$ cat store_063_cache_split.sql store_063_pass_trace_ring.sql | cmp - scripts/ckmc-write-probe/migcheck/migration63.sql && echo ...
concat == migcheck/migration63.sql
cf39db34d0b74f3adba9b5ba486411ab0e79462e5bf0477e92b5f5196f9ebde4  scripts/ckmc-write-probe/migcheck/migration63.sql
```

### 6. `load_session_status_snapshot` still does a full decode

`lib.rs:8717-8783` does a full `read_decoded` plus `hydrate_meta_row_state` (the identity and served-output rows) plus three counts and the pass trace, in one read transaction.

**Cost (not measured directly here).** From the results' clone profile:
- `read_decoded` costs 12.3 ms min and 14.0 ms median on AFT, and 11.6 / 12.6 ms on ALF;
- `load_transform_snapshot`, which adds the identity rows and the overlays, costs 39.7 ms on AFT.

A status call on AFT therefore costs about 15–40 ms, with the identity hydration as the variable part.

**Frequency.** It runs only for `session.status` requests without `state_sync` or `state_sync_inventory`. Those two variants return early from `load_meta` or `load_state_sync_inventory` (`mc-module/src/lib.rs:8126-8207`; dispatch at `:13771`). The plain form comes from:
- the plugin's stall probe on a transform that has passed `probeAfterMs` (`rust-mode-transform.ts:1776-1786`);
- the parked-session health probe, at most once per parked turn (`:2471-2477`);
- status and diagnostic tools.

It is not on the per-pass path. Verdict: **acceptable**. The one sharp edge is that the stall probe adds up to about 40 ms of SQLite work to a module that is already slow to answer.

---

## Plugin v94 (packages/plugin, packages/pi-plugin)

### 7. LKG slices

**Writes: OK.** The save reads the stored slice hashes inside the same IMMEDIATE transaction that writes the changed slices, deletes the slices past the new count and upserts the slot row with the count, length and hash (`lkg-persist.ts:213-287`, transaction at `:218-280`). Concurrent writers serialize on the write lock, and each one diffs against what is actually stored, not against a hash it remembers. A torn write rolls back as a whole; `a failed save rolls back its slices with the row and the previous prefix still loads` pins that.

**Load: OK.** One read transaction reads the slot row and its slices (`lkg-persist.ts:301-325`). `assembleLkgPrefix` (`lkg-prefix-chunks.ts:75-105`) checks, in order:
1. the count and length are safe integers, the hash is a string, and the row count equals the recorded count, so an extra or missing slice is rejected;
2. slice `i` has `chunk == i`, which rejects reordering and gaps, and its body is a string;
3. the summed length equals the recorded length;
4. each body hashes to its stored hash;
5. the hash over the slice hashes equals the slot's recorded hash.

That set is complete for "is this the prefix that was saved". The slot's metadata row is one row written in the same transaction, so it needs no separate hash.

**Mismatch handling: OK.** On a mismatch nothing is served: the loader returns `undefined` after calling `clearPersistedLkgSlot`, which deletes both tables in one IMMEDIATE transaction (`lkg-persist.ts:335-345`, `:289-299`). If the clear itself fails, it is logged and the loader still returns `undefined`.

**RISK (fail-closed).** The save skips a slice whose stored hash column matches the new hash without reading the body (`lkg-persist.ts:230`). A body corrupted underneath an intact hash column therefore survives saves until the next load clears the slot, and only one recovery slot is lost.

**RISK (unchanged from before v94).** Two hosts writing one session: the last writer wins the whole slot. The per-handle `persistedFingerprints` skip (`lkg-persist.ts:215`) means host A can believe its slot is persisted while host B's slot is stored. Replay still applies its validity fences, so this can serve no slot; it cannot serve a wrong one. This behaviour is on master too.

Probe 5, three writer processes and one reader on one session: 450 saves, no failed saves, 38,580 verified loads, zero wrong or cleared loads.

### 8. Replay decisions as rows

**Absorbing strip: OK.** `addTrailingBlankDecisions` overwrites only an absent decision, or the live newest assistant when its current decision is not `strip` (`storage-meta-persisted.ts:2670-2680`). `updateTrailingBlankDecisions` compares every stored row against the value `decide` saw (`storage-replay-document.ts:494-511`):

```sql
INSERT INTO session_replay_decisions (session_id, message_id, decision) VALUES (?, ?, ?)
  ON CONFLICT(session_id, message_id) DO NOTHING
UPDATE session_replay_decisions SET decision = ? WHERE session_id = ? AND message_id = ? AND decision IS ?
```

`changes != 1` throws `DECISION_CONFLICT`, which rolls back the batch and re-decides from a fresh read. A concurrent keep→strip demotion therefore makes a stale "keep" refresh lose and re-decide, and the re-decision sees `strip`. Probe 2 shows `keep over strip (overwrite a2) -> true a2 = strip`. `a concurrent strip is never overwritten by a stale keep refresh` (`migrations-v94.test.ts:473-588`) pins the race.

**Retry bound: OK.** `CAS_RETRY_LIMIT = 5` for both the row CAS (`storage-replay-document.ts:461`) and the envelope CAS (`:376`). No test asserts the bound itself.

**Cost of `readAllTrailingBlankDecisions` in TS mode: OK, cheaper than v93.** It reads every decision row of the session (`storage-replay-document.ts:333-351`, `:170-180`) from `loadPostprocessReplaySnapshot` (`storage-meta-persisted.ts:3029-3033`). The snapshot is cached per `data_version` and `total_changes` (`postprocess-read-cache.ts:57-63`, `:95-100`). Any commit by another connection invalidates it, so on a busy shared `context.db` it effectively reloads on every pass. Measured on the clone (probe 1 for v94, probe 1b for v92):

| Session | Decisions | v94 rows read (median / min) | v92 column read+parse (median / min) |
|---|---|---|---|
| AFT | 34,842 | 6.39 / 4.96 ms | 15.08 / 8.64 ms |
| ALF | 52,182 | 11.39 / 9.19 ms | 14.43 / 13.22 ms |
| CEREB | 12,960 | 2.86 / 1.74 ms | 8.23 / 3.97 ms |

The v94 and v92 runs are at different load averages (about 26–31 for v94, about 60 for v92), so compare orders of magnitude only. Rust mode reads decisions only for the visible ids; on the clone a 40-id subset costs 0.36–0.39 ms.

**FINDING (performance, not correctness): the reasoning-removal read walks every decision row on every pass.** `getReasoningRemovalState` calls `readReplayDocument(db, id)`, strict (`storage-reasoning-removal.ts:76-84`). That function reads and strictly validates every decision row of the session (`storage-replay-document.ts:307-325`), even though the caller needs only the envelope's `reasoningRemoval` namespaces. The postprocess phase reads it on every pass where reasoning removal is enabled, that is for non-Anthropic providers with compaction on (`transform-postprocess-phase.ts:1985-1996`, and again at `:2344`). Measured `readReplayDocument` medians: 13.4 ms on AFT and 27.2 ms on ALF.

A strict read also means one invalid decision row makes the read throw, and the pass then fails closed with `reasoning-removal-read-failure`. That is the same strictness the v93 column parse had. The fix is to read the envelope alone (`readReplayEnvelope`).

### 9. Reasoning removal under v94 (probe 2)

**OK.** `reasoningRemoval` and `reasoningRemovalBackup` sit in the envelope column. The v94 data step rewrites only `$.trailingBlank` for a strictly valid v2 document, through `json_set` (`migration-v94-write-split.ts:232-241`), and every other namespace is kept.

After the split:
- `getReasoningRemovalState` reads the same state;
- `addRemovedReasoningIds` and `markDropLeavesReasoning` CAS-write both namespaces, and the backup mirrors the primary (`storage-reasoning-removal.ts:60-68`, `:94-128`, `storage-replay-document.ts:361-407`);
- a decision write leaves the column bytes untouched, so trailing-blank writes no longer contend with the reasoning CAS;
- a corrupted primary is read from the backup;
- the merged `readReplayDocument` exposes every namespace plus the row decisions.

### 10. The v94 migration (the 24-hour LKG window and the rest)

**Measured on a clone of the live `context.db` at v92** (1,328 LKG slots, 273 captured in the last 24 hours, 700 MB of prefixes; 1,893 replay documents). The live store is at **v92, not v93** (`MAX(version) FROM schema_migrations` = 92), so the first open of the new plugin runs v93 and v94 together.

Through the real `openDatabase`, open plus migration took **93.8 s** at a 1-minute load average of about 26–31:
- v94's transaction ended 41.4 s after v93's (`applied_at` 1790858654298 → 1790858695720);
- initialisation plus v93 took at most 52.4 s;
- v94 moved 271 slots into 3,217 slices.

That is about twice the 16–47 s in the brief. The whole migration holds the `context.db` write lock (`migrations.ts:3321-3355`).

- **Partial move: OK.** Both steps run inside the migration's one IMMEDIATE transaction (`migrations.ts:3193-3203`, `:3321-3355`). Within it:
  - a slot whose prefix is not a string, or whose metadata breaks a `NOT NULL` constraint, is dropped (`migration-v94-write-split.ts:116-144`);
  - `DELETE FROM lkg_slot_chunks` before the move makes a re-run start clean (`:132`);
  - the drop and rename happen in the same transaction (`:145-146`);
  - the old table had no indexes, so the rebuild loses nothing.
- **Version detection: OK.** The SQL mirrors `parseReplayDocument`:
  - v2 means a `version` key whose value is not itself a decision (`:188-193`);
  - only documents that parse strictly are moved (`:194-217`);
  - a v1 column is emptied;
  - a v2 column keeps every namespace (`:232-241`);
  - documents that do not parse strictly stay untouched, and the readers overlay rows on the column (`storage-replay-document.ts:146-151`).

  All three of the large sessions were v2 and moved fully: 34,842, 52,182 and 12,960 rows, with the column down to 750 bytes.
- **RISK: mixed-version hosts.** A plugin process that is still running v93 code after another host migrated:
  - fails its LKG saves (no `json_prefix` column; the failure is caught and logged);
  - writes trailing-blank decisions into the column, which the v94 readers rank below rows. An old process's `strip` written to the column for an id that has a `keep` row would be hidden. That is a strip→keep promotion visible to v94 readers.

  This is safe only if every OpenCode and Pi host restarts in the window. I did not verify whether the cached-handle schema fence (`storage-db.ts:2511-2525`) fences such a process before its next write.
- `packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts:147` still selects `lkg_slots.json_prefix` and will fail against v94. This is test tooling only.

---

## Both

### 11. Migration order in the restart

**`scripts/restart-window.sh` does not exist at `a2ee94ef7b`**, so I could not review the script itself. What follows is the order the code requires.

- **context.db first, then store.db: correct.**
  - The new ck-mc's context fence is a ceiling (`supported_fences_line`, `mc-module/src/lib.rs:18225-18233`; `place-ck-mc.sh:57-79`). Its write fence on `context.db` compares table fingerprints for the compartment tables and their bracket (`host_store.rs:626-657`), and v94 does not touch those tables.
  - **Placing ck-mc first would be worse,** because the live `context.db` is at v92: the new module refuses compartment writes until v93 exists (`v92_opens_but_compartment_writes_require_the_v93_revision_schema`, `host_store.rs:2119`), and v93 planning runs uncached, at 390–500 ms per pass on AFT (results, section 3).
  - **Plugin first means the old ck-mc refuses compartment writes** from the moment v93's triggers land until placement. That is the warning in `docs/reports/rust-planning-regression-2026-09-30.md:5-8`. Keep the gap short; it already includes the 94 s migration.
- **Placement runs store.db 62→63 on the first open:** 7.9–32.0 s on clones (results). Sessions get `store_opening` and can park meanwhile (design 8).
- **Cross-version reads: none break.**
  - ck-mc reads no v94 table or column, and none that v94 dropped (`single_store_schema.rs:291-419`, `context_boundaries.rs:184-201`, `context_writes.rs`).
  - No product plugin code reads store.db. `cache-bust-sentinel.ts:586-655` reads `mc_pass_trace` with a fallback for both the ring view (63) and the legacy columns (62).
- **Not verified:** how other hosts' `openDatabase` and the old ck-mc's context writers behave while the plugin holds the 94 s migration lock (boot busy timeouts and `MigrationLockBusyError` retries).

### 12. Invariants without a test that turns red on revert

- **The compaction-off path does not repair a discard,** and no test covers it; the behaviour is wrong today (finding 3).
- **`apply_state_sync` keeps discarded chunks, and its seed counter is misreported.** No test exercises the `FrozenWrite::Keep` branch (`lib.rs:11277-11280`).
- **The bootstrap clear** (`clear_session_rows` in `commit_transform`) is defence in depth; the results say its test does not go red.
- **The HARD plan override for a discard** does not go red on non-subagent passes, because `force_hard` alone covers them (results, section 4). No subagent test pins the override.
- **LKG:** no test drives truly simultaneous writers (probe 5 is the only evidence). No test isolates the whole-prefix-hash check or the total-length check from the per-slice checks.
- **The replay-decision retry bound** of 5 is not asserted.
- **Namespace survival:** no test carries an arbitrary unknown v2 namespace through the v94 migration. Probe 2 covers the reasoning namespaces.
- **v94 crash:** no test injects a failure mid-migration, and none has a v93 binary meet a v94 database.
- **Mixed-version hosts:** no test covers a v93 process writing the column after v94.
- **Defended indirectly:** the `skip_serializing_if` coupling of the meta-only serde writers. The mutation below reddened 13 tests, none of them named for the invariant.

---

## Probes (all reverted; output pasted verbatim)

**Probe 1: open and migrate a clone of the live context.db through `openDatabase`, then time the reads.** `bun probe.ts $TMPDIR/magic-context/split-review/context.db`:
```
open+migrate: 93.8 s
applied: [{"version":93,"applied_at":1790858654298},{"version":94,"applied_at":1790858695720}]
open db files (lsof):
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/split-review/context.db-shm
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/split-review/context.db
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/split-review/context.db-wal
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/split-review/context.db-shm
lkg_slots: {"n":271,"chars":199424280} chunks: {"n":3217}
AFT: rows=34842 column_bytes=750 decisions=34842 readAll median=6.39ms min=4.96ms; readReplayDocument median=13.38ms; subset(40) median=0.390ms; loadPersistedLkgSlot median=4.37ms chars=1930997
ALF: rows=52182 column_bytes=750 decisions=52182 readAll median=11.39ms min=9.19ms; readReplayDocument median=27.21ms; subset(40) median=0.371ms; loadPersistedLkgSlot median=6.25ms chars=2773761
CEREB: rows=12960 column_bytes=750 decisions=12960 readAll median=2.86ms min=1.74ms; readReplayDocument median=5.56ms; subset(40) median=0.364ms; loadPersistedLkgSlot median=4.87ms chars=2660025
```
Before the migration, the same clone held these trailing-blank counts in the v2 column: AFT 34,842, ALF 52,182 and CEREB 12,960. They match the moved row counts.

**Probe 1b: the v92 baseline on an untouched clone.** The decision read is the column read plus parse:
```
AFT v92: decisions=34842 read+parse median=15.08ms min=8.64ms
ALF v92: decisions=52182 read+parse median=14.43ms min=13.22ms
CEREB v92: decisions=12960 read+parse median=8.23ms min=3.97ms
```

**Probe 2: reasoning removal under v94.** A fresh v94 database; a v93-shaped v2 document; `splitReplayDecisions`; then the reasoning and decision writers:
```
before split: state {"ids":["m1","m2"],"drop":true}
after split: column {"version":2,"trailingBlank":{},"piNative":{"x":1},"reasoningRemoval":{"messageIds":["m1","m2"],"dropLeavesReasoning":true},"reasoningRemovalBackup":{"messageIds":["m1","m2"],"dropLeavesReasoning":true}}
after split: rows 3 decisions {"a1":"keep","a2":"strip","a3":"keep:3"}
after split: state {"ids":["m1","m2"],"drop":true}
addRemovedReasoningIds(m3) -> true state {"ids":["m1","m2","m3"],"drop":true}
backup mirrors primary: true
addTrailingBlankDecisions(a4 strip) -> true
column unchanged by a decision write: true rows 4
keep over strip (overwrite a2) -> true a2 = strip
markDropLeavesReasoning -> true state {"ids":["m1","m2","m3"],"drop":true}
primary corrupted: state from backup {"ids":["m1","m2","m3"],"drop":true}
merged keys piNative,reasoningRemoval,reasoningRemovalBackup,trailingBlank,version trailingBlank {"a1":"keep","a2":"strip","a3":"keep:3","a4":"strip"}
```

**Probe 3: `commit_meta` and a state sync against a corrupted chunk.** A throwaway test in `crates/mc-store/src/cache_codec/tests.rs`: seed 130 units, corrupt chunk 0, then `commit_meta`, then `apply_authority_state_sync` with one drop seed, then the transform's full rewrite. Run with `cargo test -j 2 -p mc-store --lib review_probe -- --nocapture`:
```
probe: rv=Some(1) digest_rv=Some(1) index={"sv":1,"f":{"n":130,"c":3,"h":"1d4f7d8ccb7797937d4c8bbf54e23e0d"},"b":{"n":2,"h":"ca1ead74beb2dcfae6687a2869b41750"},"t":{"h":"9112a2515cbf9967d200a61e78f03c16"}}
probe: commit_meta -> rv 2; digest_rv=Some(2); index unchanged=true; chunks unchanged=true
probe: after commit_meta frozen=Discarded(DigestMismatch) units=0
probe: state sync -> rv 3 drop_seeds_skipped=0; frozen index entry unchanged=true (sv 1 -> 1); chunks unchanged=true
probe: after state sync frozen=Discarded(DigestMismatch) units=0 seed_unit_present=false
probe: after full rewrite chunks==clean true frozen=Intact(FrozenBase { chunk_digests: [236116488942635357845348616942655092591, 269823551615132050982894065834245713860, 299625683165015184324474832651435294537] })
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 212 filtered out; finished in 1.16s
```

**Probe 4: a compaction-off session with a corrupted chunk.** A throwaway test in `crates/mc-module/src/transform.rs`: bootstrap with `compaction_enabled = false`, `corrupt_frozen_chunk`, then three more passes. Run with `cargo test -j 2 -p mc-module --lib review_probe -- --nocapture`:
```
probe: bootstrap action=HARD committed=true
probe: pass 0 ERROR UnknownShape("unknown frozen-set shape")
probe: pass 1 ERROR UnknownShape("unknown frozen-set shape")
probe: pass 2 ERROR UnknownShape("unknown frozen-set shape")
probe: frozen state after passes = Discarded(DigestMismatch)
test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 1486 filtered out; finished in 9.82s
```

**Probe 5: concurrent LKG writers.** Three `bun` writer processes each saved 150 different prefixes for one session. The prefixes share two slices and have 3 to 7 slices each. A reader process loaded the slot for 25 s. For each slot it loaded, the reader recomputed the expected prefix from the slot's `lastInputMessageId`. It counted any mismatch as WRONG, and also counted as WRONG any empty load when the slot row already existed, because that can only be a verification failure that clears the slot:
```
writer 1: saves=150 failed=0
writer 2: saves=150 failed=0
writer 0: saves=150 failed=0
reader: verified=38580 empty=502 WRONG=0
final slot: w0-149 matches=true chunks={"n":8} elapsed=25072ms
```
The 502 empty loads all ran before the first save, when no slot row existed yet.

**Mutation: the moved-key coupling of the meta-only serde writers.** In `crates/mc-store/src/lib.rs`, `#[serde(default, skip_serializing_if = "Vec::is_empty")]` on `resolved_compartment_boundaries` was replaced by `#[serde(default)]`, marked NON-VACUITY BREAK. Running `cargo test -j 2 -p mc-store --lib` gave `197 passed; 13 failed`. Among the failures:
- `truncate_compartments_for_revert_deletes_suffix_and_bumps_epoch`
- `publish_historian_chunk_is_cas_gated_and_double_publish_conflicts`
- `matching_historian_abandon_fences_predicate_and_update_for_both_backoffs`
- `historian_publish_failure_counter_accumulates_and_success_state_resets`
- `reset_for_recomp_clears_every_split_row`
- `edit_sequences_round_trip_through_the_store`

The file was then restored with `git checkout`, and `git diff --stat` was empty.

---

## Blocking findings

None. Every path I traced either keeps the stored state consistent or fails closed without serving wrong bytes.

## Non-blocking findings

1. **The compaction-off path never repairs a discarded frozen list** (`transform.rs:2954`, `:3078-3096`; probe 4). The session rejects every pass until someone resets it by hand. Route a discard to HARD there and add the test. This is the most important item on this list.
2. **The reasoning-removal read walks and strictly validates every decision row on every pass:** 13 ms on AFT and 27 ms on ALF (`storage-reasoning-removal.ts:76-84` → `storage-replay-document.ts:307-325`). Read the envelope only.
3. **`apply_state_sync` over a discarded list silently drops its seed units and reports `drop_seeds_skipped=0`** (`lib.rs:11273-11280`; probe 3). The Keep branch has no test.
4. **The 92→94 first open took 93.8 s** on a clone at load about 26–31, not 16–47 s. The live `context.db` is at v92, so the window runs v93 and v94 together. Plan the restart window around that.
5. **Mixed-version hosts after v94:** an old process's column decisions rank below rows (a strip→keep promotion becomes visible). Every host must restart in the window.
6. **Stale comment:** `store_063_cache_split.sql:72-73` describes an "open-time backfill" that does not exist. Migrated rows stay unhashed (`sv = 0`) until their first codec commit.
7. **Untrusted row-state digests:** the meta-only writers other than `commit_meta` and the historian `store_meta`, and also `apply_state_sync`, leave the row-state digest untrusted, which costs one full identity-row walk on the next pass.
8. **Status cost:** `load_session_status_snapshot` costs about 15–40 ms on AFT. It is acceptable at its frequency, but it lands on a module that is already stalling when the plugin's stall probe calls it.
9. **Broken probe script:** `packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts:147` reads the dropped `lkg_slots.json_prefix`.
10. **Missing restart script:** `scripts/restart-window.sh` is absent at the reviewed tip.

## Could not verify

- The restart script itself; it is not in the tree.
- How other plugin hosts (`openDatabase` boot busy timeout, `MigrationLockBusyError`) and the old ck-mc's `context.db` writers behave during the 94 s migration lock. In particular, whether pending compartment publications are retried or stranded.
- Whether the cached-handle schema fence in `storage-db.ts:2511-2525` stops a still-running v93 plugin process before it writes the replay column or an LKG slot.
- `load_session_status_snapshot` was not timed directly on a store 63 clone; the cost in 6 is derived from the results' clone profile.
- Whether the reasoning-removal read in the postprocess phase also runs in Rust mode; the cost in finding 2 assumes the TS postprocess path.
- AFT and ALF were not driven end to end through a real module and daemon. Like the results doc, this review's AFT and ALF figures come from clone-level calls.
