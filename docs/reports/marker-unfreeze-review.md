# Compaction-marker unfreeze: adversarial review

## Scope and verdict

Reviewed `alfonso/task/bg_08b630c2edb0a671-opencode-1-rust-mode-compaction-marker-frozen-by`
at **7f61381c52be2702eff925de8c2e83770b1c0bda**, against merge base
**e50e2b52e71d871dcc5afc3ea046a8dacc774bbe** (two commits, ten changed files).
Line references below refer to that reviewed tree, not the review branch's HEAD.
Read `ARCHITECTURE.md:48–108`, its protected cache-stability section, before
reviewing code. Neither architecture file was edited.

**Do not treat this as fleet-ready ALF recovery.** The replacement correctly
removes the blanket indexed-end veto for a contiguous, valid Rust history, but
the motivating long session still has older gaps that the replacement vetoes.
There is also an ungated frozen-replay retry path that contradicts the advertised
retry contract. An additional pre-existing OpenCode 2 safety defect survives the
shared-query extraction. These are distinct from whether the happy-path host
fixture can produce a large, byte-stable cut.

This is review only. Temporary source overlays, proof tests, and mutations were
restored; only this report is delivered. No live store was copied or opened
writable. Live observations used outer-timeout, read-only `sqlite3` queries
against the expanded `$HOME` path
`file:$HOME/.local/share/cortexkit/magic-context/context.db?mode=ro` only.

## Findings

### Blocker — older legitimate ordinal gaps still permanently veto the motivating move

**Evidence:** `packages/plugin/src/features/magic-context/compartment-storage.ts:897–913`;
`packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts:220–235,317–326`;
`crates/mc-module/src/historian_chunk.rs:1013–1026`;
`crates/mc-module/src/historian_validate.rs:1095–1113`.

The query releases an indexed end only for `sequence + 1` and either the same
message at a greater block index or **exactly** `end_message + 1`. That is
stricter than the real Rust historian's contract: it starts the next firing at
the **next present** ordinal, and validates coverage against present ordinals,
not every integer. Retired/synthetic coordinates can therefore leave legitimate
gaps. `historian_chunk.rs:2866–2968` already has the explicit sparse-consumer
regression test. A successor after skipped background notices must not be
assumed to cover arbitrary missing content, but neither may integer adjacency
be treated as the only proof available.

Read-only counts at **2026-10-05 12:11:14 UTC** found the lagging OpenCode
session `ses_227ce5788ffeRPA9THoPLOQreO` with:

| Property | Observed |
|---|---:|
| Compartments / indexed ends | 2,030 / 2,029 |
| Latest compartment end | 134,815 |
| Persisted marker ordinal | 121,728 |
| Lag | 13,087 ordinals |
| Pending ordinal | NULL (no retained pending target) |
| Indexed ends rejected by the new SQL | 8 |
| Earliest rejected end | 111,638 |
| Successor ordinal gaps | 7, each one or two ordinals |
| Such gaps before the persisted marker ordinal | 3 |
| Unresolved-rebase rows | 0 |

These observations are not a claim that I inspected the live raw messages or
proved the gaps' contents. They **do** show that the new query rejects older
rows in the very history needing recovery, not just its safe latest end. For
a proposed user boundary after 111,638, the manager returns
`stale-skip / partial-message-boundary`; if that old raw endpoint has vanished,
unknown ordering also vetoes. Publishing additional contiguous compartments
at the tail does not fix an older immutable gap.

**Concrete proof:** the reviewed test
`applyDeferredCompactionMarker — outcomes > still blocks an older indexed end with an uncovered remainder before the user cut`
seeds an indexed end at 8, its successor starting at 10, and a user cut at 10.
Even an exact Rust row-version fence returns `stale-skip`; the direct publication
path returns false. I reran it successfully, and independently disabled its veto
to prove it detects the difference (mutation record below). Substituting a
historian-certified retired ordinal for the missing 9 cannot change the result:
the helper never reads such evidence.

**Required before calling this ALF recovery:** reproduce the real sparse shape
in a throwaway fixture, then use authoritative coverage/present-coordinate or
last-block evidence to distinguish harmless gaps from unsummarized content.
Do not simply accept every ordinal gap. Alternatively perform an explicit,
verified boundary repair/recompilation; document that additional recovery rather
than promising that the first bust alone heals this session.

### Blocker — SOFT+ retry permission is incomplete

