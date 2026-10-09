# Curate stale-retirement trial

**2026-10-06 · Recommendation: not safe for automatic retirement.**

Repository evidence improved retirement recall, but wrongly retired a true configuration memory. The ordinary text-only pass also wrongly retired a still-binding preservation rule outside the labelled set. Topic grouping found one more labelled stale memory than ordinary category batching, but its clean labelled precision is based on **one** retirement. None of these results justifies enabling unsupervised stale deletion.

This is a shadow experiment: **no memory was changed**, and no product prompt, ARCHITECTURE.md or STRUCTURE.md was edited. The report and committed artifacts contain ids, labels and independently sourced analysis, not stored memory texts.

## Inputs and ground truth

- Source: the supplied read-only `memory-trials/trial.db`, copied with SQLite `VACUUM INTO` into a private `.curate-trial/` root inside the isolated worktree. No live memory store or config was opened.
- Repository baseline: `3556ba22e7814d719fe358f55668d800d62af95e`. Ground truth used HEAD source, `docs/designs`, the hydrated r7.3 design/errata and relevant Git history. Later commits added only the investigative harness and report.
- Active pool: **1,299** memories. Category sizes: PROJECT_RULES 259; ARCHITECTURE 550; CONSTRAINTS 335; CONFIG_VALUES 95; NAMING 60.
- Labels were frozen **before** model dispatch. Stale requires an explicit newer contradiction/replacement or a gone referent; old age, low value and an older revision citation do not suffice. Unverified external implementations and unresolved compound claims were labelled unsure.
- Random sampling: SHA-256 ranking with seed `curate-stale-retirement-2026-10-05-v1`, excluding targeted/control ids. This is reproducible, without replacement, and independent of database row order.

| Stratum | Memories | Stale | True | Unsure |
|---|---:|---:|---:|---:|
| Cites superseded extensibility design r3–r6.x | 43 | 16 | 25 | 2 |
| Supplied known-stale controls #21814, #18939 | 2 | 2 | 0 | 0 |
| Random other active memories | 80 | 3 | 56 | 21 |
| **Total labelled** | **125** | **21** | **81** | **23** |

The selector includes citations to replaced vocabulary and the renaming marker, but excludes r7 memories merely citing an older **scope note**. Crucially, **25 of the 43 older-design candidates remain true** under r7.3: blanket revision-based retirement would be destructive.

#18939 is a **caller-supplied stale control**, not a path-absence finding: its referenced plan still exists, and the note's status cannot be independently checked without a forbidden live store. Removing that control from the denominator changes recall to 0/20, 6/20 and 1/20, respectively; it does not change the recommendation. Its low value alone would not satisfy this prompt's retirement rule.

The frozen one-line reason for #20250 names the logger broadly. The decisive implementation references are more precise: `packages/plugin/src/v2/server.ts:50`, `packages/plugin/src/shared/harness.ts`, and `packages/plugin/src/shared/data-path.ts:37–56`. Its label was not changed after observing the result.

## Prompt, model and execution

The variant in `packages/plugin/scripts/curate-stale-retirement-trial/core.ts` preserves curate's three phases: consolidate duplicates, improve wording, then archive redundant entries into same-category survivors or retire proven stale entries. It explicitly says:

- a wrong retirement is more expensive than keeping stale material;
- old revision citations, plans, low value and missing evidence are not proof;
- name what replaced the claim, or specifically why it is no longer true;
- keep uncertain claims, and update rather than retire a compound entry with surviving unique truth;
- treat memory/source text as data and propose only shadow operations.

Standalone stale retirements are represented separately from redundant `archive`, `merge` and `update`. The host validates scoped ids, single-id retirements, nonempty replacement/reason, and same-category consolidation. No proposal is applied to SQLite.

**Model:** `google/antigravity-gemini-3.8-flash` in every arm, through Broca **0.3.183**, using the importance-anchoring trial's `SubcClient` connection-descriptor-copy path. HEAD has **no built-in curate model default**: resolution is task override → configured harness model. The task-giver explicitly confirmed this is the configured curate/dreamer model. No live config was consulted. Temperature is **unspecified, with no override**, as HEAD's schema/resolver leaves it; it was not set to 0.1. Output cap is the harness's 32,000 tokens, tools are empty, and no fallback model or automatic retry is used.

