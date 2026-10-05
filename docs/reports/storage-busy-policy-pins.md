# Storage-busy adversarial pins: F2–F6

> The subsequent [foreground-scope revision](storage-busy-foreground-scope.md)
> narrows F3's retry policy, makes read-only callers explicit, and adds a fresh
> full-array budget after `need_full_sync`. The records below describe this pin
> delivery before that follow-up.

This follow-up implements the pins in `storage-busy-policy-gate.md` on the gate
branch. The original report describes the initial `38a6a6cd` delivery, not the
corrected acquisition coverage or fallback behavior below.

## F2 — immutable TypeScript LKG capture

**Reproduced red:** `captures entry digests before live tagging mutates the host
messages` captured an entry projection, changed its live text to a tagged managed
representation, then attempted replay against the original host messages. The
old lazy closure produced `lkg_content_mismatch`.

`projectLkgEntry` now calculates the digest at entry and keeps only that immutable
string in its non-enumerable accessor. It no longer retains a closure over live
message objects. These are the digests of the **pristine host input** needed to
validate the next host reconstruction. Separately, the existing capture serializes
the **served managed output** into `jsonPrefix`; the two representations must not
be confused. A late tag/heuristic mutation cannot alter either stored value.

The real OpenCode 2.0.18 test serves a normal first turn, holds a write lock from
another process during the second context hook, and requires all of:

- A primary provider request for the busy turn, rather than a refusal;
- `lkg_replay_served`, with no `lkg_content_mismatch`;
- Every message in the prior served array is byte-identical to the corresponding
  prefix of the replayed array;
- The complete served system array is byte-identical too (F6 below).

The second turn naturally has new tail messages; the test does not falsely claim
that an appended user turn leaves the total array length unchanged. The unit
reproduction also tests whole-array byte identity with unchanged host input.

Reverting to the lazy digest closure makes both the unit test and the actual
2.0.18 host test fail. Restoring the implementation makes them pass.

## F3 — one acquisition retry for every shared write transaction

**Reproduced red:** four real file-backed tests held the writer lock in a separate
process beyond `busy_timeout=50`: default `transaction()`, `.immediate()`,
`.exclusive()`, and literal `exec("BEGIN IMMEDIATE")`. Each previously failed
before the lock holder released it.

`shared/sqlite.ts` now installs transaction routing on **every Database instance
it exports**, under both Bun and Node:

1. Standalone `BEGIN IMMEDIATE` / `BEGIN EXCLUSIVE` through `exec` use the shared
   `retryAcquisition` helper.
2. `transaction(fn)` is implemented by the same small synchronous wrapper on both
   runtimes. Native Bun transactions bypass an `exec` override internally, so an
   override of `exec` alone would not have fixed this pin.
3. Writable handles default to IMMEDIATE. Readonly handles default to DEFERRED;
   explicit `.deferred()` remains available for read snapshots. The existing
   transaction-mode source guard continues to restrict production read-snapshot
   exceptions. This avoids claiming that an arbitrary DEFERRED read-to-write
   upgrade can safely be retried.
4. Nested transactions use SAVEPOINT, preserve the callback receiver/arguments,
   and roll back without replaying callback mutations.
5. `withPrivilegedWriter` still accepts externally supplied handles. It uses the
   same acquisition helper; an already-exhausted routed acquisition is recognized
   and is **not retried a second time**.

The schedule remains three attempts with 500/1000 ms backoff. Only acquisition is
repeated. A callback, COMMIT, or nested savepoint failure is not retried.

`sqlite-acquisition-fence.test.ts` scans production sources in plugin, Pi and CLI.
It rejects direct native SQLite imports/re-exports/loads and non-standalone or
prepared BEGIN IMMEDIATE/EXCLUSIVE literals, which would bypass this routing.
It also counts transaction and literal sites to prove the scan is nonempty.
The pre-existing transaction-mode guard remains active. Test-support lock holders
are intentionally excluded: they must own independent native connections.

Mutation proofs cover all four entry shapes and an actual injected native import
in a production source file. The callback-at-most-once, nested rollback, and
non-multiplied exhaustion tests also pass. The Node smoke script exercises real
`node:sqlite` contention for all four entry shapes, in addition to its existing
bind, readonly, savepoint and ATTACH checks.

**Cost:** SQLite's synchronous busy timeout and the backoff still block that host
thread. One production acquisition can occupy approximately 16.5 seconds, plus
scheduler delay; several independent writers can accumulate waits. This is not
an asynchronous storage conversion. No claim is made that every direct DML
statement or optional-write catch is itself a retrying transaction.

## F4 — consume the completion budget while the module is applying

**Reproduced red:** the mock now follows the real module's coordinator contract:
first execution starts once, the transport deadline fires, duplicate final pages
return `authority_transform_page_in_progress`, and only a later request can take
the cached committed response. The old immediate retry refused that pass.

After the original final-page timeout, one **fixed 45-second completion window**
is opened. An `in_progress` answer waits up to 250 ms before polling again. Every
poll carries the identical content-addressed final-page body and only the
**remaining** deadline budget. Other errors still propagate immediately. The
window is never restarted by an `in_progress` answer.

The test waits through three `in_progress` answers, then accepts the committed
array, asserts identical detached request-body snapshots, one execution, decreasing budgets, and
zero failure/parking count. A separate manual-clock test keeps returning
`in_progress` and verifies refusal at exactly the fixed 45-second deadline.
No state sync, upload series, or host mutation is repeated.

The call boundary now also races its deadline against the client promise, in
addition to aborting its signal. A client that fails to honor cancellation cannot
make the completion window or health probe hang forever.

## F5 — cheap admission for parked full attempts

