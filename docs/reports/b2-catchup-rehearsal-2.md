# B2 catch-up with master and second real-store rehearsal

## Result

`integration/b2-offline` now contains master v0.44.4 (160 commits). Every code gate passes on the final tip. That includes all 54 Rust E2E files and `opencode2/rust-mode-fold-cadence`, which failed until the OpenCode 2 boundary fix described in "Follow-up: OpenCode 2 partial-end boundaries". The full drill passed on fresh scrubbed copies of today's live stores:

- migrate with its lsof refusal, backup and undo printout, and 362/362 identical render samples;
- an OpenCode 1.18.30 drive on the migrated copy;
- TS↔Rust switching;
- MC-C14 refusal on the unmigrated store;
- Pi 0.87.1 on the migrated copy;
- the undo drill with remigration.

On the migrated copy, ALF's session shows its full history: **1,754** compartments.

**One action for the migration window.** The live `context.db` still carries the development-build column `memories.content_version`, as it did in the first rehearsal. The migration refuses until it is dropped:

- Quit every Magic Context process first.
- Then run: `sqlite3 ~/.local/share/cortexkit/magic-context/context.db 'ALTER TABLE memories DROP COLUMN content_version;'`
- The engine prints this exact command itself.
- Then rerun with `--skip-foreign`, which the same two foreign projects need.

- Branch: `alfonso/task/bg_b1e3722adb34a09d-b2-merge-160-master-commits-into-integration-b2-` (worktree `pool-1178`), based on `integration/b2-offline` at `cd6b03ba`.
- Master endpoint merged: `a2d189f0d8` (release v0.44.4).
- Evidence root `R` = `$TMPDIR/magic-context/b2-catchup` (macOS resolves it under `/private/var/folders/...`). Logs are kept in `R/logs`. Every database copy was deleted after its step, per the disk constraint.
- There was no push and no deploy. `ARCHITECTURE.md` and `STRUCTURE.md` are unchanged.

## Migration numbering

- Master's `context.db` fence is still **91**, and master added no context migration since the merge base (`f955875500`), so B2's **92** stays contiguous.
- Master added no `store.db` migration either. After migration the store reports `mc_cache` **61**; unmigrated copies report **60**.

## Conflict resolutions

The Rust module (`crates/`) merged without textual conflicts. Master's crate changes there (the subc-protocol 0.27.0 route `scope`, #577 calibration, #581 answer protection, the Astra performance work and the launch nonce) apply on top of B2's context.db runtime unchanged. The 14 conflicted files were all TypeScript, JSON or tests:

1. **`packages/cli/src/commands/doctor-authority.ts`** (deleted in B2, edited on master). Kept the deletion. Master's edit only threaded `allow_home_project` through the authority commands, which B2 removed.
2. **`doctor-repair-db.ts` `defaultInspectHolders`**. Kept B2's injectable holder dependencies and its rule for non-default stores (named target-file holders, or Pi processes that reference the path). Added master's changes:
   - one Windows process snapshot shared by the RPC and Pi checks;
   - the 15 s RPC-discovery deadline with its progress line;
   - refusing on an inconclusive RPC liveness result.
   An injected `inspectPi` still wins over the snapshot, so the tests keep control.
3. **`compartment-storage.ts`** (five replace paths). Each one now keeps B2's `recomp_boundary_change` m0 mutation, plus master's chunk-embedding back-off delete and auto-embed re-arm (issues 564/565).
4. **`module-state-sync.ts`**. Kept B2's deletion of the compartment mirror. Master had added an auto-embed re-arm inside that mirror resync. On B2 the module writes compartments straight into `context.db`, so the TS writers never see them. The re-arm therefore moved into the Rust-mode pass (next item).
5. **`rust-mode-transform.ts`**.
   - Kept B2's background single-store embedding drain instead of master's mirror pulls, and wrapped it in master's `withSqliteBackgroundWriter`.
   - Added the re-arm: when the transform response's `row_version`, `boundary_id` or `coverage_ordinal` changes, a background query compares the session's compartment `max_sequence` and count, and re-arms the auto-embed latch if they moved.
   - The first version queried on every pass. That broke master's performance guard `skips acknowledged state watermark reads until an observed input changes` (the only red test in the first full plugin run). It was fixed in `b43c4f5f84`, with a new test: `re-arms auto-embed when the module publishes compartments into context.db`.
