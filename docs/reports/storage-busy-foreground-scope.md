# Foreground-only SQLite acquisition retry

This revision narrows F3 from the preceding pin report. F2/F4/F5/F6 are retained;
`need_full_sync` additionally receives a fresh full-wire request budget.

## Retry ownership

`packages/plugin/src/shared/sqlite.ts` keeps the common transaction routing and
source fence, but `retryAcquisition` now checks an `AsyncLocalStorage` pass lease:

- **Inside a foreground pass:** three acquisition attempts, with 500/1000 ms
  backoff. The callback never runs before acquisition succeeds and is never retried.
- **Outside a pass:** one native attempt. Its original SQLite error propagates;
  there is no additional sleep or repeated busy timeout. Background writers can
  log failure and try again on their existing next tick.

`withSqliteTransformPass` enters a lease at the OpenCode 1 messages-transform
wrapper, OpenCode 2's whole managed context callback, and direct Rust-mode `run`.
Each explicit entry owns its lifetime, including a nested pass that outlives its
initiator. The lease expires on synchronous return, promise settlement, or error,
so a detached descendant cannot retain retry privileges after its pass has ended.
Concurrent unrelated async work has its own context, not a process-global flag.

`withoutSqliteTransformPass` explicitly detaches maintenance launched from a pass:

- TypeScript FTS reconciliation scheduling, automatic embedding callbacks,
  deferred durable LKG save, authority recovery and fire-and-forget notices;
- Rust deferred LKG capture, memory/compartment mirror projection, and historian
  host-runner pump;
- Historian `startCompartmentAgent`, including its lease renewal timer and cleanup;
- v2 deferred storage-notice delivery and catalog warming.

These jobs cannot borrow an active foreground lease even if they run before that
pass finishes. Existing independently registered background timers/events start
outside the scope already. A regression starts a historian while a foreground
pass remains active, then observes exactly one background acquisition attempt.
A separate red-first regression caught automatic embedding borrowing the lease
(three attempts); both TypeScript and Rust-dispatch embedding launches now detach
and the regression observes one attempt.

The policy remains synchronous: a background acquisition with the production
5-second busy timeout can still block the event loop for about 5 seconds. This
revision removes the extra two waits and backoff; it is not an asynchronous SQLite
conversion. Foreground contention can still spend its approved 16.5-second
acquisition budget, plus scheduling delay.

## Read-only transaction audit

An AST census found **127 `transaction(...)` call sites across 51 production files**
in plugin, Pi and CLI. Callbacks with no direct `.run`/`.exec` were separately
reviewed for indirect writes. In particular, `markTagsCompactedByMessageIds` uses
`UPDATE ... RETURNING` through `.all`, so it is a writer, not a reader. The generic
Pi `runImmediateTransaction(fn)` adapter is write-capable, as are conditional
no-op callbacks that update only when rows exist.

The complete always-read-only production `db.transaction(...)` list is:

| Call site | Read operations | Change |
| --- | --- | --- |
| `packages/plugin/src/v2/store-reader.ts` — `V2StoreReader.window` | `latestCompaction` → SELECT completed checkpoint; `all` → `page` → SELECT message rows | Explicit `.deferred()`; the handle was already opened readonly, but the intent no longer depends on its default mode. |
| `packages/pi-plugin/src/inject-compartments-pi.ts` — `readFrozenM0InputsPi` | Workspace membership/alias/category SELECTs, compartment SELECT, memory/profile SELECTs, project-state and mutation-watermark SELECTs, pure hashing/render metadata | `read()` → `read.deferred()` on its writable handle. |

The Pi helper's transitive getters were checked: `getProjectState` does not call
`ensureProjectState`; workspace resolution only reads membership/aliases; the
memory and profile getters issue SELECTs; `getSessionFactsVersion` is constant
zero. Neither callback performs a durable write.

The Pi change was separately authorized by the parent and committed alone as
`9db6aca32c`. Pi injection tests, mural injection tests, the pinned six-pass Pi
pure replay, and Pi typecheck passed. No other Pi policy code is changed. Pi's
owner can opt its foreground entry into the exported scope API separately; this
revision installs the requested OpenCode 1/2 and Rust entry scopes only.

The existing manual `BEGIN` read snapshot in `materializeM0` is not a
`db.transaction(...)` call and already remains deferred. The Node smoke's
read transaction uses an explicitly readonly handle. Neither gains a writer lock.
A source guard now requires both audited production readers to say `.deferred()`;
a runtime test reads committed WAL data through a writable handle while another
connection owns the write lock.

## Marker fixtures

