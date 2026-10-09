# Compaction-marker unfreeze: round-three implementation and evidence

## Delivery and scope

The interrupted implementation at `739065d12f51e969d4a98d0b44eb736a3de7e5b3`
was recovered by merging it into the prepared task branch at `3ba0f00042`.
The prepared branch was clean but did not contain the interrupted tip; merging,
rather than resetting it, preserves the newer storage-permission and model-threshold
work. Recovery checkpoint: `c32bceb`. Additional admission controls: `0a31af0ecb`.
The fixes below address the three blockers in `marker-unfreeze-review-r2.md`.
No unrelated native-lane workaround, configuration change, migration, or production
database access is included.

**Disposition:** the three reproduced consumer safety holes are defended. A
post-cut adapter fault now refuses the provider turn and makes the next pass
recompose; it does not promise to keep serving the pre-cut LKG. This is the
approved fail-closed recovery choice, not rollback of a committed host cut.

## Blocker 1: the retained user, not the previous target ordinal

`boundaryWouldDiscardUncoveredMessage` examines all indexed uncovered ends
through the new target. An end is excluded as already discarded only when raw
canonical ordering proves it is **strictly before the actual old user boundary**.
Equality and unknown ordering remain protected. The previous summary target's
ordinal is not evidence that the host discarded the rest of that turn.

The review's assistant-8/user-7 rollback reproduction is retained as
`r2 proof: a retained partial at the prior target ordinal still vetoes the next cut`.
It creates the initial marker through the real manager, verifies the retained user,
then requires `stale-skip / partial-message-boundary` for the later cut. The
already-cut-user control remains positive, with actual raw canonical-order evidence.
Unknown-order and sparse synthetic-gap controls also remain intact.

## Blocker 2: validate, durably fence, refuse, recompose

### Before a possible host cut

The adapter validates the module's synthetic native history head before running
marker-changing postprocess. Candidate cuts also require coherent, unique capture
input IDs and snapshots, plus a proven native-output fit under the context limit.
The rejected-HARD reproduction replays exactly the previous LKG and verifies
**both** that context.db has no marker state and that OpenCode has no marker rows.
It also verifies that no durable admission fence was armed.

### At the irreversible boundary

The adapter installs a write-ahead admission fence in the existing versioned
replay document and strictly deletes the old durable LKG in one context.db
transaction **before** allowing the host strategy to write the cut. This ordering
is intentional: OpenCode's host-store transaction and context.db are separate,
so waiting until after the host commit would leave a crash/restart window in which
old LKG was still replayable. The fence is therefore already durable when the
host cut commits. If the fence transaction fails, no host cut is attempted and
the previous durable LKG remains restart-safe. The current process conservatively
refuses that attempt; a restart may use the old slot because the cut did not move.

The in-memory slot and queued old captures are invalidated too. The capture
sequence prevents an earlier queued SOFT+ callback from resurrecting old durable
bytes. The outer replay participant and durable loader both honor the fence.
This intentionally errs toward refusal if a marker strategy throws after a
possible commit; it does not try to infer that a swallowed host-store error
guarantees the cut was unchanged.

### After a cut or an uncertain cut attempt

Installation, final output-fit checking, priced LKG capture/persistence, final
bookkeeping, and the last fence-clear step can still fail. Such a fault throws
`EmergencyFailClosedError`, not LKG or raw fallback. The fence remains armed.
A fault after the adapter returns into the outer storage-busy wrapper likewise
refuses and re-arms the fence; it cannot turn the failed turn into an old-prefix
serve.

The next pass bypasses parking, sends the full current host input without
`tail_delta`, calls the existing `session.flush` operation, and requires a genuine
rebuilding decision. A metadata-only committed execute labelled SOFT+ is still
not permission to release the fence. The new priced LKG must persist before final
bookkeeping and strict fence clearing complete. Persistent faults refuse every
attempt; a one-shot fault recovers on the next successful rebuilding pass.
This is recovery of an unadmitted boundary change, not an ordinary marker retry
timer or a new standalone bust for historian publication.

### Executed fault controls

All run through `createRustModeTransform.run`, actual SQLite host-marker writes,
and file-backed context.db; only the module response is mocked:

