# Anthropic wire evidence: consecutive signed thinking blocks (2026-09-28)

**Answer: yes, for the observed single-message shape.** A direct `claude-opus-5-5` request at 19:35:12 UTC replayed both signed thinking blocks from CEREB's 19:34:10 assistant message, adjacent and in their original order, and received a complete HTTP 200 streaming response with usage and a new `tool_use` reply. This is not merely a successful original response: the two blocks were in an earlier assistant message in the *request* body. The wire evidence contradicts a blanket rejection of every assistant run containing more than one thinking block; it does not establish that arbitrary interleavings or merged messages are safe.

## Sources and method

Read-only inspection of `~/.local/share/opencode/opencode.db` with `sqlite3 -readonly`, joining ordered `part` rows by `message_id`, and JSON parsing of `$(getconf DARWIN_USER_TEMP_DIR)opencode-anthropic-auth-dumps/` files. Filename timestamp and sequence identify a call; the matching `.body.json`, `.request.json`, `.response.json`, and `.meta.json` contain respectively the Anthropic request body, request headers, response summary, and status. This follows the naming/response conventions in `packages/plugin/scripts/analyze-cache-busts.ts`. Compared **both complete thinking text and complete signature strings**, not just prefixes, against store rows for `msg_0e982ab63001ydwkzKXikgA0tG`. The broader scan checked adjacent `type: "thinking"` entries inside a single `role: "assistant"` message's `content` array (not across messages). The scan was a snapshot of 2,641 parseable body files dated 2026-09-28, through the 22:56:00 UTC dump; these live dumps can rotate or grow. No store or dump was modified and no request was sent.

The ordered store parts for that message are `step-start`, `reasoning`, `reasoning`, completed `tool`, `step-finish`. In the first matching request, `messages[175]` is one assistant message with the wire type sequence **`thinking, thinking, tool_use`**. Its two blocks match the corresponding store text and signatures byte-for-byte (UTF-8):

| Block | Thinking text | Signature | First 40 signature characters |
| --- | ---: | ---: | --- |
| First | 576 characters / 578 UTF-8 bytes | 1,936 bytes | `CAQSpAsKEAgSGAI4AUIIdGhpbmtpbmcSDKRA6dB0` |
| Second | 210 characters / 210 UTF-8 bytes | 1,368 bytes | `CAQS+QcKEQgSGAI4AUIJbmFycmF0aW9uEgxC74Q8` |

The first request is `2026-09-28T19-35-12-703Z-014417-ses_0758f6ce7ffeJ0A9sV8Qvema7d-direct-sticky-umutaday.{body,request,response}.json`. `body.model=claude-opus-5-5`, `body.thinking={"type":"adaptive","display":"summarized"}` (no `drop_block`), and the `anthropic-beta` header **includes** `thinking-binding-controls-2026-08-01` (also `interleaved-thinking-2025-05-14`). The paired response has `status=200`, `stream_complete=true`, `message_id=msg_011CfWQ54bZobDEy2sSU6eQ4`, `stop_reason=tool_use`, and usage including `output_tokens=98`; the metadata also says 200. This is a normal generated response, not merely an accepted cache-prewarm request.

### Every request carrying these exact two CEREB blocks

All **32** matches after 19:34:10 UTC contain both blocks at `messages[175].content[0:2]`, adjacent, with exact store text/signatures in original order followed by `tool_use`. All have `body.model=claude-opus-5-5`, `response.status=200`, `stream_complete=true`, and usage. Except the marked prewarm, each has the thinking-binding beta header and no `drop_block` setting. UTC filename timestamps and sequence numbers (the `-NNNNNN-` component) identify the requests without copying their potentially sensitive bodies:

| UTC | Sequences | Response / beta |
| --- | --- | --- |
| 19:35:12 | 014417 | 200 / binding |
| 19:44:16, 19:44:47 | 014523, 014526 | 200 / binding |
| 19:45:02, 19:45:21, 19:45:47 | 014531, 014538, 014544 | 200 / binding |
| 19:46:12, 19:46:36; 19:47:26 | 014548, 014552, 014558 | 200 / binding |
| 20:27:20, 20:27:35, 20:27:54 | 014882, 014885, 014892 | 200 / binding |
| 20:28:10, 20:28:39, 20:28:49; 20:29:07 | 014895, 014898, 014900, 014901 | 200 / binding |
| 21:24:56 | 015228 | 200 / **no binding**, prewarm |
| 21:52:04, 21:52:48, 21:53:34 | 015439, 015445, 015453 | 200 / binding |
| 21:54:46, 21:54:57, 21:55:22 | 015471, 015472, 015474 | 200 / binding |
| 21:56:44; 21:57:01, 21:57:12, 21:57:51 | 015487, 015489, 015490, 015497 | 200 / binding |
| 22:08:44; 22:09:15; 22:10:07, 22:10:28; 22:11:02 | 015556, 015560, 015569, 015571, 015575 | 200 / binding |