- `compaction-marker-manager.test.ts` invokes the manager directly, outside a
  pass. Its old **one 5-second timeout** behavior is restored, including the
  original 10-second test ceiling and 4.5-second lower bound. The old-marker
  preservation assertions remain.
- `rust-mode-marker-lock-contention.test.ts` drives the real Rust transform entry,
  so its marker write is **foreground**. It still needs a lock held beyond the
  retry window; the prior 10-second holder and bounded-pass assertion remain.
  The test continues to require served module output with no marker recording.

Classification is based on the invocation's scope, not a permanent label on a
function: the same marker helper can run from foreground or background work.

## Fresh deadline after `need_full_sync`

`sendTransformSeries` now determines full-wire versus delta from the **payload
being sent**, not the original pass's captured `wireDelta`. A `need_full_sync`
response replaces that delta with a full array and therefore starts a fresh
**at least 45-second** execution budget. The existing size-based cold-start budget
can still raise it to 90 seconds; page-upload deadlines remain separate.

45 seconds reuses the established full-wire/materialization floor, leaves room
for a 20-second reconstruction, and avoids raising ordinary deltas beyond their
15-second budget. The inspected host hook paths impose no finite hook timeout.
The original request's timer is cleared on its response; none of its spent time
is subtracted from the full-array call's new deadline.

The red-first manual-clock test primes the module, spends **14 seconds of a
15-second delta** before `need_full_sync`, then takes **20 seconds** on the full
retry. Before the fix, it observed a 15-second full retry budget. With the fix,
the full call starts at t=14s with 45 seconds, completes at t=34s, serves successfully,
uses exactly three transform calls (prime/delta/full), and records no failure.
Restoring the stale delta classification reddens this test.

## Real-host responsiveness evidence

The new OpenCode 2 storage-busy lane registers an independent background writer in
the actual server process. A separate Python process owns `BEGIN IMMEDIATE` on
throwaway `context.db`. Once the background acquisition starts, a read request for
a second host session is issued while the lock remains held.

The first successful run printed:

```
version=opencode v2.0.18
background elapsed_ms=5001.508791
second_session_response_ms=4991.813457999997; lock still held
```

The read therefore completed after the single native wait, without waiting for
lock release or three acquisition attempts. The test does not claim that the
server answers during the unavoidable synchronous 5-second wait itself.
Re-enabling global retries made the same read exceed its 9-second client deadline.
Removing the v2 foreground entry scope separately broke the 7-second recovery
lane, proving the background bound was not obtained by disabling foreground retry.

Every host run supplies `MC_E2E_OPENCODE2_CLI` explicitly and prints that binary's
version. Host/locker descriptors are checked with `lsof`, and the harness checks
its process group and protected-directory metadata. No live stores are opened.

## Verification and delivery

The delivery declaration records the final plugin suite, typecheck, lint, build,
four OpenCode 2 storage-busy lanes, Node smoke, Pi tests/replay, and
`--ts-only origin/master HEAD` pure-replay results. Controlled mutation evidence
is retained in `.cache/storage-busy-task/scope-mutations.json` and in the declaration.

At resume there was one pre-existing untracked file,
`.cortexkit/alfonso/release-notes/FORMAT.md`. The parent explicitly instructed that
it remain untouched and authorized a clean-worktree check excluding that file.
It is neither edited nor committed in this revision.

### Final gate results

- Plugin full suite on the final implementation: **5,963 passed, 3 skipped**, and
  one unrelated `readGitCommits` non-git-directory smoke timed out at 30 seconds.
  Its complete file passed on rerun (**9 passed**), without changing that code or
  its timeout. All scoped-retry, marker, replay and deadline tests passed.
- Detached embedding/historian regression files: **65 passed**. The named-context
  source guard was adapted to inspect both the extracted body and registration;
  a forbidden persistent-tool-registration mutation proves the same invariant
  remains enforced.
- Plugin build, typecheck, lint and real Node SQLite smoke: **passed**.
- Final Pi injection/mural/pinned replay run: **72 passed, 1 child-only skip**;
  six served replay arrays matched the pinned baseline byte-for-byte. Pi
  typecheck also passed.
- Final OpenCode 2.0.18 storage-busy lane: **4 passed, 0 failed**. Background
  acquisition took **5002.647334 ms** and the second session answered in
  **4996.823084 ms**, while the other process still held the write lock.
- **14 controlled mutations** reddened exactly their named tests, including all
  three host entry scopes, background single-attempt policy, detached lease
  expiry/maintenance, historian and embedding launch isolation, readonly intent,
  and the stale `need_full_sync` budget classification. Source and bundle restores
  were checked; no mutation is committed.
- Final-head pure replay is recorded in the delivery declaration after commit.
