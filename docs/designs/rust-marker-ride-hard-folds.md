# Rust-mode OpenCode 1 markers: ride the rebuilding pass, not scheduler execute

## Status and decision

Design and isolated prototype evidence only, against **b6ee864f91bb01abe287e647de8d2d5c6f77a07f**.
No production, test, protocol, configuration, or architecture change is delivered.
The temporary adapter/test overlays were restored and the production bundle rebuilt.

**The scheduler restriction is unnecessary for a genuine rebuilding pass.** A
committed, admitted HARD caused by a changed render/system epoch can recreate the
current durable coverage target even when the scheduler says `defer` and the
pending-marker blob is NULL. The host cut should ride that pass. Ordinary SOFT+
must neither create a target nor retry a retained one.

The recommended implementation removes the scheduler discriminator **and uses
the producer's actual shared bust permission**, preserving admission and replay
fencing. The smallest adapter-only prototype removes the scheduler-execute check from
`materializedCompactionBoundary`, retaining its bust, commit and coordinate checks.
It reproduces the reported failure and fixes it on real OpenCode **1.18.30**:
marker **50 → 16,940** on **HARD / epoch_change / scheduler=defer**, then host input
**16,958 → 70**, exact provider replay, and a three-message ordinary delta.

**Important bound on that recommendation:** a Rust `HARD` label is not invariably
a genuine cache bust in this base. There are explicitly byte-preserving marker
HARDs. Section “Shared permission and the byte-preserving HARD exception” explains
why the deletion is sufficient for the demonstrated ALF-shaped epoch rebuild but
is not, by itself, an unconditional “every HARD label may mutate” safety proof.
Do not broaden permission beyond real rebuilding passes when implementing this
design. Carry the producer's actual permission to the adapter if the rollout must
cover the byte-preserving HARD cases too; do not infer it from scheduler metadata.

The brief's live ALF numbers are inputs, not fresh observations here: ordinal
121,728, coverage 138,293, 31–48% of an 872k window, 75% execute threshold, forty
post-reboot defers including two epoch HARDs. The ordinal lag is **16,565**;
“about 17,000 messages” is a host-input measurement, not exactly that subtraction.
No live database, backup, or configuration was opened or copied for this design.
In particular, no `opencode.db` was copied and no live marker was moved.

## 1. Why execute-only exists

Commit **2a47acdc4e42af995c9aee2a69eef10dadadd390** (September 4) introduced
`materializedCompactionBoundary`: `committed:true`, scheduler execute, valid
coverage ordinal, positive row version, and a last-block boundary ID. It passed
those exact response coordinates to Rust postprocess. This addressed a stranded
host cut and expensive large raw inputs without querying a later module status
whose boundary might not describe the response actually being served. The
execute check used the scheduler as an eligibility proxy; it was not a Rust
producer rule that HARD folds return no durable boundary on defer.

At this base the two gates are visibly separate:

- `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:754–787`:
  extraction requires **both** bust permission and scheduler execute.
- Same file `:3854–3867,3903–3906,3933–3961`: the adapter derives
  `moduleDecisionBusts` from HARD/MIGRATE_HARD/EXECUTE/SOFT, not the scheduler;
  then a materialized target **or an existing pending target** enables admission.
- `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:793,859–880,1100–1117`:
  the drain already requires bust permission, checks admission, and fences before
  calling the host strategy. Thus a defer HARD with pending work can already
  attempt a cut, but the same pass with NULL pending cannot reconstruct the target.

The review history explains why removing *all* guards would be wrong:

1. `docs/reports/marker-unfreeze-review.md:85–134,245–279` found an ungated
   frozen-SOFT+ retry and the metadata-only execute escape. `committed` includes
   metadata/tag overlays; scheduler execute can still produce unchanged SOFT+.
   The review also found that integer adjacency rejected legitimate sparse gaps.
2. **192c674e8ebd88bb9ccb1f64268b6af1b5fe50c8** (October 5) added the explicit
   bust check to extraction, removed the frozen replay drain, and required an
   explicit drain permission. It **kept** the older scheduler check.
   `docs/reports/marker-unfreeze-review-r2.md:37–43,310–357` confirms both SOFT+
   escapes were closed and explicitly notes that defer HARD with no pending target
   is still not a catch-up opportunity under that extractor.
