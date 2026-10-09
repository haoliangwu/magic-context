# Memory reconcile-check trial: narrower questions help, quotations do not authorize deletion

**2026-10-06 · Recommendation: shadow/approval mode only.**

All **225 primary targets** and the **125-target repetition** are complete on
`google/antigravity-gemini-3.8-flash`. The readable, claim-first reconciliation
prompt found **6/21 labelled stale memories** initially and **4/21** on repetition.
It did not exceed the curate evidence arm's initial stale-detection recall, and
it still accepted destructive semantic errors. A real quote can be irrelevant,
incorrect, or support replacing only part of a compound claim.

**No memory was changed.** Only an investigative harness and this report are
committed. Stored memory texts, proposed rewrites, prompts, model replies,
vectors, credentials and grading packets remain in the ignored private trial
root, not in Git. No production prompt, ARCHITECTURE.md or STRUCTURE.md changed.

## Inputs, retrieval and execution

- Supplied read-only `$TMPDIR/magic-context/memory-trials/trial.db`, copied with
  SQLite `VACUUM INTO` into this worktree's owner-private
  `.tmp-memory-reconcile/`. No live memory store or config was opened.
- Repository baseline: **`6b1b55cd8052d90d847bcda564edf0fc7e6f36e2`**. Subsequent
  trial commits change no source used as evidence. Private hydrated r7.3 and
  errata were read as design evidence, never modified.
- Active pool: **1,299**. Frozen curate cohort: **125 = 21 stale + 81 true +
  23 unsure**. `evaluation.json` was reused **byte-for-byte**, with SHA-256
  `fbeb7ff3b803cfa52b07b83e71d7f0d6bcb36e3f7c3d592b6afa843c8f5a48eb`.
  No relabelling, including the caller-supplied #18939 control.
- Extra cohort: **100 distinct other active memories**, SHA-256-ranked without
  replacement by seed `memory-reconcile-check-2026-10-06-v1`, independent of row
  order. All 100 were read and separately graded; no model verdicts appear in
  the extra grading packet. Labels were frozen before opening the action packet.
- Each target gets its full text, category, source, and age at the snapshot's
  latest active creation time (**2026-10-06 08:12:01.058 UTC**). Ages are frozen
  across passes. No ground-truth labels are shown to the model.
- Newer evidence: **six cosine-similarity slots plus two BM25-only slots**,
  cross-category, strictly `created_at > target.created_at`. The two lexical
  slots exclude the semantic six, rather than being crowded out by rank fusion.
  BM25 uses the eligible newer pool (`k1=1.2`, `b=0.75`). Existing normalized
  **1,292 compatible 4,096-dimensional vectors** were used, with no embedding
  calls. Targets without vectors have only lexical slots; late targets may
  have fewer neighbors. Similarity is a retrieval aid, not a truth score.
  Actual primary retrieval supplied **1,344 semantic + 446 lexical neighbors**;
  #24670, the latest target, had no newer semantic neighbor.
- Real repository evidence reuses curate's `retrieval.ts` identifier vocabulary,
  single timeout-bound numbered Git capture, allowlists and ranker. Allocation
  is **five newest-design/errata + five source lines**, backfilled from that
  ranker's fifteen-line result. All **225 targets received ten real lines**,
  **2,250 lines per primary pass**, each capped at 1,600 characters. Full memory
  texts are not truncated. Unrelated identifier hits and source unit tests remain
  possible; missing context is not evidence of staleness.

### Treatment

Targets are in small, readable prose batches: **five per call**, 25 labelled
and 20 extra calls in A; **the exact same 25 labelled prompts** in B. There is a
160,000-character batch ceiling, which did not split these batches. The input
is not a JSON memory dump; only the reply wire format is JSON.

The one question per target is whether **any claim is no longer true**, given
the supplied newer memories and repository lines. The model must inventory exact
target clauses **first**, including exceptions, constraints, negatives and
bounds, then return `still_true`, `partly_replaced` with complete surviving text,
`replaced`, or `unsure`. Each replaced clause names a provided memory ID or
path:line, a reason, and a verbatim supporting passage. Relatedness, silence,
workarounds, a different harness/caller, and older revision citations do not
suffice. A whole retirement may not inventory a surviving claim.

