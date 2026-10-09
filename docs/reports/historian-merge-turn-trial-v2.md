# Historian merge-turn trial v2: a better prompt, not yet a safe rewrite primitive

## Result and recommendation

**All forty cases and two additional fifteen-case repetitions are complete.** No first turn was regenerated and no memory was written. The v2 prompt materially improved preservation: in the primary pass, **10 of v1's 11 wrong merge/replaces decisions became correct**, as did its wrong update (**11/12 wrong rewrites fixed**, counting all three rewrite actions). However, three wrong rewrites remained, including two newly wrong decisions. The repetitions each still contained an accepted wrong rewrite.

The operator's criticism was justified: the one-line/free-form v1 prompt was not a fair ceiling on this model's reconciliation ability. The readable, claim-inventory prompt is substantially better. **It does not justify automatic destructive writes.** Use it in shadow/approval mode. The token gate is a useful backstop, not a semantic preservation verifier: it accepts a real quoted passage even when that passage does not contradict the claim being deleted, and a token can survive in the wrong context.

The treatment also moved errors elsewhere. Ranking twenty candidates down to eight discarded a useful long lexical memory, causing redundant `new` decisions. Strict schema validation rejected five primary batches; safe all-`new` fallback retained old knowledge but also reinserted already-known facts. These failures are included, not repaired away or excluded from the cohort.

## Design: what changed and why

The implementation is investigative code under `packages/plugin/scripts/historian-merge-turn-trial/`, not a change to the production historian or memory applier.

1. **Readable, ranked evidence.** Each fact gets its own heading and full prose, followed by eight candidates with ID, category, source, age at the original cutoff, hybrid rank score, and complete text. Scores rank evidence; they are explicitly not a correctness oracle. This reduces visual and token load without truncating individual memories.
2. **Rank fusion rather than adding incompatible score scales.** The supplied twenty-row lists contain fifteen semantic neighbours plus five lexical-only additions, not two comparable score distributions. V2 uses reciprocal rank fusion, `1/(60 + semanticRank) + 1/(60 + BM25Rank)`, over that retained union. BM25 ranks are recomputed against the complete eligible pool; semantic ranks are available only for the retained fifteen. Outside that fifteen the semantic contribution is absent, **not a measured zero cosine**. No new embeddings were needed. This is a bounded reranking experiment, not full-pool hybrid retrieval.
3. **Claims before prose.** Every proposed rewrite must inventory exact contiguous target clauses, mark each `keep` or `replaced`, and only then write the replacement text. A replaced claim requires a reason and a verbatim passage from the original transcript. Ancillary negative rules, exceptions and bounds are explicitly called out. This externalizes the preservation work instead of asking for a free-form summary.
4. **Narrow actions and target scope.** `skip` requires complete coverage by the selected target alone. Mere relatedness is not a merge. `update` requires the same property's demonstrated change; `replaces` requires explicit evidence that the old claim is false. Workarounds, silence and compatible measurements do not qualify. Uncertainty should select `new`.
5. **A deterministic gate outside the model.** `preservationGate` checks backticked spans, paths, numeric quantities with units, refusal/error codes, dotted/snake-case keys and camel-case identifiers. Missing concrete tokens reject a rewrite unless an exact target clause containing that token is marked replaced with a reason and a verbatim transcript passage. Invented target quotes, non-verbatim evidence, missing inventories, and update/replaces without evidenced replacement also reject. Evidence is searched only inside the actual `<new_messages>` transcript, XML-unescaped and whitespace-normalized, not in examples or old memory blocks. A rejected rewrite becomes `new`, inserting the original first-turn fact, not the rejected rewrite.
6. **One JSON object per fact, with a claim list.** The wire output remains a single JSON array. Invalid count/index/action/target/rewrite/claim schema rejects the entire batch to all `new`; there are no correction prompts, silent index repairs, or inference retries. Raw malformed proposals are still reviewed by output ordinal, separately from executable decisions.