3. Round two found the retained assistant-target/user-boundary mistake and
   irreversible cuts preceding adapter rejection (`r2:53–180`). Round three
   confirmed their fixes, then found a recovery flush lacking its JSON method
   (`docs/reports/marker-unfreeze-review-r3.md:29–49,61–146`). The current base has
   the correctly serialized `body: { method:"session.flush", ... }` at
   `rust-mode-transform.ts:3651–3659`; do not reintroduce that mock-only recovery.

### How TS mode decides (`pp.markerReconcile` is a timing label)

There is no file named `pp.markerReconcile`. The intended code is
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:3112–3261`;
line 3261 emits that timing label. No compatibility shim is needed.

TS does **not** require scheduler execute in this block. It computes
`historyWasConsumedThisPass` from an actually delivered injection, a rebuilt
history, an eligible deferred/awaited/explicit consumption opportunity, and
satisfied materialization (`:3113–3127`). A pending target must be covered by the
consumed boundary, and the delivered prefix must be proven trimmed through it
or the source must already reflect a covering marker (`:3133–3184`). It rereads
the committed winner and CAS-clears pending; retryable failures retain the
refresh signal (`:3185–3215`). Reconciliation runs on every pass to replay the
chosen representation; first application is governed by `isCacheBustingPass`
(`:3220–3261`). The shared ride predicate is formed from actual prefix-changing
folds, provider-cold retry, flush, force and published-history work, not execute
alone (`:1984–1994,2056–2099`).

## 2. What ck-mc returns on a non-execute HARD

The normal response path does not conditionalize durable coordinates on execute:

| Field | Producer authority at this base |
| --- | --- |
| `coverage_ordinal` | `meta.coverage_ordinal`, assigned from the composed compartment coverage in the HARD branch (`crates/mc-module/src/transform.rs:5670–5709`), returned at `:6989`. It is the durable summary end, not the host's retained user coordinate. Empty history can yield NULL. |
| `boundary_id` | `core.boundary_id`, updated with the same compose result (`:5670–5683`), returned at `:6983`. Vocabulary is `<message-id>#<last-block-index>`. A HARD validates a live anchor and its ordinal before accepting it (`:5471–5500`). |
| `row_version` | The version returned by `store.commit_transform` when committing, otherwise the loaded version (`:6831–6876`); returned at `:6986`. It is not a separate host-store transaction ID. |
| `committed` | `commit_required`: changed core/meta, discarded cache sections, consumed drops, or pending overlays (`:6810–6821,6988`). This is a durability fact, **not** a bust fact. |
| `decision` / `scheduler_decision` | Independent fields. `action_str` maps the prefix plan to HARD/SOFT/SOFT+ (`:16107–16115`); the scheduler's canonical decision is returned at `:6967–6972`. |

A successful state-changing defer HARD therefore returns committed coordinates
just like an execute HARD. An idempotent/noncommitting response does **not** give
the extractor authority to mint a new target. Old pending work still has its
own validated retry path, but only on a genuine rebuilding opportunity.

The host proof observed `decision=HARD reason=epoch_change scheduler=defer
committed=true row_version=8`, consumed through ordinal 16,940, and created the
marker at that coverage. The module had already reduced its outgoing prompt to
69 messages even in the unmodified baseline; only the host cut stayed at 50.
This separates the expensive **incoming** history from the module's already
compacted outgoing history.

The exact response tuple is passed forward, not replaced with a status read:
`transform-postprocess-phase.ts:810–873` persists the target monotonically and
only treats it as trusted when pending ordinal and end ID match that response.
`compaction-marker-manager.ts:323–331` uses that row-version/coordinate fence to
skip the redundant local target lookup, **not** the user-boundary and partial-end
checks. A positive row version is not an independently revalidated distributed
snapshot or protection against arbitrary manually corrupted compartments.

## 3. Safety on the actual defer rebuilding pass

### Fit and coherent capture inputs

