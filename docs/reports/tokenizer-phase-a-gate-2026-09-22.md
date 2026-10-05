# Verdict: BLOCK

Phase A must not ship from `5d423d2717e3241fb3bd749742e7058500b6960b`.

Two executed defects violate the approved contract:

1. **A revisioned table upgrade is consumed immediately by the active protected-window decision.** On the same persisted session DB, before any bust, the Fable tool ratio changed from `1.551639` to `1.9`, the active revision changed, and the protected set contracted from 20 tags (`cutoff=21`) to 16 (`cutoff=25`). The required defer freeze reddened. `sessionDecisionCalibration` reconstructs the current binary's seed from only the cached model key; it has no frozen active revision/coefficient to replay.
2. **Tail hygiene remains raw-local in TS, Pi, and Rust.** A Fable tool-only tail with local `T=40,000`, `U=20,000` is real-token `T=62,066`, `U=31,033`. The 0.50 ratio correctly remains unchanged, but production returns `quiet / tail-below-minimum` instead of the required `firm`; the reminder says `~20k` rather than `~31k`. The Rust twin reddened `Quiet` versus `Firm`. The branch's own PARITY files explicitly call this required Phase A row “deferred.”

No product fix is included. The necessary fix is to freeze a revisioned active decision calibration at the authorized bust boundary (without turning a coefficient refresh into a HARD), and to implement a versioned hygiene-unit transition so T/U, cadence/grace watermarks, absolute floors, and reminder figures use calibrated units on TS, Pi, and Rust. Those are product changes and require author work.

## Revisions and isolation

- Master control: `3d049bf4a2347b9f8da95ecae103c64b4a8c7331`.
- Candidate: `5d423d2717e3241fb3bd749742e7058500b6960b`.
- Host runs used fresh throwaway `HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME` roots. No live store, private prompt dump, credential, or paid completion was opened.
- `git diff --name-only 3d049bf4a2..HEAD -- '**/migrations*.ts' '**/storage-db.ts' 'crates/mc-store/**'` printed nothing: no fence or store migration moved.

## 1. Cache identity — PASS

### Neutral model

Command:

```sh
root=$(mktemp -d "$PWD/.gate-neutral.XXXXXX")
HOME="$root" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" \
bun packages/e2e-tests/scripts/pure-replay-differential.ts \
  --ts-only --priced --neutral 3d049bf4a2 5d423d2717
```

Captured excerpt:

```text
master  hardMessagesSha256=1c3f62d9... hardHistorySha256=4ce19ae0... expectedLocalBudget=60000 restarted=true
branch  hardMessagesSha256=1c3f62d9... hardHistorySha256=4ce19ae0... expectedLocalBudget=60000 restarted=true
PASS 1 decision=defer ... sha256=2ba3e5c8...
PASS 2 decision=defer ... sha256=aa4f608f...
PASS 3 decision=defer ... sha256=1002a68c...
PASS 4 decision=defer ... sha256=7571eb70...
PRICED_GATE hard=true tail_m0_equal=true four_defers_each=true
RESULT PRICED_EXPECTATIONS_MET defer_passes=4
```

The corresponding message, system, and tool hashes were identical between refs on all four passes. The restart was between defers two and three; all four observed scheduler decisions remained `defer` and cached history stayed `4ce19ae0...`.

### Calibrated Fable model

Command: the same isolated command without `--neutral`.

Captured excerpt:

```text
master  hardMessagesSha256=1c3f62d9... hardHistorySha256=4ce19ae0... expectedLocalBudget=60000
branch  hardMessagesSha256=5cea1515... hardHistorySha256=e5a3fd05... expectedLocalBudget=38173
master  expectedDropped=[56,59] actualDropped=[56,59]
branch  expectedDropped=[56,59,62,65] actualDropped=[56,59,62,65]
PASS 1 decision=defer ... history=e5a3fd05...
PASS 2 decision=defer ... history=e5a3fd05...
PASS 3 decision=defer ... history=e5a3fd05...
PASS 4 decision=defer ... history=e5a3fd05...
PRICED_GATE hard=true tail_m0_equal=true four_defers_each=true
RESULT PRICED_EXPECTATIONS_MET defer_passes=4
```

