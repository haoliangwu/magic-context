# Rust-mode bridge performance audit: measurements and verification

Baseline: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. Measurements preceded the
corresponding production edits. Bun 1.4.2, TypeScript 5.9.3, macOS. No live host,
live database, credentials, config, cache epoch, or persisted format was changed.

**The initial verification gap is closed.** The complete Rust manifest is green,
the requested baseline/branch served-wire differential is identical, and the Pi
startup cases pass in isolation on both baseline and branch. The original
failed runs remain recorded below rather than erased; the final follow-up
sections distinguish their load-sensitive failures from the successful gates.
Five narrow optimizations are committed; several expensive findings remain
unchanged because the proposed shortcut breaks an identity/isolation fence or
changes request bytes. The table distinguishes those from the actual fixes.

## Instrument and measurement limits

Run `timeout 240 bun packages/plugin/scripts/perf-audit/rb-bridge.ts` from the
worktree root. The script creates an in-memory migrated database and a throwaway
XDG/config/log root, then removes the root. It starts no real host. Copy the same
script into a baseline checkout to repeat the before measurements; the pending
drop probe falls back to the baseline predicate when the scalar API is absent.

History fixtures contain 1,000 / 10,000 / 60,000 short text exchanges, with a
nested completed tool every tenth message, Unicode, quotes and newlines. Their
JSON is 145,880 / 1,469,780 / 8,879,780 UTF-8 bytes. Samples are medians after one
warmup: seven samples normally, five for forced envelopes, three for cold seeds
and large packing, 31 for no-change logging and unchanged metrics updates.
The >48 MiB packing fixture has 60,000 messages and 55,608,955 bytes, producing
two pages. These are microbenchmarks, not provider-latency measurements.

For `noteEntry`, the slot's JSON prefix is deliberately `[]`: that isolates input
validation even when a full large slot would hit the existing heap budget. The
sidebar fixture has an actual cached-m0 blob and up to 10,000 lines of docs.
The pending-op fixtures deliberately stress a large queue; real queues are
usually much smaller. Empty-state retention is measured for 1,000 **sessions**,
not 60,000 messages. Populated wire-cache retention and real HTTP probe latency
remain unmeasured. RB-16's directory lookup and refusal polling were inspected,
but not timed. Those limitations must not be mistaken for zero costs.

## Findings

Times below are milliseconds per operation on the 60k fixture unless specified.
An unchanged row has a baseline cost, not a claimed improvement.

