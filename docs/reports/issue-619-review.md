# Issue 619: adversarial review of the subagent execute ride

## Verdict: block

The queued-drop fix works, including on a real OpenCode task child. Primary
execute admission is unchanged when the session is correctly classified. However,
the new permission exposes an image-only rewrite which leaves later
prefix-bound signed thinking intact. That is an invalid request for the models
this repository explicitly treats as prefix-bound. Fix finding 1 before merging;
finding 2 also contradicts the change's no-op claim. Findings 3–5 distinguish
remaining gate/coverage gaps from demonstrated new regressions.

This is a **review-only** delivery. No production code or tests were edited,
and no mutation controls were applied. Only this report is committed.

### Reviewed snapshot and method

- Target branch:
  `alfonso/task/bg_f5320366833a5e2f-issue-619-subagents-never-apply-queued-drops-bet`.
- Target HEAD: `a17babc1fd9eb67adc4ca68e32e36f671aa90b84`.
- Ran `git diff master...alfonso/task/bg_f5320366833a5e2f-issue-619-subagents-never-apply-queued-drops-bet`.
  The merge base was `9fdaf2876239090d8541156414c55488b067921c`;
  local master was `3b631ba19bc1395a86986a2661c10c4699cccc30`.
  Three-dot diff means changes since that merge base, not changes against all
  subsequent master commits.
- Read `docs/reports/issue-619-subagent-execute-ride.md` first, then GitHub issue
  619 and its maintainer reply, then the protected architecture invariants.
- Checked out the target **detached in this review worktree**, ran its actual
  source/bundle tests, and returned to the review branch to write this report.
  Source stayed unmodified throughout.
- All line references below are to the **target snapshot**, not this report
  branch's older source. “Ran” means executed here; “reasoned” means source
  analysis, not a claim of a reproduced provider response.

## Findings

### 1. High — image-only execute rewrites bypass signed-thinking invalidation

**Locations:**
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:2755–2762`,
`:3649–3675`; newly reachable through `:2019`.
The same accounting omission is visible in stale-reduce first application
at `:2727–2736` and placeholder/system sentinel discovery at `:2926–2978`.

**Concrete failing scenario, ran an inline pipeline probe:**

1. A canonical Anthropic subagent has a previously served user image, followed
   by two signed assistant reasoning blocks separated by a user turn. The old
   image's tag is at or below the persisted drop watermark. It has not yet been
   frozen into `processed_image_stripped_ids`.
2. The session reaches an ordinary 70% execute pass, below the 85% force floor.
   No pending drops, fold, flush, publication, heuristic candidate, age-reasoning
   candidate, or recovery flag exists. `clearReasoningAge=999`.
3. Trailing-blank decisions already exist for both assistants (`strip`, with
   neither source containing a blank). This prevents an unrelated trailing-blank
   event from accidentally masking the defect.
4. The new subagent permission first-strips the image to an empty text sentinel.
   The image lane persists its id but does not report the edit into
   `prefixEditBesidesReasoningTrim`. That predicate remains false, so
   `freezeReasoningOnBustingPass` is not called. Both later signed blocks survive.

Observed output from the probe:

```json
{"probe":"primary-image","identical":true,"imageRemoved":false,"signedBlocksLeft":2}
{"probe":"subagent-image","identical":false,"imageRemoved":true,"signedBlocksLeft":2}
```

The subagent result also reported `bustedThisPass=false`, `droppedCount=0`,
`proactiveThinkingStrip=null`, and `materialized=false` despite changing the
image bytes. The primary was the same fixture with `fullFeatureMode=true`.

The probe used real `runPostTransformPhase`, an in-memory initialized DB,
`createTagger`, raw messages rebuilt between passes, canonical provider
`anthropic`, and `thinkingBindingRecoveryEnabledForModel=true`. Its image was
the existing image-test shape: a `file` part with `mime=image/png` and
`data:image/png;base64,` followed by 220 `a` characters. Reasoning parts used
`metadata.anthropic.signature`. The image tag/watermark were both 1.
Both assistants had ordinary text after reasoning, and user messages separated
them, ruling out merged-assistant stripping.

Repeated both findings' primary/subagent controls with consistent persisted
`sessionMeta.isSubagent`, correctly shaped `metadata.anthropic.signature`, and
the actual `isPrefixBoundThinkingModel("anthropic", "claude-sonnet-5-5")`
predicate rather than a manually supplied model verdict. Both defects reproduced:
the image child retained 2 signed blocks, and the no-op child removed both;
both corresponding primaries stayed identical. This rules out a mismatched
session flag or an unrecognized model name as the cause of the probes.

**What is proven versus inferred:** the image rewrite and retained signed blocks
were executed and observed. The resulting Anthropic 400 is **reasoned**, not
obtained from a paid provider: replacing an earlier image is not the allowed
oldest-prefix-thinking-only trim, and the repository's own invalidation rule says
later signatures are bound to those preceding bytes. Opus 5.5, Sonnet 5.5 and
Fable 5.1 take this same predicate. The branch's mock host does not validate
cryptographic thinking bindings and uses `mock-sonnet`, so its green result
cannot refute this failure.

**Required fix:** feed every first-application wire edit, including processed
images, stale reduce calls and sentinelization, into the single actual-edit
accounting used by both telemetry and proactive thinking invalidation. Replay of
already-frozen ids must not count as a new edit. Add an image-only subagent
execute test with existing trailing decisions and later signed thinking; add
equivalent stale-reduce/sentinel tests so a simultaneous drop cannot conceal
these lanes. Keep the trim-only exception only when the *entire* pass is truly
oldest-prefix-thinking-only.

### 2. Medium — a metadata-only trailing decision can originate a gratuitous bust

**Locations:**
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3582–3587`,
`:3669–3675`;
`packages/plugin/src/hooks/magic-context/strip-content.ts:636–644`, `:687–696`.

