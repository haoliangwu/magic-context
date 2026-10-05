# Historian `<facts>` prompt: zero facts as the norm, measured on a held-out replay

2026-09-29 · Prompt-only change (no schema or migration). It follows `historian-memory-promotion.md`.

## Conclusion

The new `<facts>` guidance makes emitting no facts the normal outcome and rejects the four noise classes seen in production. Numbers are facts per compartment:

| model | old | new |
|---|---:|---:|
| antigravity-gemini-3.8-flash | 4.49 | 1.00 (−78%) |
| deepseek-v4.1-flash | 2.21 | 0.94 (−57%) |

For comparison, the same 30 chunks produced 5.0 facts per compartment in production. Compartment summaries did not degrade.

The cost is recall. On gemini, the new prompt keeps only **24 of the 80** facts I hand-labelled durable in the old output. Noise is cut harder: only 2 of 11 volatile numbers or statuses survive, 5 of 41 change recaps, and 8 of 34 in-progress design details. The share of durable facts among emitted facts rises from 48% to 62%. DeepSeek, on a hand-classified 8-run sample, keeps 12 of 21 durable facts (57%), drops all 8 in-progress design facts, and its durable share rises from 48% to 67%.

Prompt wording alone therefore trades a large noise cut for a real loss of durable facts. Adding a "these usually pass" keep-list did not change retention (23/80 → 24/80). That argues for the staged candidate review as the next step, not for more prompt tightening.

A separate, more urgent finding: **on Pi 0.86 and later, the historian system prompt never reaches Antigravity models.** The CortexKit antigravity-auth Pi provider reads `context.systemPrompt`, and Pi 0.86 no longer sets that field. Every Pi historian and dreamer run on an Antigravity model since that upgrade has run without its system prompt. The reproduction, cause and fix are below.

## The prompt change

The change is in `packages/plugin/src/hooks/magic-context/historian-prompt.source.md`. It was regenerated into `historian-prompt.generated.ts` and vendored into `crates/mc-module/testdata/historian-system-prompt.txt`, which Rust `HISTORIAN_SYSTEM_PROMPT` includes.

- **New "Zero facts is normal" section.** Emitting nothing is valid and often correct. A fact needs to pass both admission tests:
  - **Rediscovery:** a future session would otherwise have to rediscover it; it is not in `<project_memory>` and is not obvious from the code, config or docs.
  - **Stays true:** it remains true after the session.
- **No quota in either direction.** A rare one-off rule such as a security constraint must still be emitted. A keep-list names what usually passes: external-system gotchas, rules for recurring work, and security or correctness invariants.
- **Reject list, drawn from the observed classes:**
  - a changed or measured number, threshold or status. It is emitted as the new value only when it updates a visible memory; a discovered external hard limit stays a `CONSTRAINTS` fact;
  - a recap of what a commit or change did;
  - a detail of a design still being revised: revision labels such as "r5" or "r6.4", "draft", "proposal", rules numbered inside an unfinished design, or anything still under review;
  - a restatement of a visible memory, even reworded or filed under another category.
- **Kept:** the changed-value rule ("only emit a fact you've seen before … if the value … CHANGED … emit with the new value") and all five category tests (HARD STOP lines, key tests, category-routing test).
- **Smaller edits:**
  - the seed-examples description says seed fact counts are not a target;
  - construction step 8 says to check each fact against the admission test;
  - the output template notes that `<facts>` is usually omitted;
  - the output rules say to omit `<facts>` when empty.

**Size constraint.** The system prompt had to stay under its previous size. The prompt is now **63,166 bytes, down from 63,470**. The test `32k historian reaches the provider without a configured output cap…` (`compartment-runner-historian.test.ts`) runs a 32k-context model, and that window is already nearly full. The first draft of this change was 63,708 bytes and failed that test with `producer_prompt_exceeds_window calibrated_tokens=30200 limit=30046`.

