# Adversarial review: holding frozen Rust-mode LKG replay

## Verdict and scope

**The alias fix works, and I found no new downstream-authority or signed-thinking
regression in the authority split. The hold policy is intentionally unbounded in
healthy-pass count. It has a real transport/tag-visibility cost, and the revised
park gates do not prove eventual adoption of module bytes.**

There is also an executable safety counterexample: a healthy frozen pass can
know that **both representations are over the known context limit and still
send the frozen one**, repeatedly. This is a **pre-existing admission hole**, not
a newly introduced alias or permission bug. Removing the count release makes
its frozen/full-transport lifetime unbounded too. The implementation must not be
described as “hold only while fitting” or “fit escape always prevents overflow.”

Recommendation: accept the alias repair and producer-only edit authority;
require a follow-up for known-over admission before calling recovery fit-safe,
and supplement the park tests with an authorized-rebuild/pressure drill. Do not
restore the 8/16 retagging permission as a solution to either problem. If
fit-safe recovery is a release requirement, the known-over counterexample below
is a blocker for that claim. I have **not** demonstrated a new production 400,
native-delta corruption, or an actual Rust producer that defers forever at high
pressure.

Reviewed delivery:

- `8d39b214bf7ded1a86917c55fed02b756274ebd5` — alias baseline, hold policy,
  representation-adoption split, plugin tests.
- `44a1891224e47530be4753e8416bd5c2f2133798` — park recovery gate changes;
  tip of `alfonso/task/bg_29744d0872d793c1-fix-lkg-freeze-baseline-counted-after-in-place-r`.
- Diagnosis: [Rust late first-serve tags](rust-tag-late-first-serve.md), from
  report base `cd43800a8ea365ee98aa45d6d786732e71cf72e1`.

The worktree started at that report base, not at the delivery. I temporarily
checked out the exact delivery **inside this isolated worktree**, tested it,
restored every exploratory edit, and returned to the task branch. Only this
report is committed. Source line numbers below refer to **44a18912**, not to the
older product source underneath this report commit.

## 1. Downstream authority audit

The important distinction is not “anything changing bytes is a HARD.” A safety
adoption selects a different already-produced representation; it must not invent
permission for unrelated host prefix edits.

In [rust-mode-transform.ts](../../packages/plugin/src/hooks/magic-context/rust-mode-transform.ts)
at the reviewed revision, `cacheBustingPass` and `moduleDecisionBusts` are the
same immutable producer decision (`HARD`, `MIGRATE_HARD`, `EXECUTE`, or `SOFT`,
3862–3873). `frozenReplayReleased` separately records local selection of module
bytes after replay-validation or admission failure. `shouldAdoptModuleAfterFreeze`
is their OR, used for capture and final freeze bookkeeping, not postprocess.

