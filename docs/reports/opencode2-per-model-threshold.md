# OpenCode 2 per-model execution thresholds

## Runtime version and affected releases

The diagnostics in issue 622 label the plugin as 0.45.0, but that field is
`getSelfVersion()` in `packages/cli/src/lib/diagnostics-opencode.ts`: it identifies
the reporting CLI, not the plugin loaded by the host. Both OpenCode plugin-cache
manifests in the report identify 0.44.4. More decisively, the supplied running
plugin log says `supported_fence=v91`. The published 0.44.4 bundle supports v91;
the published 0.45.0 bundle supports v94. Among those two releases, the runtime
evidence identifies **0.44.4**, not 0.45.0. This conclusion uses the supplied
report and downloaded release artifacts; no reporter or operator store was opened.

Both **published 0.44.4 and published 0.45.0** reproduce the defect on a real
OpenCode **2.0.22** host. Each was downloaded from npm and loaded as an explicit
directory plugin in a fresh host with its own database schema. At 284,298 input
tokens out of a 917,504-token usable window, both log a 31.0% scheduler **defer**.
The 0.45.0 run also reproduces the reporter's `below proactive floor (48%)` log.
Refreshing the cache to 0.45.0 alone therefore does not fix this defect.

## Model-key trace and root cause

OpenCode 2 already knows the selected model before its first usage reading:

1. `registerContext` receives `draft.model = { providerID, id, variant? }`.
2. `createChatMessageHook` is called before the shared transform. It stores
   `{ providerID: draft.model.providerID, modelID: draft.model.id }` in
   `liveModels`, on **every** context pass.
3. `createTransform` receives this map as `liveModelBySession`, and its v2
   `hostModelFallback` reads the same map. Budget/limit resolution can see it.
4. However, the TypeScript transform reads `deps.getModelKey?.(sessionId)` for
   `resolveExecuteThreshold[Detail]`, the scheduler, the protected-tail boundary,
   and history budgets. The v2 adapter never supplied **that callback**.
5. Consequently the resolver receives `undefined`, even after usage events and
   even when `responseModel` is an exact config match. The percentage map falls
   back to `default: 50`; the proactive floor is `50 - 2 = 48`, not `20 - 2 = 18`.

This is not a provider-prefix mismatch, a variant suffix, a stale stored session
model, or a threshold cached before the model becomes known. The configuration
map is retained at startup, but the model-specific value is resolved per pass.
Usage persistence correctly identifies the response model independently; that
log line did not prove the scheduling resolver received a model key.

The fix supplies `getModelKey` in `createHostSeams`, resolving the current draft
map through the same `resolveModelKey(providerID, modelID)` canonicalizer as
OpenCode 1. The callback is evaluated each time it is called, not captured when
the transform is created. It therefore works before the first response, after a
model switch, and for a session other than the one that created the transform.

### Harness parity

* **OpenCode 1:** `hook.ts` already supplies `getModelKey` from
  `liveModelBySession`, using `resolveModelKey`. Its chat-message hook seeds the
  map before usage; assistant events and cold-store recovery also maintain it.
  A regression test exercises the actual hook with the exact muse/mimo config,
  verifies the scheduler receives the selected model, and checks execute/defer
  across the switch.
* **OpenCode 2:** the outgoing draft is authoritative. A response from an older
  model does not replace the draft model; existing usage-reading/persistence
  code ignores stale-model pressure. The missing shared-transform callback was
  the gap, now covered by unit and real-host tests.
* **Pi:** the context handler tracks the canonical live `ctx.model` key and
  passes it directly to the shared scheduler and threshold resolver. Existing
  context-handler tests cover live model, forward pressure, cache-TTL routing,
  and historian pressure; the added resolver test checks the exact muse config
  and its 18% floor. No Pi production change is necessary.

The reporter's logs are from the TypeScript transform. The separate Rust-mode
transform resolves a model key from the live model itself; this report does not
claim a new native-host verification or change Rust policy.

## Other per-model maps