6. **`rpc-handlers.ts`**. B2 had left an unused `resolveProjectIdentity(directory)` in the Rust status path. Master guards the same call against the home directory (issue 570). The dead lookup was removed rather than guarded, since it could only throw.
7. **`v2/hooks/storage-gate.ts` and its test.** Both sides restore a 5000 ms busy timeout after the non-blocking boot open. Kept B2's named constant and B2's copy of the duplicated test.
8. **`dreamer/map-memories.test.ts` and `dreamer/verify.test.ts`**. Kept B2's module-applier tests and master's token-budget tests side by side.
9. **`e2e-tests/tests/opencode2/storage-busy.test.ts`**. Kept B2's wait for the actual provider capture (plus its `<session-history>` assertion) and master's timing and diagnostic logging.
10. **`e2e-tests/tests/rust-classify-producer.test.ts`**. Kept B2's shared-context seeding without the authority lane, with master's `.immediate()` write transaction and busy timeout.
11. **`e2e-tests/mode-manifest.json` and `validate-mode-manifest.test.ts`**. Master's entries were added. The `dreamer-verify-slice-authority` entry was dropped because B2 deleted that test. Counts were recomputed from the validator: **141** files, **46** TS, **54** Rust.
12. **`Cargo.lock`** (`06de35a8cf`). The merge kept B2's older sibling subc versions, so `cargo --locked` refused. The lock was reconciled to master's and the sibling checkout's versions:
    - `subc-client-rs` 0.23.3;
    - `subc-control` 0.25.0;
    - `subc-core` 0.20.46;
    - `subc-daemon` 0.26.0.
    It now differs from master's lock only by B2's removed `mc-module` dependencies.

## Gates on the merged tip

| Gate | Result |
|---|---|
| `bun install --frozen-lockfile` | no changes |
| `bun run typecheck` (plugin, Pi, CLI, retina) | pass |
| `bun run lint` | pass (existing warnings only) |
| Plugin full suite | first run 5980 pass / 1 fail: the watermark guard above. After the fix, that file passes 140/140, and the full rerun on the final code passes **5982 pass, 0 fail**. |
| Pi full suite | 1361 pass, 0 fail |
| CLI full suite | 534 pass, 2 fail: both hit timeouts at load averages of 40–60 (`host process probe … real process` at 5 s, `collectDiagnostics Pi path resolution` at 88 s). Both files pass alone (19/19). |
| retina-local-fs | 23 pass |
| `cargo fmt --check` | pass |
| `cargo clippy -j 4 --locked --workspace --all-targets -- -D warnings` | pass |
| `cargo test -j 4 --locked --workspace` | 1652 passed, 0 failed, 18 ignored |
| `bun run build:dists`, CLI build, `bun test scripts/built-context-fence.test.ts` | pass. Plugin, Pi and CLI chunks each carry `LATEST_SUPPORTED_VERSION = 92`. |
| Rust hermetic E2E (manifest Rust lane, serial, one fresh-process retry) | Before the boundary fix: 53 of 54 (fold-cadence failed). **After the fix: 54 of 54, none on retry**, run in four foreground chunks (`rust-e2e-final-results.txt`). |

## Rehearsal drill

The earlier drivers were never committed. They lived in a reclaimed worktree's `target/` and an evidence root under `$TMPDIR`, both gone. The procedure was rebuilt from the first report and committed under `scripts/b2-drill/`:

| Driver | Step |
|---|---|
| `copy-and-scrub.py` | read-only live copy |
| `subset-opencode.py` | OpenCode session subset |
| `migrate-drill.sh` | lsof refusal, migrate, idempotent rerun |
| `host-drill.ts` | OpenCode drive and MC-C14 refusal |
| `pi-drill.ts` | Pi on the migrated copy |
| `alf-spot-check.ts` | dashboard and ctx_expand spot check |

