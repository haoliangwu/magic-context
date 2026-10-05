# Reasoning resent as input: offline two-step measurement

Investigation only, for the token-budget design in issue 620. Repository base:
`e50e2b52e71d871dcc5afc3ea046a8dacc774bbe`. No product code, configuration,
live session, or credential was changed; no model request was made.

## Bottom line

- **Count roughly one input token per reported reasoning token** on measured
  Anthropic, OpenAI/Codex, OpenRouter DeepSeek and Grok 4.7 routes. OpenCode's
  output convention must be normalized first; the literal proposed formula
  otherwise manufactures a multiplier near two.
- **Antigravity Gemini 3.8 Flash is not a zero-cost exception in these data.**
  Its selected pairs fit **k=1.218**, stable across body/cache tolerances, but only
  75 small-content pairs survive from 21,186 steps. A real example stores the
  thought signature on the **tool**, not the reasoning part. The diff measures
  the replay bundle, not savings from deleting its visible reasoning text alone.
- **Ollama Cloud DeepSeek behaves differently from OpenRouter DeepSeek.** Its
  stored reasoning text has **k=0.004** (41 pairs), consistent with no size-dependent
  text replay; do not assume the two adapters share a policy. GLM 5.3 Flash has
  only **two** small-content text-bearing pairs: no defensible slope.
- **Stored reasoning text is not a universal proxy for reported reasoning.**
  Opus 5.5's text-based slope is 2.096 after existing calibration, versus 1.000
  using reported R. OpenAI summaries are often empty/short despite large R.
- The Pi files **do have `usage.reasoning`** on 3,989 of 4,020 windowed assistants,
  contrary to the initial data description. Use it; empty encrypted summaries
  cannot support a text-only estimate. The named OpenCode 2 store has **no
  assistant steps at all** (two users and two idle records).
- Stable-prefix triples/new-user subsets support persistence of older charged
  reasoning on the well-sampled routes, **conditionally on this filter**. They
  cannot establish an unconditional all-history policy or deletion acceptance.

The final measurement completed at **2026-10-05 11:06:20 UTC** using Bun 1.4.2,
ai-tokenizer 1.0.6 (`tokenizer:43` fingerprint), and the table revision below.

## Acquisition and reproducibility

Analysis code and synthetic accounting/regression tests:
[`packages/plugin/scripts/reasoning-resend-cost/`](../../packages/plugin/scripts/reasoning-resend-cost/).
Commands, including acquisition and cleanup, are in that directory's README.
All shell commands ran under an outer `timeout`; long acquisition/analysis jobs
used background execution, not a foreground polling loop.

The analysis window is **2026-09-27 00:00:00 through 2026-10-04 23:59:59.999 UTC**
(eight complete UTC dates; October 5 assistants are outside the window).
The **corrected** acquisition method reads live OpenCode stores through narrow
**read-only SELECTs**, not whole-store copies. Each store has one read transaction.
Only windowed message IDs/session IDs/timestamps/route IDs/usage are selected;
parts on candidate pairs provide only types, tokenization fields and metadata
lengths. Text needed for MC's tokenizer stays in memory. No credential/account
table is queried. Only numeric counts and identifiers are written to scratch.
No pair crosses the window's start, and older history is not separately inspected.
Pi files were selected by mtime within seven days, copied, and filtered by entry
timestamps after copying; month-old file names do not delimit the window.

Before the acquisition correction arrived, the original `VACUUM INTO` instruction
was attempted. The first attempt hit disk exhaustion and produced an incomplete
snapshot; it was never analyzed. A retry was canceled immediately on correction
and **all its DB/journal outputs were deleted**. The shared data volume then showed
169 GiB free. No unrelated directory was deleted. The final script contains no
whole-store copy/vacuum operation. Private Pi copies and numeric scratch outputs
are deleted after report generation.

### What the harnesses actually recorded

| Harness / inventoried source | Windowed coverage | Recorded accounting / replay evidence |
|---|---|---|
| OpenCode 1, `~/.local/share/opencode/opencode.db` | 251,977 message rows; 227,826 assistant steps across 22 provider/model keys | Route IDs and `tokens.input/output/reasoning/cache.read/cache.write`; tool results are assistant parts. Positive R is separate from O. Ollama routes store R=0 despite reasoning text. |
| Pi, `~/.pi/agent/sessions/*/*.jsonl` | 216 files inventoried; two recently modified files copied (511,131,498 bytes), 4,020 windowed assistants | `input/output/cacheRead/cacheWrite`, **plus reasoning on 3,989 steps**. O includes R. Thinking text and `thinkingSignature` are separate. Measured models are Codex GPT-6.1-sol, GPT-6-sol and GPT-5.6-sol; this is not Pi Anthropic coverage. |
| OpenCode 2, `~/.local/share/opencode/opencode2.db` | Two `user` and two `idle` rows **all time**, zero `assistant` rows | Uses `session_message`, not the v1 part table. No reasoning-bearing steps exist in this named store; no v2 multiplier can be measured. |

Named `opencode*.db` files were enumerated in the standard data directory. This
does not claim exhaustive discovery of arbitrary external XDG/configured or
archived stores. No service registration, config or auth file was read. The two
Pi files are `2026-06-02T15-48-02-003Z_019e8905-3b53-7442-b79f-4ee106474820.jsonl`
and `2026-05-01T16-48-44-508Z_019de471-4fdc-762d-9286-624dfad0b5fe.jsonl`.

## What the two-step calculation measures

For consecutive assistants A and B on the **same provider/model**, let
`T = input + cache.read + cache.write`. The residual is

```text
resent = T(B) - T(A) - visibleOutput(A) - newBody - wrappers
resent ≈ k * reasoning(A) + c
```

