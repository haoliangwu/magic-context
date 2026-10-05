# Smart-note missed and false fires

## Findings

- The compiler dry-ran generated checks through QuickJS and the guarded HTTP capability. A response over 64 KiB became a persistent compilation failure immediately. There was no feedback-driven repair attempt.
- Persistent failures stored `ready_reason` but left the smart note pending. Search could expose that reason, but normal nudges selected active session notes and ready smart notes, not pending smart notes. Consequently, recording a reason did not notify the owner.
- `gitTag()` returns a single nearest reachable tag, not the repository's tag set or ancestry. Retina's `git_tag_matching` similarly cannot express the reported two-clause ancestry/exclusion condition. Neither is an appropriate implementation of that condition.
- The historical compiled check for note #3071, watching non-ancestral tags or tags outside v0.1.0/v0.1.1 on cortexkit/insula, was deleted when the condition was rewritten and is unrecoverable from the available evidence. The probable defect class is an always-true OR between two name exclusions, or an ancestry comparison interpreted in the wrong direction. The fixture reproduces the exclusion-OR false fire: `name !== A || name !== B` is true for either allowed tag. This is a reproduction of the semantic failure, **not** proof that the deleted production check used that expression.

## Changes

- General compiler guidance now includes short examples of set exclusion (`allowed.indexOf(name) === -1`, never exclusion-OR), both GitHub ancestry comparison directions (`X...BASE`: ahead/identical proves X ancestral; `BASE...X`: behind/identical proves X ancestral), and bounded tag pagination that throws when the final permitted page is full. Release endpoints, numeric version comparisons and tag-object parsing are also covered. `gitTag()` is explicitly documented as a scalar nearest-tag operation.
- A persistent body-too-large dry-run error triggers one recompile, carrying the actual error and instructions to use smaller endpoints. The second failure terminates normally; the deadline and cancellation signal still apply. The 64 KiB security limit is unchanged.
- The sentence-specific tag compiler has been removed. All conditions use the existing general compiler transport. A regression verifies that the exclusion, ancestry and pagination guidance is present in the actual compiler request for both the original wording and a rewording. Fixture compiler output using correct set exclusion and ancestry stays unmet when v0.1.0 and v0.1.1 are the only tags and both are ancestors of master.
- Permanent compilation failures, and compilation failures reaching the fallback threshold, create a separate session notice containing the condition and error. The smart note remains pending. Notices target its bound owner session (or the evaluator's parent session for legacy unbound notes), trigger a normal nudge, and take priority over ordinary reminders. Successful anchored delivery atomically dismisses only the notice. The dismissed notice is retained to deduplicate retries of the same note/condition. Sticky anchor replay remains available. No live-store migration or modification is performed.

## Verification

- `bun install --frozen-lockfile`: passed; no manifest or lockfile changes.
- Plugin `bun run typecheck`: passed.
- Plugin `bun run lint`: passed (1,092 files).
- `bun test src/features/magic-context/smart-notes src/hooks/magic-context/note-nudger.test.ts src/tools/ctx-note/render.test.ts --timeout 30000`: passed, 118 tests covering checks, owner notifications and note rendering.
- All new tests use injected HTTP responses and disposable Git repositories. New SQLite fixtures are under `$TMPDIR/magic-context/smart-notes-fix/`; no live stores or live GitHub requests were used. The compiler transport retry tests inject settled model output, not a live model.
- Local-fs was investigated but not changed; its tests are not needed for this patch.
- Earlier mutation probes confirmed that tests detect disabled oversized-response recompilation and disabled owner-notice acknowledgement. The old special-case tag exclusion probe no longer represents the implementation. Removing the new set-exclusion guidance fails only `tag guidance reaches the compiler transport for original and reworded conditions`; the other fixture tests still pass. The prompt mutation is restored before committing.

## Limits

The historical cause is not conclusively attributed. The false-fire fix is general compiler guidance, not a special-case compiler or semantic validator. A sandbox dry run validates execution and boolean result shape; it cannot infer whether that boolean correctly implements arbitrary prose. The negative fixture explicitly demonstrates that injected exclusion-OR code can still pass compilation and return true. A cheap, general negative-fixture self-test is not available: it would need to interpret the prose again to identify the watched set and construct substitute responses for arbitrary generated capability calls. An expected result supplied by the same model could repeat its original mistake, rather than independently checking that model. No such schema or second compiler was added.

Tests prove guidance delivery and fixture behavior, not live-model compliance. GitHub compare responses can still exceed the unchanged body limit for large divergent histories; those are execution errors. A legacy note with neither an associated owner conversation nor an evaluator's parent conversation has no session to notify; its stored failure reason remains searchable. Delivery requires the owner conversation to resume with a new message so the notification does not modify an already cached message.
