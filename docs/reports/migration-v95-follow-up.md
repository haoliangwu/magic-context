# Migration v95 follow-up verification

This record accompanies the fixes for B1/S1/S2/S3 in
`docs/reports/migration-v95-review.md`. The continuation merge recovered the
interrupted implementation and its earlier measurements. Those measurements
remain in `docs/designs/perf-audit-migration-batch.md`; the checks below are new
runs against the continuation, including the merged private-storage changes.

## Isolation

Live-store isolation, verbatim: never open/read/write/migrate the live stores.
No live OpenCode/Magic Context database or user configuration is used. All test
and host HOME/XDG/TMPDIR/storage paths are fenced below
`$TMPDIR/magic-context/migration-v95-follow-up-bg_9a93f47f4bc5a770/`.
The only permitted large input is the pre-existing read-only backup pair at
`$TMPDIR/magic-context/ckmc-perf/backups/{context,store}.db`. Only disposable
clones may become writable; host-process-group lsof inventories must contain
only database/sidecar paths below the resolved throwaway root.

## B1 — fail closed when the worker cannot load

The async opener rejects worker construction/loading/early-exit errors and
incomplete worker results, without calling the synchronous migration runner.
The explicit synchronous opener remains available to offline CLI/tests. Host
tool/RPC/timer paths use the current-schema-only opener, so registration after
failed async boot cannot accidentally perform the rejected migration itself.

The former fallback-success test intentionally asserts refusal instead: an
unloadable worker must leave the ledger at 94 and the main-thread body counter
unchanged. A further test covers a worker claiming completion before `ready`.
Non-file-backed async opens are rejected before any file/permission setup, so
private-storage creation cannot leave a literal `:memory:` file in the checkout.
The in-memory refusal test also checks the absence of that artifact.
The two timer lifecycle fixtures now explicitly establish current storage before
registration, as actual host boot does; their overlap/replacement assertions are
unchanged. They previously failed because they implicitly expected registration
to upgrade a cold store. A default 5-second dream-trigger timeout in the first
combined run also disappeared with the package's normal 30-second timeout.

Fresh checks (Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1):

- Worker and OpenCode 1/2 boot refusal tests: **13 passed**, 40 assertions.
- Timer/dream-trigger tests after fixture correction: **26 passed**, 79 assertions.
- Initial combined storage/tool/timer/worker run: **112 passed, 3 failed**; the
  three impacted failures above were corrected/rechecked without weakening the
  refused-boot contract. Storage/tool tests passed in that run.
- Actual Pi extension/context-runner refusal: **1 passed**, 10 assertions.
- Plugin typecheck: all **3 tsc projects passed**. AFT reports no TypeScript
  diagnostics, but is partial because its Biome producer is unavailable.
- Pi/CLI plain typechecks expose an unrelated merged-baseline TS2868 error:
  `shared/storage-permissions.ts:151` references `Bun`, while these packages
  specify only Node types. No unrelated production change is included. Pi passes
  its normal script with `--types node,bun`; CLI passes with
  `--typeRoots ../plugin/node_modules/@types,node_modules/@types --types node,bun`
  (CLI does not install its own Bun types).
- `bun run build:dists`: **4 loader tests**, **3 import probes**, OpenCode 1/2
  and Pi worker bundles emitted. CLI build: **401 modules**. No mutant was built.
- Plugin lint: **1,224 files checked**, no errors/fixes; two existing warnings
  (one unused import in the merged RPC handler) and two unrelated infos.

Independent mutation controls used staged live state and the exact
`NON-VACUITY BREAK` marker, a nonempty working diff, checkout/touch restoration,
then an empty working diff:

1. Restore a main-thread fallback only for pending v95 after worker failure:
   **“a worker that cannot load refuses pending v95 without a main-thread
   fallback”** alone fails because the promise resolves; **10 peers pass**.
2. Let current-only host access cold-migrate again: **“OpenCode 1 async boot
   records worker-load failure and refuses the primary transform”** alone fails
   because registration advertises five tools; the **OpenCode 2 peer passes**.

Restored worker/host tests pass. Detailed mutation output and diff-stat evidence
are included in the delivery declaration, not inferred from the green suite.

## S1 — offline map diagnosis and paired-backup repair

```sh
magic-context doctor git-fts-map
magic-context doctor git-fts-map --repair [--backup-root <directory>]
```