| Consumer | Actual authority at the delivery | Assessment |
| --- | --- | --- |
| Materialized boundary, marker candidate/admission, deferred marker drain | Producer bust, with committed `scheduler_decision=execute` required for a published boundary; 3909–3912, 3939–3967, 4147 | No local safety release can move the history cut. Correct. |
| Pending operations, heuristic cleanup, placeholder/system/stale-reduce strips | Rust owns planning/rendering. The adapter does **not** invoke the broad TypeScript `runPostTransformPhase`; it invokes the narrower `runRustModePostprocess` only when serving module output | No new host drain/heuristic authority is granted. |
| Note nudge | Producer bust, or the existing first-serve fence; previously persisted anchors are replayed | A safety release is not marked a bust. Holding freezes skips the host serve observer, so this is not a complete host ledger of raw-tail serves; the release comparison still covers edits before signed thinking. This is a pre-existing ledger limitation, not a new permission consumer. |
| Synthetic todo mirror | An anchor present in the **served** array is mirrored; an absent anchor clears the durable mirror only on a producer bust (4184–4190; helper 1332–1350) | This is one actual change from the old mutated local flag. Retaining an absent mirror is deliberate ride-only state, not proof of a served anchor. No executable wrong reintroduction found; a producer that omits its existing anchor on defer would need separate investigation. |
| Signed thinking | Producer bust for blanket invalidation; actual served-array comparison for safety adoption (`frozenReleaseLastServed`, 4156–4158) | Local adoption still invalidates reasoning after the first changed message; it does not blanket-strip valid earlier thinking. Correct. |
| Trailing blank decisions | Module frozen units own keep shape. Host only replays absorbing strip decisions and considers the newest assistant's source decision in postprocess | Not controlled by the newly separated flag. Frozen raw tails bypass this host phase; this predates the change. The delivered fixed-point and Rust-over-host-keep controls pass. |
| LKG slot replacement | Producer bust pre-drops the slot after installation (4225–4228); producer bust **or safety adoption** commits a replacement synchronously and requires durable persistence (4264–4279) | Safety adoption no longer pre-drops merely to price the pass, but capture failure still drops the slot and throws. An old durable representation is not accepted as the replacement. |
| Capture mode/row and delayed capture fences | Adoption is synchronous (`sync_priced` for producer bust, `sync_recovery` for safety); ordinary frozen refresh is asynchronous and capture-sequence/row-version fenced | Preserved. Row-version advancement on a frozen capture is the producer's version, **not** evidence that its native array was served. |
| Freeze counters and `forceFullWire` | Cleared after successful adoption; otherwise `forceFullWire = lkgRepresentationFrozen` (4315–4327, 4373–4376) | Consistent, but now potentially permanent. |
| Native delta acknowledgement | `pendingWireCache.nativeOutput` retains the unmodified module array (4095–4098); host-postprocessed/LKG bytes are never its splice basis. Full wire disables `tail_delta` eligibility while frozen (3125–3180) | No wrong-base splice found. After adoption the separate native basis remains valid even if the host stripped thinking or inserted marker bytes. |

**Not every listed consumer previously received the mutated flag.** In the
review base, the call to `runRustModePostprocess` already passed
`cacheBustingPass: moduleDecisionBusts`, and `materializedCompactionBoundary`
already used that producer flag. The delivery changes capture/bookkeeping and
the todo mirror's use of `cacheBustingPass`; it does not newly fence a broad
TypeScript postprocess path. Treating all these consumers as a new grant removal
would overstate the diff.

### Producer state versus what the provider really saw

There is still no host publication protocol for the actual LKG/raw-tail serve.
Rust's `served_output_fingerprint`, tag overlays, and frozen units describe
**module renders**, not every provider request. In
[transform.rs](../../crates/mc-module/src/transform.rs), the fingerprint normally
advances at 6725–6763; deferred m0/m1 divergence retains the older fingerprint.
Pending late tags are held at 5194–5223 only when Rust previously observed the
target block. Full native transport supplies raw ingress, not an acknowledgement
of the host's LKG selection.

Consequently, while frozen the engine can believe it has rendered a tagged or
blank-normalized turn that the provider actually saw raw. This was the premise
of the diagnosis, and is not repaired by these commits. The host's continued
LKG selection prevents those different renders from leaking on ordinary defers.
On a local safety release, the host adopts native output without authorizing
unrelated module frozen decisions; it synchronously saves the **postprocessed
served** array. No new inconsistent delta basis or stale-LKG resurrection was
demonstrated. Producer telemetry must not be read as proof of provider tag
visibility or cryptographic signature validation.

## 2. Unbounded hold: concrete consequences and admission hole

### Healthy producer does not imply representation recovery

An executable adapter probe uses the existing in-memory Rust fixture, a tagged
initial user, one module failure, then **100 healthy SOFT+ defers**, appending an
assistant and a user each time. Module outputs tag the users; frozen serves do
not. The raw user text contains 100 repetitions of `word ` per turn.

The new park predicates accept **all 100** recovery rows:
`applied=true`, `row_version > 1`, `served_from=lkg_frozen`. The adapter has
`parked=false` and `forceFullWire=true`; every one of those serves remains
frozen. This is producer recovery, not a permanent park. It is also no bound on
when module bytes become provider-visible. Under the stipulated never-busting
producer, arbitrarily many fitting defers can remain frozen.

Measured transport using the real adapter's `transform` request bodies (scripted
module response only):

