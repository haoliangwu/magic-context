# Protected tools: adversarial re-review

## Verdict

**Do not merge yet.** The new refusal fixes the missing guard, but does not satisfy
the guard's trust requirement: complete, **uncalibrated upper-envelope estimates
are labeled trusted and can reject requests that fit**. Two new, deliberately red
regressions exercise the production estimators and refusal functions together.

The stale-strip blocker and the three original should-fixes are closed on the
executed evidence below. The native Claude Code module returns the typed error,
not a sendable response, when its lower-bound guard fires. Actual OpenCode 1 and
Pi unchanged-config SOFT+ handoffs preserve the **entire raw provider request
body**, not just a selected prefix or a reconstructed JSON object.

## Revisions and scope

- Reviewed fixes tip: `9c7c20d37529adc63cd2f3f7441b3264cb475938` on
  `alfonso/task/bg_320e344f642c3722-protected-tools-map-and-smart-drops-always-on`.
- Master control: `b4438c5982f15f09ab5a9b81af733c5fcfe65178`.
- This task branch was moved to the fixes tip before editing, as requested; the
  supplied master-based branch could not fast-forward because the histories diverge.
- Read the first review, `protected-tools-queued-drops.md`, and the newer
  `protected-tools-review-fixes.md` **at that tip**. The queued-drops report really
  exists there; no missing-path compatibility shim was introduced.
- No production, package manifest, lockfile, fixture expectation, or live-store
  changes. Only this report and its two review harness files are changed.

All production file:line references refer to the reviewed fixes tip. Short OpenCode
hook names below mean `packages/plugin/src/hooks/magic-context/`; shared storage
names mean `packages/plugin/src/features/magic-context/`. Pi and Rust paths are
written explicitly.

## Blocker: completeness is mistaken for trustworthy refusal evidence

The new `outgoingContextRefusal` checks `estimate.trusted`, then refuses every
over-limit number (`emergency-fail-closed.ts:35–52`). The problem is upstream:

1. `final-wire-token-estimate.ts:252–273` resolves calibration and prices the
   estimate with `providerMass(..., true)`. For an unknown model,
   `decision-calibration.ts:55–58` multiplies **all raw mass by
   `UNKNOWN_FIT_RATIO`**, currently 2. This is a conservative upper envelope for
   admission/replay, not proof that a healthy request cannot fit.
2. `final-wire-token-estimate.ts:274–303` sets `trusted: complete`. Neither a
   calibrated model nor even this route's own tool-definition measurement is
   required. A largest-tool-set measurement borrowed from a different route also
   qualifies (`:253–267`). Completeness and `toolDefinitionsMeasured` are separate
   facts, but the refusal ignores the distinction.
3. The protected subset is inflated too:
   `reclaim-protection.ts:50–60` calls the same fit-mode `providerMass` on active
   protected tag counts. `transform.ts:2865–2877` passes this inflated subset and
   the final estimate to the new refusal. Consequently even the **specific**
   `protected_tool_results_over_limit` message can falsely blame protection.
4. Pi has the same defect:
   `packages/pi-plugin/src/pi-raw-fallback.ts:81–120` requires a complete envelope
   and a tokenizer, applies unknown-model fit inflation, and sets trusted merely
   from numerical finiteness. The healthy handler calls the refusal after reclaim
   at `packages/pi-plugin/src/context-handler.ts:4012–4037`.
5. OpenCode's Rust-mode **TS adapter** also calls the faulty estimator and helper
   on its final array (`rust-mode-transform.ts:4152–4173`). Being after reclaim
   does not make an uncalibrated number a trustworthy lower bound.

### Executed counterexamples

`docs/reports/protected-tools-re-review.test.ts` has these exact failing tests:

- `re-review: OpenCode must not refuse a fitting uncalibrated request on the unknown-model upper envelope`
- `re-review: Pi must not refuse a fitting uncalibrated request on the unknown-model upper envelope`