**Concrete failing scenario, ran an inline pipeline probe:** a resumed/imported
or previously partially observed subagent has historical assistants with no
persisted trailing-blank decisions. Their source has no trailing blanks. A defer
pass records only the newest assistant. On the first ordinary execute pass,
recording the older assistant's `strip` decision changes no content at all, but
sets `bustedThisPass` and `lateEditBeforeNewestThinking`. On a prefix-bound model
that false edit indication then strips *both* assistants' signed thinking.
No queued or otherwise eligible content cleanup is necessary.

Controls and observed results:

| Probe | Content byte-identical? | Reported bust? | Proactive strip |
| --- | --- | --- | --- |
| Primary, prefix-bound flag on | yes | no | none |
| Subagent, prefix-bound flag off | yes | **yes** | none |
| Subagent, prefix-bound flag on | **no** | yes | `a1`, `a2` |

The fixture was user / reasoning+text assistant / user / reasoning+text
assistant, no targets or tags, `clearReasoningAge=999`, usage 70%, no independent
ride, and no existing historical trailing decisions. Each execute used a fresh
clone of the original raw array after a baseline defer. This is not necessarily
every normal newly created child: assistants observed individually while newest
will already have decisions. It is a concrete unsupported case in the broader
“nothing eligible means byte-identical” claim.

**Required fix:** distinguish persistence of a shape that already matches served
bytes from a real trailing-blank addition/removal. Only the latter invalidates
thinking or counts as a bust. Retain the existing poisoned-keep repair when it
actually changes the representation. Add the above three controls with signed
thinking and a fresh raw-array replay; the issue-619 no-op tool fixture does not
exercise this path.

### 3. Medium — Rust's reductions-only branch still has a second, primary-only mutation gate

**Locations:** `crates/mc-module/src/transform.rs:4684–4690`, `:5161`,
`:5246–5258`, `:5359–5375`, `:6354–6368`.

