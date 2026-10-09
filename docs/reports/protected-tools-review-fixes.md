# Protected tool cache-review corrections

Refusal code: `protected_tool_results_over_limit`

Refusal message: `The tool results kept by protected_tools are larger than this model's context window, so this turn was not sent. Lower the protected_tools counts.`

These are a public contract. TypeScript and Rust each define the production text
once and test it against `protected-tool-refusal.json`. OpenCode 1, OpenCode 2,
Pi/OMP and Claude Code share that text. The message deliberately avoids language
that Claude Code could interpret as an instruction to compact.

## Trusted over-limit refusal

Healthy send paths require refusal-grade evidence after reclaim, including
successful no-op reclaim: complete counts, a measured model seed and this route's
measured tool definitions. Conservative fit envelopes remain admission-only.
The new refusal requires the calibrated protected subset alone to exceed the
limit. A missing or fitting subset takes the existing send, fold and provider-
overflow handling path, even when the full-request estimate exceeds the window.
There is no new generic healthy pre-send refusal.

The Rust-mode OpenCode adapter checks its final returned array, not the module's
ingress estimate, before installation/LKG capture. Typed native protected-tool
errors also bypass fallback and LKG replay. Pi measures its final array with a
complete current system/tool envelope and only guards priced/reclaim passes.

ck-mc counts protected result mass remaining after the actual fold's coverage
trim. Its native lower-bound guard requires the current request's
`usage.final_wire_trusted`, a positive model hard limit, and calibrated protected
mass above that limit; stale persisted trust is insufficient. No module wire
schema was added. Its Claude Code handler returns `HandlerOutcome::Error` with
the exact code and message above, no sendable/passthrough response, and no
transform-state commit. The handler regression exercises the real Claude Code
profile and route config; an untrusted-count control remains admitted.

THALAMUS owns the gateway mapping/test in its own repository. This delivery
does not claim an end-to-end gateway proof. The agreed gateway behavior is a
terminal HTTP 400 displaying the module's message verbatim, not a passthrough.

The refusal guards were mutation-checked: disabling the shared outgoing guard
made the impossible-reclaim regression, the Pi context-handler refusal, and the
Rust-mode final-wire refusal fail. The Rust-mode typed-error/no-replay control
remained green. Disabling ck-mc's native lower-bound guard made the Claude Code
handler regression fail. All breaks were staged safely, restored, and rerun green.

Verification: Bun 1.4.2, TypeScript 5.9.3; plugin and Pi typechecks pass. The
postprocess/refusal/Pi fit suites passed 249 tests initially; focused final
contract/fit tests passed six, adapter/byte-identity controls three, and the Pi
handler control one. Cargo 1.99.0 ran 29 protected-behavior tests successfully
with one build at a time; rustfmt 1.10.0 check passed. A combined full adapter
invocation exceeded its 20-minute outer bound and is not claimed as passing.
Its old 2048-message byte-identity fixture was over the former artificial window;
the fixture now supplies an isolated SDK window large enough for its unchanged
ballast. Its exact SHA256 assertions remain unchanged and all three pass classes
pass, while the separate over-limit regression proves refusal.

## Stale result stripping

First detection in OpenCode, Pi and ck-mc consumes the effective per-tool
selection set. Pi's old hardcoded newest-three selector is removed; its exported
default-count alias is only fixture metadata. A zero override permits stale
selection, while custom counts above three hold all requested results. Frozen
replay is unchanged and cannot resurrect a previously stripped result. The
design document now describes that distinction accurately.

The two executed review regressions are in the postprocess and Pi cleanup
suites. A real native transform verifies held detection, a zero-count priced
strip, and byte-identical frozen replay after protection is restored. All three
guards were individually neutralized, making each exact regression fail.
Restored checks passed (266 Bun tests and one native integration-style unit test).

## Nudge policy adoption

The frozen baseline now carries the adopted keep-count policy. Recency rotates
inside that policy on SOFT+, but a changed map is not adopted until rebuilding.
Legacy baselines without the field retain the old ctx_reduce-three-only policy
until rebuilding, including the default-only todowrite upgrade. Rust persists
this optional map inside the existing baseline blob; there is no new table.