| Quantity | Delivery | Base adapter, same fixture |
| --- | ---: | ---: |
| Frozen serves among first 100 healthy defers | 100 | 7 |
| Raw messages at end | 201 | 201 |
| Cumulative transform-body JSON bytes for those 100 defers | 9,245,096 | 699,864 |
| Delta transports among those 100 defers | 0 | 92 |
| Full served-array JSON bytes at end | 87,095 | 87,842 |
| Final no-append inspection request body | 179,675 bytes, 201 CK + 201 native messages, no delta | 3,453 bytes, 0 CK + 0 native messages, delta |

The delivered body traffic in this small probe is about **13.2×** the base.
These are adapter/module transport bytes, not Anthropic HTTP body bytes,
network latency measurements, or native re-encode timings. The final inspection
request is one additional no-append pass, outside the 100-pass cumulative sum.
Full transport bypasses the delta optimization and refreshes state/permission
probes every frozen pass. For the diagnosis's thousands of raw messages and
large full-upload pages, this perpetuates the expensive transport shape that
helped cause the original outage. It does not prove a new staging-cap failure.

During the freeze, new tool results likewise append raw, as the delivered
assistant/user/tool-result debt test demonstrates. The regular `ctx_reduce`
interface takes visible numeric tag ranges, not message IDs
([tools.ts](../../packages/plugin/src/tools/ctx-reduce/tools.ts):53–57). Newly
appended tagless results cannot be selected by a tag read from their served
content. That is **not** proof that all reduction stops: old known tags, discovery
through other tool surfaces, or a queued reduction/historian/epoch/TTL event can
cause a genuine producer bust. Untransformed raw content keeps accumulating in
the served replay until one of those events or a safety escape. The experiment
measures that presentation/transport debt; it does not exercise a real Rust
`ctx_reduce` call or assert tags are absent from Rust's store.

Finite resource limits also remain: the LKG store has a 24 MiB single-slot and
64 MiB total heap budget (UTF-16 prefix plus metadata accounting), captures can
fail, and failed replay can refuse. Thus “unbounded hold” means no pass/count
deadline, not infinite memory or a guarantee that an endlessly growing transcript
will always serve.

### Known-over, neither fits nor releases

`frozenReplayAdmission` (2628–2688) has this decision table:

| Frozen fit | Native fit | Emergency with matching provider-proven limit? | Result |
| --- | --- | --- | --- |
| under | not measured | either | Hold |
| unproven/limit unknown | not measured | normally | Log, hold |
| over | under | no | Release with `frozen_over_context_limit` |
| over | over **or unproven** | no | **Log, hold, send the known-over frozen array** |
| over | over **or unproven** | yes | Throw `FrozenReplayOverProvenLimitRefusal`, surfaced as MC-H07 refusal |

The counterexample initializes a known 200,000-token limit **before** the first
capture, enters a fitting freeze, appends a 1,500,000-byte user payload, and returns
healthy tagged SOFT+ output containing the same bulk. No provider emergency is
armed. Both candidates exceed the independent 4-bytes/token budget; neither
depends on a possibly wrong tokenizer estimate. **Ten passes send successfully,
ten log `frozen_fit_both_over`, zero refuse, freeze remains true.** The final
state is `healthy_passes=10`, `forceFullWire=true`, `limit=200000`.

The sole red assertion is:

```text
REVIEW: both-over frozen recovery must refuse rather than send ten known-over requests
Expected { sent: 0, refused: 10 }; received { sent: 10, refused: 0 }
```

The matching emergency control arms `recordOverflowDetected` and refuses the
same input with `EmergencyFailClosedError` / MC-H07. It passes. The default
provider path may therefore recover **after a provider rejection**; the local
check does not prevent the rejection. Pressure based on the preceding response
cannot itself prove a newly appended large tool result fits. Rust planning reads
`effective_usage` for scheduling (transform.rs:4304 onward), so prior successful
usage is not a replacement for final-request admission.

Baseline comparison is important: the **same known-over assertion fails on
cd43800**, sending all ten requests. The old eighth healthy pass leaves the
freeze, so only eight passes log `frozen_fit_both_over` and the final state is
unfrozen. Restoring the old count limits would not make this safe. The defect is
the no-emergency known-over fallthrough, now coupled to an unbounded hold.
The fixture scripts an otherwise legal native response, not a real module
planner; it proves the host seam lacks the claimed safety, not that the deployed
Rust planner commonly emits this exact sequence.

### Margin before overflow

