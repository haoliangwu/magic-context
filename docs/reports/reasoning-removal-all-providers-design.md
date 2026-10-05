# Old reasoning removal on every provider, plus two emergency-drop guards: design note

Date: 2026-10-01. Written before the code change. It records what changes on which pass and why replay stays byte-identical.

## Evidence that motivates the change

A long OpenCode subagent on `openai/gpt-6.1-sol` (openai-auth, Responses API over WebSocket, `store:false`) sat at 100% context for its last hour. Its 04:18:49 request body was 2.99 MB:

| Part of the request | Size |
|---|---:|
| 609 `reasoning` input items, each with `encrypted_content` | 2.60 MB |
| tool calls | 255 KB |
| tool results (307 of 330 already `[dropped N]`) | 37 KB |
| messages | 23 KB |

Magic Context's tags recorded only 2,994 reasoning tokens for the session, because opaque reasoning is not counted. Each emergency pass at 100% dropped exactly one tag: the tool result that had arrived under a second earlier. That reclaimed 28 to 149 tokens against a gap of about 9,200. The logged floor was about 326K and the ceiling about 251K.

Two defects explain this:

1. Age-based reasoning cleanup runs only when the provider id is exactly `anthropic`, so every other route keeps all of its reasoning forever.
2. The emergency planner commits a pass that reclaims almost nothing, because its minimum is compared with the gap, not with what the chosen candidates reclaim.

## 1. Remove old reasoning parts on every provider

### Which parts

On assistant messages older than the age cutoff, remove every whole `reasoning`, `thinking` or `redacted_thinking` part. The cutoff is the current rule: the message's tag must be at most `maxTag − clear_reasoning_age`. Removal takes the part's provider metadata with it, including OpenAI's `itemId` and `reasoningEncryptedContent`. Text is never rewritten to `[cleared]`. The wire capture in `reasoning-cleanup-per-provider.md` shows that, on OpenCode 1.18.30, a removed part sends nothing on native Anthropic, Vertex, Bedrock, OpenAI Responses, Gemini and Groq. DeepSeek still sends an empty `reasoning_content`.

A message is never selected when it is one of these:

- the newest assistant message;
- the newest assistant that still carries replayable content (`findLatestAssistantReasoningMutationExemptMessage`, which skips OpenCode's metadata-only request shell);
- untagged (tag 0);
- a message whose removal would leave no wire content. Wire content means a non-empty text part, a tool part or a file part. This keeps an assistant from becoming an empty message on adapters that do not drop empty messages;
- a message whose reasoning payload would stay on the wire through another part. `@openrouter/ai-sdk-provider` sends `reasoning_details` taken from the message's tool-call provider options before the reasoning part (`findFirstReasoningDetails`). The adapter is recognized by its `metadata.openrouter.reasoning_details` on the message's parts, not by provider id, so custom ids are covered. Removal also strips those copies from the message's tool parts. When a copy is a Gemini thought signature (`format: google-gemini-*`), which Gemini needs back for every function call of the current turn, or a detail without a `format`, which cannot be told apart from one, the message is never selected and nothing changes. Rust cannot strip the copies, so it skips any message carrying them. The lane never changes bytes without taking reasoning off the wire; a per-route test pins this.

An ineligible message is skipped; it does not stop the walk.

**Prefix-bound models** (Fable 5.1, Opus 5.5 and Sonnet 5.5 via `isPrefixBoundThinkingModel`, on any route) bind each signed thinking block to every byte sent before it (`anthropic-thinking-binding.md`). They follow a different rule; see the next section.

### Prefix-bound models: the oldest prefix only

Anthropic's [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking) page has a table under "What counts as an edit". Each row compares two consecutive requests. The rows this lane relies on, quoted:

| Change between requests | Later thinking blocks |
|---|---|
| Remove `thinking` blocks from the start of the history, from the end, or all of them | Valid (the model loses that reasoning) |
| Remove a `thinking` block from the middle of the history and keep later ones | Invalid for every later thinking block |
| Put back a `thinking` block you removed on an earlier request | Invalid for thinking blocks produced while it was gone |
| Clear or shorten an earlier `tool_result`, re-encode an earlier image, or change an earlier `tool_use` input | Invalid for every later thinking block |
| Re-render the context you put in the first user message with a changed value | Invalid for every thinking block |
| Edit, reorder, or delete any earlier `user`, `assistant`, or `system` message | Invalid (with an on-demand-compaction exception) |

So on these models, on every host:

1. **The age lane removes a contiguous oldest prefix.** The walk goes oldest first over the reasoning-bearing assistants. It passes over messages whose reasoning is already gone (earlier removals, and the binding-mismatch strip set). It stops at the first message it may not remove: the newest assistant, one too young, untagged, without wire content after removal, or with reasoning that would stay on the wire (OpenRouter copies, a Pi redacted block, Pi inline `<thinking>` text). The removed set therefore never has a gap. A removed block is never put back: the set is persisted before any byte changes and replayed on every pass, as on other routes. The `[cleared]` watermark lane (canonical Anthropic) and the inline `<thinking>` strip stay off. They skip an ineligible message instead of stopping, so they could remove blocks after a block they leave in place: a removal from the middle. OpenCode TS uses the id-set lane on canonical Anthropic too, and Rust mints `reasoning_age` units there too.
2. **Any other edit before newer signed thinking strips everything.** A busting pass that also makes any other edit (a tool or text drop, an m0 or m1 change, an emergency drop, a structural or placeholder strip, a merged-reasoning strip, a todo pair or sticky reminder added to an earlier turn, a marker change, a requested materialization) runs the proactive strip, which removes every signed block. So does a pass that cannot say what it changed, such as the first render. Subagents are included.
3. **A pass whose only edit is the oldest-prefix trim keeps the newer blocks.** It does not run the proactive strip.

The pass decides from the facts it already reports, never by comparing bytes:

- **OpenCode TS:** `prefixEditBesidesReasoningTrim` in `transform-postprocess-phase.ts` ORs every mutation flag of the pass except the trim. That covers drops, heuristics, fold, m1, materialization, history, first render, emergency, skeletons, a merged-strip, trailing-blank or binding decision, the todo anchor, note and auto-search hints, the retired marker and the drop-mode switch.
- **Pi:** `RunPipelineResult.prefixEditBesidesReasoningTrim`, plus the sticky reminders and todo anchor the handler adds after the pipeline.
- **Rust:** `TransformResponse.reasoning_trim_only` is true only on a prefix-bound OpenCode SOFT pass with reason `selection`. Its only new units must be `reasoning_age`, with no reductions, caveman units, todo, calibration change, held or new overlays, guidance date change, released native keeps while overlays are active, held system strips, new `reasoning_clear` units or trailing-blank heals. The host keeps the newer blocks only when that flag is set and it added no note nudge and changed no marker itself.

In practice the usual trim-only pass is a force-band pass: context pressure alone permits the rewrite, and nothing else changes. Every other cause of a busting pass (first render, flush, fold, published history) is itself an edit. In Rust mode with the tag surface active, a bust that follows tail growth also lands the tag overlays withheld from demoted assistants, so it reports false and strips everything. A test pins that this edit is real.

**Why removing the oldest blocks keeps the newer ones valid, and why an earlier review concluded otherwise.** An earlier review turned the age lane off on these models. It argued that a signed block is valid only while everything sent before it is unchanged, so removing any older block invalidates every newer one, and an oldest-prefix removal protects nothing. The table says otherwise. The check compares what came before each kept block. Removing blocks from the start leaves no kept block with a changed history in front of it, so Anthropic lists that removal as valid. Only a removal that leaves a later block in place behind it is invalid. The review also made every busting pass strip every block. That is right when the pass makes another edit, and needless when the trim is its only edit.

### OpenCode (packages/plugin)

- **Canonical `anthropic`:** unchanged. The existing `clearOldReasoning` → `[cleared]` → empty-sentinel lane and its watermark replay stay exactly as they are, so canonical Anthropic output is byte-identical to today. The new lane does not run there.
- **Every other provider:** a new frozen id set holds the ids of assistant messages whose reasoning was removed.
  - **Storage:** a new `reasoningRemoval` namespace in the existing per-session replay document (`session_meta.trailing_blank_decisions`, v2 envelope, the same document `piNative` lives in). No schema change and no migration.
  - **Selection** runs only where `clearOldReasoning` runs today: inside the heuristics block, when `routineCleanupApplied` is true. That is the same cache-rebuilding permission every other mutation lane uses (ARCHITECTURE.md protected section, invariant 4). New ids are persisted, as a union, before any byte changes. If the write fails, nothing new is applied on that pass and the old set is replayed. After a successful write the committed set is re-read, so ids another process committed meanwhile are served on this pass, not first on a later defer pass.
  - **Unresolved provider:** no selection. The session may be canonical Anthropic, whose later passes would not replay the ids. Ids frozen by an earlier, resolved pass are still replayed.
  - **Unreadable state:** every write stores the state twice, as `reasoningRemoval` and `reasoningRemovalBackup`, in one compare-and-swap. A malformed primary is read from the backup, which is correct across processes and restarts. When neither copy (or the document itself) can be read, the pass fails closed with `EmergencyFailClosedError` rather than serve an empty set that would bring removed reasoning back.
  - **Application** happens on every pass, defer passes included, right after `finalizeMessageRepresentation`. It splices the reasoning parts out of every message whose id is in the persisted set, except the newest assistant with replayable content, which Rust also skips. A removed message can only become that message if newer history disappears (a revert), which already rewrites the cache.
- **Why at finalize:** several lanes read or write `message.parts` by index during a pass:
  - text tag content ids are `<messageId>:p<index>`;
  - file-part tag targets write `messageParts[partIndex]` from a closure;
  - the stale-reduce strip records indices;
  - merged-reasoning replay keys frozen parts by index.

  All of them run before the splice, on the unmodified array. OpenCode rebuilds the message array from its own database on every pass, so the next pass tags the original indices again. One lane does read positions after the splice: the tail-hygiene walk attributes text parts by `<messageId>:p<index>` on the spliced array, so in a reasoning-removed message its text can lose its tag attribution in the T/U accounting. That attribution is the same on every pass, so it never flips bytes or the baseline; it skews the nudge accounting only. `stripReasoningFromAssistantIds` already had the same effect on non-Anthropic routes. `reasoningByMessage` holds part references, not indices, and is used only by the canonical Anthropic lane.
- **Accounting:** the pass counts removed parts as a mutation (`heuristicOrReasoningDidMutate`), so the usual bust bookkeeping sees it.

### Reasoning invalidated by tool and text drops (OpenCode)

The audit in `reclaim-lanes-provider-matrix.md` (rows 3 and 4) found a second, larger source. When a tool or text tag was dropped, `clearThinkingParts` (`tool-drop-target.ts`) and the text-tag `setContent` (`tag-messages.ts`) wrote `[cleared]` into the related reasoning parts on every provider. Only canonical Anthropic converted those parts to an empty sentinel afterwards. Elsewhere the literal went to the wire:

- on Vertex, Bedrock and Copilot Claude, inside a signed block;
- on OpenAI, as a summary beside the untouched `encrypted_content`. In tonight's dump, 516 of 609 items had this shape and still held 2.1 MB.

**Change.** Both write sites now call `neutralizeDroppedReasoningPart`, and a drop never writes `[cleared]` into new bytes.

- The part object is rewritten in place to exactly the shape `makeSentinel(part)` produced: `{type:"text",text:""}`, keeping any cache marker. Its original fields are kept aside.
- **Canonical Anthropic:** the sentinel stays. That is the output the old `[cleared]` → `stripClearedReasoning` conversion gave, so the bytes do not change.
- **Every other route:** a drop leaves reasoning to the age lane, as Pi and Rust do. Before finalize, the original part is put back in place, byte for byte. Removing it with the drop was tried and dropped after review: the tag lane links an OpenCode tool to the reasoning of the step *before* it, so the removal took an unrelated block off the wire, and on prefix-bound models that removal sits in the middle of the history, which invalidates every newer signed block. (The drop itself already does that, which is why a pass with a drop strips them all.)
- **First pass after upgrade:** until the session's first rebuilding pass, the part is put back with `[cleared]` in its `thinking`/`text`, exactly the bytes the drop served before. That rebuilding pass records `reasoningRemoval.dropLeavesReasoning` in the replay document, and only after the write succeeds does it serve the restored parts; every later pass does the same, including passes whose provider is unresolved. The change in what a drop does to reasoning therefore first lands on a pass that already rebuilds, never on a defer pass. Before the switch, an unresolved provider gets the legacy bytes.
- Redacted parts (no `thinking` or `text`) are left alone, as before.
- `clearOldReasoning` and `replayClearedReasoning` skip parts that are already neutralized, so the age lane never writes `[cleared]` into them. The age-lane selection counts neutralized parts as reasoning, so a message whose reasoning a drop touched is still removed by age.

### Forced call skeleton beside reasoning (OpenCode)

`requiresToolArcSkeleton` (issue 423) keeps the real arguments of a dropped call whose assistant message carries reasoning, so Anthropic cannot merge signed turns. It applied on every provider and kept 190 KB (about 47K tokens) of call arguments in tonight's request.

It now applies only on Anthropic-family routes (`isAnthropicFamilyRoute`):

- canonical `anthropic`;
- any provider id containing `anthropic` (Vertex and custom ids such as `vertex-eu-anthropic`);
- any Claude model behind another provider: Bedrock Claude, Copilot, OpenRouter `anthropic/*`.

Non-Claude Bedrock models (Nova, Llama, DeepSeek R1) are excluded: they produce no signed Anthropic thinking. A Claude model served through a gateway whose provider id and model alias name neither `anthropic` nor `claude` is a known false negative.

On other routes the flag is cleared on the tag targets right after tagging, so emergency drops and the legacy conversion remove the pair fully. An unknown provider keeps the skeleton. Skeletons already persisted as `skeleton_real` keep replaying; only new decisions change.

### Pi (packages/pi-plugin)

Pi is the parity reference. It already clears typed thinking on every provider. `clearOldReasoningPi` has no provider gate. It empties `thinking` and drops `thinkingSignature`, which carries the OpenAI reasoning item and its encrypted content. Every Pi serializer drops empty thinking, so the block already leaves the wire on every route. Two guards are missing, and this change adds them:

- **Newest assistant:** never selected. The newest assistant has the highest tag, and replay covers only tags at or below the watermark, so a watermark below its tag cannot reach it on a later defer pass.
- **Prefix-bound models:** the cutoff is `piPrefixBoundReasoningCutoff`. It sits below the first assistant the clear would keep (the newest one, a redacted block, an untagged one, or text with inline `<thinking>` markup that the shared watermark would rewrite). It also moves back until every assistant before the stop lies at or below it, so the cleared set stays a prefix even when tags are out of order. The inline strip never starts on these models. The proactive thinking strip also runs for subagents.

The emptied shape stays as it is. Changing it to a splice would change Pi's working array for existing sessions without changing the wire. Native `providerPayload` reasoning (`canClearNativeReasoning`) keeps its existing gate. That gate concerns a different payload, Responses history captured by OMP, and is out of scope.

### Rust module (crates/mc-module)

Rust already has a whole-block removal lane: the `reasoning_age` frozen strip unit, used by Claude Code and replayed by `remove_frozen_historical_reasoning`. For the OpenCode profile on a provider other than canonical `anthropic`, `reasoning_age` units are minted on bust passes for eligible messages. The eligibility rules are the ones listed above. On prefix-bound models it selects only the oldest prefix (see above), on canonical `anthropic` too. The lane selects nothing when the provider is unresolved, or on OpenRouter: TS strips the tool-call `reasoning_details` copies there, and Rust does not, so it stays off rather than change bytes without shrinking the request. The reasoning cutoff for canonical Anthropic's `reasoning_clear` and Claude Code's `reasoning_age` is also not captured for prefix-bound models. Units are minted only when `is_bust_pass` holds, persisted with the other frozen units, and replayed unchanged on defers.

## 2. Emergency drop: a minimum reclaim per pass

`planEmergencyDrop`, used by OpenCode and by Pi, now computes the reclaim its selection would actually achieve and commits only when that clears a minimum:

```
minimum achievable reclaim = 2,000 tokens (EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS, equal to the rearm constant)
```

**Why this number.** In the evidence, each pass reclaimed 28 to 149 tokens against a 9,200-token gap and rewrote a prefix of roughly 300K tokens every time. A fixed 2,000-token floor blocks every observed pass. A share of the gap (10%) was tried and rejected: it would have skipped a 10K-token reclaim against a 177K gap, a pass worth having, and the existing planner tests encode that case.

**When the pass is skipped:** it is a no-op with a logged reason, and the pressure-episode latch is not consumed.

**Floor above ceiling:** when the estimated fixed floor alone exceeds the ceiling, the reason says so plainly, for example: `fixed floor ≈326000 already exceeds ceiling 251000: tool drops cannot reach the target`.

Rust's `select_emergency` gets the same rule and constant. Instead of a reason string, its assessment records `floor_above_ceiling` and `skipped_below_minimum_reclaim`, and the module logs both through `tracing`.

**What waives the minimum.** Only a rewrite this pass already pays for, because riding it costs nothing extra. That is Pi's predicate: newly applied drops, a fold that busts the served prefix, or a rebuilt history injection. Replaying persisted drop statuses never counts: it restores bytes already served and is true on every pass that holds a drop, so the incident session (307 of 330 results dropped) would never have applied the minimum. The same predicate decides when TS rearms the pressure episode and admits the routine lanes, as in Pi. In Rust, the force-band edge and the 95% backstop are permissions to rewrite, not paid rewrites, so they do not waive it either: `emergency_minimum_waived` and `supersession_ride_available` both derive from one `independent_rebuild` expression, the ride adding only the force edge and the backstop. Transform-level tests in TS and Rust drive a 100% pass with drops already persisted and show a sub-2,000-token selection skipped.

## Considered and dropped: exempting unseen tool results

A third guard was considered: never let an automatic lane drop a tool result before a completed later step has read it. It was dropped before implementation. Removing old reasoning removes the cause, and the minimum reclaim per emergency pass already stops a pass from discarding a small fresh result for nothing. The unseen check would add a walk of the message array on every pass and three implementations (OpenCode, Pi, Rust) to keep in sync, without preventing anything those two changes do not.

## Where TypeScript and Rust differ from Pi after this change

| Technique | Pi (reference) | OpenCode TS | Rust (`opencode-aisdk`) |
|---|---|---|---|
| Age-based reasoning removal | All providers. Thinking is emptied and its signature dropped, and the serializer then drops the block. The watermark is bounded below the newest assistant. Oldest prefix only on prefix-bound models. | Canonical Anthropic: unchanged `[cleared]` → sentinel lane. Every other route: whole-part removal from a frozen id set (OpenRouter tool-call `reasoning_details` copies leave too; Gemini-signed messages are never selected). Prefix-bound models: oldest-prefix id-set removal on every route. Off for unresolved providers. | Canonical Anthropic: unchanged `reasoning_clear` shells. Every other route: frozen `reasoning_age` whole-block removal. Prefix-bound models: oldest-prefix `reasoning_age` units on every route. Off for unresolved providers and OpenRouter. |
| Proactive strip on prefix-bound models | Busting passes that make another edit, subagents included. | Busting passes that make another edit, subagents included. | Host postprocess on module busts not reported as `reasoning_trim_only`, subagents included. |
| Reasoning side effect of a drop | None; reasoning is left to the age lane. | Canonical Anthropic: empty sentinel (unchanged). Elsewhere: none, reasoning is left to the age lane (legacy `[cleared]` bytes replayed only until the first rebuilding pass after upgrade). | None; reasoning is left to the age lane. The native encoder also drops historical reasoning from assistant messages whose parts changed. |
| Emergency minimum waived by (and episode rearm) | Applied drops or a busting fold. | Applied drops, a busting fold or a rebuilt history injection; never drop replay. | An independent rebuild only; never the force edge or the 95% backstop. The latch clears only on pressure exit. |
| Forced skeleton beside reasoning | Exempt only for `openai-responses` and `openai-codex-responses`. | Anthropic-family routes only. | No blanket rule; only a targeted separator safeguard. |
| Native Responses reasoning items | Codex API with compat flags (`canClearNativeReasoning`), unchanged. | Covered by whole-part removal, because the encrypted payload lives on the part. | Covered by whole-block removal. |

## Replay and byte identity

| Lane | Selection | Persisted as | Defer pass |
|---|---|---|---|
| OpenCode non-Anthropic removal | rebuilding passes only | message id set in the replay document | splices the same ids at finalize |
| OpenCode drop path | the drop's own rebuilding pass | the persisted drop, plus `dropLeavesReasoning` for the upgrade switch | drop replay neutralizes again; non-Anthropic puts the part back (legacy `[cleared]` bytes until the first rebuilding pass after upgrade) |
| Forced skeleton scope | new drops and new legacy conversions only | the persisted `drop_mode` | already persisted modes replay unchanged |
| OpenCode canonical Anthropic | unchanged | unchanged watermark | unchanged |
| Pi | rebuilding passes only (oldest prefix on bound models) | existing watermark, now clamped | existing replay |
| Rust | bust passes only | `reasoning_age` frozen units | existing unit replay |
| Emergency minimum reclaim | only changes what a rebuilding pass selects | nothing new | drops already applied replay as before |

## Real-host wire evidence (recorded after implementation)

**Setup.**

- **Harness:** `packages/e2e-tests/src/repro/reasoning-removal-real-host.ts`.
- **Host:** the installed OpenCode **1.18.30** (`opencode-stock-1.18.30`), running `serve` with the locally built plugin (`packages/plugin/dist`).
- **Fixture:** a plugin listed before Magic Context. On every request it prepends the same single-turn tool loop: 40 assistant steps, each with `step-start`, a reasoning part carrying provider metadata, a completed `bash` call and `step-finish`.
- **Endpoints:** every route is a loopback recorder that rejects the request after OpenCode has serialized it. The captures therefore prove the wire shape and its replay, not provider acceptance.
- **Isolation:** one throwaway root per scenario under `$TMPDIR/magic-context/reasoning-removal/run6/` (rerun after the second review round; the same counts as run5), holding HOME, all XDG roots, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`. After every scenario, `lsof -p <host pid>` listed only the `wire.db` and `context.db` files (plus their WAL and SHM files) inside that root.

**What each scenario does.**

- **age** (`clear_reasoning_age=10`): passes 1 to 3 are three prompts in one session. Pass 1 is the session's first pass, which is a rebuilding pass. Passes 2 and 3 are defer passes.
- **drop** (age lane idle): passes 1 and 2 serve the loop as is. A `drop` is then queued for `call_fx_5`, and `/ctx-flush` makes pass 3 a rebuilding pass. Pass 4 is a defer pass.
- **Prefix hash:** compares the serialized history before the newest tool-result segment.

| Route (adapter) | Lane | Reasoning blocks of 40 on the wire, by pass | Encrypted payloads / signatures | `[cleared]` | Fixture prefix hash across later passes |
|---|---|---|---|---|---|
| `anthropic` (`@ai-sdk/anthropic`, signed thinking) | age | 1 / 1 / 1 | 1 signature | 0 | identical on passes 1–3 |
| `anthropic` | drop | 2 / 2 / 2 / 2 (tool calls 40 → 39) | 2 signatures | 0 | identical on 1–2; identical on 3–4 |
| `vertex-eu-anthropic` (`@ai-sdk/google-vertex/anthropic`) | age | 9 / 9 / 9 | 9 signatures | 0 | identical on 1–3 |
| `vertex-eu-anthropic` | drop | 40 / 40 / **39** / 39 (tools 40 → 39) | 40 → 39 signatures | 0 | identical on 1–2; identical on 3–4 |
| `openai` (`@ai-sdk/openai` Responses, `store:false`) | age | 9 / 9 / 9 | 9 `encrypted_content` | 0 | identical on 1–3 |
| `openai` | drop | 40 / 40 / **39** / 39 (tools 40 → 39) | 40 → 39 `encrypted_content` | 0 | identical on 1–2; identical on 3–4 |
| `google` (`@ai-sdk/google`, Gemini 2.5 Pro) | age | 9 / 9 / 9 | 9 `thoughtSignature` | 0 | identical on 1–3 |
| `google` | drop | 40 / 40 / **39** / 39 (tools 40 → 39) | 40 → 39 thought signatures | 0 | identical on 1–2; identical on 3–4 |

**Reading the rows.**

- The newest assistant's reasoning and the newest tool result were on the wire in every pass.
- Canonical Anthropic keeps only one or two blocks because its existing merged-reasoning lane keeps at most one reasoning block per run of consecutive assistant messages. That lane is unchanged.
- On the drop rows, the drop removed the tool call and its owner message, together with that message's own reasoning (39 of 40 left). The reasoning of the step before it, which the tag lane links to the dropped call, stayed intact: drops leave reasoning to the age lane. No `[cleared]` text appeared, because each session's first pass is a rebuilding pass, which switches the drop mode.

**Worker shape (OpenAI, 300 steps, about 3 KB `encrypted_content` each).**

| Run | Request bytes | Reasoning items | Newest tool result present |
|---|---:|---:|---|
| age lane idle (control) | 1,458,451 | 300 | yes |
| this change | **494,863** (−66 %) | 9 | yes |

The 494,863-byte request was byte-identical in its fixture prefix across the two defer passes that followed. At about 0.25 tokens per byte, the control is about 365K tokens and the new request about 124K. That is below the ~251K ceiling logged in the incident, and the reduction comes without dropping any tool result.

**Not covered by this run.** The forced-skeleton scope needs a pressure-driven emergency drop, which requires provider usage numbers; the recorder returns none. It is covered by the unit test of `isAnthropicFamilyRoute` and by the transform wiring, but not on a real host.

## What this note cannot settle offline

Provider acceptance cannot be proven offline. The open questions, each with the live call that would settle it:

1. **OpenAI Responses (Codex OAuth, `store:false`), removed reasoning mid-turn.** Does the service accept the worker's own turn with the reasoning items of older steps removed while their `function_call` items stay? Send tonight's body twice, as-is and with every reasoning item older than the 10 newest removed, and compare status, `usage.input_tokens` and `cached_tokens`.
2. **OpenAI `previous_response_id` and WebSocket suffix continuation.** openai-auth may send only a suffix and rely on server state. Does a server-held prior response restore reasoning that the client dropped? Run one continuation with `previous_response_id` after a removal pass.
3. **Vertex-Anthropic and Bedrock, removal of an oldest prefix of signed thinking.** Send three completed turns, then a request with the first two thinking blocks removed. On binding models (Opus 5.5, Fable 5.1), add `prefix_mismatch_behavior:"error"`.
4. **Gemini, thought parts removed beside retained function-call signatures.** One Gemini 2.5 call and one Gemini 3 call, each with older thought parts removed.
5. **Copilot Claude, reasoning part (and its `reasoning_opaque`) removed.** One call.
6. **Unsigned chat routes (DeepSeek, Kimi), function-call pairs fully removed.** One call each, with an older pair removed beside retained `reasoning_content`.
