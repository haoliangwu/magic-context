# 0.45 startup migrations off the main thread

Date: 2026-10-02 (log times in UTC). Platform: macOS arm64, APFS, Bun 1.4.2, Node 24.16.0.
Follows `docs/reports/v045-upgrade-rehearsal.md`. That rehearsal started 0.44.4 → 0.45 candidate hosts (OpenCode
1.18.31, OpenCode 2.0.15, Pi 0.99.2) on copies of a real 7.5 GB schema-91 store and found OpenCode's
`/health` silent for 6.6 to 46 seconds while migration v94 ran synchronously inside the host. "OpenCode 1"
and "OpenCode 2" below mean those two host generations.

## Verdict

- **Startup migrations now run on a worker thread**, so the host keeps serving requests while v94 commits.
  On fresh copies of the same real schema-91 store, `/health` probes every 250 ms showed **no gap above
  1 s on either OpenCode lane**. OpenCode 1.18.31 had 0 of 50 probes fail, with a longest gap of 315 ms.
  OpenCode 2.0.15 had 0 of 50 fail, with a longest gap of 895 ms. Run the same way, the unfixed build lost
  39 of 63 probes (an 11.1 s gap) on OpenCode 1 and 70 of 81 (an 18.7 s gap) on OpenCode 2. Every lane
  served its first turn through the mock provider, and a second start applied no migrations.
- **Migration v94's body is unchanged.** v94 is already applied on our fleet, and this change does not
  alter what it writes. Measured on the specimen, the LKG part dominates only for a recently used store.
  Discarding those prefixes would remove the replay fallback on exactly the first pass after the upgrade
  (see Part 2). With v94 off the main thread, its cost is first-start time to tools, not a frozen host.
- **No schema version was added.** The persisted schema and the fence are unchanged (`LATEST_SUPPORTED_VERSION = 94`).

## What changed

`openDatabaseAsync` is the startup open for OpenCode 1, OpenCode 2 and Pi. When the database has pending
migrations, it now:

1. Runs the schema fence and the old-holder migration guard on the main thread, exactly as before. A
   confirmed old OpenCode or Pi holder still refuses the migration before any worker starts.
2. Starts `migration-worker.js`, which opens its own SQLite connection and runs the same code the main
   thread used to run: `initializeDatabase`, then `runMigrationsWithRetry`. The migration lock, BEGIN
   IMMEDIATE, the read-only fast path and sibling-conflict tolerance are therefore unchanged. Worker log
   lines are forwarded to the host's log with their original timestamps.
3. Awaits the worker. A migration failure rejects with the worker's message, so the open fails closed with
   the same `storage unavailable: Migration vN failed: …` text as before. The main connection stays idle
   during migration and is handed out only after the worker has committed. No caller can read a
   half-migrated schema.
4. Runs `initializeDatabase` and `runMigrationsWithRetry` on the main connection. On a migrated database
   these take `runMigrations`' read-only fast path. `finishDatabaseOpen` then rechecks the schema fence,
   as before.

Further behaviour:

- **No pending migrations:** no worker is started (`hasPendingMigrations` is two read-only queries), so
  the cost of a no-op startup is unchanged; see the measurements below.
- **Worker cannot load:** if its file is missing or the runtime cannot start it, the client logs this and
  the open migrates on the main thread, as every earlier build did. In-memory and `file:` URI paths always
  migrate on their own connection.
- **Boot deadlines:** the OpenCode 1 hooks phase and the Pi runtime phase (`runBootPhaseWithDeadline`), and
  the OpenCode 2 storage probe (`probeV2StorageAtBoot`), no longer count time the worker spends migrating.
  Before, the synchronous migration kept the deadline timer from firing, so a long first-start upgrade
  still ended with tools registered. With the timer live, that outcome would have been lost. Sleeps
  between retries of another process's write lock still count, as they did before. A migration that never
  finishes now defers the deadline indefinitely, which matches the old synchronous behaviour, but the host
  stays responsive.
- **Synchronous `openDatabase` during an in-flight startup open of the same path** (tool registration after
  a timed-out hooks phase, an RPC status read) now returns null instead of opening a second connection.
  That second connection would migrate on the main thread, contend with the worker for the write lock, or
  read a partly migrated schema. Callers already treat null as "storage unavailable".