**Evidence:** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:1070–1083`
is the new gate, but `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3850–3897,3958–3966`
still calls `applyRustModeDeferredCompactionMarker` unconditionally when serving
the frozen representation. That branch is entered with `!cacheBustingPass`.
The callee at `transform-postprocess-phase.ts:836–880` has no permission check.

**Concrete repro, executed:** a temporary test in `rust-mode-transform.test.ts`
used its existing real SQLite / mocked module / real LKG fixtures:

1. Seed a throwaway OpenCode user row `m1`, and a compartment with both block
   anchors 0. Serve HARD successfully and capture LKG.
2. Fail the next module transform; the adapter freezes that representation.
3. Persist pending `{ordinal:1,endMessageId:"m1",publishedAt:1}`.
4. Return a healthy **SOFT+**, with no committed/materialized-boundary fields.

`review proof: frozen SOFT+ drains a pending marker without bust permission`
passed five assertions: the representation remained frozen, served messages
equaled LKG, pending became NULL, and persisted marker ordinal became 1. Output:
`REVIEW frozen SOFT+ applied pending ordinal=1 while replaying unchanged LKG`.
The proof fixture was removed after execution.

The current pass can remain byte-identical while the **next host input cut**
changes. This is precisely what the new gate's comment says it must prevent;
it can also invalidate the input needed to validate a continuing frozen replay.
This call predates the patch, but relaxing the indexed guard now lets real Rust
targets get through it, and the patch's “only on busts” contract is not enforced
at this call site. It also supplies no host-specific strategy: do not assume
the OpenCode 2 boundary strategy participates in this exceptional path.

**Required:** route every retry through the same genuine bust permission,
including frozen representations, with a test at `createRustModeTransform`
level, not only `runRustModePostprocess` level. Preserve the pending target
until the frozen representation is actually released on an eligible pass.

There is a second, **source-proven permission escape** in the normal gate's
`|| args.materializedBoundary` clause. `materializedCompactionBoundary`
(`rust-mode-transform.ts:737–767`) checks committed/scheduler-execute/coordinates,
but not the served decision. Rust explicitly supports scheduler-execute with
unchanged **SOFT+** (`crates/mc-module/src/transform.rs:23481–23491`);
`committed` means `commit_required`, which also includes tag/metadata overlays,
not only a render bust (`:6801–6804,6950–6972`). Those fields alone are not
proof of materialization. The existing postprocess test at
`transform-postprocess-phase.test.ts:1490–1545` applies a supplied boundary
without setting `cacheBustingPass`, demonstrating the gate's behavior.
I did not reproduce that field combination with a real folded module; the
successful real-host ordinary probes below all report scheduler-defer. Add a
real-producer metadata-only execute regression and require the actual served
bust decision rather than treating any durable row commit as its substitute.

### Medium — OpenCode 2's earliest-only guard can discard a later visible partial message

**Evidence:** `packages/plugin/src/features/magic-context/compartment-storage.ts:904–910`
returns one row; `packages/plugin/src/v2/fold/boundary.ts:166–174` looks up only
that endpoint in the supplied array. If it is absent, `partialIndex === -1`
and the recorded cut proceeds, even when another uncovered endpoint is present
before that cut. The context hook trims before module transformation at
`packages/plugin/src/v2/hooks/context.ts:1634–1643`.

**Concrete repro, executed:** a temporary test in `boundary.test.ts` seeded:

| Sequence | Ordinals | Indexed end |
|---|---|---|
| 0 | 1–2 | `absent-old-partial#0` |
| 1 | 4–5 | `visible-partial#0` |
| 2 | 8–9 | `tail#0` |

Record user boundary `boundary-user` at ordinal 8. Supply
`[visible-user, visible-partial(with UNCOVERED_SUFFIX), other-unsummarized, boundary-user, tail]`.
The trim removes three messages, including the uncovered suffix. A control
array that also includes the earliest partial trims only to that old partial
and retains the suffix. Test
`review proof: an absent earliest partial masks a later visible uncovered message`
passed all five assertions. This is possible for host-cut histories, removal,
or revert; the API explicitly accepts arrays already missing older history.

This is **pre-existing in the SQL/trim introduced for OpenCode 2**, not a new
regression caused by `COALESCE` or extraction. It is nevertheless a real safety
hole in the reviewed shared-coverage use. The raw trim demonstrably removes
unsummarized blocks; I did not extend this proof to a live V2 provider request.
Depending on tool shape the module may refuse instead of sending an orphaned
result. Neither outcome is a proof that the trim retained the content.

