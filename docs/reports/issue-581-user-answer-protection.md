# User-answer protection — issue 581

## Real-host observations

All captures used a mock Anthropic-compatible provider and fresh roots under
`$TMPDIR/magic-context/issue-581/`. Each root has `lsof.txt`, captured requests,
and host/session evidence. The probe scripts reject open paths under the live
OpenCode or CortexKit config/store locations. No live store was opened, copied,
or migrated, and this change adds no schema migration.

| Host tested | Tool and answer representation | Selection signal |
| --- | --- | --- |
| OpenCode 1.18.30 | Built-in `question`; completed tool part has `state.metadata.answers: [["ANSWER_581"]]`. | Structural `answers` array; tool name is irrelevant. |
| OpenCode 2.0.20 | Stored/API tool parts **still have** `state.metadata.answers`. But the `llm.context` event consumed by the plugin has separate `tool-call` and `tool-result` parts. Its result is `{type:"text",value:"User has answered…"}`, with **no answer metadata**. | The adapter marks completed built-in `question` results with internal `userAnswer: true`. This is the only named fallback. It is necessary specifically on the metadata-free context event, not on stored parts. |
| Pi 0.87.1 (`@earendil-works/pi-coding-agent`) | Pi has no built-in question tool; the shipped `examples/extensions/question.ts` asks through the host UI. Real answered result: `role:"toolResult"`, `toolName:"question"`, `details:{question:"CHOOSE_581",options:["ANSWER_581"],answer:"ANSWER_581",wasCustom:false}`. | Structural `details.answer` string. No named fallback. |
| OMP 17.0.4 | Mock provider invokes native `_ask`; the session result is named `ask`. Real answered result has `details:{question:"CHOOSE_581",options:["ANSWER_581"],multi:false,selectedOptions:["ANSWER_581"]}`. | Structural `details.selectedOptions` array. Custom-input and multi-question result shapes are also recognized. No named fallback. |

The shared TS/Rust fixture covers `answers`, `answer`, `selectedOptions`,
`customInput`, nested `results`, and the adapter's internal `userAnswer` marker.
Empty arrays/strings are conservatively protected too. Pi extensions control
their own result details; an arbitrary extension that discards all answer
provenance cannot be structurally identified. The supported shipped question
extension and OMP's native tool both retain provenance.

Final successful capture roots (under the macOS `$TMPDIR`):

- `opencode-1790751511427`: OpenCode 1.18.30, PID 16022; emergency dropped nine other tools, and 222625 later read tokens put the answer outside the 16000-token protected tail.
- `opencode2-EfvVAo`: OpenCode 2.0.20; emergency dropped nine other tools, with 221975 later read tokens. `drafts.jsonl` shows the metadata-free event, while `messages.json` shows stored answer metadata.
- `pi-RSoyRu`: real Pi question extension, answered through the PTY.
- `omp-FMzLL8`: native OMP ask, answered through the PTY.

The OpenCode scripts assert that the **post-emergency provider request body**
still contains the answered question, not merely that the session database does.
OpenCode 1 proves emergency execution through `transform_decisions`; OpenCode 2
uses its emergency log and actual dropped tag rows, since its capture did not
populate `transform_decisions`.

## Automatic-lane audit

The protection applies when automatic cleanup selects results to remove, not
inside the functions that perform removals. Agent-requested `ctx_reduce`
operations and historian compaction (summarizing and replacing older history)
can still remove an answer.

The checks below apply only to newly selected removals. `canDrop` returns false
for answer-bearing results; Rust's `active_arcs` list excludes their complete
call/result pairs. Supersession removes obsolete control-tool output or replaces
older edits with small location markers. Previously recorded removals still
replay, which is what the table calls frozen stripping.

| Lane | Guard before newly removing a result |
| --- | --- |
| OpenCode emergency | `packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts:120` checks `canDrop`. |
| Two-pass age reclaim (both TS hosts) | `packages/plugin/src/hooks/magic-context/tool-reclaim.ts:41` checks `canDrop`; synthetic application also checks it in `apply-operations.ts:365`. |
| Control-plane supersession (both TS hosts) | `packages/plugin/src/hooks/magic-context/supersession-reclaim.ts:109` checks `canDrop`. |
| Edit supersession/marker compression (both TS hosts) | `packages/plugin/src/hooks/magic-context/supersession-reclaim.ts:177` checks `canDrop`. |
| OpenCode duplicate dedup | `packages/plugin/src/hooks/magic-context/heuristic-cleanup.ts:313` now consults the answer veto. This lane previously bypassed it. |
| OpenCode stale `ctx_reduce` stripping | `packages/plugin/src/hooks/magic-context/drop-stale-reduce-calls.ts:129-134` has a separate structural guard for **new detection**. Frozen stripping still replays. |
| Pi emergency | `packages/pi-plugin/src/heuristic-cleanup-pi.ts:363` checks `canDrop`. |
| Pi stale `ctx_reduce` stripping | `packages/pi-plugin/src/heuristic-cleanup-pi.ts:481` now checks the answer veto. |
| Pi duplicate dedup | `packages/pi-plugin/src/heuristic-cleanup-pi.ts:585` now checks the answer veto. |
| Rust dedup, two-pass age, emergency, control-plane/edit supersession | All use the filtered `active_arcs` population in `crates/mc-module/src/selection.rs:1538-1546`; dispatch is at lines 1558, 1567, 1586, 1622 and 1652. Answer-bearing arcs are excluded there. |