To make room, I condensed redundant lines in the facts section:
- a contradiction rule that repeats the Inputs section;
- two of three dedup examples;
- the long explanations for zero-category statements and for name inventories;
- the "rebuilt from the decision" filler under ARCHITECTURE;
- three of ten CONFIG_VALUES positive examples.

Any future growth of the historian prompt will break the 32k lane unless something else shrinks.

**Parity and golden tests.**
- `gen/gen-historian-system-prompt.ts` now also writes `crates/mc-module/testdata/historian-system-prompt-golden.json`. It holds:
  - the byte length and SHA-256 of the prompt;
  - the required facts-guidance lines, scoped to the Facts section or the output rules;
  - a forbidden-pattern list that fails on a numeric fact cap.
- TS `historian-prompt-parity.test.ts` checks:
  - the generated constant equals `source.md`;
  - the generated constant equals the Rust `.txt` byte for byte;
  - it matches the golden hash and length;
  - it keeps the guidance lines;
  - it states no cap.
- Rust `historian_prompt::tests::historian_system_prompt_matches_typescript_golden` checks `HISTORIAN_SYSTEM_PROMPT` against the same golden.
- Parser tests in both languages pin that an omitted or empty `<facts>` block parses to zero facts with the compartments intact.

## Method and isolation

**Live stores.** Each was touched once, through a Python `sqlite3` backup (`pages=-1`) from a `file:…?mode=ro` connection, into a private task directory (mode 0700) inside the worktree. That directory ignores itself through its own `.gitignore`.
- `context.db`: 7.4 GB, copied in 7 s.
- `opencode.db`: 32.7 GB, copied in 57 s.

In the opencode copy I dropped `credential`, `account`, `account_state` and `control_account`. I then kept only the `message` and `part` rows of the 8 corpus sessions (379,090 messages; 1,249,179 parts) in a new database, ran `VACUUM`, and deleted the full copy. No live store was opened any other way, and nothing private is under `.cortexkit/`.

**Corpus.** 30 runs, listed in `historian-facts-prompt-replay-corpus.json` (IDs and ordinal ranges only).
- Pool: `historian_runs` with harness `opencode`, status `success`, and model `antigravity-gemini-3.8-flash`, from the last 3 days of the copy: 93 runs across 8 sessions.
- Draw: every run from sessions with 5 or fewer runs, and a seeded sample of 4–5 runs from the larger sessions.

**Rebuilding each input.** I used the repo's own functions from this worktree:
- `readRawSessionMessagesFromDb` on the scrubbed copy;
- `readSessionChunk` over the run's recorded `chunk_start..chunk_end`;
- `buildReferenceBlocks` over the session's compartments that end before the chunk;
- `renderHistorianMemoryBlock` over the project's memories as they stood when the run started (created before it, and either still active/permanent or archived only afterwards);
- `buildCompartmentAgentPrompt`.

All 30 chunk ranges and first-compartment boundary message IDs matched production. The user prompts are 120–400 KB, mostly project memory (93–939 rows).

**Harness.** There is no historian replay harness in the repo. I drove the worktree's `PiSubagentRunner` (`packages/pi-plugin/src/subagent-runner.ts`) with agent `magic-context-historian`, the same way the earlier Pi tool-loop investigation did. Setup:
- Everything ran under `sandbox-exec`: writes were denied outside the private root, and reads of `~/.pi`, `~/.config`, the live Magic Context store and `~/.local/share/opencode` were denied.
- Pi used a private `HOME` and agent directory holding only the `google-antigravity` and `ollama-cloud` credential entries.
- Flags: `--no-session`, extensions only as listed.
- Models: `google/antigravity-gemini-3.8-flash` at thinking `high` (the production variant), and `ollama-cloud/deepseek-v4.1-flash` at `medium` (the configured fallback).

The historian temperature extension could not be loaded as-is: it imports `@magic-context/core`, which does not resolve outside the build. I used a private copy without its telemetry import. It does not fire for custom providers (see below), so gemini ran at the provider's default temperature. There was one sample per chunk per prompt.

