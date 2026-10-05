# TypeScript transform performance — 2026-09-30

## Result and scope

The MC clone's new-message passes improved from **782.2 ms to 100.9 ms median**. `tag.inertWhitespace` improved from **567.7 ms to 0.6 ms**. The replacement uses the existing fingerprint index to read retired whitespace tags only for visible message owners; no schema migration is required. The same-session cache now also keys on visible owners, so changing the set of visible messages cannot reuse the wrong subset. Unscoped reduction-tool reads remain unchanged.

`applyFlushedStatuses` now bounds its fallback reader to dropped tags with visible targets. OpenCode already supplies this slice, so this is primarily a shared-code/Pi fallback improvement, not the cause of the measured MC speedup. The last-known-good (LKG) entry projection captures immutable message digests for fallback replay. `findSessionId` was misattributed: its timer included `projectLkgEntry`, which digests every incoming message. The helper itself takes less than the logger's 0.1 ms resolution. The digests still run; the new `lkg.entryProjection` stage reports their actual cost.

**SUBC's original slow/degraded path is diagnostic-only.** The operator directed that this path remain diagnostic-only because their separate migration investigation traced B2 data loss, replacing 1,255 context.db compartments covering ordinal 82,880 with 707 older store.db compartments. The snapshot has 725 compartments, with new summaries again ending in July. Repairing that data is separate work. Neither `compartment-trigger.ts` nor `inject-compartments.ts` is changed in this delivery.

The MC median target is met in this offline sample. SUBC's corrupt-state trigger remains over 1 s on a warm direct check; **the requested SUBC hot-path p99 target is not certified or fixed**. Whole-history work is removed from the whitespace reader and fallback drop reader, not from every transform operation. Digesting, applying drops and serializing the visible prefix still require visible-message work.

## Isolation and replay method

- Initial `df -h`: 151 GiB available. Final profiling check: 115 GiB available, above the required 20 GB reserve.
- `du -sh ~/.local/share/opencode`: 35 GB. APFS `cp -c` cloned both databases and their `-wal`/`-shm` siblings into `$TMPDIR/magic-context/perf-ts/20260930-224045/{context,opencode}`. Each run then cloned that snapshot into a fresh sibling directory. No SQLite connection was opened on a live database; the only live-store file operation was APFS cloning. Copies of DB and WAL are sequential, not an atomic SQLite backup; all comparisons use the same recovered snapshot.
- `lsof -nP -c opencode -c bun` identified the live handles belonging to OpenCode. `lsof` on snapshot paths was empty before opening them. Every full replay printed `lsof -nP -p <replay pid>` database handles. For example, optimized MC PID 94877 had context.db FD 8u and opencode.db FD 9r, and WAL/SHM handles, **all under `/private/var/folders/.../T/magic-context/perf-ts/mc-new-after/`**. SUBC PID 97765 likewise had only its `subc-after/` database paths, including marker-manager write handles. No replay PID had a live-store database handle.
- The live plugin log was read in place, not copied. For example its 19:45:03 MC pass recorded 141.2 ms whitespace, 31.6 ms flushed-status replay and 354.6 ms total; its next pass recorded 133.0 ms whitespace and 315.5 ms total.
- Runner: `packages/plugin/scripts/profile-cloned-ts-transform.ts`. It enforces a throwaway root beneath the canonical temporary `magic-context/perf-ts` directory and refuses an existing run directory. `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and logging are pointed at that run directory before dynamic plugin imports.
- This calls the **real `createTransform`**, not a stand-in. It reconstructs messages/parts from the cloned OpenCode v1 tables, beginning at the persisted marker if its summary is complete, then scans for the newest completed compaction marker. The snapshot has 195,538 MC tags (68 inert whitespace tags), and 95,640 SUBC tags (25 inert). Its visible windows are now 181 MC messages and 1,216 SUBC messages, not the earlier log window's 456/855.
- No client or completion executor is installed; no model/network historian work runs. The transform scheduler always returns `defer` to test cache-safe replay without deliberately pricing a new prefix. This is an offline TS replay, **not a complete production host configuration**. First-touch resets, native page-cache state and clone write initialization are expensive. First passes are excluded from steady-state summaries and reported below.
- `PERF_ADVANCE=1` appends one small, uniquely identified user message per pass after pass zero. These clone-only messages force real tag insertion/version invalidation. Simply revealing already-persisted historical rows does not reproduce the live whitespace cost: it leaves the tag-version cache valid. Static repeated-array replay and advancing replay both retain the real recorded message array.

Example ordinary run:

```sh
PERF_PASSES=8 PERF_ADVANCE=1 bun packages/plugin/scripts/profile-cloned-ts-transform.ts \
  "$TMPDIR/magic-context/perf-ts/20260930-224045" \
  "$TMPDIR/magic-context/perf-ts/mc-new-after" ses_331acff95fferWZOYF1pG0cjOn
