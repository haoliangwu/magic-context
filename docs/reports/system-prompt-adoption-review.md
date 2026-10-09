# Independent adversarial review: system-prompt identity adoption

## Scope and merge verdict

Reviewed **39fb1e89fdd606102962327269e373920a1b8914** and
**d57cddf9dd52e5b948c165af55b43e6e1bf29df9**, including the implementation report
`docs/reports/system-prompt-change-detection-order.md` at the latter revision.
All implementation inspection and execution used that revision in this reviewer's
isolated worktree. The worktree was returned to its original task branch before
committing this report. No product code or test changes are delivered here.

**Verdict: approve merging for the currently wired stock OpenCode 1, OpenCode 2,
and Pi paths. No blocking cache-safety regression found.** The measured stock
OpenCode 1.18.35 path really does lose the second rewrite in both modes; the
same-pass model HARD, deferred-drop delivery, sticky date, idle retry and restart
properties survived independent challenges.

There are two **low-severity, non-blocking findings** below. In particular, the
helper is not a general proof of request identity: its system-first claim needs
a completion-delivery assumption. Do not extend its wiring to another
system-first host without addressing that assumption. OpenCode 2 and Pi do not
use the new marker, so this limitation does not undermine their present routes.

Severity here distinguishes a reproduced supported-path regression (blocking)
from an unproven portability claim or fixture coverage limitation (low).

## Findings

### Low: the marker means “since the last consumption/completion,” not “this request”

**Evidence:** `request-hook-order.ts:43-70` has only a session-keyed map and an
assistant-message watermark. It has no request identifier, start/end pair, abort
reset or session-idle reset. This sequence is a counterexample to the general
system-first claim:

```ts
const order = createRequestHookOrder();
order.consumeMessagesPrepared("s"); // system(A): false
order.messagesPrepared("s", [{ info: { id: "msg_0002", role: "assistant" } }]);
// A ends without a completed assistant event, or its event has not arrived yet.
order.consumeMessagesPrepared("s"); // system(B): true; messages(B) has NOT run
```

An independent temporary test named **“an unfinished previous request cannot
make the next system-first request look messages-final”** asserts `false` for the
last call and fails with **Expected: false / Received: true** (0 pass, 1 fail).
No product mutation is needed for this counterexample. An incomplete preparation
that leaves a mark before reaching its system hook has the same shape.

The event wrapper in `hook.ts:1189-1222` does clear completed failures/aborts, not
only successful replies. Its id guard also correctly protects a fresh messages
pass from an old completion. Nevertheless, “record before awaiting the other
handlers” is only local: the outer plugin event wrapper in
`src/plugin/event.ts:19-21` awaits the auto-update handler first, and host event
delivery itself is asynchronous. A completion is not a request-correlation token.

**Impact if the helper is wired into a system-first route:** a system-only edit
can be adopted before that request's messages transform, although a fold could
still have ridden the same bust. This loses a same-pass work opportunity. The
opposite problem, a premature completion clearing a valid mark, can restore the
unwanted next-pass fold. The current unit tests test ordinary alternating calls,
old comparable ids and missing ids, but not an unfinished previous request.

**Why non-blocking for the reviewed wiring:**

* Stock OC1 runs messages before system on every normal main request. Each
  messages pass overwrites the marker, and its own system hook consumes it.
  Aborts/retries do not need completion delivery to identify that order.
* OC2's `v2/hooks/context.ts:1401-1417` constructs the system handler **without**
  `consumeMessagesPrepared`, then constructs its transform without
  `onMessagesPassStarted`. The system stage explicitly precedes the transform.
* Pi uses `processSystemPromptForCache` in `before_agent_start`, not this hook
  factory or marker.

**Recommendation:** narrow the helper's documented contract to the present
routing, or use an explicit host/request seam before reusing it on a system-first
host. Add the negative sequence above if portable order detection is intended.
I did not reproduce a false adoption on a stock supported host.

### Low: the new e2e fixture assumes messages-first; it is not an order-neutral test

**Evidence:** the initial isolated run used a copy of the placed executable
reporting **1.18.30**. The fixture failed at its queued-work assertion, not at its
rewrite assertion:

```text
pending_at_agents_edit=0 pending_at_instructions_edit=0 pending_at_end=0
agents-edit t3: kept=1/7, HARD reason=epoch_change
instructions-edit t6: kept=3/17, HARD reason=epoch_change
system prompt hash changed: ... triggering flush
Expected: > 0 / Received: 0
```

