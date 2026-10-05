# Storage contention and managed-prompt refusal

> Historical initial-delivery report (`38a6a6cd`). The acquisition coverage,
> TypeScript LKG capture, Rust completion wait, parked health gate, and v2 system
> replay findings are corrected in [the pin follow-up](storage-busy-policy-pins.md).

## Implementation

The shared acquisition helper is `beginImmediate` inside
`packages/plugin/src/shared/sqlite.ts`, used by `withPrivilegedWriter`.
It makes **three acquisition attempts**, waiting **500 ms, then 1,000 ms**.
With the production `busy_timeout=5000`, one acquisition takes at most about
**16.5 seconds** (excluding process scheduling delays). The callback, privilege
flag and nesting-depth mutation all occur **after** successful acquisition.
Neither the callback nor a whole transform is retried. Callback failures retain
the existing rollback/savepoint behavior. Bun named/extended contention codes
and Node numeric `errcode` values are recognized.

OpenCode 1 keeps LKG first at its error boundary. Without usable LKG, a storage
error refuses with:

> Magic Context's database is busy (another process held it too long); send your message again.

The production v1 binding sends the existing status notification and calls the
existing confirmed session-abort path before propagating the typed refusal.
OpenCode 2 now uses the same transform boundary and LKG replay. Contention in
its setup path also gets a replay attempt. Otherwise it publishes a toast,
stores a user-facing storage notice, confirms interruption before the provider,
and throws its existing context-refusal type. Compaction-off remains passthrough.
Every storage-busy refusal logs its stage and the original SQLite stack;
acquisition exhaustion retains the original error as its cause.

The v2 hook probes writer admission before its best-effort tool-definition
writers. The real-host experiment found those writers could otherwise each
spend another busy timeout before the actual transform. The admission callback
is empty; it does not retry any setup work.

## Host deadline source inspection

Versioned host sources were downloaded into the worktree's ignored evidence
directory, not read from a running host or a live database:

- OpenCode **v1.18.0**, `packages/opencode/src/session/prompt.ts:1255` calls
  `plugin.trigger("experimental.chat.messages.transform", ...)`.
  `packages/opencode/src/plugin/index.ts:280–290` awaits each callback with
  `Effect.promise`. No hook timeout is imposed in that invocation path.
- OpenCode **v2.0.18**, `packages/core/src/session/model-request.ts:206–224`
  awaits the shaped draft; `:378–386` selects the `context` hook for primary
  requests. `packages/core/src/plugin/hooks.ts:88–95` yields each callback.
  No hook timeout is imposed there either. Hook failures are defects in the
  host's Effect error channel, so interruption and a separate visible notice
  are important; an exception by itself is not sufficient UX evidence.

These are the `v1.18.0` and `v2.0.18` tags of
`https://github.com/anomalyco/opencode`. There is no finite hook budget in the
inspected paths to subtract from. The implementation nevertheless bounds each
storage acquisition and module retry rather than waiting indefinitely.

## Rust mode

No-LKG fallback now **refuses whenever compaction is on**, including a module
timeout or an otherwise locally fitting raw prompt. Oversized/unknown-limit
fallbacks retain their existing typed refusal and calm recovery message.
`served_from=refused` is set before raw-fallback admission checks; it becomes
`raw` only when a compaction-off raw fallback actually succeeds.

Parking skips the module only if LKG actually serves. A parked session with no
usable LKG attempts the module immediately, including when raw history exceeds
the context limit, and the existing success path clears the parked state.

Module wait budgets are pass-sensitive:

- Upload pages retain their 5-second budget.
- Ordinary tail-delta/defer execution retains the 15-second default.
- Cold/full-wire execution, known pending materialization/history refresh, and
  emergency execution receive at least **45 seconds**. The existing size-based
  cold-start budget can still raise this to **90 seconds**.
- A final-page timeout gets **one identical-final-page retry with 45 seconds**
  before failure/parking accounting. No state synchronization, page upload, or
  host transform mutation is replayed. Explicit `moduleTimeoutMs` overrides
  remain authoritative and do not gain an automatic retry.

The module alone knows some coverage-fold decisions. Such a fold can initially
look like a defer to the host; its timeout gets the longer final-page retry.
The default execution portion is therefore bounded to 60 seconds for such a
pass, 90 seconds for known materialization, or 135 seconds for the largest
pre-existing cold-start budget. Upload/state-sync work has separate existing
bounds, so these are not claimed as whole-hook deadlines.

Retry safety is based on the existing content-addressed page protocol, not on
transform idempotence. `crates/mc-module/src/lib.rs:12079–12107` checks completed
series generation and final digest and returns the stored result.
`completed_content_addressed_page_series_replays_without_reexecution` already
covers that contract. The new plugin test asserts that both final-page bodies
are identical and that a successful retry does not increment failure/parking
state. A generation mismatch remains a refusal/restart signal, not permission
to replay arbitrary mutations.

## Anthropic LKG rejection