For the successful fit-escape branch, admission checks the candidate against
`lkgReplayLimit`, then requires native output to measure `under`. The limit is
the trusted usable **soft** prompt budget: a declared input limit when available,
otherwise window minus the resolved output reserve; a model-matching detected
limit can narrow it. `measureLkgReplay` accepts estimates **at** the limit. It
does not reserve an additional freeze-specific percentage or tail-growth margin.
Measured-prefix admission uses provider input for that exact prefix plus an
estimate/byte budget for the new tail; it cannot borrow another request's usage.

Thus the extra margin is **zero relative to the resolved soft limit**, and
whatever output reserve the model geometry supplies relative to the total
window. The 4-byte budget is a conservative risk proxy, not a cryptographic or
provider-tokenizer bound. Unproven fit deliberately holds; known-over/both-over
can hold too. There is no unconditional “escape before overflow” guarantee.
The correct safety follow-up is refusal or explicit proven recovery, not
adopting an equally unfit array or authorizing routine prefix edits.

## 3. Restart / cold start

`coldStart.rawRunStart` is an **object field**, not a path needing a compatibility
shim. At the reviewed tip, `detectColdStartFrozenSlot` returns it from
`coldStartRawServedIndex` in
[lkg-replay.ts](../../packages/plugin/src/hooks/magic-context/lkg-replay.ts):730–760.
The helper finds the trailing raw-equivalent run in the durable served snapshot,
then resolves its start in the current raw-input index space. The delivery changes
the explanation of that baseline, not the helper's shape or file.

The value now controls debt telemetry, not a release budget. Repeated restart
resets process-local healthy-pass counts, but no longer re-arms an 8/16 escape.
The existing durable restart test holds bytes through three restarts and then
adopts a scripted HARD. First-pass busts and uncaptured outage replays give the
thinking comparison an **unproven** last-served snapshot, choosing conservative
strip coverage rather than trusting a stale shorter slot. Those controls pass.
No restart count/selection regression found; the heuristic still is not a
durable explicit “provider served this exact freeze” record.

## 4. Signed thinking

For Opus 5.5, Sonnet 5.5, and Fable 5.1, appending a new valid signed assistant
run behind an unchanged frozen prefix does not, by itself, change the prefix to
which that run binds. Frozen replay re-applies durable binding-mismatch strips
to its raw tail **before** validation, and `validateAnthropicReasoningRuns`
rejects structurally unsafe merged assistant runs.

Adoption is the dangerous moment, not the number of frozen turns. The last slot
is read before validation can drop it, and a safety release passes that served
snapshot to postprocess. `proactiveStripStartIndex` starts at the first served
message that changed; when exact last-serve proof is absent, it starts at the
first change or snapshot end, or zero without any snapshot. A genuine bust still
has blanket authority; a trim-only SOFT during/after freeze still compares the
raw-served tail rather than blindly preserving newly invalid thinking.

The delivered tests cover immediate outage-to-release, a captured frozen pass,
uncaptured growing outage tails, growth without stripping, later HARD, trim-only
SOFT, repeated safety-release chains, and the three named models across restart.
They pass. These fixtures use **synthetic signature strings** and check
preservation/removal, not Anthropic cryptographic acceptance. No claim of a
live-provider “zero 400” proof is made.

I also checked a tempting false counterexample: an armed reactive thinking
recovery being skipped forever by frozen postprocess. The real error paths in
[event-handler.ts](../../packages/plugin/src/hooks/magic-context/event-handler.ts)
arm recovery **and drop the LKG slot** (session.error:359–374;
message.updated:569–585), then invalidate session caches. The next healthy
frozen pass cannot keep replaying that slot: it releases, reaches reactive
postprocess, and can clear the flag after installation. Calling only
`armThinkingBindingRecovery` in a test would omit the production invalidation
and would not be an honest blocker reproduction.

## 5. Are the tests non-vacuous?

- The alias matrix checks stored ingress count **40** with both array identities,
  all replay entry paths, and one-message follow-up. Merely checking
  `lkgRepresentationFrozen=true` would no longer catch the alias bug because the
  count no longer releases; the explicit baseline assertion does.
- The debt tests compare the **entire served representation** with captured
  fallback plus pristine additions, against a module stub that would instead
  replace assistant/user/tool-result content with tagged output. They cross both
  old bounds, restart, then explicitly require a different HARD representation.
  The expected array is not computed through the mutated native tag renderer.