**Concrete scenario, reasoned:** an ordinary execute subagent has an eligible
queued/age tool drop and an eligible processed image, stale reduce shell or
age-reasoning removal. `pass_already_busting` is now true and the reduction lands.
But `is_bust_pass` is still `!req.is_subagent && is_provider_prefix_mutation_pass`.
New strip units and reasoning-clear units are discarded, and the subagent core
step accepts only `new_reduction_units`. The image/age-reasoning lanes therefore
do not join the ride. If the same stored session is later treated as primary,
they first land at a later primary bust; while it stays subagent, they may never
land at all.

This is a pre-existing reductions-only restriction, **not proof that this patch
introduces two rewrites in an unchanged Rust child**. Nonetheless, the broad claim
that the new shared permission admits all cleanup lanes across all engines is
false. Merged-reasoning stripping and trailing-blank healing use the other,
execute-inclusive `is_provider_prefix_mutation_pass` gate at `:6518–6578`, making
the distinction substantive rather than merely a variable name.

**Verification:** ran the four Rust `issue_619` tests and
`subagent_merged_reasoning_first_applies_only_on_execute_and_replays_on_defer`;
all passed. Neither asserts that an eligible image/age-reasoning lane joins a
drop on a subagent execute pass. No new Rust test was written for this review.

**Disposition:** either explicitly scope/document/test these reductions-only
exclusions, or wire supported subagent strip lanes through the shared permission.
Do not blindly remove `!req.is_subagent` from every use: prefix composition,
synthetic todo and caveman intentionally have different session eligibility.
This is a contract/parity gap, subordinate to the demonstrated blocker above.

### 4. Medium — the amended Rust HARD-advisory fixture no longer supplies its old HARD trigger

**Locations:** `crates/mc-module/src/transform.rs:22896–22905`, `:22936–22952`,
`:22955–22962`; TTL-to-HARD derivation at `:4517–4520`, `:4586–4593`.

**Concrete coverage failure, reasoned:** the `reconcile=false` fixture starts with
the already-bootstrapped `cfg0` state, leaves its boundary present and its
reconcile flag clear, submits the same `cfg0`, sets usage to 20%, and now sets
`cache_ttl="never"`. Previously the 300002ms time and observed response at 1ms
exercised an expired 5m TTL/HARD advisory. Disabling TTL removes that cause.
There is no asserted replacement HARD trigger. Consequently
`hard_advisory_without_prefix_materialization_cannot_price_reductions` can pass
even if a future bug lets a genuine non-executed HARD advisory authorize a drop:
the false/reconcile-free arm no longer demonstrates such an advisory.

The `reconcile=true` arm **does** still deliberately seed a missing boundary and
`reconcile_pending=true`; moving that arm to defer is defensible because execute
now independently prices reductions. It still asserts frozen units and the age
watermark remain unchanged, but it no longer covers the old execute/no-prefix
combination. Neither arm compares the complete served wire.

**Verification:** ran
`cargo test --locked -p mc-module advisory_without_prefix_materialization`;
both named tests passed. That is evidence of current assertions, not non-vacuity
of the removed HARD input. No source mutation was performed.

**Recommended fix:** retain a defer negative control, but actually seed and assert
a non-scheduler HARD advisory (for example a render-identity change that the
reductions-only branch does not execute). Keep the reconcile-specific input and
add an execute positive companion asserting eligible reductions apply while the
inherited HARD/reconcile advisory still cannot materialize history. Assert served
wire as well as frozen units. Do not restore the old “execute must hold” expected
result: that expectation is intentionally superseded by issue 619.

### 5. Low — Pi placeholder discovery remains narrower than the new shared ride

**Locations:** `packages/pi-plugin/src/context-handler.ts:6923–6944`;
`packages/pi-plugin/src/strip-placeholders-pi.ts:135–148`.

**Concrete scenario, reasoned:** a marked-session Pi child on execute drops the
only text in an old assistant. The `[dropped §N§]` shell is retained because
discovery uses `args.isCacheBusting` (history refresh), not `isCacheBustingPass`
(now true for subagent execute). A later refresh/cutover can remove that same
shell. In an ordinary no-history child it instead remains indefinitely. Thus
this lane cannot be described as discovering every eligible cleanup on the same
execute ride. The comments explicitly acknowledge and justify the narrower gate
because Pi splices messages rather than neutralizing them.

