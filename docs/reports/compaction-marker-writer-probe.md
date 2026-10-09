# OpenCode 1.18.30 marker writer investigation

## Findings

The old log does **not** establish that the 13.2 seconds were spent inside a
write transaction. The interval from `pp.nudgeAndSticky` to “injected boundary”
also includes the manager's boundary preflight. That preflight has two
correlated part probes which, on the freshly created 1.18.30 schema **without
ANALYZE statistics**, choose `part_session_idx`, not the message index. Near
the end of a large session each probe reads almost every part in the session.
This is a concrete, reproducible slow path; it is not writer-lock waiting.

The read-only log confirmed 2127.4ms, 3219.8ms and 13235.7ms reconcile stages
(the last at ordinal 153299). There was no attributable host-store acquisition
or hold diagnostic in the slow interval. **The live case cannot be conclusively
classified retrospectively without opening the live store, which was not done.**
The synthetic results strongly implicate boundary lookup as a contributor; they
do not prove that contention or disk pressure never contributes on the host.

Changes:

* Disqualify the part **session-only** index in boundary and historian-gap
  correlated probes, using the same unary-`+` technique already used by marker
  lineage cleanup. Both TEXT session columns still participate in equality;
  no row predicate, ordering, boundary rule or written payload is removed.
  This uses the existing message index; it does not create an index or migrate
  OpenCode's store.
* Keep `BEGIN IMMEDIATE` and atomic replacement, but bound native busy waiting
  for injection/replacement (including cold-open WAL setup) to 250ms instead of
  5000ms. Removal operations retain 5000ms on a separate cached connection.
  Failure before
  callback entry remains `definitely-no-cut`; the manager retains its retry
  and old marker. The shared transform lease can shorten this further.
* Every outer injection/replacement emits
  `sqlite writer site=compaction-marker-{inject,replace} db=opencode acquire_ms=... hold_ms=... work_ms=... end_ms=... outcome=...`.
  Nested injection savepoints are not counted as another writer acquisition.
  Hold includes transaction finalization; `work_ms` is the callback and
  `end_ms` is COMMIT on success, or transaction unwinding on failure. A large
  `end_ms` identifies finalization/I/O, not necessarily a checkpoint versus
  fsync. A failed acquisition has zero hold/work/end and `not_acquired`.

### Removal caller audit and timeout isolation

All production removal callers were checked, not just each function's return
type or comments:

| Removal | Actual caller and failure behavior | Retry? |
| --- | --- | --- |
| `removeCompactionMarker` | `removeCompactionMarkerForSession` ignores its false result and clears persisted marker state. Invoked by `event-handler.ts` for `message.removed`, `session.compacted` and `session.deleted`. A surviving marker loses its durable ownership; a future publication is not a guaranteed deletion retry. | No retained marker-removal retry. |
| `removeForeignCompactionMarker` | `reconcileForkOrphanedCompactionMarkers` reports `failed`, but `prepareCompartmentInjection` discards the result and invokes hygiene only when `degradedCount === 1`. The next pass of the same degraded episode does not retry. | No immediate retry; another degraded episode may revisit it. |
| `removeMcOwnedCompactionMarkers` | `cleanupOffMarkers` propagates SQLITE_BUSY into `reconcileCompactionMode`. The first flip stages `off_notice_pending` before cleanup; the transform catch fails the managed pass with `compaction-mode-transition-failure` rather than settling it. Later passes retry that pending transition. An existing `off_cleanup_pending` record also remains pending on failure. | Durable retry on subsequent transforms/restarts. |

Since two removals have no retained retry, **all three** keep their original
5000ms native wait on a dedicated cached removal connection, including WAL
setup. Publication keeps its separate 250ms connection; removal success or
failure cannot leak a longer timeout into injection/replacement. Both handles
are closed/reset by `closeCompactionMarkerDb`.

Removal transactions explicitly run outside the shared foreground-transform
acquisition lease, which otherwise shortens BEGIN to 250ms even on a connection
configured with 5000ms. The surrounding transform lease remains unchanged.
Tests exercise every removal with an independent process holding the writer
beyond 250ms, inside a foreground transform scope, then verify the actual rows
are removed. Additional tests verify publication stays short after the removal
connection is warm and that compaction-off cleanup retains its durable retry
when SQLITE_BUSY is raised.

This preserves the old removal wait, not an unlimited deletion guarantee. A
writer busy beyond 5000ms can still leave one-shot cleanup incomplete; adding
durable retries to those callers would be a separate change. Compaction-off
cleanup already has the durable retry described above.

