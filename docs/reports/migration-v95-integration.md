# v95 and frozen temporal markers: integration readiness

Verified on macOS on 2026-10-06, before the fleet reboot window. This branch is
based on master **99ae86b1eb7a30cd119d1ddae7ef0e92a0115d99** and merges both
reviewed tips, without pushing, installing binaries, restarting live services,
or opening any live store:

- Migration batch: **6528bb968193c4bf9c3965e6056793646f54ebd0**.
- Frozen temporal markers: **6e8cc0f9e38529d61bc9cbff75c64586ea59cf5b**.
- Production integration fixes: **ada3bb758c840a7a51a637206bdfdf3be9dd214d**.

The delivery declaration records the final branch SHA. Subsequent changes are
verification instruments and this report, not additional production changes.

## Semantic reconciliation

Both merges were textually clean. The temporal branch already includes the
migration foundation, so it extends the same installer rather than adding a
second v95 entry. Inspection confirms:

- Exactly one TypeScript migration 95 calls `installV95PerfSchema`.
- `LATEST_SUPPORTED_VERSION` and the Rust HostStore context fence are **95**.
- Fresh initialization uses that same installer. The miscellaneous replay
  column still has its normal `ensureColumn` path in `storage-db.ts`.
- `temporal_decisions(session_id, message_id, marker)` uses an indexed composite
  primary key and WITHOUT ROWID storage. Session cleanup includes it after
  metadata deletion, retaining another harness's surviving metadata owner.
- Neither branch changes `crates/mc-store`. Its **store.db lane remains 63**;
  context.db 95 is a separate fence. Native domain fingerprint tests pass.
- The named schema generator produces a byte-identical v95 Rust fixture.

Master history since the branch bases was reviewed for migrations, storage,
Pi/OpenCode transforms and the Rust transform. Relevant intervening changes
include live cache-TTL policy, protected-tool work and its revert, bounded
tokenization/refusal, measured LKG replay, and compaction-marker admission.
The merges preserve those implementations. Five interactions needed explicit
resolution:

1. **Sparse historical tables:** temporal conversion assumed the optional
   `merged_reasoning_stripped_ids` column existed before normal initialization.
   Nineteen existing migration regressions exposed the missing column. The v95
   installer now supplies it with `ensureColumn` before reading it, and a new
   populated sparse-table regression covers the case.
2. **Offline legacy cloning:** the shared clone helper was newly querying
   `temporal_decisions` unconditionally. Six existing offline clone tests use
   pre-v95 stores without upgrading them. Indexed copying and its destination
   guard now run only when the table exists; current clone/fork copying remains
   covered by the reviewed temporal tests.
3. **Private-storage policy:** the new doctor backup writer bypassed master's
   shared filesystem helpers. It now uses those helpers, forcing private backup
   directories and manifest files. The existing structural policy guard remains
   unchanged and was mutation-tested.
4. **Master's Rust TTL field:** the temporal mode-switch fixture now supplies
   `cache_ttl_policy: None`, matching master's new `ProducerContext` signature.
5. **An old test asserted the opposite temporal contract:** the cold-flip
   subagent test expected a new `+10m` gap on first sight during SOFT+. Independent
   master compilation passes that old assertion. The reviewed fix deliberately
   defers new temporal choices until rebuilding, including on appended tails.
   The test retains its first-sight tag assertion, now checks that the defer
   lacks the gap, then proves a real pressure-driven subagent execute adds it
   and a following defer replays it exactly. This is an intentional expectation
   change, not a claimed baseline failure. The cleanup mock's prepare count
   similarly changes from 38 to 39 for the added session-owned table while
   retaining its single-transaction assertion.

The existing populated `migrations-v95.test.ts` step-through test now covers
both features together: cached metadata, dropped tags, FTS bytes/rowids/ranks,
map backfill, legacy temporal adoption including an empty choice, index
replacement, a single v95 ledger row, and repeat migration/fresh initialization.

## Gates

Versions: **Bun 1.4.2**, **TypeScript 5.9.3**, **Biome 2.5.1**,
**cargo/rustc 1.99.0**, **rustfmt 1.10.0**. Commands ran in the integration
worktree with throwaway HOME/XDG paths. Unit suites do not export OPENCODE_DB.
Native compilations were serialized and package-scoped with two jobs.