**Verification:** ran `strip-placeholders-pi.test.ts` and `index-env-guard.test.ts`
together, 15 passing tests. These cover safety/replay and the child bypass, not
the above new execute/refresh sequence.

**Disposition:** existing, intentional Pi behavior; not independently a merge
blocker or proof of a second *unpriced* bust. Reconcile the invariant wording
with this exclusion or safely coalesce text-only placeholder discovery while
preserving tool-call/result ownership. Never blindly splice tool-call owners.

## Invariant-by-invariant assessment

### One permission, including the force band

At ordinary below-force execute, OpenCode queued drops, heuristics, age/smart
reclaim, stale-reduce detection, image detection and sentinel discovery all reach
the new `hasReclaimRide` predicate. Pi's new arm also bypasses its once-per-turn
heuristic guard. Primary admission is not broadened. But permission alone is not
a proof of complete coalescing: findings 3 and 5 name remaining distinct gates.

There is another **reasoned edge** in both TS engines: at 85–95%, after the force
episode was consumed, routine heuristics/reasoning still consult the emergency
latch (`transform-postprocess-phase.ts:2302–2308`, Pi `context-handler.ts:6213–6220`),
and age reclaim is excluded by `!emergencyDropEligible` (OpenCode `:2579`, Pi
`:6495`). New image/sentinel first applications still consult the now-open
subagent execute permission. A first image/sentinel rewrite can therefore happen
without all otherwise eligible routine cleanup joining it; a later queued drop
rearmer can admit that cleanup. This is not an unlimited emergency bypass, and
the latch itself predates this patch, but the new ride must not be mistaken for
one uniform all-lanes permission at every percentage. No 90% split-lane fixture
was run in this review.

### No-op/replay discipline by lane

| Lane | Assessment on a subagent execute pass |
| --- | --- |
| Queued drops / heuristics / age reclaim | Existing eligibility/protection checks still apply; executed no-op controls and the real host show stable prefixes when these find no work. |
| Sentinel and image first application | Require actual eligible ids; permission does not itself create images/placeholders. However their actual-edit accounting omits thinking invalidation (finding 1). |
| Reasoning clear / prefix trim | Require an age cutoff and suitable parts; prefix-bound models avoid the gap-producing watermark lane. Rust has the narrower subagent restriction in finding 3. |
| Trailing-blank decisions | Can record a no-change shape and incorrectly report an edit, then strip reasoning (finding 2). |
| Caveman | OpenCode's caller enables it only for primaries; Pi gates discovery/replay on `!isSubagent`; Rust rejects subagent caveman. The new ride does not independently enable it. |
| Synthetic todo | OpenCode/Pi primary-mode guards and Rust `!req.is_subagent` eligibility keep it out of normal children. Permission is not a new todo trigger. |
| Frozen-id replays | Read and replay prior decisions each pass; growing tails do not reselect the old ids on defer. Existing strip, thinking, replay and issue-619 tests ran green. Reclassification/config changes are not proven to be byte-identical. |

The worker's no-op fixture is a useful **negative control**, not an exhaustive
proof: OpenCode's new case contains a protected tool and repeats its transformed
in-memory array (`transform-postprocess-phase.test.ts:9269–9282`); the real host
does rebuild genuine raw requests but does not supply bound thinking or the
image/trailing-decision states above.

### Can a long subagent now bust every execute pass?

**Yes.** This is a policy consequence, not automatically a correctness bug.
The candidate rules bound *what may be changed*, not the number of priced passes
in a continuously growing child. OpenCode/Pi advance the age watermark on every
authorized execute even when the batch is empty. The age selector uses active
tools at/below the previous watermark, a 250-token known-size floor (legacy
unsized rows remain eligible), `canDrop`, newest-todowrite/newest-ctx-reduce
exclusions, and protection during application. Smart supersession additionally
protects recent owners. Rust likewise advances its prior-execute frontier after
an admitted batch. Once dropped/frozen, a candidate is not selected afresh just
because the next request replays it.

