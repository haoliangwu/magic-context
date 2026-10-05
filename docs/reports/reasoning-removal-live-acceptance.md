# Old reasoning removal: live provider acceptance

Date: 2026-10-01. Plugin under test: commit `7e61ac82fd`, the tip of the reasoning-removal branch, built into `packages/plugin/dist`. Design: `reasoning-removal-all-providers-design.md`. That note's real-host proof used recording endpoints, so it showed the wire shape but not whether providers accept it. This report settles acceptance with real, billed calls.

## Verdict

**No provider rejected a request after reasoning removal.** Two providers could not be tested, and one test found a lane that does not shrink the request.

| Provider (route, model) | Removal on the wire | Accepted after removal | Billed input before → after (cached) |
|---|---|---|---|
| OpenAI Responses, API key, `store:false` + `include:["reasoning.encrypted_content"]`, `gpt-5-nano` | 2 of 2 old reasoning items removed; all 12 `function_call` items kept | **yes**, 6 of 6 calls | 13,141 (13,056) → **9,903** (9,344); the next call 9,939 (9,856) |
| DeepSeek, `deepseek-flash`, thinking on, age lane | 5 oldest `reasoning_content` values sent as `""` | **yes**, 6 of 6 | 12,025 (11,776) → 12,016 (11,136); the next call 12,278 (12,032) |
| DeepSeek, drop lane (oldest tool pair dropped, then `/ctx-flush`) | tool call and its result fully removed (12 → 11 of each) | **yes**, 6 of 6 | 11,998 (11,776) → 11,979 (11,136); the next call 12,041 (11,904) |
| OpenRouter, `anthropic/claude-haiku-4.5` | **ineffective at `7e61ac82fd`**: the plugin selected 1 assistant message for reasoning removal, but only the plain `reasoning` text left the wire; the signed `reasoning_details` block stayed. **Fixed; see the rerun below** | yes, 19 of 19 (nothing signed was removed) | 13,381 (13,280) → 13,400 (11,664); after the fix 13,530 (13,425) → **13,374** (11,664) |
| OpenRouter, `google/gemini-3-flash-preview` | **not exercised**: the host stored no reasoning parts to remove | yes, 19 of 19 (no removal) | n/a |
| Bedrock, `us.anthropic.claude-haiku-4-5-20251001-v1:0` | **not run** | n/a | n/a |
| Kimi For Coding, `kimi-for-coding` | **not run** | n/a | n/a |

On the providers where removal happened, input is the provider's own field: OpenAI `input_tokens` and DeepSeek `prompt_tokens`, both of which include cached tokens. Cached is the provider's cached-token count. "Before" is the last call before removal and "after" is the first call that showed it; both are on the same session.

### Merge blockers

**No rejection was observed, so no provider blocks the merge on acceptance.** Three things are still open:

1. **Bedrock Claude (signed thinking) is unproven.** The design note flagged it as the riskiest case. Claude's thinking blocks carry provider signatures, and the test must show that Bedrock accepts a request after the oldest of them are removed. On models whose signed thinking is bound to the exact preceding history (Opus 5.5, Sonnet 5.5), it must also show whether Bedrock answers with `prefix_mismatch`. The only call made was refused before the model ran:

   ```
   403 {"Message":"Bearer token has expired"}
   ```

   The CKCRED record `apikey:amazon-bedrock` holds a short-term Bedrock API key for `us-east-1`, presigned on 2026-06-23 with a 12-hour expiry. A fresh key has to be minted in AWS. Until Bedrock runs, Anthropic-family acceptance rests only on the recorded wire shape.

2. **Kimi is unproven.** Every call was refused before the model ran:

   ```
   403 {"error":{"message":"You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/membership/subscription?tab=quota","type":"access_terminated_error"}}
   ```

   DeepSeek accepted both shapes Kimi would be tested on: older steps sent with empty `reasoning_content` beside steps that keep theirs, and a tool call removed together with its result. Kimi's own validation is still unseen.

3. **On OpenRouter Anthropic, age-based reasoning removal invalidates part of the provider's prompt cache without making the request smaller.** This is not a rejection. The plugin removed the reasoning part, so the plain `reasoning` text field left the wire, but the signed `reasoning_details` block was still sent. The request therefore did not shrink (13,381 → 13,400 input tokens), but its bytes changed at the first assistant message, so the cached prefix fell from 13,280 to 11,664 tokens on that call.

   The cause is the adapter. `@openrouter/ai-sdk-provider` builds `reasoning_details` from the message-level provider options first, then from the provider options of a `tool-call` part, and only last from the `reasoning` part (`findFirstReasoningDetails`, `dist/index.js` in 3.1.0). OpenRouter streams `reasoning_details` onto the tool call as well. Removing the `reasoning` part therefore leaves the signed block in place.

   Whether a real removal would be accepted on this route is still untested. It would need `reasoning_details` stripped from the other parts of the same message.

