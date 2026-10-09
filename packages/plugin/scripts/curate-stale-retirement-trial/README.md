# Curate stale-retirement shadow trial

Investigative scripts only. No product prompt, memory mutation, live configuration or embedding provider is used. Read the report at `docs/reports/curate-stale-retirement-trial.md` before interpreting the numbers.

## Reproduce

Use Bun 1.4.2 with the repository's installed dependencies. Run from the repository root, in an isolated worktree. Every shell invocation, including internal Git reads, has an outer `timeout`. `.curate-trial/` is the private throwaway root; never commit it. Its copied database, descriptors, prompts, excerpts, vectors and raw responses are sensitive.

```sh
timeout 15s mkdir -m 700 .curate-trial
timeout 15s sqlite3 "file:$TMPDIR/magic-context/memory-trials/trial.db?mode=ro" \
  "VACUUM INTO '$PWD/.curate-trial/trial.db'"
timeout 15s cp "$HOME/.local/share/cortexkit/run/subc-connection.json" .curate-trial/subc-connection.json
timeout 15s chmod 600 .curate-trial/trial.db .curate-trial/subc-connection.json
timeout 30s bun packages/plugin/scripts/curate-stale-retirement-trial/prepare.ts
timeout 600s bun packages/plugin/scripts/curate-stale-retirement-trial/arrange.ts
timeout 3400s bun packages/plugin/scripts/curate-stale-retirement-trial/run.ts text
timeout 3400s bun packages/plugin/scripts/curate-stale-retirement-trial/run.ts evidence
timeout 2400s bun packages/plugin/scripts/curate-stale-retirement-trial/run.ts topic
timeout 30s bun packages/plugin/scripts/curate-stale-retirement-trial/analyze.ts text evidence topic
timeout 30s bun packages/plugin/scripts/curate-stale-retirement-trial/export.ts
timeout 60s bun packages/plugin/scripts/curate-stale-retirement-trial/verify.ts
```

The preparation script requires exactly the committed cohort; a newer snapshot must not silently substitute different ids or labels. Labels were frozen before the first pass. Outside-retirement judgements were made afterward, separately, and cover the entire outside-retirement union because it contains fewer than 20 memories.

Generation is not deterministic. On a new run, review its outside retirements and update `spot-judgements.json` before exporting; the exporter rejects a mismatched census. After private checks, `export.ts --retain` writes only the sanitized sidecar into this directory. Never copy raw results into Git.

`run.ts` uses the importance trial's Broca credential path: `SubcClient.connect` on a descriptor copy, fresh independent `management_surface` lineages, `session.send` and `session.subscribe`. Both the requested model and lack of temperature override are explicit; there are no fallback models or automatic retries. Each retained call must finish one provider step with `stop`, return parseable JSON, and pass scoped-id validation. Existing completed results resume without dispatching again. A failed invocation needs an explicitly preserved earlier response and a fresh lineage; never silently replace it.

The evidence arm is **not** an agent tool loop. `arrange.ts` enumerates current source with fenced `git grep -n`, then runs each memory's identifier queries against that immutable numbered capture. This is equivalent to filtering real grep output, not model-generated snippets. The query vocabulary includes quoted identifiers, paths, dotted config/symbol names, revision names and rare lexical terms. It selects at most 15 real lines per memory: eight newest-design/errata hits and seven source hits, backfilling either quota. Lines are capped at 1,600 characters. No labels influence retrieval. Repeated multi-pattern Git scans were too slow on Apple Git; the one-pass capture avoids that cost. The current source capture excludes trial artifacts, live config, dependencies, JSON/JCS goldens, and Rust testdata/integration fixtures. Current source unit tests are still searchable, which is a documented precision hazard.

Topic batching uses only the snapshot's existing normalized float32 vectors: deterministic oldest-id seed, up to 80 nearest remaining neighbors, 256,000-character ceiling. Comparisons without compatible vectors use BM25 (`k1=1.2`, `b=0.75`, mapped to `score/(score+20)`); no embeddings are purchased. Categories may share a neighborhood but cross-category consolidations remain invalid.

`evidence.json` is sanitized: ids, labels, source references/hashes, memberships, operation types, prompt/system hashes, run ids and provider counts only. `excerptCatalog` plus each memory's ordered `suppliedEvidence` indices identifies its exact excerpts. Every evidence batch's ids identify the complete union shown to that verdict; use the baseline source and excerpt hashes to reconstruct it. It contains no memory texts, rewrite contents, raw model reasoning, prompts, vectors or credentials.

## Local gates

```sh
timeout 30s bun --version
timeout 30s packages/plugin/node_modules/.bin/tsc --version
timeout 180s bun run --cwd packages/plugin typecheck
timeout 60s bun test packages/plugin/scripts/curate-stale-retirement-trial/core.test.ts \
  packages/plugin/scripts/curate-stale-retirement-trial/retrieval.test.ts
```

The private verification script checks actual provider event records, exported source references, complete coverage and absence of full active-memory text in the deliverables. Delete only `.curate-trial/` after exporting and checking sanitized evidence; Broca keeps its normal run WALs as in the existing importance trial. Do not remove the worktree.