**An important correction to the proposed formula:** OpenCode 1's stored
`tokens.output` is **visible/non-reasoning output when reasoning is separately
reported**, not output inclusive of `tokens.reasoning`. Where R=0 despite stored
reasoning text (Ollama Cloud), O may include that unreported reasoning; use
independently tokenized visible parts instead. Pi's usage output is inclusive on
the measured routes.
Therefore `visibleOutput = output` in OpenCode and `output - reasoning` in Pi.
Numerous OpenCode steps have R>O, and independently tokenized visible content
tracks O rather than O-R. Applying the literal formula initially yielded slopes
around **2** for Opus/OpenAI; this is an accounting artifact, not twice-billed
reasoning. The script retains the literal-formula fit as a diagnostic, on the
same observations, and tests the two conventions separately.

Tool results belong to A's tool parts in OpenCode 1, whereas Pi stores separate
`toolResult` messages. Tool arguments are already part of A's visible output and
must not also be subtracted as new content. User messages between A and B count
as new content. Tool/user wrappers are estimated at 12/8 tokens each; the fitted
intercept absorbs fixed serialization mismatch, not arbitrary history edits.

The requested calibration path is absent at this revision. Its real location is
`packages/plugin/src/hooks/magic-context/tokenizer-calibration.ts`; the tokenizer
is `estimateTokens` in `read-session-formatting.ts` (**Claude BPE**). Result bodies
and user text use that tokenizer times the resolved model **proseRatio**. The
calibration table revision is `2026-09-30-sol-tokenizer-seeds-v3`. `toolsRatio` is
for tool **definitions**, not arbitrary result bodies. Neutral/inherited seeds
are not new measurements of DeepSeek/GLM/GPT-6.1 tokenization.

If reasoning usage is absent or zero **and reasoning text exists**, x is the
calibrated stored reasoning text, and visible output is independently tokenized
text plus tool arguments. Subtracting locally measured reasoning from a provider's
possibly visible-only output would manufacture replay. Empty OpenAI thinking text
cannot stand in for its encrypted payload.

### Filtering and uncertainty

- Consecutive assistant rows, without skipping failed/empty steps; same route;
  positive usage; no errors/incomplete outputs. R can exceed O in OpenCode; only
  Pi's inclusive-output convention requires R<=O.
  Pi follows entry ancestry (`parentId`), not file adjacency, and rejects history
  edit/compaction/custom-message/model-change boundaries.
- Main prefix gate: `cache.read(B) >= T(A) - 128`. Also compare tolerance 0 and 512.
  This rejects large rebuilds; it is **not proof of identical complete requests**.
  A short rewritten tail or server-side edit can survive this proxy. In particular,
  a cache counter is not a request-body hash.
- Main fit: positive x and new body <=512 calibrated tokens. Also report <=128,
  <=2048, no-tool and new-user subsets. Non-text/attachments, unfinished tools and
  new bodies over 100,000 characters are excluded. Negative residuals and numerical
  outliers are **not** removed just to force a positive slope.
- `k,c` are OLS. The 95% interval uses a **session-cluster** sandwich variance,
  accounting for correlated/overlapping pairs. Few-session intervals are weak,
  and a single session has no reported interval. Per-pair p10/p50/p90
  `resent/x` (x>=64) describes spread, including intercept and estimation noise.
- Tool-result sensitivity changes body estimates uniformly by 20%, then allows
  adversarial ±20% per pair plus ±all guessed wrappers. These scenarios quantify
  how far k could move under those assumptions; they are **not** validated bounds
  on real tokenizer error. Missing output counts, tool-call serialization changes,
  MC annotations and unrecorded host injections add further error.
- Zero-reasoning controls expose residual mismatch, not a pure measurement of
  result-body error. Stored tool results are not necessarily the exact tagged or
  truncated wire content. The static calibration harness uses per-model encodings
  for some seeds, while MC's runtime estimator uses Claude BPE for all models;
  applying its existing resolver exactly does not eliminate this uncertainty.

## Per-provider/model measurements

**54,055** positive-reasoning small-content pairs survive across 25 keys (including
synthetic/unmeasurable keys). `n/s` is pairs/independent sessions; `c` is tokens.
`ratio` is p10/p50/p90 of per-pair resent/x with x>=64. `err` is the worst-case
|Δk| from per-pair ±20% body error plus ±all estimated wrappers. It is a sensitivity
scenario, not a confidence interval. A dash means insufficient variation/sample,
not zero replay. `text` marks a stored-text denominator, not reported R.