Follow-up verification passed 62 tests / 266 assertions across the marker,
manager and compaction-off suites. The 150k-message/1M-part probe still matched
the independent baseline row hash; its publication acquisition rejected the
competing writer in 251ms. The additional artifact is
`<root>/data/opencode/marker-probe-removal-followup.json`. Scoped mutations
proved the tests fail when the foreground lease exemption is removed, when
the removal connection is shortened to 250ms, or when publication is lengthened
to 5000ms; all mutations were restored.

## Isolation, schema and fixture

No live database or config was opened, copied, written or migrated. Only the
explicitly authorized plugin **log** was read. A stock
`opencode-stock-1.18.30 --version` and `/global/health` both reported 1.18.30.
The host created a new DB and one session, then was terminated before bulk
population. Its `lsof -p 40465 -Fn` listed only these database paths:

```
<root>/data/opencode/opencode.db
<root>/data/opencode/opencode.db-wal
<root>/data/opencode/opencode.db-shm
```

Root: `$TMPDIR/magic-context/bg_e88be788a4c0ed42/` (also canonicalized as
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_e88be788a4c0ed42/`).
HOME, all five XDG roots, OPENCODE_CONFIG_DIR, OPENCODE_DB,
MAGIC_CONTEXT_STORAGE_DIR and the probe log path were under that root.
The benchmark separately checks its own open DB handles with `lsof`.
All shell/host/probe commands were bounded by an outer `timeout`.

The **fresh host's schema**, not a hand-built approximation or live DB copy,
was used. The marker-relevant DDL from its `sqlite_master` is:

```sql
CREATE TABLE message (
  id text PRIMARY KEY, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_message_session_id_session_id_fk
    FOREIGN KEY (session_id) REFERENCES session(id) ON DELETE CASCADE
);
CREATE TABLE part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL,
  CONSTRAINT fk_part_message_id_message_id_fk
    FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
);
CREATE INDEX message_session_time_created_id_idx ON message(session_id,time_created,id);
CREATE INDEX part_message_id_id_idx ON part(message_id,id);
CREATE INDEX part_session_idx ON part(session_id);
```

The complete schema, including session/project and 1.18.30's parallel
`session_message` tables, is in `<root>/schema.json`. No ANALYZE was run.
There are 150,000 ordinary messages and 1,000,000 ordinary parts in one
session, plus the few marker/legacy fixture rows. Message JSON carries 512
bytes of padding; text parts carry 1024 bytes. The DB is **1,609,650,176 bytes**,
well below 5GB, with 4096-byte pages and WAL. Runtime: Bun 1.4.2, SQLite 3.54.0
(the probe runtime; schema is pinned to the host, not its SQLite engine).
The independent probe connection uses FULL synchronous, and the real plugin
connection keeps its existing defaults. No durability or auto-checkpoint
setting was changed in production.

## Every injection/replacement transaction statement and its plan

These are the executed SQL statements, in order, including legacy deletion.
Plans were obtained by binding the actual parameters to `EXPLAIN QUERY PLAN`
on the fresh populated schema. EQP reports searches, not b-tree maintenance
or sync syscalls. BEGIN/savepoint/finalization controls have empty EQP results.
SQLite's implicit FK work is also shown below where EQP exposes it, even
though the plugin connection retains its existing foreign-key setting.

| Order | Statement | EQP detail |
| --- | --- | --- |
| 1 | `BEGIN IMMEDIATE` | empty (transaction control) |
| 2 | `DELETE FROM part WHERE id = ?` (old summary part) | `SEARCH part USING INDEX sqlite_autoindex_part_1 (id=?)` |
| 3 | `DELETE FROM message WHERE id = ?` (old summary) | `SEARCH message USING INDEX sqlite_autoindex_message_1 (id=?)`; FK: `SEARCH part USING COVERING INDEX part_message_id_id_idx (message_id=?)` |
| 4 | `DELETE FROM part WHERE id = ?` (old boundary part) | same as 2 |
| 5 | `SAVEPOINT mc_tx_sp` (nested injection) | empty |
| 6 | Legacy lineage SELECT below | `SEARCH m USING INDEX message_session_time_created_id_idx (session_id=?)`; `SEARCH p EXISTS USING INDEX part_message_id_id_idx (message_id=?)` |
| 7a | `DELETE FROM part WHERE +session_id = ? AND message_id = ?` for each legacy summary | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` |
| 7b | `DELETE FROM message WHERE session_id = ? AND id = ?` for each legacy summary | `SEARCH message USING INDEX sqlite_autoindex_message_1 (id=?)`; same FK covering search as 3 |
| 8 | Legacy boundary part DELETE below, only when legacy summaries were found | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` |
| 9 | Part UPSERT below (canonical boundary part) | empty |
| 10 | Message UPSERT below (canonical summary) | `SEARCH part USING COVERING INDEX part_message_id_id_idx (message_id=?)` (FK work for the update arm) |
| 11 | Part UPSERT below (canonical summary text part) | empty |
| 12 | `RELEASE mc_tx_sp` | empty |
| 13 | `COMMIT` | empty |

Standalone injection uses 1, 6–11, 13, without replacement DELETEs or a nested
savepoint. Rollback paths use `ROLLBACK TO mc_tx_sp`, `RELEASE mc_tx_sp`, and/or
outer `ROLLBACK`, also empty EQP. A first-use schema probe can run
`PRAGMA table_info(message)` and `PRAGMA table_info(part)` inside the outer
replacement but before injection; these also have empty EQP. When the manager
supplies `resolvedBoundary`, the boundary SELECTs below run **before** BEGIN.
Standalone injection without a resolved boundary also resolves it before its
own BEGIN. The manager always pre-resolves it on publication/drain.

```sql
-- 6: legacy lineage lookup (unchanged)
SELECT m.id FROM message m
WHERE m.session_id = ? AND m.id <> ?
  AND COALESCE(json_extract(m.data, '$.summary'), 0) = 1
  AND COALESCE(json_extract(m.data, '$.finish'), '') = 'stop'
  AND COALESCE(json_extract(m.data, '$.parentID'), '') = ?
  AND EXISTS (
    SELECT 1 FROM part p
    WHERE +p.session_id = m.session_id AND p.message_id = m.id
      AND COALESCE(json_extract(p.data, '$.type'), '') = 'text'
      AND COALESCE(json_extract(p.data, '$.text'), '') = ?
  );
