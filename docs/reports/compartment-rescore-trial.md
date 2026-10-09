# Can stored compartments be rescored without rebuilding them?

Trial date: 2026-10-06. Base: `2b57304c2f140c80c37d9dcccf4e7a4f94563dd9`. Model: **`google/antigravity-gemini-3.8-flash`**, via the anchoring trial's Broca/SubcClient connection-descriptor path. Temperature 0.1, no tools, 32,000 max output tokens, no model fallback. The requested model was reachable.

## Verdict

**Yes, title + episode type + P1 contain enough signal for a useful score-only repair.** The model separated tactical work from durable constraints without raw messages or existing scores. Sample SD increased from **13.32 to 18.56** in session A and **18.35 to 20.85** in B. True neighbouring scores within ±2 fell from **22.0% to 10.0%** and **27.5% to 9.5%**, respectively.

This is not a clean “flat before, correct after” story. The whole histories already contain substantial variation; only 17% of the sampled old scores were 70–74. Qualitative review found useful demotions and retained high invariants, but also underweighted constraints and **material generation noise**: a verbatim rerun changed scores by an average absolute **4.33 points**, with **10/60 crossing rubric bands**. Do not treat the precise new integer as ground truth or repeatedly rescore until a desired histogram appears.

The P2 + recent unscored titles variant has **no demonstrated quality advantage**. It shifted the mean down another 4.35 points relative to the paired baseline, used much more input, and sometimes changed the judgment without new evidence. Prefer P1-only for a first implementation, with a visible audit trail and review/undo.

Cache safety is a separate shipping prerequisite: **naive SQL importance UPDATEs request an early HARD in ck-mc**, despite TS generally leaving m[0] frozen. The [design](../designs/compartment-rescore.md) traces both paths and recommends render-only score overlays consumed at independently required natural folds.

## Data, sampling and controls

* Only `$TMPDIR/magic-context/memory-trials/trial.db` was opened, using read-only SQLite to create a private copy. No live store, host history or user config was read. The only credential input was a copied subc connection descriptor; its contents are not retained in git.
* A = `ses_331acff95fferWZOYF1pG0cjOn`, **2,188** compartments. B = `ses_227ce5788ffeRPA9THoPLOQreO`, **2,078**. These are two real histories, not a synthetic corpus.
* **300 per session**: 100 evenly spaced non-overlapping triplets from sequence order, including first and last rows. Each session supplies 200 true immediate chronological pairs. Pair shares below use exactly those pairs, not the previous *sampled* row across a gap. Triplets slightly cluster observations; no independent-observation confidence interval is claimed.
* The 600 rows were deterministically shuffled together into **30 batches of 20**. No immediate chronological neighbours from the same session appear in one batch. Numeric ids are response correlation keys; title, episode type and P1 are the only semantic candidate inputs. No old importance, date, range, sequence or session label was shown. Numeric ids can weakly reveal ordering; a shipped scorer should use opaque per-batch handles.
* Every batch carried **three scored cross-project seeds** from the production pool and the revised Importance section including “Scoring procedure.” Source: `packages/plugin/src/hooks/magic-context/reference-seeds.source.xml`, generated to `reference-seeds.generated.ts`; production selection/rendering: `reference-retrieval.ts:98-148`. Seeds rotate across three distinct bands per batch, not all sixty examples per request. The only rubric edit was removal of “set once at creation and never updated,” which conflicts with this explicit experiment. No forced distribution or added score anchors from these sessions.
* Batches 0, 14 and 29 were repeated with **identical prompt/system bytes**, ids, order and seeds, in fresh provider lineages: 60 compartments total. The context arm used the same 60 and added P2 plus eight latest unscored titles from the appropriate entire session. Early candidates therefore receive retrospective later context in that arm. Repeat/context order rotates; each generation is independent, with no prior answers in its conversation.
* The analyzer validates one `stop`-finished provider step and exact unique requested ids per accepted cell. **36 accepted generations** produced 600 base scores, 60 rerun scores and 60 context scores. Two base generations (batches 10 and 16) returned only 19/20 scores despite `stop`; both were rejected and explicitly rerun in fresh lineages. An in-flight batch 14 lost its client when the original concurrent runner exited on batch 10's error; it was reattached and recovered, not generated twice. The runner now drains concurrent work before closing on failure. All failures and spend are retained in sanitized evidence.

There were **38 distinct provider generations**, including the two rejected answers. Reported usage, counting the recovered run once: **471,249 uncached input tokens + 40,835 cached input tokens; 102,520 output tokens**, of which 71,475 were reported reasoning tokens (not added a second time). This is usage, not a dollar estimate; provider price/accounting metadata was not available in the trial inputs. Broca keeps its normal provider run records; no compartment/fact publication occurred.

## Before and after

