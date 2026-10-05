# Issue 619: re-review of first-edit accounting and advisory repair

## Verdict: block on one new Medium cache regression

The original blocking findings **1, 2 and 4 are repaired**. Findings **3 and 5
are now documented exclusions**, as requested, not newly enabled lanes. However,
the repair also strips a primary's earlier signed thinking when the only actual
edit is **after every signed block**. That extends the rewritten cache prefix
unnecessarily. The requested “doesn't add a strip where the old code correctly
kept thinking” check therefore fails. Fix the positional accounting in R1 below
before merging. No remaining High finding was reproduced.

This is a review-only delivery: only this report is committed. No tracked source,
test, configuration or store was modified; no mutation control was applied.

## Snapshot and method

- Read `docs/reports/issue-619-review.md` on master first.
- Reviewed branch:
  `alfonso/task/bg_f5320366833a5e2f-issue-619-subagents-never-apply-queued-drops-bet`.
- Repaired HEAD: **`2a378709c9459dc7ec8a1225b557ff05585e7a77`**,
  `mason: repair issue 619 first-edit accounting and advisory coverage`.
- Differential baseline: its immediate parent,
  **`2f14225ff68dfa51d2f355f8f0fa59cb426485d8`**. This isolates the repair, rather
  than attributing intervening master changes to it. The baseline reproduces the
  original review's image and trailing-decision failures.
- Checked out each revision **detached in this worktree**, then returned to the
  report branch. All source line references below are to the repaired HEAD, not
  the report branch's source.
- Ran full plugin and Pi suites in separate, sequential processes, Rust issue and
  advisory selections, and the repository's workspace TypeScript typecheck.
- Reconstructed the original inline probes from the original report's documented
  fixture; an original saved probe script was not available. Used real
  `runPostTransformPhase`, initialized in-memory DBs, `createTagger`, consistent
  persisted `isSubagent`, canonical `anthropic`, the real
  `isPrefixBoundThinkingModel(..., "claude-sonnet-5-5")` predicate, correctly shaped
  `metadata.anthropic.signature`, and fresh raw-array clones on every pass.
- Ran a **28-scenario pre/post corpus**, including independent primary, replay,
  trim-only and terminal-edit controls. “Ran” below means executed here;
  “reasoned” means source/contract analysis, not a paid-provider observation.

## R1 — Medium: terminal first edits unnecessarily strip earlier primary thinking

**New finding; ran and reproduced in all three lanes.**