**Required:** locate the earliest *visible* uncovered endpoint, or enumerate
uncovered endpoints before choosing a cut. If the guard rolls a cut back into
an assistant/tool turn, also resolve an appropriate user/paired-turn boundary
rather than assuming the partial endpoint itself is a user turn.

### Low — retry diagnostics still promise “next pass” after the contract change

**Evidence:** `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:732–734,823–826`;
`docs/reports/aft-marker-drain-atomicity-2026-09-22.md:34,56`.

The runtime lock-contention log still says “next pass retries”, and the
bookkeeping comment says every pass records the boundary. On the normal path,
the next SOFT+ now does neither. The earlier incident report also describes
ordinary-pass healing; it is historical evidence, not the new behavior.

**Proof:** `retries a retained marker only on busts and retains retry health on defers`
and `an upgraded indexed pending waits through byte-identical defers and moves on the next bust`
pass while defers retain the blob/attempt count. Update the runtime wording to
“next cache-busting pass” and add a current operational explanation. This review
does not recommend modifying the historical incident report in place.

## Attack-by-attack conclusions

### 1. Coverage, deletion, recompilation, and block-index semantics

- The Rust anchor explanation is correct **for this producer**.
  `historian_chunk.rs:238–245` records `last_block_id(message)`,
  `:294–301` renders the message's block collection, `:470–475` publishes one
  ordinal line per message, and `:1544–1546` picks the last block.
  `historian_validate.rs:1003–1031` maps both compartment endpoints to those
  lines; `crates/mc-store/src/context_boundaries.rs:8–20` splits the flat ID
  into canonical message ID and block index. A nonzero **start** index is
  consequently not proof that earlier blocks in that message were omitted.
- Successors at the same message with a greater anchor release an older end
  under the query, without requiring `end + 1`. Normal Rust publication
  actually enforces non-overlapping, next-present message ordinals, so the
  same-message case is compatibility coverage, not the ordinary firing shape.
  This SQL is not a general verifier for arbitrary hand-edited block intervals.
- `COALESCE(...,0)` makes an unknown same-message start conservative. With
  NULL `start_block_index`, the same-message comparison does not release an
  end. A next ordinal *does* release it regardless of that NULL; this is
  appropriate only with the producer's whole-message anchor contract.
- A missing `sequence + 1` stays protected. Deleting a middle successor or
  recomputing it with a real gap cannot silently release that predecessor;
  the existing unit tests check both sequence and ordinal gaps. Recompilation
  replaces staging and live compartment state transactionally and queues the
  m0 mutation (`compartment-storage.ts:669–704`), while target validation checks
  raw existence plus current end-ID/ordinal (`compaction-marker-manager.ts:119–152`).
  A trusted Rust response deliberately bypasses that latter validation, but
  still runs the uncovered-end guard. These are not guarantees against every
  manual deletion or arbitrary corrupt prefix: the helper examines indexed
  ends, not complete historical coverage from the beginning.
- Undo/revert changes cannot be justified by integer adjacency alone. The
  existing missing-boundary repair deletes a suffix under a lease and rebuilds
  the cache (`history-boundary-repair.ts:111–149`). Sparse/retired ordinals are
  explicitly supported by Rust validation. See the first finding for the
  mismatch and the V2 finding for an absent raw endpoint.

### 2. Tool pairing and request roles

OpenCode 1 resolves the nearest non-synthetic **user** at or before the target
using canonical `(time_created,id)` order (`compaction-marker.ts:263–311`).
The host retains that boundary, not just the assistant endpoint. The latest
partial message and its entire following turn therefore remain raw. Ordinary
OpenCode tool call/result data are carried together in the assistant tool
part; no new split was demonstrated in the valid OpenCode 1 shape. The reviewed
tests retain the partial turn and suffix, and existing historian boundaries
keep completed/open tool arcs from being split before publication.

This does **not** establish a universal guarantee for tool results in separate
messages or for V2's rollback-to-partial guard. V2's own gap test explicitly
expects a retained array beginning with `a2` (`boundary.test.ts:268–277`), an
assistant, not the earlier user. Synthetic m0/m1 may still put user messages
first on the provider request; the raw tail is not thereby proven paired.
The host stress fixture has no synthetic tool arcs (see test-quality section).

### 3. Cache permission and all marker application paths