OpenCode's admission predicate is in `tool-drop-target.ts:641-648`. Pi uses
`shared/tag-transcript.ts:1278`, fed by `transcript-pi.ts:951`. Standalone Pi
parts containing answers can forbid automatic removal, without allowing new
automatic removals of ordinary results that lack a matching call.

Caveman and system-injection cleanup operate on **message/text tags**, not
tool-result tags (`caveman-cleanup.ts:82-209`, `heuristic-cleanup.ts:209-250`,
`heuristic-cleanup-pi.ts:493-550,618-641`). They cannot select the answer result.
Legacy skeleton conversion changes the retained placeholders of already-dropped tools
(`apply-operations.ts:184-239`). Persisted drops replay without the new veto
(`apply-operations.ts:494-533`), and a regression explicitly verifies that an
answer dropped before upgrade stays dropped. Historian publication and explicit
pending operations remain independent of automatic admission.

The native codecs and TS encoder retain a list of answer-bearing block indices
in the host-neutral wire envelope's `provider_extras` metadata.
`transform.rs:4590` marks the corresponding items before automatic selection.
This information is not inserted into block content, hashes, or the
provider-visible prompt; a codec test compares answered and ordinary block bytes.

## Verification and mutation controls

- Plugin and Pi `typecheck` and `lint`: passed. Pi lint emits two existing warnings and one informational finding in unrelated tests.
- Reclaim, emergency, tool-drop, supersession, heuristic, transcript, adapter and marker suites: 185 tests passed; the subsequently added persisted-answer replay regression also passed (six protection regressions total).
- `CARGO_BUILD_JOBS=2 cargo test -p mc-module`: complete rerun passed, including 1446 unit tests and integration targets. Seventeen unit tests are intentionally ignored. The initial 240-second command cap expired after passing unit tests and several integrations; a 600-second rerun completed successfully. `MC_REAL_STORE_COPY` was unset.
- `CARGO_BUILD_JOBS=2 cargo clippy -p mc-module --all-targets -- -D warnings`: passed.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only master HEAD`: **RESULT IDENTICAL**, all four defer passes byte-identical, including system/tool hashes. Compared master `11d6b01dfa51290387f512a36e99e22396cc1018` to implementation commit `6099bb41cd869419eb975078a1804fa4193e575a`.
- Both real OpenCode emergency scripts and both real Pi/OMP PTY probes: passed.

Each mutation check temporarily disabled one protection to show its test really
could fail. The correct implementation was staged first, with an empty working
diff. The temporary change was marked `NON-VACUITY BREAK`; its nonempty diff was
captured before running the named test. `git checkout -- <path>` and `touch`
restored the staged implementation, and the working diff was empty again.
No mutation was committed. The worker's final delivery JSON records exact
controls and failing output under `mutation_evidence`.

Removing the OpenCode answer check caused emergency, age, supersession, dedup,
and the real 1.18.30 request assertion to fail individually. Removing the same
check from Pi's combined call/result target caused its age/explicit-drop test
and its emergency test to fail. Removing the OpenCode 2 fallback caused both
its adapter test and real 2.0.20 request assertion to fail. Applying the check
to explicit drops made the `ctx_reduce` test fail; applying it to persisted
replay made the old-drop test fail. Rust controls disabled automatic answer
exclusion and metadata recognition separately; each named test failed alone.

The initial duplicate test stayed green with protection disabled because its
records did not belong to the same owner, so the duplicate-cleanup code never
ran. The corrected test creates same-owner duplicates and verifies that an
ordinary duplicate is removed. Disabling protection then made its
answer-preservation assertion fail. Emergency regressions in both TS hosts
place the answer among the largest tier-3 results, require other results to be
dropped, and require retained tokens below the ceiling.