This is a **same-pass fold**, not the double rewrite being prevented. The placed
executable's SHA-256 is
`ef0b32817bcf85fe423f6f28bff0f855358bf01d18103014dc7454b5f8cf702b`.
It is not identical to the npm 1.18.30 executable
`2d0c9c339bb91046c6ea951c97664bc2f8a8eaca707f31fbfbb7bc73c4eddc62`.
I do not infer stock 1.18.30 behavior from that placed executable. The passing
reference runs instead used the independently downloaded npm **1.18.35** binary,
whose tarball hash exactly matches the implementation report.

`system-prompt-change-order.test.ts:259-262,301-302` deliberately requires work to
remain queued on the edit's request. That is useful non-vacuity for the intended
late-detection route, but it rejects the correct early-detection route. A version
string alone is insufficient provenance for this test.

**Recommendation:** pin the reference host/package hash for this fixture; if an
early-detection host is included, give it a separate expectation permitting the
same-request fold. This is not evidence of a product regression and is not a
reason to weaken the queued-work assertion on stock messages-first hosts.

## Order and lifecycle audit

I independently fetched stock `v1.18.35` host source into the throwaway root.
`session/prompt.ts:1186-1201` persists the new assistant before request
preparation; `1255` awaits messages.transform; `1257-1263` reads instructions and
converts provider messages; `1272` enters the processor. This independently
confirms the relevant ordering in the implementation report. Its prompt-loop
source SHA-256 is
`f0c5bc64c0f0e966693d4a57f7ede1e9d6e188b396152f04b55303dc75b9b768`.

| Challenge | Result / boundary |
| --- | --- |
| Concurrent sessions in one plugin process | Each hook closure owns its own map; entries are keyed by session id. The five helper tests include isolated sessions and deletion. No process-global order latch was added. |
| Parent and ordinary subagent sharing hooks | `findSessionId` selects the latest user message's session id; the system input supplies that session id. Parent and child do not share one marker. Subagent-specific guidance remains separate. |
| Title, summary, compaction | Recognized system signatures return before consuming the marker (`system-prompt-hash.ts:272-295`). The new skip unit asserts the consumer is never called for a title. Stock same-session auxiliary calls therefore do not steal the main request's mark. |
| Historian/dreamer children | Prompt signatures and the internal-child session set skip them. Their own child session ids cannot consume a parent's mark. Existing hidden-agent signature tests passed. |
| Skipped main-agent injection | Global opt-out and configured skip signatures return before consuming. On stock OC1 the next main messages pass overwrites any surviving mark; it cannot turn a future main request into a false messages-first pass. |
| Aborted/retried requests | After a real provider abort the completed assistant has an error and completion timestamp. The reviewed wrapper accepts that event for order cleanup; the served-response clock separately rejects it. Full idle/restart tests passed in both modes. A request with no completed event is the portability limitation above, not evidence against stock OC1 ordering. |
| Host restart | The map is process-local and starts empty. Durable system hash adoption survives separately. Both restarted idle/abort byte-replay cases passed. |
| OC2 | Separate system-first adapter, neither marker callback supplied. Seven system-stage restart tests passed. |
| Pi / OMP | Separate before-agent-start system handler and context implementation; no production use of `createRequestHookOrder` or the OC1 hook factory. Source audit only, not a new Pi/OMP real-host run. |

Native-agent skip recognition remains literal-signature-based. A customized
unrecognized auxiliary prompt sharing the main session can already compete for
the system hash; that pre-existing limitation should not be mistaken for a
request-identity guarantee added by this change. No customized auxiliary-prompt
host run was performed.

## Is skipping the fold correct?

### System hash is an identity marker, not an m[0]/m[1] renderer input

I traced `cachedM0SystemHash` through storage, snapshot marker reconstruction,
`mustMaterialize`, cached-head persistence and the Rust adapter. In TS,
`inject-compartments.ts:1838-1845` compares it to the hard system signal. Other
uses carry or persist snapshot markers; they do not insert the hash into the
rendered text or choose different memory/history content from it. No frozen
reduction decision was found whose interpretation depends on the external
system-prompt hash.

Adoption updates the marker, not cached m[0]/m[1] bytes, their materialization
clock, history coverage or memory/drop coordinates. Independently meaningful
content and render changes retain their own checks: memory disable, renderer
format, budgets, workspace/project identity, destructive memory changes and
model identity are not erased by overwriting the system marker.

