# SQLite storage audit measurements

Baseline: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. All databases were synthetic,
created under a throwaway temporary root and removed. Final probes explicitly
fence XDG homes, OPENCODE_DB, context storage and logs to that root and check
tracked connection paths. No real host was started. No database version,
persisted cache format, epoch, setting or
CLI flag changed. Rust was left to the separately assigned store worker.

## Method and limitations

Commands (each has an outer timeout):

```sh
timeout 600 bun packages/plugin/scripts/perf-audit/sqlite-storage.ts
timeout 120 bun packages/plugin/scripts/perf-audit/sqlite-durability.mjs
timeout 120 node packages/plugin/scripts/perf-audit/sqlite-durability.mjs
```

The storage probe runs 1k, 10k and 60k message fixtures, five repetitions per
operation, reporting the median-wall-time sample's counters. Each fixture has
256-byte source messages, a long session with message/tool tags, one other
session and one compartment with a retired 6KiB embedding per 100 messages,
256KiB m0 / 64KiB m1 **BLOBs**, and 4096 placeholder ids. The cleanup probes
contain one plugin message per message and one memory candidate per ten messages.
The decision-log probe reproduces the production open/insert/prune/close SQL,
retaining 2000 rows. The final probe completed all three fixtures and 81 timing/
plan records. Baseline controls restored the original write admission, SELECT-star
projection and uncached column discovery, using the identical final fixture.

Explicit transaction hold starts after BEGIN succeeds and includes COMMIT.
Autocommit hold is an upper bound: the driver does not separate lock waiting
from statement execution. The JSON `commits` field counts transaction/write
**scopes**, including no-op autocommits. In particular, the three no-match lease
heals produced no WAL frames and no durable commits, despite taking the writer
lock. The decision-log probe's separate connection is not included in the main
connection's hold counters; its zero counters must not be read as zero hold.
WAL bytes are file growth, not a syscall count. FULL minus NORMAL is a controlled
estimate of sync cost, not a trace of individual fsync calls.

Shared-machine I/O contention was substantial: e.g. the unchanged 60k FULL
tag-mint probe varied from 159ms to 449ms, and the four unchanged tag scans from
53ms to 100ms. Do **not** attribute the large setter wall-time difference entirely
to removing ignored INSERTs. Writer counts, removed blob bytes, query plans and
the held-sibling-writer experiments are the strongest evidence.

## Findings

Numbers below use the 60k fixture unless otherwise stated. A dash means no
implementation change; observed fluctuations on untouched paths are not fixes.

