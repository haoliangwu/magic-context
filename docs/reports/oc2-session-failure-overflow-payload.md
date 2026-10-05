# OpenCode 2 session-failure overflow payload capture

## Scope and decision

Real-host capture of the events and HTTP response hooks exposed to plugins; no implementation or test changes to the Magic Context context-management plugin. Captured on macOS arm64 with `@opencode/cli` **2.0.18 and 2.0.20**, using their built-in Anthropic and Google providers pointed at a loopback mock. These are native host executions, not event replays or synthetic plugin callbacks.

**The native `session.execution.failed` event is a viable candidate fallback for the tested providers:** its `data.error.message` preserves the overflow sentence and both token numbers. Title-only failures did not emit it. Manual compaction failure used a separate event type. However, there is **no request-kind field** in the execution-failure payload, and the event reports terminal execution failure, not every rejected HTTP request. These observations are not a guarantee for every internal request or the SDK-owned transport in antigravity-auth, the authentication/provider integration for Google/Antigravity. Keep the `http.response` path if antigravity-auth can preserve it; this capture does not establish a need to change Magic Context.

### (a) Verbatim or rewrapped?

The error **object is normalized**, but the provider's **message string is verbatim**, including token numbers, for the captured Anthropic error JSON and Gemini error JSON:

- Anthropic: `prompt is too long: 1091002 tokens > 100000 maximum`
- Gemini: `The input token count (1091002) exceeds the maximum number of tokens allowed (100000)`

Both normalize to `error.type: "provider.invalid-request"`, `error.status: 400`. The native host did not prepend a summary or discard the numbers in these primary-failure captures. OpenCode 2.0.20 additionally retains the original JSON as `data.error.response.body` (a string); 2.0.18 does not include that field.

### (b) Which field?

`event.data.error.message`, in an event received through the plugin's `context.event.subscribe` subscription API with `event.type === "session.execution.failed"`. The session is `event.data.sessionID`, also repeated as `event.durable.aggregateID`. This is not `event.properties.error` or a top-level `event.error`.

**Zero `session.error` events were observed** in all 20 accepted runs. Primary failures also emitted `session.step.failed`, with the same error and an `assistantMessageID`; that was recorded but is not the requested execution-failure signal.

### (c) Title/internal failures and primary discrimination

