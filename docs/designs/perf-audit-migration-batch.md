# Performance-audit migration batch

Status: **approved reduced cut implemented and verified**. Initially inspected at
`51ece6fd479b27364458f7e735af3052abe2d706` (context.db 94, store.db 63).

## Approved scope (after measured gates)

The initial recommendation below was conditionally approved, then narrowed after
the two requested gates failed. **v95 now contains only DB-10, DB-13, DB-14,
DB-18 and MEM-4. DB-2 and DB-5/11 are OUT.** store.db remains 63. Sections A/B are
retained as rejected prototype designs for reproducing the gate, not migration
instructions. No cold payload move, aggregate ledger, memo, coordinated dashboard/
CLI/Pi repair change or additional session-scoped table is being implemented.

## Initial recommendation (superseded by the gates)

Recommend **one context.db migration, 95**, containing DB-2 (a limited,
coordinated payload split), DB-5/11 (shared change-version infrastructure and
safe reuse), DB-10/13/14/18 (indexes), and MEM-4 (an FTS rowid map without
rebuilding FTS). Recommend **no store.db migration** in this batch. Defer the
host-owned ordinal/anchor proposals and the remaining Rust transcript/codec work.

Approval includes updating every supported reader/writer of the five moved
metadata fields: OpenCode, Pi/OMP, CLI, dashboard, and ck-mc's context.db repair
path. A plugin-only DB-2 is **not safe**. If that coordinated scope is unwanted,
remove DB-2 before implementation; do not introduce compatibility triggers.

No live source store is changed by this work.
Large-store migration durations below are **engineering estimates**, not new
measurements. The actual v95 duration and health evidence are approval-gated
deliverables. There is no way to measure an unimplemented migration honestly.

## Constraints and source of evidence

Read `ARCHITECTURE.md`, including the protected cache-stability section and
Storage, and `docs/architecture/storage.md`. Neither ARCHITECTURE.md nor
STRUCTURE.md is to be edited. In particular:

- SOFT+ replays the same bytes; deferred work never forces a bust. No new HARD
  trigger, cache epoch, renderer version, protected-tail rule, or replay decision.
- Preserve m[0]/m[1], mural bytes, markers, watermarks, tag numbers, statuses,
  pending operations, and all replay/LKG decisions. Moving storage is not an
  excuse to delete old cached values or recapture them, even for inactive sessions.
- Preserve commit boundaries in tag allocation and exact telemetry retention.
  No DB-4 batching, no approximate accounting or early LIMIT before tool tiers.
- context.db and store.db remain one backup/restore consistency unit, even though
  this batch changes only context.db. No live migration is part of the rehearsal.
- Use bound spread parameters on both SQLite drivers. Run startup through the
  existing off-thread worker, not a new synchronous startup migration path.

Measurements come from these checked-in reports:

| Report | Evidence used |
| --- | --- |
| `packages/plugin/scripts/perf-audit/sqlite-storage-results.md` | DB-2/5/10/11/13/14/18; 1k/10k/60k fixtures, five repetitions, substantial shared-machine I/O noise |
| `packages/plugin/scripts/perf-audit/MEM-REPORT.md` | MEM-4; 2,000-row FTS fixture; real-copy inventory of 345,030 message rows, 47,905 commits, largest session 201,120 tags |
| `packages/plugin/scripts/perf-audit/V2-results.md` | V2-14; host-owned seq versus canonical conversation ordinal |
| `packages/plugin/scripts/perf-audit/HR_REPORT.md` | HR-3/4/5/12; 133k/152k canonical histories; missing authoritative anchors |
| `crates/mc-store/tests/perf-audit-report.md` | RS-3/4 and why their remaining proposals were held |
| `docs/reports/ckmc-write-amplification-design.md`, sections 7.5/7.6 | v94 already split trailing-blank decisions/LKG; remaining blob split has non-plugin writers |

The audit preceded v94 and store 63. Rebenchmark **this base**, not the audit's
older base, before assigning a gain to this batch. In particular, do not count
the already-shipped LKG/replay split, transcript compression/eviction improvement,
or frozen-state split a second time.

## Candidate decisions, cost, gain, and migration budget

The budgets assume a roughly 6 GB context.db, about 12k metadata rows, tens of MB
of head payloads, hundreds of thousands of indexed messages, about 48k commits,
and up to millions of tags across sessions. Inventory the rehearsal copy first.
Times include commit/checkpoint cost, exclude copying the specimen and waiting
for another writer, and may be much worse under machine contention. None is an SLA.

| Candidate | Measured cost today in the reports | Recommendation and expected gain / measurement | Estimated large-store migration time |
| --- | --- | --- | --- |
| **DB-2** | 20 full metadata reads 4.447 ms vs scalar projections 0.356 ms; 20 scalar updates 13.987 ms wall, 13.818 ms hold, 20 commits, 82,400 WAL bytes. This sample does not show every update rewriting overflow. Later write-split report measured length-changing updates rewriting the full record; pre-v94 large rows were 1.13–3.05 MB. | **IN, limited to five cold fields**, coordinated across products. Reduce record size and length-changing scalar-update WAL; do not promise faster full SessionMeta reads (they still return head bytes). Repeat fixed-length and length-changing setters separately, count WAL frames/hold, and compare exact returned fields. Measure the residual post-v94 row first. | **2–30 s** for payload copy and five metadata-table DROP COLUMN passes at the assumed sizes; O(metadata pages + moved bytes), not a 6 GB rewrite. Inventory and time each drop separately. No startup VACUUM. |
| **DB-5** | Status update + floor-0 tagger reload 34.694 ms vs hot reload 0.008 ms, one dirty write/commit. v86's trigger includes status in tags_version. | **IN with DB-11 infrastructure.** A status-only change must not reload assignments/tool accounting. Target zero assignment rows decoded on that path, comparable to the hot scalar probe. Identity and accounting changes still refresh; test both own and sibling writers. | **0.1–3 s shared with DB-11**: create/seed a small ledger from session_meta and install triggers. No full tag backfill or numbering rewrite. |
| **DB-10** | Plan selects non-covering session/time index; no counterfactual speedup measured. | **IN.** Cover rowid enumeration for session deletion/search. EXPLAIN must show a covering session/rowid lookup; measure actual enumeration/deletion at 1k/10k/60k and on the copy, including insert overhead. Retain the time index. | **0.5–10 s** for about 345k map rows; O(map rows), sorting and new index pages only. |
| **DB-11** | Four aggregate/map/oldest-tool scans 53.657 ms; bound alone 6.559 ms; no writer hold. v86 omits token/input/reasoning counts, tool names, pending ops. | **IN.** Safe bounded quiescent reuse, not a permanent materialized total. Warm unchanged calls avoid SQL scans; returning isolated maps still costs O(result size). Measure cold/warm calls, scans and copied entries separately. Changing calibration, floor, protection, limit, tokens, status or pending ops must invalidate the relevant result. | **Included in DB-5's ledger budget**. Adds no aggregate data backfill. New ledger writes may offset some DB-14 WAL savings; measure net mint/update WAL rather than promising their sum. |
| **DB-13** | Open + insert + exact prune + close 1.741 ms, temporary ORDER BY b-tree. Separate-handle hold was not instrumented. | **IN, index only.** Remove retention sort, keep prune after each insert and the same handle lifetime. EXPLAIN and equal-timestamp retention fixtures; repeat the full open/write/prune/close probe, not just SELECT. No claim all 1.741 ms disappears. | **0.1–5 s** depending on number of sessions retaining 2,000 rows; O(telemetry rows). |
| **DB-14** | **Seven indexes across multiple tables**, not seven tag indexes: 568 pages / 2,326,528 bytes. Minting 32 tags touches 32–35 redundant-index WAL frames (131,840–144,200 bytes). | **IN, drop the exact seven redundant indexes below.** Keep every UNIQUE/partial identity constraint and useful non-redundant index. Expect those redundant pages/frames gone, but measure net WAL with the new version ledger too. Compare actual query plans and the compact-by-id path that explicitly pins the old tag index. | **<1–3 s** to unlink about 568 pages at the fixture size; O(index pages), more on a larger copy. Freelist grows; file need not shrink. |
| **DB-18 plugin messages** | No-match delete on 60k rows: 1.506 ms wall / 1.486 ms hold, full scan, no WAL growth. | **IN.** Session lookup instead of full-table cleanup scan, especially across many sessions. Keep identical deletion predicate/results; EXPLAIN and populated/no-match delete measurements. | **0.1–5 s** for 60k rows; O(plugin rows). |
| **DB-18 candidates** | No-match delete on 6k rows: 0.149 ms / 0.145 ms hold, negligible today. | **IN as the cheap companion cleanup index**, not as a material present-day speedup. This is user_memory_candidates, not primer_candidates (which already has a session index). Check indexed lookup and unchanged cleanup with unrelated rows. | **<0.1–1 s** at 6k rows; O(candidate rows). |
| **MEM-4** | 313.08 ms for 2,000 absent-SHA pre-deletes against 2,000 FTS rows: about 4M row visits, virtual-table scan. | **IN with rowid map**, not a canonical-rowid FTS rebuild. Target zero FTS rows visited for absent SHAs and indexed point deletes for present ones. Benchmark actual INSERT/UPDATE/DELETE triggers at 2k and about 48k commits; compare ordered search rows, scores and rendered text. | **0.1–5 s**: one scan of about 48k FTS rows to copy sha/rowid, no tokenization/rebuild. O(FTS content rows). |
| **V2-14** | 60k ordinal 3.189–6.094 ms; late 100-id range 38.179–52.148 ms. Newest assistant 0.009 ms, absent compaction 0.102 ms. | **OUT.** Authoritative ordinal/type indexes belong to OpenCode 2's database. seq includes non-conversation rows. A context.db migration cannot make a stale shadow ordinal authoritative. Future host-provided revision/index could eliminate OFFSET; existing carried keyset anchors remain the safe path. | **0 s in this batch**. Host migration/backfill duration is unknown and not authorized; no OpenCode store copy or DDL. |
| **HR-4/5/12 ordinal anchors** | HR-4 two-id hydration remains 316.62/210.34 ms on 152k/133k sessions; point lookup baseline 237.80/236.39 ms; last-100 seed 331.62/307.14 ms (36.92 ms at 60k). | **OUT.** Need authoritative canonical ordinals under deletion, revert, compaction, summary filtering, malformed-row holes and timestamp ties. A context shadow without source revisions either silently misnumbers or pays a full validation scan. Keep current bytes/errors and keyset paging. Measure future design via the report's exact range/point/seed hashes and concurrent mutation cases. | **0 s here**; an eventual full registry costs O(all canonical host rows), with no reliable large-store bound yet. |
| **HR-3 arc index** | 60k chunk 244.86–267.86 ms; live full hydration lower bound 28.65–35.24 s / 1.54–2.05 GB; COUNT 217–271 ms. | **OUT.** A persistent arc inventory needs a raw-source revision and complete-range expansion/arc contract. Bounded lookahead would change completedToolArcs or previews. This batch adds neither an arc table nor a stale COUNT memo. A future redesign must compare all emitted bytes and complete arc metadata, not only budgeted text. | **0 s here**; eventual extraction is at least one full raw scan/hydration, and the report's times exclude arc construction. |
| **RS-3 transcript key** | Eight-copy publish transaction now 0.821 ms (was 9.314), 8.563 ms preparation outside lock; eviction now 5.996 ms (was 3672.085). Physical fixture payload still 4,343,696 bytes. | **OUT of this batch** despite real remaining duplication. A byte-safe physical sharing design is outlined below; it requires all lifecycle writers and per-compartment eviction/limit semantics, not just a new key. Current residual transaction is <1 ms. No store 64 merely to rename the key. | **0 s here**. Optional sharing design: preliminary **10–120 s** for about 161 MB transcript tree within a ~1 GB store, including BLOB grouping, copy and commit; unmeasured. |
| **RS-4 frozen codec** | Audit read 16.069 ms / commit 25.983 ms; old report measurements predate store 63. | **OUT: structural split already shipped in 63.** Current cache_codec has 64-unit chunks, section_index, digest verification, and changed-section writes. Rebenchmark that implementation first. Dirty flags or (session,row_version,sv)-only memoization can hide a corrupt body without key changes; do not remove verification or advance a codec epoch. | **0 s, no new DDL/rewrite.** Historical store-63 migration was 14.9–26.5 s on a clone under heavy load; not a forecast of a new codec migration. |
| **DB-8** | Parsing two 4096-id getters 0.822 ms. | **OUT.** No normalized frozen-id table, CAS or decision rewrite. The cold payload split does not normalize these JSON sets. | **0 s**. |
| **DB-9** | Invalidated coverage proof 6.574 ms including one scalar write; hot 0.014 ms. | **OUT.** Keep physical completeness proof and watermark semantics; covering index DB-10 is not permission to memoize incomplete inventory. | **0 s**. |

