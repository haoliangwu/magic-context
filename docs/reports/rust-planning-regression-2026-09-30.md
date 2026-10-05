# Rust planning after the single-store migration

## Final correction: per-session revisions under writer churn (v93)

**Hold merge/deployment for the coordinated restart window. Rebuild the shared
plugin/Pi distributions and ck-mc, apply context.db v93, and restart the module with
the new binary. Old module binaries refuse compartment writes after the trigger
schema changes, so deploying the database migration alone can strand publications.**

The initial database-wide `data_version` key below was insufficient in production.
It misses the first validation of every pass when unrelated sessions or the
module's separate writer connection commit. The final implementation uses
`compartment_history_versions(session_id, generation, version)` instead. Read only
that session's small revision row; retain exact overlay JSON and context-domain
identity in the key. A schema-presence query enables a safe, uncached v92 fallback.
The remaining sections below this correction record the original, uncontended
investigation rather than claiming that its first cache key is still deployed.

### Churn workload and measurements

Read the live plugin log and its rotated predecessor in place at
`$TMPDIR/opencode/magic-context/magic-context.log{,.1}`. The TS-only completion
marker for TypeScript (TS) passes is `final representation` in `transform-postprocess-phase.ts`. The last
30-minute window ending 22:20:01.777Z contained 736 completed TS passes across 20
sessions: 0.409 passes/second, median 26/minute, peak 51/minute, and median aggregate
interarrival 1.413 seconds.

On fresh paired APFS clones, a separate Python process rotated through 20 unrelated
session IDs, committing six small `session_meta` updates per simulated TS pass,
with a burst every approximately 2.44 seconds. This supplies approximately 2.45
context commits/second at the observed 0.409 TS passes/second. Six transactions per
pass is an explicit workload assumption, not a measured live transaction count;
the writer reproduces invalidation/journal churn, not the full tags/index/LKG IO
mix. Requests were spaced by 2500 ms so this was not a rapid uncontended replay.
The writer's own `lsof` assertion, plus daemon/module assertions, verified all
opened databases were under the throwaway clone root. No live database was opened.

A second comparison additionally injected one transaction per transform through
the module's **actual `ModuleContextDomain` writer connection and privileged write
bracket**, before planning. Its normal privilege-row flip/commit changes the
reader's `data_version` without changing compartments. Normal module flushes were
not disabled. The injected hook and info-level hit tracing were temporary profiling
instrumentation and are not shipped; ordinary cache-hit tracing remains debug-level.
This tests the module's own connection, not just another Python connection.

Each session/binary received the same 15 inputs; medians use the last 12 confirmed
SOFT+ defers. A pass invokes coordinate validation five times; counting all calls
alone would misleadingly conceal the first-read miss:

| Cache key / churn | Session | First-validation hits | All-call hits | planning ms | trigger_ms |
| --- | --- | ---: | ---: | ---: | ---: |
| database-wide / TS writer | ALF | 0/15 | 52/75 | 56.338 | 20.687 |
| database-wide / TS writer | AFT | 0/15 | 60/75 | 65.024 | 22.394 |
| database-wide / TS + module writer | ALF | 0/15 | 60/75 | 70.835 | 21.320 |
| database-wide / TS + module writer | AFT | 0/15 | 56/75 | 77.129 | 22.730 |
| per-session / TS + module writer | ALF | 14/15 | 74/75 | 27.437 | 21.875 |
| per-session / TS + module writer | AFT | 14/15 | 74/75 | 17.257 | 17.774 |

The only per-session misses were each session's cold validation. All 12 measured
warm passes hit on their first read. The own-writer comparisons recorded 318 host
commits over 129.141 seconds and 246 over 100.204 seconds respectively; both add
30 actual module-writer transactions. Different elapsed times include compilation
and process startup, so transaction totals are not compared as throughput results.

All 30 broad/narrow served-byte pairs remained identical, including actual native
arrays. Nonce-only replays remained identical. A final-source release run, with
normal module writes enabled and the paced TS writer, measured ALF planning/trigger
17.424/17.454 ms and AFT 20.257/20.240 ms (276 host commits over 112.361 seconds).
Its 30 served-byte pairs also matched the broad-key own-writer run, including the
cold adoption pass. Final byte lengths and SHA-256 values are unchanged below.

### Narrow signal, same-length freshness, and cleanup

