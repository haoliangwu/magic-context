# Dreamer and historian: 14-day token-use investigation

## Scope and decision

**Window:** 2026-09-14 14:27:20 UTC ≤ invocation start < 2026-09-28 14:27:20 UTC (exactly 14 days). Local, single-machine inventory; not fleet-wide telemetry. Code inspected at `0cae05d8bccd4997e5c5c09ae641a16a5236f00a`. This is an investigation, not a budget or batch-size change.

**Main result:** 3,040 recorded dreamer/historian invocations account for **1,484,854,010 reported tokens**, including **1,183,461,698 cache-read tokens (79.7% of all reported tokens)**. Verify, verify-broad and map-memories together account for **1,030,630,608 tokens (69.4%)**. These are token volumes, **not dollar costs**: cache reads have different prices, some providers are subscription-backed, and reasoning is absent from the invocation table. Cache hits are cheaper than misses, but do not make a 60-turn expanding-prefix loop free.

The strongest actionable signal is **replaying accumulated investigation context**, not an oversized initial prompt. Retained Gemini map/verify children typically start around 7–10K prompt tokens and repeatedly consume an increasingly large prefix. Conversely, the Rust/Broca historian cohort is a one-model-step workload, with a large initial prompt: shrinking its initial input matters more than its step cap. Pi historian is a third, materially different workload: 715,649 recorded tokens per produced compartment in the matched cohort, versus 95,558 for OpenCode Gemini. Do not pool these execution modes when tuning.

**Important limit:** exact per-step reconstruction of the five globally most expensive invocations is impossible from the surviving stores. Four lack a surviving attributable transcript, including the 21.1M-cache-read curate invocation and the 18.3M-cache-read Pi verify invocation. This report identifies those runs and separately dissects the **five most expensive retained OpenCode child sessions** step by step. Missing measurements are not filled in with estimates presented as observations.

## Sources, linkage and measurement rules

All live SQLite stores were opened read-only (`sqlite3 -readonly` for inventory; Python SQLite URI `mode=ro`, `PRAGMA query_only=ON`, read transaction for analysis). JSONL and WAL files were opened only for reading. No live store, configuration, or GitHub content was changed. Only this report and the reusable analysis script are committed. Raw prompts, message bodies, arguments, paths read by agents, and tool results are not reproduced here.

- `~/.local/share/cortexkit/magic-context/context.db`: `subagent_invocations` is the primary **invocation** ledger, not the scheduler-run ledger. It contains parent `session_id`, `harness`, `subagent`, nullable task/model/provider, start/end, status, four token totals, error and parent invocation ID. It has **no step count, child-session ID, reasoning count, or structured failure-kind column** in this installation. Error kinds below are shape-based classifications, not provider-certified root causes.
- `dream_runs.tasks_json`: scheduler-level task results, structured `failure.failure_class` and sometimes `failure.child_session_id`, backlog snapshots and progress counters. One task can make several child invocations, fallbacks or batches. Scheduler counts therefore must not be added to invocation counts. 1,231 task-result entries matched a unique invocation by parent/task/time containment. Backlog movement is not universally a useful-output counter.
- `historian_runs`: direct `subagent_invocation_id` join supplies produced compartments. There are 3,337 rows in-window, including many no-ops without model invocation. No-op rows are not additional model runs.
- OpenCode 1 `opencode.db`: title identifies the child task, `session.parent_id` identifies the invocation's parent, and child creation time must fall in its invocation interval (1-second startup tolerance). `magic-context-dream-verify` needs the parent/time join to distinguish verify-broad. If intervals overlap, a **unique exact match of all four usage totals** breaks the tie. Ambiguous matches stay unlinked. 1,743 candidate children survive; 1,486 link to invocation rows. A child may be a batch, not an entire scheduled task. Standalone unlinked child statistics stay separate from the invocation ledger.
- OpenCode 2 `opencode2.db`: inspected `session_v2`, `session_message` and event-store schema. The materialized message table contains only two user and two idle rows, **no assistant usage**. No second independent OpenCode 2 task population can be measured here; do not treat absence as zero task cost.
- Pi `~/.pi/agent/sessions/`: 153 in-window JSONL session headers, 150 clearly under runtime-test directories; 201 assistant records across the scanned in-window files. No invocation parent ID matches. This is expected: `packages/pi-plugin/src/subagent-runner.ts:2030–2039` passes `--no-session` and consumes `agent_end` from stdout. Production dreamer/historian children are in memory, not persisted JSONL. Pi aggregate usage survives in the invocation ledger; step counts, growth and tool attribution do not.
- Broca `run-index.db.export_facts`: select `mc-historian:*` / `mc-dreamer:classify:*` sessions, deduplicate by run ID and sum segment facts before quantiles. Window is **export occurrence/terminal time**, unlike invocation start; 54 matching historical facts have no timestamp and cannot be assigned to this window. Keep this as a separate execution-mode cohort: Rust classify can already be represented in host invocation accounting, and there is no universal invocation↔Broca-run foreign key.
- Broca WALs: derive filename via FNV-1a of `(project_root, harness, session)` separated by U+001F from each selected export fact. Read the documented 53-byte little-endian header; verify SHA-256, record sequence and lineage frame shape; never repair a tail. All 1,147 selected export runs were found in live WALs. There were 747 `model_step_finished` records and 400 zero-completed-step failures. Source contract: `broca/docs/data-model.md`, sections 2 and 4. No archive extraction was necessary.

### Semantics and denominators

1. All distribution cells use **median / nearest-rank p90 / maximum**, not a mean. Include failed and zero-recorded-usage invocations unless a table explicitly says otherwise. Zero in the ledger means *zero reported*, not proof no provider tokens were spent. Unknown-model failures have particularly poor accounting. Model grouping uses the ledger's recorded model (often the last assistant model), and child grouping likewise uses the last reported model. Fallback children can contain multiple models: these are final-model **cohorts**, not exact provider-by-provider spend attribution. Detailed traces identify each record's model; do not attribute every token in a D-labelled child to DeepSeek.
2. Invocation tokens are the stored uncached-input, cache-read, cache-write and output columns. `sumTokensFromChildMessages` in `packages/plugin/src/features/magic-context/subagent-token-capture.ts` excludes reasoning. OpenCode per-message reasoning is shown separately in the detailed traces. Do not assume output/reasoning normalization is identical across providers; Broca output can include reasoning. Do not add reasoning a second time to Broca cost.
3. OpenCode **step proxy** = assistant message with at least one nonzero usage field. This is observable and reproducible, but is not the harness's internal tool-loop counter. It includes output-only records, fallback/continuation records and sometimes more than one provider attempt. A 62-record child is not proof that a 60-step cap was violated. “Near cap” below means proxy ≥90% of the **current code cap**, not a certified terminal `max_steps` event. Historical deployment versions/overrides are not persisted with these records.
4. Prompt size is input + cache read + cache write. First prompt means **first positive reported prompt**, skipping output-only records. Growth is `(last positive prompt − first positive prompt)/(positive-prompt-records − 1)`, per child, then quantiles. Cache-read share measures provider-reported reuse, not semantic redundancy. New input also includes cache misses, not just newly appended content.
5. Tool sizes are **characters of persisted output**, not tokens. A whole-file/default read is proxied by absence of range/limit arguments; a large ranged read can still be wasteful. Repeated-argument calls are not necessarily repeated file content (pagination, mutations and retries matter). Tool output replay estimates below are explicitly counterfactual.
6. Useful-unit ratios use only uniquely joined, positive-output invocations. Map/classify/review use net processed backlog; verify uses progress **verified + updated + archived**, excluding skipped/refused. Historian uses produced compartments. These are pooled tokens / pooled units, **not median per-unit costs** and not “all attempts including unlinked failures / successful units.” No defensible denominator survives for docs, retrospective, curate, smart-note evaluation, compress-cues or primer refresh. Do not divide by the configured batch size or claim that a completed status means useful work.

## Task configuration at the inspected revision

This is the current source contract, not a claim that every historical child used this revision. The source already contains batch floors and several tightened tool surfaces; historical waste does not prove those fixes are absent today.

| Task | Batch / input shape | Current OpenCode cap and tools | Budget / useful unit |
|---|---|---|---|
| map-memories | 80 memories; memory text → code mappings | 60; read, grep, glob, aft_outline/zoom/search | 240s per-batch floor, stop after 2 consecutive timeouts; memory mapped |
| verify / verify-broad | 50 mapped memories; text + backing-file references; deeper investigation | 60; same mapper tools | 240s floor, stop repeated provider-shaped batch failures; verified/updated/archived memory |
| curate | Rotating one-category pool, not a fixed 50-memory batch | 150; ctx_memory, ctx_memory_list only | Accepted mutation; reads/list calls must not count as mutations |
| classify-memories | 100-row chunks; floor 10, full pool ≤100, 30 calibration anchors for larger pools | 4; no tools in host agent; Rust producer is a distinct path | 600s Rust await / 660s transport; memory classified |
| retrospective | ≤20 sessions; ≤80 user messages/session; ≤240/run; ≤8,000 chars/user message; default 30-day recency | 40; ctx_search only | Accepted retrospective output; not simply sessions scanned |
| maintain-docs | Repository investigation; default docs max_tokens 12,000 | 60; read, grep, glob, aft_outline/zoom/search; no edit/bash now | Accepted documentation proposal |
| promote-primers | Cluster existing candidates; host-only | No LLM, no step cap | Primer promoted; model tokens structurally zero for promotion itself |
| refresh-primers | ≤5 stale primers/run, separate read-only investigation per primer | 40; read, grep, glob, aft_outline/zoom/search, ctx_search | Remaining deadline fairly divided; primer refreshed |
| evaluate-smart-notes | No-tool compiler/confirmation plus local sandbox evaluation | Compiler 8; no tools | Compiled/evaluated note; not number of prompt calls |
| review-user-memories | Candidate text → JSON verdict, host applies | 4; no tools | Candidate reviewed/promoted |
| compress-cues | 40 memories/chunk, no-tool transform | No separate cap established from hidden-agent registrations | 240s floor, 2 consecutive timeouts stop, 3 validation failures latch; cue accepted |
| historian | Session chunk → compartments/facts; optionally scoped source investigation | 40; read, aft_outline/zoom/search, subject to disallowed tools | Compartment produced; Rust cohort here completed in one model step |

Paths: `packages/plugin/src/agents/hidden-agent-registrations.ts:84–275`; `dreamer/{map-memories.ts:66–89,verify.ts:74–99,classify.ts:72–82,refresh-primers.ts:28,retrospective-raw-provider.ts:15–27,task-registry.ts:57–105,task-config.ts:25–47}` under `packages/plugin/src/features/magic-context/`; `mural/compress-cues.ts:65–89`. Task config defaults to 20 minutes, with model/task overrides. Pi reuses the shared executor, abort signal and task definitions; `packages/pi-plugin/src/dreamer/index.ts:558–561` sets a 30-minute outer runner timeout while the executor owns the task deadline. **Do not transfer the OpenCode cap numbers to Pi as measured caps**.

## Findings, ordered by size of plausible token-saving opportunity

These are ranked interventions, **not a claim that every cached token is wasted**. Savings are scenarios, not additive forecasts; the first two overlap substantially.

1. **Shorten expensive map/verify investigations before replaying their context dozens more times.** Verify + verify-broad + map consume 1.031B recorded tokens. Retained Gemini children near the current cap proxy: map **54/93**, verify **93/131**, verify-broad **34/42**. Median step proxies are 61/62/62; their median first prompts are only about 7.1K/9.7K/9.7K. The data supports a step-to-work mismatch, but not blindly halving every batch: source comments intentionally batch large to preserve shared file-read reuse. Proposed experiment: group memories by backing file/symbol, checkpoint accepted per-memory results, and stop opening new files when the remaining step budget cannot finish them. A **20% reduction** in those cohorts' reported token volume is **206M tokens/14 days**. That is a target to test against preserved useful-unit throughput, not an observed saving. Existing 240s floors address time starvation; they do not directly bound cumulative token rereads.
2. **Bound source-read output and use symbol/range navigation, especially early in a loop.** Retained verify output is 13.18M read characters vs 2.68M grep and 1.51M aft_search; verify-broad adds 4.86M read chars; map adds 5.73M. There are only 42/12/34 aft_zoom calls respectively, compared with 4,074/1,363/2,134 read calls. Four ≥50K-character reads occur in retained run `ses_f33fbf109ffeLrzikZHwefl208`; its prompt grows from 13,772 to 178,015 and 97.8% of input is cache-read. Replacing a 50K-character result by a 5K-character relevant excerpt saves roughly **11,250 tokens of new context at 4 chars/token**, and **562,500 prompt-token rereads over 50 later calls**. This is a transparent upper-bound-style scenario: tokenizer, compaction and necessary context change it. Prefer outline → zoom, return metadata plus a targeted follow-up for large reads, and reuse a per-task symbol/file evidence map. Do not assume grep is harmless: map alone returns 2.37M grep chars.
3. **Make documentation investigation bounded and proposal-only; verify deployment of the tightened tool surface.** maintain-docs contributes **119.65M tokens**, 105.11M cached. Retained Gemini docs children: median 52 records, p90 65, 10/21 near the current 60 cap proxy. Historical tool output includes **270 bash calls and 18 edit calls**, even though current docs registration permits neither. This is evidence of an older/different tool surface, not evidence that the current permission lock is broken. The most expensive retained docs child reaches 182,656 prompt tokens, with 6.53M cache reads and two ≥50K reads at its first step. Scope to one documentation claim/section per proposal, precompute the relevant file/symbol set, and enforce the current allowlist. A **25% volume reduction** in the historical docs cohort would be **29.9M tokens/14 days**; preserve proposal acceptance as the denominator.
4. **Avoid re-enumerating curate's whole category and distinguish reads from useful mutations.** Curate contributes **88.71M tokens**, including the single **21,098,966-cache-read** DeepSeek invocation 17577. Its scheduler result records a 159-memory category and 148 operations, but those include 59 gets and 9 lists, so “148 useful units” would be false. Retained Gemini curate children issue 112 ctx_memory_list calls; **75 repeat identical arguments**, and list output contributes 645,430 of 672,769 persisted tool-output chars (95.9%). Cache the initial category snapshot locally and return mutation deltas; do not re-list unchanged pages. A **20% cohort reduction** is **17.7M tokens/14 days**. Exact replay saving cannot be reconstructed for 17577 because its transcript is gone; repeated calls alone are not proof the returned data was unchanged.
5. **Tackle historian input differently by execution mode, and repair telemetry before sizing Pi.** Broca Gemini historian has median **78,191 uncached input tokens/run** and completes in one model step, unlike Pi historian's multi-million-token outliers. That cohort reports **46,230,708 uncached input tokens**. A **10% reduction in initial chunk input**, holding semantic coverage constant, would save **4.62M uncached tokens/14 days**; it cannot be obtained by shortening the 40-step cap when the run has one step. Pi Gemini historian's matched unit cost is **715,649 tokens/compartment** (196 runs, 211 compartments), with two global top-five invocations costing 8.39M and 8.22M tokens for one compartment each. Preserve compact per-step counters in stdout-derived telemetry before tuning Pi. Neither unused prompt context nor the specific tool responsible can be demonstrated for those lost sessions.