An unchanged replay already below the nudge floor is not a new collapse, so it
does not reset a delivered Channel 2 lease. Existing queued-drop action-state
collapses remain valid; those are real reductions in actionable mass, not policy
adoption. Both callers provide the previous baseline for that distinction.

The review's map-edit, legacy-upgrade and rotation cases are in the postprocess
suite, with Pi equivalents. The native regression activates the Claude Code
surface and preserves a real raw arc before measuring its old-policy baseline;
the transition pass intentionally has no actionable U (reclaimable token mass
still available to reduce). A restart test verifies policy persistence and legacy
decoding in mc-store. Neutralizing policy freezing made the TS/Pi map-edit and
upgrade tests and the native policy test fail;
neutralizing the no-op lease guard separately made the TS/Pi lease assertions
fail.
The TS rotation control stayed green in those runs.

## Actual delivery-fold retirement

OpenCode postprocess now records the source rows removed by `injectM0M1`'s
successful delivery trim, not just the earlier preparation trim. Those tags
become compacted, and their held pending rows are deleted in the same bounded
writer transaction as retirement. Retained owners sharing a call ID are untouched.

The regression `review regression: executed fold must retire the held historian
row it actually trims` runs a real model-change HARD fold with a historian hold;
it never invokes the retirement helper. It proves the covered raw copy disappears,
the retained raw copy survives, the covered tag is compacted and its pending row
is gone before any subsequent drain. A retained protected row remains pending.

Two separate mutations disabled the delivery-retirement call and the pending-row
delete. Each made only that regression fail; `keeps OpenCode final bytes identical
to a one-shot executed fold` remained green. Staged working bytes were restored
after each break. The restored regression/control passed. Storage retirement and
v86 migration tests passed (seven tests), including the unchanged 100k-tag/two-
second bound (117.7 ms). Their small storage fixture now supplies the tag-number
and pending-queue columns required by atomic retirement; assertions are unchanged.
Plugin typecheck passed with TypeScript 5.9.3. Scoped formatting passed with Biome
2.5.1 from the plugin directory; invoking Biome at workspace root hit the existing
nested-root configuration error. Bun test version: 1.4.2.

## Idempotent historian enqueue

Both generic enqueue and the historian's identity-revalidated INSERT now check
pending membership per `(session, tag, operation)` inside the same SQLite write
statement. This bounds overlapping/repeated publications without a new schema
or a whole-session scan under the writer; the existing session/tag index supports
the probe. The first row's ID, timestamp and queue order survive retries. Different
sessions, tags and operations stay independent, and a consumed row can be enqueued
again. Pre-existing duplicates are not migrated, but cannot grow via these APIs.

The real historian regression `review regression: repeated historian publication
of a held result must have bounded pending depth` makes 100 publications and
asserts one unchanged held row. A separate storage test makes 100 generic enqueues
and checks tuple isolation and re-enqueue after removal. Neutralizing each pending
membership predicate made only its own bound test fail; the historian's concurrent
identity/status revalidation and storage queue-order controls respectively stayed
green. Both staged mutations were restored before a passing rerun.

The older prepared-publication differential explicitly expected a duplicate of
an already-pending tag. That expectation is intentionally changed from
`[3, 1, 3, 4, 5]` to `[3, 1, 4, 5]` for idempotency, without altering its frozen
clock or byte/identity assertions. Storage and historian suites passed 15 tests
(42 assertions); plugin typecheck passed (TypeScript 5.9.3).

## Final verification of the continued branch

A normal merge preserved the current shared dependency versions and Pi's
acknowledgment behavior. Cargo.lock keeps published Git dependencies unchanged,
and the acknowledgement includes both held-drop feedback and the self-stamp warning.
The two changes were applied independently.

