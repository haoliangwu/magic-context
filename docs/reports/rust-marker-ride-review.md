# Rust marker rides: adversarial design review

## Scope and verdict

Reviewed master **4ad229feb8395644d49f68a420f9582b87f4c137**, including
`docs/designs/rust-marker-ride-hard-folds.md`. All production line references below
are to that tree. Read the protected mutation gates, invariants 1–4 and disjoint-DB
model in `ARCHITECTURE.md:68–90`, and all three `marker-unfreeze-review` reports.
Neither architecture file is changed. This delivery is **report-only**.

**The direction is right, but the implementation contract needs two corrections
before it is safe to implement literally:**

1. Specify a **served-rebuild permission**, not an export of the planner's
   `reclaim_ride_available`. I reproduced a real producer **SOFT+ with
   `reclaim_ride_available=true` and identical served bytes**. The two internal
   predicates named in the design are not interchangeable.
2. Bound a pending retry by the coverage actually consumed in the response.
   I reproduced the consumer applying **20 despite a response boundary of 10**
   and clearing the newer pending blob. Monotonic target selection and CAS-clear
   do not establish consumed coverage. TS mode already has this check.

These are a protocol-design ambiguity and an inherited consumer hole,
respectively, not regressions in an implementation that has not landed. Removing
the scheduler check with a correctly defined permission can fix the demonstrated
epoch/defer shape; the host prototype does not certify either correction above.
Existing baseline suites remain green. No production guard was neutralized, and
no live database, backup database or live configuration was accessed or copied.

## Blockers

### B1 — exporting the existing reclaim opportunity is not exporting an actual rebuild

**Evidence:** `crates/mc-module/src/transform.rs:4690–4708,4917–4980,5165–5186,6934–6940`;
`crates/mc-core/src/lib.rs:139–157`;
`docs/designs/rust-marker-ride-hard-folds.md:236–253`.

The design names both `is_provider_prefix_mutation_pass` and
`reclaim_ride_available`, without fixing a field name or its exact derivation.
The latter returns `pass_already_busting`, computed **before classification**.
It includes a fresh force-band episode and emergency authorization. It is an
opportunity for the selector to find work, not evidence that work/rebuilding
landed. The classifier can still choose Defer when there is no m1 delta or eligible
reclaim; reconcile clearing can also choose Defer. A later lineage-anchor failure
explicitly demotes the plan to Defer at `transform.rs:5165–5168`.

**Executed real-producer counterexample:** a throwaway test inside the existing
Rust test module warmed a compartment covering `a` at ordinal 1 plus protected
text at ordinal 2, at 10% usage. An empty project-memory epoch HARD had
`reclaim=false` and identical output. Raising usage to 90%, without a history delta,
tool arc, caveman candidate or other reclaim work, then produced:

```text
REVIEW no-op action=HARD reclaim=false equal=true
REVIEW force action=SOFT+ reclaim=true equal=true
transform::tests::review_probe_planner_ride_is_not_a_served_rebuild_certificate ... FAILED
a served SOFT+ cannot certify a genuine prefix rebuild
```

The action and literal served-message equality assertions passed before the last
assertion failed. **0 pass / 1 expected-safe failure**, 1,627 filtered, 0.50s.
This is not a defect in force authorization itself: the producer is permitted to
select work in that band. It disproves using that *planner opportunity* as a
certificate that a response actually rebuilt. A host that exports it verbatim and
drains a lagging marker would make the host marker the pass's first mutation.

The opposite label trap is real too. `transform.rs:4632–4679,5171–5186` deliberately
runs byte-preserving marker HARDs while closing every bust-only lane.
`action_str` still says HARD (`:16107–16115`). The adapter currently guesses
permission from that label (`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3854–3867`),
so a retained target can already drain on this inherited path. The existing
real-producer `identical_bytes_epoch_hard_holds_pending_drop_and_serves_identical_bytes`
test (`transform.rs:21345–21390`) protects Rust drops, not the host marker or
host frozen-replay release. The protocol change must fix the adapter, not weaken
the producer's byte-preserving exception.

