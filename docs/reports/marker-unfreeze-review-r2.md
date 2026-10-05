# Compaction-marker unfreeze: revision-round adversarial review

## Scope and verdict

Reviewed **7b4167adac2cbf09e3c9cf98d6606ad70b881455**, including revisions
**192c674e8ebd88bb9ccb1f64268b6af1b5fe50c8** and **7b4167ad**, against the
checklist in `docs/reports/marker-unfreeze-review.md`. Production line references
below are to that candidate. The comparison baseline is actual review-worktree
master **1da8d5beb435fb55e623ea0053cef08b494a44e3**, not just the first candidate.
Read the protected section of `ARCHITECTURE.md:48–108` before reviewing.

**Not ready for an unconditional safety/recovery sign-off.** The motivating
synthetic-gap recovery and both originally demonstrated SOFT+ permission escapes
now work as claimed. The real OpenCode 1 suite passes independently. However:

1. The new lower bound confuses the previous *summary target ordinal* with the
   actual *retained user boundary*, allowing an uncovered retained turn to be cut.
2. A response labelled HARD can move a marker **before** adapter validation rejects
   the response and serves unchanged LKG. Explicit decision permission is necessary
   but is not yet permission from the representation actually served.
3. OpenCode 2's visible-end fix closes the original reproduction but still trims
   visible unsummarized gap content when its earlier endpoint is absent.

All three have executed, expected-safe **failing throwaway tests** below. These
are consumer/fault-path proofs, not claims that a healthy Rust historian publishes
bad ranges. That distinction does not make it safe to trim legacy, stale, or
host-cut history before validating its coverage.

This delivery changes only this report. Candidate source overlays, throwaway
tests, and extra lsof logging were restored. No live database or configuration
was opened, read, written, copied, or migrated. The first review's live read-only
queries were **not** repeated; only the expressly permitted backup copies were
opened with SQLite `-readonly` and `mode=ro`.

## First-review checklist

| First-review item | Revision result and independently checked evidence |
| --- | --- |
| Older ordinal gaps permanently veto ALF | The seven exact coordinates are now fixture data (`compaction-marker-manager.test.ts:265–375`). The candidate query enumerates uncovered ends after a lower bound (`compartment-storage.ts:907–940`), and OpenCode 1 certifies sparse raw intervals (`compaction-marker.ts:336–373`). The manager fixture passes; the real-host seven-gap fixture advances 50 → 140 on HARD. Real content in a later gap still causes producer refusal with no provider request. **Original all-gaps veto closed; new lower-bound hole is blocker 1.** |
| Frozen SOFT+ drains pending marker | The old exceptional call is removed. `rust-mode-transform.ts:3859–3967` bypasses postprocess during frozen replay; the actual `createRustModeTransform` regression at `rust-mode-transform.test.ts:337–403` passes, including a later eligible HARD drain. **Original reproduction closed.** |
| Metadata-only scheduler-execute substitutes for bust | Boundary extraction now requires the module bust permission (`rust-mode-transform.ts:736–768`); the drain requires an explicit boolean (`transform-postprocess-phase.ts:759–775,1078–1090`). Independent real producer: **SOFT+ / scheduler=execute / committed=true**, unchanged history blocks, pending blob retained. **Original escape closed; post-validation failure remains blocker 2.** |
| OpenCode 2 absent earliest endpoint hides later visible endpoint | Enumeration and array-order selection now find the earliest visible endpoint, and rollback finds its user (`v2/fold/boundary.ts:166–183`). The revised tool-turn test at `v2/fold/boundary.test.ts:212–251` passes. **Exact first-review reproduction closed; visible gap without its endpoint remains blocker 3.** |
| Retry text promises next ordinary pass | Runtime text and bookkeeping comment now say **next cache-busting pass** (`transform-postprocess-phase.ts:734,829`). The diagnostic regression passes. **Closed.** |
| Pi uncovered-end parity | `packages/pi-plugin/src/compaction-marker-manager-pi.ts:60–68` checks the shared uncovered-end query even for a precomputed kept entry. Independent Pi process: 11/11 pass. Pi deliberately does **not** inherit OpenCode's raw-gap certificate or current-marker exclusion. **Closed within the Pi producer/entry contract.** |

