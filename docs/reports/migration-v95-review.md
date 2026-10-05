# Adversarial review: context.db v95

## Verdict and scope

**Do not claim the requested “never migrates on the main thread” property.** A
missing/unloadable migration worker still makes the async host opener apply v95
synchronously. This is a **blocker for that startup acceptance criterion**, not
a newly introduced fallback. The ordinary, successfully loaded worker path is
off-thread. I found **no new full-table scan caused by an index removal in the
session/project query families inspected**, and no changed uniqueness constraint.
The healthy FTS-map lifecycle survived independent crash and concurrent-writer
probes. Its only new table is `git_commit_fts_rowid_map`. Damaged-map recovery
and real-size host health still need attention.

Reviewed delivery:

- Branch: `alfonso/task/bg_9951be3e1d89f0fa-perf-audit-migration-batch-plan-first`.
- Plan: `7c496fa372dba4dfdc7d7ce79935bced75956b33`.
- Implementation: `d909961bd2326a3f346c23c31d1f74c98171830b`.
- Implementation base: `51ece6fd479b27364458f7e735af3052abe2d706`.
- The intended plan file **exists at those target commits**:
  `docs/designs/perf-audit-migration-batch.md`. It is absent at this review
  branch's starting revision; I inspected the target commits in this isolated
  worktree, then returned to the review branch. No compatibility shim or
  production-code change is included.

**Every file:line citation below refers to d909961b**, unless explicitly marked
as the v94 base. This report separates independently executed probes from the
implementation's recorded rehearsal; it does not recast their measurements as
new measurements.

## Isolation and methods