Diagnosis takes a read-only inventory snapshot and reports missing, mismatched
and extra map rows. Repair refuses active/uncertain holders, acquires IMMEDIATE
locks on **both** stores, rechecks holders, VACUUMs and quick-checks a backup
pair, then rewrites **only** the map inside the context transaction. The store
lock is rolled back without data changes. Backups explicitly require restoring
both stores or neither. Repair preserves the FTS corpus/rowids, rendered
metadata and migration ledger; both anti-joins and SHA storage classes are
verified before commit. Migration replay refusal names this exact command.

Three new tests introduce missing/extra/wrong-storage-class map entries during
the rewrite using disposable map triggers. They exercise the **real** verifier,
not its injected-failure seam, and assert rollback with the verified backup
retained. Each corresponding verifier mutation reddens only its named test
(**10 peers pass**). This demonstrates both anti-joins and the type check are
live controls. The existing holder, backup-before-write and FTS/ledger
preservation tests remain unchanged.

Fresh verification:

- Doctor/help run: **29 passed**, 129 assertions (Bun 1.4.2).
- Restored doctor tests: **11 passed**, 46 assertions.
- CLI lint: **135 files checked**, no errors; one unrelated warning/info.
- CLI tsc passes using the documented baseline Bun-type workaround.
- Actual emitted CLI under **Node v24.16.0 / SQLite 3.53.0**: **9 checks passed**.
  Damaged diagnosis exits 1, repair exits 0, post-diagnosis exits 0. Independent
  reads find ledger **94**, numeric FTS row **7 / 123**, integer map SHA, unchanged
  companion store and an empty pre-repair backup map. Driver lsof proves only
  throwaway context/store/backup files and sidecars were opened.

## S2 — unshipped v95 DDL preserves SHA storage classes

The map declares `sha BLOB`, SQLite's no-coercion affinity. v95 is corrected in
place: no conversion migration, v96 or store.db lane change. The numeric probe
`(rowid=7, sha=123, project_path='project', message='numeric legacy')` keeps
integer storage in FTS and map through first migration and lost-ledger replay.
Public text SHA `'123'` insertion/deletion leaves that numeric orphan alone,
matching the pre-v95 behavior. Repair verification also rejects equal-valued
integer/real pairs whose storage classes differ.

Fresh verification:

- Changing only the map DDL back to TEXT reddens **“numeric legacy FTS SHA
  survives migration and replay without matching a text SHA”**, with map type
  `text` instead of `integer`; **9 peers pass**. Staged-state/diff-stat/restore
  proof is in the delivery declaration.
- Restored migration/armed replay/v38/fence/tag-trim/public git API tests:
  **29 passed**, 652 assertions across seven files (Bun 1.4.2).
- `bun scripts/dump-context-db-schema.ts` regenerated the runtime schema into a
  disposable file. Independent comparison matches the committed **v95** fixture
  exactly (**1 comparison**). The continuation merge already carries that fixture
  and the original v95 index-sensitive Rust domain hash updates.
- **cargo 1.99.0** fingerprint test:
  `cargo test --offline -j 2 -p mc-module --lib domain_fingerprints_match_the_committed_schema_snapshot -- --nocapture`
  ran **1 test, passed**. It recomputes Rust domain hashes from the actual schema
  fixture. The project-owned git map is not a Rust domain table, so BLOB versus
  TEXT needs no additional domain hash change.
- `cargo fmt --all --check`: passed (rustfmt **1.10.0**).

The first `--locked` native check refused because isolated sibling path packages
advanced independently of the committed lock (subc-core 0.20.55→0.20.56,
subc-daemon 0.31.1→0.32.0, subc-os 0.1.5→0.1.6). The scoped check used temporary
offline resolution, then restored the staged original Cargo.lock. No dependency
or lockfile upgrade is part of this delivery; no network install was attempted.

## S3 — full-size host, holder and restart observations

Preflight found **193 GiB free**. The permitted read-only snapshots are
**6,155,116,544 bytes** (context.db) and **1,108,799,488 bytes** (store.db).
Owner-read-only APFS seed clones live in a private throwaway root; each host
receives its own writable clone of **both** stores. No source permissions or
contents are changed. The context corpus is v94 with **2,070,685 tags**,
**344,457 message-map rows**, **47,897 git FTS rows**, and **13,735 metadata
rows**. The instrument rejects a writable or undersized seed rather than
silently treating a synthetic host fixture as a full-size rehearsal.