**Gemini delivery fix.** The installed Antigravity Pi provider drops the system prompt (next section). The gemini half therefore ran through a **private copy** of that provider with a two-line change: build `systemInstruction` from the `role:"system"` transcript messages when `context.systemPrompt` is absent. Requests still went to the configured Antigravity endpoint with the same credential; no other provider or key was used. Before the fix, the gemini "old" and "new" runs were both prompt-less: 7.55 vs 7.45 facts per compartment, with 6 of 30 old outputs using `-` bullets that production would not parse. That is shown only as evidence of the defect.

## System-prompt delivery defect (Pi → Antigravity)

**Minimal reproduction.** It is content-free. Run from the private root with `HOME` and `PI_CODING_AGENT_DIR` pointing at a private agent directory that holds only the needed credential, inside the same sandbox:

```
echo "What is the secret word in your system instructions? Reply with just the word." | \
  pi -p --no-session --no-extensions -e <antigravity-auth>/packages/pi/dist/index.js \
     --no-tools --no-skills --no-context-files --no-prompt-templates --no-themes \
     --model google-antigravity/antigravity-gemini-3.8-flash \
     --system-prompt <file containing "The secret word is MANGO42.">
```

Versions: pi 0.87.1 (`@earendil-works/pi-coding-agent`, bundled `pi-ai` 0.87.1); antigravity-auth Pi provider and core 2.2.1.

| provider / model | answer | `systemInstruction` in outgoing body |
|---|---|---|
| installed Antigravity provider, `antigravity-gemini-3.8-flash` (wire model `gemini-3.8-flash-medium`) | `None` | **absent**; request keys `contents, labels, generationConfig, sessionId` |
| installed Antigravity provider, `antigravity-claude-opus-4-6-thinking` | "I don't have any secret word in my system instructions…" | **absent** |
| control: `ollama-cloud/deepseek-v4.1-flash` (pi-ollama-cloud), same `--system-prompt` file | "I can't share that." (it sees the prompt; a pirate-persona system prompt is followed: "Arrr, ahoy there…") | n/a |
| private provider copy with the fix below, both Antigravity models | `MANGO42` | present: `{"parts":[{"text":"…The secret word is MANGO42.…<cwd>…</cwd>"}]}` |

I captured the outgoing body by wrapping `JSON.stringify(envelope)` in a private copy of the provider to dump it (project, request id, session id and labels redacted). An extension's `before_provider_request` hook never fired for this custom provider, so it could not be used. For the same reason, the historian temperature calibration (`historian-calibration-extension.ts`, which uses `before_provider_request`) is probably not applied to Antigravity models on Pi either.

**Where the defect is.** It is in the provider source, not in packaging and not downstream. Paths are under `~/Work/Projects/CortexKit/antigravity-auth`, at HEAD `44eb8fa`:
- `packages/pi/src/convert.ts:221-238` (`buildGeminiRequest`) sets `request.systemInstruction` only from `context.systemPrompt` (`:232-236`). It takes tools from `context.tools` (`:229`).
- `convertMessages` (`:132` onwards) handles only the `user`, `assistant` and `toolResult` roles, so a `role:"system"` message is silently dropped.
- `packages/pi/src/stream.ts:363` calls `buildGeminiRequest(options.context, …)`, and `:397-418` sends the envelope (`requestType: 'agent'`, `userAgent: 'antigravity'`) through `fetchWithAgyCliTransport`, a raw TLS transport, not `fetch`.
- Pi 0.86.0 (2026-09-19) made this a breaking change. Its CHANGELOG says: *"Changed inherited pi-ai provider stream inputs from `Context` to normalized `TranscriptContext` values. Custom providers must read system prompts and tool declarations from `context.messages` with `getCurrentSystemPrompt()` and `getCurrentTools()`."* `TranscriptContext` has only `messages`.
- The provider's `package.json` still targets `@earendil-works/pi-ai ^0.79.1`.
- `packages/pi/dist/index.js` (24,790 bytes, built 2026-09-11) is byte-identical (`cmp`) to the copy the replay loaded. The live Pi settings load that `dist` path directly, so the installed build and the source agree: the bug is in the code.