| Harness; provider/model | Steps | n/s | k [cluster 95%] | c | ratio p10 / p50 / p90 | err |
|---|---:|---:|---|---:|---|---:|
| OC1 anthropic/claude-opus-5-5 | 140289 | 43277/638 | 1.000 [0.999, 1.001] | -13.838 | 0.686 / 0.960 / 1.070 | 0.028 |
| OC1 openai/gpt-6.1-sol | 33598 | 5115/342 | 1.052 [0.957, 1.147] | -15.306 | 0.848 / 1.002 / 1.022 | 0.028 |
| OC1 google/antigravity-gemini-3.8-flash | 21186 | 75/68 | 1.218 [1.198, 1.237] | -59.775 | 1.145 / 1.191 / 1.237 | 0.003 |
| OC1 openai/gpt-6-astra | 14587 | 2446/114 | 1.004 [1.003, 1.005] | -11.349 | 0.779 / 0.998 / 1.017 | 0.037 |
| OC1 openai/gpt-6-sol | 10706 | 2033/104 | 1.015 [1.009, 1.021] | -11.458 | 0.719 / 1.000 / 1.025 | 0.206 |
| OC1 openai/gpt-6-luna | 3663 | 73/39 | 1.018 [0.994, 1.043] | -12.226 | 0.898 / 0.993 / 1.028 | 0.206 |
| Pi openai-codex/gpt-6.1-sol | 3494 | 623/2 | 1.004 [1.003, 1.005] | -5.438 | 0.957 / 1.002 / 1.012 | 0.029 |
| OC1 ollama-cloud/glm-5.3-flash (text) | 2468 | 2 | — | — | — | — |
| Pi openai-codex/gpt-6-sol | 481 | 86/1 | 1.003 [—] | -8.506 | 0.837 / 0.999 / 1.050 | 0.056 |
| OC1 anthropic/claude-opus-5 | 350 | 77/1 | 1.007 [—] | -22.345 | 0.738 / 0.972 / 0.999 | 0.056 |
| OC1 ollama-cloud/deepseek-v4.1-flash (text) | 315 | 41/9 | 0.004 [-0.003, 0.011] | 64.215 | 0.030 / 0.296 / 0.783 | 0.046 |
| OC1 xai/grok-4.7 | 187 | 78/1 | 1.000 [—] | -7.710 | 0.888 / 0.993 / 1.006 | 0.040 |
| OC1 opencode/muse-spark-1.3-contributor-free | 178 | 88/1 | 0.961 [—] | 6.924 | 0.902 / 0.987 / 1.161 | 0.067 |
| OC1 openrouter/deepseek/deepseek-v4.1-flash | 166 | 9/4 | 0.994 [0.973, 1.016] | -20.660 | 0.716 / 0.835 / 0.980 | 0.111 |
| OC1 ollama-cloud/glm-5.3 (text) | 56 | 3/1 | 0.019 [—] | -66.647 | -0.343 / -0.019 / -0.012 | 0.068 |
| Pi openai-codex/gpt-5.6-sol | 45 | 10/1 | 1.008 [—] | -0.651 | 0.930 / 1.020 / 1.036 | 0.212 |
| OC1 magic-context/magic-context | 17 | 0 | — | — | — | — |
| OC1 anthropic/claude-sonnet-5 | 17 | 5/1 | 1.001 [—] | -15.773 | 0.866 / 0.977 / 0.998 | 0.019 |
| OC1 anthropic/claude-fable-5-1 | 16 | 4/1 | 1.002 [—] | -55.761 | 0.393 / 0.809 / 0.998 | 0.004 |
| OC1 unsloth-studio/unsloth/Qwen3.8-27B-GGUF (text) | 14 | 9/1 | 0.781 [—] | 36.490 | 0.840 / 1.169 / 1.299 | 0.345 |
| OC1 ollama-cloud/minimax-m3 (text) | 8 | 1 | — | — | — | — |
| OC1 openrouter/qwen/qwen3.8-27b:free | 2 | 0 | — | — | — | — |
| OC1 opencode/space-bunny-free | 1 | 0 | — | — | — | — |
| OC1 google-vertex/claude-sonnet-5-5@default | 1 | 0 | — | — | — | — |
| OC1 google-vertex/gemini-3.8-flash | 1 | 0 | — | — | — | — |

### Stability and where the calculation is too noisy

Each entry below is `pairs:k`. Body caps are calibrated tokens, cache tolerances
are logical input tokens. Zero-tolerance Anthropic samples are tiny because the
cache breakpoint leaves a small uncached suffix (commonly two tokens); a strict
zero gate discards otherwise stable prefixes. GPT caches have block granularity.

| Route (same harness as above) | body<=128 | body<=2048 | exact prefix | tolerance 512 |
|---|---|---|---|---|
| Opus 5.5 | 21196:1.0004 | 62751:0.9956 | 10:0.9479 | 43286:1.0001 |
| OC1 GPT-6.1-sol | 3772:0.9991 | 6554:1.1592 | 38:0.9991 | 12992:1.0171 |
| Antigravity Gemini 3.8 Flash | 32:1.2147 | 121:1.2138 | 57:1.2172 | 123:1.2189 |
| GPT-6-astra | 1761:1.0009 | 3017:1.0115 | — | 6134:1.0035 |
| OC1 GPT-6-sol | 1410:1.0002 | 2593:1.0174 | — | 5232:1.0110 |
| GPT-6-luna | 46:0.9859 | 92:0.8583 | — | 648:1.0087 |
| Pi GPT-6.1-sol | 343:1.0032 | 780:1.0064 | 4:1.0007 | 1537:1.0047 |
| Pi GPT-6-sol | 45:0.9995 | 103:1.0087 | — | 264:1.0065 |
| Opus 5 | 41:1.0000 | 120:1.0185 | — | 77:1.0075 |
| Ollama Cloud DeepSeek | 9:0.0513 | 138:0.0045 | — | 41:0.0040 |
| Grok 4.7 | 53:0.9982 | 129:0.9990 | — | 78:0.9997 |
| Muse contributor | 45:0.9648 | 117:0.9643 | — | 88:0.9606 |
| OpenRouter DeepSeek | — | 38:0.9961 | 8:0.9976 | 9:0.9944 |
| GLM 5.3 Flash (text) | — | 3:-0.0185 | — | — |
| GLM 5.3 (text) | — | 3:0.0190 | — | 3:0.0190 |
| Pi GPT-5.6-sol | 6:0.9953 | 13:1.0496 | — | 27:1.0217 |
| Sonnet 5 | 4:1.0008 | 8:1.0175 | — | 5:1.0013 |
| Fable 5.1 | — | 4:1.0023 | — | 4:1.0023 |
| Qwen local (text) | 6:1.0377 | 11:0.7310 | 9:0.7807 | 9:0.7807 |

**GPT-6.1-sol's main OLS is contaminated by one large unexplained growth event.**
For `msg_0f89b1bc50013na1B8VSClAxE3` → `msg_0f8b6e101001qHKx57dDsRLGWT`,
A has I/O/R/read/write=`115/110/3106/327552/0`, B has
`34174/158/15535/327552/0`; body=411.006987, wrappers=20. The prefix gap is only
115, yet estimated replay is **33,517.993**, about 30K above A's R. This could be
unrecorded appended content or a weakness of the cache proxy; it is not credible
evidence of a tenfold encrypted-reasoning cost. It remains in the main fit.
The independently specified **no-new-user** subset is 5,095 pairs, k=**0.9986**
[0.9953,1.0018], and the <=128 body subset agrees with one. The new-user subset
alone is 20 pairs with k=5.986: do not use it to choose a budget multiplier.