At `rust-mode-transform.ts:3927–3961`, native-boundary validation precedes the
marker candidate. The candidate is primary-only, compaction-on, and requires a
new durable boundary or pending work. Its inputs must have unique string IDs,
a nonempty array and a corresponding raw-content snapshot for every ID. The
output must measure **under** the context limit. Unknown/untrusted fit does not
become permission just because the scheduler deferred or the response says HARD.
If proof fails, pending is retained and fresh output can be served without a cut.

After postprocess, validation and the final output-fit check run again
(`:4162–4175`), because host canonicalization may add summary/reminder bytes.
A failure after a possible cut cannot return old bytes. None of these predicates
uses scheduler execute. The prototype only changes whether the durable response
can supply a candidate; it does not bypass admission.

### Write-ahead LKG fence, not imaginary cross-database atomicity

The before-apply callback at `:4111–4129` durably fences old replay **before**
the host strategy. `fenceMarkerAdmission` (`:2085–2108`) cancels queued captures,
forces full wire and stores the fence under context.db `BEGIN IMMEDIATE`.
Initially it quarantines the old slot; a proven no-cut outcome may preserve it.
If the cut changed or might have changed, durable and in-memory old slots are
invalidated. The loader refuses to hydrate any fenced slot
(`lkg-persist.ts:300–310`).

Host replacement has its own transaction (`compaction-marker-manager.ts:381–411`,
`features/magic-context/compaction-marker.ts:694–731`). There is **no** atomic
transaction across context.db and opencode.db. The write-ahead fence handles the
uncertain window. Final fit, installation, synchronous priced capture and
bookkeeping must finish before strict fence clear (`rust-mode-transform.ts:4162–4264,4450–4459`).
Possible-cut failures refuse; they do not replay old LKG, park or send raw.
Recovery flushes the real module and requires a rebuilding response
(`:3651–3659,3868–3871,4500–4520`). Changing eligibility must preserve this ordering.

The temporary scheduler-defer HARD fault tests exercised after-marker, capture
and late-bookkeeping failure with real SQLite/LKG state, then a new adapter/file
connection: each retained the fence, refused old replay, and cleared only after
a successful rebuild. These are injected exception/restart tests, not OS-kill
or provider fault tests.

### Sparse gaps and the retained partial end

The producer starts the next historian chunk at the next **present** nonsynthetic
ordinal, not necessarily `end+1` (`historian_chunk.rs:1013–1039`). Publication
validates starts/ends against present coordinates and advances using
`next_present_after` (`historian_validate.rs:1083–1113`). But during a HARD compose,
every present live nonsystem item at/below coverage must belong to a compartment;
otherwise the module refuses rather than trim unsummarized bytes
(`transform.rs:5452–5469`).

The consumer still enumerates indexed ends whose `sequence+1` successor does not
prove continuation at a greater same-message block or the next ordinal
(`compartment-storage.ts:912–945`). `boundaryWouldDiscardUncoveredMessage`
(`compaction-marker-manager.ts:238–285`) excludes only endpoints canonically
**strictly before the actual old retained user**, not at/below its summary target.
Equal/unknown ordering stays protected. A sparse interval is released only with
both anchors present and a raw canonical interval containing no historian-present
message. The certificate requires actual boolean `synthetic:true` or
`syntheticTodoMarker:true` on every noncompaction part and at least one such part
(`compaction-marker.ts:392–438`). Empty messages, mixed real/synthetic parts,
unknown flags and missing anchors are not grandfathered by text or missing FTS.

For the newest indexed end, OpenCode retains the nearest real user **at or before**
the target (`compaction-marker.ts:316–374`); it does not cut after the last indexed
block. Thus that user, partial assistant and the rest of the turn remain raw.
The partial-end guard remains active even with an exact Rust response fence
(`compaction-marker-manager.ts:358–378`). Last-block anchors of fully summarized
Rust messages explain why an index is not automatically evidence of a partial,
but are not a general coverage theorem for corrupt/manual block intervals.

### Historian veto and the shared bust permission

Moving the marker replaces compaction metadata/a synthetic summary, not ordinary
raw messages. The historian reads a raw snapshot and proceeds after published
coverage; retaining the boundary user also retains a superset of that suffix.
A later historian publication cannot change the exact target used by this pass;
newer pending work wins through the ordinal/CAS checks. This is source-based
concurrency reasoning, not an in-flight race certification by the host fixture
(its deterministic producer was deliberately disabled).

