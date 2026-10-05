# Issue 512: Gemini model-tail follow-up

## Outcome and limits

The two quoted `final-wire` lines are **not provider requests**. They describe
OpenCode message rows before OpenCode's AI SDK conversion. In OpenCode 1.18.30,
a zero-part row is skipped, and a local tool part (including pending/running)
produces a tool result, which Google serializes as a user turn. Neither quoted
shape proves that Gemini received an empty assistant or a trailing model turn.

A real OpenCode 1.18.30 host with the Google AI SDK and a loopback provider:

- completed a parent/task/subagent tool loop, a 305-second idle, and resumed
  parent and child tool work with MC enabled and disabled, without rejection;
- completed the loop with deliberately inserted zero-part assistant rows,
  enabled and disabled, without sending those rows to the provider;
- **did reproduce the model-tail 400 with MC disabled** when the provider ended
  a text stream without a finish reason. MC enabled reproduced the same error.

This identifies a real upstream failure path, **not proof that this was the
reporter's exact failure**. Their log lacks the rejected HTTP payload, finish
reason, tool state and provider-executed metadata. No production fix is justified
by this evidence. This change adds a repeatable probe and negative controls,
not a speculative history rewrite in TS, Pi or Rust.

## Reporter evidence (2026-09-28)

Read issue 512's latest reply and reporter comment. The original 1,152-line
capture was preserved before exploration as `scratch/issue-512-reporter.log`.
Line numbers below refer to that preserved capture.

An important correction to the premise: `ses_f187c3024ffefQLfjsXwcLqyrO` is
reported by MC as **`subagent=false, ctxReduce=true`** at lines 96 and 491.
The actual child sessions in this extract are
`ses_f180490e6ffekqZL0nfUgiHEir` and `ses_f1803e2d8ffeAaA9N9qI95GR0m`
(`subagent=true, subagentReduceMode=true`, e.g. lines 148 and 819). The older
session may be the orchestrator whose tool result reports the child failure;
the log alone does not establish a parent/child ID link.

For the older session:

| Evidence | 12:26:24 | 12:27:26 |
|---|---|---|
| Host rows on entry | 6 | 7 |
| Fold | HARD `ttl_idle` | HARD `system_hash` |
| Dropped tags fetched | 0 | 0 |
| Pending operations | 0 | 0 |
| Heuristic dropped/deduplicated tools | 0 / 0 | 0 / 0 |
| Structural/reasoning parts stripped | 0 / 0 | 0 / 0 |
| Final representation cleared/merged | 0 / 0 | 0 / 0 |
| Final rows | 8 | 9 |

Lines 466–467 further say the synthetic tool-reclaim attempt was
`protected:1`, `mutated=false`. There is no evidence that MC changed the last
tool's status or removed any of its parts. This is not the emergency
last-tool-removal failure fixed in 0.43.0.

The first pass's user-terminated request was accepted: lines 425–428 report
67,489 input tokens on its response. Thus the same historical `assistant:none`
was already present in an accepted pass. The children also repeatedly have
assistant tool-step tails and subsequently report successful usage. An
assistant row containing a tool is normal in OpenCode's hook representation.

## Where zero parts can come from

Relevant MC source paths:

- `hooks/magic-context/strip-content.ts:378–406`: `stripClearedReasoning`
  replaces a part with a sentinel; it does not shorten the array. The caller in
  `transform.ts` gates it on `modelAcceptsEmptyContent`. That gate is canonical
  `anthropic` only (`sentinel.ts:37–39`), not `vertex-eu-google`.
- Structural noise uses the same length-preserving sentinel approach; whole
  message stripping uses `[dropped]` on noncanonical providers. Neither makes
  a Gemini assistant's `parts` array empty.
- `clearOldReasoning` changes text/thinking to `[cleared]`, not to absent parts.
- `tool-drop-target.ts:375–399`: a removal batch filters parts, then removes
  emptied affected messages from the served array. A no-removal batch returns
  immediately, so a pre-existing host empty row remains. The fold-aware scoped
  sweep does not manufacture a row or remove unrelated reasoning turns.
- `strip-content.ts:720–790`: trailing-blank normalization copies arrays before
  splicing, keeps a canonical blank for all-blank messages, and explicitly
  leaves an already zero-part row alone. It does not manufacture empty rows.
- `transform-postprocess-phase.ts:273–283`: synthetic todo removal can empty an
  existing anchor row; the synthetic head row is removed if empty. This is a
  separate possible MC empty-row path, but the reporter's zero mutation counts
  and stable historic empty row do not implicate it. A zero-part row still is
  not forwarded by the OpenCode 1 conversion.