**Smaller / unproven suspects:** exact same-argument reads are uncommon in the retained source-reading cohorts (verify 12, docs 2, map 0); large first reads and long replay are better-supported than repeated identical file reads. Different ranges of the same file are not measured as duplicate content. Fallback waste is real in attempts but not necessarily large in tokens: Broca Muse has 58 classifier and 163 historian errors with zero reported usage; 169/182 Opus historian attempts error. Pi has 76 recorded model-not-found errors across these agents in the window. Remove unavailable models from an experiment's fallback chain, but do not attribute millions of tokens to zero-accounted pre-call failures. Unknown-model timeout rows may instead hide real usage. There is insufficient evidence to assign a numeric saving to unused tool definitions, unused initial context, or scratch-restarting retries; durable child/run IDs and per-attempt accounting should precede those claims.

## Quantitative appendices

Model keys: **G** = antigravity-gemini-3.8-flash; **D** = deepseek-v4.1-flash; **D0** = deepseek-v4-flash:0731; **M** = muse-spark-1.3-contributor-free; **O** = antigravity-claude-opus-4-6-thinking; **F** = claude-fable-5-1; **O5** = claude-opus-5; **O55** = claude-opus-5-5; **?** = not recorded. `OC` is the ledger's opencode harness, not an assertion that every call used the OpenCode model loop. `PI` is pi. Counts are invocations unless explicitly marked children or scheduler tasks.

### A. Invocation outcomes by host, task and model
Completed percentage is completed / all rows. Non-completed includes failed, timed_out, empty and aborted; it is not uniformly a provider failure. Failure-kind percentages use all rows in that same group. Unknown model is retained rather than attributed to a configured fallback.

| Host | Task | Model | Runs | Completed % | Status counts | Non-completed error-shape kind (count; % of runs) |
| --- | --- | --- | --- | --- | --- | --- |
| OC | classify-memories | G | 139 | 100.0% | completed=139 | — |
| OC | classify-memories | D0 | 1 | 100.0% | completed=1 | — |
| OC | classify-memories | D | 10 | 100.0% | completed=10 | — |
| OC | classify-memories | M | 24 | 100.0% | completed=24 | — |
| OC | classify-memories | ? | 150 | 16.0% | completed=24; failed=126 | cancelled=22 (14.7%); empty_output=12 (8.0%); manifest=1 (0.7%); missing_run_id=45 (30.0%); other=14 (9.3%); timeout=32 (21.3%) |
| OC | curate | G | 43 | 100.0% | completed=43 | — |
| OC | curate | D | 1 | 100.0% | completed=1 | — |
| OC | evaluate-smart-notes | G | 144 | 96.5% | completed=139; failed=5 | other=5 (3.5%) |
| OC | evaluate-smart-notes | D | 10 | 100.0% | completed=10 | — |
| OC | evaluate-smart-notes | M | 19 | 100.0% | completed=19 | — |
| OC | evaluate-smart-notes | ? | 32 | 0.0% | aborted=4; failed=28 | cancelled=13 (40.6%); empty_output=1 (3.1%); other=7 (21.9%); timeout=11 (34.4%) |
| OC | historian | O | 99 | 100.0% | completed=99 | — |
| OC | historian | G | 436 | 100.0% | completed=436 | — |
| OC | historian | F | 4 | 100.0% | completed=4 | — |
| OC | historian | O55 | 5 | 100.0% | completed=5 | — |
| OC | historian | D | 55 | 94.5% | completed=52; empty=3 | other=3 (5.5%) |
| OC | historian | M | 229 | 100.0% | completed=229 | — |
| OC | historian | ? | 76 | 1.3% | completed=1; failed=75 | cancelled=1 (1.3%); other=3 (3.9%); timeout=71 (93.4%) |
| OC | maintain-docs | G | 28 | 100.0% | completed=28 | — |
| OC | maintain-docs | D | 2 | 100.0% | completed=2 | — |
| OC | maintain-docs | M | 30 | 100.0% | completed=30 | — |
| OC | map-memories | G | 124 | 100.0% | completed=124 | — |
| OC | map-memories | D0 | 12 | 100.0% | completed=12 | — |
| OC | map-memories | D | 17 | 100.0% | completed=17 | — |
| OC | map-memories | M | 28 | 100.0% | completed=28 | — |
| OC | map-memories | ? | 137 | 0.0% | empty=2; failed=135 | cancelled=21 (15.3%); empty_output=26 (19.0%); manifest=27 (19.7%); timeout=63 (46.0%) |
| OC | retrospective | G | 129 | 100.0% | completed=129 | — |
| OC | retrospective | D0 | 2 | 100.0% | completed=2 | — |
| OC | retrospective | D | 3 | 100.0% | completed=3 | — |
| OC | retrospective | M | 7 | 100.0% | completed=7 | — |
| OC | review-user-memories | G | 12 | 100.0% | completed=12 | — |
| OC | review-user-memories | D | 3 | 100.0% | completed=3 | — |
| OC | verify | G | 206 | 100.0% | completed=206 | — |
| OC | verify | D0 | 10 | 100.0% | completed=10 | — |
| OC | verify | D | 13 | 100.0% | completed=13 | — |
| OC | verify | M | 50 | 100.0% | completed=50 | — |
| OC | verify | ? | 219 | 0.0% | empty=14; failed=154; timed_out=51 | cancelled=18 (8.2%); empty_output=49 (22.4%); manifest=13 (5.9%); other=4 (1.8%); timeout=135 (61.6%) |
| OC | verify-broad | G | 72 | 100.0% | completed=72 | — |
| OC | verify-broad | D | 5 | 100.0% | completed=5 | — |
| OC | verify-broad | ? | 32 | 0.0% | failed=27; timed_out=5 | empty_output=3 (9.4%); manifest=1 (3.1%); timeout=28 (87.5%) |
| PI | classify-memories | G | 6 | 100.0% | completed=6 | — |
| PI | classify-memories | D0 | 3 | 0.0% | failed=3 | model_not_found=3 (100.0%) |
| PI | compress-cues | G | 26 | 100.0% | completed=26 | — |
| PI | curate | G | 2 | 100.0% | completed=2 | — |
| PI | curate | D0 | 1 | 0.0% | failed=1 | model_not_found=1 (100.0%) |
| PI | evaluate-smart-notes | G | 6 | 100.0% | completed=6 | — |
| PI | historian | G | 223 | 87.9% | completed=196; failed=27 | timeout=27 (12.1%) |
| PI | historian | D0 | 5 | 0.0% | failed=5 | model_not_found=5 (100.0%) |
| PI | historian | gpt-5.6-sol | 5 | 0.0% | failed=5 | empty_output=5 (100.0%) |
| PI | maintain-docs | G | 5 | 20.0% | completed=1; empty=2; failed=2 | empty_output=4 (80.0%) |
| PI | maintain-docs | D0 | 4 | 0.0% | failed=4 | model_not_found=4 (100.0%) |
| PI | map-memories | G | 44 | 11.4% | completed=5; empty=33; failed=6 | empty_output=34 (77.3%); other=5 (11.4%) |
| PI | map-memories | D0 | 44 | 0.0% | failed=44 | model_not_found=44 (100.0%) |
| PI | retrospective | G | 8 | 87.5% | completed=7; failed=1 | empty_output=1 (12.5%) |
| PI | retrospective | D0 | 1 | 0.0% | failed=1 | model_not_found=1 (100.0%) |
| PI | unattributed | G | 10 | 90.0% | completed=9; failed=1 | other=1 (10.0%) |
| PI | unattributed | D0 | 10 | 0.0% | failed=10 | model_not_found=10 (100.0%) |
| PI | verify | G | 11 | 27.3% | completed=3; empty=5; failed=3 | empty_output=8 (72.7%) |
| PI | verify | D0 | 8 | 0.0% | failed=8 | model_not_found=8 (100.0%) |

No promote-primers or refresh-primers invocation rows were observed in this window on either host. Promotion is host-only by design; this does **not** prove that its scheduler never ran. OpenCode compress-cues has surviving child sessions but no task-labelled invocation rows: see C rather than interpreting its ledger absence as zero usage. Pi has 20 dreamer rows with null task (shown as unattributed); no task is guessed for them.

### B. Per-invocation token and wall-time distributions
Each cell is median / p90 / max. Wall time is seconds. Steps are the **sum of surviving linked child usage records**, over linked invocations only (coverage n shown); incomplete children can make this a lower bound. Pi steps are unavailable. Cache-write is reported even when zero.

