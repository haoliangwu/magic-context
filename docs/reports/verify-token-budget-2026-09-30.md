# Verify token-budget investigation — 2026-09-30

## Finding

**The incident was path (a): Gemini kept calling tools after finalization and
hit the two-refusal hard stop.** The user confirmed that verify's config contained
only schedules, so the then-default **1.7M** budget applied. Independently, live
`dream_runs` row **16335** records `budget=1700000`, `spent=1418834`,
`finalizeFired=true`, and `banked=0`, matching the supplied invocation.

The **1,418,834** prompt tokens (324,812 input + 1,094,022 cache read) are below
1.7M but above its **1.36M** finalize threshold. In this async transport the only
hard-stop state below the budget after finalize is two refused tool calls.
Consequently neither (b), crossing 100% on a completed answer, nor (c), skipping
80% on a coarse report, explains this incident. The old implementation did not log
finalization/refusals; absence of those lines did not mean finalize never fired.

Real OpenCode **1.18.30**, using the local mock provider, also reproduced the other
two mechanisms so their defenses remain covered. A fourth problem appeared first:
OpenCode emits `MessageAbortedError` for the transport's own abort, and the
session-error hook could mistake that late event for a provider failure in the
replacement finalize turn. Ignoring only that expected event makes finalization
usable; other provider errors remain failures. All host reproductions use
throwaway stores. The live database was subsequently queried **read-only** for the
attribution and sizing analysis below; live stores/config were never written.

## Host reproductions

`packages/e2e-tests/tests/dreamer-verify-token-budget-oc1.test.ts` uses the shared
verify implementation through `verify-broad`, bypassing incremental file-change
selection to isolate the budget behavior. It checks invocation status and actual
banked rows, not just mock replies. The 20-memory map probe checks the persisted
file-mapping records in `memory_verifications`.

Failure-probe investigation steps report 20K new input + 100K cache read, with a
1.2 s response delay so the real polling loop observes persisted usage. Refused
steps report 1 new input + 60K cache read. Normal-batch probes replay 15 read turns
plus an answer at 10K input + 100K cache per turn, totaling 1.76M. Output is small
and not charged.
Failure probes explicitly use a **1.4M test override**, not an asserted live setting.

| Path | Script / measured result |
| --- | --- |
| (a) refuses twice | Ten 120K reports reach 1.2M; finalize fires; two more read calls are refused. Stops at **1,320,002**, banked **0**, token-budget failure. |
| (b) finalize reply crosses 100% | Same 1.2M pre-finalize spend; completed XML costs another 120K input + 120K cache. At **1.44M**, fixed code banks **1** verdict. Restoring the old charge ordering discards it with a token-budget error and banks **0**. |
| (c) coarse step skips the 80% finalize threshold | Nine 120K reports reach 1.08M (<1.12M soft limit); the next report is 210K input + 120K cache. Stops at **1.41M**, no finalize request, banked **0**. This intentionally models a large newly-read input, not a 1M cache-read step. |
| normal verify batch | Twenty memories: **1.76M** replayed at the new 2.5M default; all **20** banked, no finalize/refusals. |
| normal map batch | Twenty memories: **1.76M** replayed at the new 2.5M default; all **20** mapped, no finalize/refusals. |

These are realistic *usage replays*, not measurements of Gemini's reasoning or
proof that every real memory requires this many turns. An in-flight step can be
sent before the polling loop notices the preceding usage; the hard cap therefore
is not an exact provider billing ceiling.

### Isolation and reproducible command

```sh
ROOT="$(getconf DARWIN_USER_TEMP_DIR)magic-context/verify-budget"
mkdir -p "$ROOT/home"
HOME="$ROOT/home" TMPDIR="$ROOT" MC_E2E_OC1_BUDGET_PROBE=1 \
  bun test --timeout 120000 packages/e2e-tests/tests/dreamer-verify-token-budget-oc1.test.ts
```

`opencode --version` is asserted to equal 1.18.30 before each probe. Each host has
separate config/data/cache/work roots and an isolated diagnostic-log override.
`lsof -nP -p <host pid>` is sampled before and after each run: every open `.db`,
`-wal`, and `-shm` must be inside the harness data home. One successful run sampled
PIDs **81673, 81993, 82056, 82134, 82238**, under respectively
`opencode-e2e-1790796315203-qro4nn`, `...1790796334297-m7adin`,
`...1790796351508-jgkag2`, `...1790796367516-3a57yc`, and
`...1790796389812-m9rt7q` beneath the root above. For example PID 81993 held
`data/opencode/opencode.db` and `data/cortexkit/magic-context/context.db`
(and their WAL/SHM files) there, with no database outside that data home.
This is sampled host-process proof, not a continuous descendant-process audit.

Observed diagnostic lines included:

```text
dreamer token budget: finalize fired {"budget":1400000,"spent":1200000,"finalizeFired":true,"refusedCalls":0,"hardStopped":false}
dreamer token budget: tool call refused {"tool":"read","hardStopped":false}
dreamer token budget: tool call refused {"tool":"read","hardStopped":true}
```

