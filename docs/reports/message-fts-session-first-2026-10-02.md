# Session-first message full-text search

## Design and completeness

The message lane in shared `search.ts` now screens matching posting rowids
through `message_fts_rowid_map` **before reading the unindexed session/content
columns**. The existing FTS corpus, `bm25`, projections, ordinal/date predicates,
limits, diagnostic live-tail counts, and ordering clauses are retained. This is
not per-session BM25, a new FTS index, native `ORDER BY rank`, or a timeout change.

The predicate is deliberately `+message_history_fts.rowid IN (...)`, placed
before the ordinary session predicate. Unary `+` prevents SQLite from selecting
rowid point-MATCH restarts for each mapped message. A preliminary Node warm probe
of plain `rowid IN` took about 1.2 seconds, versus 0.15–0.17 seconds globally;
that version was rejected. The shipped form retains one global postings cursor,
but tests the session's rowid membership before fetching other sessions' content.
The query-plan/bytecode regression checks the sidecar's session index, the single
MATCH cursor, and membership rejection before the first FTS column read.

**Choice: fall back, not backfill.** The map's primary key is
`(session_id, message_ordinal)`. An ordinal collision can leave multiple physical
FTS rows while an upsert retains only one rowid. A backfill-completed flag, equal
counts, or source-ordinal coverage is therefore insufficient. Making that map
represent every duplicate would require a schema/contract change. No migration
or new backfill is included, and existing message-index writes remain unchanged.

A read-only coverage audit computes physical rowids in FTS5's compact `docsize`
inventory minus rowids in the sidecar, then reads only those missing rows to
identify incomplete sessions. Undated searches for those sessions execute the
previous global query, preserving legacy rows and ordinal duplicates. Complete
sessions use the filter even when other sessions are incomplete. Dated searches
keep their existing sidecar timestamp join and NULL-time exclusion; adding the
rowid screen cannot discard a row that that join previously admitted. If the
inventory/proof is unavailable, undated queries conservatively remain global.

The coverage proof is cached per connection, invalidated by `total_changes()` for
local writes and `data_version` for external commits. Caller-owned transactions
do not publish cached proofs, so rollback cannot preserve an uncommitted result.
An explicit main-table read pins a deferred read transaction even on cache hits;
the proof and all synchronous message queries share that snapshot, preventing a
concurrent unmapped insert from being silently excluded. Unrelated writes also
invalidate coverage: correctness is preferred to a schema-based revision counter.
As with the existing index readers, map entries are maintained by the transactional
message-index writer; this change does not repair manually corrupted ownership.

## Both hosts

OpenCode's `tools/ctx-search/tools.ts` and `auto-search-runner.ts`, and Pi's
`tools/ctx-search.ts` and `auto-search-pi.ts`, all call the same `unifiedSearch`.
No host-specific SQL fork or wrapper change is necessary. The predicate covers
single queries, cutoff queries, diagnostic CTEs, relaxed recall, batched literal
probes, per-probe counts, and dated variants. Existing host behavior tests and
both package typechecks/builds were run; Node's SQLite backend was also exercised.

## Result equivalence

The new seeded-store regression runs **72 combinations** of session, query,
ordinal cutoff, date range, and automatic/explicit mode. Every actual production
FTS SELECT/COUNT runs first against real SQLite; a reference query with only the
new rowid predicate removed then runs against the same store. Exact
`JSON.stringify` row arrays must match, including rank values/order and diagnostic
summary rows. The fixture includes matching other sessions, equal-rank ties,
multi-probe recall, empty eligible sets, live-tail matches, NULL timestamps,
unmapped legacy rows, and duplicate ordinals despite a completed backfill flag.
Assertions additionally require both legacy ordinal copies and the unmapped
message to survive and require the mapped-session production queries to use the
sidecar, preventing equality from passing merely because both arms stayed global.

Separate tests cover local insertion/deletion, map repair, external commits,
rollback, cached read-snapshot isolation, read-only connections, and a missing
docsize inventory.

## Benchmark method

Only an initial SQLite backup opens the live source, with `-readonly`:

```sh
COPY="$TMPDIR/magic-context/bg_33a5cd3014846dbc"
mkdir -p "$COPY"
sqlite3 -readonly "$HOME/.local/share/cortexkit/magic-context/context.db" ".backup $COPY/seed.db"
timeout 2400 bun packages/plugin/scripts/benchmark-message-fts-session-first.ts \
  --source "$COPY/seed.db" --directory "$COPY" --repeats 5
```

Each cold sample uses `sqlite3 -readonly <seed> ".backup <fresh-destination>"`
and a new process/SQLite connection. The seed URI includes `immutable=1`, because
it is a static SQLite backup with no pending WAL, not a live database. Sample
connections use the same immutable URI plus `readonly: true`. This avoids
creating journals/shared-memory files and a reproduced read-only WAL-backup
opening failure. No live file is opened for writing, no live configuration is
read, and all database copies are deleted after measurement.

Cold means a fresh file/process/SQLite cache per sample; **the OS/disk cache is
not purged**, and SQLite backup itself reads the seed. Arms alternate AB/BA over
five pairs per lane. Warm samples use one connection per arm, one untimed warmup,
then five measured repetitions. Coverage validation, its cache checks, transaction
entry/exit, and statement preparation are included in the new arm. Backup,
connection opening, and result hashing are outside the timed lane. The global arm
uses the prior query without coverage overhead. This is a SQL-lane benchmark,
not a whole-hook, embedding/provider, or strict three-second-bound measurement.

