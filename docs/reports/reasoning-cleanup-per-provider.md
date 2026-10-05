# Reasoning cleanup by provider: wire evidence and remaining live checks

Date: 2026-09-30. Research only; no product changes. Host: **OpenCode 1.18.30**. MC base: `d8a6963308f750f3c0959bacfd995d2fa0a81eb7`.

## Bottom line

**Yes, removal is technically possible outside provider ID `anthropic`; this does not establish backend acceptance or savings.** The installed host's real serializers sent no old reasoning text or associated reasoning-part payload after physical removal on every tested route; DeepSeek still emitted an empty `reasoning_content` field. An empty **text sentinel**, as MC actually uses, also disappeared in these mixed reasoning-plus-answer fixtures. Merely changing signed reasoning's text to `""` is different: Anthropic/Vertex/Bedrock still sent the signed block; Copilot retained its opaque payload; OpenAI retained its encrypted payload.

Do **not** widen `modelAcceptsEmptyContent()` on these results. Its contract also covers whole-message emptiness, tool adjacency, step boundaries and cache shape, which this experiment does not validate. Instead, investigate a separate, provider-adapter-aware **old completed-turn reasoning removal** capability. Do not change signed text to `[cleared]`. Qualify native Anthropic first, then Vertex and Bedrock with actual accounts. Copilot and OpenAI need opaque/encrypted-reasoning-specific policy; Gemini needs thought-signature-specific policy. A provider label is not a transport capability.

The Sonnet 5 Vertex incident remains **unproven**: MC permits age-based typed-reasoning cleanup only when `providerID === "anthropic"`, which excludes `vertex-eu-anthropic` and explains its zero age-based cleanups, and the route really can replay old thinking, but neither this mock nor prior binding-model measurements proves that reasoning caused the missing 50–100K tokens or the two-hour pressure plateau.

## Evidence levels and access limitation

- **W (new wire capture):** the actual installed OpenCode executable, with its bundled adapters and host transforms, sent a request to a recording loopback endpoint. Not a reimplementation or a direct-SDK substitute.
- **S (source / documented contract):** pinned upstream host and adapter sources, or provider documentation. Not service acceptance evidence.
- **L (earlier live observation):** explicitly reused measurements in [anthropic-thinking-binding.md](anthropic-thinking-binding.md) and [anthropic-open-tool-round-thinking.md](anthropic-open-tool-round-thinking.md); not rerun here.
- **U (unverified):** no authorized live measurement in this investigation.

**New live calls: 0; model spend: $0 / 0 billed tokens.** The earlier native OAuth probe obtained an in-memory bearer for its primary account through anthropic-auth's `ClaustrumScopedRuntime.authorize('main')` authorization call. The parent supplied its module path for read-only inspection, but inspection established that authorization loads and refreshes operator auth metadata, including writes. That conflicts with the no-live-store rule. The parent explicitly decided to **skip new live probes**, preserve the prohibition and describe the remaining measurements. No bearer was obtained, printed, logged or stored. Vertex, Bedrock and Copilot accounts were unavailable as stated in the brief. OpenAI/Gemini key and OAuth routes exist in earlier documentation, but no isolated, authorized credential was supplied; no live store or `~/.config` was searched for one.

The earlier calibration routes are documented in `packages/plugin/scripts/calibrate-tokenizer/README.md:43–58,83–94`; OpenAI OAuth routing is discussed in `pi-openai-cache-busts-2026-09-28.md:172–177`. Their existence is not permission to read their credential files.

## Recording experiment

Committed harness: [`packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.ts`](../../packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.ts).
Committed reduced evidence: [`reasoning-cleanup-per-provider.capture.json`](../../packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.capture.json), **60 cases / 60 captured requests**, with the raw capture's SHA-256. Each case had exactly one request carrying `OLD_ANSWER_FIXTURE`; this was checked against the actual capture before extracting evidence.

Reproduce with a new root (macOS `TMPDIR` is usually not `/tmp`):

```sh
bun packages/e2e-tests/src/repro/reasoning-cleanup-per-provider.ts \
  --opencode /absolute/path/to/opencode \
  --out "${TMPDIR%/}/mc-reasoning-wire-UNIQUE"
```