Paths without a package prefix in this table are below
`packages/plugin/src/hooks/magic-context/`, except `compartment-storage.ts` and
`compaction-marker.ts`, which are below `packages/plugin/src/features/magic-context/`,
and the explicitly named `v2/` paths.

## Findings

### Blocker 1 — the previous target ordinal is not the host's already-discarded prefix

**Evidence:**
`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts:227–228,326–340,368–375`;
`packages/plugin/src/features/magic-context/compaction-marker.ts:263–311`;
`packages/plugin/src/features/magic-context/compartment-storage.ts:923`.

`boundaryOrdinal` stores `pending.ordinal`, but OpenCode retains the nearest user
**at or before** that target. If the target is assistant 8 and its user is 7, the
host still supplies user 7, assistant 8, and the following raw messages. The new
`end_message > current.boundaryOrdinal` predicate removes assistant 8 from the
safety check anyway. On the next advance, its uncovered remainder/gap is never
examined, even though it was never cut by the old marker.

The shipped lower-bound regression uses a user target at the same coordinate as
the physical cut (`compaction-marker-manager.test.ts:216–263`). That is an important
case, but does not defend the assistant-target/user-rollback case. Nor does ALF's
safe fixture establish that equivalence for every session.

**Executed reproduction:** insert this test in the existing outcomes describe in
`compaction-marker-manager.test.ts`, using that file's ordinary fixture helpers:

```ts
it("r2 proof: a retained partial at the prior target ordinal still vetoes the next cut", () => {
    const home = useTempDataHome("r2-retained-partial-");
    const sid = "ses-r2-retained";
    const oc = createOpenCodeDb(home);
    insertUserMessage(oc, "turn-user", sid, 7);
    insertMessage(oc, "partial", sid, 8, "assistant");
    oc.prepare("INSERT INTO part VALUES ('partial-p','partial',?,8,8,?)")
        .run(sid, JSON.stringify({type:"text", text:"covered then UNCOVERED_SUFFIX"}));
    insertMessage(oc, "real-gap", sid, 9, "assistant");
    insertUserMessage(oc, "next-start", sid, 10);
    insertUserMessage(oc, "target", sid, 20);
    const db = openDatabase();
    appendCompartments(db, sid, [{sequence:0, startMessage:1, endMessage:8,
        startMessageId:"older", endMessageId:"partial", endBlockIndex:0,
        title:"partial", content:"covered"}]);
    db.prepare("INSERT INTO session_meta(session_id) VALUES (?)").run(sid);
    expect(applyDeferredCompactionMarker(db, sid,
        makePending({ordinal:8, endMessageId:"partial"}), home))
        .toEqual({kind:"applied", markerOrdinal:8});
    expect(getPersistedCompactionMarkerState(db, sid)?.boundaryMessageId)
        .toBe("turn-user");
    appendCompartments(db, sid, [{sequence:1, startMessage:10, endMessage:20,
        startMessageId:"next-start", endMessageId:"target", endBlockIndex:0,
        title:"later", content:"later"}]);
    oc.close();
    expect(applyDeferredCompactionMarker(db, sid,
        makePending({ordinal:20, endMessageId:"target"}), home))
        .toEqual({kind:"stale-skip", reason:"partial-message-boundary"});
});
```

Result: **expected stale-skip / partial-message-boundary; received applied /
markerOrdinal 20**. The initial move to 8 is performed by the real manager, not
an invented inconsistent persisted record. The replacement physically cuts at
user `target`, past retained `partial` and the real gap.

The Rust module's live coverage guard would reject the real ordinal 9 if it
received it on a fresh compose (`crates/mc-module/src/transform.rs:5435–5451`). This
test does not claim that producer emitted such coverage. It proves the newly
relaxed host manager is **not itself** conservative for retained old targets;
both deferred and direct publication use this predicate. The module guard also
checks ordinal coverage, not individual remainder blocks (`transform.rs:9017–9031`).
It is not a substitute for the indexed-end consumer guard.

**Required:** exclude only endpoints proven canonically before the *actual old
boundary message*, not every endpoint at/below the old target ordinal. Keep
unknown ordering protected. Add the assistant-target/user-rollback regression
without deleting the already-cut-user control.

### Blocker 2 — a rejected HARD result still advances the marker before serving LKG