Migration v93 and fresh initialization use the same installer. INSERT/DELETE bump
the affected session; every UPDATE bumps the old session and, on a session move,
also the new session. This includes same-length title/content updates, coordinates,
block indices, timestamps, and other row fields. Revision and compartment changes
commit atomically and roll back together. Existing sessions are seeded without
changing compartment bodies; reapplying the installer preserves existing counters.

`domain_mutation_epoch` covers project memories/notes, not per-session history.
`m0_mutation_log` is explicit application logging, not a SQL trigger: direct SQL
repairs can leave it unchanged. A projection containing only coordinates and body
lengths would therefore miss a same-length replacement of title/content. The new
step-through test changes `body` to `BODY` while verifying that m0's log remains
empty and both the general and external-update versions advance. No length-based heuristic is used. The
counter has an auxiliary `rewrite_version` for unprivileged in-place UPDATEs and a
`seeded` marker for histories already present at installation. These enter the
module's external prefix-revision signal: otherwise fresh coordinates alone could
leave old body bytes frozen when a repair keeps their coordinates unchanged.
Ordinary INSERTs and DELETEs retain the existing publication/structural coalescing
policy. Privileged module updates retain their existing semantic-log and state-hint
policy. **All** such writes still advance the general validation version, so cached
coordinates are never reused across them. Installation/reinstallation of the
owned triggers is atomic, including during fresh schema bootstrap. A managed-pass test warms the prefix, changes
`SUMMARY` to `CHANGED` through a second SQLite connection without advancing m0's
log, and requires the next pass to serve the repair via one HARD rebuild, then
return to defer. Adopting the new revision signal can cause one cold rebuild after
upgrade; it does not change how the prefix is rendered.

Counters have a random 128-bit generation as well as a monotonic version. Session
cleanup can delete and recreate a counter at the same numeric version; its new
generation prevents an old cached validation from matching. The table is in
`SESSION_SCOPED_TABLES` **after** compartments, so deletions cannot recreate an
already-cleaned counter. The session-deleted event handler and the cleanup sweep
for sessions absent from the host's live registry both use that inventory.
The Rust test also checks equal-version recreation and v92's exact uncached fallback.

The CLI `doctor merge-identities` command combines project identities; it changes
project keys, not session IDs. The revision
table has no project coordinate to rekey; it remains attached to its session.
If a compartment's session ID is moved directly, both old/new counters advance.
Single-store migrate/repair keep the context-side revision table and use ordinary
compartment inserts/updates/deletes, so triggers maintain or recreate its rows;
versions are not imported from disposable store.db. The engine now fences this
indirectly-written table as well. Pi opens through the same shared storage/migration
code. `doctor store init` uses that initializer/migration chain for fresh stores;
its fresh-schema regression confirms the table and triggers exist.

### Shared fence and compatibility

The plugin's maximum supported upstream migration and the Rust binary's compiled
context schema version are both 93. The generated context
schema fixture, compartment fingerprint, and revision-table fingerprint are updated
together. Compartment writes also check their trigger-written revision table at
transaction time, not just startup. Counter-table drift blocks compartment writes.

- An **older v92 ck-mc on v93 context.db** tolerates the newer numeric lane and can
  read unchanged row columns. Its old compartment fingerprint does not contain
  the three new triggers, so compartment writes/publishes refuse with
  `single_store_fingerprint_mismatch`. Unchanged domain tables remain individually
  writable. Its database-wide reader cache remains correct but churn-sensitive.
- The **new ck-mc on actual v92 context.db** can open and read. Missing revision
  schema disables validation caching and reloads exact body identities every time.
  Compartment writes/publishes refuse because the required trigger/counter schema
  is absent; unchanged domains can still write. The single-store migration engine
  also requires the new counter fingerprint before copying compartments. The CLI's
  read-only preflight uses the current plugin lane, then upgrades an older
  unmigrated context through the shared migrations after backup; a v92 preflight
  regression proves history counters are seeded before engine invocation. A dedicated
  fence test recreates actual v92 schema, rather than only lowering the lane number.
- New ck-mc plus v93 schema has the intended narrow cache and compatible writers.

Old binaries refusing compartment publishes after v93 migration is the reason to
coordinate the schema upgrade, rebuilt distributions and module restart. The
numeric schema version alone does not globally prohibit all database access.

### Follow-up verification