The protected architecture describes the HARD-fold bypass of the historian veto
and the disjoint read/write stores (`ARCHITECTURE.md:68–89`). The current Rust
implementation is stronger about a single permission: historian activity is
**not a second mutation gate** (`transform.rs:4611–4614`). Independently priced
rebuilds, force and emergency form `pass_already_busting`
(`:4690–4708`); automatic reductions still need that ride permission
(`:4739–4750`). Adding a new historian-active check to marker extraction would
recreate a split bust. Do not add one. On a nonbusting SOFT+ all lanes must hold;
on a genuine HARD they ride its permission irrespective of scheduler pressure.

### Shared permission and the byte-preserving HARD exception

This base contains a nuance absent from a simple “HARD always busts” reading:
`transform.rs:4632–4679` can run a marker HARD whose compose reproduces the
provider's cached prefix. `:5171–5186` treats it as nonmutating for all bust-only
lanes, although `action_str` still returns **HARD**. Existing tests
`identical_bytes_epoch_hard_holds_pending_drop_and_serves_identical_bytes`
(`:21345–21390`) and `content_changing_epoch_hard_still_drains_pending_drop`
(`:21443–21477`) distinguish these cases. The five-test `epoch_hard` Rust selection
passed here, including the synthetic-todo no-op control.

The adapter currently equates the label with permission (`rust-mode-transform.ts:3854–3867`),
whereas the internal producer has `is_provider_prefix_mutation_pass` and
`reclaim_ride_available`; the latter is carried internally at
`transform.rs:6934–6940`, not among the public response fields. This is an
**inherited permission gap**, not solved by deleting the scheduler check.

For ALF's demonstrated **render/system epoch** HARD, identity invalidation and
coverage movement already price a real rebuild
(`transform.rs:4623–4631,8660–8675`), so the prototype is sound for that shape.
For an unconditional all-cache-rebuild implementation, the smallest *fully shared*
permission design is to expose the producer's actual prefix-bust boolean in
`TransformResponse` and use it for extraction, candidate admission and every host
first-application lane, instead of independently granting permission on the HARD
label. Require an actual boolean and reject/hold unsupported responses; do not
invent an execute/decision-based compatibility shim. Retained SOFT+ pending work
must not force a flush. Add a real-producer byte-preserving HARD with a lagging
host marker as a pre-ship control. This additional protocol/host-lane work is a
design requirement if promising universal permission parity, **not** an untested
product fix hidden in this document or certified by the epoch host probe.

### Following SOFT+ bytes and transport

The current rebuilding request is transformed before the host marker replacement
affects the next input. On the following pass, OpenCode omits older raw messages
that the module was already representing by m0/m1. A shrinking input cannot use
the old suffix cache: delta eligibility requires
`messages.length >= previousWireCache.rawCount`
(`rust-mode-transform.ts:3113–3119`). It sends the smaller array whole, records
the new raw count (`:3388,3426`), then resumes append-only deltas.

Frozen replay skips postprocess (`:4032–4110`), and normal marker retries require
`args.cacheBustingPass` (`transform-postprocess-phase.ts:1100–1117`). Therefore
following SOFT+ does not move the boundary or create retry churn. Wire stability
means the frozen prefix stays identical while real new tail messages may append;
entire-request byte equality is meaningful only with the same raw tail.
The real probe compared literal intercepted `system` and `messages` after
reverting/re-sending the same user probe, and separately checked frozen history
blocks on an ordinary append. It did not compare a hash with itself.

## 4. Minimum adapter prototype and implementation tests

For the demonstrated genuine rebuilding decision, the evaluated source change was:

```diff
 function materializedCompactionBoundary(response, cacheBustingPass) {
     if (!cacheBustingPass) return undefined;
     if (response.committed !== true) return undefined;
-    if (
-        typeof response.scheduler_decision !== "string" ||
-        response.scheduler_decision.toLowerCase() !== "execute"
-    ) {
-        return undefined;
-    }
     // Existing safe integer, positive row version and boundary-ID checks remain.
```