**Required contract:** name and document one response-local boolean whose `true`
means the **successful response's final prefix-mutation plan** admits host work.
For primary sessions the existing `is_provider_prefix_mutation_pass` at
`transform.rs:5179–5186` is the relevant served-plan predicate; do not substitute
the pre-classification reclaim opportunity. Cover special constructors and later
response replacement explicitly. `lib.rs:10604–10607,10665–10669,10714–10723` can
rerun the transform after publication: the permission, coordinates and native
messages must come from the **same final result**, not an earlier attempt.
If the implementation instead wants force-with-no-rebuild to authorize a host-only
rewrite, that is a different policy from this design's “genuine rebuilding pass”
and needs explicit pricing/plan changes, not an accidental consequence of a field.

### B2 — a newer pending target can replace the exact response target before applying

**Evidence:** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:810–880`;
`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts:114–168,323–331,358–378`;
`docs/designs/rust-marker-ride-hard-folds.md:124–130,205–213,292–294`.

The design says a later publication cannot change this pass's exact target and
that existing candidate/CAS checks need no change. The consumer does otherwise:

1. Response boundary is `{rowVersion:7, ordinal:10, endMessageId:"m10"}`.
2. A pending blob at 20 is already present when the recording transaction runs.
   At `transform-postprocess-phase.ts:824–826`, `target = pending` wins.
3. The consumer rereads pending at 859, drops the trusted response fence because
   the coordinates differ, and **still invokes the strategy on 20** at 875–880.
4. Unfenced validation proves only that a raw target and matching durable
   compartment exist. It does not prove this response rendered that compartment.
5. Successful application CAS-clears pending 20. That CAS says nobody replaced
   the blob during the drain; it says nothing about served coverage.

**Executed expected-safe failure:** a throwaway Bun test made real OpenCode fixture
message/part tables with users at 1, 10, 11 and 20, and complete adjacent indexed
compartments `[1,10]`, `[11,20]`. It called the real exported consumer and default
marker manager with admission proven and response boundary 10, while pending was
`{ordinal:20,endMessageId:"m20",publishedAt:2}`. Result:

```text
REVIEW race {"marker":20,"pending":null}
review proof: a newer pending publication must not outrun the served Rust boundary
Expected: <= 10
Received: 20
```

The same real-manager fixture without newer pending passed:
`review control: an exact response target applies with the same real manager`
(marker 10; pending NULL). This does not require a malformed compartment, a partial
end, a bypassed guard, or a host lock failure.

Concrete cache trace: response R renders history through 10 and serves raw 11–20;
publication P becomes durable through 20 after R's snapshot; the host applies P's
marker, then serves R. The next host input omits 11–19 although frozen Rust coverage
still ends at 10. Those raw bytes leave the next request without having joined R's
summary, or repair has to refuse/rebuild. The write-ahead LKG fence does not fix
this: R can fit, capture and finish successfully, clearing the fence despite the
coverage mismatch.

**Reachability limit:** this is an executed *consumer interleaving state*, not a
paused live Rust-historian race. The current module publishes compartments directly
into context.db (`rust-mode-transform.ts:4421–4425`); I found no module historian
writer of the plugin's `pending_compaction_marker_state`. A normal module-only
publication with NULL pending therefore does not by itself produce this trace.
However, pending is an explicitly supported legacy/retry input, and TS publication
can write it transactionally (`compartment-runner-incremental.ts:1143–1154`). The
design claims safety for retained pending and racing publication, not just a
single module-only producer with no such state. Do not present the unsafe exported
consumer as a general publication fence.

**Required:** a pending target may be applied only if covered by the actual served
response/consumed representation. Retain newer work unchanged, including retry
health; do not force a flush to catch it. Decide explicitly whether to apply the
older response target while retaining the newer blob, or skip this cut entirely.
Both can be safe; applying the newer target without consumption proof cannot.
An old pending retry on a noncommitting response needs coverage proof as well;
“there is no fresh target to mint” is not permission to drain arbitrary old work.

TS already does the missing check at
`transform-postprocess-phase.ts:3133–3184`. Its test
`preserves a pending marker newer than the consumed compartment boundary`
(`transform-postprocess-phase.test.ts:2597–2626`) passed in the baseline run.
Carry that property into the Rust consumer, not just its ordinal monotonicity.

## Should-fixes

### S1 — reconciliation has a different permission from the other Rust host lanes

**Evidence:** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1100–1128,1254–1273`;
`packages/plugin/src/features/magic-context/storage-meta-persisted.ts:2313–2362`;
TS counterpart `transform-postprocess-phase.ts:3220–3243`.