The host is launched in `serve` mode. A tiny fixture plugin prepends an earlier user question and a **completed assistant** with reasoning plus a nonempty text answer in `experimental.chat.messages.transform`. The assistant uses the requested provider/model identity so OpenCode does not downgrade cross-model reasoning to plain text. This exercises host message lowering, provider transforms, then the bundled serializer. It bypasses MC itself: the fixtures model the outputs of its cleanup operations, not MC eligibility or replay execution.

Six modes per route:

1. `intact`: old reasoning text with synthetic replay metadata.
2. `cleared`: same metadata, reasoning text `[cleared]` (tool-drop behavior).
3. `empty-reasoning`: same metadata, reasoning text `""` (**not** MC's sentinel).
4. `sentinel`: replace the reasoning part with `{type:"text",text:"",id:...}`, with no signature/opaque payload (MC's strip shape).
5. `removed`: omit the part entirely.
6. `unsigned`: intact text, no replay metadata.

All signatures, thought signatures, encrypted payloads and opaque payloads are **fake** (`mock-*`). Each endpoint deliberately returns HTTP 400. The host still serializes and sends the body before that rejection. Neither that 400 nor the host session API's response status is an acceptance result. Vertex's token generator is replaced in the fixture config with a mock function; Bedrock uses its supported mock bearer option, avoiding AWS discovery. Codex's custom mock provider uses OpenAI Responses with `store:false`, **not a logged-in OAuth session**. OAuth final routing is qualified separately below.

No tool round, reasoning-only assistant, redacted block, model switch, step-boundary reconstruction, restart replay or true prompt cache was tested. These are deliberate limits, not evidence that they are safe.

### Isolation proof

The final run root was `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/mc-reasoning-wire-20260930-c`. `HOME`, all XDG roots (including runtime), `OPENCODE_CONFIG_DIR`, absolute `OPENCODE_DB`, MC storage/log paths, child `TMPDIR` and child working directory were beneath it. Child environment came from an allowlist, not inherited API keys. Only configured mock providers were enabled. Each provider base URL was loopback. The host was stopped in `finally`.

`lsof-before.txt` and `lsof-after.txt` sample the host PID. The final run's after sample (PID 48075) showed `data/opencode/wire.db`, `wire.db-wal` and `wire.db-shm` inside its throwaway root and passed the database-handle check. This is **sampled database isolation**, not a continuous descendant or network sandbox audit. The earlier sample also showed external HTTPS sockets despite disabled model fetching; do not describe the host as fully offline. No credentialed model route was configured. Raw `results.json`, `host.log` and lsof files remain in the throwaway roots and are not committed. Sources were downloaded to a separate throwaway `/tmp/mc-reasoning-source` directory. No live OpenCode/MC/config store was opened.

## Per-provider wire, billing and acceptance table

`R` below means the original old reasoning text, `S` a replay signature, `E` encrypted content, and `O` Copilot opaque content. “Omitted” concerns the reasoning, **not** the retained answer. All removal acceptance columns cover oldest-first / middle-gap / all removal / `[cleared]` separately in the next section.

| Provider family / tested adapter | Earlier reasoning (W) | `[cleared]` (W) | Empty reasoning / text sentinel / physical removal (W) | Earlier thinking billed as input? | Service acceptance / evidence |
|---|---|---|---|---|---|
| Native Anthropic, canonical `anthropic`, `@ai-sdk/anthropic` | `/messages`: `content:[{type:"thinking",thinking:R,signature:S},text]` | Same signed block, text changed | Signed `thinking:""` **survives** / omitted / omitted. Unsigned reasoning omitted. | Binding-model earlier L shows input increases with preserved thinking; exact Sonnet 5 A/B **U** | New variants **U**. Binding rules S; limited earlier L below. |
| Vertex Anthropic, custom `vertex-eu-anthropic`, `@ai-sdk/google-vertex/anthropic` | `/claude-sonnet-5:streamRawPredict`: same Anthropic `thinking` blocks, `anthropic_version:"vertex-2023-10-16"`, no body `model` | Same signed block, text changed | Signed empty block **survives** / omitted / omitted. Unsigned omitted. | **U**; no Vertex usage measurements | All acceptance **U**; cloud binding contract S, no account. |
| Bedrock Claude, `@ai-sdk/amazon-bedrock` | `/model/anthropic.claude-sonnet-5/converse-stream`: `reasoningContent.reasoningText:{text:R,signature:S}` | Same signed reasoningText, changed text | Signed empty reasoningText **survives** / omitted / omitted. Unsigned omitted. | **U**, no Bedrock usage measurements | All acceptance **U**; cloud binding contract S, no account. Converse, not raw InvokeModel, was tested. |
| GitHub Copilot Claude, host's bundled custom adapter (`npm` config key `@ai-sdk/github-copilot`) | `/chat/completions`: assistant `content:answer,reasoning_text:R,reasoning_opaque:O` | `reasoning_text:"[cleared]"`, opaque unchanged | Opaque survives, `reasoning_text` absent / both omitted / both omitted. The unsigned fixture omits reasoning; source S additionally says text replay requires opaque metadata. | **U**; visible text size is not proof of opaque billing or accounting | All acceptance **U**; no Copilot account or live auth plugin. |
| OpenAI Responses, API shape, `@ai-sdk/openai`, `store:false` | `/responses`: input item `{type:"reasoning",encrypted_content:E,summary:[{type:"summary_text",text:R}]}`; no item ID | Summary changed to `[cleared]`, E unchanged | E **survives**, `summary:[]` / reasoning item omitted / omitted. Without E/ID, reasoning omitted. | **U**; summary length cannot estimate encrypted-reasoning input | All acceptance **U**. Anthropic signed-prefix rules do not establish OpenAI rules. |
| OpenAI Responses, Codex OAuth shape | Same Responses serializer output in `codex-probe` (W); final OAuth endpoint rewrite only S | Same as API serializer | Same as API serializer | **U**, no authenticated Codex billing A/B | All acceptance **U**; mock did not execute OAuth auth/refresh or WebSocket transport. |
| Gemini, `@ai-sdk/google`, Gemini 2.5 Pro generate-content shape | `/models/gemini-2.5-pro:streamGenerateContent`: `role:"model",parts:[{text:R,thought:true,thoughtSignature:S},answer]` | Same thought and signature, changed text | Empty reasoning omitted (including its signature) / omitted / omitted. Unsigned **nonempty** thought text still sent. | **U**; not measured by a countTokens proxy | All acceptance **U**; Gemini 3/tool-call signature constraints not covered. |
| DeepSeek reasoner, `@ai-sdk/openai-compatible` | `/chat/completions`: `reasoning_content:R` on assistant | `reasoning_content:"[cleared]"` | `reasoning_content:""` / `""` / `""` | **U**; this OpenCode route **does resend** reasoning | All acceptance **U**; cannot use DeepSeek as a no-replay example on this version/configuration. |
| Groq DeepSeek-R1 distilled model, `@ai-sdk/groq` (additional control) | `/chat/completions`: assistant `reasoning:R` | `reasoning:"[cleared]"` | omitted / omitted / omitted | **U**; also resends reasoning | All acceptance **U**. |
| **Non-replay control:** xAI Grok 3 mini, `@ai-sdk/xai` chat | `/chat/completions`: answer only; no earlier reasoning | No reasoning | omitted / omitted / omitted | Prior reasoning is absent from this request (W); therefore no additional input for **that omitted content**. No live invoice/usage comparison. | Reasoning removal is wire-equivalent for this fixture; actual backend acceptance **U**. Not the xAI Responses route. |

The important Copilot distinction is opaque metadata, not an Anthropic signature. An initial signature-only mock did not resend Copilot reasoning; the final fixture uses `reasoningOpaque`, as the real converter requires. Likewise, DeepSeek and Groq both actually resent reasoning here. The no-replay example is **Grok 3 mini on xAI chat**, not an assumption about DeepSeek.

## Removal and signed-block acceptance: binding versus non-binding

No new live acceptance row was run. The following table deliberately distinguishes published rules from observations.

| Operation on completed earlier reasoning | Native Sonnet 5 (non-binding) | Native binding model (Opus 5.5 / Fable 5.1; Sonnet 5.5 also documented) | Vertex / Bedrock Claude | Copilot / OpenAI / Gemini |
|---|---|---|---|---|
| Remove oldest prefix of reasoning blocks, preserving all other content | **U** for requested live Sonnet 5 sample; no prefix-binding check S | Valid per preserved-thinking contract S; exact multi-block oldest-prefix acceptance **U** here | Same cloud rule S for applicable accounts/models; acceptance **U** | **U**; route-specific rules required |
| Remove a middle block, keep later reasoning | **U**; absence of prefix binding does not prove arbitrary mutation acceptance | Invalidates every later block S. Strict-error rejection / drop behavior for this exact gap **U** here | Cloud rule S; acceptance **U** | **U**, no transfer of Anthropic rules |
| Remove all earlier reasoning | **U** | Valid per contract S; earlier L removed the sole thinking block in a tool-round sample and was accepted, not a multi-completed-turn “all” trial | Cloud rule S; acceptance **U** | **U** |
| Replace signed text with `[cleared]`, retain signature | **U**; “non-binding” does not mean signature edits are legitimate | A changed signed block is not the documented removal operation; no live specimen of this exact edit here (**U**) | **U**; mock proves literal text reaches a signed block, not that the cloud accepts it | Copilot has opaque content, OpenAI encrypted content, Gemini a thought signature; modified visible text acceptance **U** |

[Preserved thinking: What counts as an edit](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#what-counts-as-an-edit) explicitly permits deleting thinking from the **start**, **end**, or **all**, prohibits middle gaps with later blocks retained, and prohibits restoring a removed block after newer thinking was produced without it. Editing earlier user/assistant/system content, tools, images or tool results invalidates later thinking. Removing only an oldest prefix of thinking is a special allowed case; it must not accidentally remove surrounding answer/tool content.

The prefix check applies to Fable 5.1, Opus 5.5 and Sonnet 5.5; models before Fable 5.1 (including requested Sonnet 5) are non-binding per that page. Signature integrity is a separate concern. [Account enforcement](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking#when-the-api-enforces-the-check) defaults to strict checking on accounts created on or after **2026-08-31 00:00 UTC**, including cloud platforms. An older account's success with defaults is not a strict-binding test. Use the matching beta plus explicit `prefix_mismatch_behavior:"error"` to qualify a binding model. Sonnet 5.5's controls also depend on adaptive versus between-tools thinking mode.

### Earlier live evidence, not newly reproduced

From `anthropic-thinking-binding.md:98–113,138,173–176`, on native OAuth: `m0` is the first user message's project context, changed from `project=alpha` to `project=beta`. The `drop_block` control lets the service remove reasoning whose signed prefix no longer matches rather than reject the request.

| Model | Same follow-up with valid thinking | Follow-up after m0 edit and server `drop_block` | Input difference | Scope |
|---|---:|---:|---:|---|
| Fable 5.1 | 213 input tokens (`req_011CfSak8u1qA2hyCXe5u5As`) | 154 (`req_011CfSakH8s5NcwscVeQdApf`) | 59 | L: preserved thinking contributed input; edited m0 + server drop, **not** exact client-removal A/B |
| Opus 5.5 | 309 (`req_011CfSam9G7rqhi5Xmh7Douo`) | 120 (`req_011CfSamPTePuhdmyK5oE1Kj`) | 189 | Same limitation |

Those responses also showed strict m0-edit errors and `thinking_dropped` transformations. They demonstrate input accounting effects on binding models, but m0 differed as well; do not report these as the requested identical-conversation Sonnet 5 or client-removal billing experiment. Earlier OAuth defaults silently dropped invalid thinking, unlike the documentation's older-account “mismatch allowed” description. Therefore future tests must record transformations, not just HTTP status.

`anthropic-open-tool-round-thinking.md:9–22` records acceptance of sole-block removal in a thinking-bearing open tool round on Fable/Opus. Opus's older-thinking-removed / newest-open-thinking-retained sample was accepted with 808 input tokens (`req_011CfSnTdPwQ9LmsnaKk9E8f`). Fable's corresponding newest block was absent, making that sample non-probative. These observations **do not relax the requested invariant: never touch current-tool-round reasoning**.

## Server-side `clear_thinking_20251015`

**Can OpenCode send it through provider options? Yes, on the tested native adapter (W).** No custom body-rewrite fetch was needed. Put camelCase SDK options on the configured model, or equivalently supply them to the host's model-option path:

```json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-5": {
          "options": {
            "contextManagement": {
              "edits": [
                {"type":"clear_thinking_20251015","keep":{"type":"thinking_turns","value":1}}
              ]
            }
          }
        }
      }
    }
  }
}
```

This is an **option fragment**, not complete runnable provider config. The recording harness supplies the full mock config. Captured native request:

```json
"context_management": {
  "edits": [{"type":"clear_thinking_20251015","keep":{"type":"thinking_turns","value":1}}]
}
```

Captured `anthropic-beta` includes `context-management-2025-06-27` (plus unrelated structured-output beta on native). Vertex's adapter also emitted this field and beta to its mock endpoint, but Vertex service support/acceptance remains **U**. Do not infer a Bedrock or Copilot option from an Anthropic namespace: this same option was not emitted there in the test.

The pinned SDK defines and parses `contextManagement`, converts it to `context_management`, and adds the context-management beta automatically. The uncertainty over whether the bundled adapter accepts a host `contextManagement` option and emits the corresponding body field is resolved **for 1.18.30 / these options**, not for every host version or wrapper. MC currently does not register a `chat.params` hook to opt sessions into it; no product implementation is proposed in this report.

[Context editing documentation](https://platform.claude.com/docs/en/build-with-claude/context-editing#context-editing-and-prompt-caching) says server clearing is not a binding-prefix edit, **but it is not cache-free**: retained thinking preserves the cache; cleared thinking invalidates the cached prefix **at the clearing point**. Keep the client's full original history for server-side editing; do not turn the edited server view into a new locally truncated conversation. Default thinking preservation is model-class dependent (Sonnet 4.6+ and Opus 4.5+ keep prior thinking). Set `keep` explicitly.

**Following-turn cache-read numbers: U.** There was no real cache in the recording endpoint. Neither the earlier input-token deltas nor emitted `cache_control` markers measure cache reads. The correct comparison records `cache_read_input_tokens`, `cache_creation_input_tokens` and uncached `input_tokens` separately, on repeated requests before and after a clearing boundary; procedure below.

## Recommended design, not implementation

1. **Do not broaden the empty-content gate.** Introduce an explicit host/adapter capability for removing **completed historical reasoning**, distinct from whole-message sentinel safety. Resolve custom provider IDs such as `vertex-eu-anthropic` using the selected adapter/model information; do not infer transport solely from spelling or “Claude” in a model name.
2. **Remove a part rather than corrupt its signed text.** Keep native answer/tool parts intact. The current tool-drop helper changes both `thinking` and `text` to `[cleared]` on all providers (`tool-drop-target.ts:250–254`); only canonical Anthropic then replaces that reasoning with an empty text sentinel, which the host filters off the wire. That mismatch remains a design hazard. Any later implementation must give tool drops the same signature-safe removal/replay policy, not just change the age-cleanup gate. Preserve opaque/redacted forms as atomic parts; no text-only optimization should leave their payload behind.
3. **Stage providers.** Native Anthropic is the first qualification target. Vertex and Bedrock are plausible next targets because real serializers prove removal works, but keep them opt-in/unenabled until service acceptance is verified. Do not enable Copilot, OpenAI or Gemini by analogy with Anthropic. For xAI chat's non-replay route, cleanup cannot save model input that was never sent; any local-storage cleanup is a different scope. DeepSeek/Groq cannot be classified as non-replay from model branding.
4. **Binding rule:** remove a contiguous **oldest prefix of surviving reasoning blocks**, ordered by actual wire history; freeze part identities, not just “everything older than an age today.” If a different cleanup edits earlier non-reasoning content, all later bound thinking may be invalid, including blocks too recent for the age cutoff. Use a separately qualified binding strategy (e.g. paired `drop_block` control + beta, or suffix removal when safe), not a middle gap. Never reintroduce a removed block. An account/model switch is another qualification boundary.
5. **Current tool round is protected.** Never remove/empty/edit reasoning in the assistant/tool loop since the last user turn while that round is still open. Protection is not merely “skip the last assistant message”: multiple reasoning-bearing assistant messages can belong to the same round. If preserving the round conflicts with invalidated bindings after a prefix edit, defer that prefix edit or use a verified server policy; do not quietly strip the round to get a 200.
6. **Cache discipline:** select new removals only on passes that already rebuild/bust the cache. Persist a frozen set of reasoning part identities/host-message ownership atomically before applying it. On write failure, apply nothing. Defer passes replay only that set, byte-identically; no fresh cutoff computation or widening. Replay after restart and on raw host histories. Preserve untouched part identities/order and native step boundaries. A tag watermark is useful for age selection but insufficient for provider-independent part removal, missing tags, or tool-drop gaps.
7. **Server editing is an option, not a default flip.** Native `contextManagement` transport is proven. Prefer qualifying `keep:thinking_turns` server clearing for binding safety where the service supports it, especially if local removals would create gaps. It does not fix unrelated MC prefix edits and can still reduce cache reads at clearing points. Schedule policy changes deliberately, observe applied edits, and avoid simultaneously doing client and server cleanup without a defined accounting/replay policy. Use the provider's turn definition; do not translate a tag age directly to a thinking-turn count without a mapping.

No product changes, gate widening, ARCHITECTURE.md/STRUCTURE.md edits or live-state cleanup were made.

## Small live probe plan to settle the remaining questions

Provision a **disposable enrolled auth store/token/connection route** first. The existing runtime cannot be used under a blanket no-live-store rule because its roster refresh writes metadata. Keep signatures and bearer in memory, persist only allowlisted usage/status/transformation/error summaries, and never save request headers. Isolate the runner's HOME/XDG/DB/config/log/TMPDIR roots and sample `lsof` before/after. Use native Sonnet 5 plus **Opus 5.5** (or Fable 5.1), max approximately **30 calls total**, stop immediately on usage-cap or rate-limit errors. Replay the signed thinking history only within the account that produced it; do not send it through another account. No tools are needed for completed-turn acceptance.

Suggested bounded script, maximum 28 message calls:

- **Each model: 3 generation calls.** Build three completed assistant turns with nonempty thinking (`A1,A2,A3`), replaying the exact returned content each time. Small maths questions, short final answers, stable system/tools. Use documented adaptive thinking and small output caps compatible with the model. On binding-model continuations pair the `thinking-binding-controls-2026-08-01` beta with `prefix_mismatch_behavior:"error"` to force strict prefix validation, rather than relying on an older account's defaults that may accept or drop mismatched blocks. If any generation lacks reasoning, report not-reached and do not spend unbounded retries.
- **Each model: 5 branches from identical full history**, same final user prompt: intact control; delete A1's thinking only; delete A2's thinking only (middle gap); delete all A1–A3 thinking; replace A1 thinking text with `[cleared]`, retaining its actual signature. Never mutate or include an open tool round. Log exact model, HTTP/request ID, `input_transformations`, error category and usage only. This totals 16 calls for both models. Strict binding should distinguish prefix removal from a gap; a 200 with server drop is not evidence that surviving later blocks were valid.
- **Billing A/B:** use those intact/all-removed branches with no explicit cache markers (or fresh isolated cache prefixes), identical system/tools and every non-thinking value. Compare uncached `input_tokens`, checking that cache reads/writes are zero and no server fallback/model substitution occurred. If cached, compare `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` for logical input volume and apply the route's different price rates for billing; do not equate uncached input with total input. This gives the missing **Sonnet 5** measurement and a real binding-model client-removal pair without the earlier m0-edit confound.
- **Binding-model cache lane: up to 12 additional calls.** Seed a distinct stable prefix padded just above the model's documented minimum cacheable size (not a giant session), stable explicit cache breakpoints after completed assistant content, and enough completed thinking turns for keep=1 to clear something. Three seed generations, then control twice with keep-all; then same history with keep=1 twice; append one completed assistant/user turn and repeat twice to move the boundary; then unchanged keep-all control repeats as remaining budget permits. Keep final outputs tiny. Record `context_management.applied_edits`, logical input, uncached input, cache reads and writes for every turn. Confirm that the stable control really hits cache before drawing conclusions. A no-hit control is not a cache experiment. The first clearing request and following repeated/append requests settle whether reads recover within the edited prefix versus restart at each advancing boundary. Do not compute expected token counts from the same serializer under test.

This is a protocol for later execution, **not an already-run harness or a result**. If auth provisioning or usage cap prevents it, leave the corresponding acceptance, Sonnet 5 billing and cache-read rows marked **unverified**. Cloud acceptance requires separate account-backed qualification on each transport/account cohort, not another native probe.

## Source map

All upstream host links are pinned to `v1.18.30`:

- [OpenCode package.json:58–75](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/package.json#L58-L75): Anthropic **3.0.111**, Vertex **4.0.181**, Bedrock **4.0.166**, OpenAI **3.0.88**, Google **3.0.73**, OpenAI-compatible **2.0.41**, Groq **3.0.31**, xAI **3.0.102**. Copilot is the host's bundled custom adapter, not a separately installed `@ai-sdk/github-copilot` package.
- [provider.ts:113–140](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/provider.ts#L113-L140): adapter factories, including Copilot; its Claude selection uses chat rather than GPT Responses.
- [message-v2.ts:244–285,362–375](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/message-v2.ts#L244-L285): same-model reasoning metadata replay, cross-model conversion, signed reasoning separators. Cross-model text downgrade is outside this experiment.
- [transform.ts:168–221](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/transform.ts#L168-L221): native Anthropic empty-content filtering **retains empty signed reasoning**; Bedrock filters unsigned reasoning and empty text. [321–353](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/transform.ts#L321-L353): interleaved reasoning moved into provider options; [486–515](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/transform.ts#L486-L515): custom provider metadata remapping and Responses item-ID stripping when `store !== true`; [1408–1465](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/provider/transform.ts#L1408-L1465): request option namespaces.
- [Copilot converter:73–123](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/github-copilot/chat/convert-to-openai-compatible-chat-messages.ts#L73-L123): `reasoning_text` depends on `copilot.reasoningOpaque`; opaque can reside on text/tool parts too. Our sentinel test removes metadata only on the reasoning part; removal may not erase opaque state carried by a different part.
- [Codex plugin:412–435](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/plugin/openai/codex.ts#L412-L435): OAuth endpoint/header rewrite forwards `init.body` unchanged. This supports the serializer-shape conclusion, not authenticated service acceptance or WebSocket equivalence.
- Exact npm source archives downloaded read-only: `@ai-sdk/anthropic@3.0.111` `src/convert-to-anthropic-messages-prompt.ts:592–625` (signature/redacted replay), `src/anthropic-messages-options.ts:307–349` and `src/anthropic-messages-language-model.ts:562–605,701–708` (context management/beta); `@ai-sdk/google-vertex@4.0.181` `src/anthropic/google-vertex-anthropic-provider.ts:192–230` (shared Anthropic model, Vertex request lowering); `@ai-sdk/openai@3.0.88` `src/responses/convert-to-openai-responses-input.ts:567–668,998–1019` (encrypted reasoning and store behavior); `@ai-sdk/google@3.0.73` `src/convert-to-google-generative-ai-messages.ts:247–273` (thought replay); `@ai-sdk/xai@3.0.102` `src/convert-to-xai-chat-messages.ts:65–99` (only text/tool calls replayed).
- Local MC: `transform-postprocess-phase.ts:2204–2242`, `strip-content.ts:307–390`, `sentinel.ts:22–39,94–113`, `tool-drop-target.ts:250–254` under `packages/plugin/src/hooks/magic-context/`: canonical gate, watermark, empty-text replacement and provider-independent tool-drop text mutation. Comments about noncanonical adapters are conservative; mixed-message wire captures alone do not invalidate that broader safety contract.
