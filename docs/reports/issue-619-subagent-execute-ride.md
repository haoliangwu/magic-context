# Issue 619: restore the subagent execute ride

## History and intended behavior

`git log -S hasReclaimRide`, `git log -S pass_already_busting`, the introducing
diffs, and blame of the OpenCode permission assembly identify two stages:

1. **85cfbfbfe4953244399b8d36c83a1293c0d74ae7** (September 7,
   “make automatic reclaim ride independently priced busts”) introduced
   `hasReclaimRide` and removed bare execute as an automatic-cleanup ride across
   OpenCode, Pi and Rust. Its commit message deliberately says ordinary execute
   pressure must not originate heuristic/age rewrites. Queued agent drops still
   applied on execute and could promote the shared permission after application.
2. **4ece15f109bfda68cb87f273b58c6878308a040c** (September 17,
   “ride-only agent drops across three lanes”) removed that remaining execute
   admission for queued drops. In OpenCode it replaced the execute-inclusive
   `publishedWorkDrainAllowed`/pending-op predicate with `hasReclaimRide`, removed
   the `agentDrop` signal and its post-application promotion, and made
   `isCacheBustingPass` equal the shared drain permission. Pi received the same
   gate; Rust selection and floor admission were coupled to the independent ride.
   **140bc49decbbd5cb1bc41d310a1a4dc1d37729d1** completed and verified the WIP,
   explicitly asserting that execute-only queues stay held with/without historians.

Thus the broad ride-only policy was deliberate, not an accidental deleted line.
Neither change carved out subagents, which have no historian/history fold to
provide the ordinary ride. This conflicts with the current **ARCHITECTURE.md
Session modes** table (“every execute pass” for subagent heuristics). The issue's
October 4 maintainer reply explicitly confirms the table and requests restoration
for subagents, keeping primaries unchanged. This change restores that exception;
it does not undo the primary-session ride-only policy.

## Fix and no-op discipline

- **OpenCode:** the existing `rideSignals` assembly adds `subagentExecute` when
  reduced mode and the effective scheduler decision is `execute`. The shared
  `hasReclaimRide` admits it; queued operations and supported ordinary cleanup
  retain that shared admission permission. Per-lane session and emergency-latch
  restrictions still apply. Logs name `ride=subagentExecute`, not a fictitious fold.
- **Pi:** the same shared predicate receives the session's subagent flag and
  effective execute decision. Its heuristic once-per-turn guard also yields to
  that signal, matching OpenCode. Current hidden/no-session Pi children do not
  use this handler; the marked-session path is nevertheless consistent and tested.
- **Rust:** the reductions-only subagent branch adds canonical `execute` to
  `supersession_ride_available`, which already feeds `pass_already_busting`, queued
  admission, automatic reduction selection, protection-floor adoption and returned
  ride telemetry. Canonicalization includes the existing force/emergency execute
  variants; it does not bypass effective mid-turn deferral. No mc-core gate needed
  modification. No Rust epoch constant changed.

The permission opens on every subagent execute, not just when a queue is nonempty:
supported heuristics and first-application lanes can have eligible work without queued drops.
Precomputing all their eligibility would duplicate selection and risk giving lanes
different permissions. Permission is not evidence of a mutation. Each lane keeps
its existing candidate/protection checks and only actual byte changes count as
busts. Tests replay three further execute passes byte-identically when no work is
eligible (including a protected tool fixture). Metadata such as a reclaim watermark
may advance; no gratuitous provider-content rewrite is introduced. Unprotected
age candidates are work, even if the user queue is empty.

The positive engine cases also exercise a second lane on the same pass: OpenCode
and Rust reclaim a distinct eligible age candidate alongside the queued drop; Pi
clears an older inline-thinking block alongside a different queued text drop.
The next passes must replay exactly those resulting bytes.

Two existing Rust advisory fixtures intentionally now run **defer**, with idle TTL
disabled and an asserted scheduler decision. On execute their subagent reductions
are now correctly authorized by execute itself, so that setup no longer isolates
whether an inherited HARD/reconcile advisory can price work. Their no-prefix-fold
and unchanged-frozen-unit assertions remain. Primary execute-only hold tests were
not weakened or renamed.

## Failing-first and restored controls

Before adding the production signal, each engine's four-case regression group
returned **3 pass / 1 fail**. The only failure was subagent execute draining queued
drops (queue length expected 0, actual 1). Primary execute hold, subagent defer hold
and empty/no-eligible execute replay were already-correct negative controls and
passed on the baseline; claiming those fail on the old code would be false.
The original real-host run likewise reached execute repeatedly but never shrank.