For the recommended cut, initially reserve **5–60 s** for the complete v95
transaction; item bounds are not additive measurements. If the copy exceeds the
assumed inventory or duration, report it, do not discard payloads or change
transactionality to meet the estimate. Writer lock duration and off-thread
responsiveness are separate metrics: other writers still wait/refuse normally.

## Storage design and rewrites (only C/D/E make the approved v95 cut)

All sections below execute within the migration runner's **one BEGIN IMMEDIATE
transaction and v95 ledger insertion**. No independent commits or background
backfill before the new readers become available. Existing migration entries
1–94 remain unchanged. Schema detection handles genuinely absent tables/columns
in legacy/minimal fixtures; it does not guess a compatible version of a different
table or swallow SQL/constraint errors.

### A. DB-2: five cold payloads, not frozen-decision normalization

Move only `cached_m0_bytes`, `cached_m1_bytes`, `cached_m0_mural_data_url`,
`memory_block_cache`, and `note_nudge_anchors`. The last is a measured growing
JSON array (13–43 KB in the write-split report); copy its exact stored value,
without normalizing its entries or changing its compare-and-swap behavior.
Keep protected-token snapshots and all compaction-marker columns in session_meta,
including pending marker state, and do not edit compaction-marker-manager.ts or
compartment-storage.ts. Keep the mural hash, baseline markers, memory counts/ids,
replay envelope, and stripped-id sets in session_meta.

```sql
CREATE TABLE IF NOT EXISTS session_meta_payloads (
    session_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (name IN (
        'cached_m0_bytes', 'cached_m1_bytes', 'cached_m0_mural_data_url',
        'memory_block_cache', 'note_nudge_anchors'
    )),
    payload BLOB,
    PRIMARY KEY (session_id, name)
);

INSERT INTO session_meta_payloads(session_id, name, payload)
SELECT session_id, 'cached_m0_bytes', cached_m0_bytes FROM session_meta
WHERE session_id IS NOT NULL;
INSERT INTO session_meta_payloads(session_id, name, payload)
SELECT session_id, 'cached_m1_bytes', cached_m1_bytes FROM session_meta
WHERE session_id IS NOT NULL;
INSERT INTO session_meta_payloads(session_id, name, payload)
SELECT session_id, 'cached_m0_mural_data_url', cached_m0_mural_data_url FROM session_meta
WHERE session_id IS NOT NULL;
INSERT INTO session_meta_payloads(session_id, name, payload)
SELECT session_id, 'memory_block_cache', memory_block_cache FROM session_meta
WHERE session_id IS NOT NULL;
INSERT INTO session_meta_payloads(session_id, name, payload)
SELECT session_id, 'note_nudge_anchors', note_nudge_anchors FROM session_meta
WHERE session_id IS NOT NULL;

ALTER TABLE session_meta DROP COLUMN cached_m0_bytes;
ALTER TABLE session_meta DROP COLUMN cached_m1_bytes;
ALTER TABLE session_meta DROP COLUMN cached_m0_mural_data_url;
ALTER TABLE session_meta DROP COLUMN memory_block_cache;
ALTER TABLE session_meta DROP COLUMN note_nudge_anchors;
```

These are the exact statements for a populated v94 schema. For fresh/already-split
tables skip each absent source column and its DROP; never re-add it in
initializeDatabase. If a lost ledger row leaves both a legacy column and a
payload row for the same key, refuse a disagreement (including typeof/NULL),
rather than overwrite either decision. Equivalent rows may be kept, then the
legacy column dropped. NULL session ids are not valid API sessions; their
unaddressable source values are not migrated into a NOT NULL session key.

`payload BLOB` deliberately has **no affinity**, retaining SQL text, BLOB, NULL
and legacy storage classes. Do not CAST, JSON.parse/stringify, recompress,
decode/re-encode UTF-8, canonicalize models, or heal values during the move. Copy
NULL as NULL and empty text/BLOB as their original type. The ordinary rowid table
avoids putting large payloads in the primary-key index. No FK is added: existing
session cleanup semantics, including harness-scoped retention, remain explicit.

**Reads/writes:**

- A full SessionMeta projection substitutes scalar subqueries to payloads, aliased
  with the original field names. It still uses the original validators and
  defaults. Missing payload defaults are NULL, except memory_block_cache's usual
  empty-text default and note_nudge_anchors's '[]'. Preserve an explicitly stored
  NULL separately from absence.
- Full baseline/mural readers return exactly the previous buffers/text. Scalar
  readers do not join payloads. `hasCompleteCachedM0M1` and boundary-presence checks
  inspect the payload, not a retired session_meta column.
- `updateSessionMeta` separates scalar clauses and payload upserts **in its current
  immediate transaction**. A mixed marker/m0/m1 update, its snapshot comparisons,
  and memory cache/count/ids changes remain atomic. Bind buffers unchanged. No
  new independently committed payload setters, especially on materialization.
- Add a shared storage accessor/projection for the injection, RPC and diagnostic
  readers; convert direct SQL writes explicitly. Do not mirror writes with
  triggers, retain shadow columns, or fall back to stale old columns at runtime.
- Convert note_nudge_anchors reads/CAS in storage-meta-persisted.ts, its combined
  replay snapshot reader, and note-nudger.ts's reset. Its payload CAS must compare
  exact old text/NULL and preserve retries, ordering and concurrent delivery
  behavior. Do not edit the protected-token snapshot/protection policy path.
- Rust `single_store_repair.rs`, dashboard `db.rs` invalidation, CLI
  `migrate-session.ts`, clone/reset, identity merge, and compaction-off transition
  must clear the corresponding payloads in the same transactions as before.
  Update Pi injection/status readers too. Inventory direct reads/writes again at
  implementation time, including e2e seeding/inspection and clone scripts.
- No reset runs during v95: existing cached bytes remain usable immediately. This
  touches **stored wire bytes**, but not their content or the fold decision. A
  missing converted external writer is a release blocker, not a later cleanup.

Add session_meta_payloads to SESSION_SCOPED_TABLES **after session_meta**, using
the same extra-predicate ownership pattern as session_replay_decisions:
`NOT EXISTS (SELECT 1 FROM session_meta AS remaining WHERE remaining.session_id = session_meta_payloads.session_id)`.
A harness sweep must not delete another harness's retained metadata payloads.
Clones preserve their existing durable-state/note-anchor copy rules, but do not
copy rendered head caches or make a clone's cached prefix valid.

### B. DB-5/11: separate assignment freshness from status/aggregate freshness

Keep **all three v86 tags_version triggers and their existing semantics**.
`session_meta.tags_version` remains the coarse identity/status signal used by
existing inert-whitespace replay consumers. Do not silently repurpose it as an
identity-only version. Add a small session-owned ledger:

```sql
CREATE TABLE IF NOT EXISTS session_tag_versions (
    session_id TEXT PRIMARY KEY NOT NULL,
    generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    identity_version INTEGER NOT NULL DEFAULT 0 CHECK (identity_version >= 0),
    binding_version INTEGER NOT NULL DEFAULT 0 CHECK (binding_version >= 0),
    aggregate_version INTEGER NOT NULL DEFAULT 0 CHECK (aggregate_version >= 0)
);
INSERT OR IGNORE INTO session_tag_versions(session_id)
SELECT session_id FROM session_meta WHERE session_id IS NOT NULL;
```

The generation is a ledger-incarnation key, not a cache epoch or anything the
renderer serves. Seed existing sessions at zero; process caches are recreated on
restart. Tags/pending ops that predate a metadata row get a ledger lazily from
the triggers, so no full tag scan is necessary. Delete/recreate gets a different
generation, preventing version ABA. New columns get ensureColumn support in the
ledger, **not** new versions in the large session_meta record; missing/invalid
ledger data disables reuse and does not authorize stale state.

