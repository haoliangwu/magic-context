# Historian importance anchoring: paired production-model trial

**Run and E/A2 follow-up:** 2026-10-05, on base `ee9d82912cd8105322672a1f5dd1bbb7172a2f46`. Investigation only; no product changes. The explanation for small historian chunks was removed from this investigation's scope by request. A–D observations are unchanged; E and A2 add sixty calls on the exact same thirty inputs.

## Bottom line

**There is strong evidence of numeric anchoring to session-reference importance, but not literal copying of the preceding score on every run.** On 30 real inputs, removing only those numeric attributes reduced first-compartment scores within ±2 of the real preceding compartment from **21/30 (70%) to 3/30 (10%)**. Replacing them with shuffled seed importances moved scores substantially and directionally toward the planted values. The fixed cross-project examples were unchanged in both interventions.

**D improves the reference band's coverage, but this trial does not show that it restores independently scored output.** Its first-score standard deviation rose only from **6.17 to 6.86**, and proximity to the preceding real importance stayed **20/30 (66.7%)**. Its larger all-compartment spread partly comes from changing segmentation. D should not be advertised as a demonstrated cure on these results.

**E substantially reduces newest-score proximity while retaining scored diverse examples:** within ±2 falls to **7/30 (23.3%)**, first-score SD is **10.80**, and first scores span **42–85**. That resembles B's spread more than D's, although E is less de-anchored than B on this proximity measure and has no first scores below 30. It is evidence that hiding recent numeric labels matters even when older references remain scored, not proof of objectively correct calibration.

**A2 establishes a small score-noise baseline but extensive text regeneration noise.** A2 differs from A by only **0.83 points** on average, with **19/30** identical first scores and **27/30** within ±2 of A. Its proximity to the preceding real compartment remains **21/30 (70%)**. Yet A2 has **0/30 exact title-array and P1-array matches** against A, just like B/C/D/E. Exact text differences alone therefore cannot be attributed to the arms. This is full historian regeneration, not a fixed-summary scoring-only test.

## Inputs, provenance and isolation

I found **recorded historian prompts**, rather than reconstructing raw message ranges. The copied OpenCode database contains retained hidden children in `session`, with user prompt text in `part` and model XML in assistant text parts. `historian_runs` and `subagent_invocations` contain range/importance/usage telemetry, not complete prompts; AFT's recent module-backed children were more useful than its older telemetry rows. Code also confirms that debug dumps are **responses**, not input prompts (`compartment-runner-historian.ts:1024–1044`), and successful-response cleanup is attempted at `:359`/`:407`.

Selection: the **ten latest distinct retained primary-model inputs per session** with exactly one output compartment, whose output start/end/title/importance matches a published compartment in the copied context store. Six recorded session references must be present and their newest score must match the real preceding stored compartment. Repair drafts, fallback-model outputs, multi-compartment outputs, duplicate input ranges and unmatched/unpublished attempts are excluded. This is a selected retained corpus, not random sampling of all runs or all historical days.

| Session | ID | Selected compartment sequences | Input dates (UTC) | Count |
| --- | --- | --- | --- | ---: |
| AFT | `ses_313660571ffeZTsf4koSJwk50Q` | 2066–2077, with gaps | October 4 | 10 |
| BROCA | `ses_114f158ccffet7znXAgI7lc3Kp` | 635–660, with gaps | October 2–4 | 10 |
| Magic Context | `ses_331acff95fferWZOYF1pG0cjOn` | 2155–2169, with gaps; includes 2160 | October 3–4 | 10 |

All original accepted outputs used `google/antigravity-gemini-3.8-flash`. A preserves the recorded **user prompt byte-for-byte**, including seeds, session references, project-memory block, chunk formatting and transcript guard. AFT's ten children also retained their role-system string; the other twenty use `COMPARTMENT_AGENT_SYSTEM_PROMPT` from the current production generated source. This is not a claim of complete historical provider-envelope replay for those twenty. B/C preserve every non-reference block; D preserves every block except the two example blocks. Prompt and system SHA-256s, input IDs/ranges, published IDs, scores and reference selections are retained in [the sanitized evidence](../../packages/plugin/scripts/importance-anchoring-trial/evidence.json).