For zero-reasoning controls, residual p10/median/p90 are **-52/-17/+8 tokens** on
Opus 5.5 (38,029 pairs), **-34/+1/+3** on OC1 GPT-6.1-sol (3,493), and
**-25/~0/+9** on Pi GPT-6.1-sol (311). This is real wrapper/body/host mismatch;
tiny R values have correspondingly noisy per-pair ratios. A uniform 20% body
perturbation moves k by +0.00027 on Opus, -0.00008 on OC1 GPT-6.1, -0.00093 on
Gemini, and +0.00055 on Ollama DeepSeek. The adversarial bounds in the main table
are larger and do **not** cover the 30K unobserved-content event.

Gemini rejects **18,394** candidate pairs for a prefix gap >512; 75 selected
small-body pairs from 68 sessions are a highly selected subset. Its alias does
not match a measured seed in the existing resolver (prose ratio=1). The measured
canonical Gemini seed is 1.006909, but no alias shim was invented. GPT-6.1/GPT-6-sol
prose seeds are inherited and unmeasured; DeepSeek has neutral calibration; GLM
inherits prose=1 from `opencode-go/glm-5`. Do not read precise decimals as proof
of precise result-body calibration.

Ollama Cloud GLM 5.3 Flash has 33 nonempty reasoning parts across 2,468 steps,
GLM 5.3 has 15 across 56, and DeepSeek has 303 across 315 (none are `[cleared]`).
Only two/three/41 pairs respectively meet the small-content filter. The GLM
results cannot distinguish no replay from small fixed costs; DeepSeek's stable
near-zero slope is stronger, but it still has a **+64-token intercept** and local
visible-output uncertainty. It rules against 1:1 text-size replay on these pairs,
not against every fixed protocol cost or every other turn state.

## Earlier history versus only the newest step

The delta estimates **marginal newly added** reasoning, not the sum of all older
reasoning in B. Older reasoning already included in A's intact cached prompt does
not appear again in the difference. A slope near one therefore does **not** mean
only one block is sent. Conversely, a latest-only policy could replace the previous
block: `delta ≈ k*R(A) - k*R(previous) + c`. The script fits this lag coefficient
on eligible triples as a diagnostic.

This selection is inherently biased toward stable replay: removing old reasoning
can fail the prefix gate and be excluded. Even h≈0 on selected triples cannot prove
all older completed turns are kept. New-user transitions are a useful separate
test, but this offline store has no complete request bodies, transformations,
server-side context edits, or account-specific binding state. Wire captures or
controlled history A/Bs are needed to settle those questions, especially on opaque
routes. Existing wire evidence is in
[reasoning-cleanup-per-provider.md](reasoning-cleanup-per-provider.md); its mocked
serialization is not new billing evidence and does not settle these measurements.

| Route | Selected triples | k (latest) | h (previous) | New-user pairs:k |
|---|---:|---:|---:|---|
| Opus 5.5 | 21898 | 0.99998 | +0.00044 | 3692:1.0072 |
| Opus 5 | 23 | 1.01846 | +0.02238 | 10:1.0026 |
| OC1 GPT-6-astra | 690 | 1.00435 | +0.00003 | 15:1.0031 |
| OC1 GPT-6-sol | 615 | 1.01614 | -0.00211 | 14:1.0289 |
| OC1 GPT-6.1-sol | 1454 | 1.12337 | +0.15790 | 20:5.9856 (growth anomaly above) |
| Pi GPT-6.1-sol | 153 | 1.00534 | -0.00152 | 161:1.0033 |
| Pi GPT-6-sol | 22 | 1.00500 | +0.00632 | 8:0.9901 |
| Grok 4.7 | 69 | 1.00010 | -0.00098 | none |
| OpenRouter DeepSeek | 8 | 0.97789 | +0.02311 | none |
| Ollama Cloud DeepSeek (text) | 39 | 0.00347 | +0.00121 | none |
| Muse contributor | 66 | 0.95790 | -0.00956 | 6:0.9594 |

There is no near-`-k` lag replacement signature on the well-sampled Opus/OpenAI
paths; older charged reasoning is consistent with remaining in the reused prefix,
including Opus and Pi GPT-6.1 new-user transitions. Grok/OpenRouter DeepSeek only
support stable **within-tool-loop** retention here. Gemini has no eligible triple
and no selected new-user transition: **earlier versus latest-only is unsettled**.
GLM and the tiny models cannot settle it either. These numbers do not establish
retention after MC cleanup, compaction, a model/account switch or a server edit.

## Replay form and recommendation by route

Live-store shape evidence was retrieved as **key names and lengths only**, never
signature/opaque values. Four representative steps establish these forms:

| Step | Stored form |
|---|---|
| `msg_0efb55820001uiRbWs5M3q2df6` (Opus 5.5) | Reasoning text 733 characters; `metadata.anthropic.signature` 2,160 characters. |
| `msg_0ea1c7463001GZCSFWgUXr0YTj` (GPT-6-astra) | Reasoning text empty; `metadata.openai.reasoningEncryptedContent` 2,104 characters plus item ID. |
| `msg_0fe27a11e001X3ToLnBIKyKry2` (Antigravity Gemini) | Reasoning text 915 characters with no reasoning metadata; **tool** `metadata.google.thoughtSignature` 3,252 characters. |
| `msg_0efa670b900148SPerA1Nv3XS5` (Ollama DeepSeek) | Reasoning text 5,856 characters; no reasoning or tool replay metadata on its five tools. |