Here is exact trigger DDL as a **deterministic expansion** (six triggers), to
avoid divergent hand-copied freshness predicates. The implementation should emit
these statements from one installer shared by migration/fresh schema. Each
placeholder below has only the substitutions enumerated here; it is not an
open-ended implementation choice.

For `tags_ledger_ai`/`tags_ledger_ad`, expand `$EVENT` to `INSERT`/`DELETE` and
`$ROW` to `NEW`/`OLD` respectively:

```sql
CREATE TRIGGER $NAME AFTER $EVENT ON tags BEGIN
    INSERT INTO session_tag_versions(session_id, identity_version, binding_version, aggregate_version)
    SELECT $ROW.session_id, 1, 1, 1 WHERE $ROW.session_id IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET
        identity_version = identity_version + 1,
        binding_version = binding_version + 1,
        aggregate_version = aggregate_version + 1;
END;
```

For the single `tags_ledger_au AFTER UPDATE ON tags`, `$I` is exactly this
NULL-safe predicate:

```sql
(OLD.session_id IS NOT NEW.session_id OR OLD.harness IS NOT NEW.harness
 OR OLD.message_id IS NOT NEW.message_id OR OLD.tag_number IS NOT NEW.tag_number
 OR OLD.type IS NOT NEW.type OR OLD.tool_owner_message_id IS NOT NEW.tool_owner_message_id)
```

`$B` is exactly `$I OR OLD.byte_size IS NOT NEW.byte_size OR
OLD.input_byte_size IS NOT NEW.input_byte_size OR OLD.token_count IS NOT
NEW.token_count OR OLD.input_token_count IS NOT NEW.input_token_count`, with the
entire expression parenthesized. These are also fields in AssignmentRow's
validation/tool-accounting cache; an identity-only signature would miss them.

```sql
CREATE TRIGGER tags_ledger_au AFTER UPDATE ON tags BEGIN
    INSERT INTO session_tag_versions(session_id, identity_version, binding_version, aggregate_version)
    SELECT OLD.session_id, CASE WHEN $I THEN 1 ELSE 0 END,
        CASE WHEN $B THEN 1 ELSE 0 END, 1 WHERE OLD.session_id IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET
        identity_version = identity_version + excluded.identity_version,
        binding_version = binding_version + excluded.binding_version,
        aggregate_version = aggregate_version + 1;
    INSERT INTO session_tag_versions(session_id, identity_version, binding_version, aggregate_version)
    SELECT NEW.session_id, 1, 1, 1
    WHERE NEW.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id
    ON CONFLICT(session_id) DO UPDATE SET
        identity_version = identity_version + 1,
        binding_version = binding_version + 1,
        aggregate_version = aggregate_version + 1;
END;
```

For `pending_ledger_ai`/`pending_ledger_ad`, expand `$EVENT` and `$ROW` as above:

```sql
CREATE TRIGGER $NAME AFTER $EVENT ON pending_ops BEGIN
    INSERT INTO session_tag_versions(session_id, aggregate_version)
    SELECT $ROW.session_id, 1 WHERE $ROW.session_id IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET aggregate_version = aggregate_version + 1;
END;
```

```sql
CREATE TRIGGER pending_ledger_au AFTER UPDATE ON pending_ops BEGIN
    INSERT INTO session_tag_versions(session_id, aggregate_version)
    SELECT OLD.session_id, 1 WHERE OLD.session_id IS NOT NULL
    ON CONFLICT(session_id) DO UPDATE SET aggregate_version = aggregate_version + 1;
    INSERT INTO session_tag_versions(session_id, aggregate_version)
    SELECT NEW.session_id, 1
    WHERE NEW.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id
    ON CONFLICT(session_id) DO UPDATE SET aggregate_version = aggregate_version + 1;
END;
```

Aggregate version conservatively advances on **every** tag/pending update,
including an unchanged assignment. This covers status, all token/byte columns,
tool names, type/owner/id ordering, future columns, operation/tag_id/queued_at and
session moves. Both old/new sessions are notified on a move. Bindings do not
refresh just because status or pending ops changed. Normal SQLite transactions
roll back ledger writes together with their tags/pending ops; OR REPLACE must be
covered with recursive_triggers both OFF and ON in tests (insert still bumps).

Install exact definitions without dropping/recreating matching triggers on each
cached open, following storage-compartment-history-version.ts's schema-match
pattern. Do not reset counters or seed again on every open. Add the ledger to
SESSION_SCOPED_TABLES after tags and session_meta with a predicate that retains
it while **either** metadata or tags for another harness remain. Do not clone
its source version numbers; destination tag triggers establish destination
freshness. Update schema fingerprint fixtures for Rust's affected tables/triggers.
Numeric ledger counters can use ensureColumn with their constant defaults;
generation is created by the full table DDL. Do not attempt SQLite's unsupported
ADD COLUMN with a randomblob default on populated rows. A pre-existing ledger
with a missing/different generation definition is a schema error, not permission
to reset its incarnation. The payload helper's ensureColumn checks use BLOB for
payload; removed session_meta fields are excluded from new initializer ensures.

**Read changes and memo contract:**

- Tagger probes generation/binding_version plus the existing coarse tags_version.
  Status-only updates skip assignment reloads but refresh the observed coarse
  version. `getLoadedTagsVersion` must still expose that observed coarse version
  to tag-messages.ts's inert-whitespace cache, not the new binding version. Keep
  database identity, floor and counter recovery; own mints advance the new loaded
  signature only for changes this tagger actually mirrored. Tool accounting
  changes from a sibling must reload, even if identity did not change.
- Memoize the DB-11 bound, active aggregate, all-status map and oldest-tool
  candidate read by actual Database identity, session, generation,
  aggregate_version, and **every argument**: floor, protected cutoff/set,
  calibration ratios, limit. For oldest-tool hints cache the ordered candidate
  pool before protection/tier/limit selection, so a changing protected set is
  applied afresh; do not cache a final four-tag decision under just the version.
- Each cold result and its version must come from one read snapshot. Reuse only
  outside an already-active transaction; don't store uncommitted memo results.
  Include schema_version, total_changes and data_version as conservative fences
  for connection-local rollback/replacement and ledger tampering. This can lose
  hits on unrelated writes, which is preferable to stale reclaim decisions.
  Check revisions before/after computation; refuse a memo hit on non-finite or
  non-safe-integer counters. Never extend a TTL over a version mismatch.
- Bound retained sessions/bytes (initial cap: 16 MiB / 32 sessions per Database,
  weak ownership); clone mutable return maps/sets/objects so callers cannot poison
  subsequent results. Oversized entries simply bypass reuse. No durable totals,
  no changed SQL inclusion, calibration arithmetic, row iteration order, tier
  priority, protected membership, or age threshold.
- Measure the extra ledger page written by each transaction. Index removals do
  not automatically compensate it. These versions are freshness evidence, not
  new frozen decisions or input to mustMaterialize.

### C. DB-10/13/18: covering, retention, and cleanup indexes

```sql
CREATE INDEX IF NOT EXISTS idx_message_fts_rowid_map_session_rowid
    ON message_fts_rowid_map(session_id, fts_rowid);
CREATE INDEX IF NOT EXISTS idx_transform_decisions_retention
    ON transform_decisions(session_id, harness, ts_ms);
CREATE INDEX IF NOT EXISTS idx_plugin_messages_session
    ON plugin_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_user_memory_candidates_session
    ON user_memory_candidates(session_id);
```

No data rewrite or reader/writer predicate change. The retention index is
**ascending**, including its implicit rowid suffix. A backwards scan with fixed
session/harness supplies `ts_ms DESC, rowid DESC`, preserving exact tie-breaking.
SQLite cannot explicitly index the rowid pseudo-column; don't propose
`CREATE INDEX(..., rowid)`, a mixed DESC ts/ASC rowid index, or a new surrogate
telemetry key. The latest 2,000 rows still survive after every insert, including
INSERT OR REPLACE with equal timestamps. Keep message map session/time and
ordinal-uniqueness indexes for their other readers. Query plans that change row
iteration order require ordered-output comparison, not just equal row counts.

### D. DB-14: remove only proven redundancy

```sql
DROP INDEX IF EXISTS idx_tags_session_tag_number;
DROP INDEX IF EXISTS idx_compartments_session;
DROP INDEX IF EXISTS idx_pending_ops_session;
DROP INDEX IF EXISTS idx_source_contents_session;
DROP INDEX IF EXISTS idx_compression_depth_session;
DROP INDEX IF EXISTS idx_transform_decisions_session_harness;
DROP INDEX IF EXISTS idx_project_key_files_project;
```

| Removed index | Retained replacement |
| --- | --- |
| tags(session_id, tag_number) | UNIQUE(session_id, tag_number) autoindex, same implicit rowid suffix |
| compartments(session_id) | UNIQUE(session_id, sequence) |
| pending_ops(session_id) | idx_pending_ops_session_tag_id(session_id, tag_id) |
| source_contents(session_id) | PRIMARY KEY(session_id, tag_id) |
| compression_depth(session_id) | PRIMARY KEY(session_id, message_ordinal) |
| transform_decisions(session_id, harness) | PRIMARY KEY(session_id, harness, message_id), plus the new retention index |
| project_key_files(project_path) | idx_project_key_files_generated_at(project_path, generated_at) |

No row rewrite, no VACUUM, no uniqueness relaxation. Remove fresh/ensure DDL
that recreates these indexes, including storage-db.ts's later telemetry block.
Do not remove the active/dropped partial indexes, tool composite UNIQUE index,
null-owner index, Pi owner/adoption indexes, or session/message-id index.

`markTagsCompactedByMessageIds` in storage-tags.ts currently uses
`INDEXED BY idx_tags_session_tag_number`; deleting the index without changing
that SQL breaks it. Resolve the actual UNIQUE(session_id, tag_number) constraint
index through PRAGMA index_list/index_info, cache the name by connection/schema
version, and pin that equivalent index instead. Do not hard-code
sqlite_autoindex_tags_1 (rebuilds/fork constraints can change its name), or let
the query silently switch to random message-id table reads. Preserve old
tag-number/id visitation and batch boundaries; test malformed/delimiter ids and
the affected query plan. Schema-existence tests must deliberately assert the
replacement constraints/indexes, documenting why the old index-name assertions
changed, not delete coverage of indexing.

### E. MEM-4: retain existing FTS bytes and rowids

Do **not** rebuild git_commits_fts to use git_commits.rowid. That would retokenize
and renumber rows, potentially changing bm25 ties and served result order. Copy
the current relationship, including duplicate/orphan legacy FTS rows, instead:

```sql
CREATE TABLE IF NOT EXISTS git_commit_fts_rowid_map (
    fts_rowid INTEGER PRIMARY KEY,
    sha BLOB
);
CREATE INDEX IF NOT EXISTS idx_git_commit_fts_rowid_map_sha
    ON git_commit_fts_rowid_map(sha);
INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha)
SELECT rowid, sha FROM git_commits_fts;

DROP TRIGGER IF EXISTS git_commits_fts_insert;
DROP TRIGGER IF EXISTS git_commits_fts_delete;
DROP TRIGGER IF EXISTS git_commits_fts_update;

CREATE TRIGGER git_commits_fts_insert AFTER INSERT ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE rowid IN (
        SELECT fts_rowid FROM git_commit_fts_rowid_map WHERE sha = NEW.sha
    );
    DELETE FROM git_commit_fts_rowid_map WHERE sha = NEW.sha;
    INSERT INTO git_commits_fts(sha, project_path, message)
    VALUES (NEW.sha, NEW.project_path, NEW.message);
    INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha)
    VALUES (last_insert_rowid(), NEW.sha);
END;
CREATE TRIGGER git_commits_fts_delete AFTER DELETE ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE rowid IN (
        SELECT fts_rowid FROM git_commit_fts_rowid_map WHERE sha = OLD.sha
    );
    DELETE FROM git_commit_fts_rowid_map WHERE sha = OLD.sha;
END;
CREATE TRIGGER git_commits_fts_update
AFTER UPDATE OF message, project_path ON git_commits BEGIN
    DELETE FROM git_commits_fts WHERE rowid IN (
        SELECT fts_rowid FROM git_commit_fts_rowid_map WHERE sha = OLD.sha
    );
    DELETE FROM git_commit_fts_rowid_map WHERE sha = OLD.sha;
    INSERT INTO git_commits_fts(sha, project_path, message)
    VALUES (NEW.sha, NEW.project_path, NEW.message);
    INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha)
    VALUES (last_insert_rowid(), NEW.sha);
END;
```

sha has BLOB affinity (no coercion) and stays nullable in the map to preserve
legacy FTS storage classes/NULLs; it
is not UNIQUE because the old trigger deletes **all** same-SHA rows. No FK to
git_commits: a cascade would lose orphan rowids the old pre-delete could remove.
Use `=` on sha, as before, not NULL-equal matching. Existing public upserts do
not mutate sha; retain the original UPDATE OF message/project_path trigger
predicate rather than adding a new SHA-only repair behavior.

The map insertion immediately follows the virtual-table insertion and captures
its actual rowid. Verify this with **both Bun and Node SQLite**, normal upserts
and REPLACE, not an assumption about the base table's last_insert_rowid. FTS5's
internal insert work must not make the map point at a shadow-table row. Driver
tests must compare every new mapped row against actual virtual-table rowids.

Leave search-git-commits.ts's FTS query and its bm25 ordering unchanged. Future
base-table trigger writes delete/insert the exact same FTS rows in the same
order, preserving FTS's rowid allocator. An absent-SHA insertion now visits the
ordinary indexed map only. No FTS `rebuild`, `optimize`, or corpus cleaning in
v95. On a lost-ledger rerun, require an existing map to match FTS exactly before
accepting it; missing source tables in minimal fixtures simply skip this part.
Keep initialization read-only on an already-current database. Git schema today
comes from migration 4, not storage-db.ts's main CREATE block; install its latest
fresh shape with the shared initializer after the base tables exist, rather than
rewriting migration 4 or creating triggers against an absent base table.

This map is **project-owned**, not session-owned; do not add it to
SESSION_SCOPED_TABLES. Commit eviction/clear uses the same base DELETE and the
triggers remove map rows. Clone/export scripts that skip/rebuild git FTS must
handle its map consistently as well.

## Excluded persistent designs: DDL/rewrite disposition

### Host ordinal/anchor/arc findings (V2-14, HR-3/4/5/12)

**Exact DDL and rewrite in this batch: none.** Adding an index to OpenCode's
message tables is a host-schema migration, which is outside context.db/store.db
ownership and the explicit no-live-host-store rule. Inventing a context.db
`(session_id, ordinal, id, time)` registry does not solve its authority problem.
message_history_source already contains derived message ordinals, and v88
coordinate_generation records projection identity, not a source revision.
Neither proves that no offline edit/deletion/revert has happened.

A future design needs an authoritative host revision captured in the same raw
read snapshot, separate v1/v2/Pi canonical spaces, absolute ordinals including
legacy malformed-row behavior, source-identity/part-arc validation, and clear
delete/revert/compaction invalidation. Until that contract exists there is no
sound exact registry/backfill DDL to approve here. A run-scoped caller-provided
anchor is an alternative API redesign, not a schema-migration quick win. No
served output/frozen decision is touched by the exclusion; accepting a naive
registry would risk changing both.

### RS-4 codec

**Exact new DDL/data rewrite: none.** store_063_cache_split.sql and cache_codec.rs
already implement the split and changed-section writer. The frozen chunk size
must stay 64. No new memo that skips body-digest verification, no serialization
change, and no forced HARD rebuild are authorized. A future parse optimization
may retain raw-body verification and reuse typed decode results only after an
exact-body match; it need not take store 64 without a measured schema need.

### RS-3 optional physical transcript sharing (not approved by this plan)

This is a **concrete alternative for later review**, not proposed store 64 in
the recommended cut. Separate identical compressed payload pairs from the
per-compartment identity/range. Do not infer that equal ranges, creation times
or adjacent sequences came from the same publish. Deduplicate only exact
compressed pairs **within one session**, without recompression:

```sql
CREATE TABLE mc_chunk_transcript_payloads (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    transcript_deflate BLOB NOT NULL,
    raw_messages_deflate BLOB
);
CREATE INDEX idx_mc_chunk_transcript_payloads_session
    ON mc_chunk_transcript_payloads(session_id);
INSERT INTO mc_chunk_transcript_payloads(id, session_id, transcript_deflate, raw_messages_deflate)
SELECT MIN(rowid), session_id, transcript_deflate, raw_messages_deflate
FROM mc_chunk_transcripts
GROUP BY session_id, transcript_deflate, raw_messages_deflate;

CREATE TABLE mc_chunk_transcript_refs (
    session_id TEXT NOT NULL,
    compartment_seq INTEGER NOT NULL,
    start_ordinal INTEGER NOT NULL,
    end_ordinal INTEGER NOT NULL,
    payload_id INTEGER NOT NULL REFERENCES mc_chunk_transcript_payloads(id),
    transcript_override BLOB,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY(session_id, compartment_seq)
);
INSERT INTO mc_chunk_transcript_refs(session_id, compartment_seq, start_ordinal,
    end_ordinal, payload_id, transcript_override, created_at_ms)
SELECT t.session_id, t.compartment_seq, t.start_ordinal, t.end_ordinal,
    p.id, NULL, t.created_at_ms
FROM mc_chunk_transcripts AS t JOIN mc_chunk_transcript_payloads AS p
    ON p.session_id = t.session_id
    AND p.transcript_deflate IS t.transcript_deflate
    AND p.raw_messages_deflate IS t.raw_messages_deflate;
CREATE INDEX idx_mc_chunk_transcript_refs_session_range
    ON mc_chunk_transcript_refs(session_id, start_ordinal, end_ordinal, compartment_seq);
DROP TABLE mc_chunk_transcripts;
```

A publish would compress once (already done), insert one new physical payload,
then the same N refs in its existing publish/CAS transaction. Range readers join
refs to payloads but retain **one result per compartment**, ascending seq and
LIMIT-before-decompression, and every StoredChunkTranscript field. Read condensed
bytes via `COALESCE(ref.transcript_override, payload.transcript_deflate)`.

Crucially, eviction must continue counting **logical bytes per ref**, not unique
physical payload bytes. Budget/tie/victim order is currently created_at_ms then
compartment_seq. Reclaiming a raw-backed ref writes that ref's exact old
compress_transcript("") bytes into transcript_override, leaving raw recovery and
other refs intact. A non-raw victim deletes only its ref. Reclaim the physical
payload only after its last ref disappears, in the same transaction; never
evict raw payloads on a new physical budget. Preserve deliberately evicted empty
condensed bytes through migration. Clone copies/rekeys payload groups to the
destination session; reset, session deletion, sync replacement and revert
truncation clean unreferenced payloads without cascading into another session.

Eight identical fixture copies could approach one eighth of the physical
payload storage (4.34 MB to about 0.54 MB, ignoring ref/index overhead), but
**logical eviction behavior and preparation cost stay unchanged**. Actual live
duplication and new-publish WAL gain remain unmeasured. An 8→1 result-count change
or a larger retained transcript window is a wire/recovery contract change and
is expressly rejected. The needed lifecycle conversion and migration round-trip
proof outweigh the now sub-millisecond transaction cost for this batch.

If later accepted, this and any other accepted Rust store changes must share
**one mc-store migration 64**, after 63, with populated step-through/codec and
byte-identity tests. Do not take version 64 for a no-op now. It has no reason to
touch frozen-state tables or advance sections version/codec format.

## Implementation sequence after approval

1. Preserve this base's **complete** OpenCode 1/2 and Pi dist directories under
   the task scratch root for comparison (entry chunks alone are insufficient).
   Inventory every direct SQL reader/writer of the moved fields. No edits to
   selection/config/protected_tools; keep compaction-marker columns unmoved and
   avoid the two other branches' compaction-marker/compartment-storage files.
2. Implement shared payload/ledger/map installers and explicit read/write
   conversions, maintaining transactions. Update dashboard/CLI/ck-mc repair in
   the same release. Handle clone/session cleanup and diagnostics, not only the
   happy transform path. No package/lockfile changes expected.
3. Add exactly one migration entry **95** to migrations.ts; set
   LATEST_SUPPORTED_VERSION = **95**. Update fresh schema, ensureColumn and
   post-migration initializers without re-adding removed columns/indexes.
   Boot into a fresh v95 shape and step into it from populated v94; test both.
4. Update Rust context.db expectations and fingerprint fixtures. At this base,
   supported_fences_report_plugin_and_store_ceilings in mc-module/src/lib.rs
   expects `context.db=94`; BUILT_CONTEXT_FENCE_VERSION in host_store.rs is
   **93**, not 94. Advance both relevant expectations to 95; trace
   supported_fences_line's fence derivation rather than replace every literal
   94. Rust's per-table trigger fingerprint fence still applies. store.db stays
   at 63 and no mc-store migration is added in the recommended cut.
