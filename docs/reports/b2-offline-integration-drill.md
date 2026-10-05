# B2 offline integration and real-store drill

## Review boundary and status

**Result: ready for integration review; the required gates and final real-copy drill passed.**

The integration target is **frozen master `b8fada367a`**, by explicit parent decision. The remote originally resolved to `a7ebcf3e4b`; it advanced while the first drill was running. Both merges are on this task branch; later master movement is deliberately out of scope.

The canonical-boundary implementation is committed in `c403790a83`, with warm-reconnect and hermetic-fixture follow-up in `692f69f5e3`. The final gate ledger below distinguishes initial failures, corrections, and successful reruns.

- Task branch: `alfonso/task/bg_95408fedc70a962b-b2-offline-merge-master-into-integration-full-ga`.
- Worktree: `/Users/ufukaltinok/.local/share/cortexkit/alfonso/worktrees/8f93aad09f2535d0/bg_95408fedc70a962b`.
- Evidence root (`R` below): `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_95408fedc70a962b`. macOS `lsof` resolves this to `/private/var/folders/...`.
- No push to master or integration, no GitHub posts, and no manual changes to `ARCHITECTURE.md` or `STRUCTURE.md`.

## Merge decisions

1. Kept B2's deletion of the mirror, authority handoff/recovery and separate memory-ID lanes. Kept context v92 and store migration 61: frozen master still has context v91/store60, so neither number collided. The populated-v91 step-through remains a gate.
2. Carried the Windows hidden-spawn protection into the relocated shared-ID mapping tests and the new doctor subprocess. Also added the missing flag to frozen master's offline hidden-child `lsof` probe. The global hidden-spawn assertion passes.
3. Master's mirror-tool reply-budget regression has no equivalent wait after B2: facade writes return the shared context ID directly, without targeted mirror acknowledgement or background mirror draining. The deleted mirror-only test was not resurrected.
4. Master's resolved-session-directory authority-route test was translated into a shared-store route test. It checks that requests and persisted session identity use the resolved session directory, not the plugin launch directory.
5. **Foreground-only SQLite retries:** `packages/plugin/src/shared/sqlite.ts` was retained exactly from frozen master, including AsyncLocalStorage leases. The deleted background mirror pull had been explicitly detached from that lease. B2's remaining embedding-watermark drain now uses `withoutSqliteTransformPass` too. A real acquisition-count test proves that this drain gets one attempt, not the foreground retry loop; neutralizing the wrapper reddens that test. The additional real OpenCode2 lock gate found that its asynchronous opener left the connection at the boot-only 0 ms timeout. The storage gate now restores 5000 ms after readiness, without changing lease scope or retry counts. A red-first real-handle PRAGMA test and the real 7 s lock test prove the correction; blocked boot still serves HTTP, and background contention still spends only one timeout.
6. Deleted TS authority recovery no longer needs master's background retry exclusion: switching renderers does not transfer ownership of domain tables. No recovery/drain API or second domain store was reintroduced.
7. Kept master's storage-busy fail-closed/LKG changes, bootstrap responsiveness, carrier-planning fix, and Rust allocation/performance work. The remaining state-sync sequence-mismatch test now expects the deliberate fail-closed error rather than raw continuation. The new tag-allocation fixture installs a context domain; its allocation ceilings were not relaxed.
8. Reconciled `Cargo.lock` separately twice: first client 0.22.0/core 0.20.41, then client 0.22.1 when the sibling graph advanced. The frozen-master endpoint did not move again.
9. Removed manifest entries for three tests B2 deleted, and registered the two frozen-master OpenCode2 storage tests that had not been added to the manifest. Restored the manifest's exact file/count assertions.

## Boundary-format finding and approved correction

The real compatibility problem was not merely an outdated test. TS compartments used raw host IDs; module rows used `<mid>#<index>`. After deletion of compartment replication, a cold Rust adoption could no longer rely on the old TS serializer to repair/flatten boundaries. TS's ordinary trim lookup, conversely, matched raw IDs and did not understand module flat IDs.

The parent explicitly approved extending **unshipped v92**, not allocating v93:

- Shared `compartments` now stores raw IDs plus nullable `start_block_index`/`end_block_index`.
- NULL means whole-message coverage. Rust publication and offline migration split flat IDs; Rust reads reconstruct private flat coordinates.
- Recompaction staging carries the same columns, so retaining an existing partial compartment cannot erase its indices. Same-host TS clones and Rust lineage copies preserve them.
- Cold TS-to-Rust adoption sends only resolved boundary/date metadata, not domain rows. The module guards the cache with the original raw IDs, indices and ordinals, persists it in existing session metadata, and never rewrites the shared rows to resolve a read.
- Missing boundaries heal from contiguous neighbours/first raw ordinal. Unprovable ranges fail visibly as `context_compartment_boundary_unresolved`, without LKG replay or parking.
- TS keeps an indexed end message raw; source-order and direct-ID trims both do so. Whole-message native markers cannot advance over that boundary. Pi conservatively retains the prefix rather than letting split-tool orphan cleanup remove an uncovered result.
- `ctx_expand` uses ordinal ranges and can safely return whole boundary messages. Dates resolve through raw IDs. Dashboard readers display summaries/ranges and do not authorize trimming. Cross-host OpenCode-to-Pi conversion refuses indexed boundaries before staging/journal claims; its existing entry mapper cannot preserve partial-block semantics. TS recompaction to whole-message boundaries is the recovery path.

The raw-ID/dangling-start hermetic fixture was retained, and its **original clean served-byte golden** was retained. The architecture design was updated in `docs/architecture/single-store-b2-offline.md`.

## Live-store isolation and snapshot handling

The only live-store access was one read-only SQLite backup pass over the three requested sources. Each source was opened with a `file:...?...mode=ro` URI and `PRAGMA query_only=ON`; Python's SQLite backup API copied the consistent database including committed WAL state. All later opens, schema edits, doctor runs and hosts used copies.

The copied OpenCode credential tables `credential`, `account`, `account_state`, and `control_account` were emptied and committed. VACUUM on that roughly 30 GB copy exceeded the first command's wall-time cap; only the copy was reopened to complete VACUUM. All four counts were zero, and that completion took **2495.47 s**. No second live backup/read was performed. Initial per-copy wall times were lost when the first command timed out; they are not inferred from file timestamps.

The extra `memories.content_version` column was dropped **only on a copied context.db**. A sidecar-free WAL backup could not initially be queried read-only by Bun; the copied store was put in DELETE journal mode before doctor. The engine restores WAL. Node 22.23.1 was used for the built CLI, matching its shebang. Running the CLI with Bun exposed retained SQLite handles after `closeDatabase()`, causing the later journal-mode switch to fail with `database is locked`; this is recorded, not claimed to be fixed.

Every host environment overrides `HOME`, `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `XDG_CACHE_HOME`, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` into task scratch roots. Hermetic runners further narrow those paths to each host's own data directory. The live ck-mc and live subc daemon were never controlled or restarted.

Copies reset only `cortexkit_fence` lease metadata before a throwaway module opens them: a new isolated lease epoch cannot inherit the live writer's epoch. This is the harness's existing specimen-copy procedure, not a domain-row modification.

## Doctor migration on the canonical-format copy

Built CLI command (with the isolation environment above):

```sh
node packages/cli/dist/index.js doctor single-store migrate \
  --skip-foreign --ck-mc "$WORKTREE/target/release/ck-mc"
```

Two projects were classified as foreign in the original snapshot: `dir:982da5a779a6` and `git:9ca367d64dd098fdc77a30765c0e9d37759efd17`. The first unflagged run refused. The subsequent explicit `--skip-foreign` run retained their store rows only in the backup, as designed. The engine also reported **1399 mappings whose store memory no longer exists**; those orphan mappings remain only in the backup.

The initial built doctor also refused an unrelated ambiguous Pi PID. The parent approved a scoped shared-holder policy: preserve conservative global refusal for the default live directory; for an explicit non-default target, require target-file holders or readable process metadata naming that path. `lsof` errors still refuse. This is shared by repair and migration and has red-first plus mutation coverage.

Canonical run: `$R/canonical-real-migrate.log`. That production binary was subsequently preserved byte-for-byte as `target/b2-ck-mc-canonical` before building the separate drive-fault variant.