| Host | Task | Model | Uncached input | Cache read | Cache write | Output | Wall s | Observed steps (linked n) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OC | classify-memories | G | 9,319 / 20,487 / 33,495 | 0 / 0 / 24,541 | 0 / 0 / 0 | 640 / 2,366 / 6,286 | 36.8 / 72 / 129.9 | 1 / 1 / 1 (n=77) |
| OC | classify-memories | D0 | 42,574 / 42,574 / 42,574 | 0 / 0 / 0 | 0 / 0 / 0 | 2,730 / 2,730 / 2,730 | 85.7 / 85.7 / 85.7 | — (n=0) |
| OC | classify-memories | D | 21,889 / 35,003 / 36,579 | 0 / 0 / 24 | 0 / 0 / 0 | 2,951.5 / 7,483 / 7,769 | 61.2 / 556.5 / 1,850.1 | 2 / 2 / 2 (n=7) |
| OC | classify-memories | M | 8,062 / 11,719 / 12,603 | 113 / 113 / 113 | 0 / 0 / 0 | 688.5 / 1,297 / 2,176 | 26.9 / 50.8 / 72.8 | — (n=0) |
| OC | classify-memories | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 16.4 / 935.5 / 1,947.3 | 0 / 0 / 0 (n=4) |
| OC | curate | G | 153,121 / 477,064 / 938,572 | 844,605 / 3,333,637 / 5,693,513 | 0 / 0 / 0 | 2,428 / 6,501 / 9,814 | 132.7 / 222.5 / 320.3 | 14 / 48 / 65 (n=21) |
| OC | curate | D | 840,937 / 840,937 / 840,937 | 21,098,966 / 21,098,966 / 21,098,966 | 0 / 0 / 0 | 40,643 / 40,643 / 40,643 | 603.3 / 603.3 / 603.3 | — (n=0) |
| OC | evaluate-smart-notes | G | 3,325 / 3,904 / 9,558 | 0 / 0 / 113 | 0 / 0 / 0 | 5 / 510 / 2,242 | 3.6 / 78.2 / 920.2 | 1 / 1 / 1 (n=88) |
| OC | evaluate-smart-notes | D | 3,921 / 4,254 / 7,520 | 0 / 2,816 / 2,816 | 0 / 0 / 0 | 89 / 126 / 884 | 1.5 / 33.8 / 636.4 | 2 / 2 / 2 (n=7) |
| OC | evaluate-smart-notes | M | 3,525 / 4,136 / 6,558 | 113 / 113 / 1,521 | 0 / 0 / 0 | 58 / 661 / 678 | 6.5 / 36.1 / 41.5 | — (n=0) |
| OC | evaluate-smart-notes | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 681.6 / 961 / 1,076.3 | 0.5 / 1 / 1 (n=6) |
| OC | historian | O | 0 / 0 / 54,289 | 0 / 0 / 21,002 | 0 / 0 / 0 | 33 / 33 / 11,678 | 0.5 / 8.1 / 273.7 | 1 / 1 / 2 (n=98) |
| OC | historian | G | 70,697.5 / 101,873 / 515,937 | 0 / 16,372 / 2,377,122 | 0 / 0 / 0 | 2,426 / 3,703 / 5,718 | 55.4 / 88.5 / 600 | 1 / 1 / 27 (n=420) |
| OC | historian | F | 4 / 4 / 4 | 0 / 0 / 0 | 149,526 / 155,515 / 155,515 | 9,366 / 16,273 / 16,273 | 142.8 / 292.4 / 292.4 | 1 / 1 / 1 (n=4) |
| OC | historian | O55 | 4 / 4 / 4 | 0 / 0 / 0 | 146,629 / 151,583 / 151,583 | 6,932 / 8,686 / 8,686 | 67.9 / 78.1 / 78.1 | 1 / 1 / 1 (n=5) |
| OC | historian | D | 69,208 / 92,563 / 100,364 | 13,994 / 18,688 / 22,016 | 0 / 0 / 0 | 25,545 / 32,000 / 32,000 | 103.7 / 175.7 / 227.9 | 1 / 1 / 1 (n=55) |
| OC | historian | M | 4 / 72,951 / 86,261 | 0 / 113 / 95,202 | 0 / 0 / 0 | 416 / 4,507 / 6,284 | 33.2 / 95.3 / 282.7 | 1 / 1 / 2 (n=203) |
| OC | historian | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 356.1 / 1,205.2 / 1,948.7 | 0 / 2 / 4 (n=73) |
| OC | maintain-docs | G | 375,808.5 / 673,472 / 772,626 | 2,673,820.5 / 4,583,050 / 5,602,549 | 0 / 0 / 0 | 5,715.5 / 11,333 / 13,822 | 227.4 / 339.8 / 415.8 | 53.5 / 65 / 69 (n=20) |
| OC | maintain-docs | D | 440,402.5 / 531,537 / 531,537 | 3,326,220.5 / 3,637,482 / 3,637,482 | 0 / 0 / 0 | 21,794.5 / 28,286 / 28,286 | 386.9 / 403.5 / 403.5 | 60 / 60 / 60 (n=1) |
| OC | maintain-docs | M | 55,237.5 / 84,558 / 148,286 | 583,191.5 / 1,329,402 / 2,320,266 | 0 / 0 / 0 | 4,247.5 / 6,902 / 12,740 | 96.7 / 164.4 / 287 | — (n=0) |
| OC | map-memories | G | 412,952.5 / 563,706 / 829,511 | 1,604,114 / 2,529,437 / 3,583,262 | 0 / 0 / 0 | 2,241 / 3,438 / 4,990 | 183.2 / 267 / 334.8 | 62 / 64 / 67 (n=83) |
| OC | map-memories | D0 | 242,255 / 351,838 / 403,065 | 367,199 / 1,791,618 / 3,500,810 | 0 / 0 / 0 | 4,030 / 20,287 / 28,129 | 93.5 / 203.5 / 354 | — (n=0) |
| OC | map-memories | D | 164,503 / 767,059 / 811,824 | 1,751,467 / 3,941,184 / 4,361,768 | 0 / 0 / 0 | 20,861 / 81,743 / 138,610 | 366.7 / 648.7 / 1,031.2 | 49.5 / 69 / 72 (n=12) |
| OC | map-memories | M | 45,608 / 99,352 / 113,075 | 234,929.5 / 1,037,125 / 1,206,966 | 0 / 0 / 0 | 2,342.5 / 6,742 / 7,982 | 60.2 / 125.5 / 200 | — (n=0) |
| OC | map-memories | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 675.4 / 976.6 / 1,877.7 | 1 / 60 / 62 (n=18) |
| OC | retrospective | G | 4,988 / 65,692 / 150,012 | 0 / 4,072 / 227,996 | 0 / 0 / 0 | 1 / 212 / 637 | 4.7 / 44.4 / 195.9 | 1 / 8 / 20 (n=71) |
| OC | retrospective | D0 | 101,097.5 / 109,125 / 109,125 | 79,887 / 159,774 / 159,774 | 0 / 0 / 0 | 1,319.5 / 1,637 / 1,637 | 77.4 / 86.3 / 86.3 | — (n=0) |
| OC | retrospective | D | 11,389 / 21,270 / 21,270 | 0 / 20 / 20 | 0 / 0 / 0 | 75 / 120 / 120 | 426 / 617.6 / 617.6 | 2 / 2 / 2 (n=3) |
| OC | retrospective | M | 5,252 / 17,999 / 17,999 | 113 / 22,468 / 22,468 | 0 / 0 / 0 | 78 / 357 / 357 | 10.5 / 40.3 / 40.3 | — (n=0) |
| OC | review-user-memories | G | 6,718.5 / 10,832 / 14,566 | 0 / 0 / 0 | 0 / 0 / 0 | 58 / 93 / 249 | 12.3 / 31.2 / 44.1 | 1 / 1 / 1 (n=8) |
| OC | review-user-memories | D | 10,950 / 17,811 / 17,811 | 0 / 0 / 0 | 0 / 0 / 0 | 396 / 604 / 604 | 9.8 / 509.8 / 509.8 | 2 / 2 / 2 (n=2) |
| OC | verify | G | 413,602.5 / 516,233 / 806,272 | 1,941,869.5 / 2,509,327 / 5,572,190 | 0 / 0 / 0 | 4,069.5 / 5,037 / 12,830 | 195.6 / 285 / 353.7 | 62 / 64 / 66 (n=119) |
| OC | verify | D0 | 230,375.5 / 393,178 / 486,502 | 1,365,192.5 / 3,686,473 / 3,859,749 | 0 / 0 / 0 | 21,441.5 / 36,767 / 37,607 | 213.4 / 289.2 / 306.4 | — (n=0) |
| OC | verify | D | 181,296 / 534,874 / 624,330 | 1,692,186 / 5,442,688 / 8,050,816 | 0 / 0 / 0 | 28,852 / 88,964 / 142,743 | 298.5 / 489.6 / 905.5 | 46.5 / 76 / 90 (n=10) |
| OC | verify | M | 69,298.5 / 163,392 / 244,522 | 465,175.5 / 1,194,964 / 2,092,304 | 0 / 0 / 0 | 4,122.5 / 6,560 / 8,934 | 56.8 / 85.6 / 124.7 | — (n=0) |
| OC | verify | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 300.9 / 720.3 / 1,075.9 | 36 / 65 / 76 (n=27) |
| OC | verify-broad | G | 414,308.5 / 550,693 / 731,012 | 1,960,088.5 / 3,123,247 / 5,381,146 | 0 / 0 / 0 | 4,078 / 4,898 / 6,174 | 176.2 / 217.8 / 239.2 | 62 / 64 / 66 (n=40) |
| OC | verify-broad | D | 124,974 / 497,648 / 497,648 | 276,950 / 3,608,810 / 3,608,810 | 0 / 0 / 0 | 13,943 / 67,351 / 67,351 | 106.1 / 407.9 / 407.9 | 31 / 31 / 31 (n=1) |
| OC | verify-broad | ? | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 300.1 / 720.2 / 720.3 | 34 / 35 / 35 (n=3) |
| PI | classify-memories | G | 5,802 / 7,143 / 7,143 | 0 / 0 / 0 | 0 / 0 / 0 | 16,089 / 21,950 / 21,950 | 41.2 / 52.2 / 52.2 | — (n=0) |
| PI | classify-memories | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 4.5 / 8.9 / 8.9 | — (n=0) |
| PI | compress-cues | G | 1,285 / 3,070 / 3,111 | 0 / 0 / 0 | 0 / 0 / 0 | 5,082 / 10,397 / 23,379 | 18.5 / 38.6 / 65.1 | — (n=0) |
| PI | curate | G | 3,046.5 / 3,724 / 3,724 | 0 / 0 / 0 | 0 / 0 / 0 | 19,229.5 / 23,744 / 23,744 | 50.4 / 54.2 / 54.2 | — (n=0) |
| PI | curate | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0.7 / 0.7 / 0.7 | — (n=0) |
| PI | evaluate-smart-notes | G | 248 / 472 / 472 | 0 / 0 / 0 | 0 / 0 / 0 | 371.5 / 666 / 666 | 6.8 / 14.3 / 14.3 | — (n=0) |
| PI | historian | G | 80,563 / 466,221 / 1,339,143 | 200,964 / 1,599,016 / 7,642,955 | 0 / 0 / 0 | 11,568 / 20,005 / 36,912 | 80.8 / 600 / 600.1 | — (n=0) |
| PI | historian | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.6 / 3.9 / 3.9 | — (n=0) |
| PI | historian | gpt-5.6-sol | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 5.5 / 7.9 / 7.9 | — (n=0) |
| PI | maintain-docs | G | 890 / 516,352 / 516,352 | 0 / 3,714,317 / 3,714,317 | 0 / 0 / 0 | 252 / 34,879 / 34,879 | 7.1 / 202.5 / 202.5 | — (n=0) |
| PI | maintain-docs | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.4 / 2.7 / 2.7 | — (n=0) |
| PI | map-memories | G | 5,387 / 11,514 / 58,787 | 0 / 0 / 0 | 0 / 0 / 0 | 1,178.5 / 65,532 / 89,414 | 11.8 / 148.6 / 267.4 | — (n=0) |
| PI | map-memories | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.8 / 4.7 / 15.4 | — (n=0) |
| PI | retrospective | G | 11,771.5 / 54,663 / 54,663 | 0 / 41,317 / 41,317 | 0 / 0 / 0 | 5,098 / 31,648 / 31,648 | 25.9 / 98.4 / 98.4 | — (n=0) |
| PI | retrospective | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.4 / 1.4 / 1.4 | — (n=0) |
| PI | unattributed | G | 246 / 470 / 470 | 0 / 0 / 0 | 0 / 0 / 0 | 44,151.5 / 63,194 / 65,429 | 146.7 / 180.8 / 193 | — (n=0) |
| PI | unattributed | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.8 / 4.6 / 8.7 | — (n=0) |
| PI | verify | G | 3,920 / 169,271 / 1,277,143 | 0 / 545,681 / 18,339,944 | 0 / 0 / 0 | 4,031 / 35,465 / 46,162 | 12.3 / 83.7 / 546 | — (n=0) |
| PI | verify | D0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 1.3 / 4.5 / 4.5 | — (n=0) |

### C. Surviving OpenCode child cost shape and cap proximity
All title-identified children, including ones without an invocation join. n = children with any reported usage; zero-usage shells are excluded from distributions. Prefix/new is cache-read / (input + cache-read + cache-write); this is reuse, not proven waste. Positive prompt records alone determine first prompt and growth. Cap proximity uses current caps and is not an observed terminal reason. “historian-rust” means the OpenCode child title contains an mc-historian ID; it is **not** an independent Broca-export cohort.

| Task | Model | n | Steps med/p90/max | Near cap | First prompt med/p90/max | Growth/step med/p90/max | Cache share of input |
| --- | --- | --- | --- | --- | --- | --- | --- |
| classify-memories | G | 77 | 1 / 1 / 1 | 0/77 | 7,922 / 15,436 / 22,832 | — | 0.0% |
| classify-memories | D | 7 | 2 / 2 / 2 | 0/7 | 18,033 / 36,579 / 36,579 | — | 0.0% |
| compress-cues | G | 91 | 1 / 2 / 3 | — | 4,130 / 7,373 / 17,281 | 12,481 / 35,792 / 43,368 | 2.4% |
| compress-cues | D | 13 | 2 / 2 / 2 | — | 7,823 / 10,172 / 11,277 | — | 8.7% |
| curate | G | 21 | 14 / 48 / 65 | 0/21 | 12,418 / 27,354 / 42,734 | 4,082.9 / 7,233.6 / 9,043 | 81.9% |
| evaluate-smart-notes | G | 91 | 1 / 1 / 1 | — | 3,166 / 3,845 / 5,032 | — | 0.0% |
| evaluate-smart-notes | D | 7 | 2 / 2 / 2 | — | 3,739 / 4,254 / 4,254 | 842 / 842 / 842 | 18.7% |
| historian | O | 107 | 1 / 1 / 4 | 0/107 | 85,445 / 96,205 / 98,593 | 739 / 1,414 / 1,414 | 16.8% |
| historian | G | 437 | 1 / 1 / 27 | 0/437 | 81,804 / 102,379 / 112,413 | 3,240.7 / 8,104.7 / 10,444 | 28.9% |
| historian | F | 3 | 1 / 1 / 1 | 0/3 | 151,614 / 155,519 / 155,519 | — | 0.0% |
| historian | O55 | 5 | 1 / 1 / 1 | 0/5 | 146,633 / 151,587 / 151,587 | — | 0.0% |
| historian | D | 55 | 1 / 1 / 1 | 0/55 | 81,486 / 93,768 / 100,364 | — | 10.8% |
| historian | M | 115 | 1 / 1 / 2 | 0/115 | 66,367 / 78,956 / 86,374 | 10,979 / 10,979 / 10,979 | 2.1% |
| historian-rust | G | 75 | 1 / 9 / 36 | — | 104,367 / 109,775 / 157,677 | 3,089 / 7,699.3 / 7,946 | 64.5% |
| maintain-docs | G | 21 | 52 / 65 / 69 | 10/21 | 8,178 / 13,147 / 13,208 | 1,858.7 / 2,526.5 / 2,604.4 | 85.1% |
| maintain-docs | D | 1 | 60 / 60 / 60 | 1/1 | 8,174 / 8,174 / 8,174 | 1,556.7 / 1,556.7 / 1,556.7 | 85.9% |
| map-memories | G | 93 | 61 / 64 / 67 | 54/93 | 7,062 / 11,057 / 19,667 | 1,054.5 / 1,471.4 / 2,390.2 | 77.3% |
| map-memories | D | 17 | 60 / 69 / 72 | 9/17 | 11,937 / 21,543 / 21,801 | 1,357.5 / 2,818.8 / 2,872.8 | 84.8% |
| retrospective | G | 74 | 1 / 10 / 26 | 0/74 | 3,269 / 5,766 / 14,485 | 1,041.6 / 1,719.2 / 2,446.5 | 43.8% |
| retrospective | D | 7 | 2 / 24 / 24 | 0/7 | 3,177 / 10,160 / 10,160 | 578 / 1,843 / 1,843 | 39.1% |
| review-user-memories | G | 8 | 1 / 1 / 1 | 0/8 | 6,594 / 7,072 / 7,072 | — | 0.0% |
| review-user-memories | D | 2 | 2 / 2 / 2 | 0/2 | 8,686 / 10,758 / 10,758 | 4,583 / 4,583 / 4,583 | 0.0% |
| verify | G | 131 | 62 / 64 / 76 | 93/131 | 9,697 / 14,304 / 29,827 | 927.7 / 1,795.6 / 7,090.4 | 81.4% |
| verify | D | 19 | 50 / 76 / 90 | 8/19 | 12,453 / 15,884 / 20,696 | 1,929.4 / 4,331 / 4,898.3 | 92.4% |
| verify-broad | G | 42 | 62 / 64 / 66 | 34/42 | 9,684.5 / 11,399 / 14,314 | 1,050.8 / 1,915 / 13,698.7 | 82.8% |
| verify-broad | D | 1 | 31 / 31 / 31 | 0/1 | 8,586 / 8,586 / 8,586 | 3,697.7 / 3,697.7 / 3,697.7 | 89.9% |