**Reproduced red:** after three failures park a no-LKG session, the fake module
never resolves either health or transform requests, even after cancellation.
The old code sent another full transform and had no two-second admission gate.

A parked pass that cannot simply serve LKG now sends `session.status` with the
existing **2-second health budget**, bypassing the potentially blocked session
transport lane. A failed probe serves LKG if still admissible, preserves the
compaction-off fallback, or refuses immediately without state sync/full transform.
A successful probe permits the normal pass-sensitive transform/completion budgets.

The regression asserts no fourth full request to the hung module, then changes
the same module to healthy-but-slow. The next pass probes successfully, waits for
its five-second transform, serves the managed result and unparks. This preserves
the CEREB recovery case rather than restoring the four-out-of-five refusal trap.
A responsive health endpoint is not a proof that every later transform will
complete; it is the requested inexpensive liveness gate, not a new deadline for
all healthy work.

## F6 — pair the served system with its exact LKG snapshot

**Reproduced red on actual 2.0.18:** after fixing F2 but before this fix, the busy
turn reached the provider and its message prefix matched, but its system array
differed from the first turn. The test failed on that exact system comparison.

`V2LkgSystemReplay` keeps a bounded process-local record containing:

- A digest of the message slot's content, input digests, model/provider, capture
  timestamp and sequence/version metadata;
- The exact incoming host system identity;
- A detached copy of the processed system actually served with that slot.

Both v2 replay paths invoke the shared wrapper's new pre-adoption callback.
Only a matching slot **and** matching incoming system may restore the recorded
served system and adopt the replayed messages. Otherwise LKG is declined and the
normal loud busy refusal is used. Slot reads return copies, so object identity
is deliberately not used. A process restart or eviction loses the system record;
a successful transform must capture the pair again before v2 replay is admitted.
No schema migration or persisted-slot format change is needed.

Tests cover detached snapshot ownership, copied slots, changed input system,
changed capture identity and restart without a system record. Removing the input
identity check fails the unit test. Omitting restoration fails the real-host
system-byte comparison, while the message prefix still matches.

## Host provenance and isolation

All follow-up runs explicitly set:

```
MC_E2E_OPENCODE2_CLI=<worktree>/.cache/storage-busy-task/node_modules/@opencode/cli/bin/opencode.exe
```

The test executes that exact binary's `--version` under its throwaway environment
and prints **`version=opencode v2.0.18`**, separately from the client library's
version. There is no inference from the lane's default pin.

The first successful F2/F6 run used root `mc-opencode2-UCe1Ug`, host PID 61049 and
locker PID 61204. `lsof` showed their database descriptors only under that root,
including the host's `opencode2.db` and the locker's `context.db`. The test prints
this evidence and the runner also checks the host process group and protected
metadata fence. No live stores are read or opened.

After each real-host mutation the source is restored from its staged live state,
its diff is verified empty, and the v2 bundle is rebuilt. The delivery declaration
records the final all-lane rerun and gate outcomes.

## Additional review points

- The prior F8 model-key change is intentional: `adaptPayload` constructs v2
  messages with top-level `providerID`/`modelID` even on user messages, taken from
  the authoritative `draft.model`. Without accepting that shape, a user-only v2
  input cannot validate its captured model key. v1's nested user model remains
  the first-choice path. This was not just a made-up fixture shape.
- Genuine Anthropic reasoning-run rejection remains in place. The previous
  thinking-strip ordering fix is unchanged; the gate found it preserved bytes
  for candidates admitted by both orders.
- No Pi package files, migrations, ARCHITECTURE.md or STRUCTURE.md are changed.
  The shared routing automatically reaches Pi/CLI consumers of its Database.
- The existing source fence for runtime-relative imports in `sqlite.ts` remains
  intact, so Node can still execute its type-stripped smoke script directly.

## Verification outcomes

- Red-first reproductions: F2's live-tagging digest test; all four F3 native
  acquisition entry shapes; F4's applying coordinator; F5's parked unresponsive
  client; and F6's real-host system-array mismatch all failed before their fixes.
- Changed transform/replay suites: **196 passed, 0 failed**.
- Bun routing, transaction-mode/source fences and system-pair tests: **11 passed,
  0 failed**. Real Node SQLite smoke: **SMOKE PASS**, including all four contention
  entry shapes and readonly default transactions.
- Full plugin suite: **5,950 passed, 3 skipped, 3 failed**. Two existing marker
  tests still assumed a single busy timeout: one had a 10-second test ceiling for
  what is now a 16.5-second acquisition, and the other released its lock before
  the new retry window ended. Their fixtures/expectations now cover exhausted
  retries while preserving the old-marker/no-recording assertions. The third was
  the unrelated newspaper-layout test's existing 30-second timeout under load.
  All three affected files passed when rerun: **30 passed, 0 failed**. The marker
  changes are intentional retry-policy changes, not deleted safety assertions.
- Final real OpenCode **2.0.18** lane after restoring mutations: **3 passed,
  0 failed**. It covers 7-second lock recovery, 60-second no-LKG refusal, and
  60-second lock LKG replay with identical prior message-prefix and system bytes.
  The CLI path/version and lsof evidence are printed for each run.
- **12 new mutation proofs**, including real-host F2 and F6 reversions and a
  changed-final-page-ID control checked against detached request snapshots. Each named
  test alone reddened; every mutation was restored from the staged live source
  and followed by an empty working-tree diff. Full records live in the worktree's
  `.cache/storage-busy-task/pin-mutations.json` and the delivery declaration.
- Comment review completed; the handle-routing and restart-system comments were
  clarified. The authoritative typecheck/lint and final build outcomes, plus
  `--ts-only origin/master HEAD` pure replay, are recorded in the delivery.
