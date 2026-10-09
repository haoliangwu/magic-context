# Memory reconcile-check shadow trial

Investigative code only: no product prompt or memory mutation. See
`docs/reports/memory-reconcile-check-trial.md` for results and limitations.
Use the installed repository dependencies and Bun 1.4.2. Every invocation has
an outer `timeout`, including the harness's internal Git capture commands.

## Reproduce

Run from this isolated checkout's repository root. The fixed private root is
`.tmp-memory-reconcile/` (already ignored by `.tmp-*/`). Never commit the copied
database, descriptor, full texts, captures, replies or grading packets.

```sh
timeout 30s bash -c 'umask 077; mkdir .tmp-memory-reconcile'
timeout 30s sqlite3 "file:$TMPDIR/magic-context/memory-trials/trial.db?mode=ro" \
  "VACUUM INTO '$PWD/.tmp-memory-reconcile/trial.db'"
timeout 30s cp "$HOME/.local/share/cortexkit/run/subc-connection.json" \
  .tmp-memory-reconcile/subc-connection.json
timeout 30s chmod 600 .tmp-memory-reconcile/trial.db .tmp-memory-reconcile/subc-connection.json
timeout 360s bun packages/plugin/scripts/memory-reconcile-check-trial/prepare.ts
timeout 2400s bun packages/plugin/scripts/memory-reconcile-check-trial/run.ts A
timeout 1800s bun packages/plugin/scripts/memory-reconcile-check-trial/run.ts B
timeout 30s bun packages/plugin/scripts/memory-reconcile-check-trial/review.ts
```

Preparation freezes the **unchanged** curate `evaluation.json` bytes, all 125
labelled IDs, an additional independent SHA-256-ranked 100 IDs, the snapshot
pool, retrieval and batch membership. Seed: `memory-reconcile-check-2026-10-06-v1`.
No labels influence retrieval. B reuses A's exact labelled prompts/cutoff.

Targets are batched in supplied order, at most five per call and 160,000 prompt
characters (a single unusually long target is kept complete). Retrieval compares
normalized existing same-model/dimension vectors against **strictly newer** active
rows, taking six cosine neighbors and two disjoint positive-scoring BM25 rows.
BM25 statistics use the eligible newer pool (`k1=1.2`, `b=0.75`). Missing target
vectors leave semantic slots empty, not falsely semantic lexical substitutions.
Texts are never truncated. Ages use the largest active `created_at` in the
snapshot, frozen across passes, rather than changing with execution time.

Repository evidence reuses curate's identifier extraction, single numbered
`git grep` capture, source allowlists and ranking. The ten-line budget allocates
five newest-design/errata hits and five source hits, backfilled from the curate
ranker's fifteen-line list. Each captured line is capped at 1,600 characters.
Unit tests are searchable and may omit runtime caller context. Missing hits are
not evidence of staleness. Private r7.3/errata are read-only supplied design context.

`run.ts` uses the curate credential path: a **copied** Broca connection descriptor,
`SubcClient`, fresh independent management-surface lineages, `session.send` and
`session.subscribe`. Model is explicitly `google/antigravity-gemini-3.8-flash`;
temperature is omitted, output cap 32,000, tools empty, three concurrent calls.
No fallback model, correction turn or inference retry. Completed artifacts resume
without resending; interrupted admitted runs reattach to their original lineage.
Malformed batches and length-limited terminals retain every target as `still_true`
and count all usage. `still_true` fallback is a no-write disposition, not a truth
certificate. The observed capped repetition is retained, not rerolled.

The input is readable prose; only the response wire format is JSON. Claims must
precede verdict/text. Replacement quotes must be verbatim (whitespace-normalized,
**not** markdown-stripped) within the specifically named provided newer memory or
path:line. Whole retirements cannot inventory surviving claims. Partial rewrites
reuse historian v2's `preservationGate` without changing its token recognizers.
This gate checks concrete literals, not logical contradiction, complete claim
coverage or faithful prose. Bare numbers without a recognized unit/backtick and
ordinary prose are not exhaustively guarded by v2's recognizer.

## Private review and checks

Read all 100 rows in `extra-texts.txt`, consulting `extra-review.txt` and actual
repository context without opening the action packet. Save ordered
`extra-labels.json` rows `{id,label,reason}` (`stale|true|unsure`) and the SHA-256
of its exact bytes in `extra-labels.sha256`. Then review every changed proposal in
`changed-review.json` against its target and complete sources in
`action-review.txt`. Save `action-grades.json` rows `{pass,id,grade,reason}`
(`correct|wrong|unsure`) in packet order and freeze `action-grades.sha256`.
Judgment files remain private; they are not a model scoring oracle.

```sh
timeout 180s bun run --cwd packages/plugin typecheck
timeout 60s bun test packages/plugin/scripts/memory-reconcile-check-trial/core.test.ts \
  packages/plugin/scripts/historian-merge-turn-trial/v2.test.ts \
  packages/plugin/scripts/curate-stale-retirement-trial/retrieval.test.ts
timeout 90s bun packages/plugin/scripts/memory-reconcile-check-trial/analyze.ts
```

The analyzer verifies copied snapshot identity, unchanged labels, sample
membership, recomputed neighbor retrieval, real excerpt bytes, 70 unique provider
runs, exact admitted prompts, gate recomputation and complete manual grading. It
also scans every committed harness/report deliverable for full active-memory
texts and raw responses. Its observed-terminal count asserts 69 stop + one length;
a fresh reproduction with different provider terminals must revise that explicit
run-count expectation rather than silently omit failures. Summary and all model
outputs stay inside the private root. No credential material is printed.