### Live-store copy

Each live file was opened once, with `file:…?mode=ro` and `PRAGMA query_only=ON`, and copied with SQLite's backup API. Nothing else ever opened a live path.

- **Single-step backup.** A first attempt used a stepped backup. It kept restarting because the live `context.db` is written continuously; after 12 minutes it had copied 1.6 GB. It was killed, its partial copy deleted, and the step rerun as a single-step backup: one read transaction, which does not block WAL writers.
  - `context.db`: 7,559,360,512 bytes, 75.2 s, `quick_check` ok.
  - `store.db`: 1,120,432,128 bytes, 8.9 s, ok.
- **OpenCode subset instead of a full VACUUM.** The full `opencode.db` copy (34.3 GB) had its credential tables emptied. Its VACUUM then drove free disk from 76 GB to 31 GB, falling about 2 GB a minute, so it was aborted before crossing the 20 GB floor. The migration engine never reads `opencode.db`; the host drives create their own sessions, and only ALF's spot check needs real raw history. So `subset-opencode.py` wrote a fresh database, row by row, holding:
  - every non-session table;
  - ALF's session: 121,864 messages, 400,299 parts and 368,713 events;
  - empty `credential`, `account`, `account_state` and `control_account` tables.
  It came to 2.2 GB, and `quick_check` was ok. Writing it row by row means no deleted credential row can survive in free pages. The full copy was deleted right after.

The spot-check baseline, read from the copies before migration:

- ALF's session had **1,469** compartments in `context.db` (max sequence 1468) and **1,754** in `store.db` (max sequence 1753).
- `context.db` was at v91; `store.db` at `mc_cache` 60.

### `doctor single-store migrate`

The built CLI ran under Node with `--ck-mc target/release/ck-mc`. `HOME`, every `XDG_*`, `TMPDIR` and `MAGIC_CONTEXT_STORAGE_DIR` pointed into `R/migrate`, and the databases there were APFS clones of the snapshot.

1. **Fingerprint refusal.** The first run refused with `single_store_fingerprint_mismatch`: `memories` had the unknown column `content_version` on all 18,341 rows. As in the first rehearsal, the column was dropped **on the copy only**, using the command the engine printed.
2. **Foreign-project refusal.** The next run refused with `single_store_foreign_context`: 2 projects (`dir:982da5a779a6` and `git:9ca367d64dd098fdc77a30765c0e9d37759efd17`, the same as last time) are owned under another `context.db`. Log: `migrate-drill-unflagged-refusal.log`.
3. **lsof refusal.** With `--skip-foreign`, a helper process held the copied `context.db` open, and migrate refused with exit 2:

   ```text
   single_store_files_in_use: database holder (PID 83807)
   quit OpenCode, Pi and ck-mc (`ck stop magic-context`) and run again
   ```

