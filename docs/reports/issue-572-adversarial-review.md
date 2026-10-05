# Issue 572 adversarial cache review

Terminology: **MC** is Magic Context. **m[0]** is the frozen rendered history/memory baseline at the front of the prompt; **m[1]** contains additions since that baseline. A **fold / HARD** rebuilds the baseline, potentially losing the provider's cached prefix. **SOFT+ / defer** replays both slots; **SOFT / priced refresh** can refresh additions without rebuilding the baseline. The **force band** is high prompt pressure (85% here), which authorizes reclamation. A **natural HARD** is an independent rebuild trigger such as a changed model/system prompt or expired cache, rather than a window measurement changing.

## Verdict: MERGE WITH FIXES

Reviewed `279995cb558ccd45ec66846ff4afacda6f2747bc` against local `master`. The rising-window cache fix works. **The shrinking-window safety assumption does not:** neither an empty-m[1] pressure backstop nor the force band guarantees that an oversized frozen m[0] will be resized. Preserve the rising-window behavior, but resolve the demonstrated shrinking-window pressure case before merging. No production fix is included in this review.

Read the protected architecture contract first: SOFT+ replays both slots, SOFT updates only m[1], HARD re-renders m[0]. Pressure backstop refolds are conditional on newly recomputed, nonempty m[1], not on the size of m[0] relative to the new window.

## Finding: a lowered window retains the larger baseline past the force band

### Real-host differential reproduction

Run the committed worker harness with the added `shrink` mode:

```sh
TMPDIR=/tmp/magic-context/issue-572-review bun packages/e2e-tests/scripts/issue-572-probe.ts shrink
```

The runner sets isolated XDG paths, `OPENCODE_DB`, and `MAGIC_CONTEXT_STORAGE_DIR` for its child. The fixture uses a configured 262144-token model, seeds a 1600-repeat P1 compartment, forces a natural `cached_m1_missing` fold, reports 22000 accepted input tokens, restarts the **same model/session** with `limit.context = 32768`, and sends growing user text. Historian is disabled to prevent an asynchronous publication from becoming a confounding delta. Compaction is **on** in this mode. The mock accepts requests regardless of size.

Observed usable window: **253952 → 24576** (8192 output reserve). The selected MC policy remains `hp0.15:percentage:40`; the runtime history allowance becomes about **15237 → 1474** tokens. The first restart transform resets stale usage to zero and defers. Its response establishes **22000 / 24576 = 89.52%** usage; passes 2 and 3 then explicitly execute in the **85% force band**. All three passes reach the mock with `rematerialized=false, reason=cache_hit`.

The fixture's `data/cortexkit/magic-context-e2e.log` confirms that high-pressure reclamation actually ran (not merely a calculated pressure):

```
transform scheduler: percentage=89.5% inputTokens=22000 ... decision=execute
heuristics WILL RUN — reason=force_materialization (89.5% >= 85%)
pending ops WILL APPLY — reason=ride=force (scheduler=execute)
emergency tiered drop skipped: no-candidates
transform: injected m[0]/m[1] (rematerialized=false, reason=cache_hit)
```

| Pass | Branch m[0] bytes | Branch local wire tokens | Master m[0] bytes | Master local wire tokens |
|---|---:|---:|---:|---:|
| seed HARD (10) | 49673 | 17120 | 49673 | 17121 |
| restart (1) | 49673 | **27162** | **82** | **19165** |
| next (2) | 49673 | 37204 | 82 | 29207 |
| next (3) | 49673 | 47246 | 82 | 39249 |

Branch m[0] SHA-256 remains `f7eec1a0f2da8bda6e249027c2718d9d5f3954d223dc47edd21fdf4e2806fb7a`. Master folds at pass 1 with `reason=render_config`; the branch does not. At the **first restart request**, the branch's local tokenizer estimate is above the usable window while master's is below. By pass 2 the branch estimate is also above the raw 32768 window. Later tail growth eventually exceeds the window on master too; that is not attributed to this patch. The comparative first-pass result isolates the retained baseline's extra cost (~7997 locally estimated tokens).

These counts use MC's tokenizer on serialized provider input, not the remote Qwen tokenizer. This proves a sent, locally over-budget request and an unchanged oversized baseline at high pressure, **not** a real Qwen rejection. Provider usage is scripted (22000) to keep the measured force-band case stable; the mock is not a physical capacity oracle. A production model that rejects such a request may learn a limit / enter emergency recovery later, but that is not preventive resizing at the force band.

### Committed unit reproductions

- OpenCode: `review: shrinking history budget with empty m1 does not refold even on a priced pass`.
- Pi: `Pi review: shrinking budget cannot refold an oversized baseline with empty m1`.

Both cache real compartment history at a 12000-token history allowance, lower the runtime allowance to 1 while keeping the policy identity unchanged, and run **defer → priced refresh → priced refresh**. Each pass keeps the exact old m[0] bytes and exceeds the new allowance. These tests intentionally assert the observed unsafe retention, rather than pretending it is a safety contract.

