# 0.44.4 → 0.45.0 startup upgrade rehearsal

Date: 2026-10-02 (measurements in UTC). Platform: macOS arm64, APFS, Bun 1.4.2, Node 24.16.0.
Candidate source: `fd7a388fdf329fa1b5c54c08584655ef9fb98f66`.

## Verdict

Here, v91–v94 are **Magic Context context.db schema migration versions**, not host versions. v92 adds single-store bookkeeping and canonical compartment boundaries, v93 adds per-session history-version triggers, and v94 splits last-known-good (LKG) cached prefixes and replay decisions into separate rows. The **schema fence** is the maximum persisted migration version a plugin build supports; advancing it makes an older build incompatible with the shared database.

**Not a green release-readiness result.** The real schema-91 store migrated successfully inside all three TypeScript hosts, and each host served a mock-provider turn afterwards. However, **OpenCode's `/health` stopped responding during v94**, including OpenCode 2.0.15. The longest measured success-to-success gaps were **46.148 seconds** on the first OpenCode 1 run and **6.624 seconds** on OpenCode 2. The OpenCode 2 boot-responsiveness requirement is not met.

The upgrade scenarios also checked whether a new host migrates under an attached old host and whether the first resumed conversation rebuilds exactly once. Those expectations are not what this build does:

- With a confirmed old OpenCode host attached, the **new host refuses to migrate**, rather than moving the fence underneath the old host. The old host consequently continues serving on v91. The post-fence old-host behavior was not reached; the guard was not bypassed to manufacture it.
- Resuming the same conversation across a successful OpenCode 1 upgrade hydrated its persisted LKG and used `cache_hit`, **without a forced rebuild**. New conversations did perform one `first_render` rebuild. A universal one-time rebuild is not established by these results.

The Rust arm used the permitted offline-doctor-only fallback because the existing isolated-daemon harness pre-migrates the input before host startup. Its production-runtime doctor invocation refused the unchanged specimen's extra `memories.content_version` column. A Rust host's MC-C14 refusal was **not experimentally verified**. No production code was changed. This report records the responsiveness defect and the remaining coverage limitations, rather than claiming fixes or a complete Rust compatibility proof.

## Specimen, builds, isolation, and measurement

### Real data, not a synthesized fixture

The requested backup directory contains the database pair in its `pre/` subdirectory. Each source was copied with `cp -c`; no SQLite connection opened the backup or the live store. The live OpenCode main database, WAL, and SHM were also cloned with `cp -c` before any connection to the copy.

| Copied input | Bytes | Schema / contents | `PRAGMA quick_check` on copy |
| --- | ---: | --- | --- |
| Backup `pre/context.db` | 7,559,360,512 | `schema_migrations` upstream maximum 91 | `ok` |
| Backup `pre/store.db` | 1,134,546,944 | `cortexkit_schema_version`, `mc_cache` maximum 60 | `ok` |
| Scrubbed OpenCode snapshot | 35,967,610,880 | Real host data; credential tables empty | `ok` |

The context snapshot contains **11,907 session metadata rows, 1,961,895 tags, 11,893 compartments, and 18,401 memories**. `PRAGMA user_version` is zero; Magic Context instead records context migrations in `schema_migrations` and Rust store migrations in `cortexkit_schema_version`.

On the OpenCode copy, foreign-key enforcement was off for scrubbing, all rows in `credential`, `account`, `account_state`, and `control_account` were deleted and committed, and **VACUUM completed before any host opened the copy**. All four final row counts were zero. An initial preparation command hit its 600-second timeout while vacuuming the approximately 34-GiB host store. Recovery checkpointed only the copy, switched its journal to DELETE, and completed a fresh VACUUM in **492.391 seconds**. That preparation cost is not included in any plugin migration measurement. The copied snapshot passed `quick_check` afterwards. Copying a changing live WAL in separate `cp -c` operations is not an atomic online backup; the successful integrity checks and host opens describe this particular captured image, not a general atomic-snapshot guarantee.

