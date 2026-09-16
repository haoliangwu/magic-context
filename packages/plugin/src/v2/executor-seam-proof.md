# Hidden completion executor seam: review record

Baseline: `e2dfcb236a70dea8482953b7ede915fc7a86d569`.

## Shared hunks

- `hooks/magic-context/compartment-runner-types.ts`: lifecycle/identity/completion types, typed refusals, optional executor and marker publication members; optional-client generic limited to the incremental entry.
- `hooks/magic-context/compartment-runner-historian.ts`: extracted default child open/prompt/collect/close transport; executor threading through initial, repair, editor and explicit fallback constructors; executor usage/harness accounting. The transient loop, settlement latch, validation, repair and fallback ordering stay shared. Only terminal v2 preflight refusal stops the automatic session-model last resort.
- `shared/model-suggestion-retry.ts`: one optional SDK-prompt transport callback, threaded inside the existing timeout/suggestion/fallback orchestration; child abort and diagnostic identity use the callback's handle identity, never a v2 user session.
- `hooks/magic-context/compartment-runner.ts`: type-only widening of incremental lifecycle helpers.
- `hooks/magic-context/transform.ts`: optional executor, existing marker strategy publication members, availability guards and pass-through at the existing recovery/compartment call sites.
- `hooks/magic-context/transform-compartment-phase.ts`: availability guards and executor/marker pass-through at its two existing start sites.
- `hooks/magic-context/compartment-runner-incremental.ts`: optional-client directory fallback, validated-pass forwarding, existing pending/direct marker publication calls. Harness substitutions are at baseline line 151 (`historian_runs`) and line 988 (primer provenance); both were explicitly authorized. No publication/fold algorithm was added.
- `features/magic-context/dreamer/classify.ts`: the same lifecycle at the existing transport points, retaining shared output validation and module authority behavior; explicit executor-metered invocation accounting.
- `features/magic-context/dreamer/task-executor.ts`: injected completion executor and parent identity, tools refusal before task dispatch, classifier forwarding, existing provider-failure telemetry, type-safe v1 client access for tool transports.
- `features/magic-context/dreamer/task-registry.ts`: truthful per-task tool requirements.

## Decisions correcting the initial map

1. `attempt()` settles the prompt; `collect()` remains at the original post-loop read point. Putting message reads inside the attempt would retry transient output-read failures and move the completion log. The owner chose exact v1 order over the initial three-method sketch.
2. Mapping and verification output one manifest but require read-only tools to inspect backing code. The owner corrected map-memories, verify and verify-broad to `requiresTools: true`; their transports and prompts are unchanged. Classify and historian are text-only and use generate.
3. V2 preflights the configured chain as a whole. A matching configured fallback is usable; a nonempty chain with no matching model refuses without silently appending the session model. Unset configuration uses the current session model.
4. compress-cues is genuinely tool-free but its transport lies outside this fence. It is `requiresTools: false` and explicitly refuses with `unsupported_transport` on v2. The owner assigned its transport substitution to the follow-up slice.
5. The second incremental harness literal is primer provenance, not an invocation fallback. Its corrected location was explicitly authorized.

## Six v1 identity sequences

`v1-sequences.golden.json` was captured with the exact baseline historian and model-retry source files temporarily restored from the baseline Git objects. The live implementation was first staged, then restored after capture. The fixture compares serialized request bodies, message/usage responses, retirement requests and the prompt-settled log position. Its SHA-256 is `48a53e1bedaf2b366bc550e8e6f7f78ba8a460f1e153f5d9819d2c695ee841d5`.

| Scenario | Baseline and branch call order |
| --- | --- |
| Clean | create → prompt → settled log → messages/usage → delete |
| Transient | create → prompt failure → prompt on same child → settled log → messages/usage → archive (unsettled latch preserved) |
| Validation repair + editor | Three distinct create → prompt → settled log → messages/usage → delete runs; repair body and editor agent are pinned |
| Fallback model | create → failed primary prompt → archive; fresh create → alternate-model prompt → settled log → messages/usage → delete |
| Length-capped reasoning-only | create → prompt → settled log → messages/usage → delete; pass fails without publication |
| Aborted | create → failed prompt → archive |

## Verification

- Plugin typecheck and full build pass.
- Full plugin suite: 4,824 passing tests across 427 files.
- All 22 manifest-selected v1 OpenCode host files: 52 passing tests, including historian-success and slow-historian.
- Real GA 2.0.3: historian publishes a compartment through genuine `Context.session.generate`; exact session-list equality before/after; exactly one provider request; `historian_runs.harness = opencode2`; no marker state. The source is the real host's stored conversation and the shared runner publishes it.
- Real GA configured-model refusal and tools-required dream refusal: no provider requests; dream dispatch sentinel stays zero and failed telemetry is persisted.
- Real GA warming-shaped generate: before/after hook draft JSON is byte-identical and its provider request retains the real transcript.
- Manifest coverage: 79 files; TS/v1 invocation remains 22 files.
- Nine safe mutations each reddened only its named test: calibrated prompt replacement, warming discrimination, configured-chain preflight, tools gate, persisted harness discriminator, per-attempt model check, unset-model fallback, v1 title identity, and explicit fallback executor forwarding. All were restored with an empty unstaged diff before proceeding.
- The committed-ref `pure-replay-differential.ts --ts-only master HEAD` result is recorded in the delivery declaration; it must run after the implementation commit, not against the old HEAD.

## Limits of this seam

GA generate returns only text, not provider usage or finish metadata. V2 usage is an explicit local tokenizer estimate accumulated across attempts (the hermetic scratch probe exercises its character-estimate fallback when tokenizer assets are absent); it is not billed usage. There are no invented child rows or assistant-message usage records. GA exposes no reasoning/length-cap flag through this method, so shared empty/manifest validation remains the output fence.

This change adds no fold owner, second orchestration or dream scheduling loop. The dream task executor is injectable; existing v2 event-trigger and dedicated status-UI wiring are not introduced by this seam. Refusal codes and actionable model guidance are retained in the existing error/dream-run telemetry.

AFT diagnostics timed out twice after completing 12 phases; successful TypeScript checks are the diagnostic authority. Comment review ran (lint-only; cold-reader service unavailable). The package formatter passed for plugin files; e2e files are outside that formatter's configured include set.