Partial rewrites reuse historian v2's **unchanged `preservationGate`**: literal
identifiers, paths, quantities/units, config keys and error codes must survive
unless their own exact target clause is marked replaced with evidence. The
additional provenance gate checks each quote against its **specifically named
provided source**, not examples, the target, or another target's evidence.
Whitespace is normalized; markdown is **not** stripped. A rejected answer becomes
`still_true`, retaining the original text. That fallback means **no write**, not
a positive truth certification. Like v2, the gate cannot prove inventory
coverage, logical contradiction or prose preservation, and bare numbers without
a recognized unit/backtick are not exhaustively protected.

### Model and failures retained

Same curate credential route: **copied Broca 0.3.183 connection descriptor**, SubcClient
management surface, `session.send` / `session.subscribe`, fresh independent
lineages, no tools. Model is explicitly the requested production dreamer model;
temperature is **unspecified/omitted**, as in curate, **not** historian v2's 0.1.
Output cap: **32,000**. Three concurrent calls; no fallback model, correction
turns or automatic inference retries.

All **70 unique runs** reached a terminal with one provider step. **69 stopped
normally; B-labelled-7 hit `length`** at 31,996 reported output tokens. The initial
driver stopped on that terminal; it was resumed from the **same stored raw run**,
not resent. Its five targets are included as unchanged schema fallback, and its
full cost is included. **B-labelled-19** stopped normally but returned four objects
for five targets; that entire batch also fell back unchanged. A had no schema
failures. The prompt and gate were not tuned after observing replies.

## Precision and recall: distinguish detection from safe action

Two different quantities matter:

1. **Label-based detection precision**: among changed verdicts on known labels,
   stale / (stale + true). Unsure-label actions are separate, not credited.
   Recall is changed stale / 21, even when a proposed correction is semantically
   unsafe. This preserves the frozen curate labels as the scoring oracle.
2. **Independently reviewed action precision**: a `replaced` action is correct
   only if the whole substantive claim is obsolete with adequate support;
   a `partly_replaced` action must remove the stale part **and preserve all valid
   parts**, without leaving stale assertions as current prose. Known precision
   is correct / (correct + wrong), with unresolved actions shown separately.

### One comparison table with all three curate arms

Curate metrics are copied from its report, not rerun. Its recall counts **whole
retirements only**; reconcile's combined recall also counts partial repairs.
The separate whole-retirement row makes that mismatch explicit. Curate updates
were not independently certified, so they are not retroactively added to recall.

| Metric | Curate category text | Curate evidence | Curate topic text | Reconcile A labelled | Reconcile B labelled |
|---|---:|---:|---:|---:|---:|
| Labelled targets | 125 | 125 | 125 | 125 | 125 |
| Changed stale: whole / partial | 0 / not graded | 6 / not graded | 1 / not graded | **2 / 4** | **3 / 1** |
| Changed true: whole / partial | 0 / not graded | 1 / not graded | 0 / not graded | **1 / 0** | **2 / 1** |
| Changed unsure: whole / partial | 0 / not graded | 0 / not graded | 0 / not graded | 0 / 0 | **1 / 0** |
| Known label-based precision, combined | Undefined | 85.7% (6/7) | 100% (1/1) | **85.7% (6/7)** | **57.1% (4/7)** |
| Labelled stale recall, combined | 0.0% | 28.6% | 4.8% | **28.6% (6/21)** | **19.0% (4/21)** |
| Whole-retirement recall only | 0.0% | 28.6% | 4.8% | **9.5% (2/21)** | **14.3% (3/21)** |
| Reviewed true memories not changed | 81/81 retired-only | 80/81 retired-only | 81/81 retired-only | **80/81** | **78/81** |
| Unsure labels not changed | 23/23 retired-only | 23/23 retired-only | 23/23 retired-only | **23/23** | **22/23** |
| Calls in the reported arm | 5 (all 1,299) | 32 (all 1,299) | 17 (all 1,299) | 25 | 25 |
| Provider input tokens | 122,840 | 1,914,963 | 128,518 | 224,748 | 224,748 |
| Provider output tokens | 41,617 | 278,607 | 156,199 | 103,037 | 98,411 |

The initial reconcile pass detects **20482, 20484, 20485, 20643, 21117, 21127**.
It misses fifteen stale labels: **20483, 20597, 20635, 20638, 20773, 20775,
20778, 20781, 21061, 21118, 18939, 21814, 18327, 21066, 8480**. #20638 was a
substantively correct raw retirement rejected for a non-verbatim quote. B detects
**20638, 20643, 21127, 21814**. The caller-supplied #18939 stays unchanged in both;
excluding it changes combined recall to 6/20 and 4/20, not the recommendation.