Rust drains using `args.cacheBustingPass` but passes
`isCacheBustingPass: args.materializedBoundary != null` to reconciliation. The
coordinate extractor requires a fresh commit and valid nonempty coverage, so
permission can be true while that boundary is absent. A logical marker clear
keeps a tombstone for ordinary replay. On a genuine noncommitting/empty-history
rebuild, Rust still replays that cleared marker instead of retiring it in this
already-priced pass. TS passes its shared permission directly.

**Executed expected-safe failure:** `review proof: a permitted rebuild without a
fresh boundary retires a cleared marker` seeded a marker, logically cleared it,
and ran real Rust postprocess with `cacheBustingPass:true`, no new boundary and a
normal MessageLike tail. `getDeferredClearedCompactionMarkerState` returned the
old marker instead of NULL. This is an inherited delayed-retirement defect, not
an unsafe new raw cut. It is precisely a lane the design's universal-permission
promise (`docs/designs/rust-marker-ride-hard-folds.md:245–253`) should include.
Do not merely swap the extractor's permission while leaving this second gate.

### S2 — define the wire truth table and unsupported-build recovery, not just “boolean”

**Evidence:** `crates/mc-module/src/transform.rs:1629–1729,1738–1818`;
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3868–3871,4032–4079,4139,4177–4182,4217–4264,4454–4459`;
`docs/designs/rust-marker-ride-hard-folds.md:247–251`.

A single boolean is sufficient for **eligibility**, not admission, coverage or
distributed atomicity. Specify the following before changing callers. In this
table `prefix_bust_permitted` is a proposed name, not a field already implemented.

| Wire value / result | Host action |
| --- | --- |
| Actual `true`, successful native response | Allow bust-only host lanes on this response, regardless of scheduler execute/defer. Create a new marker target only with `committed:true` and all existing coordinate checks. Apply/retry only after coverage and fit proof, then fence, cut, final admission and synchronous capture. Permission is not “must cut”. |
| Actual `false`, including byte-preserving HARD | Replay existing decisions/marker representation. No target extraction, marker retry, attempt increment, new strip or other bust-only first application. A HARD label/metadata commit does not override false. A frozen representation stays frozen unless its separate bounded/invalid-replay release rule legitimately fires. |
| Absent, NULL, string `"true"`, number `1`, object, or other wrong type | Unsupported permission: hold host first applications and retained target/counters; log an actionable upgrade/capability diagnostic. Never fall back to the label, scheduler, committed flag or a later status read. Pending alone must not induce `session.flush`. |
| Any error, NEED_FULL_SYNC, rejected native shape or failed admission | Not permission to cut, even if an earlier response had true. The eventual accepted retry must carry its own permission and coordinates. |
| A false/unsupported response while a durable marker-admission fence is armed | Refuse; do not clear the fence, hydrate old LKG, park unmanaged, or turn “hold” into raw fallback. Require a supported rebuilding response after the explicit recovery flush. |

For a new producer, emit **both true and false explicitly**; do not copy
`reasoning_trim_only`'s skip-false serialization and make false indistinguishable
from an old build. Define compatibility constructor defaults and deserialization
of old responses. A new producer emitting true with final SOFT+ should be a
protocol inconsistency, not an excuse to broaden ordinary-defer mutation.

Keep separate concepts in the adapter: producer permission, local frozen-release
pricing and durability of the response actually installed. The mutable local
`cacheBustingPass` becomes true on bounded/invalid frozen-release paths at
`rust-mode-transform.ts:4055–4073`; the immutable module permission passed to
postprocess at 4139 must **not** acquire marker authority from that local release.
On an unsupported old module, holding mutations also must not accidentally change
priced LKG replacement to asynchronous persistence: the code at 4217–4264 uses
the same variable for capture/failure semantics. Conservatively synchronous
capture or explicit refusal is safer than allowing a fresh representation while
leaving old durable replay authoritative after restart. The design should state
this distinction; it need not infer marker permission from a label to maintain a
conservative capture policy.

**Other hosts:** the field is additive response metadata, not prompt content.
The module serializes response metadata independently of CK message streaming
(`crates/mc-module/src/lib.rs:15821–15835`); the OpenCode transport returns the
assembled object (`module-transport.ts:631–665`). Test it through full, native-delta
and paged replies, not only a mocked object literal. Claude Code uses the same
module but has no OpenCode marker rows (`docs/architecture/rust-module.md:3,76–78`);
do not graft this host cut or OpenCode fence onto its gateway. The gateway's
consumer implementation is not in this worktree, so strict unknown-field parsing
and its deployed version mix are **not certified** here. Require a gateway
compatibility check for the public response addition.

Pi currently always runs TS (`docs/architecture/rust-module.md:22`) and drains an
entry-list marker via `appendCompaction`, retaining ordinal + 1
(`packages/pi-plugin/src/compaction-marker-manager-pi.ts:60–79,110–119`). Its
rendered-coverage check is separate (`context-handler.ts:5254–5280,7080–7102`).
It should do **nothing** with this Rust response field in this change. Do not
share OpenCode's sparse-gap certificate, retained-user exclusion, or fence with Pi.

### S3 — the 16k cut proves progress, not operational bounds for mixed large histories

**Evidence:** `docs/designs/rust-marker-ride-hard-folds.md:339–380`;
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3941–3948,4112–4116,4224–4233`;
`packages/plugin/src/features/magic-context/compaction-marker.ts:93–96,106–140,339–365,400–438,607–664,704–720`.

