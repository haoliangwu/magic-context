# Serving-thread stall cost: before and after

Driver: `scripts/perf-audit/stall-cost.ts`. Both runs used the same driver on
the same Linux build host, one after the other, in a throwaway root
(`/tmp/magic-context/bg_189551472f6f1b31`, with `XDG_*`, `HOME`,
`MAGIC_CONTEXT_STORAGE_DIR` and `OPENCODE_DB` pointed inside it). "Before" is
`packages/plugin/src` at 9d26c87081, extracted with `git archive`; "after" is
this branch, including the independently reviewed fixes. Every database the driver opened was
created under the root: `before-opencode.db`, `before-reasoning-context.db`,
`after-opencode.db`, `after-reasoning-context.db` and `search-context.db` (built
by the first run and searched by both). No OpenCode host was started.

Fixture: one OpenCode session of 150,000 messages (OpenCode 1.18.30 message/part
schema and indexes, four messages per timestamp, a compaction summary every
1,000th message); 300,020 tags for the reasoning budget (one message tag and one
tool tag per message), a live array of 2,000 messages and 1,000 frozen
merged-reasoning decisions; a 150,015-message LKG prefix.

| Stall | Measure | Before | After |
|---|---|---|---|
| Ordinal of an indexed message (`readRawSessionMessageByIdFromDb`) | first lookup of the session | 25.2 ms | 25.6 ms |
| | lookup right after appending that message, median of 20 | 22.5 ms | 22.0 ms |
| | same, max | 26.7 ms | 22.2 ms |
| | lookup with no write since the previous lookup, median of 20 | 22.0 ms | 0.05 ms |
| Explicit `ctx_search` with probes (message lane) | longest event-loop block | 137 ms | 3.9 ms (worker) |
| | total latency | 137 ms | 179 ms (worker start included) |
| keep_reasoning_tokens projection | first pass | 490 ms | 271 ms |
| | ordinary pass (2 tags appended), median of 10 | 357 ms | 1.29 ms |
| | compartment-trigger estimate read, median | 69.0 ms | 0.03 ms |
| LKG entry digests (`noteEntry`) | first pass | 5,047 ms | 2,712 ms |
| | ordinary pass (3 messages appended), median of 5 | 5,955 ms | 442 ms |

Equality checks in the same runs: the last ordinal was 149,870 in both; the
reasoning cutoff was 299,028 in both; the search returned the same ten message
ids in process and from the worker, and the same ids as before.

## The ordinal is not O(new) after a write

