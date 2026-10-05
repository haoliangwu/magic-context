# Request-mutating techniques by provider route: verdict matrix

Date: 2026-10-01. Research only; no product code changed. Base `8a69b3a95c5bc76bb7f7f70f684bae0dc2aaf531`.
Hosts: **OpenCode 1.18.30** (Vercel `ai` 6.0.168 plus the `@ai-sdk/*` adapters pinned in its `package.json`), **OpenCode 2.0.20** (its own `@opencode/ai` package; protocol code read from the cached `@opencode/ai@2.0.15` build and the `v2.0.20` tag of a local OpenCode checkout), and **Pi** (`@earendil-works/pi-ai` 0.83.0 as installed under `packages/pi-plugin/node_modules`).
Companion to [reasoning-cleanup-per-provider.md](reasoning-cleanup-per-provider.md), whose wire captures (mark **W**) are reused here and not repeated.

Evidence marks: **S** = read in source (MC, host or adapter). **W** = wire capture from the companion report (real 1.18.30 binary, mock endpoints). **D** = observed in tonight's request dump. **U** = unknown; the cell says what would settle it. No provider was called, and no live store was opened. The dump was read from a read-only copy.

## Bottom line

1. **Most reclaim lanes are provider-independent, and they work on every route.** Tool-call removal, the `[dropped §N§]` result placeholder, `ctx_reduce`, age sweep, dedup, supersession, the emergency tier planner, caveman, inline-thinking strip, and marker-only reply neutralization all run on every provider, and their effect reaches the wire on every adapter (S). Only empty-text sentinels and typed-reasoning removal are provider-gated.
2. **One `providerID === "anthropic"` predicate gates seven lanes** in the OpenCode plugin (`sentinel.ts:37-39`): typed reasoning age clearing and its watermark replay, conversion of `[cleared]` reasoning to empty sentinels, structural-noise strip, stale `ctx_reduce` strip, processed-image strip, merged-reasoning strip, and trailing-blank decisions. The Rust engine copies it (`request_accepts_empty_content`, `crates/mc-module/src/transform.rs:15101-15107`). Pi uses the same predicate for image strip and stale `ctx_reduce`, even though Pi's own mechanisms for those two never emit an empty sentinel.
3. **The biggest loss tonight is not a disabled lane. It is an ineffective one.** Tool drops write `"[cleared]"` into the reasoning parts of the owning assistant message on every provider (`tool-drop-target.ts:250-255`, `tag-messages.ts:892-900`). Only canonical Anthropic then removes those parts. On OpenAI Responses the serializer keeps `encrypted_content` and only replaces the summary text. In the dump, **516 of 609 reasoning items carry `summary:[{"text":"[cleared]"}]` and still carry 2.10 MB of encrypted payload.** All 609 reasoning items together are **2,595,374 bytes, 87.0 % of the 2,983,691-byte body** (D). Every one of them precedes the last user message.
4. **The second biggest loss is the forced skeleton.** When an arc's assistant message carries native reasoning, emergency drops and the legacy-skeleton conversion keep the call with its **real arguments** (`heuristic-cleanup.ts:175-181`, `apply-operations.ts:231-242`). That rule exists to stop Anthropic from merging signed assistant turns. It is applied on every provider, and on OpenAI Responses every tool step carries reasoning. The dump serves **307 dropped calls whose arguments total 190,133 bytes (≈47.3 K o200k tokens)** (D). Pi already exempts `openai-responses` and `openai-codex-responses` from this rule (`packages/pi-plugin/src/context-handler.ts:3351-3353`).
5. **Signed-block corruption is real on non-canonical Claude routes.** On Vertex-Anthropic, Bedrock and Copilot-Claude, the tool-drop `[cleared]` write reaches the wire inside a signed thinking or reasoning block, or beside retained opaque state (W for the serializer shape, S for the MC write path). Commit `cabf06dac0` closed this hazard for age-based clearing only. The tool-drop path has the same hazard and was never gated.
6. **Test coverage cannot see any of this.** The OpenCode 1.x e2e harness runs the real `@ai-sdk/anthropic` serializer, but under providerID `mock-anthropic` (`packages/e2e-tests/src/opencode-runner/spawn.ts:295-296`). That disables every canonical-Anthropic lane in the default e2e suite. The only multi-provider serializer test, the companion repro, deliberately bypasses MC.

## Technique × route matrix

Legend: **AC** active-correct · **AI** active-ineffective · **AH** active-harmful · **D** disabled by a gate · **U** unknown · **N/A** the route has nothing for the technique to act on · `+` the technique adds bytes by design (injections), the route is irrelevant.

Routes: **ANT** canonical `anthropic` · **VTX** `google-vertex-anthropic` · **BDR** `amazon-bedrock` (Claude) · **CPL** `github-copilot` (Claude over chat) · **OAI** `openai` Responses, `store:false`, via openai-auth · **ORT** `openrouter` · **GEM** `google` Gemini and Antigravity · **DSK** `deepseek` · **GRQ** `groq` · **XAI** `xai` (chat) · **OLC** `ollama-cloud` · **KIM** Kimi / Moonshot · **CRB** `cerebras` · **PI** Pi's own providers (Pi implementation).

