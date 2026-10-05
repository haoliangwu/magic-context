# Historian tool expansions

## Delivery and verification boundary

TypeScript rendering, config validation, generated schema/docs, OpenCode 1/2 and Pi wiring, Rust rendering/config wiring, and one shared fixture file are implemented. No migrations or provider-wire changes were made. Existing compartments are untouched.

**No Rust test ran.** Sequential package-scoped attempts timed out while the six shared compile slots were occupied: `timeout 300 cargo check -p mc-module --locked`, `timeout 600 cargo test -p mc-module --locked historian_tool_template -- --nocapture`, and `timeout 900 cargo test -p mc-module --locked historian_ -- --nocapture`. Dependencies progressed to `mc-module`, but the module remained queued. The reviewer explicitly requested delivery without killing other seats' builds and will run the Rust checks in the warm merge checkout. Rust formatting passed with Cargo 1.99.0.

Exact merge-time checks (run sequentially under timeout):

```sh
timeout 600 cargo test -p mc-module --locked shared_historian_tool_expansion_goldens -- --nocapture
timeout 600 cargo test -p mc-module --locked shared_historian_expanded_chunk_golden -- --nocapture
timeout 600 cargo test -p mc-module --locked historian_expand_tools_merges_user_and_project_templates_with_validation -- --nocapture
timeout 600 cargo test -p mc-module --locked historian_chunk_golden_fixture_matches_builder -- --nocapture
```

The first filter checks every shipped default, the array language, caps, missing fields, newlines, Unicode, and invalid templates. The second checks byte-exact chunk text using the **same** fixture as TypeScript. The third checks user/project override and validation behavior. The fourth retains the existing compact-renderer regression fixtures. A Rust-mode real-host run was not attempted because compiling the module alone exhausted the available wait windows.

TypeScript verification used Bun 1.4.2 and TypeScript 5.9.3:

- Plugin and Pi package `typecheck` scripts passed.
- 184 targeted tests across 10 files passed, including schema/docs generators, config loading, shared expansion fixtures, chunk boundaries/budgeting, ctx_expand and the e2e mode manifest.
- `timeout 180 bun run build` passed for plugin, Pi plugin and CLI, including 4 OpenCode 2 loader tests.
- The real OpenCode 1.18.30 host test passed (1 test, 13 assertions).
- Scoped AFT inspection reported zero TypeScript diagnostics; its Biome producer was unavailable.

## Current behavior confirmed before editing

The old formatter preferred a description, otherwise `TC: tool(keyArg)`, and never rendered results. The chunk reader discarded calls when text was present. Rust similarly omitted calls alongside narrative, while separately pairing CK call/result blocks.

One small correction to the brief: path, filePath, pattern and query had a 60-character cap, but symbol, module and action did **not**. Those legacy details remain unchanged for unexpanded tools.

Failing-first tests captured these exact failures:

```text
historian retains peer_send alongside assistant text
Expected: [1] A: Delegating the review. / TC: PM to Ada: Check the parser.
Received: [1] A: Delegating the review.

historian includes the ask answer from structured result text
Expected: [1] A: TC: Asked user: Which mode? → Strict
Received: [1] A: TC: ask
```

Both now pass. No old test contract was reversed.

## Shipped defaults and rendered examples

The templates live in `packages/plugin/src/shared/historian-tool-defaults.json`, also included directly by Rust. Examples below come from `crates/mc-module/testdata/historian-tool-expansions.json`, read by both suites.

- **ctx_note**: `Note ${input.action} ${input.note_ids}: ${input.content} → ${output.truncate(160)}`
  - `Note write : Review parser boundaries → Saved note #7.`
- **ctx_memory**: `Memory ${input.action} ${input.category} ${input.ids}: ${input.content} → ${output.truncate(160)}`
  - `Memory write architecture : Use a single writer. → Saved memory [ID: 8] in architecture.`
- **todowrite**: `Todos (${input.todos.count}): ${input.todos.each("${status}: ${content}")}`
  - `Todos (2): completed: Inspect schema; in_progress: Test renderer`
- **question**: `Asked user: ${input.questions[*].question.join(" / ")} → ${output}`
  - `Asked user: Which modes? → User has answered your questions: "Which modes?"="Strict, Fast". You can now continue with the user's answers in mind.`
- **task**: `Task ${input.subagent_type}: ${input.prompt} → ${output.truncate(200)}`
  - `Task explore: Find the config loader. → task_id: ses_123 <task_result>Found loader.ts</task_result>`
- **ask**: `Asked: ${input.question.truncate(250)} [options: ${input.options.join(" / ")}] ${input.resolution} → ${output.truncate(300)}`
  - `Asked: Which mode? [options: Strict / Fast]  → Strict`
- **peer_send**: `PM to ${input.agent}${input.agent_id}: ${input.message.truncate(400)}`
  - `PM to Ada: Check the parser. Report edge cases.`