**Locations:**
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2186–2190`,
`:2739–2740`, `:2769–2770`, `:2950–2953`, `:3697–3717`.
The report's claim that the ledger distinguishes terminal edits is too broad at
`docs/reports/issue-619-subagent-execute-ride.md:232–234`.

`recordFirstApplicationWireEdit` defaults `beforeNewerThinking` to `true`.
Image, stale-reduce and visible sentinel callers all omit that argument. They
therefore claim to precede newer thinking even when **no signed thinking follows
the edited message**. Only trailing-decision accounting actually supplies a
positional verdict (`:3518`). The falsely set bit reaches proactive invalidation
and freezes removal of an earlier, unaffected signed block.

### Concrete primary controls

The raw sequence is:

1. user `u1`;
2. assistant `a1`, signed reasoning followed by ordinary text;
3. user `u2`;
4. `edit`, either a processed user image, an old assistant `ctx_reduce` call,
   or assistant text `[dropped §1§]`;
5. user `u3`;
6. assistant `a2`, **plain text only**, no reasoning.

Each session is a persisted primary (`fullFeatureMode=true`, `isSubagent=false`).
All assistant trailing decisions are pre-frozen to `strip`. There are no queued
drops, other targets, fold/head signals, materialization requests, heuristic or
age-reasoning candidates (`clearReasoningAge=999`). Image tag and watermark are 1.
A baseline defer serves the raw history; a **96% force pass** then first-applies
the selected edit. User boundaries rule out merged-assistant stripping.

| Terminal lane | Before repair: signed blocks / proactive strip | Repaired HEAD: signed blocks / proactive strip | Materialized, both revisions |
| --- | --- | --- | --- |
| Image | 1 / none | **0 / `a1`** | false |
| Stale reduce | 1 / none | **0 / `a1`** | false |
| Sentinel | 1 / none | **0 / `a1`** | false |

The old code's `bustedThisPass=false` telemetry was incomplete, since the terminal
edit really occurred. Repairing that telemetry is correct. **Retaining `a1` was
also correct**: its preceding prefix did not change. The new strip shifts the
first changed message backward from `edit` to `a1` and persists that earlier
removal for future replay. This is an unnecessary prefix/cache regression, not
a new invalid-signature request.

The wire changes and earlier strip are **ran**. That edits after a signed block
do not change the prefix to which it is bound, and therefore do not require its
removal, is **reasoned** from the repository's prefix-bound contract. No paid
provider or production cache meter was used.

Three scratch tests execute the repaired pipeline directly and fail with
`Expected: 1; Received: 0`:

- `primary terminal image edit preserves thinking whose preceding prefix is unchanged`
- `primary terminal stale edit preserves thinking whose preceding prefix is unchanged`
- `primary terminal sentinel edit preserves thinking whose preceding prefix is unchanged`

**Required follow-up:** keep actual-edit telemetry (`any=true`), but derive
`beforeNewerThinking` from the changed visible locations and remaining signed
blocks for these lanes. A terminal-only edit must not itself trigger a strip.
Retain conservative invalidation for independent head/fold/materialization
changes. Add the three terminal controls while keeping the existing earlier-edit
lane/model tests green. Do not turn off the recorder wholesale: that would reopen
the original High finding.

## Original findings: closure assessment

### 1 — High, closed: earlier image/stale/sentinel edits invalidate later thinking

**Locations:** `transform-postprocess-phase.ts:2186–2190`, `:2739–2745`,
`:2769–2771`, `:2951–2953`, `:3361–3369`, `:3697–3717` under
`packages/plugin/src/hooks/magic-context/`.

**Ran:** the original image-only ordinary 70% execute fixture, with pre-existing
trailing decisions and later signed blocks `a1` and `a2` separated by a user turn:

| Control | Byte-identical to preceding defer? | Image removed? | Signed blocks left | Bust / proactive strip |
| --- | --- | --- | --- | --- |
| Primary | yes | no | 2 | false / none |
| Subagent | no | yes | **0** | true / `a1`, `a2` |

The parent revision retained both child blocks and reported no bust. The repaired
stale-reduce-only and placeholder-sentinel-only child controls likewise strip
both later blocks and report a real bust, without another reduction masking the
edit. Full plugin testing also executes all **nine** lane/model combinations at
`transform-postprocess-phase.test.ts:10068–10183` (Opus 5.5, Sonnet 5.5, Fable 5.1).

**Pure replay shown:** after the child image first application, rebuilding the
original raw array on both execute and defer produces exactly the same complete
message JSON as the first application. Both report `bustedThisPass=false` and
`proactiveThinkingStrip=null`. The normalized role/parts SHA-256 is
`820cf631fccd333ec6a74ab8546cb525b252dffde54a049efbd211a9a88e70d5`.
Appending user `u3` and signed assistant `a3` to the raw replay preserves `a3`;
replaying the old image id does not count as another edit. Stale/sentinel controls
give the same replay/no-new-edit result.

**Trim-only exception, ran:** primary and child controls using the existing
`google-vertex-anthropic` trim-only shape on Sonnet 5.5 remove the first five of
eight thinking blocks, preserve the last three byte-identically, report no
proactive strip, and replay complete message JSON identically on defer. Both
revisions produce SHA-256
`92c43dc352a680e13b058a55bc8f0d2ffacf681eae356c0478c02400f129c6dc`.
The plugin suite's trim-only, trim+drop, trim+materialization and gap controls at
`:10339–10413` also pass. The Pi suite's trim-only preservation test passes.

### 2 — Medium, closed: metadata-only trailing capture is not an edit

**Locations:** `transform-postprocess-phase.ts:3501–3519`, `:3557–3559`,
`:3609–3614`, `:3635`; regression controls at
`transform-postprocess-phase.test.ts:10186–10252` in the same directory.

**Ran all three original controls:** user / signed+text assistant / user /
signed+text assistant, with no blanks, targets or historical trailing decisions.
After a defer baseline, primary-bound, child-unbound and child-bound execute
controls all remain byte-identical, keep both signed blocks, report no bust and
perform no proactive strip. Child history acquires a matching `strip` decision
without a wire edit; primary execute still lacks a ride. Subsequent raw execute
and defer replays stay identical. The parent revision reproduced the unbound
false bust and the bound child's removal of both blocks.

**Reasoned:** comparison is between old and new frozen projections, not between
raw ingress and a replayed old strip. Poisoned-keep repair remains; the existing
repair tests pass. No broad assertion that every imported/provider projection
was exhaustively tested is intended.

### 3 — Medium, documented, not behaviorally removed: Rust child strip exclusions

**Locations:** `crates/mc-module/src/transform.rs:5158–5161`, `:5246–5258`,
`:6354–6368`; worker report `:257–264`.

**Reasoned:** the gate now explicitly describes the reductions-only inherited
history contract. `is_bust_pass` remains primary-only, so child execute does not
mint new image/system/age-reasoning strip units. The same strip-unit gate also
excludes stale-reduce units. The reduction ride does not erase these restrictions;
merged-reasoning and trailing healing still use the execute-inclusive provider
mutation gate. No image/age-reasoning parity claim is inferred from the five
passing Rust `issue_619` tests. Documentation, not widening this gate, was the
requested disposition.

### 4 — Medium, closed: a genuine non-scheduler HARD input and served-wire companion

**Locations:** `crates/mc-module/src/transform.rs:22902–23037`;
identity/advisory gates at `:4510–4512`, `:4593–4595`, `:4670–4687`.

**Ran:** both advisory negatives and the execute positive companion. The HARD
negative now submits `cfg1` against stored `cfg0`, asserts that mismatch, and
requires a primary-mode control to return **HARD** at 20% usage with TTL disabled.
This is a genuine render-identity input, not an expired-TTL or execute proxy.
The reconcile negative separately asserts missing-boundary and reconcile state.
Both child negatives assert defer, complete `ck_messages` equality to baseline,
retained old output, unchanged frozen units/watermark, and no summary/history.

The positive loops over **both** advisory setups at 75% execute: queued old output
disappears from served `ck_messages`, the queue drains, non-reduction frozen units
stay identical, stored render identity remains inherited, and no summary/history
is materialized. It therefore checks served wire, not just bookkeeping. Source
analysis confirms that the primary-only prefix-plan gate keeps these advisories
from pricing child defer reductions. The worker's claimed HARD-trigger and ride
mutations were inspected in its report but **not independently repeated** here.

### 5 — Low, documented, not behaviorally removed: Pi placeholder discovery

**Locations:** `packages/pi-plugin/src/context-handler.ts:6912–6929`;
worker report `:266–272`.

**Reasoned:** comments at the gate now explicitly exclude execute-only discovery
because Pi splices messages rather than neutralizing them in place. History
refresh/stable-id cutover discovers new shells; frozen ids replay every pass.
The worker report says “supported” lanes and lists exclusions instead of claiming
universal coalescing. **Ran:** full Pi suite, including refresh-only sentinel
invalidation/replay at `context-handler.test.ts:7414–7534`. That test is not proof
of an ordinary-execute placeholder discovery path, and is no longer described as
one. This intentional restriction is not an additional blocker.

## Primary cache comparison apart from R1

**Ran against both snapshots:** image/stale/sentinel plus no-work controls on
system-hash HARD fold, model-key HARD fold, explicit flush, and 96% force passes.
Compared serialized **role/parts** strings, excluding synthetic hook message ids
that are not provider content; also compared proactive-strip outputs and counts.
Raw replay assertions separately compare complete hook-message JSON.

- All **12 fold/flush cases** are byte-identical across the repair. Where old
  independent head/fold/flush accounting already stripped thinking, the new ledger
  does not change final content or add another strip.
- Force-only first edits **before** later thinking now strip those later blocks;
  this is the intended safety repair. Force with no real work preserves both
  blocks, stays byte-identical and reports no bust on both revisions.
- Three primary cases first applied/froze a lane on flush, appended new signed
  thinking, then replayed at force. Each keeps that new block and remains exactly
  equal to its preceding defer, with no bust or proactive strip. Already-frozen
  first-edit ids do not themselves invalidate new thinking.
- Primary ordinary execute admission remains unchanged, by executed controls and
  by the unchanged ride-signal/pending-op predicates. The repair ledger has no
  primary exclusion, so real primary first edits feed it too.
- **Exception: R1's three terminal first edits.** These are the only additional
  byte changes beyond the seven intended changes in the 28-case differential
  corpus. Do not call primary bytes universally unchanged after this repair.

## Verification run here and limits

Tools: **Bun 1.4.2**, **TypeScript 5.9.3**, **Cargo/rustc 1.99.0**.

| Command/check on repaired detached HEAD | Result |
| --- | --- |
| `bun run --cwd packages/plugin test` | **6752 pass / 4 skip / 0 fail**, 650 files, 203398 assertions; frozen install checked 995 installs / 1250 packages, no changes. |
| `bun run --cwd packages/pi-plugin test` | **1504 pass / 3 skip / 0 fail**, 138 files, 83925 assertions; separate subsequent process, frozen install unchanged. |
| `cargo test --locked -p mc-module issue_619` | **5 pass / 0 fail** unit tests; binary/integration selections ran 0. Compile queued for shared slots, then completed. |
| `cargo test --locked -p mc-module advisory` | **4 pass / 0 fail** unit tests; other targets selected 0. |
| `bun packages/plugin/node_modules/typescript/bin/tsc --version && bun run typecheck` | Version 5.9.3; all **four configured packages** passed (silent-on-success tsc commands exited 0). |
| `bun node_modules/.cache/issue-619-re-review-probes.ts` with isolated environment, once per snapshot for the final corpus | **28 scenarios per revision**, rebuilt raw arrays; retained baseline and repaired JSON/logs. |
| `PROBE_ROOT="$ROOT" bun node_modules/.cache/issue-619-re-review-compare.ts` | Passed 28 corpus comparisons/closure assertions; identified seven intended byte changes and three R1 over-strips. |
| `bun test --timeout 30000 ./node_modules/.cache/issue-619-terminal.test.ts` with the same isolated environment | **0 pass / 3 fail**, 12 assertions; directly executes repaired source. All failures are the three named R1 retention expectations, 1 expected / 0 received. |
| Report-branch `git diff --check` | Passed before commit; only this report is staged. |

An initial scratch “trim-only” attempt used consecutive assistants on canonical
Anthropic and also triggered merged-reasoning stripping on **both** snapshots;
it was not a trim-only control. The final control uses the repository's existing
Vertex trim-only shape. An initial scratch test invocation lacked `./` and Bun
selected no tests; the explicit path above selected and executed all three. Neither
setup error is being counted as a production regression or a passing gate.

No new tracked tests, source mutations, live-provider signature/cache validation,
full Rust workspace build, target bundle rebuild, workspace lint, exhaustive
primary wire corpus or standalone real-host e2e was run. This is source-pipeline
review, not a claim about a newly rebuilt bundle or production cache prices.
The worker's ten mutation controls do not cover R1's terminal edit placement.
Report-scoped AFT inspection was partial: Markdown has no registered authoritative
diagnostics producer. It is not being claimed as a compiler pass.

## Containment and retained evidence

No live store/configuration was opened or changed by the probes. They use
in-memory DBs and `setHarness("pi")` to prevent OpenCode fallback reads; HOME,
XDG config/data/cache/state/runtime, storage and TMPDIR are throwaway paths under
`$TMPDIR/magic-context/issue-619-re-review/`. No standalone OpenCode/Pi host was
launched. Package tests use their existing isolated fixtures; real-store tests
remained skipped. The report does not reuse the previous review's host results
as measurements run here.

Synthetic evidence retained under that root:

- `before-repair.json`, `before-repair.log`, `repair.json`, `repair.log`;
- `terminal-direct.json` (direct repaired pipeline run for the red scratch tests);
- `issue-619-re-review-probes.ts`, `issue-619-re-review-compare.ts`,
  `issue-619-terminal.test.ts` (also kept in this worktree's ignored
  `node_modules/.cache/` for imports/tool resolution).

**Merge condition:** fix R1's positional bit and add the terminal controls, while
retaining all repaired earlier-edit, metadata-only, replay, trim-only and advisory
assertions. Findings 3 and 5 remain accepted documented exclusions. No force-band
formula, primary admission, cooldown or prompt-policy change is requested here.