No change is needed to the existing marker candidate, fit proof, CAS, raw-gap
certificate, user rollback or write-ahead fence. No marker-specific timer, forced
execute, eager historian publication drain or status read should be added.
The extractor is also used by `armNoteNudgeOnRustPublish`
(`rust-mode-transform.ts:808–824,4317–4327`): caught-up coverage may arm its overdue
historian-complete nudge once, seeded from the old persisted ordinal. Preserve
its monotonic/cooldown controls; do not accidentally re-arm on repeated folds.
The four-suite prototype run includes the existing nudge test.

When implementing, deliberately rename the existing helper test
`accepts materialized boundaries only from a committed execute with served bust permission`
(`rust-mode-transform.test.ts:1963–2003`): its execute-only claim is the policy
being changed. **Keep both of its SOFT+ rejection assertions**; do not rename them
into acceptance. The temporary additional tests were:

- `design probe: HARD accepts committed coordinates despite scheduler defer`
- The same SOFT, MIGRATE_HARD and EXECUTE cases, with explicit bust permission.
- `design probe: deferred bust extraction preserves every durable coordinate guard`:
  false bust; false/missing committed; zero/fractional/unsafe row version;
  negative/fractional/infinite ordinal; missing separator, empty message ID,
  negative/non-numeric block suffix. All remain rejected.
- `design probe: scheduler-defer HARD {after-marker,capture,bookkeeping} failure stays fenced across restart`:
  parameterize the existing `markerFaultFixture` scheduler, leaving original
  execute, frozen-SOFT+, metadata-execute, fit and lock controls in place.

The first literal helper assertion is reproducible without computing an expected
value from the implementation:

```ts
expect(__rustModeTransformTest.materializedCompactionBoundary({
    decision: "HARD", scheduler_decision: "defer", committed: true,
    row_version: 12, coverage_ordinal: 9590, boundary_id: "msg_boundary#3",
}, true)).toEqual({ rowVersion: 12, ordinal: 9590, endMessageId: "msg_boundary" });
```

It failed against unchanged production with `Received: undefined`, then passed
with the prototype. No safety guard was neutralized and no mutation-proof claim
is made; these are safe expected-outcome baseline regressions.

## 5. Real OpenCode 1.18.30 reproduction

Temporary test name:
`design probe: deferred epoch HARD catches up a sparse marker and replays exact provider bytes`.
It used the real host, the worktree-built module, a real hermetic daemon, SQLite
stores and an intercepted deterministic Anthropic-compatible local provider.
It made no external model calls.

Recipe, all generated in the throwaway root:

1. Start TS mode; observed usage **350,000 / 872,000 = 40.14%**, with execute at
   **654,000 = 75%**, five-minute TTL, compressor off. Generate 17,000 64-byte
   user text rows using `RustTestHarness.appendSyntheticHistory`; no raw-store copy.
2. Set nine boolean-flagged synthetic notices at ordinals
   `16,29,43,63,75,85,86,109,110`. These form seven gaps of sizes `1,1,1,1,1,2,2`.
   Seed initial coverage ranges `[1,15],[17,28],[30,42],[44,50]`, block anchors 0,
   with an actual native marker at **50** and NULL pending. State-sync the live
   anchor `raw[49].id + "#0"`; restart in Rust and warm below execute threshold.
3. Append fixture compartment ranges `[51,62],[64,74],[76,84],[87,108],[111,16940]`.
   Three gaps are behind the old cut; four are ahead. Disable the historian
   producer so publication cannot change the measured history during comparison.
4. Add fixture-local `AGENTS.md` instructions and restart the host on the same
   stores. This changes the system/render epoch, not pressure or a marker timer.
5. Send one turn: require HARD, **epoch_change**, scheduler defer, committed true,
   applied transform, and marker 16,940.
6. Send the same literal user probe twice with the same message ID, reverting
   its first occurrence through the host API. Require both passes to be applied
   SOFT+ defers, marker unchanged, and literal provider `system/messages` JSON
   identical. Require the first smaller input to be a full send; an ordinary
   subsequent append must send ≤4 messages and retain identical history blocks.
   Exclude LKG/refusal/failure diagnostic lines for the measured session.

### Observed results