Full step-proxy distributions (`records:children`), rather than just cap anecdotes:

| Task | Model | Step distribution |
| --- | --- | --- |
| classify-memories | G | 1:77 |
| classify-memories | D | 2:7 |
| compress-cues | G | 1:78, 2:12, 3:1 |
| compress-cues | D | 2:13 |
| curate | G | 3:1, 4:1, 5:1, 6:1, 7:1, 8:1, 10:2, 13:1, 14:2, 15:1, 16:2, 17:1, 22:1, 37:1, 42:1, 48:1, 50:1, 65:1 |
| evaluate-smart-notes | G | 1:91 |
| evaluate-smart-notes | D | 2:7 |
| historian | O | 1:98, 2:5, 3:3, 4:1 |
| historian | G | 1:419, 2:3, 3:1, 4:4, 5:1, 7:1, 9:1, 10:1, 11:1, 14:2, 20:1, 21:1, 27:1 |
| historian | F | 1:3 |
| historian | O55 | 1:5 |
| historian | D | 1:55 |
| historian | M | 1:114, 2:1 |
| historian-rust | G | 1:61, 2:1, 3:1, 4:1, 5:2, 9:2, 10:1, 13:2, 16:1, 17:2, 36:1 |
| maintain-docs | G | 1:4, 36:1, 37:1, 43:1, 45:2, 49:1, 52:1, 55:1, 60:1, 61:1, 62:4, 65:1, 68:1, 69:1 |
| maintain-docs | D | 60:1 |
| map-memories | G | 1:12, 2:1, 3:1, 11:1, 15:1, 16:1, 17:1, 18:2, 21:2, 22:1, 24:1, 28:1, 29:1, 30:1, 32:1, 34:1, 35:1, 36:1, 37:2, 39:1, 40:1, 47:1, 48:1, 50:1, 52:1, 55:1, 56:1, 58:1, 59:2, 61:6, 62:18, 63:9, 64:8, 65:4, 66:1, 67:3 |
| map-memories | D | 2:1, 8:1, 16:1, 22:1, 26:1, 27:1, 32:1, 39:1, 60:3, 61:1, 62:2, 68:1, 69:1, 72:1 |
| retrospective | G | 1:51, 2:2, 3:1, 4:5, 5:2, 7:2, 8:1, 9:2, 10:1, 11:1, 12:1, 13:1, 20:1, 25:1, 26:2 |
| retrospective | D | 2:5, 12:1, 24:1 |
| review-user-memories | G | 1:8 |
| review-user-memories | D | 2:2 |
| verify | G | 1:3, 2:1, 4:1, 6:1, 7:1, 8:3, 10:1, 13:1, 14:2, 22:1, 24:1, 25:1, 26:2, 29:2, 30:1, 32:1, 35:2, 36:2, 43:1, 44:2, 45:2, 48:3, 49:2, 51:1, 56:1, 60:2, 61:7, 62:35, 63:22, 64:15, 65:9, 66:1, 76:1 |
| verify | D | 11:1, 26:1, 30:1, 32:1, 37:1, 40:2, 46:1, 47:1, 50:1, 53:1, 57:1, 61:2, 65:2, 71:1, 76:1, 90:1 |
| verify-broad | G | 4:1, 10:1, 11:1, 16:1, 18:1, 34:1, 35:1, 44:1, 61:5, 62:12, 63:9, 64:4, 65:3, 66:1 |
| verify-broad | D | 31:1 |

Tool output growth by child task, pooled across models. Counts/chars are actual persisted result shapes. Same-args means identical serialized arguments within a child, not a proof of redundant content. Default reads means no offset/limit/range keys.

| Task | Tool | Calls | Output chars | Same-args calls | Default reads | Default-read chars |
| --- | --- | --- | --- | --- | --- | --- |
| compress-cues | task | 14 | 0 | 0 | 0 | 0 |
| curate | ctx_memory | 299 | 27,339 | 84 | 0 | 0 |
| curate | ctx_memory_list | 112 | 645,430 | 75 | 0 | 0 |
| curate | task | 5 | 0 | 0 | 0 | 0 |
| historian | aft_outline | 1 | 34,283 | 0 | 0 | 0 |
| historian | aft_search | 87 | 153,374 | 5 | 0 | 0 |
| historian | aft_zoom | 14 | 44,647 | 0 | 0 | 0 |
| historian | read | 75 | 379,812 | 0 | 4 | 11,782 |
| historian-rust | aft_search | 76 | 431,742 | 2 | 0 | 0 |
| historian-rust | aft_zoom | 2 | 988 | 0 | 0 | 0 |
| historian-rust | read | 67 | 266,469 | 0 | 37 | 36,830 |
| maintain-docs | aft_outline | 2 | 13,182 | 0 | 0 | 0 |
| maintain-docs | aft_search | 154 | 290,354 | 4 | 0 | 0 |
| maintain-docs | aft_zoom | 10 | 22,323 | 0 | 0 | 0 |
| maintain-docs | bash | 270 | 1,077,947 | 5 | 0 | 0 |
| maintain-docs | edit | 18 | 425 | 0 | 0 | 0 |
| maintain-docs | glob | 57 | 24,396 | 0 | 0 | 0 |
| maintain-docs | grep | 92 | 35,300 | 0 | 0 | 0 |
| maintain-docs | read | 401 | 2,586,026 | 2 | 104 | 1,148,303 |
| map-memories | aft_outline | 26 | 91,867 | 1 | 0 | 0 |
| map-memories | aft_read | 1 | 0 | 0 | 0 | 0 |
| map-memories | aft_search | 1,250 | 2,667,465 | 16 | 0 | 0 |
| map-memories | aft_zoom | 34 | 63,335 | 0 | 0 | 0 |
| map-memories | bash | 7 | 0 | 0 | 0 | 0 |
| map-memories | glob | 252 | 78,429 | 1 | 0 | 0 |
| map-memories | grep | 2,401 | 2,370,878 | 17 | 0 | 0 |
| map-memories | read | 2,134 | 5,728,346 | 0 | 134 | 430,130 |
| retrospective | ctx_search | 218 | 277,049 | 2 | 0 | 0 |
| retrospective | task | 3 | 0 | 0 | 0 | 0 |
| verify | aft_outline | 49 | 420,509 | 1 | 0 | 0 |
| verify | aft_search | 695 | 1,507,081 | 9 | 0 | 0 |
| verify | aft_zoom | 42 | 295,189 | 0 | 0 | 0 |
| verify | bash | 11 | 0 | 0 | 0 | 0 |
| verify | glob | 317 | 83,944 | 4 | 0 | 0 |
| verify | grep | 5,123 | 2,678,904 | 36 | 0 | 0 |
| verify | list_mcp_resource_templates | 1 | 29 | 0 | 0 | 0 |
| verify | list_mcp_resources | 1 | 238 | 0 | 0 | 0 |
| verify | read | 4,074 | 13,183,330 | 12 | 212 | 2,330,246 |
| verify-broad | aft_search | 219 | 400,628 | 0 | 0 | 0 |
| verify-broad | aft_zoom | 12 | 51,396 | 0 | 0 | 0 |
| verify-broad | glob | 61 | 15,137 | 0 | 0 | 0 |
| verify-broad | grep | 1,254 | 733,462 | 4 | 0 | 0 |
| verify-broad | read | 1,363 | 4,863,985 | 0 | 126 | 1,461,723 |

### D. Tokens per useful unit: matched positive-output subset
All four invocation token columns are included; reasoning is not available there. Ratios are rounded, not full-population estimates. Counts are invocations with positive attributable output. Missing tasks/models have no defensible positive matched denominator, not free work.

| Host | Task | Model | Matched runs | Useful units | Tokens/unit |
| --- | --- | --- | --- | --- | --- |
| OC | classify-memories | G | 99 | 1516 | 768 |
| OC | classify-memories | D0 | 1 | 25 | 1,812 |
| OC | classify-memories | D | 9 | 154 | 1,680 |
| OC | classify-memories | M | 18 | 219 | 737 |
| OC | historian | G | 369 | 440 | 95,558 |
| OC | historian | F | 3 | 14 | 34,970 |
| OC | historian | O55 | 5 | 12 | 62,818 |
| OC | historian | D | 49 | 263 | 17,988 |
| OC | historian | M | 114 | 462 | 16,355 |
| OC | map-memories | G | 93 | 1563 | 95,659 |
| OC | map-memories | D0 | 11 | 69 | 158,761 |
| OC | map-memories | D | 11 | 285 | 84,928 |
| OC | map-memories | M | 22 | 233 | 40,154 |
| OC | review-user-memories | G | 12 | 85 | 1,100 |
| OC | review-user-memories | D | 3 | 13 | 3,143 |
| OC | verify | G | 47 | 616 | 114,728 |
| OC | verify | D0 | 7 | 105 | 107,347 |
| OC | verify | D | 6 | 80 | 122,229 |
| OC | verify | M | 17 | 202 | 51,627 |
| OC | verify-broad | G | 16 | 290 | 113,184 |
| OC | verify-broad | D | 4 | 48 | 56,450 |
| PI | historian | G | 196 | 211 | 715,649 |

For context, scheduler progress across all in-window task rows reports verify: 8,055 verified + 84 updated + 83 archived, 348 skipped, 4 refused (237 progress-bearing results); verify-broad: 2,576 verified + 15 updated + 9 archived, 118 skipped (41 results). These larger scheduler denominators were **not** divided into the selectively joined invocation costs. Backlog reduction alone undercounts re-verification and is unsuitable for these tasks.

### E. Rust/Broca export cohort (separate, not added to A/B)
All exports carry harness `opencode`; execution is Broca/Rust regardless of that host label. Run count is distinct run_id after summing segments. Missing optional token fields contribute zero *reported* tokens, not proof of no cache use. WAL completed-step count is authoritative here: all successful runs have one, failed runs zero. No selected terminal is max_steps. First prompt equals the sole successful step input shape; there is no within-run prompt-growth series. Cross-run cache hits are not within-run prefix rereads.