**Evidence:**
`packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3920–3970,4009–4087,4341–4365`;
`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1078–1090`.

The adapter runs marker-changing postprocess at 3930 **before**
`assertNativeBoundary` at 3970. It can also still fail during priced LKG capture.
The catch then replays the old LKG representation. Host-store marker writes are
already committed and are not rolled back. Calling the boolean “served” bust
permission does not make the response a served representation at this point.

This violates `ARCHITECTURE.md:80–83`: the current provider request need not
rebuild the cached prefix, but the next host input is already cut differently.
It is the failure-path version of the frozen retry defect, not a metadata-only
execute. A protocol failure is exactly where LKG is supposed to preserve bytes.

**Executed throwaway test:** inserted into `rust-mode-transform.test.ts`'s
`Rust mode authority adapter` describe, using its existing helpers. Named:

`r2 proof: a rejected HARD output cannot move the host marker before LKG replay`.

Construction (all real SQLite/LKG state, mocked module only):

1. `installRawProvider(sid)` and `installAvailabilityDb(sid)`; create its normal
   `part` table and raw user `m1` at time 1.
2. `makeDb()`; append one compartment spanning `m1`, ordinal 1, **both** block
   anchors 0; set `deps.tagger = createTagger()`.
3. First transform response is `{decision:"HARD", scheduler_decision:"execute",
   row_version:1, native_messages:makeMessages(sid)}`. No boundary fields: this
   existing accepted response shape captures a valid LKG.
4. Second response has the same native messages, decision and scheduler, plus
   `{committed:true, coverage_ordinal:1, row_version:2, boundary_id:"m1#0"}`.
   Its missing synthetic history head is deliberately invalid and must fail
   `assertNativeBoundary`.
5. Run through `createRustModeTransform.run`, not just postprocess. Assert:

```ts
const first = await serve(); // fresh makeMessages input/output + makeMeta each call
expect(await serve()).toBe(first);
expect(transform.getState(sid).lkgRepresentationFrozen).toBe(true);
expect(getPersistedCompactionMarkerState(db, sid)).toBeNull();
```

The first two assertions pass. The last **fails**, receiving a real persisted
marker with `boundaryOrdinal:1`, `boundaryMessageId:"m1"`, and native marker/
summary part IDs. Thus it is not a failure before reaching marker application.
Isolated rerun: **one test, one failure, three assertions**. An initial attempt
omitted the start block anchor and correctly stopped in shared-boundary validation;
that setup error was corrected before the result above.

**Required:** complete all output/admission validation before irreversible marker
application, and ensure later adapter failure cannot replay old bytes after moving
the cut. Moving only the `assertNativeBoundary` call is insufficient if another
fallible priced step remains after the marker commit. Keep this fault-path
regression alongside the passing frozen-SOFT+/metadata-execute regressions.

### Blocker 3 — OpenCode 2 still drops a visible real gap when its endpoint is absent

**Evidence:** `packages/plugin/src/v2/fold/boundary.ts:166–183`;
`packages/plugin/src/v2/hooks/context.ts:1634–1643`;
`packages/plugin/src/hooks/magic-context/history-boundary-repair.ts:172–182`.

The guard enumerates uncovered **end IDs**, not visible uncovered raw messages.
When an earlier partial endpoint is absent but a real message in its successor
gap is present, the first visible candidate can be the latest end **after** the
recorded user boundary. `Math.min(start, partialIndex)` then keeps the old cut and
discards the real gap. The subsequent module never sees that discarded message,
so its present-coordinate coverage check cannot refuse it. Missing-boundary
repair checks the latest end, which is still present in this shape.

This is a surviving, pre-existing coverage hole, rather than a new ordering bug
in enumeration. The revision's exact absent-earliest/later-visible-*endpoint*
test is now correct; “earliest visible endpoint” is still not equivalent to
“earliest visible uncovered content.” Host-cut arrays may already lack old
endpoints, without proving that every later raw message is summarized.

**Executed reproduction:** insert in the indexed-end describe of `boundary.test.ts`:

```ts
it("r2 proof: an absent partial endpoint cannot hide visible real content in its successor gap", () => {
    const db = useTempDataHome();
    const sid = "ses-r2-visible-gap";
    getOrCreateSessionMeta(db, sid);
    db.exec(`INSERT INTO compartments(session_id,sequence,start_message,end_message,
        start_message_id,end_message_id,end_block_index,title,content,created_at) VALUES
        ('${sid}',0,1,2,'old-user','absent-partial',0,'t','c',1),
        ('${sid}',1,4,9,'next-start','tail',0,'t','c',1)`);
    setPersistedCompactionMarkerState(db, sid, {boundaryOrdinal:9,
        boundaryMessageId:"boundary-user", targetEndMessageId:"tail",
        summaryMessageId:"", summaryPartId:"", compactionPartId:""});
    const messages = [
        {id:"real-gap", role:"user", ordinal:3,
            parts:[{type:"text", text:"UNSUMMARIZED_REAL_GAP"}]},
        {id:"boundary-user", role:"user", ordinal:8, parts:[]},
        {id:"tail", role:"assistant", ordinal:9, parts:[]},
    ];
    expect(trimToRecordedBoundary(db, sid, messages)).toBe(0);
    expect(JSON.stringify(messages)).toContain("UNSUMMARIZED_REAL_GAP");
});
```

Result: **expected 0 removed; received 1**. The actual retained array is
`[boundary-user, tail]`; `UNSUMMARIZED_REAL_GAP` is gone. A separate direct flag
classification control in the same run passes; only this reproduction fails.
This is a pre-module trim proof, not an independently captured V2 provider request.

**Required:** prove coverage of the visible prefix before trimming it, including
visible messages in sparse intervals whose old endpoint is missing. Do not
speculatively cut unknown legacy/reverted coverage. Preserve the user/tool-turn
rollback already added for visible partial endpoints.

### Should-fix — make the native-lane baseline disposition explicit, not “CI green”

The local failures are reproducible on **rebuilt master** and are not evidence
that this marker patch caused them. They are not all just one worker's poisoned
worktree either. Candidate and master share the relevant lane sources; a clean
master plugin rebuild in this worktree gives the same seven failures on the same
nine-test selection, **233 assertions** on each tree:

| Lane / evidence | Independent disposition |
| --- | --- |
| `dream-loop.test.ts:36–46`, `hidden-step-limit.test.ts:25`, `hidden-child-two-directories.test.ts:24`, `hidden-child-terminal-failure.test.ts:72` | Four scratch-plugin activation failures on **both** trees, explicitly naming `ReferenceError: __promiseAll is not defined`. These are Bun-built auxiliary plugin load failures before the marker behavior under test. |
| `output-cap.test.ts:28–32` | The fifth auxiliary case also fails on master with the same undefined helper. It even uses `includeMagicContext:false`; no candidate marker bundle is needed to produce this failure. |
| `fold-s3-owner.test.ts:137–143` (local and provider) | Both trees leave `cached_m0_materialized_at` at the fixture's `idleTime - 1`; the TTL assertion fails at 143. Earlier fold/restore/SOFT/identity assertions run successfully. This is a local baseline clock/host/fixture problem, not a newly demonstrated marker regression. The exact underlying TTL cause was not independently repaired or fully diagnosed. |
| `context-s2-lanes.test.ts:330–368` poisoned draft | Both trees fail the provider request count: expected 1, received 0. The preceding frame assertions pass. Again a local baseline host/test contract, not a candidate-specific result. |
| `overflow-reading-retention.test.ts:149–156` | Passes on both trees; the reported stale-log failure did **not** reproduce. Important limitation: line 156 awaits a log helper whose timeout returns the content, but never asserts that the text exists (`opencode2-runner/spawn.ts:133–143`). A pass does not certify the stale-log claim. Add an actual assertion in a separate lane fix. |
| `hidden-child-native-remove.test.ts` | Passes on both trees; useful control that not every auxiliary activation is broken. |

Existing scratch-probe workarounds are already present on both trees at
`fold-s3-owner.test.ts:19–22` and `mapper-step-finalize.test.ts:20–22`. No new helper
shim or assertion weakening was made for this review.

**Decision:** do not require unrelated production compatibility changes on the
marker branch to turn these lanes green. Preserve the failing local evidence and
open a separate macOS/Bun/native-lane remediation. Green master CI does not erase
reproducible local baseline failures. The marker release must nevertheless fix
the three independently reproduced safety findings above; the baseline allowance
does not excuse those.

