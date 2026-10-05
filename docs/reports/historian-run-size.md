# Why historian runs usually publish one compartment

Investigation only; no runtime, prompt, configuration, or schema changes.
Code reference: `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`.
All dates below are **2026, UTC**. Git commit times are converted to UTC where compared with telemetry.

## Conclusion

**The strongest explanation for the compartment-count swings is the historian
model mix, not a new one-compartment limit.** Gemini Flash usually returns one
logical work arc; the DeepSeek/GLM/Muse interludes return several. This survives
controlling approximately for chunk span and looking within the same sessions.
The model switches explain the Sep 9 rise, the Sep 17 evening fall, and the Sep
22–23 rise followed by the Sep 24 fall better than the candidate Sep 18 commits.

There are two separate phenomena:

1. **Fewer compartments for comparable input spans:** strongly associated with
   returning to Gemini. The prompt encourages grouping by objective and explicitly
   asks for one compartment for entirely tool-only stretches. It does not impose
   one compartment per run or per 100 messages.
2. **Shorter chunks:** real in the recorded OpenCode cohort after Sep 23. The
   eligible raw head, true-raw per-run cap, protected tail, and producer-token
   budget all bound a run independently. Calibration and boundary changes around
   Sep 22–24 can shorten it; the surviving evidence does **not** establish which
   bound was decisive on each historical run. Oct 1 prompt fitting cannot explain
   the onset of a Sep 24 shift.

**A substantial sampling trap:** `historian_runs` does not capture the Rust
publication path. ALF's last row is Sep 18 and AFT's Sep 10, although both continue
publishing compartments through Oct 4. The recent table trend is not a census of
all historian runs. Rust publication batches also usually contain one compartment,
but have smaller *published* spans than the reported TypeScript *input* spans.

Discard-last amplifies some one-compartment outcomes but is not the principal
cause: since Sep 24, **566 of 647 single-compartment successes (87.5%) did not
discard the last compartment**.

## Evidence and isolation

Read-only SQLite connections executed `VACUUM INTO` for copies of
`~/.local/share/cortexkit/magic-context/context.db` and `store.db` in
`$TMPDIR/magic-context/run-size/`. Snapshot writes completed at Oct 4 22:56:53
and 22:57:00 UTC respectively. All SQL used those copies, not the live stores.
No live configuration files were read. Logs were read directly, then copied into
the same temporary directory to freeze the analysis inputs. Copies were deleted
after analysis.

An additional read-only `VACUUM INTO` of `opencode.db` exceeded a 180-second
limit; its incomplete output was never queried and was deleted. No host database
was required for the model attribution below: the context copy already contains
the invocation-to-run foreign key. `opencode2.db` was not copied or queried.

Definitions:

- Recorded runs: `run_kind='incremental'`, `status='success'`,
  `2026-09-01 <= created_at < 2026-10-05`. There are **1,795** such rows.
- Chunk span: `chunk_end_ordinal - chunk_start_ordinal + 1`. This is an ordinal
  distance, not a recount of delivered messages; sparse/retired coordinates and
  harness message shapes matter. It is not the number of tokens the model sees.
- Compartment count: `compartments_produced`, **after** discard-last.
- Model: join `historian_runs.subagent_invocation_id` to
  `subagent_invocations.id`, then `provider_id/model_id`. All 1,795 successes in
  this interval have a resolved model. This measures realized successful models,
  not configured primary models or every attempted fallback.
- Rust batch proxy: group surviving `compartments` by
  `(session_id, harness, created_at)` and exclude `episode_type='filtered-noise'`.
  Rust stamps all compartments in a publication with the same timestamp
  (`crates/mc-module/src/historian.rs:178–211,825–830`). This cannot recover
  discarded output, input chunk length, failed/noop runs, or deleted/rebuilt rows.

The supplied trend is consistent with the daily data, but pooled periods are
weighted by run count; they are not averages of the supplied daily ranges.

### Recorded runs by harness

Each cell is **successes / mean ordinal span / mean compartments / one-compartment % / discard %**.

