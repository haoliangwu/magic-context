# Historian memory-block paired control

## Answer

**Yes: in this forty-case cohort, removing `<project-memory>` increases turn-one fact emission and already-known re-emission beyond the observed stripped-to-stripped noise.** The fresh full-memory arm **F emitted 86 facts**; the trial's stripped replies **T emitted 139**, and the fresh stripped repeat **S emitted 133**. The stripped repeat changed the total by only **−6 facts (−4.3%)**, compared with **+47 to +53 facts (+54.7% to +61.6%)** when comparing either stripped arm with fresh F.

The direction is **less suppression, not merely different wording**. Reading every emitted fact against the earlier pool found **0/86 fully covered facts in F**, versus **24/139 (17.3%) in T** and **24/133 (18.0%) in S**. Removing the block also changes which *not-fully-covered* rules become durable-fact candidates: it does not just add duplicates to an otherwise unchanged selection. Conversely, some rules appear only in F. This is not evidence that stripping improves factual correctness or preserves every important rule.

**Do not attribute every individual omission to the block.** T and S themselves change fact counts in 33/40 cases and rule-family selection in 35/40. The systematic yield/redundancy shift is much more directional than that noise; particular selection differences are not individually causal proofs. There is one fresh F and one fresh S per case, not a replicated full-memory variance estimate or a formal recall benchmark.

The historical full-memory outputs are **not the control** in these comparisons. This closes the system-prompt-version confound identified in the [v1](historian-merge-turn-trial.md) and [v2](historian-merge-turn-trial-v2.md) reports without pretending that the old historical outputs used today's system prompt.

## Corpus, identity and isolation

- Reused exactly the same forty newest snapshot cases, ordered by `created_at DESC, child_session DESC`, case 0 newest through case 39 oldest. No filtering by fact count or output shape.
- Copied **84 files** from the supplied private `$TMPDIR/magic-context/merge-turn-trial-bg4916/` into **`$TMPDIR/magic-context/historian-paired-control-bg7d08/`**: `trial.db`, the connection descriptor, manifest, judgments, forty inputs and forty recorded stripped first replies. The root is 0700, files 0600, copied database 0400 and opened read-only. Source and destination hashes were checked again after analysis. No live store or configuration was read, and the source root was not modified.
- **F:** read the complete original `user_prompt` directly from the copied `historian_runs` row. Its SHA-256 must equal `inputs/<n>.json`'s `originalPromptHash`; no XML reconstruction, reinsertion or whitespace round-trip. F's user prompt is byte-identical to the recorded original.
- **S:** the exact existing `input.prompt`, with the single literal memory span removed and surrounding bytes unchanged. Its hash, the removed block hash, original row identity and timestamp were checked. S is a fresh repeat, not T imported into a conversation.
- **T:** the trial's already-recorded stripped first reply. It is reused for comparison, not regenerated or billed again by this task. Its actual artifacts, not prose summaries of the old report, supply counts and usage.
- All three arms use **`google/antigravity-gemini-3.8-flash`**, the checked-in `crates/mc-module/testdata/historian-system-prompt.txt`, SHA-256 **`f6a5a6dac2c8e29f0c4c54d3eb3c482b6159b9bfce76831cca01928de5ddc978`**, **temperature 0.1**, **max output 32,000**, and **empty tools**. The analyzer verifies T's recorded settings against F/S rather than assuming parity.
- Same copied-descriptor `SubcClient` → Broca management-surface **`session.send` / `session.subscribe`** path as the trial. Every F/S session was read and confirmed empty before sending; 80 distinct sessions/runs, with no imports, continuations, alternate models or inference retries. All 80 new runs and 40 reused T runs completed with one provider step, `stop`, and a completed terminal event.
- Counterbalanced order: **20 F→S pairs and 20 S→F pairs**, alternating by case index, at most three pairs concurrently. The two-case pilot was retained, then the all-case invocation resumed without resending it. Pilot invocation about 60 seconds; resumed invocation **774 seconds**, including orchestration. Broca retains its normal service WALs; it is not an isolated provider daemon.
- No second turns, embeddings, database inserts or destructive decisions were run. Only scripts and this reviewed report are committed; prompts, replies, full memories, annotations and review packets remain private.