## OpenRouter rerun after the fix

Plugin: the reasoning-removal branch after the review fixes. For a selected assistant on OpenRouter, removal now also strips the `openrouter.reasoning_details` copies from the message's tool-call parts, which `findFirstReasoningDetails` reads before the reasoning part. A message whose copies are Gemini thought signatures (`format: google-gemini-*`) is never selected, so those bytes never change. Run: `--providers openrouter`, same `mc-e2e` enrollment, same scenarios (12-step loop, `clear_reasoning_age: 10`, `/ctx-flush`, three more turns), 38 billed calls. Every call was accepted, and `lsof` listed only the root's `live.db` and `context.db` files.

| Route, model | Call | Request bytes | Reasoning on the wire | Input (cached / cache write) |
|---|---|---:|---|---|
| OpenRouter, `anthropic/claude-haiku-4.5` | 13, last before removal | 52,828 | 1 signed `reasoning_details` block | 13,530 (13,425 / 99) |
| | **14, removal pass** (plugin log: `froze 1 assistant(s)`) | **50,207** | **0**: the signed block left the wire with the reasoning part | **13,374** (11,664 / 1,700), although a new user turn was added |
| | 15, next call | 51,650 | only the new turn's block | 13,517 (13,364 / 147) |
| | 16–19 | 51,834 → 54,510 | new turns' blocks only | 13,495 → 13,717, cached 13,364 → 13,598 |
| OpenRouter, `google/gemini-3-flash-preview` | 1–19 | 53,146 → 61,200 | every step's tool-call signatures kept (12 → 15 blocks) | 11,462 → 12,030, cached ≈ 11.2K throughout; no selection, no byte change from the lane |

**Result.** On OpenRouter Claude the lane is now effective. The removal pass shrank the request by 2,621 bytes and billed 156 fewer input tokens than the call before it, despite the added turn; the earlier run grew by 19. The cache read dropped on the removal pass only (13,425 → 11,664, the expected cost of a real edit at the first assistant message) and was back at 13,364 on the next call. Gemini's signatures were untouched and every call was accepted.

## Per provider

### OpenAI Responses (API key)

