# OpenCode 2 generate replay: SQLite corruption diagnosis

## Finding and safety boundary

**The throwaway Linux replay store really becomes corrupt. This is not merely a
read-only connection observing an ordinary concurrent WAL transaction.** A copy
opened after the test process exits still fails `PRAGMA integrity_check`.

The trigger is the test's destructive replay restore: deleting the WAL/SHM and
overwriting the main file while supposedly closed Bun connections still hold
native SQLite handles. There is no evidence here that `synchronous=NORMAL`, pooled
readers, or normal concurrent writes corrupt an untouched shared store. The
unsafe replacement is in `generate.test.ts`, not the production write path.
Nevertheless, the connection-lifetime defect is real and is fixed in the shared
SQLite wrapper, rather than hiding the error in the snapshot reader.

All hosts and SQLite probes used private temporary roots. The runner checks host
and descendant descriptors with `lsof` before and after execution. The generate
test additionally records its host's database descriptors. No live OpenCode or
Magic Context stores or configuration directories were opened.

## Reproduction and causal control

- Retrieved the actual failing job with
  `timeout 40s gh run view 37248225942 --log-failed`. It reports the second replay
  arm's `snapshot(dbPath)` at line 389, `SQLITE_CORRUPT`, 70 passing host tests and
  one failing generate test.
- On macOS, Bun 1.4.2 / OpenCode 2.0.22 reproduces the bad lifetime earlier as
  `SQLITE_IOERR_VNODE` in `isolateStoreDirectories`, during replay boot.
- On Linux arm64 in the existing `mc-e2e-host:1.4.2` Docker image, a worktree
  archive, `bun install --frozen-lockfile` (994 packages), and a fresh plugin build
  reproduce **the exact CI failure** at the second arm's line 389. The CLI reports
  `opencode v2.0.22`; Bun reports `1.4.2 (744846f84)`. The image is only a toolchain
  base: the test executes this checkout's plugin and runner, not the image's old
  plugin artifacts.
- Reverting only the runtime hunks of **116d3ff741** in `storage-db.ts` and
  `storage-meta-shared.ts` makes the Linux generate test pass. Restoring those
  hunks makes it fail again. All other audit changes, including b405b270fa's
  schema-column cache and the OpenCode reader pool, stay enabled in this control.
- Independently changing the context writer policy back to `synchronous=FULL`
  does **not** fix the failure: the same generate test still reports
  `SQLITE_CORRUPT`. The delivered fix leaves WAL/NORMAL unchanged.

The causal audit commit is 116d3ff741's retained `prepare()` statements. The
other new schema cache also retains a preparation and needs the same lifecycle
guarantee; a passing revert control is not evidence that every remaining cache
has correct teardown.

## Mechanism and affected connections

Bun's `Database.close()` closes the JavaScript handle, but unfinalized statements
created by `prepare()` defer SQLite's native close. `query()` statements are
connection-owned; unowned `prepare()` statements kept in JS caches are not.
WeakMap caches do not help while the database object is still reachable, and GC
is not an acceptable synchronization barrier for replacing database files.

Two test-process connections matter:

1. `prepareContextDatabase()` calls the shared `openDatabase()` factory before
   every host boot. The new `healWedgedChannel2Claims` cache retains SELECT/UPDATE
   statements, and column discovery retains `PRAGMA schema_version`. Clearing
   the factory's map in `closeDatabase()` did not release the native handles.
2. The generate test's direct `bun:sqlite` writer seeds `compartments`, updates
   `tags`, and calls `clearCachedM0M1`. That call reaches `ensureSessionMetaRow`,
   which now retains its metadata-existence SELECT. The local `db` variable stays
   reachable throughout the async test, even after `db.close()`.

Temporary instrumentation captured native descriptors after both host shutdown
and `closeDatabase()`. Before the first and second restores, the parent still
had `context.db`, `context.db-wal`, and `context.db-shm` open. After the restore,
`lsof` explicitly labeled the old WAL/SHM descriptors **`(deleted)`** while new
connections were opening the same main-file inode. Reopened connections were
therefore mixing old pager/shared-memory state with a restored database and new
WAL generation. The first failing table scan was **`session_meta`**. On an
independent post-exit copy, both `session_meta` and `sqlite_sequence` fail scans.

The instrumented run saved the pre-replay main-file bytes separately. Opening
that saved copy yields `integrity_check = ok`; opening the post-failure database
and its sidecars yields `database disk image is malformed`. A main-file-only
copy also fails. This rules out a permanently bad initial fixture and a harmless
read-only snapshot race.

### Syscall evidence: a supposedly closed parent writes stale pages