This does not capture what the provider actually received. In particular,
Gemini's positive cost cannot be attributed to its text instead of its signature,
and Opus's short visible thinking cannot be assumed to contain all charged
thinking. After correction, a text-only denominator gives k=**2.096** for Opus 5.5,
**1.940** for Opus 5, and **5.460** for this Gemini subset; OpenAI text slopes are
unstable (many empty summaries). Reported R is the better budget denominator on
those routes. OpenRouter DeepSeek's text-based k=0.909 is compatible with its
reported-R k=0.994 given the small sample and uncalibrated tokenizer.

| Route | Is reasoning-sized content charged again? | Budget recommendation / limit |
|---|---|---|
| Native Anthropic Opus 5.5 | **Yes**, approximately 1× reported R; strong stable-prefix evidence, including new-user transitions. Signed text is stored, but text alone undercounts. | Charge **reported R × 1** per step's reasoning group. Do not use calibrated visible thinking length as a substitute for full R. |
| Opus 5 / Sonnet 5 / Fable 5.1 | **Yes** in selected samples, slopes near one; only 77/5/4 pairs and one session apiece. | Provisional **1× reported R**, with binding/open-round constraints. Do not treat these small samples as independent qualification of cleanup safety. |
| OpenAI/Codex GPT-6 family; Pi GPT-5.6-sol | **Yes**, roughly 1× reported R. The OpenAI sample contains an encrypted replay payload even with empty text. | Charge **reported R × 1**, not summary or encrypted-byte BPE counts. GPT-6.1's anomalous main OLS is not a reason to configure 1.052; smaller-body/no-new-user and Pi controls support one. |
| Google Antigravity Gemini 3.8 Flash | **Yes for the replay bundle in selected pairs**, k≈1.218. Signature on a tool means deleting the typed reasoning part may not remove the cost. | **Do not assign zero.** For a qualified accounting-only estimate on this route, use ~**1.25× reported R** as a rounded selected-sample allowance. Whole replay-object ownership and actual removable cost need a wire/A-B probe before implementing cleanup; do not extrapolate this factor to canonical/Vertex Gemini. |
| OpenRouter DeepSeek v4.1 Flash | **Yes**, k≈1; text and replay metadata differ from Ollama's shape. No new-user evidence here. | Provisional **1× reported R**, subject to independent qualification of old-turn replay and deletion acceptance. Body uncertainty can move k by ~0.11. |
| Ollama Cloud DeepSeek v4.1 Flash | **No detectable size-dependent text replay**: k≈0 over x ranging from small to thousands of stored text tokens. Fixed/mismatched costs remain. | Treat historical reasoning text as **near-zero input-reclaim value on this observed route**, not 1× its local text length. Qualify with an identical-history A/B before enabling a zero-cost capability globally; storage/privacy cleanup is separate. |
| Ollama Cloud GLM 5.3 Flash / GLM 5.3 | Flash: **unsettled**, only two/three wider-body pairs. Non-flash: three pairs consistent with near-zero, not enough to qualify. | Keep **unknown**, not an assumed inherited zero/one. Tokenize available text for display, clearly uncalibrated; collect more small-body pairs or controlled replay. |
| xAI Grok 4.7 | **Yes**, k≈1 in one session. This is not the older Grok 3 mini chat non-replay mock. | Provisional **1× reported R** on this exact route; text-only reasoning is a poor proxy (text slope 4.821). No completed-turn retention claim. |
| Muse Spark contributor free | **Yes**, k≈0.961 in one session; small-body fit 0.965. | Provisional **1× reported R** rather than encoding a spurious precise discount; no broad family/host qualification. |
| Local Qwen3.8-27B-GGUF | Positive text-sized growth, but k ranges 0.731–1.038 with body cap and error bound ~0.35. | **Unsettled exact multiplier**; calibrated text could be a conservative provisional estimate, not a validated 0.781 policy. |
| MiniMax / Qwen free / Space Bunny / Vertex Claude or Gemini | One or zero qualifying pairs; no multiplier. | **Unknown**. No broad cloud/brand fallback from this measurement. |
| OpenCode 2 | No assistant steps in the discovered named store. | **No empirical recommendation**. Do not transfer v1 accounting/conversion behavior without inspecting a real v2 reasoning run. |

No experiment here tests request acceptance after reasoning removal, account
binding enforcement, savings after a full cache bust, or whether resetting a
provider's conversation state changes its policy. These remain explicit gaps.

## Budget design constraints independent of the fitted multiplier

1. Budget **logical input volume**, not dollars: cached reasoning remains input,
   albeit at a different price. These measurements do not estimate net savings
   after a reasoning deletion busts a large cached prefix.
2. Use **reported generated reasoning tokens** where a route has a defensible
   resend multiplier; do not tokenize signatures, base64 or encrypted payloads as
   if their transport bytes were ordinary model text. Nor is a short stored
   summary an accounting substitute for a provider's complete reasoning count.
3. When a step contains several reasoning parts but only one usage count, budget
   the reasoning **group for that assistant step** unless the harness records a
   defensible per-part allocation. Do not apportion opaque reasoning by summary
   character length. Store the generation-time usage before replacing parts.
4. A token budget chooses **whole native blocks/groups**, not a partial edit of a
   signed block. Protect the entire open tool round; it can legitimately exceed
   the target. Anthropic binding rules additionally require a permissible oldest
   prefix/suffix policy, not arbitrary middle deletion. Preserve removal IDs and
   do not resurrect previously removed bound reasoning on a later replay.
5. Apply new removals only at a qualified cache-rebuild opportunity, and replay
   the same frozen selection on stable passes. The present analysis deliberately
   filters out most such rebuilds and therefore does not measure their penalty.
6. A no-replay result is about **that adapter/model route**, not the brand. Local
   storage cleanup is a separate budget/privacy concern when no input is saved.
   Sparse or unqualified routes should remain explicitly unknown rather than
   inheriting a zero or one multiplier from a model name.

## Raw numeric example rows