| Step | Seconds |
|---|---:|
| context copy | 49.4 |
| context quick_check + SHA-256 | 13.7 |
| store copy | 12.7 |
| store quick_check + SHA-256 | 1.8 |
| read/classify | 0.1 |
| copy/reconcile | 1.0 |
| Claude Code ID check | 0.1 |
| cache reset/flags | 0.3 |
| verify | 0.1 |
| render comparison | 1.2 |

SQLite checks after the run:

- context version **92**, store `mc_cache` version **61**.
- Both migrated stamps: **1790651130009**.
- **328/328 render samples passed**, seed 1790651130009; **1294 cache rows reset**.
- Store size **1,027,731,456 → 816,107,520 bytes**.
- Existing flat-form context rows found/normalized: **0**. This is an observed count, not an assumption that old mirrors never wrote them; the dedicated migration test normalizes existing flat rows and pins their count.
- Final context compartments: **21,186**; **13,942** indexed starts and **14,036** indexed ends from copied module rows. A flat-ID SQL probe returned **0** rows.

Canonical backup:

```text
$R/canonical/data/cortexkit/magic-context/backups/single-store-2026-09-29T03-05-29.370Z
```

Printed undo, expressed with variables for readability (the log contains absolute quoted paths):

```sh
DATA="$R/canonical/data/cortexkit/magic-context"
BACKUP="$DATA/backups/single-store-2026-09-29T03-05-29.370Z"
# Quit every host using this copy first.
rm -f "$DATA/context.db-wal" "$DATA/context.db-shm" \
      "$DATA/store.db-wal" "$DATA/store.db-shm"
cp "$BACKUP/context.db" "$BACKUP/store.db" "$DATA/"
```

Keep the current plugin and ck-mc. TS works after restore; Rust refuses with MC-C14 until remigration. The engine's formerly contradictory “reinstall the previous plugin” message was fixed. CLI diagnostics now preserve both per-step stderr and the structured stdout error instead of hiding the actual failure behind progress output.

## Host drill evidence

Pinned actual hosts: **OpenCode 1.18.30**, **Pi 0.87.1**. Local production and drive-fault module binaries are separate files; final hashes are in `$R/final-host-binary-hashes.txt`. No installed/live module binary was replaced.

Before the canonical-format extension, the full real-copy host drill passed:

- first Rust HARD and three identical defer prefixes;
- module restart and identical subsequent prefixes;
- `ctx_memory` write/update/archive, each followed by an explicit project-epoch bust and three identical defers showing the corresponding state;
- smart-note write/read and `ctx_search` finding the test note;
- historian publish, fold and identical defers;
- `ctx_expand` over a genuinely folded range **1–52**, returning 1316 bytes.

Evidence: `$R/real-copy-complete-drill.log`, `$R/real-copy-plugin.log`, and per-PID `real-copy-*.lsof`/`opencode-*.lsof`. The epoch bust was deliberate test control, not a claim that every memory mutation forces HARD immediately.

TS on the migrated copy passed three identical defers. Pi 0.87.1 TS processed two turns on a real context copy. Its first cleanup assertion mistakenly counted historical copied `subagent_invocations` as new off-mock calls; deleting only those old audit rows from the **Pi copy** scoped the existing guard correctly, and the rerun passed. Evidence: `ts-real-copy.log`, `pi-real-copy-scoped-telemetry.log`, and `pi-*.lsof`.

The printed original paired backup was restored with hosts closed. SQLite then showed context92/required and store60/marker0. With the **new** plugin, TS replay still passed. Direct real-module requests for transform, state_sync, historian.pending, session.status, classification and ctx_memory all refused with MC-C14; echo answered. Switching the real host to Rust produced MC-C14 in the host session error, not merely a log line. Evidence: `rollback-real-copy.log`, `rollback-host-messages.json`, `rollback-plugin.log`, and `rollback-*.lsof`.

**Canonical-format real-copy TS→Rust→TS switch passed.** It used fresh clones of the canonical migration result and the same scrubbed OpenCode snapshot, not another live copy. `final-canonical-mode-switch.log` records session `ses_f148fca00ffeA6YA5IR9Rzoa1A` with the final locally built module:

- The real TS historian published range 1–16 with raw IDs and NULL block indices; three defers were byte-identical.
- Rust cold-adopted those rows with one `HARD / first_render`, then three `SOFT+` defers with identical frozen m0 bytes.
- A real `ctx_memory` write returned ID 20901; the project-epoch bust rendered it, followed by three identical defers.
- The Rust historian appended range 17–65 using raw IDs plus start index 0/end index 1. No flat IDs were present. After folding, three defers were identical.
- `ctx_expand(17,65)` returned the 49 original messages, including the `TSRAW_8` fixture text; this was not a synthetic placeholder response.
- The module restarted twice: once while only TS-authored compartments existed, and again after Rust publication. Both first post-restart prefixes equalled their pre-restart bytes; each restart was followed by three identical, non-HARD defers.
- Returning to TS retained the indexed boundary's raw text, rematerialized exactly once, and produced three identical `cache_hit` defer prefixes. Both provider bytes and the materialization telemetry were asserted.

Host PIDs at the final captured phases were 54326 (initial TS), 57395 (Rust), and 64841 (return to TS). Per-phase `canonical-switch-*-host-*.lsof` and module/daemon `canonical-switch-*.lsof` snapshots record only task-root database paths. The repeat also proves the conservative partial-end policy on module-published rows, not just TS-authored fixtures. Final module PIDs were 54209, 61934 and 64253; isolated subc PID 54119 and mock-producer PID 54258 are captured too. The final audit covered **331 lsof snapshots / 2042 database-handle lines**, with **zero paths outside the task root**, and rechecked all four copied credential-table counts at zero (`final-isolation-audit.json`).

## Gates and test interpretation

Evidence logs live under `R`; do not treat an earlier failed attempt as a later pass.