The execute-ride fixtures were also tested with the new ride neutralized, marked
`NON-VACUITY BREAK`. All intentional files were staged first; the working-tree
`git diff --stat` was empty. The applied diff for each mutated path was **1 file,
2 insertions, 1 deletion**. After each control, restoration used
`git checkout -- <path> && touch <path>` and the diff was empty again.

| Neutralized control | Exact failing test | Unaffected cases / result |
| --- | --- | --- |
| Shared TS `hasReclaimRide` subagent arm | `ride-only queued drops > issue 619 subagent execute drains queued drops` | Other three issue 619 cases pass; queue expected 0, actual 1; exit 1 |
| Same TS arm, Pi handler | `registerPiContextHandler > issue 619 subagent execute drains queued drops` | Other three cases pass; queue expected 0, actual 1; exit 1 |
| Same TS arm, real host | `issue 619 task subagent drops ride execute once and replay the provider prefix` | Sole selected test fails: pass 5 `prefixChanged` expected true, actual false; exit 1 |
| Rust transform subagent arm | `transform::tests::issue_619_subagent_execute_drains_queued_drops` | Other three cases pass; queue left 1/right 0; exit 101 |

The mutation paths were
`packages/plugin/src/hooks/magic-context/cache-busting-signals.ts` and
`crates/mc-module/src/transform.rs`. All breaks were restored before final gates.

## Real OpenCode host and cache measurement

Command (Bun **1.4.2**, actual OpenCode **1.18.30**):

```sh
PATH="$HOME/.opencode/bin:$PATH" MC_E2E_KEEP=1 bun test --timeout 120000 \
  packages/e2e-tests/tests/subagent-execute-ride.test.ts \
  packages/e2e-tests/scripts/validate-mode-manifest.test.ts
```

The host's real `task` tool creates `ride-worker`; this is not a fabricated child
session or direct queue write. A local Anthropic mock scripts real `bash` and
`ctx_reduce` calls. Three deterministic identifier files carry actual tool-output
mass below the host truncation cap. Configuration is
`execute_threshold_tokens.default=5000`, window 100000 (usable soft 91808), and
`protected_tokens=4000`. All measured execute usage stays roughly 8–17k, far below
the unchanged force floor. The child has zero compartments and drains its queue.
An extra settling pass before the first reduction ensures the tool's persisted
token mass has reached the protected-window accounting; the test does not confuse
protected-work delay with missing permission.

Here **changed** means previously served message-content bytes changed, not that
the growing full HTTP body is identical. Ordinary tool steps append new content.
The comparison excludes only host-owned `cache_control` annotations, whose boundary
moves on every request, and asserts that the system content is unchanged. At passes
6–8 it also compares the entire frozen pass-5 message prefix, not just tag statuses.
Lengths below are UTF-8 byte counts, not JavaScript character counts. The test
also checks the captured **whole raw HTTP request** shrinks by more than 20000 bytes.

Cache counters are **mock-provider measurements**, not a paid Anthropic cache
experiment: the mock meters common complete message prefixes (excluding the
ephemeral annotation), estimates tokens from actual serialized bytes, and emits
read/write usage. The test independently reads the real host's persisted assistant
usage and checks that every reported counter arrived unchanged. This proves the
provider-wire cache opportunities and host meter plumbing, not production pricing,
minimum cache sizes or a provider's caching algorithm.

| Child pass | Decision | Old content changed? | Message bytes | Provider cache read | Provider cache write | Action returned |
| ---: | --- | --- | ---: | ---: | ---: | --- |
| 1 | defer | no baseline | 116 | 0 | 893 | read A |
| 2 | defer | no | 29903 | 29 | 8310 | read B |
| 3 | execute | no | 59715 | 7475 | 8317 | settling tool step |
| 4 | execute | no | 59975 | 14928 | 929 | queue A via ctx_reduce |
| 5 | execute | **yes: A drops** | **30730** | **66** | **8480** | tool step |
| 6 | execute | no | 30990 | 7682 | 929 | tool step |
| 7 | execute | no | 31250 | 7747 | 929 | tool step |
| 8 | execute | no | 31510 | 7812 | 929 | queue B and read C |
| 9 | execute | **yes: B drops** | 32019 | **128** | **8740** | tool step |
| 10 | execute | no | 32280 | 8004 | 930 | tool step |
| 11 | execute | no | 32543 | 8070 | 929 | child completes |