Every arm received independent APFS clones from the untouched snapshots, except the intentional two-host shared-copy arm and restarts within an arm. No column was dropped and no authority row was removed to make an arm succeed.

### Exact packages and entry points

- `bun run build:dists` passed, including four OpenCode 2 plugin export-contract tests and the `dists LOAD OK` import probe.
- Before packages came from `npm pack @cortexkit/opencode-magic-context@0.44.4` and `npm pack @cortexkit/pi-magic-context@0.44.4`.
  - OpenCode tarball npm SHA-1: `7c5f9efec4748e80604a746ef6dd2e1851f2f69a`.
  - Pi tarball npm SHA-1: `8fcf520d76bab572f7d08e439d7b824421fb8d6d`.
- Installed hosts under the throwaway root: `opencode-ai@1.18.31`, `@opencode/cli@2.0.15`, `@opencode/client@2.0.15`, and `@earendil-works/pi-coding-agent@0.99.2`. Executable version output confirmed `1.18.31`, `opencode v2.0.15`, and `0.99.2`.
- OpenCode 1 loaded `file://<package>/dist/index.js`; OpenCode 2 loaded `file://<package-directory>`; Pi loaded the local extension package directory. Candidate distributions came from this worktree's source build, not npm's current version.
- The checkout still identifies itself as **0.44.4** in package metadata and Pi's `loaded v0.44.4` breadcrumb. “Candidate” below means the source revision above, with migrations 92–94, not a published 0.45.0 tarball.

The first OpenCode 1 before attempt lacked the extracted package's declared runtime dependencies and never registered tools (`Error: plugin tools not ready`). Importing it independently exposed `Cannot find module '@opencode-ai/plugin'`. This was a rehearsal setup error, not a product compatibility finding. Supplying dependencies from the corresponding worktree package's installed `node_modules` made the **unmodified published package** load and serve on v91. Both a separate control and the later faithful same-conversation arm confirmed that before state. Pi's initial dependency setup also emitted an `ai-tokenizer` fallback warning; corrected runs had empty stderr. No compatibility wrapper or export shim was added.

### Child environment and provider containment

