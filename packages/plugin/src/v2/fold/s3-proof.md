# OpenCode 2 fold ownership: executed review record

Implementation base: `dc952bf35c6ed6db5925e284258db8985290ab25`. The unverified draft `53d21505` was applied without committing its history, repaired and verified, then committed as `64bd12338add7b7b868c3e4aec73ced49b87ea1d`.

## Executed pass taxonomy

Both local and provider-mode rows below ran against real GA 2.0.3 through `fold-s3-owner.test.ts`, not a simulated context callback. The context observer captures the outgoing host draft; request assertions inspect the independent mock-provider wire capture.

| Pass / stimulus | Observed change | Observed frozen state |
| --- | --- | --- |
| Host automatic compaction after 15,000 input tokens on the 16k model | Hook supplies MC baseline; actual durable compaction row appears; first context binds its actual seq and pins rendered checkpoint separately | One next-turn provider request, exactly the control turn alone: compaction adds zero requests. Three planted unarchived strings are absent from summary and present verbatim on the provider wire |
| First post-fold context | Checkpoint occupies index 0; MC volatile sentinel occupies index 1; uncovered pre-cut rows restored from the read-only store before post-cut rows | Raw ordinals before/after agree; no dependency on host `recent` (provider mode stores empty recent) |
| SOFT+ / ten defer turns | New user/assistant tail grows | Checkpoint digest holds ten turns; entire previously served identified prefix holds for three defer passes; all three restored strings remain on wire |
| SOFT after real historian publication plus pending drop | One hidden provider request publishes; execute pressure consumes the pending drop; new compartment content appears in m[1], leaves raw tail | Checkpoint digest holds; m[1] changes from its prior digest; following defer replays the two-message head byte-identically |
| HARD model / provider / system / epoch / structural mutation identities | Stale persisted identity operand is replaced; real shared transform advances materialization timestamp, folds published markers into checkpoint | Next defer has identical timestamp and checkpoint bytes. These are controlled persisted-marker mismatches, not claims that a test changed the user's live model |
| HARD upgrade state | Stale persisted upgrade-state component causes materialization | Checkpoint remains first; same restore/transform path used |
| HARD TTL | Host's stored response completion time is aged one hour; baseline materialization is older than that response; next turn materializes | No clock sleeps or replacement scheduler needed |
| HARD pressure backstop | A large fixture-published compartment becomes an m[1] delta on an execute turn; timestamp advances and its distinctive content moves into checkpoint | Next defer checkpoint digest is identical |
| Persisted host-summary mutation | Actual host row summary is overwritten; next pass reports `HARD reason=host_rerender` | Corrupted string never reaches provider; following defer holds recovered checkpoint digest |

The large pressure compartment is fixture data, distinct from the real historian publication already proven earlier in the same test. The HARD identity table perturbs cached operands to exercise the real comparison gates; the model/provider rows do not exercise host model-selection UI.

`owner.test.ts` additionally executes all four R3a arms: same provisional watermark replay, later provisional supersession, crash/restart actual-row binding, and rejection of a cut below watermark. Local same-cut replay/later-cut freshness and one-shot divergence are separate tests. Summary SHA and rendered SHA are separate identities.

MC-initiated compaction remains **gap-blocked**, not implemented: GA `Context.session` Pick lacks `compact` (promise/session.d.ts:105–106). The runner's wider client is fixture-only; no endpoint or invented client was added to product code.

## Marker runtime proof (I10)

The fixture adds entry counters to the actual four shared function declarations during bundling; it verifies all four declarations were instrumented. No import-graph assertion substitutes for runtime observations.

| Member | v2: fold + organic publication + ten turns | v1 control |
| --- | ---: | ---: |
| applyDeferredCompactionMarker | 0 | 1 |
| reconcileMarkerRepresentation | 0 | 32 |
| setPendingCompactionMarkerState | 0 | 2 |
| updateCompactionMarkerAfterPublication | 0 | 1 |

The v2 session has neither persisted nor pending marker state. The v1 control uses the explicitly authorized fixture-only RawMessageProvider populated from that real session's SDK messages, plus a real tool-dispatched direct historian publication to exercise the post-publish move. It does not manufacture a marker row or call the counter functions directly.

Report-only missing-boundary finding: the completed SDK-backed v1 control has a populated latest `end_message_id` (`msg_…`), not an empty one. Shared `mapParsedCompartmentsToChunk` copies `endLine.messageId` into that field; it does not synthesize missing source identity. Thus missing IDs from an earlier source-less control are not intrinsic to shared publication: they are source/fixture-dependent. This proof does not diagnose every production v1 raw-reader configuration or change shared code to accommodate the earlier fixture.

## Automatic paths and calibration

- Organic pressure, without a test hook: exactly one historian generate, successful run with `harness=opencode2`; total requests = one foreground + one hidden.
- Real execution-succeeded event wakes the existing scheduler; due classify dispatches one generate and marks ten real stored memories classified. No second scheduler was introduced.
- compress-cues runs one generate through the executor and applies its returned cue; task telemetry reports success. Tool-required tasks remain refused before dispatch per R38a; configured-chain filtering remains R37b.