Both use an unknown provider/model, a completed protected probe result containing
8,000 repetitions of `word `, a complete system/tools envelope, and a 16,000-token
limit. No prior provider rejection is armed. The first test also executes master's
old refusal decision on **the same input** and verifies that it allows the turn.

| Lane | Complete local mass | Fit-envelope estimate | Trusted | Result |
| --- | ---: | ---: | --- | --- |
| OpenCode | 8,109 | 16,218 | true | Aborts; protected-tools refusal text |
| Pi | 8,121 | 16,242 | true | Protected-tools refusal text |

The raw protected subsets are about 8,000, not over 16,000. A provider using the
available local tokenizer can accept this envelope with several thousand tokens
of framing headroom. The engine has no observation excluding that possible
provider, yet makes the production refusal. This is a deterministic trust-policy
counterexample, **not a claim that a live vendor accepted this particular request**.

Lowering protection is not the right diagnosis: without the inflated protected
subset, the same guard still issues its generic over-limit refusal. This new guard
broadens healthy-send refusal beyond the protected-results case as well.

**Required correction before merge:** distinguish a complete estimate suitable
for conservative fit admission from evidence strong enough to prove non-fit.
Do not originate a healthy-send refusal from the unknown-model multiplier or a
borrowed tool-set upper envelope. A supplied `trusted: false` unit control does
not defend this bug; the estimator itself currently supplies `true`.

### Native Claude Code path: typed outcome verified, narrower guard

There is no TS adapter ahead of the tested native Claude Code handler. Its guard
at `crates/mc-module/src/transform.rs:6821–6849`:

- requires **this request's** `usage.final_wire_trusted`, not persisted usage;
- counts only protected results still in the tail after actual fold coverage;
- excludes frozen stale-strip messages;
- prices that remaining subset with `active_calibration.tools_ratio`, **not** the
  unknown-model fit multiplier used by the TS healthy-send callers;
- returns `TransformError::ProtectedToolResultsOverLimit` before the transform
  commit when this lower bound exceeds the hard limit.

`crates/mc-module/src/lib.rs:10439–10473` maps that error to
`HandlerOutcome::Error` with code `protected_tool_results_over_limit` and the
canonical message. The executed regression
`tests::claude_code_protected_results_over_limit_is_a_typed_refusal_not_passthrough`
(`lib.rs:27649–27685`) exercises the real Claude Code serializer/route, asserts
the exact golden error and unchanged row version, and admits an untrusted-count
control. All 31 native protected tests passed. The two OpenCode Rust-mode adapter
tests also passed: successful no-op reclaim over limit refuses, and a typed native
error cannot become passthrough or LKG replay.

**Note:** this establishes the module's typed response, not THALAMUS's HTTP mapping
or the gateway's provenance for `final_wire_trusted`. THALAMUS is outside this
worktree; no end-to-end live Claude Code gateway claim is made.

## Closed: stale strip honors protection only at first detection

- OpenCode's postprocess supplies selected protected call IDs
  (`transform-postprocess-phase.ts:2786–2794`). Detection checks them at
  `drop-stale-reduce-calls.ts:139–150`; frozen replay deliberately does not
  (`:135–136,152–157`). The protected-three postprocess regression passed, as did
  execute→defer identical-shape replay and the complete stale-strip suite.
- Pi's selection and application are no longer hardcoded to three. The effective
  per-tool set is computed at
  `packages/pi-plugin/src/heuristic-cleanup-pi.ts:344–346`, and the actual stale
  application skips that set at `:486–507`. The custom-six regression passed;
  changing the count to zero in that test then permits stripping. Persisted
  dropped status is replayed, not reactivated by later protection.
- Rust derives `protected_reduce` from the selected block set at
  `crates/mc-module/src/transform.rs:13189–13192` and consults it in both stale
  detection branches (`:13245–13268`). The executed
  `transform::tests::protected_ctx_reduce_stale_detection_and_frozen_replay`
  holds first detection, strips on a priced zero-count pass, and compares frozen
  replay after protection is restored. It passed.

No already-stripped result was resurrected in these controls. No new stale-strip
blocker found.