The first authorized HARD differs by the independently expected 60,000-provider-token to 38,173-local conversion. Every later branch pass reuses its own cached generation; the restart does not produce another HARD.

Mutations: none.

## 2. Table drift — FAIL (blocking)

A persistent synthetic session used `cached_m0_model_key='anthropic/claude-fable-5-1'`, `protected_tokens_effective=30000`, and forty 1,000-local-token tool rows.

Baseline command imported `sessionDecisionCalibration` and `getProtectionWindowForSession` against `/tmp/mc-tokenizer-table-drift.sqlite`.

Captured baseline:

```json
{"phase":"before-upgrade","revision":"2026-09-21-family-v1","toolsRatio":1.551639,"protectedCount":20,"protectedMass":31033,"cutoff":21}
```

### Revisioned upgrade mutation

After staging `tokenizer-calibration.ts` with an empty unstaged diff, the table resolver was changed to return Fable `toolsRatio=1.9` and revision `table-upgrade-v2`, marked `NON-VACUITY BREAK`. The same DB was reopened in a new Bun process, simulating a new binary before a bust.

Command/check:

```sh
bun -e '<open the same DB; resolve the session calibration and protection window;
assert revision/count/cutoff remain family-v1/20/21 before a bust>'
```

Captured red:

```text
1 file changed, 5 insertions(+), 2 deletions(-)
{"check":"table-drift defer freeze identity","revision":"NON-VACUITY BREAK table-upgrade-v2","toolsRatio":1.9,"protectedCount":16,"cutoff":25}
error: table-drift defer freeze identity: expected frozen revision/count/cutoff
```

Only the named check failed. Restore produced an empty `git diff --stat`.

A preliminary direct seed-JSON mutation reproduced the same defect: ratio `1.9`, count `16`, mass `30400`, cutoff `25` on the unchanged DB. It was also restored cleanly.

Result: the new coefficient is consumed before the next bust, so the requested defer identity, later-bust adoption, and boot-log lifecycle cannot be satisfied. The coefficient/revision is not snapshotted with the active generation.

## 3. Fit guards in both directions — PASS for executed TS/Pi caller paths; native Rust has no separate raw/LKG carrier

Commands:

```sh
cd packages/plugin
bun test src/hooks/magic-context/decision-calibration.test.ts \
  src/hooks/magic-context/final-wire-token-estimate.test.ts \
  src/hooks/magic-context/rust-mode-transform.test.ts \
  --test-name-pattern 'family fallback|unknown-model fit|tiny untrusted fallback|LKG plus suffix|unknown calibrated raw fallback'

cd packages/pi-plugin
bun test src/pi-raw-fallback.test.ts src/pi-lkg.test.ts \
  --test-name-pattern 'incomplete fallback|complete calibrated fallback|Pi high-fill recovery'
```

Captured output:

```text
TS/Rust-mode adapter: 5 pass, 0 fail
Pi raw fallback:       2 pass, 0 fail
Pi calibrated LKG:     1 pass, 0 fail
```

Independent boundary probe at wall 10,000:

```text
unknown local=9500  estimate=19000 admitted=false
unknown local=4500  estimate=9000  admitted=true
family fallback Fable-5.2 local=6000 estimate=9431 admitted=true source=family-fallback
measured Fable local=7000 estimate=11003 admitted=false
measured Fable local=6000 estimate=9431 admitted=true
```

The family fallback did not receive the unknown 2.0 envelope. Incomplete raw and LKG representations refused; fitting complete controls were admitted.

Mutation: the unknown-model fit multiplier was changed from `UNKNOWN_FIT_RATIO` to `1` with `NON-VACUITY BREAK`. The exact test `unknown calibrated raw fallback refuses a locally fitting request and admits a safe request` was the sole failure (`Expected promise that rejects; Received promise that resolved`). The mutant diff was one file/one line and restore was empty.