- **Hosts:**
  - OpenCode 1 and 2 and Pi all await an async plugin initialization, so no host keeps the old synchronous
    path.
  - Under Node, the worker ran the dist build: Pi's lane used Node 24.16, and a direct smoke test ran
    `plugin/dist`, `plugin/dist/v2` and `pi-plugin/dist` `migration-worker.js` under Node and Bun. OpenCode
    Desktop runs on Node too, but Desktop itself was not launched here.
  - The `magic-context` CLI (its `doctor` commands open and migrate context.db offline) keeps its
    synchronous open: it is a one-shot process with no server to keep alive.
- **Builds:** the plugin, OpenCode 2 and Pi builds emit `migration-worker.js` next to `embedding-worker.js`.

Tests added:

- `migration-worker.test.ts`. A startup open migrates a fresh database to the latest version with **zero
  migration bodies on the main thread**. A control shows that the counter does count the synchronous path.
  The file also covers: no worker for a current database, fail-closed on a worker failure, fallback when
  the worker cannot load, and refusal of a synchronous open during an in-flight startup open.
- Clock and deadline tests in `off-thread-migration-clock.test.ts`, `boot-deadline.test.ts` and
  `storage-gate.test.ts`.

## Part 1: v94 measured in parts

The specimen was a copy (`cp -c`) of `backups/b2-window-20260930T173909Z/pre/context.db`: 7,559,360,512
bytes, schema 91. Every run used its own fresh clone. The script times the same SQL as
`splitLkgSlotPrefixes` and `splitReplayDecisions`, step by step, inside one BEGIN IMMEDIATE transaction.

| Data in the specimen | Value |
| --- | ---: |
| LKG slots | 1,283 |
| LKG prefix characters, total / largest | 661,205,015 / 8,542,079 |
| Slots captured within 24 h of the newest capture (2026-09-30 17:38:58Z) | 293 (179,461,810 chars) |
| Oldest slot | 2026-09-23 17:44:36Z |
| `session_meta` rows / rows holding a replay document | 11,907 / 1,503 |
| Replay document characters, total / largest | 16,852,582 / 2,084,894 |
| Replay decision rows produced | 362,303 |

v94 keeps LKG slots captured in the last 24 hours and drops older ones. So what it does depends on when it
runs relative to the store's last use:

- **Stale store**, migrated "now": every slot is older than a day, so all 1,283 are deleted and none moved.
  This is the rehearsal's situation, and what a store unused for a day sees.
- **Active store**, migrated at the specimen's own time: 293 slots are moved and 990 deleted. This is what a
  user who restarts right after using 0.44.4 sees.

"Commit" includes SQLite's automatic WAL checkpoint, which copies the transaction's pages into the 7.5 GB
database file. In both the rehearsal and the hosts, that work happens inside the timed transaction.

| Run | LKG delete | LKG move (read / slice / write) | Drop old table | Replay split | Commit | v94 total | WAL after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Stale, both parts | 210 ms (1,283 rows) | none | <1 ms | 1,605 ms | 17,917 ms | **19,737 ms** | 50.9 MB |
| Stale, both parts, repeat under load* | 289 ms | none | <1 ms | 25,017 ms | 29,971 ms | **55,281 ms** | 50.9 MB |
| Stale, LKG part only | 1,105 ms | none | 3 ms | n/a | 2 ms | **1,117 ms** | 1.5 MB |
| Stale, replay part only | n/a | n/a | n/a | 1,110 ms | 5,555 ms | **6,668 ms** | 49.6 MB |
| Active, both parts | 201 ms (990 rows) | 674 ms (96 / 102 / 474), 293 slots, 2,935 chunks | 101 ms | 3,125 ms | 8,126 ms | **12,232 ms** | 236.6 MB |
| Active, LKG part only | 376 ms | 1,645 ms (217 / 128 / 1,293) | 54 ms | n/a | 7,701 ms | **9,778 ms** | 187.1 MB |

\* The repeat ran while a TypeScript build was running on the machine. An earlier run during the OpenCode
store's VACUUM took 33.3 s. The same work varied between 20 and 55 seconds depending on I/O conditions,
consistent with the rehearsal's 5.6 to 44.6 seconds. Initialization, v92 and v93 together took 30 to
253 ms in every run.