SD is population SD. Band counts use the rubric's exact inclusive boundaries; they are not equal-width histogram bins.

### Complete supplied histories, old scores only

| Session | n | Mean | SD | Min–max | 1–9 | 10–29 | 30–59 | 60–84 | 85–100 | Within ±2 of actual previous |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|
| A | 2,188 | 69.31 | 15.03 | 1–95 | 2 | 44 | 372 | 1,556 | 214 | 460/2,187 = 21.03% |
| B | 2,078 | 67.58 | 17.87 | 1–92 | 27 | 82 | 301 | 1,492 | 176 | 578/2,077 = 27.83% |

### Matched 300-row samples

| Session / scores | Mean | SD | Min–max | 1–9 | 10–29 | 30–59 | 60–84 | 85–100 | 70–74 | Within ±2 of actual previous |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| A old | 69.99 | 13.32 | 15–90 | 0 | 3 | 51 | 222 | 24 | 51 (17.0%) | 44/200 = 22.0% |
| A new | 64.05 | 18.56 | 12–92 | 0 | 21 | 77 | 172 | 30 | 37 (12.3%) | 20/200 = 10.0% |
| B old | 67.60 | 18.35 | 1–90 | 5 | 11 | 44 | 215 | 25 | 50 (16.7%) | 55/200 = 27.5% |
| B new | 61.99 | 20.85 | 1–92 | 8 | 24 | 72 | 169 | 27 | 39 (13.0%) | 19/200 = 9.5% |

Across 600, new scores have mean **63.02**, SD **19.77**, range **1–92**, and band counts **8 / 45 / 149 / 341 / 57**. Months-level concrete work remains the majority (56.8%); the scorer did not merely flatten everything downward. Old-score full-history SD is larger than the flattening description might suggest: local plateaus do not characterize all 4,266 rows.

Temporal thirds of the evenly spread sample (100 rows each) show where the spread changed:

| Session / sample third | Old mean → new mean | Old SD → new SD |
|---|---|---|
| A early | 72.11 → 57.71 | 13.16 → 18.64 |
| A middle | 64.24 → 61.18 | 14.68 → 19.15 |
| A late | 73.61 → 73.27 | 9.63 → 13.64 |
| B early | 69.46 → 59.72 | 15.49 → 19.29 |
| B middle | 74.70 → 64.20 | 13.06 → 17.17 |
| B late | 58.63 → 62.04 | 21.57 → 25.05 |

The late A third broadened without lowering its mean, while late B rose. This is consistent with compartment-specific judgments rather than a uniform score discount. It does not establish improved rendered-history quality; that would need replay measurements with frozen-cache semantics and independent retrieval/recall evaluation.

## Run-to-run noise and extra-context arm

Positive difference = later arm minus comparison arm. The same 60 ids are paired by identity, never output position.

| Comparison | Mean difference | SD of difference | Mean absolute difference | Difference range | Within ±2 | Different rubric band |
|---|---:|---:|---:|---|---:|---:|
| Verbatim rerun − base | +0.03 | 5.98 | 4.33 | −19 to +16 | 23/60 (38.3%) | 10/60 (16.7%) |
| P2/titles − base | −4.35 | 8.24 | 6.85 | −27 to +15 | 16/60 (26.7%) | 12/60 (20.0%) |
| P2/titles − rerun | −4.38 | 8.20 | 6.62 | −28 to +17 | 21/60 (35.0%) | 12/60 (20.0%) |

| Paired arm (n=60) | Mean | SD | 1–9 | 10–29 | 30–59 | 60–84 | 85–100 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Base subset | 61.42 | 19.94 | 2 | 4 | 15 | 36 | 3 |
| Verbatim rerun | 61.45 | 20.03 | 2 | 4 | 17 | 32 | 5 |
| P2 + recent titles | 57.07 | 20.77 | 2 | 4 | 22 | 30 | 2 |

The additional context creates more change than the measured rerun noise, but change is not quality. Private review found both reasonable demotions of code-recorded work and questionable demotions of durable findings; no consistent rubric-fit gain. In example **25**, baseline 50 and repeat 58 are both within routine-work territory, while added context raises it to 65 without a new lasting constraint. Example **21** remains appropriately negligible (8 / 8 / 6). Some non-table candidates moved 17–27 points, so a “small contextual refinement” claim is not supported. The variant's input usage was about 21–23k tokens per batch versus about 12–13k for those same baseline prompts. P2 overlaps P1; latest titles do not reliably tell whether an old thread remains open.

This is a small, non-blinded qualitative comparison, not an accuracy benchmark. Seed/prompt/order are held fixed for reruns, but provider execution can still vary; some runs reported reasoning tokens and others did not. No attempt was made to change thinking configuration or discard low-spread answers. Rerun noise also means a band-boundary decision should not be treated as deterministic.