Measured on the same 557-byte chunk prompt, verified present as an exact provider request string in each arm:

| Arm | Validator | Prompt bytes | System bytes |
| --- | --- | ---: | ---: |
| v1 child | pass | 557 | 63,894 |
| v2 own system | pass | 557 | 63,470 |
| v2 session system | pass | 557 | 11,712 |

The v2 default is MC's own system: exact equality with `COMPARTMENT_AGENT_SYSTEM_PROMPT` is asserted on the provider wire. GA honors system replacement. The transcript is not prepended to the calibrated chunk. The own-system arm preserves the intended historian framing while eliminating the v1 host's extra 424 system bytes. These are deterministic mock-provider measurements of transport shape and validator behavior, **not** an empirical model-quality comparison or billed-token calibration. V2 usage remains locally estimated because GA generate returns text, not usage metadata.

## Authorized shared hunks

Only two shared files differ from the task base:

1. `features/magic-context/mural/compress-cues.ts`: replace child lifecycle imports with the existing default/injected HiddenCompletionExecutor; make client optional and add executor argument; open the same titled/classifier run; substitute prompt transport and output collection; preserve shared manifest validation, retries, chunk application and timeout classification; account injected-executor usage; propagate typed transport refusal; close through the executor with the existing settled/privacy flags. No chunk selection or scheduling change.
2. `features/magic-context/dreamer/task-executor.ts`: exactly the two authorized hunks: remove the obsolete tools:false `unsupported_transport` refusal for compress-cues, and forward optional client + hidden executor to that task. Its existing import-order lint finding was not fixed because doing so would add an unauthorized shared hunk.

The resume repair also replaces a nonexistent v2 config property with `getProtectedTokensTierOverrides(config)` and reads fail-closed usage from complete history rather than the post-cut window. The latter preserves the existing I17 >=95% refusal after the new fold hides the prior usage row. The old I17 assertion was not weakened or renamed.

## Verification and limits

- Plugin full build and typecheck passed; full unit suite: 4,831 tests / 429 files, no failures.
- All 22 manifest-selected TS/v1 host files: 52 tests, no failures.
- Whole v2 lane: initial final-production run passed 49 tests / 13 files, 486 assertions. After type-only fixture cleanup, the full rerun passed 48 and hit one SQLite BUSY in the unchanged s2 test's fixture `ALTER TABLE`, before its hook invocation. That exact test passed on its one targeted retry (3 assertions); all s3 tests passed on the full rerun.
- Manifest: 82 live files; TS/v1 selection remains exactly 22. The final-tree v1 rerun passed all 52 tests; the final-tree plugin unit rerun passed all 4,831.
- E2E `tsc --noEmit` was also executed. All touched test/fixture diagnostics were fixed; remaining errors are outside this slice: `dropped-input-guard.test.ts` contextLimit option, `pi-compaction-off.test.ts` SQLite type mismatch, and `condition-compiler.ts` retina-local-fs subpath resolution in the e2e tsconfig. Plugin package typecheck itself passes.
- Full plugin lint was executed and remains red on pre-existing import/format findings outside these edits. All changed files except task-executor pass ordinary Biome checks (warnings only); task-executor passes with assists disabled, isolating its unchanged import-order diagnostic. No shared baseline formatting cleanup was smuggled in.
- AFT inspect timed out after six completed phases. Initial Sidekick comment reviews timed out; the final review completed and its one unclear mutation-runner comment was rewritten. TypeScript is the diagnostic authority.
- Live snapshot: **skipped (active v1 host); fd guard + private roots: enforced**. The fixture's controlled live-snapshot detector test still passes. No operator serve was stopped.
- `pure-replay-differential.ts --ts-only master HEAD` was executed twice after the implementation commit. Both executions failed **on the master arm before comparison**: the archived ref had no dist and `opencode serve` emitted no stdout/stderr or bound port within 30s. **HEAD was never invoked; no IDENTICAL claim exists.** Master resolved `fd142c63cd3a93968b25ab769c6a7e8c9b680358`. The chair explicitly instructed this worker not to modify the out-of-fence replay instrument and will rerun against final HEAD on a quiet machine before merge.

## Mutation evidence

`s3-mutation-evidence.json` preserves all executed controls: 19 reddened, one undefended. Each mutation was made only after staging the live implementation and observing an empty unstaged diff; non-empty mutant diff and empty restored diff were captured. Every reddened entry names exactly one failing test; unselected tests were filtered, not claimed as passing. The reusable runner is `packages/e2e-tests/tests/opencode2/mutation-s3-proof.ts`.

The one undefended control appended a timestamp to restored raw text. The shared transform's persisted tag-text replay masks that change: provider bytes still remain frozen. Same-file controls that remove restoration entirely and change restored metadata both reddened the real provider-mode test. The undefended text mutation is therefore reported, not silently discarded or called a red proof.