Final suite runs used Bun 1.4.2; TypeScript 5.9.3; Cargo 1.99.0, rustc 1.99.0,
rustfmt 1.10.0; and Biome 2.5.1. Every suite had an outer timeout (120–240 seconds
for Bun, 900 seconds for Cargo). Rust ran once, foreground, `-j 2`, with serial
tests and no concurrent build or host. Bun's test preload redirected data/config
to throwaway roots under this worktree's ignored `target/protected-tools-final/tmp`
for final runs; fixture-specific OpenCode stores stayed isolated. No live model,
host or production store was opened.

| Final check | Result |
| --- | --- |
| TS configuration, selection/holds, stale strip, refusal, full postprocess/Channel 2, ctx_reduce, storage-ops and historian queue suites (10 files, `timeout 240s bun test`) | 338 passed, 1 inherited fixture failure, 1778 assertions |
| Pi selection/holds, context/refusal, cleanup and hygiene suites (6 files, filter `protected\|protection\|held drop\|review\|legacy.*SOFT\|smart_drops`) | 21 passed, 1 inherited fixture failure, 83 assertions |
| Pi tests outside that filter: map adoption, legacy upgrade, queued rotation and custom stale keep count | 4 passed, 13 assertions |
| Rust-mode host final-wire refusal and typed-error/no-LKG tests | 2 passed, 2 assertions |
| `timeout 900s cargo test --locked -j 2 -p mc-module --lib protected -- --nocapture --test-threads=1` | 31 passed, 0 failed; compiled in 2m14s, tests in 21.25s |
| `timeout 120s bun run --cwd packages/plugin typecheck` | Passed |
| `timeout 120s bun run --cwd packages/pi-plugin typecheck` | Passed |
| `timeout 240s bun run build` | Plugin/OpenCode 2, Pi and CLI builds passed; 4 OpenCode 2 loader tests, 19 assertions |
| `timeout 120s cargo fmt --check` and scoped Biome formatting | Passed |

The **only final suite failures** are `TypeScript held drop: newest three
ctx_reduce results hold agent drops` and `Pi held drop: newest three ctx_reduce
results hold agent drops`. Their shared fixture expects a `Held:` acknowledgment,
but the tool correctly rejects an agent dropping its own ctx_reduce result with
`§2§ is a ctx_reduce call; leave those alone, they are cleaned up automatically.`
This is a fixture mismatch, not an enqueue or retirement regression; no expected
hold assertion was weakened to hide it. Updating this older fixture is outside the
two queue-retirement fixes covered here.

All new tests and unaffected controls passed after their mutations were restored.
Scoped `aft_inspect` reported incomplete Biome/server diagnostics, so explicit
package typechecks and formatting are authoritative. Full lint and live gateway/
provider probes were not run; no end-to-end provider acceptance is claimed.

## Healthy-send evidence correction after re-review

The two regressions identified during re-review are included, with their exact
names and 8,000-word/16,000-token specimens, in the OpenCode refusal and Pi fallback
package suites. Those suites do not depend on archived reference code. The other
four closed findings and native Rust guard are unchanged.

### Two kinds of estimate

`trusted` still means a complete admission estimate. Unknown-model fit inflation,
family inheritance, largest-tool-set borrowing and Pi's all-registered-tools
envelope remain usable for replay/fit admission, not for originating a healthy
refusal. `refusalGrade`, `refusalTokens` and `refusalBasis` separately name non-fit
evidence. Refusal requires a real measured model seed, a working tokenizer and
route-owned measured definitions; missing evidence serves the healthy request.
Family and model-id-only provider inheritance are admission-only. Persisted
calibration freezes can omit their diagnostic prefix, so measured provenance is
checked against the model's seed rather than that optional label.

Both the entire refusal estimate and protected subset use calibrated ratios,
never `UNKNOWN_FIT_RATIO`. Pi retains its frozen fit policy independently of the
current measured refusal seed and counts only the introspected active tool subset
for refusal. Missing active-set introspection leaves the all-tools figure usable
for admission only. A fitting protected subset cannot receive the specific
protected-results message merely because other context exceeds the limit.