All five suggested prompt ingredients were retained. The eight-candidate reduction was the least successful ingredient: with only partial semantic ranks, this fusion favoured two-lane candidates over the lexical-only long dist-retention memory. A follow-up should retain a dedicated lexical slot or evaluate full-pool RRF before further shrinking retrieval. That would be a new treatment, not a post-hoc improvement to this trial.

## Corpus, dispatch, and review protocol

- The supplied owner-private root was copied into **`$TMPDIR/magic-context/merge-turn-trial-v2-bg663b/`**, with private permissions. The original `merge-turn-trial-bg4916` root was not modified. Inputs, forty recorded first replies, twenty-row candidate lists, database, connection descriptor, and v1 judgments were reused. Captured prompts, full memories, model outputs, HTML and raw annotations remain outside git.
- Same model: **`google/antigravity-gemini-3.8-flash`**. Same production historian system hash: `f6a5a6dac2c8e29f0c4c54d3eb3c482b6159b9bfce76831cca01928de5ddc978`. Same Broca management route and `session.send` / `session.subscribe`, no tools, temperature **0.1**, max output **32,000**. Three cases concurrently within each pass; no alternate models.
- **Imported prior turns, not original-lineage continuation.** The recorded lineages already contained v1's second answers. To avoid seeing those answers, each v2 run used a fresh lineage and Broca `session.import` to install only the recorded user prompt and assistant first reply in their actual roles. `session.read` confirmed exactly those two messages, their roles and byte-identical concatenated text before dispatch. The unchanged system was supplied separately. This is not a claim to reproduce opaque provider-side first-turn reasoning state or cache state.
- All **70 runs** completed with exactly one provider step, `stop`, and a completed terminal event. The first strict schema failure stopped the initial driver invocation after case 6; completed replies were retained, and two already-admitted runs (8 and 9) were reattached, not resent. The driver then continued the remaining cases. The prompt and preservation rules were unchanged; schema fallback was added rather than repairing the malformed reply. Seven early artifact wrappers had a redundant proposal array removed after verifying their gates and effective decisions were unchanged.
- Primary pass **A: all forty cases / 139 facts**, including case 19's zero-fact continuation. Repetitions **B and C: fifteen cases / 76 facts each**. Total **291 reviewed decisions**.
- The brief's fifteen rewrite-concern cases were not present in the actual v1 ledger: wrong/debatable merge/update/replaces decisions occupy **thirteen cases**, `3,4,6,8,9,12,18,21,25,27,35,38,39` (eighteen decisions). The parent approved adding **1 and 31**, the two definite wrong-skip controls, to meet the fifteen-case budget. These are repeat controls, not mislabelled rewrite cases.
- Every v2 decision was read against its complete selected target, the retrieved pool, and relevant original transcript; whole-pool checks resolved coverage outside the shortlist. Correct means supported coverage/change with still-valid target knowledge retained. Wrong means lost information, unsupported coverage/change, incoherent graft, or inserting a fact fully covered by the older pool. Debatable means genuine scope, precision or action-choice ambiguity. Safe consolidation may be correct; redundant no-op consolidation remains debatable, as in v1.
- Review packets omitted v1 decisions, reasons and verdicts. Effective and raw semantic grades were completed first, with separate explanations for rejections, and all three annotation files were hash-frozen before the analyzer loaded the v1 verdicts for comparison. **Blinding limitation:** the reviewer had read the published v1 report and the repeat cohort was deliberately selected from its concern membership; this is verdict-hidden regrading, not a reviewer unaware of the earlier findings or inter-rater validation. No v1 grades were used as a scoring oracle.
- As in v1, eligibility is current snapshot `active` with `created_at < original run time`; absent status/revision history prevents a fully reconstructed historical pool. This trial retains that caveat rather than attributing every retrieval change to real historical knowledge.

## Primary results: all forty cases

### Effective decisions, after deterministic validation