For the follow-up, the original temporary copies had already been deleted. I made fresh read-only snapshots, recovered prompts by the **original thirty child IDs**, and required **150 original SHA-256 checks** (A/B/C/D prompts plus system, for every input) to match the committed evidence. Original recorded P1 hashes also matched. No newer inputs were selected and no reference history drift was accepted. A2's user prompt is byte-identical to A; E is byte-identical to D except for removing the four recent opening-tag importance attributes. A–D response records were carried forward unchanged from the committed sanitized evidence, not regenerated.

Live databases were accessed **only by the mandated `sqlite3 "file:…?mode=ro" "VACUUM INTO '…'"` snapshot operation**. Queries used copied `context.db`/`opencode.db`; a copied `store.db` was inspected for schema but was not needed for replay. `credential`, `account`, `account_state`, `control_account` were removed from the OpenCode copy with secure deletion before use. Configuration was copied bytewise before parsing; no live configuration was changed. Snapshots were taken sequentially, not atomically across stores. All snapshots, staged configuration/authentication/connection files and raw input/output files were deleted after retaining sanitized evidence.

No OpenCode host was launched, and no compartment, fact or memory was published. Calls used Broca with a throwaway `project_root` under `$TMPDIR/magic-context/importance-trial/`, harness `importance-trial`, and a fresh lineage per cell. The existing Broca provider service retains its normal run WALs in its own store; that is distinct from the forbidden OpenCode/Magic Context stores and is not a throwaway provider daemon. The harness never reads or migrates those live forbidden stores during model execution.

## Model and experimental arms

The **copied** Magic Context config selects `historian.opencode.model = { model: "google/antigravity-gemini-3.8-flash", variant: "high" }` and `historian.temperature = 0.1`. It also has a separate module-model entry for Muse Spark; this trial uses the configured OpenCode primary and the model observed in all thirty accepted original children, **not** Muse or a cheaper substitute.

Dispatch followed the existing Rust producer's `session.send`/`session.subscribe` protocol (`crates/mc-module/src/historian_producer.rs:801–854`, `:966–979`): system and user roles separate, `tools: []`, temperature 0.1, max output 32,000. Broca version was **0.3.176** for both phases. No editor pass, validation-repair prompt or model fallback was used. Three independent cases ran concurrently, with A/B/C/D order rotated by case; the follow-up alternated E/A2 versus A2/E by case. A2 had a new lineage, not a second message appended to A. Every final cell completed in one provider step with `finish_reason: stop`; none hit the length cap.

**Envelope gap:** the producer wire used here does not pass OpenCode's `variant: high`. Broca's resolved provider reasoning setting was not independently verified as the identical OpenCode high preset. All arms used the same dispatch contract; the results establish sensitivity of the configured model, not exact equivalence of the two host/provider envelopes. Provider usage reports substantial reasoning (see cost below).

| Arm | Reference treatment |
| --- | --- |
| A | Recorded prompt, unchanged: four seed examples and six recent session references. |
| B | Remove `importance="N"` from **session-reference compartment opening tags only**. Preserve seed scores, reference prose, transcript and all other attributes. |
| C | Replace those six attributes with a deterministic shuffled permutation of actual fixed-seed scores, taking six without replacement. The corpus spans **3–96**. Preserve all other bytes. |
| D | **Final requested design**, superseding the earlier six-reference proposal: three deterministic seeds, four newest content-bearing session compartments, three diverse older session compartments. All importance attributes retained. |
| E | D's exact layout and example text, but **only the recent four** omit `importance`. The diverse three and all three seeds keep their scores. |
| A2 | Independent second generation of A, with identical user/system prompts and model settings, in a fresh lineage. |

D uses the production band edges **85–100, 60–84, 30–59, 10–29, 1–9**. Count bands covered by the three seeds and recent four; choose from available uncovered bands first. Then choose from the least-represented available bands, updating representation after each pick. Ties use high-to-low production band order and the newest unselected older row in the band. Older selections are chronological, **before** the chronological recent four. There are exactly three seeds and seven rendered session references in every final D prompt. Empty boundary-only markers are not examples. This deterministic tie rule was an implementation assumption, not an embedding or relevance query.