5. Run focused gates, then full impacted-package gates and **bun run build:dists**.
   Build CLI/dashboard/ck-mc too because DB-2 changes their SQL. Assert the fence
   is 95 in actual emitted OpenCode 1, OpenCode 2 and Pi chunks and their worker
   dependency graphs, plus load probes; a source-only grep is insufficient.
6. Rehearse v94→95 on the permitted context.db copy, time the migration/commit,
   collect off-thread `/health`, run integrity/data/wire comparisons and restart
   no-op checks. Delete the big specimen and sidecars once all holders close.
   Commit only intentional source/tests/design evidence, never copied stores,
   private captures, .cortexkit files or generated caches.

## Verification and non-vacuity acceptance plan

### Populated migration / storage tests

Create `packages/plugin/src/features/magic-context/migrations-v95.test.ts`.
Construct an actual v94 schema (no preinstalled v95 trigger/index/payload shape),
apply through **94**, then populate through public v94 APIs. For split-field
setup use the preserved v94 storage implementation, not v95 accessors that
quietly create v95 tables. Assert the starting schema before migrating. Apply
95 through the real runner and inspect both raw SQL and public v95 APIs:

- Every moved payload's bytes and SQLite typeof, including empty/NULL, unicode,
  BLOBs, invalid legacy JSON and non-default frozen note anchors; every retained
  scalar, m0/m1 marker, old tag counter/version, pending op and replay/LKG row.
  SQL DDL must not emit a reset/materialization request. Injected write failure
  proves rollback leaves v94 data/columns/triggers and no v95 ledger row.
- Atomic mixed head/marker and memory cache/count/ids updates from a sibling;
  read and write races retain the old materialization CAS behavior. Lost-ledger
  rerun, fresh initialization, clone, harness-scoped clear, orphan cleanup and
  retained-other-harness cases. Rust repair, dashboard and CLI invalidation must
  actually clear the new payloads.
- Tag status-only update: no assignments decoded, correct inert-whitespace
  replay cache refresh. Identity retarget/move/insert/delete, owner adoption,
  all AssignmentRow accounting fields, null backfill, pending queue/delete/move,
  rollback, REPLACE, distinct handles/sessions and cleanup/recreation. Test
  generation and revision fences with raw SQL through both drivers.
- Aggregate/map/hint cold result equals an independent direct-SQL reference;
  caller mutation, protection/limit/calibration/floor changes, transaction-local
  reads and rollback, and sibling writes cannot leave a stale warm result.
  Result ordering and floating-point sums remain exactly the old implementation.
- FTS map backfill retains **rowids and content of every virtual-table row**, not
  just row count. Include duplicate/orphan same-SHA rows; absent-SHA insert,
  amended update, no-op public upsert, REPLACE, eviction/clear and rollback.
  Assert FTS point plan and rowid-map equality after every real trigger write.
  Compare ordered BM25 rows/scores and served search text on the same corpus.
- Retention ties/REPLACE preserve exact last 2,000 rowids; index plans cover
  enumeration, cleanup and compaction. Missing-index errors must not be hidden.
  DB-14 uniqueness constraints and active/dropped/tool indexes remain enforced.

Focused existing suites include schema-version-fence, migration-worker,
storage-meta/session cleanup/clone, tagger recovery/scoping/accounting,
protection-window, frozen m0/m1 and native replay, transform-decision-log,
git-commit storage/search, Pi parity, Rust single-store repair and schema drift.

**Mutation controls** will be recorded by exact test name and peer tests that
remain green: remove the binding-version comparison, omit one token or
pending-op aggregate invalidation, redirect a head read to empty data, suppress
one external payload reset, and replace an FTS point delete with its old scan
under a work-observing performance guard. Guards must observe actual driver
rows/plans/writes, not a self-computed expected proxy. Use the required safe
sequence: stage specific live files; empty working diff; mark a mutant
`NON-VACUITY BREAK`; capture nonempty diff; run the named gate; restore with
`git checkout -- <path> && touch <path>`; capture empty diff. Never commit a
mutant. A purely byte-value assertion that fails loudly needs no separate guard
proof; freshness/performance/fence invariants do.

### Commands / tool evidence

All shell commands get outer `timeout`. Record local tool versions and test or
check counts, not only exit status. Use repository scripts, not fetching bare
package runners. Heavy checks run one at a time, with a blocking tool wait (no
polling/sleep loop); cargo uses **-j 2** and package scope while iterating.

- `timeout 300 bun run typecheck` (includes plugin scripts/Pi/CLI; tsc, not Bun
  transpilation); focused and full package test/lint scripts for each changed
  package, with the serial Pi gate if parallel boot contention intervenes.
- `timeout 1200 bun run build:dists`, `timeout 600 bun run --cwd packages/cli build`,
  `timeout 600 bun run --cwd packages/dashboard check`, and
  `timeout 600 bun run --cwd packages/dashboard test`.
- `timeout 3600 cargo test --locked -j 2 -p mc-module -p mc-store` and applicable
  dashboard Rust tests, scoped while iterating; `timeout 3600 cargo clippy
  --locked -j 2 -p mc-module -p mc-store --all-targets -- -D warnings`;
  `timeout 120 cargo fmt --all --check`. The dashboard crate is excluded from the
  workspace: use `timeout 3600 cargo test --locked -j 2 --manifest-path
  packages/dashboard/src-tauri/Cargo.toml` for its SQL tests and the corresponding
  package-scoped check/clippy if needed. Do not build a sibling daemon checkout.
- Bun/Node SQLite migration and trigger smoke checks, versioned output. Restart
  on already-current v95 must run no migration body and attempt no redundant
  writer/trigger reinstall on cached opens.

The exact dashboard/host probe commands are resolved from existing package
scripts/runners during implementation, not invented executables in this plan.

### Copy-only rehearsal and responsiveness

After approval, first run `timeout 30 df -h /System/Volumes/Data`. Use a unique,
resolved root `R="$TMPDIR/magic-context/perf-audit-migration-batch-<unique>/"`.
Allow space for the ~6 GB VACUUM destination, its independent working copy,
WAL/index/sort spill and baselines; if space is insufficient, stop rather than
copy the live OpenCode database or modify the live store.

The **only** live context read is the read-only snapshot:

```sh
timeout 1800 sqlite3 -readonly "$LIVE_CONTEXT" "VACUUM INTO '$R/context.db'"
```

LIVE_CONTEXT is the operator's context.db path; resolve it before running. R is
an absolute throwaway path without SQL quote characters. Every later connection
uses that specimen or a disposable copy of it. Record copied schema version,
table/byte inventory, SQLite version, quick_check and foreign_key_check before
and after. If the live copy is not at 94, report the separate earlier migration
costs; don't fake its schema ledger to claim a v94→95 measurement. Never copy or
open the live OpenCode store; host history for rehearsal is synthetic. No
store.db copy is needed for the recommended cut. If Rust sharing is subsequently
approved, take the ~1 GB store.db snapshot in exactly the same read-only fashion
and manage both snapshots as one consistency unit.

For **each real host run**, put HOME, all XDG_* homes, OPENCODE_DB,
MAGIC_CONTEXT_STORAGE_DIR, project/config/log/cache and provider fixtures under
R. Reject an inherited test storage override pointing elsewhere. Resolve
macOS /var versus /private/var before comparing paths. Audit lsof for each host,
worker process and probe before/after migration and after prompts; every store,
WAL/SHM/journal descriptor must be under that run's root. The only allowed live
descriptor is the separate short-lived sqlite3 -readonly VACUUM source. Wait
for hosts/connections to close before deleting only this task's specimen and
sidecars, not the worktree or anyone else's roots.

Start OpenCode **1.18.30** and **2.0.22** on separate working copies with v94
ledger and the new built plugin. Shared storage touches both generations, so
the v2 check is required even though host ordinal work is out. Use raw host
spawn, without a runner that premigrates context.db before startup. Verify the
migration-worker dist is actually loaded and main-thread migration-body count
stays zero. An independent async health sampler schedules requests every 250 ms
from listening handoff, with 1 s per-request timeout and real authentication on
v2. Record start/end and response times, number of successes/failures, **longest
gap between completed successes**, migration start/commit interval and activation
time. The longest gap overlapping v95 must be **<=1 s**, with no silently omitted
timed-out probe. Don't run synchronous lsof in the health sampler event loop.
Fallback to a missing-worker main-thread migration is a failure, not a pass.
Repeat startup at 95: no migration bodies. Report migration wall and writer hold
separately from host readiness; off-thread work still owns SQLite's writer lock.

### Served-output byte identity

Use the real OpenCode 1 replay differential and the real OpenCode 2 raw-provider
wire harness (existing perf-audit/v2-wire.mjs is a reference, not sufficient
unchanged: it seeds an empty store and the normal runner can premigrate).
Preserve full baseline dists and derive both arms from the **same pre-turn v94
throwaway host/context snapshots**, same session ids, project paths, deterministic
response ids and fixed clocks where needed. One arm uses base code at 94; the
other migrates to 95. No live host state is involved.

Populate meaningful nonempty head/mural/protection snapshots, tags, pending ops,
memory cache and git corpus. Compare raw provider HTTP bodies, system, tool
schema, m[0]/m[1], and search served text, by literal bytes and independent
SHA-256/length inventory. Include first resumed **SOFT+**, several growing-tail
defers, status-only and pending mutations that remain deferred, a naturally
priced execute/flush, and restart. Both arms must make the **same fold/defer
decisions**; a matching request after both accidentally rebuilt is not proof of
preserved cache state. Require no migration-originated m0 rebuild. Do not strip
hints, normalize request/session/cache keys, or erase tool/media fields to get
equality. Use the host versions requested here, not the older versions from the
rehearsal reports. The mock transport replaces inference only, not host serving.

Rust and Pi's existing replay/parity suites cover their corresponding consumers;
Rust repair tests directly observe the moved context payloads. If a future store
64 is approved, additionally run real Rust-mode replay against paired context /
store copies and compare raw recovery results and frozen decisions. No such
store migration or codec byte change is part of this approval request.

## Phase 1 validation completed