There is no 16,000-row DELETE in the marker transaction: it deletes the previous
marker row set and upserts one compaction part, one summary message and its text
part. Ordinary raw history remains in opencode.db. The new cut changes what the
next host read returns. A one-shot jump is not intrinsically a longer write lock
proportional to the ordinal distance, and dividing it into many marker steps
would risk precisely the repeated mutation cycles the design avoids.

But latency/memory are not proven by 17,000 cloned 64-byte users. Raw input, wire
snapshots, engine output and capture preparation have different sizes; output fit
does not bound raw-input serialization or memory. Indexed-end enumeration and
canonical gap/boundary reads also still run. The short **250ms busy timeout**
bounds lock acquisition, not transaction-body work or COMMIT/fsync. Existing
writer logs expose acquire/hold/work/end times; the design does not report those
numbers or peak RSS for its large fixture.

Require a mixed user/assistant/tool fixture with large JSON/tool outputs, tied
timestamps, the seven sparse gaps and a retained assistant partial turn. Measure
incoming bytes, peak RSS, fit results, host write timings and first smaller-input
transport. Hold a real opencode writer and verify definitely-no-cut rollback,
pending retention and ordinary-pass no-retry. Keep the failed-fit controls; never
use low pressure or “only metadata” as permission to skip fit/fence checks.

## Crash, restart and coverage conclusions

### The existing write-ahead fence is the right ordering; preserve it on defer HARD

**Evidence:** `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:2085–2108,3933–3961,4111–4129,4162–4175,4252–4264,4454–4525`;
`packages/plugin/src/hooks/magic-context/lkg-persist.ts:300–310`;
`packages/plugin/src/features/magic-context/compaction-marker.ts:694–731`.