The native Rust module has calibrated provider-mass and producer admission tests, but raw fallback/LKG are adapter carriers rather than separate Rust-module paths.

## 4. Protected floor — PASS

Commands:

```sh
cd packages/plugin
bun test src/features/magic-context/migrations-v84.test.ts \
  src/features/magic-context/protection-window.test.ts \
  --test-name-pattern 'migration v84|Fable protection|minimum-bounded HOLD'
```

Captured output: `5 pass, 0 fail`.

Independent 30,000-provider-token probe:

```json
{
  "floorReal": 30000,
  "ratio": 1.551639,
  "calibrated": {"count":20,"rawLocal":20000,"estimatedReal":31033},
  "legacy": {"count":30,"rawLocal":30000},
  "newestThreeWins": {"protected":[8,9,10],"count":3,"estimatedReal":34137}
}
```

The 1,000-token atomic rows explain 20,000 rather than exactly 19,334 local tokens: the crossing row is kept whole. The v84 snapshot column remains the real-token floor, raw tag counts remain unchanged, and the newest-three structural floor wins when the token walk would keep fewer.

Rust named control `protection_window::calibration_tests::fable_protection_spends_real_tool_tokens_without_changing_rows` also passed.

Mutations: none.

## 5. Emergency episode — PASS for calibrated mass and structure

Independent same-fixture comparison used eight tool rows with 5,000 local tokens each. The calibrated variant supplied `servedTokens=7,758.195` and retained-skeleton-adjusted `reclaimableTokens=6,982.376` per row.

Captured output:

```text
legacy-local tags=[1,2,3,4,5,6,7] reclaim=34000 floor≈45000
fable-real  tags=[1,2,3,4,5,6,7,8] reclaim=49446 floor≈22934.44
fable-95    tags=[1,2,3,4,5,6,7,8] reclaim=49446 floor≈22934.44
```

Every eviction-list difference follows from the 1.551639 served-mass ratio and retained-skeleton reclaim charge: the calibrated active tail is larger, the estimated fixed prefix is lower, and the batch must evict the eighth tag. At 95%, the structure rule still yields the token window/reserve while retaining the established open-arc and exemplar protections.

Commands/results:

```text
plugin emergency planner controls: 3 pass, 0 fail
Pi post-pending active-set + 99% paired-skeleton controls: 2 pass, 0 fail
Rust selection::tests::calibrated_emergency_uses_current_token_mass_not_original_bytes: passed
```

Mutations: none.

## 6. Historian — PASS

Command/probe:

```text
Fable producer, local source at 100% of a 10k usable window:
  admitted=false
  reason="producer_prompt_exceeds_window calibrated_tokens=15718 limit=9700 estimator_margin=0.03"
Fable producer, local source at 55%:
  admitted=true
```

Targeted command:

```sh
bun test src/hooks/magic-context/producer-window-guard.test.ts \
  src/hooks/magic-context/derive-budgets.test.ts \
  src/hooks/magic-context/compartment-runner.test.ts \
  --test-name-pattern 'complete producer prompt|historian source allowance|refuses a producer source far beyond'
```

Captured output: `3 pass, 0 fail`. The producer local source allowance moved from 20,000 to 12,724 for Fable. Reasons include calibrated tokens, limit, and the unchanged 3% estimator margin.

Rust controls passed:

```text
historian_chunk::calibration_budget_tests::producer_source_budget_uses_producer_static_seed
historian_chunk::tests::below_budget_refuses_normally_but_fires_in_emergency
historian::tests::calibrated_full_prompt_refuses_before_producer_start (covered by full suite)
```

Thus chunk cut points use the producer prose/tool seed while the `min_chunk_tokens` substance-floor behavior remains unchanged, including the existing emergency/fold-only bypass.

Mutations: none.

## 7. Hygiene bands — FAIL (blocking)