| Gate | Final result |
| --- | --- |
| Root `bun run typecheck` | Passed all six tsc invocations, including the rehearsal script |
| Root `bun run lint` | Passed: 1,236 plugin, 236 Pi, 135 CLI, 6 retina files; four existing warnings, no errors |
| Plugin `bun run test` | **7,103 passed, 5 skipped, 0 failed**, 210,936 assertions, 687 files |
| Pi `bun run test` | **1,554 passed, 3 skipped, 0 failed**, 84,202 assertions, 147 files |
| CLI `bun run test` | Main suite **612 passed, 2 skipped**; four isolated suites **36 passed**; total **648 passed, 0 failed** |
| Dashboard `bun run test` | **131 passed, 0 failed**, 492 assertions, 24 files |
| `cargo test -j 2 -p mc-module -p mc-store` | **1,860 passed, 26 ignored, 0 failed** across 18 test/doc targets |
| `cargo clippy -j 2 -p mc-module -p mc-store --all-targets -- -D warnings` | Passed; checked module/store and their two internal dependency crates |
| `cargo fmt --all --check` | Passed |
| Fresh schema generator / committed fixture comparison | **1 byte-identical comparison** |
| Restored privacy/doctor selection | **16 passed, 0 failed**, after the mutation was removed |
| Diagnostics for both new/changed verification instruments | Authoritative TypeScript results: **0 errors, warnings or hints** |

The first plugin run exposed the four TypeScript interactions above, a
throwaway-HOME double-slash mismatch, and one load-sensitive 200-ms startup
assertion. The normalized-HOME full rerun passes without weakening either test.
The first native compile exposed the TTL fixture field; the subsequent native
run exposed the intentionally changed cold-flip assertion. Both are reconciled
as described above, and the final complete native suite passes.

Additional checks, not substituted for the required gates:

- The broad e2e tsc project has **19 pre-existing errors**. Archived master
  reports exactly the same diagnostics after path normalization, with **0 new
  errors**. Root tsc and authoritative changed-file diagnostics pass. The broad
  errors concern old SQLite adapter types, SDK/test signatures, retina path
  aliases, and a readonly command handler; no unrelated fixes are included.
- A supplementary real-daemon rerun under the exact task TMPDIR raced the
  hostless test's unguarded first probe: `store_opening`, elapsed 629 ms.
  Independently compiled master (fence 94, separate target directory) reproduces
  the same error at the same assertion, elapsed 595 ms. The candidate's isolated
  retry passes **1/1**. The earlier complete native suite passed that test too.
  No retry/test-source change is included for this baseline race.
- An initial shared-target master comparison was discarded because it reused
  candidate Cargo artifacts. The cold-flip baseline and hostless comparison
  above use independently compiled master artifacts, not that invalid run.
- No Linux-only smart-note stall occurred in these Mac package suites. The full
  unrelated Rust e2e marker shard was not required or rerun; no result from the
  separate worker fixing that shard is assumed here.

## Branch e2e probes and byte-identical differential

The only e2e file added/changed by the two input branches is
`packages/e2e-tests/scripts/pi-temporal-drain-probe.ts`; both modes pass on
**Pi 0.87.1** with real context hooks and local provider transport:

| Probe | Literal comparison | SHA-256 |
| --- | --- | --- |
| Physical drain followed by defer | **19 input objects / 13,530 bytes**, three requests | `a9a16d23b3557a188c2f09634661df66468436628999c8c3ce4a47e9f2e1680a` |
| Actual v94 old-handler to v95 restart handoff | **69 input objects / 39,374 bytes**, two requests; frozen m0/m1 unchanged | `d2d9482fbf96155708eab11763c837745d94e63bc565bea18278f912df94b40a` |

The pure-replay differential passes between master and the integrated
production commit in **both the normal mode and `--ts-only` mode**:

```sh
bun packages/e2e-tests/scripts/pure-replay-differential.ts 99ae86b1eb HEAD
bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only 99ae86b1eb HEAD
```

Each ref supplies **four observed defers**. All four comparisons are
**IDENTICAL**, including raw messages, system and tools hashes, and the cached
generation stays unchanged. Message byte lengths are **588, 754, 920, 1,088**.
The normal mode uses the freshly tested module (context fence 95) and the
prepared native daemon as an explicit prebuilt pair. As the differential is
designed to do, its provider requests start in TypeScript mode; this does not
claim a separate native-renderer wire differential.

The instrument now records actual `lsof -p` host descriptors in each ref instead
of relying only on intended environment variables. All OpenCode database and
sidecar paths in all four captures are under the task's throwaway roots. The
last normal-mode host PIDs were **46,949 / 70,754**; TS-only PIDs **2,015 / 2,930**.
The Pi drain PID was **76,536**; old/new handoff PIDs **78,210 / 79,357**. Their
database descriptors likewise contain only the task-local context.db and its
sidecars. No live OpenCode database was copied, so no credential tables or live
configuration were read.

## Large-store worker rehearsal