| ID | Classification | Before → after | Commit | Test / evidence | Notes |
| --- | --- | --- | --- | --- | --- |
| DB-1 | POLICY (approved; cost confirmed on Node) | Controlled Node 32-commit pass: 4.192 → 0.309ms wall; 4.088 → 0.253ms hold; 32 → 32 commits; 131840 → 131840 WAL bytes | `8104dd7146` | `sqlite-context-pragmas.test.ts`; CLI database-access test; Node durability probe | Ufuk approved NORMAL after the original measure-only brief. WAL is verified before every NORMAL setting. Bun 1.4.2 already defaults WAL to NORMAL; Node 24.16 defaults to FULL. Runtime initializers, migration worker, telemetry and CLI/doctor writers share the helper. Read-only rollback-journal diagnostics and in-memory fixtures retain their old mode. Repair restores FULL before exporting DELETE-mode files. |
| DB-2 | CONFIRMED; stopped before migration | 20 large-row reads 4.447ms versus 0.356ms for scalar projections; 20 scalar updates 13.987ms, 13.818ms hold, 20 commits, 82400 WAL bytes → — | — | Actual metadata getter and UPDATE probes | Splitting blobs/large JSON needs a migration. This scalar-update probe does **not** establish that every scalar update rewrites every overflow page; its median sample appended only 20 pages. No side table or getter contract changed. |
| DB-3 | CONFIRMED | Three cached opens: 0.520 → 0.128ms wall; 0.221 → 0ms hold; 3 → 0 no-op writer scopes; 0 → 0 durable commits. Held sibling writer: 286.407 → 0.073ms | `116d3ff741` | `cached opens do not attempt a writer when no lease is stale`; stale/fresh lease tests | SELECT before UPDATE, not a timer: preserve the identical recovery opportunity on every open. The UPDATE repeats the TTL predicate to respect a concurrent renewal. Prepared statements are cached, but results are never cached. Schema fences still query on every open. |
| DB-4 | POLICY (measured cost, batching rejected) | 32 minted tags: 32 transactions, 64 writes. NORMAL pass about 160–180ms wall, 9.53–10.69ms hold → — | — | Production tagger probe; existing tagger recovery/scoped-load suites | One outer transaction would roll back previously committed tags on a mid-walk failure and prevent sibling allocations from interleaving as before. Savepoints do not preserve those committed prefixes. Cached counters are not proof of durable counters after rollback either. Leave numbering, transaction boundaries and crash recovery unchanged. Most wall time is outside the writer lock, so batching cannot be claimed to remove the whole stage. |
| DB-5 | CONFIRMED; stopped before migration | Status UPDATE + floor-0 reload: 34.694ms versus 0.008ms for the hot reload probe; 1 dirty write/commit → — | — | Actual status update and tagger reload | Trigger versioning cannot distinguish identities from statuses. A new identity/status version arrangement is a schema migration; no trigger changed. |
| DB-6 | NEGLIGIBLE / admission policy | 20 busy-timeout read/set/restore cycles: 0.056ms. Empty privileged admission: 0.932ms wall, 0.861ms hold, 2 privilege writes, 1 commit, 4120 WAL bytes → — | — | Shared SQLite writer probes; acquisition-routing suites; 15-check Node smoke | Under 1ms on this fixture. The actual admission contract is retained. NORMAL makes the analogous admission probe about 0.087ms, but that is DB-1, not an admission rewrite. No stale timeout memo added. |
| DB-7 | CONFIRMED for no-op writer admission; prepare overhead left alone | 20 transactional setters: 40 → 20 write statements, 20 → 20 commits; measured 41.831 → 4.582ms wall, 40.410 → 4.269ms hold (noisy) | `116d3ff741` | `existing metadata reads do not attempt INSERT OR IGNORE admission`; defaults and held-writer tests | Existing rows use a fresh indexed existence read. Transactional setters still hold their existing transaction; nontransactional callers avoid a needless writer admission. Missing rows keep the original INSERT OR IGNORE defaults and race handling. No blanket rewrite of 107 prepares. The compaction test double gained get(); all original assertions remain. |
| DB-8 | NEGLIGIBLE; normalization stopped before migration | Both getters parse 4096 ids in 0.822ms → — | — | Actual getters | The proposed normalized table needs a migration. No frozen ids, CAS serialization or replay decision changed. |
| DB-9 | POLICY (coverage cost confirmed) | Invalidated physical coverage proof: 6.574ms including one scalar write; hot proof: 0.014ms; read portion has no writer hold → — | — | Actual coverage helper; existing missing-row/duplicate-ordinal/sibling-writer tests | It does not scan on every search when unchanged. A completed backfill watermark does not prove that every physical row is mapped after an ordinal replacement. Keep the completeness proof; a durable inventory would need a migration. |
| DB-10 | CONFIRMED structural finding; stopped before migration | EXPLAIN uses non-covering `idx_message_fts_rowid_map_session_time (session_id=?)` → — | — | EXPLAIN QUERY PLAN | There is an existing session-prefixed index, so this is missing **coverage**, not a full-session-map table scan. Adding `(session_id, fts_rowid)` is a schema/index migration. No counterfactual speedup claimed. |
| DB-11 | CONFIRMED scan cost; proposed version memo stopped | Four reads/scans: 53.657ms, 4 prepares, no writes/hold; trigger bound alone 6.559ms → — | — | Actual aggregate/oldest-tool helpers; existing accounting tests | `tags_version_au` covers identity and status, not token counts, input counts, reasoning counts, tool names or pending ops (`migrations.ts`, v86). A memo keyed solely by tags_version would serve stale accounting/reclaim decisions. A sufficient durable aggregate version needs schema work. Preparation is not the dominant cost; four returned maps/candidate scans are. No unsafe memo or early LIMIT that changes tier priority. |
| DB-12 | NEGLIGIBLE | Preparing two 900-parameter IN reads: 0.165ms; executing/decoding them: 1.303ms → — | — | Separate prepare-only and real read probes | The claimed preparation cost is under 1ms. JSON membership would also need care to preserve existing chunk ordering and duplicate behavior. No query rewrite. |
| DB-13 | CONFIRMED; stopped before index/retention change | Open + insert + prune + close: 1.741ms; EXPLAIN has TEMP B-TREE FOR ORDER BY → — | — | Equivalent production SQL probe; full decision-log retention suite | Index needs migration. Pruning every N rows changes persisted retention; handle reuse also needs replacement-file/connection-lifecycle fencing. Retention and connection lifetime stay unchanged (apart from the approved DB-1 pragma). Separate-handle hold was not instrumented. |
| DB-14 | CONFIRMED; stopped before migration | Seven indexes occupy 568 pages / 2326528 bytes. Minting 32 tags writes 32–35 redundant-index WAL frames (131840–144200 bytes) → — | — | dbstat plus physical WAL-frame page-id counting | No index was dropped, even in the benchmark. Removing indexes also requires removing fresh-initializer DDL and migrating existing stores. |
| DB-15 | CONFIRMED | 600 compartments: 1.439 → 0.701ms; 3686400 retired embedding bytes no longer transferred; 0 → 0 writes/commits/hold | `118f7753ef` | Blob projection test plus legacy-coordinate rejection test | Preserve every returned renderer/validator field and ordering. Schema-aware projection retains old rejection behavior on minimal tables. No count API change. |
| DB-16 | CONFIRMED (boot only) | 171 repeated column checks: 5.297 → 0.033ms, 171 → 0 warm prepares, 0 → 0 writes/commits/hold | `b405b270fa` | Committed-schema reuse, local/sibling DDL, rollback-version reuse and unknown-proxy tests | WeakMap per connection; schema_version invalidates all table discoveries. Transaction-local/unknown schemas bypass caching and discard prior discoveries. Nothing durable is cached or versioned differently. |
| DB-17 | NOT REPRODUCIBLE as “never shrink”; eviction is POLICY | 600 sessions / 60000 assignment entries → 0 / 0 after cleanup, on the unmodified tagger | — | Actual heap counters before/after cleanup; existing cleanup/recovery tests | `tagger.ts:872-879` deletes all four maps for the session. Archived sessions without cleanup can retain entries. Bind/unbind APIs expose in-memory decisions and live Map references; replacing the four independent maps with LRU eviction without proving hydration/atomic eviction would exceed byte-safety evidence. No eviction policy added. |
| DB-18 | CONFIRMED for plugin-message scan; candidate scan NEGLIGIBLE | No-match deletes: 60000 plugin rows 1.506ms wall / 1.486ms hold; 6000 candidates 0.149ms / 0.145ms hold; one no-op writer scope each, no WAL growth → — | — | Populated fixtures and EXPLAIN show SCAN on both tables | Session indexes need migration. No cleanup semantics or schema changed. |