| ID | Classification | Before → after / fixture | Commit | Test / evidence | Notes |
|---|---|---|---|---|---|
| RB-1 | POLICY: capture identity; CPU cost confirmed | stringify 8.380, persistence 28.901; **one** metadata row write per new capture, not all chunks | — | Persisted slot hashes unchanged | Keep captureSequence and rowVersion. Removing sequence from the fingerprint can leave the durable slot identified as an older captured request. The Pi measured-fit rule explicitly compares request and slot identities. No LKG change attempted. |
| RB-2 | CONFIRMED, stopped on wire/attempt identity | forced envelope + transport stringify 156.455 | — | Three baseline request hashes | Raw-byte digest is not the existing canonical page digest, and the content-addressed envelope allows completed-request adoption. Changing either breaks the no-request-byte-change rule. No protocol/cache-identity change attempted. |
| RB-3 | CONFIRMED, not fixed | noteEntry 659.055 (1k: 15.712; 10k: 137.926) | — | Existing LKG failure/replay tests in plugin suite | Lazy hashing after failure would observe an input the transform already mutated. Adapter signatures cannot replace exact pre-entry content proof without additional detached ownership/equality machinery. The shortcut was not applied. |
| RB-4 | POLICY: mutable-container isolation | full clone 38.485 | — | Existing native-output delta/postprocess isolation tests | Postprocess can edit older reasoning/markers, not just the replacement suffix. Sharing mutable cached prefix containers is not sound without a wider copy-on-write refactor. |
| RB-5 | POLICY: exact prefix fence | exact snapshot comparison 7.611 | — | Prefix mutation guard and multi-MB steady-budget tests | The full prefix already compares detached tokens directly, without hashing. messageCacheSignature is for the last message, not every prior message. A cheap lossy signature is not an exact prefix proof. |
| RB-6 | NEGLIGIBLE on measured stage | watermark payload 0.249; three raw queries 0.035 vs proxy 0.202; 32 schema PRAGMAs across 8 proxy probes | — | Prepare/PRAGMA counters in instrument | WeakMap misses are real, but under 1 ms per pass here. Per audit rules, do not change this quick-win solely on static reasoning. |
| RB-7 | NEGLIGIBLE serialization component / wire-policy stop | 300k mural duplicated; probe serialization 0.019 | — | Forced-envelope request hashes | No field removal or acknowledged-hash substitution: those alter bytes sent to ck-mc. This measurement does not measure network bandwidth. |
| RB-8 | CONFIRMED: BPE component fixed | 3.048 → 0.245; 1k 0.351 → 0.021; 10k 3.909 → 0.271 | `83f6ea5b5d` | reuses exact block token counts and recounts a changed sidebar block | Reuse the existing bounded exact-text/tokenizer-identity memo. Other subitems unchanged: SELECT * 2.418 (includes m0 bytes actually needed), unchanged UPDATE 0.028, status-lane latency unmeasured. |
| RB-9 | POLICY: state recovery obligations | ~951,667 heap bytes for 1,000 empty session states | — | Heap delta instrument; populated cache not measured | Evicting the whole session also loses frozen-replay/health-pass/fit/ordinal obligations; it is not demonstrably only a full-wire miss. No new recovery/cache format or eviction policy introduced. |
| RB-10 | POLICY: fresh pressure verdict | permission evaluator CPU 0.004; 16 SDK reads for 8 probes; no real network timing | — | reuses the persisted todo verdict on defer and probes a permission flip at execute pressure | Fresh pressure probes are the tested contract. Rate limiting can miss a permission flip at the pass that prices new todo bytes. Parallelization was not implemented without a green real Rust lane. |
| RB-11 | CONFIRMED: queue probe fixed | materialization 16.588 → scalar predicate 0.001; 1k 0.356 → 0.001; 10k 3.133 → 0.001 | `a3f43d6670` | probes pending drops with a scalar read instead of materializing queue rows; malformed/real-number cases | EXISTS uses the same valid-drop predicate as getPendingOps. Other reads unchanged: two overflow reads 0.011, and the later read must observe intervening recovery writes. |
| RB-12 | CONFIRMED: overlap fixed | 2 → 1 simultaneous tick bodies with maintenance held across two interval callbacks | `9b189a107b` | does not overlap maintenance ticks and releases the guard after completion | A process-local guard covers the whole tick and clears in finally. Registration/snapshot duplication was not separately optimized. |
| RB-13 | CONFIRMED: comparator serialization fixed | cold strip seed 430.018 → 70.021; 1k 6.237 → 1.492; 10k 66.312 → 7.842 | `3688b59e93` | sorts canonical seeds byte-identically with one key read per seed | Precompute canonical sort keys for pending drops, auto-search hints and strips. Keep localeCompare and stable ties. No seed order or identity change. Other cold-start serialization remains. |
| RB-14 | CONFIRMED: discarded-page hashing fixed | 533.277 → 363.489; 55.6 MB, two pages | `c5c45d1c8f` | hashes only stabilized pages while preserving canonical digests and wire sizes | A 64-byte placeholder is used only for admission; compute original canonical digests on final pages. Packing still converges over multiple passes. No new byte digest or page format. |
| RB-15 | NEGLIGIBLE | no-change detail/log-buffer pass 0.008 | — | 32 no-change samples, throwing client proves no module I/O | Logger buffers writes; a log call is not one disk write/fsync. No production logging-policy change. |
| RB-16 | POLICY / cold action; timing incomplete | full JSON prefix parse for m0: 25.747 | — | Prefix parser instrument and existing served-m0 tests | This is a summary/read action rather than steady transform work. Negative-caching a failed host directory read or backing off refusal probes changes recovery timing; leave unchanged. No claim that those network paths were measured. |

## Identity and parity evidence