The first queued batch lands on the very next execute pass, removing **29245
message bytes** despite the appended tool traffic. There is one rewrite, then
three byte-identical prefix replays until the next queued drop. The second batch
also lands on its next execute pass; C displaces B's protected floor and adds real
bytes at the same time, so total request length is not a second shrink assertion.
There are no other old-content changes in the eleven child requests.

Latest repaired-hook host run: **pid 42812**, throwaway root
`$TMPDIR/magic-context/issue-619/opencode-e2e-H1uG2z` (canonical
`/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-619/opencode-e2e-H1uG2z`).
`lsof -p 42812 -Fn` ran before and after the task. Every open DB/WAL/SHM was under
that root: `data/opencode/opencode.db` and
`data/cortexkit/magic-context/context.db`. HOME, XDG config/data/cache/state/runtime,
OPENCODE_DB and MAGIC_CONTEXT_STORAGE_DIR were all isolated by the existing harness.
No live store/config was opened, inspected or migrated. Kept proof files are
`proof/host-lsof.txt`, `proof/passes.json`, `proof/host-cache-meters.json`, and
`proof/requests.json`; they contain only synthetic fixtures and are not committed.
The scenario is registered as ts-only/OpenCode in the manifest; totals are 166
files, 52 TS invocations, 38 TS/OpenCode invocations, with Rust counts unchanged.

## Force band and reply wording (not changed)

Deriving the primary force band from a low token threshold is **not automatically
safe**. It would turn ordinary low-window-percentage pressure into emergency
permission, affect fold/historian cadence and token-mass protection/emergency
selection, and could originate expensive prefix rewrites much earlier while a
primary has ample headroom and an independent publication/fold still pending.
It needs separate cache/effectiveness measurements and an explicit policy decision
about margins, latching and historian recovery. This patch leaves
`max(85, threshold + 2)` and the 95% backstop untouched.

`ctx_reduce` currently replies `Queued: drop §N§.` for unprotected requests; it
does **not** tell a subagent when queued drops apply. Protected requests do say
they apply once newer work displaces them. Suggested subagent-specific reply:
“Queued: drop §N§. Eligible queued drops are applied together on the next execute
pass; protected items wait until newer work displaces them.” Prompt/tool-reply text
was not changed, because permission correctness does not require a prompt rewrite.

## Verification

- `bun run build`: passed, three package builds and four embedded OpenCode 2 server
  tests (Bun 1.4.2).
- `bun run --cwd packages/plugin test`: passed, **6757 pass / 4 skip / 0 fail**,
  650 files (Bun 1.4.2).
- `bun run --cwd packages/pi-plugin test`: passed, **1507 pass / 3 skip / 0 fail**,
  138 files (Bun 1.4.2).
- `bun run typecheck`: passed, four configured packages (TypeScript 5.9.3).
- `bun run lint`: passed, Biome 2.5.1 checked 1197 plugin, 224 Pi, 133 CLI and
  6 retina files, with only existing warnings/infos.
- Real-host plus manifest command above: passed, **7 tests / 0 fail / 84 assertions**.
- `cargo test --locked -p mc-module -- --test-threads=1`: passed, **1562 unit tests
  and 24 binary/integration tests**, 22 ignored in total (Cargo/rustc 1.99.0).
- `cargo clippy --locked -p mc-module --all-targets -- -D warnings`: passed,
  mc-module all targets (Cargo/rustc 1.99.0).
- `cargo fmt -p mc-module --check`: passed (Cargo/rustc 1.99.0).
- The final Rust gate survived a tool-transport restart. Its original command was
  not rerun concurrently: the saved output and terminal metadata confirm all
  three Rust commands completed with exit 0. Shared compile-slot queues, including
  the real-daemon tests' nested build, account for the long wall time.
- Workspace typecheck uses TypeScript **5.9.3**. The e2e package-wide extra tsc
  check has 24 pre-existing errors in unrelated probes, paired replay, Rust harness,
  OpenCode 2 tests and their imported plugin typing. The new scenario and manifest
  validator typecheck cleanly with a scoped config using the existing Bun/Node
  types and retina path mappings; that temporary config stays in ignored
  `node_modules/.cache`, not in the delivery.
- AFT inspection was partial (Biome unavailable in its producer and Rust indexing
  timeout). Actual repository compiler/lint/test commands are authoritative.
- Existing informational/warning-only Biome findings outside these changes remain.
  Frozen-lockfile installs inside this worktree reported no dependency changes.
  No config knob, architecture/structure document, package manifest, lockfile or
  Rust epoch update is delivered.