## Matched fixture sizes for the implemented changes

All times are milliseconds. The DB-1 controlled probe has nine repetitions of
32 commits per fixture; storage probes use five repetitions.

| Operation | 1k before → after | 10k before → after | 60k before → after |
| --- | --- | --- | --- |
| Node FULL → NORMAL wall (controlled scalar commits) | 2.285 → 0.317 | 2.069 → 0.693 | 4.192 → 0.309 |
| Node FULL → NORMAL writer hold | 2.170 → 0.265 | 1.962 → 0.637 | 4.088 → 0.253 |
| Three cached opens, wall | 0.184 → 0.128 | 0.195 → 0.232 | 0.520 → 0.128 |
| Three cached opens, hold / no-op scopes | 0.039 / 3 → 0 / 0 | 0.045 / 3 → 0 / 0 | 0.221 / 3 → 0 / 0 |
| One cached open with sibling writer held | 376.201 → 0.061 | 284.897 → 0.069 | 286.407 → 0.073 |
| 20 setters, wall (I/O-noisy) | 14.769 → 4.271 | 116.011 → 5.231 | 41.831 → 4.582 |
| 20 setters, hold / commits | 14.053 / 20 → 4.017 / 20 | 114.008 / 20 → 5.013 / 20 | 40.410 / 20 → 4.269 / 20 |
| Compartment reads, wall | 0.065 → 0.173 | 0.817 → 0.106 | 1.439 → 0.701 |
| 171 existing-column checks, wall | 5.891 → 0.039 | 11.320 → 0.045 | 5.297 → 0.033 |

The schema projection has a small fixed overhead on the 10-compartment fixture;
the 600-compartment fixture eliminates 3.5MiB of dead blob transfers. The commit
count of all retained real writes is unchanged; no tag walk was batched.

## Byte identity and verification

- Bun 1.4.2; TypeScript 5.9.3; Biome 2.5.1; Node v24.16.0;
  Bun SQLite 3.54.0. Frozen installs made no manifest/lockfile changes.