| Action | Total | Correct | Wrong | Debatable |
| --- | ---: | ---: | ---: | ---: |
| `new` | 93 | 82 | 8 | 3 |
| `skip` | 10 | 8 | 0 | 2 |
| `merge` | 30 | 27 | 1 | 2 |
| `update` | 2 | 2 | 0 | 0 |
| `replaces` | 4 | 2 | 2 | 0 |
| **Total** | **139** | **121** | **11** | **7** |

For comparison, v1's effective totals were **112 correct / 14 wrong / 13 debatable**. V2's accepted rewrite error rate is **3/36 (8.3%)**, versus **12/52 (23.1%)** across v1's merge/update/replaces. The brief's **11/48** denominator excludes updates: v1 had eleven wrong merges/replacements among forty-eight such actions, plus one wrong update among four updates. These are descriptive rates over different action/target mixes, not a paired same-target prompt-only effect.

### Raw proposals, semantic grades before fallback

These include proposals in malformed batches, linked by array position for analysis only. The table does **not** claim they passed schema validation.

| Proposed action | Total | Correct | Wrong | Debatable |
| --- | ---: | ---: | ---: | ---: |
| `new` | 81 | 76 | 4 | 1 |
| `skip` | 16 | 12 | 0 | 4 |
| `merge` | 36 | 33 | 1 | 2 |
| `update` | 2 | 2 | 0 | 0 |
| `replaces` | 4 | 2 | 2 | 0 |
| **Total** | **139** | **125** | **7** | **7** |

Five batches (**6, 21, 26, 30, 31; 21 facts**) failed schema. Cases 6 and 21 used fact text instead of integer indices; case 26 used invalid indices; cases 30 and 31 selected a target available for another fact but outside that particular fact's shortlist. All twenty-one effective actions became `new`. This rejected six semantically safe rewrite proposals as part of batch abstention. It also turned four correct raw skips into wrong redundant insertions (`21:1`, `30:1`, `30:4`, `31:1`). A safe fallback is non-destructive, not necessarily correct deduplication.

The other four wrong `new` decisions are **`26:1`, `26:4`, `27:1`, `38:7`**, all fully covered by **#16288**, the long dist/chunk-retention rule. It was present in the original retrieval union but dropped by the top-eight ranking. The raw model correctly preserved many unrelated details in other targets while failing to see this one. The gate cannot validate new/skip coverage.

### Every remaining wrong merge/update/replaces

| Pass | Case:fact | Action / target | Failure and why the gate missed it |
| --- | --- | --- | --- |
| A | 2:1 | `replaces #18611` | Changing sibling path dependencies does not supersede the origin-agnostic runner boundary or the absence of a direct runner dependency. Both vanish. A real dependency-change quotation was incorrectly attached to the entire integration clause as “replaced”; the code checks quotation provenance, not logical contradiction. |
| A | 12:1 | `merge #23179` | “Termination/detaching” weakens the old detach-to-background guarantee without resolving the conflicting first-turn termination claim. The numeric duration survives; prose meaning does not. |
| A | 27:7 | `replaces #19889` | The host-filtered tool-set workaround does not remove the no-plugin-client permission API gap. Pi's limitation survives, but the OC2 API limitation is deleted. The model marks the whole target replaced with a valid but insufficient workaround quotation. |
| B | 35:1 | `replaces #23094` | Changing the paging sizing basis is used to treat the 64 KiB bound as obsolete and remove the >512 KiB trigger. The 64 KiB token remains only in the description of the old, allegedly replaced behavior; the target-wide replaced claim waives the other missing quantity. Literal presence plus a reason is not preservation. |
| C | 12:1 | `merge #23179` | “Terminate or detach” again fails to preserve a definite detach outcome. No concrete-token deletion occurs. |

There are **no accepted wrong updates**. The B rejection at `18:1` is an additional **wrong raw replacement**, not an accepted rewrite: it deletes the unchanged composition-versus-dedicated-preset distinction. Its supporting quotation ends in fabricated ellipsis text, so the evidence check rejected it to `new`.

### Which v1 wrong rewrites were fixed?

