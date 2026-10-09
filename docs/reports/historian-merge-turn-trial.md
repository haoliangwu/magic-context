# Historian merge-turn trial — forty same-session continuations

## Status and recommendation

**The full forty-run trial is complete.** All first-turn replays and same-session second turns completed on `google/antigravity-gemini-3.8-flash`. Turn one removed only the recorded project-memory span. The 139 emitted facts each received twenty hybrid candidates: fifteen semantic neighbours plus five distinct candidates from their previously staged BM25 lists. I independently judged all 139 decisions and audited all 131 original facts against the timestamp-cut snapshot pool.

An initial **HTTP 402, insufficient credits** blocked embedding preflight, so first turns were staged independently without lexical-only second turns. After funding, the matching vault credential and production query-prefix recipe were used. Five fresh document embeddings each retrieved their own stored row first; both pilot and full-cohort preflights passed. The original first turns were resumed, not regenerated.

**Recommendation: the smaller first prompt is promising, but do not deploy this five-action flow with automatic memory rewriting.** Combined reported input is 3.081 million tokens, versus 4.802 million estimated original user-plus-current-system tokens: about **35.8% less input size**, not a verified billing saving. However, **9/45 merges, 1/4 updates and 2/3 replacements were wrong**, commonly deleting still-valid target constraints. Even skip had two definite false-coverage decisions and six debatable ones. All eleven wrong merge/replaces targets were verifiably present, with the same text, in the actual pre-run memory blocks; historical reconstruction gaps do not explain those failures.

Use a **shadow/approval-gated second turn** first: retain original facts, require explicit coverage evidence for skips, and never auto-apply merge/update/replaces without independent preservation review. Before removing the memory block by default, run a paired fresh full-memory control with identical system/model settings and fix historical membership reconstruction. This corpus demonstrates re-emission control and possible input savings, **not a demonstrated improvement in historical duplicate prevention**: among 104 observed original insertion candidates, zero were clearly fully covered by the available earlier pool; two were debatable, and only one of those was caught by a correct continuation decision.

## Corpus, isolation and method

- Source: the supplied read-only `$TMPDIR/magic-context/memory-trials/trial.db`; 60 recorded runs, 3,362 project memories. A read-only SQLite `VACUUM INTO` created a private copy before analysis. No live Magic Context/OpenCode store or configuration was read.
- Cohort: exactly the 40 newest rows, ordered by `created_at DESC, child_session DESC`, spanning **2026-10-03 12:08:31.316 UTC through 2026-10-06 08:11:33.807 UTC**. Case 0 is newest, case 39 oldest. No case was filtered for output shape or fact count.
- User-prompt treatment: remove the single literal `<project-memory>...</project-memory>` span, not adjacent newlines, examples, references, transcript or guard text. Original, removed-block and stripped-prompt SHA-256s are retained privately. All forty prompts had exactly one such span.
- System: the snapshot does not retain sent system prompts. Replays use the checked-in production system golden, `crates/mc-module/testdata/historian-system-prompt.txt`, SHA-256 `f6a5a6dac2c8e29f0c4c54d3eb3c482b6159b9bfce76831cca01928de5ddc978`. This is **not** a claim of byte-identical original system prompts.
- Dispatch: the importance-anchoring harness's Broca `session.send`/`session.subscribe` connection-descriptor path, copied into the throwaway root; empty tools, temperature 0.1, max output 32,000, no fallback models or automatic retries. Three cases concurrently; each first turn in a fresh lineage, each second turn with the exact same identity and system hash but a different run ID. All eighty runs completed with one provider step, `stop` finish reason and completed terminal event. First-phase invocation: 352 seconds plus an 11-second pilot invocation (10 seconds in the provider). Second-phase invocation: 130 seconds plus a 13-second pilot invocation (3 seconds in the provider), with the pilot resumed rather than repeated. Invocation timings include retrieval/preflight overhead where applicable and are not historical latency comparisons.
- Extraction uses the production compartment/fact parser. No replay output, compartment, candidate, decision or memory was published. Raw material and connection metadata remain outside git in the owner-private `$TMPDIR/magic-context/merge-turn-trial-bg4916/` root so the continuation can resume. Broca retains its normal service WALs; it is not a throwaway provider host.

### Memory coverage and historical-pool caveat

| Snapshot population | Memories | Embeddings | Coverage |
| --- | ---: | ---: | ---: |
| Active | 1,299 | 1,292 | 99.46% |
| Archived | 2,063 | 307 | 14.88% |
| All | 3,362 | 1,599 | 47.56% |

One vector namespace is present: `embedding-provider:567a42801637f21615239a4aa26ec0b6`; every vector is 4,096 float32 dimensions (16,384 bytes). Supplied metadata identifies OpenRouter `qwen/qwen3-embedding-8b`, endpoint `https://openrouter.ai/api/v1`, max input 8,192 tokens. The constructed production provider's identity exactly matched this namespace before the endpoint request failed.

Preflight embedded five evenly spaced active memories **fresh as documents**, with no document prefix, ranking against all 1,292 embedded active rows. This is not a stored-vector-versus-itself comparison. Fact embeddings use the production provider's `query` purpose and canonical Qwen3 instruction (`Given a web search query, retrieve relevant passages that answer the query` followed by `Query:`). No `input_type` override is configured. The same model-family recipe used by memory search is exercised without reading live embedding configuration.

| Document ID | Own-row rank | Fresh-document/stored-row cosine |
| --- | ---: | ---: |
| #4951 | 1 | 0.999929 |
| #9978 | 1 | 0.999934 |
| #18930 | 1 | 0.999926 |
| #21115 | 1 | 0.999920 |
| #24670 | 1 | 1.000000 |