- Local validation/fit escapes and release-strip controls remain real positive
  controls. The changed growth/thinking test keeps its signed-thinking claim on
  the later genuine rebuild, rather than deleting it.
- Both temporary production mutations below fail the intended named test while
  their control remains green. The policy tests are not dead assertions.
- The park gate change is **non-vacuous for producer recovery**: a parked LKG
  shortcut is `applied=false` and does not advance the producer row. It is
  **insufficient for representation/reduction recovery**: a permanently frozen
  healthy producer satisfies it. The executable 100-pass control above proves
  this without pretending to be a real-host e2e run.

Recommended additional claims for the park suite: after recovery request an
independent authorized rebuild (or exercise real pressure/flush), require an
actual transform serve with restored visible tags/reduction and stable native
delta continuation, and retain the ordinary-defer byte-identity assertion. Do
not require ordinary healthy defer to retag just to turn the park test green.

### Mutation checks (all restored; no production change retained)

Each used the required safe sequence: stage the live file, confirm empty
unstaged diff, apply a marked `NON-VACUITY BREAK`, capture non-empty diff, run the
selected tests, `git checkout -- <path> && touch <path>`, capture empty unstaged
diff, then rerun the restored checks.

1. Move `replayInputCount` below replay installation.
   - Red: `LKG durability across restarts > preserves the frozen replay after one new raw message with aliased arrays (failure ladder)`;
     expected 40, received 1.
   - Green: the identically named **separate**-arrays failure-ladder control.
   - Mutant summary: **1 pass / 1 fail / 17 assertions**; restored:
     **2 pass / 0 fail / 18 assertions**.
2. Reintroduce `rawTailGrowth >= 16 ? "raw_tail_growth_limit" : ...` into local
   release selection.
   - Red: `LKG durability across restarts > keeps frozen bytes through twenty new raw messages and ten healthy defers with aliased arrays until a genuine rebuild`;
     provider-served outage bytes become the stub's tagged output.
   - Green: `LKG durability across restarts > releases an over-context frozen replay to fitting module output on a healthy defer`.
   - Mutant summary: **1 pass / 1 fail / 7 assertions**; restored:
     **2 pass / 0 fail / 55 assertions**.

Both mutations touched only `rust-mode-transform.ts`; each non-empty diff was
**1 file, 2 insertions(+), 1 deletion(-)**, followed by empty `git diff --stat`.

## 6. Executable counterexamples

Run the following **from the root of a clean disposable checkout of 44a18912**
with the prepared Bun dependencies. It generates a sibling test from the existing
in-memory fixture, adds instrumentation and three probes, and removes the
generated test on exit. It launches **no OpenCode/subc/module host**, opens only
fixture databases, and needs no live stores or API credentials. The reviewed
fixture uses the real adapter and real estimator; only module replies are
scripted. The final command is intentionally red: **two pass, one fail**.