- Executed the proposed context SQL blocks (including the deterministic six
  ledger-trigger expansions) against an isolated, populated v94 fixture:
  **19 checks passed**, Bun 1.4.2 / SQLite 3.54.0. Checked exact payload types/bytes,
  status versus binding invalidation, token/pending/session-move revisions,
  preserved FTS rowids/BM25 results, mapped writes, index removals and the two
  covering/retention plans. The production migration ledger remained at 94.
- Executed the exact MEM-4 block on **Node v24.16.0 / SQLite 3.53.0**:
  **7 checks passed**, including duplicate/NULL rowids, actual virtual-table rowid
  capture, delete/update and REPLACE with recursive triggers OFF and ON. Its
  plan uses the covering SHA map and an FTS rowid constraint. The first fixture
  attempt used double-quoted SQL values (rejected by Node); bound fixture values
  corrected the probe, with no design SQL change.
- These are small in-memory design checks, **not** an implemented v95 migration,
  a benchmark, a large-store rehearsal, or real-host byte-identity evidence.
  No host or live store was opened. The fenced temporary root was removed.
- Typecheck/build/full suites and the copy/host/mutation gates above are deferred
  to approved implementation. AFT has no authoritative Markdown diagnostic
  producer; its partial inspection is not claimed as a clean diagnostic pass.

## Conditional approval gate results

The parent approved measuring DB-2 first, including it only if it halves scalar
WAL on large sessions, and required stopping on any net ledger hot-path regression.
After these results, the parent explicitly approved dropping **both DB-2 and
DB-5/11** and proceeding with C/D/E only. The split prototype took **3,026.3 ms**
(the preliminary ask's approximate duration was incorrect; this is the captured
timer). It was never installed in a production migration.

### Residual v94 inventory

Disk preflight: 278 GiB free. A read-only `sqlite3 VACUUM INTO` produced a 5.8 GiB
context.db at 94, quick_check=ok. No OpenCode store or store.db was copied.
There are **13,956 session_meta rows**. Sizes below are bytes of stored values,
not JS object sizes. Whole-row logical bytes sum SQLite BLOB/text lengths and
decimal numeric lengths; the largest-row table separately computes exact SQLite
record payload sizes (serial-type widths and varint header, excluding b-tree
cell/overflow-page overhead).

| Field | Nonempty | Total | p50 | p90 | p99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| cached_m0_bytes | 147 | 18,861,748 | 0 | 0 | 14,296 | 607,397 |
| cached_m1_bytes | 147 | 185,088 | 0 | 0 | 90 | 35,287 |
| cached_m0_mural_data_url | 43 | 4,218,186 | 0 | 0 | 0 | 128,586 |
| memory_block_cache | 85 | 2,705,826 | 0 | 0 | 0 | 68,376 |
| note_nudge_anchors | 13,956 | 193,707 | 2 | 2 | 2 | 66,529 |
| Whole row, logical | 13,956 | 39,259,601 | 227 | 937 | 20,616 | 1,973,974 |

The nudge array's default `[]` counts as nonempty here. Largest sessions, labelled
by their stable id prefix rather than retaining their contents:

| Session | Exact record bytes | m0 | m1 | Mural | Memory cache | Note anchors |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 019de471 | 1,973,995 | 357,094 | 9,588 | 0 | 0 | 4,021 |
| ses_331acff9 | 1,145,201 | 361,045 | 28,226 | 126,030 | 44,419 | 658 |
| ses_12a4fa38 | 1,079,991 | 360,402 | 19,600 | 118,082 | 62,884 | 2 |
| ses_31366057 | 970,429 | 607,397 | 90 | 117,962 | 45,674 | 34,491 |
| ses_227ce578 | 954,449 | 495,331 | 19,112 | 117,566 | 3,113 | 66,529 |
| 019e8905 | 946,360 | 369,693 | 20,844 | 0 | 0 | 2 |
| ses_114f158c | 910,008 | 343,020 | 17,270 | 125,686 | 7,560 | 719 |
| ses_100a028a | 799,390 | 354,599 | 90 | 126,594 | 10,167 | 2 |
| ses_110d8791 | 719,287 | 389,059 | 90 | 121,002 | 1,248 | 219 |
| ses_070d004c | 657,106 | 370,623 | 90 | 50,030 | 7,245 | 2 |

### Scalar-update gate: rejected

`migration-batch-gates.ts` operates only on disposable copies of the specimen.
Bun 1.4.2 / SQLite 3.54.0, WAL/NORMAL, autocheckpoint disabled during samples.
Five repetitions of eight updates per session/mode; reset WAL between samples.
Fixed-length alternates two equally sized last_nudge_band strings; length-changing
alternates 9/13-byte strings. One explicit transaction per update, clock starts
after BEGIN succeeds and ends after COMMIT. No writer wait is attributed to hold.
Report independent medians of WAL and hold; shared-load timing is noisy.

| Session | Fixed WAL before→split | Fixed hold ms before→split | Length-changing WAL before→split | Length-changing hold ms before→split | WAL reduction |
| --- | ---: | ---: | ---: | ---: | ---: |
| 019de471 | 32,992→32,992 | 5.582→7.069 | 16,018,592→13,052,192 | 71.516→34.143 | 18.5% |
| ses_331acff9 | 32,992→32,992 | 5.080→3.671 | 9,327,712→4,812,192 | 61.951→11.095 | 48.4% |
| ses_12a4fa38 | 32,992→32,992 | 3.133→3.073 | 8,800,352→4,284,832 | 27.735→8.819 | 51.3% |

Only one of three largest rows halves length-changing WAL; fixed-length writes
do not improve at all. Do not expand the payload list or normalize remaining
frozen JSON just to satisfy the gate. The coordinated DB-2 changes are excluded.

### Ledger plus DB-14 gate: rejected

1k/10k/60k tag fixtures, public insertTag for setup, actual createTagger.assignTag
for minting and updateTagStatus for status. Five repetitions of 32 new mints or
32 active→dropped transitions, one explicit outer transaction per operation.
The mint API retains its own nested transaction/savepoint; these are matched
single-operation held-writer probes, not whole transform timings. All other
indexes/fields are identical between arms. WAL bytes include a 32-byte WAL header.

| Tags | Mint WAL before→ledger-minus-indexes | Mint hold ms | Status WAL before→ledger-minus-indexes | Status hold ms |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 976,472→984,712 | 7.513→7.774 | 527,392→659,232 | 2.587→3.222 |
| 10,000 | 1,017,672→1,001,192 | 123.123→85.554 | 527,392→659,232 | 3.919→3.403 |
| 60,000 | 972,352→959,992 | 662.019→408.105 | 527,392→659,232 | 5.108→2.618 |

Status WAL increases **131,840 bytes / 32 frames (+25%) at every size**: the new
ledger dirties one additional page per transaction, and removing the tag-order
index does not save that page on status-only writes. Faster noisy wall/hold
samples do not excuse this durable regression. The 1k mint also grows 0.8%.
The gate was reached and the implementation stopped before obtaining the parent
decision to exclude DB-5/11. **20 fixture/isolation checks passed**; performance
gates failed as reported, not counted as passing checks. lsof observed only this
task's copy/fixture database paths.

### What a future ledger redesign must prove

No redesign is included here. It must preserve identity/status/accounting and
pending-op freshness, generation/rollback/sibling-write safety, frozen decisions
and mutable-result isolation, while proving **non-regressing net WAL and hold on
both mint and status** at all three scales. It must account for record growth if
versions share an already-dirtied row, not just assume that sharing is free.
Keep bookkeeping small/separate so future per-session dirty-log triggers can
coexist; measure their combined write amplification too. A partial invalidation
key is not an acceptable way to meet the write gate.

## Reduced-cut implementation results

### DB-14 on its own

The reduced fixture uses an explicitly reconstructed **v94** schema, not the
new fresh initializer pretending to be the baseline. The candidate applies C/D/E
without a ledger or payload split. Same five-repetition, 32-operation held-writer
method as above. `--hot-only --index-only` reproduces this comparison in a fresh
copy root. **15 fixture/isolation checks passed**, 12 measurement records.

| Tags | Mint WAL before→reduced | Bytes saved / 32 mints | Mint hold ms | Status WAL before→reduced | Status hold ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 976,472→852,872 | 123,600 | 12.258→10.869 | 527,392→527,392 | 4.886→5.028 |
| 10,000 | 1,017,672→869,352 | 148,320 | 31.208→31.586 | 527,392→527,392 | 2.285→2.700 |
| 60,000 | 972,352→828,152 | 144,200 | 147.812→142.542 | 527,392→527,392 | 2.564→2.386 |

Minting saves **30/36/35 WAL frames** respectively. Status WAL is exactly
unchanged; sub-millisecond hold differences do not establish a speedup or a
regression under shared load. No new tag/status trigger or transaction policy
was deployed.

### Migration and durable-data rehearsal

The final specimen has **13,956 metadata rows, 2,082,727 tags and 48,035 git FTS
rows**. v94→95 via the real migration runner took **4,248.312 ms**, including
commit; the second no-op run took **0.158 ms**. Earlier warmed rehearsals took
308–319 ms. These are load-dependent measurements, not a latency guarantee.
Before/after streaming hashes match (FTS hash includes its actual **rowid**, not
just its content); quick_check=ok and foreign_key_check has **zero violations**.

| Data | Equal SHA-256 before/after |
| --- | --- |
| session_meta, all stored fields | `2b4168be6b2c4cdbdb408361208f3234c2d2c4cdab974ffa8dcbae722226964c` |
| tags, all stored fields | `4d5bb0150fc6fb6d7bf0b1ca4107781b7ceff509c4bfcad2aa2018070eb0235a` |
| git_commits_fts, rowid and stored fields | `f29626cb987325184bc32b75aa2d8cc8637940c584c80a1c55bf7aefded145d1` |

No rewrite of frozen decisions, head bytes, statuses, tag identities or FTS
content. The only new table is project-scoped git_commit_fts_rowid_map, so no
SESSION_SCOPED_TABLES entry is appropriate. There are no new columns to ensure;
fresh/current schema uses the shared installer, and old schemas leave its DDL
to v95's transaction. Existing ensureColumn logic is unchanged. A lost-ledger
replay validates an existing map and fails closed on disagreement; ordinary
current opens do not scan FTS or reset the map.

