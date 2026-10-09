# Adversarial protected-tools review

Review target: `9185f46176` on
`alfonso/task/bg_96e1f8e361fdcfb2-protected-tools-map-and-smart-drops-always-on`;
dispatch base `3ba0f0004289798681054955226a1e47e7f6ed57`.
The review worktree starts at master `52dc2620a9` and contains no production edits.
Candidate source is extracted with `git archive` into the ignored
`target/protected-tools-review/candidate/` inside the review worktree.
All file:line references below refer to the candidate unless stated otherwise.

## Scope and isolation

The protected section of `ARCHITECTURE.md`, especially lines 68–83, is the
acceptance contract: automatic mutation is ride-only, a defer pass replays
frozen bytes, and queued work cannot originate a bust.
The candidate's design and `docs/reports/protected-tools-queued-drops.md` were
read directly from the named commit; the latter is absent on the review base.

No live OpenCode or Magic Context stores/configuration are opened by this review.
Checks use in-memory test databases or throwaway roots. No host/model invocation
is planned; therefore a live host `lsof` proof is not applicable. Every shell
command is bounded by an outer `timeout`; Rust checks run with `-j 2` and no
concurrent host or Cargo build.

## Verdict

**Do not merge on the current evidence.** Two blockers and three should-fix
findings have executable reproductions below. No production changes were made.
The existing protected selection/hold goldens pass in all three lanes, but they
do not defend the stale-strip or actual fold-retirement paths.

Path key for the short file names used below:

- OpenCode hooks: `packages/plugin/src/hooks/magic-context/`.
- Shared TS storage: `packages/plugin/src/features/magic-context/`.
- Pi hooks: `packages/pi-plugin/src/` (explicitly labeled Pi below).
- Rust module: `crates/mc-module/src/` (explicitly labeled Rust below).

## Findings

### Blocker: protection can exhaust reclaim without a pre-send refusal

The per-tool protected set never yields at 95% (`emergency-drop.ts:269–270`,
`transform-postprocess-phase.ts:2252–2255`). Eight protected completed results
can themselves exceed the request limit; selection returns no drops and the
postprocess pipeline returns all eight active, with zero reclaimed tokens.
The normal refusal predicate requires a **previous provider rejection** and no
fold (`transform-postprocess-phase.ts:1650–1659`); even a trusted over-limit
estimate and provider-proven limit do not refuse the first oversized request.
`transform.ts:2865–2880` uses that predicate. Its separate over-limit check at
`transform.ts:2957–2967` applies only to degraded passes, not successful no-op
reclaim. This violates the review's explicit “over-limit must never happen”
requirement. It is an inherited fail-closed limitation made reachable with
arbitrarily large user keep counts, not a newly introduced refusal-policy edit.

Regression: `review regression: impossible protected reclaim must refuse an
over-limit wire before provider rejection` fails (`shouldAbort: false`).

### Blocker: stale stripping bypasses protected tools (and differs by runtime)

OpenCode's canonical-Anthropic path calls `dropStaleReduceCalls` with only a
message-count window, not the per-tool set
(`transform-postprocess-phase.ts:2740–2747`). That function explicitly selects
`ctx_reduce` **by name** (`drop-stale-reduce-calls.ts:6–27,137–143`). A priced pass
with 30 unrelated later messages strips **all three** newest completed
`ctx_reduce` results into empty text sentinels, while all three tags remain
active and in the default protected set. This breaks the stated keep-N promise
even without custom configuration.

Pi has a different leak: its stale selector still hardcodes three exemplars
(`packages/pi-plugin/src/heuristic-cleanup-pi.ts:75,281–294`). The application
loop at lines 488–508 does not check `protectedTools`, even though the function
computes that set at lines 344–347. With `ctx_reduce: 6`, it drops protected tags
1, 2 and 3. The Rust non-tool strip planner likewise emits `stale_reduce` units
based on message position/name without consulting the selected protected set
(`crates/mc-module/src/transform.rs:13174–13181,13191–13197`); that observation
is source review, not a new executed Rust regression.

The design explicitly exempts frozen strips at `docs/designs/protected-tools.md:38`
but says they “don't select tool results by name”; that rationale is false for
stale `ctx_reduce`. If this exception is intentional, the public keep-N claim
must be narrowed rather than declaring all automatic drops protected. As
specified in the review brief, the current implementation does not keep N safe.
Frozen **replay** must remain immutable; only first detection needs to honor
the effective keep set, without resurrecting an already stripped result.