The fresh standalone actual-runner rehearsal took **7,321.072 ms** through
commit, with a **4.292 ms** no-op. Streaming metadata/tag/FTS-with-rowid hashes
are identical before/after; quick_check is `ok` and foreign-key violations are
**0**. That transaction is intentionally in the **driver**, not a host; it is
not substituted for the worker/health measurements below.

### Measurement controls and the initial failed health budget

The initial host instrument used a timer in its own SDK-driving process. Its
OpenCode 1 alone/reader/restart cases passed, but OpenCode 2 alone recorded a
**2,142 ms** completion gap overlapping the end of the worker interval and
aborted the matrix. The worker closed at **18:47:06.063 UTC**; the four timed-out
probes began at **06.221, 06.472, 06.723 and 06.974**, all **after close**. The
last pre-close success was **05.968**, next success **08.110**. There were no
timed-out probes overlapping the migration body. This is real failed startup
responsiveness evidence, not a main-thread migration counterexample, and is
not discarded in favor of a faster run.

The final instrument puts 250-ms/1-second-timeout probes in a **separate Bun
process**, preventing SDK/module work in the driver from suppressing observations.
Its regression test deliberately occupies the driver's event loop and proves
requests are still scheduled during that interval. Neutralizing the probe timer
reddens only **“health sampler schedules requests even while the rehearsal
driver is busy”**; restored test **1 passed**, four assertions. A second named
preflight control rejects zero tags before any host launch with
`full-size-host-seed-corpus-floor`; its staged source is restored before
measurement. The named opt-in test **“full-size host preflight validates the
read-only v94 rehearsal corpus”** alone reddens, with the sampler peer passing.
It is opt-in so ordinary tests never need or discover a developer's large stores.

The script retains the one-second budget check, but now applies it **after**
recording the complete host/holder/restart matrix, so a failed budget cannot
erase the remaining requested evidence. Worker start, ready receipt, v95 start,
COMMIT and connection close are all recorded with raw health samples. Both
worker-start→close and migration-body→close gaps are reported. Corpus counts
are independently read and asserted on each host's actual file before/after
upgrade and restart. All lsof process-group output is retained, with PIDs in
the report; every DB/WAL/SHM path must be under the resolved private root.

### Completed independent-observer matrix

All dates below are **2026-10-05 UTC**. The emitted plugin is the fresh build
from this continuation. The driver checks each executable's exact version:
**OpenCode 1.18.30** and **2.0.22**. Each context starts from a fresh full v94
clone and ends at 95 with the three corpus counts unchanged. This repeat reuses
the per-case **synthetic** OpenCode stores/caches from the initial attempt;
it is warm/load-sensitive evidence, not an unconditional cold-boot health SLA.
The initial 2,142-ms gap remains part of the result.

| Host / case | Worker start → COMMIT → close | Body start→close ms | Probes / during body | Longest worker/body-overlapping gap ms | Whole-startup gap ms / failures |
| --- | --- | ---: | ---: | ---: | ---: |
| 1.18.30 alone | 18:58:15.435 → 15.780 → 15.783 | 298 | 9 / 1 | **302 / 302** | 302 / 0 |
| 1.18.30 reader holder | 18:58:21.088 → 21.366 → 21.369 | 264 | 9 / 1 | **309 / 309** | 309 / 0 |
| 2.0.22 alone | 18:58:26.562 → 26.914 → 26.917 | 316 | 11 / 1 | **250 / 250** | 336 / 0 |
| 2.0.22 reader holder | 18:58:32.190 → 32.468 → 32.470 | 267 | 11 / 1 | **274 / 274** | 439 / 0 |

Worker-ready receipt times are **15.447, 21.100, 26.572, 32.198** respectively.
All four initial opens and all four restarts log **main-thread migration-body
count 0 (total=0)**. The restarts use the **same full v95 files**, with **no
worker launch or applied-v95 log**, unchanged corpus counts, and zero failures:

| Restart | Successful probes | Longest gap ms |
| --- | ---: | ---: |
| 1.18.30 alone | 7 | 311 |
| 1.18.30 after reader holder | 7 | 331 |
| 2.0.22 alone | 8 | 271 |
| 2.0.22 after reader holder | 8 | 294 |

