# Issue 572: asymmetric budget-shrink follow-up

The adversarial review found that policy identity alone preserves an oversized m[0] when the model window contracts. Empty m[1] and force-band reclamation do not resize that baseline. The reviewer tests were cherry-picked from `9c9d400b5807863ab5fcef2e827c441486dc4a3e` without changing production code.

## Planned fix

Keep the policy comparison unchanged. Store a separate `|rendered-budgets:m<tokens>-h<tokens>` component in the existing cached upgrade-state string, atomically with each rendered prefix. It records the provider-token history allowance and absolute memory allowance supplied to that render, before local-token calibration or decay-pressure adjustments. No schema migration or renderer epoch change.

Compare the live numeric allowances with the recorded allowances asymmetrically. A decrease greater than `max(64 tokens, 1% of the recorded allowance)` in either component requests an ordinary HARD fold with `render_config:budget_shrink(old→new)`. Growth and sub-tolerance noise replay unchanged. Comparing against the rendered baseline rather than the previous observation makes cumulative small decreases eventually trigger, and prevents a dip followed by growth from triggering twice. Missing or malformed legacy components adopt only on a natural HARD fold.

The component must survive every cached-row decode/state re-encode path. Current marker reads compute the live allowance, while render snapshots and persistence keep the allowance used by the rendered bytes. Do not change content-marker CAS checks or nonpersisted contention behavior. Apply the same shared comparator and component to Pi.

## Proof and contract change

The review tests currently assert the defect (oversized baseline retention). Replace those expectations with exactly one shrink fold and reduced history, retaining the smaller-model transition coverage. This intentionally changes that safety contract and will be stated in the commit message. Add tolerance, cumulative shrink, growth-after-dip, memory shrink, legacy, and component round-trip tests.

Run the real OpenCode 1.18.30 shrink probe with its full-history fixture, asserting a single shrink fold and a first request below its 24576-token usable window. Continue checking all subsequent request sizes; the probe's accumulating unreclaimable user-text tail may independently exhaust the window and must be distinguished from m[0] sizing. Re-run rising accepted input and one-fold policy edit gates, both package typechecks and relevant tests, and pure replay against master with concurrent lsof isolation auditing. Disable the shrink comparator in a staged safe mutation and require the named OpenCode and Pi shrink regressions to fail; restore before committing.

## Cold-pass allowance discovery

The first policy-edit host run exposed a second-fold edge: an unknown catalog model's reset-to-zero usage hid its persisted usable window, so the policy-edit HARD recorded the renderer's fallback history allowance of 60000. The next pass rediscovered 280000 usable tokens, yielding history 22400 and a legitimate numeric-shrink trigger. That would violate the one-fold policy-edit contract.

The OpenCode transform now uses its already-captured, pre-reset `lastUsageContextLimit` as a history-render fallback only when the model key matches and no live trusted limit resolves. Newly configured, catalog or detected-overflow limits always win. This does not restore stale pressure or change scheduler thresholds. The corrected host policy-edit probe records 22400 immediately and folds only once. Pi already supplies its stable `usageContextLimit` at zero usage through its history-budget resolver; no corresponding source change was needed there.

## Follow-up results

- The real OpenCode 1.18.30 shrink gate passed under throwaway root `opencode-e2e-1790721740893-iqw0be`. `lsof` verified both hosts' OpenCode and MC databases were below its isolated data directory. The 49673-byte baseline recorded history allowance 15237. The first restart request folded once with `render_config:budget_shrink(m4000-h15237→m4000-h1474)`, produced an 82-byte baseline, and locally estimated 19186 input tokens against the 24576-token usable window. The next two passes replayed those same 82 bytes without another fold.
- The original probe intentionally grows unreclaimable user text. Its second and third requests estimated 29228 and 39270 tokens; those independently exceed the smaller usable window even after resizing, as they do on master. The safety gate pins the comparative first request, not a claim that m[0] resizing can bound arbitrary subsequent user input.
- The rising-input gate passed under root `opencode-e2e-1790721881429-7roovc`: four restart turns, no folds while accepted input rises, and the actual serialized provider shared prefix stayed 33509 characters with SHA-256 `c6519c39b93cdb89350cb34260360a821238221faf643e7196c032746a2dd0a6`. Changing history fraction from 0.15 to 0.2 produced one policy fold, immediately recording numeric history allowance 22400, then two cache hits.
- The new postprocess regression proves that the shrink HARD strips signed thinking on the resizing pass, including newly appended thinking, and leaves fresh thinking alone on the next replay. Pi and OpenCode legacy restart fixtures now explicitly omit rendered-budget metadata and replay unchanged through both growth and shrink before natural HARD adoption.
- Disabling `renderedBudgetShrinkReason` with a staged `NON-VACUITY BREAK` caused exactly the OpenCode test `shrinking history budget refolds an oversized baseline once with empty m1` and exactly the Pi test `Pi shrinking budget refolds an oversized baseline once with empty m1` to fail in their separately filtered runs. The mutation diff was 1 file / 2 insertions; restoring the staged file and touching it left an empty working diff. Both restored tests pass.
- Both runtime package typechecks, targeted lint, and production builds pass. The OpenCode six-file suite covered 345 tests: 343 initially passed; the two expected marker-string assertions were updated for the new numeric component and passed on rerun. Pi's three-file suite passed all 79 tests. No old behavioral safety assertion was silently removed: the two reviewer tests were explicitly demonstrations of unsafe retention and now assert the corrected one-fold contraction contract.
- Pure replay is verified against the committed follow-up; the exact command, result and concurrent database-isolation evidence are included in the delivery declaration.