Production's anchoring opportunity is explicit: `reference-retrieval.ts:159–214` renders the last six compartments with scores; its comment says the historian calibrates against its own prior scoring. `historian-prompt.source.md:121–159` gives the duration-based rubric, then tells the model to use seed/session references as calibration anchors and give a similar score when the new compartment feels like a reference. The Rust twin has the same six-reference window and band edges at `historian_prompt.rs:13–18`. Numeric sensitivity therefore has a plausible prompt-level mechanism; it is not evidence of a storage layer copying a previous value.

## Scores

Primary analysis is **one first output compartment per input**, since the suspected effect is across runs. All SDs are **population SD**. The denominator is always the same thirty inputs, including those that regenerate more than one compartment. The previous score is the preceding compartment's **real stored** importance, never A's regenerated score or a planted score.

| Arm | First-score min–max | Mean | SD | Within ±2 of previous real score | Single-output cells | Mean absolute distance from recorded original | Mean absolute change from A | Mean absolute change from A2 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 52–76 | 69.50 | 6.17 | 21/30 = 70.0% | 29/30 | 1.43 | — | 0.83 |
| B | 35–88 | 70.30 | 11.10 | 3/30 = 10.0% | 28/30 | 7.23 | 6.93 | 7.03 |
| C | 5–88 | 56.17 | 20.35 | 7/30 = 23.3% | 29/30 | 16.63 | 16.20 | 16.43 |
| D | 52–84 | 69.37 | 6.86 | 20/30 = 66.7% | 26/30 | 2.17 | 1.80 | 1.90 |
| E | 42–85 | 71.83 | 10.80 | 7/30 = 23.3% | 26/30 | 8.43 | 8.00 | 8.43 |
| A2 | 58–75 | 69.73 | 5.28 | 21/30 = 70.0% | 30/30 | 1.00 | 0.83 | — |

The original retained outputs themselves had min–max **50–75**, mean **69.87**, SD **5.92**, and **21/30** within ±2. “Recorded original” means the real published output of that historical input, not the previous reference's score. Its distance describes change, **not scoring accuracy**. A2 is an independent unchanged-prompt repeat in this experiment, subject to the envelope caveat above.

| Arm | All emitted compartments | All-score min–max | Mean | SD |
| --- | ---: | --- | ---: | ---: |
| A | 31 | 52–76 | 69.58 | 6.09 |
| B | 32 | 35–88 | 71.00 | 11.12 |
| C | 31 | 5–88 | 55.13 | 20.81 |
| D | 34 | 40–84 | 67.74 | 9.08 |
| E | 34 | 42–85 | 69.47 | 12.37 |
| A2 | 30 | 58–75 | 69.73 | 5.28 |

Do not interpret D's 40-point minimum or 9.08 SD as the same first-compartment measure: some lower scores are second compartments from newly split chunks.

### By session: first-score spread / proximity

Each cell below is **min–max; SD; within-±2 count / 10**.

| Session | A | B | C | D | E | A2 |
| --- | --- | --- | --- | --- | --- | --- |
| AFT | 52–65; 4.15; 6/10 | 35–78; 14.63; 0/10 | 5–74; 20.88; 1/10 | 52–65; 4.57; 7/10 | 52–84; 9.65; 0/10 | 58–65; 2.33; 7/10 |
| BROCA | 60–74; 4.20; 7/10 | 55–88; 9.00; 1/10 | 38–88; 17.40; 4/10 | 58–84; 5.95; 6/10 | 58–85; 9.10; 2/10 | 60–75; 4.27; 6/10 |
| Magic Context | 72–76; 1.11; 8/10 | 65–82; 4.52; 2/10 | 38–80; 14.84; 2/10 | 62–76; 3.77; 7/10 | 42–78; 11.43; 5/10 | 70–74; 1.30; 8/10 |

## C: movement toward planted values