| Path | Conclusion |
|---|---|
| OpenCode 1 TS deferred drain | Requires consumed history, satisfied materialization and proven trim at `transform-postprocess-phase.ts:3045–3117`; not an ordinary SOFT+ drain. |
| OpenCode 1/2 normal Rust postprocess | New gate at `:1073` admits a bust **or** a boundary extracted from committed scheduler-execute fields; a metadata commit with SOFT+ is not excluded. See the permission finding. |
| Hook-init pending rehydration | `hook.ts:354–367` populates **deferred**, not explicit, signal sets. `cache-busting-signals.ts:13–23` and `transform.ts:1653–1675` still require an eligible consumption opportunity. Rehydration is not itself permission to mutate on SOFT+. |
| Direct `updateCompactionMarkerAfterPublication` | Has no standalone bust permission. Incremental background callers set `preserveInjectionCacheUntilConsumed:true`; the direct alternative clears injection cache (`compartment-runner-incremental.ts:1175–1203`). Explicit recomp paths eagerly rebuild/invalidate and directly update (`compartment-runner-recomp.ts:361–385`). Retain that caller contract; do not call it as routine background publication. |
| OpenCode 2 recorded-boundary trim | Replays a persisted boundary every pass, not a new move every pass. The boundary changes via the shared Rust postprocess strategy; the existing guard is unsafe for multiple partials with an absent earliest one. |
| Frozen Rust representation | **Ungated SOFT+ drain remains**, independently reproduced above. |

### 4. The first move after upgrade

There are two separate questions: releasing the database veto, and safely
transporting the smaller input **after a move actually succeeds**.

- Old `stale-skip` outcomes CAS-clear pending at
  `transform-postprocess-phase.ts:855–864`; one cannot assume the old blob
  survives an upgrade. The lagging session's pending ordinal was NULL in my
  read-only observation. I did not infer the historical reason from that NULL.
- A committed execute response can recreate the target even if pending was
  cleared: `applyRustModeDeferredCompactionMarker` constructs it from the exact
  returned boundary (`:772–821`). A subsequently consumed new publication also
  provides a target. Another publication is **not strictly necessary** if the
  next materializing response already returns the advanced durable coverage.
- For the observed sparse history, the recreated target can immediately
  stale-skip again on the earliest old gap. Consequently the claimed fleet
  “first bust → one large move” is not established by the contiguous fixture.
- When a valid move lands, this request has already been read/transformed;
  the host's next request is the smaller array. Delta transport is considered
  only when `messages.length >= previousWireCache.rawCount`
  (`rust-mode-transform.ts:2993–2998`). A 12k-message shrink is sent as a full
  current array, not a suffix against the obsolete larger one; the new cache
  snapshot records that smaller raw count (`:3263–3282`). Later unchanged
  append-only passes can return to suffix transport.
- That is an adapter full-array resync, not a demand to reopen/rescan all live
  raw storage, nor necessarily a protocol `NEED_FULL_SYNC` rejection. The
  handler permits one full retry for a module that asks for it, and refuses
  if even a full-array response still asks (`:3532–3548,3693–3697`). The host
  fixture checks wire-message counts and served-source decisions, not an exact
  RPC-attempt count.

Host rerun result is recorded in Verification below. Byte identity/no-LKG/no
refusal claims apply to that isolated fixture, not automatically to a live
upgrade with the older gaps above or to the exceptional frozen path.

### 5. TypeScript mode and Pi

The ordinary TS historian mapping emits message IDs and ordinals, **not** block
indices (`compartment-runner-mapping.ts:37–56`,
`read-session-chunk.ts:1292`). Storage binds absent indices to NULL
(`compartment-runner-recomp.ts:65–89`). Pure TS-produced OpenCode 1 histories
therefore keep their prior behavior. A TS-mode session retaining old Rust
compartments is not a pure TS history and does receive the new indexed-end
policy; changing transform mode does not erase those rows. Existing recomp
copy paths also preserve indices supplied by candidates.

The Pi guard is appropriately stricter because it keeps ordinal + 1 rather
than the user at/before the partial end (`compaction-marker-manager-pi.ts:60–79`).
It protects even precomputed first-kept IDs. My read-only live counts were
**1,178 Pi compartments, zero indexed ends**, consistent with the brief's
earlier 1,176/0 observation: ordinary Pi publication is unchanged.

### 6. Failed injection, pending duration, and health