### Each action's precision, after gates

Counts below include all 225 A targets and the labelled-only B repetition.
"Conservative" counts unresolved actions as errors. An unsafe action on a stale
memory can be a label-based true positive **and** an independently wrong action.

| Pass / action | Accepted | Stale / true / unsure labels | Label-based known precision | Semantically correct / wrong / unresolved | Reviewed known precision | Reviewed conservative precision |
|---|---:|---:|---:|---:|---:|---:|
| A `replaced` | 5 | 3 / 1 / 1 | 75.0% (3/4) | **2 / 2 / 1** | **50.0% (2/4)** | 40.0% (2/5) |
| A `partly_replaced` | 6 | 5 / 1 / 0 | 83.3% (5/6) | **4 / 2 / 0** | **66.7% (4/6)** | 66.7% (4/6) |
| B `replaced` | 6 | 3 / 2 / 1 | 60.0% (3/5) | **2 / 2 / 2** | **50.0% (2/4)** | 33.3% (2/6) |
| B `partly_replaced` | 2 | 1 / 1 / 0 | 50.0% (1/2) | **0 / 2 / 0** | **0.0% (0/2)** | 0.0% (0/2) |

Across A, label-based combined precision is **80.0% (8/10 known)**, but reviewed
action precision is **60.0% (6/10 known)**, with one unresolved retirement. Four
accepted actions are wrong. B has four wrong accepted actions again. On the
labelled stale denominator, **safe-action recall** is **5/21 (23.8%)** in A and
**2/21 (9.5%)** in B; this stricter measure does not credit bad partial repairs
or an unresolved full-compound retirement simply because its label is stale.

### Every independently wrong changed proposal

| Pass / ID | Action | What goes wrong | Independent evidence / why the gate misses it |
|---|---|---|---|
| **A #20484** | Accepted partial | The old vocabulary changes, but the cost ladder and declared-segment-position semantics still hold. Waiving the entire compound clause deletes that valid structure rather than merely updating the names. | r7.3:1413–1417 retains positional rungs, cheaper-point applicability and distinct costs. The quoted newer vocabulary only justifies changing names; the gate accepts a target-wide token waiver. |
| **A #6643** | Accepted whole | An erroneous repository comment is treated as truth about the SQLite engine, invalidating the old caution wholesale. | A synthetic in-memory probe on **Bun 1.4.2** found **null** from both raw `bun:sqlite` and the shared adapter for a no-row `.get()`. `migrate-session.ts:209` claims a difference not observed here. A verbatim comment is not execution evidence. |
| **A #20458** | Accepted whole | Correctly identifies obsolete sequential fetching, but removes the entire compound memory, including the still-valid dependency on finalized tool names and refetch-on-drift requirement. | r7.3:239,257 and ALF errata:56 explicitly retain those dependencies while requiring parallel fetches. All claims are bundled into one replaced clause, so the inventory gate cannot see surviving truth. |
| **A #6850** | Accepted partial | Adding `setup` to the default-export object is treated as repeal of the positive object-shape requirement. Surviving prose retains only the ban on named exports. | `index.ts:1155–1168` explains why the object shape bypasses the legacy factory scan and still exports an object. An additional property is compatible, not a contradiction. |
| **A #20204** | Raw whole, rejected | Compatible foreground variants are misread as repeal of tool-reference closure. | r7.3:170 requires every returned tool/text reference to resolve. A variant without a companion-tool reference satisfies that rule. A's markdown-stripped quote happens to fail provenance, preventing this write for a syntactic—not semantic—reason. |
| **B #20643** | Accepted partial | Uses an intermediate replacement memory, then leaves the self-asserted session-reference bind mechanism in surviving text as if current. It detects staleness but does not finish repairing it. | r7.3:339,342 replaces the old request identity shape with verified scopes. Literal preservation does not verify that the surviving assertion is still current. |
| **B #20204** | Accepted whole | Same closure error as A, now with a genuinely verbatim quotation, so the gate accepts it. | Same r7.3:170 evidence. This is the clearest observed demonstration that quote correctness is not contradiction correctness. |
| **B #6643** | Accepted partial | Again invents a Bun/Node difference from the comment, this time rewriting the caution as Node-only. | Same independent synthetic engine probe. No kept concrete token has to disappear for the semantic scope to become false. |
| **B #20104** | Accepted whole | New provider role names are treated as replacing the exclusive reduction-owner constraint itself. | r7.3:53 still allows **at most one compaction provider**. Separating compaction and step transforms is compatible with, not a negation of, that constraint. |