## Adversarial review follow-up

The review in `docs/reports/issue-619-review.md` identified two real accounting
defects and a vacuous HARD-advisory fixture. The branch was rebased onto master
before repairing them.

### Actual edits, not permission or persistence

OpenCode now records first image, stale-reduce and visible sentinel edits in the
same actual-edit ledger consumed by bust telemetry and prefix-bound thinking
invalidation. Frozen-id replay and hidden-at-seam-only persistence do not enter
that ledger. The ledger also covers later binding/merged-reasoning edits. It
distinguishes edits before newer thinking from terminal edits using actual visible
message/part locations (see the positional re-review repair below), so the
oldest-prefix-trim exception applies only when no other prefix edit occurred.

Trailing-blank decisions are compared against the previous frozen projection
before being counted. Capturing `strip` for a historical message with no blank
suffix changes only metadata: it does not report a bust or remove signed thinking.
Poisoned keeps are still repaired, but count only when their served representation
actually changes. The comparison is lazy and examines only newly committed
decisions; steady replay does not hash the full message corpus.

Pi uses the same coupled first-edit recording for its supported image, stale
reduce, native activation and permitted placeholder discoveries. Restoring durable
dropped statuses from raw history no longer reports a fresh bust. Pi's image and
stale-reduce invalidation already worked; the new controls also expose stale-reduce
replay's false telemetry and placeholder discovery's missing telemetry.

The isolated OpenCode lane tests pre-freeze every trailing decision, including
the strip owner, so an unrelated metadata event cannot mask an omitted edit. All
three lanes run against the real model predicate for Opus 5.5, Sonnet 5.5 and
Fable 5.1, with correctly shaped Anthropic signatures, and replay fresh raw arrays.
The three metadata controls cover primary bound, subagent unbound and subagent
bound. Pi has separate image, stale-reduce and refresh-only placeholder controls.
These are representation safety tests, not a paid-provider cryptographic test.

### Remaining intentional exclusions

The original report's universal all-lanes wording was too broad. Rust's
reductions-only child branch still accepts reduction units, not new image/system
or age-reasoning strip units. The `!req.is_subagent` gate now documents that
separate inherited-history/replay contract and is unchanged. Rust's primary
first-strip planning already excludes non-reasoning strips from its trim-only
classification; no child strip gate was widened by this repair.

Pi placeholder discovery still requires history refresh or stable-id cutover,
because Pi splices entire messages and discovering on a fresh-drop execute can
collapse a tool turn. A short comment at that gate states the exclusion. Its
sentinel control uses a permitted refresh, not an invented ordinary-execute
discovery path. Frozen discoveries replay on every pass. Existing emergency
latches, primary-only caveman/todo rules and session-mode restrictions likewise
remain independent eligibility limits, not claims of universal coalescing.

### Genuine Rust advisory controls

The HARD negative now submits `cfg1` against the stored `cfg0` identity and asserts
that a primary control actually returns HARD for that same non-scheduler input.
The reconcile negative retains its asserted missing-boundary/reconcile input.
Both children defer, keep the complete served wire unchanged, retain old tool
output, and expose no history summary. The execute companion applies an eligible
queued reduction for both advisories while keeping the inherited history frozen:
the old output disappears from the served wire, the queue drains, and no summary
is materialized. These assertions no longer rely solely on frozen-unit equality.

### Accepted continuously eligible rewrite cost

The reviewer independently reran the real OpenCode 1.18.30 task child. The first
batch saved 29245 message bytes, but traded a roughly 14928-token prefix read for
66 read and 8488 write tokens on the rewrite. The second batch traded a 7812-token
read for 128 read while new C output was appended. Those counters are mock-prefix
meters verified against the real host, not production Anthropic pricing.

A continuously growing, eligible child can now rewrite on **every execute pass**;
the accepted design has no new cooldown or minimum ordinary batch gain. For the
reviewer's scale example, 100 rewrites each invalidating about 20000 still-live
tokens expose about **2 million tokens** to input/cache-write rather than cache-read
pricing. Net cost also subtracts permanently reclaimed tokens from future requests
and depends on provider rates and cache minimums. The finite fixture proves one
rewrite per batch and stable replay between batches, not a global frequency cap.
Primary admission and the force-band formula remain unchanged.

### Follow-up failing-first and non-vacuity checks