Executed TS decision probe for a tool-only Fable tail:

```json
{
  "raw":{"u":20000,"t":40000},
  "real":{"u":31033,"t":62066},
  "ratioRaw":0.5,
  "ratioReal":0.5,
  "production":{"fire":false,"band":"quiet","reason":"tail-below-minimum"},
  "calibratedExpected":{"fire":true,"band":"firm","reason":"band-crossing"}
}
```

The 0.20/0.40/0.60/0.75 ratio thresholds are correctly not scaled: U/T remains 0.50. The absolute `T>=60k`, `U>=25k`, and `U>=50k` floors are not being fed calibrated units. Reminder excerpts prove the copy error:

```text
production: 4 spent tool outputs (~20k tokens)
expected:   4 spent tool outputs (~31k tokens)
```

### Rust red probe

After staging `tail_hygiene.rs` with an empty unstaged diff, a temporary `NON-VACUITY BREAK` test asserted that the same raw Fable measurement reaches `Firm` after decision calibration.

Captured output:

```text
running 1 test
test tail_hygiene::tests::fable_tool_only_hygiene_calibrates_absolute_floors_before_band ... FAILED
left: Quiet
right: Firm
0 passed; 1 failed; 1222 filtered out
```

The temporary test was restored; post-restore diff was empty. Pi shares the same nudge policy and its `PARITY.md` explicitly says tail-hygiene calibration and the legacy floors remain deferred.

## 8. Runtime learning — removed by owner ruling

There is no Phase B. Calibration remains a periodically curated static seed table. The candidate EMA, per-priced-pass L/P capture and logging, `learned-candidate` provenance, and candidate-only tests were deleted. Static provenance is `seed` or `family-fallback`; the per-session freeze in sequence 2 is bust-boundary discipline rather than learning. Sequence 8 is therefore removed from the rerun list.

## 9. Pi parity — FAIL with the same blocking hygiene gap

Command:

```sh
cd packages/pi-plugin
bun test src/inject-compartments-pi.test.ts src/pi-raw-fallback.test.ts \
  src/pi-historian-runner.test.ts src/heuristic-cleanup-pi.test.ts \
  src/tail-hygiene-walk-pi.test.ts \
  --test-name-pattern 'Fable HARD history|complete calibrated fallback|does not spawn beyond the producer window|post-pending-op active tag set|parity fixture'
```

Captured output: `4 pass, 0 fail` across the calibrated history, raw fit, producer-window, and emergency shared sites.

The requested calibrated hygiene site does not pass because it is intentionally not implemented. `packages/pi-plugin/PARITY.md` states that history/protection, fallback fit, historian fit, and partial candidate logging use the shared seeds, but also states:

```text
Tail-hygiene calibration is deferred with TS and Rust ... Legacy T/U floors remain in effect.
```

No standalone real Pi-host calibrated-model lane exists in this delivery; the executed lane is package-level. This is a missing required host proof in addition to the reproduced hygiene defect.

Mutations: none beyond the shared hygiene red probe in sequence 7.

## 10. Rust parity — goldens PASS; requested Phase A parity FAILS on hygiene

Command:

```sh
cargo test -p mc-module
```

Captured output:

```text
running 1222 tests
1214 passed; 0 failed; 8 ignored
all integration targets passed
```

This executed the protection golden, selection differential/golden, hygiene parity golden, history render, historian, and transport/module tests.

Live-shape commands:

```sh
bun test src/hooks/magic-context/decay-render.test.ts \
  --test-name-pattern '^Fable HARD history rendering uses 38173 local tokens for a 60000 real-token budget$'
cargo test -p mc-module fable_history_budget_is_provider_tokens -- --nocapture
```

Captured output: TS `1 pass`; Rust `1 pass`. Both resolve the 60,000-provider-token Fable history allowance to 38,173 local tokens on the fixture.