OpenCode's Rust-mode TS adapter also forwards only refusal-grade counts/trust to
the native guard's existing fields, including full-sync retries. No native Rust
guard or wire schema changed. Its recovery-wire tests reach both unknown and
measured model routes; the unknown upper envelope never becomes native non-fit
proof. Healthy final-array tests admit the unknown model and still refuse the
calibrated known model. The old positive adapter specimen used an unknown model;
it now uses measured Fable and route-owned definitions. Its 12,000-word specimen
is still calibrated over the 16,000 limit, without conflating refusal with upload
paging. Handwritten positive estimate fixtures now declare refusal evidence
explicitly instead of claiming completeness alone proves overflow.

### Provider evidence wins

OpenCode keeps bounded, detached evidence of exact served prefixes, the system
hash and exact measured schema fingerprints. A completed same-route reply must
match the captured request's real user parent and chronology before its input +
cache-read + cache-write usage can replace the full-prefix estimate. Only the
actual new tail is then estimated. A changed prefix, system, schema, route or
parent invalidates that basis. Missing/cold/evicted evidence falls back to current
measured calibration, never a stale session usage aggregate.

Pi reuses its existing correlated captured-request/JSONL usage proof through a
non-replaying accessor. Exact served prefix and envelope equality are still
required. Tagging the new reply may change its content without invalidating its
provider usage identity; the actual returned tail is priced separately. Tests
prove both directions: a small provider measurement prevents a false refusal
from a much larger full-prefix estimate, and a large provider measurement proves
generic overflow despite a small local full-array estimate. Mismatched metadata,
parentage and rewritten prefixes cannot borrow the old count.

The earlier generic healthy-refusal assertions described above were broader than
the design and have been corrected: full-prefix overflow evidence is useful for
admission and telemetry, but cannot originate this refusal when protected results
fit. The provider-overflow refusal path is unchanged. Claude Code's gateway mapping
above remains only for the specific protected-results code, not generic pressure.

### Mutation and final verification

Treating admission estimates as refusal evidence made each reviewer regression
fail individually; the calibrated protected-overflow control stayed green in each
lane. Suppressing all healthy refusals made each calibrated control fail individually
while the unknown-model regression stayed green. Separately, disabling provider-prefix
reuse made the OpenCode and Pi provider-preference tests fail individually, with
their calibrated protected controls still green. Forwarding admission trust to
native made only the unknown-route producer test fail; the measured-route producer
test stayed green. Every mutation used staged live bytes, a nonempty mutant diff,
index restoration plus touch, and an empty restored diff. All restored controls
passed. The canonical refusal code/message at the top of this report are unchanged.

Tools: Bun 1.4.2, TypeScript 5.9.3, Biome 2.5.1, Cargo/rustc 1.99.0. Exact `./`
test paths prevent accidental discovery of archives. Bun checks had 120–240s
outer bounds and isolated preload-owned stores under the worktree's ignored temp
root; no host or live provider/store was opened. Cargo ran once, foreground,
`--locked -j 2`, with serial tests and no simultaneous build or host.

| Final gate | Result |
| --- | --- |
| TS refusal/estimation, replay fit, full postprocess, calibration and tool-definition suites (6 files) | 302 passed, 0 failed, 1654 assertions |
| Pi refusal, measured-prefix and fit-envelope suites (3 files) | 23 passed, 0 failed, 107 assertions |
| Pi context/cleanup/hygiene protected and closed-review controls (3 files, targeted filter) | 24 passed, 0 failed, 94 assertions |
| Rust-mode TS healthy refusal/admission, native trust provenance and typed-error/no-replay controls | 5 passed, 0 failed |
| `cargo test --locked -j 2 -p mc-module --lib protected -- --nocapture --test-threads=1` | 31 passed, 0 failed; native Rust guard unchanged |
| Plugin and Pi repository `typecheck` scripts | Passed |
| `bun run build` | Plugin/OpenCode 2, Pi and CLI passed; 4 loader tests, 19 assertions |
| Scoped package-local Biome formatting | Passed for 19 edited TypeScript files |

Scoped `aft_inspect` had incomplete Biome/Pi server diagnostics; explicit package
typechecks/builds are authoritative. Full workspace tests/lint and real-host/
gateway/provider probes were not run. This does not claim a live-vendor acceptance
or repeat the earlier report's host handoff proof.