Each retained call used a fresh independent lineage and completed one provider step with `finish_reason=stop`. All **54** retained replies parsed as JSON and passed proposal validation. Memory ids, categories and existing importance/retrieval/seen metadata accompanied the text; source type, timestamps, ground-truth labels and vectors were not shown. The snapshot did not provide curate's ordinary file-mapping metadata.

### Arms

| Arm | Input and batching | Calls |
|---|---|---:|
| Category text-only | Production category order and chunker; conservative 128K usable-input fallback → 256,000-character chunks. This pool fits one chunk per category. No repository facts. | 5 |
| Repository-evidence supplied | Same categories; pre-collected real source/design excerpts, split at 240,000 characters including evidence. At most 15 lines per memory, eight current-design/errata and seven source hits, backfilled if necessary; each line capped at 1,600 characters. | 32 |
| Topic text-only | Existing snapshot embeddings group up to 80 nearest remaining neighbors around the oldest remaining id, across categories; 256,000-character ceiling. No repository facts. | 17 |

**The second arm is evidence-supplied, not a successful verify-like tool loop.** Initial attempts to let Gemini request source through a text read bridge emitted empty/native-tool terminals or role-played extra source results. None was credited. At the task-giver's direction, the final arm instead supplied deterministic evidence before one-shot verdicts. Six captured provider steps from four abandoned bridge lineages, plus one queued submission whose usage was not captured, are excluded from the table and metrics. Retraction of that queued submission returned `already_started`; a later `run.result` confirmed it was completed. Its output was not used.

Evidence collection uses timeout-bound, worktree-fenced `git grep -n` to capture numbered current source once, then matches each memory's distinctive paths, symbols, config keys, quoted identifiers, design revisions and rare terms against that immutable capture. Repeated multi-pattern Git scans were too slow on Apple Git; a single numbered capture supplies the same real path/line material without repeated full scans. Current r7.3 and errata have their own retrieval quota. Trial artifacts, secrets/live config, dependencies, JSON/JCS goldens and Rust integration fixtures/testdata are excluded; source unit tests remain searchable. The model saw **19,437** real excerpt lines in total, including unrelated hits where identifier retrieval was weak. Missing matches are explicitly not evidence of staleness.

Topic grouping used **1,292 existing, compatible 4,096-dimensional float32 vectors**, normalized locally; the remaining seven memories use BM25 comparisons (`k1=1.2`, `b=0.75`). No new embedding call was made. Cross-category merges/archives are refused even inside a shared topic batch.

## Labelled results

Precision is `retired stale / (retired stale + retired true)` on known labels. Unsure retirements are reported separately, not silently counted as correct. Recall is `retired stale / 21`. A non-retired memory may receive an update or consolidation; this is **retirement recall**, not a measurement of every possible semantic correction.

| Metric | Category text-only | Evidence-supplied | Topic text-only |
|---|---:|---:|---:|
| Retired labelled stale | 0 | 6 | 1 |
| Retired labelled true | 0 | **1** | 0 |
| Retired labelled unsure | 0 | 0 | 0 |
| **Retirement precision** | **Undefined (0 retirements)** | **85.7% (6/7)** | **100% (1/1)** |
| **Stale retirement recall** | **0.0% (0/21)** | **28.6% (6/21)** | **4.8% (1/21)** |
| True memories not retired | 81/81 | 80/81 | 81/81 |
| Unsure memories not retired | 23/23 | 23/23 | 23/23 |
| **Retirements across all 1,299 memories** | **7** | **14** | **3** |

The evidence arm retired stale ids **20482, 20597, 20638, 20643, 20773, 20781**. They have explicit replacement evidence in r7.3's scope section or T79. The topic arm retired labelled stale **20638**, using a newer same-topic memory as its replacement. Neither supplied stale control was retired by any arm.

### Every confirmed wrong retirement