What this shows:

- **For a stale store, the replay split dominates.** The LKG part is a delete of whole rows: their
  overflow pages go to the freelist, and it costs about 1 s with a 1.5 MB WAL. The replay split writes
  362,303 rows and rewrites 1,503 `session_meta` records. That is about 50 MB of pages, and committing and
  checkpointing them costs seconds. The replay rows must be preserved exactly, so this part cannot be made
  cheaper by discarding.
- **For an active store, the LKG move dominates:** 9.8 s of 12.2 s. It writes 179 MB of chunks, and the
  187 MB checkpoint at commit is most of that time.

## Part 2: should v94 discard old LKG prefixes?

Discarding every pre-v94 prefix would make an active store's v94 about as cheap as the stale case's LKG
part: about 1 s instead of about 10 s on this specimen. These are all the LKG readers that can run on the
first pass after an upgrade, and what the user loses there without a slot:

- **TypeScript mode, ordinary passes (OpenCode 1, OpenCode 2, Pi):** nothing. The served m[0]/m[1] bytes
  come from the persisted injection cache, not from LKG. That is the `reason=cache_hit` path
  (`inject-compartments.ts` `transform-postprocess-phase.ts`). `getSlot` hydrating the slot from disk is
  what logs `lkg_hydrated_from_disk` (`lkg-slot.ts`), but on a successful pass the hydrated slot is not
  the byte source.
- **TypeScript mode, a failing first pass** (a transient SQLite busy error or a transform exception):
  - OpenCode 1 and 2: the shared wrapper (`messages-transform.ts`) replays the slot when one exists.
    Without one, the user gets the storage-busy refusal ("database is busy … send your message again") or
    the fail-closed error, where before they would have been served the previous good request.
  - Pi (`context-handler.ts`): without a slot, Pi serves the raw input only if it fits the model's limits,
    otherwise it refuses with `PiStorageBusyError`.
- **Rust mode:** the restart that applies v94 also restarts the module. While the module reopens its store,
  a session's passes replay the LKG slot (`rust-mode-transform.ts` `replayLastGood`, and the
  frozen-representation replay). Without a slot, those passes refuse with the reconnecting error until the
  module is back. The v94 comment names this as the reason it moves the last day's slots.
- In every lane, the next successful pass recaptures the slot, and a slot whose model, provider or input
  anchoring does not match is rejected anyway (`lkg-replay.ts`).

**Decision: v94 is unchanged.** Discarding would trade a first-start delay, which now leaves the host
responsive, for losing the replay fallback on exactly the passes where it matters most. It would also make
new upgraders' stores diverge from the fleet, where v94 has already run. If a 1 s v94 is still wanted, the
change is one line: delete every slot instead of keeping the last 24 hours. With the timings above, the
reviewer can weigh it.

### Served bytes for a resumed session across the upgrade

OpenCode 1 lane, same conversation. The published 0.44.4 build served the turn on v91. The upgraded build
then resumed it while migrating v91 → v94, and restarted. This sequence ran twice: once with the unfixed
build (migration on the main thread) and once with this change (worker). Each provider request body was
captured by the mock.

- After replacing the lane directory name and removing the `<ctx-search-hint>` blocks, all three phases'
  request bodies are **byte-identical** between the two builds, with equal length and SHA-256:
  - before: `4f1e513480c2d53b`, 46,103 bytes
  - upgrade: `3f3c368a30103c88`, 47,930 bytes
  - restart: `00cc3919cde09341`, 48,126 bytes
- The raw bodies differ only in that auto-search hint. The hint already differs in the before phase, where
  both lanes ran the identical published 0.44.4 build, so it is timing in the auto-search result, not the
  migration.
- With the worker, the upgraded turn resumed with `lkg_hydrated_from_disk` and `reason=cache_hit`: no
  rebuild. Its earlier messages equal the before turn's messages once Anthropic `cache_control` markers are
  removed (the breakpoint moves to the newest message). The system prompt and tool text change between
  0.44.4 and the candidate because they are different builds. Upgrade → restart: system and tools are
  identical byte for byte, and messages equal once `cache_control` is removed.

v94 is unchanged, so the comparison that matters is main-thread versus worker migration of the same v94
body, and it shows identical served bytes.