| # | Technique (OpenCode TS unless noted) | ANT | VTX | BDR | CPL | OAI | ORT | GEM | DSK | GRQ | XAI | OLC | KIM | CRB | PI |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Tool drop, full removal (`ctx_reduce`, age sweep, dedup, supersession) | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC |
| 2 | Tool drop skeleton: real args, result → `[dropped §N§]` | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC |
| 3 | Forced skeleton beside native reasoning (emergency drop, legacy conversion) | AC | AC | AC | U | **AI** | U | U | AI·U | AI·U | **AI** | AI·U | AI·U | AI·U | AC; OAI-family exempt → AC |
| 4 | `[cleared]` written into reasoning by tool/text drops | AC¹ | **AH** | **AH** | **AH** | **AI** | U | U | AC | AC | AI | AC | AC·U | AC | N/A² |
| 5 | Typed reasoning age clear + watermark replay | AC¹ | D | D | D | D | D | D | D | D | D | D | D | D | AC·U |
| 6 | Native Responses reasoning-item removal (Pi only) | absent | absent | absent | absent | absent | absent | absent | absent | absent | absent | absent | absent | absent | AC (Codex API only) |
| 7 | Inline `<think>`/`<thinking>` strip + replay | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC |
| 8 | Structural-noise strip (`step-*`, `meta`, cleared reasoning → `""`) | AC³ | D | D | D | D | D | D | D | D | D | D | D | D | absent |
| 9 | Trailing-blank / whitespace decisions | AC | D | D | D | D | D | D | D | D | D | D | D | D | absent |
| 10 | Merged-assistant reasoning strip | AC | D | D | D | D | D | D | D | D | D | D | D | D | absent |
| 11 | Thinking-binding recovery strip (model-ID triggered) | AC | AC | AC | U | N/A | U | N/A | N/A | N/A | N/A | N/A | N/A | N/A | AC |
| 12 | Marker-only reply / system-injection neutralization (`""` vs `[dropped]`) | AC | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC⁴ | AC (splice) |
| 13 | Stale `ctx_reduce` strip | AC | D | D | D | D | D | D | D | D | D | D | D | D | D (non-`anthropic`) |
| 14 | Processed-image strip | AC | D | D | D | D | D | D | D | D | D | D | D | D | D (non-`anthropic`) |
| 15 | Caveman text compression (default off, primary only) | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC |
| 16 | Synthetic todo | + | + | + | + | + | + | + | + | + | + | + | + | + | + |
| 17 | `§N§` tag prefixes (user, assistant, tool) | + | + | + | + | + | + | + | + | + | + | + | + | + | + |
| 18 | m0/m1 head injection, compaction markers, prefix trim | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC | + / AC |
| 19 | Nudges, note/auto-search reminders, system-prompt guidance | + | + | + | + | + | + | + | + | + | + | + | + | + | + |
| 20 | LKG replay | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC | AC |

¹ Correct only while compaction is on: the conversion from `[cleared]` to an empty sentinel (`transform.ts:2175-2176`) is skipped under `compactionOff`. On binding models (Fable 5.1, Opus 5.5, Sonnet 5.5), tool-drop clearing is not ordered as an oldest prefix, so a middle gap can invalidate later signed blocks. Acceptance is **U**; see the companion report's binding section.
² Pi's tool drops do not write `[cleared]`; Pi clears typed thinking only in the age lane (row 5).
³ Source suggests a wrinkle: if the same message still holds an Anthropic-signed reasoning part, OpenCode 1.18.30 replaces an empty text part with `" "` before the adapter (`message-v2.ts` L262-285 at v1.18.30), so a sentinel there reaches the wire as a one-space text block. Settle with a W capture of a mixed signed-reasoning message after the structural strip.
⁴ Active with the 9-character `[dropped]` placeholder instead of an empty message. The message is kept, so the saving is the original text minus 9 characters.

"AI·U" means the lane spends bytes for no known benefit on that route, but nobody has verified that removing the pair is accepted there.

## Host facts every verdict depends on

**OpenCode 1.18.30, all `@ai-sdk/*` routes.** MC runs in `experimental.chat.messages.transform` on stored `{info,parts}` messages, so its output goes through:
- `message-v2.ts` `toModelMessages`. Assistant text parts pass through unchanged, except that an empty text part in a message with an Anthropic-signed reasoning part becomes `" "` (v1.18.30 L262-285). Reasoning provider metadata is kept only for the same model.
- `ai@6.0.168` `convertToLanguageModelPrompt`. It removes an assistant text part when `text === ""` and it carries no `providerOptions` (`~/.bun/install/cache/ai@6.0.168@@@1/dist/index.mjs:1438-1440`). MC's sentinels carry no metadata, so a lone empty sentinel is removed on **every** 1.18.30 route. This matches the companion report's W result ("text sentinel omitted" on all ten adapters). Reasoning parts are not filtered here.
- `provider/transform.ts` `normalizeMessages`. This is keyed on the adapter **npm**, not the providerID. `@ai-sdk/anthropic` drops `""` text and unsigned blank reasoning, but keeps signed or redacted reasoning even when it is empty (L168-195). `@ai-sdk/amazon-bedrock` keeps only signed or redacted reasoning (L197-222). Vertex-Anthropic's npm is `@ai-sdk/google-vertex/anthropic`, so neither branch runs for it.
- Then the adapter. Empty assistant messages, the reason for whole-message `[dropped]`, are still forwarded by OpenAI-compatible adapters. Commit `9c0a49b127` documents Kimi/Moonshot rejecting them.

**OpenCode 2.0.20.** MC registers the native `session.hook("context")` (`packages/plugin/src/v2/hooks/context.ts:1676-1680`). It receives `@opencode/ai` draft messages after OpenCode's lowering, which already removed empty text and dropped wholly empty assistants (`packages/core/src/session/runner/to-llm-message.ts:208-211,224` at v2.0.20). The adapter maps those messages to `{info,parts}` and runs the same TypeScript transform (`packages/plugin/src/v2/hooks/payload.ts:283-323`). Every gate below therefore applies to 2.x unchanged. MC's sentinels are created after that lowering, so only the protocols see them:
- `anthropic-messages` drops blank assistant text and sends signed reasoning even when its text is `[cleared]` or empty (2.0.15 build `dist/protocols/anthropic-messages.js:784-843`).
- `open-responses` keeps `""` `output_text`. It sends reasoning as a summary plus `encrypted_content` (`open-responses.js:425-482`).
- `openai-chat` and the compatible-chat variant skip an assistant only when every text part is blank (`openai-chat.js:283-372`).
- `gemini` and `bedrock-converse` emit empty text (`gemini.js:235-309`, `bedrock-converse.js:186-236`).