## Coverage, cache, and operational conclusions

### Note — pre-flag, empty, mixed, and unknown rows fail closed

`compaction-marker.ts:336–373` matches the ingress boolean policy in
`module-wire.ts:912–927`: every non-compaction part must carry actual JSON boolean
`synthetic:true` or `syntheticTodoMarker:true`, and at least one such part must
exist. The Rust historian filters `ck.meta.synthetic` at
`crates/mc-module/src/historian_chunk.rs:1015–1033`.

An independent throwaway truth-table test made eight raw interval fixtures:
pre-flag text, zero parts, compaction-only, numeric `1`, string `"true"`, mixed
synthetic/real parts, all-synthetic, and synthetic todo. **16 assertions pass**,
including an absent-anchor rejection for each. Only the last two certify absence.
There is no text-pattern grandfathering of old notices. A pre-flag background
notice is classed as **present**, even if a human recognizes its text. Such rows
can therefore keep recovery blocked; do not “fix” that by accepting unknown gaps.
An interval with no message rows is different from a message with no parts.

The certificate proves the **inter-message** gap is absent to this producer. It
does not prove arbitrary stored block intervals cover an endpoint's remaining
blocks. The valid Rust contract uses whole-message last-block anchors; the shared
SQL must not be advertised as a general verifier for corrupt/manual intervals.
Blockers 1 and 3 are the consumer protections still missing for older/stale shapes.

### Note — tool pairing, Pi, deletion, undo and revert have bounded guarantees

- OpenCode 1 resolves the real user at/before the target. OpenCode 2 now also
  rolls a visible partial assistant/tool endpoint back to its user, or does no
  speculative cut when roles/the user are absent (`boundary.ts:175–179`). The
  revision's test retains both tool call and result plus the uncovered suffix.
- Pi retains ordinal + 1 and therefore intentionally vetoes any remaining
  uncovered indexed end, even with a precomputed first-kept entry. Its guard runs
  before entry existence/current-compaction checks (`compaction-marker-manager-pi.ts:60–95`).
  Sparse OpenCode raw flags are not authority for Pi entries.
- Missing target/raw rows and superseded targets remain covered by the passing
  manager tests and the unfenced validation at `compaction-marker-manager.ts:120–153`.
  The exact Rust response fence bypasses that target lookup, **not** the uncovered
  end guard. Missing successors are still protected by the SQL.
- Missing latest-boundary repair deletes a suffix transactionally, queues an m0
  mutation and clears the cache (`history-boundary-repair.ts:111–149`). That is
  useful for revert, but is not proof that every older absent endpoint or retained
  previous-target remainder is repaired. The two coverage reproductions are why
  this review does not certify arbitrary undo/revert histories.

### Note — successful deferred moves ride a genuine bust; fault-path ordering does not yet

The normal and frozen SOFT+ fixes uphold the original retry contract: pending
work/attempt counts can stay unchanged indefinitely through defers. There is no
new independent timer or automatic bust. Direct publication still relies on its
caller contract, not a new permission parameter: background incremental publication
preserves injection cache, while explicit recomp invalidates it
(`compartment-runner-incremental.ts:1175–1203`, `compartment-runner-recomp.ts:361–385`).

Independent host measurement: **25 indexed compartments, 24 distinct marker
ordinals (571 … 12,887)**; the large transition is **12,956 → 44 messages**, first
cut transport sends all 44, next ordinary append sends **3**. All three comparable
provider system/messages serializations are equal, SHA-256
`86ef9e6b2bd2988f3b4f1fd60e28ff79398d5c76ea2786e7d07df1f1270ca508`.
The tests assert actual intercepted provider objects, not just a normalization
hash. Comparable passes are applied SOFT+ transforms, not LKG/refusal. This proves
healthy byte stability and resync, **not** the rejected-HARD path in blocker 2.

### Note — what ALF's first eligible rebuilding pass can actually do

The permitted backup `context.db` contains marker **121,728**, NULL pending target,
and the same seven gaps listed in the revision. Its newest end is **132,025**,
not the brief's later **134,815**, so it is an older snapshot. Its marker's
`boundaryMessageId` equals `targetEndMessageId`; the three older gaps really are
behind that particular boundary. Neither backup contains the authoritative raw
OpenCode part flags needed to certify the four later intervals. FTS/source hashes
are not a substitute. No live raw rows were inspected to fill that evidence gap.