### Prompt surface and tool descriptions

`promptSurfaceHashMaterial` hashes actual system content and, for non-full
presets, a preset identity suffix. It does **not** hash tool-description strings.
Guidance override bytes are frozen by shared runtime/session/model-key epochs;
a file edit alone does not silently change guidance during a warm epoch.

The new TS adoption can acknowledge a preset-only identity change even if the
wire system content is unchanged. That is not a proof that the provider cache was
cold, but m[0]/m[1] do not render from that preset identity, so acknowledging it
need not rebuild their bytes. Actual changed system guidance is already sent in
that request. Tool-set hashes were already deliberately excluded from TS HARD
fold triggers because their process-wide scope causes false session busts; this
change does not add or remove that policy.

Rust is stricter. `can_adopt_system_identity` (`transform.rs:7605-7639`) requires
an initialized OpenCode serializer request, a nonempty changed system hash and
an idle expiry or exact host acknowledgement. It reconstructs the old identity
by changing **only the external system hash** back, including the unified
prompt-surface epoch, and requires equality with the frozen render identity.
Model/provider, prompt-surface selection/config/tool descriptions, serializer,
workspace and renderer differences therefore cannot be excused by the system
acknowledgement. Both full and additive-only transform paths use this gate.
The existing Rust source test
`issue_610_expired_retry_replays_one_fold_and_adopts_only_the_late_system_identity`
also explicitly rejects an acknowledged non-system render-config delta. I read
that test but did not rebuild/run Cargo tests: the requested placed module copy
was used for every real Rust run.

### Sticky date and issue 610

`adoptSystemChange` was widened; `dateMayAdvance` was not widened to include the
messages-final marker. An ordinary warm midnight remains frozen. A genuine
content change can release the date because those actual system bytes already
bust the cache; idle expiry and explicit refresh retain their existing date
release rules.

The full `idle-ttl-restart.test.ts` run on npm OC1.18.35 passed **7/7 in Rust and
7/7 in TS**, including warm/expired midnight, head replay with/without restart,
and aborted idle attempt plus late system identity with/without restart. The
four opt-in 240k long-loop variants and other hosts were skipped (37 skips per
full-file run). This is independent coverage of the issue-610 seam, not merely a
unit check of the new boolean.

## Queued work and independent HARD triggers

The new real-host fixture leaves one queued drop after the first edit and two
after the second. The work is not deleted; it is withheld from a warm prefix.
History publications have their own deferred history/materialization signals,
and m[1] can still refresh on permitted work. A system change is not a coordinate
change, model switch, serializer change or project-identity migration.

I additionally ran a temporary real-host probe in **both modes**:

1. Seed two substantial replies, queue `ctx_reduce drop: "2"` through the real
   tool, edit AGENTS.md, and send a warm follow-up. The drop remains pending.
2. On the next request, **switch model and edit AGENTS.md again together**.
3. Assert the captured model is `second-model`, the provider system contains the
   new `Review rule v3`, and the queued count is zero on that first switch pass.
4. Assert the following warm request retains the switched request's prior
   message prefix.

Independent provider captures show:

| Mode | Same-switch-pass decision | First old assistant's bytes | Retained messages | Pending drops |
| --- | --- | --- | --- | --- |
| TS | HARD `model_change` | `§2§ reply line 0: ...` → `[dropped]` | 1/11 | >0 → 0 |
| Rust | HARD `epoch_change` | `§2§ reply line 0: ...` → `[dropped §2§]` | 1/11 | >0 → 0 |

Thus adoption does not swallow an independently required model HARD, even when
the same request also changes system text. In TS the model check precedes the
system check; Rust's full identity comparison prevents acknowledging a model or
provider delta. A separate real provider-switch fixture was not run; the TS key
includes provider/model and Rust separately compares provider identity. The
model-switch probe is stronger than the supplied e2e fixture's pending-only
assertion because it demonstrates actual eventual consumption and changed bytes.

## Test non-vacuity and independent mutation

The supplied e2e test hashes **captured provider request bodies**, not a plugin
render proxy. It verifies the new AGENTS/instruction text reached the system
block, counts actual pending work, and compares the already-sent message prefix.
Its expected rewrites are the edit requests, not a value derived from the
implementation's adopted hash. With these queued drops, disabling adoption
really changes a prior assistant message, rather than merely producing a HARD
log over identical bytes.