Use paired response change **ΔY = first(C) − first(A)**. The newest-reference intervention is **ΔX = planted newest − real newest reference**. These are real score changes, not merely correlations of successive outputs.

- C differs from A on **27/30** first scores; its mean change is **−13.33** points.
- **20/30** move in the planted newest value's direction (three have zero response change; seven move the other way).
- **19/30** end closer to the planted newest value than A did. Mean absolute distance to that target falls **11.87 points**; direction and closeness are different because a score can overshoot.
- Regressing ΔY on ΔX with an intercept gives slope **0.274** and correlation **0.460**: descriptively, about a 27-point response shift per 100-point newest-reference intervention.
- Using the **mean of all six** planted/real reference values instead gives slope **0.619**, correlation **0.416**, **20/30** directionally aligned changes, **16/30** closer responses, and **5.57 points** mean distance reduction.

This does **not** identify the newest reference as the sole causal anchor: all six attributes change together, the transcript topics are correlated, and newer-vs-mean targets are not independently randomized. Nonetheless the directionality plus the B ablation is evidence against purely content-independent numeric scoring. The 27/30 differences and non-unit slopes are also evidence against a literal unconditional copy rule.

## D: available history and what actually spread

Content-bearing older history has low-band compartments in **all 30 cases**, but very few in the lowest band for BROCA/MC. These are counts in the **eligible older pool**, excluding the recent four and empty boundary markers; ranges reflect the ten sampled cutoffs.

| Session | 85–100 | 60–84 | 30–59 | 10–29 | 1–9 | Cases with either low band available |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| AFT | 180 | 1,170–1,180 | 524–525 | 167 | 18 | 10/10 |
| BROCA | 81 | 451–473 | 73–76 | 25 | **1** | 10/10 |
| Magic Context | 214 | 1,520–1,534 | 371 | 44 | **1** | 10/10 |

D's **combined seed/session examples** cover all five bands in **30/30** prompts; A covers all five in **7/30** and four bands otherwise. Older low-band references are selected only when useful to coverage/representation: a diverse score below 30 appears in **16/30** D prompts, below 10 in **10/30**. A seed can already cover a low band, so the design does not force an older low-score example into every input. With only one genuine 1–9 example in BROCA and MC, those examples are repeatedly reused when selected.

Thus D demonstrably restores **input band coverage**, and there is a modest output-spread increase, especially inside MC. It does not demonstrate a large restoration of the **first-compartment output spread or de-anchoring**: the four recent references still have their original scores, and the observed first-score proximity remains high. D also changes example text, seed count and reference count together, so any score/content effect cannot be attributed to band coverage alone.

## E and A2: de-anchoring versus generation noise

E retains the same three scored seeds and three scored diverse references as D, along with all four recent reference bodies, but hides the recent labels. That reduces proximity to the preceding real score from **D's 20/30 to E's 7/30**, expands the first-score range from **52–84 to 42–85**, and increases SD from **6.86 to 10.80**. Mean absolute E–D change is **7.33 points**, with mean signed change **+2.47**. E–A change is **8.00 points**, versus **0.83** for the unchanged A2 repeat. These are materially larger than the observed score-noise baseline; the result does not require deleting all session-reference scores as B did.

The effect is heterogeneous: E has zero within-±2 hits in AFT, two in BROCA, but five in MC. E's mean is **71.83**, higher than A/A2's approximately 69.5–69.7; its first-score SD is similar to B's **11.10**, but it has no first score below 30. The scored diverse references may still influence calibration, and topic-specific content may justify high scores. Without judged score ground truth, **spread and reduced newest-score proximity are not proof of unbiased or quality-preserving calibration**.

E does not reselect diversity after hiding the recent labels: it uses D's exact references as requested. Its **six scored examples** cover five bands in **13/30** inputs and four bands in **17/30**; sixteen inputs have no scored 60–84 example. D's selection counted that band as covered by the recent four, whose numeric labels E now hides. Thus E retains broad scored anchors, but not D's complete five-band **numeric** coverage in every input. The seven session reference bodies and their continuity information are still present.