Consequently “deploy → inevitably 121,728 to 134,815 on the first HARD” is too
strong. **Conditional prediction:** with both anchors available and every later
gap containing only boolean-flagged synthetic rows (or no rows), a successfully
served, committed scheduler-execute rebuilding response supplies the exact durable
coverage target even though pending was NULL. One marker replacement can jump to
that target. A latest assistant target cuts at its earlier user, not necessarily
at the exact summary-end message. If the later intervals contain pre-flag/real/
unknown rows, expect a veto or producer coverage refusal instead of recovery.

The real seven-gap host reproduction independently performs **50 → 140 on one
HARD / first_render / scheduler=execute / committed=true**. With a mixed real row
at 85 it keeps marker 50, emits the precise coverage-gap refusal and makes **no
new provider request**. Append-only turns do not repair that durable hole; repair
or recompilation must include the real content. Do not disable either guard.

A rebuilding pass need not always be HARD: a natural m1 refresh can be SOFT.
Also, boundary extraction still requires scheduler-execute, committed and exact
coordinates (`rust-mode-transform.ts:736–768`); a HARD labelled scheduler-defer
with no pending target is not an unconditional catch-up promise. No extra bust
should be forced just to retry the marker.

For an in-flight historian, the move does not delete ordinary raw rows: it replaces
compaction metadata and a synthetic summary. The replacement user boundary is
at/before already-published coverage, while the next historian chunk starts at
the next present ordinal after that coverage (`historian_chunk.rs:1013–1026`).
The raw suffix that chunk reads remains retained. Drops/reclaim ride the same
priced pass under the protected architecture's fold bypass. This is source-based
concurrency reasoning; the byte-comparison fixture deliberately drains/stops the
producer (`rust-compaction-marker-byte-identity.test.ts:139–155`), so it is not a
paused-in-flight deployment-race certification. A successful move causes a smaller
**next** host array and full-array transport resync, not an extra provider HARD
fold in itself. Blocker 2 is the exceptional path that still violates that story.

## Verification and isolation record

Tools: **Bun 1.4.2 (744846f84)**, **TypeScript 5.9.3**, **cargo 1.99.0
(5f94df478 2026-08-27)**, **SQLite 3.54.0**, real **OpenCode 1.18.30**; V2 uses
the pinned **2.0.22** CLI resolution. Existing hermetic daemon binary reports
**ck-subc 0.20.55**. The module was rebuilt from this worktree's unchanged Rust
source. This is not a separately rebuilt daemon certification. The review master's
Cargo lock uses the available sibling `cortexkit-store 0.2.1`, whereas the
candidate records 0.2.0; no Rust or manifest change is part of this marker patch.

All shell runs had an outer `timeout`. Native compilation used **`-j 2`**, only
one native build at a time, and the required foreground wait. The 7m51 build
included a reported shared compile-slot queue; no concurrent native rebuild was
launched. No package manifest/lockfile was edited or install performed by this
review; the prepared frozen install was used.

For unit runs below, the working directory was `packages/plugin` (Pi separately
`packages/pi-plugin`); the preloads and fixture helpers remained enabled. All runs
set `TMPDIR` beneath `$TMPDIR/magic-context/marker-unfreeze-review-r2/`, plus
throwaway `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`,
`OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`. Relative `OPENCODE_DB=opencode.db`
or `opencode2.db` resolves under each fixture's throwaway XDG root, not the live
store. Host runs were from `packages/e2e-tests`, with the candidate's rebuilt
`packages/plugin/dist/index.js` and explicit prebuilt module/daemon paths.

