# Issue 586: Pi placeholder strip strands `function_call_output`

Reported by lyston11 against Pi 0.99.1, plugin 0.44.4 and an `openai-responses` relay. Every request of a long tool-heavy session failed with `400 invalid function_call_output ... no earlier function_call with matching call_id`.

## Credit

The report was careful work, and it located the fault. lyston11 measured 14 orphan `function_call_output` items with Magic Context on and 0 with it off. They traced all 14 owners to `session_meta.stripped_placeholder_ids`, isolated the removal in `stripPiDroppedPlaceholderMessages` by disabling `markToolRemoval`, and tested a one-line guard locally. Their follow-up (comment 2) corrected the first hypothesis with instrumentation:

- The call never "comes back". All 14 owners have `tags.status = 'dropped'` with `drop_mode = 'skeleton_real'`, which keeps the call by contract.
- `requiresToolArcSkeleton` was false on all 251 targets, so `cannotRemove()` was not the path on the passes they instrumented.
- 11 of the 20 persisted ids belong to messages that own a live `toolCall` on the strip's own view. The other 9 are real placeholder-only messages.
- The question left open was what stored those 11 ids while their calls were present. They named two candidates: a legacy skeleton conversion rewriting `drop_mode` after the id was stored, or another strip lane storing it.

## What stored the poisoned ids (real host)

`packages/e2e-tests/tests/issue-586-pi-responses-orphans.test.ts` runs Pi 0.99.1 (the global install, via `MC_E2E_PI_PACKAGE_JSON`) with the plugin loaded. It talks to a mock `openai-responses` relay and a mock `openai-completions` local gateway. Both reject a tool result that has no call, the way the relay in the report does. Every root is under `$TMPDIR/magic-context/issue-586/`, and `lsof` on the Pi process lists only databases under that root. The session runs 4 turns of 12 `read` calls with encrypted reasoning, a `ctx_reduce` of old outputs, a `/ctx-flush` busting pass, a second `/ctx-flush` that triggers placeholder discovery, and defer turns. It then switches to the gateway for two prompts, switches back to the relay, corrupts the native removal lane, and finishes with more defer and busting turns.

Snapshots taken with the pre-fix build (`MC_E2E_PI_PLUGIN_ROOT` set to the dist built from base `59725dc811`):

| checkpoint | strip ids | ids owning a call-keeping tag | dropped tool modes |
|---|---|---|---|
| after placeholder discovery | 43 | **0** | full 43, skeleton_real 2 |
| after the gateway switch | 43 | **43** | skeleton_real 60 |
| back on the relay | 43 | 43 | full 4, skeleton_real 64 |

When the strip stored the ids, every owner's arc was `full` and absent, so each id was correct at that point. The model switch executes a HARD fold (`model_change`). `convertLegacyToolSkeletons` then rewrote every `full` tag whose call "cannot be removed" on that pass to `skeleton_real`, and it persists that permanently. On the gateway, a model that needs tool pairs beside its reasoning, `cannotRemove()` is true for every arc that has reasoning. From then on, every pass replays those arcs as real-argument skeletons. The call is present, the strip still removes its owner by id, and the result is stranded:

- gateway requests: 43 orphans (`messages with role 'tool' must be a response to a preceding message with 'tool_calls'`)
- relay requests after switching back: 43 orphans (`invalid function_call_output at input[...]`). This is the reported error, and it never cleared.

This confirms lyston11's first candidate: the conversion rewrote `drop_mode` after the id was stored. No other lane wrote the ids. On Pi, only `stripPiDroppedPlaceholderMessages` writes `stripped_placeholder_ids`. The four postprocess strip lanes they listed belong to OpenCode.

Limits of what this proves about the reporter's own session:
- Their instrumentation covered relay passes. It cannot show what `cannotRemove()` returned on the pass where the HARD fold converted the tags.
- The ≤1024-byte correlation does not identify the path. The conversion's `full` branch writes `skeleton_real` whatever the input size, and `read`/`web_search` inputs are small anyway. Every demoted tag in the repro was also small.
- Any HARD fold on a pass where a `full` arc cannot be removed produces the same state. A switch to a pair-keeping model is one such pass. Unreadable removal markers are another, because authorization is then false. Their log would show `pi HARD fold converted N legacy dropped-tool skeleton(s)`.
- The two tags with larger inputs fit this path equally well. The conversion does not look at size for `full` rows.

## Fix

Three changes. Each has a mutation proof below.

1. **The strip never removes a message that owns a tool call** (`packages/pi-plugin/src/strip-placeholders-pi.ts`). Discovery already refuses such messages. Replay now refuses them as well, whatever stored the id and whatever the drop mode later became. The check is narrow: it asks only whether the message has a `toolCall` part, not the full placeholder predicate. A message whose reasoning text differs between passes therefore does not reappear, and every pass decides the same way given the same tool replay.
2. **HARD-fold conversion keeps recorded removals** (`convertLegacyToolSkeletons` takes an optional `keepFullDrop`, and Pi passes it from `context-handler.ts`). A `full` tag whose arc has a Pi removal marker was removed on a priced pass. It was never served as a legacy marker, so a pass that only looks unable to remove it no longer demotes it. When the removal lane cannot be read, full drops are kept as they are. OpenCode passes nothing, so its behaviour is unchanged.
3. **A kept pair never overwrites a removal marker** (`applyNativeToolInputReplayPi`). On a pair-keeping pass the dropped call's arguments become a sentinel. Before this change, a busting pass could store those arguments as the call's native input over the marker. Later Responses defer passes could then no longer remove the arc.