None of those rules prevents an adversarial tool loop from contributing one
fresh, distinct eligible candidate per pass as newer mass displaces the token
floor. At sustained below-force execute pressure, a child can therefore make
one old-prefix rewrite on each request. The prior implementation could make
**zero** such ordinary-pressure rewrites and leave the same outputs accumulating
until flush/force. A finite corpus eventually exhausts eligible candidates; an
unbounded growing corpus does not. There is no new cooldown or minimum total
batch gain on the ordinary subagent arm.

### Re-run of the real-host cost table

Ran the target's task-child scenario here on actual **OpenCode 1.18.30**, with
the token threshold 5000, context limit 100000 and protected floor 4000. Its
nine execute requests stayed below force, and only two changed previously served
message content. These are this review's measurements, not copied worker output:

| Child pass | Decision | Old content changed? | Message bytes | Mock cache read | Mock cache write |
| ---: | --- | --- | ---: | ---: | ---: |
| 1 | defer | baseline | 116 | 0 | 900 |
| 2 | defer | no | 29903 | 29 | 8318 |
| 3 | execute | no | 59715 | 7475 | 8325 |
| 4 | execute | no | 59975 | 14928 | 937 |
| 5 | execute | **yes, A drops** | **30730** | **66** | **8488** |
| 6 | execute | no | 30990 | 7682 | 937 |
| 7 | execute | no | 31250 | 7747 | 937 |
| 8 | execute | no | 31510 | 7812 | 937 |
| 9 | execute | **yes, B drops** | 32019 | **128** | **8748** |
| 10 | execute | no | 32280 | 8004 | 937 |
| 11 | execute | no | 32543 | 8070 | 937 |

The first drop reduced the message body by **29245 bytes** despite appended
traffic. It traded a near-14928-token prefix read for a 66-token read and an
8488-token write on that rewrite, then replayed the frozen prefix on passes
6–8. The second drop traded a 7812-token read for 128 while C was appended.
The cache counters are a deterministic mock-prefix meter, independently checked
against the real host's persisted meters; they are **not production Anthropic
pricing/cache measurements**. The whole raw HTTP body also shrank by over 20000
bytes on the first drop. The unchanged system and old message-content prefix
were compared excluding only host-moved `cache_control` annotations.

For scale: 100 continuously eligible execute passes can make 100 rewrites rather
than zero below-force rewrites. If each rewrite invalidates about 20000 still-live
tokens after its first changed message, that exposes roughly **2 million tokens**
to ordinary input/cache-write pricing instead of cache-read pricing. Actual net
cost also subtracts tokens permanently removed from every subsequent request and
depends on provider rates/cache minimums. The table shows why batching/early
reclaim can repay its rewrite quickly; it does **not** show a global bound on
rewrite frequency. The maintainer explicitly authorized cleanup on subagent
execute, so this tradeoff needs accurate disclosure, not a silent primary-policy
change or a new force formula in this patch.

### Primary and session-mode checks

**Source proof, all three engines:**

- OpenCode derives `fullFeatureMode = !sessionMeta.isSubagent`
  (`transform.ts:988–989`); the only new production arm is
  `!fullFeatureMode && schedulerDecision === "execute"`. With a primary's
  flag it is false; all previous arms and their downstream inputs are identical.
  Compaction-off remains an independent outer mutation veto, not a synonym for
  reduced mode.
- Pi's new ride and once-per-turn bypass both require
  `args.sessionMeta.isSubagent`; both are false for primaries. The primary queue
  hold fixture passed. Pipeline arguments carry that same session flag at
  `context-handler.ts:3407`.