| Injection | Observable result |
| --- | --- |
| Immediately after the real manager writes the host marker | Host marker exists; turn refuses; durable fence blocks old LKG; next pass rebuilds and captures the new representation. |
| In priced LKG capture | Same refusal/recovery; persistent faults refuse four successive attempts rather than parking into raw fallback. |
| In later overflow bookkeeping, after capture has completed | Same refusal/recovery even though a new snapshot has already been captured. |
| Outside the adapter, in the real storage-busy wrapper | `StorageBusyRefusalError`; replay callback never runs; durable fence is re-armed. |
| Across disposal, slot-store reset, and a new file connection/adapter | Fence survives; old LKG cannot hydrate; another failed attempt refuses; successful rebuilding clears the fence. |
| Queued pre-cut defer capture | Running the stale callback cannot recreate a durable LKG row. |
| Durable fence write itself, before host application | No host marker rows or mirror state; transaction rolls back; previous LKG hydrates unchanged on restart. |
| SOFT+ / scheduler-execute / committed response during recovery | Refuses without releasing the fence; a later HARD succeeds. |

These are adapter/consumer fault proofs, not fault-enabled Rust producer runs.

## Blocker 3: visible prefix coverage on OpenCode 2

`trimToRecordedBoundary` verifies the entire visible prefix against valid summary
ordinal ranges, not just whichever indexed endpoints happen to remain visible.
An absent partial endpoint can no longer hide visible raw content in its successor
gap. Unknown coordinates or missing covering summaries prevent speculative cuts.
Id-only drafts use the existing raw provider's bounded ID/ordinal metadata range;
the guard does not decode historical message bodies. A visible uncovered assistant
or tool endpoint rolls back to its user; absent roles or user anchors prevent a cut.

The exact review reproduction retains `UNSUMMARIZED_REAL_GAP`. Positive
same-message/next-message successor and user/tool-turn controls remain. Older
positive trim fixtures now provide actual summary coverage/coordinates rather than
claiming that a marker alone establishes coverage. Pi keeps its conservative
uncovered-end veto, including precomputed kept entries; OpenCode-specific raw
synthetic-gap certification is not extended to Pi.

## Non-vacuity controls

Each mutation used the prescribed stage/mutate/restore sequence. The live files
were staged first and `git diff --stat` was empty. Each temporary mutation carried
`NON-VACUITY BREAK`; its diff was captured before testing. Restoration used
`git checkout -- <path> && touch <path>` and the final diff was empty. No mutant
was committed. Each named target was the **only** failed test in its selection.

| Mutated production control | Sole red test | Controls that stayed green | During / after restore |
| --- | --- | --- | --- |
| Exclude indexed ends at/below the old summary target ordinal | `r2 proof: a retained partial at the prior target ordinal still vetoes the next cut` | `does not let already-cut indexed ends behind the current marker veto an advance` | `compaction-marker-manager.ts`: 1 file, +2/-6 / empty |
| Remove the early native-head assertion, leaving the later assertion | `r2 proof: a rejected HARD output cannot move the host marker before LKG replay` | `retains pending indexed markers while a healthy SOFT+ serves the frozen representation` | `rust-mode-transform.ts`: 1 file, +1/-1 / empty |
| Remove the durable LKG hydration fence check | `does not hydrate a durable slot while marker rebuilding admission is fenced` | All four other durable-write/prune tests | `lkg-persist.ts`: 1 file, +1/-1 / empty |
| Treat visible ordinal coverage as always true | `r2 proof: an absent partial endpoint cannot hide visible real content in its successor gap` | `trims past a last-block end whose successor starts on the next message` | `v2/fold/boundary.ts`: 1 file, +1/-1 / empty |

## Verification and boundaries

Tools: Bun **1.4.2 (744846f84)**, TypeScript **5.9.3**, Biome **2.5.1**,
cargo **1.99.0 (5f94df478 2026-08-27)**, real OpenCode **1.18.30**.
The module was rebuilt from this worktree; the explicitly selected existing
hermetic daemon reports **ck-subc 0.20.55** (not a freshly rebuilt daemon).

- Plugin typecheck: the package's three tsc invocations pass.
- Seven focused plugin suites: the recovered implementation initially passed
  **457 tests / 4,554 assertions**. The two added admission controls passed with
  all existing fault/rejection controls: **10 tests / 88 assertions**. After all
  mutations were restored, the final seven-suite run passed **459 tests / 4,578
  assertions**, 61.80 seconds.