Regressions:
- `review regression: newest protected ctx_reduce results must survive automatic
  stale stripping` fails with three empty text parts replacing the raw results.
- `review regression: Pi stale removal must honor a custom ctx_reduce keep count
  above three` fails with dropped tags `[1, 2, 3]` instead of `[]`.

### Should-fix: nudge accounting adopts protection on SOFT+ (including upgrade)

`transform-postprocess-phase.ts:2177,3869–3875` computes and passes the live map
on every pass. `tail-hygiene-walk.ts:1173–1178,1269–1276` can re-freeze a baseline
when protection enters on a defer, and `transform-postprocess-phase.ts:3932–3936`
then resets a delivered Channel-2 lease through `channel2-cycle.ts:26–33`.
A `probe: 1` map change takes U from 12,002 to zero and changes durable nudge
state from `delivered` to empty on a pass reporting no bust and identical bytes.
The design's promise that map changes take effect only on a rebuilding pass is
therefore not true for nudge state.

There is also a default-only upgrade case: the old U projection excluded the
newest three `ctx_reduce` results, **not** the newest `todowrite`; the candidate
excludes the latter too (`tail-hygiene-walk.ts:393–401`, versus dispatch base
lines 393–403). The first unchanged SOFT+ pass can rearm a delivered lease even
with no config edit. Existing prompt bytes in both regressions remain identical;
this finding is state/cadence drift, not evidence of an independent wire bust.

Regressions: `review regression: protected map change on defer must not reset
delivered nudge state` and `review regression: unchanged defaults on upgrade
must not rearm Channel 2 on SOFT+` both fail.

### Should-fix: actual fold trim does not retire a held historian queue row

The shared fixture manually calls `markTagsCompactedByMessageIds`
(`protected-tool-holds-fixture.test.ts:82–93`), so it does not prove the fold path
does that work. A real `runPostTransformPhase` model-change HARD fold trims the
held raw `todowrite` and retains the live tail, but leaves its tag active and its
pending row held even after another priced drain. Actual delivery trimming at
`transform-postprocess-phase.ts:2800–2824` does not populate the separate
`trimmedMessagesAtCompactionBoundary` input consumed at lines 3002–3006.
The main transform only captures that input around **initial preparation** when
`isCacheBusting && deferredHistoryWasPendingAtPassStart`
(`transform.ts:2030–2054`), not the subsequent off-wire fold's delivery trim.

The raw copy does leave the wire; the defect is stale active/protection/queue
bookkeeping, not proof of indefinitely raw sending. It can continue occupying a
keep-count slot and holding pending work when the source is no longer visible.
The fold regression deliberately does not invoke the retirement helper itself.

Regression: `review regression: executed fold must retire the held historian row
it actually trims` reaches `prefixTrimStatus: applied`, then fails with
`{ status: active, pending: 1 }` instead of `{ status: compacted, pending: 0 }`.

### Should-fix: repeated historian enqueue of one held tag grows without bound

`compartment-runner-drop-queue.ts:45–57` filters active status, not already-pending
membership. `storage-ops.ts:13–18,88–96` uses an unconditional INSERT. A protected
row remains active across drains (`apply-operations.ts:356–359`), so 100 repeated
publications/enqueues of the same observed raw tag leave 100 held pending rows.
Agent `ctx_reduce` does deduplicate requests against its pending snapshot
(`tools/ctx-reduce/tools.ts:231–249`); the historian path does not. This is not
evidence that ordinary disjoint historian chunks duplicate, but a repeated or
overlapping publication has no storage-level bound or idempotency. Longer hold
lifetimes expose the pre-existing duplicate-queue weakness.

Regression: `review regression: repeated historian publication of a held result
must have bounded pending depth` fails with length 100 instead of 1.

## Answers to the seven attacks

1. **Rotation alone / SOFT+.** No new wire-bust origin found in the tested
   rotation/drain paths. The new rotation control compares the entire previously
   served message slice, observes `bustedThisPass: false`, and keeps the queued
   row pending. Queued mass stays out of U even after rotation. Unqueued mass can
   become reclaimable as protection exits; that is measurement, not a wire edit.
   The branch's OpenCode/Pi priced-drain tests and Rust
   `protected_tool_snapshot_is_the_selection_set_and_rotation_does_not_bust`
   and `protected_tool_queued_drop_persists_until_rotation_and_a_priced_pass`
   also passed. **Nudge state is not frozen**: see the should-fix finding above.