A separate unfixed run under Linux `strace 6.13` identifies the actual writer.
The test process is PID 73; its original factory connection opened main-file
descriptor 11 and WAL descriptor 12. These are not host-process descriptors.

The parent restores 1,052,672 main-file bytes at `01:43:09.396607` and again at
`01:43:12.890870`. After the test has printed its failure summary, the deferred
native close checkpoints the **deleted old WAL**:

```text
01:43:15.697562 fsync(12<.../context.db-wal>(deleted)) = 0
01:43:15.709178 pwrite64(11<.../context.db>, "\n...", 4096, 12288) = 4096
01:43:15.709244 pwrite64(11<.../context.db>, "\n...", 4096, 565248) = 4096
01:43:15.711073 ftruncate(12<.../context.db-wal>(deleted), 0) = 0
```

`sqlite_master` assigns root page 4 to `sqlite_sequence` and root page 139 to
`session_meta`. With 4096-byte pages, those are exactly offsets 12288 and 565248.
The traced post-exit copy contains **0x0a (index-leaf pages)** at those table
roots, rather than table-leaf pages, and fails integrity checking. The stale
checkpoint is observable disk damage, not just a hypothesis about WAL readers.

The OpenCode pool reads the host's `opencode2.db`, not `context.db`. Host writers
also update the isolated context store during prompts, but the destructive
overwrite and the traced stale checkpoint are performed by the test process.

## Fix and regression coverage

- The shared Database wrapper owns every Bun preparation for teardown, using
  weak references plus a finalization registry so one-shot preparations are not
  retained for the life of a host. It finalizes surviving statements before
  native close and preserves transaction/admission routing. Node already owns
  its preparations on close and has no `finalize()` method, so it keeps its native
  behavior.
- `prepareCachedStatement` supplies the same ownership for caches accepting a
  direct Bun handle. The metadata-existence cache uses it, covering the seed
  writer without changing the existing-row fast path.
- The generate test asserts and records the parent's real descriptor inventory
  before snapshotting/restoring stores. It checkpoints both stores before saving
  main-file bytes, because the runner kills the host and committed WAL frames
  must not be discarded. It integrity-checks those snapshots. The original
  read-only `SELECT *` snapshot and every replay/provider-byte assertion remain.
- Two POSIX regression tests exercise real native handles, prove that `lsof`
  finds them while open, keep JS handles reachable across close, and require
  descriptor release without GC. They also restore bytes and integrity-check the
  replay. Windows skips these two descriptor-inventory tests because it has no
  `lsof`; the normal SQLite tests remain platform-independent.

The new regressions fail before the fix. The fixed generate test passes on both
macOS and Linux, including repeated side-request byte equality and the next main
provider body comparison. Existing lease healing, no-op writer admission, schema
invalidation, WAL/NORMAL, and the real Node SQLite smoke remain passing. The
delivery record includes narrowly targeted mutation controls for teardown.

The existing exclusive-lock boot test initially failed after genuine descriptor
teardown: initialization now encounters the held lock and rejects with the
already-established `storage unavailable: database is locked` error. Disabling
teardown makes its old successful-open expectation pass again. The test still
asserts the original sub-second bound, but now also requires the fail-closed
rejection while an exclusive lock is held. This is an intentional strengthening
of the test contract, not a relaxation to accept a new failure.

Plugin typechecking passes. The whole e2e package's standalone `tsc` invocation
reports 24 unrelated errors in existing probe scripts, Rust tests, other OC2
tests, and imported plugin dependencies. None is in `generate.test.ts`; the
changed test is also checked directly with the same TypeScript compiler/project
options. Those unrelated errors are left untouched.

## Retained local evidence

These are diagnostic artifacts, not release output or live stores:

- `/tmp/mason-oc2-ci-failed.log`
- `/tmp/mason-oc2-local-baseline.log`
- `/tmp/mason-oc2-linux-baseline.log`
- `/tmp/mason-oc2-linux-revert-116d.log`
- `/tmp/mason-oc2-linux-instrumented-baseline.log`
- `/tmp/mason-oc2-linux-full-control.log`
- `/tmp/mason-oc2-linux-fixed.log`
- `/tmp/mason-oc2-linux-syscall-test.log`
- `/tmp/mason-oc2-syscalls/tmp/mason-oc2-syscalls.73` (parent syscall trace)
- `/tmp/mason-oc2-linux-instrumented-root/` (healthy saved image and failed store)
- `/tmp/mason-oc2-linux-syscall-root/` (post-checkpoint corrupt store)

The retained Docker containers are `mason-oc2-corruption` (original failure),
`mason-oc2-diagnosis` (controls and final fixed run), and `mason-oc2-trace`
(unfixed syscall reproduction). Only temporary container/filesystem roots were
used; no dependency manifest or lockfile was changed, and no dist is committed.