## Fix and batch sizing

Completed successful answers now take precedence over spend, including when one
poll receives multiple usage rows together, or a completed answer is already
available after two refusals. Usage is still charged; tools and validation retries
cannot extend a stopped budget. A child still investigating stops at the hard
limit or after two refused calls. Existing XML validation/application rules remain
in force: only a valid closed manifest can be banked.

All memory tool-loop batches are now **20**: verify and verify-broad 50 → 20,
map-memories 80 → 20. Defaults are **2.5M** prompt tokens for verify and map,
**3M** for verify-broad based on its separate fit. Curate and all other task
budgets are unchanged. These replace the proposed batches of five verify and six
map memories, which repeatedly paid fixed per-child costs.

### Live 14-day measurements and outcome joins

The [580 per-invocation rows](verify-token-budget-2026-09-30-runs.csv) include input,
cache-read and cache-write tokens, their sum (no output), model, task, timestamps,
joined run ID, processed memories, inferred batch size, and join quality. Window:
**2026-09-16 19:00Z–2026-09-30 19:00Z**; attempts must start and finish inside it.
The profiler opens `context.db` with SQLite `mode=ro`, sets `query_only=ON`, and
uses one read transaction; CSV output is in this repository, not the live store.

```sh
python3 packages/plugin/scripts/dreamer-batch-cost-profile.py \
  --db "$HOME/.local/share/cortexkit/magic-context/context.db" \
  --as-of 2026-09-30T19:00:00Z \
  --csv docs/reports/verify-token-budget-2026-09-30-runs.csv
```

There are **292 verify**, **77 verify-broad**, and **211 map** completed children.
Only **278** have a unique single-child task/run association; **296** belong to
multi-child tasks and **6** are unmatched. A join requires the same parent session,
task and contained time window (1 s recording tolerance). We do not assign a whole
task's output to every child or treat an unknown outcome as zero.

For verify, the saved task progress gives verified + updated + archived memories;
when no remainder remains, its total processed count (including skips/refusals)
is the inferred selected batch size. For map, a fully drained single-child task
uses the initial unmapped backlog as the inferred size and backlog reduction as
processed count. Map requeue work is not included in that backlog delta, a source
of size uncertainty. Failed tasks, zero-sized/zero-usage records and partial
remainder tasks are excluded from fitting. The CSV retains excluded rows.

`memory_verifications` is only corroboration: count **distinct memory IDs**, not
file rows, whose `verified_at`/`mapped_at` falls inside the child window and project.
Later verification replaces both timestamps, so rows stop matching earlier child
windows. Among the
Gemini fitting rows, only 16 verify, 8 broad and 5 map rows retain any current-state
matches; just 3 in each group exactly match inferred size. Those zeros are **not**
zero historical work and are not used as the fitting denominator.

### Fits, efficiency and budget arithmetic

Fit only OpenCode **antigravity-gemini-3.8-flash**, rather than pooling models or
hosts. Ordinary least squares with an intercept gives `T(N)=fixed+per_memory*N`:

| Task | Fit rows / distinct sizes | Fixed tokens | Tokens/additional memory | R² | Residual RMSE |
| --- | --- | ---: | ---: | ---: | ---: |
| verify | 57 / 27 (1–50) | 601,223 | 56,325 | .616 | 635,725 |
| verify-broad | 15 / 12 (1–50) | 386,999 | 80,761 | .832 | 529,592 |
| map-memories | 101 / 40 (1–75) | 880,094 | 43,527 | .507 | 729,870 |

A quadratic was also fitted. Verify gives `82,761 + 142,784*N − 1,878*N²`
(R²=.777, AIC 1498 vs linear 1527), broad gives
`−7,408 + 145,704*N − 1,483*N²` (R²=.898, AIC 394 vs 399), and map gives
`520,289 + 107,205*N − 1,165*N²` (R²=.648, AIC 2699 vs 2731).
Negative curvature improves descriptive fit, consistent with cost saturation and
step caps, but becomes non-monotonic within/near the observed range. It is not a
credible unbounded sizing model; the monotone linear fits set the budgets.

Linear expected **batch tokens / tokens per memory** (rounded):

| N | verify | verify-broad | map-memories |
| ---: | ---: | ---: | ---: |
| 5 | 882,847 / 176,569 | 790,802 / 158,160 | 1,097,728 / 219,546 |
| 10 | 1,164,471 / 116,447 | 1,194,606 / 119,461 | 1,315,363 / 131,536 |
| 20 | 1,727,719 / 86,386 | 2,002,213 / 100,111 | 1,750,632 / 87,532 |
| 50 | 3,417,464 / 68,349 | 4,425,034 / 88,501 | 3,056,438 / 61,129 |

Small batches reduce each child's bill but repeatedly pay fixed overhead, making
the **total cost of processing the same memory pool higher**. The budget is a
runaway guard, not a reason to make normal batches uneconomically small. Following
the parent sizing decision, use N=20 and round `expected/0.70`:

- verify: `1,727,719 / .70 = 2,468,170` → **2,500,000** (expected 69.1%);
- map: `1,750,632 / .70 = 2,500,903` → **2,500,000** (about 70.0%);
- broad: `2,002,213 / .70 = 2,860,304` → **3,000,000** (expected 66.7%).

Finalize remains at **80%** (2M verify/map, 2.4M broad); hard stops remain at 100%
or two refused tools. Batches using many tokens still save the checked memories
listed in any valid closed XML result.
**Residuals are large** and completed-only sampling omits failures; these are
conditional expected costs, not upper prediction bounds or a guarantee. Map
backlog proxies and project/file complexity confound the fit. No live budget
setting was changed. The large fitted fixed per-child cost merits a separate
investigation into setup/context/tool-loop overhead; the intercept extrapolates
to an empty batch, whose cost was not directly measured.

At a **20-minute** deadline and **four-minute** minimum batch slice, plan for up to
**five batches / 100 memories per run**, versus 25 verify memories with batch=5.
The 279-memory changed pool requires **14 batches / about three nightly runs**
at five completed batches/run. Exactly floor-sized turns plus scheduling overhead
can fit only four batches (80/run, about four nights); slower/heavy investigations
or partial manifests can reduce throughput further. The floor is unchanged.

Contract tests retain their claims: one full batch plus a durable tail,
timeout/outage recovery, closed-subset acceptance versus non-budget rejection,
and resume of omitted IDs. Fixtures are rescaled to 20, not deleted. The former
79/80 (then 5/6) closed-subset case is now 19/20 with the same one-ID retry contract.

## Verification and mutation controls

- Plugin `bun run typecheck` and `bun run build`: passed (build includes four v2 loader tests).
- Full dreamer directory + async transport + dropped-input guard tests: **430 passed**.
- Five real-host usage probes: **5 passed**, including log assertions and lsof checks.
- The verify test for preserving its minimum batch execution time passed with
  20-memory fixtures: 121 s, 20 verdicts saved, no second batch started. Together
  with the five usage probes, the revised real-host suite has **6 passed**.
  The existing 1.18.30 map/finalize probe also passed before this sizing revision.
- Plugin `bun run lint`: fails on pre-existing formatting in
  `scripts/self-tag-trial/host-plugin.mjs` (plus unrelated informational template
  suggestions). Biome checking all changed plugin files passes; the unrelated
  file was not changed.
- Extra e2e `bunx tsc --noEmit`: blocked by unrelated existing diagnostics in
  imported plugin/harness/probe files (missing retina package subpath declarations,
  readonly command-hook typing, SQLite type mismatches, and OpenCode 2 fixtures).
  It reports no errors in either changed e2e test; plugin typecheck remains green.

Completion-retention, abort-event and diagnostic-log mutation proofs below remain
applicable to the unchanged implementations; batch-size
controls were rerun against the 20-memory fixtures, and budget-default/read-only
profiler controls were added. Four synthetic Python tests cover linear/quadratic
fit recovery, insufficient variation, single-child distinct-memory attribution,
and an actual rejected write through the read-only connection.

Each control was staged before mutation, marked `NON-VACUITY BREAK`, shown with a
nonempty unstaged diff, then restored from the index and touched; the resulting
unstaged diff was empty. Each named red below was the **only** failing test in its
selected run; unselected host scenarios were filtered out, not claimed green.

| Mutated control | Exact red test (suite prefix where applicable) | Green control / result |
| --- | --- | --- |
| Discard completed answer in `charge` at 100% | OpenCode 1.18.30 verify budget: completed | 1.44M token-budget failure, banked 0; other host cases filtered |
| Restore aborting a completed answer when spend reaches the hard limit | dreamer budget on an async child > returns the final manifest after a soft nudge with 25 final tokens | 1-final-token case stayed green |
| Admit expected abort event as provider failure | OpenCode 1.18.30 verify budget: completed | MessageAbortedError, banked 0; other host cases filtered |
| Restore verify batch size 50 | runVerify disposition > banks a completed batch and reports the deadline remainder | mapper counterpart green; got 21 instead of 20 |
| Restore map batch size 80 | mapMemories disposition > banks a completed batch and reports the deadline remainder | verifier counterpart green; got 21 instead of 20 |
| Replace finalize diagnostic string | OpenCode 1.18.30 verify budget: completed | banking still succeeded; missing log assertion red |
| Replace refusal diagnostic string | OpenCode 1.18.30 verify budget: refusals | stop behavior unchanged; missing refusal log assertion red |
| Restore verify default budget 1.7M | dreamer prompt-token budget > sizes memory tool-loop defaults for twenty-memory batches without changing other budgets | other eight budget tests green; got 1.7M instead of 2.5M |
| Change profiler connection to SQLite mode=rw (synthetic DB only) | test_single_child_join_is_read_only_and_counts_distinct_memories | three fit tests green; expected readonly OperationalError not raised |