`lkg_anthropic_reasoning_run_invalid` drops the cached slot, which explains the
subsequent `lkg_miss`. The check correctly rejects adjacent assistant runs that
would merge independently signed thinking blocks; that check remains enabled.

There was also a real ordering defect: both Rust replay and the outer wrapper
validated the reconstructed prefix + raw tail **before** reapplying durable
binding-mismatch thinking strips. A thinking block already removed from the
served representation could therefore invalidate the candidate before its
persisted strip was applied. Replay now applies those existing decisions after
content/identity validation but before wire/seam validation. The regression test
reconstructs precisely this kind of candidate; removing preparation makes it
fail, while existing genuinely invalid reasoning-run tests still pass.

The supplied CEREB log sequence establishes rejection and eviction, but does
not contain the rejected prefix/tail or its persisted strip IDs. No live stores
were opened. Consequently this report does **not** claim to prove which of the
two cases caused that particular production rejection. The corrected production
interpretation also matters: the reported oversized raw fallback was already
refusing; its old pass-log label falsely said it was served raw.

## Remaining fallback audit

| Path | Result / decision |
| --- | --- |
| v1 transient SQLite failure | Acquisition retries; valid LKG replay, otherwise visible refusal. |
| v2 transient failure inside transform | Shared LKG boundary, then interrupt + notice + refusal. |
| v2 transient failure before transform | Admission retries, then candidate LKG replay or interrupt + notice. |
| Rust local SQLite contention | Same acquisition helper; safe LKG where admitted, otherwise storage-busy refusal. Existing emergency barriers remain stronger than LKG. |
| Rust unreachable/slow module, no LKG | Bounded final-page wait/retry where applicable; refuses, never raw with compaction on. |
| Rust parked, usable LKG | Existing cadence retained and LKG served. |
| Rust parked, unusable LKG | Tries module every pass; refuses only if recovery fails. |
| v1 ordinary non-storage bug | Existing LKG attempt, then logged/telemetried unmodified fallback deliberately retained under the requested audit-only scope. |
| v2 ordinary pre-fold bug | Existing warning/fail-open path deliberately retained; post-fold restore failures still interrupt/refuse. |
| disabled/null hooks, internal/hidden child exemptions, deleted-session races | Existing bypasses retained; they are not newly classified as storage contention. |
| compaction-off | Existing passthrough policy retained. Rust's pre-existing oversized raw-admission refusal remains. |

Not all SQLite writes go through `withPrivilegedWriter`: direct statements and
other transaction helpers remain. A propagated contention error after acquisition
is never retried by this change; the boundary replays LKG or refuses. Best-effort
internal catches can still suppress optional-write failures; this change does not
turn every such telemetry or bookkeeping write into a mandatory operation.
A v2 setup-stage LKG replay preserves managed message bytes but may precede
system-prompt refresh; exact combined system+message cache identity on that
rare setup-failure path is not asserted by the adapter byte-identity tests.

## Verification record

- Red-first changed the old issue-23 raw-pass assertions into refusal assertions;
  both failed on the original wrapper. Rust no-LKG timeout and immediate parked
  recovery tests also failed before implementation.
- Full plugin suite: **5,938 passed, 3 skipped, 2 failed**. One was the changed
  ordinal test's old module-call count (the final-page retry adds one call),
  which was corrected while preserving its no-full-read assertion. The other
  was an unrelated newspaper-layout test exceeding 30 seconds under machine
  load. The impacted files plus that unrelated file were rerun together:
  **206 passed, 0 failed**. No weakened timeout was committed.
- Plugin typecheck and lint passed. Full plugin build passed during development;
  final build/typecheck/lint results are also recorded in the delivery declaration.
- Seventeen controlled mutations cover both host adapters' LKG, attempts 2/3,
  refusal, and compaction-off policies; Rust timeout, park recovery, retry,
  thinking-strip preparation and refusal labeling; and both real v2 lock tests.
  Each named test alone went red, with no other failure in its filtered run.
  Every mutation had a nonempty diff and was restored from the staged live
  implementation, followed by an empty diff. Full records are in the delivery
  declaration and `.cache/storage-busy-task/mutations.json` in the worktree.
- Real **OpenCode 2.0.18**, using a separate Python process holding `BEGIN
  IMMEDIATE` on throwaway `context.db`: **7-second lock recovered**, and
  **60-second lock produced an interrupted turn and the exact stored refusal
  notice with zero primary provider requests**. Title requests are deliberately
  counted separately from primary model requests. Both tests passed again
  after restoring the real-host mutations: 18 assertions, 0 failures.
- That final host run used throwaway roots ending in `mc-opencode2-zfp0N4`
  (host PID 36622, locker 36638) and `mc-opencode2-Gtop2E` (host PID 36784,
  locker 37005). Host process-group descriptors and the locker's descriptors
  were checked with `lsof`; database paths were under those roots. No live
  store was opened. The harness's protected-directory metadata fence passed.
- Pure replay `--ts-only origin/master HEAD` is run against the committed
  implementation; its result is recorded in the delivery declaration.

No Pi package, schema migration, ARCHITECTURE.md, or STRUCTURE.md was changed.