An atomic host-store lock failure preserves the old marker and keeps pending.
The normal-path marker can now remain pending through arbitrarily many active
SOFT+ passes: there is no timer that independently grants bust permission.
Idle-TTL/execute/coverage/flush opportunities eventually permit a retry, but a
busy continuous session need not become idle just because five minutes passed.
This is a real performance tradeoff, not immediate content loss: the old host
cut can keep handing the adapter thousands of already-folded messages.

For a retained failed target, health still uses **three attempts OR five minutes
since the first failure** (`storage-meta-persisted.ts:2935–2954`), so withholding
attempts on defers does not withhold the time-based warning. The passing retry
test checks unchanged attempts on defers. A newer target can reset its failure
metadata (`transform-postprocess-phase.ts:787–821`); this was not repaired by
the patch. Coverage-policy `stale-skip` is cleared, not reported as an injection
failure, so health does not diagnose the first finding's stranded old marker.

### 7. Test quality and independent mutation

The revised host test is not a self-hash or a no-op assertion:

- It requires at least three distinct marker ordinals and at least three
  indexed compartment ends (`rust-compaction-marker-byte-identity.test.ts:98–122`).
- It compares actual intercepted provider `system` and `messages` JSON, not
  only the normalized serialization hash (`:200–204,246,262–263`).
- It requires >12,900 control messages, <400 cut messages, full cut transport,
  then an ordinary delta of at most four messages (`:271–287`).
- It excludes LKG/refusal/failure logs and checks applied transform serves plus
  ordinary decisions (`:275–297`).

However, `appendSyntheticHistory` copies a **user text** template for all 12,900
rows (`rust-harness.ts:536–615`). These are dense ordinals with one text block,
not a real long alternating/tool-heavy history with retired coordinates.
The test's producer does write actual indexed Rust compartments, so it is useful
for the removed blanket veto and transport size, but it misses the motivating
session's older gaps. It also freezes the producer, restarts/settles state, and
**manually deletes/restores marker rows** (`host test:128–186,215–237`) to measure
the large input transition. That is not a deployment of an old binary followed
by recovery of an old cleared/stale pending target.

The partial-turn manager test's “with and without a Rust fence” loop first
applies without the fence and then obtains `already-current` on the second
iteration (`compaction-marker-manager.test.ts:256–271`); do not mistake it for
two fresh injections. The older-gap test independently does use a trusted
boundary and covers that safety check.

**Independent mutation record:** staged the exact reviewed working state before
the mutation; `git diff --stat` was empty. Changed
`boundaryWouldDiscardUncoveredMessage` to `return false`, marked with the exact
token `NON-VACUITY BREAK`. The mutation diff was one file, one insertion and one
deletion. Ran:

`timeout 60s bun test packages/plugin/src/hooks/magic-context/compaction-marker-manager.test.ts --timeout 30000`

Only
`applyDeferredCompactionMarker — outcomes > still blocks an older indexed end with an uncovered remainder before the user cut`
failed: expected stale-skip/partial-message-boundary, received applied/ordinal 10.
The other **18 named tests passed**, including the covered-successor advance,
partial-turn retention, raw-deletion/superseded targets, lock preservation, and
direct-publication rollback controls. Restored with `git checkout -- <path> &&
touch <path>`; `git diff --stat` was empty again. Rerun: **19 pass, 0 fail, 59
assertions**. No mutation was committed. This independently confirms the older-gap
guard control; it does not certify all five controls claimed in the implementation's
delivery.

**Non-reddening host control, disclosed:** setting only the predicate's final
return to true (leaving `if (!partial) return false` intact) did **not** redden
the host test. A source-entry attempt passed one test / 86 assertions; the
rebuilt-distribution attempt passed one test / 85 assertions, with many marker
moves in both. The rebuilt attempt
confirmed the altered final return in the generated bundle; it still leaves the
no-uncovered-end fast path intact. This dense fixture therefore does not defend
that particular predicate alteration. Do not cite the host pass as protection
against the older-gap hazard. The unit control above reaches the same source
file and does defend that hazard.