The comparison strips `cache_control` and excludes the previous final message.
Consequently it proves the fixture's system/retained-message content claim, not
provider billing, raw whole-body byte identity or tool-definition stability. The
large early replies and early drop targets make that exception irrelevant to
the mutation below. Tool definitions are not independently compared by this
new test. The printed decision table can lag log flushing (one final TS
injection diagnostic was `?` in a passing run); the correctness assertions do
not depend on that diagnostic table.

The five helper tests and four new hash-handler cases are non-vacuous for their
local branches: they assert literal booleans, hash/flag changes, skip consumption
and frozen date text. They are **not** a proof that the real event wrapper always
resets a system-first mark: the helper tests manually deliver completion and the
hash-handler tests stub the marker consumer. The first finding states that gap.

### Mutation rerun

I independently neutralized **only** `hook.ts`'s consumer binding:

```ts
consumeMessagesPrepared: () => false, // NON-VACUITY BREAK
```

Safe sequence: stage the pristine specific file, confirm empty `git diff --stat`,
apply the mutation, capture a nonempty stat, rebuild the plugin, run both real-host
lanes, restore with `git checkout -- <path> && touch <path>`, confirm empty stat,
and rebuild. No mutation is in the delivered tree.

* Applied stat: `packages/plugin/src/hooks/magic-context/hook.ts | 2 +-`;
  **1 file changed, 1 insertion(+), 1 deletion(-)**.
* Restored stat: **empty**.
* Both TS and Rust reddened **only**
  **“an AGENTS.md edit and an instruction-file edit each rewrite the provider
  prefix once”** in their respective mode-labelled suite (0 pass, 1 fail per run).
  No other test failed; the first six assertions passed before the rewrite-list
  assertion failed.
* Exact additional rewrites: **`5:t4` and `10:t7`**. Rust retained only **1/9**
  and **3/19** messages and logged HARD `epoch_change`; TS retained the same
  counts and logged rematerialization `system_hash`.
* Restored code: the same named test passed in each mode (1 pass, 0 fail,
  7 assertions), retaining **9/9** and **19/19** messages at t4/t7.

Measured restored request sizes are t3 **124,851 B**, t4 **149,686 B**,
t6 **224,504 B**, t7 **249,340 B**, identical across modes. Mutant t4 is
**125,001 B TS / 125,007 B Rust**, and t7 is
**199,970 B TS / 199,982 B Rust**, reflecting the early drops and a real prefix
rewrite. Absolute system digests differ between independent fixtures because
the host embeds fixture paths; comparisons are always within a fixture.

## The idle-test wait edit is a flush-race repair, not a weakened scheduler assertion

The old predicate counted any `decision=` line. A single expired Rust pass
produces both `todo_permission_probe_miss decision=HARD reason=ttl_expiry` and
`rust pass: decision=HARD ... scheduler=execute`. That already satisfies the old
“two lines” condition without the warm pass's scheduler line.

The changed predicate counts the scheduler lines actually asserted afterwards.
It does not change the assertions: there must still be **exactly one execute**
and a **defer**, and an aborted usage-less request must not advance the served
response clock. If the warm request also executed, the new wait would finish
and the execute-count assertion would fail. If it never produced a scheduler
line, the wait would time out and fail. It cannot turn those regressions green.

Independent isolated runs of the **exact Rust case alone** on npm 1.18.35:

| Run | Tests / assertions | Result | Duration |
| --- | --- | --- | --- |
| 1 | 1 / 10 | pass, 0 fail | 28.29 s |
| 2 | 1 / 10 | pass, 0 fail | 20.02 s |
| 3 | 1 / 10 | pass, 0 fail | 15.79 s |
| 4 | 1 / 10 | pass, 0 fail | 30.29 s |
| 5 | 1 / 10 | pass, 0 fail | 36.12 s |

Each process reports 33 nonselected-host skips. The retained logs contain the
permission-probe HARD line, one expired execute, and the warm SOFT+/defer line
roughly 0.1 s later. The abort completion has an error and its response clock
stays equal to the preceding served clock. The full Rust file subsequently
passed too. I did not recreate an intermittent failure with the old wait or
rerun a base bundle; the old predicate's premature satisfiability is directly
visible in these independent logs and the unchanged assertions still defend the
scheduler property.

## Verification record and containment

Tools: **Bun 1.4.2 (744846f84)**; **TypeScript 5.9.3**;
reference **OpenCode 1.18.35**. Rust copies report:

```text
ck-mc 0.1.0 (5d7bce016dbd8942080c05e6485240ee84ff7bce)
ck-subc 0.20.58
```