Live-store isolation, verbatim: never open/read/write/migrate the live stores
(`~/.local/share/opencode/*.db`,
`~/.local/share/cortexkit/magic-context/{context,store}.db`,
`~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a
throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`,
`XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under
`$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only
throwaway `.db` paths; a single live-store write is a rejected delivery.

No OpenCode, Pi, dashboard, or ck-mc host/service was launched for this review.
No live store or permitted backup specimen was opened or copied. Database probes
and library-level tests used synthetic stores only. Every shell invocation had
an outer `timeout`. Their environment set HOME, all four XDG homes, OPENCODE_DB,
MAGIC_CONTEXT_STORAGE_DIR, and test TMPDIR below
`$TMPDIR/magic-context/migration-v95-review-bg_a1e0053e8c68b1c8/`
(or the standalone reproduction's new `migration-v95-review-repro-<pid>/` root).
The package preload additionally enforced test data/config isolation.

For the file-backed probes, `lsof -p` was checked against the **realpath** of
that root (macOS `/var` resolves to `/private/var`). All database, WAL, and SHM
descriptors were beneath it:

| Probe | PID(s) | Database basename(s) observed |
| --- | --- | --- |
| Populated plans | 33063 | `plans-v3.db`, `plans-v3.db-wal`, `plans-v3.db-shm` |
| Missing-map/recovery | 33409 | `fts.db` and its WAL/SHM |
| Missing-worker v94→95 | 33475 | `fallback.db` and its WAL/SHM, before and after |
| Legacy numeric SHA | 33563 | `numeric.db` and its WAL/SHM |
| SIGKILL/rollback | 68184, 65972 | `crash.db` and its WAL/SHM |
| Two simultaneous migrators/indexers | 70834, 70841, 69765 | `race.db` and its WAL/SHM |
| Actual v94 plugin/CLI versus v95 | 4636 | `plans-v3.db` and its WAL/SHM |
| Exact Appendix B reproduction | 28506 | `context.db` and its WAL/SHM under the new `migration-v95-review-repro-28495/` root |

The Node driver check used `:memory:`. These are library-client isolation
observations, **not** a substitute for host-process lsof or `/health` evidence.

## Findings

### B1 — blocker: unloadable worker falls back to main-thread v95

**Impact.** A packaging/runtime error changes a multi-second SQLite migration
into an event-loop stall instead of refusing startup. The implementation's
4.248-second copy transaction is long enough to miss a one-second health budget
if executed synchronously. That duration is not a measured fallback stall.

**Evidence.**

- `packages/plugin/src/features/magic-context/migration-worker-client.ts:6-12`
  explicitly documents main-thread fallback. Constructor failures return
  `worker_unavailable` at `:48-55`; pre-ready error/exit takes the same path at
  `:75-81,103-114`.
- `packages/plugin/src/features/magic-context/storage-db.ts:2806-2816` awaits
  that worker but **does not gate on its outcome**, then calls
  `runMigrationsWithRetry` on the main connection.
- The synchronous opener also migrates in place at `storage-db.ts:2713-2714`.
  It is blocked while an async open is pending (`:2670-2679`), not universally
  forbidden for a cold database.
- `packages/plugin/src/features/magic-context/migration-worker.test.ts:95-104`
  currently asserts that fallback **succeeds** and increments the main-thread
  migration counter. This test passed in the review run; it defends the opposite
  of the unconditional startup requirement.
- The plan itself rejects this outcome:
  `docs/designs/perf-audit-migration-batch.md:766-769`.

**Executed throwaway reproduction.** A reconstructed v94 store was closed, the
worker-entry test seam was pointed at a nonexistent file, and the actual
`openDatabaseAsync({dbPath})` was called. Its counter changed by **1**, and its
ledger became **95**. No worker applied that migration body:

```text
v94-to-v95 missing worker main-thread body delta 1 ledger { v: 95 }
```

The standalone reproduction in Appendix B uses the same public opener and test
seam; no production source mutation is needed. This is a counterexample to
“never,” not evidence that properly emitted workers fail to load.

**Disposition.** Before accepting that startup guarantee, make a worker loading
failure fail closed (or explicitly relax the guarantee), and test it at v95.
Also distinguish CLI/test/subagent synchronous opens from the host's boot path.
I made no production change. This fallback predates v95; the finding is about
the release criterion applied to this irreversible, potentially long migration.

### S1 — should-fix: a missing map row is silently trusted on normal opens

**Impact.** A damaged rowid ledger is not just a performance degradation. An
amend leaves an unmapped old FTS document behind, so the search join can return
the same canonical commit twice and rank it using stale terms. Deletion/eviction
removes only mapped documents. The remaining orphan still participates in FTS
corpus statistics, even if the base-table join hides it after deletion.

**Evidence.**

- `packages/plugin/src/features/magic-context/migration-v95-perf-indexes.ts:26-35`
  deletes **only** rowids listed for that SHA. There is no absent-map fallback.
- Existing maps are checked only when `verifyExistingMap` is true at `:84-99`.
  Migration 95 passes true (`migrations.ts:3207-3212`), but the current/fresh
  initializer calls the default false (`storage-db.ts:2579-2582`). No integrity
  validation of an existing map is performed by a normal current open.
- An unchanged public upsert does not trigger any FTS/map repair:
  `git-commits/storage-git-commits.ts:36-45` skips updates unless the message
  differs.
- Search joins by SHA, not rowid:
  `git-commits/search-git-commits.ts:110-118`.

**Executed damage probe (not a normal API transition).** In a healthy synthetic
v95 store with one commit, I deleted its map row, then called the actual public
upsert API:

```text
unchanged upsert: { inserted: 0, updated: 0 }; old FTS row remains unmapped
amend: FTS row 1 = "old cache" (unmapped), row 2 = "new cache" (mapped)
MATCH 'cache' join: two "new cache" results, each bm25 = -0.000001
DELETE FROM git_commits: row 1 = "old cache" remains, with no map row
```

No inspected normal writer independently edits this new map or directly rewrites
git FTS. The healthy insert/update/REPLACE/concurrency/crash controls passed
(N2). This is therefore a **damage/recovery should-fix**, not a claim that an
ordinary transaction spontaneously loses a map row.

**Recovery and lost-ledger behavior.** Removing the v95 migration row from that
damaged store makes replay throw:

```text
Migration v95 failed: git FTS rowid inventory differs; refusing migration replay.
Database may need manual repair.
```

The ledger remains at 94, and the worker/opener propagates the error rather than
providing an in-memory fallback (`migration-worker.ts:54-58`,
`storage-db.ts:2821-2827`). This disables Magic Context until repair; it does
**not** destroy the durable store or constitute an unrecoverable brick. Doctor's
generic `.recover` is a physical salvage workflow, not a dedicated logical map
repair (`packages/cli/src/commands/doctor-repair-db.ts:303-345,422-430`).

For ordinary text/NULL SHAs and an otherwise intact FTS corpus, the tested
recovery was: stop all writers; retain a consistent context.db/store.db backup
pair; repair a disposable copy; inside one IMMEDIATE transaction replace **only
the map inventory** with `SELECT rowid, sha FROM git_commits_fts`; verify both
anti-joins used at `migration-v95-perf-indexes.ts:89-95`; then let the normal v95
runner replay. The copy recovered to 95 with its old FTS rowid/content preserved.
Do not derive FTS rowids from `git_commits.rowid`, retokenize/rebuild FTS, force a
95 ledger row past validation, or suggest downgrading the shared database.
The orphan remains intentionally preserved; corpus cleaning is a separate
decision. No live repair was performed.

Ship a documented, offline logical-map diagnostic/repair path. Whole-map absence
is another special case: the initializer creates/backfills it at `:74-78` without
the migration transaction when the database is already current. That is not a
safe online multi-writer repair protocol and can run on the main thread. Do not
rely on deleting the map table during a running host as recovery.

### S2 — should-fix: numeric legacy FTS SHAs defeat otherwise healthy replay

**Evidence.** `migration-v95-perf-indexes.ts:21-24` gives the map SHA **TEXT
affinity**. The FTS column has no such affinity. The initial copy at `:77`
coerces a legacy numeric FTS SHA into text; the later replay check uses
`m.sha IS NOT f.sha` at `:91`, which rejects the different storage classes.

**Executed minimal probe.** Before v95, a synthetic FTS orphan was inserted as
`(rowid=7, sha=123, project_path='project', message='numeric legacy')`. The first
migration succeeded and preserved the FTS row. Its types were then
`typeof(f.sha)='integer'`, `typeof(m.sha)='text'`. Removing only ledger row 95 and
replaying raised the inventory-refusal error above, without any map damage.

Public git indexing supplies hexadecimal string SHAs, so this does not affect
the ordinary corpus. But the stated legacy duplicate/orphan preservation policy
is broader, and the initial migration admits this row. A repeated plain map
backfill will **not** repair this case: TEXT affinity repeats the coercion.
Either preserve the relevant storage classes/matching semantics or explicitly
diagnose/reject unsupported legacy SHA types before declaring replay-safe.
Treat it as lower-probability recovery hardening, not an observed live defect.

### S3 — should-fix: real-size host health is not independently established

The correctly loaded worker owns its own connection and applies the migration
off-thread (`migration-worker.ts:28-53`, `storage-db.ts:2800-2812`). It closes
before reporting completion to avoid checkpoint/open races. Host boot reaches
this async path in `packages/plugin/src/hooks/magic-context/hook.ts:1258`,
`packages/plugin/src/v2/hooks/storage-gate.ts:63`, and
`packages/pi-plugin/src/index.ts:1220`. There is no new main-thread *normal*
migration path in this patch. B1 is the exceptional fallback.

However, these are distinct claims:

1. The recorded copy transaction processed 2,082,727 tags / 48,035 git FTS rows in
   **4,248.312 ms**, including commit (`docs/designs/perf-audit-migration-batch.md:943-948`).
2. The recorded real-host health runs used **synthetic** stores and measured
   **1,918.5 ms** and **321 ms** migration intervals (`:974-984`).
3. Neither proves a two-million-tag host boot meets the one-second health gap
   criterion. This review launched no host and makes no new `/health` claim.

v95 does not build a new index on tags: it drops the duplicate tag-order index.
Its new index builds cover the message map, telemetry, plugin messages and
candidates; it also scans git FTS once. Total file size/tag count alone is not
the build workload. A representative large copy still matters because it carries
the actual distribution of those tables and the host's subsequent startup reads.

**A real-size host rehearsal is warranted before release**, using an already
permitted read-only backup copied to a fully fenced throwaway host root, never a
live store. Use both supported OpenCode versions, the actual emitted worker
dependency graphs, zero main-thread-body count, and lsof over host/children.
Correlate every successful response and timeout with worker start/commit/close
and plugin activation. Include restart/no-op and a simultaneous writer/holder
case. Worker isolation removes the synchronous migration body from the host
event loop, but disk/CPU contention, checkpoint/open lock waits and subsequent
main-thread initialization/backfills are not a hard `/health` SLA. Four seconds
on the copy versus shorter synthetic intervals is precisely the missing scale
evidence, not proof of a stall.

### N1 — note: index removals retain lookup coverage and all unique constraints

Appendix A records the query inventory and plan comparisons. The synthetic
plan fixture had 200,000 tags, 200,000 message-map rows, 40,000 telemetry rows,
and 10,000 rows each in compartments, pending ops, source contents, compression
depth, key files, plugin messages and user-memory candidates, spread over 100
sessions/projects. These are populated query-plan checks, not a six-GiB or
two-million-tag performance rehearsal.

Across **38 SQL shapes**, **15 plans changed**. No previously indexed
session/project shape became a full-table scan. `PRAGMA index_list/index_xinfo`
showed identical **unique-index definitions on all seven affected tables**.
The code drops only the seven named non-unique indexes; it rebuilds none of
those base tables (`migration-v95-perf-indexes.ts:11-19,64-70`). Partial active/
dropped tag indexes, tool/owner/adoption constraints and message/time indexes
remain. The migration tests additionally exercise an actual duplicate tag-number
violation (`migrations-v95.test.ts:138-170`).

Two qualifications should not be hidden under “redundant”:

- `hooks/magic-context/tag-messages.ts:572` orders a session's compartment rows
  by **rowid**, not sequence. Before: `idx_compartments_session`, no sort. After:
  `sqlite_autoindex_compartments_1` **plus TEMP B-TREE FOR ORDER BY**. The query
  stays session-scoped and preserves its explicit order, but this is a real sort
  regression. Measure unusually large compartment sessions if this removal is
  expected to be unconditionally faster.
- `plugin/rpc-handlers.ts:953-963` requests 100 pending ops **without ORDER BY**.
  The returned array changes from rowid visitation to tag-id visitation. The
  probe's first five tag ids changed `[10000,9900,9800,9700,9600]` →
  `[100,200,300,400,500]`. Its comment says the array is unused by the UI;
  `storage-ops.ts:28` explicitly orders the transform's real queue by
  `queued_at,id`, so this is **not** a transform-selection or served-provider
  regression. Do not claim every diagnostic/RPC array is byte-identical.

Global inventory/list queries naturally still scan: dashboard compartment
aggregation (`packages/dashboard/src-tauri/src/db.rs:6350-6357`) scans the
retained sequence index; candidate listings (`:8208-8211`) scan the unchanged
created-at index. FTS MATCH plans say `SCAN ... VIRTUAL TABLE INDEX ...:M3`, which
is an inverted-index search, not the unindexed SHA pre-delete being removed.
A deliberately unscoped `message_fts_rowid_map WHERE fts_rowid=?` remains a scan
before **and** after; the new index requires session_id. Real message search
joins constrain both (`features/magic-context/search.ts:541-546`). A promise
that *all* queries avoid *all* scans would be incorrect.

### N2 — note: healthy FTS/map transactions are atomic; no normal drift found

- Migration 95 creates the map from the **existing virtual-table rowids**, with
  no FTS rebuild (`migration-v95-perf-indexes.ts:74-78`). Existing duplicates,
  orphan rows and NULL SHAs are copied; the map is non-unique by SHA.
- Insert/amend removes all mapped same-SHA documents before inserting the new
  one. The very next statement captures the actual FTS rowid with
  `last_insert_rowid()` (`:26-49`). Trigger statements and the canonical write
  are in one SQLite transaction. Public indexing uses IMMEDIATE transactions
  (`git-commits/storage-git-commits.ts:128-149`); cap eviction uses one DELETE
  (`:96-102,181-185`).
- Both recursive-trigger settings for REPLACE, duplicate cleanup, deletion and
  eviction passed the v95 suite. Independent **Node v24.16.0 / SQLite 3.53.0**
  checks used a bundle of the actual installer, not handwritten replacement
  triggers: **9/9** checks passed, including gapped rowids 3/77/99, duplicate/NULL
  inventory, amend, both REPLACE modes, rollback, delete, matching replay and
  damaged replay refusal. Bun used **1.4.2 / SQLite 3.54.0**.
- Independent SIGKILL after the actual v95 body **and** an uncommitted 95 ledger
  insert, before COMMIT: reopen found version **94**, the old compartment index,
  **no map table or retention index**, original FTS rowid/content, and
  `quick_check=ok`. This tests process death, not just a caught JS exception.
- Two concurrently spawned library clients migrated the same v94 file and each
  ran 100 IMMEDIATE public upsert batches, including a shared SHA. Completion
  left **201 FTS documents**, exact map equality, and one v95 ledger row. Cap
  eviction to one left **1 FTS / 1 map** row. SQLite serialization, not a
  process-local lock, protects the map. No claim is made about cross-host
  readiness/health from this library test.

“Project-scoped” here means project-owned lifecycle, **not a `(project,sha)` key**.
The pre-existing `git_commits` table has a global SHA primary key
(`migrations.ts:419-428`); the new map still keys its SHA lookup globally.
Cross-project identical-SHA ownership behavior is unchanged, not newly repaired.
No runtime SHA-only retarget writer was found; UPDATE still watches only message
and project_path, as v94 did.

### N3 — note: mixed-version outcomes are refusal/degradation, not corruption

| Combination | Outcome and evidence |
| --- | --- |
| v94 TypeScript host opening a v95 file | **Refuses storage**, disables/degrades Magic Context. Fence is checked before initialize/migrate (`storage-db.ts:416-431,2703-2714`); cached handles recheck at `:2681-2683`; transform-side probe rejects future lanes (`schema-fence-probe.ts:83-91`). Actual base-51ece6fd library probe returned null with `{persistedVersion:95,supportedVersion:94}`. |
| v95 plugin with old ck-mc | **Partial Rust-domain refusal**, not whole-file fence rejection. The built lane is informational; each write checks domain/privilege fingerprints (`crates/mc-module/src/host_store.rs:55-61,625-637,643-654`). The old hashes differ for **compartments** and **user_memory_candidates** (`:312-315,344-347`); a publish involving those tables refuses with `single_store_fingerprint_mismatch`. Unchanged domains remain eligible. This degrades historian/observation publication and is not a compatible rolling upgrade. |
| Old dashboard, built at the v94 code | **Continues reading and writing the unchanged shapes.** `packages/dashboard/src-tauri/src/db.rs:688-698,739-758` has no maximum context lane fence. Workspace support checks a minimum (`workspaces.rs:88-93`), not a ceiling. v95 only changes ordinary indexes and git triggers the dashboard does not author. SQLite runs the new triggers/authority guards. No v95-specific corruption path found; this is source/SQL evidence, not a launched dashboard test. |
| v94 CLI doctor | **Graceful diagnostic degradation and mutation refusal.** The context opener rejects 95 for both readonly/write (`packages/cli/src/lib/database-access.ts:103-118`); the doctor sweep skips fenced stores (`commands/doctor.ts:98-107`). Its raw version/cached-plugin detector deliberately still reads 95 (`doctor-cached-plugin-fence.ts:90-103`). Actual v94 library probes verified both refusals, raw version 95, and unchanged schema/ledger: **5 checks passed**. Updating/unpinning the plugin is recovery, not downgrading the DB. |

An old ck-mc is **not** made safe merely by bumping a displayed ceiling. A rebuilt
and restarted module must carry the two new hashes. Conversely, a new module
against the old v94 index shape can refuse those domains until the plugin has
completed migration. Coordinate activation/restart; don't advertise plugin-only
upgrade compatibility. I did not compile or run an old/new native binary; the
actual fingerprint logic and old/new constants are the evidence here.

Checklist from `STRUCTURE.md:52`:

- `storage-db.ts:161` is **95**, and migration 95 is the maximum
  (`migrations.ts:3207-3225`); the fence test passed.
- Fresh/current installer is wired at `storage-db.ts:2579-2582`. On an old lane
  it leaves C/D/E to migration 95. Migration 4 still owns git's base schema, and
  the v95 installer runs after those tables exist. Existing migrations 1–94 are
  unchanged. Repeated current install does not recreate dropped indexes or
  rewrite FTS (the corresponding v95 test passed).
- `migrations-v95.test.ts` exists and all **8** cases passed; the populated
  armed chain now includes 95 (`migrations-armed-replay.test.ts:739`).
- There are **no new columns** to add via ensureColumn, and no new session-owned
  table. `storage-session-tables.ts:16-62` correctly excludes the new map. It
  must survive a session/harness sweep; project commit DELETE owns its cleanup.
  `scripts/clone-session.ts:104-121,1271-1278` filters/copied-counts session-owned
  tables, not this global/project-owned map; no direct git-FTS rebuild writer
  was found in that script.
- store.db remains **63**: the mc-store migration list still ends in 063
  (`crates/mc-store/src/lib.rs:3225-3238`), with no mc-store diff in the delivery.

### N4 — note: healthy transform-serving code/bytes are unchanged; scope limits matter

The base→implementation diff contains **no transform renderer, selection/config,
protected-tail, marker, replay, cache epoch, search formatting, Pi runtime,
dashboard reader, or mc-store codec change**. The only production tag SQL change
is the explicit index pin in `storage-tags.ts:1896-1907`, now resolved from the
actual `UNIQUE(session_id,tag_number)` constraint instead of a removed index
name. The same column order, rowid suffix, WHERE predicates, and batching remain;
discovery handles rollback-local schema versions
(`migration-v95-perf-indexes.ts:110-137`). The 100k-tag/malformed-id/interrupted-
batch tests passed. Session/source query order changes feed keyed lookups or
explicitly ordered queues, not new rendered ordering.

The populated v95 test preserved every selected metadata/tag field, FTS rowid/
content and ordered BM25 results (`migrations-v95.test.ts:66-101`). These include
frozen m0/m1 bytes and dropped status. Migration code neither resets those bytes
nor requests materialization. Retention uses an ascending `(session,harness,ts)`
index whose backward scan supplies `ts DESC,rowid DESC`; no tie-breaking or
logical retention predicate changes (`transform-decision-log.ts:490-499`).

The implementation separately records literal equality of **five provider
requests per OpenCode host**, including defer/flush/restart, in
`docs/designs/perf-audit-migration-batch.md:999-1026`. I did **not** rerun that
real-host differential. It symmetrically disables auto-search hints, explicitly
acknowledges timing-dependent default hints (`:1006-1013`), and is not universal
proof for every scheduling/configuration case.

Conclusion: **no intended served-byte or fold/status contract change on a healthy
store**. Not “anything anywhere is unchanged”: S1's damaged map can change search
results/ranks (and thus automatic-search input), B1 can stall activation, and
N1's diagnostic array changes. Those are the relevant qualifications to the
unconditional claim.

## Appendix A — query inventory and EXPLAIN evidence

Searched SQL mentions of every touched table throughout `packages/plugin/src`,
`packages/pi-plugin/src`, `packages/cli/src`, `packages/dashboard/src-tauri`, and
`crates/`, plus scripts for explicit index pins and FTS writers. Expanded the
dynamic session-table cleanup and generic identity-merge predicates as well.
DDL, fixture statements, tests and whole-table inventory/export scans were
distinguished from production selective lookups. Search/callgraph indexing was
borrowed from the parent revision, so source reads and lexical searches of the
actual target checkout, not graph line numbers alone, supplied evidence.

The following are **predicate/order families**, not a claim that every distinct
SELECT projection or every possible planner statistic was separately executed.
All explicit production queries found on the affected tables fit these families
or retain a point lookup by primary key. Representative EQPs were run before
and after the real v95 runner on the populated fixture, without ANALYZE.

| Table/family | Query sites inspected (path under `packages/plugin/src/` unless prefixed) | v95 plan / retained coverage |
| --- | --- | --- |
| tags session/range, point/status/token updates, owner lookup, compaction pin | `features/magic-context/storage-tags.ts:46-77,153-156,238-245,322-332,429-438,464-480,657-666,778-834,1040-1069,1272-1342,1588,1896-1907`; `tagger.ts:181-187`; `protection-window.ts:286`; `tool-owner-backfill.ts:194,214,317,438-455`; hook aggregate/replay and v2 fork queries | Session/tag-number uses unique autoindex; active/dropped partial indexes unchanged; message-id/owner/Pi indexes unchanged; point updates retain UNIQUE key. JSON scans are small bound inputs, not tag-table scans. |
| Pi direct tag predicates | `packages/pi-plugin/src/context-handler.ts:2153-2184`, `native-replay-state-pi.ts:192`; shared tag/source/compartment APIs | `idx_tags_pi_adopt`, owner/message-id and session indexes retained. No removed-index pin in Pi. |
| compartments session/sequence/range/end-boundary/id | `features/magic-context/compartment-storage.ts:299-362,442,481`; `storage-clone.ts:496-500`; `compartment-chunk-embedding.ts:233,298,325-338,354`; `hooks/magic-context/inject-compartments.ts:1289,1332,1409-1412,2089,2191,4159`; `history-boundary-repair.ts:128-135`; `protected-tail-boundary.ts:811-814`; `tag-messages.ts:572`; `v2/fold/boundary.ts:167-168` | UNIQUE `(session_id,sequence)` or INTEGER PRIMARY KEY; end-message-id filter stays session-scoped. Rowid ORDER BY now needs a temporary sort (N1). |
| CLI doctor/migrate compartments | `packages/cli/src/commands/migrate.ts:1064,1138,1161,1415`; `doctor-store-generation.ts:70,114`; `doctor-compartment-boundaries.ts:80` | Session/sequence seek for scoped paths; whole-store diagnostic sweeps retain global scans. |
| Dashboard compartments and telemetry | `packages/dashboard/src-tauri/src/db.rs:1490,1530,2177-2178,6357,7183` | Counts/session reads use UNIQUE sequence; GROUP BY session globally scans retained index; telemetry session-IN uses new retention prefix or PK. |
| Rust context compartments | `crates/mc-module/src/host_store.rs:1094-1099,1120`; `crates/mc-store/src/single_store_schema.rs:485`; `lib.rs:11529-11775,12054,12432`; `context_writes.rs:112,180,232-238,280,364-398` | Session/sequence bounds and rowid/id lookups retained, including embedding child FK lookups. Fingerprint refusal is separate from EQP (N3). |
| pending_ops session/tag/drop/ordered queue | `features/magic-context/storage-ops.ts:17-47,112-117,129`; `storage-tags.ts:326-327,1437-1478,1588,1642`; `storage-clone.ts:646-652`; `plugin/rpc-handlers.ts:438,960`; `packages/pi-plugin/src/dialogs/status-dialog.ts:1093` | `(session_id,tag_id)` index; queued_at/id sort existed before and after; RPC LIMIT visitation changes (N1). |
| source_contents session/tag and JSON batch | `features/magic-context/storage-source.ts:24-54`; `storage-clone.ts:612-618`; tag-fold cleanup; `scripts/clone-session.ts:1135-1145` | PK `(session_id,tag_id)` covers prefix, IN list and joins. No uniqueness change. |
| compression_depth session/range/upsert/delete | `features/magic-context/compression-depth-storage.ts:21-53,122`; `store-generation-rebase.ts:902`; `hooks/magic-context/history-boundary-repair.ts:142` | PK `(session_id,message_ordinal)` replaces session-only index. |
| transform_decisions insert/retention/session-IN | `features/magic-context/transform-decision-log.ts:458,490-499`; dashboard above; session/clone cleanup | Covering retention index supplies exact descending ts/rowid without old temp sort. Outer prune also uses its session/harness prefix. |
| project_key_files | `features/magic-context/storage-db.ts:1593-1605`; generic `storage-identity-merge.ts:388-457` | Project equality/range covered by `(project_path,generated_at)` and PK `(project_path,path)`. No surviving explicit index pin or transform reader was found for this legacy table. |
| message_fts_rowid_map session/ordinal/time/FTS joins | `features/magic-context/message-index.ts:135-174,244-279`; `message-fts-rowid-map.ts:37,108,242-246`; `message-time-backfill.ts:114,142`; `search.ts:456,541-546,599-611,1139`; `message-fts-session-filter.ts:9,29,40`; `compartment-chunk-embedding.ts:117,327-337`; `store-generation-rebase.ts:1410-1423`; shared session cleanup | New covering `(session_id,fts_rowid)` for enumeration/join; session/time and session/ordinal indexes retained. Unscoped rowid-only diagnostic is a baseline scan. |
| plugin_messages | `features/magic-context/storage-session-tables.ts:51,124-128`; `shared/rpc-notifications.ts:3` | New session lookup for cleanup. Live bus was already replaced by RPC; old direction/created indexes remain. |
| user_memory_candidates id/session/created-time/global/dedupe | `features/magic-context/user-memory/storage-user-memory.ts:53,74,97,117,134`; `dreamer/task-gates.ts:222`; session cleanup; dashboard `db.rs:8210,8271,8285,8297`; `crates/mc-module/src/host_store.rs:1412-1423,1465` | New session cleanup index; PK id and created-at indexes unchanged. Global listings scan the created-at index; dedupe in the tested shape chose the unchanged created-at index. |
| git_commits / git_commits_fts / new map | `features/magic-context/git-commits/storage-git-commits.ts:36-102`; `search-git-commits.ts:110-156`; `storage-git-commit-embeddings.ts:49-78`; `project-embedding-registry.ts:896,1108,1153,1606,1712,2186`; new trigger helper | Project/time and SHA PK unchanged. FTS MATCH and LIKE fallback unchanged; SHA map lookup is covering and FTS DELETE uses rowid constraints (bytecode test passed). |
| Dynamic deletion/rekey/clone | `features/magic-context/storage-session-tables.ts:106-128`; `storage-identity-merge.ts:388-457`; `storage-clone.ts:496-652`; `scripts/clone-session.ts:1271-1278,1348-1355` | Expand session/project equality or IN predicates against the retained prefixes above; orphan/global sweeps still intentionally inspect all rows. No new direct git-FTS/map writer found. |

Selected literal EQP differences:

```text
tags session/range:
  v94 SEARCH tags USING INDEX idx_tags_session_tag_number (...)
  v95 SEARCH tags USING INDEX sqlite_autoindex_tags_1 (...)
message-map enumeration:
  v94 SEARCH ... USING INDEX idx_message_fts_rowid_map_session_time (session_id=?)
  v95 SEARCH ... USING COVERING INDEX idx_message_fts_rowid_map_session_rowid (session_id=?)
telemetry retention:
  v94 SEARCH ... idx_transform_decisions_session_harness (...) + TEMP B-TREE FOR ORDER BY
  v95 SEARCH ... COVERING INDEX idx_transform_decisions_retention (...)
plugin_messages / candidate session DELETE:
  v94 SCAN plugin_messages / SCAN user_memory_candidates
  v95 SEARCH ... USING INDEX idx_plugin_messages_session / idx_user_memory_candidates_session
compartment rowid ordering:
  v94 SEARCH ... idx_compartments_session (session_id=?)
  v95 SEARCH ... sqlite_autoindex_compartments_1 (session_id=?) + TEMP B-TREE FOR ORDER BY
```

The populated fixture's v95 transaction took **70.9 ms**, `quick_check=ok`, and
`foreign_key_check` returned **0 violations**. This timing is only fixture context.
The first probe attempt used nonexistent legacy key-file column names and rolled
back its seed transaction; the corrected probe used the real schema. A second
attempt retained plan/PRAGMA statements on the migrating connection and got a
table-lock error; the completed comparison closed that inspection handle and
used a clean migration connection, as the production worker does. Neither
setup failure is reported as a migration or performance regression.

## Appendix B — standalone reproduction of B1

Run from the isolated worktree checked out at **d909961b**. All paths are new
throwaway paths. This reproduces migration-body placement, not real-host health.
The seven old indexes/four new-index removals reconstruct the v94 index shape;
git base schema/triggers come from the unmodified migrations through 94.

```bash
timeout 60s bash <<'SH'
set -eu
R="${TMPDIR:?}/magic-context/migration-v95-review-repro-$$"
mkdir -p "$R/home" "$R/data" "$R/config" "$R/state" "$R/runtime" "$R/storage" "$R/tmp"
export REVIEW_ROOT="$R" HOME="$R/home" TMPDIR="$R/tmp"
export XDG_DATA_HOME="$R/data" XDG_CONFIG_HOME="$R/config"
export XDG_STATE_HOME="$R/state" XDG_RUNTIME_DIR="$R/runtime"
export OPENCODE_DB="$R/data/opencode.db" MAGIC_CONTEXT_STORAGE_DIR="$R/storage"
unset MAGIC_CONTEXT_TEST_DATA_DIR MAGIC_CONTEXT_LATEST_SUPPORTED_VERSION
bun run - <<'TS'
import { Database } from './packages/plugin/src/shared/sqlite.ts';
import { initializeDatabase, openDatabaseAsync, closeDatabase }
  from './packages/plugin/src/features/magic-context/storage-db.ts';
import { MIGRATIONS, __getMainThreadMigrationBodyCountForTests }
  from './packages/plugin/src/features/magic-context/migrations.ts';
import { __setMigrationWorkerEntryForTests }
  from './packages/plugin/src/features/magic-context/migration-worker-client.ts';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
const root = process.env.REVIEW_ROOT!;
const path = `${root}/storage/context.db`;
const setup = new Database(path);
initializeDatabase(setup);
for (const n of ['idx_message_fts_rowid_map_session_rowid',
  'idx_transform_decisions_retention', 'idx_plugin_messages_session',
  'idx_user_memory_candidates_session']) setup.exec(`DROP INDEX IF EXISTS ${n}`);
setup.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, description TEXT, applied_at INTEGER)');
for (const m of MIGRATIONS.filter(m => m.version <= 94)) {
  m.up(setup);
  setup.prepare('INSERT INTO schema_migrations VALUES (?,?,0)').run(m.version, m.description);
}
for (const [n,t,c] of [
  ['idx_tags_session_tag_number','tags','session_id,tag_number'],
  ['idx_compartments_session','compartments','session_id'],
  ['idx_pending_ops_session','pending_ops','session_id'],
  ['idx_source_contents_session','source_contents','session_id'],
  ['idx_compression_depth_session','compression_depth','session_id'],
  ['idx_transform_decisions_session_harness','transform_decisions','session_id,harness'],
  ['idx_project_key_files_project','project_key_files','project_path'],
]) setup.exec(`CREATE INDEX IF NOT EXISTS ${n} ON ${t}(${c})`);
setup.close();
__setMigrationWorkerEntryForTests(pathToFileURL(`${root}/does-not-exist.mjs`));
const before = __getMainThreadMigrationBodyCountForTests();
const db = await openDatabaseAsync({ dbPath: path });
if (!db) throw new Error('unexpected storage refusal');
const audit = spawnSync('lsof', ['-p', String(process.pid)], { encoding: 'utf8' });
const lines = audit.stdout.split('\n').filter(l => /\.db(?:-wal|-shm|-journal)?(?:\s|$)/.test(l));
console.log(lines.join('\n'));
if (audit.status !== 0 || !lines.length || lines.some(l => !l.includes(realpathSync(root))))
  throw new Error('database isolation audit failed');
console.log('main-thread migration bodies:', __getMainThreadMigrationBodyCountForTests() - before);
console.log('ledger:', db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get());
closeDatabase();
TS
SH
```

Observed equivalent probe: `main-thread migration bodies: 1`, ledger 95. The
required guarantee would need **0**, or a refusal before any migration body.

## Verification record and remaining limits

- `timeout 180s … bun test` in `packages/plugin`, with the package preload and
  throwaway environment: **Bun 1.4.2; 45 passed / 0 failed; 673 assertions; 9 files**.
  Selected files: migrations-v95, migrations-v38, migrations-armed-replay,
  migration-worker, schema-version-fence, storage-tags-trim,
  transform-decision-log, git-commits/storage-git-commits and
  git-commits/search-git-commits. The missing-worker test passing is B1's
  counterexample, not a successful never-main-thread gate.
- `timeout 180s … bun run --cwd packages/plugin typecheck`: **passed**,
  TypeScript **5.9.3**, all **3 tsc projects**. The initial version command used
  a nonexistent root-level tsc shim; corrected to the package's installed shim.
- `timeout 60s … bun build …migration-v95-perf-indexes.ts --target node …` and
  `node --input-type=module` driver assertions: **passed, 9 checks**;
  Node **v24.16.0 / SQLite 3.53.0**. The bundle was a disposable review artifact,
  not published output.
- Isolated Bun probes: **38 EQPs**, unique-index definitions **7/7 unchanged**;
  missing-map/amend/delete/lost-ledger/refill observations; missing-worker main
  counter **1**; numeric legacy replay refusal; SIGKILL rollback to **94**; two
  concurrent migrators/indexers **201 matching rows**, eviction **1/1**.
  Quick checks all returned **ok**. These are reproductions/observations, not a
  separately committed regression suite.
- Actual base-v94 plugin/CLI versus the synthetic v95 file: **5 checks passed**,
  Bun **1.4.2**. No native dashboard/ck-mc binary was launched or rebuilt.
- The **exact Appendix B bash block** was extracted and executed at d909961b:
  passed, main-thread delta **1**, ledger **95**, and throwaway-only lsof audit.
  This verifies the checked-in reproduction rather than merely a similar probe.
- No production mutation controls were requested or applied. The damaged-map,
  numeric-row and missing-worker controls alter disposable data/test seams,
  not staged source. The first control is deliberately outside normal API
  operations; it must not be mistaken for spontaneous corruption.
- Skipped: live/backup-store inspection; real-size host `/health`; independent
  provider-body differential; native builds/clippy and full workspace suites.
  This is a report-only change. Prior build/install success supplied for the
  review worktree is not verification of the other branch's emitted workers.
  The target's own broader results are recorded at
  `docs/designs/perf-audit-migration-batch.md:1028-1077`.
- Markdown diagnostics: AFT inspection was **partial**, with no registered LSP
  producer for Markdown; it is not claimed as a clean diagnostic pass. Document
  structure and whitespace are checked separately for this report-only delivery.

Release follow-up should preserve this distinction: resolve B1's acceptance
criterion, rehearse health at real size under isolation, document logical-map
recovery, and ship/restart ck-mc with its updated fingerprints. Do not rollback
the shared migration or reset rendered cache bytes to work around these issues.
