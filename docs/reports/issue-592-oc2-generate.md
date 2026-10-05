# Issue 592: read-only OpenCode 2 generate context

## Host confirmation

Verified on **@opencode/cli 2.0.20**, installed only under `$TMPDIR/magic-context/issue-592/host`. The recording provider is the repository's loopback OpenAI Responses mock, not a live provider.

The exact-version source was fetched into `$TMPDIR/magic-context/issue-592/source`:

- [`core/src/session/generate.ts:19–65`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/generate.ts#L19-L65): generation is explicitly non-mutating; it previews stored history, builds the base transcript, appends instruction updates and `Message.user(input.prompt)`, then prepares the generate request.
- [`core/src/session/model-request.ts:415–422`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/core/src/session/model-request.ts#L415-L422): `prepare("generate", input, agentHook("generate", input.agent))` triggers the session generate hook.
- [`protocol/src/groups/session.ts:706–717`](https://github.com/anomalyco/opencode/blob/v2.0.20/packages/protocol/src/groups/session.ts#L706-L717): the supported trigger used here is **POST `/api/session/:sessionID/generate`**, body `{"prompt":"SIDE-QUESTION"}`. This exercises the host's side-question path without needing terminal keystrokes.

The probe wraps the actual plugin registrations, recording the host draft before and after the callback. The generate draft contains `sessionID`, `model`, `agent`, mutable `system`, `messages`, `tools`, and `options`; the side question is the final user message, with no stored message ID. The hook returns no answer itself: changing its draft changes the real provider request. The host returned HTTP 200 and the mock's answer.

The fixture creates a real tool call (`bash`, producing `RAW-DROPPED-OUTPUT`), marks its existing tag dropped, seeds a compartment containing `GENERATE-COMPARTMENT`, and serves a second main turn before invoking generate. Historian, dreamer, memory and temporal awareness are disabled to isolate request rendering.

### Captured result

The completed capture is under:

```
/private/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/magic-context/issue-592/capture-0SX552/
```

Artifacts there:

- `trace.jsonl`: raw and returned context/generate drafts;
- `requests.json`: actual provider requests with Magic Context;
- `requests-without-mc.json`: actual generate provider request after restarting the same stored session **without Magic Context loaded**;
- `counterfactual-false.json`, `counterfactual-true.json`: next-main provider bodies from the no-side-question and side-question arms;
- `lsof-with-mc.txt`, `lsof-without-mc.txt`: host open-file evidence.

Without Magic Context, the provider body contains the original dropped output and no compartment. With the hook, the provider body contains the compartment and omits the original output. The returned messages start with the exact main-turn `__magic_context_v2_m0__` and `__magic_context_v2_m1__` messages, followed by the already-served retained history, the unmodified live assistant tail and the question. The returned prefix and system are compared by direct JSON serialization to the prior served main draft. Tool definitions are also compared at the provider boundary: generate uses the main turn's transformed descriptions rather than host defaults.

This is a small functional fixture, not a context-window stress test or a measurement of provider cache hits. The proof concerns prompt bytes and preservation of managed history; provider-specific cache accounting is not simulated as evidence of a hit.

## Implementation and read-only boundary

`V2GenerateReplay` is a **separate code path**, not a flag in the stateful transform. Its `apply` method only reads an in-memory snapshot and replaces request-local arrays/tool definitions. It has no database, scheduler, tagger, activity, token-accounting, notification or last-good-request dependency.

A completed main context callback saves the final draft and its last raw message ID. This snapshot is intentionally separate from `lkg_slots`: the shared last-good-request prefix is captured inside the transform, through its chosen anchor, before the V2 adapter may replace m[0] with the host checkpoint message. It is therefore not necessarily the final V2 array actually handed back to the host. Capturing after that rewrite preserves the exact served system, history and tool descriptions, in both TypeScript and module lanes.

Generate locates the saved anchor in the host preview and appends everything after it verbatim. That is the pristine-tail behavior used by last-good-request/defer replay; the live tail and side question are not assigned persistent tags. Existing compartments, applied drops and placeholders already in the served prefix are copied, not recomputed. Host media class instances are preserved using the adapter's existing cloning helper.

The snapshot is updated **only by a main context callback**, and forgotten on session deletion. Generate never executes queued drops, triggers historian/compartment work, advances nudges, captures last-good requests, updates TTL/activity/ordinal/token state, or persists newly minted tags. With compaction disabled, no prior served prefix, a changed model/agent, or a preview that no longer contains the anchor, the host request is unchanged. After a process restart, a main pass must populate the in-memory prefix before generate can reuse it. This avoids pretending a mismatched or incomplete durable slot is a valid served V2 prefix.

### Overflow recording decision

Keep the `http.response` recorder **primary-only**. A side question adds its own text and may independently exceed the model limit. Recording its overflow as a main-turn overflow would mutate the database/usage map and potentially force compaction on the next main turn, violating the read-only and byte-stability contract. The side-question error remains a host/provider error; it does not become main-session compaction pressure. No recorder behavior was changed.

## Proof and non-vacuity

The new real-host E2E test is named:

**`OpenCode 2 generate serves managed bytes without writes and preserves replay`**

It checks:

1. Actual hook output and actual provider body carry the compartment and do not resurrect dropped output; the same session without the plugin sends unmanaged history.
2. Every table in `context.db` has identical canonically sorted row content before and after each of two generate calls. This covers tags, compartments, meta counters, durable last-good slots and their ancillary state rather than checking just one selected counter.
3. Repeated generate drafts and provider bodies are byte-identical.
4. Two real-host arms restart from identical closed Magic Context and host database files, use the same directories/session, prime the main prefix, then either invoke generate or skip it before the same next main prompt. The **entire next-main provider body** is byte-identical, not just its retained prefix.

The counterfactual mock reply has a fixed provider item ID. Otherwise the mock invents a fresh response ID in each independent arm, introducing unrelated random bytes into the next request. No fields are stripped or normalized in the comparison.

Both final next-main bodies are **41,510 bytes**, SHA-256:

```
1b0c4326e1b34eae920c051eeffbe27d1ad446f1be8b482a8a9e9d6ecbf9b942
```

Unit tests additionally check replay after caller mutation, exact saved system/tool descriptions/placeholders and pristine tail, no-prefix fallback, missing-anchor fallback, model mismatch and deletion. Existing main-turn last-good replay and prefix-trim pure-replay suites remain green.

**NON-VACUITY BREAK control:** after staging the implementation and confirming an empty working diff, temporarily added `DELETE FROM lkg_slots` inside the registered generate callback. The real host successfully sent the side request, then only the named E2E test failed at its before/after database equality assertion (`lkg_slots` became empty). The four server-loader tests still passed. Mutation diff: `context.ts | 2 ++`, one file/two insertions. Restored using `git checkout -- packages/plugin/src/v2/hooks/context.ts` and touched the path; working diff was empty afterward. Rebuilt the restored bundle and the host test passed. The control demonstrates that the database assertion observes actual generate writes.

## Isolation

All host HOME/XDG/config/data/state/cache/runtime/toolchain roots and the project directory are under the throwaway capture root. Host installation and source download are also under `$TMPDIR/magic-context/issue-592/`. No operator database was opened or copied.

`lsof -p <host-pid> -Fn` passed the runner's `assertOpenPaths` fence for both with-plugin and without-plugin hosts. The recorded database descriptors were only:

```
$ROOT/XDG_DATA_HOME/opencode/opencode2.db{,-wal,-shm}
$ROOT/XDG_DATA_HOME/cortexkit/magic-context/context.db{,-wal,-shm}
```

The new test's `spawnSync` calls use `windowsHide: true`; the shared host spawn now does too.

## Verification

- Plugin `bun run typecheck`: passed.
- Plugin `bun run lint`: passed (three informational suggestions in untouched files).
- Comment review: revised two explanations of served-prefix capture; final review flagged no unclear comments.
- Focused generate, payload, V2 system-replay and shared last-good-transform suites: **48 passed**.
- Existing `prefix-trim-pure-replay.test.ts`: **8 passed**.
- Plugin `bun run build:v2`: passed, including **4 server-loader tests**.
- Real 2.0.20 E2E: **1 passed**, 30 assertions in the final capture.
- Mode-manifest validator: **6 passed**; registered the new file as TS-only/OpenCode 2 and updated count pins to 145 files, 47 TS invocations and 28 OpenCode 2 TS invocations. The intended validator path is `packages/e2e-tests/scripts/validate-mode-manifest.test.ts`, not the absent repository-root path from the brief.
- AFT initially produced authoritative zero diagnostics on the changed plugin files. A later mixed-scope inspect was authoritative for the new E2E file (zero errors), but Biome did not publish plugin diagnostics within that inspect budget. Command-line plugin checks above are authoritative.
- E2E package `bunx tsc --noEmit -p tsconfig.json`: baseline failures in existing imports/tests (retina-local-fs resolution, Effect's readonly error flag, older database/client/schema fixtures); **no errors in the new generate test or changed runner/validator files**. These were not widened into unrelated fixes.
- `opencode2/pins.test.ts`: existing entry-pin mismatch. `packages/plugin/src/index.ts` is unchanged, and its raw SHA-256 equals the base revision (`cd926e1d11c264424768abead39c3fbf01356c0eb9ab7484b47a311931df0523`). The pin test's normalized hash is `80343f6c6bfacc3530bd8d1f9db42b7101204e2df89d7bec0776a91bbab6b642`, while its stored expectation is `30ad85288d914f2e152d28deb60f18c22ee0c8012cb5527195f852bcc89abfb1`. No entry file changed, so this task does not remint that pre-existing pin.

Reproduce the exact-host proof after building the V2 bundle:

```sh
MC_E2E_OPENCODE2_CLI="$TMPDIR/magic-context/issue-592/host/node_modules/.bin/opencode" \
  bun test packages/e2e-tests/tests/opencode2/generate.test.ts
```

The test also remains registered for the repository's pinned OpenCode 2 lane. The measured run above used the explicitly supplied 2.0.20 binary.
