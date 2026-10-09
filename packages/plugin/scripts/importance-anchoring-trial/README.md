# Historian importance anchoring trial

Investigative harness only; it does not modify historian behavior. Results and limitations are in `docs/reports/historian-importance-anchoring.md`. `evidence.json` retains input identities, prompt/system SHA-256s, reference selections, response titles, score/range arrays, P1 SHA-256s and provider usage. It contains no full prompts, transcripts, project-memory blocks, P1 bodies, reasoning or credentials.

## Reproduction

Run from `packages/plugin` with Bun 1.4.2 and the repository's installed dependencies. Never point these scripts at a live database. The exact root is `$TMPDIR/magic-context/importance-trial/` (resolved through Node's `tmpdir()`). Do not overwrite another trial's root.

1. Create a private root (`mkdir -p`, `chmod 700`). Snapshot each live database with the permitted read-only SQLite operation, for example:

   ```sh
   sqlite3 "file:$HOME/.local/share/cortexkit/magic-context/context.db?mode=ro" \
     "VACUUM INTO '$TMPDIR/magic-context/importance-trial/context.db'"
   sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" \
     "VACUUM INTO '$TMPDIR/magic-context/importance-trial/opencode.db'"
   ```

   Scrub the OpenCode **copy** before any use:

   ```sh
   sqlite3 "$TMPDIR/magic-context/importance-trial/opencode.db" \
     'PRAGMA secure_delete=ON; DROP TABLE IF EXISTS credential; DROP TABLE IF EXISTS account; DROP TABLE IF EXISTS account_state; DROP TABLE IF EXISTS control_account;'
   ```

   A whole-file second `VACUUM` is unnecessary and very expensive on this 36-GiB snapshot. SQLite may need to recover an interrupted copy's hot journal first. Never recover or migrate the live database.

2. Stage a bytewise copy of `~/.config/cortexkit/magic-context.jsonc` as `magic-context.jsonc` and the subc connection metadata as `subc-connection.json`. Set files to `0600`. The harness reads only these copies. The final runner uses Broca and does **not** need OpenCode auth/config copies or an OpenCode host. Do not launch a host on the snapshot.
3. `bun scripts/importance-anchoring-trial/prepare.ts "$TMPDIR/magic-context/importance-trial"` selects the ten latest matching published, single-output, primary-model children from each of the three named sessions. It keeps recorded prompts byte-for-byte in A, including project memories and raw chunk formatting. It matches output range/title/importance against the compartment store, excludes fallback outputs, and requires the newest recorded reference score to match the preceding stored compartment. No reconstruction is needed for this retained corpus. AFT also retains the system string; the other two sessions use the current generated production system prompt.
4. `bun scripts/importance-anchoring-trial/run.ts "$TMPDIR/magic-context/importance-trial" 1` runs a four-cell pilot. Replace `1` with `30` for the full trial. It uses `session.send`/`session.subscribe` over the same wire as the Rust producer; tools are empty, temperature comes from copied config, max output is 32,000, no model fallback. Each cell has a fresh lineage under the throwaway project root. Three cases run concurrently; arm order rotates by case. Broca itself remains the existing provider service, not a throwaway host; it retains normal run WALs in its own store. Its store is not one of the forbidden live stores. These runs do not publish compartments or facts.
5. `bun scripts/importance-anchoring-trial/analyze.ts "$TMPDIR/magic-context/importance-trial"` checks completeness and emits `summary.json` and sanitized `evidence.json` in the temporary root. Copy only the sanitized evidence to this directory if retaining a new report. The analyzer requires one completed provider step with a `stop` finish reason, and reports all output compartments as well as first-compartment metrics.
6. Delete the temporary root (including snapshots, hot journals, staged configuration/credentials, connection metadata and all raw model output) when done.

The root is deliberately fixed to reject accidentally passing a live path. A/B/C preserve all text except session-reference opening-tag importances. C uses a deterministic shuffled permutation of the 60 fixed seed importances, taking six values without replacement. D follows the final requested design: three deterministic seeds, four newest **content-bearing** session compartments, and three older diverse references. Band selection minimizes representation among available bands, so uncovered bands come first; ties follow production's high-to-low band order and choose the newest unselected older row in that band. Diverse references are chronological before the chronological recent four. The production per-block renderer is called separately for each reference to bypass its six-reference ceiling without altering escaping or tier semantics.

The code intentionally does not add a scoring-only instruction, deterministic answer template or temperature override. Such controls could conceal the production model's real response to changed reference scores. Consequently full summaries, not just scores, can vary.