So the 2.x serializer verdicts match 1.18.30 for every lane MC actually enables. The 2.0.20 protocol source was not diffed line by line against the 2.0.15 build (**U**, minor).

**Rust engine.** Opt-in with `transform_mode: "rust"`. The default is `"ts"` on both hosts (`packages/plugin/src/config/schema/magic-context.ts:1110-1115`). OpenCode sends serializer profile `opencode-aisdk` with `serve_native` (`rust-mode-transform.ts:1435-1442`). Rust also serves Claude Code (`claude-code-anthropic`) and a `pi` profile (`crates/mc-module/src/healing.rs:9-49`).

**Pi.** Every Pi provider first goes through `transform-messages.js:68-90`. That step keeps signed empty thinking for the same model and drops unsigned empty thinking. It also turns nonempty thinking from another model into text. Then each provider converter skips empty text and empty thinking (`anthropic-messages.js:885-930`, `openai-completions.js:840-891`, `google-shared.js:115-149`, `bedrock-converse-stream.js:625-693`). OpenAI Responses replays a reasoning item only from a truthy `thinkingSignature`, which is the stored item including `encrypted_content` (`openai-responses-shared.js:129-164`).

**Route → adapter.** Taken from models.dev on 2026-10-01 and OpenCode 1.18.30 `provider.ts:113-140`:

| Route | Adapter / protocol | Prior reasoning on the wire (1.18.30) |
|---|---|---|
| anthropic | `@ai-sdk/anthropic` 3.0.111 | `thinking` + signature (W) |
| google-vertex-anthropic | `@ai-sdk/google-vertex/anthropic` 4.0.181 | same signed `thinking`; no npm filter (W) |
| amazon-bedrock | `@ai-sdk/amazon-bedrock` 4.0.166 | `reasoningText` + signature (W) |
| github-copilot | OpenCode's own Copilot adapter; Claude uses chat | `reasoning_text` + `reasoning_opaque` (W) |
| openai (openai-auth) | `@ai-sdk/openai` 3.0.88 Responses, `store:false`. openai-auth does not rewrite `input` items (`openai-auth/packages/opencode/src/ws-pool.ts:828-853`). WebSocket continuations may send a suffix only (`ws-pool.ts:994-1067`). | `reasoning` item: `encrypted_content` + summary (W, D) |
| openrouter | `@openrouter/ai-sdk-provider` 2.9.0 | `reasoning` text only while `reasoning_details` survive (S, converter L229-379) |
| google / Antigravity | `@ai-sdk/google` 3.0.73. antigravity-auth re-wraps the Gemini body but does not touch `thought` / `thoughtSignature` (`antigravity-auth/packages/opencode/src/plugin/request.ts:610-680,742-778`). | `thought:true` + `thoughtSignature`. Empty thought dropped with its signature (W) |
| deepseek | `@ai-sdk/openai-compatible` 2.0.41 | `reasoning_content` (W) |
| groq | `@ai-sdk/groq` 3.0.31 | `reasoning` (W) |
| xai | `@ai-sdk/xai` 3.0.102 chat | none (W) |
| ollama-cloud | `@ai-sdk/openai-compatible` (`https://ollama.com/v1`) | `reasoning_content` when nonempty (S) |
| Kimi / Moonshot | `@ai-sdk/openai-compatible` for `moonshotai`, `kimi-code-plan-*` | `reasoning_content` when nonempty (S) |
| cerebras | `@ai-sdk/cerebras` 2.0.60 (OpenAI-compatible chat) | `reasoning` (moved from `reasoning_content`) (S) |

## Per-technique sections

### 1–3. Tool drops: full removal, skeleton, forced skeleton

- **Where.** TS: `tool-drop-target.ts:487-544` (`drop`, `skeletonReal`, `skeletonStripped`), `apply-operations.ts:84-108` (`applyNewToolDrop`), pending ops at `apply-operations.ts:405-430`, emergency at `heuristic-cleanup.ts:105-200`, legacy conversion at `apply-operations.ts:214-248`. Shared transcript target used by Pi: `packages/plugin/src/shared/tag-transcript.ts:1122-1240`. Pi wiring: `transcript-pi.ts:815-874`, `context-handler.ts:5251-5269`. Rust: `crates/mc-module/src/selection.rs:102-126,474-567,704-800,858-898,1704-1767`.
- **Gates.**
  - New drops ride a reclaim/bust pass (`transform-postprocess-phase.ts:1894-1916,2030-2054`). Persisted drops replay on every pass (`transform.ts:2084-2099`).
  - Age sweep needs a cache-busting pass, no emergency eligibility, tags at or before the reclaim watermark, and ≥250 estimated tokens. It always keeps the newest `todowrite` and the newest 3 `ctx_reduce` (`tool-reclaim.ts:18-48`, `reclaim-protection.ts:1-19`).
  - Supersession needs `smart_drops` (default `false`, `config/schema/magic-context.ts:1424-1428`). Dedup needs routine cleanup.
  - Emergency starts at the derived force band, needs a known ceiling, and runs for primaries and subagents. Below 95 % it protects the newest 20 % of T1/T2 (`emergency-drop.ts:215-300`). `execute_threshold_percentage` defaults to 65 (`schema/magic-context.ts:12-17,1204-1214`).
  - **No provider predicate** anywhere in these lanes, in TS, Pi or Rust.