- Pi marker suite: **11 tests / 18 assertions** pass. Its normal package typecheck
  fails in untouched shared `storage-permissions.ts:151` because Pi's config lists
  only Node ambient types while newer master references `Bun`. The same Pi package
  passes `tsc --noEmit --types node,bun`; no manifest/config workaround is committed.
- Plugin build passes, including **4 V2 loader tests / 19 assertions**.
- Executable Biome check passes on **9 guard/fixture files**, with no fixes applied.
  The one new conditional-format mismatch found by its first run was corrected;
  no existing lint rule or assertion was weakened.
- Real OpenCode 1 suite: **3 tests / 140 assertions**, 187.96 seconds. The 12,900-row
  fixture produces **25 indexed compartments / 24 marker ordinals**, cuts input
  **12,956 → 42**, sends the full **42** after the cut, then just **3** on ordinary
  append. Actual intercepted comparable provider objects are equal; the three
  serializations share SHA-256
  `ae85cf59172640b8f64e6fe0b1c6ceb60342a0e3b31b1dfcdc421438e8842193`.
- The seven-sparse-gap host fixture advances **50 → 140** on genuine HARD.
  Inserting real content at ordinal **85** instead preserves marker **50**, emits
  the precise coverage-gap refusal, and sends **no new provider request**.
- The real producer's **SOFT+ / scheduler-execute / committed=true** control
  preserves pending work and unchanged history blocks.
- `cargo build --release -p mc-module -j 2 --locked` cannot resolve the prepared
  lock against the available sibling versions. One foreground offline build
  succeeds in 2m17s, temporarily updating only sibling package versions
  (`subc-core` 0.20.55→0.20.56, `subc-daemon` 0.31.1→0.32.0, `subc-os` 0.1.5→0.1.6).
  Cargo.lock was staged before this attempt and restored/touched afterwards;
  no Rust source, manifest or lock change is delivered.
- E2E-wide `tsc --noEmit` has **19 diagnostics in unchanged files** (SQLite type
  mismatches, missing SDK `session.get`, older V2 API/option fixtures, an ES2022
  `findLast`, optional strings, retina-local-fs module resolution, and a read-only
  property). None is in the edited marker host test. No unrelated fixes were made.