```

Baseline source was `git archive d8a6963308f750f3c0959bacfd995d2fa0a81eb7` into `baseline-source/`, using this worktree's installed dependencies through symlinks. The runner is held constant with `PERF_SOURCE_ROOT`. Profiles used `bun --cpu-prof --cpu-prof-dir=.../perf-ts/profiles --cpu-prof-name=<session>-<side>.cpuprofile` and fresh run directories. Private data and profiles stay outside git.

## Ordinary wall times

All numbers are milliseconds. `max` is the observed maximum, **not a statistically supported production p99** (seven warm MC samples and three warm SUBC samples).

| Stage | MC before median / max | MC after median / max | SUBC before median / max | SUBC after median / max |
|---|---:|---:|---:|---:|
| entire pass | 782.2 / 958.6 | 100.9 / 277.1 | 180.9 / 300.9 | 165.1 / 182.7 |
| findSessionId (old timer includes LKG) | 22.3 / 182.1 | 0.0 / 0.0 | 97.0 / 101.3 | 0.0 / 0.0 |
| lkg.entryProjection | included above | 15.9 / 61.7 | included above | 93.2 / 103.1 |
| getOrCreateSessionMeta | 12.8 / 58.0 | 7.2 / 8.6 | 6.2 / 6.7 | 5.6 / 5.7 |
| emergencyRecoveryBlock | 1.9 / 6.0 | 1.1 / 1.7 | 0.6 / 0.6 | 0.5 / 0.5 |
| compartmentTrigger | 27.3 / 85.5 | 15.7 / 29.7 | not reached in warm passes | not reached in warm passes |
| prepareCompartmentInjection | 4.2 / 27.1 | 3.5 / 4.2 | 2.8 / 3.1 | 2.5 / 3.0 |
| tag.initFromDb | 0.7 / 2.0 | 0.7 / 0.7 | 0.1 / 0.1 | 0.1 / 0.1 |
| tag.inertWhitespace | 567.7 / 638.1 | 0.6 / 1.2 | 0.0 / 116.6 | 0.1 / 2.1 |
| tag.loop | 39.5 / 189.0 | 2.2 / 4.9 | 3.5 / 4.3 | 3.1 / 4.1 |
| tag.assignTag (within loop) | 38.5 / 177.2 | 1.3 / 3.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| tagMessages | 605.9 / 803.0 | 6.5 / 11.2 | 5.8 / 124.3 | 6.3 / 7.7 |
| getDroppedTagsByNumbers | 0.3 / 0.6 | 0.3 / 0.4 | 1.5 / 1.5 | 1.2 / 1.5 |
| applyFlushedStatuses | 20.8 / 47.8 | 20.7 / 24.1 | 45.1 / 48.8 | 40.1 / 40.8 |
| compartmentPhase | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.1 | 0.0 / 0.0 |
| pp.replaySnapshot | 10.5 / 17.7 | 9.2 / 11.2 | 7.9 / 8.2 | 7.4 / 7.6 |
| pp.nudgeAndSticky | 10.3 / 24.8 | 10.9 / 18.6 | 0.0 / 0.1 | 0.0 / 0.1 |
| pp.noteAndTodoSynthesis | 0.6 / 341.1 | 0.2 / 82.4 | 0.2 / 0.5 | 0.2 / 4.7 |
| pp.frozenDecisions | 0.6 / 0.9 | 0.4 / 0.6 | 0.5 / 0.6 | 0.5 / 0.7 |
| postTransformPhase | 44.6 / 387.7 | 26.1 / 129.9 | 14.2 / 14.4 | 13.0 / 17.7 |

Other measured stage medians were below 1 ms: findLastUserMessageId, modelChangeDetection, schedulerAndUsage, tag.getSourceContents, tag.deriveOwner, tag.getToolTag, tag.assignToolTag, tag.saveSource, getActiveTagsBySession, stripStructuralNoise, replayReasoningClearing, stripClearedReasoning, batchFinalize:heuristics, pp.setupAndOperations, dropStaleReduceCalls, stripProcessedImages, pp.placeholderNeutralize, pp.markerReconcile, finalizeMessageRepresentation, pp.tailBaseline and pp.tailGuard. The batchFinalize:flushed timer contains applyFlushedStatuses and is not independent work.

Cold first passes: MC 117,824 ms before / 14,175 ms after; SUBC 132,507 ms before / 54,358 ms after. These are not comparable optimization estimates: initialization, filesystem caching and machine contention differ. Earlier static MC replay had a 133.6 ms warm median even before the fix because no new tags invalidated the whitespace cache.

## CPU-profile runs

Profiler wall measurements, kept separate from ordinary wall measurements:

| Stage | MC profile before / after median | SUBC profile before / after median |
|---|---:|---:|
| entire warm pass | 382.3 / 113.7 | 311.7 / 282.7 |
| LKG projection (old findSessionId / new lkg.entryProjection) | 17.8 / 17.4 | 120.8 / 147.8 |
| compartmentTrigger | 18.1 / 16.9 | not reached / not reached |
| prepareCompartmentInjection | 3.8 / 3.6 | 3.9 / 4.5 |
| tag.inertWhitespace | 280.6 / 0.7 | 0.0 / 0.2 |
| tagMessages | 289.2 / 7.7 | 8.6 / 9.7 |
| applyFlushedStatuses | 16.5 / 22.7 | 88.6 / 90.5 |
| compartmentPhase | 0.0 / 0.0 | 0.0 / 0.0 |
| pp.replaySnapshot | 8.8 / 10.0 | 9.8 / 10.2 |
| pp.frozenDecisions | 0.4 / 0.3 | 0.8 / 0.8 |
| postTransformPhase | 26.1 / 29.2 | 18.2 / 20.7 |

The four files are `profiles/{mc-before,mc-after,subc-before,subc-after}.cpuprofile` under the temporary root. Counting self samples by function shows MC native `all` totals of 5,045 ms before versus 340 ms after; native `run` totals of 12,028 versus 3,998 ms. Those totals include cold initialization and must not be interpreted as steady-state CPU savings. SUBC profiles are dominated by native SQL and `encodeOrdinary` tokenization during the first pass, not its short subsequent defer passes. Profiling makes native SQLite/serialization costs especially unreliable as wall-time estimates; the ordinary measurements above are authoritative for this sample.

## Why whitespace scaled

`getCachedInertWhitespaceAssistantTags` was keyed on the loaded tags version. Every new tag invalidated it, causing the unscoped `getInertWhitespaceAssistantTags` query to revisit all compacted message rows and apply a fingerprint `LIKE` filter. Only 68 rows were useful in MC, but the search spanned the historical tag store. Every pass also built membership/rank maps for all historical inert rows.

The transform now passes its visible message IDs. The storage reader seeks ranges `["mc:whitespace-assistant:<id>:p", "mc:whitespace-assistant:<id>:q")`, and uses the existing `idx_tags_pi_adopt(session_id, entry_fingerprint)` index. Clone `EXPLAIN QUERY PLAN` confirmed:

```text
SEARCH tags USING INDEX idx_tags_pi_adopt (session_id=? AND entry_fingerprint>? AND entry_fingerprint<?)
```

There is no ordinal-floor assumption: a visible message's retired tag may be far below the current tagger load floor, and still must replay. Whitespace rank, part-index remapping, signed-thinking adjacency, new post-step blanks and real-text replacement keep their existing tests. Index seeks are O(visible owners log historical rows), with hydration/rank work only for their inert parts, instead of O(all historical tags). This is deliberately not an unsafe “only append” cache: changed tags versions and changed windows must be respected. Unchanged replay uses the cache; an advancing pass performs small owner-index seeks, not a history scan.

## SUBC diagnosis — no behavioral changes

Snapshot evidence:

- Frozen baseline boundary: `msg_f8c1c9c25001ukvE3g4ZddOBH1`, July 22, 2026, ordinal **24496** in `ORDER BY time_created,id` history. It still exists in OpenCode. Compartment 711 has that endpoint, `end_block_index=null`, `rebase_status=ok`. It is neither deleted nor a partial-message boundary.
- Current marker: user `msg_0ed79eb94001sjHqN6gnLCRkWg`, September 29, ordinal **82769**, with a compaction part and its completed summary. The host therefore serves a window **after** the frozen boundary.
- The cached baseline still says max compartment sequence **1252**, while the snapshot's latest durable sequence is **725**, ending at ordinal **25156**. The migration-overwrite finding comes from the operator's separate investigation, not an independent store.db comparison in this delivery.
- Protected-tail drain state is **192000 tokens spent**, prior boundary ordinal 82881. The latest stored compartment endpoint is also absent from the visible array. `buildTriggerInMemoryTail` intentionally refuses to guess absolute ordinals without its anchor and returns undefined. The trigger consequently falls back to raw history from the stale July endpoint, rather than the in-memory September tail. Boundary resolution and token counting then revisit a very large eligible range. The compartment phase similarly primes the DB tail when it starts/blocks a run; a spent drain budget prevents the historian from advancing the state. Moving this read to an event alone would not repair the missing history.

A fresh clone with `PERF_TRIGGER_ONLY=1` explicitly held `compartmentInProgress=false` to measure the same check twice (no historian network operation). Both checks reported `inMemoryTail=false`, `shouldFire=true`, `reason=commit_clusters`, boundary `msg_f8f26dcb3001MHhXhNIP4sh4XK`: cold **20,054.6 ms**, warm **1,187.4 ms**. No trigger behavior was changed. The full offline transform's warm SUBC passes do not reproduce the production fire/drain loop: the omitted host client and first-pass state changes make that path unavailable. Its sub-1-second totals must not be used to claim that loop is fixed.

### Degraded defer cache evidence

`prepareCompartmentInjection` explicitly falls through to a database rebuild on every defer cache hit whose `compartmentEndMessageId` is null (original `inject-compartments.ts:428-433`). This is an independent inefficiency/cache-stability risk. It remains unchanged under the operator's diagnostic-only restriction while the migration data repair is handled separately.

`PERF_INJECTION_ONLY=1` called the real preparation function three times with fresh copies of the identical 1,216-message host array, on an untouched clone baseline:

| Pass | wall ms | rebuiltFromDb | boundary | prepared block SHA-256 | remaining host-array SHA-256 |
|---|---:|---|---|---|---|
| 0 | 3366.6 | true | null | cd965ab68af940a5cbb4ba0281f8318aa986cb6959f0ded5c7644dbef3968fe0 | abe363ee0a5837b1e2168377f6ab7a09d2a9782cdb9850bcd013ccd5b0051a81 |
| 1 | 2.5 | true | null | same | same |
| 2 | 2.3 | true | null | same | same |

Thus rebuilding every defer is **proven**, but byte drift with no intervening publication is **not** observed. The isolated preparation block is not the final modern serializer: final output injects a frozen baseline block (m0) and a cached delta block (m1), which can differ from the newly prepared compartment block. The full real-transform SUBC outputs were also identical on all four passes, before and after: SHA-256 `3f107ae4a44b0d21e84ad6c0c80c86687f163f38fea01e820cadb0e2f3ffa02c`. A concurrent-publication test would be needed to establish final served-prefix drift; none is claimed here.

## Moving the historian trigger off the pass — analysis only

A routine size/commit-cluster check does not fundamentally need to run before every send. It can be computed after a provider response or on terminal `message.updated`, producing a versioned “eligible work exists” candidate for the next send. There is already a Pi `maybeFireHistorian` caller; OpenCode's present caller is the transform itself.

However, invoking today's synchronous reader from `message.updated` would still block the same OpenCode main thread and would be worse if run for every streaming delta. A useful move requires a coalesced terminal-event job and a worker or separate process for expensive reads/tokenization. Sending the response, accepting new tool results, reverts, compaction-marker movement, and migration/rebase must invalidate stale candidates. Streaming same-ID edits cannot be treated as append-only.

What a send still needs synchronously:

1. **Current force/urgent-band and actual provider-overflow decisions.** These depend on current model geometry, calibration, usage, reclaim that can land on this priced pass, and pending cache-bust signals, not just the previous terminal event. The pass cannot trust a stale “not enough work” result when context has just become unsafe.
2. **A coherent protected-tail boundary snapshot if starting or joining recovery now.** The trigger's snapshot is handed to `runCompartmentPhase` precisely to avoid a second resolution with different inputs. A precomputed snapshot must match source/history revision, coordinate generation, latest durable compartment endpoint, protected-tail policy/budget/prior boundary, open tool arcs, tag-token version and current context-limit configuration. Otherwise re-resolve on demand; never guess missing-anchor ordinals.
3. **Choice of whether to render new summaries or reuse cached output.** An event may publish future work, but a defer send must replay frozen m0/m1 bytes. It cannot incorporate new summaries just because an event completed between two passes.

Recommended future split: routine event-driven background evaluation with versioned results; a cheap synchronous pressure/candidate-validity gate; fresh boundary resolution only when a current send actually needs to start recovery or force-band behavior. Preserve the raw-history fallback for missing anchors until the data and marker lifecycle are repaired. Do not suppress force-band recovery merely because the ordinary drain budget is spent; emergency escalation has separate safety semantics. No such scheduling or budget-bypass change is implemented here.

## Proof and gates

- `bun run --cwd packages/plugin typecheck`: passed, including scripts.
- `bun run --cwd packages/plugin lint`: passed; three pre-existing informational template-literal diagnostics in unrelated files.
- Relevant tests: whitespace, scale, tool-drop operations, trigger and full transform suites: **122 passed**, zero failures.
- Pi typecheck passed. Pi `tail-hygiene-parity.test.ts` and `protected-tail-parity-pi.test.ts`: **7 passed**, zero failures.
- `pure-replay-differential.ts --ts-only <base> 4906bac9cf279ddfc5ccd1b8c74d85b02ba240b2`: four deferred passes byte-identical, including system/tools. Result `IDENTICAL`.
- The same command with `--priced`: `hard=true tail_m0_equal=true four_defers_each=true`; result `PRICED_EXPECTATIONS_MET`. Both refs preserve the shared priced/defer history digest `4ce19ae00732aa6549dfe829aaf01c8ee6da2dd212b86f9ac5a0718c2511a777`, including a restart; expected dropped tags `[56,59,62,65]` match.
- All eight ordinary MC advancing output hashes matched baseline/optimized per corresponding pass. The JSON-serialized full message array after the final advancing pass (pass 7, 130 output messages) has hash `ef64e447838114131b96b1ab4fea730dba54348e1d76c97f85c3c3e42c783fe4`.
- Three unconditional 100K-tag scale guards count actual hydrated tag rows, not elapsed time. They cover whitespace reload on each new-message/version change, the existing anchored trigger owner-floor contract, and fallback dropped-status replay. They do not certify the corrupt/missing-anchor fallback, which intentionally remains unbounded.
- Mutation proofs: restoring whole-session whitespace hydration failed only `whitespace replay reads only visible rows in a 100K-tag session, including new-message passes` (100001 rows versus <20). Neutralizing the existing trigger owner floor failed only `anchored trigger reads only live owner rows in a 100K-tag session` (100001 versus <20). Restoring the full-tag fallback failed only `flushed status fallback reads only visible drops in a 100K-tag session` (100000 versus 1). In each run the other two tests passed. Each mutation was staged-safe, marked `NON-VACUITY BREAK`, exhibited a nonempty working diff, then restored with an empty working diff. No mutant is committed.

## Remaining work

Repair SUBC's migration-truncated compartments before judging its hot-path performance. Follow with an actual host-client replay of that recovered history and a larger p99 sample. Separately investigate LKG digest memoization using immutable host revisions (not object identity, because host objects are rebuilt), and background/coalesced historian evaluation with versioned snapshots. Modern m0/m1 publication stability under degraded preparation remains an explicit correctness investigation, not a behavior change hidden in this performance patch.