**Reddening real-host control:** replaced the *whole* boundary-veto function
body with unconditional `return true`, marked `NON-VACUITY BREAK`, and rebuilt
the actual host distribution with
`timeout 180s bun run --cwd packages/plugin build`. The applied diff was one
file, **one insertion / ten deletions**. Ran the same isolated real-host test
under an outer 180s timeout, explicitly pointing at `packages/plugin/dist/index.js`.
Only
`rust invariant: compaction marker byte identity > advances indexed Rust markers on busts and resyncs a 12900-message cut without changing ordinary wire bytes`
reddened, at line 113: **expected marker ordinal count > 0, received 0** after
at least three compartments had published. **Zero pass, one fail, 12 assertions,
52.72s**; no other test was included or failed. Lsof isolation assertions passed.
The stale-skip logs named ordinals 1,107 and 1,643, demonstrating the control
reached actual marker attempts, rather than a startup/producer failure.
Restored from the staged original with `git checkout -- <path> && touch <path>`;
`git diff --stat` was empty. Rebuilt the restored distribution successfully
(four V2 loader tests / 19 assertions). This control defends marker progress,
while the non-reddening predicate control above demonstrates the fixture's
narrower coverage of older-partial safety.

## Verification and isolation

- Tools: Bun **1.4.2 (744846f84)**; TypeScript **5.9.3**; cargo **1.99.0
  (5f94df478 2026-08-27)**; SQLite **3.54.0**.
- `timeout 180s bun test packages/plugin/src/features/magic-context/compartment-storage-v6.test.ts packages/plugin/src/hooks/magic-context/compaction-marker-manager.test.ts packages/plugin/src/hooks/magic-context/transform-postprocess-phase.test.ts --timeout 30000`:
  **264 pass, 0 fail, 1,494 assertions**.
- `timeout 60s bun test packages/pi-plugin/src/compaction-marker-manager-pi.test.ts --timeout 30000`:
  **11 pass, 0 fail, 18 assertions**.
- `timeout 90s bun test packages/plugin/src/v2/fold/boundary.test.ts --timeout 30000`:
  **18 pass, 0 fail, 45 assertions**.
- Temporary frozen-retry and absent-partial proof tests: **one test / five
  assertions each**, both passed; removed afterwards. Their fixture construction
  and observed results are recorded above so they can be reinstated as regression
  tests with safe expectations.
- `timeout 180s bun run build`: passed; rebuilt reviewed plugin/Pi/CLI bundles,
  including **four V2 loader tests / 19 assertions**.
- `timeout 120s bun run --cwd packages/plugin typecheck`: passed (the repository's
  three tsc invocations, including script types; silent-on-success).
- `timeout 900s cargo build --release -p mc-module -j 2`: passed, one package
  build target, no tests. Shared compile-slot queue extended this to 8m45s.
- Attempting the harness's local module/daemon binary-pair build under a 900s
  timeout with `CARGO_BUILD_JOBS=2` timed out. No second concurrent native build
  was launched. The host rerun instead uses this worktree's freshly built module
  and the installed daemon executable, both against isolated fixture paths;
  this is not an independently rebuilt daemon certification.
- An initial combined Plugin + Pi unit-test invocation had **262 pass / 13 fail**:
  loading the Pi suite selects the Pi-compatible harness in the same test process,
  making OpenCode writes fail with “OpenCode database is not writable from a
  Pi-compatible process.” Separate host processes gave the clean results above;
  no production change was made to mask this test-harness interference.

The real-host run uses `$TMPDIR/magic-context/marker-unfreeze-review/`, explicitly
sets all `XDG_*`, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR`, and the harness
further scopes each child to its own `opencode-e2e-*` fixture. Its built-in lsof
assertion observed only fixture-root `context.db`, `store.db`, and `opencode.db`
for the OpenCode/daemon/module/producer PIDs. OpenCode reported **1.18.30**.
The host log is retained under that throwaway root as `host-run.log`; the final
host result follows.

The other retained logs are `host-mutant.log` (source-entry predicate attempt),
`host-bundled-mutant.log` (rebuilt predicate attempt), and
`host-cut-disabled.log` (reddening all-moves-disabled control). No fixture
database contents are delivered with this report.

**Independent real-host rerun:** the reviewed test passed, **one test / 86
assertions**, in 210.42s. The module produced 25 indexed compartments and 24
distinct marker ordinals (571 through 12,887). This run shrank
**12,956 → 42 messages**, sent all 42 on the first cut pass, then sent a
**three-message** ordinary delta. All three comparable request serializations
had SHA-256
`ae85cf59172640b8f64e6fe0b1c6ceb60342a0e3b31b1dfcdc421438e8842193`;
the exact provider system/messages comparisons also passed. The compared passes
were applied SOFT+ transform serves, with no LKG replay or refusal in the
asserted logs. The difference from the delivery's 44 retained messages is
fixture timing, not a weakened bound. Lsof assertions passed before and after
both restarts. This validates the contiguous transport/cache recovery, not the
first finding's sparse live history.