Examples are the nearest 10th/50th/90th percentiles by x from the main filtered
pairs; fewer rows appear when fewer exist. All identifiers are original step
IDs. Usage tuples are **I / O / R / cache.read / cache.write**, unchanged provider
fields as stored by the harness. `x` is reported R except on marked text routes.
Body is the calibrated new-content estimate; wrappers are separate. Negative
estimated replay is intentionally retained. Rounding the body to two decimals
can change the reproduced residual by at most 0.005 token.

For OC1 reported-R rows subtract **O**; for Pi subtract **O-R**. For text routes
subtract the independently tokenized visible output **V**, listed with each
section; O may contain unreported reasoning. Nothing below contains source text,
tool arguments, signatures, encrypted contents or auth data. Zero-pair routes
above have no qualifying raw examples to present.

### OC1 — anthropic/claude-opus-5-5

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0e832c7020014W3VeITOJn61Ia` → `msg_0e832e439001gDV5vsfZ0jKELM` | 2/123/44/47188/3267 | 2/348/0/50455/402 | 44 | 237.34 | 12 | 29.66 |
| `msg_0f6b32710001pYu3i9dsWtHtFG` → `msg_0f6b33f02001hE9HgOtmeBEb2Z` | 2/126/157/393657/2902 | 2/2867/0/396559/399 | 157 | 138.32 | 12 | 122.68 |
| `msg_0fa78c80f001fs15VcUN4C2he7` → `msg_0fa7913050014F9ahsxH0evrF0` | 2/940/754/480460/18832 | 2/521/0/499292/1822 | 754 | 51.87 | 24 | 806.13 |

### OC1 — openai/gpt-6.1-sol

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0fb0746b8001UU9d3VyO0jDo6m` → `msg_0fb077115001uxNY02CpHSrdg8` | 605/259/15/76928/0 | 390/45/0/77440/0 | 15 | 9.00 | 12 | 17.00 |
| `msg_102d4c9aa001zlmcywvsY0l2Wy` → `msg_102d4f80d001Jsi8ZQqp0Cf88Z` | 2011/141/73/76928/0 | 494/123/0/78848/0 | 73 | 180.00 | 12 | 70.00 |
| `msg_0f81862df001IABxFVPGSPtMdq` → `msg_0f8198be5001P9G07RPiaeVed2` | 976/40/516/178560/0 | 718/40/1034/179456/0 | 516 | 65.00 | 12 | 521.00 |

### OC1 — google/antigravity-gemini-3.8-flash

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0ed584621001tUD9uHe76WUxl7` → `msg_0ed587302001bWiNGwtP2mNnyp` | 4202/29/1850/106609/0 | 2102/64/20655/110855/0 | 1850 | 85.00 | 12 | 2020.00 |
| `msg_0ecc1a8470014sLt7s1cQI3I7G` → `msg_0ecc1e374001YnOkp2is1cRO2r` | 4843/18/3970/106852/0 | 5263/52/15483/111696/0 | 3970 | 461.00 | 12 | 4773.00 |
| `msg_0edc05b890013wYKnhUtIzIQhL` → `msg_0edc21ddd0012tONNlG4mpTceP` | 4803/18/29168/106814/0 | 31848/62/4179/115750/0 | 29168 | 511.00 | 12 | 35440.00 |

### OC1 — openai/gpt-6-astra

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0e91f1143001ZR90KnBDq15yfa` → `msg_0e91f6601001x8tznpK3TSR7CJ` | 362/139/14/74112/0 | 282/1425/86/74368/0 | 14 | 9.00 | 12 | 16.00 |
| `msg_0ea53cae5001HouUOjDyMhNPPe` → `msg_0ea53ead5001TgbRTFdDtDVoXe` | 731/69/68/103552/0 | 314/40/748/104192/0 | 68 | 90.00 | 12 | 52.00 |
| `msg_0ea841bd7001ygVmu1TeWaA9ue` → `msg_0ea8648b0001MMPHoTwuXRwHqx` | 215/40/516/233088/0 | 716/38/0/233216/0 | 516 | 60.00 | 12 | 517.00 |

### OC1 — openai/gpt-6-sol

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0ed81fd54001sQ7tGgmVV6Av87` → `msg_0ed82379f001j27C0gpobWzmuh` | 492/389/10/50688/0 | 530/188/9/51072/0 | 10 | 9.00 | 12 | 12.00 |
| `msg_0e7f72d77001z7B8QoJOyZnZpc` → `msg_0e7f7521b001b7ILQsh40gddBb` | 15068/82/31/0/0 | 322/55/0/14976/0 | 31 | 104.00 | 12 | 32.00 |
| `msg_0eddb38b90011WEujQVEsQAlOy` → `msg_0ede0467a001IhFwyR339zzMEh` | 3962/110/173/24960/0 | 877/75/12/28800/0 | 173 | 494.01 | 12 | 138.99 |

### OC1 — openai/gpt-6-luna

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0edff9d81001Xr13Q0hWH3qYPf` → `msg_0ee002121001zIUttUWfsO7XYZ` | 1142/41/10/46592/0 | 246/41/9/47616/0 | 10 | 61.00 | 12 | 14.00 |
| `msg_0f9de122600175vnUnj4MHGxED` → `msg_0f9de2ede001kUFxDL2VX4Y1r3` | 1138/196/31/47616/0 | 364/58/26/48640/0 | 31 | 9.00 | 12 | 33.00 |
| `msg_0e9f0e95c001zUPMLHt6DlpwAT` → `msg_0e9f147c8001SKWuBeD2izviXH` | 1151/42/143/30208/0 | 406/37/0/31232/0 | 143 | 101.00 | 12 | 124.00 |