| Command / check | Result |
| --- | --- |
| `timeout 200s bun test src/features/magic-context/compartment-storage-v6.test.ts src/hooks/magic-context/compaction-marker-manager.test.ts src/hooks/magic-context/transform-postprocess-phase.test.ts src/hooks/magic-context/rust-mode-transform.test.ts src/hooks/magic-context/rust-mode-marker-lock-contention.test.ts src/v2/fold/boundary.test.ts --timeout 30000` | Candidate: **439 pass, 0 fail, 4,447 assertions**, six files, 66.12s. Includes the first-review reproduction regressions. |
| `timeout 90s bun test src/compaction-marker-manager-pi.test.ts --timeout 30000` | Candidate Pi, separate process: **11 pass, 0 fail, 18 assertions**. |
| `timeout 180s bun run --cwd packages/plugin build` | Candidate build passed, including **4 V2 loader tests / 19 assertions**. Repeated after restoring master for the baseline comparison, same loader result. |
| `timeout 120s bun run --cwd packages/plugin typecheck` | Candidate passed all **three tsc invocations**, silent-on-success, TypeScript 5.9.3. |
| `timeout 900s cargo build --release -p mc-module -j 2` | Passed, **one package build target**, no Rust tests, cargo version above. |
| `timeout 700s bun test tests/rust-compaction-marker-byte-identity.test.ts --timeout 600000` with isolated environment and explicit binary/bundle paths | **3 pass, 0 fail, 140 assertions**, 89.59s; dense large cut, sparse synthetic/real controls, real committed metadata-only execute. |
| Temporary `-t 'r2 proof:'` manager/rejected-HARD tests under `timeout 90s` | Retained partial failed with applied/20. Correctly anchored isolated rejected-HARD rerun failed with persisted marker/1 after two passing replay assertions. Setup failure disclosed above. Tests removed. |
| Temporary flag-table + V2 real-gap tests under `timeout 90s` | **1 pass, 1 expected-safe failure, 17 assertions**; the V2 real-gap trim is the sole failed test. Tests removed. |
| `timeout 750s bun test` the eight native files listed below, same `-t` selection and `--timeout 120000` on candidate and then rebuilt master | **Each: 2 pass, 7 fail, 10 filtered out, 233 assertions**; candidate 258.00s, master 325.08s. Exact baseline dispositions above. |
| `timeout 180s bun test tests/opencode2/output-cap.test.ts --timeout 120000` on master | **0 pass, 1 fail**, undefined scratch-plugin helper / activation timeout; 65.53s. |
| SQLite `timeout 15s sqlite3 -readonly 'file:…/ckmc-perf/backups/{context,store}.db?mode=ro'` metadata queries | Confirmed copied marker/gap coordinates and lack of authoritative raw part flags; no live paths opened. |

The native comparison selection was:

```text
tests/opencode2/dream-loop.test.ts
tests/opencode2/hidden-step-limit.test.ts
tests/opencode2/hidden-child-two-directories.test.ts
tests/opencode2/hidden-child-terminal-failure.test.ts
tests/opencode2/hidden-child-native-remove.test.ts
tests/opencode2/fold-s3-owner.test.ts
tests/opencode2/overflow-reading-retention.test.ts
tests/opencode2/context-s2-lanes.test.ts
-t 'tool-loop families|reaching its cap|each worktree|retried and a terminal|parented and removed|host fold costs|retains rejection-derived|poisoned shared'
```

OpenCode 1's built-in `timeout 20s lsof -p <host,daemon,module,producer pids>`
assertions listed only each fixture's `data/opencode/opencode.db`,
`data/cortexkit/magic-context/context.db` and `store.db`. One sparse-host sample
was PIDs **35491,31791,31851,31893**, all beneath
`…/marker-unfreeze-review-r2/opencode-e2e-P9CrNm/data/`. V2's mandatory process-group
lsof/inode guards also passed at handoff/teardown; temporary logging preserved
their `.db` inventories, e.g. master output-cap host **65998** held only
`…/marker-unfreeze-review-r2/magic-context/issue-551/mc-opencode2-nRXSM0/XDG_DATA_HOME/opencode/opencode2.db`
and its WAL/SHM. Failed activation was not an isolation failure. Logging was
removed afterwards. No fixture database contents are delivered.

Retained text logs under the throwaway review root: `plugin-units.log`,
`build.log`, `master-build.log`, `oc1-host.log`, `v2-candidate.log`, `v2-master.log`,
`v2-master-output-cap.log`. No production mutation proofs are claimed: the new
reproductions assert literal safe outcomes and visibly fail against the candidate;
they do not replace, neutralize, or weaken a production guard. Workspace-wide
test/lint and a full V2 native suite were not rerun; this is a targeted review,
with relevant candidate gates and an actual master baseline comparison.
