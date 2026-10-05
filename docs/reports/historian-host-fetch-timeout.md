# Historian prompts ending at about five minutes despite `historian_timeout_ms` (2026-10-02)

Evidence: the issue 563 priming trial (every thinking-on historian attempt failed with `TimeoutError` at 300–340 s under a 600 s `historian_timeout_ms`), and a live SUBC session on 2026-10-02 (`historian prompt failed: TimeoutError message="The operation timed out." code=23`).

## Which timer fires

Bun's default `fetch` timer, on the plugin's own requests to the OpenCode 1 host. Two parts make it fire:

1. On OpenCode 1 the historian sent its prompt with a synchronous `client.session.prompt`. That is one `POST /session/{id}/message`, and the host answers it only when the child's whole run ends, so the request stays silent for the model's full answer time.
2. The installed host build (`~/.opencode/bin/opencode`, 1.18.30) hands plugins a client whose fetch is plain `globalThis.fetch` (`docs/reports/dreamer-host-fetch-timeout.md` §2). Bun's default timer stays on and rejects the request with a `TimeoutError` DOMException (`The operation timed out.`, legacy code 23) after 300–360 s. The stock 1.18.30 build uses the SDK's own fetch, which sets `timeout = false`.

Reproduced with the Bun embedded in the stock host (`BUN_BE_BUN=1 opencode-stock-1.18.30 run probe.ts`, Bun 1.3.14). A local server holds each response for 330 s:

| Client | Result |
|---|---|
| `fetch(url)` | `TimeoutError` code 23 at 300 010 ms |
| `req.timeout = false; fetch(req)` (stock SDK fetch) | 200 at 330 s |
| `fetch(url, { timeout: false })` | 200 at 330 s |

Our own timer (`promptWithTimeout`) would have thrown `prompt timed out after <n>ms`, not a `TimeoutError`. A `TimeoutError` therefore means a host-side timer fired.

The SUBC attempt started at 17:43:29.7Z (first child message) and failed at 17:53:39.3Z, about 610 s later. That is longer than one Bun period, and the log alone does not show why. The error shape is the same as the trial's.

## Every timeout on the historian request path

Our timers:
- `packages/plugin/src/shared/model-suggestion-retry.ts:257`, `promptWithTimeout`: a per-attempt `setTimeout` that aborts the request with `timeoutMs`. On expiry it aborts the child run (`abortChildRun`, `:323`, bounded by `ABORT_CALL_TIMEOUT_MS = 3000`, `:25`) and throws `prompt timed out after <n>ms`.
- `model-suggestion-retry.ts:523` and `:697`: a 300 000 ms fallback when a caller passes no `timeoutMs`. The historian always passes `historian_timeout_ms` (`compartment-runner-historian.ts`, the `timeoutMs: timeoutMs ?? DEFAULT_HISTORIAN_TIMEOUT_MS` arguments to `executor.open` and to the retry chain).
- `packages/plugin/src/config/schema/magic-context.ts:18`: `DEFAULT_HISTORIAN_TIMEOUT_MS = 600_000`, with a schema minimum of 60 000.
- `packages/plugin/src/shared/prompt-async-transport.ts:46`: `DEFAULT_START_GRACE_MS = 30_000`. This only applies when the child is idle and has no settled answer, meaning the send was lost. It is not a run limit.
- `packages/plugin/src/hooks/magic-context/historian-host-runner.ts:264`: the Rust host-runner claim race. The per-attempt time is `min(budget, claim.historianTimeoutMs)` (`:638`).
- `packages/plugin/src/v2/hidden-completion.ts:541` and `:611`: the OpenCode 2 executor deadline (`run.identity.timeoutMs`, which is `historian_timeout_ms`). It interrupts and retires the child.
- `packages/pi-plugin/src/subagent-runner.ts:1879`: the Pi hard timeout (`historianTimeoutMs`). It SIGTERMs the child, then SIGKILLs it after 2 s (`:2645`). There is also a 2 s drain grace after the final turn (`:526`).
- `crates/mc-module/src/historian.rs:1417`: `historian_await_timeout`, which clamps `historian_timeout_ms` to 60 s–1 h. `:1423` adds 60 s per attempt. `crates/mc-module/src/historian_host.rs:142` waits on the claimant with `tokio::time::timeout_at`.

`AbortSignal.timeout` in shipped plugin code: none is on the historian or dreamer prompt path. The uses are `v2/host-service.ts:271` (60 s DELETE), `plugin/conflict-warning-hook.ts:141` (10 s), `hooks/magic-context/send-session-notification.ts:379` (10 s) and `features/magic-context/memory/embedding-probe.ts:99`.

Client `fetch`: the plugin creates no OpenCode client of its own and uses the host's `input.client`. The stock SDK (`@opencode-ai/sdk` `createOpencodeClient`) sets `req.timeout = false` only when the caller supplies no fetch. A host that supplies plain `globalThis.fetch` keeps Bun's timer. This is the one that fired.

Host timers (OpenCode 1.18.30 provider fetch wrapper, from the stock binary): `headerTimeout` (default 300 000 ms, raises `HeaderTimeoutError`), `chunkTimeout` (default 300 000 ms between SSE chunks, raises `ResponseStreamError("SSE read timed out")`), and the optional provider `timeout` (`AbortSignal.timeout`). All three are set per provider in `opencode.json` under `provider.<id>.options`. A local model that sends no response headers or stream chunks for five minutes meets these too, and the plugin cannot change them. They make the host retry or fail the step; they do not produce the plugin-side `TimeoutError`.

## Fix

`createV1HiddenCompletionExecutor` (`compartment-runner-historian.ts`) now sends every hidden child, historian included, with `prompt_async` and polls `session.status` for idle, as dreamer children already did. No request stays open for the run, so `historian_timeout_ms` is the only limit, and on expiry the retry chain still aborts the child. A provider error the host records still ends a historian attempt the way the synchronous prompt did: `collect()` reports the failed assistant message, and the historian does not re-send into the same child. The dreamer's user-memory review and smart-note compiler children, which still held a synchronous prompt, now use the same transport. Clients without `prompt_async` (the Pi facades) keep the synchronous prompt.

Tests:
- `packages/plugin/src/hooks/magic-context/v1-hidden-executor-prompt-async.test.ts`: a host whose held requests die on a short timer standing in for Bun's.
- `packages/e2e-tests/tests/historian-host-timeout.test.ts`: a real OpenCode 1 host, a plain-fetch client and a model that streams for seven minutes. It runs the historian executor and a held-prompt control side by side. The mock keeps the stream alive with pings (`streamHoldMs`), so the host's own header and chunk timers stay out of the result.

Real-host result on `~/.opencode/bin/opencode` 1.18.30, in a throwaway root (`lsof` on the serve pid listed only `.db` files under the harness's `$TMPDIR/opencode-e2e-*`):
- The executor path completed after 420 991 ms with the model's answer. The mock received one request and no session was left busy.
- The held control failed with `TimeoutError: The operation timed out.` at 359 564 ms.
- An earlier run with a six-minute model gave 360 598 ms for the executor and 359 971 ms for the control.