Before the accounting fixes, all **nine** isolated OpenCode lane/model tests failed
(`bustedThisPass=false` despite a strip). Seeding trailing decisions for the strip
owner as well as both signed assistants was essential: otherwise the old
metadata-only trailing bug could accidentally mask the stale/sentinel omissions.
Before the trailing-shape fix, the unbound child reported a false bust and the
bound child lost both signed blocks; the already-correct primary control passed.
Pi's initial three-case run passed image invalidation, but failed stale-reduce
replay telemetry (two fresh decision records) and sentinel first-application
telemetry (zero records). No primary expectation was inverted to make these pass.

Each restored mutation below was marked `NON-VACUITY BREAK`. The six intentional
files were staged first and `git diff --stat` was empty. OpenCode/Pi recorder
neutralization added **2 lines** in the respective handler. The trailing predicate,
Rust HARD input and Rust execute arm controls each changed **2 insertions / 1
deletion**. Every restore used `git checkout -- <path> && touch <path>` and left an
empty diff. Tests were run in separate engine processes, never a mixed Pi/OpenCode
test process.

| Removed/neutralized protection | Exact red test | Observed failure / unaffected selection |
| --- | --- | --- |
| OpenCode actual-edit recorder | `issue 619 first-application thinking accounting > image alone invalidates later signed thinking on claude-sonnet-5-5` | Bust expected true, actual false; sole selected test |
| Same recorder | `issue 619 first-application thinking accounting > stale reduce alone invalidates later signed thinking on claude-sonnet-5-5` | Bust expected true, actual false; sole selected test |
| Same recorder | `issue 619 first-application thinking accounting > sentinel alone invalidates later signed thinking on claude-sonnet-5-5` | Bust expected true, actual false; sole selected test |
| Pi coupled recorder | `Pi proactive strip of invalidated thinking > issue 619 Pi image first application invalidates thinking and replay is not a new edit` | Expected zero signed blocks, retained two; sole selected test |
| Same recorder | `Pi proactive strip of invalidated thinking > issue 619 Pi stale reduce first application invalidates thinking and replay is not a new edit` | Expected zero signed blocks, retained two; sole selected test |
| Same recorder | `Pi proactive strip of invalidated thinking > issue 619 Pi sentinel first application invalidates thinking and replay is not a new edit` | Expected one telemetry record, got zero; sole selected test |
| Treat metadata capture as a wire edit | `issue 619 metadata-only trailing decisions > subagent unbound keeps bytes and reports no bust when a historical strip already matches` | Bust expected false, actual true; sole selected test |
| Same false-edit predicate | `issue 619 metadata-only trailing decisions > subagent bound keeps bytes and reports no bust when a historical strip already matches` | Signed parts replaced by sentinels; primary-bound control passed |
| Remove cfg1 HARD trigger | `transform::tests::hard_advisory_without_prefix_materialization_cannot_price_reductions` | Primary control returned SOFT+ instead of HARD; sole selected test |
| Remove subagent execute reduction ride | `transform::tests::issue_619_execute_reduces_wire_without_materializing_inherited_advisories` | Served wire incorrectly equaled baseline; sole selected test |

An initial Rust exact selector omitted its module qualification and selected zero
tests; it was corrected to the full symbol before accepting the HARD-input proof.
The final full Rust suite and all-target clippy passed after restoration. Plugin
and Pi package scripts initially collided in concurrent frozen-lockfile workspace
linking (`EEXIST`); serial install and separate, sequential package test processes
passed with no dependency changes. The repaired hooks were rebuilt and the real
OpenCode task-host/manifest run passed again with the same eleven-pass byte table.

## Positional re-review repair

The full re-review report was read from
`alfonso/task/bg_b77d69ad9e84f87e-re-review-issue-619-fixes-for-the-blocking-findi:docs/reports/issue-619-re-review.md`.
It confirmed the earlier repairs but found a new primary cache regression: the
first-edit recorder's default `beforeNewerThinking=true` made a terminal image,
stale-reduce or sentinel edit remove an earlier, still-valid signed block. All
three new primary controls reproduced that regression before this repair.

The recorder now requires an explicit positional verdict. Supported strip helpers
report actual first-application message/part locations through optional internal
observers; replay never fires those observers. OpenCode retains `any=true`, then
checks the edit locations against the remaining reasoning projection after frozen
reasoning removals. Thus thinking already frozen for removal cannot spuriously
invalidate an earlier block. Only actual positional edits on bound models pay for
that replay preview; no-op passes do not copy/hash the corpus. The real message
arrays are not changed by the preview.