A2's paired first-score change from A has mean **+0.23**, SD **1.67**, and range **−4 to +6**. **19/30** first scores are identical; **27/30** differ by at most two. Output ranges/segmentation match A in **29/30** cases (A splits one case that A2 keeps whole). Compared with that baseline, B/C/E score differences are much larger, while D's **1.80-point** mean absolute change is modest. One repeat does not estimate the full noise distribution or remove time/provider confounding.

## Five side-by-side examples

These are actual response titles, shortened only in this display. Full title arrays and output ranges are in the evidence. Bracketed numbers are importance; `+` indicates another output compartment. Cases were chosen for topic diversity and contrasting effects, not as a representative statistical sample.

| Input / previous real score / C newest plant | A | B | C | D | E | A2 |
| --- | --- | --- | --- | --- | --- | --- |
| AFT seq 2077 / **67** / **27** | **65** Landed Trains 297 and 295, staged 300/301, triaged OMP delegation, purged 316 notes | **76** Landed Trains 297 and 295, staged 300/301, framed OMP delegation, pruned notes | **38** Staged Train 300 executor perf, landed 297 schema gate, settled Tier-2 inspect, mapped delegation **+ 24** Pruned 316 notes, landed 295, rebased 298 | **65** Staged Train 300 executor perf, landed 297, staged 301 worktrees, planned delegation **+ 45** Purged 316 notes, landed 295, pushed 298 | **78** Staged Train 300 executor perf, landed 297, settled 301 worktree inspect, routed OMP URL delegation **+ 52** Pruned notes, verified C5 vectors, landed 295, rebased 298 | **65** Landed Trains 297 and 295, staged 300/301, planned OMP delegation, pruned notes backlog |
| AFT seq 2070 / **64** / **4** | **52** Dispatched follow-up worker to isolate views migration test flake in Train 293 | **35** Isolated Train 293 view migration test flake and dispatched isolation follow-up | **5** Triaged Train 293 views test parallel flake and dispatched isolation worker | **55** Triaged Train 293 view test flake and dispatched shared-state isolation follow-up | **52** Identified Train 293 view migration test flake and dispatched isolation worker | **58** Triaged Train 293 views migration test flake and dispatched shared-state isolation follow-up |
| BROCA seq 659 / **68** / **78** | **74** Landed proactive token refresh, isolated gate vault builds, decoded Claustrum provider_ids, absorbed subc 0.28.1 | **72** Landed proactive token refresh, fixed gate vault builds, updated decoder, absorbed subc 0.28.1 | **74** Merged proactive token refresh, isolated vault builds, adopted provider_ids, absorbed subconscious 0.28.1 | **72** Landed proactive token refresh, isolated gate vault binaries, absorbed subconscious 0.28.1 updates | **70** Landed proactive token refresh, isolated vault test builds in gate.sh, absorbed subconscious patch releases | **72** Picked proactive token refresh, fixed gate vault schema skew, updated decoder, absorbed subconscious patch bumps |
| MC seq 2169 / **74** / **17** | **73** v0.45.0 release execution, r7 present_tools settlement, #619 re-review, Claude Code fallback fix | **68** v0.45.0 release execution, present_tools settlement, #619 re-review, bridge gate fix | **42** v0.45.0 release execution, present_tools settlement, #619 re-review, role-preset bridge fallback | **72** v0.45.0 release execution, present_tools settlement, #619 re-review, catalog bridge safety fix | **72** v0.45.0 release execution, present_tools settlement, #619 fixes, Claude Code bridge gate repair | **74** v0.45.0 release execution, present_tools settlement, #619 review fixes, role-preset legacy guard |
| MC seq 2155 / **74** / **5** | **74** PR #603 cubic finding fix, merged PR audit, automated review-findings merge gate | **72** PR #603 bounded-provider fix, cubic audit, merge gate, AFT gh-shim policy | **50** PR #603 cubic finding fix, historical PR review triage, merge-pr.sh gate | **62** PR #603 cubic finding fix, merged PR audit, merge-pr gate enforcement | **42** PR #603 cubic fix, external PR review audit, automated merge-pr.sh gate | **73** PR #603 bounded-provider fix, external PR review audit, automated review-findings merge gate |