- `timeout 1800 bun run test`: final plugin stage **6784 passed, 4 skipped** in
  654 files; Pi parallel stage **1510 passed, 3 skipped, 1 startup timeout**.
- `timeout 1200 bun run --cwd packages/pi-plugin test:serial`: **1511 passed,
  3 skipped**, 139 files. This resolves the parallel startup deadline failure.
- `timeout 600 bun run --cwd packages/cli test`: all five subprocess suites
  passed: **599 + 9 + 8 + 10 + 8 passes**, 2 skips.
- `timeout 180 bun run --cwd packages/retina-local-fs test --timeout 30000`:
  **26 passed**. Its original 5s git predicate deadline timed out under load.
- `timeout 300 bun run typecheck`: all four packages passed (seven tsc invocations).
- `timeout 300 bun run lint`: passed; **1204 + 225 + 133 + 6 files** checked;
  only pre-existing warning/info diagnostics.
- `timeout 600 bun run build`: OpenCode 1/2, migration workers, Pi and CLI built;
  bundled 668 / 714 / 967 / 399 modules for their main targets; **4 v2 loader
  tests passed**.
- `timeout 60 node packages/plugin/scripts/smoke-node-sqlite.ts`: **15 checks
  passed**, including nested rollback and writer acquisition behavior.
- The full plugin suite passed the existing **“serves byte-identical hot passes
  while coalescing state and skipping all-hit token SQL”**, frozen m0/m1 replay,
  SOFT+ taxonomy, scoped tag-number recovery and native replay tests. Pi's full
  serial suite passed tail-hygiene and protected-tail parity tests. The added
  projection test observes actual driver row properties as well as unchanged
  returned compartment fields, rather than computing an expected value with the
  new projection itself.
- No transform logic changed; the real-host pure-replay differential was not
  run. Unit wire-identity/parity suites and unchanged returned-field comparisons
  are the byte-safety evidence. No new e2e test or manifest entry was needed.
- Independent controls reddened only their named tests: WAL fence, stale-lease
  admission, existing-meta admission, rollback schema cache, unknown-proxy schema
  cache, and retired-blob transfer. The first metadata control was undefended
  because its targeted getter already bypassed ensure; the test was strengthened
  to call ensure directly under a sibling writer, then reddened as intended.
  Every control was staged first and restored with an empty working diff.
- Reviewed the comments in the uncommitted changes before each implementation
  commit; reasons and cache invalidation are stated without audit/task labels.

## Stopped work

No migration was built for DB-2/5/8/10/11/13/14/18. The proposed DB-4 batch and
counter-write elision were rejected for crash/numbering reasons. DB-9's coverage
proof, DB-13's exact retention and DB-17's binding lifetime were preserved.
DB-6 and DB-12 preparation micro-costs did not justify a rewrite.

## Tool issues

- AFT inspection reported fresh TypeScript diagnostics but partial/unavailable
  Biome/Tier-2 analysis; authoritative package tsc and repository lint passed.
- Initial benchmark fixture text was corrected to BLOBs and validated through
  the real getter; invalid preliminary readings are not the table's numbers.
  The invalid text fixture caused metadata validation to fall through to the
  creation-time OpenCode parent lookup. Preliminary runs fenced context.db but
  did not override OPENCODE_DB/XDG homes; that **read-only** fallback could have
  opened a live host store if one existed. No live write was performed and those
  readings were discarded. Explicit raw-store/XDG/log fences and tracked-path
  checks were added; final valid-BLOB measurements do not need the fallback.
- Repeated checkpointing was removed after SQLITE_LOCKED in the benchmark.
  Cleanup uses a separate host connection after the decision-log writer, avoiding
  SQLITE_BUSY_SNAPSHOT from reusing the long-lived search reader. This happened
  with both baseline and changed code; no unrelated snapshot workaround was
  added to production search.
- Biome `--changed` could not infer a default comparison branch; the repository
  lint script with `--write --staged` formatted only intentional files instead.
- Full-suite runs exposed minimal legacy compartment tables and instrumentation
  proxies; the implementation was corrected to preserve their existing behavior,
  not by weakening those tests. A compaction mock was extended for the new read.
- Unrelated git setup/verification deadlines and Pi's 18-way parallel boot
  deadline were intermittent; final plugin, Pi serial, CLI, extended-deadline
  Retina, typecheck, lint and build results above passed.