| Crash/failure window | Required outcome with the new eligibility |
| --- | --- |
| store.db transform committed, response lost before adapter fencing | Host marker unchanged. Old LKG can still validate/freeze. The committed fold is not proof the provider received it; a subsequent SOFT+ must not retry the marker or force a marker-only bust. Catch-up can wait for another genuine rebuild. |
| context.db fence transaction failed/uncommitted | No host strategy invocation. Its transaction rolls back. Preserve safely available old replay; no unmanaged serve on a busy fault. |
| Fence committed, before opencode replacement | Quarantined old LKG is hidden on restart even if host boundary is still old. Recovery must actually dispatch flush and recompose; uncertainty cannot be guessed away. |
| Host replacement committed, mirror/CAS bookkeeping not complete | Fence remains; host may be newer than the context marker mirror. Never hydrate old LKG or serve the original uncut input as a fallback. Deterministic marker IDs permit repair/upsert on recovery. |
| Cut followed by native validation/final-fit/capture/late-bookkeeping failure | Refuse the turn, retain durable fence, cancel queued old captures. This is not an admitted bust, and returning old bytes would undo the cache-stability reasoning. |
| Proven no-cut outcome, later capture failure | Old saved representation may be restored only with typed definitely-no-cut proof. An ambiguous COMMIT failure is not that proof. |
| All final validation, priced capture and bookkeeping completed | Clear the durable fence last; fresh restart must load only the new admitted slot. |

The fence lives in **context.db**, not store.db. The module's CAS commit, plugin
fence and host transaction are three distinct operations, not a distributed
transaction. The fence does not have to precede the module commit; it must precede
any host cut. The successful marker write must not be confused with a response
being sent to or accepted by the provider. Admission/capture is the local boundary
this code can prove; this review does not claim provider-ack atomicity.

The r3 missing-method defect is fixed at this base: recovery includes the JSON
`method:"session.flush"` (`rust-mode-transform.ts:3651–3659`), and transport now
inserts non-facade methods too (`module-transport.ts:224–229,600–605`). Keep a real
transport/recovery test rather than relying on mocks that accept every non-transform
call. A fenced session with an older module lacking permission will necessarily
refuse under the proposed fail-closed contract; document upgrade as the remedy,
not manual fence deletion.

A historian that reads raw data is not a second permission gate. Marker replacement
changes synthetic compaction metadata, not ordinary raw parts; retaining the user
at/before the consumed end retains a superset of the historian's later suffix.
This is consistent with `ARCHITECTURE.md:85–90` and
`crates/mc-module/src/historian_chunk.rs:1013–1039`. Do not add a historian-active
veto to just the host marker on a genuine rebuild: that recreates the split-bust
problem. However, raw-read disjointness is **not** consumed-target proof; B2 is
independent of whether the historian's input remains intact.

### Sparse and partial-end rules must remain exactly as strict

**Evidence:** `crates/mc-module/src/historian_validate.rs:1083–1113`;
`crates/mc-module/src/transform.rs:5452–5469,5471–5500`;
`packages/plugin/src/features/magic-context/compartment-storage.ts:912–945`;
`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts:238–285,358–378`;
`packages/plugin/src/features/magic-context/compaction-marker.ts:316–438`.

Nothing about permission=true changes these rules:

- Next **present** ordinal is legal; integer adjacency is not the only coverage
  proof. A fresh Rust HARD still refuses a present live item below coverage that
  belongs to no compartment, and validates its live last-block anchor.
- Unknown/missing anchors, a missing successor, real or mixed gap parts, empty
  messages and pre-flag notices do not become safe because the pass is rebuilding.
  The OpenCode certificate requires actual boolean synthetic flags on every
  noncompaction part and at least one such part; text/FTS recognition is not proof.
- The old lower bound is the **actual retained user**, not the summary target
  ordinal. Only strictly earlier canonically ordered ends are excluded. Unknown
  order and equality remain protected.
- The latest indexed assistant end cuts at its preceding real user, retaining the
  partial message, tool parts and turn suffix. A trusted response coordinate skips
  the redundant target lookup, **not** this partial-end guard.
- Last-block indices are valid for the real Rust whole-message producer; neither
  this field nor the SQL query certifies arbitrary manually corrupted intervals.

The base's retained-partial regression and sparse-gap manager controls passed.
The host prototype's all-user fixture is not new evidence for tool-turn rollback.

## Nits

### N1 — make the permission requirement unconditional in the design prose

`docs/designs/rust-marker-ride-hard-folds.md:23–30,245–254,451–459` sometimes frames
the field as necessary only for an “unrestricted all-HARD promise”, whereas
`:15–17` recommends actual shared permission. Even an epoch/defer-only extractor
does not isolate retained pending retries from byte-preserving HARD labels in
the existing adapter. State one shipping requirement; label the adapter-only
prototype as a demonstration, not an alternative safe production patch.