### Post-checkpoint TypeScript verification

The coherent implementation was in place before the short, lane-by-lane
verification runs. The TypeScript refusal/estimation suites then
passed 21 tests and 68 assertions with Bun 1.4.2 under a 120-second bound.

The calibrated positive control now deliberately crosses the boundary: its local
protected count is below 16,000, while measured Fable pricing puts that subset
above 16,000. Neutralizing protected-subset calibration made only
`calibrated measured protected results still refuse with the protected-results code`;
the unknown-model reviewer regression remained green. Restoring the staged bytes
and rerunning the two suites passed. This defends calibration itself, not just a
specimen whose unscaled mass was already over the limit.

### Post-checkpoint Pi verification

After TypeScript verification, the targeted Pi refusal, provider-usage
and fit-envelope suites passed 23 tests and 109 assertions (Bun 1.4.2, 120-second
bound). Pi's calibrated positive likewise has local protected mass below 16,000
and calibrated protected mass above it. Neutralizing subset calibration made
only `Pi refuses a complete protected over-limit final envelope but not untrusted counts`;
the Pi unknown-model reviewer regression stayed green. Restored suites passed.

These short final runs include the strengthened calibration-boundary assertions;
the larger suite counts above record the earlier production-code verification.
No production change was needed after the coherent implementation checkpoint.

## Agent self-stamp precedence

An agent cannot queue its own `ctx_reduce` result, regardless of its protected
keep count; automatic and historian queues still honor `ctx_reduce: 3`. The
conflicting agent-hold fixture uses `custom: 3`.
The shared fixture now retains a three-result ctx_reduce historian hold/retirement
case and explicitly tests protected and unprotected agent self-stamp rejection
in TypeScript, Pi and the native Rust facade.

Mixed calls pin the order free drop, protected hold, then self-stamp note. Tests
verify sibling queue contents and exclusion of the self-stamped tag. The Rust
facade retains its existing visibility disclaimer. The OpenCode Rust-backend
acknowledgment had discarded the self-stamp suffix when a held result existed;
that composition bug is fixed without changing queue policy.

All retained changes are covered by configuration, shared-fixture, facade,
integration, and persistence tests. The obsolete agent-ctx_reduce fixture now
matches the rejection of self-drops.

### Verification counts

| Check | Result |
| --- | --- |
| Shared TS/Pi holds and both ctx_reduce tool suites | 50 passed, 217 assertions |
| Final shared TS/Pi holds and tool suites, including backend suffix correction | 51 passed, 218 assertions |
| Updated OpenCode tool/backend acknowledgment suite | 23 passed, 50 assertions |
| Plugin and Pi repository typechecks | Passed, TypeScript 5.9.3 |
| Native `mc-module --lib ctx_reduce` | 23 passed, 0 failed |
| Native `mc-module --lib protected` | 31 passed, 0 failed |
| Native `mc-store --lib protected` | 3 passed, 0 failed |
| Dashboard config parity from the dashboard directory | 7 passed, 11 assertions |
| Full Pi `bun run test` | 1559 passed, 3 skipped, 0 failed; 84180 assertions across 144 files |
| Full CLI `bun run test` | 637 passed, 2 skipped, 0 failed across its five runner phases (639 total tests) |
| Full plugin `bun run test` | Incomplete: two 840s attempts and one 1740s attempt timed out; no final suite count exists |

The required plugin script was used, including frozen installation and
`bun test --parallel=4 --timeout 30000`, never a substituted bare test command.
The second attempt logged 6913 passing, zero failing and four skipped outcomes,
but timed out with `rust-mode-transform.test.ts` as the only unfinished file
(659 seconds in that file). The longer attempt still had that file unfinished
after 1590 seconds and logged 6910 passes, three failures and four skips. These
are incomplete logged outcomes, not successful full-suite totals.