| Task | Host | Model | Runs | Terminals | Completed steps med/p90/max | Wall s med/p90/max | Input med/p90/max | Cache read med/p90/max | Cache write med/p90/max | Output med/p90/max | Reasoning med/p90/max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| classify-memories | opencode | G | 87 | completed=87 (100.0%) | 1 / 1 / 1 | 10.6 / 25.8 / 36.6 | 9,551 / 20,337 / 27,849 | 0 / 4,080 / 16,355 | 0 / 0 / 0 | 3,500 / 11,839 / 16,715 | 3,140 / 9,394 / 14,220 |
| classify-memories | opencode | D0 | 58 | completed=49 (84.5%); error=9 (15.5%) | 1 / 1 / 1 | 12.6 / 29.3 / 932.4 | 16,572 / 29,788 / 41,528 | 0 / 8,192 / 24,828 | 0 / 0 / 0 | 2,201 / 6,171 / 32,000 | 0 / 0 / 0 |
| classify-memories | opencode | M | 58 | error=58 (100.0%) | 0 / 0 / 0 | 1.1 / 2.9 / 3.3 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| historian | opencode | O | 182 | completed=13 (7.1%); error=169 (92.9%) | 0 / 0 / 1 | 1.3 / 2.8 / 116 | 0 / 0 / 75,971 | 0 / 0 / 15,541 | 0 / 0 / 0 | 0 / 0 / 4,386 | 0 / 0 / 0 |
| historian | opencode | G | 575 | completed=575 (100.0%) | 1 / 1 / 1 | 26.4 / 40.8 / 95.5 | 78,191 / 117,619 / 137,420 | 0 / 0 / 85,982 | 0 / 0 / 0 | 7,426 / 12,284 / 31,996 | 5,885 / 10,254 / 30,717 |
| historian | opencode | D | 24 | completed=23 (95.8%); error=1 (4.2%) | 1 / 1 / 1 | 24.5 / 53.7 / 90.1 | 71,436 / 117,039 / 130,538 | 6,656 / 14,080 / 14,080 | 0 / 0 / 0 | 4,665 / 13,612 / 21,900 | 0 / 0 / 0 |
| historian | opencode | M | 163 | error=163 (100.0%) | 0 / 0 / 0 | 0.8 / 3.1 / 5.2 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |

No other requested dreamer task prefix was found in this Broca export cohort. Historian IDs are `mc-historian:<module>:<identity>:<ordinal>`; classify IDs are `mc-dreamer:classify:<hash>`, derived from project/command/attempt nonce (`crates/mc-module/src/classify.rs:150–163`). There is no safe direct join from the hash to a host invocation ID. Accordingly, no per-compartment or per-memory ratio is claimed for this separate cohort.

### F. Structured scheduler failure kinds (different denominator)
These are actual dream_runs task-result failure classes. They can outnumber invocation failures because some failures occur outside a recorded child; never add them to A. Unknown is preserved.

| Task | Failure kind | Task-result count |
| --- | --- | --- |
| classify-memories | child_aborted | 57 |
| classify-memories | empty_completion | 12 |
| classify-memories | provider_error | 59 |
| classify-memories | unknown | 71 |
| compress-cues | child_aborted | 15 |
| compress-cues | unknown | 99 |
| curate | empty_completion | 1 |
| curate | provider_error | 33 |
| curate | unknown | 12 |
| evaluate-smart-notes | unknown | 35 |
| maintain-docs | child_aborted | 25 |
| maintain-docs | empty_completion | 8 |
| maintain-docs | provider_error | 63 |
| maintain-docs | unknown | 1 |
| map-memories | child_aborted | 47 |
| map-memories | unknown | 179 |
| retrospective | child_aborted | 12 |
| retrospective | empty_completion | 5 |
| retrospective | provider_error | 52 |
| retrospective | unknown | 6 |
| verify | child_aborted | 55 |
| verify | empty_completion | 54 |
| verify | provider_error | 125 |
| verify | provider_timeout | 72 |
| verify | unknown | 2 |
| verify-broad | empty_completion | 3 |
| verify-broad | provider_error | 26 |
| verify-broad | provider_timeout | 33 |

### G. Five largest invocation-ledger entries
Ranked by input + cache read + cache write + output, not dollars. These are whole recorded invocations, not necessarily single children.

| Invocation | Host / task / model | UTC start | Wall s | Input | Cache read | Output | Status | Surviving linked children |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 17577 | opencode / curate / D | 2026-09-20T01:58:25+00:00 | 603.3 | 840,937 | 21,098,966 | 40,643 | completed | Unavailable |
| 16170 | pi / verify / G | 2026-09-15T00:23:46+00:00 | 546 | 1,277,143 | 18,339,944 | 46,162 | completed | Unavailable |
| 16687 | pi / historian / G | 2026-09-17T11:29:27+00:00 | 250.3 | 714,327 | 7,642,955 | 27,968 | completed | Unavailable |
| 18227 | opencode / verify / D | 2026-09-23T02:06:53+00:00 | 265 | 181,296 | 8,050,816 | 41,251 | completed | ses_f33fbf109ffeLrzikZHwefl208 |
| 17354 | pi / historian / G | 2026-09-19T13:40:47+00:00 | 212 | 1,036,084 | 7,165,387 | 22,195 | completed | Unavailable |

17577: 603s curate, 159-memory category; 148 recorded operations include reads (59 get, 9 list), and five unsafe mutations were refused. No transcript: neither prompt trajectory nor terminal cap can be reconstructed. 16170: 546s Pi verify; --no-session prevents step reconstruction. 16687 and 17354: Pi historians each produced one compartment; 250s and 212s respectively, but no per-step/tool evidence survives. 18227: directly reconstructed below. These missing traces are the principal limit on finding the globally largest waste, not a reason to extrapolate retained OpenCode behavior to Pi.

### H. Five most expensive retained children, every usage-bearing step
Ranked by their summed four comparable usage fields, not all invocations. “Step” is the assistant-record proxy described above. I = uncached input; R = cache read; O = output; Q = separately recorded reasoning; P = I + R + cache write. **Cache write is zero at every listed step.** Tool cells contain only tool names, counts and aggregate output characters; no raw results. A dash means no tool output attached to that usage-bearing record. Output-only startup records remain visible rather than being misrepresented as a zero-token first prompt.

#### ses_f33fbf109ffeLrzikZHwefl208 — verify, D, invocation 18227

61 usage-bearing records; total I/R/W/O/Q = 181,296 / 8,050,816 / 0 / 41,251 / 0. First positive prompt 13,772; final 178,015; net growth 164,243. Cache read is 97.8% of input volume.

| Step | Model | I | R | O | Q | P | Tool outputs (count × total chars) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G | 0 | 0 | 46 | 0 | 0 | — |
| 2 | D | 13,772 | 0 | 1,073 | 0 | 13,772 | read 4× / 114,656 chars |
| 3 | D | 33,190 | 13,696 | 1,503 | 0 | 46,886 | read 4× / 23,043 chars |
| 4 | D | 6,631 | 46,848 | 1,043 | 0 | 53,479 | read 3× / 109,435 chars |
| 5 | D | 30,681 | 53,376 | 1,802 | 0 | 84,057 | read 2× / 96,090 chars |
| 6 | D | 26,867 | 83,968 | 267 | 0 | 110,835 | grep 2× / 1,114 chars |
| 7 | D | 597 | 110,720 | 183 | 0 | 111,317 | aft_search 1× / 1,692 chars; grep 1× / 526 chars |
| 8 | D | 875 | 111,232 | 104 | 0 | 112,107 | read 1× / 9,204 chars |
| 9 | D | 2,789 | 112,000 | 138 | 0 | 114,789 | grep 2× / 1,183 chars |
| 10 | D | 552 | 114,688 | 110 | 0 | 115,240 | read 1× / 8,351 chars |
| 11 | D | 2,451 | 115,200 | 98 | 0 | 117,651 | grep 1× / 433 chars |
| 12 | D | 229 | 117,632 | 85 | 0 | 117,861 | read 1× / 9,218 chars |
| 13 | D | 2,736 | 117,888 | 307 | 0 | 120,624 | grep 2× / 927 chars |
| 14 | D | 531 | 120,576 | 291 | 0 | 121,107 | grep 2× / 1,122 chars |
| 15 | D | 474 | 121,088 | 85 | 0 | 121,562 | read 1× / 7,607 chars |
| 16 | D | 2,088 | 121,600 | 215 | 0 | 123,688 | grep 2× / 1,026 chars |
| 17 | D | 499 | 123,648 | 188 | 0 | 124,147 | grep 2× / 1,108 chars |
| 18 | D | 566 | 124,032 | 454 | 0 | 124,598 | grep 1× / 403 chars; read 1× / 4,467 chars |
| 19 | D | 1,600 | 124,544 | 3,277 | 0 | 126,144 | grep 4× / 2,061 chars |
| 20 | D | 950 | 126,080 | 2,123 | 0 | 127,030 | grep 4× / 1,649 chars |
| 21 | D | 810 | 126,976 | 248 | 0 | 127,786 | read 1× / 4,679 chars |
| 22 | D | 1,360 | 127,744 | 303 | 0 | 129,104 | grep 2× / 493 chars |
| 23 | D | 396 | 129,024 | 2,637 | 0 | 129,420 | grep 4× / 2,165 chars |
| 24 | D | 939 | 129,408 | 256 | 0 | 130,347 | grep 2× / 456 chars; read 1× / 4,157 chars |
| 25 | D | 1,467 | 130,304 | 153 | 0 | 131,771 | grep 2× / 1,491 chars |
| 26 | D | 548 | 131,712 | 254 | 0 | 132,260 | grep 2× / 770 chars; read 1× / 3,517 chars |
| 27 | D | 1,332 | 132,224 | 449 | 0 | 133,556 | grep 1× / 556 chars; read 1× / 5,703 chars |
| 28 | D | 1,767 | 133,504 | 814 | 0 | 135,271 | grep 4× / 1,941 chars |
| 29 | D | 966 | 135,168 | 314 | 0 | 136,134 | grep 4× / 1,045 chars |
| 30 | D | 710 | 136,064 | 241 | 0 | 136,774 | grep 3× / 1,775 chars |
| 31 | D | 772 | 136,704 | 214 | 0 | 137,476 | grep 1× / 470 chars; read 1× / 2,211 chars |
| 32 | D | 984 | 137,472 | 273 | 0 | 138,456 | grep 3× / 413 chars |
| 33 | D | 458 | 138,368 | 80 | 0 | 138,826 | grep 1× / 572 chars |
| 34 | D | 190 | 138,880 | 51 | 0 | 139,070 | read 1× / 33,772 chars |
| 35 | D | 8,874 | 139,008 | 219 | 0 | 147,882 | grep 2× / 618 chars |
| 36 | D | 374 | 147,840 | 180 | 0 | 148,214 | aft_search 1× / 1,627 chars; grep 1× / 27 chars |
| 37 | D | 669 | 148,096 | 249 | 0 | 148,765 | grep 2× / 610 chars |
| 38 | D | 330 | 148,736 | 132 | 0 | 149,066 | grep 1× / 640 chars |
| 39 | D | 334 | 148,992 | 196 | 0 | 149,326 | grep 2× / 1,102 chars |
| 40 | D | 580 | 149,248 | 173 | 0 | 149,828 | read 1× / 6,073 chars |
| 41 | D | 1,738 | 149,760 | 166 | 0 | 151,498 | grep 2× / 921 chars |
| 42 | D | 484 | 151,424 | 217 | 0 | 151,908 | read 1× / 6,851 chars |
| 43 | D | 1,664 | 151,808 | 386 | 0 | 153,472 | grep 2× / 1,058 chars; read 1× / 3,286 chars |
| 44 | D | 1,432 | 153,472 | 614 | 0 | 154,904 | grep 3× / 1,547 chars; read 1× / 3,284 chars |
| 45 | D | 1,680 | 154,880 | 872 | 0 | 156,560 | grep 4× / 1,642 chars |
| 46 | D | 818 | 156,544 | 2,156 | 0 | 157,362 | grep 4× / 7,161 chars |
| 47 | D | 2,486 | 157,312 | 2,693 | 0 | 159,798 | grep 2× / 1,070 chars; read 1× / 7,573 chars |
| 48 | D | 2,329 | 159,744 | 232 | 0 | 162,073 | grep 1× / 1,012 chars; read 1× / 5,101 chars |
| 49 | D | 1,769 | 162,048 | 278 | 0 | 163,817 | grep 2× / 4,650 chars; read 1× / 6,226 chars |
| 50 | D | 3,401 | 163,712 | 833 | 0 | 167,113 | grep 4× / 1,309 chars |
| 51 | D | 757 | 167,040 | 319 | 0 | 167,797 | grep 3× / 2,567 chars |
| 52 | D | 1,084 | 167,680 | 305 | 0 | 168,764 | grep 1× / 595 chars; read 1× / 3,081 chars |
| 53 | D | 1,085 | 168,704 | 116 | 0 | 169,789 | grep 1× / 1,389 chars |
| 54 | D | 537 | 169,728 | 425 | 0 | 170,265 | grep 1× / 498 chars; read 1× / 4,957 chars |
| 55 | D | 1,730 | 170,240 | 143 | 0 | 171,970 | grep 1× / 1,560 chars |
| 56 | D | 621 | 171,904 | 184 | 0 | 172,525 | grep 2× / 400 chars |
| 57 | D | 408 | 172,416 | 89 | 0 | 172,824 | read 1× / 5,690 chars |
| 58 | D | 1,670 | 172,800 | 170 | 0 | 174,470 | grep 1× / 903 chars |
| 59 | D | 362 | 174,464 | 212 | 0 | 174,826 | grep 2× / 3,902 chars |
| 60 | D | 1,416 | 174,720 | 359 | 0 | 176,136 | grep 1× / 585 chars; read 1× / 4,658 chars |
| 61 | D | 1,887 | 176,128 | 9,654 | 0 | 178,015 | — |

#### ses_f33c15088ffekZ93yzvb8F4UbZ — verify, D, invocation 18303

61 usage-bearing records; total I/R/W/O/Q = 186,217 / 7,251,616 / 0 / 71,061 / 0. First positive prompt 14,596; final 178,594; net growth 163,998. Cache read is 97.5% of input volume.

