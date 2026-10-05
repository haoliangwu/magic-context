# issue 552: bounded retrospective historical input

## Change and scope

Pi primer refresh and retrospective now share `bounded-session-reader.ts`: directory iteration, header-only discovery, and a 64 KiB buffered JSONL reader with a 1 MiB serialized-entry ceiling. Neither production provider calls `SessionManager.listAll`. Retrospective no longer calls the whole-file loader in `pi-session-api.ts`; that compatibility API remains for its other consumers/tests. The running host's `getAgentDir()/sessions` supplies the default root; tests supply a throwaway directory.

Retrospective retains normalized typed user text, timestamp and ordinal only. Since reads retain at most cap+1 rows (80+1 in the task), overlap retains its requested suffix, and oldest-time reads retain one row per session. The shared aggregator's 240-message / 20-session limits are unchanged. Each JSONL query scans to EOF **without retaining the file**: imported/branched sessions need not have monotonic timestamps, so early stopping at the first 80 user rows would change the old oldest-first selection. This bounds retained memory, not total scan CPU. Discovery still retains session metadata proportional to file count; oldest-time discovery still examines eligible sessions before the aggregator selects twenty. Oversized entries fail through the existing empty-read fallback rather than silently shifting ordinals.

OpenCode selects only retrospective-relevant text/flags and tool name/error evidence in SQL. Assistant text, tool input/output, diagnostics and metadata do not cross into JavaScript. SQL computes the old case-insensitive ASCII-word error predicate, including stringified structured output, error values, status, true booleans, JavaScript trim whitespace and embedded NULs. User text remains unchanged (the shared prompt clamp still applies later). This is a JS hydration bound, **not** a bound on SQLite's native memory while inspecting a huge stored value. Arbitrarily large genuine user text or arbitrarily many parts in a message are not newly bounded here.

## Differential evidence

* `Pi retrospective input is byte-identical to whole-file reads under caps`: real JSONL, installed host parser for the old whole-file path, independent legacy normalization/filter/sort oracle, identical serialized scan and gate prompt. Includes malformed lines, Unicode, image exclusion, multipart user content, out-of-order timestamps, watermark overlap and a three-row truncation check.
* `OpenCode retrospective input is byte-identical to full-data privacy filtering`: same real SQLite rows and normalizer, replacing the projected query with the old full-data SELECT for the oracle. Compares serialized scan input including tool flags. Includes false/error object values, mixed-case status, non-word/underscore boundaries, nested structured output, escaped newlines, Unicode and embedded NULs.
* Existing provider tests and primer tests continue to exercise shared behavior. No migration or transform-path changes.

## Real-task memory experiment

Both fixtures execute `createDreamTaskExecutor` with task `retrospective`, including discovery, frontier selection, capped scan, gate prompt, deterministic child response `n`, completion and child deletion. Assertions require a real `question 1` prompt and child deletion; empty-provider/no-op success does not pass. Model transport alone is stubbed. The no-hit gate deliberately avoids unrelated deeper investigation/model output.

Fixtures: 500 versus 5,000 turns, 16,384-byte tool outputs and 40 diagnostics per tool. Pi writes JSONL incrementally. OpenCode uses real temporary SQLite stores; its large fixture additionally puts one **80 MiB output** on a selected first tool, because ordinary 16 KiB outputs behind an 80-message SQL cap do not exercise the single-part risk. All timestamps are recent enough to traverse the real recency gate.

Bun 1.4.2 on Darwin; tokenizer warmed and GC forced before measuring. JSON.parse is temporarily wrapped (not spied on, since spies retain arguments/results and would themselves accumulate the session). Every parse and asynchronous task boundary samples `process.memoryUsage().heapUsed`. No GC is forced during the task. The test also measures the largest actual JSON string entering the parser.

| Path | Small sampled delta | Large sampled delta | Large maximum parsed JSON | Gate prompt chars |
| --- | ---: | ---: | ---: | ---: |
| Pi streaming | 601,392 B | 593,788 B | 18,904 chars | 2,086 |
| Pi original provider mutation | 35,097,599 B | **182,593,406 B** | 18,904 chars | 2,086 |
| OpenCode SQL projection | 0 B | 0 B | **68 chars** | 1,450 |
| OpenCode full-data mutation | 0 B | 0 B | **83,890,314 chars** | 1,450 |

Zero means no sampled value exceeded the starting baseline, not zero allocations. In this Bun runtime both `heapUsed` and an exploratory JSC `heapSize` measurement failed to reflect the huge SQLite-returned string. **The heap-counter-only OpenCode control was initially undefended.** The final test therefore also rejects any parsed JSON entry >=1 MiB, observing the actual data crossing the SQL/JS boundary rather than pretending the heap counter proves something it does not. OpenCode's final old-path mutation fails that hydration assertion, not its heap-delta assertion. Pi's mutation fails the 48 MiB heap-delta assertion; both also require large-minus-small delta below 32 MiB. These are empirical regression envelopes, not universal process/RSS ceilings.

Pi's delivered parser counts were 3,003 versus 30,003: streaming keeps memory flat but still scans all rows twice (oldest and since). OpenCode's were 280 at both sizes. Prompt lengths remained identical across sizes and mutations.

## Mutation controls

All final mutations were applied after staging the live implementation and confirming an empty unstaged diff. Each carried `NON-VACUITY BREAK`, had a nonempty unstaged diff while active, and was restored from the index followed by `touch` and an empty diff. No mutation is delivered.

* Restored the entire original Pi retrospective provider (including preview discovery and full-file loader). Only `Pi retrospective peak heap does not grow with same-project history` failed: 182,593,406 B versus <50,331,648 B. Its differential test passed.
* Restored the entire original OpenCode provider. Only `OpenCode retrospective peak heap excludes huge selected tool output` failed: 83,890,314 chars versus <1,048,576. Its differential test passed. Before adding the hydration assertion the identical old-path control was undefended; it reached the full part (maximum JSON 83,890,314 chars), but heap counters remained flat.
* An exploratory JSC heap-stat sampler was discarded: scanning JSC's live object statistics after every parse made the Pi old-path control time out. The delivered sampler uses constant-cost process memory accounting.

## Verification and isolation

* Pi typecheck and lint passed (lint reports a non-failing template-literal style suggestion in the new differential fixture).
* Plugin typecheck and lint passed. The first plugin typecheck exceeded a 120-second command limit; a longer foreground run completed.
* Full Pi suite: 1,319 passed, 3 skipped; one unrelated startup-maintenance timeout under 18-way parallel load. Its complete test file rerun plus the new retrospective tests passed (15 tests).
* Full plugin suite: 5,895 passed, 3 skipped; one unrelated non-git-directory smoke-test timeout under parallel load. Its complete test file rerun plus the new retrospective tests passed (11 tests).
* Locked dependency installation made no manifest/lock changes.
* AFT diagnostics were incomplete (TypeScript/Biome initialization failures); package tsc checks are authoritative.
* Pure replay is run against the committed tree with `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master HEAD`; its final outcome is recorded in the delivery record.

Tests use the repository preloads' throwaway data/config roots. The new OpenCode fixture sets a temporary `OPENCODE_DB`, uses explicitly injected fixture connections, restores the environment and deletes its root afterward. Pi uses only explicitly supplied throwaway session directories; the legacy differential uses the host parser but never host discovery. No live session stores, user configuration, migrations, GitHub posting, or architecture/structure-document edits are involved.