### Review definition and historical-pool limits

I read **all 358 facts** (86 F + 139 T + 133 S) and compared all forty three-arm selections. Coverage uses the same **snapshot `status='active'` and `created_at < original run time`** pool as v1, with 1,180–1,298 eligible rows. Two complete BM25 neighbours per distinct emitted text served as initial evidence; whole-pool keyword checks and complete identified passages resolved extra claims and joint coverage. Retrieval scores never determined a verdict.

**Known** means the entire emitted fact is already covered, possibly jointly by multiple earlier memories. A changed value, new identifier, wider scope, new mechanism or stronger constraint is not a clear duplicate merely because an older fact is related. **Debatable** marks genuine scope/implication ambiguity. Every fact has an ordinal coverage judgment and reason; known/debatable judgments name eligible evidence IDs. The reread's 24 known T ordinals exactly match the prior v1 annotation set.

This is still **not an exact reconstructed historical membership/content pool**. The snapshot lacks status-change and revision history. V1 demonstrated archived-now rows and later-edited texts in captured blocks. F sees the actual recorded block, but coverage grades remain conditional on the timestamp-cut snapshot pool. Thus zero fully covered F facts is not a proof of zero historical duplicates under perfect reconstruction.

For selection, I manually inventoried **case-local rule families** across F/T/S, treating paraphrases and prose/constant splits as the same family where they convey the same rule. Material qualifications and scope differences are described in the ledger. These are emitted durable-fact *candidates*, not an independent truth/durability verdict on every sentence, atom-level claim counts, or a transcript-derived recall denominator. The review is single-reviewer and not blinded to the published v1 examples.

## Facts, compartments and coverage

| Measure, forty runs per arm | Fresh full F | Trial stripped T | Fresh stripped S |
| --- | ---: | ---: | ---: |
| Emitted facts | 86 | 139 | 133 |
| Mean facts/run | 2.150 | 3.475 | 3.325 |
| Compartments | 51 | 52 | 51 |
| Mean compartments/run | 1.275 | 1.300 | 1.275 |
| Zero-fact runs | 9 | 1 | 0 |
| Fully covered by earlier pool | 0 | 24 | 24 |
| Fully covered share of emitted facts | 0.0% | 17.3% | 18.0% |
| Debatable coverage, separate from known | 1 | 5 | 4 |
| Not judged fully covered or debatable | 85 | 110 | 105 |
| Exact normalized-text duplicates of earlier pool | 0 | 0 | 0 |
| Hypothetical exact-duplicate insert attempts, including within-run repeats | 0 | 0 | 0 |
| Reviewed case-local rule-family presences | 87 | 143 | 138 |

The duplicate check uses production lowercasing/whitespace normalization on text. The insertion simulation starts from each case's eligible pool and adds each emitted fact in order, also detecting a normalized repeat within that run. **No inserts actually occurred**, and this is not a simulated chronological publication of all forty replays into one evolving store. Semantically repeated prose/config facts can still differ in normalized text; examples include S's case-13 NORMAL setting and case-14 reference counts. Exact-text equality would miss all 48 clear known re-emissions across T/S.

Removing the block increases the *not-clearly-covered* population too: after subtracting the 24 known facts, T has 115 and S 109 versus F 86 (these totals still include debatable cases). Under the narrower unambiguous classification, counts are **85 / 110 / 105**. The added output therefore is not solely duplication, although absence from this imperfect pool does not prove genuine novelty or useful recall.

### Paired effects versus the noise reference

In this table “more/fewer” refers to the **right-hand arm** relative to the left.

| Comparison | More / fewer / equal fact counts | Sum of absolute per-case count differences | Cases with changed rule-family sets | Rule-family symmetric difference |
| --- | --- | ---: | ---: | ---: |
| F → T | 24 / 8 / 8 | 75 | 35 | 112 |
| F → S | 23 / 8 / 9 | 75 | 36 | 101 |
| T → S, same-treatment noise | 15 / 18 / 7 | 46 | 35 | 75 |