An intermediate external-signal implementation incorrectly made every publication
HARD and failed 26 existing tests. Separating external in-place updates from append,
delete and owned-hint policy fixed those regressions without weakening the existing
coalescing/replay claims. Only the explicit supported-fence expectation was advanced
to 93 as required by the authorized schema change.

The new regressions cover populated v92-to-v93 migration through public compartment
APIs, direct same-length SQL repairs, INSERT/DELETE, cross-session UPDATE, rollback,
repeat installation, fresh initialization, cleanup/recreation, and unrelated host
plus own-writer commits that must add zero body reads. The armed migration replay
now includes a deliberate v93 arm; the fixed expected schema lane advances from
92 to 93 because this authorized migration changes that contract.

Regression controls temporarily broke each invariant, after staging the specific
files to preserve their live implementation. Each check was run against the mutant,
then `git checkout -- <path>` restored the index and `touch` invalidated build timestamps.
These controls proved that (1) reverting to a database-wide key
fails the unrelated-commit read-bound test (14 reads versus 2), (2) ignoring revision
increments fails the external-repair freshness test, and (3) making the UPDATE
trigger conditional on changed content length fails only the selected populated
migration test (version remains 1 instead of 2). Each mutant had a nonempty diff
while applied and an empty diff after restoration. No profiling hook or mutation
marker is retained. Omitting the revision from the rendered-prefix signal also
fails only `same_length_sql_repair_without_mutation_log_reloads_the_next_managed_pass`
(the module wrongly returns SOFT+ instead of HARD after the repair).

Final gates:

- Shared migration/cleanup/identity/doctor scope: 49 existing/new tests passed in
  the final eight-file run; the new test of updates inside the module's database
  privilege bracket initially failed because its
  privilege UPDATE affected no singleton row. Corrected it to enter the actual
  INSERT/UPSERT write bracket; its isolated rerun passed. No production change or
  existing claim was relaxed.
- Plugin and CLI typechecks passed. Shared plugin/Pi/CLI builds passed in this
  worktree; nothing was deployed.
- Final Rust library: 1440 passed, 17 opt-in tests ignored. All module integration
  targets passed with only the previously diagnosed missing-context supervision
  fixture excluded. The combined command hit its 1200-second cap after reaching
  store tests; package-scoped store completion passed 180 tests (one ignored) and
  doc tests. The last source edit removed a needless borrow flagged by clippy;
  clean clippy and release build then passed.
- Biome formatting was unavailable: both repository configs reject their existing
  `rules.preset` key with the installed formatter. Config files were not changed.

## Initial investigation (uncontended, superseded cache key)

### Result

ALF is the orchestration session `ses_227ce5788ffeRPA9THoPLOQreO`; AFT is the tool
session `ses_313660571ffeZTsf4koSJwk50Q`. Repeated passes that replay cached output
without recomposing the prefix (`SOFT+` defers), run on paired APFS clones,
returned to tens of milliseconds. The problem was **compartment coordinate validation**, not token
estimation, memory rendering, or the date cache. Both planning and the historian
trigger repeatedly loaded and fingerprinted every historical summary to validate
otherwise unchanged host-coordinate overlays.

The final release binary and a release binary using the original read implementations served
byte-identical CK **and OpenCode-native** output for all 15 matched inputs per
session. Nonce-only defer replays were byte-identical within each run as well.

## Incident log check

Read `magic-context.2026-09-30.log` in place; did not copy it. Selected
`mc-pass-timing` lines, which record per-request phase durations,
with the two exact session IDs and `action=SOFT+`, using timestamps before 17:30Z
and at/after 19:45Z. These are the medians observed when starting this investigation
(milliseconds):

| Session | Window | n | total | planning | trigger_ms | finalize | build_output | store_commit |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ALF | pre | 163 | 1078.30 | 19.30 | 245.80 | 262.40 | 209.60 | 260.40 |
| ALF | post | 12 | 1402.85 | 573.55 | 538.45 | 189.25 | 134.50 | 188.00 |
| AFT | pre | 168 | 1126.30 | 31.05 | 213.70 | 279.65 | 183.95 | 274.05 |
| AFT | post | 15 | 1123.30 | 475.20 | 393.90 | 230.70 | 137.40 | 229.30 |

The independently calculated medians show an approximately 30x ALF / 15x AFT
planning regression, despite the small post-migration sample.

## Isolation and reproduction

- Checked `df -h` before cloning: 152 GiB available; 148 GiB after the paired
  context/store clones, 143 GiB after also cloning the raw OpenCode input database.
  All remain above the required 20 GiB reserve.
