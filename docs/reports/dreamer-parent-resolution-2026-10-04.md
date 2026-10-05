# OpenCode 1 scheduled Dreamer parent resolution

## Diagnosis

`createChildSessionWithFence` in
`packages/plugin/src/hooks/magic-context/child-session-spawn.ts` logs
`child session deferred: no parent session is available`. It returns `null` for
an unparented Dreamer child on a visible host. `verifyOneBatch` interprets that
as `Could not create verify session`, and previously repeated it for every batch.

The scheduled path is `dream-timer.ts:sweepProject` →
`createDreamTaskExecutor` → `resolveParentSessionId` → the host SDK's
`session.list`. This is **not** the process-local project registration map or
Magic Context's `session_projects` table. OpenCode 1.18.30's route reads the
host's persisted session table, which remains populated across `serve` restarts.
The registration map chooses the checkout and client, not the parent session.

The old request supplied only `directory`. The exact host's
[`session.list` handler](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L64-L74)
and
[`listByProject`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/session.ts#L955-L1006)
show two ways that request misses an existing ordinary project session:

1. It filters to the timer's **exact checkout directory**, not all worktrees of
   the project. A conversational session in the main checkout does not satisfy
   a sibling checkout's lookup.
2. The host returns the **100 most recently updated sessions** by default,
   including children. Filtering children and internal titles *after* this
   limit can discard the whole result even with an older ordinary root present.
   Older, leaked internal root sessions can also fill a root-only page.

The fix asks the host for `scope=project&roots=true`, retaining `directory` to
select the correct host project/instance. It grows the root prefix beyond 100
when necessary to exclude old internal roots. It still excludes children and
`magic-context-*` titles, never chooses another project's session, shares the
lookup promise across concurrent tasks, and rechecks after a missing parent.
Lookup exceptions now get a diagnostic rather than being silently swallowed.

These are reproduced against a throwaway host, not inferred from a live-store
query. Live stores and live configuration are forbidden for this investigation;
therefore the reporter project's actual directory/session counts are not
claimed. The allowed log was found at the `getconf DARWIN_USER_TEMP_DIR` path
in the brief. It also contains a 01:29Z deferral and dead-checkout registration
messages, before the supplied 01:58Z excerpt.

## Introduction and deployment timing

The directory/default-limit lookup predates this incident (promise-based
lookup: `9fb9f53c3d5`, June 24). Commit
`e880c528ebef4bebd5cb8d0adb26461e02c35afe` (September 30), merged as
`6a5916170e`, introduced the ordinary-root selection and the refusal to create
unparented Dreamer sessions. That made a missed lookup fatal instead of leaking
a visible background root. `339fc8fe27` retained the guard and exempted only
Pi's explicitly invisible, process-local sessions.

The guard is an ancestor of `9b6c4903a9fcc82a72155d4114aa8c56bdd894c4`.
Given the supplied restart timeline, the October 3 11:41Z restart activated
the stricter behavior in the long-lived fleet processes. Copying master dist
files at 13:34Z does not reload already imported JavaScript. The first scheduled
window after that restart is consistent with the first failures that night;
this is not evidence that the host lost its persisted sessions on restart.

## A genuinely parentless project

Skip the **whole task once**, with
`no ordinary parent session is available on this host`, before task cursors,
batch invocations, or model requests. The existing scheduler records `skipped`,
moves to the next cron slot, resets retry count to zero, and leaves the last
successful-run watermark and backlog unchanged. A later manual run or scheduled
slot can discover the first ordinary session. No unparented OpenCode root is
created. Hidden completion carriers and Pi's process-local sessions retain
their exemption. This follows the existing issue 587 requirement to wait for
an ordinary session, rather than undoing the session-visibility fix.

## Isolation and verification

No schema or migration changes are needed. The reproducer initializes only an
in-memory Magic Context fixture with the existing schema/migrations; OpenCode's
normal first boot initializes its own **throwaway** database. It never opens a
live store or live config. All HOME/XDG paths, `OPENCODE_DB`, and
`MAGIC_CONTEXT_STORAGE_DIR` are beneath `$TMPDIR/magic-context/<probe-run>/`.
The host and runner's `lsof` snapshots are retained, with an assertion that
every database descriptor is under that root and that at least one host
database is present.

Reproducer: `packages/e2e-tests/scripts/probes/dreamer-parent-resolution.ts`.
It uses the real SDK, task executor, scheduler, child-spawn fence, verification
transport, and memory-apply path with OpenCode 1.18.30 and a loopback mock
provider. It does not simulate Desktop or the nightly wall clock; it drives
the same scheduled executor without supplying a parent, unlike manual
`/ctx-dream` probes that already have a conversational parent.

### Results

- Failing first: the new sibling-checkout and leaked-root lookup tests both
  returned `failed` against the old resolver. The parentless scheduler test
  exposed `tasks_failed=1` rather than a skip. No existing behavioral test was
  reversed or renamed.
- `timeout 180 bun test` on `task-executor.test.ts`, `task-scheduler.test.ts`,
  `verify.test.ts`, and `child-session-spawn.test.ts` (plugin cwd): **116 passed,
  0 failed**, Bun **1.4.2**, 611 assertions. The restored parent-resolution
  subset also passes after the mutation controls below.
- `timeout 180 bun test src/dreamer/index.test.ts --timeout 30000` (Pi cwd):
  **43 passed**, 116 assertions. The invisible process-local exemption works.
- Plugin `timeout 180 bun run typecheck`: **passed**, TypeScript **5.9.3**
  (retina build types, plugin `tsc --noEmit`, and script types).
- Plugin `timeout 240 bun run build`: **passed**, Bun **1.4.2**; both v1/v2
  bundles, declarations, and **4 v2 loader tests**. Generated tracked TUI files
  were unchanged.
- Biome **2.5.1**: scoped plugin check **2 files passed**; probe check
  **1 file passed**, no warnings in the final version. Full plugin lint has
  **3 pre-existing import-order errors** in `config/schema/magic-context.ts`,
  `hooks/magic-context/historian-expand-tools.test.ts`, and
  `hooks/magic-context/read-session-chunk.ts` (1,192 files checked). They were
  not changed.
- Standalone `tsc --noEmit --strict --target ESNext --module ESNext
  --moduleResolution bundler --esModuleInterop --skipLibCheck
  --types bun-types,node --resolveJsonModule` on the probe: **passed**.
  Applying that extra check to the entire executor test file finds **3 existing
  test-only errors outside the new describe block**: a narrow backlog type
  omits `totalAtStart`/`totalAtEnd`, and an inferred retrospective mock omits
  `readUserMessagesBefore` at its assignment and transport call. Git blame
  attributes those lines to June/August/September commits. The repository's
  production typecheck excludes test files and passes; no unrelated test
  typing cleanup was included.
- AFT inspection was **partial** (Biome unavailable to the producer and no
  timely TypeScript diagnostics for the executor). Command-line gates above
  are the authoritative checks, not an empty diagnostics result.

### Real host evidence

`timeout 240 bun packages/e2e-tests/scripts/probes/dreamer-parent-resolution.ts`
passed **3 scenarios** on **OpenCode 1.18.30** (Bun **1.4.2**):

1. An ordinary root in the main checkout, behind **100 recent children** and
   **100 leaked internal roots** in a sibling checkout, was resolved without a
   supplied parent. The original directory-only request returned 100 children.
   The fixed request used root/project filters and prefixes of 100 then 200.
   The task created `ses_efb3acfd8ffeMs2f0M24H5Fj6g` with
   `parentID=ses_efb3ad16dffemyjwuKefIkinwv`, verified the seeded memory, and
   recorded a completed invocation with **200 input / 80 output tokens**.
2. A distinct project with no ordinary session skipped exactly once, with no
   new child, provider generation, failed run, retry, broad-cycle cursor, or
   verification timestamp change. Its next cron slot advanced and its
   successful-run watermark remained null. An immediate second tick ran zero
   tasks. It did not borrow the other project's parent.
3. Creating that project's first ordinary session let the same executor
   discover it and complete the next forced-due verify task with a parented
   child. Negative lookup results are not permanently cached.

Final artifacts are in
`$TMPDIR/magic-context/dreamer-parent-resolution-jZ1gGt/`: `evidence.json`,
`host-before-lsof.txt`, `host-after-lsof.txt`, `runner-lsof.txt`, host and
Dreamer logs. Host PID **93386** held only that root's
`data/opencode/opencode.db` and its WAL/SHM; the runner held no file-backed DB.
No live-store read, write, migration, or live configuration access was used.
The first probe trial's 20-output-token mock hit the existing near-zero-output
provider-outage safeguard; the successful mock uses 80 output tokens. No
production provider-output validation was changed for the probe.

### Non-vacuity controls

Each control was labeled as a non-vacuity break, applied only after staging the
live implementation, and restored with `git checkout -- <mutated path>` plus
`touch`. Each working diff was non-empty during mutation and empty afterward.
All controls targeted `dreamer/task-executor.ts`:

- Omit `scope=project`: only **finds an ordinary project root outside the
  checkout and behind recent children** reddened; the other five
  parent-resolution tests passed.
- Return after the first root prefix: only **looks beyond a full page of
  leaked internal roots** reddened; the other five parent-resolution tests
  passed.
- Disable the task-level parentless skip: only **skips a parentless
  verify-broad task once without consuming retries or its backlog** reddened
  in the selected five-test control (the two successful-parent tests, hidden
  process-local test, and concurrent lookup test remained green).

Deployment requires rebuilding and restarting the affected `opencode serve`
processes. This change does not rewrite old leaked roots, modify live stores,
or restart the fleet itself.