`rb-byte-baseline.json` records hashes captured on the untouched baseline, not
hashes computed from the optimized implementation as expected values. Comparing
each hash with the corresponding current script row yielded **13 identical
checks**: three persisted LKG slots (capture sequence/time/version included),
three forced-envelope request wires including accept_reply_pages, three token
result objects, three complete cold-seed payloads, and the 55.6 MB multipage wire.
This is a request/persistence comparison, **not a passing real provider replay**.

The only reused token memo is keyed by the entire exact block string and the
active tokenizer object. Content edits miss; tokenizer fallback/replacement
invalidates old counts. It is already bounded at 64 entries and 8 MiB. OpenCode
and Pi both call this shared breakdown, so no twin implementation diverges.
Sort keys and page finalizers are local to one invocation and cannot survive an
input change. Rust receives the same page/seed bytes and digest algorithm.

Reviewed Pi/LKG history before declining RB-1, including `124c05b09d` (preserves
measured resend identity on unchanged captures), `a37229d8c2`, and recent
lkg-slot history. `notePiLkgProviderUsage` checks request captureSequence;
unchanged captures deliberately refresh the in-memory slot identity. Removing
the durable identity update is not an audit-safe dedupe change.

## Verification and non-vacuity

- `timeout 900 bun run --cwd packages/plugin test`: Bun 1.4.2, **6773 pass,
  4 skip, 0 fail**, 651 files, 203530 assertions. Frozen install unchanged.
- `timeout 180 bun run --cwd packages/plugin typecheck`: TypeScript 5.9.3,
  passed all three configured compilation projects, including audit scripts.
- `timeout 180 bun run --cwd packages/plugin lint`: checked 1199 files,
  no errors; one existing warning and two existing infos.
- `timeout 300 bun run build`: passed plugin/Pi/CLI builds and the four v2
  loader tests; regenerated output did not dirty tracked generated files.
- `timeout 600 bun run --cwd packages/pi-plugin test`: **1506 pass, 3 skip,
  5 fail**, 139 files. All failures were untouched runtime/lifecycle tests in
  index-in-process-latch.test.ts. A single-file rerun had 15 pass and two 15-second
  startup timeouts. This suite is **not green**; baseline causality is not proved.
- Pi typecheck passed; Pi lint checked 225 files with one existing warning.
- After mutations were restored, the five affected unit files had 83 pass and
  one existing inventory test hit Bun's default 5-second timeout; rerunning only
  module-state-sync.test.ts with the package's 30-second timeout gave 25 pass,
  0 fail. No source/test rewrite to hide that timeout.
- Comment review and git diff --check passed before commits.

Each of the five performance fences was independently neutralized with a
`NON-VACUITY BREAK`, after staging the exact live state. Each two-test run had
exactly its named new test red and the named control green. Every mutation had
a non-empty unstaged diff while applied and an empty diff after
`git checkout -- <path> && touch <path>`; no mutant was committed.

| Neutralized control | Red test | Green control |
|---|---|---|
| Sidebar memo | reuses exact block token counts and recounts a changed sidebar block | measures each m[0] slice from the rendered bytes and retires Facts |
| Scalar pending probe | probes pending drops with a scalar read instead of materializing queue rows | probes only valid session-local drops, including real-valued number fields |
| Tick overlap guard | does not overlap maintenance ticks and releases the guard after completion | stale same-directory cleanup preserves the replacement registration |
| Cached comparator keys | sorts canonical seeds byte-identically with one key read per seed | carries frozen placeholder, stale-reduce, and image ids plus the tag watermark |
| Deferred page digests | hashes only stabilized pages while preserving canonical digests and wire sizes | hashes map slices with the Rust canonical page digest |

## Initial tool issues and blocked next action (resolved below)

`timeout 3600 scripts/run-rust-hermetic-e2e.sh` exited **124**. Its first suites
could not finish harness construction: ck-mc release compilation repeatedly
reported `prefrontal-build-slot: ... 6 slots, all busy; queued behind other
worktrees' builds`. Each file hit its 600-second setup ceiling and the script's
built-in retry; the outer one-hour cap expired during the context-limits retry.
The cache-invariants/cache-stability failures were before/after-hook failures,
with secondary `h.dispose` errors because no harness existed. No Rust assertion
pass is claimed, and no second heavy build was started. No own task process
remained after timeout.