## 25 examples and rubric judgment

Dates are **stored `created_at` in UTC**, not proven raw-message dates. Many early A compartments share a May 31 import timestamp and B compartments a June 2 timestamp; their narratives can refer to earlier work. All three latest sampled compartments from both sessions are included. Titles are verbatim; reasons below paraphrase the model's one-line explanation rather than reproducing stored P1. Judgments are an independent reading of private P1 against the revised recall-duration rubric, not claims derived from matching old/new scores.

| # | Session / created date / sequence | Title | Old → new | One-line reason | Does the new score fit? |
|---|---|---|---|---|---|
| 1 | A · May 31 · 0 | Created comprehensive guide and documentation for context-management | 40 → 45 | Documentation records the outcome; details can be recovered from the repository. | **Fits:** weeks-level routine documentation, not a permanent design constraint. |
| 2 | A · May 31 · 1 | Fixed legacy hook dead zone when context-management hook is disabled | 75 → 74 | A safety gap could silently eliminate fallback protection. | **Borderline:** months is defensible, but a lasting correctness invariant could justify 85+. |
| 3 | A · May 31 · 2 | Investigated scheduler non-execution and implemented tokenless TTL refresh fix | 70 → 58 | The fix explains a scheduler stall caused by inappropriate TTL-clock refresh. | **Probably too low:** a reusable failure mechanism warrants accurate months-level recall, not only code recovery. |
| 4 | A · May 31 · 22 | Wired variant flushes and fixed nudge delivery dead zones | 82 → 58 | Fixes connect cache identity changes and delivery selection to correct scheduling. | **Probably too low:** the cache identity discovery is more durable than ordinary bug mechanics. |
| 5 | A · May 31 · 23 | Optimized context dump script and standardized nudge token interval | 65 → 45 | Script cleanup and a shared constant are directly visible in the code. | **Fits:** useful rough recall for weeks, without long-lived high-fidelity need. |
| 6 | A · Oct 6 · 2185 | OC1 marker unfreeze merge to master, Pi idle-gap cache bust triage, crates.io dependency migration, and protected_tools cache review | 73 → 86 | Liveness blockers and cache-bust root causes constrain future recovery work. | **Fits:** permanent correctness findings justify the top band despite routine work mixed in. |
| 7 | A · Oct 6 · 2186 | crates.io migration merge, Issue #623 reply correction, historian publish lock-hold fix, and Rust hermetic CI restart hold | 73 → 71 | Concrete reliability fixes and user corrections remain valuable for related work. | **Fits:** substantial months-level work; not every detail is an indefinite invariant. |
| 8 | A · Oct 6 · 2187 | Rust hermetic CI daemon drift discovery, regression 2x2 steer, and CI cleanup review | 70 → 67 | An open diagnostic thread and CI-policy reasons deserve accurate recall. | **Fits:** months-level, with implementation still unresolved and rationale useful. |
| 9 | A · Jun 24 · 1016 | Investigating CI failure for v0.27.0 release | 20 → 12 | A brief start-of-investigation status has no durable finding yet. | **Fits:** tactical days-level recall, not importance proportional to potential incident size. |
| 10 | A · Jun 12 · 774 | Investigated dashboard blank window issues and checked Tauri version | 42 → 25 | Version checking and delegated triage are mostly transient. | **Borderline:** no resolved invariant, but the still-open investigation can justify low 30s. |
| 11 | A · May 31 · 354 | Designed and implemented shared Transcript interface | 78 → 75 | A shared abstraction governs work across different message representations. | **Fits:** re-enterable mechanism with useful design rationale. |
| 12 | A · May 31 · 576 | Designed v7 historian prompt: hippocampus identity, decay-aware tiers, importance scoring, and reference compartments | 90 → 92 | Foundational historian design establishes enduring memory and calibration rules. | **Fits:** a load-bearing specification, not merely a large implementation. |
| 13 | B · Jun 2 · 0 | Removed Hephaestus, Prometheus, and Atlas agents, and unified Sisyphus prompt routing | 75 → 64 | A substantial surface simplification changes how future work is organized. | **Fits:** months-level outcome whose exact mechanics also live in code. |
| 14 | B · Jun 2 · 1 | Codebase dead-code cleanup after agent removal | 60 → 25 | Deleted code and verified cleanup are self-documenting current state. | **Fits:** a strong useful demotion; effort and deletion volume do not demand high fidelity. |
| 15 | B · Jun 2 · 2 | Renamed Sisyphus to Alfonso and rebranded package to @cortexkit/alfonso | 70 → 62 | Project-wide naming and prompt changes are worth remembering accurately. | **Fits:** meaningful user-facing direction, with mechanical details recoverable. |
| 16 | B · Jun 2 · 21 | Made tasks background-only, renamed cancel arg, and updated background tool descriptions | 70 → 56 | Tool-surface simplification is largely recorded in implementation and descriptions. | **Borderline:** the explicit future execution constraint may warrant low months-level instead. |
| 17 | B · Jun 2 · 22 | Silenced metadata log spam and removed OpenCode references from prompts | 60 → 55 | Most changes are visible edits and cleanup. | **Probably too low:** the summary also records an enduring user-stated prompt convention; the reason underweights it. |
| 18 | B · Oct 6 · 2075 | Settled reconciler S8 and consent S6, pushed sentinel train matching, resolved Callosum push, and fixed flow authority and work show | 82 → 71 | Concrete delivery work includes authority and tracking mechanisms. | **Probably too low:** an authority-revocation invariant is hidden among routine outcomes and deserves top-band consideration. |
| 19 | B · Oct 6 · 2076 | Settled campaign auto-closure, stamped verify leaves, launched nudge and retry fixes, and held fleet tests for AGAUTH capture | 78 → 83 | Verification obligations and cancellation behavior constrain continued operations. | **Borderline:** high months-level is sound; a standing correctness rule could cross 85. |
| 20 | B · Oct 6 · 2077 | Monitored fleet quiet hold for AGAUTH capture as workers parked on asks | 18 → 22 | Temporary coordination and observation are self-correcting operational work. | **Fits:** days-level, even though the surrounding campaign is important. |
| 21 | B · Sep 28 · 1700 | User reported ANTAUTH status looks wrong | 12 → 8 | A brief acknowledgement contains no finding or durable decision. | **Fits:** almost no long-term recall is needed for this isolated status fragment. |
| 22 | B · Jun 2 · 23 | Removed legacy retry, json error recovery, and skill-mcp/mcp-oauth infrastructure | 70 → 45 | Repository cleanup and obsolete integrations are recoverable from current state. | **Fits:** weeks-level outcome, not a high score merely for broad removals. |
| 23 | B · Jun 11 · 149 | Refactored Alfonso primary prompt to reduce token size and focus on principles | 65 → 75 | Long-lived identity, economics and delegation choices warrant accurate recall. | **Fits:** substantive stated reasons and future-facing direction, not just a smaller prompt. |
| 24 | B · Jun 8 · 127 | Stale process cleanup incident and process-termination rule | 90 → 92 | An explicit user prohibition on destructive action must not be forgotten. | **Fits:** a permanent user-stated safety constraint belongs in the top band. |
| 25 | A · May 31 · 24 | Optimized transform performance via batching and indexing | 85 → 50 | The optimization is primarily a mechanism whose outcome is preserved in code. | **Fits:** routine-to-substantial performance work need not retain benchmark detail indefinitely. |