The **eight accepted wrong occurrences** span seven IDs. Frozen labels were not
modified to reflect action quality or resolve the comment discrepancy.

### Every unresolved accepted action

- **A #8629 (`replaced`, extra unsure label):** role partitioning alone does not
  establish repeal of the external five-class harness contract, exclusive
  compaction, or trailing result-decoration boundaries. Not credited as correct.
- **B #21814 (`replaced`, frozen stale control):** supplied quotes establish
  parenting/removal/compaction support, but do not independently establish that
  **every** listed upstream capability and duplicate-issue directive is obsolete.
  It earns frozen-label detection credit, not safe whole-retirement credit.
- **B #8318 (`replaced`, frozen unsure):** a newer memory asserts lineage state,
  but the external Thalamus implementation is not independently verifiable here.

## Unsure handling and deterministic rejections

A emits **six** effective `unsure`: labelled stale **21061**, extra stale
**20108, 21026**, and extra true **23697, 7042, 16531**. **None** of the 45
ground-truth unsure memories in A receives that verdict: 44 are unchanged and
one (#8629) is retired. Thus the prompt is conservative about many claims but
does **not** reliably identify epistemic uncertainty as such. `still_true` means
no demonstrated contradiction, not independent verification of every assertion.

B emits **zero** effective `unsure`: 22/23 frozen unsure labels stay unchanged,
and #8318 is retired. Ten targets fall back unchanged due to the capped and
wrong-count batches. No silent exclusions or corrected replies are scored.

A's two provenance rejections are **#20638** (correct raw retirement) and
**#20204** (wrong raw retirement). Both remove markdown characters from source
quotes. B copies those quotes correctly and both pass, one helpfully and one
destructively. **No observed partial rewrite was rejected by the concrete-token
gate.** Its unit/mutation controls demonstrate a narrow capability, not a corpus
semantic catch. Keeping the real runtime caller context and testing apparently
load-bearing code comments would address hazards that literal gates cannot.

## All 100 extra memories: pool-wide estimate

Manual prevalence grading yields **7 stale, 71 true, 22 unsure**, frozen before
action review (hash `a3797a3f94dda9fd44c0875b55aeb5af32d86d3fdccabbd467d06d02af2646da`).
The seven stale IDs, with independently sourced reasons:

| ID | Why stale at the repository baseline | A outcome |
|---|---|---|
| 19889 | OC2 host-filtered tools now suppress denied `ctx_reduce` without needing the missing permission API (`v2/hooks/context.ts:498–518`); underlying API/Pi limitations remain. | Unchanged |
| 24670 | Push/release daemon builds use the default-branch sibling checkout, not the claimed distinct pinning policy (`ci.yml:643–648,697`; `release.yml:349–353,393`). | Unchanged |
| 21429 | Restricting local clients on OpenCode/Pi heads is explicitly deferred (`r7.3:336,446`). | Correct partial |
| 20458 | Final-tools fetches are explicitly parallel (`r7.3:239`; ALF errata:56). | Wrong whole: valid companion claims lost |
| 20206 | Current separate provider roles/catalog contract replaces the old monolithic extension-query mechanism (`r7.3:210,239`). | Unchanged |
| 20108 | Same monolithic capability identifier is no longer the current role interface. | Unsure |
| 21026 | HTTP response limit is now 1 MiB (`smart-notes/ssrf-guard.ts:58`); 64 KiB bounds compiled-check/file content, not HTTP. Weekly retries and 404 handling survive. | Unsure |

The four changed extras are **#21429, #20458, #8629, #6850**: label-based
**2 stale / 1 true / 1 unsure**, but action review finds **1 correct / 2 wrong /
1 unresolved**. Extra known detection precision is **66.7% (2/3)**; safe-action
precision is **33.3% (1/3 known)**, or **25.0%** treating unresolved as errors.
Extra stale-detection recall is **28.6% (2/7)**; safe-action recall is **14.3% (1/7)**.

The random hundred samples the **1,174-memory remainder**, not the enriched
labelled cohort. Its **7% confirmed-stale rate** has an approximate Wilson 95%
interval of **3.4–13.8%**, before finite-population correction and judgment error.
Weighting the fixed labelled stratum separately estimates about **103 confirmed
stale memories (7.9% of the 1,299 pool)**, plus **281 unresolved (21.7%)**. This
does not declare the unresolved group true or false.

For an exploratory projection of the same treatment over the whole pool, A's
seven labelled changed verdicts plus the remainder's observed **4%** change rate
estimate **54 proposals**, roughly **29 stale detections, 13 true-memory changes
and 12 unresolved changes**. These are fractional survey estimates rounded to
whole memories, **not 1,299 actual verdicts**. Weighting action-quality judgments
instead yields approximately **17 correct / 25 wrong / 12 unresolved proposals**;
four extra actions make that extrapolation extremely noisy. The supported
observation is the actual **one wrong change to a true extra** plus the unsafe
whole retirement of a partly stale extra, not a precise fleet error probability.

### Complete extra-label census (IDs only)

All 100 received a judgment, including unchanged and unsure outputs. True labels
include stable process rules and compatible scoped/historical claims; an old
citation or an unobserved external incident alone was never a stale label.
Unverifiable compound external claims remain unsure, rather than being rewarded
as correct deletions.

- **Stale (7):** 19889, 24670, 21429, 20458, 20206, 20108, 21026.
- **Unsure (22):** 7667, 12699, 21674, 18613, 20786, 24239, 21877, 21021,
  16286, 21154, 18924, 20308, 8629, 18826, 12660, 21530, 17334, 24077,
  9978, 20192, 5076, 22061.
- **True (71):** 8879, 23388, 12631, 21537, 21529, 11984, 15755, 8191,
  20101, 8540, 23697, 20355, 9147, 7996, 20698, 7640, 20770, 8392, 5173,
  18591, 21029, 22062, 5695, 20205, 15381, 15150, 22064, 21345, 7257,
  21435, 19948, 22602, 20543, 7836, 18592, 21522, 18884, 23984, 7405,
  6099, 15976, 20986, 22701, 19842, 7042, 23806, 20346, 19672, 17378,
  20313, 22531, 23369, 21635, 7893, 21431, 22709, 21825, 18379, 21540,
  18237, 4973, 21428, 23765, 5189, 16006, 21535, 21536, 6850, 21440,
  21873, 16531.

## Repetition noise

Effective verdicts agree on **113/125 (90.4%)**, dominated by unchanged memories.
Only **three** changed-target IDs recur in both passes (#20643, #21127, #6643),
and only **two** detected stale IDs recur (#20643, #21127). The changed-target
intersection over union is **3/12 (25.0%)**; stale detections' is **2/8 (25.0%)**.
High overall agreement therefore does not imply stable useful actions.

| ID | A | B |
|---|---|---|
| 20482 | partial | unchanged |
| 20484 | partial | unchanged |
| 20485 | partial | unchanged |
| 20638 | unchanged (quote rejection) | whole |
| 20643 | whole | partial |
| 21061 | unsure | unchanged (capped batch fallback) |
| 21117 | partial | unchanged |
| 21814 | unchanged | whole |
| 20204 | unchanged (quote rejection) | whole |
| 6643 | whole | partial |
| 20104 | unchanged | whole |
| 8318 | unchanged | whole |

These are every effective-verdict difference. The capped/wrong-count batches are
part of this operational noise measurement; excluding them after the fact would
make the treatment look more reliable than the observed execution.

## Cost

Provider counters, including all retained failures/fallbacks:

| Pass / cohort | Calls | Input | Output | Reported reasoning* | Sum of call durations |
|---|---:|---:|---:|---:|---:|
| A labelled | 25 | 224,748 | 103,037 | 83,335 | 292.0 s |
| A extra | 20 | 182,490 | 52,773 | 38,175 | 157.7 s |
| **A total** | **45** | **407,238** | **155,810** | **121,510** | **449.7 s** |
| B labelled | 25 | 224,748 | 98,411 | 78,803 | 306.0 s |
| **Both passes** | **70** | **631,986** | **254,221** | **200,313** | **755.7 s** |

\* Reasoning is a component of output, not an extra billable total. It is reported
in **40/70** runs; omitted fields are unknown, not measured zero. No cache-read or
cache-write counter was supplied. No dollar cost is inferred from subscription
token counters. Durations are summed overlapping calls, not wall-clock elapsed
time, and exclude preparation/review. B's capped call alone consumed **8,265
input / 31,996 output / 30,719 reasoning** tokens. The same A prompt already used
31,636 output tokens, showing that small batches do not bound reasoning spend.

Compared with curate, per-target evidence and eight full newer texts add input,
and explicit inventories add output. A labelled-only input already exceeds the
category-text arm's full-pool input. The arms have different coverage, tools,
questions and output schemas; token totals are descriptive, not a matched cost
efficiency experiment or a prompt-only causal estimate.

## Verification, limits and recommendation

The harness's compiler, synthetic controls and actual-artifact analyzer verify
the mechanical treatment separately from semantic grading. The analyzer checks
unchanged label bytes, copied database identity, random membership, all retrieved
neighbor identities/scores, real excerpt bytes, exact admitted prompts, 70 unique
lineages/runs, complete provider terminals/usage, recomputed gates, all 100 extra
labels and all 21 changed raw proposal grades. It scans deliverables for full
active-memory texts and raw model replies. Grading hashes stay private except
their identities; action grades hash:
`5e48826bec1f63929559b3d46b17e699206721f3ecbd02b752600934f819e77a`.

Verification gates:

- **TypeScript 5.9.3:** `timeout 240s` around the plugin's `bun run typecheck`
  plus targeted tests; the script compiles the retina build config, plugin
  source and `tsconfig.scripts.json`, exit 0.
- **Bun 1.4.2:** reconcile core, historian v2 and curate retrieval tests:
  **24 tests / 87 assertions**, all passed. These include named-source quote
  provenance, cross-source/target rejection, partial literal preservation,
  surviving-claim whole-retirement refusal, malformed fallback, unsure
  abstention, strictly-newer 6+2 retrieval and row-order-independent sampling.
- **Biome 2.5.1:** plugin `bun run lint`, **1,224 files**, passed with two
  pre-existing warnings and two informational diagnostics in unrelated files.
  Trial TypeScript scripts are excluded by that lint configuration; compiler
  and unit tests check them instead. Initial scoped diagnostics covered **six
  source files with zero errors/warnings**. After reversible controls, IDE
  inspection twice left `core.ts` pending; the final authoritative compiler
  check passed for all scripts, including the byte-restored gate.
- **Bun 1.4.2 actual-artifact analyzer:** **five checks passed**, covering
  **70 runs / 350 decisions**. It reopens only the copied trial database.
- **Three staged/reversible `NON-VACUITY BREAK` controls:** allowing the missing
  refusal code made only **`partial gate rejects a dropped refusal code and
  retains original memory`** fail, while bound/evidence controls and the other
  ten tests passed. Allowing a fabricated quotation made only **`whole retirement
  requires a quote from the named provided source`** fail, while partial
  preservation and cross-source controls and the other ten tests passed.
  Copying an actual target sentence into this report made only **`deliverables
  contain no full active memory or raw model response`** fail; the other four
  artifact checks passed. Each break had a non-empty Git diff, was restored
  from staged live state, and left an empty unstaged diff before green checks.

No package manifests, lockfiles, production source or generated outputs changed;
the prepared worktree's install/build passed, and no additional product/native
build was needed for investigative scripts and documentation.

Limitations: single reviewer; verdict-hidden extra grading **not full blinding**
(prior curate/historian reports were read); 22/100 extra uncertainties; frozen
labels judged against an earlier source baseline; retrieved evidence may omit
callers and may contain misleading comments; semantic gates do not check complete
clause coverage or contradiction; older neighbor memories may themselves be
stale; no prompt-only ablation, inter-rater check, or monetary billing evidence.
Repetition is sequential and provider-side hidden reasoning/cache state is not
controlled. Private artifacts remain ignored for inspection/reproduction rather
than being shipped as a memory corpus.

**Do not deploy this as an automatic deleter or rewriter.** The v2 shape makes
the reasoning auditable and recovers some stale claims, but accepted errors
still involve precisely the preservation failures it was meant to prevent:
compatible implementation changes presented as repeal, a true quote attached
to too broad a replaced clause, and an untested comment overriding real engine
behavior. Use a human approval gate. A next trial should test claim-level
contradiction and surviving-prose coverage, richer caller context, and evidence
authority—not simply require another quotation or relax the syntactic gate.

Reproduction commands and private grading schema:
`packages/plugin/scripts/memory-reconcile-check-trial/README.md`.