**Next action at initial delivery (now completed below):** after shared compile
slots are available, run the required Rust
hermetic lane on this branch, then the before/after served-wire replay against
`ee9d829`. Alternatively supply the harness a matched current-tree prebuilt
module/daemon pair via its existing prebuilt environment seams. Resolve the two
Pi startup timeouts before claiming full parity. The pure-replay differential
was not launched into the same unavailable build lane. No Rust crate source or
Cargo.lock changed, so additional crate clippy/test gates were not run.

AFT inspect returned PARTIAL because it could not locate Biome through its
daemon environment and Tier-2 analysis was unavailable. The real package lint
and typecheck commands above are authoritative. No todowrite tool was exposed
in this worker's tool set.

## Follow-up: ordinary prebuilt Rust lane

The ordinary lane completed in the background in **1,623 seconds**, exit 0:
**108 pass, 154 mode-inapplicable skips, 0 fail across 54 manifest files**.
There were no recovered retries. Every file ran through
`scripts/run-rust-hermetic-e2e.sh`, selected sequentially with its existing
`MC_E2E_SHARD=i/57` seam. The three specialized fixture files were deferred, not
silently removed from the required coverage: rust-timeout-double-hard,
rust-timeout-epoch-recovery, and rust-oversize-reply.

The parent authorized the installed default module build
`49a120bd771d42f0ec7b780d8a1f43b2c557ad24`. The supplied `magic-context.current`
pointer had been renamed; the versioned staging binary was copied instead.
`git diff ee9d829 49a120bd -- crates` confirms that only a test comment differs.
Both executables were copied into this worktree's ignored throwaway `tmp/` root
before execution; no binary was run from staging:

- `MC_E2E_CK_MC_PREBUILT_BIN`: copied default module, SHA-256
  `93cb867a9500bae09fd4b73fe3a62905856d6cf13a43274c1d679fe998711567`.
- `MC_E2E_CK_SUBC_BIN`: copied installed ck-subc 0.20.55, SHA-256
  `4a352dc54897efa6e39fb71e48216e8d9d4a20e1bc4b832526fff3a200d95fb9`.

`lsof -p 76293 -Fn` on an OpenCode host descended from this lane's own runner
showed only throwaway `opencode-e2e-joDhE0/data/` database descriptors (OpenCode
and Magic Context context.db, including WAL/SHM). A checked denylist found no
live OpenCode/Magic Context store or user config descriptors.

The parent then authorized one package-scoped build of the two missing fixture
binaries. `cargo build --release --locked -p mc-module --features drive-fault
--bin ck-mc --example slow_transform_probe` completed successfully with cargo
1.99.0 and both artifacts were copied into the same throwaway root. The build
was not cut off and does not need restarting. No other crate/package build ran
concurrently with it. Fixture SHA-256 values:

- drive-fault module:
  `11886e4f4fc621406ba730879f98fdac00688cf56abb978d3a5df7b1e1155a70`.
- delayed synchronous-dispatch probe:
  `674cf1a43f6eee6b0b205b5a9550c40278217829cba20b167943e7466fa3eac9`.

The production module is not substituted for either fault/probe fixture.

## Follow-up: specialized fixtures and complete Rust coverage

The remaining files ran sequentially through the same script and shard seam,
with `MC_E2E_CK_MC_DRIVE_FAULT_BIN` set to the real drive-fault artifact and
`MC_E2E_SLOW_TRANSFORM_PROBE_BIN` set to the real delayed-dispatch artifact:

| Manifest shard | File | Result |
|---|---|---|
| 38/57 | rust-oversize-reply.test.ts | 2 pass, 0 fail: screenshot output above 4 MiB is byte-identical without disconnect; health responds within 1 second during deliberately slow synchronous dispatch |
| 50/57 | rust-timeout-double-hard.test.ts | 1 pass, 0 fail |
| 51/57 | rust-timeout-epoch-recovery.test.ts | 1 pass, 0 fail |