- `bun install --frozen-lockfile`: passed, no manifest/lock changes.
- Repository TypeScript typecheck and lint: passed after canonical changes. A standalone ad-hoc e2e tsc command was not authoritative: that package has no typecheck script, and the isolated invocation lacked workspace aliases and found a pre-existing SDK `session.get` typing gap. Repository tsc is the authoritative gate.
- Plugin full suite: **5871 passed, 0 failed**, after preserving sparse migration fixtures and legacy clone schema compatibility.
- Pi full suite: **1334 passed, 0 failed** (plus its separate helper check). CLI: **534 passed, 0 failed** in the main invocation, and all four guarded-file invocations passed. The final doctor timing regression is included.
- `CARGO_BUILD_JOBS=2 cargo fmt --check` and `cargo clippy -j 2 --locked --all-targets -- -D warnings`: passed. The exact requested four-package `cargo test -j 2 --locked -p mc-module -p mc-store -p mc-core -p mc-tokenizer` command passed in **341 s** after the tokenizer artifact correction (`final-rust-all-green.log`). Initial store lineage failures exposed missing index copying and were fixed without changing expectations. A warm-reconnect test additionally caught validating raw IDs after the host had correctly omitted already-cached coordinates; adoption now uses the guarded persisted overlay.
- Built plugin, Pi and CLI chunks assert `LATEST_SUPPORTED_VERSION = 92`; all three pass, and an actual stale plugin chunk reddens only the plugin check.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only b8fada367a HEAD`: passed **IDENTICAL** against the frozen master endpoint.
- Rust hermetic shards: **54 manifest-selected files**, run serially with separate immutable production/fault-feature binaries. Forty-eight passed in the four shard runs; six fixture failures were corrected and passed in isolated reruns. All five OpenCode2 Rust files passed in final standalone runs: fold cadence, host-runner default, module-served, unavailable-module limitation, and the on-demand **10,000-row** boundary/restart gate. Shared scenario files retain explicit mode-skip banners; those are not claimed as native-engine coverage.

Initial load averaged **573.56 / 361.29 / 353.26**. The old stuck-historian wall-clock test failed alone in B2 but passed in the master snapshot; a later two-job B2 rerun passed, so that comparison did not establish a deterministic regression. Frozen master itself replaces that fragile wall-clock assertion with a wait-budget assertion. No timing ceiling was relaxed here. The migration step-through timed out alone in both B2 and master at the original 30 s limit, then passed alone at lower load. The real-lsof and Pi restart tests also passed alone; their master controls passed after correcting local dependency links.

The two timeout e2e fixtures' old 16 s stalls no longer exceeded master's initial timeout **plus its 45 s identical-final-page completion grace**. A 65 s fault now exhausts both budgets; the recovery/HARD-count assertions remain unchanged and passed. The producer/shared-memory fixtures stopped calling deleted authority/mirror APIs and kept their real producer, scoped-write and per-ID assertions. The marker comparison first independently proves its text-only fixture ends at the final CK block, then declares whole-message coverage; the original applied-marker versus absent-marker byte comparison remains intact. The long-session fixture had an invalid `score_threshold: 0.1` (schema minimum 0.3), disabling memory through config refusal. It now uses 0.3 and an explicit off embedding provider; memory and auto-search assertions passed unchanged.

The tokenizer allocation test initially reported full text copies in the aggregate graph despite unchanged source, while the standalone package passed. A **clean frozen-master target** passed the same aggregate-graph control. Clearing only this worktree's stale `mc-tokenizer` build artifacts and relinking fixed the aggregate test: all three sizes then allocated zero text bytes. No tokenizer source or allocation threshold was changed. Baseline work must use a separate Cargo target to avoid contamination.

### Final rollback, remigration, and extra OpenCode2 gates

The canonical-format paired backup was also restored, not just the earlier draft backup. SQLite again showed context92/required and store60/marker0. `final-rollback-real-copy.log` proves TS replay, six representative non-echo lane refusals, echo success and the visible host MC-C14 error with the final module. `final-pi-copy.log` repeats Pi 0.87.1 TS on the canonical real-store copy.

Remigration then passed with **327/327** render samples and 1294 resets; the sampling seed/cutoff changes with the run time. `final-remigrate.log` records:

- context backup copy 12.5 s + check/hash 13.3 s;
- store backup copy 2.0 s + check/hash 1.8 s;
- transaction **3040 ms**, VACUUM **4366 ms**;
- existing context normalizations 0;
- store bytes **999,931,904 → 816,107,520** (the restored VACUUM backup had already removed the original file's free pages);
- stamp **1790657512639** and backup `single-store-2026-09-29T04-51-52.548Z` under the canonical data directory.

The next invocation printed `already migrated` without calling the engine (`final-idempotent.log`). A pre-rollback migrated reference pair remains in `$R/canonical-migrated-reference`; the main canonical pair is now remigrated too.

The extra OpenCode2 storage files pass: two responsive-boot tests and four real-lock/LKG/background tests. Their latest-version fixture now targets v92, not an obsolete hole at v91. The success case waits for an actual provider capture within its original bound and asserts the transformed history is present. The on-demand restart gate had selected a 24k historian window that could not fit its prompt; it now uses the existing fold-cadence fixture's separate 128k historian model while retaining the 24k conversation window and all 10,000 seeded rows. Its retired `single_store off` claim was explicitly replaced by the B2 contract: capable shared context, no optional mode, and both databases open only under the isolated root. Its coverage and read ceilings were not weakened: maximum 100 decoded rows per operation; steady passes decoded 59–60 rows (the two cold passes are expressly excluded by the original contract).

Drill-driver failures were not counted as product successes: path canonicalization (`/var` versus `/private/var`), the real `served_from=transform` label, a read-only test connection, a missing initial project-epoch row, and a short-lived lsof-monitor child were corrected before successful reruns. PID capture now selects the actual OpenCode executable and still fails if that host cannot be inspected.

## Safety controls tested non-vacuously

Every mutation was staged first, produced a non-empty working diff, then was restored from that staged live implementation and touched; the post-restore working diff was empty. No mutant was committed.

- Scoped maintenance environment reference and failed-lsof guards.
- Built emitted-chunk fence, not the source constant alone.
- Background embedding drain exclusion from foreground SQLite retry leases.
- Partial-message TS trimming.
- Cached boundary source-row identity matching.
- Populated-v91 v92 column addition (the fresh-schema companion stays green).
- Cross-host partial-block refusal before staging/journalling.

Exact named red tests and companion results are included in the delivery's mutation evidence and the corresponding `*-mutant.log` files.

## Reproduction commands and artifact map

Run only in this worktree and only against these throwaway copies. Prepare `canonical-switch-host/data/cortexkit/magic-context/{context,store}.db` from the migrated reference pair, and its `data/opencode/opencode.db` from the scrubbed specimen. Pi uses `pi-copy/data/cortexkit/magic-context/context.db` with only historical invocation-audit rows removed. The refusal driver uses `rollback-host/data` populated from both printed pre-cutover backups and the scrubbed OpenCode specimen. Reset copied `cortexkit_fence` leases only, as described above; never point a driver at a live directory.

The driver sources are retained both under `$WORKTREE/target/` and `$R/drivers/`; the archived copies use worktree-relative imports and should be restored to `target/` before execution. They never take another live snapshot and delete only their owned throwaway host directories.

```sh
export B2_EVIDENCE="$R"
export REAL_HOME="$HOME"
export CARGO_HOME="$REAL_HOME/.cargo" RUSTUP_HOME="$REAL_HOME/.rustup"
export CARGO_BUILD_JOBS=2
export HOME="$R/home" XDG_DATA_HOME="$R/data" XDG_CONFIG_HOME="$R/config"
export XDG_STATE_HOME="$R/state" XDG_RUNTIME_DIR="$R/runtime" XDG_CACHE_HOME="$R/cache"
export TMPDIR="$R/tmp" PATH="$WORKTREE/target/b2-tools:$PATH"
export MC_E2E_CK_MC_PREBUILT_BIN="$WORKTREE/target/b2-ck-mc-final"
export MC_E2E_CK_MC_DRIVE_FAULT_BIN="$WORKTREE/target/b2-ck-mc-final-drive-fault"
export MC_E2E_CK_SUBC_BIN="$WORKTREE/packages/e2e-tests/.cache/rust-e2e-cargo-target/release/ck-subc"

