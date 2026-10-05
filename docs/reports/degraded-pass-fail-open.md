# A degraded transform pass must never be served

The incident and initial fix below describe the original change. The
[follow-up](#remaining-fail-open-gaps-closed) supersedes the record-only
postprocess verdicts, ordinary wrapper fallback, and Pi raw-fallthrough claims.

## The incident

A busy database made one pass send a request 2.5 times larger than the previous one. Session `ses_110d87916ffeDbfbAjhUgyL8Ps`, OpenCode 1, TypeScript mode, `anthropic/claude-opus-5-5`. The lines below are copied from the live diagnostic log (`magic-context.log.1` under `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/`), which was only read:

```
15:55:50.291Z event message.updated: totalInputTokens=648983 contextLimit=872000 percentage=74.4%
15:55:52.658Z transform scheduler: percentage=74.4% inputTokens=648983 cacheTtl=never lastResponseTime=1790870150267 decision=defer
15:55:53.035Z transform tag persistence failed; continuing without tagging: SQLite writer acquisition remained busy
15:55:53.482Z historian skip: internal drain budget spent (130800/130800 tokens; resets in 3m)
15:55:53.485Z pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=591 context=74.4%
15:55:54.441Z transform: final-wire telemetry estimate=unavailable trusted=false conversation=unknown tools=unknown system=unknown toolDefinitions=unknown tail=[...]
15:55:54.441Z lkg_capture_declined degradations=tagging-persistence-failure
15:56:03.553Z channel1 evaluation: ctx_reduce=callable U=54052.02 T=1473060.97 ratio=0.0367 band=quiet ...
15:56:07.404Z overflow detected via session.error: reportedLimit=1000000 provenance=prompt_only pattern=prompt is too long
```

The provider refused the request with `prompt is too long: 1621877 tokens > 1000000 maximum` (from the brief; the plugin log records only the pattern).

What happened: the in-turn writer limit (250 ms) expired under fleet contention while tagging this pass's new messages. `transform.ts` caught the error, recorded `tagging-persistence-failure` and kept going with an empty target map. Every replay keyed on tag targets was skipped: about 40K persisted drops (`applyFlushedStatuses`), reasoning clearing and caveman rewrites. Channel 1 then measured 1.47M tokens in the conversation. The pass knew it was degraded, so it declined to store itself as last-known-good (LKG), but it still served the request. The request was about 2.5 times the previous one, and it broke both the storage-busy rule (never send unreduced messages: LKG replay, then lock retries, then a refusal) and the defer-replay rule (a defer pass replays byte-identically).

## The fix

### One path for a failed stage

`degraded-pass-refusal.ts` adds `DegradedPassRefusalError` and `degradedPassError(site, error)`, where `site` is the name the pass records for the failed stage. Inside the pass, `failPass(site, error)` records the degradation and then throws, which hands the pass to the messages wrapper's recovery:

- a SQLite busy or locked error is rethrown unchanged, so the messages wrapper's existing storage-busy path handles it: LKG replay, otherwise `StorageBusyRefusalError` and the host notice (toast and abort on OpenCode 1);
- any other error becomes `DegradedPassRefusalError` (user-facing code `MC-S06`). The wrapper treats it like `UnresolvedHistoryBoundaryError`: replay the LKG if valid, otherwise rethrow, which refuses the turn. On OpenCode 2, `isBlockingV2TransformError` includes it, so the context hook toasts and refuses before the provider.

In compaction-off mode `failPass` only records. There, OpenCode's native compaction decides what history the request carries, the pass only adds blocks, and the wrapper's contract is to pass the input through unchanged on any failure.

The tagging catch keeps `tagger.cleanup(sessionId)` before throwing, so the next pass reloads the tagger's counter and assignments from the database. Without that, a stale in-memory counter can keep producing the same UNIQUE collision on every pass.

### Per-degradation verdicts

The rule: if serving the degraded pass can produce bytes different from a healthy pass, or grow the request, it takes the replay-or-refuse path. Otherwise the table says why it is served. Line numbers refer to this branch.

| Site | Can bytes differ / grow? | Verdict |
|---|---|---|
| `tagging-persistence-failure` (`transform.ts` tagging catch) | Yes, grows. With no targets, persisted drops, truncations, reasoning clears and caveman replays are all skipped. This is the incident. | **Replay or refuse.** A busy writer goes to the storage-busy path; a UNIQUE collision or other error goes to `DegradedPassRefusalError`. Tagger state is still reset. |
| `flushed-status-failure` (`applyFlushedStatuses` / `batch.finalize`) | Yes, grows. The replay mutates messages as it iterates and has no rollback (`apply-operations.ts:503-553`), so some drops may apply and others not. | **Replay or refuse.** |
| `session-meta-early-return` (`getOrCreateSessionMeta` / cache TTL) | Yes, grows. The early `return` served the host's raw input with nothing applied. | **Replay or refuse** (`fatal`). Compaction-off keeps the early return. |
| `store-generation-rebase-failure` | Yes. Saved ordinals stay in the old host's projection. A boundary cut that cannot find its id keeps raw history (`inject-compartments.ts` `findBoundaryIndex`), and the postprocess marker drain compares ordinals. | **Replay or refuse.** The generation stamp is written only on success, so the next pass retries the rebase. |
| `compaction-mode-transition-failure` | Yes. A half-applied transition leaves a stale m[0]/m[1] baseline or marker state that a completed one would replace (`transform.ts` transition block, `compaction-off-transition.ts`). | **Replay or refuse.** This only happens on the first pass after a mode flip, and that pass retries. |
| `overflow-state-read-failure` | Yes, grows. If the block fails before it reads the overflow latch, a provider-overflow arm goes unseen and the synthetic 95% bump that drives the emergency drops never happens. The block also writes on every pass (`resetProtectedTailNoEligibleHead` below 80%). | **Replay or refuse.** |
| `rust-transform-unavailable` (new, `transform.ts` Rust branch) | Yes. The branch returned the raw input. Production always builds a module client in Rust mode (`index.ts:305-311`, `v2/hooks/rust-mode.ts:22-33`), so this is a wiring fault. | **Replay or refuse.** |
| `session-directory-fallback` | Can differ, cannot grow the conversation. The launch directory only selects which project's memories and docs m[0]/m[1] render, plus the materialize decision. It skips no drop, truncation or history cut. Refusing would refuse every turn on a host whose session lookup fails, and 32 existing tests use mocks with exactly that shape. | **Served, record-only, with an m[0]/m[1] freeze** (parent ruling). When a frozen pair exists and the host has resolved this session before (a `session_projects` binding exists), the pass replays the frozen pair byte-identically and leaves every rebuild signal pending (see below). A session with nothing frozen, or one the host never resolved (whose pair was itself rendered with the launch directory), renders as before. Not counted by the size guard. |
| `compartment-trigger-failure` | Not for this pass. The trigger only decides whether to start the historian (`updateSessionMeta(compartmentInProgress)`, boundary snapshot). The conversation bytes equal those of a healthy pass whose trigger declines to fire, and every persisted reduction is still replayed. | **Served.** Not counted by the size guard. |
| `invalid-cache-ttl-fallback` | No relative to a valid config. A malformed `cache_ttl` falls back to the 5-minute default, which is a TTL healthy sessions use. It is deterministic config, so refusing would refuse every turn of every session with that config. | **Served.** Not counted by the size guard. |
| `auto-search-timeout`, `auto-search-search-failure`, `auto-search-cas-exhaustion` (`transform-postprocess-phase.ts` auto-search) | Cannot grow, and cannot change anything already served. All three happen only on a fresh tail turn that has no persisted decision yet, and they skip appending a new hint to it. A persisted hint is re-appended before the search runs (`auto-search-runner.ts:256-263`), so a defer pass does not drop one it served before. | **Served.** Not counted by the size guard. `auto-search-internal-failure` is counted: the runner can throw before it re-appends a served hint. |

The postprocess phase records more degradation sites than the ones above. They are listed here so nothing is silent. They are **not** converted in this change, because each needs its own replay-vs-detect analysis. Each can change the request, so the size guard below counts all of them and refuses any whose request goes over the limit:

| Site | Effect when caught |
|---|---|
| `pending-operation-failure` | Rest of the pending-op batch skipped; earlier in-memory edits remain. Can be larger than a healthy pass. |
| `stale-reduce-strip-exception`, `image-strip-exception` | Remaining strips skipped; can be larger. |
| `m0-m1-injection-degradation` | Legacy history block re-injected instead of m[0]/m[1]; bytes differ, can be larger. |
| `m0-m1-fallback-failure` (fatal) | History missing from the wire; differs, cannot be larger. |
| `compaction-marker-drain-failure` | Marker not advanced, signal kept; can be larger than a pass that advanced it. |
| `note-nudge-cas-failure` | Nudge text not appended; cannot be larger. |
| `thinking-binding-recovery-…`, `merged-reasoning-strip-…`, `trailing-blank-…`, `proactive-thinking-strip-persistence-failure` | A strip whose persistence failed is not applied this pass (so the next pass's replay stays consistent); can be larger by the kept reasoning or trailing bytes. |

Follow-up candidates: the exception variants that can stop a replay of persisted decisions part-way (`pending-operation-failure`, `stale-reduce-strip-exception`, `image-strip-exception`, `merged-reasoning-strip-exception`, `trailing-blank-*-exception`). The persistence-failure variants deliberately do not apply a decision they could not persist. Applying it would break the next pass's byte-identity instead.

### The m[0]/m[1] freeze on a directory fallback

`transform.ts` computes `freezeM0M1` when the session directory fell back, a complete cached pair exists, and `hasRecordedSessionProjectIdentity` finds a binding (a failed read counts as "freeze"). On such a pass:

- the explicit and deferred history refresh signals are not seen and not consumed, so `prepareCompartmentInjection` stays on its cached boundary;
- `protectionFoldWillBust` skips `mustMaterialize`, which also avoids its write of `cached_m0_project_identity`;
- postprocess skips the fold preflight and the soft refresh, and serves `prepareCachedM0M1Replay` (the persisted pair and its trim boundary) as the prepared prefix. That replay is marked contention-exhausted, so the history drain and marker drain treat the pass as not consumed;
- `pendingMaterializationSessions` and the explicit/deferred materialization successes are left in place, so the next resolved pass does the rebuild.

### Last-resort size guard

At the end of the pass, after the emergency fail-closed handling and before the LKG capture, `transform.ts` runs a guard when the pass recorded a degradation that can grow or change its request. If no estimate exists yet, it estimates now, which is the only added cost and lands only on such passes. If the estimate exceeds `boundaryContextLimit`, it throws `DegradedPassRefusalError("served-request-over-limit")`, so the wrapper replays the LKG or refuses. An untrusted estimate is partial: it leaves out parts it cannot count, so on such a pass one already over the limit is over for certain.

Which degradations count is one classification, `PASS_DEGRADATION_EFFECTS` in `pass-outcome.ts`. It lists every site a pass records as `changes-request` (the replay-or-refuse sites and every postprocess site above) or `served` (the four rows marked **Served** above). `PassOutcome.record` accepts only a listed site, so a new site does not type-check until it has a verdict, and `pass-outcome.test.ts` checks that the list and the recorded sites match. A pass with only `served` degradations is served exactly as a healthy pass would be: over the limit, the normal over-limit and emergency paths own it.

An untrusted estimate alone never refuses. On OpenCode 1.18.32 and later, a session's first pass reaches the transform before the system prompt has been measured (the final-wire telemetry logs `system=0` there, against `system=8953` on 1.18.30), so that pass's estimate is always untrusted. Refusing it would refuse the first turn of every session on a model whose window is smaller than OpenCode's own system prompt and tool definitions (about 40K tokens). In the hermetic e2e lane this refused `rust-cold-start-drop-seed` and `rust-real-or-absent-drops`, and in the OpenCode host lane five more files, all with 20K-30K windows. On OpenCode 1.18.30 the same refusal also fired whenever an auto-search timed out while the embedding model loaded. The guard needs a known limit. `boundaryContextLimit` falls back to `inputTokens / percentage`, which is 0 when a synthetic usage bump meets an empty input sample, and a limit of 0 proves nothing. The check is the same estimator-versus-limit comparison as the existing in-pass `UnresolvedHistoryBoundaryError` fit check, which is the TypeScript-mode counterpart of `assertPiRawFallbackFits`. The Rust raw-fallback byte proxy is not used here, because it counts base64 image bytes as tokens and would refuse image-heavy requests that fit.

A healthy pass with no estimate (a defer pass under 95%) is not estimated. It is the previous request plus the new tail, measured by the last provider usage.

## Pi

`packages/pi-plugin/src/context-handler.ts` (catch at about line 3895). After an ordinary, non-storage error the handler logged `context handler failed (continuing without mutation)` and returned `undefined`, so **Pi sent its own unmodified messages**: unmanaged, without the session's drops. The transient-storage branch was already safe. It tries the LKG and checks fit with `assertPiRawFallbackFits`, which refuses whenever measured system and tool-definition tokens are missing, and no caller passes them. So that branch always refuses.

Pi has no catch-and-continue around tagging. A tagging or drop-replay error reached that top-level catch and was served raw. The change:

- `tagTranscript` and `applyFlushedStatuses` run through `runPersistedReplayStage`. A busy store is rethrown as is; any other error becomes `PiDegradedPassError` (with tagger cleanup first for tagging). The catch handles `PiDegradedPassError` exactly like a transient storage failure (`DEGRADED PASS` in the recovery log): LKG plus fit check, otherwise refuse. Compaction-off still falls through.
- Last-resort guard on the ordinary fall-through: when the messages alone (`tokenizePiMessages`, so without system prompt or tools) exceed the window, the handler throws `PiDegradedPassError("raw-messages-over-limit")`. Messages that cannot be read or counted are not refused, which keeps the existing "persists and clears top-level transform errors" behavior.

## Rust mode

- Host fail-open found and closed: `transform.ts`, Rust branch. `if (!rustModeTransform) { …"using raw passthrough"; return; }` served raw input. It is unreachable with production wiring, and now goes through `failPass("rust-transform-unavailable")`.
- `rust-mode-transform.ts` `run` already refuses. Module failures go to LKG replay, then `serveRawFallback` (`rust-mode-transform.ts:2238-2300`). That function throws `StorageBusyRefusalError` for a busy store, `RawFallbackContextLimitError` when the limit is unknown or the byte proxy or trusted estimate is over, and `EmergencyFailClosedError` in every other case unless compaction is off. The catches that keep serving after publication serve **module output**: LKG capture failures on non-busting passes, rendered-memory-id and nudge bookkeeping, optional writers. None serves raw messages. Tagging lives in the module, so the TypeScript tagging catch never runs in Rust mode.

## Tests

| Test | What it shows | Red when reverted |
|---|---|---|
| `transform-degraded-pass.test.ts` "replays the last good request when the writer lock is held across tagging" | Real `context.db`. A second connection holds `BEGIN IMMEDIATE` from the tagger's `initFromDb` until `cleanup`, i.e. exactly across tagging, on a session with a persisted tool drop. The served array equals the previous request byte for byte, plus the new turn as it arrived. | Tagging catch back to record-only: the served array contains the dropped tool output (`not.toContain("BULKY-TOOL-OUTPUT")` fails). |
| … "refuses with the storage-busy refusal … no last good request" | Same, with the LKG dropped: `STORAGE_BUSY_MESSAGE` refusal. | Same mutant: the pass resolves. |
| … "replays the last good request when the persisted drop replay fails" / "refuses when …" | `applyFlushedStatuses` throws a non-transient error: LKG replay byte-identical, or `DegradedPassRefusalError(site=flushed-status-failure)`. | Flushed catch record-only: both red. Wrapper without the `DegradedPassRefusalError` rethrow: the refusal test goes red (raw served). |
| "a pass that falls back to the launch directory" | Resolved first render; then a system-prompt change plus an explicit flush, with the host returning no directory: m[0]/m[1] are byte-identical, the cached system hash is unchanged and the flush stays pending. The next resolved pass rebuilds (system hash updated, flush consumed). | `freezeM0M1` forced false: red. |
| "the served-request size guard" | A pass whose m[0]/m[1] render fails (a `changes-request` degradation) over a 2,000-token window throws `served-request-over-limit`; a tagging failure on that window is refused with `tagging-persistence-failure`; a first pass whose estimate is untrusted only because the system prompt is unmeasured is served; a pass whose only degradation is an auto-search timeout is served; the same request on a healthy pass is served unchanged. | Guard throw removed: the m[0]/m[1] test red. The untrusted-estimate condition restored: the first-pass test red. `auto-search-timeout` reclassified as `changes-request`: the auto-search test red. Tagging catch back to record-only: the tagging test red. |
| `pass-outcome.test.ts` | Every site the transform records is in `PASS_DEGRADATION_EFFECTS` and every listed site is recorded somewhere; the `served` set is exactly the four verdicts above. | A site added without a verdict, or a verdict changed: red. |
| `transform.test.ts` (3 rewritten) | The old fail-open claims for unreadable session meta, a throwing meta lookup and a failing tagger init now assert the refusal, unchanged input, and tagger cleanup. | — |
| Pi `context-handler-degraded-pass.test.ts` | A tagging or drop-replay failure refuses (`PiStorageBusyError` caused by `PiDegradedPassError`); an ordinary failure over the window refuses; one that fits falls through. | `runPersistedReplayStage` rethrowing the raw error: both stage tests red. Guard removed: the over-limit test red. |
| Pi `context-handler-lkg.test.ts` "preserves intentional non-storage raw fallthrough" | Now reports a host window (272K) that its 170K-token payload fits, so it still pins "ordinary failures fall through and the byte proxy is not applied". Its old fake reported 100K, which made the same payload over the window, and that case is now a refusal by design. | — |

### Real host: OpenCode 1.18.30

`packages/e2e-tests/tests/degraded-pass-lock.test.ts` is an opt-in probe, excluded from the mode lanes. Run it with `TMPDIR=$TMPDIR/magic-context/degraded-pass/`, using the throwaway harness roots and the mock Anthropic provider. A wrapper plugin loads the plugin source unchanged. Once armed, it blocks the host at the tagging step's first writer acquisition (recognized by its stack) until a separate `python3` process holds `BEGIN IMMEDIATE` on the throwaway `context.db`. Every earlier write in the pass has already committed by then, which is the incident's shape. The lock is released when the pass settles.

The session: turn 1 sends a ~24 KB ballast message; the test marks its tag dropped; turn 2 is the healthy managed request; turn 3 is served under the lock.

| Run | Log | Turn-3 request (`messages` JSON bytes) |
|---|---|---|
| This branch | `transform tag persistence failed; not serving this pass` → `lkg_replay_served` | **575** (managed turn 2: 450, unmanaged turn 1: 24,502), no ballast |
| Base commit's `transform.ts` (catch-and-continue; swapped in for this run, restored afterwards) | `transform tag persistence failed; continuing without tagging` | **24,758**: ballast resent, larger than the unmanaged turn 1. The test fails on `not.toContain("BALLAST-DEGRADED-PASS")`. |

An earlier variant locked at the transform's session lookup instead, before tagging. There the per-pass overflow-state write met the lock first: `overflow recovery state read failed` went to LKG replay (699 bytes). On base, the next unguarded write threw to the wrapper, which also replayed. Locking exactly at tagging is what reproduces the incident.

Isolation: `lsof -p <pid> -Fn` on the host before the lock, on the host while locked, and on the locker listed only `.db`, `-wal` and `-shm` paths under `/private/var/folders/…/T/magic-context/degraded-pass/opencode-e2e-*/data/`, for example `…/data/cortexkit/magic-context/context.db` and `…/data/opencode/opencode.db`. The test rejects any path under `~/.local/share/{opencode,cortexkit}` or `~/.config/{opencode,cortexkit}`, and any path outside its root.

## Residual risks

- A deterministic, non-transient failure at a replay-or-refuse site refuses every turn until it is fixed, or until LKG replay stops validating. That trade is the rule's intent: a refused turn is visible, and an unreduced request is not.
- The OpenCode wrapper still serves the raw input after an ordinary (non-storage, non-degraded) transform exception when no LKG replays (`messages-transform.ts`, "Continuing with unmodified messages"). It has no context limit at hand. Pi now size-guards its equivalent path.
- On a directory fallback, historian scheduling and memory promotion in that pass still use the launch directory's identity. Only m[0]/m[1] is frozen.

## Remaining fail-open gaps closed

### Recovery boundary

With compaction enabled, every ordinary exception reaching the OpenCode 1
messages wrapper now attempts the existing validated last-known-good (LKG)
replay and, if it cannot replay, throws `DegradedPassRefusalError` (`MC-S06`,
site `messages-transform-failed`). The wrapper does not know the context limit,
but fit would not make raw or partially replayed history safe anyway. Error
diagnostics still persist best-effort. Transient storage failures keep their
existing storage-busy refusal and host notice.

OpenCode 2 uses that same wrapper and no longer propagates ordinary errors into
a raw-fallthrough branch. Errors in the surrounding context setup also become
`MC-S06` (`v2-context-failed`), toast, and interrupt before the provider. The
test exercises the registered context hook, poisons a tool-definition read,
and verifies a confirmed host interrupt, not merely an error classifier.

Pi now attempts its existing fit-validated LKG replay for **every** managed
failure, not just storage/tagging/drop failures. If none validates, it uses the
existing `PiStorageBusyError` host-abort path with a `PiDegradedPassError` cause.
It no longer returns `undefined` after an ordinary failure, even when the raw
messages fit. The installed-host test verifies the abort. Compaction-off mode
retains raw passthrough on all three adapters; the OpenCode 1 wrapper retains
its exact-input restoration, and OpenCode 2/Pi retain their native ownership.

### Postprocess verdicts

`runPostTransformPhase` now has a local `failPass` with the same policy as
`transform.ts`: record the site, stop a managed pass, and preserve a busy/locked
exception for storage recovery. Nested refusals preserve the **first** site's
identity instead of being relabeled by an outer catch. A failed write returning
false/null is a failed stage too: not applying the unpersisted decision is
still necessary, but is no longer sufficient permission to serve the pass.

Each retained replay-or-refuse site was rechecked against the same criterion:
does the failed pass change anything already served, or leave a request larger
than a healthy pass? Optional additions to the newest, never-served user turn
do not qualify. After that review, the two sites below remain record-only;
**no other site was moved back**.

| Record-only site | Why it stays served |
|---|---|
| `note-nudge-cas-failure` | Failed delivery appends no reminder to the new user turn. Historical bytes are unchanged and the request is smaller than the healthy request with the reminder. |
| `auto-search-internal-failure` | A failed optional fresh-tail hint skips that addition. It does not authorize a history mutation or stop the remaining persisted-decision replay. |

Both are classified `served` in `PASS_DEGRADATION_EFFECTS`, including for the
size-guard backstop. A recurring optional search/nudge bug must not refuse an
otherwise valid transform. The previous claim that these two failures should
refuse was too broad and is superseded by this review: `runPostTransformPhase`
already replays both `replaySnapshot.noteNudgeAnchors` and
`replaySnapshot.autoSearchHintDecisions` in its sticky-injection block **before**
either optional append lane. The runner's later duplicate replay is not the
only path preserving an already-served hint.

Retained sites and the specific history/size reason:

| Site | Why replay or refuse, even below the limit |
|---|---|
| `m0-m1-fold-preexecution-degradation` | A failed fold can leave a different prefix or partially committed materialization. A cached-prefix substitute is not proof the complete pass replayed. |
| `pending-operation-failure` | Earlier mutations in the batch can remain while later operations or finalization were skipped. The test edits a reasoning part before throwing. |
| `stale-reduce-strip-exception` | Persisted id-keyed strips can stop midway on a defer pass. |
| `image-strip-exception` | Persisted image strips can stop midway on a defer pass. |
| `m0-m1-injection-degradation` | A legacy history fallback is not the persisted m[0]/m[1] representation. Clear the injection cache before stopping, so a retry cannot cut against an unserved prefix. |
| `compaction-marker-drain-failure` | A retryable marker-write failure cannot publish a pass whose trim and host marker disagree. Keep the pending marker and refresh signals by stopping before their drains. |
| `reasoning-removal-persistence-failure` | Leaving reasoning that a healthy pass removes makes the request larger and may affect historical assistants, not just the fresh user turn. Both thrown writes and false outcomes stop. |
| `reasoning-removal-read-failure` (committed-set re-read) | After committing new removals, a failed re-read cannot safely omit a concurrent winner's ids. The initial unreadable-set lane was already a refusal and remains one. |
| `thinking-binding-recovery-persistence-failure` | Keeping signed blocks that a healthy recovery removes makes the request larger and changes historical assistant bytes. |
| `merged-reasoning-strip-persistence-failure` | Keeping newly selected historical reasoning makes the request larger than a healthy strip; this is a removal, not omission of a new user-turn addition. |
| `merged-reasoning-strip-exception` | An exception in freezing/reading the set can leave replay incomplete. |
| `trailing-blank-heal-persistence-failure` | Retaining a historical keep/count decision adds blank blocks a healthy demotion removes. |
| `trailing-blank-heal-exception` | A heal can commit only part of a set before a subsequent operation throws. |
| `trailing-blank-decision-persistence-failure` | This lane can replace historical keep/count choices and demote a newest assistant from keep to strip. Failure can retain more blank blocks than the healthy pass; it is not restricted to omission of a new hint. |
| `trailing-blank-decision-exception` | Freezing or re-reading shape decisions may stop before all committed choices were adopted, leaving a historical shape different or larger. |
| `proactive-thinking-strip-persistence-failure` | A prefix-editing pass that keeps thinking a healthy pass removes is larger and leaves historical signed blocks bound to the wrong prefix. |

Sites deliberately left:

- `m0-m1-fallback-failure`: unchanged, reachable only in compaction-off mode
  after the new injection refusal. A managed pass can no longer reach the
  legacy fallback at all.
- The initial `reasoning-removal-read-failure` was already a loud refusal;
  its existing `EmergencyFailClosedError` behavior is retained.
- `session-directory-fallback`: retains the previously adjudicated frozen
  m[0]/m[1] replay and pending rebuild signals.
- `compartment-trigger-failure`: scheduling only; persisted request decisions
  still replay. `invalid-cache-ttl-fallback`: deterministic valid-default TTL.
- `auto-search-timeout`, `auto-search-search-failure`,
  `auto-search-cas-exhaustion`: a previously served hint has already replayed;
  these omit only a new, never-served tail hint.
- Best-effort channel-2 cycle reset, permission diagnostics, metrics,
  recovery-flag cleanup and timing logs are not persisted-decision replay
  lanes. They remain observational/bookkeeping. Uncaught exceptions still
  reach the now-fail-closed wrapper. Rust module-output publication paths are
  outside this TypeScript postprocess change.

### Tests and non-vacuity

The under-limit refusal table now has 16 cases: each retained site above, with a
distinct committed-re-read case. Each injects an exception or false/null
persistence result at a real stage seam, asserts that the seam ran, and asserts
the refusal's site. Degradation recording is also checked.

Two separate served cases compare a healthy request with its fresh-tail
addition against two recurring failed passes. Each asserts no refusal, an
identical historical prefix including a saved hint and reminder, completion of
a persisted reasoning strip after the optional lane, and a request exactly equal to the healthy request minus
the new hint/reminder. Both tests failed against the initial refusal code.
The effect-classification test likewise failed until these sites were `served`.
Full-transform cases also prove these optional failures do not trigger the
degradation size guard when a new user turn is itself over the limit; normal
overflow/emergency policy still owns that size, just as on a healthy pass.

The seeded full-transform tests additionally verify byte-identical LKG replay
and no-LKG refusal for stale-reduce and image exceptions, and add the missing
direct tests for `store-generation-rebase-failure` and
`compaction-mode-transition-failure`. An ordinary wrapper exception after a
partial edit also replays LKG, and an id-less failing request refuses.

Old tests that explicitly claimed failed marker persistence, failed
trailing-blank persistence, failed proactive stripping, or ordinary Pi errors
could still serve were changed deliberately to assert refusal. Their durable
state/retry assertions remain. The reasoning-watermark tests still pin that
age cleanup cannot advance the watermark; their injected failing writes now
also assert refusal instead of awaiting a served pass.

Mutation procedure: stage the live implementation, verify an empty worktree
diff, apply a `NON-VACUITY BREAK`, capture a non-empty diff, run the named tests
under `timeout`, restore from the index, touch the source, and capture an empty
diff again. Selectively bypassing each postprocess refusal made exactly its
named table case red; the mixed healthy pure-replay case stayed green on all
18 initial runs. The 16 retained refusal proofs remain valid; the two optional
addition refusal proofs are withdrawn because that refusal contract was
incorrect. Rebase, mode-transition, wrapper, OpenCode 2, and Pi bypasses each
made exactly their corresponding refusal case red, with the healthy/off-mode
control green. Removing nested-refusal preservation made the merged-reasoning
persistence case red on its site assertion, while healthy replay stayed green.
Restoring the task-base production files also made the image refusal case red.
The correction has four new mutation controls: reinstating each optional
refusal makes only its served-prefix case red, and reclassifying each optional
failure as `changes-request` makes only its full-transform size-guard case red.
The healthy mixed pure-replay control remains green on all four runs.
No mutation remains in the committed implementation.

### Pure replay: original versus fixed

The same deterministic session geometry was seeded into isolated stores with a
persisted tool drop, stale-reduce id, processed-image id, binding-recovery
reasoning id, and trailing-blank decision. `transform-postprocess-phase.ts`,
`messages-transform.ts`, and `degraded-pass-refusal.ts` were restored exactly to
base commit `545d5f229f136e2f9e6b7803efd1021011312379` for the before capture
(verified against that commit before adding a non-vacuity marker comment).
The after capture used the fixed sources. Both independently captured the
entire messages arrays actually served by the wrapper, not raw inputs or an
estimator. The comparison did not compute expected bytes using transform code.

| Served request | JSON bytes | SHA-256, identical before and after |
|---|---:|---|
| Seeded replay and three repeated ordinary defers | 841 each | `012f2e18bfd1a9d95fe54af03ab7f74421738e663c577811aa54f3dc6aff77ae` |
| Ordinary defer with the new tail appended | 1,161 | `571c41d9d6662c5e32bf1bf4ffd96255d8d8b3873fae400056c0dd0126d14a92` |

**Five served requests compared; zero changed bytes.** This fix introduces no
byte changes on any non-failing pass: neither ordinary/defer passes nor existing
successful rebuilding passes get new mutation or scheduling permissions. The
existing first render, explicit flush, independently authorized fold/refresh,
emergency work and new tail bytes remain owned by their existing rules. Only a
**failing** managed pass changes disposition at a history/size-affecting stage:
validated LKG plus its admitted tail, or no provider request. Optional
fresh-tail search/nudge failures continue serving without that addition.
Compaction-off failure passthrough is unchanged.

### Real host: two residual sites

The additional opt-in cases in `degraded-pass-lock.test.ts` run a real
**OpenCode 1.18.30** process and mock Anthropic endpoint under an isolated root
named `magic-context/degraded-residuals-…`. `TestHarness` can now select the
canonical `anthropic` provider id, so these provider-specific lanes actually
run. Memory auto-search is disabled to prevent a fresh search hint from
reintroducing a ballast fragment. The plugin source is loaded unchanged. A
wrapper adds message-property getters armed only on turn three; the getter
throws only when the stack names the selected replay function. Captured stacks
prove the exception executed inside that function and its postprocess catch.

| Injection | LKG state | Raw turn 1 | Managed turn 2 | Turn 3 |
|---|---|---:|---:|---|
| `dropStaleReduceCalls` | Present | 24,502 bytes | 458 bytes | LKG replay, 590 bytes; ballast absent |
| `stripProcessedImages` | Deliberately removed | 24,502 bytes | 458 bytes | `MC-S06` in the assistant error; **zero provider requests** |

The tests assert stage execution, replay/refusal, and request contents/counts;
an empty capture is not accepted as replay success. `lsof -p <pid> -Fn` before
and after each fault listed only databases under that run's throwaway root,
including `data/opencode/opencode.db`,
`data/cortexkit/magic-context/context.db`, and any ONNX telemetry database
inside the throwaway home. The assertions require both host/plugin databases
and reject live or out-of-root paths. `HOME`, `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, and
`MAGIC_CONTEXT_STORAGE_DIR` were all throwaway. No live store was opened or
modified. No schema/migration change was made; only fresh test schemas were
initialized by the existing harness.
