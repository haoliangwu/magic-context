# Stored-compartment rescoring trial

Investigative harness only: no production renderer, model configuration, migration or compartment writes. Findings live in `docs/reports/compartment-rescore-trial.md`; shipping proposal in `docs/designs/compartment-rescore.md`. Bun 1.4.2 and installed repository dependencies are required.

## Isolation and inputs

The exact root is `$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2` (Node `tmpdir()` on this machine). This fence deliberately rejects live storage and other paths. `prepare.ts` refuses to replace an existing manifest. Resume with `run.ts`; a genuinely new experiment needs a fresh private root and a corresponding explicit fence change, not an overwritten prior run.

Only the task-provided `$TMPDIR/magic-context/memory-trials/trial.db` is read. Copy it with read-only SQLite `VACUUM INTO` before preparing, into a newly created 0700 root. Copy **only** the subc connection descriptor from the credential path used by the anchoring harness, `~/.local/share/cortexkit/run/subc-connection.json`, as `subc-connection.json` in the root (0600). No live Magic Context/OpenCode databases, raw transcripts, auth databases or user model config are required or permitted. This trial hardcodes the requested `google/antigravity-gemini-3.8-flash`, temperature 0.1 (the previous anchoring harness setting), empty tools and 32,000 max output tokens. Preparation isolates HOME/XDG/storage paths before importing the pure production reference renderer.

## Procedure

Run from `packages/plugin`, with an **outer timeout** on every command:

```sh
timeout 30s bun scripts/compartment-rescore-trial/prepare.ts "$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2"
timeout 700s bun scripts/compartment-rescore-trial/run.ts "$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2" 1
timeout 1800s bun scripts/compartment-rescore-trial/run.ts "$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2" 30
timeout 30s bun scripts/compartment-rescore-trial/analyze.ts "$TMPDIR/magic-context/compartment-rescore-bg_a526ac86bdd83bf2"
```

* Each session contributes 100 evenly spaced non-overlapping triplets, 300 rows, including first/last rows. This provides 200 **true immediately time-previous** pairs per session; gaps between sampled triplets are never treated as neighbours. The complete supplied sessions' old-score statistics are also reported.
* Deterministic hash shuffling mixes the two sessions into 30 batches of 20; a row is deferred if its immediate chronological neighbour is already in that batch. Candidates have opaque database ids, title, episode type and P1 only. No score, date, sequence, range or session id is sent. Database ids are response correlation keys, not contextual metadata (they may still weakly correlate with creation time).
* Each batch has three scored seeds selected by the production `selectSeeds`, and the current source prompt's entire Importance section including the revised procedure. Only the “set once ... never updated” sentence fragment is removed because this experiment explicitly revisits old scores. Seed examples remain unchanged. The prompt asks for a score and one-line recall-duration reason, not a new summary or a forced histogram.
* Batches 0, 14 and 29 are rerun verbatim in separate fresh Broca lineages (60 rows total). Their context variants keep all the same seeds/order/rubric, add P2 and eight most recent unscored titles from each candidate's session. These titles come from the entire supplied session, including later work relative to early candidates: this deliberately tests retrospective context, not a historically available prompt. Variant/repeat order rotates; base mostly precedes the added arms. There is no model fallback or automatic retry.
* Dispatch uses the anchoring harness's `SubcClient` Broca `session.send`/`session.subscribe` credential path, with at most two calls concurrently. A terminal event is insufficient: runner and analyzer require exactly one provider step with `finish_reason=stop`, all requested unique ids, integer 1–100 scores and non-empty single-line reasons. Admission records preserve run ids. Failed cells require explicit investigation, not silent reissue. An explicit fourth argument `--retry-failed` archives failures/spend, reattaches a run interrupted by client closure, or uses a fresh lineage for a rejected terminal answer. Stop and ask the task-giver if the requested model cannot be reached.
* Results/raw events, prompts, source rows, rationales, descriptor and private example-review file stay inside the temporary root. Broca retains its normal run records; the harness does not publish compartments. Do not start another host against the snapshot.

The analyzer emits sanitized `evidence.json` with input/system/P2 hashes, row identities, numeric scores, seed scores, provider usage and run ids. It contains **no candidate prose, titles, reasons, credentials or provider raw events**. The committed examples table is the only retained candidate-title list. Model reasons there are paraphrased to avoid reproducing P1 text. Private P1s are reviewed to judge rubric fit; more spread alone is not the success criterion.

Keep the private root only while reviewing/reproducing; then remove that **exact throwaway root**, never the supplied `memory-trials` root or a worktree. For this delivery it is retained temporarily for parent review; its path is recorded in the report.

## Offline checks

```sh
timeout 180s bun run typecheck
timeout 60s bun test scripts/compartment-rescore-trial/core.test.ts
```

Tests exercise endpoint coverage, true-neighbour pairing, shuffle independence, score/chronology projection, context-variant isolation, revised rubric extraction, strict output ids/range/shape, band boundaries, population SD and identity-paired noise. No unit test calls the model or opens a store. The score-leak invariant also has a staged/restored mutation check recorded in the delivery.