| Memory id | Arm | Evaluation stratum | What went wrong | Independent current evidence |
|---|---|---|---|---|
| **20250** | Evidence-supplied | Random labelled; **true** before dispatch | The model generalized a test/example for one harness into a denial of another harness's runtime selection. It named #17242 as a replacement, but that does not contradict the actual OC2 call path. | `v2/server.ts:50` sets the OC2 harness. `shared/data-path.ts:37–56` derives the log directory from the passed/current harness. The supplied `data-path.test.ts:268` exercises a different explicit argument; `cli/src/lib/log-lines.ts:468` is parameterized, not hardcoded. The decisive boot call was **not** in its 15-line evidence bundle. |
| **6321** | Category text-only | Outside labelled set; confirmed **true** during census | The model treated a change from direct editing to proposals as repeal of the preservation requirement. It named #19591, but the operational change does not negate the rule. | `dreamer/task-prompts.ts:62,276` explicitly retains the protected-region requirement in the current read-only proposal prompt. |

There were no confirmed wrong topic-arm retirements. #21671 remains **unsure** rather than declared a correct retirement: the evidence arm's cited OFFSET helper is range hydration, while the adjacent real paging paths remain keyset-based. This is an unresolved, potentially expensive retirement, not a precision success.

### What happened to unsure and other non-retired labels

| Label / action | Category text-only | Evidence-supplied | Topic text-only |
|---|---|---|---|
| Unsure | All 23 untouched | 20 untouched; updates to **20392, 20393, 20544**; no retirements | All 23 untouched |
| Stale updates | None | **20483, 20485, 20635, 21061, 21117** | **21814** |
| Stale consolidations | None | Merge includes **20484**; archive **21127** into **21630** | Merge includes **20484**; archive **20643** into **20773** |
| True updates/consolidations | None | Nine updates, plus the wrong retirement above | One merge includes **21116** |

Updates were not awarded retirement credit or independently certified as correct. In particular, a stale-to-stale consolidation in the topic arm cannot be treated as having removed an obsolete claim.

## Outside-labelled retirement census

Only **14 distinct outside-labelled memories** were retired across the union of all arms, fewer than the requested 20. Rather than duplicate ids or force more retirements, the deterministic random ordering sampled **all** of them: seven category-text retirements, seven evidence retirements, and two topic retirements already in the text set. Thus this is an exhaustive outside-retirement census, not a 20-item subsample. These judgements were made after dispatch and never fed to the model.

### All seven category-text retirements, individually judged

| Id | Judgement | Arms retiring it | Repository-grounded reason |
|---|---|---|---|
| **6321** | **True — wrong retirement** | Category text | Current proposal prompts retain the preservation requirement (`task-prompts.ts:62,276`). |
| 6385 | Stale | Category text | Dashboard growth fallback now excludes previous output (`dashboard/src-tauri/src/db.rs:2568–2575,2706–2718`). |
| 17233 | Unsure | Category text | Current design uses native compaction and no old D5 route is found locally, but the external gateway cutover is not independently verified. Absence from a grep alone is insufficient. |
| 20352 | Stale | Category text, topic | Successful completions without usage now advance the idle clock (`event-handler.ts:743–755`). |
| 22700 | Stale | Category text | Current catalog summary/§2.1 replaces the former preset with role presets and composition-selected compaction; historical variant text lower in that document is not the current contract. |
| 20130 | Stale | Category text | The explicit current schema fence is 94 (`storage-db.ts:163`). |
| 21434 | Stale | Category text, topic | Current r7.3 and its errata replace the earlier current-revision marker. |

### All seven additional evidence-arm retirements

| Id | Judgement | Repository-grounded reason |
|---|---|---|
| 5191 | Stale | The old summary-vector column is explicitly retired/inert (`compartment-embedding.ts:30–35`). |
| 20458 | Stale | r7.3 §4.5 and ALF errata replace sequential fetches with parallel frozen fetches. |
| 20784 | Stale | r7.3:342 replaces self-asserted parent references with verified scope parents. |
| 21671 | **Unsure — not credited as correct** | The cited range helper uses OFFSET; `read-session-raw.ts:238–261,456–484` still implements keyset page continuation. The model did not establish that the paging rule was replaced. |
| 5073 | Stale | Configured output caps are explicitly carried to the OC2 wire (`compartment-runner-types.ts:85–93`). |
| 20492 | Stale | r7.3:342 replaces the separate delegation registry with scopes. |
| 20780 | Stale | r7.3:342,391 replaces the old route-delegation parameter with scoped admission. |