Named Rust controls also passed for Fable protection, calibrated emergency mass, producer source budget, and unchanged minimum-chunk semantics. However, sequence 7's Rust red probe proves `tail_hygiene.rs` still classifies the Fable absolute-floor fixture as `Quiet`, so the full requested TS/Pi/Rust row-for-row parity is not achieved.

Mutations: the temporary Rust hygiene test is recorded in sequence 7; no mutant remained.

## Mutation ledger

| Control | Expected red | Observed | Applied/restored evidence |
|---|---|---|---|
| Revisioned Fable table upgrade is consulted before a bust | `table-drift defer freeze identity` | Sole check failed: active revision/count/cutoff became v2/16/25 instead of frozen v1/20/21 | `tokenizer-calibration.ts`: empty → 1 file, `+5/-2` → empty |
| Preliminary direct seed-entry upgrade | Protection decision must remain 20/cutoff 21 before bust | Decision changed to 16/cutoff 25 | seed JSON: empty → 1 file, `+1/-1` → empty |
| Unknown fit envelope replaced by 1 | `unknown calibrated raw fallback refuses a locally fitting request and admits a safe request` | Sole test failed because rejection resolved | `decision-calibration.ts`: empty → 1 file, `+1/-1` → empty |
| Fable hygiene absolute-floor requirement | `tail_hygiene::tests::fable_tool_only_hygiene_calibrates_absolute_floors_before_band` | Sole test failed `Quiet != Firm` | `tail_hygiene.rs`: empty → 1 file, `+8` → empty |

## Gate conclusion

The original verdict above records the pre-fix gate. Fix round 1 below closes both blocking findings with static-only calibration; runtime learning was removed by owner ruling.


## Fix round 1

### Scope and persistence

- OpenCode/Pi store the active static calibration under `session_meta.deferred_execute_state.magicContextTokenizerCalibration.active`: `{ revision, providerId, modelId, systemRatio, toolsRatio, proseRatio, source }`. This existing JSON column was chosen because its retired execute-hold payload already belongs to pass/bust lifecycle state; `cached_m0_upgrade_state` remains a renderer-identity string and is not repurposed. Parsing is tolerant: malformed/absent state is unfrozen and remains neutral on defer until the next authorized bust. No column or migration was added.
- Rust stores the same backward-defaulted snapshot in `mc_cache_state.meta.decision_calibration`.
- A changed static table is read only with bust permission. The adoption log is `calibration revision <old> → <new> adopted (bust=<reason>)`; a table change does not originate a HARD.
- Hygiene unit epoch 2 uses tools ratio for tool input/output and prose ratio for text/file content, accumulates fractional class mass, then ceilings once at the aggregate decision. Ratio bands remain unchanged.
- The exact persisted U-watermark list is OpenCode/Pi `session_meta.last_nudge_undropped` and `session_meta.last_nudge_level.postReduceGraceBaselineU`; Rust twins are `ModuleMeta.channel1_last_nudge_undropped` and `TailHygieneBaseline.channel1_post_reduce_grace_baseline_u`. `growthThreshold` / Rust `channel1_refire_tokens(T)` is derived rather than persisted and therefore changes by consuming calibrated T. These values convert once on the first bust and are guarded by `hygieneUnitsVersion=2` / `hygiene_units_version=2`.
- Runtime learning was deleted: no candidate EMA/state, priced-pass L/P logging, `learned-candidate` source, or candidate-only tests remain. Static provenance is only `seed` or `family-fallback`.

### Sequence 1 — cache identity and priced replay: PASS

Commands used isolated HOME/XDG roots:

```sh
bun packages/e2e-tests/scripts/pure-replay-differential.ts \
  --ts-only --priced --neutral 3d049bf4a2 HEAD
bun packages/e2e-tests/scripts/pure-replay-differential.ts \
  --ts-only --priced 3d049bf4a2 HEAD
```