The snapshot has **342,163 FTS rows and 342,138 map rows**, preserving the 25-row
global difference. The selected largest indexed Pi session has **935 mapped
rows**, no missing rowids, and persisted compartment cutoff **61,140**. The input
is the report's current-status prompt (`What's the current status ?`), with the
production content-column MATCH expression. Auto uses the original 30-row fetch;
explicit diagnostic search uses the original cutoff-aware 90-row fetch and
live-tail summary. Only aggregate timings and hashes are retained; private
session identities/content are not committed.

### Measurements

Milliseconds; median and nearest-rank p90. Bun **1.4.2**, SQLite **3.54.0**;
five samples per arm per row (40 timed samples total).

| Lane/cache | Global median | Session-first median | Global p90 | Session-first p90 |
| --- | ---: | ---: | ---: | ---: |
| Auto / cold fresh backup | 187.589 | 110.119 | 238.358 | 222.688 |
| Auto / warm | 150.499 | 65.935 | 152.298 | 72.817 |
| Diagnostic ctx / cold fresh backup | 158.849 | 129.578 | 308.654 | 188.612 |
| Diagnostic ctx / warm | 150.020 | 61.562 | 155.807 | 61.640 |

All 40 samples returned identical row bytes within their respective lanes,
including the diagnostic rank/summary columns. Each returned one eligible row
and zero suppressed live-tail matches; richer rank/diagnostic cases are covered
by the seeded tests. All new-arm samples reached the sidecar filter despite the
25 unmapped rows elsewhere in the store.

The fresh-backup medians improve about **41% auto / 18% diagnostic**; warm medians
improve about **56% / 59%**. With five samples, nearest-rank p90 is the largest
sample, not a well-estimated long-tail quantile. These copied-file measurements
**do not reproduce the older 4.5–6.3-second prompt stalls**. SQLite backup reads
and writes the entire store, unlike the earlier copy-on-write-clone experiment,
so its OS-cache state is different. No provider/whole-hook speedup or absolute
latency cap follows from these numbers. Warm measurements also use unchanged
read-only connections: production metadata writes invalidate coverage and must
pay for another audit.

A separate warm run using Node **24.16.0** and `node:sqlite` **3.53.0** ran ten
samples per arm/lane (40 total), again with identical ranked/diagnostic row bytes:

| Node warm lane | Global median | Session-first median | Global p90 | Session-first p90 |
| --- | ---: | ---: | ---: | ---: |
| Auto | 216.012 | 82.093 | 248.944 | 85.726 |
| Diagnostic ctx | 196.752 | 76.739 | 219.436 | 89.200 |

This confirms the shared query works with Pi's native SQLite backend; the Bun and
Node runs are not controlled runtime comparisons. The two saved lane hashes also
agree across the Bun and Node artifacts (80 timed samples total). Reproduce the
Node warm check
by bundling the benchmark with `bun build --target node --external bun:sqlite
--external node:sqlite`, then running the output with the same seed/directory
arguments and `--repeats 10 --warm-only yes`.

An initial ten-pair attempt exceeded a 120-second backup subprocess guard under
shared-machine disk load; that incomplete attempt is not included above. The
driver now gives backups 600 seconds and persists progress outside Git after
each sample. The final five-pair run completed without timeouts. Its raw timings
and hashes are in private `fts-benchmark.json`; the supplemental Node run is in
`node/fts-benchmark.json` under the task directory. Database copies, journals,
and the temporary Node bundle were removed after verification.

## Verification and non-vacuity

- Shared/OpenCode search, index, host-wrapper, deadline, and temp-policy tests:
  105 passed, zero failed (Bun 1.4.2; shell `timeout`, per-test 30-second timeout).
- Pi explicit/automatic search tests: 24 passed, zero failed (same timeouts).
- Both package typechecks: passed (TypeScript 5.9.3).
- The new regression fixture was additionally typechecked with a temporary
  single-test configuration (TypeScript 5.9.3); the configuration was removed.
- Native Node coverage/ranking smoke: six assertions passed, including unmapped
  fallback, local writes, rollback, deletion, and exact ranked rows.
- Both package builds: passed; OpenCode's build also ran four server-export tests.
- Changed source lint: three files passed (Biome 2.5.1). Pi lint passed with its
  existing mural-test warning. Whole-plugin lint has three existing import-order
  errors in config schema, historian-expand tests, and `read-session-chunk.ts`;
  those unrelated files were not changed.

With the verified state staged, neutralizing the lean cutoff query's rowid screen
failed only `production message queries constrain FTS rowids through the session
index`; the other four regressions passed. The mutant had a 2-insertion/1-deletion
diff, and index restore plus touch returned an empty diff. Removing only the
explicit snapshot-pin read left all five tests green: this Bun SQLite version's
`pragma_data_version` query already pins the snapshot. The explicit main-table
read remains a conservative guarantee independent of that pragma implementation;
the undefended mutant had a 1-insertion/1-deletion diff and was likewise restored.
No mutation is present in the delivered tree.