There is **no `kind`, model, provider, request ID, or assistant-message ID in `session.execution.failed.data`**. Its type is the available discriminator in these captures, not an equivalent of `http.response.kind === "primary"` (which identifies the user's main model request, rather than title or compaction requests):

- An untitled session sends title requests under **the same sessionID** as the primary turn. The host first tried its small title model, then retried title generation with `mock-model`. Both title responses were HTTP 400 overflow errors. With a successful primary response, the execution emitted `session.execution.succeeded`, **not** `session.execution.failed` or `session.error`. This held for both providers on both host versions.
- When title and primary requests all failed, there was **one** `session.execution.failed`, not one per title request. The title-model fallback could complete after the execution-failure event. Correlating solely by sessionID or arrival proximity would therefore be unsafe.
- A successful primary followed by explicit `client.session.compact` sent a `kind: "compaction"` request under the same sessionID. Its 400 overflow failure emitted **`session.compaction.failed`**, not `session.execution.failed` or `session.error`. The surrounding manual-compaction execution still emitted `session.execution.succeeded`.
- With automatic native compaction enabled, primary overflow triggered a compaction request. If that failed too, the host emitted `session.compaction.failed`, then `session.step.failed`, then **one `session.execution.failed`**. Thus execution failure can follow an internal recovery request; it is not a per-request notification.

The scope of this answer is title generation, explicit compaction, and automatic overflow compaction. Other helpers such as arbitrary `context.session.generate` calls, SDK-owned fetch, hidden runs, and cancellation were not exercised. Do not infer universal primary-only semantics from the absence of a `kind` field. No fallback was implemented or guessed here.

### (d) Do both signals fire, and in what order?

**Yes**, for these ordinary, non-owned primary requests. In all primary-failure runs, the plugin observed the `http.response` draft first, then `session.step.failed`, then `session.execution.failed`. With automatic compaction, its response hook and failure event intervened before step/execution failure. The timestamps below are plugin observation time (`Date.now()`), not a promise about future host scheduling.

| Host | Provider | Primary hook time | Step failed observed | Execution failed observed |
| --- | --- | ---: | ---: | ---: |
| 2.0.18 | Anthropic | 1790721337366 | 1790721337373 | 1790721337373 |
| 2.0.18 | Google | 1790721350132 | 1790721350139 | 1790721350139 |
| 2.0.20 | Anthropic | 1790721369896 | 1790721369903 | 1790721369903 |
| 2.0.20 | Google | 1790721382320 | 1790721382327 | 1790721382328 |

A future consumer would need idempotence between hook and event, but the captured HTTP response draft and execution-failure event contain no shared HTTP request identifier. Deduplication design and recovery behavior were deliberately not implemented or tested in this report.

## Capture method

Used the worktree's `packages/e2e-tests/src/opencode2-runner/spawn.ts` with:

- `includeMagicContext: false`, `prepareContextDatabase: false`: only the observer plugin and the runner's existing schema guard were loaded. No Magic Context database was prepared, opened, or migrated. This keeps host error propagation independent of Magic Context's emergency interception.
- `existingIsolation` constructed beneath `$TMPDIR/magic-context/oc2-overflow-event/`, canonicalized through `realpathSync` on macOS.
- `providerID: "anthropic"` or `"google"`, `defaultModelID: "mock-model"`, `modelOutputLimit: 1024`, context limit 200000. The deliberately inconsistent mock error reports N=1091002 and M=100000; the purpose is to capture provider error transport, not estimate prompt size.
- A loopback `Bun.serve` returned HTTP 400 with the exact JSON below. Successes used the existing Anthropic `MockProvider` SSE response or a minimal Google SSE candidate with usage 100 input / 10 output tokens.
- Explicit session titles suppressed title traffic in the primary/compaction cases. Untitled cases deliberately exercised it. Prompt: `Please respond to this primary capture prompt.`
- `client.session.prompt`, then `client.session.wait` (15-second deadline), then a 1.5-second settling interval to capture title fallback. Every accepted run's wait completed without timeout. Manual compaction cases then called `client.session.compact` and waited again before settling.
- The observer subscribed to **all** plugin events before the turn and recorded every response hook using `response.clone().text()`. No error body was injected into an event, and the observer did not rewrite any draft.

Observer plugin used to record subscribed events and cloned response bodies (reformatted for readability):

```js
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default {
  id: "overflow-capture",
  async setup(context) {
    const log = (entry) => appendFileSync(
      join(context.location.directory, "capture.jsonl"),
      JSON.stringify({ at: Date.now(), ...entry }) + "\n",
    );
    const ctrl = new AbortController();
    void (async () => {
      for await (const event of context.event.subscribe({ signal: ctrl.signal })) {
        log({ source: "event", event });
      }
    })();
    await context.session.hook("http.response", async (draft) => log({
      source: "http.response",
      draft: {
        sessionID: draft.sessionID,
        kind: draft.kind,
        model: draft.model,
        status: draft.response.status,
        body: await draft.response.clone().text(),
      },
    }));
    log({ source: "ready" });
    return () => ctrl.abort();
  },
};
```

Mock request classification for selective failures used **only system-prompt text**, then was checked against the captured response-hook `kind`:

```ts
const systemTexts = providerID === "google"
  ? (body.systemInstruction?.parts ?? [])
  : (body.system ?? []);
const isTitle = systemTexts.some(part =>
  part.text?.startsWith("You are a title generator."));
const isCompaction = text.includes(
  "You MUST summarize the conversation above into a structured summary");
const fail = mode === "title-only" ? isTitle
  : mode === "compaction-only" ? isCompaction
  : true;
```

| Mode | Session title | Native auto compaction | Mock failure policy | Observed requests / relevant events |
| --- | --- | --- | --- | --- |
| `primary` | Explicit | false | All | Primary 400; step failed; execution failed |
| `untitled-all-error` | Omitted | false | All | Title 400; primary 400; fallback title 400; one execution failed |
| `title-only` | Omitted | false | Title only | Title 400; primary 200; fallback title 400; execution succeeded |
| `compaction-only` | Explicit | false | Compaction only | Primary 200; manual compaction 400; compaction failed; no execution failed |
| `auto-all-error` | Explicit | true | All | Primary 400; automatic compaction 400; compaction failed; step failed; execution failed |

Each row ran separately for both providers and both host versions: **20 accepted hosts**. Initial exploratory captures had an overbroad title matcher or forwarded the wrong `Host` header to the Anthropic success server; those were discarded, the routing was fixed, and the complete matrix rerun. None of the failed exploratory title-only attempts is used as negative evidence.

### Tools and commands

The worktree dependencies were installed with `bun install --frozen-lockfile`; no manifest or lockfile changed. The repository currently pins 2.0.15, so 2.0.18 was selected explicitly rather than using the e2e runner's default version resolution. Package manifests confirmed the selected binaries as 2.0.18 and 2.0.20.

```sh
bun add --cwd "$TMPDIR/magic-context/oc2-overflow-event/cli-2.0.20" @opencode/cli@2.0.20
bun pm --cwd "$TMPDIR/magic-context/oc2-overflow-event/cli-2.0.20" trust @opencode/cli

CAPTURE_VERSION=2.0.18 \
MC_E2E_OPENCODE2_CLI="$HOME/.local/share/cortexkit/e2e-bin/opencode-cli/2.0.18/node_modules/@opencode/cli/bin/opencode.exe" \
bun packages/e2e-tests/.oc2-overflow-capture.ts

CAPTURE_VERSION=2.0.20 \
MC_E2E_OPENCODE2_CLI="$TMPDIR/magic-context/oc2-overflow-event/cli-2.0.20/node_modules/@opencode/cli/bin/opencode.exe" \
bun packages/e2e-tests/.oc2-overflow-capture.ts
```

The last two commands were also run with `CAPTURE_AUTO=1` to select the automatic-compaction cases. The temporary capture driver was removed from the worktree after collecting evidence; it is not a new e2e suite or production code. The observer, routing, host options, and lifecycle above describe its capture procedure.

## Captured payloads

The JSON below preserves event IDs, session IDs, timestamps, error text and structural fields. Response drafts serialize the native `Response` as `status` plus cloned `body`; the response object itself cannot be meaningfully JSON-stringified. No secret credentials are included.

### Anthropic 2.0.18: primary response and execution failure

```json
{
  "hook": {
    "sessionID": "ses_f10b0ddafffesCovX5vER7TCbq",
    "kind": "primary",
    "model": { "id": "mock-model", "providerID": "anthropic", "variant": "default" },
    "status": 400,
    "body": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 1091002 tokens > 100000 maximum\"}}"
  },
  "event": {
    "id": "evt_0ef4f281b001jPn89KqwfXBS4d",
    "created": 1790721337371,
    "type": "session.execution.failed",
    "durable": { "aggregateID": "ses_f10b0ddafffesCovX5vER7TCbq", "seq": 7, "version": 1 },
    "data": {
      "sessionID": "ses_f10b0ddafffesCovX5vER7TCbq",
      "error": { "type": "provider.invalid-request", "message": "prompt is too long: 1091002 tokens > 100000 maximum", "status": 400 }
    }
  }
}
```

### Gemini 2.0.18: primary response and execution failure

```json
{
  "hook": {
    "sessionID": "ses_f10b0a97fffe4fcwkSL2yQlK7Z",
    "kind": "primary",
    "model": { "id": "mock-model", "providerID": "google", "variant": "default" },
    "status": 400,
    "body": "{\"error\":{\"code\":400,\"message\":\"The input token count (1091002) exceeds the maximum number of tokens allowed (100000)\",\"status\":\"INVALID_ARGUMENT\"}}"
  },
  "event": {
    "id": "evt_0ef4f59fa001MnW3RCLq4EoUWy",
    "created": 1790721350138,
    "type": "session.execution.failed",
    "durable": { "aggregateID": "ses_f10b0a97fffe4fcwkSL2yQlK7Z", "seq": 7, "version": 1 },
    "data": {
      "sessionID": "ses_f10b0a97fffe4fcwkSL2yQlK7Z",
      "error": { "type": "provider.invalid-request", "message": "The input token count (1091002) exceeds the maximum number of tokens allowed (100000)", "status": 400 }
    }
  }
}
```

### Anthropic 2.0.20: primary response and execution failure

```json
{
  "hook": {
    "sessionID": "ses_f10b05c8cffefIqDDgO2QqrOlA",
    "kind": "primary",
    "model": { "id": "mock-model", "providerID": "anthropic", "variant": "default" },
    "status": 400,
    "body": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 1091002 tokens > 100000 maximum\"}}"
  },
  "event": {
    "id": "evt_0ef4fa72d001zEoOvi52GwKzjs",
    "created": 1790721369901,
    "type": "session.execution.failed",
    "durable": { "aggregateID": "ses_f10b05c8cffefIqDDgO2QqrOlA", "seq": 7, "version": 1 },
    "data": {
      "sessionID": "ses_f10b05c8cffefIqDDgO2QqrOlA",
      "error": {
        "type": "provider.invalid-request",
        "message": "prompt is too long: 1091002 tokens > 100000 maximum",
        "status": 400,
        "response": { "body": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 1091002 tokens > 100000 maximum\"}}" }
      }
    }
  }
}
```

### Gemini 2.0.20: primary response and execution failure

```json
{
  "hook": {
    "sessionID": "ses_f10b02bd3ffeAc4K7Z9QrDikq1",
    "kind": "primary",
    "model": { "id": "mock-model", "providerID": "google", "variant": "default" },
    "status": 400,
    "body": "{\"error\":{\"code\":400,\"message\":\"The input token count (1091002) exceeds the maximum number of tokens allowed (100000)\",\"status\":\"INVALID_ARGUMENT\"}}"
  },
  "event": {
    "id": "evt_0ef4fd7b50011IuPklpnCSfemF",
    "created": 1790721382326,
    "type": "session.execution.failed",
    "durable": { "aggregateID": "ses_f10b02bd3ffeAc4K7Z9QrDikq1", "seq": 7, "version": 1 },
    "data": {
      "sessionID": "ses_f10b02bd3ffeAc4K7Z9QrDikq1",
      "error": {
        "type": "provider.invalid-request",
        "message": "The input token count (1091002) exceeds the maximum number of tokens allowed (100000)",
        "status": 400,
        "response": { "body": "{\"error\":{\"code\":400,\"message\":\"The input token count (1091002) exceeds the maximum number of tokens allowed (100000)\",\"status\":\"INVALID_ARGUMENT\"}}" }
      }
    }
  }
}
```

### Title-only negative controls

All title drafts carried the same provider error bodies as the corresponding primary fixtures above. Captured hook sequence (same sessionID throughout each row):

| Host / provider | SessionID | First title hook / model | Primary hook | Fallback title hook / model | Failed/error events |
| --- | --- | --- | --- | --- | --- |
| 2.0.18 / Anthropic | `ses_f10b0c1d8ffeuHozT4MknJF8ZZ` | 1790721343937 / `claude-haiku-4-5` / 400 | 1790721343940 / 200 | 1790721343951 / `mock-model` / 400 | None |
| 2.0.18 / Google | `ses_f10b09223ffe2ZjWhJyB2FYak9` | 1790721355980 / `gemini-flash-lite-latest` / 400 | 1790721355983 / 200 | 1790721355996 / `mock-model` / 400 | None |
| 2.0.20 / Anthropic | `ses_f10b044d4fferqS2yfKWRvAxHz` | 1790721375895 / `claude-haiku-4-5` / 400 | 1790721375898 / 200 | 1790721375911 / `mock-model` / 400 | None |
| 2.0.20 / Google | `ses_f10b013e2ffesv1tX3IHi3rtxo` | 1790721388382 / `gemini-flash-lite-latest` / 400 | 1790721388385 / 200 | 1790721388398 / `mock-model` / 400 | None |

Each stream contained one `session.execution.succeeded`, so the absence of failure events is accompanied by positive evidence that the observer received completion. Title requests were confirmed by their system prompt, not inferred from model name.

### Internal compaction payload difference

Manual compaction, Anthropic 2.0.18 (only the throwaway directory is redacted):

```json
{
  "id": "evt_0ef4f4e1e001kzfGIOpE5PkZ5i",
  "created": 1790721347102,
  "type": "session.compaction.failed",
  "durable": { "aggregateID": "ses_f10b0b5cdffehczm5aScZgGLcL", "seq": 15, "version": 1 },
  "location": { "directory": "<throwaway-root>/work" },
  "data": {
    "sessionID": "ses_f10b0b5cdffehczm5aScZgGLcL",
    "reason": "manual",
    "error": { "type": "provider.invalid-request", "message": "prompt is too long: 1091002 tokens > 100000 maximum", "status": 400 },
    "inputID": "msg_0ef4f4e09001XjIpfU40dSEyX7"
  }
}
```

Automatic compaction, Anthropic 2.0.20, followed by terminal execution failure:

```json
[
  {
    "id": "evt_0ef507a8300117VK81J5BG79Un",
    "created": 1790721424003,
    "type": "session.compaction.failed",
    "durable": { "aggregateID": "ses_f10af8818ffe7kt86amRoAORzT", "seq": 6, "version": 1 },
    "location": { "directory": "<throwaway-root>/work" },
    "data": {
      "sessionID": "ses_f10af8818ffe7kt86amRoAORzT",
      "reason": "auto",
      "error": { "type": "compaction.failed", "message": "The compaction request cannot be reduced further without losing the latest exchange or checkpoint" }
    }
  },
  {
    "id": "evt_0ef507a86001nyquN6A4GRcWmH",
    "created": 1790721424006,
    "type": "session.execution.failed",
    "durable": { "aggregateID": "ses_f10af8818ffe7kt86amRoAORzT", "seq": 9, "version": 1 },
    "data": {
      "sessionID": "ses_f10af8818ffe7kt86amRoAORzT",
      "error": {
        "type": "provider.invalid-request",
        "message": "prompt is too long: 1091002 tokens > 100000 maximum",
        "status": 400,
        "response": { "body": "{\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"prompt is too long: 1091002 tokens > 100000 maximum\"}}" }
      }
    }
  }
]
```

Google 2.0.20 had the same generic `compaction.failed` message, while its terminal execution error retained the Gemini overflow sentence and raw JSON. In 2.0.18 both manual and automatic compaction errors instead retained `provider.invalid-request` with the overflow sentence. An overflow detector using native failure events must not treat every error-bearing event as a primary request failure.

## Live-store isolation evidence

No live store or configuration contents were opened/read/written. No migration was performed. All accepted host runs set:

```text
HOME                 = <root>/HOME
XDG_CONFIG_HOME      = <root>/XDG_CONFIG_HOME
XDG_DATA_HOME        = <root>/XDG_DATA_HOME
XDG_STATE_HOME       = <root>/XDG_STATE_HOME
XDG_CACHE_HOME       = <root>/XDG_CACHE_HOME
XDG_RUNTIME_DIR     = <root>/XDG_RUNTIME_DIR
CARGO_HOME           = <root>/CARGO_HOME
RUSTUP_HOME          = <root>/RUSTUP_HOME
TMPDIR               = <root>/tmp
OPENCODE_DB          = opencode2.db
MAGIC_CONTEXT_STORAGE_DIR = <root>/storage
OPENCODE_DISABLE_DEFAULT_PLUGINS = true
```

`OPENCODE_DB` is a basename because this runner requires it; the host resolves it beneath the private `XDG_DATA_HOME/opencode/`, not relative to the operator's home. The runner inspects the host process group's open files at startup and shutdown, rejecting protected live paths and outside writable files and matching the private DB inode. Its write fence inspects directory/file **metadata only**, not live store/config contents. An additional explicit `lsof -p <host pid> -Fin` was captured after each settled scenario and before shutdown. All 20 captures included the private database and no protected live-store/config paths. These are point-in-time checks, not continuous tracing.

Accepted local artifact roots, all beneath the canonical `$TMPDIR/magic-context/oc2-overflow-event/` (prefix abbreviated as `B`):

- `B/2.0.18-5lwaRo/results.json`: eight cases with auto compaction disabled.
- `B/2.0.20-j42e4C/results.json`: same eight cases.
- `B/2.0.18-mL0dy3/results.json`: two automatic-compaction cases.
- `B/2.0.20-4A52HU/results.json`: same two cases.

Here `B` was `/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/oc2-overflow-event`. Each scenario has `work/capture.jsonl` and `lsof.txt`; the aggregate JSON also retains mock request bodies, observation timestamps, private environment and host stderr. Those artifacts are local/temporary, not committed, and are not needed to interpret the payloads above.

| Host | Provider | Mode | PID | Private DB inode from lsof |
| --- | --- | --- | ---: | ---: |
| 2.0.18 | Anthropic | primary | 87045 | 1960301168 |
| 2.0.18 | Anthropic | untitled-all-error | 88153 | 1960301798 |
| 2.0.18 | Anthropic | title-only | 89113 | 1960302530 |
| 2.0.18 | Anthropic | compaction-only | 89608 | 1960303115 |
| 2.0.18 | Google | primary | 89903 | 1960311628 |
| 2.0.18 | Google | untitled-all-error | 90264 | 1960312031 |
| 2.0.18 | Google | title-only | 90635 | 1960312702 |
| 2.0.18 | Google | compaction-only | 91099 | 1960313251 |
| 2.0.20 | Anthropic | primary | 92694 | 1960315411 |
| 2.0.20 | Anthropic | untitled-all-error | 93565 | 1960316168 |
| 2.0.20 | Anthropic | title-only | 94054 | 1960321736 |
| 2.0.20 | Anthropic | compaction-only | 94520 | 1960325177 |
| 2.0.20 | Google | primary | 94905 | 1960325718 |
| 2.0.20 | Google | untitled-all-error | 95340 | 1960326263 |
| 2.0.20 | Google | title-only | 95686 | 1960326603 |
| 2.0.20 | Google | compaction-only | 96001 | 1960326997 |
| 2.0.18 | Anthropic | auto-all-error | 98648 | 1960330309 |
| 2.0.18 | Google | auto-all-error | 99026 | 1960330716 |
| 2.0.20 | Anthropic | auto-all-error | 99302 | 1960331269 |
| 2.0.20 | Google | auto-all-error | 99655 | 1960331709 |

Representative unmodified `lsof -p 87045 -Fin` database lines (surrounding descriptors omitted):

```text
f8
i1960301168
n/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/oc2-overflow-event/2.0.18-5lwaRo/anthropic-primary/XDG_DATA_HOME/opencode/opencode2.db
f9
i1960301170
n/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/oc2-overflow-event/2.0.18-5lwaRo/anthropic-primary/XDG_DATA_HOME/opencode/opencode2.db-wal
f10
i1960301171
n/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/oc2-overflow-event/2.0.18-5lwaRo/anthropic-primary/XDG_DATA_HOME/opencode/opencode2.db-shm
```

## Boundaries

This report establishes native payloads and observed ordering, not overflow recording or emergency recovery. The SDK-owned-fetch/no-response-hook e2e, event-only unit tests, idempotence implementation, mutation proof, and mode-manifest changes were explicitly deferred when scope changed to capture only. Hidden-session behavior was not changed. Production code and pure-replay inputs remain untouched.