- Rust's only production change requires `req.is_subagent`; with false,
  `supersession_ride_available`, `pass_already_busting` and dependent choices are
  algebraically unchanged. The primary issue-619 hold test passed. The
  reductions-only/prefix-mode distinction uses the same request flag, not a
  scheduler label masquerading as subagent detection.

This establishes unchanged primary admission for identical correct inputs;
there was no separate master-versus-target wire corpus run for all primary
configurations.

**OpenCode 2 / issue 612:** `getOrCreateSessionMeta`
(`storage-meta-session.ts:86–124`) uses `session_v2.parent_id` at **fresh row
creation**, inserting the child flag atomically. It does not accidentally read
the retained v1 `session` table for OC2. Existing rows preserve their already
served classification rather than silently correcting their prompt mid-session.
Ran the real OC2 2.0.22 allowed child, denied child and denied primary fixtures;
all three passed, including their first-request mode and store-containment checks.
This checks classification and primary guidance, not an OC2 queued-drop cache
cost experiment.

**Pi children:** today's built-in hidden children use `MAGIC_CONTEXT_PI_SUBAGENT=1`
and `subagent-entry.ts`, which does not register the context handler. The real
children therefore do not acquire this transform merely because the predicate
changed. The new Pi tests exercise a deliberately marked session through the
handler. The child environment guard was executed and passed.

**Mid-life status changes:** ordinary host parent linkage is not a dynamic agent
name toggle. Existing OC2 rows deliberately do not follow later parent edits;
an old misclassified child may continue behaving primary-equivalently and not
receive the new ride. That is an existing compatibility limitation, not a primary
regression from this diff. OpenCode v1's `session.created` handler can update the
flag, and Rust accepts the current request flag each pass. If external code
actually flips a stored primary into a child, the next execute correctly starts
using the new arm; byte-identical behavior across that *mode transition* is not
guaranteed. There is no new status-transition freeze in this diff. None of the
four new engine cases tests a transition; do not claim they do.

### Thinking-bound models and advisory coverage conclusion

The existing **oldest-prefix trim** rules are sound in shape: prefix-bound models
skip gap-producing watermark clears, stop at ineligible blocks, and preserve
newer thinking only when trim is the sole edit. The executed OpenCode suite
included primary/subagent trim-only replay, trim+drop full stripping, ineligible
middle-block protection, and Rust-host trim-only preservation. Pi's executed
handler suite included both invalidated-thinking stripping and trim-only
preservation. Those tests do not observe the unreported image edit in finding 1.

The new ride does not directly reorder signed blocks, but it **does** expose
previously suppressed cleanup with incomplete invalidation accounting. “All
existing tests pass” is insufficient to conclude “no 400.” The negative Rust
advisory tests also need the input/coverage repair in finding 4; their passing
defer assertions are not equivalent to their former expired-TTL/execute setup.

## Verification actually run here

Tools: **Bun 1.4.2**, **TypeScript 5.9.3**, **Cargo/rustc 1.99.0**.
All following commands ran on the target detached checkout unless noted.