The canonical throwaway root was:

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/v045-rehearsal
```

Hosts were launched with a newly constructed environment, **not an inherited credential-bearing environment**. For an arm directory `A` under that root:

```text
HOME=A/home
TMPDIR=A/cache
XDG_DATA_HOME=A/data
XDG_CONFIG_HOME=A/config
XDG_STATE_HOME=A/state
XDG_RUNTIME_DIR=A/runtime
XDG_CACHE_HOME=A/cache
OPENCODE_DB=A/data/opencode/opencode.db
MAGIC_CONTEXT_STORAGE_DIR=A/data/cortexkit/magic-context
MAGIC_CONTEXT_LOG_PATH=A/<phase>.plugin.log
```

OpenCode 1 additionally used `OPENCODE_CONFIG_DIR=A/config`; Pi used `PI_CODING_AGENT_DIR=A/agent`. Automatic updates/default external plugins were disabled. Magic Context embeddings, memory injection, historian work, and dreamer work were disabled to keep the measurement about startup and the primary turn. This is a real-store migration and basic-turn rehearsal, **not a default-feature or historian stress test**.

The shared E2E `MockProvider` in `packages/e2e-tests/src/mock-provider/server.ts` served every primary reply, with the exact marker `V045_REHEARSAL_MOCK_ONLY`. OpenCode 1's enabled provider list contained only `mock`, and both its main and small models used the mock. OpenCode 2 used the harness's local OpenAI-compatible provider configuration; Pi used a custom local Anthropic-messages provider. All configured endpoints were on `127.0.0.1`, with fake keys. Successful turns were checked against captured mock request counts and the marker in the host's actual assistant messages. No non-mock reply was observed. OpenCode can make an additional mock title request; counts of two are not two primary turns.

### Timing definitions

- Migration **span**: timestamp of `current upstream migration lane: 91, applying 3 migration(s)` through `upstream migration lane now: 94` in the plugin log.
- v92/v93 times: differences between plan/applied timestamps, at **1-ms log resolution**, including the preceding transaction/ledger work. A same-millisecond difference is reported as `<1 ms`, not a claim of zero work.
- v94: exact `slow write transaction: site=migration-runner held=...ms` diagnostic, when present.
- OpenCode readiness: spawn to tool registry readiness (v1), or active plugin state (v2), after the application/session bootstrap has been triggered. The HTTP listening banner alone is not plugin readiness.
- `/health`: independent requests scheduled every **250 ms**, starting at the server's listening handoff, with a **1-second request timeout**. OpenCode 2 requests used its advertised Basic authentication credentials. Both hosts returned HTTP 200 when healthy. Longest gap means time between completed successful health responses, including failed probes between them; it is not merely the slowest successful response. Synchronous `lsof` collection can delay the driver near the audit points, so subsecond/approximately one-second gaps are not attributed exclusively to the host. The multi-second migration stalls contain repeated failed probes and coincide with v94.
- Pi runs used RPC startup and a primary prompt. Pi has no HTTP `/health`; reporting zero would be misleading. Its wall measurements include the driver's one-second startup wait and one-second post-turn log-flush wait, plus audits and teardown.

## Arm 1 — OpenCode 1.18.31, TypeScript

Two successful candidate migration observations are retained: the first candidate-only fresh copy, and a corrected **published-before → candidate → restart on the same conversation** sequence. Filesystem-cache state was not controlled in either sequence. The timing difference must not be treated as a host-performance comparison or a guaranteed first-start duration.

| Phase | Migration span; v92 / v93 / v94 | Spawn to plugin ready | Longest `/health` gap | First turn | Errors / refusals |
| --- | --- | ---: | ---: | --- | --- |
| Published before, faithful arm, v91 → v91 | No versions applied | 25.727 s | 1.250 s; 0/64 probes failed | HTTP 200, mock; one `first_render` | None blocking |
| Candidate, first fresh-copy observation, v91 → v94 | **44.600 s**; 6 ms / 4 ms / **44,589.8 ms** | **48.217 s** | **46.148 s**; 181/209 probes failed | HTTP 200, mock; one `first_render` | No turn refusal; health timeouts/socket failures |
| Candidate, faithful same-conversation upgrade, v91 → v94 | **5.575 s**; 2 ms / <1 ms / **5,572.2 ms** | **8.440 s** | **5.777 s**; 18/39 probes failed | HTTP 200, one mock request; LKG hydrated, `cache_hit`, no hard-fold rebuild | No turn refusal; health timeouts |
| Candidate restart, same conversation, v94 → v94 | No versions applied; boot migrate/check phase 19 ms | **2.629 s** | 0.412 s; 0/16 probes failed | HTTP 200, mock; one `system_hash` hard fold | No turn refusal |

The separate published-package control remained v91, registered tools, and returned the marker; its 45.172-second host readiness includes host initialization rather than application schema migrations. The initial candidate-only observation's before attempt was invalid for the dependency reason above. It is not represented as a successful before arm.

Verbatim fresh-copy migration evidence:

```text
[2026-10-02T00:54:42.418Z] [migrations] current upstream migration lane: 91, applying 3 migration(s)
[2026-10-02T00:54:42.424Z] [migrations] applied v92: store-level offline single-store state and canonical compartment boundaries
[2026-10-02T00:54:42.428Z] [migrations] applied v93: per-session compartment history revision for shared readers
[2026-10-02T00:55:27.018Z] [magic-context] slow write transaction: site=migration-runner held=44589.8ms
[2026-10-02T00:55:27.018Z] [migrations] applied v94: store LKG prefixes as slices and replay decisions as rows instead of growing records
[2026-10-02T00:55:27.018Z] [migrations] upstream migration lane now: 94
[2026-10-02T00:55:27.184Z] [magic-context] boot phases: config=53ms conflict=2008ms guard=68ms open=3ms migrate=44776ms hooks=42ms rpc=0ms post=8ms total=46959ms budget=15000ms deadline_phase=none
```

Verbatim resumed-conversation behavior:

```text
lkg_hydrated_from_disk
transform scheduler: percentage=0.0% inputTokens=0 cacheTtl=5m lastResponseTime=1790904237377 decision=defer
heuristics WILL NOT RUN — reason=scheduler_defer
transform: injected m[0]/m[1] (rematerialized=false, reason=cache_hit)
```

The same conversation's next restart logged:

```text
m[0] HARD fold decision: reason=system_hash executed=true bustsServedPrefix=true
```

Thus a successful primary turn is proven by the actual mock response, rather than by a literal `decision=pass` diagnostic (the Rust pipeline's render-decision vocabulary). TypeScript instead logs its scheduler and materialization decisions. “Exactly one upgrade rebuild, never another on restart” is **not** the observed contract. The fresh-copy new conversation logged `reason=first_render executed=true` once.

Health probe failures included these exact messages:

```text
TimeoutError: The operation timed out.
TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()
TypeError: Unable to connect. Is the computer able to access the url?
```

A non-blocking startup warning also occurred:

```text
[magic-context] resolved-config fetch failed; using file-based compaction detection (the running server's resolved config may differ — `opencode debug config` is authoritative)
```

Final migrated context copy: v94, `quick_check=ok` (both successful copies checked).

## Arm 2 — OpenCode 2.0.15, TypeScript

| Phase | Migration span; v92 / v93 / v94 | Spawn to active plugin | Longest `/health` gap | First turn | Errors / refusals |
| --- | --- | ---: | ---: | --- | --- |
| Published before, v91 → v91 | No versions applied | 1.559 s | 0.532 s; 0/10 probes failed | Mock marker in assistant messages, two mock requests | None blocking |
| Candidate, v91 → v94 | **6.461 s**; 3 ms / 1 ms / **6,457.4 ms** | **7.355 s** | **6.624 s**; **22/33 probes failed** | Mock marker, two mock requests; one `first_render` hard fold | No turn refusal; health timeouts |
| Candidate restart, v94 → v94 | No versions applied | **0.626 s** | 0.341 s; 0/6 probes failed | Mock marker, two mock requests | None blocking |

The before and candidate turns used new conversations in the same host store. Same-conversation resume coverage is supplied by arm 1, not implied for this arm. An initial driver's attempt used the nonexistent `client.session.messages`; the correct 2.0.15 call is `client.message.list`. The corrected before/upgrade/restart sequence above uses the latter and validates actual returned messages.

Verbatim candidate boot evidence:

```text
[2026-10-02T01:11:11.827Z] [migrations] current upstream migration lane: 91, applying 3 migration(s)
[2026-10-02T01:11:11.830Z] [migrations] applied v92: store-level offline single-store state and canonical compartment boundaries
[2026-10-02T01:11:11.831Z] [migrations] applied v93: per-session compartment history revision for shared readers
[2026-10-02T01:11:18.288Z] [magic-context] slow write transaction: site=migration-runner held=6457.4ms
[2026-10-02T01:11:18.288Z] [migrations] applied v94: store LKG prefixes as slices and replay decisions as rows instead of growing records
[2026-10-02T01:11:18.288Z] [migrations] upstream migration lane now: 94
[2026-10-02T01:11:18.311Z] [magic-context] @cortexkit/opencode-magic-context v2 setup
```

`/health` had successful replies before and after this interval, but timed out repeatedly during it (`TimeoutError: The operation timed out.`). The plugin eventually became active and served the turn. **Returning a listening handoff and eventually becoming active does not satisfy boot readiness when health is unresponsive in between.** This reproduces the boot-readiness failure where the listening server becomes unresponsive while plugin initialization is pending; it does not claim identity with every historical failure path.

Final migrated context copy: v94, `quick_check=ok`.

## Arm 3 — Pi 0.99.2, TypeScript

| Phase | Migration span; v92 / v93 / v94 | Plugin entering → loaded | Driver wall time | `/health` | First turn / errors |
| --- | --- | ---: | ---: | --- | --- |
| Published before, v91 → v91 | No versions applied | Not used as migration timing | 2.477 s | N/A: RPC host | Mock marker, `agent_end`, one request; stderr empty |
| Candidate, v91 → v94 | **9.290 s**; 3 ms / 1 ms / **9,286.4 ms** | **9.475 s** | **11.252 s** | N/A: RPC host | Mock marker, `agent_end`, one request; one `first_render`; stderr empty |
| Candidate restart, v94 → v94 | No versions applied | **0.099 s** | **2.407 s** | N/A: RPC host | Mock marker, `agent_end`, one request; stderr empty |

Each phase used a new Pi conversation, so this arm proves startup and basic rendering, not resuming a long Pi transcript across the upgrade. Database size and migration contents remained the real specimen.

```text
[2026-10-02T01:01:57.812Z] [migrations] current upstream migration lane: 91, applying 3 migration(s)
[2026-10-02T01:01:57.815Z] [migrations] applied v92: store-level offline single-store state and canonical compartment boundaries
[2026-10-02T01:01:57.816Z] [migrations] applied v93: per-session compartment history revision for shared readers
[2026-10-02T01:02:07.102Z] [magic-context] slow write transaction: site=migration-runner held=9286.4ms
[2026-10-02T01:02:07.102Z] [migrations] applied v94: store LKG prefixes as slices and replay decisions as rows instead of growing records
[2026-10-02T01:02:07.102Z] [migrations] upstream migration lane now: 94
```

Pi's registration log confirmed `ctx_search, ctx_memory, ctx_note, ctx_expand, ctx_reduce` and its context handler. Final context copy: v94, `quick_check=ok`.

## Arm 4 — An old OpenCode host remains attached

Both hosts were OpenCode 1.18.31, on distinct ports, sharing the **same** throwaway v91 context and host databases. Old plugin: published 0.44.4. New plugin: candidate distribution. The old host first served a mock turn. Then the new host started.

| Side | Migration / schema | Readiness | Longest `/health` gap | Next turn | Errors / refusals |
| --- | --- | ---: | ---: | --- | --- |
| Old PID 47142 | No migration; v91 throughout | 2.848 s | 0.341 s; 0/17 startup/first-turn probes failed | HTTP 200, mock marker, one request after new host refused | No schema refusal: fence did not move |
| New PID 47430 | **Refused before migration**; boot `migrate=0ms`; v91 afterwards | Fail-closed state observed at 3.153 s, not enabled readiness | 0.378 s; 0/16 probes failed | HTTP **500**; zero captured mock requests at primary failure | Migration guard refusal below |

New side, verbatim decisive log message (the path is the actual throwaway database):

```text
[magic-context] storage fatal: refusing to migrate /private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/v045-rehearsal/old-open/data/cortexkit/magic-context/context.db from upstream migration v91 to v94 while confirmed OpenCode server PID 47142 still use the old plugin build. Restart the blocking harness, then retry this process.
[magic-context] fail-closed blocking armed (migration_guard); primary sessions will error until storage recovers or the build is upgraded
```

The next primary HTTP response from the new side was:

```json
{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_1ff7e207"}}
```

Its host log contained `createFailClosedBlockingError` / `enforce` stack frames. The detailed recovery text was present in the plugin log, but the direct HTTP response exposed only the generic server error. The host can subsequently schedule a title request; zero above is the captured count at primary failure, not a lifetime claim about auxiliary requests.

The old side's next turn returned `V045_REHEARSAL_MOCK_ONLY` and HTTP 200. The context reader's `PRAGMA data_version` changed **2 → 3** across that old-host turn: the old host still wrote to the v91 store. That is **not** a write after an advanced fence. There was no advanced fence and no dropped-hook evidence. The safety condition this run actually exercised was **new-host refusal while an old holder is confirmed**, preventing incompatible old code from remaining attached to a newly migrated shared store. The requested “new migrates, then old loudly refuses/no writes” branch remains untested, because reaching it would require neutralizing a production safety guard.

## Arm 5 — Rust mode and offline doctor

**Doctor-only stop; Rust-host first-start and post-migration restart not exercised.** The existing hermetic stack cannot serve as an unmodified schema-91 startup driver: `HermeticSubcStack.start` unconditionally calls `prepareContextDatabase(opts.dataDir)` before starting the daemon/module (`packages/e2e-tests/src/rust-runner/hermetic-subc.ts:490–493`). That helper applies current plugin migrations outside the host (`packages/e2e-tests/src/prepare-context-db.ts:12–14`). Using it unchanged would falsely label a pre-migrated host as a startup-upgrade proof. The normal OpenCode runner also calls `prepareContextDatabase` unless `prepareContextDatabase: false` is supplied; that would likewise migrate the copy before the host sees it. The TypeScript arms above therefore used raw host spawning, not that preparer.

Rust single-store cutover moves the domain data from store.db into context.db; adding context schema tables alone does not perform that copy. The `ck-mc` executable is Magic Context's Rust engine. No ck-mc process was connected to the live daemon. The only ck-mc execution in this arm was its offline `single-store-migrate` subcommand, invoked by doctor with explicit copied paths and an engine built in this worktree using `cargo build --release -p mc-module`.

| Step | Time | Migration work | `/health` / turn | Result |
| --- | ---: | --- | --- | --- |
| Rust host at v91 / store v60 | Not run | Not measured | Not exercised | No claim of observed MC-C14 |
| Initial doctor under Bun | 1.83 s | No schema migration logged | N/A | Exit 1: `single_store_internal_error: unable to open database file` |
| Doctor under production Node runtime | **17.97 s total** | Additive context migrations: **16.782 s** span; v92 4 ms / v93 <1 ms / v94 **16,777.7 ms** | N/A: offline | Exit **2**, fingerprint refusal; no completed single-store cutover |
| Rust second start | Not run | N/A | Not exercised | Cutover remained refused |

The command, under the same isolated HOME/XDG/storage variables as above, was:

```sh
node packages/cli/dist/index.js doctor single-store migrate \
  --ck-mc "$PWD/target/release/ck-mc" \
  --backup-root "$ROOT/rust/backups"
```

Bun's initial read-only opener failure is reported as an extra runtime observation, not confused with the successful Node preflight or classified as a Node CLI defect. The Magic Context CLI entry point declares `#!/usr/bin/env node` (`packages/cli/src/index.ts:1`), making Node the relevant production invocation here.

Doctor printed a backup location and undo directions, then refused **without dropping the unknown column**:

```text
single_store_fingerprint_mismatch: context.db table memories has schema fingerprint 898922c5de90f95ee39fe1e34173265151df28a94cceead3afc4c44e9bc5fb85, not the a5b13611e93768e4f53e78e4831a58d74d6c79e078a1a85c5cfbf269a0eb417c this module was built against; domain writes to memories are refused. memories has column(s) this build does not know: content_version. If no release of Magic Context created them (a development build did), stop every Magic Context process and drop them with sqlite3 on context.db: ALTER TABLE memories DROP COLUMN content_version; Then run the migration again
```

This is specimen-specific incompatibility, already described in the earlier offline single-store drill documentation, not evidence that an ordinary published 0.44.4 installation created that column. The unchanged real specimen is **not** a passing Rust-cutover fixture. No follow-up with `ALTER TABLE`, `--skip-foreign`, or preference flags was used to turn a refusal into a green result.

The MC-C14 sentence is supported by source, **not by an executed Rust host in this rehearsal** (`packages/plugin/src/shared/user-facing-codes.ts:235–238` and `single-store-refusal.ts:5–7`):

```text
Magic Context's Rust mode needs a one-time migration of its store. Quit OpenCode and every ck-mc process, then run `magic-context doctor single-store migrate`. (MC-C14)
```

After the Node doctor attempt, context.db was v94 and passed `quick_check`; this does not mean Rust domain data migrated from store.db or that Rust mode could serve. The command refused before completing that cutover.

## Arm 6 — Second starts

| Host | First candidate startup | Second startup | Versions reapplied? | Turn result |
| --- | ---: | ---: | --- | --- |
| OpenCode 1.18.31, faithful same conversation | 8.440 s to tools | **2.629 s** to tools | **None**; migration lock/check log only | HTTP 200, mock; `system_hash` hard fold, not a migration rerun |
| OpenCode 2.0.15 | 7.355 s to active plugin | **0.626 s** | **None** | Mock marker in actual assistant messages |
| Pi 0.99.2 | 9.475 s plugin-entering → loaded | **0.099 s** on same definition | **None** | RPC `agent_end`, mock marker |
| Rust | No successful Rust cutover | Not run | Not claimed | Not exercised |

The first candidate-only OpenCode 1 copy also restarted at v94 with no applied-version logs: 3.593 seconds to tools, compared with 48.217 seconds initially. Neither table claims all cache materialization work disappears on a restart.

## Open-file isolation evidence

For every running host, the driver executed **`lsof -p <pid> -Fn`**, saved the complete output, extracted all `.db`, `.db-wal`, `.db-shm`, and `.db-journal` paths, canonicalized them, and rejected any outside the throwaway root. The ready/turn audits contained actual database handles, not just an empty path list. No live-store open was observed.

Define `R` as the canonical absolute root printed above. This table is a deduplicated transcription of the database paths from those `lsof` outputs; **each expanded path is under R**. A grouped `{,-wal,-shm}` represents the main database and its SQLite write-ahead-log and shared-memory sidecars; all three exact paths were observed, not assumed from a directory restriction.

| Host / phase | PID | Observed database paths |
| --- | ---: | --- |
| OpenCode 1 published-package control | 85903 | `R/oc1-control/data/opencode/opencode.db{,-wal,-shm}`; `R/oc1-control/data/cortexkit/magic-context/context.db{,-wal,-shm}` |
| OpenCode 1 initial candidate migration | 46181 | `R/oc1/data/opencode/opencode.db{,-wal,-shm}`; `R/oc1/data/cortexkit/magic-context/context.db{,-wal,-shm}` |
| OpenCode 1 initial candidate restart | 56896 | Same two triplets under `R/oc1/` |
| OpenCode 1 faithful published-before | 90455 | Both triplets under `R/oc1-faithful/` |
| OpenCode 1 faithful candidate | 95809 | Both triplets under `R/oc1-faithful/` |
| OpenCode 1 faithful restart | 96148 | Both triplets under `R/oc1-faithful/` |
| OpenCode 2 published-before | 46189 | `R/oc2/data/opencode/opencode.db{,-wal,-shm}`; `R/oc2/data/cortexkit/magic-context/context.db{,-wal,-shm}` |
| OpenCode 2 candidate | 46336 | Same two triplets under `R/oc2/` |
| OpenCode 2 restart | 46870 | Same two triplets under `R/oc2/` |
| Pi published-before | 94437 | `R/pi/data/cortexkit/magic-context/context.db{,-wal,-shm}` |
| Pi candidate | 94761 | Same context triplet under `R/pi/` |
| Pi restart | 95572 | Same context triplet under `R/pi/` |
| Concurrent old host | 47142 | Both host/context triplets under `R/old-open/` |
| Concurrent new host | 47430 | Both host/context triplets under `R/old-open/` |

The dependency-missing initial OpenCode 1 host (PID 973), the first Pi setup attempt (PID 81917), the initial OpenCode 2 driver attempt, and the first concurrent-arm attempt were also audited against the same path rule; they are excluded from successful outcome claims. Pi did not open the OpenCode snapshot. There is no Rust-host `lsof` claim because no Rust host was started. Doctor received explicit copied context/store paths and an isolated environment.

## Defect and interpretation

### Reproduced defect: migration work blocks OpenCode health

The `/health` requirement is directly violated in both OpenCode generations. Its strongest controlled comparison is OpenCode 2: **22 failed probes during the 6.457-second v94 transaction, zero failed probes before and on restart**, with successful health replies on both sides. The first OpenCode 1 copy independently shows a 44.590-second v94 transaction and a 46.148-second health gap. The faithful OpenCode 1 before/upgrade/restart sequence reproduces the same symptom on a shorter, warm-cache migration.

The source provides a matching mechanism: `runMigrations` executes each migration synchronously in a SQLite transaction (`packages/plugin/src/features/magic-context/migrations.ts:3320–3355`). `runMigrationsWithRetry` only sleeps for **lock acquisition** failures; it does not move a successful migration body off the host event loop (`:3421–3443`). A timer-based boot deadline cannot preempt that synchronous body. The first OpenCode 1 boot log even reports `total=46959ms budget=15000ms deadline_phase=none`. A 15-second budget therefore does not bound this measured stall. This is evidence for the event-loop-blocking path, not a proposed compatibility shim or a verified fix.

**No code fix is included.** A release decision must account for this result or remediate and rerun the real-store startup lanes; the eventual successful mock turn does not erase the health failure.

### Not labeled as defects without additional evidence

- The new host's old-holder migration refusal is an explicit production safety guard, not silently lost hooks. It contradicts the requested arm's expected order but protects the shared store.
- The extra development-era `content_version` column caused a clear fingerprint refusal. Removing it would change the requested specimen and was deliberately not done.
- A resumed LKG cache hit is not necessarily defective. It means the requested blanket rebuild assertion is not supported. The observed later `system_hash` fold also prevents asserting restart has no rendering work.
- MC-C14 remains a source-supported expectation needing an actual hermetic Rust host test that does not pre-migrate the copy. This report is not that test.

## What release notes must tell users

- First start upgrades the shared context store, once per store, not once per project. On this **7.56-GB / nearly two-million-tag** specimen, additive migrations took **5.6–44.6 seconds**, dominated by v94; the slowest observed OpenCode startup reached tools after approximately **48 seconds**. These are local observations, not an upper bound for slower disks or larger stores.
- Ordinary subsequent starts did not reapply v92–v94 and returned to subsecond/few-second plugin readiness in these lanes.
- **Until the responsiveness defect is fixed, do not promise `/health` remains live while upgrading.** Both OpenCode 1 and OpenCode 2 stalled during migration in this rehearsal.
- Quit or upgrade older OpenCode/Pi processes using the shared store before starting the new plugin. A confirmed older holder causes the **new** host to refuse migration and block primary turns; a pinned old package may require updating, not just restarting.
- Experimental `transform_mode: "rust"` requires the offline `magic-context doctor single-store migrate` step with hosts and ck-mc stopped. Additive context schema migration alone is not the Rust-domain cutover. Keep paired backups and heed refusal diagnostics rather than forcing unknown schema changes. The unchanged fleet specimen refused its extra development column, so this rehearsal does not establish a successful Rust upgrade time.
- Explain possible first-render/cache materialization once a session is opened, but **do not state that every upgraded conversation necessarily rebuilds exactly once** on this evidence: new sessions rebuilt, while the resumed OpenCode 1 session hydrated LKG and hit cache. Restart can still cause an independent system-prompt-hash fold.

## Verification and cleanup

`quick_check=ok` was obtained on all three initial copied databases, the successful OpenCode 1 copies, OpenCode 2's migrated context, Pi's migrated context, and the doctor-refused v94 context. These checks are database integrity observations, not full semantic parity tests. The required dists build and import probes passed. Only this Markdown report is committed; no manifests, lockfiles, architecture files, host packages, databases, generated distributions, or temporary drivers are part of the change.

After stopping the hosts, cleanup removed **58 throwaway database/sidecar or large-binary files**, totaling **322,047,025,140 bytes of logical file size (approximately 299.9 GiB)**. Cleanup did not follow symlinks and did not touch backup/live source files or the worktree. APFS clones share extents, so that total is **not** a claim of 299.9 GiB of unique physical disk space reclaimed. Small driver scripts, logs, and summaries remain under the throwaway root for review; the large specimen copies are gone.