This deliberately selected early/latest/band-spanning table has **17 clear fits, four borderline placements and four plausibly underweighted cases**. It is not a random 25-row accuracy sample. Broader SD and reduced adjacent-score similarity are useful diagnostics, not substitutes for this semantic review. Some broad multi-topic compartments obscure their single most durable constraint; rescoring cannot repair their boundaries or missing rationale without rebuilding, which is outside this trial.

## Artifacts, reproducibility and limits

* Harness: `packages/plugin/scripts/compartment-rescore-trial/{prepare,run,analyze,core}.ts`, `core.test.ts`, README and sanitized `evidence.json`. Evidence retains ids, old/new scores, creation times, prompt/system/input hashes, seed selections by score, run ids and usage; **no candidate text, titles, reasons, credentials or raw model events**.
* Private review root: `$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2`. It holds only the provided DB copy, staged connection metadata and trial inputs/results. Retained temporarily for the parent to inspect; remove that exact root after review. Do not remove the supplied source root or the worktree.
* Reproduction uses outer `timeout` wrappers listed in the harness README. The package typecheck uses TypeScript 5.9.3 and includes `tsconfig.scripts.json`; the eight Bun 1.4.2 helper tests cover output validation, rubric extraction, score leakage and true-neighbour arithmetic. A deliberately leaked old score reddened only `candidate projection hides current score and chronology`; the mutation was staged/restored and the suite returned to eight passing tests.
* Neither shipping API nor schema/cache behavior was changed. No raw-history reconstruction, replay benchmark, embedding migration, whole-history rescoring, automatic backfill or native build was performed. The two supplied sessions likely overrepresent engineering/system-design work; do not infer a universal target histogram.
* A production job needs strict answer validation, explicit retries for omitted ids, source-identity CAS, resumability and model provenance. A one-time accepted score is preferable to an unexplained moving score; offer undo/review rather than automatically averaging repeated calls. The proposed command must preserve cached prefixes in **both** runtimes before being enabled for old projects.