| Step | Model | I | R | O | Q | P | Tool outputs (count × total chars) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G | 0 | 0 | 46 | 0 | 0 | — |
| 2 | D | 14,580 | 16 | 133 | 0 | 14,596 | aft_outline 2× / 41,543 chars |
| 3 | D | 13,619 | 14,466 | 1,619 | 0 | 28,085 | aft_outline 6× / 12,818 chars |
| 4 | D | 4,732 | 27,956 | 330 | 0 | 32,688 | read 4× / 26,422 chars |
| 5 | D | 7,375 | 32,558 | 437 | 0 | 39,933 | read 3× / 16,969 chars |
| 6 | D | 4,718 | 39,804 | 220 | 0 | 44,522 | read 1× / 25,953 chars |
| 7 | D | 6,267 | 44,392 | 607 | 0 | 50,659 | read 4× / 24,843 chars |
| 8 | D | 6,830 | 50,530 | 215 | 0 | 57,360 | read 2× / 30,627 chars |
| 9 | D | 7,869 | 57,230 | 1,114 | 0 | 65,099 | grep 1× / 576 chars; read 3× / 6,679 chars |
| 10 | D | 2,399 | 64,970 | 206 | 0 | 67,369 | read 2× / 18,148 chars |
| 11 | D | 5,268 | 67,240 | 226 | 0 | 72,508 | read 2× / 17,272 chars |
| 12 | D | 4,750 | 72,378 | 219 | 0 | 77,128 | grep 2× / 1,008 chars |
| 13 | D | 583 | 76,998 | 121 | 0 | 77,581 | grep 2× / 267 chars |
| 14 | D | 348 | 77,452 | 240 | 0 | 77,800 | read 3× / 14,418 chars |
| 15 | D | 3,693 | 77,670 | 205 | 0 | 81,363 | read 2× / 25,858 chars |
| 16 | D | 6,435 | 81,234 | 818 | 0 | 87,669 | read 2× / 11,978 chars |
| 17 | D | 3,333 | 87,540 | 391 | 0 | 90,873 | aft_outline 1× / 4,972 chars; grep 1× / 374 chars; read 1× / 3,062 chars |
| 18 | D | 2,897 | 90,744 | 382 | 0 | 93,641 | read 3× / 10,252 chars |
| 19 | D | 3,249 | 93,512 | 759 | 0 | 96,761 | read 1× / 16,805 chars |
| 20 | D | 4,578 | 96,632 | 673 | 0 | 101,210 | read 3× / 24,535 chars |
| 21 | D | 6,434 | 101,080 | 264 | 0 | 107,514 | grep 2× / 972 chars; read 1× / 6,146 chars |
| 22 | D | 2,332 | 107,384 | 387 | 0 | 109,716 | read 3× / 12,162 chars |
| 23 | D | 3,861 | 109,586 | 304 | 0 | 113,447 | grep 2× / 1,014 chars |
| 24 | D | 617 | 113,318 | 468 | 0 | 113,935 | grep 1× / 753 chars; read 1× / 3,020 chars |
| 25 | D | 1,293 | 113,806 | 575 | 0 | 115,099 | grep 1× / 460 chars; read 2× / 16,673 chars |
| 26 | D | 4,636 | 114,970 | 795 | 0 | 119,606 | read 3× / 37,647 chars |
| 27 | D | 10,223 | 119,476 | 5,983 | 0 | 129,699 | grep 3× / 1,719 chars; read 1× / 5,987 chars |
| 28 | D | 2,464 | 129,570 | 242 | 0 | 132,034 | read 3× / 12,485 chars |
| 29 | D | 3,804 | 131,904 | 5,387 | 0 | 135,708 | grep 3× / 4,872 chars; read 1× / 1,695 chars |
| 30 | D | 2,264 | 135,578 | 5,440 | 0 | 137,842 | grep 2× / 965 chars; read 2× / 8,826 chars |
| 31 | D | 3,013 | 137,712 | 515 | 0 | 140,725 | glob 1× / 600 chars; grep 2× / 1,320 chars |
| 32 | D | 820 | 140,596 | 249 | 0 | 141,416 | grep 1× / 2,636 chars; read 1× / 6,560 chars |
| 33 | D | 2,808 | 141,286 | 218 | 0 | 144,094 | grep 2× / 5,933 chars |
| 34 | D | 1,887 | 143,964 | 125 | 0 | 145,851 | read 1× / 5,396 chars |
| 35 | D | 1,430 | 145,722 | 243 | 0 | 147,152 | grep 2× / 3,864 chars |
| 36 | D | 1,321 | 147,022 | 276 | 0 | 148,343 | grep 2× / 230 chars |
| 37 | D | 404 | 148,214 | 243 | 0 | 148,618 | grep 1× / 5,677 chars; read 1× / 2,866 chars |
| 38 | D | 2,501 | 148,488 | 277 | 0 | 150,989 | grep 2× / 5,990 chars |
| 39 | D | 1,865 | 150,860 | 1,576 | 0 | 152,725 | grep 1× / 545 chars; read 2× / 4,999 chars |
| 40 | D | 1,923 | 152,596 | 173 | 0 | 154,519 | grep 1× / 392 chars; read 1× / 3,022 chars |
| 41 | D | 1,281 | 154,390 | 303 | 0 | 155,671 | grep 3× / 3,671 chars |
| 42 | D | 1,359 | 155,542 | 394 | 0 | 156,901 | aft_search 1× / 1,589 chars; grep 1× / 477 chars |
| 43 | D | 835 | 156,772 | 415 | 0 | 157,607 | grep 1× / 2,185 chars |
| 44 | D | 782 | 157,478 | 700 | 0 | 158,260 | grep 3× / 594 chars |
| 45 | D | 502 | 158,130 | 627 | 0 | 158,632 | grep 2× / 2,024 chars |
| 46 | D | 852 | 158,502 | 474 | 0 | 159,354 | grep 2× / 797 chars; read 1× / 2,624 chars |
| 47 | D | 1,401 | 159,224 | 361 | 0 | 160,625 | bash 1× / 0 chars; grep 1× / 3,374 chars |
| 48 | D | 1,282 | 160,496 | 757 | 0 | 161,778 | aft_search 1× / 2,216 chars; grep 2× / 1,427 chars |
| 49 | D | 1,289 | 161,648 | 5,863 | 0 | 162,937 | grep 3× / 1,061 chars; read 1× / 5,115 chars |
| 50 | D | 2,158 | 162,808 | 162 | 0 | 164,966 | grep 2× / 1,140 chars |
| 51 | D | 627 | 164,836 | 179 | 0 | 165,463 | read 1× / 10,603 chars |
| 52 | D | 3,165 | 165,334 | 301 | 0 | 168,499 | grep 3× / 1,111 chars |
| 53 | D | 676 | 168,370 | 176 | 0 | 169,046 | grep 1× / 475 chars; read 1× / 3,293 chars |
| 54 | D | 1,297 | 168,916 | 218 | 0 | 170,213 | read 1× / 3,230 chars |
| 55 | D | 1,078 | 170,084 | 8,029 | 0 | 171,162 | grep 3× / 574 chars |
| 56 | D | 520 | 171,032 | 644 | 0 | 171,552 | grep 2× / 2,850 chars; read 1× / 3,867 chars |
| 57 | D | 2,035 | 171,422 | 383 | 0 | 173,457 | grep 2× / 2,651 chars |
| 58 | D | 1,030 | 173,328 | 9,227 | 0 | 174,358 | grep 3× / 1,217 chars; read 1× / 4,261 chars |
| 59 | D | 1,879 | 174,228 | 255 | 0 | 176,107 | grep 1× / 785 chars; read 1× / 1,287 chars |
| 60 | D | 796 | 175,978 | 3,203 | 0 | 176,774 | grep 2× / 5,583 chars |
| 61 | D | 1,950 | 176,644 | 5,689 | 0 | 178,594 | — |

#### ses_f2eeb9eceffeK85tNVpwAGAWRG — maintain-docs, G, invocation 18564

68 usage-bearing records; total I/R/W/O/Q = 890,814 / 6,525,365 / 0 / 14,560 / 27,496. First positive prompt 8,162; final 182,656; net growth 174,494. Cache read is 88.0% of input volume.

| Step | Model | I | R | O | Q | P | Tool outputs (count × total chars) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G | 8,162 | 0 | 78 | 235 | 8,162 | bash 1× / 16,423 chars; read 2× / 101,689 chars |
| 2 | G | 40,095 | 0 | 60 | 54 | 40,095 | read 2× / 36,225 chars |
| 3 | G | 12,481 | 36,764 | 50 | 175 | 49,245 | bash 1× / 16,408 chars |
| 4 | G | 6,047 | 49,024 | 46 | 87 | 55,071 | bash 1× / 16,405 chars |
| 5 | G | 6,897 | 53,112 | 50 | 80 | 60,009 | bash 1× / 748 chars |
| 6 | G | 3,202 | 57,189 | 18 | 120 | 60,391 | bash 1× / 41 chars |
| 7 | G | 3,401 | 57,180 | 29 | 26 | 60,581 | bash 1× / 4 chars |
| 8 | G | 3,486 | 57,171 | 29 | 44 | 60,657 | bash 1× / 14,366 chars |
| 9 | G | 8,943 | 57,177 | 36 | 94 | 66,120 | bash 1× / 107 chars |
| 10 | G | 5,049 | 61,252 | 30 | 44 | 66,301 | bash 1× / 10,437 chars |
| 11 | G | 3,559 | 65,334 | 44 | 95 | 68,893 | aft_search 1× / 7,429 chars |
| 12 | G | 71,024 | 0 | 44 | 44 | 71,024 | aft_search 1× / 1,053 chars |
| 13 | G | 2,074 | 69,405 | 38 | 244 | 71,479 | aft_search 1× / 1,895 chars |
| 14 | G | 2,920 | 69,398 | 41 | 42 | 72,318 | read 1× / 11,653 chars |
| 15 | G | 6,499 | 69,400 | 40 | 35 | 75,899 | aft_search 1× / 1,259 chars |
| 16 | G | 2,946 | 73,475 | 30 | 25 | 76,421 | aft_outline 1× / 1,671 chars |
| 17 | G | 3,672 | 73,467 | 41 | 39 | 77,139 | read 1× / 9,796 chars |
| 18 | G | 6,753 | 73,468 | 34 | 419 | 80,221 | aft_search 1× / 1,267 chars |
| 19 | G | 3,553 | 77,606 | 44 | 38 | 81,159 | read 1× / 28,387 chars |
| 20 | G | 10,772 | 77,615 | 46 | 40 | 88,387 | read 1× / 30,034 chars |
| 21 | G | 10,117 | 85,795 | 45 | 53 | 95,912 | read 1× / 6,116 chars |
| 22 | G | 3,984 | 93,961 | 27 | 2,089 | 97,945 | glob 1× / 228 chars |
| 23 | G | 6,221 | 94,288 | 23 | 17 | 100,509 | bash 1× / 1,683 chars |
| 24 | G | 2,745 | 98,377 | 31 | 435 | 101,122 | glob 1× / 166 chars |
| 25 | G | 3,293 | 98,434 | 30 | 26 | 101,727 | glob 1× / 195 chars |
| 26 | G | 101,870 | 0 | 26 | 28 | 101,870 | bash 1× / 1,463 chars |
| 27 | G | 4,072 | 98,414 | 41 | 80 | 102,486 | read 1× / 2,283 chars |
| 28 | G | 4,928 | 98,403 | 38 | 120 | 103,331 | read 1× / 2,250 chars |
| 29 | G | 5,758 | 98,393 | 42 | 27 | 104,151 | read 1× / 2,565 chars |
| 30 | G | 2,553 | 102,482 | 39 | 25 | 105,035 | read 1× / 3,284 chars |
| 31 | G | 3,693 | 102,472 | 37 | 41 | 106,165 | read 1× / 2,065 chars |
| 32 | G | 4,554 | 102,462 | 39 | 24 | 107,016 | read 1× / 1,506 chars |
| 33 | G | 107,650 | 0 | 36 | 39 | 107,650 | read 1× / 1,850 chars |
| 34 | G | 5,849 | 102,442 | 37 | 22 | 108,291 | read 1× / 748 chars |
| 35 | G | 2,068 | 106,530 | 37 | 21 | 108,598 | read 1× / 1,871 chars |
| 36 | G | 2,749 | 106,520 | 35 | 35 | 109,269 | read 1× / 1,477 chars |
| 37 | G | 3,355 | 106,510 | 35 | 19 | 109,865 | read 1× / 1,346 chars |
| 38 | G | 3,905 | 106,500 | 28 | 1,340 | 110,405 | read 1× / 17,950 chars |
| 39 | G | 9,533 | 106,604 | 43 | 182 | 116,137 | aft_search 1× / 1,248 chars |
| 40 | G | 6,054 | 110,694 | 43 | 21 | 116,748 | aft_zoom 1× / 1,681 chars |
| 41 | G | 117,311 | 0 | 46 | 23 | 117,311 | aft_search 1× / 2,668 chars |
| 42 | G | 118,116 | 0 | 39 | 19 | 118,116 | read 1× / 1,419 chars |
| 43 | G | 3,939 | 114,763 | 29 | 226 | 118,702 | read 1× / 8,905 chars |
| 44 | G | 6,374 | 114,752 | 30 | 299 | 121,126 | read 1× / 5,293 chars |
| 45 | G | 3,828 | 118,897 | 28 | 1,132 | 122,725 | read 1× / 4,995 chars |
| 46 | G | 6,254 | 119,064 | 83 | 101 | 125,318 | bash 1× / 3,339 chars |
| 47 | G | 3,265 | 123,157 | 118 | 442 | 126,422 | bash 1× / 466 chars |
| 48 | G | 20,466 | 106,789 | 109 | 37 | 127,255 | bash 1× / 13,000 chars |
| 49 | G | 7,278 | 123,201 | 54 | 661 | 130,479 | bash 1× / 2,638 chars |
| 50 | G | 4,515 | 127,357 | 128 | 116 | 131,872 | bash 1× / 15,238 chars |
| 51 | G | 4,277 | 131,444 | 54 | 83 | 135,721 | bash 1× / 5,034 chars |
| 52 | G | 5,599 | 131,431 | 32 | 266 | 137,030 | aft_search 1× / 1,954 chars |
| 53 | G | 2,386 | 135,588 | 34 | 45 | 137,974 | aft_search 1× / 2,430 chars |
| 54 | G | 3,243 | 135,576 | 35 | 55 | 138,819 | aft_search 1× / 2,558 chars |
| 55 | G | 4,147 | 135,563 | 35 | 21 | 139,710 | aft_search 1× / 2,619 chars |
| 56 | G | 4,940 | 135,552 | 37 | 30 | 140,492 | bash 1× / 15,712 chars |
| 57 | G | 5,539 | 139,637 | 26 | 3,719 | 145,176 | aft_search 1× / 1,353 chars |
| 58 | G | 5,677 | 144,484 | 26 | 133 | 150,161 | bash 1× / 15 chars |
| 59 | G | 5,872 | 144,473 | 16 | 98 | 150,345 | bash 1× / 611 chars |
| 60 | G | 2,287 | 148,579 | 57 | 2,935 | 150,866 | bash 1× / 3,133 chars |
| 61 | G | 6,001 | 148,996 | 828 | 2,699 | 154,997 | edit 1× / 24 chars |
| 62 | G | 5,484 | 153,712 | 107 | 1,217 | 159,196 | bash 1× / 10,348 chars |
| 63 | G | 5,191 | 157,943 | 346 | 1,253 | 163,134 | bash 1× / 1,269 chars |
| 64 | G | 3,001 | 162,334 | 30 | 141 | 165,335 | aft_search 1× / 1,248 chars |
| 65 | G | 3,577 | 162,315 | 8,972 | 1,435 | 165,892 | edit 1× / 27 chars |
| 66 | G | 14,203 | 162,439 | 28 | 1,783 | 176,642 | read 1× / 960 chars |
| 67 | G | 3,886 | 175,017 | 29 | 379 | 178,903 | read 1× / 10,378 chars |
| 68 | G | 7,672 | 174,984 | 1,664 | 1,524 | 182,656 | — |