| Case:fact | V1 wrong action / target | A effective action | Outcome |
| --- | --- | --- | --- |
| 3:1 | merge #24492 | new | Fixed: stronger Rust opt-out precedence remains untouched. |
| 4:3 | merge #21817 | merge #21817 | Fixed: CPU saturation, event-loop blocking and cancellation all survive. |
| 6:4 | merge #7804 | new (schema fallback) | Fixed effectively; raw merge also preserves no-entitlements and all deployment rules. |
| 9:2 | replaces #24124 | merge #24124 | Fixed: ratios complement encryption and Gemini replay representation. |
| 12:1 | merge #23179 | merge #23179 | Still wrong: detach-versus-terminate is unresolved. |
| 18:1 | replaces #23845 | replaces #23845 | Fixed: role restriction changes, no-tag and composition/preset details survive. |
| 18:2 | merge #18618 | new | Fixed non-destructively; old target was ranked out. |
| 21:2 | merge #20243 | new (schema fallback) | Fixed non-destructively; raw proposal already chose new, and old target was ranked out. |
| 25:1 | merge #5027 | new | Fixed: old lazy indexing and database ownership remain untouched. |
| 27:3 | update #19889 | new | Fixed: new workaround does not erase Pi or the OC2 API gap. |
| 27:5 | merge #21026 | new | Fixed: unrelated smart-note target was ranked out; no graft. |
| 35:1 | merge #23094 | new | Fixed in A; B is wrong again, C preserves the bound in a merge. |

**11/12 are correct in A; none of those eleven fixes is a concrete-token gate catch.** Three are accepted preservation rewrites on the same old target; the other eight avoid rewriting the old target (including one schema abstention after a safe raw rewrite). Three old targets were not offered in the new shortlist. The treatment changed layout, ranking, action instructions, inventories and validation together; these counts cannot isolate claim lists from retrieval or `new` preference.