With 2 and 3, the tool-drop replay removes a recorded removal again whenever the model allows it. With 1, a pass where the replay has to keep the pair (a pair-keeping model, unreadable markers, a result that ends the request, an in-window skeleton) never strands the result.

### Healing and the first pass after upgrade

A poisoned session stores ids whose messages own live calls, as in the reporter's session and the 43 in the repro.

- **First pass after upgrade, if it is a defer pass:** those messages are kept with their calls and results, and the stored ids are left alone. The request is valid. Its bytes differ from the previous (rejected) request only from the first stranded result onward. A strict endpoint never cached those bytes, because it rejected them.
- **First pass that already busts** (HARD fold, first render, `/ctx-flush`, published history, forced materialization; `canFirstApply = isCacheBustingPass`, plus the history-refresh and cutover signals): the ids of messages that own a call are removed from `stripped_placeholder_ids`. The 9 genuine ids stay and keep replaying. The stored set therefore changes only on a pass whose bytes change anyway.
- Tags already demoted to `skeleton_real` stay that way. They are valid skeletons, and a demoted tag cannot be told apart from an in-window skeleton, so the fix does not promote them back.

Fixed build, same real-host script: 0 rejected requests. The gateway requests carry 85 calls with 85 outputs. After the gateway, `stripped ids = 0` because the gateway's HARD fold forgot the owners, and the dropped tags stay `full` 43. Back on the relay the arcs are removed again (38 calls / 38 outputs, 0 orphans).

Trade-off: after a model round trip, the forgotten ids are not stripped again until the next history refresh rediscovers the (again placeholder-only) messages. In between, those messages are sent as empty reasoning turns, which is valid and small.

## OpenCode and Rust

- **OpenCode TS:** replay neutralizes by id without a tool-part check (`sentinel.ts:183-196`, called from `transform-postprocess-phase.ts:2625-2633`), while discovery rejects messages with `type: "tool"` parts (`strip-content.ts:203-207`). An OpenCode tool part carries both the call and its result, so a whole-message neutralization removes both together. It cannot strand a result. Not exposed to this bug.
- **Rust (`mc-module`):** replay replaces a whole message's content by `mid` (`transform.rs:12779-12790`) using seeds from `module-state-sync.ts:1058-1062`. Native serving accepts only the `OpencodeAiSdk` profile (`lib.rs:10440-10441`). As long as the OpenCode ingress keeps a tool part's call and result in one message, as it does on the TS side, a whole-message replay cannot split them, so this path is not exposed either. That ingress claim was checked by reading, not by a test. The research found no production path that serves Pi through `codec/pi.rs`.

## Tests

- `packages/pi-plugin/src/issue-586-strip-pairing.test.ts` drives the real context handler over an `openai-responses` transcript with encrypted reasoning. It checks for orphans in two ways: over Pi messages, and through Pi's own `convertResponsesMessages` (the relay's `input`). It covers:
  - a relay → gateway → relay round trip: no orphans on any pass, byte identity across consecutive defer passes, drop modes stay `full` after the gateway HARD fold, and the same results survive back on the relay;
  - unreadable removal markers: no orphans, byte-identical defer passes;
  - healing a poisoned session (frozen ids plus `skeleton_real` tags). The wire detector confirms that the poisoned state produces the orphans. Defer passes are valid and byte-identical and leave the ids stored. The busting pass forgets the poisoned ids and later defer passes are byte-identical.
- `strip-placeholders-pi.test.ts`: an owner is kept on a defer pass and its id retained; a busting pass forgets only the poisoned id, and the next defer pass matches it.
- `native-replay-state-pi.test.ts`: a kept pair's sentinel arguments never replace a removal marker.
- Real host: `issue-586-pi-responses-orphans.test.ts`. It is registered in the mode manifest as excluded, because it needs an installed Pi and a throwaway `TMPDIR`. Run it with `TMPDIR=$TMPDIR/magic-context/issue-586 MC_E2E_PI_PACKAGE_JSON=<pi>/package.json bun test tests/issue-586-pi-responses-orphans.test.ts`.

### Mutation proofs

| mutation | red |
|---|---|
| remove the owner guard in the replay loop | unreadable-markers and poisoned-session handler tests; `keeps a frozen message that owns a live tool call` |
| forget owner ids on every pass | poisoned-session handler test; `keeps a frozen message ... keeps its id` |
| `keepFullDrop` always false | round-trip handler test only (drop modes demoted) |
| remove the marker guard in native input replay | `never replaces a recorded arc removal with the arguments of a kept pair` only |