- Used `cp -c` on database files and each existing `-wal`/`-shm` file. No SQLite
  connection, profiler, or module opened a live store. The raw OpenCode database was
  also APFS-cloned before querying it.
- All data, binaries, fixtures, response captures and logs stayed under
  `$TMPDIR/magic-context/perf-planning/pool-1198/`. No private payload or profile is
  committed. Each daemon/module pair is owned by the test and terminated on exit.
- The real-daemon probe runs `lsof -p` for the daemon and module processes and asserts that every
  database path is under its canonical throwaway root. The final read-profile
  helper performs the same assertion for its process.
- The context clone is about 7.0 GiB, the cache clone about 885 MiB. ALF has 1771
  accepted coordinate overlays; AFT has 1995. Their host-wire tails contain 581
  and 422 messages, starting at absolute ordinals 121942 and 134085 respectively.
- Used the installed `ck-subc` binary with an empty isolated module configuration,
  isolated HOME/config/runtime/data homes, and explicit release `ck-mc --subc`.
  The daemon never connects to production. Historian model chains are empty, so
  trigger preparation/evaluation executes but no model production occurs.

The writer fence rejects writes from a lease whose epoch is older than the last
accepted writer. The clone retains production epoch 347, but the new temporary
path's lease starts with a lower epoch; it therefore rejects otherwise valid writes.
Reset `cortexkit_fence.epoch` to zero **only on clones**. Raw host input differs
from the historical transformed block-identity pins, so removed the two sessions'
`mc_block_identities` **only on the initial clone**, allowed a normalization pass,
and then made identical before/after clones of that normalized foundation. Shared
compartments and their summary bodies were not deleted or rewritten. This measures
real planning at historical scale, not an exact continuation of the live host's
in-memory ingress state.

Fixtures use `readRawSeedTailFromDb` on the cloned OpenCode database, retaining
parts and absolute ordinals. The test uses the Rust OpenCode codec to construct CortexKit's canonical wire
representation (CK),
sets the stored render/provider/model/system inputs, and requests `serve_native`.
Every third request appends an ordinary user message with a new ID/ordinal; the
other requests change only the nonce. These are full-tail requests, not the host's
transport-level delta protocol. Both runs receive identical sequences.

Reproduction entry points:

```sh
cargo build --release --locked -j 2 -p mc-module --bin ck-mc
MC_PLANNING_CLONE="$clone_root" \
MC_PLANNING_FIXTURES="$fixtures_json" \
MC_PLANNING_MODULE="$release_binary" \
MC_PLANNING_DAEMON="$isolated_daemon_binary" \
cargo test --locked -j 2 -p mc-module --test real_daemon \
  planning_clones_through_real_daemon -- --ignored --nocapture

MC_PLANNING_CLONE="$clone_root" \
cargo test --locked -j 2 -p mc-store cloned_boundary_validation_profile \
  -- --ignored --nocapture
```

`fixtures_json` is an array of objects with session/render/provider/model/system
fields copied from the persisted cache metadata (to reproduce the same rendering
configuration, provider/model identity and system-prompt hash), and `raw_messages`: OpenCode `{info:{id,role,time},parts,absolute_ordinal}`
records from the cloned boundary-inclusive tail. The root is required to be under
`$TMPDIR/magic-context/perf-planning/`. Recreate destination WAL/SHM files as a pair
when repeating a clone; do not leave a prior run's WAL beside a newly copied main
file. One exploratory run with an old destination WAL failed as malformed and was
discarded before the matched measurements.

## Profile and cause

Neither `samply` nor `cargo-flamegraph` was installed. Used the real module's phase
spans and a timed store-path helper rather than claiming sampled CPU stacks.

The expensive chain is:

- Planning: `apply_once -> detect_boundary_divergence_candidate ->
  max_compartment_end_ordinal / load_compartment_boundaries ->
  cached_context_boundaries -> load_raw_context_compartments ->
  ResolvedContextBoundary::identifies -> row_identity`.
- Historian: trigger preparation calls `max_compartment_end_ordinal`, reaching
  exactly the same validation chain. `boundary_messages` and trigger evaluation
  themselves were approximately 0.5–1.1 ms in the matched release runs, not the
  dominant cost.