### N2 — preserve telemetry distinctions and describe the precise test-policy change

`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:754–765,808–824,827–877`
and `rust-mode-transform.test.ts:1963–2003` are the relevant places. Log explicit
permission and unsupported permission separately from HARD/SOFT and scheduler
decision. The helper test currently claims execute-only eligibility; changing
that claim is intentional and should be stated in the implementation commit.
Keep both metadata-SOFT+ negative assertions. Keep the once-per-coverage/cooldown
nudge controls (`rust-mode-transform.test.ts:2005–2052,2054–2100`); repeated
same-coverage rebuilds must not re-arm a nudge just because scheduler no longer
filters them. No new timing-label file or compatibility shim is needed for
`pp.markerReconcile` (`transform-postprocess-phase.ts:3261`).

## Implementation acceptance tests and mutations that must turn them red

These are **required future controls**, not mutation proofs performed by this
report. Use actual producer/native output for permission and actual intercepted
provider objects for byte equality. Every safety mutant must reach the intended
test, and only its named expected control should fail. Passing ordinary unit
suites alone is insufficient: both consumer proof failures below coexist with
the current green baseline.

| Named control to carry | Concrete mutation that must make it fail |
| --- | --- |
| `deferred system epoch rebuild catches up a lagging marker with NULL pending` | Restore scheduler=execute as an extractor prerequisite, or always return false permission on defer HARD. Use a real producer and assert the literal marker advance, then full smaller-input transport. |
| `byte-preserving marker HARD holds the host marker, queued drops and frozen provider bytes` | Derive host permission from HARD, or serialize permission=true for the no-op epoch/floor-input HARD. Assert unchanged real marker rows, pending blob/attempts, frozen state, and literal provider system/messages. |
| `force opportunity without eligible work does not certify a served rebuild` | Export `pass_already_busting`/`reclaim_ride_available` directly. Use the real-producer 90%-usage counterexample in B1. |
| `all host first applications hold without an actual boolean permission` | Add any label/execute/committed compatibility fallback or truthiness coercion. Table-test absent, NULL, false, 1, strings and objects, through the adapter, with pending work. |
| `newer pending publication waits until consumed by the served response` | Remove the consumed-coverage check or adopt newer pending before applying. Use B2's real-manager fixture, then a paused-publication integration test; require newer pending and retry health retained. |
| `genuine rebuild without fresh coordinates retires the cleared marker in the same cycle` | Reintroduce `materializedBoundary != null` as reconciliation permission. Include ordinary false-permission tombstone replay as the green counterpart. |
| `frozen SOFT+ and local bounded freeze release cannot drain retained markers` | Run marker postprocess on frozen replay, or pass the locally promoted mutable pricing flag as producer permission. Existing frozen-SOFT+ regression is at `rust-mode-transform.test.ts:915–992`. |
| `defer HARD failed admission remains fenced across restart` | Move fencing after the host cut, clear early, let the loader ignore the fence, or let a stale queued capture resurrect replay. Parameterize existing after-marker/capture/bookkeeping fault fixtures by scheduler defer; add final-fit, mirror failure and OS-cut windows. |
| `recovery uses real session.flush and only supported rebuilding admission clears the fence` | Remove the serialized method, acknowledge flush without reaching the module, or permit false/missing permission to clear. Test real transport and restart, not just call-method mocks. |
| `sparse certificates and retained partial turns survive newly eligible cuts` | Accept unknown/mixed/string flags, ignore a missing anchor/successor, restore summary-target lower bounds, or bypass the partial guard for a trusted Rust row. Retain the r2 assistant-target/user-rollback test. |
| `one shared rebuild drains while the historian is running` | Add a marker-only historian veto. Pair with a nonbusting active-historian control; neither ordinary publication nor queued drops may force a bust. |
| `mixed 16k catch-up has byte-stable following SOFT+ and bounded host writes` | Use a suffix delta against the old larger raw count, omit final fit, or incrementally cut without a new admitted shared permission. Assert full transport after shrink, later append delta, actual provider bytes and no LKG/refusal masking. |