4. **Migration.** It completed in 169 s wall time.
   - Backup: `context.db` copy 63.8 s plus check/hash 14.6 s; `store.db` copy 10.5 s plus 2.2 s.
   - Transaction **11,632 ms**; VACUUM **11,563 ms**.
   - Normalized compartment boundaries: 0. Mappings left only in the backup because their memory no longer exists: **1,399**.
   - **Render check: sampled 362, passed 362**, seed `1790773578484`.
   - Sessions reset: 1,363.
   - `store.db` size: 1,120,432,128 → 901,439,488 bytes.
   - Afterwards: context **92**, store `mc_cache` **61**, and ALF has **1,754** compartments in `context.db` (max sequence 1753).
   - The backup path and the undo commands (`rm -f` of both databases' WAL and SHM files, then `cp` of the backup pair) were printed before the engine ran and again afterwards.
5. **Idempotency.** A rerun printed `already migrated at 1790773578484 by unstamped-0.1.0; backup …` without calling the engine.

Log: `migrate-drill.log`.

### ALF's session on the migrated copy (`alf-spot-check.log`)

- **Dashboard reader.** `get_compartments`' SQL, run verbatim from `packages/dashboard/src-tauri/src/db.rs` against the migrated copy, returns **1,754** rows. Sequences run contiguously from 0 to 1753. This ran the SQL, not the Tauri binary.
- **ctx_expand.** The plugin's real `ctx_expand`, run in-process for `ses_227ce5788ffeRPA9THoPLOQreO` against the migrated `context.db` and the subset `opencode.db`, returns the original messages for:
  - the oldest compartment (1–124: 124 messages);
  - a middle one (sequence 877, 55162–55170);
  - the newest (sequence 1753, 121549–121610: 62 messages).
  Before migration the newest `context.db` compartment was sequence 1468, so a range past it would have been clamped as live tail.

### Live OpenCode 1.18.30 drive on the migrated copy (`host-drive.log`)

This used a real `opencode serve` (1.18.30), the mock provider, the hermetic subc daemon, and the `ck-mc` built by the E2E lane from this tree, all on clones of the migrated pair plus the subset `opencode.db`. The session was `ses_f0d8acc59ffeLoft6bxZ3ExahE`.

- **First render.** `HARD/first_render`, then three `SOFT+/none` defers.
- **Memory.** `ctx_memory` wrote memory 21751, updated it and archived it through the real tools. Its `context.db` row ends `archived` with the updated text.
- **Notes and search.** `ctx_note` wrote note #3565 and read it back, and `ctx_search` found it (`[note] … id=#3565`).
- **Historian fold.** Under pressure, 7 historian compartments landed in `context.db` with raw message IDs and block indices, and the served head carries `<session-history>`.
- **ctx_expand.** Expanding 1–26, the first folded range, returned the 26 original messages.
- **Restarts.** After the history settled, both a module restart and a host restart served a head byte-identical to the one before.
- **Rust → TS → Rust.** TS served the shared history, with a byte-identical TS defer. Back in Rust, the passes were `SOFT/coverage_fold` then `SOFT+/none`.
- **Isolation.** lsof audits ran at the first render, after the fold, after the restarts, in TS mode and back in Rust. Every database handle held by the host and module processes was inside the drill root.

The first two drive attempts failed on driver bugs, not product failures:

- The drill note's marker was in its body, but `ctx_note read` lists titles.
- The restart comparison ran while folds were still landing.

Both drivers were fixed, and the third run passed on a fresh clone.

### MC-C14 on an unmigrated store (`host-refusal.log`)

This ran on clones of the store restored by the undo drill (context 92 with migration required, store 60). In Rust mode, the host session showed the error below as the assistant message's error, not only in a log:

```text
Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)
```

After restarting in TS mode, a new session on the same store was served normally.

### Pi 0.87.1 on the migrated copy (`pi-drive.log`)

`MC_E2E_PI_VERSION=0.87.1` resolved `@earendil-works/pi-coding-agent@0.87.1`.

- Two turns completed, and Magic Context was active in the requests.
- Every database Pi held open was inside the root.
- The copied store carries 14,300 historical `subagent_invocations` rows from real sessions. They were removed from the Pi copy only, as in the first rehearsal, so that the harness's off-mock guard judges this run's calls. Without that step the guard fails on old rows. The turns themselves had already passed.

### Undo drill and remigration (`remigrate.log`)

1. The printed undo commands (`undo-commands.sh`) were executed verbatim on the migrated copy.
2. Both restored files hash identical to the backup.
3. The restored state was context 92, store `mc_cache` 60, and ALF back to 1,469 `context.db` compartments. This matches the first rehearsal's recorded restore state.
4. The MC-C14 drive above ran on this restored state.
5. Remigration passed:
   - render check **361/361**, seed `1790774975183`;
   - transaction 3,072 ms, VACUUM 5,880 ms;
   - store `mc_cache` 61, ALF 1,754.
6. The next invocation printed `already migrated`.

## What changed since the first rehearsal

- **The drivers are now committed**, together with the live-copy step. The stepped backup the copy step first used cannot finish on a busy live store; it now copies in a single step.
- **OpenCode copy.** The full 34 GB VACUUM no longer fits the disk. The drill now uses a scrubbed subset (ALF's session). This is safe for the gate because the migration engine does not read `opencode.db`.
- **More render samples.** 362/362 (and 361/361 on remigration), against 327–328 before, because the live stores have grown.
- **The same live-store facts** apply: the `memories.content_version` column, the two foreign projects, 1,399 orphan mappings, and 1,363 cache sessions reset (1,294 before).
- **Backup timings** under a heavily loaded machine: `context.db` 63.8 s against 49.4 s before; transaction 11.6 s and VACUUM 11.6 s on the first run, 3.1 s and 5.9 s on the remigration.
- **New behaviour carried over from master.** Auto-embedding is re-armed when the Rust module publishes compartments. See conflict resolution 5.

## Follow-up: OpenCode 2 partial-end boundaries

The owner chose to record the boundary at partial ends and to cap the trim on coverage (commit `afcc1adf54`).

**Why it failed.** The partial-end guard from `6d6b2bff94` stopped OpenCode 2 Rust mode from trimming after the first fold, in two places:

- `applyDeferred` refused any fold that ended partway through a message.
- `trimToRecordedBoundary` capped the cut at the earliest compartment that ever had an `end_block_index`.

**What the block indices mean.** `historian_chunk.rs:527-547` builds each chunk line from all blocks of its host message, and `last_block_id` anchors the line at the message's **last** block. So both indices on a published row are last-block anchors.

`scripts/b2-drill/fold-anchor-probe.ts` shows this on a real hermetic fold (`fold-anchor-probe.log`): each of the 8 rows ends at the end message's last block (`end_block_index 1`, 2 module blocks). Each successor starts at `end_message + 1`, with the start message's own last-block anchor (`#0`, 1 block). This also explains the earlier drive rows: seq1 ended at 27#0 because message 27 has one block, and seq2 started at 28#1 because message 28 has two, anchored at its last. That was no gap, and the ordinal validator (`historian_validate.rs:1023-1084`) rejects skipped messages.

**Change.**

- `applyDeferred` resolves the boundary from the partial message itself, as the nearest user turn at or before it. The cut lands after the last whole turn, and the partial message stays in the array raw.
- `trimToRecordedBoundary` caps the cut at the earliest indexed end whose remainder is **not** covered, using one indexed self-join. The next compartment covers the remainder when it continues on the same message at a later block, or on the next message ordinal. Exact `end+1` / `0` start indices cannot be required, because starts are last-block anchors.
- The latest compartment (no successor) and any end followed by a gap stay protected.
- The OpenCode 1 and Pi marker paths are untouched.

**Proof.**

- Unit tests pass:
  - a partial published end records the preceding user turn, and the trim keeps the partial message;
  - a same-message continuation is trimmable;
  - a last-block end followed by the next message is trimmable;
  - a gap stays protected, with the uncovered blocks still in the array;
  - the existing "retains its uncovered blocks" test passes unchanged.
- Mutations:
  - restoring the stale-skip reddens the four new tests;
  - treating any successor as covering reddens the gap test and the existing retain test;
  - restoring the earliest-partial cap reddens the two trimmable tests.
- `opencode2/rust-mode-fold-cadence` passes 3/3 (final oc_input 15 against 29 untrimmed).
- `pure-replay-differential --ts-only` is IDENTICAL on all four defers against both `cd6b03ba` and master.
- The OpenCode 1 compaction-marker, prefix-trim replay and shared-boundary tests (30) and Pi `inject-compartments-pi` (66) pass. The fix does not touch them.

**Lock.** The sibling `subconscious` moved to subc-core 0.20.47. The lock was bumped (`887bb40d24`), and `cargo build --locked --release -p mc-module` passes.

**Final plugin suite.** 5983 pass, 3 fail. The three failures are storage-boot tests on the default store: `createV2StorageGate … busy timeout`, `explicit shared storage resolution … finite boot busy timeout`, and `initializeDatabase legacy index ordering … shared OpenCode and Pi boot paths`. Each timed out at 30 s. The same tests passed in the full run an hour earlier (5982/0).

Alone, those three files fail the same way (plus an async boot-timing test) on the final tip, on an exported tree of the pre-fix tip `d81f296f7b`, and on master. The machine was then running about 859 processes at load 22–35, and these opens inspect live processes. This is environmental, not caused by the branch. Typecheck and lint pass.

## Rust E2E notes (before the boundary fix)

The lane was run serially with the runner's per-file command and one fresh-process retry. The tool's background timeout killed the first run after 25 files; the remaining files ran through the same command (`rust-e2e.log`, `rust-e2e-resume.log`, `rust-e2e-results.txt`).

**`tests/opencode2/rust-mode-fold-cadence.test.ts` fails deterministically on the merged tip.**

- It failed twice in the lane and again alone at load average ~13, with `the historian never produced a module boundary`.
- The same test on an exported master tree passes 2/2 (`fold-cadence-master.log`).
- B2's pre-merge tip `cd6b03ba` can no longer be built against today's sibling `subconscious` (subc-protocol 0.27.0), so it could not be run as a direct baseline.

What the plugin log shows:

- Folds do happen: `SOFT/coverage_fold` passes, `historian_complete`, and `rust fold published compartments through ordinal N`.
- But `rust input coverage: … marker_at=none` never changes, and `v2 boundary trim` never fires. Master's log has eight trims.

The cause is B2's partial-end guard. `hasPartialCompartmentEndThrough` in `createV2RustCompactionMarkerStrategy.applyDeferred` (`packages/plugin/src/v2/fold/boundary.ts`) returns `stale-skip` (`partial-message-boundary`) whenever a published compartment ends partway through a message. Module folds routinely end partway through a message (block indices), so on OpenCode 2 no boundary is recorded, `trimToRecordedBoundary` never trims, and the module keeps receiving the whole history.

The guard landed in `6d6b2bff94` ("fence cached boundaries and protect partial host suffixes"), after the first rehearsal's report (`6412fc0805`) recorded this test passing. So this is a pre-existing B2 regression, not a merge resolution.

This is a design decision for the owner. Options:

1. Record the OpenCode 2 boundary at the nearest user message at or before the partial message, so the partial message stays in the array (it is kept, never trimmed).
2. Keep the guard, and accept that Rust mode on OpenCode 2 does not trim after folds.

OpenCode 1 (the live host) and Pi are unaffected, and so is TS mode on OpenCode 2.

## Reproduction

The drill must run only against the copies this procedure creates. `R` is the evidence root under `$TMPDIR/magic-context/`, and `B` is the E2E build's release directory (`packages/e2e-tests/.cache/rust-e2e-cargo-target/release`).

1. **Copy.** `python3 scripts/b2-drill/copy-and-scrub.py "$R"`. If the disk cannot hold a VACUUMed OpenCode copy, run `python3 scripts/b2-drill/subset-opencode.py <full-copy> <subset> <session…>` and delete the full copy.
2. **Migrate.** `MIGRATE_EXTRA_ARGS=--skip-foreign CK_MC=$PWD/target/release/ck-mc bash scripts/b2-drill/migrate-drill.sh "$R" migrate`
3. **Host roots.** Clone the migrated pair and the OpenCode subset into a host root under `R` with `cp -c`.
4. **OpenCode drive.** Run `bun scripts/b2-drill/host-drill.ts drive <root>` with:
   - `HOME=<root>/home`;
   - `MC_E2E_CK_MC_PREBUILT_BIN=$B/ck-mc` and `MC_E2E_CK_SUBC_BIN=$B/ck-subc`.
5. **Pi.** `TMPDIR=<root>/tmp MC_E2E_PI_VERSION=0.87.1 bun scripts/b2-drill/pi-drill.ts <root>`
6. **Spot check.** `bun scripts/b2-drill/alf-spot-check.ts <root>`
7. **Undo.** Run the printed undo commands. Then run `bun scripts/b2-drill/host-drill.ts refusal <root>` on a clone of the restored pair, and remigrate.