- **board**: `Board ${input.verb}: ${input.ops.each("${op} ${item}${lane.title} ${state}${lane.status}${props.text} ${lane.items[*].text}")}`
  - `Board update: item Parser done ; lane Tests active Golden fixtures; post  Ready for review `
- **room**: `Room ${input.action} ${input.room_id}: ${input.text.truncate(400)}`
  - `Room post review: Parser is ready.`
- **work**: `Work ${input.action} ${input.id}: ${input.prompt_file}${input.prompt.truncate(200)}${input.notes.truncate(200)} → ${output.truncate(160)}`
  - `Work run : Test Unicode truncation. → work_1 running worker accepted`
- **knowhow**: `Looked up how-to: ${input.query}${input.id}`
  - `Looked up how-to: Release procedure`

Evidence sources: the registered Magic Context tools in this checkout, OpenCode's `question.ts`, `task.ts` and `todo.ts` fetched from tag `v1.18.30` into ignored worktree-local scratch, and the reviewer's schema/result excerpts for Prefrontal. Those excerpts explicitly verified lowercase host names and plain-text results. PM receipts and board/room transcript echoes are intentionally omitted.

## Real-host proof and isolation

`packages/e2e-tests/tests/historian-expand-tools.test.ts` launches OpenCode **1.18.30** with the mock Anthropic provider, the production plugin bundle, and deterministic `ask`/`peer_send` stand-ins. The assistant emits text and both calls in one message. Real tool execution returns the answer; pressure then triggers a genuine historian request captured at the provider.

Final successful host PID: **87842**. All host runs used throwaway roots beneath `$TMPDIR/magic-context/bg_0a9a7b85031943c5/`. The harness explicitly set `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` beneath each throwaway root. No live stores/configs were opened, read, written or migrated.

`lsof -p 87842 -Fn` showed only the throwaway `data/opencode/opencode.db` and `data/cortexkit/magic-context/context.db` paths (plus their WAL/SHM files). The test requires a nonempty DB-path list and rejects any DB path outside that host root.

Retained mock-only artifacts are under `$TMPDIR/magic-context/bg_0a9a7b85031943c5/proof/`: `host-lsof.txt`, `historian-request.json`, `chunks.json`, `ctx-expand-default.txt`, and `ctx-expand-verbose.txt`. Prior failed attempts' diagnostics are also retained there, not committed.

Same stored history, before/after excerpt:

```text
Before:
[2-3] A: Coordinating the parser review. / Acknowledged.

After:
[2-3] A: Coordinating the parser review. / TC: PM to Ada: Check parser boundaries. / TC: Asked: Which mode? [options: Strict / Fast]  → Strict: preserve call boundaries. / Acknowledged.
```

The captured historian prompt contains both expanded lines, including `Strict: preserve call boundaries.`. The host-registered default `ctx_expand` result is byte-equal to the legacy compact render for the recovered range. The verbose tool result includes:

```text
[2] A (assistant)
    • Coordinating the parser review.
    • tool peer_send: PM to Ada: Check parser boundaries.
    • tool ask: Asked: Which mode? [options: Strict / Fast]  → Strict: preserve call boundaries.
```

The realistic 20-message history (coding-work vocabulary ballast plus communications) measured **14,959 tokens before / 14,994 after**, a **35-token increase (0.23%)**, using the same tokenizer/history in both renders. The small shared fixture measured 40 / 74 tokens; its budget regression also verifies that expansions can shorten a chunk. Call/result arcs are still atomic.

## Non-vacuity and implementation choices

The containment assertion was safely challenged by adding a **fake string** `/NON-VACUITY BREAK.db` to the observed path list, without opening it. The named real-host test alone failed at the root-containment assertion (`Expected true, Received false`; 0 pass / 1 fail). Before mutation the live implementation was staged and `git diff --stat` was empty; during mutation it showed one file/one insertion; after `git checkout --` and `touch` it was empty again. The restored host test then passed.

- The reviewer expanded the language to include index/projection/each/join/count forms; all are covered by the shared fixtures. No conditionals were added.
- Objects render as compact JSON with sorted keys, providing deterministic ordering across engines. Unicode truncation counts characters, not bytes or UTF-16 halves.
- Optional-field concatenation can leave double spaces, empty labels, or awkward board phrasing. This is intentional rather than introducing branching. `work` read actions also expand because one unconditional template was explicitly authorized. Work/task results show their first bounded characters, not a separately parsed first line.
- The host proof uses authorized answer/PM stand-ins rather than interacting with a real user or contacting peers. Its default/verbose comparison uses a short recovery range to avoid OpenCode's independent tool-output byte truncator; the token comparison still uses the 20-message history.
- Initial host attempts exposed harness setup mistakes (the title generator consumed a scripted response; the fixture could not resolve the plugin workspace SDK; pressure usage needed the same cache-token fields as existing scenarios). They were fixed in test setup, not product behavior.
- Rust parity and config code are intentionally delivered **uncompiled/unexecuted**, at the reviewer's request. Merge-time Rust verification is mandatory; do not interpret the shared fixture's passing TypeScript side as a Rust pass.