## Closed: nudge policy adoption and Channel 2 lease freeze

`reclaim-protection.ts:21–29` adopts live maps only on rebuilding (or when no prior
baseline exists). A legacy baseline without a policy explicitly retains
`todowrite: 0, ctx_reduce: 3`, rather than receiving the upgrade's new defaults.
Both TS baselines store the adopted policy:
`tail-hygiene-walk.ts:1176–1182` and
`packages/pi-plugin/src/tail-hygiene-walk-pi.ts:704–714`.

`channel2-cycle.ts:26–43` rejects a no-op SOFT+ reset: an unchanged below-floor
replay is not a new U collapse. The OpenCode caller provides both the previous
baseline and actual bust status (`transform-postprocess-phase.ts:3989–3995`).
Legitimate action-state deltas, such as newly queued work leaving actionable U,
are not confused with policy adoption.

Rust likewise freezes the baseline map and decodes the legacy three-only policy
(`crates/mc-module/src/transform.rs:6223–6240,6321–6325`). Its restart/legacy
blob test at `crates/mc-store/src/lib.rs:20059` passed without a schema change.

The named OpenCode map-edit, legacy-default-upgrade and rotation/queued-U
postprocess tests passed. Pi's three equivalents passed. The native
`protected_nudge_policy_waits_for_rebuilding_and_legacy_defaults_stay_frozen`
passed. Map edits and new defaults do **not** rearm a delivered Channel 2 lease
on the tested unchanged SOFT+ passes; the independently rebuilding pass adopts
the new map.

## Closed: actual fold retirement and idempotent enqueue

The real delivery path snapshots source rows **before** `injectM0M1` and retires
only those absent after a successful `prefixTrimStatus: applied`
(`transform-postprocess-phase.ts:2844–2879`). It no longer relies solely on the
initial preparation trim. `storage-tags.ts:1923–1954` identity-revalidates each
retirement and removes the pending row in the **same bounded writer transaction**.

The real model-change HARD-fold regression
`review regression: executed fold must retire the held historian row it actually trims`
passed. It never invokes the retirement helper itself; it checks that covered raw
bytes leave the wire, the covered tag becomes compacted and its queue row is gone,
while a retained raw owner and its protected pending row survive. The one-shot
fold-byte control passed too.

The new idempotency key includes **operation**, not only tag:
`storage-ops.ts:18–21,99–110`. The historian's identity-revalidated drop INSERT
has its own matching membership predicate (`:125–132`), reached by the real
publication path (`compartment-runner-drop-queue.ts:41–48`). The storage test
`100 enqueues are idempotent per session, tag and operation and preserve the first row`
passed, including a different existing operation for the same tag, independent
sessions, first-row timestamp preservation, and re-enqueue after consumption.
The real 100-publication historian regression and source-identity revalidation
controls passed.

`PendingOp` currently exposes only `operation: "drop"` (`types.ts:61–66`), with
no additional operation payload to accidentally conflate. Unknown operations are
intentionally ignored on read, but do not suppress a valid drop INSERT. No new
different-op swallowing defect found. Existing duplicate rows are not migrated;
the APIs prevent further duplicate growth, as the fix report states.

## Passed: real-host master → branch unchanged-config SOFT+ handoff

The committed `protected-tools-re-review-handoff.ts` runs real hosts against the
repository mock provider. Master serves a session containing a tool result and a
warm follow-up. After stopping the host, the harness snapshots **only its own
throwaway stores**. Master then serves the comparison turn; the host is stopped,
the specimen restored at the identical path, and the candidate serves the exact
same next turn. Pi explicitly resumes the same saved session. There is no config
edit between the master and candidate passes; the extension path selects the code.

The compared value is the mock's **raw HTTP request body before JSON parsing**.
No normalization, masking, expected-value rendering, selected-prefix hash, or
self-comparison is used. Defer/nonmaterialization logs and absence of executed
HARD folds are asserted independently, so a rebuilding pass cannot masquerade as
a successful SOFT+ continuation.