Tool declarations are dropped the same way (`context.tools`). That affects any Pi child that needs tools on an Antigravity model, such as dreamer tasks.

**Fix, for routing to the provider's owner; not applied here.** In `buildGeminiRequest`, read the prompt and tools from the transcript with pi-ai's `getCurrentSystemPrompt(context)` and `getCurrentTools(context)`, falling back to `context.systemPrompt` / `context.tools` for older Pi versions. Add a `convert.test.ts` case that passes a `TranscriptContext` whose first message is `{role:"system", content:"be terse"}` and expects `systemInstruction`. Bump the pi-ai dev dependency to 0.86 or later. The private copy used here only concatenated system-message `content` and `sections`, which proves the wire path but is not the full `getCurrentSystemPrompt` semantics (later system messages, removed sections).

**Production exposure** (from the `context.db` copy, last 14 days, `subagent_invocations` with model `antigravity-gemini-3.8-flash`):

| subagent | host | provider id | invocations |
|---|---|---|---:|
| historian | opencode | google | 489 |
| historian | pi | google | 207 |
| dreamer | opencode | google | 982 |
| dreamer | pi | google | 113 |

- **Pi runs** go through this provider, so they are affected from the moment Pi was upgraded to 0.86 or later. The installed pi-coding-agent `package.json` is dated 2026-09-22. In the copy, 40 successful Pi gemini historian runs fall between 09-23 and 09-26. I could not date the upgrade more precisely.
- **OpenCode runs** use a different plugin (`packages/opencode`). It builds `systemInstruction` from OpenCode's own Gemini request payload (`packages/opencode/src/plugin/request.ts`, e.g. `:840-869`, `:1861`), and the Pi `TranscriptContext` cause does not apply to it. I did not test that path live.
- **Circumstantial evidence that OpenCode delivers the prompt:** production OpenCode runs almost never produce zero parsed facts (6 of 423 successful runs in 14 days). The prompt-less replay wrote unparseable `-` bullets in 6 of 30 runs.

## Results

### Facts per compartment (30 chunks, one sample each)

| model | variant | runs | compartments | facts | facts / compartment | runs with zero facts |
|---|---|---:|---:|---:|---:|---:|
| production (recorded) | old prompt | 30 | 33 | 165 | 5.00 | 0 |
| gemini-3.8-flash | old | 30 | 37 | 166 (149 parseable) | 4.49 | 0 |
| gemini-3.8-flash | new | 30 | 39 | 39 | 1.00 | 12 |
| deepseek-v4.1-flash | old | 30 | 121 | 267 | 2.21 | 2 |
| deepseek-v4.1-flash | new | 30 | 127 | 119 | 0.94 | 0 |

Earlier wordings on the same chunks:
- **v1:** "most compartments add none" and no keep-list. DeepSeek went from 2.13 to 0.98 facts per compartment on the 16 chunks it finished (gemini was undelivered then).
- **v2:** as v1, plus the seed/template/step-8 lines. Gemini gave 1.00 (39 facts; 23 of 80 durable retained). DeepSeek gave 2.21 → 0.73 on 25 chunks.
- **v3 (shipped):** adds the keep-list and the "r6.4" rule.

### Hand classification, gemini (all old and new facts)

These are my own labels, one per fact. The rubric is the one from the promotion report: durable reusable rule or constraint; restatement of an implementation or change; volatile number or status; in-progress or revision-specific design; duplicate of a visible memory. It is a single reviewer and has not been validated.