- A TypeScript compiler-API check rooted at the edited marker host test passes
  with **1 changed file / 0 local diagnostics**. It still reports **1 unchanged
  dependency diagnostic** (`rust-harness.ts`'s SDK `session.get`); this is a scoped
  file result, not a clean e2e-package typecheck.
- AFT's scoped inspection has no TypeScript errors; it is **partial**, because
  its Biome producer and Tier-2 analysis are unavailable; the final snapshot also
  lacked an authoritative report for `compaction-marker-manager.ts` within its
  budget. Executable Biome checks and package tsc are the authoritative scoped
  gates here.

### Reproduction commands

From `packages/plugin`:

```sh
bun run typecheck
bun test src/features/magic-context/compartment-storage-v6.test.ts \
  src/hooks/magic-context/compaction-marker-manager.test.ts \
  src/hooks/magic-context/transform-postprocess-phase.test.ts \
  src/hooks/magic-context/rust-mode-transform.test.ts \
  src/hooks/magic-context/rust-mode-marker-lock-contention.test.ts \
  src/hooks/magic-context/lkg-persist.test.ts src/v2/fold/boundary.test.ts \
  --timeout 30000
./node_modules/.bin/biome check src/hooks/magic-context/rust-mode-transform{,.test}.ts \
  src/hooks/magic-context/lkg-persist{,.test}.ts \
  src/features/magic-context/storage-replay-document.ts \
  src/hooks/magic-context/compaction-marker-manager{,.test}.ts \
  src/v2/fold/boundary{,.test}.ts
```

From the repository root: `bun run --cwd packages/plugin build`. From
`packages/pi-plugin`: `bun test src/compaction-marker-manager-pi.test.ts --timeout
30000`, `bun run typecheck` (baseline failure above), and
`./node_modules/.bin/tsc --noEmit --types node,bun` (scoped ambient-type pass).

From `packages/e2e-tests`, with the worktree-rebuilt module and explicitly
selected existing hermetic daemon:

```sh
MC_E2E_CK_MC_PREBUILT_BIN="$PWD/../../target/release/ck-mc" \
MC_E2E_CK_SUBC_BIN="$PWD/../../target/pipe-only-subc/debug/ck-subc" \
MC_E2E_PLUGIN_ENTRY="$PWD/../plugin/dist/index.js" \
timeout 1200s bun test tests/rust-compaction-marker-byte-identity.test.ts \
  --timeout 900000
```

Every host lsof assertion names only that fixture's throwaway `data/opencode/`
and `data/cortexkit/magic-context/` databases. No live or backup database was
opened for this delivery. All native work was serialized and bounded (`-j 2`);
the heavy build and host gates used foreground waits per worker verification
requirements. No package install was needed after the prepared frozen install.

The unrelated local native-lane failures documented in the round-two review were
not rerun or repaired. This is not a full OpenCode 2 native-suite sign-off or a
paused-in-flight historian race certification. It also does not promise recovery
through real, pre-flag, mixed, empty-part or otherwise unknown gaps: those remain
fail-closed, and may require repair/recompilation rather than a marker retry.

## Round-four follow-up: dispatch and definitely unchanged cuts

Merged master first, bringing in `marker-unfreeze-review-r3.md` and preserving
its report unchanged. Implementation checkpoints are `23fe9ebc81` (wire dispatch)
and `c6326155bb` (verified non-cut availability). The earlier sections describe
round three; the quarantine/retention behavior below supersedes its destructive
pre-attempt LKG invalidation.

### Management dispatch is now constructed by the transport

Recovery explicitly supplies `method:"session.flush"` in the JSON body.
`SubcModuleTransport.call` also derives the dispatch field of flat JSON management
requests from its authoritative `method` argument, including replacing a mismatched
body discriminator. The change preserves reply paging and the intentional MCP
facade protocol: `{name,arguments}` calls must stay method-free, because ck-mc
routes them to a different handler. Pre-encoded byte bodies remain byte-preserving;
the production caller audit found no such caller.

The audit covered all 27 direct `.call(...)` matches in 17 production files and
their dynamic wrapper/builders. Transform/state-sync builders, management RPC and
command handlers, refusal status probes, todo/drop backends, and historian wrapper
calls already carry their management discriminator. Dreamer/memory/tool calls using
`name`/`arguments` are deliberate facade requests, not malformed flat management
calls. Recovery was the missing flat discriminator. No compatibility shim or Rust
dispatch change is introduced.

The new socket regression uses the actual transport, SubcClient authentication,
route opening, frame encoding, and bytes received by a TCP peer. It does not mock
the module client's `.call`. Literal expectations verify missing flush method
insertion, mismatched status-method replacement, and unchanged facade routing.
On the old encoder, this is the sole failure beside the original flat-body identity
control: **1 pass / 1 fail / 9 assertions**.

The real-host reproduction recreates the exact durable version-2 fence and removes
LKG rows/chunks on a valid summarized-history session. It then submits the next
turn, re-arms the fence, restarts OpenCode on the same fixture, and submits another.
Both next passes now report **SOFT / reason=explicit_flush / applied=true /
served_from=transform**, send full input, reach the provider, clear the fence, and
persist one new durable LKG. No manual flag clearing substitutes for admission.
The fixture deliberately ends the harness's frozen zero-TTL setup and seeds a
valid summary; otherwise TTL expiry can produce an unrelated HARD, or an
unsummarized session can produce metadata-only SOFT+. The genuine rebuilding
decision requirement was not weakened to accommodate either preliminary fixture.

### Typed non-commit proof preserves still-safe replay

Host replacement now returns `committed`, `definitely-no-cut`, or `uncertain`.
A failed BEGIN or writer setup never wrote. A callback failure before COMMIT is
definitely unchanged only after the connection confirms the surrounding rollback
completed. A COMMIT failure remains uncertain even when SQLite is idle. Failure
in context.db's marker mirror after the host commit is likewise uncertain.

The strategy carries this distinction in retryable outcomes via
`cut:"definitely-no-cut"`; an omitted annotation remains uncertain, so existing
or alternate strategies cannot accidentally authorize old replay. Already-current
and stale-skip are typed no-mutation results. V2's failed boundary lookup reports
the same definite non-cut proof; its actual recorded-boundary write does not.

The cross-database crash window still requires a durable write-ahead fence while
the host outcome is unknown. Instead of destroying old bytes at this point, the
adapter quarantines them behind that fence. Committed, uncertain, and thrown
strategy outcomes permanently invalidate them. Verified non-cuts retain their
snapshot through the remainder of admission. If later capture or bookkeeping
fails, restoration and fence clearing commit together before old replay is made
available. Failure to restore remains fail-closed. A non-cut on the current retry
cannot clear a fence left by an earlier potentially committed attempt.

Restoration also handles output arrays aliasing the raw input and a new capture
already persisted before late bookkeeping fails. The unadmitted process copy is
evicted before installing the older safe slot; ordinary monotonic row-version
capture checks remain unchanged. Queued old capture cancellation and every
post-commit refusal/restart guard remain in place.

The reverse-order regression holds the real OpenCode writer in a separate process
for seven seconds, with the WAL connection already primed. Host BEGIN cannot
acquire the writer and returns a typed definite non-cut. A later priced capture
fault now serves exactly the previous LKG, leaves no host marker/mirror, clears
the provisional fence, and hydrates the same old snapshot on a new adapter/file
connection. Once the lock/fault ends, a real marker application succeeds. No-op,
stale-skip, persisted-new-capture/late-bookkeeping, and uncertain-result controls
cover the adjacent branches. Existing real post-commit and mirror-failure tests
retain their safe claims; no test was rewritten to invert its contract.

### Round-four mutation proofs and final gates

All mutations staged the live specific files first and captured an empty unstaged
diff, carried `NON-VACUITY BREAK`, captured a non-empty diff, then restored with
`git checkout -- <path> && touch <path>` and captured an empty diff again.
Each named test was the sole failure in its selection:

| Mutation | Sole red test | Green control | During / restored diff |
| --- | --- | --- | --- |
| Remove transport-derived method insertion/replacement | `serializes management dispatch from the call method over the real socket and preserves facade envelopes` | `omits an ambient supervised identity while preserving route identity and flat request bytes` | `module-transport.ts`: 1 file +2/-1 / empty |
| Ignore typed failed-BEGIN non-cut proof | `a busy host cut followed by priced capture failure retains still-safe LKG across restart` | `an uncertain strategy failure never revives quarantined LKG even without a visible marker` | `compaction-marker-manager.ts`: 1 file +1/-1 / empty |
| Trust every retryable failure, including uncertain results | `an uncertain strategy failure never revives quarantined LKG even without a visible marker` | `a busy host cut followed by priced capture failure retains still-safe LKG across restart` | `compaction-marker-manager.ts`: 1 file +1/-1 / empty |

Final results (Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**):

- Plugin package typecheck: **three tsc invocations pass**.
- Ten focused plugin files (the seven original suites plus low-level marker,
  LKG-slot, and module-transport suites): **512 pass / 0 fail / 4,781 assertions**.
- Restored fault/rejection selection: **15 pass / 0 fail / 112 assertions**.
- Executable scoped Biome: **8 non-cut files pass**, plus **3 dispatch files pass**.
- Plugin rebuild: pass, including **4 V2 loader tests / 19 assertions**.
- Final complete real OpenCode 1 marker suite: **4 pass / 0 fail / 168 assertions**,
  209.24 seconds. All original large-cut/byte-identity, sparse synthetic/real-gap,
  and metadata-only SOFT+ claims pass alongside the new live/restarted SOFT recovery.
- Pi's normal package typecheck now passes after the master merge, and its marker
  suite passes **11 tests / 18 assertions**. No Pi config workaround was added.
- The edited host fixture has **0 local TypeScript diagnostics**; its scoped
  dependency graph still has the unchanged `rust-harness.ts` SDK `session.get`
  diagnostic. E2E-wide typecheck and unrelated V2/native lanes were not rerun.
- AFT inspection remains partial because its Biome/Tier-2 producers are unavailable;
  it reports no TypeScript errors. Executable Biome and package tsc are the gates.

Host commands use the same explicit module, daemon, and bundle paths shown above.
The module is the existing worktree-built artifact from the preceding delivery;
Rust sources are unchanged, and the existing hermetic daemon is **ck-subc 0.20.55**.
Every lsof isolation assertion passes. No live database/configuration or backup
store is accessed. No package install, manifest/lock edit, native rebuild, or new
report file is part of round four. Production fixes were checkpointed separately
before this evidence update.