The first attempt's failures were timeout-only in the 20,000-file sentinel scan
hook and non-git directory Git smoke test. The longer attempt also had unrelated
verification CLI timing failures (`runVerify disposition` and the 2/22 manifest
case). Machine load was 35–40 with other workers compiling during diagnosis.
No unrelated timing expectation was changed to make a full suite look green.
The affected self-stamp/hold/backend tests and native suites passed independently.

Logs are retained under ignored `target/self-stamp-verification/` as
`plugin-first.*`, `plugin-full.*`, `plugin-long.*`, `pi-full.*` and `cli-full.*`.
Bun 1.4.2 and Cargo/rustc 1.99.0 were used. Native checks ran serially with `-j 2`.
The initial dashboard invocation from workspace root selected React JSX instead
of the package's Solid configuration; its correct package-local retry passed.
All storage was in-memory or preload/fixture-owned temporary roots; no live host
or provider was started. Full-plugin completion remains an explicit verification
gap, not a claimed pass.

## Synchronous tokenizer hang correction

The earlier full-plugin gap is now closed. The isolated oversized-priced-snapshot
regression hit a hard 10-second timeout
before the fix. A temporary diagnostic confirmed the stack: the Rust-mode healthy
refusal path called `estimateFinalWireInputTokens` → `estimateMessageTokens` →
`serializedTokens` with **12,583,912 characters**, before replay admission's cheap
byte proxy could run. The diagnostic was removed; this was synchronous BPE work,
not merely machine contention or an asynchronous test timeout.

Healthy refusal checks now settle over/under byte bounds before BPE and tokenize
only uncertain envelopes. Provider-measured prefix usage remains the baseline;
only the new tail is bounded. Missing envelope evidence still cannot originate
a healthy refusal. Byte-derived evidence is named separately from calibrated
counts. Priced refusals invalidate an obsolete durable snapshot before returning.

`estimateTokens` previously had no input-cost guard. Its memo's byte ceiling only
bounded retention **after** encoding. It now bounds individual BPE calls to 4096 UTF-16 code units
chunks, splits ordinary prose before whitespace to preserve measured mass, and
uses a byte upper bound for pathological unbroken runs or parts beyond the total
work ceiling. Fallback does not disable ordinary tokenization. Bound-only message
counts do not become calibrated refusal evidence. Shared hygiene differential
corpora and the 250k-token memoization control pass without changing their goldens.

Admission already rejected byte-over arrays before tokenization. It still had
the same exposure in uncertain-band text and in other direct tokenizer callers,
including tool/schema counting; the shared cost guard now bounds those routes too.

The fail-first real-pass regression requires the 12 MB second pass to complete
under one second. It now completes in **3.1 ms** in the full suite (4.3 ms in the
initial isolated restored run), still returns `EmergencyFailClosedError`, and
retains its stale-LKG invalidation assertions. Its failure counter is now zero:
the cheap refusal is a healthy context decision, not an engine capture failure.
The originally failing 12 MB fixture and normal force-latch/incomplete-system
fixtures all pass; no unrelated timeout or hygiene expectation was weakened.

### Final gates

| Command/check | Result |
| --- | --- |
| Full plugin `bun run test` | **7016 passed, 4 skipped, 0 failed**; 7020 tests across 678 files in 185.22s |
| Full Pi `bun run test` | **1562 passed, 3 skipped, 0 failed**; 1565 tests across 145 files in 41.31s |
| Root `bun run lint` | **Passed with zero errors**; 1603 files checked (13 warnings and 3 infos) |
| Plugin and Pi repository typechecks | Passed, TypeScript 5.9.3 |
| Root package build | Passed; 4 OpenCode 2 loader tests, 19 assertions |
| Refusal/estimation and replay-fit targeted suites | 43 passed, 123 assertions |
| Pi refusal/provider-usage targeted suites | 16 passed, 73 assertions |
| Hygiene differential/performance controls | 5 passed, 209 assertions |

The complete plugin script includes the required frozen installation and
`bun test --parallel=4 --timeout 30000`. Its first completed runs exposed unrelated
fixture Git-commit timeouts: inherited command-line `core.hooksPath` pointed at
external AFT hooks. The final run removed only inherited `GIT_CONFIG_*` hook
environment from test subprocesses; fixture-local Git configuration and all tests
remain enabled. No test timeout was increased or assertion removed to obtain the
successful full-suite result. Package import organization was checked,
including the Pi context-handler imports, which now appear at the top of their files.