Rust's fingerprint includes **indexes**, so dropping the compartment prefix
index and adding the candidate session index changed the compartments and
user_memory_candidates fingerprints. Their two expected hashes were advanced,
and the schema fixture regenerated with `scripts/dump-context-db-schema.ts`.
The legacy v92 test removes all ledger rows >=93 so it still tests v92 rather
than accidentally leaving later version rows behind. This release needs a
rebuilt/restarted **ck-mc too**, not only the plugin dists: an old module refuses
the two changed domains rather than silently using the wrong schema. store.db
and its codec remain unchanged at 63.

### Real-host health and served bytes

All runs used this task's private HOME/XDG_* / OPENCODE_DB / context directories,
with lsof over the whole process group. Every database/sidecar descriptor was
under the resolved task root. Host stores were **synthetic**; no live OpenCode
store was copied. Old-holder checks and worker loading were not bypassed.

| Real host | Observed v95 transaction | Health probes | Longest successful-response gap |
| --- | ---: | ---: | ---: |
| OpenCode 1.18.30, final bundles | 1,918.5 ms writer hold | 94, all HTTP 200 | **666.877 ms** across the entire measured startup |
| OpenCode 2.0.22, final bundles | 321 ms in current worker log | 11, all HTTP 200; 1 overlaps v95 | **251 ms** overlapping migration; **363 ms** entire startup |

The worker start/apply logs name v95 and neither successful lane fell back to
main-thread migration. Health is sampled independently every 250 ms with a
1-second request timeout; current-run wall timestamps bracket the v95 log
interval. One earlier whole-startup v2 run under heavier load recorded four
timeouts. That sampler lacked wall correlation, so those cannot honestly be
assigned to or excluded from the migration. The instrument was improved to
record both whole-startup failures and the precise current-run migration
interval; the final lane has **zero failures even over whole startup**. It was
not made green by raising the timeout, ignoring a timed-out migration probe, or
changing production startup code. Initial v2 probe setup also needed its normal
directory-shaped module wrapper and actual activation wait; an absent plugin's
healthy host was correctly rejected.

Literal provider bodies match for **five requests on each host**: three growing
tail defers after restoring the same warmed v94 host/context snapshots, a priced
flush, and a second host process's restart defer. Both head hashes and the
materialization stamp remain unchanged during the pure defers and restart;
restart applies no migration. Session ids, reply ids and project paths are
preserved across arms. No byte normalization or field/hint stripping is used.

For deterministic replay, both fixtures explicitly set
`memory.auto_search.enabled=false` as well as disabling inference/background
features. Auto-search is independent of memory.enabled: an earlier default-hint
restart comparison differed only in a timing-dependent hint about the current
prompt; the four pre-restart requests were identical. The final comparison
**opts out symmetrically via the existing setting**, not by deleting the hint
from a captured request. This is replay evidence, not a claim that asynchronous
search hints are deterministic under all timing schedules.

| Host | Request | Bytes | Equal SHA-256 |
| --- | ---: | ---: | --- |
| 1.18.30 | 0 | 47,330 | `a7a8b7c8335e180c1f49debf22a6b5edbba8e8a0459533996c2fbd4561c2392c` |
| 1.18.30 | 1 | 47,473 | `86af95231ab98b905d0c15c5a8e78d688b7e10c4b940b3bf6313efdda0205580` |
| 1.18.30 | 2 | 47,616 | `60f81178b20b86207154607cab06ce8eaa3e74db770b584689dcb3f24914cc57` |
| 1.18.30 | 3 | 47,765 | `77598e3115caba7f412607a5ad23d049efe7dbfcb77221896e7b4ab6ee0c8228` |
| 1.18.30 | 4 | 47,916 | `c011be94c40a4ca16d98ba924a2a941a85100d9c6148944c300eb352c8d30095` |
| 2.0.22 | 0 | 36,849 | `0c760ade68d63e4a2196cba92c218e2a1cb9cae8466d3b65760c2205a4914f54` |
| 2.0.22 | 1 | 37,100 | `9dead67b17258ee038560973301d22da7ebf66694c0f26cc55baaaaeaa186227` |
| 2.0.22 | 2 | 37,351 | `697278ed19a9f63696fea491c84705216362dd823d28fd5ed487c9389ea7c24b` |
| 2.0.22 | 3 | 37,607 | `6dfa74cb0492a9dba749127ff13918a10852afde884f632b153e1dbf367cd89f` |
| 2.0.22 | 4 | 37,866 | `888702d442a9f64b599796ad80781f0da9c5163e0d9afa8341f0586c3d61a3f0` |

### Gates, fixes and limits

- Bun 1.4.2, TypeScript 5.9.3, Node v24.16.0 (SQLite 3.53.0), Bun SQLite 3.54.0,
  Biome 2.5.1, cargo/rustc 1.99.0, rustfmt 1.10.0.
- Final plugin lint checked **1,221 files**, with only one pre-existing warning
  and two pre-existing infos in unrelated files. Scoped AFT inspection had no
  TypeScript errors but remained partial for Biome and Rust metadata; the real
  package commands provide the verification evidence.
- Plugin package typecheck passes all three tsc projects. Full plugin suite:
  **6,877 passed / 4 skipped / 3 failed** initially. All three failures were
  migration-test obligations: v38 still asserted the intentionally retired
  prefix index twice, and the armed step-through lacked a v95 population arm.
  They now assert the replacement retention index and continue checking all
  original data/authority properties; v94 seeds a real git row for v95 and an
  independent claimed-arm signature prevents silent empty coverage. The focused
  rerun is **11 passed / 0 failed** (these three plus eight v95 cases). No test
  was rewritten to accept opposite served/recovery behavior. Another focused
  storage/git/fence run passed **92 tests**; worker/trim/fence run had 18 passes
  plus the stale numeric fence assertion, subsequently corrected and passed.
- Pi typecheck and complete serial suite: **1,524 passed / 3 skipped / 0 failed**.
  Both package test scripts' frozen installs checked 995 installs / 1,250 packages
  without manifest/lock changes.
- Actual v95 helper bundled for Node, not a second copy of its SQL: **9 checks
  passed**, including gapped/duplicate/NULL FTS rowids, amend/delete/REPLACE,
  actual virtual rowid capture, autocommit index discovery, no-op install and
  failed inventory replay. Earlier design-only Node checks are not substituted
  for this runtime check.
- `bun run build:dists` passed, including **4/4** v2 loader tests and all **3**
  load probes. An import-graph check of OpenCode 1/2 and Pi **six entry/worker
  graphs** finds only fence **95** in reachable chunks (63/18, 55/17, 33/12 files
  respectively). Unreferenced stale chunks were not counted as shipped code.
- Rust package compilation succeeded, then the correctly selected ceiling test
  passed **1/1** and HostStore tests **29 passed / 2 ignored**; fmt check passed.
  The initial `--exact` filter selected zero tests and is explicitly **not** test
  evidence. A sibling path dependency advanced cortexkit-store 0.2.0→0.2.1 during
  the queued build, so subsequent --locked commands/LSP metadata failed. The
  scoped rerun used temporary **offline** lock resolution, then restored the
  staged original Cargo.lock; no dependency/lock upgrade is included in this
  branch. The regenerated fixture exposed the two index-sensitive fingerprints,
  which were corrected before the green rerun. No broad native host/daemon suite
  or clippy run is claimed.
- Four independent controls reddened only their named v95 test, with **7 peer
  tests passing** each: FTS full-scan delete, missing retention index,
  rollback-local index-name caching, and omitted existing-map validation.
  Every control used staged live state, a nonempty mutant diff, checkout/touch
  restore, and an empty working diff. No mutant was built or retained.
- The large specimen, its working copies/sidecars and throwaway host roots are
  deleted after connections close. No binary placement or live migration is
  performed. ARCHITECTURE.md, STRUCTURE.md, compaction-marker-manager.ts,
  compartment-storage.ts and selection/config files remain unchanged.

## Adversarial-review follow-up

The review in `docs/reports/migration-v95-review.md` was imported by merging
master before these changes. The parent clarified that **v95 is unshipped**:
no live/user store has applied it. Accordingly its map DDL is corrected in place,
with no conversion shim, v96, cache reset or store.db change. Every follow-up
rehearsal starts from a fresh v94 backup clone and the final emitted bundles.

### B1: unavailable workers fail closed

Worker construction errors, pre-ready errors/exits, and completion before ready
now reject with the underlying cause and **“the migration worker could not
start; reinstall or rebuild the plugin”** guidance. The async opener contains
no main-thread migration-runner call. It refuses incomplete workers while a
migration remains pending, and refuses pending in-memory/URI async opens rather
than quietly using a synchronous path. Explicit synchronous opens still migrate
for CLI/tests; the existing counter control proves that path is observable.

Synchronous host access after bootstrap is explicitly **current-schema-only**.
Tool registration, startup maintenance, RPC and dream triggers cannot cold-migrate
after an earlier async open failed: they reuse/open a current store or return
unavailable and let the async recovery path own the upgrade. This closes the
secondary registration path that could otherwise resurrect the forbidden fallback.
The explicit sync opener remains unchanged by default for offline CLI/tests.
The OpenCode 1 failure test also calls the real tool registry after failed boot
and requires an empty registry and zero main-thread bodies. Healthy registry
fixtures now explicitly establish storage first, as the real host does.

The old fallback-success assertion was replaced deliberately: fallback is now
forbidden because a supervised host can otherwise stall, be killed, roll back
the transaction and repeat the same stalled migration on restart. This changes
broken-install startup from apparent recovery to a clear storage refusal, not
healthy transform behavior. OpenCode 1's actual async session-hook factory records
the storage failure and its primary transform refuses; OpenCode 2's actual boot
gate refuses before a request; Pi's actual extension factory installs its
fail-closed surface and the installed Pi context runner aborts. Default blocking
and compaction settings are used; existing explicit user opt-outs are unchanged.

New logs expose worker ready, connection close, and async-open main-thread
migration-body delta/total. Commit is the existing applied-v95 log after COMMIT.
The real-host records below show **delta=0 and total=0**. A missing-worker mutation
that actually runs the old synchronous migration made only
**“a worker that cannot load refuses pending v95 without a main-thread fallback”**
fail; **9 worker-test peers passed**. The mutation was restored before builds.

### S1: explicit offline diagnosis and map-only repair

Commands:

```sh
magic-context doctor git-fts-map
magic-context doctor git-fts-map --repair [--backup-root <directory>]
```