## Fixed-cohort E/A2 follow-up

Do **not** use `prepare.ts` to select a newer cohort for the follow-up. After making and scrubbing fresh snapshots as above, run:

```sh
bun scripts/importance-anchoring-trial/restore-inputs.ts "$TMPDIR/magic-context/importance-trial"
bun scripts/importance-anchoring-trial/run.ts "$TMPDIR/magic-context/importance-trial" 30 E,A2
bun scripts/importance-anchoring-trial/analyze.ts "$TMPDIR/magic-context/importance-trial"
```

`restore-inputs.ts` locates the thirty original child IDs in committed `evidence.json`, verifies all 120 A–D prompt hashes and thirty system hashes, and verifies the recorded output P1 hashes. A2 is exactly A in a fresh lineage. E changes only D's last four reference opening tags, removing their importance attributes while keeping the first three diverse references scored. The copied config must still select the original model and temperature. Broca's version should be checked before dispatch; both phases here used 0.3.176.

The follow-up alternates arm order by case, adds only sixty provider calls, and does not regenerate A–D observations. The analyzer carries those response records and superseded-run spend forward from `prior-evidence.json`, adds E/A2, reports distances from the recorded original and both A generations, and compares title/P1 arrays against both A and A2. No P1 bodies are needed to compare hashes. Retain only the newly sanitized `evidence.json`, then delete the temporary root again. A repeat of a previously used arm requires a new lineage namespace; do not append to an existing provider session or interpret its replay as another independent generation.

## Rubric-first system-prompt trial

Use only the **existing saved inputs**, not `prepare.ts`/`restore-inputs.ts` or a
live database. Copy `inputs/0.json`–`29.json` and `manifest.json` to a private
`$TMPDIR/magic-context/historian-scoring-<unique-name>/` root, plus an authorized
copy of the Broca connection descriptor as `subc-connection.json`. No live
configuration or database is needed. A model argument enables this mode:

```sh
timeout 5400s bun scripts/importance-anchoring-trial/run.ts "$ROOT" 30 E,F,E2 google/antigravity-gemini-3.8-flash
timeout 5400s bun scripts/importance-anchoring-trial/run.ts "$ROOT" 30 E,F,E2 openrouter/deepseek/deepseek-v4.1-flash
timeout 60s bun scripts/importance-anchoring-trial/analyze-scoring.ts "$ROOT" google/antigravity-gemini-3.8-flash openrouter/deepseek/deepseek-v4.1-flash
```

E and E2 use the saved system and `prompts.E`; F uses the same user bytes with
the regenerated system. Cohort hashes, three scored seeds, three scored diverse
references and four unscored recent references are checked. The runner sets all
six isolation variables under the root and records `lsof -p` database handles
before connecting. No OpenCode host is launched; Broca remains the existing
provider service. Temperature is 0.1, tools are empty, and max output is 32,000.

Each model/arm has its own lineage and results directory. Resuming the same
command skips all completed outputs, including missing-score answers. Only
provider/transport failures are retried, with fresh lineages; superseded failed
attempts and their reported usage are retained. There are no automatic retries,
repair prompts, fallbacks or resampling of completed outputs. The DeepSeek
credit-limited pilot can be resumed this way **only after authorization and a
credit refill**. `analyze-scoring.ts` reports scored denominators explicitly,
paired noise and the common-triplet subset; credit failures are not zero scores.

A transport disconnect does not prove the provider cancelled a run. Before
retrying an unknown-outcome transport failure, query `run.status` with its
original admission identity. If it completed, recover the original answer with
`run.result` and its `session.subscribe` replay instead of regenerating it. In
this trial, two such original outputs were recovered and used in the primary
analysis; their unnecessary fresh-lineage retries are retained as excluded
completed attempts with usage, never substituted for the original scores.

Keep only sanitized `scoring-evidence.json` in git. `scoring-quality.json` and
raw outputs contain P1 bodies and stay private in the throwaway root. Selected
first lines may be quoted in the report for the requested qualitative check.

## Checks

```sh
bun run typecheck
bun test scripts/importance-anchoring-trial/core.test.ts
```

`typecheck` includes `tsconfig.scripts.json`. No product packaging or generated prompt file changes are required. The tests cover literal B/C scope, production band edges, deterministic planting, D counts/order/availability, empty boundary markers, literal `$&` in history, E's selective score removal, score parsing and population standard deviation. Live dispatch is never part of a unit test.