| Period | OpenCode | Pi |
|---|---|---|
| Sep 1–8 | 226 / 241.5 / 1.42 / 75.2 / 41.6 | 98 / 48.2 / 1.02 / 98.0 / 2.0 |
| Sep 9–15 | 214 / 222.0 / 3.66 / 23.4 / 72.4 | 50 / 55.6 / 1.02 / 98.0 / 8.0 |
| Sep 16–17 | 55 / 234.7 / 3.64 / 27.3 / 69.1 | 58 / 70.2 / 1.00 / 100.0 / 0.0 |
| Sep 18–20 | 159 / 217.3 / 1.17 / 89.3 / 27.0 | 86 / 71.1 / 1.06 / 94.2 / 8.1 |
| Sep 22–23 | 104 / 199.2 / 3.30 / 45.2 / 58.7 | 28 / 212.7 / 1.32 / 75.0 / 42.9 |
| Sep 24–30 | 316 / 125.5 / 1.19 / 90.8 / 18.4 | 13 / 224.0 / 1.08 / 92.3 / 7.7 |
| Oct 1–4 | 273 / 120.6 / 1.20 / 89.7 / 22.0 | 107 / 83.1 / 1.04 / 96.3 / 1.9 |

Sep 21 has only eight recorded successes (six OpenCode, two Pi); it is not a
stable baseline. Pi did **not** exhibit the main Sep 9–17 multi-compartment rise.
Its larger share of runs on Sep 16–17 lowers the combined mean even while the
OpenCode cohort remains at 3.64 compartments/run. Recent OpenCode rows are from
the TypeScript historian runner; `harness='opencode'` itself does not identify
transform mode or distinguish OpenCode 1 from 2.

### Sessions and transform mode

| Name | Session | Mode evidence / last recorded historian run |
|---|---|---|
| ALF | `ses_227ce5788ffeRPA9THoPLOQreO` | Rust/ck-mc completions in retained Sep 23–Oct 4 logs; last `historian_runs` row Sep 18 02:57:35 |
| AFT | `ses_313660571ffeZTsf4koSJwk50Q` | Rust/ck-mc completions in retained Sep 23–Oct 4 logs; last row Sep 10 13:53:26 |
| BROCA | `ses_114f158ccffet7znXAgI7lc3Kp` | TypeScript trigger/transform logs on Oct 4; last row Oct 4 09:30:19 |
| MC | `ses_331acff95fferWZOYF1pG0cjOn` | TypeScript trigger/publication logs on Oct 4; last row Oct 4 21:24:55; max compartment sequence **2169** |

Historic rows do not contain a transform-mode field. The cessation of ALF/AFT
telemetry is evidence of a coverage break, not an exact deployment timestamp.
All four are OpenCode sessions. Pi is a separate cohort, not one of these IDs.
Rust's publish path (`historian.rs:807–907`, `McStore::publish_historian_chunk`)
publishes durable compartments without inserting this TypeScript run ledger;
the TypeScript runner records it through
`packages/plugin/src/features/magic-context/storage-historian-runs.ts`.
Even after B2, 842 retained Rust `Completed(...)` log lines have **zero** matching
success rows within five seconds for the same session.

Recorded session cells below are **n / mean span / mean compartments**:

| Period | ALF | AFT | BROCA | MC |
|---|---|---|---|---|
| Sep 1–8 | 62 / 206.5 / 1.26 | 33 / 215.3 / 1.27 | 7 / 297.4 / 1.29 | 28 / 205.0 / 1.75 |
| Sep 9–15 | 66 / 228.2 / 4.00 | 10 / 253.0 / 1.90 | 28 / 218.3 / 4.57 | 38 / 197.8 / 3.42 |
| Sep 16–17 | 16 / 208.2 / 2.94 | absent | 4 / 222.0 / 4.25 | 9 / 268.0 / 2.11 |
| Sep 18–20 | 3 / 173.7 / 1.33 | absent | 3 / 321.0 / 2.00 | 21 / 213.5 / 1.38 |
| Sep 22–23 | absent | absent | 10 / 220.1 / 3.40 | 23 / 168.1 / 3.35 |
| Sep 24–30 | absent | absent | 42 / 131.6 / 1.00 | 106 / 96.9 / 1.10 |
| Oct 1–4 | absent | absent | 39 / 126.5 / 1.10 | 57 / 94.2 / 1.11 |

For the missing Rust cohort, surviving publication batches show:

| Session / period | Batches | Mean compartments/batch | Single-compartment batches | Mean published ordinal span |
|---|---:|---:|---:|---:|
| ALF Sep 22–23 | 30 | 1.03 | 96.7% | 84.2 |
| ALF Sep 24–30 | 196 | 1.07 | 94.4% | 60.9 |
| ALF Oct 1–4 | 201 | 1.05 | 95.0% | 50.4 |
| AFT Sep 22–23 | 44 | 1.14 | 86.4% | 62.9 |
| AFT Sep 24–30 | 141 | 1.02 | 97.9% | 61.0 |
| AFT Oct 1–4 | 77 | 1.03 | 97.4% | 63.1 |

Sep 22 mode is inferred from the continuing cohort, not observed in retained
dated logs. Do **not** substitute published spans for historian input chunk spans.
The supplied June–August observation that one-compartment batches were already
common remains compatible with this finding; it is not evidence of a recent
universal regression.

## Model mix explains the oscillations

| Period / realized model | n | Mean span | Mean persisted compartments | One-compartment % |
|---|---:|---:|---:|---:|
| Sep 1–8 Gemini 3.7 Flash | 155 | 128.5 | 1.15 | 87.7 |
| Sep 1–8 Gemini 3.8 Flash | 166 | 234.7 | 1.42 | 77.7 |
| Sep 9–15 Gemini 3.8 Flash | 56 | 76.5 | 1.05 | 96.4 |
| Sep 9–15 DeepSeek v4 Flash (`ollama-cloud`) | 22 | 222.5 | 4.05 | 22.7 |
| Sep 9–15 GLM 5.3 Flash (`ollama-cloud`) | 13 | 196.2 | 3.23 | 15.4 |
| Sep 9–15 Muse Spark 1.3 (`opencode`) | 172 | 222.5 | 3.74 | 21.5 |
| Sep 16–17 Gemini 3.8 Flash | 66 | 83.9 | 1.02 | 98.5 |
| Sep 16–17 Muse Spark 1.3 | 47 | 243.4 | 4.06 | 17.0 |
| Sep 18–20 Gemini 3.8 Flash | 245 | 166.0 | 1.13 | 91.0 |
| Sep 22–23 Gemini 3.8 Flash | 76 | 200.6 | 1.36 | 81.6 |
| Sep 22–23 DeepSeek v4.1 Flash (`ollama-cloud`) | 48 | 206.9 | 5.23 | 8.3 |
| Sep 24–30 Gemini 3.8 Flash (all successes) | 329 | 129.4 | 1.19 | 90.9 |
| Oct 1–4 Gemini 3.8 Flash | 361 | 110.1 | 1.06 | 94.5 |
| Oct 1–4 DeepSeek v4.1 Flash (`openrouter`) | 19 | 108.0 | 2.95 | 36.8 |

The last row is especially useful: similar ~100-ordinal chunks still yield
nearly three persisted compartments with another model. Multi-compartment
behavior has not been made impossible by the current code.

**Approximate span control, OpenCode only, Sep 1–Oct 4, spans 150–300:** Gemini
3.8 has n=403, mean span 207.4, **1.29 compartments**, 84.6% single; Muse has
n=163, span 223.7, **3.92 compartments**, 14.7% single; Ollama DeepSeek v4.1 has
n=30, span 213.4, **5.20 compartments**, 0% single. This is observational, not
a randomized replay of identical prompts.

Within-session attribution also agrees: ALF's Gemini 3.8 successes average
1.23 compartments versus Muse's 4.28; BROCA 1.09 versus 4.65; MC 1.22 versus
3.02. AFT's recorded Gemini 3.8 runs average 1.29 versus DeepSeek v4's 2.00.
Retained Rust completion logs name Gemini 3.8 on **825 of 842** completions and
Ollama DeepSeek v4.1 on 17; these are log counts, not joins to the run table.

### When it changed, and the candidate commits