| Command/check | Result |
| --- | --- |
| `bun test --timeout 30000 packages/plugin/src/hooks/magic-context/cache-busting-signals.test.ts packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts` | Passed, 230 tests / 0 failures, isolated process. |
| `bun test --timeout 30000 packages/pi-plugin/src/context-handler.test.ts` | Passed, 139 tests / 0 failures, 520 assertions, separate process. |
| `cargo test --locked -p mc-module issue_619` | Passed, 4 unit tests; integration targets selected 0 tests. Initial compile queued behind shared build slots, then completed. |
| `cargo test --locked -p mc-module advisory_without_prefix_materialization` | Passed, both advisory unit tests. |
| `cargo test --locked -p mc-module subagent_merged_reasoning_first_applies_only_on_execute_and_replays_on_defer` | Passed, 1 unit test. |
| `bun run build` | Passed, three package builds and 4 embedded OC2 server tests. Rebuilt the target bundle before the real-host run. |
| `bun packages/plugin/node_modules/typescript/bin/tsc --version && bun run typecheck` | Version 5.9.3; passed all four configured package typechecks. |
| `PATH="$HOME/.opencode/bin:$PATH" TMPDIR="$TMPDIR/magic-context/issue-619-review" MC_E2E_KEEP=1 bun test --timeout 120000 packages/e2e-tests/tests/subagent-execute-ride.test.ts packages/e2e-tests/scripts/validate-mode-manifest.test.ts` | Passed, 7 tests / 0 failures, 84 assertions; real OC 1.18.30. |
| `TMPDIR="$TMPDIR/magic-context/issue-619-review/opencode2" MC_E2E_KEEP=1 bun test --timeout 180000 packages/e2e-tests/tests/opencode2/subagent-mode.test.ts` | Passed, 3 tests / 0 failures, 75 assertions; real OC2 2.0.22. |
| `bun test --timeout 30000 packages/pi-plugin/src/strip-placeholders-pi.test.ts packages/pi-plugin/src/index-env-guard.test.ts` | Passed, 15 tests / 0 failures, 76 assertions. |
| Inline `bun -e` probes described in findings 1 and 2 | Ran, 2 image controls and 3 no-op controls, then 4 strengthened primary/child controls with real model detection and consistent persisted flags; observed both defects. No test file/source mutation. |
| Final report-only `git diff --check` | Passed on the delivery branch. |

An initial **combined Pi + OpenCode test process** produced 360 pass / 9 fail:
the Pi harness global leaked into OpenCode compaction-marker fixtures, which
failed with `OpenCode database is not writable from a Pi-compatible process`.
Running the two engines in separate processes resolved all nine failures without
changing code. This is a test-process isolation issue, not a reproduced defect
in the proposed permission. An initial root-level `./node_modules/.bin/tsc`
version lookup was absent; the repository's package-local installed compiler and
named typecheck script were then used successfully.

No new test suite, live-provider signed-thinking validation, exhaustive primary
differential corpus, full Rust workspace build, workspace lint, or mutation
control was run. The findings explicitly label the corresponding limits.
Report-scoped AFT inspection was partial because Markdown has no registered
authoritative diagnostics producer; it is not being claimed as a compiler gate.

## Store containment and retained host evidence

No live stores/configuration were opened, read, written or migrated. Host roots
were under `$TMPDIR/magic-context/issue-619-review/`; the harness isolated HOME,
XDG config/data/cache/state/runtime, OpenCode DB and Magic Context storage paths.
The v1 scenario performed `lsof` containment assertions before and after the
task; the OC2 fixtures also asserted every open DB path was within their root.
Inline probes used initialized **in-memory** DBs, `setHarness("pi")` to avoid
OpenCode fallback reads, and throwaway HOME/XDG/storage environment paths.

Kept v1 proof root (synthetic fixtures only):

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-619-review/magic-context/issue-619/opencode-e2e-2ROpWV
```

Host pid was 99325. Proof files include `proof/host-lsof.txt`, `proof/passes.json`,
`proof/host-cache-meters.json`, `proof/requests.json` and `proof/host-stderr.txt`.
They are not committed. OC2 host pids 63019, 63073 and 63101 used sibling
throwaway roots under the review's `opencode2/` directory. All host processes
were disposed by their fixture teardown.

## Minimum follow-up before merge

1. Account for first image/stale-reduce/sentinel wire edits in signed-thinking
   invalidation and actual-bust telemetry; add isolated lane-only tests.
2. Stop metadata-only trailing-decision capture from stripping thinking on an
   otherwise empty execute pass; keep the three primary/plain/bound controls.
3. Repair the HARD-advisory negative test's genuine trigger and add an execute
   reductions-only companion. Explicitly settle/document Rust/Pi lane exclusions
   rather than claiming universal all-lanes parity from the current four cases.
4. Keep the threshold/force formula and primary admission unchanged. Accept and
   disclose that continuously eligible subagent work can now rewrite each execute
   pass; the real-host table demonstrates successful batching, not a frequency cap.