The count effect also appears in both dispatch-order groups: **F-first cases: 35 F versus 64 S facts; S-first cases: 51 F versus 69 S**. This does not remove every cache/time effect, but the result is not driven solely by which arm ran first.

At the reviewed family resolution, **51 families in 26 cases appear in both stripped replies but not F**, versus **18 families in 13 cases appearing only in F**. These are within-case presences, not 51 globally distinct memories or 51 proven false omissions. They include known rules as well as not-fully-covered candidates. The smaller difference between T/S is substantial enough that a single changed fact, or the mere number of cases with a changed set, would not be convincing evidence on its own.

## Durable selection: examples and all-case check

### Case 1, revisiting the v1 pattern

The historical output had five facts and the original v1 stripped reply also had five, but selected different rules. With the valid fresh control, **F emits no facts at all**, **T five**, and **S six**; each still emits one compartment.

Both stripped replies select the quantized-report verification/approval rule (already covered by **#24495**), the named external-Cargo-path enforcement gate, Claude refusal-message handling, and the two user-level override keys. S additionally selects indefinite Broca snapshot retention and states the typed HTTP refusal more specifically. F's empty fact set cannot be equated to an empty narrative compartment.

The original historical lock-scan optimization does **not** reappear in either stripped repetition. Its disappearance is therefore **not evidence that memory removal caused that specific loss**: fresh F does not select it either. Conversely, the five rule families shared by T/S but absent from F are a repeatable selection difference in this case, including one known rule and several not-fully-covered candidates. This is the relevant paired contrast, not historical-five versus replay-five.

### Other patterns that matter

- **Case 7:** F has zero facts; both stripped replies select WAL measurement gates, rebuilding-only marker advances, agent-compute placement and ENTO identity without re-keying. T has sharper fixture/threshold details than S. This is more than a paraphrase-count change.
- **Cases 11, 26 and 38:** both stripped replies re-emit known reference/settings, lazy-chunk/deploy or retention rules that F omits. Case 38 is **0 / 9 / 8** facts and includes new candidate fork/wrapper/event/code knowledge as well as known retention.
- **Case 8:** F has zero, but T and S each have four with only protection-map/default families shared. Delta sync/telemetry versus smart-drops/Gemini behavior is genuine same-treatment selection noise.
- **Case 9:** the direction reverses: F has **8**, T **5**, S **2**. F adds no-copy policy and a reasoning-step budget; T/S themselves diverge. Removing the block is not monotonically more comprehensive.
- **Case 35:** F and S select only the same root-rewrite boot failure; T additionally selects two paging rules. Those omissions reproduce in S, so a full-versus-T comparison alone would over-attribute them to the block.

### Forty-case ledger

Each arm cell is **facts / compartments / fully covered facts**. Δ is the manually reviewed rule-family symmetric difference **F–T / F–S / T–S**; it is not a byte-diff or a count of proven factual errors. The comparison column summarizes every case without publishing captured prompt/output bodies.

| Case | F | T | S | Δ FT/FS/TS | Selection comparison |
| --- | --- | --- | --- | --- | --- |
| 0 | 1/1/0 | 1/1/0 | 1/1/0 | 0/0/0 | Shared pinned-helper/nightly policy; F names push/PR, T/S release scope. |
| 1 | 0/1/0 | 5/1/1 | 6/1/1 | 5/6/1 | Shared stripped verification, Cargo gate, Claude errors and override keys; S adds retention/typed refusal detail. F empty. |
| 2 | 1/1/0 | 2/1/0 | 3/1/0 | 1/2/1 | Both stripped select frozen temporal markers absent F; S adds Broca RPC boundary, T indexed-table detail. |
| 3 | 4/1/0 | 3/1/0 | 3/1/0 | 4/2/2 | F/S host-primary claim defense; T broad permissions; F agent lookup name; T/S explicit mutation restrictions. |
| 4 | 2/2/0 | 3/2/0 | 2/2/0 | 3/2/1 | Stripped broad permissions; F terminal-task behavior; T marker validation; all embedding runtime boundary. |
| 5 | 4/1/0 | 4/1/0 | 5/1/0 | 2/1/1 | Shared migration/holding/Rust permission rules; stripped full occlusion; F/S runtime boundary. |
| 6 | 4/2/0 | 5/2/0 | 6/1/0 | 1/2/1 | Five shared families split differently; F user-folder git permission exception; S backup path. |
| 7 | 0/1/0 | 4/1/0 | 4/2/0 | 4/4/0 | F empty; both stripped select WAL, marker-pass, compute-placement and ENTO identity rules. |
| 8 | 0/1/0 | 4/1/0 | 4/1/0 | 4/4/4 | F empty; shared stripped protection map/defaults, different delta/telemetry versus smart-drops/Gemini selection. |
| 9 | 8/2/0 | 5/2/0 | 2/2/0 | 5/7/4 | F selects more, including no-copy policy and reasoning budget; T/S differ on defaults, deferral and signatures. |
| 10 | 3/3/0 | 4/3/0 | 2/3/0 | 2/0/2 | F/S share rollback-safe caches and age bounds; F splits mechanism; T adds provider counter/representation rules. |
| 11 | 2/1/0 | 4/1/2 | 4/1/2 | 4/4/0 | Stripped known layout/NORMAL plus SHM behavior; F worker tool gap; all statement finalization. |
| 12 | 1/1/0 | 3/1/0 | 2/1/1 | 3/2/3 | All Bun default; stripped Node FULL; T timeout/debug gate; S known reference score hiding. |
| 13 | 2/1/0 | 3/1/0 | 4/1/0 | 1/1/0 | Shared score hiding/NORMAL; stripped model grouping; S repeats NORMAL in prose/constant form. |
| 14 | 2/1/0 | 1/1/0 | 2/1/0 | 0/0/0 | Shared diverse 3/4/3 rule; counts change through splitting rather than family loss. |
| 15 | 3/2/0 | 1/2/0 | 2/2/0 | 2/4/2 | F pin coordination/seed constants; T diversity policy; S recent-only history and target composition. |
| 16 | 1/1/0 | 4/1/1 | 3/1/1 | 5/2/3 | Stripped known git identity/schema omission; T visible markers/trailing thinking; F/S pre-coordination. |
| 17 | 0/1/0 | 3/1/0 | 3/1/0 | 3/3/2 | F empty; shared stripped legacy dispatch/present-tools; T plan co-requirement; S restart state loss. |
| 18 | 3/1/0 | 5/1/1 | 6/1/1 | 2/3/1 | Shared role isolation; stripped known thinking invalidation and empty history; S old catalog field absence. |
| 19 | 1/2/0 | 0/2/0 | 1/2/0 | 1/2/1 | F container lsof; S note scheduling; T empty. Fresh fact sets disjoint. |
| 20 | 0/1/0 | 1/1/0 | 2/1/0 | 1/2/3 | F empty; T authoring policy; S render-only normalization and package closure. |
| 21 | 0/1/0 | 3/1/1 | 1/1/1 | 3/1/2 | F empty; stripped known smart-note policy; T message shape and subagent drop application. |
| 22 | 2/2/0 | 2/2/0 | 5/2/2 | 0/3/3 | Shared OMP rules; S adds message/cache layout and two known cache bounds. |
| 23 | 2/1/0 | 2/1/0 | 2/1/0 | 0/2/2 | Shared unsent-request retries; F/T revised cache bounds; S deferred read transactions. |
| 24 | 4/2/0 | 4/2/1 | 5/2/1 | 2/3/1 | Shared flow ownership/cache/frame allowance; stripped known logging; F input-cap precedence; S note credentials. |
| 25 | 6/1/0 | 6/1/0 | 5/1/0 | 4/1/3 | Four shared families; F/S parent lookup; T Superpowers/compile limits; F pagination and repeated step threshold. |
| 26 | 4/1/0 | 5/1/2 | 4/1/1 | 2/2/2 | Shared capability/rendering/caps; stripped known lazy chunks; T verbose expansion; S provider-wire exclusion. |
| 27 | 4/2/0 | 11/2/3 | 8/2/2 | 7/4/3 | Shared expansion/reduced mode; stripped known deployment/display; T reply/cancel/filter details; F verbose display. |
| 28 | 2/1/0 | 1/1/1 | 3/1/1 | 2/2/2 | F budget/eviction; stripped known hook absence; S adds budget and interrupted-thinking replay. |
| 29 | 2/1/0 | 2/1/0 | 1/1/0 | 0/1/1 | Shared SDK termination; F/T named protocol refusal and version boundary absent S. |
| 30 | 2/1/0 | 4/1/3 | 3/1/2 | 5/2/3 | F local policy/green-check mechanism; stripped known script/GraphQL; T bypass/webhook; S direct-push rationale. |
| 31 | 1/2/0 | 4/2/2 | 7/2/3 | 5/6/5 | F staging synchronization; S staging plus bot rules/mechanisms; T general governance instead of staging. |
| 32 | 0/1/0 | 2/1/1 | 1/1/0 | 2/1/3 | F empty; T delta processing/known idle behavior; S version floor with questionable H06 association. |
| 33 | 2/1/0 | 1/1/0 | 2/1/0 | 3/2/1 | F/S live placement; T/S quiet-point migration; F pre-model refusal code. |
| 34 | 0/1/0 | 2/1/0 | 1/1/0 | 2/1/1 | F empty; stripped loosely scoped compile cap; T binary/plugin restart distinction. |
| 35 | 1/1/0 | 3/1/0 | 1/1/0 | 2/0/2 | Shared root-rewrite boot failure; T-only paging rules also absent stripped S. |
| 36 | 3/1/0 | 2/2/1 | 1/1/0 | 3/2/1 | Shared corrected urgency; F incident routing/hint timeout; T known response cap. |
| 37 | 4/1/0 | 4/1/2 | 3/1/2 | 6/5/3 | Stripped known refusal codes; F switch/plan behavior; F/T measured-tool fit; T restart thinking. |
| 38 | 0/1/0 | 9/1/2 | 8/1/3 | 8/8/2 | F empty; seven shared stripped families; T daemon cutover; S known identity recovery. |
| 39 | 5/1/0 | 7/1/0 | 5/1/0 | 3/2/3 | Four shared families; T checksum/missing-field halt; F/T reconnect bound; T/S upstream compression limitation. |

Artifact-reading correction: case 24's actual T first reply gives **320 MiB total / 224 MiB entry**, not the **384/288** described in the v1 case-24 decision example. Case 23 gives 384/288. This report uses the retained replies; it does not change the earlier reports or conflate those two cases.

## Tokens, cache and cost

These are provider-reported first-turn counters, including the common system prompt, **not local BPE estimates**. Output and reasoning are retained separately; reasoning is not added again to fabricate an output total.

| Counter, forty runs | F | T, reused | S |
| --- | ---: | ---: | ---: |
| Uncached input | 4,311,912 | 1,211,777 | 827,166 |
| Cached input | 491,359 | 159,558 | 544,169 |
| Total reported input | 4,803,271 | 1,371,335 | 1,371,335 |
| Mean total input/run | 120,082 | 34,283 | 34,283 |
| Output counter | 386,525 | 377,933 | 351,148 |
| Reasoning counter | 288,451 | 280,542 | 260,118 |
| Runs reporting input / output | 40 / 40 | 40 / 40 | 40 / 40 |
| Runs reporting cached input | 20 | 10 | 23 |
| Runs reporting reasoning | 40 | 36 | 36 |
| Runs reporting cache-write input | 0 | 0 | 0 |

F versus S measures **71.45% less reported total input**, while S's output counter is **9.15% smaller**. T and S have identical total input, despite different outputs and cache splits. The new eighty runs used **6,174,606 reported input** and **737,673 output** tokens; T is comparison accounting, not newly purchased inference.

Cached shares are **10.23% F, 11.64% T, 39.68% S**. Twenty-three S runs versus twenty F runs reported cache hits, with much larger *shares* in S. Missing cache/cache-write fields are reporting gaps, not measured zero. Earlier T and recent F/S do not share controlled cache histories; alternating order reduces one confound but cannot establish intrinsic cache-adjusted dollar savings.

**Actual monetary cost is unavailable, not $0.** None of the 120 retained provider runs supplies a monetary charge; the supplied snapshot has no billing record or verified tariff for this Antigravity route. No billing store or live config was read. For a transparent **illustrative budget only**, using the same unverified rates discussed in the importance trial—**$0.50/M uncached input, $0.05/M cached input, $3/M output**—gives:

| Illustrative first-turn token cost | F | T, not newly run | S | Newly run F + S |
| --- | ---: | ---: | ---: | ---: |
| USD at those assumed rates | $3.34 | $1.75 | $1.49 | $4.83 |

Formula: `(uncached_input × 0.50 + cached_input × 0.05 + output × 3) / 1,000,000`. These figures are **not an invoice, measured debit or verified Gemini-3.8 pricing**. The real result is the controlled first-turn input reduction; a full two-turn flow's dollar benefit still requires actual billing and cache measurements, plus its extra reconciliation/retrieval cost.

## Verification and reproduction

The committed additions are `paired.ts`, `prepare-paired.ts`, `run-paired.ts`, `analyze-paired.ts`, `paired.test.ts` and README instructions under `packages/plugin/scripts/historian-merge-turn-trial/`. No production source, prompt golden, package manifest, architecture document or structure document changed.

- **Bun 1.4.2 / TypeScript 5.9.3:** `timeout 180s bun run typecheck` passed, including the scripts configuration.
- **24 unit tests / 78 assertions** across core, v2 and paired controls passed. The six new controls check full-prompt byte identity, hash/scope refusal, counterbalanced membership, provider completion/settings/usage validation and duplicate detection with a positive duplicate example.
- Safe staged-index **NON-VACUITY BREAK**: neutralizing only original-full-prompt hash comparison reddened **only `paired control rejects a changed original prompt hash`**; the other five paired tests passed. The mutation had `1 file changed, 1 insertion(+), 1 deletion(-)`, was restored from the staged index with an empty unstaged diff, and all six paired tests then passed. No mutant was committed.
- `analyze-paired.ts` passed **120 completed-run validations, 80 fresh-session checks, 84 source/copy hash checks, forty complete selection reviews and 358 fact coverage judgments**. The private annotation SHA-256 is **`187b8d15fbfbbe9527016cbb6018c26666d9db574037bbfe715812e3d1738643`**. It checks prompt/settings hashes, unique runs/sessions, actual event usage, eligible evidence IDs, output parsing and annotation completeness before summarizing.
- Scoped diagnostics: five TypeScript files analyzed, **zero errors/warnings**. Plugin lint, **Biome 2.5.1**, checked **1,224 files** without fixes and passed; two warnings and two informational diagnostics are pre-existing in unrelated files. TypeScript scripts are excluded from Biome and checked by the compiler/tests instead.
- Worktree preparation's frozen install and product build had already passed. Script/report-only changes require no additional native/product build; no dependency or generated output changed.

From `packages/plugin`, with the retained private root, these commands validate/review without regenerating completed inference:

```sh
timeout 60s bun scripts/historian-merge-turn-trial/analyze-paired.ts "$TMPDIR/magic-context/historian-paired-control-bg7d08" inspect 0 10
timeout 90s bun scripts/historian-merge-turn-trial/analyze-paired.ts "$TMPDIR/magic-context/historian-paired-control-bg7d08"
timeout 1800s bun scripts/historian-merge-turn-trial/run-paired.ts "$TMPDIR/magic-context/historian-paired-control-bg7d08"
```

The last command verifies/resumes artifacts without resending completed or admitted runs; it was also the full-cohort dispatch command. Every shell command used an outer `timeout`. Do not rerun preparation into an existing destination or remove the retained evidence root before review.

**Recommendation:** memory-block removal is a real extraction treatment, not a prompt-size-only optimization. It produces more candidate rules and about an 18% already-covered share here, while stochastic selection still changes many details. Investigate it with non-destructive staging/dedup and explicit coverage evidence; do not use this first-turn control to excuse v1/v2's remaining destructive rewrite failures or claim universal recall preservation.