Also retain coordinate fuzz negatives (committed, row version, ordinal and boundary
vocabulary), metadata-only committed execute, compaction-off/subagent exclusions,
definitely-no-cut versus uncertain failures, Pi's independent guard suite, and
gateway old/new response compatibility. Run Rust package tests, plugin typecheck,
relevant units, rebuilt bundled real-host tests and packaging compatibility on the
eventual implementation. Source-entry mock success is not a bundled-host proof.

## Independent verification and limits

Tools: **Bun 1.4.2 (744846f84)**; **cargo 1.99.0 (5f94df478 2026-08-27)**;
**rustc 1.99.0 (b940084d7 2026-09-28)**. Prepared frozen Bun install was used;
no manifest or lockfile changed. Native compilation was foreground, package-scoped,
offline/locked, `-j 2`, one at a time.

| Command (worktree-relative; Bun commands from named package) | Result |
| --- | --- |
| From `packages/plugin`: `timeout 120s bun test src/hooks/magic-context/rust-marker-review-probe.test.ts --timeout 30000` | **1 pass / 2 expected-safe failures / 4 assertions**, 1.336s. Only B2 and S1 fail; exact-target real-manager control passes. Temporary file removed. |
| `timeout 900s cargo test -p mc-module --lib --locked --offline -j 2 review_probe_planner_ride_is_not_a_served_rebuild_certificate -- --nocapture` | **0 pass / 1 expected-safe failure / 1,627 filtered**, 0.50s after 1m52 compilation. B1 action/equality/no-op controls pass before the final certificate assertion fails. Temporary test-only insertion removed. |
| From `packages/plugin`: `timeout 240s bun test src/features/magic-context/compartment-storage-v6.test.ts src/hooks/magic-context/compaction-marker-manager.test.ts src/hooks/magic-context/rust-mode-transform.test.ts src/hooks/magic-context/transform-postprocess-phase.test.ts --timeout 30000` | Restored baseline: **438 pass / 0 fail / 4,535 assertions**, 29.93s, four files. |
| `timeout 900s cargo test -p mc-module --lib --locked --offline -j 2 epoch_hard` | Restored baseline: **5 pass / 0 fail / 1,622 filtered**, 4.36s after 51.54s compilation. Includes no-op/content-changing HARD and synthetic-todo controls. |
| From `packages/pi-plugin`: `timeout 90s bun test src/compaction-marker-manager-pi.test.ts --timeout 30000` | **11 pass / 0 fail / 18 assertions**, 0.607s, separate process. |

All probe/unit storage was generated under
`$TMPDIR/magic-context/rust-marker-ride-review-bg_5523e23a/` (expanded here under
`/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`). Bun runs set TMPDIR, HOME,
CFFIXED_USER_HOME, data/config/cache/state/runtime XDG variables and
MAGIC_CONTEXT_STORAGE_DIR there. `OPENCODE_DB=opencode.db` was intentionally
relative so each unit fixture's throwaway XDG root owned its database. Rust tests
used that TMPDIR and tempfile stores. No live-store SELECT was needed.

Retained text-only evidence: `consumer-probe.log`, `consumer-probe.ts`,
`planner-probe.log`, `planner-probe.patch`, `existing-units.log`, `epoch-hard.log`,
`pi-markers.log`. No database was copied. Only throwaway test code was added;
production predicates were unchanged throughout, and final source/lock/architecture
diff is empty. The expected-safe failures are not claimed as guard-mutation proofs.

No OpenCode/daemon/gateway host was launched in this review, so there is no new
lsof-certified host run, OS-kill test, provider-ack test, paused historian race or
large mixed-history benchmark. The design's host measurements remain its own
evidence, not independently rerun results. Typecheck/build/lint are not rerun for
this Markdown-only delivery; the prepared build was reported green, not counted
as an independent implementation gate. Final validation checks the report's cited
paths/ranges, `git diff --check`, and that only this requested report is delivered.
The citation/section validator (Python 3.9.6) checked **93 line ranges across 21
files and all three finding sections**. Scoped AFT inspection has no Markdown LSP
producer and reported partial/unknown diagnostics, not a clean compiler result.