-- 8: legacy boundary part deletion (unchanged)
DELETE FROM part
WHERE +session_id = ? AND message_id = ? AND id <> ?
  AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'
  AND COALESCE(json_extract(data, '$.auto'), 0) = 1;
-- 9 and 11: the same SQL, different row values (unchanged)
INSERT INTO part (id,message_id,session_id,time_created,time_updated,data)
VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
  message_id=excluded.message_id, session_id=excluded.session_id,
  time_created=excluded.time_created, time_updated=excluded.time_updated,
  data=excluded.data;
-- 10 (unchanged)
INSERT INTO message (id,session_id,time_created,time_updated,data)
VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
  session_id=excluded.session_id, time_created=excluded.time_created,
  time_updated=excluded.time_updated, data=excluded.data;
```

Boundary preflight:

1. `getNonSummaryMessageSortKey`: SELECT timestamp/ID by session and ID, excluding
   completed summaries. EQP: `SEARCH message USING INDEX sqlite_autoindex_message_1 (id=?)`.
2. `findBoundaryUserMessage`: newest eligible non-summary user at/before that
   timestamp/ID, excluding synthetic-only rows by two correlated EXISTS probes.
   EQP outer: `SEARCH message USING INDEX message_session_time_created_id_idx (session_id=?)`;
   two `CORRELATED SCALAR SUBQUERY` nodes. **Before:** both use
   `SEARCH p USING INDEX part_session_idx (session_id=?)`. **After:** both use
   `SEARCH p USING INDEX part_message_id_id_idx (message_id=?)`.
   No temporary sort. The exact SQL and bound-run plans are in the JSON artifacts.
3. The manager's optional historian-gap check has the same part-index trap;
   the query-plan regression test exercises the actual SQL for both paths.

## Measurements: wait, work, finalization, checkpoint

Single representative runs, not latency percentiles. Timing instrumentation
wraps the native methods used by the **actual plugin**, not a SQL reimplementation.
It separately executes EQP on the independent probe handle; minor preparation
and EQP overhead is included in transaction hold but not individual statement
execution timing.

| Exercise | Before | After |
| --- | ---: | ---: |
| Boundary preflight, uncontended | 1683.3ms | 0.48ms |
| Replacement BEGIN acquisition | 0.082ms | 0.010ms |
| Replacement total / hold (acquisition negligible) | 79.0ms | 72.5ms |
| Legacy SELECT inside replacement | 59.5ms | 50.3ms |
| Replacement COMMIT | 18.0ms | 21.3ms |
| Every DELETE/UPSERT individually | <0.14ms | <0.08ms |
| Competing writer's 1200ms hold: marker acquisition | 1202.6ms | 250.6ms, rejected before any DELETE |
| Competing writer: total marker call | 1275.3ms, committed | 250.8ms, `definitely-no-cut` |

The independent writer updates a part under BEGIN IMMEDIATE, signals lock
ownership, holds it for 1200ms, then rolls back. Baseline separates 1202.6ms
**wait** from about 72ms **hold**. This does not reproduce a 13-second hold.
The busy deadline is an acquisition budget, not an interruptible query/COMMIT
deadline: disk stalls after acquiring the writer can still exceed 250ms.

A second after-change exercise disables auto-checkpoint only on the probe
connection, temporarily updates 5000 fixture parts and commits a **6,868,072-byte
WAL**, then retries the canonical marker on its normal connection. Its BEGIN
took 0.098ms; work took about 79ms; COMMIT took **145.9ms**; total hold was
225.4ms. Immediately afterwards PASSIVE checkpoint reported 1679/1679 frames
checkpointed and took 0.56ms. An earlier explicit 51-frame PASSIVE checkpoint
took 302ms, demonstrating local disk scheduling variance even for small WALs.
Thus finalization/checkpoint cost is real and distinct from acquisition; a WAL
checkpoint writes its eligible changed pages, not the entire 39GB main file.
No checkpoint/fsync removal was made. A failed checkpoint-probe cursor was
fixed by finalizing raw EXPLAIN statements and using a separate checkpoint
connection; the delivered probe heals/restores only its own 5000 fixture rows.

The final restored verification run illustrates variance rather than a latency
guarantee: preflight was 0.45ms, acquisition failed in 252ms as intended, and an
uncontended replacement held 343ms (`work_ms=341`, `end_ms=2`). The primed-WAL
retry held 562ms (`work_ms=61`, `end_ms=501`). The new log alone distinguishes
the slow callback read from slow finalization in those two cases. Both the
representative updated run and the final run had identical host-row hashes.

Remaining work: legacy discovery is still an O(session messages) JSON scan
under the writer. Its session index is already used and its part probes are
already message-indexed. Moving the SELECT outside the lock without a version
fence would change concurrency semantics; restricting IDs/time or skipping
legacy matches would change which rows are deleted. Neither was done.

## Byte parity and artifacts

Baseline and changed revisions reset only probe-owned markers/legacy fixtures,
then execute the same replacement on the **same synthetic store**. The probe
hashes every column (including the original raw JSON strings), in ID order,
of **all** message and part rows, not just the three marker rows. Separately
captured baseline and changed SHA-256 match:

```
108029ffbeef179dc7b38a48d0eff89baa7996664d8dd29abedcda6c4a754cf4
```

Artifacts retained under the throwaway root:

* `host-lsof.txt`, `probe-lsof.txt`: isolation evidence.
* `schema.json`: complete fresh-host DDL.
* `data/opencode/marker-probe-{baseline,updated,final}.json`: every measured SQL, EQP,
  statement duration, total and checksum.
* `probe.log`: permanent writer diagnostics from the actual marker calls.

Reproduction: initialize a fresh throwaway root with a pinned 1.18.30 host
(`serve`, then POST `/session`), capture/validate host lsof, stop it, then run
the following **with all isolated roots exported**. No provider, plugin config,
credentials or model calls are needed for initialization.

```sh
timeout 180s bun packages/plugin/scripts/bench-compaction-marker.ts
# Required environment:
# MARKER_PROBE_ROOT=<throwaway root under $TMPDIR/magic-context/>
# HOME=<root>/home; TMPDIR=<root>/tmp
# XDG_{DATA,CONFIG,CACHE,STATE,RUNTIME}_HOME=<root>/{data,config,cache,state,runtime}
# OPENCODE_CONFIG_DIR=<root>/config
# OPENCODE_DB=<root>/data/opencode/opencode.db
# MAGIC_CONTEXT_STORAGE_DIR=<root>/data/cortexkit/magic-context
# MAGIC_CONTEXT_LOG_PATH=<root>/probe.log
# MARKER_PROBE_LABEL=baseline (before change), updated (after change)
```

Tests also prove failed acquisition preserves the old host marker and persisted
state, and that the same request applies after release. The old assertion that
this path spends at least 4.5 seconds waiting was replaced with a <1-second
assertion intentionally: the contract change is the retryable acquisition
budget, not marker semantics.

Non-vacuity controls were restored before delivery: removing the index hint
failed only the actual-SQL plan test (10 other feature tests passed); suppressing
the timing line failed only the timing test (10 others passed); restoring the
five-second timeout failed the targeted lock test at 5236ms. Altering a written
summary payload failed the independent whole-row hash guard. Adding a simulated
out-of-root lsof entry failed the isolation guard without opening that path.