### Pi — openai-codex/gpt-6.1-sol

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `c0681f99` → `d3b2197e` | 3537/806/106/257536/0 | 950/667/514/260992/0 | 106 | 51.00 | 12 | 106.00 |
| `d44779dc` → `2f97f744` | 1113/522/516/230400/0 | 1072/14/8/231424/0 | 516 | 456.01 | 8 | 512.99 |
| `262cab6a` → `1e08a561` | 11369/2995/2588/179584/0 | 3161/435/325/190848/0 | 2588 | 31.00 | 12 | 2606.00 |

### OC1 — ollama-cloud/glm-5.3-flash (text)

Independent V=197 and 268 respectively.

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0fcef2fc4001lCRLDw0F8bQSn8` → `msg_0fcef8118001k1s2xtT03EFs5k` | 2913/290/0/29184/0 | 609/79/0/32000/0 | 59 | 277.00 | 12 | 26.00 |
| `msg_0fd3de209001gp7R4Ee302k0mj` → `msg_0fd3e25f1001cfXDZTeNsAlv1A` | 20054/589/0/0/0 | 830/443/0/19968/0 | 302 | 430.00 | 24 | 22.00 |

### Pi — openai-codex/gpt-6-sol

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `1716fbbc` → `bdd12c2b` | 1392/112/24/226176/0 | 364/811/748/227456/0 | 24 | 126.00 | 12 | 26.00 |
| `768a2a54` → `f9d6317f` | 3038/576/86/288256/0 | 706/149/100/291200/0 | 86 | 25.00 | 12 | 85.00 |
| `45cbc96c` → `e93dfc7c` | 988/617/545/226688/0 | 805/48/0/227584/0 | 545 | 90.00 | 12 | 539.00 |

### OC1 — anthropic/claude-opus-5

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_101a8fff7001SPzTO4auoFVZxt` → `msg_101ab2096001OasUaQZeKuO4Hr` | 2/1281/121/119861/1137 | 2/514/122/120998/1600 | 121 | 215.33 | 8 | 95.67 |
| `msg_101ddb7d1001yxe9PZ5TLIkOf3` → `msg_101de0b8c0017jukqoBxVMISXG` | 2/1134/371/387746/537 | 2/663/0/388283/1531 | 371 | 14.15 | 12 | 370.85 |
| `msg_101cec049001MAEE2BrXrBK17I` → `msg_101cf44fa001xyM1Lm9EnI7myg` | 2/1775/914/301247/4523 | 2/1448/0/305770/2709 | 914 | 9.43 | 12 | 912.57 |

### OC1 — ollama-cloud/deepseek-v4.1-flash (text)

Independent V=36, 43 and 118 respectively.

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0e6030b2b001VBjTbijsYkdw6T` → `msg_0e6030f5f0013XfTWPX1Q1ccmc` | 2157/102/0/51072/0 | 467/365/0/53120/0 | 19 | 277.00 | 12 | 33.00 |
| `msg_0e6028644001C6yqA4CNn6PJNf` → `msg_0e6028a7f001BZ1cSoqZqqQOck` | 477/219/0/18944/0 | 586/245/0/19328/0 | 130 | 387.00 | 12 | 51.00 |
| `msg_0efa670b900148SPerA1Nv3XS5` → `msg_0efa68afa0018o9F7GNz7ywbJb` | 1277/1894/0/39040/0 | 466/159/0/40192/0 | 1707 | 30.00 | 60 | 133.00 |

### OC1 — xai/grok-4.7

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0fd3ad2af001GCGL14Fhwkw8qm` → `msg_0fd3ae03e001LRiT9qCXbQZqQ8` | 1256/68/17/206336/0 | 310/166/1162/207488/0 | 17 | 117.00 | 12 | 9.00 |
| `msg_0fd460fda001xgTCoK3E4fpxbt` → `msg_0fd4638df001OE88t29PJWtr7m` | 2391/335/174/263296/0 | 616/442/32/265600/0 | 174 | 6.00 | 12 | 176.00 |
| `msg_0fda5aef00017FOXAISXU4Z3Y2` → `msg_0fda5ecc4001BZqdoY0qZW08sA` | 1628/212/670/82816/0 | 991/66/9/84352/0 | 670 | 6.00 | 12 | 669.00 |

### OC1 — opencode/muse-spark-1.3-contributor-free

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_108d1d3a3001rSjN8d4po3F8nO` → `msg_108d30a5c001qcYkA7gitv2YSU` | 598/52/19/137969/0 | 317/100/117/138481/0 | 19 | 159.74 | 8 | 11.26 |
| `msg_0f2f4045d001RwRysm5aXYkZX8` → `msg_0f2f41b2b001veUg47f6uwdfB4` | 530/112/124/110449/0 | 727/98/0/110961/0 | 124 | 473.69 | 12 | 111.31 |
| `msg_108fe9bb5001YHb5xNwMbh0xU5` → `msg_108fec516001aJHylv6wXy31Mu` | 1080/165/656/137201/0 | 1242/90/0/138225/0 | 656 | 399.82 | 12 | 609.18 |

### OC1 — openrouter/deepseek/deepseek-v4.1-flash

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_104e8b343001fmwAjlfwA8T3YJ` → `msg_104e8b6200019mNJfFtSZqV3Gk` | 756/86/35/52480/0 | 374/134/392/53248/0 | 35 | 277.00 | 12 | 11.00 |
| `msg_104e8a047001SVLpBjD9jIRBQ1` → `msg_104e8a4d5001dyRnAtf2yKouqg` | 1131/174/118/47360/0 | 251/156/59/48768/0 | 118 | 232.00 | 24 | 98.00 |
| `msg_104eb7638001IFuuIvVqmwc2J0` → `msg_104eb81ee001P36UB929rUyfus` | 2288/139/781/77696/0 | 453/677/1590/80768/0 | 781 | 334.00 | 36 | 728.00 |

### OC1 — ollama-cloud/glm-5.3 (text)