Before the fix, each `cached_context_boundaries` call read the overlay JSON from
`store.db`, parsed it, selected all wide `compartments` rows for that session from
`context.db`, found each row by linear sequence search, serialized its entire
summary-containing record, and SHA-256 hashed it. `max_compartment_end_ordinal`
validated once to choose its branch and again inside `load_compartment_boundaries`.
When the cache records which compartments its frozen prefix covers, planning
also independently loads structural boundaries (sequences, ordinals and end IDs):
**three wide body reads in planning, two in the historian**, on an ordinary stable
pass. Structural overlay matching introduced another quadratic search.

The isolated debug-profile helper measures two validation calls and one max-end
call (four validations). Original warm medians were 2424.780 ms ALF / 2563.132 ms
AFT; cached warm medians were 24.000 / 40.297 ms. These debug numbers isolate the
read/validation chain; they are not release-pass latency claims. Cold cached bundles
still pay the required validation, 1258.801 / 1417.992 ms in that debug run.

Other cheap per-pass context reads remain uncached so classification immediately
sees new revision heads and publication signals: `load_m1_revision_snapshot`
reads workspace membership, visible memory/mutation maxima, compartment sequence,
note update maximum, project epoch, m0 mutation head and global profile version
inside one snapshot. Structural boundary queries still read sequence/ordinals/end
ID, not summaries. Pending drops and tag baselines remain cache-store inputs;
historian token priming reuses the pass's hydrated tag snapshot. Compartment date
cache reads are a rendering input, not the repeated defer-path body scan.

## Fix and freshness

Cache only the **validated coordinate list**, not the history or memory bodies.
The cache key includes session, exact persisted overlay JSON, the context domain
identity, and SQLite `PRAGMA data_version` from the stable reader connection. On a
miss, the version and source rows are read in the same transaction. Both production
and plain SQLite domains use one reader distinct from all writers; custom domains
must explicitly opt into that guarantee or they always reload. Replacing the
domain clears the cache under the same mutex.

An external commit, including a direct SQL summary repair with unchanged count and
maximum sequence, changes `data_version` and forces validation before reuse. A
cache-store-only coordinate change invalidates by JSON identity. Failed reads are
not cached. Retain at most eight sessions, with recency updates; retained entries
contain coordinates and source JSON, never summary bodies. Sequence maps remove
the repeated linear matching loops.

Invalidation is intentionally conservative: **any context.db commit** invalidates
the validation, even one unrelated to compartments. A workload continuously writing
unrelated context rows may still pay miss cost. No schema migration or assumption
that all writers maintain semantic mutation logs is introduced. This preserves
freshness even for maintenance tools writing directly to SQLite.

## Matched release measurements and exact bytes

Baseline restores the original master validation and structural-matching methods
in the staged implementation, builds a release binary, then restores the index
before building the final binary. Added inactive cache fields/counters do not alter
baseline behavior. Both binaries were built with `--locked -j 2` in this worktree.
The existing lock correction was cherry-picked from master commit `282445eeff` because
base Cargo.lock did not match sibling `subc-client-rs` 0.23.4.

Fifteen passes per session per binary; medians below use passes 3–14 (12 confirmed
`SOFT+` defers). Timings are milliseconds:

| Session | Binary | total | planning | trigger_ms | native_attach |
| --- | --- | ---: | ---: | ---: | ---: |
| ALF | original | 171.167 | 101.807 | 72.986 | 65.303 |
| ALF | final | 99.518 | 17.923 | 18.397 | 79.435 |
| AFT | original | 169.115 | 113.240 | 81.612 | 42.885 |
| AFT | final | 84.059 | 19.107 | 19.826 | 51.292 |

The clones reproduce the expensive read chain, not the live log's exact 475–574 ms
wall times: release clone baselines were 102–113 ms. No exact reproduction of the
live 15–30x multiplier is claimed. Final planning is below the observed pre-window
medians, and trigger time is below both observed pre-window medians.

Compared actual serialized `{ck_messages,native_messages}` bytes, not a proxy
fingerprint or a response containing null native output. The probe asserts native
output is an array. All 30 baseline/final pairs were equal; each run also asserts
nonce-only replay equality. Final pass bytes:

- ALF: 2,884,951 bytes; SHA-256
  `f110db4a2dda76feb0a02093d3fa30411504d544accf92c87972485d861ddd05`.
- AFT: 1,787,054 bytes; SHA-256
  `d9bc460b2d44e2928f8c8c104f60ef87e934a8503c0eef3397c25ed05f78e5fa`.