- LKG hydration (`lkg-slot.ts:483–500`) loads a durable snapshot and retains all
  replay validity fences. `lkg_hydrated_from_disk` is not a statement that the
  snapshot was served: this pass subsequently ran a full TTL fold.

OpenCode stores message metadata and parts separately. Its hydration defaults
missing parts to `[]` (`session/message-v2.ts:118–121`). An interrupted or failed
step can therefore have a message row without parts. MC's no-op pass keeps such
a row. **Host-origin is the best-supported explanation for this particular
empty row, but a before-transform snapshot is needed to prove its provenance.**

Pi is not an OpenCode-row serializer: `packages/pi-plugin/src/transcript-pi.ts`
lines 241–266 track empty messages created by tool removals and remove them on
commit (unless native payload items remain). Rust's trailing-blank handling also
preserves a pre-existing empty content vector rather than inventing a blank
(`crates/mc-module/src/transform.rs:23861–23872` pins this behavior). The existing
last-tool-result protections are in TS `tool-drop-target.ts`, shared Pi
`shared/tag-transcript.ts`, and Rust's placeholder/skeleton rendering. No common
MC removal regression was demonstrated, so changing all three would be an
unrelated behavior/cache change rather than a parity fix.

## Actual OpenCode 1 conversion

Source was copied into this worktree using a local shared clone of
`~/Work/OSS/opencode`, checked out at tag `v1.18.30`, commit
`3104c1428e` (no edits to the source checkout). Paths below are relative to that
checkout, under `packages/opencode/src/`.

`session/message-v2.ts:195–196` skips **every** row with `parts.length === 0`,
before testing role. `378–408` also excludes empty converted assistants and
step-start-only messages. Consequently `assistant:none` in MC telemetry does
not become an empty Google `model` message.

For a last row `step-start + reasoning + text + tool + step-finish`:

| Local tool state | Host UI part | AI SDK/provider effect |
|---|---|---|
| `completed` | `output-available` (`292–323`) | assistant call, then tool result; Google user/functionResponse |
| `error` | `output-error`, or output-available for interrupted captured output (`325–347`) | call and error/result; Google user/functionResponse |
| `pending`, `running` | `output-error`, text `[Tool execution was interrupted]` (`349–360`) | call and error result; Google user/functionResponse |

`step-finish` is not a content block. `step-start` is an AI SDK splitting marker,
not a last model utterance. Provider-executed tools are a separate case: host
passes `providerExecuted` through, so local-tool assumptions cannot establish
the result for those tools. The reporter log omits that flag as well as status.

The independently reproduced upstream failure is `session/prompt.ts:1111–1115`:
`finish` missing or `unknown` does not satisfy the loop-exit condition. OpenCode
re-enters generation with the partial assistant history. `1255–1263` runs the
plugin hook then converts it; `1279–1282` sends those messages. If the stream
ended on text without a tool result, Google sees a trailing model turn and
rejects it. MC is not necessary for this failure. The separate max-steps path
at `1281` still appends `MAX_STEPS_PROMPT` as assistant; it was not enabled in
these runs and the reporter already ruled it out.

## The second-pass system hash

The first observed pass is not a new session: it hydrates LKG, resets stale
usage and has a response timestamp approximately two hours old (lines 32–39).
After its TTL fold, the system hook at **12:26:27** logs an existing hash changing
from `3a60a160c17b70b7fba351c239cb59a7` to
`103b255399b11c146df36593944e7cd1` (line 97). The next message pass therefore
executes the explicitly requested `system_hash` fold. This follows OC1's hook
ordering, where message transformation precedes the system hook.

That is expected given an actually changed system prompt. It is not evidence
that subagent pass 2 always folds, nor proof that the change was necessary: the
capture does not include either system prompt, so restart date, guidance,
host instructions, config changes, and real prompt edits cannot be distinguished.
Do not suppress hash changes just because a TTL fold happened previously; the
old materialization may genuinely have used the old system prompt.

The earlier OC2 fix is specifically different. `packages/plugin/src/v2/hooks/context.ts:401–435`
freezes the ctx_reduce verdict from the context draft before system hashing,
because OC2 cannot read OC1's first-user table and otherwise leaves the first
post-restart verdict provisional. In this OC1 capture the system handler **did**
detect the change on the first observed pass, after messages had transformed.
The log does not demonstrate the OC2 provisional-verdict bug in OC1. Current
OC1 baseline initialization also aligns `cachedM0SystemHash` when no prior hash
exists (`system-prompt-hash.ts:534–542`); here a prior hash explicitly existed.

## Real-host probe and isolation

Harness: `packages/e2e-tests/src/repro/prefill-tail-repro.ts`. `--google` uses the
actual host `@ai-sdk/google` serializer against an IPv4 loopback SSE endpoint.
The endpoint records original Google `contents` in `google-requests.jsonl`,
normalizes them only for the common mock script, and rejects empty assistant
content and trailing assistant/model turns. It does not call Google or Vertex.
This tests the wire shape, not Vertex authentication or production networking.