The exception `015228` is `prewarm-cachekeep-direct-cachekeep`: its beta header omits thinking-binding controls and its body also has no `drop_block`. It returned HTTP 200 with usage but `output_tokens=0` and `stop_reason=max_tokens`, so the ordinary 19:35:12 response is the stronger evidence of successful generation. All other listed requests have the beta header, including the first normal reply.

## Other adjacent-thinking requests in the day's dumps

There were **198** request bodies with at least one adjacent thinking pair, across four sessions (historical pairs recur in subsequent requests, so these are not 198 independent original messages). Every counted request had a paired response summary:

| Session | Requests | Outcomes and relevant conditions | Example message content |
| --- | ---: | --- | --- |
| CEREB `ses_0758f6ce7ffeJ0A9sV8Qvema7d` | 85 | 85 HTTP 200 with usage; 84 with binding beta and one prewarm without; none with `drop_block`. Some precede the 19:34 message. | At `013119`, `messages[649]`: `thinking, thinking, tool_use` (2,543 and 300 characters; signatures 5,688 and 1,960 bytes). |
| `ses_f170afc74ffeGmv7zF2H4AxVnJ` | 66 | 66 HTTP 200 with usage and binding beta, no `drop_block`. | At `013133`, `messages[309]`: `text, thinking, thinking, tool_use, tool_use` (788 and 211 characters). This is a different, interleaved shape. |
| ALF `ses_227ce5788ffeRPA9THoPLOQreO` | 27 | 27 HTTP 200 with usage and binding beta, no `drop_block`. | At `015534` (22:04:56), `messages[673]`: `thinking, thinking, tool_use` (85 and 263 characters; signatures 1,084 and 2,528 bytes; prefixes `CAQSpAYKEAgSGAI4AUIIdGhpbmtpbmcSDCnPty+6`, `CAQS4Q4KEQgSGAI4AUIJbmFycmF0aW9uEgxLvkyK`). Reply: `output_tokens=645`, `stop_reason=tool_use`. |
| `ses_f16e21c8cffeRphPF8Mhe6JcHk` | 20 | Ten HTTP 200 with binding beta **and** `thinking.block_binding.prefix_mismatch_behavior=drop_block`; ten cachekeep prewarms without either setting returned HTTP 400 without usage. | At `013356`/`013358`, `messages[37]`: `text, thinking, thinking, text, tool_use` (488 and 21,955 characters; signatures 1,916 and 94,364 bytes). The 400 summary has no error detail, so its exact cause cannot be assigned solely to the double pair; this is not the clean leading-thinking shape. |

Across the 198: 177 are Opus 5.5 HTTP 200 with binding beta and no `drop_block`, ten Opus 4.8 HTTP 200 with both binding beta and `drop_block`, one Opus 5.5 HTTP 200 without binding beta (the prewarm), and ten Opus 5.5 HTTP 400 without binding beta or `drop_block`. A successful response proves this request shape passed the API and produced usage, not that each signed block was independently honored internally or that all variants are accepted. The 400s caution against extrapolating to text-before-thinking or different binding settings.

## Implication

Before the accompanying fix, `validateAnthropicReasoningRuns` in `packages/plugin/src/hooks/magic-context/lkg-replay.ts` rejected the second thinking block even when both were adjacent within one original assistant message before its completed tool. The CEREB wire request above demonstrates that **this blanket rule is too strict for that single-message case under the observed Opus 5.5 request settings**. The separate `stripReasoningFromMergedAssistants` rationale in `strip-content.ts` concerns merged/interleaved assistant messages and should not be treated as proof that this clean, two-block original message is rejected by Anthropic. The TypeScript replay guard can retain contiguous leading thinking blocks from one original assistant message while still rejecting thinking from a later merged message or after content. The Rust serializer residual has a related, stricter guard in `crates/mc-module/src/transform.rs` (`apply_serializer_residual_to_message`): for the Anthropic OpenCode merge profile it keeps only the first mutable reasoning block when that block is the first non-ignored content of the first assistant message in a run, and replaces all other mutable reasoning blocks (including a second one in that same message) with empty text. The residual is skipped for mutation-exempt messages and profiles without this merge quirk. Rust behavior was not changed here.