Independent V=110, 91 and 44 respectively.

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0fd5cad50001MUtcR0yq3pMcug` → `msg_0fd5cd9d8001YYF96mGLT5mu0i` | 7300/280/0/66048/0 | 577/36/0/73280/0 | 184 | 453.00 | 24 | -78.00 |
| `msg_0fd655e78001W4Ce3xgUdRDrGP` → `msg_0fd6590aa001pUv0m5LFu4wp01` | 3452/1118/0/103616/0 | 412/53/0/106944/0 | 1130 | 206.00 | 12 | -21.00 |
| `msg_0fd5f752b001eivjmMgqzU3U6n` → `msg_0fd5fec7d001laYgwEHR7cu7tA` | 2271/2462/0/94144/0 | 317/62/0/96320/0 | 2633 | 192.00 | 12 | -26.00 |

### Pi — openai-codex/gpt-5.6-sol

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `1200e30c` → `1ed528cb` | 860/734/9/171648/0 | 844/906/11/172416/0 | 9 | 4.00 | 12 | 11.00 |
| `a6702420` → `e07d08f9` | 625/250/22/121472/0 | 387/127/8/121984/0 | 22 | 9.00 | 12 | 25.00 |
| `1864ec00` → `e46f95c6` | 1149/386/243/160768/0 | 683/374/77/161792/0 | 243 | 139.00 | 24 | 252.00 |

### OC1 — anthropic/claude-sonnet-5

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0e269892d0016PWziKCsAc2RvO` → `msg_0e2699e3c001oMqSjXYxnR9Y3c` | 2/119/114/239480/1399 | 2/152/0/240879/335 | 114 | 110.03 | 12 | 93.97 |
| `msg_0e269aaa1001Y8l3cIuJbew1a4` → `msg_0e269f318001t8icY7f6lF31I4` | 2/247/1067/241214/1629 | 2/235/0/242843/1446 | 1067 | 144.61 | 12 | 1042.39 |
| `msg_0e26a3beb001eREr23uzCJ1iUI` → `msg_0e26b0dcc0014fuQ52piZjQHWK` | 2/138/4022/247324/9215 | 2/80/1128/256539/4271 | 4022 | 105.31 | 20 | 4007.69 |

### OC1 — anthropic/claude-fable-5-1

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0f207448b001tmI4ad3cOU9nOe` → `msg_0f2075448001oZy4J4RJEWCopy` | 2/125/93/126272/324 | 2/322/0/126596/584 | 93 | 419.66 | 12 | 27.34 |
| `msg_0f2654783001pvm2wUh0O2QACC` → `msg_0f267b1120017XkHlWC5tDWxKe` | 2/183/9098/146685/11442 | 2/61/0/158127/9635 | 9098 | 391.37 | 12 | 9048.63 |
| `msg_0f1fd80f5001NmQdhQYM4Jtulk` → `msg_0f20446ba001mGLyPSvwgRAmIc` | 4/8081/22060/0/82959 | 2/6644/0/82959/30162 | 22060 | 6.29 | 12 | 22060.71 |

### OC1 — unsloth-studio/unsloth/Qwen3.8-27B-GGUF (text)

Independent V=6, 59 and 50 respectively.

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0fc5cd9df001B148dHdLhQCBJ5` → `msg_0fc5cf9fe001gFU34rcl818Nlx` | 46/72/0/48411/0 | 113/70/0/48530/0 | 44 | 103.00 | 12 | 65.00 |
| `msg_0fc5aac6b001fBDZuaGaqCqt2L` → `msg_0fc5b94320015lkkXwUD7gdadU` | 4479/216/0/41708/0 | 234/195/0/46403/0 | 113 | 212.00 | 24 | 155.00 |
| `msg_0fc5bd1dc001oIDOxW9kT4KVCk` → `msg_0fc5c356a001cjbxpcUqcQBpLA` | 634/213/0/46833/0 | 46/183/0/47681/0 | 139 | 38.00 | 12 | 160.00 |

### OC1 — ollama-cloud/minimax-m3 (text)

Independent V=24.

| A → B | A: I/O/R/read/write | B: I/O/R/read/write | x | body | wrappers | estimated resent |
|---|---|---|---:|---:|---:|---:|
| `msg_0ed6be9980018NdAH2S8eBDN3T` → `msg_0ed6c253c001PJZiRkeqRzjv99` | 18458/93/0/128/0 | 170/43/0/18586/0 | 43 | 115.00 | 12 | 19.00 |

## Verification and unresolved measurements

- Bun 1.4.2: the analysis completed successfully across 25 keys / 54,055 selected
  pairs. Thirteen synthetic tests cover totals, both output conventions, negative
  residuals, tool ownership, text fallback, signatures, non-text exclusion,
  regression/lag/error sensitivity and sparse example selection.
- TypeScript 5.9.3: `bun run --cwd packages/plugin typecheck` checks product and
  script projects; no product build or model calls are required for this research.
- Python 3.9.6: `verify-report.py` independently recomputes 25 OLS selections/fits,
  verifies all 25 transcribed model rows, and checks **57 raw examples**, including
  independent visible counts on text routes. This validates transcription and
  arithmetic, **not** provider truth or wire identity.
- Verification was challenged: disabling unfinished-tool exclusion reddened only
  its named test (the other ten then-existing tests passed); corrupting one
  reported body estimate reddened only `raw examples match numeric observations`,
  while independent regressions and model-table checks still passed. Both changes
  were restored from staged live files before continuing.

Still unmeasured: the exact request bytes and deleted reasoning savings; why the
Gemini replay bundle costs ~1.22× R and whether its older signature history is
retained; the high-growth GPT-6.1 anomaly's unrecorded content; GLM Flash's true
multiplier; account/adapter changes outside this window; real OpenCode 2 reasoning;
routes/harness models not in these stores; and the net cache-rebuild cost of a
newest-N policy. The recommended counting units are not permission to implement
or enable deletion on unqualified signed/opaque routes.