The five checks ran before the pilot and again before the resumed full invocation: ten successful document requests over five distinct controls. The 139 replay facts and 131 original comparison facts were query-embedded. Embedding usage counters are not retained by the production provider wrapper, so embedding spend is unmeasured and separate from Gemini counters below.

Candidate lists use **snapshot `status='active'` and `created_at < run.created_at`**, giving 1,180–1,298 eligible memories per run; equality and future rows are excluded. BM25 uses Unicode word tokens, `k1=1.2`, `b=0.75`, no stopword filter. Following the continuation instruction to combine the staged lexical lists, hybrid retrieval takes fifteen cosine neighbours and then five distinct top-BM25 candidates from those lists. Embedded documents are not excluded from lexical ranking: literal names/constants and long procedural memories can rank poorly semantically. All 139 lists contain twenty unique IDs (2,780 candidates total), without mixing the two score scales.

Ten of the 76 targeted decisions selected a **lexical-only candidate outside the semantic top fifteen**, including the long dist-retention rule #16288. This is evidence that the lexical lane contributed actual targets, not an ablation showing how a BM25-only or semantic-only model would decide.

**This pool is not a fully reconstructed historical pool.** The database lacks status-change and content-revision history. Parsing the captured memory block (dash bullets, not the historian output's star bullets) gives 1,213–1,312 rendered facts per run. Exact current-content matching maps 1,173–1,281 of these to earlier snapshot rows; **1–20 matched rows per run are archived now**, and up to 22 matched rows have a later update timestamp. Thus current active status demonstrably differs from what the historian saw then. These ranges are separate marginal ranges, not subtractable counts. Grades are conditional on the timestamp-cut snapshot pool, not a clean historical replay.

As a sensitivity check, 74/76 chosen target texts occur verbatim after XML unescaping/whitespace normalization in the actual captured pre-run blocks. The two exceptions are `38:1` and `38:7`, both targeting #16288's later wording. Their recorded block nevertheless already contains one-week chunk retention and copying without `rsync --delete`; the specific known claims are historical, but the longer rewritten target imports later additions. Every wrong merge/replaces target passes this historical-text check.

## Effect of removing the block on turn one

| Measure | Recorded output | Stripped first turn |
| --- | ---: | ---: |
| Runs | 40 | 40 |
| Facts | 131 | 139 |
| Mean facts/run | 3.275 | 3.475 |
| Compartments | 50 | 52 |
| More / fewer / same facts than recorded | — | 13 / 11 / 16 runs |
| Exact normalized-text matches to earlier active snapshot memories | 0 | 0 |

Fact count increased **6.1% overall**, but the content changed more than that count suggests. Case 27 went from three facts to eleven; cases 32 and 34, originally fact-free, each emitted two facts; case 19 went from one fact to none. This is one stochastic replay per historical run, not a paired fresh full-memory control, so differences are not attributable exclusively to memory removal. System-version changes and generation noise are additional confounders.

Full review found **24/139 first-turn facts (17.3%) already covered by the earlier pool**, including joint coverage by multiple memories and safe-but-redundant merges. None is an exact normalized-text duplicate. The initial twelve-example lower bound became twenty-four after complete review. This is not 24 prevented historical duplicate insertions: these are re-emissions from the stripped replay. Of those known facts, 16 received correct skips; the others received consolidation/redundant merges or debatable single-target skips.

Counts also conceal extraction changes. In case 1, both outputs have five facts, but the stripped output drops the original lock-scan optimization, typed protected-result refusal, transcript-retention rule and refusal-code constant, retaining only the Claude error-substring claim. It instead emits two known rules and two override configuration keys. Compartments may still retain narrative evidence; this illustrates changed durable-fact selection, not proven loss from the total compartment output. A fresh paired control is needed to separate treatment effects from model noise/system-version differences.

### Representative actual decisions

The text is summarized rather than a retained prompt/output corpus. Grades compare the complete proposed rewrite and target, not the model's rationale or cosine threshold. Correct means coverage or change is supported and still-valid target knowledge survives; wrong means unsupported coverage, lost information or an unrelated target; debatable marks genuine scope/precision/action-choice ambiguity. This is one reviewer, not inter-rater validation. No decision was applied to storage.

| Case:fact | Decision | Grade | Comparison |
| --- | --- | --- | --- |
| 0:1 | merge #20625 | Correct | Adds pinned CI versus nightly HEAD policy while retaining existing checkout and push/PR rules. |
| 1:1 | skip #24495 | Correct | Quantized-model verification and approval before promises are already covered. |
| 1:2 | skip #24579 | Wrong | General dependency policy does not retain the newly named CI enforcement script. |
| 1:4 | new | Correct | The user-tier guidance override key is genuinely distinct from older generic guidance facts. |
| 3:1 | merge #24492 | Wrong | Generalizing owner-only permissions deletes the stronger Rust config-opt-out precedence rule. |
| 9:2 | replaces #24124 | Wrong | Token ratios do not supersede encrypted representation; the rewrite also erases valid Gemini knowledge. |
| 11:1 | skip #23987 | Debatable | Layout and score hiding are covered jointly, but the cited target alone lacks score hiding. |
| 23:2 | update #23697 | Correct | Revises 256 MiB to 384 MiB total/288 MiB per entry and retains attachment scope and eviction. |
| 27:5 | merge #21026 | Wrong | A plugin chunk/reload rule is appended to unrelated smart-note fetch-retry policy. |
| 36:1 | replaces #20900 | Correct | Replaces invalid medium urgency with normal while retaining high urgency for parks/refusals. |
| 39:5 | merge #14125 | Correct | Adds wire-family usage-field validation as an insertion, preserving the complete cache-triage workflow. |

## What actually happened to the recorded facts

| Attribution check | Count |
| --- | ---: |
| Original emitted facts | 131 |
| Exact content match to a historian-source row created within ten minutes after its run | 104 |
| Distinct matching new row IDs | 104 |
| Exact content match to an earlier snapshot row | 0 |
| Original facts without either attribution | 27 |

Normalization is production lowercasing, whitespace collapse and trim. The 104 matches are **observed insertion candidates**, not a complete publication audit: the snapshot omits parent-source-session attribution, publication times, status history and old content revisions. Twenty-seven unmatched facts must not be called “dedup skips”; delayed publication, unpublished output, later edits and deletions cannot be disambiguated here. The ten-minute window and exact-content criterion deliberately make this an auditable lower-bound attribution.

### Comparison to exact-text dedup

“Duplicate” here means fully covered by an earlier fact/pool, not merely a compatible refinement worth merging. Changed values, new identifiers, stronger scope constraints and specific failure mechanisms are not counted as clear duplicates. I reviewed all original facts using semantic and lexical candidates, existing captured memory blocks and targeted whole-pool checks; scores were retrieval aids, not an adjudication oracle.

| Original observed insertion candidates | Count |
| --- | ---: |
| Clearly fully covered by the available older pool | 0 |
| Not judged fully covered | 102 |
| Debatable overlap | 2 |
| Clear original duplicates demonstrably caught by a correct continuation | 0 |
| Debatable original duplicates caught if overlap is counted as duplication | 1 of 2 |

The two inserted overlaps are `16:3 → #23985` (trailing edits preserving earlier thinking arguably follow older #23609's forward invalidation rule; correct `16:3 merge` catches it) and `30:1 → #23506` (successful bot checks despite open threads may be implicit in older #23407's independent thread gates, but explicitly documents a new failure mechanism; replay `30:2 new` does not catch it). Unattributed `31:2` has the same bot-check ambiguity and a correct merge, but cannot be counted as an observed inserted duplicate.

Thus this trial **does not establish a historical duplicate-prevention gain over today's full-memory historian**. The 16 correct skips mainly suppress re-emissions caused by stripping the memory block. The 63 `new` decisions versus 104 observed historical insertions are not “41 saved memories”: extraction changed, and many merges consolidate new complementary facts rather than remove old duplicates. Same-run architecture/constant repetitions (for example the step-58 threshold and flow refusal code) are excluded from the strictly pre-run-pool duplicate comparison. Historical status/content gaps and absent publish auditing prevent a definitive real-world duplicate rate.

## Second-turn quality and destructive decisions

| Action | Decisions | Correct | Wrong | Debatable |
| --- | ---: | --- | --- | --- |
| `new` | 63 | 62 | 0 | 1 |
| `skip #N` | 24 | 16 | 2 | 6 |
| `merge #N` | 45 | 30 | 9 | 6 |
| `update #N` | 4 | 3 | 1 | 0 |
| `replaces #N` | 3 | 1 | 2 | 0 |
| **Total** | **139** | **112** | **14** | **13** |

All decisions passed count/index/action/target/rewrite validation. That syntactic success did not imply semantic safety. Wrong skips lose a new CI script path (`1:2`) and an all-tooling governance requirement narrowed to a gh-only target (`31:2`). A wrong update (`27:3`) deletes Pi's unchanged permission limitation while treating an OC2 workaround as removal of its underlying API gap. These matter in addition to the requested merge/replaces inventory.

### Every wrong merge/replaces

| Case:fact | Action/target | Information destroyed or incorrect combination |
| --- | --- | --- |
| 3:1 | merge #24492 | Drops cortexkit-store enforcement and ignoring `storage.enforce_private_permissions`. |
| 4:3 | merge #21817 | Drops 100% CPU, blocked event loop and blocked user cancellation. |
| 6:4 | merge #7804 | Narrows “no entitlements” to conflated privacy/TCC entitlements, losing the broader signing fact. |
| 9:2 | replaces #24124 | Removes valid Gemini signatures/summaries knowledge and invents a contradiction between OpenAI encryption and token ratios. |
| 12:1 | merge #23179 | Deletes detach-to-background behavior and does not resolve the new terminate-versus-detach conflict. |
| 18:1 | replaces #23845 | Adds a valid role restriction but deletes no-tag guidance and composition-versus-dedicated-preset distinctions. |
| 18:2 | merge #18618 | Deletes `ctx_expand` exclusion, `sessionScopedToolsDisabled` gating and scoped registration details. |
| 21:2 | merge #20243 | Deletes Broca/Anthropic allocation and the provider-independent shape-contract boundary. |
| 25:1 | merge #5027 | Deletes lazy indexing, the Magic Context database location and avoiding OpenCode database writes. |
| 27:5 | merge #21026 | Combines unrelated plugin chunk lifecycle and smart-note fetch retry, damaging fact coherence rather than deleting literal words. |
| 35:1 | merge #23094 | Deletes the unchanged 64 KiB paging frame bound. |

These failures occurred despite explicit instructions to preserve ALL still-valid target information. Ten loss/conflict cases plus the unrelated-topic graft show why a free-form rewrite is not a safe deduplication primitive. The appendices retain one-line judgments for every decision, including all debatable cases.

## Tokens and cache

The original snapshot has user-prompt text, not provider usage. Original sizes below use the repository's Claude BPE estimator, explicitly **not Gemini billing counts**. The same estimated current system prompt is added to both size comparisons; the true original system and its size are unknown.

| Input-size comparison across 40 runs | Tokens | Mean/run |
| --- | ---: | ---: |
| Original recorded user prompts, local estimate | 4,201,947 | 105,049 |
| Removed memory spans, local estimate | 3,461,315 | 86,533 |
| Stripped user prompts, local estimate | 740,552 | 18,514 |
| Current system prompt, local estimate | 600,120 | 15,003 |
| Original user + current system, local estimate | 4,802,067 | 120,052 |
| Stripped user + current system, local estimate | 1,340,672 | 33,517 |

Memory is **82.37%** of the recorded user-prompt estimate in aggregate (per-run range **77.42–85.95%**). Removing it reduces estimated user-plus-current-system input by **72.08%** before any second turn. This cohort's range is measured independently; the initial 61–92% description is not assumed as an input to the calculation.

| Provider-reported replay usage | First turn | Second turn | Combined | Reporting runs (first / second) |
| --- | ---: | ---: | ---: | --- |
| Uncached input | 1,211,777 | 1,496,937 | 2,708,714 | 40 / 40 |
| Cached input | 159,558 | 212,750 | 372,308 | 10 / 14 |
| Reported total input | 1,371,335 | 1,709,687 | 3,081,022 | — |
| Cache-write input | Unreported | Unreported | Unreported | 0 / 0 |
| Output counter | 377,933 | 42,339 | 420,272 | 40 / 40 |
| Reasoning counter | 280,542 | 28,845 | 309,387 | 36 / 7 |

Reported cached-input shares are **11.64% first turn, 12.44% second turn, 12.08% combined**. Omitted cache fields are unknown, not proven zero. Reported second-turn hits are only about 12–16k each, not evidence that the entire 30–40k first-turn prefix was cached. Same-session continuation is verified, but strong prefix amortization is **not** established; the credit wait also separated phases and could have expired provider caches.

Combined mean reported input is **77,026 tokens/run**, versus **120,052 estimated original user-plus-current-system tokens/run** (35.84% smaller). The estimate is not a paired original provider measurement. Original cache/output/reasoning usage is unavailable, and original prompts may have enjoyed large stable-memory-prefix hits. Output and reasoning counters are retained separately, not added into a fabricated total. Therefore **no net dollar-saving or original-output-cost claim is justified**. The empty-fact case 19 still received its continuation and used 35,323 reported input tokens, honestly accounting for an avoidable future implementation overhead.

## Per-run first-phase ledger

Local BPE columns count only user-prompt text; reported input is the provider's **uncached** counter, including the replay system. “Inserted” means exact-content/time-window attribution, not adjudicated non-duplication. Cached counters are included in the aggregate above, not in this uncached column.

| Case | Original facts | Stripped facts | Original user BPE | Stripped user BPE | Reported uncached input | Original inserted candidates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 1 | 1 | 104255 | 15411 | 30877 | 1 |
| 1 | 5 | 5 | 111014 | 22451 | 38205 | 5 |
| 2 | 4 | 2 | 109457 | 21102 | 36825 | 4 |
| 3 | 3 | 3 | 107463 | 19266 | 35031 | 3 |
| 4 | 4 | 3 | 105966 | 17769 | 33474 | 0 |
| 5 | 4 | 4 | 108127 | 20267 | 36004 | 4 |
| 6 | 5 | 5 | 108936 | 21076 | 36817 | 0 |
| 7 | 3 | 4 | 107352 | 19608 | 19080 | 3 |
| 8 | 2 | 4 | 107976 | 20285 | 36232 | 2 |
| 9 | 4 | 5 | 108538 | 20847 | 36928 | 0 |
| 10 | 6 | 4 | 112918 | 25494 | 41684 | 6 |
| 11 | 3 | 4 | 107231 | 19946 | 19531 | 3 |
| 12 | 3 | 3 | 107854 | 20682 | 36706 | 3 |
| 13 | 2 | 3 | 106198 | 19103 | 34745 | 2 |
| 14 | 1 | 1 | 101284 | 14259 | 13213 | 1 |
| 15 | 1 | 1 | 101247 | 14222 | 13273 | 0 |
| 16 | 4 | 4 | 103972 | 17089 | 16318 | 4 |
| 17 | 3 | 3 | 100863 | 14220 | 13138 | 3 |
| 18 | 5 | 5 | 104040 | 17593 | 33138 | 5 |
| 19 | 1 | 0 | 102774 | 16364 | 32336 | 1 |
| 20 | 2 | 1 | 102957 | 16643 | 32363 | 2 |
| 21 | 1 | 3 | 104230 | 17974 | 21789 | 1 |
| 22 | 3 | 2 | 102522 | 16304 | 32185 | 0 |
| 23 | 2 | 2 | 102910 | 16766 | 32608 | 2 |
| 24 | 4 | 4 | 107339 | 21195 | 37261 | 0 |
| 25 | 6 | 6 | 105002 | 19163 | 35087 | 6 |
| 26 | 7 | 5 | 107945 | 22378 | 38483 | 7 |
| 27 | 3 | 11 | 102709 | 17142 | 32731 | 0 |
| 28 | 1 | 1 | 100474 | 14934 | 30535 | 1 |
| 29 | 4 | 2 | 101952 | 16066 | 31597 | 4 |
| 30 | 2 | 4 | 102363 | 16680 | 32461 | 2 |
| 31 | 3 | 4 | 104483 | 18800 | 34641 | 0 |
| 32 | 0 | 2 | 103770 | 18087 | 34113 | 0 |
| 33 | 4 | 1 | 102573 | 17315 | 33170 | 4 |
| 34 | 0 | 2 | 101688 | 16430 | 15736 | 0 |
| 35 | 2 | 3 | 102120 | 16930 | 32623 | 2 |
| 36 | 5 | 2 | 105482 | 20415 | 19876 | 5 |
| 37 | 5 | 4 | 104772 | 19937 | 35631 | 5 |
| 38 | 9 | 9 | 106844 | 22333 | 38147 | 9 |
| 39 | 4 | 7 | 102347 | 18006 | 17185 | 4 |

## Reproduction, verification and follow-up

Harness: `packages/plugin/scripts/historian-merge-turn-trial/`; its README documents isolation, phased dispatch, root fencing, normalization, retrieval and attribution. `summarize.ts`, `review.ts second`, `statistics.ts`, `inspect-review.ts` and `analyze.ts` ran against all forty paired outputs. The analyzer requires exactly one independent judgment per decision and original fact, validates same-session/system/prompt identity and completed provider events, and rejects unsupported “caught” mappings. Raw annotations and provider artifacts remain private; the report retains judgments and IDs, not full prompts or model output corpora.

The package typecheck uses TypeScript 5.9.3 and includes the scripts configuration. Unit tests cover literal span removal, strict time/status eligibility, rendered-memory parsing, BM25, independent-vector cosine, lane allocation, target/rewrite validation, prompt construction and the private-root fence. Continuation adds a test proving that an embedded literal-match memory outside the semantic top fifteen is still retained lexically. The earlier time-fence non-vacuity mutation reddened only its named test; a second staged-and-restored mutation excluding embedded documents from the lexical lane reddened only the new hybrid test. Both mutations were restored before committing, and independent artifact validation confirmed the actual dispatched candidate fences and lane counts.

Final gates: package typecheck, dedicated **10 tests / 28 assertions** (Bun 1.4.2), package lint (Biome 2.5.1), and full artifact/judgment validation. Lint excludes TypeScript scripts; the compiler and tests are their authoritative gates. All 80 completed provider steps, 40 unchanged first-turn inputs, 40 same-session continuations and 2,780 hybrid candidate entries were validated. No packaging or production source changed, so no additional product build was needed.

The staged phases and manual analysis are reproducible from the retained private root; do not dispatch completed second turns again:

```sh
# From packages/plugin, with the existing private root retained:
timeout 60s bun scripts/historian-merge-turn-trial/analyze.ts
```

Follow-up should reconstruct true historical membership/content, include a fresh full-memory control and measure actual billed/cache counters. More importantly, test a non-destructive decision design or a preservation verifier before granting rewrite authority. This trial supports investigating memory-block removal for prompt size, but rejects unconditional trust in the current merge/update/replaces output.

## Appendix A — every second-turn decision

Case 19 emitted zero facts and returned `[]`; there is no decision to grade for that case. “Known” observations include some facts jointly covered by multiple memories; a specific target can still be incomplete. The following ledger grades all 139 decisions without treating the model's rationale as an oracle.

| Case:fact | Decision | Judgment | Reason |
| --- | --- | --- | --- |
| 0:1 | merge #20625 | correct | Adds pinned-versus-nightly CI policy while preserving checkout and push/PR rules. |
| 1:1 | skip #24495 | correct | Target already covers quantized-report verification and approval before promised changes. |
| 1:2 | skip #24579 | wrong | Skip loses the newly specified check-cargo-path-dependencies.py enforcement path. |
| 1:3 | new | correct | Error-substring interception is distinct from older context-overflow and retry facts. |
| 1:4 | new | correct | No older guidance fact supplies this exact user-tier override key. |
| 1:5 | new | correct | The tool-description override key and user-tier restriction are new. |
| 2:1 | update #18611 | correct | Revises obsolete sibling-path dependencies while preserving workspace and runner boundaries. |
| 2:2 | merge #5159 | correct | Adds marker freezing/persistence while preserving gap comments and compartment dates. |
| 3:1 | merge #24492 | wrong | Rewrite deletes cortexkit-store enforcement and the config-opt-out precedence rule. |
| 3:2 | merge #24241 | correct | Retains partial-end/gap semantics and adds pre-advance cache invalidation. |
| 3:3 | new | correct | Engram read-versus-mutate authority is not covered by generic confirmation rules. |
| 4:1 | new | correct | Project-wide creation permissions exceed the older Rust-only storage rule. |
| 4:2 | merge #24241 | correct | Preserves existing marker semantics and adds validation-before-cut fail-closed ordering. |
| 4:3 | merge #21817 | wrong | Rewrite drops CPU saturation, event-loop blocking and user-cancellation consequences. |
| 5:1 | merge #21696 | correct | Adds protected-result queue displacement without removing user-answer protection. |
| 5:2 | merge #22704 | correct | Worker-start failure handling complements and preserves off-thread migration requirements. |
| 5:3 | new | correct | Unconditional Rust permission/config precedence is absent from this earlier pool. |
| 5:4 | merge #24123 | correct | Full-occlusion repaint behavior complements the retained partial-overlay tolerance rule. |
| 6:1 | new | correct | Earlier pool lacks the general owner-only data-directory creation invariant. |
| 6:2 | new | correct | Rust store enforcement overriding the user setting is distinct from migration authority. |
| 6:3 | merge #21696 | debatable | Target is preserved, but the new no-schema-migration qualifier is omitted. |
| 6:4 | merge #7804 | wrong | Replaces general no-entitlements knowledge with the narrower, conflated TCC-entitlements claim. |
| 6:5 | merge #24123 | correct | Retains partial-overlay handling and adds complete-occlusion behavior and cause. |
| 7:1 | new | correct | Explicit fixture sizes and write-reduction gates are not older migration-test requirements. |
| 7:2 | new | correct | The global no-ordinary/fallback marker movement restriction is not fully covered. |
| 7:3 | new | correct | Compute-member placement of plaintext-sensitive components is new topology information. |
| 7:4 | merge #8858 | correct | Adds parallel Entorhinal IDs without losing stream keys, precedence or adapter architecture. |
| 8:1 | merge #14558 | correct | Preserves newest counts and reclaim protection while adding the unified configuration map. |
| 8:2 | merge #23402 | debatable | Combines quiet-point snapshots with per-turn delta sync without reconciling their timing. |
| 8:3 | merge #24121 | correct | Preserves the diff formula and clarifies output-counter exclusion of reasoning. |
| 8:4 | merge #14561 | correct | Adds todowrite/default-map information while preserving the newest-three ctx_reduce count. |
| 9:1 | new | debatable | Older deferral rule overlaps, but the cross-runtime Rust-only milestone is more specific. |
| 9:2 | replaces #24124 | wrong | Deletes valid Gemini replay facts and falsely treats OpenAI encryption as contradicted by token ratios. |
| 9:3 | new | correct | Signature location on Gemini tool calls is not specified by the older replay-format fact. |
| 9:4 | new | correct | Explicit OpenCode output-counter semantics are new despite related reasoning-diff knowledge. |
| 9:5 | new | correct | The combined protected_tools default map is new, not just the older ctx_reduce count. |
| 10:1 | new | correct | Rollback-stale transaction cache behavior is distinct from older invalidation/version counters. |
| 10:2 | new | correct | Ollama's missing reasoning counter is not described by earlier provider counter facts. |
| 10:3 | merge #20646 | correct | Preserves dashboard estimation caveat and adds concrete provider replay representations. |
| 10:4 | new | correct | No earlier fact supplies this clear_reasoning_age range or default. |
| 11:1 | skip #23987 | debatable | Pool jointly covers layout and score hiding, but the cited target alone omits score hiding. |
| 11:2 | new | correct | Unfinalized Bun statement handles after close are new lifecycle knowledge. |
| 11:3 | skip #21811 | debatable | Target discusses missing WAL and SHM together; emitted claim generalizes SHM absence alone. |
| 11:4 | skip #23997 | correct | Older cross-runtime WAL constant already includes store.db synchronous=NORMAL. |
| 12:1 | merge #23179 | wrong | Deletes the ceiling's detach-to-background behavior and fails to resolve terminate-versus-detach conflict. |
| 12:2 | new | correct | Runtime defaults differ from the older project-configured NORMAL setting. |
| 12:3 | new | correct | The named debug-assertion environment gate is not covered by older diagnostics facts. |
| 13:1 | merge #23987 | correct | Adds selective score hiding while retaining counts, selection bands and trimming order. |
| 13:2 | skip #23886 | debatable | Qualitative grouping is covered, but 80-98% is not the target's 90%+ estimate. |
| 13:3 | new | correct | The cross-runtime synchronous setting is new at this earlier run's cutoff. |
| 14:1 | new | correct | No earlier pool fact specifies the 3/4/3 layout and diverse-band selection. |
| 15:1 | new | correct | Generic prompt-calibration advice does not specify importance-band-diverse references. |
| 16:1 | skip #15874 | correct | Configured author identity and the exact co-author trailer are fully retained in the target. |
| 16:2 | new | correct | Older marker-neutralization facts do not require plaintext rather than opaque markers. |
| 16:3 | merge #23609 | correct | Retains every existing thinking-binding restriction and adds the trailing-edit boundary. |
| 16:4 | merge #22702 | correct | Adds wire-description matching while preserving exact tool-name and parameter-schema matching. |
| 17:1 | merge #23844 | correct | Preserves composition inspection semantics and adds the transform-compaction co-requirement. |
| 17:2 | merge #23848 | correct | Retains managed role tool restrictions and adds a scoped unmanaged legacy exception. |
| 17:3 | merge #23850 | correct | Preserves shared registry/role checks and adds provider-owned per-subagent catalog freezing. |
| 18:1 | replaces #23845 | wrong | Valid role restriction is added, but no-tag guidance and the no-dedicated-preset distinction disappear. |
| 18:2 | merge #18618 | wrong | Deletes ctx_expand exclusion, sessionScopedToolsDisabled gating and project-scoped registration details. |
| 18:3 | new | correct | Name-based worker/reader refusal on shared Claude registries is distinct enforcement knowledge. |
| 18:4 | skip #23609 | correct | Target already states earlier-content edits invalidate later signatures and require stripping. |
| 18:5 | new | correct | Subagent-local history scoping and empty blocks are not described by generic search exclusions. |
| 20:1 | new | correct | Verb-first user-profile phrasing is not the older generic prose guidance. |
| 21:1 | skip #23806 | correct | Target already states the stopgap lifecycle and prohibition on new smart-note capabilities. |
| 21:2 | merge #20243 | wrong | Drops Broca's Anthropic allocation and the provider-independent shape-contract boundary. |
| 21:3 | merge #17985 | correct | Retains rider-only/no-initiated-bust semantics and adds the subagent execute-pass exception. |
| 22:1 | new | correct | OMP system-segment arrays are distinct from older RPC and tool behaviors. |
| 22:2 | new | correct | Disabled-built-in launch refusal is an OMP constraint not covered by Pi allowlists. |
| 23:1 | new | correct | Only-unsent SDK retries differ from earlier reconnect counts and restart-order rules. |
| 23:2 | update #23697 | correct | Updates the budget, adds an entry ceiling and preserves attachments and oldest-session eviction. |
| 24:1 | new | correct | Basal flow ownership and rejection of MC flow features exceed the smart-note stopgap rule. |
| 24:2 | skip #23678 | correct | The daily path, default level and CK_LOG versus RUST_LOG distinction are already stored. |
| 24:3 | update #23697 | correct | Revises budget/entry values while retaining attachment scope and eviction policy. |
| 24:4 | new | correct | Transform-specific cap allowance is distinct from generic transport and paging ceilings. |
| 25:1 | merge #5027 | wrong | Deletes lazy indexing and the Magic Context database/avoid-OpenCode-writes boundary. |
| 25:2 | merge #21964 | correct | Preserves the fit ceiling and fallback while adding ordinary-failure and hint-only distinctions. |
| 25:3 | new | correct | Superpowers prompt injection and its child-session exemption are new host constraints. |
| 25:4 | merge #21026 | debatable | Existing failure policy survives, but the broad-history timeout qualifier becomes vague. |
| 25:5 | new | correct | Step 58 wrap-up threshold is new despite the older 60-step cap and partial-manifest rule. |
| 25:6 | new | correct | Two-hour clean-completion retention is not the older request timeout or log durability. |
| 26:1 | skip #16288 | correct | Target already mandates one-week retention and forbids destructive dist deployment. |
| 26:2 | new | correct | The deliberate flow-scopes capability omission is new at this cutoff. |
| 26:3 | new | correct | Tool expansion visibility across historian and verbose expand is new behavior. |
| 26:4 | skip #16288 | correct | Target already explains lazy old-chunk loading and deletion-triggered runtime failures. |
| 26:5 | new | correct | The 300/1000/10 template bounds are absent from the earlier pool. |
| 27:1 | merge #16288 | debatable | No-op rewrite preserves everything, but an already-covered fact should be skipped rather than merged. |
| 27:2 | skip #23505 | correct | Target already names the visible-tag issue and upstream reply guidance. |
| 27:3 | update #19889 | wrong | Deletes Pi's unchanged permission limitation and treats an OC2 workaround as removal of its API gap. |
| 27:4 | new | correct | Expansion/parser architecture is new at this earlier run's cutoff. |
| 27:5 | merge #21026 | wrong | Grafts plugin chunk lifecycle onto unrelated smart-note fetch-retry policy. |
| 27:6 | merge #18874 | correct | Retains hook absence and consolidates upstream display/completion knowledge already in the pool. |
| 27:7 | new | correct | Host-resolved tool advertisement filtering adds a workaround beyond the older API limitation. |
| 27:8 | new | correct | The expansion field cap is new at this cutoff. |
| 27:9 | new | correct | The expansion line cap is new at this cutoff. |
| 27:10 | new | correct | The expansion array cap is new at this cutoff. |
| 27:11 | new | correct | The expansion configuration name and accepted template/false values are new. |
| 28:1 | merge #18874 | correct | Preserves completion-hook absence and consolidates already-known display/tag limitations. |
| 29:1 | new | correct | flow_id protocol refusal code and minimum version are not older scope ownership facts. |
| 29:2 | new | correct | Unknown-field SDK process termination is new compatibility knowledge. |
| 30:1 | skip #23407 | correct | Target already requires merge-pr.sh and resolution of all named bot threads. |
| 30:2 | new | correct | Successful bot checks and missing thread-resolution events add explicit failure mechanisms. |
| 30:3 | skip #23407 | debatable | GraphQL refusal is covered, but positive REST permission relies on another older memory. |
| 30:4 | skip #23407 | correct | Existing prohibition on routing around the gh shim includes PATH-based bypass. |
| 31:1 | skip #23407 | correct | Target already requires verification and resolution of every bot review thread. |
| 31:2 | skip #23407 | wrong | A gh-specific prohibition does not cover the emitted all-tooling governance requirement. |
| 31:3 | skip #23407 | debatable | Cited target covers GraphQL denial but not positive REST permission by itself. |
| 31:4 | merge #23407 | correct | Adds the misleading-success bot-check mechanism without losing any existing merge gate. |
| 32:1 | new | correct | Delta-scaling of frozen-unit processing exceeds older timeout and caching optimizations. |
| 32:2 | merge #20352 | correct | Preserves the only-usage-bearing-response rule and makes its aborted-request consequence explicit. |
| 33:1 | merge #16954 | correct | Preserves paired restore/drain rules and adds quiet-point cross-host session migration. |
| 34:1 | new | correct | Placement-without-host-restart is distinct from coordinated upgrades and daemon restart ordering. |
| 34:2 | skip #22709 | debatable | Compilation failure cap is ambiguous; target names an HTTP response-size ceiling specifically. |
| 35:1 | merge #23094 | wrong | Drops the still-valid 64 KiB paging frame bound when changing its sizing basis. |
| 35:2 | new | correct | accept_reply_pages validation on non-final requests is a distinct wire rule. |
| 35:3 | new | correct | The root-commit rewrite boot failure and exact missing-column error are new. |
| 36:1 | replaces #20900 | correct | Replaces invalid medium urgency while preserving normal-versus-high incident routing. |
| 36:2 | skip #22709 | correct | Target already supplies the current one-MiB response ceiling. |
| 37:1 | new | correct | Post-restart unrecorded-thinking stripping differs from older LKG hold and post-error recovery. |
| 37:2 | merge #23276 | correct | Preserves emergency-refusal semantics and adds measured-tool-schema fit accounting. |
| 37:3 | skip #23280 | correct | A fork's over-window first-pass refusal is included in the older initial-pass code. |
| 37:4 | skip #23281 | correct | The same frozen-history replay refusal code is already stored. |
| 38:1 | merge #16288 | debatable | Existing merge-only deployment policy covers copies; rewrite is safe but largely redundant. |
| 38:2 | new | correct | This cutoff lacks the explicit quit/healthy/relaunch daemon-cutover sequence. |
| 38:3 | new | correct | OC2 fork state cloning is not the old generic fork replay hazard. |
| 38:4 | new | correct | Exact OpenCode wrapper version boundaries are new host knowledge. |
| 38:5 | new | correct | resize versus resized element event names are not older TUI integration facts. |
| 38:6 | new | correct | Fork message-ID schema and parent matching are new at this cutoff. |
| 38:7 | skip #16288 | correct | Target already names clean-dist-chunks and its one-week retention window. |
| 38:8 | new | correct | The named MC-H06 code/initial emergency-fit meaning is new at this cutoff. |
| 38:9 | new | correct | The named MC-H07 frozen-replay code is new at this cutoff. |
| 39:1 | merge #8342 | debatable | Keeps the no-real-git rule but appends a git-execution obligation without clarifying test scope. |
| 39:2 | merge #7804 | correct | Adds checksum-file handoff while preserving every canonical deployment and epoch check. |
| 39:3 | new | correct | Language gating and non-English fallback behavior are not older compression-depth facts. |
| 39:4 | merge #20988 | correct | Retains durable identity reuse and adds Claude Code no-identity pause/retry behavior. |
| 39:5 | merge #14125 | correct | Adds provider-family usage-field validation without dropping cache-triage workflow steps. |
| 39:6 | new | correct | The two-reconnect abort bound and LKG/refusal behavior are new at this cutoff. |
| 39:7 | new | correct | Upstream ASCII/English-only limitations are distinct from MC's own language-gating rules. |

## Appendix B — observed original memory insertions

Fact ordinals refer to the recorded output, not the stripped replay. All 104 IDs below are exact normalized-content matches to historian-source rows within the ten-minute window. Unattributed ordinals account for the remaining 27 facts. Cases 32 and 34 emitted no original facts. The duplicate review is 102 not-fully-covered and two debatable inserted facts (#23985 and #23506); no clear older-pool duplicates were identified under the documented criterion.

| Case | Original fact → observed new memory ID | Unattributed original fact ordinals |
| --- | --- | --- |
| 0 | 1 → #24670 | None |
| 1 | 1 → #24583; 2 → #24584; 3 → #24585; 4 → #24586; 5 → #24587 | None |
| 2 | 1 → #24579; 2 → #24580; 3 → #24581; 4 → #24582 | None |
| 3 | 1 → #24506; 2 → #24507; 3 → #24508 | None |
| 4 | None | 1, 2, 3, 4 |
| 5 | 1 → #24490; 2 → #24491; 3 → #24492; 4 → #24493 | None |
| 6 | None | 1, 2, 3, 4, 5 |
| 7 | 1 → #24240; 2 → #24241; 3 → #24242 | None |
| 8 | 1 → #24238; 2 → #24239 | None |
| 9 | None | 1, 2, 3, 4 |
| 10 | 1 → #24120; 2 → #24121; 3 → #24122; 4 → #24123; 5 → #24124; 6 → #24125 | None |
| 11 | 1 → #24082; 2 → #24083; 3 → #24084 | None |
| 12 | 1 → #24077; 2 → #24078; 3 → #24079 | None |
| 13 | 1 → #23996; 2 → #23997 | None |
| 14 | 1 → #23987 | None |
| 15 | None | 1 |
| 16 | 1 → #23983; 2 → #23984; 3 → #23985; 4 → #23986 | None |
| 17 | 1 → #23852; 2 → #23853; 3 → #23854 | None |
| 18 | 1 → #23847; 2 → #23848; 3 → #23849; 4 → #23850; 5 → #23851 | None |
| 19 | 1 → #23846 | None |
| 20 | 1 → #23844; 2 → #23845 | None |
| 21 | 1 → #23843 | None |
| 22 | None | 1, 2, 3 |
| 23 | 1 → #23822; 2 → #23823 | None |
| 24 | None | 1, 2, 3, 4 |
| 25 | 1 → #23767; 2 → #23768; 3 → #23769; 4 → #23770; 5 → #23771; 6 → #23772 | None |
| 26 | 1 → #23760; 2 → #23761; 3 → #23762; 4 → #23763; 5 → #23764; 6 → #23765; 7 → #23766 | None |
| 27 | None | 1, 2, 3 |
| 28 | 1 → #23697 | None |
| 29 | 1 → #23508; 2 → #23509; 3 → #23510; 4 → #23511 | None |
| 30 | 1 → #23506; 2 → #23507 | None |
| 31 | None | 1, 2, 3 |
| 32 | None | None |
| 33 | 1 → #23400; 2 → #23401; 3 → #23402; 4 → #23403 | None |
| 34 | None | None |
| 35 | 1 → #23388; 2 → #23389 | None |
| 36 | 1 → #23375; 2 → #23376; 3 → #23377; 4 → #23378; 5 → #23379 | None |
| 37 | 1 → #23367; 2 → #23368; 3 → #23369; 4 → #23370; 5 → #23371 | None |
| 38 | 1 → #23274; 2 → #23275; 3 → #23276; 4 → #23277; 5 → #23278; 6 → #23279; 7 → #23280; 8 → #23281; 9 → #23282 | None |
| 39 | 1 → #23256; 2 → #23257; 3 → #23258; 4 → #23259 | None |