| Shift | Evidence / interpretation |
|---|---|
| Sep 9 rise | First successful Ollama DeepSeek v4 run Sep 9 **11:31:11**; GLM is also present. Muse successes begin Sep 11 **08:05:52**. No historian system-prompt or reference-seed change accompanies the rise. Sep 8 `477c8fc29f` removes TS/Pi turn-boundary holds, and `5f695a295c` fixes Rust filtered-tail false overflow; these affect timing, but the observed model cohorts are the stronger count discriminator. |
| Sep 16–18 fall | OpenCode remains multi-compartment during much of Sep 16–17; the aggregate decline partly reflects more Pi runs. Last successful Muse run is ALF, Sep 17 **18:18:35**, span 247, five compartments, last discarded. Its next recorded success at **20:44:13** uses Gemini 3.8, span 206, one compartment, no discard. |
| Sep 18 fixes | `1f87088365` (08:23:29 UTC) guards dangling publication IDs and changes Rust boundary adoption, not a one-compartment quota. `1c330ea9ef` / merge `a33f12351b` (13:12:51 / 13:15:07 UTC) prevent an oversized connected tool-arc head escape from consuming a chain; pathological components can be split at their largest result boundary, with producer margin 0.03. They can bound oversized chunks, but occur **after** the observed Muse→Gemini fall. |
| Sep 22–24 rebound and fall | Ollama DeepSeek v4.1 successes run Sep 21 **22:07:16** through Sep 23 **12:38:58**; the Sep 22–23 cohort averages 5.23 compartments. Five Opus 5.5 and three Fable 5.1 successes add smaller multi-compartment samples. All recorded successes Sep 24–30 use Gemini 3.8. Separately, OpenCode mean spans fall from 199.2 to 125.5. |
| Size-policy changes Sep 22–24 | `7f01af9222` merges tokenizer phase A on Sep 22: `daab52e32a` calibrates the true-raw protected window and `3532a5b1c7` converts producer source allowances using the larger prose/tool ratio. `b7965a5b3d` (Sep 23) fixes provider/model-generation calibration lookup. `89e7b9e965` keeps OC2 boundaries off host-unserved rows. `b86365f046` (Sep 24) permits pressure-driven historian runs unless projected drops have an actual reclaim ride. These are credible contributors to shorter/earlier eligible slices, not proof of a particular per-run limiting bound. |
| B2 single-store | Merge `5b7e292c1f`, Sep 30; the copied `single_store_state` says migrated at **17:39:24**. The count/span change predates it by days; it did not fill the Rust run-ledger gap. |
| Oct 1 prompt fitting | `a7a6dd8c` (07:23:44 UTC) sizes TS prompts before opening the child; `978ce52c` (08:20:32 UTC) does the Rust equivalent. These are additional constraints, not the origin of the Sep 24 pattern. No `historian prompt fit` trim diagnostics occurred in the retained log inputs analyzed here. |

The repository has no tracked deployed per-user historian/dreamer config history
for these sessions. It would be unjustified to give a config-edit commit as the
time of a model switch. Invocation rows and completion logs establish what ran.
Dreamer task-budget/runner changes do not directly choose historian compartment
count. `360b566272` (Sep 23) samples historian model chains from live project
configuration; `e13135773a` (Sep 25) selects host versus Broca runner by harness,
not number of compartments. Successful output does not identify whether a
configured primary failed first.

## What chooses the chunk, and what starts the run?

These are separate decisions; none counts to 100 messages.

1. **Trigger budget:** `derive-budgets.ts:28–79` derives
   `clamp(0.05 × main_context × execute_threshold_fraction, 5,000, 50,000)`
   (percentage divided by 100).
   It governs commit-cluster/tail-size triggers. The producer chunk budget is
   separately `clamp(0.25 × historian_context, 8,000, 50,000)`; unresolved
   historian context falls back to 128,000 (thus 32,000 chunk tokens).
2. **Raw eligible boundary:** `protected-tail-boundary.ts:236–295,635–759`
   walks backward to retain `N` **true-raw calibrated tokens**. Before clamping,
   `N=0.3 × usable × (1-usage_fraction)`, with floor/ceiling/reserve limits.
   It fences tool arcs, snaps near semantic/user boundaries, retains the live
   user prompt below the force band, and applies a true-raw head cap. The routine
   cap is `min(250k, max(2N, min(0.25×usable,100k)))`; 80% and 95% pressure get
   larger caps. The cap can admit one oversized atomic component. A boundary
   snap does not mean the slice must contain only one semantic objective.
3. **Producer selection:** `compartment-runner-incremental.ts:548–678`
   resolves the protected head and independently calls `readSessionChunk` with
   the fitted producer budget and exclusive `eligibleEndOrdinal`. The formatted
   source uses compact `U:/A:/TC:` blocks rather than full raw tool-result mass.
   `read-session-chunk.ts` pins the connected component when the formatted budget
   crosses; it does not let adjacent completed arcs enlarge that escape forever.
   Calibration converts provider-token allowances to local-token allowances.