The reason is concrete in both materializers: the backstop requires freshly recomputed m[1], then a >40 memory-mutation count, a >20%-of-history-budget m[1], or a >15%-of-m[0] m[1] with the 500-token floor. With empty m[1], all predicates are false regardless of how large m[0] is. OpenCode's force flag in `transform-postprocess-phase.ts` is separate from `mustMaterialize`; Pi mirrors that separation. Existing `pressure backstop: small m[0] + large m[1] folds via the absolute m[1] cap` passes, so the backstop works for its intended delta-growth case, not the oversized-baseline case.

Suggested acceptance condition for a follow-up: a downward-window pressure case with large m[0]/empty m[1] must either safely resize on an already authorized pressure bust or refuse an over-budget outgoing request; it must not send the demonstrated oversized request while simply preserving m[0]. Do not reintroduce folds on every rising proven-input observation.

## Attack results

### 1. Legacy adoption — sound in both materializers

Committed tests:

- `review: legacy policy adoption survives restart until a natural HARD`
- `Pi review: legacy replay survives restart and only a natural HARD records policy`

Sequence: numeric baseline `-h12000` → upgrade policy + runtime budget 16000 → SOFT+ replay → reload state from SQLite / discard process-local injection cache → SOFT+ replay → natural HARD → policy recorded. Both replay passes retain the legacy marker and identical m[0] bytes; only the natural HARD writes `-hp0.15:percentage:40`. OpenCode uses a system-hash HARD; Pi uses a known larger-model → smaller-model HARD. Restarts here are **state-reload simulations**, not separate Pi/OpenCode executable upgrades. The independent worker host probe exercises an actual OpenCode restart, but not a mixed-version legacy upgrade.

### 2. Shrinking window — finding above

Ran a real configured `limit.context` decrease plus source-independent numeric-budget decreases in both materializers. Did **not** separately drive a live proven-input reset or catalog-fallback reset; both feed the same live history-budget argument, but that observation is not represented as a separate host reproduction.

### 3. Smaller model switch — sound

The OpenCode shrink test starts with `cachedM0ModelKey = review/larger-model`, then switches to `review/smaller-model` while retaining the policy identity. Decision is `model_change`, m[0] materializes, the cached model marker becomes the smaller key, and the following pass does not fold again. Pi's restart test proves the same known-key transition and one-fold behavior. These use materializer hard signals, not an actual model-provider deployment.

### 4. Budget-policy identity completeness — sound for the audited budget inputs

| Render budget input | Current coverage |
|---|---|
| `history_budget_percentage` | Policy identity `p<percentage>` |
| Selected execute percentage/default/per-model override | Effective resolved percentage in identity |
| Execute absolute token mode, default/per-model override | `tokens:<selected tokens>` in identity; same canonical/per-model lookup as runtime |
| Switching percentage ↔ token mode | Mode itself is in identity, even if numeric allowances happen to match |
| Unselected override / overridden percentage in tokens mode | Correctly omitted: no effective budget change |
| Live window (configured, catalog, accepted input, detected limit, output reservation) | Runtime input deliberately omitted from policy identity; rides HARD — shrinking risk above |
| No history percentage / falsy percentage | `pdefault`; runtime resolver returns undefined and materializer uses fixed 60000, so execute edits do not change this default budget |
| Absolute memory injection budget | `m<tokens>` remains in identity in both materializers |
| Missing absolute budgets | Materializer defaults (OpenCode memory 8000/history 60000; Pi uses its supplied memory injection allowance) |
| Real different model / provider | `cachedM0ModelKey` HARD; canonical aliases remain equivalent |

The added resolver test `review: effective policy identity covers mode, selected overrides, fraction and default history` exercises the above policy distinctions and canonical effective percentage clamp (95 and 90 identify the same policy). Existing OpenCode/Pi policy tests demonstrate rising numeric budgets replay, a percentage-policy edit folds exactly once, and memory-budget edits remain detected, including against legacy numeric markers.

Memory/history content, decay ages and importance, docs/profile/workspace selection, renderer epochs, mural mode, and memory feature enablement also affect rendered bytes, but are not all *budget* inputs. Their pre-existing ride/HARD contracts are not redefined by this fix. For example temporal labels and selection epochs may ride a natural HARD. No additional budget-policy omission was reproduced. The system/user-profile fixed allowance is not an exposed numeric config in these budget identities.

### 5. Rising input / defer prefix — sound within the worker probe's scope

Ran original worker probe against master (`proven baseline`) and branch (`proven stable`): master folded four times after restart; branch folded zero times, then exactly once on the MC policy edit. The harness's proven mode disables compaction so accepted usage can rise beyond the initial unknown-model window without force/emergency activity confounding the cache experiment. Its m[0] is only 35 bytes; it is **not** a 130K history-prefill measurement.

Extended the harness to compare the **real captured OpenAI provider input**, not just the SQLite m[0] hash. After the priced seed, restart passes 1–4 have the same 33472-byte shared prefix before the first post-restart user text:

```
SHARED_PREFIX_SHA256 1 33472 f75277d56d0d5facef75078319dcc037de582f24a830c4253bea3f04037f8fe7
SHARED_PREFIX_SHA256 2 33472 f75277d56d0d5facef75078319dcc037de582f24a830c4253bea3f04037f8fe7
SHARED_PREFIX_SHA256 3 33472 f75277d56d0d5facef75078319dcc037de582f24a830c4253bea3f04037f8fe7
SHARED_PREFIX_SHA256 4 33472 f75277d56d0d5facef75078319dcc037de582f24a830c4253bea3f04037f8fe7
```

This compares the shared system/history/conversation prefix, not appended user text/answers or request metadata. It does not claim tool-schema equality or scheduler-level defer behavior in compaction-off mode. Separate ordinary-compaction unit tests exercise history-bearing SOFT+ replay.

Non-vacuity control: staged the live harness, injected `NON-VACUITY BREAK` into captured prefix 2, observed `error: provider shared prefix changed as proven input rose` as the sole failing check, then restored from the index and confirmed no unstaged diff. Earlier fold/restart checks remained green. This proves the new prefix guard rejects differing captures; it is not a production-code mutation.

The requested pure-replay differential passed: `RESULT IDENTICAL defer_passes=4` for master versus the reviewed branch, TS only. This is complementary to, not a replacement for, the host capture.

### 6. Rust mode — inspected, not executed

`rust-mode-transform.ts:1757` sends `render_config` consisting of provider, model, variant, and system-prompt hash. It sends the numeric live history budget separately. `crates/mc-module/src/transform.rs` constructs its own effective identity via `render_identity_base`, content epochs, and the frozen mural identity, and compares it with persisted render config. The coordinator's numeric window/history budget is **not** part of that identity, so this exact numeric-identity drift mechanism is not present there. No Rust production files changed in this patch. Rust budget-edit invalidation is not established by the TS policy tests; a Rust runtime adversarial test was not run, and no Rust failure is alleged.

### 7. Opus 5.5 / Fable 5.1 — no new fold bypass found

The change modifies an operand of the existing `render_config` HARD decision, not the materialization/preflight/strip execution path. Policy edits still use the existing HARD path; rising window changes remove folds rather than create a new mid-session fold path. Existing merged-reasoning frozen-ID tests and Pi reasoning-replay tests passed alongside the materializer suites. This is source-path confirmation plus reasoning regressions, not a new signed-thinking real-provider run for those specific models.

## Isolation and verification

All host roots were under `/private/tmp/magic-context/issue-572-review/opencode-e2e-*`. The probe ran `lsof -p <pid> -Fn` before turns and after every restart and checked **every open `.db`, `.db-wal`, `.db-shm`** against the fixture's real data directory. Final branch shrink run: PIDs **12656 / 13175**, both databases and their WAL/SHM files rooted under `/private/tmp/magic-context/issue-572-review/opencode-e2e-1790720381730-4fldyb/data/`. Master shrink PIDs **20534 / 21415** used `opencode-e2e-1790720444538-mewijf/data/`; stable wire PIDs **13340 / 13757 / 14469** used `opencode-e2e-1790720397024-msh52k/data/`. No live stores/config were opened intentionally. Master was extracted with `git archive` inside this worktree and used the same instrument and dependency installation, not the parent checkout.

Verification artifacts are retained under `/tmp/magic-context/issue-572-review/`:

- `master-probe.log`, `branch-probe.log`: original worker probes, baseline/stable gates passed.
- `master-shrink-probe.log`, `shrink-probe.log`: comparative lowered-window traces, both commands passed.
- `branch-wire-probe.log`: extended stable gate and shared provider hashes passed; `branch-wire-restored.log` repeats the passing check after restoring the mutation.
- `wire-prefix-mutation.log`: named shared-prefix guard failed as intended; mutation restored.
- `plugin-final-tests.log`, `pi-final-tests.log`: full targeted materializer/resolver/history-budget/taxonomy suites (**158 pass, 0 fail**) and Pi materializer plus merged/Pi reasoning replay (**88 pass, 0 fail**) passed.
- `plugin-typecheck.log`, `pi-typecheck.log`: package typecheck scripts passed (these package scripts exclude test files).
- Scoped TypeScript check including all edited tests exposed **pre-existing** errors elsewhere in the materializer test files; no remaining errors in added review hunks. A narrower check of the host probe + resolver test and all their imports passed.
- Full e2e `tsc --noEmit` failed on unrelated existing scripts/tests (issue-564 SQLite types, Rust harness client shape, OpenCode2 fixtures, etc.); no issue-572 probe diagnostic. No manifests/lockfiles changed; `bun install --frozen-lockfile` was run in this worktree.

Initial combined tests with a globally forced `OPENCODE_DB`/storage root interfered with tests' own date-index fixture setup; one retry timed out. Re-running the suites in separate processes with isolated XDG roots but without overriding their per-test storage selection passed. These were review-runner setup failures, not patch findings.

Not executed: Rust runtime, OpenCode2 executable host, mixed-version executable legacy upgrade, live accepted-input reset/catalog fallback, and specific Opus/Fable signed-thinking provider scenarios. Their coverage is explicitly limited above.