| Check | Unchanged production | Temporary prototype |
| --- | --- | --- |
| Epoch pass | HARD / epoch_change / defer / committed=true / row 8 / applied transform | Same |
| Incoming / outgoing messages on HARD | 16,958 / 69 | 16,958 / 69 |
| Marker after HARD | **50**: sole expected-safe assertion fails | **16,940** |
| First following host input / full transport | Not reached after marker assertion | **70 / 70** |
| Two same-tail SOFT+ provider payloads | Not reached | Exact equality, SHA-256 **936679727d30b34b4348a317b82ede0a02515d238d34a4302d16dbf02e1ca977** |
| Ordinary append | Not reached | SOFT+, **3** transported messages, frozen history blocks unchanged |
| Test result | 0 pass / 1 expected-safe failure / 28 assertions / 40.19s | **1 pass / 0 fail / 51 assertions / 97.76s** |

This matches ALF's low-pressure + NULL pending + seven sparse gaps + large input
lag + genuine epoch HARD shape, **not** its exact 138k ordinal scale or mixed
assistant/tool history. The helper generates user text messages; partial/tool-turn
safety is covered by the manager/adapter unit suites, not claimed from this host
fixture. Nor does this prove actual ALF raw-gap flags are safe, an in-flight
historian race, an OS crash, V2/Pi host behavior, or a byte-preserving marker HARD.

### Isolation and retained evidence

Root:
`$TMPDIR/magic-context/rust-marker-ride-hard-folds-bg_5c99cd48/`
(expanded on this machine under `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/`).
Host commands set `TMPDIR`, **HOME**, **CFFIXED_USER_HOME**, all five `XDG_*` path
variables used here (data/config/cache/state/runtime),
`MAGIC_CONTEXT_STORAGE_DIR`, and `OPENCODE_DB` beneath that root.
`OPENCODE_DB=opencode.db` at test-runner level is deliberately relative: the host
runner sets its absolute fixture path, and the one fixture marker injection
temporarily sets that same absolute path. The host itself overrides HOME/XDG/
storage to its `tmp/opencode-e2e-*` fixture; CFFIXED_USER_HOME remains under the
outer throwaway root. `CARGO_HOME`/`RUSTUP_HOME` identify installed compiler tools,
not host stores. Absolute prebuilt binary/plugin paths select this worktree.

At startup, each restart and after replay, the probe ran
`timeout 20s lsof -p <host,daemon,module> -Fn` and asserted **every** `.db`, WAL and
SHM path lay under that fixture's data directory, with opencode.db and store.db
present. Successful sample PIDs **8917,7109,7123**, fixture **opencode-e2e-mq56Ob**:
only `data/opencode/opencode.db` and
`data/cortexkit/magic-context/{context,store}.db` plus their WAL/SHM files.
The logs include complete path inventories. Fixture databases were disposed by
the harness; only text evidence/probe sources were retained, not copied databases.

Retained under the outer throwaway root:
`host-baseline.log`, `host-prototype.log`, `host-diagnostics.log`,
`unit-baseline.log`, `prototype-units.log`, `prototype-admission.log`,
`prototype-typecheck.log`, `prototype-build.log`, `restored-build.log`,
`rust-epoch-tests.log`, `restored-adapter.log`, `restored-typecheck.log`,
`host-probe.ts`, `adapter-probe-tests.ts`, `prototype.patch`.
The exact host probe's SHA-256 is
`8640a6e79f26086b8546961e9a8a3d05d5b931b2d3262fc5e8cbd73b1d14da86`.
The retained adapter probe source is
`04fca8593ae017b81fe4fb9e632bd00972ca4430c4fdc6d5b33e100684d31c15`;
patch `b43a246120f1c6214de63e05f2b6ce39799fc545899e34f08e0d2b06dc23647e`.
These temporary artifacts are not required at runtime and are not committed.

## Verification and implementation acceptance

Versions: Bun **1.4.2 (744846f84)**; TypeScript **5.9.3**;
cargo **1.99.0 (5f94df478 2026-08-27)**; OpenCode **1.18.30**;
hermetic prebuilt daemon **ck-subc 0.20.58**. The module was rebuilt from this
worktree; the daemon was the already-hydrated `target/pipe-only-subc/debug/ck-subc`,
not a freshly rebuilt daemon certification. Prepared frozen Bun install was used;
no manifest/lock/install change.