The first version of this change reused a remembered ordinal across writes and
looked up an appended message in about 0.1 ms. The review showed that this
returned wrong canonical ordinals when earlier rows changed behind the
remembered point (a delete without a removal event, a moved `time_created`, an
insert sorting before a timestamp tie, a summary rewritten to `finish: stop`,
another connection's commit). Wrong ordinals corrupt history references, so
the remembered count is now reused only while the store stamp
(`data_version`, `total_changes()`, `schema_version`) is unchanged, which proves
nothing in the store changed. After any write the whole prefix is counted again.

That count is one row-value range seek on `(session_id, time_created, id)`, but
it must read every earlier message's JSON to leave out finished compaction
summaries: about 22 ms at 150k messages, about the same as the old statement.
An index-only `COUNT(*)` over the same range takes about 4 ms but cannot tell
which rows are excluded summaries, so it cannot give the canonical ordinal on
its own. In a live host OpenCode commits between most incremental-index
lookups, so most of them pay the full count; lookups with no write in between
(for example `ctx_expand` resolving several messages) count only the rows
between the remembered point and the target.

## Other notes

- The remaining ordinary LKG pass time is walking and comparing 150k messages'
  content, which drift detection needs; only the 3 new messages are hashed.
- The search lane does the same work on the worker; the serving thread only
  posts the request and awaits the reply. A worker that does not report it is
  running within 400 ms, or does not answer within 30 s after that, is replaced
  by the in-process lane, and the fallback is logged and counted.

# Real-store stalls after the stall fixes

After those fixes the host stall profiler on the live OpenCode host
(`opencode.db` about 39 GB, sessions up to about 160k messages with multi-KB
message JSON) still showed three Magic Context stalls on the serving thread:

1. 4.7 s (and part of 5.3 s): `countEligibleOrdinals` ← `canonicalOrdinalOf` ←
   `readRawSessionMessageByIdFromDb` in the incremental message-index job. The
   whole-prefix recount above runs after nearly every lookup on a busy host,
   and it reads every earlier message's JSON from a cold file.
2. About 2 s: `readTagOwnerSummary` ← `getReasoningTokenEstimatesByMessage` ←
   `projectOpencodeReasoningBudgetCutoff`. The summary was rebuilt (every tag of
   the session read into JavaScript) whenever another connection had committed
   anything to `context.db` (`data_version` moved), which on that host is
   nearly every pass.
3. About 3 s: `countRawSessionMessageOrdinalsFromDb` under the message-index
   page reader, the same whole-session JSON count.

## What changed

**Canonical ordinal (stalls 1 and 3).** A canonical ordinal is now an
index-only `COUNT(*)` over `(session_id, time_created, id) <= target` minus the
finished compaction summaries at or before the target. Summaries are found
through a per-connection, per-session set of candidate rows (rows whose
`summary` flag is set, finished or not), and both parts are evaluated in one
statement:

- the candidates are re-read by primary key in that statement, so a summary
  that finishes later, moves in time, changes session or is deleted is counted
  correctly;
- new rows are found by rowid: rows above the highest remembered row of the
  `message` table are read in that same statement. The set remembers the top
  64 rows (rowid and id). OpenCode's `message` has a text primary key and no
  AUTOINCREMENT, so SQLite hands a deleted top rowid to the next insert; a
  remembered row that has gone or now holds another message is passed over for
  a lower one, and only when none survive is the session scanned again;
- `countRawSessionMessageOrdinalsFromDb` uses the same path with no bounds;
- validating the remembered rows, reading the rows above them and counting run
  inside one read transaction on the serving connection (one WAL snapshot), so
  no other connection's commit can land between them. Without it, a commit that
  deleted the top row and reused its rowid for a finished summary between the
  validation and the scan made the scan adopt the new row as its top without
  reading it as a candidate, and that wrong set persisted. The
  transaction only reads and ends with ROLLBACK; inside a transaction the caller
  already holds, that one is used.

OpenCode 1.18 has no index on `message.time_updated` (only
`message_session_time_created_id_idx (session_id, time_created, id)`), and a
scan of `time_updated` would read every table leaf, which is the cost being
removed. Rowid plus the candidate re-read is the change signal instead. Its one
assumption is that a row carries its `summary` flag from its first insert:

- OpenCode v1.18.35 creates the compaction assistant with `summary: true` and no
  `finish` (`packages/opencode/src/session/compaction.ts:393-418`) and sets
  `finish` later through the processor; its message projection is
  `INSERT ... ON CONFLICT(id) DO UPDATE SET data` (`packages/core/src/session/projector.ts:261-272`),
  which keeps the rowid, session and creation time. `import` inserts with
  `onConflictDoNothing`. No other v1.18.35 path writes `summary: true`.
- In this repository the only writer of `message` rows is Magic Context's
  compaction marker (`compaction-marker.ts`, inject and replace). Its upsert can
  rewrite an existing row into a summary, so it reports the row through
  `noteRawSessionSummaryRowWritten` inside the write transaction (tested in
  `compaction-marker.test.ts`). The CLI doctor's marker repair only sets
  `time.completed` on rows that are already Magic Context summaries; the clone
  script inserts new rows. No Rust crate writes `message`.

Named limitations:

- an in-place edit by some other writer that turns an ordinary row
  into a finished summary is not seen until `forgetRawSessionSummaryRows` runs
  for the session. The first review's randomized differential (seed
  `0x5d0ee2b3`) made exactly that edit in its fourth step; its main variant now
  rewrites rows that were inserted with the flag (finishing and unfinishing
  them), and the original arbitrary edit is kept as its own test that calls
  `forgetRawSessionSummaryRows` after each write, plus a named residual test;
- a finished summary moved into another session by changing its `session_id`
  is not a candidate of the destination session until
  `forgetRawSessionSummaryRows` runs for it. OpenCode 1.18's message upsert
  never changes `session_id`, and a session location move changes only the
  session table. Witnesses: `a finished summary moved into an already warm
  session must be excluded` and the session-move variant of the r2 6,000-step
  differential (both expected failures); invalidating the destination restores
  parity in both.

**Off-thread warm-up.** Finding a session's candidates the first time reads
every message's JSON once. That scan now runs on a worker
(`raw-ordinal-warmup-worker.ts`, its own read-only connection) and is installed
on the serving connection. The worker's scan reads the top rows and the
candidates in one statement, so rows written during or after it lie above its
top remembered row (or replace it) and are read by the next count. Callers:

- concurrent calls for one store and session share one worker, and every
  connection that awaited it installs the result on itself (before, a second
  connection was reported warm without being warmed);
- the transform awaits it at the start of every pass (instant once warm), so
  no stage reached from `experimental.chat.messages.transform` (protected-tail
  boundary, compartment trigger, module-state sync, chunk reads) scans the
  session on the serving thread;
- the incremental index job and reconciliation await it and reschedule when it
  failed, without reading;
- the historian runner, `/ctx-recomp`, wrapup and `ctx_expand` await it before
  their synchronous reads;
- if the worker fails, the transform pass still runs and a count that needs the
  scan does it on the serving thread once; the failure is logged at warn level
  with the session and counted by reason, and the worker is not retried for
  that session for 5 minutes. A servable turn is never refused for it.
- sessions of at most 2,000 messages, and in-memory stores, are scanned in
  place (a few milliseconds warm).

Workers are unreferenced, stopped when the process exits, and time out after
10 minutes.

**Tag owner summary (stall 2).** After another connection's commit the summary
is no longer rebuilt. One statement reads the session's tag count and highest
id (from the `(session_id, message_id)` index, without visiting the table)
together with the rows above the cached highest id. When the count grew by
exactly those rows, they are folded in. A delete or a replace changes the count
and rebuilds. Status and drop-mode writes, on either connection, never reread
the session. Tool tags written before owners were recorded are remembered and
re-read by primary key after a foreign commit, because the tool-owner backfill
that runs when any OpenCode process opens the store gives them owners from
another process. The `schema_version` is part of the key, so a rebuilt table
rebuilds the summary.

The count and highest id cannot prove that a commit only appended: the r2
review showed another connection backfilling an old tag's
`reasoning_token_count` in the same commit as an append, and a second Pi or
OpenCode host serving the same session is a supported deployment. So every
Magic Context connection now bumps a per-session tag identity revision in the
same statement as any write of `id`, `session_id`, `message_id`,
`tag_number`, `type`, `tool_owner_message_id` or `reasoning_token_count`, and
the shape statement reads it; a changed revision rebuilds. The revision is the
`schema_migrations_meta` row `tag_identity_revision:<session>`: that key/value
table already holds per-session `retrospective_activity:<session>` rows, so no
schema change is needed (`session_meta` has fixed columns). The bump is a TEMP
trigger (`storage-tag-identity-revision.ts`) that `initializeDatabase` creates
on every connection it opens: it is not part of the stored schema, covers
every writer on that connection (the tagger, tag hygiene, owner adoption, the
reasoning backfill, the rebase fold, Pi's fallback adoption, the tool-owner
backfill, migrations, raw SQL), and commits or rolls back with the write.
Status, drop-mode, size and token-count writes do not bump it.

The trigger fires once per updated row. A backfill of `reasoning_token_count`
over 10,000 tags of a session in one UPDATE took 2.4 ms without it and
5.5–5.8 ms with it (median of 7, two runs, Linux 8 vCPUs, WAL file store;
`scripts/perf-audit/tag-revision-trigger-cost.ts`): about 0.3 µs per row. Over
100,000 rows: 47 ms without, 82 ms with.