Disk preflight found **847 GiB free**, above the 60-GB floor. Input is the
pre-existing permitted read-only backup at
`$TMPDIR/magic-context/ckmc-perf/backups/context.db` (**6,155,116,544 bytes**),
not a read of the live store. The instrument takes a new **VACUUM INTO** copy
from a read-only SQLite open, under the task root. Only that copy is writable.
The companion store.db is not needed or copied for a context-only upgrade.

The new reproducible instrument invokes the **real async storage opener and
emitted migration-worker.js**, then closes/reopens the same store for a warm
no-op. It also compiles the actual master's opener into a fence-94 build and
tests that build against the migrated copy, rather than overriding the new
build's fence.

- First v94 async boot: **3,215.787 ms** total; guard **120.505 ms**;
  worker/initialization phase **3,091.573 ms**.
- Warm v95 reopen: **68.547 ms** total; initialization **57.523 ms**;
  **no worker launch or migration body**.
- Worker body starts **16:51:00.195Z**, v95 commits **16:51:01.609Z**, connection
  closes **16:51:01.624Z**: **1,414 ms** start-to-commit.
- Host-thread migration body count: **0** on both opens.
- Ledger: **95**, FTS map: **47,897 rows**, temporal table present;
  quick_check **ok**, foreign-key violations **0**.
- The fence-94 compiled opener returns null, records
  `{persistedVersion:95,supportedVersion:94}`, and emits its clean update/unpin
  refusal. **Three fence assertions** pass; data hashes and schema remain
  unchanged after refusal.

“Cold” here means the first schema-v94 boot, not a purged OS page cache: VACUUM
and the pre-upgrade streaming hash scans have already touched the pages. These
are measured times on a shared machine, not a latency SLA.

Every before/after hash below is identical, including rowids and binary values:

| Table | Rows | Before = after SHA-256 |
| --- | ---: | --- |
| session_meta | 13,735 | `a62919d171735b4c201b2fe9c612954e484840116098e02bde4879faa65e2eaf` |
| tags | 2,070,685 | `9754fbcb49dc7ff9d67ebdc37457c3add6fb5dc7278e3d9c7d10101e81a49d3f` |
| git_commits_fts | 47,897 | `943c2669beef047a466800b5fc1859d70047651c8f99f42b301af47f12140f0a` |
| message_fts_rowid_map | 344,457 | `19d3736208af8b3d4732887f7645357379342f81b78b4056bb24aa06decadd49` |
| transform_decisions | 166,171 | `e84832f87e88c77bc802337381012bf94c03be9ffea6091fcda25e72bbd951ae` |
| plugin_messages | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| user_memory_candidates | 12 | `b8437fc164a089bf37256f245cfdecb80781d2a2d2d66e88a375c4dd0cb7908f` |

`lsof -p 76517` proves the rehearsal host holds only task-local
`rehearsal/context.db` and its WAL/SHM. The large working copy is deleted in a
finally block after checks; the permitted seed is untouched. Synthetic host
database artifacts are removed after verification too. Logs/hashes are retained
under `$TMPDIR/magic-context/bg_7ae47bdd1a6c28df/logs/`, outside the repository.

## Local distributions and landing cautions

Root **`bun run build:dists` passes**, including **four v2 loader tests** and
the plugin/Pi import probes. A static/dynamic import-graph audit checks the
actual emitted entry points, not a leftover unreferenced chunk:

| Entry | Reachable JS files | Reachable fence-95 chunk |
| --- | ---: | --- |
| plugin dist/index.js | 63 | `index-pf1knr9a.js` |
| plugin dist/v2/server.js | 55 | `server-8jyvckyw.js` |
| Pi dist/index.js | 33 | `index-9z9r3zms.js` |

Each graph has exactly one `LATEST_SUPPORTED_VERSION = 95` and no fence 94.
V2's build names its chunks `server-*`, not `index-*`. All three emitted worker
entries are present. Dists remain local and uncommitted; nothing was copied to
an installation directory. No manifests or lockfiles changed.

After the first v95 upgrade, stale fence-94 hosts deliberately refuse the
shared store. Land/deploy the matching updated hosts and worker bundles
together before restarting the fleet. Worker load failures deliberately fail
closed; there is no main-thread fallback. Temporal choices remain engine-owned
across TS/native mode switches, as the reviewed follow-up documents; this
integration does not invent a cross-engine transfer protocol.

The privacy mutation reintroduces a direct mkdir at the actual doctor backup
call site with `NON-VACUITY BREAK`. Exactly
**“owner-only storage permissions > keeps storage filesystem creation behind
the shared helper”** fails; its four named peers pass. Staged live state has an
empty working diff before mutation, **3 additions / 2 deletions** during the
mutation, and an empty working diff after checkout/touch restoration. The final
delivery includes the captured output and peer names; no mutant was built or
committed.