# Four sequential shards; never start two cargo commands or shards together.
for i in 0 1 2 3; do
  MC_E2E_SHARD="$i/4" bash scripts/run-rust-hermetic-e2e.sh
done
# Individual repaired fixtures were rerun with this form:
MC_E2E_MODE=rust bun test --cwd packages/e2e-tests --timeout 600000 tests/rust-timeout-epoch-recovery.test.ts

# After preparing fresh closed-file clones at each driver's documented child root:
bun target/b2-canonical-switch-drill.ts
bun target/b2-pi-drill.ts
B2_EXPECT_REFUSAL=1 bun target/b2-rollback-drill.ts

# Frozen origin/master, not a moving remote endpoint:
bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only b8fada367a HEAD
```

The final replay at source head `6826d49b25` was **IDENTICAL on all four defers**, and both emitted fences and the exact manifest check passed afterward (`final-head-pure-replay.log`). Only this report is added after that check. Final static/full-suite logs are `final-types.log`, `final-lint.log`, `final-plugin-suite.log`, `final-cli-suite.log`, `canonical-pi-full.log`, `final-rust-all-green.log`, and `final-clippy.log`. The canonical final host, Pi, rollback and remigration logs are named explicitly above. Failed-attempt logs remain alongside them for audit; their filenames alone are not a pass claim.

AFT inspect eventually returned `FRESH` but explicitly reported `Incomplete diagnostics: producer biome failed (biome is unavailable)` and no authoritative per-file LSP reports for the two scoped files. Package-installed tsc and Biome commands passed and are the diagnostic authority. Earlier bounded sidekick research calls timed out, so the boundary audit was completed by direct source reading; comment reviews did complete.

## What an adversarial reviewer should attack next

1. Concurrent TS recompaction between the context snapshot and the store metadata transaction: stale read-coordinate caches must never authorize trimming different shared rows.
2. Partial-message ends with large tool/image suffixes, and host-native checkpoint requests. Safe duplication is intentional; losing an uncovered suffix is not.
3. Warm cold-adoption cache validity after a mode switch, process restart, revert and lineage clone; check raw IDs and block indices, not just summary bytes.
4. Sparse/old-schema cloning and staging paths: nullable columns must neither be dropped nor invented. Cross-host conversion must continue refusing what it cannot map faithfully.
5. Real source-ID conventions and integer bounds. Supported flat coordinates use the module's existing `mid#u64` grammar; values outside SQLite's signed integer range are rejected rather than truncated.
6. The Bun CLI handle-retention issue noted above. The successful built-CLI drill uses Node; no claim is made that the Bun launcher is fixed.
7. Large raw-ID sessions after cold adoption: inventory must skip repeated host-history scans only when original row coordinates still match the cached resolution.