| Host | Specimen tool | Exact request bytes | Master and candidate SHA256 |
| --- | --- | ---: | --- |
| OpenCode 1.18.30 | `todowrite` | 47,559 | `8e4ea87bff5ccfd59875b4497fe1d61d4e630cfc4bd1c077f63aaf4bc87ae4d5` |
| Pi 0.87.1 | `ctx_reduce` | 22,557 | `2beb82185ed8eee67d598c01ceba9d7a49203ea2cab179ed58d314c8253d1752` |

OpenCode logs `decision=defer`, `rematerialized=false, reason=cache_hit`; Pi logs
`decision=defer` and `materialized=false`. Both lanes passed. This is a focused
same-session upgrade probe, not a universal equivalence claim for rebuilding
passes or every optional feature. Historian, embedding, memory injection and
dreamer are disabled identically in both phases to remove unrelated asynchronous
work; `protected_tools` is not configured. All provider endpoints are loopback,
all keys are fake, and default primary replies carry `RE_REVIEW_MOCK_ONLY`.

## Live-store isolation

The brief's isolation rule, verbatim:

> never open/read/write/migrate the live stores (`~/.local/share/opencode/*.db`, `~/.local/share/cortexkit/magic-context/{context,store}.db`, `~/.config/opencode/*`, `~/.config/cortexkit/*`); every host run goes through a throwaway root (`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` under `$TMPDIR/magic-context/<task>/`), proven by `lsof -p <host pid>` listing only throwaway `.db` paths; a single live-store write is a rejected delivery.

The actual canonical root is:

```text
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/protected-tools-re-review-bg400f36/
```

Every host receives redirected HOME, data/config/state/runtime/cache, OpenCode DB
and Magic Context storage, all under that root, plus an isolated Pi agent dir.
`timeout 10s lsof -nP -p PID -Fn` inventories every host after it serves. The
harness requires a nonempty inventory containing the expected context DB and
rejects any external `.db`, WAL or SHM path. Final successful host inventories:

- OpenCode PIDs **70801, 73080, 73233**: only
  `tmp/opencode-e2e-OjeB5D/data/opencode/opencode.db` and
  `tmp/opencode-e2e-OjeB5D/data/cortexkit/magic-context/context.db`, with their
  WAL/SHM handles, under the root above.
- Pi PIDs **1474, 1630, 1753**: only
  `tmp/pi-e2e-94UmLZ/data/cortexkit/magic-context/context.db`, with WAL/SHM, under
  that root.

Raw inventories, provider bodies, comparison hashes, host logs and stopped
specimens are retained there, not committed. `oc1-*.lsof.txt`, `pi-*.lsof.txt`,
`oc1-handoff-final.log`, `pi-handoff-final.log`, and `*.comparison.json` record the
final proof. Earlier harness attempts also inventoried only throwaway stores.
No live store or live user configuration was opened, read, written or migrated.

## Verification and reproduction

Tools: Bun **1.4.2 (744846f84)**, TypeScript **5.9.3**, Cargo **1.99.0
(5f94df478)**, rustc **1.99.0 (b940084d7)**. Every shell command had an outer
`timeout`. Cargo ran foreground, **`-j 2`**, one Cargo invocation at a time, with
no simultaneous host run.