Example (from repository root):

```sh
bun run --cwd packages/plugin build
bun packages/e2e-tests/src/repro/prefill-tail-repro.ts \
  --opencode /path/to/opencode-1.18.x --plugin packages/plugin/dist/index.js \
  --out "$PWD/scratch/google-enabled-full" --window 334464 \
  --sub-steps 3 --text-with-tool --google --idle-ms 305000
```

Repeat with `--plugin none` and a fresh output directory. For the failure control,
omit the idle flag and add `--missing-finish`. For zero-part conversion add
`--empty-step`; that inserts a host-shaped empty row **before MC**, not on the
provider wire. All mock credentials are fake. Every run overrides HOME,
XDG_CONFIG/DATA/CACHE/STATE_HOME, TMPDIR, MC storage and `OPENCODE_DB=issue-repro.db`.
No live stores or user config were used.

| Scratch run | MC | Google child requests | Rejections | Result |
|---|---|---:|---:|---|
| `google-enabled-full` | on | 8 | 0 | idle/resume/tool loops complete |
| `google-disabled` | off | 8 | 0 | same drive completes |
| `google-empty-enabled` | on | 3 | 0 | zero-part rows filtered by host |
| `google-empty-disabled` | off | 3 | 0 | same |
| `google-incomplete-enabled` | on | 4 | 1 | child APIError 400 |
| `google-incomplete-disabled` | off | 4 | 1 | same child APIError 400 |

Enabled TTL evidence: parent `ses_f17c87288ffe7KWxhg893UZCNr` logged
`HARD fold decision: reason=ttl_idle executed=true bustsServedPrefix=true` at
13:37:41.191. The real subagent is reduce-only, so it executes after TTL but does
not materialize an m[0] HARD fold. The reporter's quoted HARD folds likewise
belong to the session MC classifies as non-subagent. The test does not pretend
to manufacture a full-feature fold inside a reduce-only child. Workload usage
was lower than the reporter's (maximum 4.7% in Google enabled); neither is near
an emergency band. No OpenCode 2 run was needed to establish this OC1 conversion
path; the OC2 cache fix was inspected, not experimentally re-certified here.

`lsof -p <serve-pid>` was captured before and after each loop. For example PID
80786 (`google-empty-enabled/lsof-after.txt`) had only these distinct `.db`
paths, with their `-wal`/`-shm` files:

```
<worktree>/scratch/google-empty-enabled/data/opencode/issue-repro.db
<worktree>/scratch/google-empty-enabled/data/cortexkit/magic-context/context.db
```

The corresponding disabled run opens only its throwaway OpenCode database.
Full requests, summaries, logs and lsof captures remain in the worktree scratch;
none of those raw databases or logs are committed.

## Verification

- Plugin build passed.
- Plugin suite: 5,893 passed, 3 skipped, one unrelated baseline failure:
  `retired agent source fence > keeps only the removed-config warning key literal`.
  Standalone reproduction names unchanged dashboard `src-tauri/src/db.rs` and
  `broca_wal.rs`; this change does not touch either file.
- Pi suite: 1,320 passed, 3 skipped, zero failures.
- Repository `bun run typecheck` and `bun run lint`: passed.
- Changed harness and its test: strict package-local `tsc --noEmit` passed;
  two rejection-oracle tests passed.
- Non-vacuity: temporarily returning undefined from `rejectionReason` failed
  only `rejects Gemini-invalid model turns and empty content`; the valid tool
  round test stayed green. Staged live state first; diff was one insertion
  during mutation and empty after restoration. Restored tests passed.
- `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only origin/master HEAD`:
  **RESULT IDENTICAL**, all four defer passes. Baseline
  `1b8de24431ae5f8f829dc217be0384f2950813f2`; byte counts 588, 754, 920,
  1,088, with matching message, system and tool hashes.
- Comment review completed; clarified the new empty-row and TTL comments.
  AFT scoped inspect timed out after 16 phases; strict TypeScript checking above
  is the authoritative changed-file check.

## Next evidence needed from the failing production request

Capture the rejected Google `contents` (redacted), the last assistant's
`finish`, tool `state.status`, `metadata.providerExecuted`, and hook input/output
message IDs and part shapes for the **child that received the APIError**. Capture
old/new system prompt hashes with normalized prompt diffs separately. These are
needed to connect the reproduced upstream missing-finish failure to this report,
or demonstrate a different provider conversion or MC mutation. An unconditional
synthetic user turn or deleting partial model text would hide that distinction
and change host semantics; neither is an appropriate speculative fix.