#### ses_f1a481b98ffevruFmVmWOi9sJo — verify, G, invocation 19422

61 usage-bearing records; total I/R/W/O/Q = 806,272 / 5,572,190 / 0 / 2,966 / 15,796. First positive prompt 7,127; final 137,583; net growth 130,456. Cache read is 87.4% of input volume.

| Step | Model | I | R | O | Q | P | Tool outputs (count × total chars) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G | 7,127 | 0 | 185 | 2,944 | 7,127 | grep 5× / 2,199 chars |
| 2 | G | 11,547 | 0 | 34 | 82 | 11,547 | read 1× / 51,440 chars |
| 3 | G | 30,149 | 0 | 33 | 325 | 30,149 | grep 1× / 371 chars |
| 4 | G | 30,623 | 0 | 34 | 32 | 30,623 | read 1× / 51,458 chars |
| 5 | G | 19,037 | 28,892 | 31 | 187 | 47,929 | grep 1× / 1,025 chars |
| 6 | G | 3,130 | 45,389 | 34 | 173 | 48,519 | read 1× / 51,463 chars |
| 7 | G | 19,730 | 45,297 | 33 | 44 | 65,027 | grep 1× / 352 chars |
| 8 | G | 3,490 | 61,758 | 33 | 26 | 65,248 | read 1× / 51,443 chars |
| 9 | G | 21,619 | 61,681 | 20 | 511 | 83,300 | aft_search 1× / 2,362 chars |
| 10 | G | 2,310 | 82,288 | 33 | 41 | 84,598 | grep 1× / 491 chars |
| 11 | G | 2,552 | 82,277 | 31 | 28 | 84,829 | grep 1× / 957 chars |
| 12 | G | 85,167 | 0 | 25 | 25 | 85,167 | aft_search 1× / 1,131 chars |
| 13 | G | 85,600 | 0 | 42 | 42 | 85,600 | read 1× / 4,201 chars |
| 14 | G | 4,881 | 82,240 | 23 | 110 | 87,121 | aft_search 1× / 1,304 chars |
| 15 | G | 5,424 | 82,228 | 41 | 27 | 87,652 | grep 1× / 427 chars |
| 16 | G | 5,666 | 82,218 | 39 | 30 | 87,884 | read 1× / 3,608 chars |
| 17 | G | 2,985 | 86,314 | 38 | 88 | 89,299 | read 1× / 5,550 chars |
| 18 | G | 4,711 | 86,299 | 40 | 22 | 91,010 | read 1× / 5,178 chars |
| 19 | G | 2,229 | 90,394 | 40 | 30 | 92,623 | read 1× / 2,800 chars |
| 20 | G | 3,334 | 90,381 | 17 | 48 | 93,715 | aft_search 1× / 2,080 chars |
| 21 | G | 4,012 | 90,369 | 28 | 40 | 94,381 | aft_zoom 1× / 0 chars |
| 22 | G | 4,154 | 90,359 | 32 | 22 | 94,513 | aft_zoom 1× / 51,267 chars |
| 23 | G | 14,789 | 94,423 | 28 | 104 | 109,212 | grep 1× / 27 chars |
| 24 | G | 2,640 | 106,729 | 21 | 22 | 109,369 | grep 1× / 138 chars |
| 25 | G | 2,749 | 106,719 | 33 | 394 | 109,468 | grep 1× / 510 chars |
| 26 | G | 3,368 | 106,794 | 39 | 31 | 110,162 | read 1× / 4,996 chars |
| 27 | G | 4,869 | 106,781 | 39 | 357 | 111,650 | read 1× / 3,010 chars |
| 28 | G | 2,244 | 110,874 | 37 | 374 | 113,118 | read 1× / 1,646 chars |
| 29 | G | 31,932 | 82,163 | 38 | 235 | 114,095 | read 1× / 1,910 chars |
| 30 | G | 4,064 | 110,908 | 43 | 206 | 114,972 | read 1× / 4,162 chars |
| 31 | G | 116,602 | 0 | 36 | 555 | 116,602 | read 1× / 1,766 chars |
| 32 | G | 2,843 | 115,033 | 23 | 62 | 117,876 | grep 1× / 695 chars |
| 33 | G | 3,218 | 115,022 | 38 | 55 | 118,240 | read 1× / 1,862 chars |
| 34 | G | 3,922 | 115,010 | 42 | 358 | 118,932 | grep 1× / 542 chars |
| 35 | G | 4,507 | 114,999 | 36 | 34 | 119,506 | read 1× / 2,577 chars |
| 36 | G | 5,406 | 114,987 | 37 | 25 | 120,393 | read 1× / 2,926 chars |
| 37 | G | 2,268 | 119,082 | 34 | 38 | 121,350 | grep 1× / 121 chars |
| 38 | G | 2,412 | 119,072 | 37 | 29 | 121,484 | read 1× / 1,216 chars |
| 39 | G | 2,895 | 119,061 | 34 | 314 | 121,956 | grep 1× / 200 chars |
| 40 | G | 3,326 | 119,050 | 38 | 27 | 122,376 | grep 1× / 175 chars |
| 41 | G | 3,474 | 119,040 | 36 | 26 | 122,514 | read 1× / 897 chars |
| 42 | G | 3,808 | 119,030 | 36 | 93 | 122,838 | read 1× / 6,432 chars |
| 43 | G | 5,830 | 119,016 | 37 | 262 | 124,846 | read 1× / 3,203 chars |
| 44 | G | 2,927 | 123,108 | 37 | 21 | 126,035 | read 1× / 4,987 chars |
| 45 | G | 4,244 | 123,096 | 43 | 408 | 127,340 | grep 1× / 423 chars |
| 46 | G | 4,855 | 123,121 | 41 | 327 | 127,976 | grep 1× / 465 chars |
| 47 | G | 128,518 | 0 | 44 | 32 | 128,518 | read 1× / 1,959 chars |
| 48 | G | 6,142 | 123,100 | 43 | 600 | 129,242 | grep 1× / 656 chars |
| 49 | G | 2,913 | 127,252 | 32 | 24 | 130,165 | grep 1× / 131 chars |
| 50 | G | 3,044 | 127,242 | 38 | 26 | 130,286 | read 1× / 2,108 chars |
| 51 | G | 3,756 | 127,231 | 34 | 385 | 130,987 | grep 1× / 778 chars |
| 52 | G | 4,427 | 127,220 | 36 | 52 | 131,647 | read 1× / 1,338 chars |
| 53 | G | 4,916 | 127,209 | 35 | 96 | 132,125 | grep 1× / 593 chars |
| 54 | G | 5,275 | 127,199 | 33 | 340 | 132,474 | grep 1× / 27 chars |
| 55 | G | 5,683 | 127,189 | 27 | 19 | 132,872 | grep 1× / 816 chars |
| 56 | G | 6,002 | 127,179 | 39 | 62 | 133,181 | read 1× / 1,601 chars |
| 57 | G | 23,035 | 110,760 | 30 | 314 | 133,795 | grep 1× / 865 chars |
| 58 | G | 3,178 | 131,260 | 39 | 33 | 134,438 | read 1× / 2,252 chars |
| 59 | G | 3,972 | 131,249 | 36 | 251 | 135,221 | grep 1× / 228 chars |
| 60 | G | 4,526 | 131,231 | 38 | 1,225 | 135,757 | read 1× / 1,520 chars |
| 61 | G | 2,216 | 135,367 | 733 | 3,103 | 137,583 | — |

#### ses_f33bcbe6fffeIq02hRUfoJ4pa0 — verify, D, invocation 18310

53 usage-bearing records; total I/R/W/O/Q = 145,914 / 5,943,296 / 0 / 62,454 / 6,227. First positive prompt 13,475; final 129,979; net growth 116,504. Cache read is 97.6% of input volume.