2. **Upgrade.** The tested unchanged SOFT+ message bytes remain identical, for
   both ordinary defaults and the branch's legacy `smart_drops: false` backlog
   case. Nudge state does not necessarily remain identical. There is **no
   unconditional first-pass byte-equivalence guarantee**: if the first pass is
   already priced, behavior intentionally differs. A differential default-only
   emergency control runs the dispatch-base and candidate planners on the same
   eight `todowrite` results: the old plan selects newest tag 8, the candidate
   does not. The default counts equal old constants, but the old todo rule did
   not cover every lane. For `smart_drops: false`, supersession now runs on the
   first rebuilding pass, not on defer; that is the requested contract change.
   The candidate's `legacy smart_drops false backlog stays byte-identical on
   defer and lands on the first rebuilding pass` test passed unchanged.

3. **Signed thinking.** No new held-drop bypass of the strip rule found. The
   new control holds a drop, rotates its result, applies it on a priced pass,
   and observes the newer signed-reasoning block in `proactiveThinkingStrip`.
   OpenCode includes `pendingOpsDidMutate` in `prefixEditBesidesReasoningTrim`
   (`transform-postprocess-phase.ts:3737–3769`); Pi includes it in its returned
   prefix-edit flag (`context-handler.ts:7379–7389`) used by the strip permission
   at lines 3771–3775. Rust's reasoning-trim-only exemption requires
   `!reductions_pending_now` (`transform.rs:5335–5341`), so a newly applied held
   reduction cannot use that exemption. Model recognition covers Fable 5.1,
   Opus 5.5 and Sonnet 5.5 (`overflow-detection.ts:241–263`). This is a local
   edit/strip audit, **not** a live cryptographic/provider acceptance probe.

4. **95%.** Protection can make reclaim insufficient or zero. There is no
   successful-path pre-send refusal for the initial over-limit case proven by
   the regression; see blocker. The design's “95% refusal sooner” assertion
   (`docs/designs/protected-tools.md:42`) overstates the implemented guard.
   Pi's 95% host branch notifies/waits/reclaims (`context-handler.ts:3240–3315`);
   notification is not itself refusal. No live over-limit request was sent.

5. **Parity.** Shared `protected-tools.json` and `protected-tool-holds.json`
   fixtures passed in TS, Pi and Rust. The five selection lanes are covered,
   plus normalization/rotation/hold cases. The TS/Pi held-historian fixture
   uses the same TS helper with explicit retirement; it is not a Pi historian
   fold integration test (`packages/pi-plugin/src/protected-tool-holds.test.ts:1–24`).
   Passing these goldens therefore does not establish end-to-end parity; the
   stale-strip regressions show a real default/custom-count gap outside them.

6. **Historian holds.** A real OpenCode postprocess HARD fold **does remove the
   raw protected copy**. It does not reliably retire the tag/pending row on that
   same actual-trim path; repeated publications can also duplicate held rows.
   Both defects have failing tests. Rust has an explicit covered-target retirement
   predicate (`transform.rs:8451–8498`), unlike the observed TS trim input gap.
   This review does not claim a live host/Pi fold or a new Rust fold-retirement
   integration was exercised.

7. **Cargo.lock sibling bumps.** Fine to carry as sibling-source alignment,
   not a conflict with review-base master `52dc2620a9` or the final observed
   master `a8bc4b3b167b76bff8ed6fd466b101bdba6f74ba`: master's `Cargo.lock` has no
   changes from dispatch base in either comparison. The candidate changes five path-package versions
   only: `cortexkit-lease` 0.1.0→0.1.1, `cortexkit-store` 0.2.1→0.2.2,
   `subc-core` 0.20.55→0.20.57, `subc-daemon` 0.31.1→0.32.1 and
   `subc-os` 0.1.5→0.1.6 (`Cargo.lock:181,254,1139,1165,1206`). No registry
   dependency bump. Candidate locked Rust tests passed against the available
   siblings without lockfile edits. Sibling **source** churn did trigger one
   later recompilation, so this is not a hermetic build guarantee.

## Reproduction and verification

The committed `docs/reports/protected-tools-review.test.ts` is a deliberately red
review suite, outside ordinary package test discovery. It imports archived
production code, not an expected-value reimplementation. It creates only a
throwaway OpenCode fixture and in-memory context databases. Run from the review
worktree:

```sh
timeout 20s mkdir -p target/protected-tools-review/{candidate,baseline}
timeout 60s sh -c 'git archive 9185f461 | tar -x -C target/protected-tools-review/candidate'
timeout 60s sh -c 'git archive 3ba0f000 | tar -x -C target/protected-tools-review/baseline'
(cd target/protected-tools-review/candidate && timeout 150s bun install --frozen-lockfile)
timeout 120s bun test docs/reports/protected-tools-review.test.ts
```

`PROTECTED_TOOLS_REVIEW_SOURCE` and `PROTECTED_TOOLS_REVIEW_BASELINE` can override
the two archive paths. No source is edited to run this suite. The suite's
throwaway environment is set before it dynamically imports production code.

Tools: Bun 1.4.2 (744846f84), TypeScript 5.9.3, Cargo 1.99.0
(5f94df478), rustc 1.99.0 (b940084d7).

| Check | Result |
| --- | --- |
| Candidate frozen Bun install | Passed; 982 packages installed; no tracked manifest/lock edits |
| Shared TS/Pi protection/hold fixture files (four files) | 24 passed, 0 failed, 106 assertions |
| Candidate Rust `cargo test --locked -j 2 -p mc-module --lib protected_tool -- --nocapture --test-threads=1` | 13 passed, including selection goldens and two real transform rotation/drain controls |
| Candidate Rust `cargo test --locked -j 2 -p mc-module --lib selection::tests -- --nocapture --test-threads=1` | 71 passed, including `selection_golden_matches_ts_selectors` |
| Candidate TS postprocess/reasoning files, filter `protected\|smart_drops\|thinking\|reasoning` | 91 passed initially; one isolation-fixture mismatch fixed in the invocation, then the affected test passed alone (9 assertions) |
| Candidate Pi context/reasoning files, filter `protected\|thinking\|prefix-bound` | 24 passed, 0 failed, 130 assertions |
| Candidate `bun run --cwd packages/plugin typecheck` | Passed (repository script: retina build types, plugin no-emit, scripts types) |
| Candidate `bun run --cwd packages/pi-plugin typecheck` | Known baseline missing `Bun` ambient at `storage-permissions.ts:151`; `../plugin/node_modules/.bin/tsc --noEmit --types node,bun` from Pi passed |
| Review test scoped TypeScript check | Passed with strict, ES2022, ES modules/bundler, repository Bun types |
| Review controls filter | Three passed (10 assertions): byte replay, upgrade differential, held-drop signed-thinking strip |
| Complete adversarial review suite | Seven expected failures and three passing controls, 137 assertions across 10 tests; failures are the exact named regressions above |

Shell invocations had outer timeouts. Rust used the warmed **review worktree**
`target/` after the initial cold-target check timed out at 900 seconds waiting on
the machine's six occupied compile slots. The warm-target protected check passed
after 7m22s compilation. A subsequent 180-second selection invocation timed out
while rebuilding changed sibling sources/module (before tests); the same gate
completed under a 900-second bound in 1m48s, running 71 tests in 0.23s. Neither
timeout was an executed test hang. No Cargo jobs or hosts ran concurrently here.

The one TS control failure was caused by this review's forced `OPENCODE_DB`
overriding the test's own XDG-based fixture. Its targeted retry unset that override
and put `TMPDIR` under the throwaway task root; no production/test expectation
was rewritten. Initial review-harness corrections also separated already-queued
U from unqueued U, supplied the required project identity to reach an actual fold,
and selected canonical Anthropic to reach its stale-strip lane. Only reached,
final assertions are reported as findings.

`aft_inspect` could not start a TypeScript SDK for the root and reported unknown
diagnostics; the explicit scoped TypeScript gate above is the authoritative check.
Build/lint and live model/daemon probes were not repeated: no production or
packaging changes were made, and the prepared worktree's build was already green.
No host was launched, so no `lsof -p <host pid>` evidence is claimed or needed.