| Check | Outcome |
| --- | --- |
| Final red review suite, `timeout 120s bun test ./docs/reports/protected-tools-re-review.test.ts` | Two expected refusal failures, eight assertions; master decision control allows the same OpenCode input |
| Exact candidate TS refusal/estimation/stale/postprocess/hygiene/selection/storage/historian suites, eight explicit `./` paths, 240s bound | 326 passed, one Fable fixed-number fixture failure, 1,730 assertions |
| Postprocess with fixture-owned OpenCode DB resolution | All passed; the initial substring-path run also discovered archived master: 490 tests across two files, 2,888 assertions |
| Fable fixture in isolation on candidate and master | Passed on both; not a reproducible protected-tools behavior failure |
| Exact Pi files, filter `protected\|protection\|map edits\|legacy default\|adopted policy\|stale\|outgoing\|refus`, 240s bound | 36 passed, 0 failed, 114 assertions across five files |
| Rust-mode TS final-array refusal / typed-error-no-replay controls | Passed; the substring-path invocation ran both controls, two assertions |
| `timeout 900s cargo test --locked -j 2 -p mc-module --lib protected -- --nocapture --test-threads=1` | 31 passed, 0 failed |
| `timeout 900s cargo test --locked -j 2 -p mc-store --lib protected -- --nocapture --test-threads=1` | Three passed, 0 failed |
| `timeout 240s` package `typecheck` scripts for plugin and Pi | Both passed with TypeScript 5.9.3 |
| `timeout 120s packages/plugin/node_modules/.bin/tsc -p target/protected-tools-re-review/tsconfig.json` (both review scripts and master differential import) | Passed with TypeScript 5.9.3; config extends the e2e project with Bun/Node types and the core-source alias |
| Candidate `timeout 300s bun run build` | Plugin, Pi and CLI built; four OpenCode 2 loader tests / 19 assertions passed |
| Archived master frozen install and plugin/Pi builds, 600s bound | 982 packages installed; builds passed; four loader tests passed |
| Real-host handoff script, separately with `RE_REVIEW_LANE=oc1` and `RE_REVIEW_LANE=pi`, 600s each | One exact-body SOFT+ handoff passed in each lane; all six final host PIDs passed isolation inventories |

Initial unit-suite failures caused by forcing `OPENCODE_DB` over the suites' own
throwaway XDG fixtures disappeared on the impacted postprocess rerun with that
override unset. This is **only for unit suites**; every real host has an explicit
isolated `OPENCODE_DB`. An initial combined TS run also discovered the archived
master because Bun treats bare path arguments as discovery filters. Final exact
suite invocations use `./` file paths. The remaining combined-suite Fable failure
is `calibrates the Fable tool-only hygiene floors and reminder figures`:
`{u:31036,t:62072}` versus `{u:31033,t:62066}`. The exact assertion passed when
run alone on both revisions. No fixture expectation was changed to hide it.

Harness setup failures were corrected, not counted as product findings: a relative
SDK package-directory import needed its declared dist entry; canonical `/private`
paths were needed for the isolation assertion; the runner's cached preparation DB
handle must not survive a stopped-store restore; Pi's nonmaterialization log is
`materialized=false`, not OpenCode's `cache_hit`. The final handoff harness lets
the real hosts own/migrate their own stores. Both final host checks pass unchanged
source distributions after those harness corrections.

To reproduce, archive the master control **inside this worktree**:

```sh
timeout 60s bash -c 'mkdir -p target/protected-tools-re-review/master; git archive b4438c5982f15f09ab5a9b81af733c5fcfe65178 | tar -x -C target/protected-tools-re-review/master'
```

Before any Bun/host run, create/canonicalize a fresh root under
`$TMPDIR/magic-context/protected-tools-re-review-bg400f36`, set `REVIEW_ROOT`, and
export HOME, TMPDIR, XDG_DATA_HOME, XDG_CONFIG_HOME, XDG_STATE_HOME,
XDG_RUNTIME_DIR, XDG_CACHE_HOME, OPENCODE_DB, MAGIC_CONTEXT_STORAGE_DIR and
MAGIC_CONTEXT_LOG_PATH beneath it. Install/build the archive and candidate using
the repository's frozen-install/build scripts. Then run the two committed review
harnesses with the bounds above. The red suite requires the master archive; the
host script rejects missing/out-of-root isolation variables before spawning.

`aft_inspect` reported unknown diagnostics because its TypeScript SDK was not
available at the repository root; the explicit scoped tsc and package scripts are
the authoritative checks. Full lint/workspace tests and live provider/gateway
probes were not repeated: no production or packaging changes were made. No
production guard was mutated for this review; the new counterexamples fail on
the unmodified fixes tip itself.