## Part 3 proof: rehearsal lanes rerun

Setup, the same way as the rehearsal:

- Raw host spawn, no `prepareContextDatabase`, mock provider (`V045_REHEARSAL_MOCK_ONLY`).
- A freshly built environment with throwaway `HOME`, `XDG_*`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`
  under `R = /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/v045-offthread`.
- Hosts `opencode-ai@1.18.31`, `@opencode/cli@2.0.15` and `@earendil-works/pi-coding-agent@0.99.2`,
  reinstalled under R. The rehearsal's host binaries had been removed by its cleanup.
- The published 0.44.4 packages from the rehearsal for the "before" phase.
- Every lane started from fresh APFS clones of the v91 specimen and of the scrubbed OpenCode store.
- "Before fix" means this branch's base commit `7fe33a4e8d`, exported with `git archive` and built under R.
  It ran in the same session as the fixed build, on the same specimen.

The OpenCode store copy came from the live `opencode.db` and its sidecars, copied with `cp -c` and never
opened in place. Before any host opened it:

- `PRAGMA foreign_keys=OFF`, so deleting credential rows could not cascade into other host tables.
- `credential`: 11 rows deleted. `account`, `account_state` and `control_account`: 0 rows. All four tables
  are 0 afterwards.
- Committed, journal mode DELETE, then **VACUUM**. Scrub plus VACUUM took 966.1 s; the result is
  36,023,832,576 bytes.

### OpenCode 2.0.15 (published 0.44.4 → upgraded build → restart)

| Build | Phase | v94 transaction | Spawn to active plugin | `/health` probes failed | Longest gap | Turn |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Fixed (worker) | upgrade v91→v94 | 10,129.5 ms, on the worker | 11.039 s | **0 / 50** | **0.895 s** | mock marker, 2 mock requests |
| Fixed | restart v94 | none applied | 1.796 s | 0 / 13 | 0.837 s | mock marker |
| Unfixed (main thread) | upgrade v91→v94 | 18,381.6 ms | 19.384 s | **70 / 81** | **18.678 s** | mock marker, 2 mock requests |
| Unfixed | restart v94 | none applied | 0.671 s | 0 / 7 | 0.270 s | mock marker |

In the fixed lane, the 0.895 s gap fell at 10.9 to 11.8 s, after the migration had committed (log
02:12:40.390). It was during plugin activation and the driver's synchronous `lsof` audit, which delays the
driver's own probes. The published-0.44.4 before phase, with nothing to migrate, showed 0/12 failed in the
fixed lane but 8/30 failed (a 2.9 s gap) in the unfixed lane. That is host start-up on a 36 GB store with
the old plugin, not a migration.

### OpenCode 1.18.31 (published 0.44.4 → upgraded build → restart, same conversation)

| Build | Phase | v94 transaction | Boot phases | Spawn to tools | `/health` probes failed | Longest gap | Turn |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| Fixed (worker) | upgrade | 8,397.4 ms, on the worker | migrate=8476 total=10574 deadline_phase=none | 11.565 s | **0 / 50** | **0.315 s** | HTTP 200, 1 mock request, LKG hydrated, `cache_hit` |
| Fixed | restart | none applied | migrate=19 total=2043 | 2.709 s | 0 / 16 | 0.411 s | HTTP 200 |
| Unfixed (main thread) | upgrade | 10,714.0 ms | migrate=10771 total=12862 | 13.838 s | **39 / 63** | **11.109 s** | HTTP 200, 1 mock request, `cache_hit` |
| Unfixed | restart | none applied | migrate=26 total=2071 | 3.441 s | 0 / 18 | 0.417 s | HTTP 200 |

The published-0.44.4 before phases, with no migration, showed 9/60 and 4/47 failed probes, and gaps of
3.2 s and 2.1 s after tool readiness, while the old plugin served its first turn. The old build is outside
this change.

### Pi 0.99.2 under Node 24.16 (RPC host, no `/health`)

| Build | Phase | v94 transaction | Plugin entering → loaded | Driver wall | Turn |
| --- | --- | ---: | ---: | ---: | --- |
| Fixed (worker) | upgrade | 12,576.3 ms, on the worker | 12.77 s | 14.272 s | mock marker, `agent_end`, 1 request, stderr empty |
| Fixed | restart | none applied | n/a | 2.346 s | mock marker |
| Unfixed | upgrade | 12,043.0 ms | 12.18 s | 13.769 s | mock marker |
| Unfixed | restart | none applied | n/a | 2.371 s | mock marker |

Pi awaits its async extension factory either way, so time to load is the same. With the worker, Pi's main
thread is free during that wait.

### Before / after summary

| Lane | Rehearsal report (main thread) | Base `7fe33a4e8d`, rerun here (main thread) | This change, rerun here (worker) |
| --- | --- | --- | --- |
| OpenCode 1 longest `/health` gap during upgrade | 46.148 s (cold), 5.777 s | 11.109 s, 39/63 failed | **0.315 s, 0/50 failed** |
| OpenCode 2 longest `/health` gap during upgrade | 6.624 s, 22/33 failed | 18.678 s, 70/81 failed | **0.895 s, 0/50 failed** |
| Pi plugin load during upgrade | 9.475 s | 12.18 s | 12.77 s (main thread free) |

The rehearsal's slowest run (OpenCode 1, v94 held 44.6 s on a cold file cache) was not reproduced. On every lane here, the migration finished
inside the 15 s budget, so the deadline-deferral path was exercised by unit tests, not by a host.

### Second start and the no-op path

- Every restart applied no schema migration versions.
- `openDatabaseAsync` on a v94 copy, 15 interleaved processes per build: median **22.3 ms unfixed vs
  22.9 ms fixed** (p90 24.2 vs 23.7). The migrate phase was 18.7 vs 19.0 ms, and the fixed build started
  no worker. No-op startup did not get slower.

### Open-file audit

Every host was audited with `lsof -p <pid> -Fn` at handoff or startup, and again at readiness or after the
turn. The driver rejects any `.db`, `-wal`, `-shm` or `-journal` path outside the throwaway root R defined
above; no lane recorded an error.
Each OpenCode audit listed only `R/<lane>/data/opencode/opencode.db{,-wal,-shm}` and
`R/<lane>/data/cortexkit/magic-context/context.db{,-wal,-shm}`. Each Pi audit listed only the lane's
`context.db{,-wal,-shm}`.

## Rust arm: offline doctor on a 0.44.4-shaped copy

On a fresh clone of the v91 specimen, `ALTER TABLE memories DROP COLUMN content_version` was run (3.9 s).
A development build had added that column to the fleet store the specimen came from; a real 0.44.4 store
does not have it, and the doctor's schema fingerprint check refuses a store that does (the rehearsal's
Rust arm stopped there). The doctor then ran under the
production Node runtime (24.16), with a throwaway environment and a `ck-mc` built from this tree
(`cargo build --release -p mc-module`):

```sh
node packages/cli/dist/index.js doctor single-store migrate --ck-mc "$R/cargo-target/release/ck-mc" --backup-root "$A/backups"
```

| Run | Wall | Context migrations | Result |
| --- | ---: | --- | --- |
| Without `--skip-foreign` | **87.5 s** | v92 3 ms, v93 <1 ms, v94 **6,088.9 ms** (CLI, synchronous) | Exit **2**: backup written (context copy 50.5 s + check 14.3 s; store 12.0 s + 2.3 s), then `single_store_foreign_context: 2 project(s) are owned under another context.db (dir:982da5a779a6, git:9ca367d64dd098fdc77a30765c0e9d37759efd17); their store rows can only stay in the backup. Re-run with --skip-foreign to leave them behind` |
| Same copy, `--skip-foreign` added | **58.7 s** | none (already v94) | Exit **0**: backup 41.5 s; read/classify 0.1 s, copy 2.2 s, cache reset 0.5 s, verify 0.2 s; render check sampled 325, passed 325; 1,371 sessions reset; store.db 1,134,546,944 → 914,710,528 bytes; context.db v94, `quick_check=ok` |

With the column dropped, the fingerprint refusal no longer occurs. The remaining refusal
comes from this fleet store holding projects owned by another context.db, which an ordinary single-store
user would not have. No Rust host was started.

## Cleanup

The large clones under the throwaway root R were removed after the measurements. Drivers, logs, captured request bodies and
`results.json` files remain under R for review. Only source, tests, build scripts and this report are
committed.