Session deletion (`deleteSessionScopedRows`, through `deleteSessionActivity`)
drops the session's `tag_identity_revision:` row with its
`retrospective_activity:` row, once no tag of the session remains, so the rows
do not accumulate. A row is kept while tags remain (a harness-scoped cleanup
that leaves another harness's tags of the same session): a summary that cached
the old value would otherwise read a restarted revision as unchanged. Once no
tag remains, a summary that cached any of the session's tags sees the count
change and rebuilds, and tags added later are read as new rows with their
current values, so a missing row is never mistaken for "unchanged". Tests:
`tag identity revision rows on session deletion` in
`storage-tag-owner-summary.test.ts`.

Named limitations:

- a connection that never ran `initializeDatabase` (a tool editing
  `context.db` directly, an older plugin build) does not bump the revision,
  so its in-place rewrite stays unseen while the count and highest id fit an
  append. The CLI (`migrate-session`, `doctor repair-db`) does not rewrite tag
  rows, the dashboard has no tag writer, and Rust-mode tags live in `store.db`
  (`mc_tags`). Tests: the raw-connection residual tests in
  `oc-stall-cache-review.test.ts`, `oc-stall-r2-tag-review.test.ts` and
  `storage-tag-owner-summary.test.ts`;
- deletes are not counted in the revision (they change the count). A delete
  and an insert with an explicit `tags.id` below the highest id in one commit
  cancel out; no writer inserts tags with an explicit id (`tags.id` is
  AUTOINCREMENT and the clone copies without ids). Witness: `foreign delete and
  explicit-id reinsertion below max must not retain a deleted owner`
  (expected failure); reopening restores the full read.

## Measurements

Driver: `scripts/perf-audit/stall-ordinal-real.ts`, Linux build host, throwaway
root `/motor-home/tmp/magic-context/bg_c13b3d23ccad0f64/realistic` (removed
after the run; the driver refuses live store paths and listed its open database
files, all under the root). Fixture: OpenCode 1.18 schema, 4.9 GB
`opencode.db`; one session of 150,000 messages with 3–5 KB message JSON and two
9 KB parts per message, interleaved with three other sessions of 20,000; a
finished summary every 1,000th message. `context.db` with 100,000 tags. "Cold"
means the files' page cache was dropped with `posix_fadvise(DONTNEED)` first
(`fincore` reported 0 bytes resident).

| Measure | Old | New |
|---|---|---|
| Ordinal of the newest message, cold | 24.2 s (13.0 s in an earlier run) | 221–295 ms after another connection appended |
| Same, warm | 268–303 ms | 7.5–11.7 ms |
| Message JSON read per lookup after an append | 150,000 rows | 151 rows (1 new row, 150 summaries) |
| Session count (`countRawSessionMessageOrdinalsFromDb`), warm | (same as the lookup) | 4.6–5.6 ms, 150 rows of JSON |
| First pass after a restart, cold: longest event-loop block | 13,857 ms (in-thread scan) | 164 ms (scan on the worker, 13.6 s elapsed with the loop free) |
| Tag summary after another connection appended a tag, cold / warm | full rebuild (76 ms here, 2 s live) | 62–78 ms / 3.0–3.9 ms, 1 row read |
| Tag summary after another connection's status write, warm | full rebuild | 2.9–4.9 ms, 0 rows read |

The ordinals agreed with the old statement (149,850 at the target, 149,860
after the appends). The remaining cold cost of a lookup is the index range of
150k entries and the 150 summary rows' pages.

Rerun after the read-snapshot, shared-warm-up and identity-revision changes
(same driver, fixture and host, 8 vCPUs; the tag writer connection had the
identity-revision trigger installed, as every Magic Context connection does):

| Measure | Before those changes | After |
|---|---|---|
| Ordinal after another connection appended, cold | 221–295 ms | 214–222 ms |
| Same, warm | 7.5–11.7 ms | 7.4–11.4 ms |
| Session count, warm | 4.6–5.6 ms | 4.7 ms (mean of 2,000: 4.8 ms) |
| BEGIN/ROLLBACK around a statement | — | 0.8 µs extra per count |
| First pass after a restart, cold: longest block | 164 ms | 163 ms (in-thread: 14,446 ms) |
| Tag summary after a foreign append, cold / warm | 62–78 ms / 3.0–3.9 ms | 60–61 ms / 2.8–2.9 ms, 1 row |
| Tag summary after a foreign status write, warm | 2.9–4.9 ms | 2.6–2.8 ms, 0 rows |

The old whole-prefix count measured 15.2 s cold and 366 ms warm in this run;
all ordinals still agreed (149,850 and 149,860). The read snapshot costs
nothing measurable, and the revision read is one primary-key lookup in the
shape statement.

The r2 review's differential (`oc-stall-r2-ordinal-review.test.ts`, six seeds
x 1,000 steps per variant, two WAL connections, 18,000 steps in all) passes;
its session-move variant remains the expected failure listed above.

Work-bound tests: `read-session-raw-indexed-ordinal.test.ts` (JSON rows per
lookup are the new rows plus the summaries at 2,000 and 20,000 messages with
2 KB JSON, the count statement uses the covering index, no table scan),
`storage-tag-owner-summary.test.ts` (one shape check and the appended rows only,
at 2,000 and 20,000 tags; status writes read nothing), and
`raw-ordinal-warmup.test.ts` (no scan on the serving connection after a worker
warm-up; rows written during the scan; failure, backoff and shutdown).

Not changed: the first page of a message-index reconciliation still seeks its
start with `OFFSET` over the JSON-filtered rows, which reads the prefix's JSON
once per session after a restart; it runs in the background job, which now
awaits the warm-up, but it is still a serving-thread read.