The holder is a separate Bun process pinning a **v94 read snapshot** on the
same working copy throughout migration. Its handle is read-write solely for
WAL/SHM bookkeeping; its statements are BEGIN/SELECT only. This is an open
reader/holder case, **not** a writer-lock admission latency measurement and not
a bypass of the older-host migration guard.

### lsof proof

`timeout 30 lsof -g <group-pid> -Fn` covers the actual host and all descendants,
not just the timeout wrapper. The independently validated raw captures name:

| Case | Group / actual host PID | Holder group / actual PID | Restart group / actual host PID |
| --- | --- | --- | --- |
| 1.18.30 alone | 55282 / 55283 | — | 55811 / 55812 |
| 1.18.30 reader holder | 56241 / 56242 | 56190 / 56191 | 56686 / 56687 |
| 2.0.22 alone | 57086 / 57088 | — | 57536 / 57537 |
| 2.0.22 reader holder | 57934 / 57935 | 57879 / 57882 | 58367 / 58368 |

Every host/restart capture has exactly these **six unique database paths**,
relative to
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/migration-v95-follow-up-bg_9a93f47f4bc5a770/hosts/`:

```text
<case>/context/context.db
<case>/context/context.db-wal
<case>/context/context.db-shm
<case>/opencode.db       # OpenCode 1; opencode2.db for OpenCode 2
<case>/opencode.db-wal   # OpenCode 1; opencode2.db-wal for OpenCode 2
<case>/opencode.db-shm   # OpenCode 1; opencode2.db-shm for OpenCode 2
```

Cases are `health-v1`, `health-v1-reader-holder`, `health-v2` and
`health-v2-reader-holder`. Each holder capture contains only its case's three
context.db paths above. No live database descriptor is present. Each full-size
store.db clone is present but **not opened by these TypeScript hosts**; only
context.db needs the v95 upgrade.

Fresh verification: the completed matrix exits **0**, with **4 upgrades / 4
no-op restarts**, **40 initial / 30 restart health responses**, zero timeouts and
an empty one-second budget-violation list. An independent **Node v24.16.0** audit
passes **62 checks** over actual report/corpus counts, zero-body logs,
start/commit/close ordering, every raw lsof capture versus its reported file
set, holder identity and paired store-copy sizes. Plugin tsc passes all three
projects; Biome **2.5.1** checks **1,225 files**, no errors (the same baseline
warnings/infos). AFT remains partial, not a clean diagnostic claim.
The restored observer plus opt-in preflight tests pass **2/2**, five assertions.

Reproduction, after preparing the permitted read-only seed pair and fencing
the driver's HOME/XDG/storage environment as above:

```sh
timeout 1800 bun packages/plugin/scripts/perf-audit/migration-batch-hosts.mjs "$ROOT" --health-only --full-size-health
```

For the recorded repeat, the verified standalone rehearsal record was retained,
the initial failed health/sample records archived, and `health`/`wire` lists
reset to empty before adding `--skip-rehearsal` to that command. A skipped
rehearsal does not itself reset an existing partial health list.

Raw samples, original failed-run records, final `hosts.json`, and `lsof-<group>.txt`
captures are retained in the private task root. Database copies are disposable;
the permitted source pair remains untouched. No live service is restarted,
binary installed, or live-store migration performed. No fresh Pi full-size run
or provider-body differential is claimed here; B1's actual Pi refusal and the
earlier separately recorded rehearsal are not conflated with this host matrix.

### Additional native verification

The recovered Rust HostStore/fence changes were checked too: **28 HostStore
tests passed, 2 measurement-only tests ignored**, with one path-resolution test
initially failing because the worker's explicit `MAGIC_CONTEXT_STORAGE_DIR`
ended in `storage` rather than the test's assumed default `magic-context`.
Rerunning **only that test** with the override unset (HOME/XDG still fenced)
passes **1/1**. The supported-fences ceiling test passes **1/1** at context 95.
No assertion or production path resolver was changed.

During those checks sibling path crates also advanced cortexkit-lease
0.1.0→0.1.1 and cortexkit-store 0.2.1→0.2.2. All native checks used temporary
offline lock resolution and restored the staged original Cargo.lock afterward.
The completed host repeat overlapped the beginning of the scoped native build;
its figures therefore include ordinary shared-machine contention, not an
unloaded-machine promise. No broad native workspace build/clippy suite was run.