### Text stability against both unchanged-prompt generations

Counts are exact matches of the **whole ordered output title array** or the **whole P1-body hash array**, out of thirty inputs. P1 extraction trims its outer whitespace. Diagonal self-comparisons are marked “self”; they are not noise measurements.

| Arm | Title arrays matching A | P1 arrays matching A | Title arrays matching A2 | P1 arrays matching A2 |
| --- | ---: | ---: | ---: | ---: |
| A | self | self | 0/30 | 0/30 |
| B | 0/30 | 0/30 | 0/30 | 0/30 |
| C | 0/30 | 0/30 | 0/30 | 0/30 |
| D | 0/30 | 0/30 | 0/30 | 0/30 |
| E | 0/30 | 0/30 | 0/30 | 0/30 |
| A2 | 0/30 | 0/30 | self | self |

A2 changes titles and P1 even on all nineteen cases whose first score stays identical to A. Thus the earlier observation that every B/C/D text differs from A is **not by itself evidence that the arms cause text changes**: an unchanged-prompt repeat already has the same zero-match result. This exact-equality measure is saturated and cannot rank how much semantic content changed. Example topics are recognizable, but semantic fidelity was not graded; arm-specific content distortion is neither proved nor ruled out. P1 hashes and character counts, rather than full P1 bodies, remain in the retained evidence.

## Cost and dispatch accounting

Kept trial: **180 completed cells** (the original 120 plus sixty E/A2 follow-up cells). Ten earlier D cells were superseded after correcting two harness defects; their spend remains included. One original subscription-protocol pilot was cancelled and has **no reported usage**. Total admissions: **191**, completed/measured model runs: **190**. The follow-up had sixty admissions, sixty completed runs and no extra retries, corrections or cancelled pilot. No automatic model retry/fallback loop was enabled by the harness.

| Reported tokens | Original kept 120 cells | Added E/A2 60 cells | Superseded 10 D cells | All measured 190 runs |
| --- | ---: | ---: | ---: | ---: |
| Uncached input | 11,936,018 | 6,290,654 | 1,003,643 | **19,230,315** |
| Cached input | 1,007,251 | 159,687 | 65,512 | **1,232,450** |
| Output, including reasoning | 982,737 | 495,078 | 67,355 | **1,545,170** |
| Reasoning subset of output | 740,912 | 373,395 | 50,002 | **1,164,309** |

Reasoning is already included in Broca output; it is **not** added a second time. Inputs are large because A retains the real project-memory prompt, not a cheap scoring proxy. Cache hits were opportunistic and not enforced equally across arms.

**Actual dollar debit is unknown:** the Antigravity route and returned usage do not supply a monetary charge/invoice. This is not a claim that the run cost $0. At an explicitly **illustrative**, not verified Gemini-3.8 tariff of $0.50/M uncached input, $0.05/M cached input and $3/M output, the follow-up adds **$4.64**. All 180 kept cells total **$13.61**; all 190 measured runs including superseded D total **$14.31**, versus **$9.67** before the follow-up. A fully consumed original cancelled pilot at its 32,000 output cap and the first input's size would add approximately **$0.15** at that illustrative tariff; its actual partial use cannot be recovered from returned telemetry. The follow-up stopped at the requested sixty calls, not when a preferred result appeared.

## Tool issues