4. **Full prompt fit:** `historian-prompt-fit.ts:188–316` accounts for system
   instructions, fixed user blocks, producer input/context cap and output reserve.
   It trims recent references first, then memories, then seeds; only then shrinks
   the requested chunk (minimum fit floor 1,000 local tokens, or the requested
   budget if smaller). An unfit fixed prompt
   backs off rather than spawning repeated doomed children. Pi uses this shared
   fit in `packages/pi-plugin/src/pi-historian-runner.ts:733–814` too.
5. **Rust twins:** `boundary.rs:373–560,778–925` implements the same tail and
   trigger axes; `historian_chunk.rs:1043–1099` performs full-prompt fitting before
   chunk assembly. `historian.rs:1886–1929` enforces the producer window. Rust
   additionally has a minimum narratable-substance admission floor
   (`historian_chunk.rs:1153–1169`), bypassed for emergency/fold-only reclaim.

One concrete counterexample to treating ordinal span as narratable volume:
`magic-context.2026-09-24.log:300` records ALF's oversize admission at 00:35:06:
range **110590–110590**, **413,908 raw chunk tokens**, **19 producer-source
tokens**, requested historian chunk budget **32,000**. One enormous raw message
can collapse to a tiny tool-call summary. The following line records a firing,
and line 303 a Gemini 3.8 completion. This is not a 100-message batching rule.

Trigger precedence in `compartment-trigger.ts:639–792` (Rust:
`boundary.rs:849–924`):

| Reason | Condition |
|---|---|
| `force_band` | Usage ≥ `max(85, execute_threshold+2)`; require a runnable head, retry with a smaller protected tail if necessary. Skip if projected reclaim meets the target **and can actually land**. |
| `commit_clusters` | Enabled, at least three commit clusters by default, formatted eligible tokens ≥ trigger budget. A cluster is a work-phase signal, not a compartment quota. |
| `tail_size` | Formatted TC-chunked tokens ≥ 3× trigger budget, or the bounded scan has more content. This is deliberately **not** the full raw tool-output size. |
| `projected_headroom` | Usage ≥ execute threshold−2; meaningful eligible head; projected drops cannot meet 0.75× execute threshold on an available ride. |

For example, MC's Oct 4 logs show proactive floor **73%**, so execute threshold
75%; a 20:47:23 fire occurs despite projected post-drop usage **6.0%** because
the projection alone is insufficient without a ride. Its 20:15:19 commit-cluster
fire sees five clusters and ~32,802 formatted tokens at 69.9% usage. These are
different timing paths, not a single hard pressure trigger.

### Which reasons are observed now versus mid-September?

The two surviving TS rotations cover only **Oct 4 10:11:50–23:10:19** in the
frozen inputs. They contain **21 commit-cluster, 28 tail-size, six projected-headroom,
zero force-band = 55** firing-decision lines. MC accounts for eight commit-cluster and six
projected-headroom lines. Repeated decisions during admission/budget refusal
are counted separately; these are **not successful-run counts**.

The dated Rust logs retained here start Sep 23 08:15:37 and cover through Oct 4.
They establish model/completion and oversize-admission evidence, but contain no
named trigger-reason lines for a historical frequency table. In current Rust
code the reason is returned in `HistorianDiagnostics`
(`lib.rs:6481–6484,6730–6739`); the firing log at `lib.rs:7065` prints timeout
budgets, not that reason. The copied bounded pass-trace entries also did not
contain historian reasons. **There is no retained mid-September trigger-reason
series to compare.** Inferring reasons from chunk length or successful counts
would manufacture evidence. Code differences above describe capabilities, not
observed mid-September reason frequencies.

## Model choice versus forced discard

`historian-prompt.source.md:13,71–117` says:

- Produce **“one or more”** compartment blocks.
- A compartment is one contiguous arc with a **single objective**; changing
  activity type (design → implementation → tests → docs → release) does not split
  the same objective.
- Distinct objectives, explicit redirection, or a ship-and-pivot require another
  compartment; housekeeping folds into the larger arc.