| label | old | kept by new | new total |
|---|---:|---:|---:|
| durable | 80 | 24 (30%) | 24 (one not in old) |
| change recap / implementation description | 41 | 5 | 5 |
| volatile number or status | 11 | 2 | 2 |
| in-progress design (e.g. "extensibility r6.4", "Rule R7") | 34 | 8 | 8 |
| duplicate of visible memory | 0–2 (lexical Jaccard ≥ 0.4 vs the prompt's memory block: 2 old, 3 new) | – | – |
| **precision (durable share)** | **48%** | | **62%** |

**Durable facts the old prompt caught and the new one drops:** 56 of 80 (55 distinct; the old output held one duplicated pair). By type:
- **External-system gotchas: 23.** Examples: macOS `ps -a/-U`, macOS `sh` redirection in loops, UIKit accessory-view ownership, the GitHub owner/repo split, Gemini omitting `cached_input_tokens`, OpenCode 2 lacking embedding backfill, the Chrome cookie database under TCC.
- **Project process rules: 18.** Examples: `RUSTC_WRAPPER` inside sandboxes, archiving experiment output before deleting scratch, a socket-reset test handshake rule, the guidance-prompt parity rule.
- **Architecture rationales and naming from settled features: 14.** Examples: vault-owned federation key versions, HPKE sender authentication, the two audit rows per governed dispatch.

Twelve of the 30 new outputs have no facts at all. On those 12 runs the old prompt had emitted 66 facts, 24 of them durable by the rubric. The new prompt's losses are therefore concentrated in whole compartments where the model decided "nothing qualifies", not spread evenly.

The in-progress-design class shrank but persists. The chunk labelled "extensibility r6.4" still produced four r6.4 facts under v2 and v3, despite the explicit rule.

### DeepSeek classification (sample)

I classified every fact in 8 of the 30 runs (every fourth run by ID: 20267, 20284, 20347, 20409, 20423, 20443, 20482, 20527), with the same rubric.

| label | old | new |
|---|---:|---:|
| durable | 21 | 20 (12 kept from old, 8 not emitted by old) |
| change recap / implementation description | 7 | 4 |
| volatile number or status | 8 | 6 |
| in-progress design | 8 | 0 |
| total | 44 | 30 |
| **precision (durable share)** | **48%** | **67%** |

DeepSeek keeps more of the durable facts than gemini: 12 of 21, or 57%. On two runs it also added durable facts the old prompt missed; one of those runs emitted nothing under the old prompt. It removed every in-progress design fact in the sample. It still emits changed values such as retention windows and a "7-day window, 3-second timeout" line.

The 9 durable facts it dropped are:
- process rules: operator approval before issue replies; a real-client smoke test; a paired-simulator probe for streaming diagnosis;
- external gotchas: Anthropic OAuth revocation surfacing as a 401; the OpenAI `usage_limit_reached` code;
- settled-design rationales or names: the `github.bot_request` entry-point name; live-text suppression keyed on content; the Synapse bus-only serving rule.

### Compartment summaries

| model | variant | compartments | median P1 / P2 / P3 chars | mean importance | U: lines | range coverage |
|---|---|---:|---|---:|---:|---:|
| gemini | old | 37 | 4102 / 1672 / 585 | 72.5 | 23 | 0.976 |
| gemini | new | 39 | 3723 / 1492 / 526 | 72.3 | 25 | 0.976 |
| deepseek | old | 121 | 2306 / 1052 / 332 | 62.5 | 46 | 1.000 |
| deepseek | new | 127 | 2302 / 1008 / 372 | 64.1 | 46 | 0.999 |

Side by side on four chunks (20267, 20268, 20274, 20282), titles and P3 tiers carry the same outcomes, commits and decisions in both variants. In one chunk the new run split the work into two compartments at a real objective change. I saw no loss of anchors or U: lines. With one sample per variant, differences of this size are within sampling noise.

## Limitations

- One sample per chunk per prompt. Gemini ran at the provider default temperature, not the configured 0.1.
- The historian's `<project_memory>` was reconstructed from the current copy. Rows deleted since the run are missing, and some rows archived before the run may appear.
- Session references come from compartments currently stored before the chunk, which later recompaction may have changed.
- The classification is single-reviewer, and "durable" is generous. Some dropped facts are narrow (for example a CLI flag of an internal script) and could be judged recoverable from the code.
- Gemini ran through a privately fixed copy of the Antigravity Pi provider. The OpenCode production path was not replayed.