- **Mechanism.**
  - Full removal deletes the part or pair (`ToolMutationBatch.finalize`, `tool-drop-target.ts:376-401`).
  - The skeleton keeps the call byte-for-byte and replaces the output with `[dropped §N§]` (`tool-drop-target.ts:133-144`).
  - A skeleton is used when the call is inside the newest-20 window and its input is small, when removal would strand the conversation end (`:362-374`), or, for emergency and legacy conversion only, when `requiresToolArcSkeleton` is set: the owning message has a `thinking`/`reasoning`/`redacted_thinking` part (`tool-drop-target.ts:257-262,650-655`; `heuristic-cleanup.ts:140,180`; `apply-operations.ts:233`).
  - `ctx_reduce` and age-sweep drops do **not** pass `keepSkeleton` (`apply-operations.ts:410-412`). They remove fully even beside reasoning.
  - Pi sets `requiresToolArcSkeleton=false` for `openai-responses` and `openai-codex-responses` (`transcript-pi.ts:230-233`, `context-handler.ts:3351-3353`).
  - Rust has no blanket rule. Arcs are ineligible only when the assistant message is reasoning plus reducible tools. A skeleton is kept only when removal would erase a tool-result separator between reasoning-bearing assistants (`selection.rs:474-567`).
- **Wire.** Every adapter serializes a string tool result as-is: Anthropic `tool_result.content`, Bedrock `toolResult.text`, Responses `function_call_output.output`, chat `role:"tool"`, Gemini `functionResponse` (S, all adapters; companion W for 1.18.30). Removal deletes both halves on every adapter.
- **Verdict.**
  - Rows 1–2: AC everywhere.
  - Row 3 is AC on Anthropic-family routes, where the separator matters.
  - Row 3 is **AI on OAI** (D: 307 skeletons with full arguments) and on XAI (reasoning is never replayed, so nothing is protected).
  - Row 3 is "AI·U" on the chat-completions routes. Their consecutive assistant messages carry `reasoning_content` but no signature, so the Anthropic merge hazard does not obviously apply. Nobody has checked whether removing the pair is accepted.
  - For OAI, the open question is whether a Responses `reasoning` item may stand without its following `function_call` under `store:false` with no item IDs. Only a live call settles it. Pi already removes such pairs on its Responses route (`7fb855a7fd`).
  - CPL, ORT and GEM are **U** for the same reason.

### 4. `[cleared]` written into reasoning by tool and text drops

- **Where.** TS `clearThinkingParts`, `tool-drop-target.ts:250-255`, is called from `drop`, `truncate`, `skeletonReal`, `skeletonStripped` and `applyEditMarker` (`:501,517,531,542,579`). The assistant-text tag drop writes the same at `tag-messages.ts:892-900`. Pi: absent; its shared transcript replaces non-tool parts with a text sentinel (`transcript-pi.ts:862-864`). Rust: absent; tool-arc reduction leaves reasoning intact (`selection.rs:858-898`).
- **Gates.** None by provider. It runs whenever the tool or text tag is dropped. The only later cleanup is `stripClearedReasoning`, gated on `providerID === "anthropic" && !compactionOff` (`transform.ts:2175-2176`; `transform-postprocess-phase.ts:1568-1586,2228-2229`).
- **Mechanism.** Rewrites the `thinking` and `text` fields in place and keeps the part with all its metadata.
- **Wire.**
  - **ANT:** converted to an empty text sentinel, then filtered → the reasoning leaves the wire.
  - **VTX/BDR:** signed `thinking` / `reasoningText` with text `[cleared]` (W, `cleared` mode).
  - **CPL:** `reasoning_text:"[cleared]"` with `reasoning_opaque` retained (W).
  - **OAI:** `summary:[{type:"summary_text",text:"[cleared]"}]` with `encrypted_content` retained (W; D: 516 items, 2,158,052 bytes).
  - **ORT:** `reasoning:"[cleared]"` while `reasoning_details` (encrypted or signed entries) survive (S).
  - **GEM:** `thought` text `[cleared]` with `thoughtSignature` (W).
  - **DSK/OLC/KIM:** `reasoning_content:"[cleared]"` (W/S). **GRQ:** `reasoning:"[cleared]"`. **CRB:** `reasoning:"[cleared]"` (S).
  - **XAI:** reasoning is not sent at all.
- **Verdict.**
  - **AH on VTX, BDR, CPL.** This is the hazard `cabf06dac0` named, still reachable through the tool-drop path. Service acceptance is U; the W captures prove the literal reaches the signed block.
  - **AI on OAI.** The opaque payload, the expensive part, survives. The visible summary shrinks.
  - U on ORT and GEM, where acceptance of altered text under a retained signature is unknown.
  - AC on the unsigned chat routes. AI on XAI, where it is a no-op.
  - Kimi thinking models may require `reasoning_content` on tool-call turns; acceptance of `[cleared]` there is U.

### 5. Typed reasoning age clear and watermark replay