Pi mirrors the distinction: stale-arc observers preserve owner/call identity,
images report first-stripped parts, and permitted placeholder removals report
their location before splicing. Stable source order survives those removals.
Telemetry still records a real edit when no signed thinking follows it. Existing
head/fold/materialization and unclassified native-edit invalidation remains
conservative; the shared admission and force formula are unchanged. Pi's narrower
placeholder discovery and Rust's reductions-only exclusions remain intact.

The requested primary controls use a real Sonnet 5.5 predicate, frozen trailing
decisions, fresh raw arrays and a 96% force ride with no head/fold/materialization
change. They assert the unaffected prefix and signed block are retained, the
terminal edit actually occurs, `bustedThisPass=true`, no proactive strip occurs,
and both force and defer replay report no fresh edit. Additional controls cover a
stale part after thinking in the same message and later thinking already frozen
for removal. Pi has corresponding ordinary-child image/stale controls and a
primary-force image control. Existing earlier-edit/model, metadata-only, trim and
replay controls remain part of the final gates. These are source representation
tests, not paid-provider cryptographic/cache measurements.

### Positional failing-first and restored controls

On `2a378709c9459dc7ec8a1225b557ff05585e7a77`, the three requested primary terminal
tests all failed with **one signed block expected, zero received**. The two Pi
child terminal controls reproduced the same over-strip before its mirror repair.
Restoring the old unconditional positional bit, without disabling actual-edit
telemetry, also made the additional same-message/frozen-later OpenCode controls
and the Pi primary-force image control red.

All ten intentional files were staged before mutation, with an empty
`git diff --stat`. Each mutant below changed only the respective handler:
**2 insertions / 1 deletion**, marked `NON-VACUITY BREAK`. Restoration used
`git checkout -- <path> && touch <path>` and returned an empty diff before final
verification. Each terminal row below was a separate one-test red invocation.

| Control | Exact red test | Failure / unaffected control |
| --- | --- | --- |
| Restore unconditional OpenCode positional bit | `issue 619 terminal first edits > primary terminal image edit preserves thinking whose preceding prefix is unchanged` | Expected 1 reasoning block, received 0 |
| Same bit | `issue 619 terminal first edits > primary terminal stale edit preserves thinking whose preceding prefix is unchanged` | Expected 1, received 0 |
| Same bit | `issue 619 terminal first edits > primary terminal sentinel edit preserves thinking whose preceding prefix is unchanged` | Expected 1, received 0 |
| Same bit | `issue 619 terminal first edits > terminal stale part after its own signed block preserves the untouched prefix` | Expected 1, received 0 |
| Same bit | `issue 619 terminal first edits > terminal image edit ignores later thinking already frozen for removal` | Expected 1, received 0 |
| Restore unconditional Pi positional bit | `Pi proactive strip of invalidated thinking > issue 619 Pi terminal image edit keeps earlier signed thinking and actual-edit telemetry` | Expected 1, received 0 |
| Same bit | `Pi proactive strip of invalidated thinking > issue 619 Pi terminal stale edit keeps earlier signed thinking and actual-edit telemetry` | Expected 1, received 0 |
| Same bit | `Pi proactive strip of invalidated thinking > issue 619 Pi primary terminal image edit keeps earlier signed thinking and actual-edit telemetry` | Expected 1, received 0 |
| Disable only OpenCode positional classifier | `issue 619 first-application thinking accounting > image alone invalidates later signed thinking on claude-sonnet-5-5` | Missing proactive strip; primary terminal image control still passed |
| Disable only Pi positional classifier | `Pi proactive strip of invalidated thinking > issue 619 Pi image first application invalidates thinking and replay is not a new edit` | Retained 2 thinking blocks; Pi primary terminal image control still passed |

The last two controls defend the original safety repair against a wholesale
invalidation disable: preserving a terminal block is not sufficient if an earlier
edit can leave later signatures intact. After restoration, the full plugin suite
passed **6757 tests**, and the full Pi suite passed **1507 tests** in a separate,
subsequent process; all existing lane/model, metadata, trim and replay tests stayed
green. `cargo test --locked -p mc-module issue_619` passed **5 unit tests**, with
other targets selecting zero. Rust source was not changed in this positional
follow-up. Workspace typecheck (TypeScript 5.9.3), lint (Biome 2.5.1), and the three
package builds plus four embedded server tests (Bun 1.4.2) also passed. No new
standalone host or paid-provider probe was needed or launched for this follow-up;
the earlier eleven-pass host table remains a historical measurement.