| Command (outer timeout, foreground) | Result |
| --- | --- |
| `timeout 900s cargo build --release -p mc-module -j 2 --locked --offline` | Passed, one package build target, 2m45s; no tests, no lock change. |
| `timeout 900s cargo test -p mc-module --lib --locked --offline -j 2 epoch_hard` | **5 pass / 0 fail**, 1,622 filtered, 2.37s after compilation. |
| From `packages/plugin`: `timeout 180s bun test src/hooks/magic-context/rust-mode-transform.test.ts -t 'design probe: HARD accepts' --timeout 30000` | Baseline: sole literal regression fails, expected object / received undefined. |
| From `packages/plugin`: `timeout 240s bun test src/features/magic-context/compartment-storage-v6.test.ts src/hooks/magic-context/compaction-marker-manager.test.ts src/hooks/magic-context/rust-mode-transform.test.ts src/hooks/magic-context/transform-postprocess-phase.test.ts --timeout 30000` | Prototype: **443 pass / 0 fail / 4,552 assertions**, 35.71s, four files. Includes the five initial new helper cases plus existing safety controls. |
| From `packages/plugin`: `timeout 180s bun test src/hooks/magic-context/rust-mode-transform.test.ts -t 'design probe:\|post-cut\|failed durable' --timeout 30000` | Final probe set: **16 pass / 0 fail / 120 assertions**, 3.29s; includes three additional defer HARD restart/fence cases and original controls. |
| `timeout 120s bun run --cwd packages/plugin typecheck` | Passed all three repository tsc invocations after final temporary adapter-test edits; silent on success. |
| `timeout 180s bun run --cwd packages/plugin build` | Prototype and restored production builds passed; each **4 V2 loader tests / 19 assertions**, plus bundle/declaration builds. |
| From `packages/e2e-tests`: `timeout 400s bun test tests/rust-marker-ride-design-probe.test.ts --timeout 300000` with isolated variables and explicit binary/bundle paths | Baseline red and prototype green as recorded above; lsof assertions passed. |
| From `packages/plugin`, after restoration: `timeout 180s bun test src/hooks/magic-context/rust-mode-transform.test.ts -t 'accepts materialized boundaries\|retains pending indexed\|r2 proof:\|post-cut\|failed durable' --timeout 30000` | **11 pass / 0 fail / 96 assertions**, 1.45s, including the original execute-only claim. |
| After restoration: `timeout 120s bun run --cwd packages/plugin typecheck`; `git diff --exit-code HEAD -- packages/plugin/src/hooks/magic-context/rust-mode-transform.ts packages/plugin/src/hooks/magic-context/rust-mode-transform.test.ts ARCHITECTURE.md STRUCTURE.md Cargo.lock` | All three tsc invocations passed; source/architecture/lock diff empty. |

An initial host attempt failed before setup because isolated HOME hid rustup's
toolchain; setting explicit toolchain locations corrected it. A second setup
attempt changed only `protected_tokens`, which correctly did **not** change the
render identity and returned SOFT+. It was replaced by actual fixture-local host
instructions; neither setup failure is counted as the expected marker regression.
AFT's temporary-source inspection had no TypeScript errors, but was partial
because its Biome producer was unavailable; repository tsc/build/tests provided
the actual verification. Full workspace/native/V2/Pi gates are intentionally not
claimed for a design-only delivery.

Before shipping an implementation:

1. Land the extraction/adapter/real-host regressions with the deliberately changed
   eligibility contract, keeping the original negative/fault/partial-gap controls.
2. Resolve the byte-preserving HARD permission issue using the producer's real
   permission if making an unrestricted all-HARD promise. Test a lagging marker on
   a no-op epoch HARD, plus a genuine defer SOFT/flush and metadata-only execute.
3. Require the same fit/fence/CAS/sparse/partial-end protections on every newly
   eligible path; do not advance markers in live stores as an experiment.
4. Run typecheck, unit and bundled real-host gates on that implementation, including
   explicit wire-method recovery and unchanged ordinary provider bytes.

`d086b43a3` does not resolve in this repository at the supplied base. No change to
tool routing was needed for this design, and no foreign repository/ref or shim
was inferred. `ARCHITECTURE.md` and `STRUCTURE.md` remain unchanged.