- **Where.** TS write: `clearOldReasoning`, `strip-content.ts:312-342`, called at `transform-postprocess-phase.ts:2219-2230`. TS replay: `transform.ts:2118-2140`; `stripClearedReasoning` at `strip-content.ts:354-395`. Pi: `clearOldReasoningPi`, `reasoning-replay-pi.ts:125-184`, gated at `context-handler.ts:6234`, replayed at `:5897-5947`. Rust: `transform/reasoning_clear.rs:105-205`, `transform.rs:12556-12594,15118-15139,15222-15304`.
- **Gates.**
  - TS: `routineCleanupApplied && providerID === "anthropic"`. Replay runs every pass while the watermark is > 0, `!compactionOff`, provider `anthropic`. Age cutoff `maxTag − clear_reasoning_age`, default 50 (`hook.ts:726-727`). Runs in subagents too.
  - Pi: `reasoningClearing && shouldRunHeuristics && routineCleanupApplied`. **No provider gate.** Same default age.
  - Rust: `opencode-aisdk` + `serve_native` + provider `anthropic`, on bust passes. `claude-code-anthropic` clears with no provider check. The `pi` profile has no age clearing.
- **Mechanism.**
  - TS: `[cleared]`, then an empty sentinel (removal on the wire).
  - Pi: thinking becomes `""` and the signature is deleted. The empty unsigned block is then dropped by `transform-messages.js:79-84`. Redacted blocks are kept.
  - Rust: an empty-text sentinel for `opencode-aisdk`; whole-block removal for Claude Code.
- **Verdict.**
  - TS: AC on ANT and **D on every other route**. That includes VTX and BDR, where the companion report's W shows physical removal works.
  - Pi: AC on all Pi providers, since removal is the mechanism. On Responses, deleting the signature means no reasoning item is sent. Acceptance is U off Anthropic.

### 6. Native Responses reasoning-item removal (Pi only)

`native-replay-pi.ts:130-193`. Runs only for `api === "openai-codex-responses"` when every `requiresReasoningContent*` compat flag is `false`. The stored payload must have `dt === true`, no computer calls, no redacted thinking, and every reasoning item must hold `encrypted_content` with no plaintext. It removes the reasoning items from the captured native payload. Introduced in `77f8dda4a9` (2026-09-09). TS has no equivalent, so the OpenCode OAI route has no lane that can remove `encrypted_content`.

### 7. Inline-thinking strip

TS: `strip-content.ts:397-421`, regex `/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>\s*/g`. It needs `routineCleanupApplied` (`transform-postprocess-phase.ts:2231-2233`). Replay runs at `transform.ts:2136-2140` with no provider gate. Pi: `stripInlineThinkingPi`, `context-handler.ts:6245-6250`. Rust removes it on render (`transform.rs:12811-12819`). It rewrites plain assistant text, so it is AC everywhere it finds tags. The dump has 0 tags.

### 8. Structural-noise strip

TS: `strip-structural-noise.ts:5-52`, called at `transform.ts:2106-2107` and gated on `anthropic && !compactionOff`. It replaces `step-start`, `step-finish`, `meta` and `[cleared]` reasoning with empty sentinels. Rust: `transform.rs:12480-12488,12796-12809`, same gate. Pi: absent; Pi messages have no such parts (`context-handler.ts:5989-6000`).

