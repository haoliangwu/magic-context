# The ~720 s host `TimeoutError` on OpenCode 1 dreamer rows (2026-09-27)

Follow-up to `dreamer-failure-classes.md` §1b. The live query (14 days, all `harness=opencode`) put host `TimeoutError` durations at: verify n=66 (min 307 s, avg 663 s, max 732 s), map-memories n=63 (334 / 682 / 723 s), classify n=32 (683 / 715 / 720 s), verify-broad n=11 (662 / 705 / 720 s), evaluate-smart-notes n=6 (678 / 694 / 719 s). Only one row sits near 300 s, so neither ~300 s candidate in §1b explains the data as stated. This note names the timer.

## 1. The error is Bun's default fetch timer

Reproduction, run with the Bun embedded in the installed host (`BUN_BE_BUN=1 ~/.opencode/bin/opencode run probe.ts`, Bun 1.4.2). A `node:http` server (the listener OpenCode 1.18.30 uses) accepts three POSTs and never answers. Three clients:

| Client | Result |
|---|---|
| `fetch(url, { signal })` (Bun default) | rejects at **360.2 s**: `name=TimeoutError message="The operation timed out." code=23` |
| `fetch(url, { signal, timeout: false })` | still open at the 20-minute cap |
| `req.timeout = false; fetch(req)` (the stock SDK's `createOpencodeClient` fetch) | still open at the 20-minute cap |

The rejected object is exactly the ledger text `TimeoutError message="The operation timed out." code=23`. Bun's default timer has minute granularity: it fires between 300 and 360 s after the request starts, depending on where the request falls in the minute.

## 2. The installed host hands plugins a client that keeps that timer

A probe plugin loaded into a throwaway root (`XDG_*`, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` all under `$TMPDIR/magic-context/dreamer-timeouts/`; `lsof` on the serve process listed only throwaway `.db` paths) printed `input.client._client.getConfig().fetch`:

- `~/.opencode/bin/opencode` (the installed build, `--version` 1.18.30, 147 MB, built 2026-09-13):
  `async(R,D)=>{let U=new Request(R,D);if(S)return MB(d.directory);if(w)return globalThis.fetch(U);return E.Default().app.fetch(U)}`
  With a live server (`serverUrl` set) every plugin SDK request goes through plain `globalThis.fetch`, so Bun's default timer applies.
- `~/.opencode/bin/opencode-stock-1.18.30` (stock):
  `(X)=>{return X.timeout=!1,fetch(X)}` (the SDK's `createOpencodeClient`, source `packages/sdk/js/src/client.ts` at tag `v1.18.30`), which disables it.

So on the installed build, `client.session.prompt` (a synchronous `POST /session/{id}/message` that the host answers only when the child's whole agent loop ends, `SessionHttpApi.prompt` in `server/routes/instance/httpapi/handlers/session.ts`) fails after 300–360 s while the child keeps running.

## 3. Why the rows cluster near 720 s

The retry chain treated `TimeoutError` as retryable (`provider_error`) and did not abort the child. The fallback model was then sent into the same child session, which was still busy, and met the same 300–360 s timer. When every attempt fails, `promptSyncWithValidatedOutputRetry` throws the **first** attempt's error, so the row shows `TimeoutError` with a duration of about two timer periods: 600–720 s plus request overhead, which matches classify's 683–720 s and the other maxima of 719–732 s. The 307 s minimum is a single attempt that met the timer early in its minute. Our own slice can end the second attempt sooner, which gives the lower averages on verify and map.

The host has a second, separate timer that does not end the loop: OpenCode's provider-request timeout (default 300 000 ms, `AbortSignal.timeout(options.timeout)` around each provider call). In the real-host runs below, a model that never answered was asked again by the host after 300 s within the same loop (the mock saw the same one-prompt conversation twice). That retry keeps the child busy; it is not what produces the ledger's `TimeoutError`.

## 4. What changed

- `TimeoutError` is now a timeout everywhere: non-retryable, `provider_timeout`, ledger status `timed_out`, counted by map's breaker, and the child run is aborted.
- Real-host evidence on the installed 1.18.30 build (throwaway data roots, `lsof` showing only throwaway `.db` files): `tests/dreamer-host-timeout.test.ts` gets a real Bun `TimeoutError` after 358 s from a plain-fetch client and the chain files it as `provider_timeout`, tries one model and leaves the child idle; `tests/dreamer-verify-slice-authority.test.ts` runs a verify batch through the plugin for 420 s, past the host fetch timer, and it ends on its own slice (`prompt timed out after 419976ms`).
- The root cause is removed rather than outrun: OpenCode 1 verify, map-memories and dreamer-task hidden children (classify, compress-cues) send with `session.promptAsync` and poll `session.status` for idle (`shared/prompt-async-transport.ts`). Every request is short, so the task's own slice is the only timer and still aborts the child when it fires. The host timer cannot be raised from the plugin: the client and its fetch belong to the host.