```sh
set -eu
probe=packages/plugin/src/hooks/magic-context/lkg-freeze-hold-review.probe.test.ts
test ! -e "$probe"
trap 'rm -f "$probe"' EXIT
git show 44a1891224e47530be4753e8416bd5c2f2133798:packages/plugin/src/hooks/magic-context/rust-mode-frozen-review-r2.test.ts > "$probe"
python3 - "$probe" <<'PY'
from pathlib import Path
import sys
p = Path(sys.argv[1])
s = p.read_text()
def replace(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
replace('function reviewSession(label: string, model: Model = OPUS) {',
        'function reviewSession(label: string, model: Model = OPUS, limit = 200_000) {')
replace('recordDetectedContextLimit(db, sessionId, 200_000, modelKey);',
        'recordDetectedContextLimit(db, sessionId, limit, modelKey);')
replace('modulePageMaxBytes: 512 * 1024,', 'modulePageMaxBytes: 8 * 1024 * 1024,')
replace('    const moduleClient: RustModeModuleClient = {\n        call: async ({ method }) => {',
        '''    const wireRecords: Array<{messages:number; native:number; bytes:number; delta:boolean}> = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method, body }) => {''')
replace('            if (method !== "transform") return { ok: true };',
        '''            if (method !== "transform") return { ok: true };
            wireRecords.push({messages:(body.messages as unknown[] ?? []).length, native:(body.native_messages as unknown[] ?? []).length, bytes:Buffer.byteLength(JSON.stringify(body)), delta:body.tail_delta !== undefined});''')
replace('        model,\n        user:', '        model,\n        wireRecords,\n        user:')
p.write_text(s)
PY
cat >> "$probe" <<'TS'
import { spyOn } from "bun:test";
import * as reviewLogger from "../../shared/logger";
import { recordOverflowDetected as reviewRecordOverflow } from "../../features/magic-context/storage-meta-persisted";

describe("hold review executable probes", () => {
    it("REVIEW: both-over frozen recovery must refuse rather than send ten known-over requests", async () => {
        const s = reviewSession("hold-both-over", OPUS, 200_000);
        s.setModuleOutput(tagAllUsers);
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        await s.run(input, "throw");
        input.push(assistant(s.sessionId, "a1"), s.user("m2", "word ".repeat(300_000)));
        const log = spyOn(reviewLogger, "sessionLog").mockImplementation(() => {});
        let sent = 0, refused = 0;
        try {
            for (let i = 0; i < 10; i++) {
                try { await s.run(input, "SOFT+"); sent++; } catch { refused++; }
            }
            const state = s.transform.getState(s.sessionId);
            const bothOver = log.mock.calls.filter(([sid, line]) => sid === s.sessionId && String(line).startsWith("frozen_fit_both_over")).length;
            console.log("HOLD REVIEW both-over", JSON.stringify({sent, refused, bothOver, frozen:state.lkgRepresentationFrozen, fullWire:state.forceFullWire, healthy:state.lkgFrozenHealthyPasses, limit: lkgReplayLimit({db:s.db, sessionId:s.sessionId, model:OPUS, modelKey:"anthropic/claude-opus-5-5"})}));
            expect({sent, refused}).toEqual({sent:0, refused:10});
        } finally { log.mockRestore(); }
    });

    it("REVIEW CONTROL: provider-proven emergency refuses the same both-over input", async () => {
        const s = reviewSession("hold-emergency");
        s.setModuleOutput(tagAllUsers);
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        await s.run(input, "throw");
        reviewRecordOverflow(s.db, s.sessionId, 200_000, "anthropic/claude-opus-5-5");
        input.push(assistant(s.sessionId, "a1"), s.user("m2", "word ".repeat(300_000)));
        let refusal: Error | null = null;
        try { await s.run(input, "SOFT+"); } catch (error) { refusal = error as Error; }
        console.log("HOLD REVIEW emergency", refusal?.name, refusal?.message);
        expect(refusal).not.toBeNull();
    });

    it("REVIEW CONTROL: one hundred healthy frozen defers satisfy the new park recovery predicate", async () => {
        const s = reviewSession("hold-park-predicate");
        s.setModuleOutput(tagAllUsers);
        const input = [s.user("m1", "question")];
        await s.run(input, "HARD");
        await s.run(input, "throw");
        const log = spyOn(reviewLogger, "sessionLog").mockImplementation(() => {});
        let frozenServes = 0, outputBytes = 0;
        try {
            for (let i = 0; i < 100; i++) {
                input.push(assistant(s.sessionId, `a${i}`), s.user(`m${i+2}`, "word ".repeat(100)));
                const output = await s.run(input, "SOFT+");
                outputBytes += Buffer.byteLength(JSON.stringify(output));
                if (s.transform.getState(s.sessionId).lkgRepresentationFrozen) frozenServes++;
            }
            const lines = log.mock.calls.filter(([sid,line]) => sid === s.sessionId && String(line).startsWith("rust pass:")).map(([,line]) => String(line));
            const accepted = lines.filter(line => line.includes("applied=true") && line.includes("served_from=lkg_frozen") && Number(/row_version=(\d+)/.exec(line)?.[1]) > 1).length;
            const state = s.transform.getState(s.sessionId);
            console.log("HOLD REVIEW park", JSON.stringify({accepted, frozenServes, fullWire:state.forceFullWire, healthy:state.lkgFrozenHealthyPasses, rawCount:input.length, finalOutputBytes:Buffer.byteLength(JSON.stringify(await s.run(input,"SOFT+"))), cumulativeOutputBytes:outputBytes, finalTransport:s.wireRecords.at(-1), cumulativeTransportBytes:s.wireRecords.slice(2,102).reduce((n,r)=>n+r.bytes,0), deltaTransports:s.wireRecords.slice(2,102).filter(r=>r.delta).length}));
            expect(accepted).toBe(100);
            expect(frozenServes).toBe(100);
            expect(state.forceFullWire).toBe(true);
        } finally { log.mockRestore(); }
    });
});
TS
BUN_JSC_useOMGJIT=0 bun test --timeout 30000 "$probe" -t 'REVIEW:|REVIEW CONTROL:'
```