This background phase completed in 176 seconds, exit 0, without retries.
Combined with the ordinary phase, **all 57 Rust manifest files are covered:
112 pass, 154 mode-inapplicable skips, 0 fail**. The phases were disjoint and
sequential; no file was silently excluded and no test fixture was substituted.
All package source and Cargo.lock remained unchanged during follow-up.

## Follow-up: served-wire differential

With the copied default module/daemon pair, ran:

```sh
timeout 1800 bun packages/e2e-tests/scripts/pure-replay-differential.ts \
  ee9d82912cd8105322672a1f5dd1bbb7172a2f46 \
  alfonso/task/bg_d9e9d2c11a15577e-perf-audit-rb-rust-mode-ts-bridge-and-opencode-1
```

Compared baseline with `7b131e8279f50f95c27664cb5a37ccb5e1a44ce4`, which has
the same production source as the final report commit. Exit 0:
`RESULT IDENTICAL defer_passes=4`. Both refs observed four actual defer
decisions and retained their established m0 generation. Message bytes/hashes:

| Pass | Bytes on each ref | SHA-256 on each ref |
|---|---:|---|
| 1 | 588 | `8e44911693c99c96462f474ea2c8c327799333f11a19ad15ad802fb7ac130221` |
| 2 | 754 | `a6391f075ba8a95501c2b241a3f04e0bb5104ad48a49ebfcaa69be8b295695dd` |
| 3 | 920 | `4a86507e5ba0bd6b7083a0af0357e2f15c4f550eb48385e50add5707f3430739` |
| 4 | 1088 | `c03c4fc133c46c4cca6401fa2a3c1cf3fd80be378077fa353c49f0676b57f53a` |

Every system hash is
`79b95b263eddd8b87a79391dcce93cb4d4fb5886dbf0ce553c47f7ae9da8e0aa`;
every tool hash is
`535ac4ab4b870c8a61b892f39defb0d0c4e7c594f1465dd3f2d939f08f411f65`.
The existing differential's default fixture uses `startInTsMode: true`; this
result is not mislabeled as a Rust transform-only differential. Real Rust
request/replay coverage comes from the full green manifest above and the
independent request/seed/persisted-slot byte checks in the instrument.

## Follow-up: Pi startup timeout investigation

No source or timeout was changed. Ran the two affected tests alone from the
Pi package directory so its normal isolation preload applied:

```sh
timeout 180 bun test --timeout 30000 src/index-in-process-latch.test.ts \
  -t 'claims process-wide startup maintenance from the full runtime|registers independent sessions in the same process'
```

- Current branch: **2 pass, 0 fail**, 10 assertions. Cold startup test
  5,978.10 ms; subsequent independent-session test 6.39 ms.
- Untouched `ee9d829` archive in the worktree's throwaway root, with the same
  installed dependencies: **2 pass, 0 fail**, 10 assertions. Cold startup
  8,986.39 ms; subsequent test 4.89 ms. The archived core source was checked
  byte-for-byte against the Git baseline object, not borrowed from the branch.
- Then the entire lifecycle file alone on the branch:
  `timeout 240 bun test --timeout 30000 src/index-in-process-latch.test.ts`:
  **17 pass, 0 fail**, 107 assertions, including all five cases that failed in
  the original parallel suite. Cold startup 5,316.83 ms; total 8.39 seconds.

Conclusion: the earlier timeouts are load/concurrency-sensitive startup limits,
not an RB optimization regression. The cold path is already seconds long on
the untouched baseline, against an explicit 15-second test deadline. These two
tests register runtimes but never dispatch a context or status request, so the
changed token-count/request algorithms are not exercised by their test bodies.
Their storage/config/embedding bootstrap implementations are unchanged. The
initial parallel Pi suite remains accurately recorded as failed; its isolated
impacted-file rerun is now green, rather than claiming that the original full
suite magically passed or increasing a timeout to hide the failure.

The renamed staging pointer and specialized-fixture requirements were resolved
through a parent decision: use the exact versioned default build, finish the
ordinary lane first, then build only the missing fault/probe targets and run
their files. No new optimization was made during this verification follow-up.