`24020245e2` (#135) gated it because `step-start` is a message boundary in AI SDK 6.0.168. Replacing it changed the grouping and broke tool adjacency on Copilot. The gate is about **boundaries, not bytes**: step parts carry no content, so the wire saving off-ANT is about 0. **D** off ANT; about 0 B lost in the dump.

### 9–10. Trailing-blank decisions; merged-reasoning strip

- Trailing blanks: `strip-content.ts:587-779`, applied in finalize (`transform-postprocess-phase.ts:1602-1604`) and detected at `:3228`. Merged reasoning: `strip-content.ts:496-578,907-960`, detected at `:3125`.
- Both are `anthropic` only in TS and Rust (`transform.rs:13840-14170,14982-14995`). Both are absent in Pi.
- Merged-reasoning strip is the Opus 4.7 `groupIntoBlocks` workaround restored in `9c0a49b127`. It is Anthropic-specific by nature.
- **D** off ANT. The dump has 3 bytes of edge whitespace.

### 11. Thinking-binding recovery strip

`stripReasoningFromAssistantIds` (`strip-content.ts:850-875`). It is triggered by model identity (`isFable51ThinkingBindingModel`, `overflow-detection.ts:256-269`), not by providerID. On ANT it uses empty sentinels. Elsewhere it **splices** the reasoning part out, and it adds a whole-message `[dropped]` if the message empties. Pi runs its own recovery post-transform (`context-handler.ts:3578-3637`). AC on Anthropic-family routes. N/A where the model cannot be a binding model.

### 12. Marker-only reply and system-injection neutralization

TS: `strip-content.ts:15-20,136-242` and `sentinel.ts:143-149`, run at `transform-postprocess-phase.ts:2606-2705`. Gates: `!compactionOff && replaySnapshot`; new detections only on cache-busting passes; user messages excluded. The mechanism replaces the message with one text part: `""` on ANT, which the AI-core and npm filters then remove, and `[dropped]` elsewhere (`9c0a49b127`). Rust uses the same sentinel rule (`transform.rs:12259-12265,12668-12674`). Pi splices placeholder-only assistant messages out on every provider (`strip-placeholders-pi.ts:6-15,135-175`). AC everywhere; off ANT a 9-character placeholder remains. The dump holds one `[dropped §149§]` **user** message, which this lane excludes by design.

### 13–14. Stale `ctx_reduce` strip and processed-image strip

- **TS.** `drop-stale-reduce-calls.ts:56-72,108-145` and `strip-content.ts:1006-1049`. Called at `transform-postprocess-phase.ts:2435-2479` with `canUseEmptySentinels && !compactionOff && replaySnapshot`. Both replace parts with empty sentinels.
- **Pi.** Same predicate (`context-handler.ts:6083-6086,6365-6396`), but different mechanisms. Stale `ctx_reduce` uses the ordinary tool drop (`heuristic-cleanup-pi.ts:203-282`). Images become `{type:"text",text:"[image stripped]"}` (`strip-processed-images-pi.ts:40-49`). Neither needs an empty sentinel, so **Pi's gate here protects nothing**.
- **Rust.** Anthropic-only (`transform.rs:12659-12711`).
- **Verdict.** D off ANT. Images: Gemini 3 and OpenAI Responses replay tool-result and user images natively (S), so the loss is real on image-heavy sessions. Dump: 0 images, and only 2 `ctx_reduce` calls, within the keep-3 window. 0 B lost tonight.

### 15. Caveman compression

`caveman-cleanup.ts:73-199`, `caveman.ts`. Config `caveman_text_compression.enabled` defaults to `false`, `min_chars` to 500 (`schema/magic-context.ts:1430-1449`). It is primary-only (`transform.ts:2162`). It rewrites text in place and is provider-independent. Rust: `transform.rs:7500-7583`. Pi: `heuristic-cleanup-pi.ts:618-640`. AC everywhere when enabled. N/A for the dump, which is a subagent session (`x-parent-session-id` header).

### 16–20. Additive and replay surfaces

- **Synthetic todo** (`transform-postprocess-phase.ts:226-420`): `fullFeatureMode && !compactionOff`. Pi: `context-handler.ts:3528-3569`. Rust: `injection.rs:199-341`.
- **Tag prefixes** (`tag-messages.ts:478`; `transform.ts:1984-2029`): skipped when `ctx_reduce` is unavailable. Pi subagents skip visible prefixes. Rust: `lib.rs:1326-1341`.
- **m0/m1 and compaction** (`transform-postprocess-phase.ts:1694-1817,2482-2604`; `transform.ts:1873-1901`). Pi: `inject-compartments-pi.ts:2549-2586`, `context-handler.ts:6762-6890`. Rust: `transform.rs:3134-3274`.
- **Nudges and reminders** (`transform-postprocess-phase.ts:2716-2737,930-937`; system prompt at `system-prompt-hash.ts:241-320`). Pi: `ctx-reduce-nudge-pi.ts:116-309`.
- **LKG** (`plugin/messages-transform.ts:327-405`). Pi: `context-handler.ts:3861-3967`. Rust: the host replays the last-known-good array; only fingerprints are kept in Rust (`transform.rs:1219-1224,6433-6439`).

None of these is provider-gated, and their bytes serialize identically on every adapter as user or assistant text. In the dump, tag prefixes cost 139 bytes. m0/m1 and the synthetic todo are absent because the session is a subagent.

## Tonight's request: what the disabled and ineffective lanes left on the wire

Source: a read-only copy of `opencode-openai-auth-dumps/2026-10-01T04-18-49-093Z-84426-03818-ses_f0bf50925ffeHxNO94XOYG9ETB-websocket-main.body.json`, read from the system temp directory.

- **Host and route.** `gpt-6.1-sol`, Codex OAuth over WebSocket (`chatgpt.com/backend-api/codex/responses`), `store:false`, `include:["reasoning.encrypted_content"]`.
- **Size.** 1,277 input items; the body is 2,983,691 bytes.
- **Which host.** The body was built by OpenCode 1.x, not 2.x. Assistant `message` items carry `phase` and no `status`, which is the `@ai-sdk/openai` shape. OpenCode 2's `open-responses` always writes `status:"completed"` (`open-responses.js:443-451`).
- **Session kind.** The session is a **subagent** (`x-parent-session-id` header). Caveman, m0/m1 and the synthetic todo do not apply to it.

| Item type | Count | Bytes (compact JSON) |
|---|---:|---:|
| `reasoning` | 609 | 2,595,374 (87.0 %) |
| `function_call` | 330 | 254,831 |
| `function_call_output` | 330 | 37,857 |
| user `message` | 6 | 9,065 |
| assistant `message` | 2 | 14,234 |
| `instructions` (host) | — | 20,959 chars ≈ 4,705 tokens |
| `tools` (host, 30 tools) | — | 59,294 ≈ 12,922 tokens |

**Reasoning items.**
- Every item has keys `{type, encrypted_content, summary}` and no `id`.
- 516 have summary `[cleared]` (row 4). 1 has a real summary. 92 have an empty summary.
- `encrypted_content` totals 2,534,500 characters. All 609 values are Fernet tokens (leading version byte `0x80`). After base64url decoding they hold **1,865,552 bytes of ciphertext**, between 912 and 4,048 bytes per item.
- User messages sit at input indexes 0, 288, 300, 798, 1275 and 1276. The last two are system reminders. All 609 reasoning items sit before index 1275, so all belong to completed turns, and all lie far beyond the 50-tag age cutoff that row 5 would use.

**Tool arcs.**
- 307 of 330 outputs are `[dropped §N§]`.
- Their calls keep their real arguments: 190,133 bytes, of which `edit` 103,629, `bash` 44,301 and `write` 22,404.
- Full removal of those 307 pairs would delete 258,764 bytes of item JSON.

**Token method.**
- Readable text was counted with `o200k_base` through `ai-tokenizer` (installed under `packages/pi-plugin/node_modules`). That is the GPT-4o/GPT-5-family encoding. `gpt-6.1-sol`'s tokenizer is not public, so these counts are approximate.
- Encrypted reasoning cannot be tokenized client-side. Its billing is **U**:
  - *Lower bound 0.* This holds if the service does not put earlier turns' reasoning back into the model context.
  - *Upper bound about 466 K tokens.* This holds if the 1.87 MB of ciphertext were reinjected as UTF-8 text at about 4 bytes per token. The same figure results if it held 4-byte token IDs.
  - The upper bound would put this one request near half a million input tokens. That makes full reinjection implausible, but it is not proof.
- **To settle the billing question:** one live A/B on the same account. Send this body as-is and with every `reasoning` item before the last user message removed, then compare `usage.input_tokens` and `input_tokens_details.cached_tokens`. Make no other edits.

### Ranked list: biggest disabled or ineffective savings

| Rank | Technique and route | Status | Bytes in tonight's request | Tokens (method) | What settles it |
|---:|---|---|---:|---|---|
| 1 | Prior-turn `encrypted_content` on OAI. Nothing in OpenCode TS removes it: row 5 is **D**, row 4 is **AI** | D + AI | **2,595,374** (all 609 items); 2,158,052 of those are already marked `[cleared]` | 0 … ≈466 K (U, see above) | Live A/B on `usage.input_tokens`. Also check whether the service accepts a `function_call` with no preceding reasoning item under `store:false` |
| 2 | Forced skeleton on OAI (row 3): real arguments kept for drops beside reasoning | AI | **190,133** in arguments; 258,764 if the pairs were removed fully | ≈47,305 (o200k on the argument strings) plus per-item framing | A live call that removes a mid-history pair while keeping the surrounding reasoning items. Pi's `7fb855a7fd` already does this on Responses |
| 3 | `[cleared]` summaries on OAI (row 4): the residual placeholder text | AI (residual) | 516 × 9 characters of text, plus summary JSON (24,943 bytes for all summary arrays) | ≈2,161 for all summary text | None needed. It disappears once rank 1 is fixed |
| 4 | Tag prefixes (row 17), a deliberate cost | + | 139 | ≈50 | — |
| 5 | Trailing-blank decisions (row 9) | D | 3 | ≈1 | — |
| 6 | Structural-noise strip (row 8) | D | ≈0 (step parts are not serialized as content) | 0 | — |
| 7 | Stale `ctx_reduce` (row 13), image strip (row 14), inline thinking (row 7) | D / D / AC | 0 (2 `ctx_reduce` calls, inside keep-3; no images; no tags) | 0 | — |

Tonight's request needs no fix for ranks 4–7. Ranks 1–2 make up about 93 % of the body.

On the Anthropic-family routes, the same lanes give the following picture (S/W, no dump):
- VTX and BDR lose the whole of row 5. That is all completed-turn signed thinking past the 50-tag cutoff.
- Row 4 there also sends literal `[cleared]` inside signed blocks (AH).
- The companion report's W capture shows that physical removal is wire-clean on both routes. Acceptance is U.

## History of the provider gates

| Commit | Date | Gate introduced | What the commit says it protected against |
|---|---|---|---|
| `f41ebbf11b` | 2026-03-17 | `clearThinkingParts` writes `[cleared]` (no gate, then or now) | Initial extraction of the plugin |
| `d7dc17478c` | 2026-05-02 | Pi `clearOldReasoningPi` (no provider gate) | "full OpenCode runtime parity" |
| `9c0a49b127` | 2026-05-06 | `modelAcceptsEmptyContent` first appears; `makeWholeMessageSentinel` → `[dropped]` off `anthropic` | Kimi/Moonshot and other OpenAI-compatible routes rejected `content:""` assistant messages ("assistant message must not be empty"), traced through a wire dump |
| `24020245e2` | 2026-06-13 | Structural noise, cleared-reasoning strip, image strip and stale `ctx_reduce` all gated on the predicate (#135) | Copilot: an empty sentinel after `tool_use` (it replaced a `step-*` boundary) broke tool_use/tool_result adjacency after Copilot's Bedrock re-translation and caused a 400 on a fresh session |
| `cabf06dac0` | 2026-06-18 | `clearOldReasoning` and `replayClearedReasoning` gated (#162 D2) | Literal `[cleared]` inside reasoning blocks sent to non-canonical Claude proxies (Copilot, Bedrock-Claude) that validate thinking. Pi deferred "pending PI peer confirmation" |
| `66b9b34aab`, `876751fc43`, `ca2c5d37f2` | 2026-07-17 … 21 | Rust `request_accepts_empty_content` and `provider_sentinel_text` | Port of the TS gates (parity) |
| `3306131c9c` / `054de89aa5` | 2026-08-14 / 15 | Merged-reasoning and trailing-blank detection frozen behind `canUseEmptySentinels` | Cache stability on bust passes |
| `7756053bd9` | 2026-09-05 | `requiresToolArcSkeleton` (issue 423) | Removing a result separator beside native reasoning lets Anthropic merge signed assistant turns (`heuristic-cleanup.ts:175-177`) |
| `77f8dda4a9` | 2026-09-09 | Pi `canClearNativeReasoning` (Codex API, compat flags) | "reduce OMP native inputs and optional Codex reasoning" |
| `7fb855a7fd` | 2026-09-12 | Pi `preserveReasoningToolArcs` false for Responses APIs | Full drops remove complete pairs plus native Responses items; "Anthropic signed-turn separators … remain protected" |

Pattern: every OpenCode gate was added in reaction to a failure on one non-canonical route. Each was then applied to every non-`anthropic` providerID, including routes the failure says nothing about: OpenAI, Gemini, and the unsigned chat routes. The `[cleared]`-in-signed-block hazard that `cabf06dac0` fixed in the age lane is still open in the tool-drop lane.

**Stale premise in a source comment.** `sentinel.ts:25-35` says non-Anthropic adapters "forward `{type:"text",text:""}` parts as real content blocks". On 1.18.30, `ai` core removes metadata-free empty assistant text before **every** adapter (`ai@6.0.168` `dist/index.mjs:1438-1440`), and the W capture agrees. The real #135 failure was a boundary change, not an empty block. The comment is still right that whole-message emptiness and `step-start` boundaries are unsafe. It is wrong about part-level empty text in a message that keeps other content (S, W).

## Disagreements between TypeScript, Pi and Rust

| Technique | OpenCode TS | Pi | Rust (`opencode-aisdk` / `pi` / `claude-code`) |
|---|---|---|---|
| Typed reasoning age clear | `anthropic` only | **All providers** (empty + unsigned → dropped) | `anthropic` only / none / always (block removed) |
| Reasoning side effect of tool and text drops | Writes `[cleared]` on all providers | None | None (reasoning left intact) |
| Forced skeleton beside reasoning | All providers (emergency and legacy conversion) | All except `openai-responses` / `openai-codex-responses` | No blanket rule; targeted separator safeguard |
| Native Responses reasoning removal | absent | Codex API with compat flags | absent |
| Stale `ctx_reduce` strip | empty sentinel, `anthropic` only | ordinary tool drop, but still `anthropic` only | empty or `[dropped]` sentinel, `anthropic` only |
| Image strip | empty sentinel, `anthropic` only | `[image stripped]` text, but still `anthropic` only | `anthropic` only |
| Placeholder-only messages | `""` / `[dropped]` sentinel in place | spliced out on every provider | provider sentinel unit |
| Structural noise, trailing blanks, merged reasoning | `anthropic` only | absent | `anthropic` only |
| Caveman | primary only | primary only | non-subagent |

The predicate is identical everywhere: exact string equality on providerID `"anthropic"`. That excludes custom IDs such as `vertex-eu-anthropic`, and it excludes Kimi-for-coding when it is configured with `@ai-sdk/anthropic`, even though OpenCode's npm-keyed filter would apply to it.

## Test coverage

| Layer | Real provider serializer? | What it covers |
|---|---|---|
| `packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.ts` + `.capture.json` | **Yes:** the real OpenCode 1.18.30 binary with 10 adapters, against mock endpoints | Wire shape of `intact` / `[cleared]` / empty / sentinel / removed reasoning. **It bypasses MC**: fixtures model MC's outputs, not MC's gates |
| OpenCode 1.x e2e (`tests/*.test.ts`, `src/opencode-runner/spawn.ts`) | Yes: real binary + `@ai-sdk/anthropic` against a mock `/v1/messages` | Drops, skeletons (`real-or-absent-drops`, `adv-real-or-absent-bytes`), emergency, placeholders, tagging, todo, `thinking-block-safety`. **The default providerID is `mock-anthropic`** (`spawn.ts:295-296`), so every canonical-Anthropic lane (rows 5, 8–10, 13–14) is **off** in these tests. An `@ai-sdk/openai` mock exists (`spawn.ts:82,311-342`), but only the script `scripts/issue-572-probe.ts` uses it. `scripts/ckios-reasoning-only-probe.ts` uses `anthropic`; it is a script, not a test |
| OpenCode 2 e2e (`tests/opencode2/*`) | Yes: real 2.x binary. The runner defaults to providerID `openai` (`src/opencode2-runner/spawn.ts:268`); the harness and several tests use `anthropic` (`src/opencode2-harness.ts:76`) | Host lanes (marker policy, drops replay, emergency, todo schema, images). No test asserts reasoning bytes per provider |
| Pi e2e `tests/issue-586-pi-responses-orphans.test.ts`, `src/pi-harness.test.ts` | Yes: Pi `openai-responses` and `openai-completions` serializers; Anthropic `/v1/messages` | Tool-pair integrity after drops (no orphan results). Not reasoning removal |
| Rust `crates/mc-module/tests/real_daemon.rs` | No provider serializer; it exercises OpenCode-native encoding through the daemon | Transform spine, `serve_native` |
| Unit tests (`tool-drop-target.test.ts`, `strip-content.test.ts`, `transform-postprocess-phase.test.ts:5013-5090`, `strip-structural-noise.test.ts`, `transform-operations.test.ts`, Rust `codec/opencode.rs`, `codec/pi.rs`) | No: message arrays only | The provider gate as a boolean (Copilot no-op vs Anthropic clear), `[cleared]` writes, sentinel shapes |

No test combines MC's gate decision with a real serializer on any non-Anthropic route. No test asserts the OAI wire after a tool drop beside reasoning, which is the path that produced ranks 1–3. The canonical-Anthropic lanes have no e2e coverage at all, because the harness's providerID is not `anthropic`.

## What only a live call can settle

1. OpenAI Responses (Codex OAuth), `store:false`:
   - (a) the billing effect of prior-turn `encrypted_content`;
   - (b) acceptance when reasoning items are removed before the last user message;
   - (c) acceptance when a `function_call`/output pair is removed between reasoning items;
   - (d) whether a `[cleared]` summary beside the original `encrypted_content` is accepted and ignored. Tonight's session kept running, which suggests yes, but there is no response capture.
2. Vertex-Anthropic and Bedrock: acceptance of physically removing old signed thinking (an oldest prefix; also a middle gap on binding models). Rejection or drop behavior for `[cleared]` inside a signed block.
3. Copilot-Claude: acceptance when the reasoning part, with its `reasoning_opaque`, is removed.
4. Gemini and Antigravity: acceptance of `[cleared]` thought text beside a retained `thoughtSignature`, and of removing thought parts (Gemini 3 tool-call signature rules).
5. Kimi / Moonshot thinking models: whether `reasoning_content` may be shortened or removed on tool-call turns.
6. OpenRouter: behavior when `reasoning` is `[cleared]` but encrypted or signed `reasoning_details` remain.

Every one of these needs a disposable, authorized credential, as the companion report's probe plan describes.