Both executables were copied from the placed bin directory into the throwaway
root **before** checking versions. All Rust runs selected those copies through
`MC_E2E_CK_MC_PREBUILT_BIN` / `MC_E2E_CK_SUBC_BIN`; no Rust build or live daemon was
used. The runner's prerequisite detector unnecessarily checks a third
`MC_E2E_CK_MC_DRIVE_FAULT_BIN` path even for ordinary tests. Its unset path initially
caused a prerequisite failure under the isolated HOME. I pointed that preflight
variable at the same copied module; **no drive-fault scenario was selected and
no fault-feature capability is claimed**. The ordinary prebuilt pair is what the
binary selector actually used.

Reference npm 1.18.35 tarball SHA-256:
`b626543f4427cbd7a59756c24045f6f32dbc4cf7347ab5a8613f5c9fd6b0eeb3`.
Executable SHA-256:
`8c3c351b138cfe35905ab11846a1373f1beea590aee7eda412fb765b72c79d82`.

Gates on the reviewed revision:

* `bun run --cwd packages/plugin build`: passed, including its **4 v2 loader
  tests / 19 assertions** and declaration generation. Mutant and restored bundles
  were rebuilt with the same script.
* `bun run --cwd packages/plugin typecheck`: passed (the package's three tsc
  invocations; silent exit 0, TypeScript 5.9.3).
* `BUN_JSC_useOMGJIT=0 bun test` for `request-hook-order.test.ts`,
  `system-prompt-hash.test.ts`, `v2/hooks/system-prompt-restart.test.ts`:
  **63 pass, 0 fail, 301 assertions**. An initial run with inherited fixture-global
  `OPENCODE_DB`/storage overrides had two provisional-availability failures;
  removing those overrides let the units use their own temporary XDG databases
  and resolved both without code changes. No live store was involved.
* Real stock OC1 order fixture: **1 pass / 7 assertions per restored mode**;
  the intentional mutant has **one named failure per mode** as recorded above.
* Exact Rust usage-less idle case: **5/5 isolated reference-host runs**.
* Full idle file: **7 pass / 0 fail / 37 skip per mode**, Rust 241.65 s and
  TS 187.79 s. Four long-loop variants not enabled.
* Independent simultaneous model/system/drop probe: **1 pass / 0 fail /
  9 assertions per mode**, plus the separate expected-red portability test.
* AFT inspection of the four changed source files: TypeScript diagnostics
  **0 errors / 0 warnings**; inspection was **PARTIAL** because the checkout
  call-graph view and Biome producer were unavailable. The authoritative tsc
  gate above passed; no clean whole-inspection claim is made.

Every real host run used this throwaway root:

```text
$TMPDIR/magic-context/bg_3abec17c8f9b11fd/
/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/bg_3abec17c8f9b11fd/
```

`HOME`, `CFFIXED_USER_HOME`, all five XDG roots, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR` and the nested `TMPDIR` were set underneath it.
The harness additionally places each child host's HOME, stores and XDG roots
inside its own `tmp/opencode-e2e-*` fixture. The Foundation override was included.

A concurrent `lsof -nP -p <runner-and-descendant-pids>` sampler retained full open
file listings throughout every host-containing run, including the failing
placed-host run and both mutants. Across **18 runs it captured 68,698
open-database rows, with zero outside the canonical throwaway root**. Paths were
realpath-normalized (`/var` versus `/private/var`) before checking containment.
OpenCode, Bun runner, ck-subc and ck-mc databases were under that root; no live
OpenCode or Magic Context store was accessed. The initial prerequisite failure
started no host and is not counted as a contained host run.

Retained artifacts under `<root>/evidence/` include:

* `*.lsof.txt` and `*.containment.txt`: process/file evidence and counts;
* `ts-*-requests.json`, `rust-*-requests.json`, companion per-request tables:
  supplied fixture captures, including mutant and restored lanes;
* `rust-idle-{2,3,4,5,6}.out.txt`: the five reference-host standalone cases;
* `rust-idle-full.out.txt`, `ts-idle-full.out.txt`;
* `model-probe-{ts,rust}.json` and `*-model-system-probe.out.txt`;
* `order-counterexample.out.txt`: the expected-red portability counterexample.

The root also retains the temporary probes, containment runner, environment
setup and downloaded host source. No artifact is a live-store copy. No package
manifest or lockfile was changed; no additional package install was needed.
Only this report is committed.