* **`execute_threshold_tokens`: affected by the same missing callback.** A
  model-only override fell through to its default, or to percentage mode if no
  token default existed. Supplying the callback fixes scheduler, pressure bands,
  protected-tail sizing, and history-budget token resolution together. A real
  2.0.22 host test uses the exact muse model with a 70,000-token default and a
  20,000-token model override: it defers at 10,000 and executes at 30,000.
* **`cache_ttl`: not affected by this omission.** The chat-message hook seeds it
  with explicit provider/model IDs; the shared transform also resolves the
  session's frozen TTL policy from message/live-model IDs, not `getModelKey`.
  Both released-host reproductions already logged the per-model `1h` override.
  The fixed-host test checks that value in the throwaway persisted session too.
* **`output_reserve`: not affected by this omission.** V2 installs the reserve
  config and resolves limits with explicit provider/model IDs from the draft or
  measured response. With a zero default and a 131,072-token muse override, all
  three hosts (0.44.4, 0.45.0, fixed source) report the expected
  `1,048,576 - 131,072 = 917,504` usable input window.

## Verification and non-vacuity

The new unit test first failed against unchanged source: expected
`opencode/muse-spark-1.3-contributor-free`, received `undefined`. Its scalar and
token-default controls still passed. Published-release host runs then failed the
behavioral assertion `decision=execute`, receiving `decision=defer` at 31.0%.

The fixed host logs:

```text
transform threshold: model=opencode/muse-spark-1.3-contributor-free matchedModel=opencode/muse-spark-1.3-contributor-free mode=percentage threshold=20% proactiveFloor=18%
transform scheduler: percentage=31.0% inputTokens=284298 cacheTtl=1h ... decision=execute
```

It also logs the actual compartment check's 18% floor, invokes the mock
historian, and persists a compartment. The fixture provides real eligible
history, not just inflated usage; the historian can choose the size trigger
before the proactive trigger. Its historian/dreamer models are pinned to the
loopback mock rather than the reporter's external provider models.

Neutralizing the new callback by omitting its model ID reproduced the defect:
only `selects the draft model's threshold before usage and after a model switch`
failed in the four-test unit file (the other three controls passed), and only
`OpenCode 2 honors the exact per-model threshold and proactive floor with a mock provider`
failed in its host file. The mutation was staged safely, marked
`NON-VACUITY BREAK`, and restored from the index; the working diff was nonempty
during the mutation and empty after restoration. The restored bundles were
rebuilt before the final host verification.

All host roots, including HOME and all XDG roots, were below
`$TMPDIR/magic-context/bg_45b8fe1513a46298/`. The runner invokes `lsof -p` for the
host process group at startup and teardown and verifies the private host DB
inode. The threshold test prints its explicit post-turn inventory; every `.db`,
`-wal`, and `-shm` path is under the throwaway root. No live store was read,
written, migrated, or copied. Host-run commands were bounded by outer `timeout`.

The broad OpenCode 2 runner TypeScript program has unrelated baseline errors in
older adapter/dreamer/RPC/todo tests, missing retina paths, and the documented
cross-generation Effect readonly-Error augmentation. A narrowed program covering
the two touched host test files, with the workspace's retina paths and Bun/Node
types, passes TypeScript 5.9.3. Plugin and Pi package typechecks also pass.

## Workaround before a fixed release

On OpenCode 2 with either affected release, use a **scalar**
`"execute_threshold_percentage": 20`, or set the map's **`default` to 20**.
Those paths already work, but affect every model; other per-model percentage
entries will still be ignored until upgrading to a build containing the fix.
For token mode, a `execute_threshold_tokens.default` override likewise works
globally. Restart the host after changing startup configuration.

Do not strip the provider prefix, change variant names, or rely on clearing the
cache to 0.45.0 as the fix. After installing a release containing the change,
refresh the plugin cache if necessary and restart the running host: an existing
process can still retain an older loaded plugin. Automatic historian execution
also needs meaningful eligible history outside the protected tail; crossing the
threshold alone does not guarantee a useful summarization run.