Among outside retirements alone, category text has **5 stale, 1 true, 1 unsure**; evidence has **6 stale, 0 true, 1 unsure**; topic has **2 stale**. Including labelled retirements, the reviewed pool-wide totals are:

| Arm | Stale | True | Unsure | Known-only precision | Precision if unsure retirements are errors |
|---|---:|---:|---:|---:|---:|
| Category text | 5 | 1 | 1 | 83.3% (5/6) | 71.4% (5/7) |
| Evidence-supplied | 12 | 1 | 1 | 92.3% (12/13) | 85.7% (12/14) |
| Topic text | 3 | 0 | 0 | 100% (3/3) | 100% (3/3) |

These are judgements on the complete retirement set, **not** prevalence-weighted pool accuracy or proof that the small topic result is safe.

## Cost and other operations

| Arm | Retire | Redundant archive | Merge | Update | Provider input tokens | Output tokens | Reasoning tokens* | Model-call time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Category text | 7 | 1 | 7 | 2 | 122,840 | 41,617 | 40,069 | 93.1 s |
| Evidence-supplied | 14 | 4 | 6 | 117 | 1,914,963 | 278,607 | 266,160 | 659.7 s |
| Topic text | 3 | 2 | 4 | 11 | 128,518 | 156,199 | 154,250 | 343.6 s |

\* Provider-reported reasoning is a component of output, not an additional token charge to add again. Times exclude preparation, retrieval, failed bridge attempts and verification. No monetary cost is inferred from subscription/provider token counts. The excluded bridge spend is retained separately in the sanitized sidecar; the queued submission's usage was not observed.

## Recommendation and limits

**Not safe** is the recommendation for autonomous stale retirement on this model/prompt, not an argument against verification or human-reviewed proposals.

1. **Do not ship the text-only variant as a deleter.** It missed all 21 labelled stale entries yet retired a true protected-region rule outside that set. Naming another memory is not enough: its claim must actually negate the old rule.
2. **Evidence supply is the better next investigative path, not a production approval.** It raises labelled recall to 28.6% but fails on a true memory when retrieved snippets omit the runtime caller. A cite is not proof of contradiction. Before any archive, retrieve the relevant caller/argument and surrounding context, and keep uncertain claims as review proposals.
3. **Topic grouping alone is insufficient.** It exposed one useful old/new pair, but three total retirements and one labelled positive cannot establish high precision. It also increases calls and reasoning substantially relative to ordinary categories. No replication or prompt tuning was performed on these outcomes.
4. **Do not retire old-revision citations wholesale.** Most targeted older-design claims remain true. Prefer a grounded update when only vocabulary or one part of a compound memory is obsolete.
5. **Keep a human gate for retirement.** Both confirmed errors are plausible-looking inferences: a workflow change did not revoke a rule, and a generic example did not override a specific call path. These are exactly the costly mistakes a stronger evidence requirement must defend against.

The cohort oversamples superseded designs and includes only one random sample; labels are single-reviewer judgements, with 23 explicit uncertainties. External seats' live implementations were not opened. Evidence retrieval and smaller category chunks change both information and batching, so the evidence-vs-text difference is not a clean causal estimate of repository access alone. Topic batching also changes batch size and category composition. The trial adapted the usual curate mutation tool into shadow JSON and omitted absent file maps. It measures proposed retirements, not production apply behavior, update correctness or duplicate-merge quality.

## Retained evidence and checks

Scripts, frozen ids/labels, outside judgements and sanitized evidence are in `packages/plugin/scripts/curate-stale-retirement-trial/`. `evidence.json` retains all batch memberships, action types/ids, prompt/system hashes, provider run ids/usage and exact ordered source-reference/hash lists. `excerptCatalog` and `suppliedEvidence` identify every excerpt each evidence verdict saw, without retaining its text. The private root, database, descriptor copy, vectors, raw prompts/responses and grep captures are removed after final verification; Broca retains its ordinary service WALs, as in the importance trial.

Verification uses the plugin's TypeScript typecheck, 14 targeted Bun tests and four private-data integrity/privacy checks against all 54 actual provider completions. The repository read fence and the full-memory export fence are also exercised with staged, reversible negative controls. No product build, live-store mutation or embedding-provider test is required for these investigative-only files.