Logs: ignored `target/self-stamp-verification/plugin-complete.*`,
`pi-complete.*` and `root-lint-final.*`. Bun 1.4.2 and Biome 2.5.1 were used.
All stores remained in-memory or preload/fixture-owned temporary roots; no live
host/provider/store was opened. Native Rust and package manifests/lockfiles were
not changed in this correction.

## Exact estimator parity and failure-accounting correction

The earlier chunking behavior and its 8 MiB threshold are removed. A fail-first
parity test loads six real repository texts over 4 KiB and compares `estimateTokens`
directly with the tokenizer's whole-text `encode(..., "all").length`. It failed on the
chunked implementation: current schema text counted 21,180 instead of 21,173.
After restoration all six texts match exactly (24 assertions).

**`consecutiveFailures` drives the three-failure module parking/warning and retry cadence; early refusals of invalid returned arrays now increment it, and repeated over-limit output cannot bypass that accounting.**

The 12 MB real-pass test again requires failure count 1, then exercises two more
invalid outputs and asserts count 3 with parking enabled. Its existing fifth-pass
retry still fails closed, retains count 4, and does not create a second parking
transition. Native typed refusals that return no invalid array remain distinct.
The first oversized refusal is still below one second (1.6 ms in the final suite).

### Classification of the three Pi failures

The three failures are in hygiene regression tests unrelated to these corrections:

- `nudge hygiene three-leg differential corpus > keeps TypeScript and Pi aligned
  with the Rust-consumed golden`: **unchanged by these corrections**; its test file
  contains no edits from this work.
- `TS/Pi/module differential hygiene corpus > keeps Pi as the third leg across
  the full shared corpus`: **test body unchanged by these corrections**. Other
  edits to the file cover separate lease and policy behavior.
- `Pi hygiene walk performance > memoized 250k-token rendered tail walks are cheap
  relative to the cold walk`: **test body unchanged by these corrections**.

No expected corpus count, tolerance, performance ratio or synthetic input was
changed. The unrelated estimator defect was a global byte fallback that inflated
these larger-prose inputs. The established `estimateTokens` behavior encodes whole
texts, and the implementation now preserves that behavior; the only added helper
is a cost-fence predicate used by refusal-only counting. The 1 MiB/16,385-letter-or-digit
limits remain in the new refusal path, not in shared threshold/protection/nudge counting.
Obvious byte decisions still precede all refusal tokenization, and uncertain
pathological refusal parts use byte bounds without altering the shared estimator.

### Final isolated verification

| Gate | Result |
| --- | --- |
| Full plugin `bun run test` | **7017 passed, 4 skipped, 0 failed**; 7021 tests across 679 files, 139.46s |
| Full Pi `bun run test` | **1562 passed, 3 skipped, 0 failed**; 1565 tests across 145 files, 31.23s |
| Root `bun run lint` | Passed with zero errors |
| Plugin and Pi repository typechecks | Passed, TypeScript 5.9.3 |
| Real-file parity, refusal-only bound and unchanged hygiene controls | 7 passed, 237 assertions |
| Real oversized-output/parking regression | Passed, 14 assertions |

Both full-suite invocations explicitly unset `OPENCODE_DB`, set HOME to the same
canonical throwaway directory outside every Git repository, and rely on the
repository test preload for stores/configuration. Inherited external AFT Git-hook
environment was removed as in the previous gate. An initial HOME inside this Git
worktree caused the existing home-directory identity tests to select Git identity
instead of directory fallback; the corrected external throwaway HOME passes.
No fixture expectation was weakened to work around that invocation error.

Logs: ignored `target/self-stamp-verification/plugin-reference-final.*`,
`pi-reference-final.*`, `root-lint-parity.*` and `parity-home.txt`. No native Rust,
manifest, lockfile, live host, provider or production store was changed/opened.