## Gates and guard evidence

- AFT `aft_inspect` scoped Rust diagnostics: zero errors/warnings for all five
  changed source files.
- `cargo clippy --locked -j 2 -p mc-module -p mc-store --all-targets -- -D warnings`:
  passed.
- `cargo build --release --locked -j 2 -p mc-module --bin ck-mc`: passed.
- `cargo test --locked -j 2 -p mc-module -p mc-store`: hit the 300-second execution
  cap under default test concurrency; no test failure had been printed.
- Retried with `-- --test-threads=2`: all 1437 module library tests passed (17
  ignored), along with the completed integration targets. The existing
  `mc_pipe_only_supervision_through_real_daemon` failed, and failed again in an
  isolated retry: its supervised module is never provisioned with context.db.
  Its throwaway module log says `context_db_missing: no context.db ... run ...
  doctor store init`. The ordinary real-daemon spine and hostless-init tests passed.
  This unrelated fixture provisioning failure is not changed by this fix.
- `cargo test --locked -j 2 -p mc-store -- --test-threads=2`: all 178 store tests
  passed (one opt-in clone profile ignored), plus doc tests.
- New read-bound/freshness regression measures actual wide SELECT invocations:
  twelve stable passes add zero body reads; a second SQLite connection rewrites
  content with unchanged row count/sequence, then publishes a newer block. The
  next reads reject stale coordinates, serve repaired content, and observe new end
  ordinal 9. A separate test changes only overlay JSON and observes new coordinates.
  Existing module tests `first_compartment_published_after_empty_bootstrap_hard_folds_and_mints_boundary`
  and `an_in_place_compartment_rewrite_by_another_writer_is_an_eager_hard_input`
  also passed: they verify that the next transform observes publication/body changes
  and takes the required HARD fold, rather than continuing to serve old content.
- Safe stage/mutate/restore controls: restoring the original per-call validation
  failed only `stable_boundary_validation_reads_bodies_once_and_reloads_external_publications`
  (39 body reads versus 3); ignoring `data_version` failed the same named test at
  the external-repair assertion. Each exact run filtered 178 unrelated tests.
  Both controls had nonempty diffs while applied and empty diffs after restore.
- Comment review: no unclear comments flagged. No mutation marker remains.

## Restart-window follow-up: installer, harness sweep and reason labels

The installer now reads the four existing sqlite_master definitions and compares
SQLite's stored creation text with the expected table/trigger text. An unchanged
open returns before the IMMEDIATE transaction and the seeding scan. Missing or
different triggers are repaired atomically, with a second check after acquiring the
lock to avoid redundant repair by concurrent openers. Unexpected table-definition
drift is rejected rather than replacing revision data. Trigger SQL and fingerprints
are unchanged. A second-connection test holds a competing IMMEDIATE writer with
zero busy timeout: installation succeeds without a write lock or schema cookie
change, then verifies missing/different triggers are repaired and subsequent opens
remain read-only.

The session-counter cleanup predicate now requires that no compartments remain for
that session. The actual orphan-sweep test removes one harness's compartments while
retaining another harness's compartment and its incremented counter, then removes
the last harness and requires counter removal.

History rebuilds now report `compartment_history_revision`, including both the
trigger signal and explicit m0 history mutation log. This diagnostic component is
tracked separately from the unchanged aggregate rendering fingerprint. Zero-valued
tracking is omitted from serialized metadata, preserving the existing baseline
metadata-digest claim. The managed-repair test reproduces both the new history
label and the old generic label with identical input/core snapshots; the serialized
served CK message bytes are identical. The existing eager-rewrite test retains its
HARD/content assertions and changes only its intentionally corrected reason label.

Requested gates passed: full mc-module library (1442 passed, 17 ignored), mc-store
(180 passed, one ignored), clean clippy, plugin migration/maintenance tests, CLI
single-store doctor tests, and plugin/CLI typechecks. A shared sibling dependency
moved during verification, making the unchanged lock cease to resolve. The parent
authorized a lock-only version correction: subc-client-rs 0.23.4 -> 0.23.9. An offline
regeneration also proposed unrelated registry upgrades; those were discarded, and
only that path-package version changed. An existing short lease-timing test failed
once under suite load and passed its isolated retry and the final full run.

No live stores were opened or modified. The coordinated restart/deployment hold
above still applies.