Across all passes, the preservation/evidence gate catches **one wrong raw rewrite** (B `18:1`) and misses **five wrong rewrite occurrences** (A's three, B `35:1`, C `12:1`). There were **no semantically correct valid rewrites rejected by the preservation gate**. Schema rejection is accounted for separately. No observed rewrite was caught specifically for literal deletion of `64 KiB` or a refusal code; unit and mutation tests prove that narrower capability, not an observed corpus catch.

## Noise: the same fifteen cases three times

Each repetition used identical first-turn text, prompt, candidates and settings but an independent imported lineage. A below is restricted to the same fifteen cases, not the forty-case total.

| Pass | Facts | Correct | Wrong | Debatable | Accepted rewrites | Wrong accepted rewrites | Schema-rejected cases |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A subset | 76 | 67 | 6 | 3 | 21 | 2 | 6, 21, 31 |
| B | 76 | 68 | 3 | 5 | 16 | 1 | None |
| C | 76 | 67 | 6 | 3 | 13 | 1 | 6, 21, 31 |

### Repetition per-action grades

Cells are **correct / wrong / debatable**.

| Action | A subset | B | C |
| --- | --- | --- | --- |
| new | 46 / 4 / 2 | 50 / 2 / 2 | 52 / 5 / 2 |
| skip | 3 / 0 / 0 | 6 / 0 / 0 | 4 / 0 / 0 |
| merge | 17 / 1 / 1 | 12 / 0 / 2 | 9 / 1 / 1 |
| update | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| replaces | 1 / 1 / 0 | 0 / 1 / 1 | 2 / 0 / 0 |

Only **53/76 (69.7%)** facts kept the same effective action **and target** across all three passes; **68/76 (89.5%)** kept the same correctness grade. These are action/target and grade stability, not byte-identical rewrite stability.

| Case:fact | A / B / C effective action | A / B / C grade | Meaning |
| --- | --- | --- | --- |
| 8:2 | merge / merge / merge #23402 | correct / correct / debatable | Explicit subsequent/per-turn timing in A/B, less reconciled snapshot/delta wording in C. |
| 9:2 | merge / replaces / merge #24124 | correct / debatable / correct | B preserves specifics but selects replaces for compatible ratios. |
| 12:1 | merge #23179 throughout | wrong / debatable / wrong | B retains definite detach but omits the new termination claim; A/C make the outcome ambiguous. |
| 21:1 | new / skip #23806 / new | wrong / correct / wrong | A/C schema abstention reinserts a known rule. |
| 27:7 | replaces / merge / replaces #19889 | wrong / correct / correct | B/C retain the API gap and Pi while revising only the OC1-only conclusion. |
| 31:1 | new / skip #23407 / new | wrong / correct / wrong | A/C cross-fact target rejection causes redundant insertion. |
| 35:1 | new / replaces / merge #23094 | correct / wrong / correct | The same paging evidence produces abstention, destructive replacement or preserving merge. |
| 38:1 | merge #9597 / merge #9597 / new | debatable / debatable / wrong | Safe but redundant consolidation versus redundant insertion; the better lexical target remains absent. |

These eight are **every grade-unstable fact**. The repetitions reinforce that a low-temperature prompt improvement is not a reliable write authorization mechanism. They are a deliberately concern-enriched subset, not an estimate of fleet-wide failure probability.

## Tokens and cache

Provider counters include the preceding exchange, unchanged system, and second message. Local prompt sizes use the repository's Claude BPE estimator, **not Gemini billing tokens**.

| Quantity, primary forty cases | V1 | V2 A |
| --- | ---: | ---: |
| Second user message only, local BPE estimate | 238,516 | 145,621 |
| Reported uncached input | 1,496,937 | 1,477,496 |
| Reported cached input | 212,750 | 143,187 |
| Reported total input | 1,709,687 | 1,620,683 |
| Output counter | 42,339 | 73,213 |
| Reasoning counter | 28,845 | 53,003 |

Second-message estimated size falls **38.9%**, but provider total second-turn input falls only **5.2%** because the unchanged first exchange dominates. Output increases **72.9%**; the separately reported reasoning counter increases **83.8%**. The inventory is not free. Reasoning and output counters are not added into a fabricated total.

| Provider usage | A, 40 cases | B, 15 cases | C, 15 cases | All 70 second turns |
| --- | ---: | ---: | ---: | ---: |
| Uncached input | 1,477,496 | 630,932 | 107,200 | 2,215,628 |
| Cached input | 143,187 | 16,366 | 540,098 | 699,651 |
| Total reported input | 1,620,683 | 647,298 | 647,298 | 2,915,279 |
| Output counter | 73,213 | 56,806 | 34,257 | 164,276 |
| Reasoning counter | 53,003 | 45,811 | 24,716 | 123,530 |
| Runs reporting cached input | 9/40 | 1/15 | 14/15 | 24/70 |
| Runs reporting reasoning | 15/40 | 7/15 | 4/15 | 26/70 |

All runs report input/output. **No run reports cache-write input**; omitted fields are unknown, not measured zero. B and C have exactly the same total reported input but dramatically different cache splits. C ran after B and benefited from recent identical prefixes despite separate lineages; this is strong order/cache confounding, not an intrinsic v2 latency or cost improvement. No dollar-saving claim is made.

The unchanged recorded first-turn input counters total **1,371,335**. Combining that historical first phase with A yields **2,992,018** reported input tokens, versus v1's **3,081,022**. This is a reuse accounting comparison, not seventy fresh two-turn trials or newly paid first-turn inference. Case 19 still costs **35,710** input tokens for an empty continuation; skipping it would be an additional optimization not applied here.

## Verification and limits

- Package TypeScript check: TypeScript **5.9.3**, `bun run typecheck`, including script compilation. Unit runner: Bun **1.4.2**, **18 tests / 64 assertions** covering both v1 controls and v2 ranking, readable layout, exact evidence scope, malformed schema, valid value changes, concrete-token boundaries (including hyphenated duration units) and fallback behavior. Extending duration-unit recognition after collection left all seventy stored gate outcomes unchanged on recomputation.
- Non-vacuity mutation: after staging the live implementation, bypassing only the `64 KiB` token check with a `NON-VACUITY BREAK` caused **only** `gate rejects a dropped 64 KiB bound and falls back to new` to fail; the other **17 tests passed**, including refusal-code rejection. The mutation had a one-line non-empty diff, was restored from the staged index, and left an empty unstaged diff before green re-verification and commit.
- `analyze-v2.ts` validates **70 independent lineages/runs, 291 complete unique judgments**, unchanged first-turn identities, the actual imported prior-role hashes, all completed provider events, exact candidate derivation and prompt hashes, and recomputed gate results. Annotation hashes are frozen before comparison.
- The copied and extended `trajectory-view.ts` renders v1 and all available v2 passes, full candidates, claims, raw proposals, effective actions, both grades, and schema/preservation rejections. Raw invalid batches are clearly labelled review-only. The all-case HTML smoke check confirmed **40 cases, 70 v2 sections, eight schema-rejection sections and the preservation rejection**. HTML stays inside the fenced private root; it is not a published corpus. **123 SHA-256 comparisons** confirmed the copied database, judgments, descriptor, forty inputs, first replies and staged candidate files still match the original root.
- Package lint passed through `bun run lint`, Biome **2.5.1**, checking **1,223 files** with no fixes. Two warnings and two informational diagnostics were pre-existing in unrelated files; TypeScript scripts are excluded from that lint configuration and are checked by the compiler/tests. Scoped TypeScript diagnostics were also clean. No manifests, production source, packaging or generated output changed; the worktree's initial install/build passed and no new product build is required for script/report-only changes.

Remaining limits: one reviewer; published-v1 prior awareness; nonhistorical status/content reconstruction; no prompt-only ablation; partial-semantic-rank shortlist; unknown hidden provider continuation state; no independent contradiction proof; and sequential cache-sensitive repetitions. The strongest supported conclusion is **better prompting substantially reduces careless literal/prose loss, while narrow deterministic token preservation alone cannot make arbitrary rewriting safe**.

## Reproduction

From `packages/plugin`, using the retained private copy, completed runs resume without redispatch:

```sh
timeout 1800s bun scripts/historian-merge-turn-trial/run-v2.ts "$TMPDIR/magic-context/merge-turn-trial-v2-bg663b" A
timeout 1800s bun scripts/historian-merge-turn-trial/run-v2.ts "$TMPDIR/magic-context/merge-turn-trial-v2-bg663b" B
timeout 1800s bun scripts/historian-merge-turn-trial/run-v2.ts "$TMPDIR/magic-context/merge-turn-trial-v2-bg663b" C
timeout 90s bun scripts/historian-merge-turn-trial/analyze-v2.ts "$TMPDIR/magic-context/merge-turn-trial-v2-bg663b"
timeout 60s bun scripts/historian-merge-turn-trial/trajectory-view.ts "$TMPDIR/magic-context/merge-turn-trial-v2-bg663b" 2,6,12,18,27,35,38,39
```

The private summary contains every action, both grades, gate outcome, reason, comparison row and repetition stability row. The following ledger publishes only reviewed IDs and explanations, not full facts, prompts or model replies.

## Appendix: every primary effective decision

**C** = correct, **W** = wrong, **D** = debatable. Ordinals refer to the unchanged first-turn facts. Cases 6, 21, 26, 30 and 31 are all-`new` schema fallbacks. All wrong decisions are explained above; the remaining debatable cases are Rust-refactor deferral scope (`9:1`), SHM-alone versus WAL-and-SHM coverage (`11:3`), differing grouping percentages (`13:2`), joint REST/GraphQL coverage (`30:3`, `31:3`), broad compilation versus HTTP-response cap (`34:2`), and redundant deployment consolidation (`38:1`). Complete per-fact review explanations remain in the private annotation ledger.

| Case | Fact ordinal: effective action and grade |
| --- | --- |
| 0 | 1: new **C** |
| 1 | 1: skip #24495 **C**; 2: merge #24579 **C**; 3: new **C**; 4: new **C**; 5: new **C** |
| 2 | 1: replaces #18611 **W**; 2: new **C** |
| 3 | 1: new **C**; 2: merge #24241 **C**; 3: new **C** |
| 4 | 1: new **C**; 2: merge #24241 **C**; 3: merge #21817 **C** |
| 5 | 1: new **C**; 2: merge #22704 **C**; 3: new **C**; 4: merge #24123 **C** |
| 6 | 1: new **C**; 2: new **C**; 3: new **C**; 4: new **C**; 5: new **C** |
| 7 | 1: new **C**; 2: new **C**; 3: new **C**; 4: merge #8858 **C** |
| 8 | 1: merge #14558 **C**; 2: merge #23402 **C**; 3: merge #24121 **C**; 4: new **C** |
| 9 | 1: new **D**; 2: merge #24124 **C**; 3: new **C**; 4: merge #24121 **C**; 5: new **C** |
| 10 | 1: new **C**; 2: new **C**; 3: new **C**; 4: new **C** |
| 11 | 1: merge #23996 **C**; 2: new **C**; 3: skip #21811 **D**; 4: skip #23997 **C** |
| 12 | 1: merge #23179 **W**; 2: new **C**; 3: new **C** |
| 13 | 1: merge #23987 **C**; 2: skip #23886 **D**; 3: new **C** |
| 14 | 1: new **C** |
| 15 | 1: new **C** |
| 16 | 1: skip #15874 **C**; 2: new **C**; 3: merge #23609 **C**; 4: merge #22702 **C** |
| 17 | 1: new **C**; 2: new **C**; 3: new **C** |
| 18 | 1: replaces #23845 **C**; 2: new **C**; 3: new **C**; 4: merge #23609 **C**; 5: new **C** |
| 19 | No facts; [] |
| 20 | 1: new **C** |
| 21 | 1: new **W**; 2: new **C**; 3: new **C** |
| 22 | 1: new **C**; 2: new **C** |
| 23 | 1: new **C**; 2: update #23697 **C** |
| 24 | 1: new **C**; 2: skip #23678 **C**; 3: update #23697 **C**; 4: new **C** |
| 25 | 1: new **C**; 2: merge #21964 **C**; 3: new **C**; 4: merge #22708 **C**; 5: merge #20547 **C**; 6: new **C** |
| 26 | 1: new **W**; 2: new **C**; 3: new **C**; 4: new **W**; 5: new **C** |
| 27 | 1: new **W**; 2: skip #23505 **C**; 3: new **C**; 4: new **C**; 5: new **C**; 6: skip #23505 **C**; 7: replaces #19889 **W**; 8: new **C**; 9: new **C**; 10: new **C**; 11: new **C** |
| 28 | 1: merge #18874 **C** |
| 29 | 1: new **C**; 2: new **C** |
| 30 | 1: new **W**; 2: new **C**; 3: new **D**; 4: new **W** |
| 31 | 1: new **W**; 2: new **C**; 3: new **D**; 4: new **C** |
| 32 | 1: new **C**; 2: merge #20352 **C** |
| 33 | 1: new **C** |
| 34 | 1: new **C**; 2: merge #22709 **D** |
| 35 | 1: new **C**; 2: new **C**; 3: new **C** |
| 36 | 1: replaces #20900 **C**; 2: skip #22709 **C** |
| 37 | 1: new **C**; 2: new **C**; 3: merge #23280 **C**; 4: skip #23281 **C** |
| 38 | 1: merge #9597 **D**; 2: new **C**; 3: merge #5072 **C**; 4: new **C**; 5: new **C**; 6: merge #5072 **C**; 7: new **W**; 8: new **C**; 9: new **C** |
| 39 | 1: new **C**; 2: new **C**; 3: new **C**; 4: merge #20988 **C**; 5: merge #14125 **C**; 6: new **C**; 7: new **C** |
