# Pi /ctx-status Compartments bucket stuck at 9 tokens (issue 515)

Report: Pi 0.87.1, `@cortexkit/pi-magic-context` 0.42.6. The Compartments bucket
stays at 9 tokens across historian runs. A historian run at 58.1% usage compacts
messages 11-14 only (4 messages, ~200 tokens) while the transform serves 692
messages. The model sees an empty `<session-history>` and the summaries in
`<session-history-since>`.

## Reproduction

All runs used throwaway roots under `$TMPDIR/magic-context/issue-515/` (HOME,
`XDG_*`, `PI_CODING_AGENT_DIR` and `MAGIC_CONTEXT_LOG_PATH` all pointed there).
`lsof` on the running Pi 0.87.1 processes showed only the throwaway
`context.db`. Pi 0.87.1 and 0.86.1 were installed with npm in separate
throwaway roots. The released plugin was the npm `@cortexkit/pi-magic-context@0.42.6`
tarball. The e2e harness selects them with `MC_E2E_PI_PACKAGE_JSON` and
`MC_E2E_PI_PLUGIN_ROOT`.

Scenario: mock Anthropic provider, 100K window, execute threshold 65%. Two short
turns (2 `read` calls each), then one turn of 110 `read` calls of ~1.2K tokens
each. Reported input usage follows the request size.

| Pi | plugin | first historian run | bucket | where the compartment is served |
| --- | --- | --- | --- | --- |
| 0.87.1 | master | proactive at 63.5%, chunk 1-13 (13 msgs, ~134 tokens) | 9 | m[1] `<new-compartments>` |
| 0.87.1 | 0.42.6 | proactive at 63.5%, chunk 1-13 (13 msgs, ~134 tokens) | 9 | m[1] `<new-compartments>` |
| 0.86.1 | master | proactive at 63.5%, chunk 1-13 (13 msgs, ~134 tokens) | 9 | m[1] `<new-compartments>` |
| 0.86.1 | 0.42.6 | proactive at 63.5%, chunk 1-13 (13 msgs, ~134 tokens) | 9 | m[1] `<new-compartments>` |

In every run, m[0]'s cached `<session-history>` stayed at the 35-character empty
wrapper. That is 9 tokens by the status estimator. Ordinal 14 is the long turn's
prompt. After a compartment published, later requests carried it in m[1] as
`<session-history-since><new-compartments>…`. Pi 0.86 and 0.87 behave the same.

## Causes

1. **Compartments bucket (our bug, host-independent).** The shared helper
   `computeM0BlockTokens` measured only m[0]'s `<session-history>`. Pi keeps
   serving newly published compartments from m[1] until a later m[0] fold.
   A fold happens on a hard materialization or when m[1] passes the drift
   caps; while m[0] history is tiny, only the 20%-of-history-budget absolute
   cap applies. So a session whose m[0] was first rendered before any
   compartment existed keeps an empty m[0] history, and the bucket stays at
   the wrapper's 9 tokens. The OpenCode sidebar and the Tauri dashboard
   (`get_context_token_breakdown` in `packages/dashboard/src-tauri/src/db.rs`)
   use the same m[0]-only measurement.
2. **Small chunks (by design).** On routine passes below the force band, the
   protected-tail boundary must not cross the newest meaningful user message
   (the live-prompt floor in `resolveProtectedTailBoundary`). During a long
   autonomous turn, the historian can compact only what comes before that
   prompt. The report's chunk 11-14 fits this reading: it stops right before
   ordinal 15, and the log's note-nudge line shows a live user message. The
   log has no boundary diagnostics, so this is inferred, not confirmed. The token figure in "invoking
   subagent" counts historian prose only: tool outputs are omitted, so a
   4-message chunk reads as ~200 tokens even when its raw mass is large. The
   floor lifts at the force band, and our runs then compacted 20-35 messages
   per run.

## Pi 0.87 context change (not the cause of the report, one regression fixed)

Pi 0.87.0 stopped passing system messages to `context` handlers. After those
handlers run, Pi restores the prompt and tool state itself (`emitContext` in
`dist/core/extensions/runner.js`; changelog: "Handlers no longer see system
messages; Pi restores the prompt and tool state after they run"). Raw ordinals
are unchanged because `getBranch()` still returns system message entries, and
chunks, publishes and served history matched 0.86.1. Two effects on our side:

- **Native marker never clears (fixed).** After `appendCompaction`, the drain
  compares the persisted checkpoint with the system state in the folding input.
  On 0.87 that input has no system messages, so every drain on 0.87.1 logged
  `Pi compaction-marker equivalence refused ... persistedOnlyTools=[bash, ...]
  promptLengthDelta=4011 (folding=0, ...)` and kept the pending marker. In the
  Pi lane, `long-running-session` failed at the marker assertion 2 of 2 times
  on 0.87.1 and passed 2 of 2 times on 0.86.0. `adoptPiCompactionSystemSnapshot`
  now adopts the host checkpoint when the folding input carries no system
  message, and does not insert system messages. The test then passes on 0.87.1,
  and the refusal line is gone.
- **Alignment fallback (not changed).** `buildPiAlignedEntryIds` still counts
  transcript system entries, so on 0.87 the positional alignment never matches
  `event.messages`. Every pass falls back to fingerprint alignment:
  `collectMessageEntryIdsByRef: resolved=221/222` on 0.87.1, and no such line
  on 0.86.1. Behavior matched, but the fallback costs work and logs on every
  pass.

## Fix and coverage

- `adoptPiCompactionSystemSnapshot` adopts a host checkpoint when the folding
  input exposed no system message (see above).

- `computeM0BlockTokens` takes the cached m[1] text and adds its
  `<new-compartments>` block. The Pi status dialog and the OpenCode sidebar
  RPC pass `cached_m1_bytes`.
- The Pi host e2e lane now resolves Pi 0.87.1 (dev alias `pi-coding-agent-087`).
  `tests/pi-compartments-bucket.test.ts` asserts the host version and runs the
  scenario above. It checks the compartment is in m[1] and not in m[0], and
  that the bucket equals m[0] history plus m[1] `<new-compartments>`. With the
  helper's m[1] term removed, it fails with `Expected: 53, Received: 9`.