- The large SQLite snapshot/scrub command hit a **120-second**, then a **600-second** timeout. `context.db` and `store.db` snapshots had completed. The second command had completed the 36-GiB OpenCode snapshot but was interrupted during a redundant post-scrub whole-file `VACUUM`, leaving a hot journal. Recovery and credential scrubbing were performed **on the copy only**, without another full vacuum. Disk pressure and size, not a model/data conclusion, explain these delays.
- Initial subscription used `from_seq: 0`; Broca returned `invalid_params`, naming the supported field `from`. The documented producer contract uses `from: "start"`. That pilot lineage was cancelled and not reused. Its missing usage is the small accounting gap above.
- D initially counted empty boundary-only markers, which the production renderer excludes. Also, a string replacement interpreted literal `$&` in historical prose, reinserting old reference blocks. Both defects were corrected before accepting final D evidence; **ten changed D prompts were rerun**, not all A/B/C arms. Final preparation verifies seven actual rendered references and unchanged transcript/memory/guard. The superseded runs are excluded from effect estimates but included in spend.
- The two new regression tests were non-vacuity-probed with staged-state mutations: removing empty-marker filtering failed only `D excludes empty boundary markers before counting and band selection`; restoring string-substitution semantics failed only `D preserves literal regex replacement syntax in historical prose`. Each filtered run had one failure and ten filtered-out tests. Mutations were restored before verification and commit.
- Follow-up snapshots and fixed-cohort restoration completed without a new timeout or protocol error. The E regression test was also non-vacuity-probed: returning D unchanged failed only `E hides only the recent four scores and keeps D's three diverse scores, seeds and text`, at the assertion that recent tags lack importance. It had one failure and eleven filtered-out tests; staged live state was restored before verification and commit. No model call was made with the mutation.
- A workspace-root `bun -e` could not resolve the plugin's `jsonc-parser`; running from `packages/plugin` resolved the installed workspace dependency. No install or manifest change was needed. The original phase's final AFT snapshot was partial for `core.ts` (no published diagnostics within the budget), and Markdown has no LSP producer. The follow-up's final scoped AFT snapshot was fresh and authoritative for six script files, with zero diagnostics; package/script `tsc` also passed. Tier-2 dead-code/duplicate analysis was unavailable in this worktree.

## Gaps and interpretation limits

1. Thirty inputs from three long-lived sessions are correlated and selectively retained. These descriptive estimates are not a population prevalence or a confidence interval for all historian runs.
2. Recorded user prompts are exact; twenty system prompts and OpenCode `high` provider-option parity are not independently historical-envelope-verified. Transport tools are disabled, so this trial tests prompt-only model behavior, not live tool-assisted historian execution.
3. A2 now supplies one independent unchanged-prompt repeat, with small score differences but ubiquitous exact text differences. It ran after the original A–D phase, not interleaved with it; provider/time drift cannot be fully excluded. There is still no fixed-title/P1 scoring-only control. Changed segmentation complicates all-compartment comparisons, and exact text inequality does not measure semantic distortion.
4. C varies all six numbers together, and shuffled scores can contradict reference text. It demonstrates susceptibility to reference labels, not which label position dominates, nor that deleting attributes is a quality-preserving fix.
5. D broadens example inputs but also changes their semantic content; its modest improvement does not establish independent scoring. E isolates hiding recent labels within D's exact layout and shows substantially reduced newest-score proximity beyond observed A2 score noise. It does not establish correct calibration, removal of older-example anchoring, or quality preservation. More repeats and a judged/fixed-summary scoring control would strengthen that claim.
6. Dollar billing and the cancelled pilot's partial token usage remain unknown. Sanitized evidence is durable; copied databases and full prompt/output bodies were deliberately not retained in git or the temporary root.

## Verification

- Bun **1.4.2**: `bun test scripts/importance-anchoring-trial/core.test.ts` — **12 passed**, 34 assertions, zero failures.
- TypeScript **5.9.3**: `bun run typecheck` in `packages/plugin` — passed, including the script project (`tsconfig.scripts.json`).
- Original prepared inputs — **30** provenance-matched pairs; **120** reference-count assertions; transcript, memory and guard scope checks passed. Follow-up restored the same thirty cases with **150 original prompt/system SHA-256 matches**, identical A2 prompts, and E retaining exactly three scored diverse references and four unscored recent references. Final analyzer retains **180** cells, including **60** new completed one-step/stop responses and the unchanged 120 original records.
- Sanitized retained evidence — **30 cases / 180 cells / 6,110 fields**, no forbidden raw prompt, P1 body, reasoning/event or credential fields; the original A–D response records are unchanged.
- Final scoped AFT diagnostics — **six script files authoritative**, zero errors/warnings/hints; Tier-2 structural analysis unavailable.
- No new production build was needed: only the report and investigative harness/artifact changed; the worktree's setup build had already passed. Package manifests and lockfiles are unchanged.