- **Request:** `store:false`, `include:["reasoning.encrypted_content"]`, `reasoning:{effort:"medium",summary:"auto"}`, no `previous_response_id`, no `item_reference`. OpenCode sends the full input on every call, so no server-held state can restore removed reasoning.
- **What the model did:** `gpt-5-nano` reasoned on only 2 of the 12 loop steps (3,008 and 192 reasoning tokens). Every other step answered with zero reasoning tokens.
- **Removal pass:** on the first pass after `/ctx-flush`, the plugin logged `reasoning removal: froze 2 assistant(s), total=2`. The two reasoning items of steps 1 and 3 left the wire. The one item that remained belongs to the newest assistant message (turn 1's final answer), which the lane never selects. All 12 `function_call` items stayed.
- **Billed input:** the removed items accounted for about 3,200 input tokens; the step-1 item alone had added about 3,100 when it first appeared (9,433 → 12,509). After removal the input fell from 13,141 to 9,903, even though a new user message was added.
- **Cache:** the cache still matched up to the first removed item (9,344 cached), so the removal pass paid about 560 uncached tokens. The next call was back at 9,856 cached.
- **Later calls:** all 5 were accepted and stayed at that size.

### DeepSeek (`deepseek-flash`, thinking on)

- **Age lane:** the plugin froze 5 assistants. Their `reasoning_content` went on the wire as `""`, which matches the design note's capture: OpenCode's DeepSeek path sends an empty string rather than omitting the field. DeepSeek accepted every request, including the tool loop's own follow-ups.
  - Reasoning per step was short (about 9 tokens), so the saving is small.
  - The removal pass lost 640 cached tokens (11,776 → 11,136); the cache recovered on the next call.
- **Drop lane:** a `drop` was queued on the oldest tool tag, then `/ctx-flush` applied it. The `bash` call and its result both left the wire, and the assistant's text ("Starting with step 1.") stayed with `reasoning_content:""`. DeepSeek accepted that request and all later ones.
  - In this run the dropped step had produced no reasoning of its own. When a dropped tool call's step does carry reasoning, the plugin removes that reasoning with it; this run did not exercise that path on DeepSeek. It did exercise the tool-pair removal.

### OpenRouter

- **Claude Haiku 4.5:** see merge blocker 3. The model reasoned on 4 of the 15 steps.
- **Gemini 3 Flash:** every assistant message carried `reasoning_details` with `type:"reasoning.encrypted"`, and each detail's `id` equals its tool call's id. This is Gemini's thought signature, bound to the function call. The host stored no reasoning part for these steps, so Magic Context had nothing to remove (the flush pass selected none) and the question was not exercised.
  - Because the signatures are attached to the tool calls, age-based removal would leave them in place in any case. Gemini 3 needs the signature of each function call in the current turn sent back, so that is the safe outcome.

## Method

- **Harness:** `packages/e2e-tests/src/live-providers/`. Every child process is spawned with `windowsHide: true`.
  - `runner.ts` is the scenario runner.
  - `ckcred.ts` handles the CKCRED enrollment and key fetch.
  - `scenarios/*.ts` holds one file per provider.
  - `recorder.ts` is the loopback recording proxy.
  - `host.ts` manages the throwaway host.
  - `wire.ts` reads requests and usage.
- **Gating:** the harness is opt-in. `runner.ts` refuses to start without `MC_LIVE_PROVIDERS=1`. `tests/live-providers.test.ts` is skipped without it and is listed as `excluded` in `mode-manifest.json`.
- **Host:** OpenCode **1.18.30** (`opencode-stock-1.18.30`) `serve`, with the built plugin and a current models.dev catalogue placed in the host cache.
  - The models.dev catalogue matters: OpenCode drops models that it marks deprecated, which is why the first DeepSeek attempt with `deepseek-v4-flash` never reached the provider.
- **Scenario:** one session per scenario.
  - **Turn 1** asks for 12 single `bash` calls, one per step.
  - **Drop lane only:** a `drop` is then queued on the oldest tool tag, as `ctx_reduce` would queue it.
  - **`/ctx-flush`** makes the next pass a rebuilding pass, where the age lane (`clear_reasoning_age: 10`, the minimum the config accepts) selects reasoning.
  - **Turns 2 to 4** each ask for one more call.
- **Recording:** every provider call goes through the loopback recorder, which forwards the request unchanged to the real endpoint. For each call it records:
  - the status;
  - the provider's error text;
  - `usage`;
  - a per-step reasoning map of the request body.

  The recorder stops forwarding after the first rejection, so the host's retries are answered locally and cost nothing.
- **Credentials:**
  - **Source:** CKCRED's vault. Consumer `mc-e2e` was enrolled with `@cortexkit/claustrum-client` 0.5.0, with exact read grants on `apikey:openai`, `apikey:amazon-bedrock`, `apikey:openrouter`, `apikey:deepseek` and `apikey:kimi-for-coding`. Its token is stored at `~/.config/cortexkit/mc-e2e/enrollment.json` (mode 0600).
  - **Use:** each scenario calls `getScoped`, writes the key only into its throwaway `opencode.json`, and deletes the whole root afterwards.
  - **Leak check:** a scan of every results file, log and saved request body for each key (and its last 24 characters) found no match.
  - **No failure reports:** `report_auth_failure` was never called.
- **Isolation:** every scenario root sits under `$TMPDIR/magic-context/live-providers/<run>/roots/` and holds HOME, every XDG root, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` and `TMPDIR`.
  - **lsof check:** after each completed scenario, `lsof -p <host pid>` listed only `live.db` and `context.db` (plus their WAL and SHM files) inside that root. The runner fails the scenario otherwise.
  - **Clean-up:** every root was removed afterwards.
- **Evidence:** results JSON for every run is in `docs/evidence/reasoning-removal-live/`.
  - **`run1-openai-invalid-config.json`** is the first OpenAI attempt with `clear_reasoning_age: 5`. Magic Context rejected that value and fell back to 50, so no removal happened. The runner now refuses to start a scenario when the host logs a config warning.
  - **`run5-openrouter-gemini-kimi.json`** also holds two DeepSeek entries. They are the deprecated-model attempt, and neither made a provider call.

## Budget

| Provider | Calls | Notes |
|---|---:|---|
| OpenAI | 34 | 15 in the rejected-config run, 19 in the measured run |
| OpenRouter | 38 | reported charge $0.050 (Claude) + $0.021 (Gemini) |
| DeepSeek | 38 | |
| Kimi | 12 | all refused for quota, so not billed |
| Bedrock | 1 | refused, expired key |
| **Total** | **123** | cap 200; no rate limit and no unexpected billing |

## Rerunning Bedrock and Kimi

Once the CKCRED record `apikey:amazon-bedrock` holds a freshly minted Bedrock key and Kimi's weekly quota has reset, run:

```sh
MC_LIVE_PROVIDERS=1 bun packages/e2e-tests/src/live-providers/runner.ts \
  --opencode ~/.opencode/bin/opencode-stock-1.18.30 \
  --models-catalog "$TMPDIR/models-dev.json" \
  --providers amazon-bedrock,kimi-for-coding
```

This runs four scenarios:

- Bedrock Haiku 4.5;
- Bedrock Sonnet 5.5 (`global.anthropic.claude-sonnet-5-5`, prefix-bound), whose `prefix_mismatch` behaviour lands in the call's `error` field;
- Kimi, age lane;
- Kimi, drop lane.

The run makes at most 84 calls. `--models-catalog` takes a copy of `https://models.dev/api.json`. Results go to `$TMPDIR/magic-context/live-providers/run-<id>/results.json`, unless `--out` names a different directory.