- An entirely tool-only chunk should produce **“a single compartment”**.
- If the chunk ends mid-topic, leave the unfinished suffix out with
  `<unprocessed_from>`.

There is no target of “one per ~100 messages” and no explicit generic numerical
“prefer fewer” quota. There **is** a semantic bias against over-segmentation,
especially for autonomous tool-heavy work.

The source prompt and generated TS/Rust system prompts have **no September
changes** in their path histories. Before the Oct 4 user-observation wording
change (`7db1244f20`), the source's last change was Jul 25 (`584b5c00f7`);
the boundary directives were already present. Reference-seed corpus path history
has no September change either (source May 31; Rust reference fixture July 2).
The corpus rotates four of 60 examples; rotation can change calibration context
between runs, but is not a new Sep 24 prompt policy.

Discard-last is explicit post-model policy, not another instruction to emit one.
`compartment-runner-incremental.ts:813–841` and
`historian_validate.rs:604–625` discard at most the final compartment when there
are **at least two**, lookahead is at most two ordinals (the healing slack), no completed tool arc
would be split, and emergency/force-keep exceptions do not apply. A lone emitted
compartment is deliberately retained for forward progress. Therefore:

- one persisted + `discarded_last=1` can mean two emitted → one retained;
- one persisted + `discarded_last=0` is not explained by that policy;
- 647/709 recorded successes since Sep 24 are single-compartment, but 566 of
  those have no discard; only 81 single-compartment outcomes have discard.

The noop flood is also a different issue: of **4,427 noops**, **4,422** say
`internal protected-tail drain budget spent` (2,093 OpenCode, 2,329 Pi), and five
say filtered noise skipped. These are runner admissions/reservations, not 4,427
model calls choosing to write zero compartments. There are also 554 failures,
543 Pi failures with no populated failure reason in this ledger.

## What is not settled

- Exact deployed config edit times, primary/fallback chains, historian output
  caps, and dreamer model choices for each session: live configs were excluded,
  and this repository's git history is not their history.
- The exact limiter responsible for the within-Gemini shortening after Sep 23:
  raw-cap calibration, boundary snaps, live-user protection, host-row filtering,
  content density, or changing context/model geometry. There is no historical
  per-run boundary/budget trace covering the shift. Opus 5.5 calibration was
  already matched by the Opus 5 prefix; the Sep 23 Sonnet measurement commit
  `5e00f5c75b` must not be cited as a new Opus 5.5 calibration by itself.
- Rust input-size/discard statistics and all-run model attribution: publication
  batches and log completion totals are useful proxies, not replacement ledger
  rows. Mode history before Sep 23 is not directly logged in the retained files.
- Whether Gemini's coarser segmentation is the *desired* semantic result. Counts
  alone cannot judge whether it correctly merged one objective or flattened
  distinct objectives. A same-chunk, same-prompt cross-model replay would be the
  discriminating experiment; none was run or claimed here.

## Reproduction and verification

`packages/plugin/scripts/historian-run-size/analyze.py` is standard-library-only.
It requires an explicit already-created database copy and optional `--log FILE`
arguments; it never discovers stores or performs migrations. It outputs status,
period/harness, session/model, span-controlled, publication-batch and log coverage
aggregates, including the deliberately approximate failed Rust/run correlation.

```sh
python3 packages/plugin/scripts/historian-run-size/analyze.py --self-test
python3 packages/plugin/scripts/historian-run-size/analyze.py \
  --context-copy "$TMPDIR/magic-context/run-size/context.db" \
  --log /path/to/copied/magic-context.log \
  --log /path/to/copied/magic-context.2026-09-23.log
```

The SQL cohort is:

```sql
SELECT r.*, s.provider_id, s.model_id
FROM historian_runs r
LEFT JOIN subagent_invocations s ON s.id = r.subagent_invocation_id
WHERE r.run_kind = 'incremental' AND r.status = 'success'
  AND r.created_at >= unixepoch('2026-09-01') * 1000
  AND r.created_at < unixepoch('2026-10-05') * 1000;
```

Analysis self-tests cover inclusive spans, independent discard/count measures,
half-open UTC periods, invocation joins/status/recomp filters, unchanged copy
bytes, and distinguishing actual firing/completion lines from non-firing lines.
No provider replay, configuration alteration, runtime build, or live-store write
was part of this investigation.