| Step | Model | I | R | O | Q | P | Tool outputs (count × total chars) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | G | 13,475 | 0 | 29 | 6,227 | 13,475 | grep 1× / 1,392 chars |
| 2 | D | 23,137 | 0 | 298 | 0 | 23,137 | read 4× / 56,074 chars |
| 3 | D | 14,718 | 23,040 | 1,697 | 0 | 37,758 | glob 3× / 1,410 chars; grep 1× / 4,549 chars |
| 4 | D | 2,043 | 37,632 | 234 | 0 | 39,675 | aft_search 1× / 3,057 chars; glob 1× / 38 chars; grep 1× / 283 chars |
| 5 | D | 1,175 | 39,552 | 376 | 0 | 40,727 | grep 1× / 2,003 chars; read 2× / 102,891 chars |
| 6 | D | 29,249 | 40,704 | 839 | 0 | 69,953 | read 4× / 124,435 chars |
| 7 | D | 31,566 | 69,888 | 298 | 0 | 101,454 | aft_outline 2× / 14,580 chars; read 2× / 13,140 chars |
| 8 | D | 8,815 | 101,376 | 1,585 | 0 | 110,191 | grep 1× / 273 chars; read 3× / 19,273 chars |
| 9 | D | 5,779 | 110,080 | 550 | 0 | 115,859 | grep 2× / 660 chars; read 1× / 8,468 chars |
| 10 | D | 2,743 | 115,840 | 175 | 0 | 118,583 | grep 1× / 273 chars; read 1× / 13,898 chars |
| 11 | D | 3,880 | 118,528 | 674 | 0 | 122,408 | grep 1× / 0 chars; read 1× / 0 chars |
| 12 | D | 338 | 122,368 | 117 | 0 | 122,706 | read 1× / 0 chars |
| 13 | D | 233 | 122,624 | 159 | 0 | 122,857 | aft_search 1× / 0 chars; glob 1× / 0 chars |
| 14 | D | 336 | 122,752 | 146 | 0 | 123,088 | read 1× / 0 chars |
| 15 | D | 242 | 123,008 | 60 | 0 | 123,250 | bash 1× / 0 chars |
| 16 | D | 214 | 123,136 | 141 | 0 | 123,350 | read 1× / 0 chars |
| 17 | D | 281 | 123,264 | 116 | 0 | 123,545 | aft_search 1× / 0 chars; glob 1× / 0 chars |
| 18 | D | 250 | 123,520 | 145 | 0 | 123,770 | read 1× / 0 chars |
| 19 | D | 283 | 123,648 | 80 | 0 | 123,931 | aft_outline 1× / 0 chars |
| 20 | D | 144 | 123,904 | 75 | 0 | 124,048 | read 1× / 0 chars |
| 21 | D | 132 | 124,032 | 95 | 0 | 124,164 | aft_search 1× / 0 chars |
| 22 | D | 129 | 124,160 | 112 | 0 | 124,289 | grep 1× / 0 chars |
| 23 | D | 135 | 124,288 | 5,341 | 0 | 124,423 | read 1× / 0 chars |
| 24 | D | 170 | 124,416 | 157 | 0 | 124,586 | glob 1× / 0 chars; read 1× / 0 chars |
| 25 | D | 252 | 124,544 | 1,735 | 0 | 124,796 | read 1× / 0 chars |
| 26 | D | 292 | 124,672 | 100 | 0 | 124,964 | read 1× / 0 chars |
| 27 | D | 156 | 124,928 | 154 | 0 | 125,084 | read 1× / 0 chars |
| 28 | D | 178 | 125,056 | 232 | 0 | 125,234 | read 1× / 0 chars |
| 29 | D | 167 | 125,184 | 100 | 0 | 125,351 | read 1× / 0 chars |
| 30 | D | 175 | 125,312 | 109 | 0 | 125,487 | aft_outline 2× / 0 chars |
| 31 | D | 269 | 125,440 | 142 | 0 | 125,709 | read 1× / 0 chars |
| 32 | D | 172 | 125,696 | 112 | 0 | 125,868 | glob 1× / 0 chars |
| 33 | D | 159 | 125,824 | 85 | 0 | 125,983 | read 1× / 0 chars |
| 34 | D | 183 | 125,952 | 96 | 0 | 126,135 | read 1× / 0 chars |
| 35 | D | 171 | 126,080 | 111 | 0 | 126,251 | aft_search 1× / 0 chars |
| 36 | D | 169 | 126,208 | 733 | 0 | 126,377 | read 2× / 0 chars |
| 37 | D | 260 | 126,336 | 62 | 0 | 126,596 | read 1× / 0 chars |
| 38 | D | 133 | 126,592 | 132 | 0 | 126,725 | read 1× / 0 chars |
| 39 | D | 155 | 126,720 | 255 | 0 | 126,875 | read 1× / 0 chars |
| 40 | D | 176 | 126,848 | 111 | 0 | 127,024 | aft_zoom 1× / 0 chars |
| 41 | D | 184 | 126,976 | 127 | 0 | 127,160 | aft_search 1× / 0 chars |
| 42 | D | 186 | 127,104 | 144 | 0 | 127,290 | read 1× / 0 chars |
| 43 | D | 210 | 127,232 | 11,143 | 0 | 127,442 | read 4× / 0 chars |
| 44 | D | 593 | 127,360 | 290 | 0 | 127,953 | read 4× / 0 chars |
| 45 | D | 374 | 128,128 | 127 | 0 | 128,502 | read 1× / 0 chars |
| 46 | D | 269 | 128,384 | 7,718 | 0 | 128,653 | read 3× / 0 chars |
| 47 | D | 368 | 128,640 | 7,563 | 0 | 129,008 | read 1× / 0 chars |
| 48 | D | 264 | 128,896 | 84 | 0 | 129,160 | read 1× / 0 chars |
| 49 | D | 159 | 129,152 | 161 | 0 | 129,311 | glob 1× / 0 chars; read 1× / 0 chars |
| 50 | D | 281 | 129,280 | 130 | 0 | 129,561 | aft_outline 1× / 0 chars |
| 51 | D | 141 | 129,536 | 150 | 0 | 129,677 | read 1× / 0 chars |
| 52 | D | 164 | 129,664 | 137 | 0 | 129,828 | read 1× / 0 chars |
| 53 | D | 187 | 129,792 | 16,912 | 0 | 129,979 | — |


### I. Actual model-record token attribution in retained OpenCode children

Unlike final-model cohorts in A–C, this table attributes each assistant record to its own reported model. It is a **selected retained-child subset**, not an alternative total to add to the ledger. Per-step reasoning remains separate. No comparable Pi per-step attribution survives. Mixed-model children in this sample: 74.

| Task | Record model | Records | Input | Cache read | Cache write | Output | Reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| classify-memories | G | 84 | 731,268 | 0 | 0 | 61,275 | 1,169,826 |
| classify-memories | D | 7 | 152,474 | 0 | 0 | 29,768 | 0 |
| compress-cues | G | 118 | 736,599 | 18,012 | 0 | 46,045 | 2,784,105 |
| compress-cues | D | 13 | 93,662 | 8,880 | 0 | 162,511 | 0 |
| curate | G | 422 | 5,006,712 | 22,709,181 | 0 | 59,108 | 761,284 |
| evaluate-smart-notes | G | 98 | 305,661 | 0 | 0 | 13,473 | 834,601 |
| evaluate-smart-notes | D | 7 | 21,200 | 5,632 | 0 | 1,102 | 0 |
| historian | O | 121 | 1,457,911 | 294,048 | 0 | 227,967 | 0 |
| historian | G | 582 | 29,632,122 | 12,059,132 | 0 | 1,017,138 | 5,619,444 |
| historian | F | 3 | 12 | 0 | 454,567 | 35,005 | 15,632 |
| historian | O55 | 5 | 20 | 0 | 719,789 | 34,013 | 3,932 |
| historian | D | 55 | 3,711,496 | 449,268 | 0 | 1,321,841 | 0 |
| historian | M | 116 | 7,078,903 | 151,393 | 0 | 397,082 | 658,552 |
| historian-rust | G | 220 | 9,139,637 | 16,593,740 | 0 | 124,212 | 1,091,310 |
| maintain-docs | G | 984 | 9,048,597 | 51,515,508 | 0 | 102,730 | 444,937 |
| maintain-docs | D | 13 | 100,685 | 1,159,680 | 0 | 5,373 | 0 |
| map-memories | G | 4599 | 37,421,238 | 129,238,859 | 0 | 188,462 | 2,135,878 |
| map-memories | D | 296 | 1,277,725 | 14,147,548 | 0 | 645,678 | 0 |
| retrospective | G | 308 | 2,217,168 | 1,678,415 | 0 | 7,323 | 244,047 |
| retrospective | D | 9 | 66,445 | 52,516 | 0 | 4,085 | 0 |
| review-user-memories | G | 10 | 60,117 | 0 | 0 | 586 | 25,678 |
| review-user-memories | D | 2 | 21,955 | 0 | 0 | 644 | 0 |
| verify | G | 7205 | 53,190,499 | 231,870,790 | 0 | 444,380 | 2,867,643 |
| verify | D | 595 | 2,226,532 | 48,524,932 | 0 | 800,072 | 0 |
| verify-broad | G | 2315 | 18,172,184 | 87,216,221 | 0 | 150,392 | 899,473 |
| verify-broad | D | 21 | 121,012 | 1,771,008 | 0 | 42,183 | 0 |

## Reading the five retained traces

- **18227 / `ses_f33fbf109ffeLrzikZHwefl208`:** the output-only startup record is followed by a four-read step returning 114,656 chars, then another multi-read step, then three reads including two near the output ceiling. By record 6 the prompt is already 110,835 tokens. The remaining small grep/search calls continue paying for that prefix. Records after the first ten consume **7,469,630 prompt tokens**. This is the clearest example of large early outputs becoming repeated cache reads; it is not evidence that all those later checks were unnecessary.
- **18303 / `ses_f33c15088ffekZ93yzvb8F4UbZ`:** no individual ≥50K-character read, but initial broad outlines (41,543 chars combined), six further outline results, and many medium reads accumulate to a final 178,594-token prompt. Records after the first ten consume **7,037,522 prompt tokens**. Merely banning whole-file reads would miss this case; scope breadth and retained cumulative context matter too.
- **18564 / `ses_f2eeb9eceffeK85tNVpwAGAWRG`:** first record returns two ~50K reads plus 16K bash output. Prompt rises 8,162 → 40,095 → 49,245 in three records. Subsequent bash/read investigation keeps expanding it; after the first ten records, **6,889,547 prompt tokens** remain. Enforce current proposal-only tools, but also bound investigation scope: permissions alone do not shorten legitimate reads.
- **19422 / `ses_f1a481b98ffevruFmVmWOi9sJo`:** alternating small grep and ~51K reads creates large jumps at records 3, 5, 7 and 9. First prompt 7,127 becomes 137,583 at the end; **5,904,395 prompt tokens** occur after the first ten records. This is a good symbol-read A/B candidate because the expansion is visibly localized to early large reads.
- **18310 / `ses_f33bcbe6fffeIq02hRUfoJ4pa0`:** two ~51K reads at record 5, followed by four reads totaling 124,435 chars at record 6, precede a long high-cache prefix plateau. **5,418,398 prompt tokens** occur after the first ten records. Final prompt is 129,979; 97.6% of input volume is cached. The useful experiment is reducing the early evidence footprint, not assuming that cache hit rate alone means efficiency.

These children explain a **mechanism**, not the missing global outliers. For example, the 21M-cache curate run could have a different growth shape; its total is observed but its trace is not.

## Reproduction and next measurement

Run from this repository, with Python 3.9+ and explicit store paths (stdout contains shapes/counts/IDs, not content):

```sh
python3 packages/plugin/scripts/dreamer-token-profile.py \
  --context "$HOME/.local/share/cortexkit/magic-context/context.db" \
  --opencode "$HOME/.local/share/opencode/opencode.db" \
  --opencode2 "$HOME/.local/share/opencode/opencode2.db" \
  --pi "$HOME/.pi/agent/sessions" \
  --broca "$HOME/.local/share/cortexkit/broca/run-index.db" \
  --wal "$HOME/.local/share/cortexkit/broca/wal" \
  --start 2026-09-14T14:27:20Z --end 2026-09-28T14:27:20Z
```

The script opens all DBs in read-only transactions; it does not invoke the application, migrations, providers or model APIs. Live stores can be cleaned up after this report: a later replay may have less historical coverage even with the same cutoff. This is not an atomic snapshot across all databases. Broca framing is validated before consuming records; an incomplete tail is ignored without truncation. Correlation is intentionally conservative, and the report's manually stated scheduler progress totals are separate SQL/shape-analysis checks, not automatically joined into cost denominators.

Before choosing a production token budget, preserve a **content-free** durable record per child/provider attempt: task-run ID, child ID, Broca run ID when present, model, configured cap/deadline/version, true completed step count and terminal reason, all usage fields including reasoning, per-step input/cache/output, tool name + output size, and committed useful-unit counters. Keep failures' partial usage before deleting child sessions. For Pi, collect this from stdout instead of enabling full raw transcript persistence. For docs/curate, distinguish accepted mutations/proposals from list/get calls. This closes the two most serious gaps: expensive missing transcripts and “completed” statuses without an attributable useful-output denominator.

**Recommended first experiment:** map/verify on the same project/backlog with file-grouped batches and bounded symbol reads, holding useful-memory throughput constant. Compare token/unit, cumulative prompt tokens, actual cap terminals, wall time and refusal/skip rates. Follow with docs and curate. Do not make a global batch reduction based only on this selected retained sample, and do not use token volume as a dollar-cost estimate.

## Follow-up: prompt-token guard defaults (2026-09-29)

Tool-loop children now accept `dreamer.tasks.<task>.token_budget` as a positive integer. The budget sums each provider step's reported **input + cache read + cache write**; output/reasoning tokens are deliberately excluded. The guard asks for the normal task result at 80% and hard-stops at 100% or after two refused tool calls. A terminal manifest is still parsed by the existing task validator: valid IDs are banked, omitted IDs stay in the backlog. `token_budget` failures use MC-D11, distinct from the step-cap MC-D10. These are **per child**, not per scheduler run or per task across batches.

| Tool-loop task | Default prompt tokens | Reason for the provisional ceiling |
|---|---:|---|
| map-memories | 1,500,000 | Gemini child median input + cache read ≈2.02M, p90 ≈3.09M; stop before the common expensive 60-turn tail. |
| verify, verify-broad | 1,700,000 | Deeper backing-file reads need slightly more room than map. The report identifies these with map as 69.4% of all tokens. |
| curate | 1,500,000 | Gemini median ≈998K, p90 ≈3.81M; the 150-step allowance and a 21.1M-cache-read outlier call for an earlier cost stop. |
| maintain-docs | 1,600,000 | Gemini median ≈3.05M and p90 ≈5.26M; the proposal can cover only checked claims rather than exhaust the repository. |
| retrospective | 300,000 | Gemini median ≈5K and p90 ≈70K; this ceiling leaves room for exceptional multi-session deepening. |
| refresh-primers | 350,000 | No invocation sample survived; a single read-only primer investigation should need less than a map batch. Recalibrate once step telemetry exists. |

These values are cost ceilings, not claims that every task can complete its entire queue within one child. The source investigation above measures a single machine and mixed providers; check accepted units and skipped IDs before tightening them. OpenCode 2 hidden children lack a pre-tool execution hook: after the soft threshold its executor interrupts the child rather than prompting it to continue with tools enabled. OpenCode 1 uses its session's async generation abort and a second ordinary user turn without changing the agent/tools. Pi uses RPC steer on the same `--no-session` process and a child extension's `tool_call` block; pi-compatible hosts without RPC stop at the soft threshold instead.
