# Scoped tool sweep executing gate

## Verdict: BLOCK

Updated after merging master `955f54750c03af5339cb70179242489c4fc14166`, including marker atomicity change `41e112a0`. Sequence 11 below passes the new ordinary/refusal paths with both mutation controls red, but independently reproduces a second pre-fix-to-fixed upgrade prefix bust. Both cache-path changes gate the same dist rebuild; the combined verdict remains **BLOCK**. Earlier sequence evidence is retained with its original revision identified; sequence 10 was rerun after this merge and still fails.

Two product defects were executed, not inferred: pre-fix marker-seam upgrade loses a previously served reasoning-only assistant on the first fixed-build defer; clone inheritance discards the adoption marker. A third distinction matters: even fixed-to-fixed restart preserves provider bytes but does **not** preserve the raw transform served array at this seam (an empty dropped-tool shell disappears). No product edits are included.

This is not a complete ten-sequence certification. HARD publication/fold and two-process mid-defer concurrency remain unexecuted. The matrix below explicitly distinguishes actual executions, narrower coverage, and gaps. The observed upgrade failure alone blocks shipment under the requested invariant.

## Executable environment

- Fixed checkout: task base `e27fc7f03b1c9f1a359d8c4ce88f340b3c4486c6`.
- Pre-fix checkout: `/tmp/scoped-gate-prefixed-954`, detached `4f9a3d1a4092bc2a7b914e071045cc54b7baea3e` (merge c138e68a's first parent, not a guessed relative master ref).
- Real host: `opencode --version` returned `1.18.30`; Bun `1.4.2`.
- `bun install --frozen-lockfile` run in both worktrees. No manifest/lockfile changes retained. The old checkout shares the installed root dependency directory via symlink; its product source is the detached pre-fix revision.
- Real `createTransform`, actual SQLite stores, fresh objects per transform call. Real-host probe restarts the process with `existingEnv`, preserving **both** host history DB and MC context DB, replacing only the plugin entrypoint.
- Captures distinguish raw hook arrays (unmodified JSON SHA256) from provider-message prefixes (only `cache_control` omitted, as in the existing host regression). These are not interchangeable claims.

## Sharpest finding: sequence 10, upgrade

Run:

```sh
MC_PROBE_UPGRADE_FROM=/tmp/scoped-gate-prefixed-954/packages/plugin/src/index.ts \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

Named red: **scoped gate upgrade preserves pre-fix priced marker-seam prefix**.

Final capture: `/tmp/scoped-upgrade-pin-954.log:4,14-18`:

```
aSha256=bee64b0dac82416d02dc871d1f7283ebfe0c658002961ecdf7a46490ea2745b5
bPrefixSha256=5dfa98ab1ffbe09f0a0d63b4a5eb11a53fd0afa4cba6a05d86c0fdc239bf809c
firstDivergence=50 targetA=51 targetB=-1
hookASha256=c36538b1bca6348ac51c60d7585ff260042d8af58da56fe8fafc808c3100cfba
hookBPrefixSha256=cce6233cf4cfc50708bd4ceadc3ef7b3c4fc88071823b6b7fd14d4920269368e
hookFirstDivergence=4
(fail) scoped gate upgrade preserves pre-fix priced marker-seam prefix
```

Full retained artifacts: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-ZHhXiu/` (before/after hook arrays, provider bodies, pre-upgrade ledger, pre-upgrade scheduler log, combined log, host/DB locations, gate-evidence.json). Test reaches the prefix hash assertion after proving pre-upgrade marker drain at ordinal 4, `decision=execute`, fixed-build `decision=defer`, no adoption marker in the pre-upgrade ledger, and target present in A. Thus this is not a failed fixture setup masquerading as the intended red.

The old priced seam pruned the tagging copy, leaving the reasoning-only assistant in the served array. Restarting on fixed code without an adoption marker replays the global sweep against the live array and loses that assistant. This is a real provider-prefix bust, not merely changing host metadata or cache-control. The pre-fix non-seam behavior differs: the legacy sweep in the direct transform arm already removes the assistant; three fixed legacy defers correctly preserve its absence. The non-seam arm was not separately run using an old-build priced process; it is the shipped legacy replay arm, not a claimed second cross-version execution.

### Required fix direction (not implemented)

Pre-adoption, select the sweep variant by the **last served bytes**, not a global default. TS durable `lkg_slots` (migration v81) records that prior array. Compute the old and scoped candidate arrays on a no-marker defer; choose the candidate whose prefix matches the durable LKG. Persist adoption on that defer **only** when scoped is the matching replay: this is reproducing previously served bytes, not first application of a mutation. Preserve the old variant when it matches. Explicitly decide fail-closed behavior for missing LKG and neither-match cases; do not silently call those cache-safe.

The fix must make this population-countable: emit a structured/stable event key **`tool_sweep_lkg_mismatch`**, session id, and condition **`lkg_absent` / `matched_old` / `matched_scoped` / `matched_neither`**. These outcomes must be aggregatable as counters over sessions/passes, not only a prose log that an operator can read. Pins must cover all four outcomes and both pre-fix seam and non-seam histories. Raw empty-shell geometry at the seam must be accounted for when matching the LKG; reasoning presence alone is not an array equality check.

## Sequence matrix

### 1. Legacy defer ×3, priced adoption, defer ×3 — PASS (direct transform)

Named test: **createTransform > adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (soft-execute)**.

`/tmp/scoped-pass-kinds-954.log:4-11`:

- legacy-1/2/3: `04006c59b8c824f3eef0bc3cf0de256c708fa9e0e988069efbe8c087fff3677d`, divergence `-1` each; reasoning assistant absent, no marker.
- soft-execute: `6608ad23b947b71e9f07ffde97bd7d22ac6167c2acadabccd5e80752cf26b383`, first divergence `25`; assistant restored, marker set.
- adopted-defer-1/2/3: same `6608...6b383`, divergence `-1` each.

These are complete raw served arrays, not only target-presence assertions. Comparison against an independently executed historical master binary was not done. Mutation controls: global-sweep rollback and unconditional adoption, below.

### 2. Bust permissions — PARTIAL

Same named parameterized test, suffixes **soft-execute**, **explicit-flush**, **force-band**: all three pass and flip the flag. Explicit-flush drives `historyRefreshSessions` permission (not the command parser); force-band drives 99% live usage while scheduler remains defer. Their preceding three low-pressure defers do not flip. Their priced hashes and following three defer hashes equal the soft-execute values above. Captured `/tmp/scoped-pass-kinds-954.log:15-19,23-27`.

HARD fold/publication was not driven. This is not evidence that every possible bust permission adopts. No end-to-end `/ctx-flush` command dispatch claim is made.

### 3. Actual restart, same DB — provider PASS, raw-array FAIL

```sh
MC_PROBE_UPGRADE_FROM="$PWD/packages/plugin/src/index.ts" MC_PROBE_EXPECT_ADOPTED=1 \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

Named red: **scoped gate restart preserves adopted priced marker-seam prefix**.

`/tmp/scoped-restart-pin-954.log:4,14-18`:

- provider A and B prefix: `c55f141abd94e526007e1442ce797c3630c98b51ee00986384adc1db8f3155f4`, divergence `-1`, target `51 → 51`.
- raw hook A: `af13149013e1e53e5c0197be29d3d7656e73c9d2f32dcfbf44eb0becfa52951c`.
- raw hook B prefix: `2b5533f776811456a6c70d7b8bb3370f9344529e11291590b363e0add0106a7b`, divergence `4`.

The marker was persisted before killing the first host. Index 4 of A is the fully dropped tool owner reduced to an empty text shell; B has spliced that row, shifting the next tool owner left. Provider conversion removes this shell, hence wire equality despite hook inequality. Do not report this as raw-array byte-identical. Artifacts: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-jkvDIH/`.

### 4. Fixed marker seam and copy/live rollback — provider PASS / mutant RED

Named test: **marker-seam full-tool replay preserves the reasoning-only assistant on defer**.

Restored product: `/tmp/scoped-seam-green-954.log:4-5`, `CKIOS marker replay prefix sha256=bee64b0dac82416d02dc871d1f7283ebfe0c658002961ecdf7a46490ea2745b5 messages=53`.

Mutation restored the global sweep, which prunes only the tagging copy on the seam and the live array on the following defer. `/tmp/scoped-mut-seam-954.log:13-17`: target expected `51`, received `-1`; only this test failed (existing dropped-boundary todo not executed). Restored before subsequent checks.

### 5. Full versus mixed owner — PASS with scope caveat

- Real transform fixture's full tool owner is older than 24 filler messages and is asserted absent after replay.
- **scoped gate mixed owner retains surviving text while full owner is spliced** invokes the actual batch: `SCOPED_GATE full owner spliced; mixed owner survives`. Disabling `splice` reddens exactly this test, `/tmp/scoped-mut-owner-954.log:16-19,39` (unexpected `full` owner with `parts: []`).
- Mixed-owner branch is a batch-level test, not an additional real-transform mixed-owner scenario. The marker-copy raw-array exception is documented under sequence 3, not concealed by this passing batch test.

### 6. Pre-fix reader tolerance — consumer PASS; stronger wording is false

```sh
MC_GATE_OLD_ROOT=/tmp/scoped-gate-prefixed-954 \
  bun test packages/plugin/src/hooks/magic-context/tool-sweep-clone-gate.test.ts --todo
```

Named test: **scoped gate pre-fix reader tolerates reserved ledger entry**. Imports the actual detached checkout's storage reader and reasoning consumer; reads an actual current SQLite ledger.

`/tmp/scoped-clone-reader-954.log:21-22`: `SCOPED_GATE pre-fix reader entries=["@tool-sweep-scoped"] stripped=0`.

Important: the old reader **returns** the marker in its generic set. It does not classify/filter it as control data. The consumer selects no real message because no message has that reserved ID. Thus “without throwing and without stripping an unrelated assistant” is executed; “reader never treats this as an ID” is not true literally. No mutation control was run for this arm.

### 7. Clone — FAIL

Named expected-red todo: **scoped gate adopted clone retains priced sweep policy**; run the command above with `--todo` to execute it (Bun reports todo and exits zero despite the captured assertion failure).

`/tmp/scoped-clone-reader-954.log:4-6,16-20`:

```
SCOPED_GATE clone source_adopted=false inherited=false
SCOPED_GATE clone source_adopted=true inherited=false
Expected: true
Received: false
```

The fixture uses the actual `copySessionStateForClone` with maximally permissive inclusion filters. The clone helper's `clonePiContentDecisions` drops anything not decoding as a Pi content decision, including this reserved marker. Pre-adoption clone remains legacy as required. A later source adoption after clone creation was not separately raced/executed. Defect is already present without any mutation; no speculative product repair is included.

### 8. Two-process mid-defer concurrency — NOT EXECUTED

No atomicity claim. Restart is not concurrency and is not used as a proxy. This remains an explicit gate gap; a controlled barrier after policy selection and before finalization is required to exercise both interleavings against one SQLite session.

### 9. Pi — PASS / mutant RED

Named test: **createPiTranscript > scoped gate Pi finalization preserves unrelated reasoning-only assistant**. Executes actual transcript tagging, tool target drop, commit, and `finalizeToolRemovals`. Tool arc disappears and unrelated signed-thinking assistant remains byte-equal.

Captured line: `SCOPED_GATE Pi removed tool arc; unrelated reasoning retained`. Mutation extending finalization to all assistant rows produced `Received: []`, only this named test failed (`/tmp/scoped-mut-pi-954.log:9-44`).

## Mutation ledger

All mutations used `NON-VACUITY BREAK`, staged the live implementation first, confirmed empty unstaged diff before mutation, captured non-empty diff while mutated, restored via `git checkout -- <path> && touch <path>`, then confirmed empty unstaged diff. No mutant is retained.

| Control | Changed path / non-empty stat | Exact red test | Other failures |
|---|---|---|---|
| Scoped predicate → global | tool-drop-target.ts, +2/-1 | adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (original unsuffixed test before parameterization) | none; 61 filtered |
| Copy/live global-sweep seam | tool-drop-target.ts, +2/-1 | marker-seam full-tool replay preserves the reasoning-only assistant on defer | none; one unrelated todo |
| Ignore canAdopt permission | tool-sweep-policy.ts, +1/-1 | adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (soft-execute) | none; 63 filtered |
| Disable empty-owner splice | tool-drop-target.ts, +1/-1 | scoped gate mixed owner retains surviving text while full owner is spliced | none; two filtered |
| Pi prune every assistant | transcript-pi.ts, +1/-1 | scoped gate Pi finalization preserves unrelated reasoning-only assistant | none; other tests filtered |

The upgrade/clone defects are unmutated reds, not claimed as mutation controls. Reader tolerance, individual flush/force arms, and restart do not each have independent mutation proofs; the listed controls must not be inflated into full matrix coverage.

## Verification and retained pins

- Plugin and Pi package typechecks passed after final TypeScript edits.
- E2E package typecheck initially caught and fixed new `SpawnOptions` literal widening. Remaining errors are unrelated baseline errors in rust-harness.ts, opencode2 tests, rust-timeout-epoch-recovery.test.ts, retina-local-fs resolution, and readonly `[ignore]` assignment in command-handler.ts; recorded in `/tmp/scoped-e2e-tsc-final-954.log`.
- Passing targeted transform, policy, Pi and old-reader checks; existing real-host seam regression passes after mutation restoration.
- Upgrade and raw restart pins intentionally red when enabled with the environment shown. Clone defect is an executable todo, matching the nearby existing known-defect convention. No passing test was rewritten into the opposite claim.
- The report and test/harness changes are the deliverable; there are no product changes, no architecture edits, and no broad build/lint claim.

## Sequence 11: marker drain / delivered trim atomicity

### Executed revisions and harness

`git merge master` was performed from a clean gate branch; master resolved to `955f54750c03af5339cb70179242489c4fc14166`. `git merge-base --is-ancestor 41e112a0 HEAD` returned success. No product changes were made by this follow-up: the new product implementation is inherited from that merge.

A separate detached worktree at `/tmp/marker-gate-prefixed-954` holds `e27fc7f03b1c9f1a359d8c4ce88f340b3c4486c6`, before the atomic marker/trim fix but after scoped-sweep adoption. Frozen dependency install passed there. All three arms below use OpenCode 1.18.30, the actual TS plugin, actual host/context SQLite stores, and actual marker application—not mocked marker strategies.

### 11a. Fixed-to-fixed dropped-boundary arm — PASS

Command:

```sh
bun test packages/e2e-tests/scripts/ckios-reasoning-only-probe.test.ts
```

Named test: **dropped marker boundary must not advance before the served prefix is trimmed** (now an ordinary enabled test from master).

Captured `/tmp/marker-final-green-954.log:6-7`:

```
MARKER_GATE dropped-boundary A=3c942dca884841e71c21a2ffce5815f6b0e20bc81411385b02d817682f568a33 B_prefix=3c942dca884841e71c21a2ffce5815f6b0e20bc81411385b02d817682f568a33 first_divergence=-1
(pass) dropped marker boundary must not advance before the served prefix is trimmed
```

The existing assertion also verifies the served prefix does not retain `[dropped §3§]`. Hashes here are provider-message prefixes with cache-control omitted. This statement does not claim raw hook equality.

### 11b. Pre-fix drain A → fixed-build defer B — RED, BLOCK

Command:

```sh
MC_GATE_BOUNDARY=1 MC_PROBE_EXPECT_ADOPTED=1 \
MC_PROBE_UPGRADE_FROM=/tmp/marker-gate-prefixed-954/packages/plugin/src/index.ts \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

Named red: **marker boundary upgrade preserves pre-fix priced drain prefix**.

The test verifies the seeded boundary is an assistant containing a tool part; exactly one tool tag owns that assistant and is `status=dropped, drop_mode=full`. Before reaching the equality assertion it proves pre-fix A logged `decision=execute` and marker application at ordinal 6, the ledger already contains scoped-sweep adoption, and fixed B logged `decision=defer`. The old process is terminated and the fixed process reuses its exact host/context DB directories.

Captured `/tmp/marker-upgrade-final-954.log:4,14-18`:

```
aSha256=eb70b689dd32b491c2a83e20b227d485b1f9542cf9144c98cdfff8ec42dc4755
bPrefixSha256=b12474fd3383f00ce2c3cc357cca193fab52d119773c1a0df900d6e2edd86829
firstDivergence=1 targetA=53 targetB=49
hookASha256=72bbe23243a3fbc1176a81ffb43c7c8661f82b758743da16921bc62ae7cbfe02
hookBPrefixSha256=8fc0ceec05ce5d3ed3c071f48c4532f4b73ea6a8dfcc7c9b26251e69ee5eab73
hookFirstDivergence=3
(fail) marker boundary upgrade preserves pre-fix priced drain prefix
```

Eleven assertions ran; only the final provider-prefix assertion failed. Full captures, including the boundary-owner/tag proof, are retained at `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-g492jI/`.

This is independent of the missing scoped-sweep marker in sequence 10: adoption is already present here, and the reasoning target survives, but moves four provider entries left. The old code priced and committed a boundary without removing all older served rows. The upgraded host's defer reflects the persisted marker and omits those previously served rows. Correct future atomic drains do not retroactively price that transition. An upgrade replay/migration strategy must address already-committed marker state versus the durable last-served prefix; simply refusing future unproven drains does not satisfy this historical-byte gate.

### 11c. Unprovable trim refusal → next provable pass → defer — PASS

Command:

```sh
bun test packages/e2e-tests/scripts/tool-sweep-marker-refusal-gate.test.ts
```

Named test: **marker refusal preserves persisted row until next provable pass advances once**.

The before-plugin injects one id-less user row into index 2 of A only. This intentionally invalidates immutable source-order proof outside the permitted synthetic head. It does not mock the transform, SQLite persistence, or marker strategy. A remains a priced pass. Its response reports high usage so the immediately following clean pass can price a successful trim. A final low-usage defer checks no second marker advancement.

Captured `/tmp/marker-final-green-954.log:10-14`:

```
MARKER_GATE pass=0 sha256=07b137f17377b41ec39d574cd936c9f7106dee0d56c01799e9c1e3043f673eca first_divergence=-1
MARKER_GATE pass=1 sha256=266ea38bc619bc68710e76c03cfcdafe271a3b0b93a355d391921d90fb3c3a4c first_divergence=1
MARKER_GATE pass=2 sha256=ce3208ccaa237e6165feaf40f88a2d2d891f43f2d728997e3837bfaf0281c476 first_divergence=-1
(pass) marker refusal preserves persisted row until next provable pass advances once
```

The complete serialized marker columns are asserted equal before/after refusal: `compaction_marker_state` stays the empty string; the exact pending ordinal-6 blob stays unchanged. On retry, pending becomes null and persisted `boundaryOrdinal` becomes 6. After the subsequent defer, both serialized columns equal the retry snapshot exactly. The log contains exactly one `compaction-marker drain: applied at ordinal 6`.

Self-describing refusal records were captured in the first successful run at `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/marker-refusal-gate-MHedte/marker-dropped-boundary.log:1820,1825,1887`:

- `prefix trim: boundary ...; pass=priced; no in-pass trim applied (source message at index 2 has no stable id outside the synthetic head)`.
- `compaction-marker drain: refusing ordinal 6 because prefix trim through ... was not proven; preserving deferred history refresh signal`.
- One subsequent `compaction-marker drain: applied at ordinal 6`.

Final restored-product artifacts: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/marker-refusal-gate-K8Kdw2/`. The changing complete pass-2 hash includes newly appended messages; its previous-prefix divergence is `-1`, not a claim that whole arrays of different lengths match.

### Sequence 11 mutation proofs

1. **Exact-ID-only rollback:** force `trimToPreparedPrefix` to take its exact-live-ID fallback rather than immutable source-order proof. `inject-compartments.ts` changed +1/-1 with `NON-VACUITY BREAK`; staged live state was clean first. `/tmp/marker-mut-exact-id-954.log:13-17`: **dropped marker boundary must not advance before the served prefix is trimmed** fails because A still contains `[dropped §3§]`. Exactly one failure, one unrelated test filtered. Restored via checkout plus touch; unstaged diff empty afterward.
2. **Commit despite non-applied trim:** change `deliveredPrefixWasTrimmedThroughPendingBoundary` so a delivered result with status other than `applied` can prove the boundary. `transform-postprocess-phase.ts` changed +1/-1 with `NON-VACUITY BREAK`; staged live state was clean first. `/tmp/marker-mut-refusal-954.log:18-28`: **marker refusal preserves persisted row until next provable pass advances once** fails at the *persisted state comparison*, not merely the log assertion: marker advanced from empty to ordinal 6 and pending was cleared on the refused pass. Exactly one failure. Restored via checkout plus touch; unstaged diff empty afterward.

Both ordinary host tests and the refusal/retry test then passed together: `/tmp/marker-final-green-954.log:16-19`, `3 pass, 0 fail, 20 expect() calls`.

### Combined rebuild gate

The original scoped-sweep upgrade was rerun after merging the second fix. `/tmp/scoped-upgrade-postmerge-954.log:4,18` still shows provider divergence 50, target `51 → -1`, and the same `bee64...` versus `5dfa...` hashes. Therefore neither the first BLOCK nor the second upgrade red is stale evidence against only the superseded base.

E2E TypeScript check was rerun after the final new assertions. `/tmp/marker-e2e-tsc-final-954.log` contains the same twelve baseline diagnostics in unrelated rust-harness/opencode2/retina resolution/command-handler paths; none name changed gate scripts. The executable host gates run the changed scripts directly. No product files or package manifests/lockfiles are changed by this follow-up, beyond the explicitly requested merge of master.

Final tightening: the upgrade test now checks only log bytes appended **after** the pre-restart capture for `decision=defer`, and rejects `decision=execute` in that suffix. `/tmp/marker-upgrade-restart-proof-954.log:4,18-22` still fails at provider-prefix equality after 12 assertions, with identical provider hashes and divergence index 1. Artifact directory: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-jnDaBA/`. `bun run --cwd packages/plugin typecheck` passed on merged master; final E2E tsc retains only the documented baseline errors. Comment review found no unclear new comments.