To compare the **base adapter**, leave this generated fixture unchanged and
temporarily load just `rust-mode-transform.ts` from cd43800 in another clean
disposable checkout. The known-over test remains red; the permanent-freeze
control becomes red (`accepted=7` instead of 100), and the emergency control
stays green. This review performed that comparison and restored the reviewed
adapter afterward; it did not change the old test to make it pass.

## 7. Verification record and boundaries

Bun **1.4.2 (744846f84)**; TypeScript **5.9.3**.

- `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts packages/plugin/src/hooks/magic-context/rust-mode-release-strip-gate.test.ts packages/plugin/src/hooks/magic-context/rust-mode-frozen-review-r2.test.ts`
  — **204 pass, 0 fail, 3,370 assertions** on the exact delivery, before probes.
- `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 packages/plugin/src/hooks/magic-context/lkg-transform-replay.test.ts packages/plugin/src/hooks/magic-context/lkg-slot.test.ts packages/plugin/src/hooks/magic-context/lkg-replay-fit.test.ts packages/plugin/src/hooks/magic-context/lkg-persist.test.ts packages/plugin/src/hooks/magic-context/lkg-entry-projector.test.ts`
  — **58 pass, 0 fail, 167 assertions**.
- `BUN_JSC_useOMGJIT=0 bun test --timeout 30000 packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts -t 'Rust|rust'`
  — **17 pass, 0 fail, 171 assertions** (227 filtered out).
- `bun run --cwd packages/plugin typecheck` — **passed**, three TypeScript project
  invocations; silent successful `tsc` output. An initial version lookup at root
  `node_modules/.bin/tsc` failed because this workspace installs that executable
  under `packages/plugin/node_modules/.bin`; the actual package-script gate
  succeeded and that executable reported Version 5.9.3.
- Exploratory probes against the delivery: **2 pass, 1 expected fail, 5 assertions**.
  Base-adapter comparison: **1 pass, 2 expected fails, 3 assertions**. These are
  red diagnostic claims, not a passing acceptance suite.
- The report's executable recipe is itself run and checked for the exact one red
  name, both green controls, counts, exit status, and generated-file cleanup:
  **6 checks passed** with Python **3.9.6**. The bulk probe raises the module page
  size to 8 MiB only in its fixture so the scripted client does not need to
  implement upload-page coordination; the admission logic and estimator are
  unchanged. The 100-pass transport comparison remains below the original
  512 KiB fixture page size.
- Restored alias and policy mutation gates: **2 pass / 18 assertions**, and
  **2 pass / 55 assertions**, respectively; their isolated red runs are recorded
  above.
- Scoped Markdown inspection is **partial**: no Markdown LSP diagnostic producer
  is registered, so it is not claimed as a clean diagnostics pass.

No manifests or lockfiles changed. Prepared-worktree install/build passed at
the report base; they are not presented as a new delivery build. New build/lint
are unnecessary for the sole retained Markdown change. No Rust hermetic shard,
host, live provider, live database, or live log analysis was needed to prove
the adapter counterexamples. Accordingly there is **no host-isolation/lsof
attestation** to claim. A real-host pressure/reduction drill remains a recommended
follow-up, and must use the throwaway XDG/DB/storage/HOME roots and lsof proof
specified in the brief. No changes to ARCHITECTURE.md or STRUCTURE.md.

The source's `RustSessionState` comment still describes healthy-pass/raw-tail
limits as preventing indefinite replay, and the older Rust architecture document
still describes 8/16 release. Those descriptions are stale after the delivery;
they were left untouched in this report-only task.