The first command is a read-only, single-snapshot inventory check. It reports
missing map rows, mismatched values/storage classes and extra rows. It does not
create a database, migrate, fix the map, or rebuild FTS. These scans are **not**
added to normal opens. A missing entire map on a current store now refuses online
initialization with the offline command, rather than silently scanning/backfilling
it on the host thread. Existing-map disagreement during migration replay names
the same command.

Repair requires both context.db and store.db, a supported context lane (94 for
lost-ledger recovery or 95), and all OpenCode, Pi/OMP, dashboard and ck-mc holders
stopped. Holder uncertainty also refuses. It locks **both files IMMEDIATE**,
rechecks holders, takes read-only VACUUM snapshots of committed data in a unique
backup directory, and quick-checks both snapshots **before changing any map row**.
The locks prevent a new writer from splitting the backup consistency unit. The
store transaction has no mutations and is rolled back. Backup manifests and
messages explicitly require restoring both stores or neither.

Within that same context IMMEDIATE transaction, the only data rewrite is:

```sql
DELETE FROM git_commit_fts_rowid_map;
INSERT INTO git_commit_fts_rowid_map(fts_rowid, sha)
SELECT rowid, sha FROM git_commits_fts;
```

If the map table itself is absent, only its final table/index are provisioned
inside this offline transaction. Both anti-joins verify exact rowid/value/**type**
inventory before COMMIT; failure rolls back. No schema-ledger row is inserted or
forced, no UUID is minted, no FTS row is deleted/retokenized, and no rendered
head/replay decision is invalidated. Existing stale/orphan FTS documents are
intentionally preserved; corpus cleanup remains a separate policy decision.
Normal v95 replay can proceed after a lost-ledger repair.

**8 doctor tests** cover read-only damage diagnosis, backup-before-write ordering,
paired-store presence, initial/late holders, verification rollback, entire-map
absence, raw numeric SHA preservation and unchanged metadata/FTS/ledger. The
emitted CLI was also exercised under **Node v24.16.0 / SQLite 3.53.0**: damaged
diagnostic exits 1, repair verifies a backup pair, post-diagnostic exits 0. Four
independent result assertions verify ledger **94**, integer SHA **123**, and
actual FTS rowid **7**. A late-holder-recheck mutation reddened only its named
doctor test (**7 peers passed**). A forced normal-open inventory scan reddened
only the current-initializer test (**9 v95 peers passed**).

### S2: preserve numeric SHA storage and old matching

The map's `sha BLOB` column has **no affinity coercion**. It keeps text, integer,
real, BLOB and NULL values from FTS; the replay/doctor anti-joins also compare
`typeof`, not just SQLite value equality. The review's exact orphan probe is
included: `(rowid=7, sha=123, project_path='project', message='numeric legacy')`.
It survives the first migration and removal/replay of ledger 95 with integer
storage in both FTS and map. Public insert/delete for text SHA `'123'` does **not**
match or erase that numeric orphan, matching v94's actual trigger behavior.
Changing the DDL back to TEXT reddened only this test (**9 peers passed**).

The schema fixture was regenerated. Rust's domain fingerprints did **not** move
because this project-owned map is not a Rust domain table; the exact committed
snapshot/fingerprint test passed. No extra schema version is introduced.

### S3: full-size host/holder/restart rehearsal

Source: the permitted **read-only backup pair** at
`$TMPDIR/magic-context/ckmc-perf/backups/`, never either live database. Disk
preflight showed **26 GiB free**. APFS clones preserve the seed; only disposable
working destinations become owner-writable. The source context is **5.7 GiB** at
v94, with **2,070,685 tags, 344,457 message-map rows, 47,897 git FTS rows** and
13,735 metadata rows. store.db is a **1.0 GiB** paired snapshot. The first 60-second
quick_check limit was too short under shared I/O; the bounded 600-second check
completed **ok**. No source permissions or backup contents were changed.

The instrument now queries **each host's actual context.db** before and after
startup/restart and records those three corpus counts, rather than inferring
scale from a separate specimen. All hosts retained the full counts and moved
94→95. Raw OpenCode stores remain synthetic, as required; they are not the large
database being migrated. Dreamer/historian/inference/background hint features
are disabled symmetrically. lsof audits the whole host process group and the
independent holder; every database/WAL/SHM descriptor is under the resolved task
root. No migration guard is bypassed.

`/health` requests are scheduled independently every **250 ms**, with the same
**1-second timeout**. The recorded interval runs from the worker's v95 batch
start through **connection close**, so post-COMMIT checkpoint/close is included.
Success gaps overlapping that interval and whole-startup failures are reported
separately. All four full-size cases have **zero failures even across whole
startup**, and all main-thread-body logs are **0 (total=0)**.

| Host / case | Worker start → COMMIT → close (UTC) | Batch start→close ms | Probes / overlapping v95 | Longest v95 gap ms | Whole-startup max gap ms |
| --- | --- | ---: | ---: | ---: | ---: |
| OpenCode 1.18.30, alone | 18:00:43.239 → 44.310 → 44.321 | 647 | 109 / 3 | **374** | 766 |
| OpenCode 1.18.30, second-process reader | 18:00:59.532 → 18:01:00.057 → 00.061 | 506 | 34 / 2 | **472** | 702 |
| OpenCode 2.0.22, alone | 18:01:07.086 → 07.506 → 07.511 | 371 | 13 / 1 | **299** | 431 |
| OpenCode 2.0.22, second-process reader | 18:01:14.757 → 15.568 → 15.571 | 795 | 17 / 4 | **273** | 894 |

Dates are **2026-10-05**, wall timestamps generated by the actual emitted workers.
For each reader case, a separate Bun process holds an old-schema read snapshot
on that full copy throughout migration. Its handle is read-write so SQLite can
create WAL/SHM bookkeeping, but its only statements are BEGIN and SELECT; it does
not mutate rows or hold a writer lock. This tests an open/pinned reader, **not**
writer-lock admission latency. Its lsof paths prove it is attached to the same
working copy, not the seed or another fixture. An initial read-only-handle probe
could not open WAL bookkeeping and was rejected before measurement, not counted
as a passing holder case.

Each real host was then shut down and restarted against its **same full v95
copy**, with no worker or applied-v95 log and main-thread-body count still zero:

| Restart | Health successes / failures | Longest gap ms |
| --- | ---: | ---: |
| 1.18.30 alone | 8 / 0 | 333 |
| 1.18.30 after reader case | 8 / 0 | 294 |
| 2.0.22 alone | 10 / 0 | 472 |
| 2.0.22 after reader case | 12 / 0 | 912 |

Pi was practical too: **real Pi 0.83.0 RPC CLI under Node v24.16.0**, final Pi
dist, the same full context corpus and fully fenced HOME/XDG/agent/storage paths.
Migration worker start **18:01:22.837**, COMMIT **18:01:23.632**, close
**18:01:23.636**; its v95 batch begins at **18:01:22.897** (739 ms to close).
The verified boot plus lsof/count capture took **3,127.560 ms**, no-op restart
**2,088.394 ms**; both main-thread-body counts are zero and corpus counts unchanged.
Pi's RPC get_state can respond **before** async extension storage completes, so
the instrument waits for the real completion log instead of falsely declaring
storage ready on that first RPC response. No inference, provider-body comparison
or Pi `/health` SLA is claimed by this boot-only probe.

The final backup-copy runner also independently verified streaming metadata,
tag and FTS/rowid hashes unchanged, quick_check=ok, zero foreign-key violations,
v95 duration **1,005.407 ms** and no-op duration **0.514 ms**. An earlier warm
follow-up run measured 418.246/0.089 ms. These load-dependent figures
do not replace the real-host intervals above or promise a fixed migration time.

Reproduction: the updated `migration-batch-hosts.mjs` accepts `--health-only
--full-size-health` and tests the four cases plus their restarts. The separate
`migration-batch-pi-boot.mjs` uses the real Node Pi RPC CLI. Every native subprocess
has an outer timeout, and the scripts record raw samples/worker timestamps,
corpus counts and lsof inventories under the private root. Read-only seed files,
working copies, captures and roots are removed after all connections close;
the permitted backup source remains untouched.

### Follow-up verification and baseline limits

- Merged master manifests/lockfiles were installed with frozen Bun install:
  **995 installs / 1,250 packages**, no additional lockfile edits.
- Plugin, CLI and Pi package typechecks passed; TypeScript **5.9.3**. Focused
  worker/host-boot/map/transaction-route run: **24 passed**; doctor plus CLI help:
  **26 passed**; actual Pi fail-closed boot: **1 passed**.
  After hardening the secondary synchronous host-access path, **86 affected
  boot/tool/timer/transform/dream-trigger tests passed**, and both real-host
  full-size/restart matrices plus Pi were repeated with the final emitted code.
- Full plugin run: **6,886 passed / 4 skipped / 2 failed** initially. One failure
  required making both repair BEGIN calls **standalone shared Database.exec**
  acquisitions instead of combined PRAGMA/BEGIN SQL; the acquisition fence and
  affected tests passed on rerun. The other is **pre-existing on merged master**:
  dashboard `structured-save.test.ts` allocates raw temporary directories, which
  the cross-package registered-temp-dir guard rejects. That unrelated dashboard
  test and the guard were not weakened or edited.
- Complete CLI suite: **608 + 9 + 8 + 10 + 8 passed**, **2 skipped**, zero failures.
  Complete Pi serial suite: **1,525 passed / 3 skipped**, zero failures.
- `bun run build:dists` passed with **4 loader tests / 3 load probes**; CLI build
  passed (**401 modules**). All six emitted OpenCode/Pi entry/worker dependency
  graphs are fenced at 95, contain the fail-closed worker error/final BLOB DDL,
  and contain **no worker_unavailable fallback**. No mutant was built.
- Regenerated Rust schema fingerprint assertion: **1 passed**, cargo 1.99.0
  `--locked -j 2 -p mc-module --lib`; rustfmt 1.10.0 check passed. No Rust domain
  hash or native-store migration changes were required.
- Five independent follow-up controls reddened only their named assertion:
  missing-worker main-thread fallback (9 peers green), late-holder acceptance
  (7 peers), normal-open inventory scanning (9 peers), and numeric SHA coercion
  (9 peers), plus enabling cold migration through host tool registration (its
  OpenCode 1 boot test red, OpenCode 2 peer green). All used staged live state, nonempty mutant diff, checkout/touch
  restore and empty working diff. The existing fallback-success assertion was
  replaced because the accepted broken-install contract intentionally changed.