Candidate ref was `4b962d533370eb9b674b8e0a7af218b9b5a38718`. Neutral master/candidate HARD hashes were identical (`messages=1c3f62d9…`, `history=4ce19ae0…`), expected local budget was 60,000, and all four corresponding defer message/system/tool hashes matched. Fable adopted the independently expected 38,173-local history allowance and dropped `[56,59,62,65]` versus master `[56,59]`; its four later passes were all `defer`, including restart between defers two and three. Both runs ended `PRICED_GATE hard=true tail_m0_equal=true four_defers_each=true` and `RESULT PRICED_EXPECTATIONS_MET defer_passes=4`.

### Sequence 2 — table drift freeze: PASS

The TS upgrade probe staged clean calibration sources, changed the Fable tool ratio from `1.551639` to `1.9` and revision to `NON-VACUITY BREAK table-upgrade-v2`, then opened persisted frozen state through two defer-shaped reads. Both returned revision `2026-09-21-family-v1`, protected count 20 and cutoff 21. The next bust-permitted read returned the new revision, count 16 and cutoff 25 and emitted the required adoption log. The temporary gate test passed `1/1`; source restore returned an empty diff.

The Rust twin serialized/deserialized `ModuleMeta` between the frozen read and the changed table, retained `1.551639` across the defer/restart read, and adopted `1.9` plus `table-upgrade-v2` only at the next bust. Its named test passed; the two-file mutant diff restored empty.

Permanent controls also pass:

```text
session decision calibration freeze: 2 pass, 0 fail
frozen_revision_survives_restart_and_changes_only_at_the_next_bust: passed
```

### Sequence 3 — fit guards: PASS

The report commands were rerun unchanged. OpenCode/Rust-mode adapter controls: `5 pass, 0 fail`; Pi controls: `3 pass, 0 fail`. Removing runtime learning did not alter the conservative unknown-model envelope or completeness requirements.

### Sequence 7 — calibrated hygiene and transition: PASS

The Fable tool-only fixture now reports `T=62,066`, `U=31,033`, band/level `firm`, and reminder text containing `4 spent tool outputs (~31k tokens)` in OpenCode and Pi. Rust reports `(U,T)=(31,033,62,066)` and `Firm`.

```text
TS Fable hygiene: 1 pass, 0 fail
Pi Fable hygiene: 1 pass, 0 fail
Rust fable_tool_only_hygiene_calibrates_absolute_floors_before_band: passed
TS transition/restart controls: 2 pass, 0 fail
Rust hygiene_v1_watermarks_convert_once_on_first_bust: passed
```

The transition controls seed v1 watermarks, prove defer leaves them unchanged, convert on the priced pass, then prove a second priced pass does not convert again. Mutation control removed the Rust version stamp with `NON-VACUITY BREAK`: the sole named test `transform::tests::hygiene_v1_watermarks_convert_once_on_first_bust` failed on its second transition call; `1 failed, 0 passed, 1224 filtered out`. `transform.rs` changed from empty to `1 insertion(+), 1 deletion(-)` and restored to empty.

### Sequences 8 and learning provenance

Sequence 8 is moot under the owner ruling. The learning instrument and its mutation row were removed rather than rerun.

### Full verification: PASS

All host-facing runs used throwaway HOME/XDG roots.

```text
plugin full suite: 5254 pass, 1 skip, 0 fail
Pi full suite:     1225 pass, 3 skip, 0 fail
plugin typecheck:  passed
Pi typecheck:      passed
cargo test -p mc-module --locked: 1217 library pass, 8 ignored, 0 fail; all integration targets passed
cargo clippy -p mc-module --locked -- -D warnings: passed
```

The first full Rust run exposed one cache-delivery test that directly seeded legacy aggregate fields; the test fixture now explicitly selects legacy unit arithmetic because calibrated floor behavior has its own Fable control. The impacted test and then the full locked suite passed. No SQL migration or schema-fence movement occurred.

### Fix-round verdict

Both original blocking findings are closed across OpenCode, Pi and Rust. Active static calibration survives defer/restart and changes only at a priced bust boundary; hygiene floors, cadence/grace and reminders use calibrated units with a one-time durable transition. Runtime learning is absent by design.
