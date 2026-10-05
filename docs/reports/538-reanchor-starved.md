# Issue 538 follow-up: a warm-cache session stuck behind an engine's context wall

Investigation of the 2026-09-27 report by Sugaroverdose on issue 538 (master
`881e9738`, OpenCode 1.x). No product code was changed. Line numbers refer to
`881e9738`.

Evidence added with this report:

- `packages/plugin/src/hooks/magic-context/issue-538-reanchor-starved.test.ts`:
  unit reproductions of claims 1 and 3, using the real functions in the order
  transform calls them.
- `packages/e2e-tests/tests/issue-538-engine-wall.test.ts`: a real OpenCode
  1.18.30 host against a mock engine that rejects oversized prompts before any
  model call (tier `excluded` in `mode-manifest.json`, so it runs by hand).

## Summary

- **Claim 1** (the counter only ticks on rebuild passes and never reaches 2):
  **partly true, and not the cause.** The counter is reset by the cache clear
  that every cache-busting pass performs, so back-to-back busting passes never
  reach 2. But defer passes do advance it while the boundary is missing. In any
  case, the reporter's session never entered the branch that counts.
- **Claim 2** (a re-anchor can only apply on a cache-busting pass): **true, by
  design.** That is invariant 2.
- **Claim 3** (the injection path finds the boundary while the trim path says
  it is before the window): **true as an observation, but not a disagreement.**
  Both paths read the same array one after the other. The injection path cuts
  the covered rows out of it first, so when the prefix trim looks for the same
  boundary, the row after it is the first live row. `boundary-precedes-window`
  is the normal verdict on every pass where the injection path already cut.
  The session was never in an out-of-window state.
- **Root cause (reproduced, not yet confirmed for the reporter):** the published
  compartments reach the prompt only on a cache-busting pass, and those passes
  are gated on provider-reported pressure. When the engine's real wall is below
  what Magic Context believes the window is, pressure stays under the execute
  threshold until the wall. From then on every request is rejected with no
  usage, so the pressure reading is frozen at the last served request, and
  every pass defers. If the rejection text is not one of the overflow texts
  Magic Context knows, emergency recovery never arms, and the session stays
  stuck. With a known text, the next pass recovers (reproduced).
- **The proposed patch** would not fix this. In the reporter's state it re-anchors
  to the boundary it already has (their own E4 log shows `X -> X`). It would also
  change bytes on defer passes, breaking invariants 2, 3 and 4, and it can cut
  raw rows that the replayed m[1] does not summarize (silent history loss).
- **Smallest fix:** make an engine's pre-model rejection count as provider-proven
  overflow. That arms the existing recovery flag, which lifts pressure to 95%;
  the force band then opens the single per-pass bust permission, and every lane
  rides it. At minimum, add the reporter's exact rejection text to
  `OVERFLOW_PATTERNS`. See "Smallest correct fix".

## 1. The three claims at source

### Claim 3: the two paths read one array in sequence

Order of one pass:

1. `transform.ts:2044-2052` calls
   `prepareCompartmentInjection(db, sessionId, messages, isCacheBusting, …)`.
   With a persisted m[0], the boundary it looks for is the persisted baseline
   boundary, not the newest compartment's end (`inject-compartments.ts:582-604`).
   `findBoundaryIndex` finds it, and the normal-splice branch
   (`inject-compartments.ts:636-645`) cuts `messages` in place up to and
   including that row. On a warm defer pass, the cached injection is replayed
   and the same cut is made at the cached boundary (`inject-compartments.ts:418-451`).
2. `transform-postprocess-phase.ts:2352-2374` calls `injectM0M1({ messages:
   args.messages, … })` with the same array. Its trim boundary is again the
   persisted baseline boundary (`preparedTrimBoundaryId`,
   `inject-compartments.ts:4042-4056`). Unless a deferred history refresh is
   pending, no source order is captured (`transform.ts:1674-1676`), so
   `trimToPreparedPrefix` does an id lookup (`inject-compartments.ts:3733-3740`)
   on the already-cut array, misses, and calls `classifyAbsentBoundary`.
   `firstPersistedLiveId` (`inject-compartments.ts:3471-3479`) returns the row
   right after the boundary, the boundary sorts before it, and the verdict is
   `boundary-precedes-window` (`inject-compartments.ts:3575-3584`).

So the two paths agree on the boundary and read the same array. The trim path
reads it after the cut. "Nothing to cut" is correct: the cut already happened.
The master log line on such a pass names as its "first live message" the row
that directly follows the boundary, which the reporter can check in their log.

Reproduction: `issue 538 claim 3 … injection finds the baseline boundary and
cuts; the prefix trim then sees it before the window`. After a baseline at
row 4 and a published compartment covering rows 5 to 10, three defer passes each
show `prepareCompartmentInjection` → boundary row 4, 4 rows skipped, then
`injectM0M1` → `boundary-precedes-window`, and rows 5 to 10 still on the wire.
The same `injectM0M1` call on the uncut array reports `applied`. One
cache-busting pass moves the baseline to row 10 and the rows leave the wire.

The real problem in this state is not the verdict. It is that the baseline is
frozen: raw rows covered by later compartments stay on the wire until a busting
pass. That is the designed deferral (invariant 3), and it depends on a busting
pass eventually arriving.

### Claim 1: the degraded-pass count

- The count is ticked only in `prepareCompartmentInjection`'s rebuild path
  (`noteDegradedRebuild`, `inject-compartments.ts:647`), which runs only when the
  boundary is **not** found. The reporter's session found it (claim 3), so this
  count played no part in the stuck state.
- Rebuilds are not limited to busting passes. A degraded rebuild caches a `null`
  boundary (`inject-compartments.ts:635`, `704-717`), and the next defer pass
  sees that and forces a rebuild (`inject-compartments.ts:423-427`), which counts
  again. So defer passes do advance the count while the boundary is missing.
- The count is reset by `clearInjectionCache` (`inject-compartments.ts:115-121`),
  which `trimToPreparedPrefix` calls on every cache-busting pass
  (`inject-compartments.ts:3743-3747`), after that pass's preparation. It is also
  reset by the injection-failure path (`transform-postprocess-phase.ts:2443`),
  the recomp paths, and session cache invalidation (`hook.ts:825-828`, which
  overflow detection triggers). Background historian publications normally keep
  the cache (`compartment-runner-incremental.ts:1135-1141`).
- Net effect: consecutive busting passes with no defer pass between them never
  re-anchor; a busting pass that follows at least one defer pass does. The
  reporter's E2 (`consecutive degraded passes: 1` twice, about a minute apart) is
  consistent with a reset between the two, for example a busting pass.

Reproductions (`issue 538 claim 1 …`): the control shows that two back-to-back
busting preparations re-anchor; with the busting delivery's cache clear between
them, three busting passes never re-anchor; with two defer passes between them,
the next busting pass re-anchors.

### Claim 2: the re-anchor applies only on a busting pass

True: `inject-compartments.ts:657` requires `isCacheBusting`, and the comment at
`inject-compartments.ts:133-138` gives the reason, which is invariant 2. This is
intended, not a defect.

## 2. The designed recovery, and why it never came

### What should happen

A historian publication does not bust (invariant 3). It lands on the next pass
that busts for another reason. For a growing session, that pass comes from
pressure:

- the scheduler returns `execute` once `percentage >= execute threshold`
  (`scheduler.ts:92-94`), or once the idle time since the last response exceeds
  the cache TTL (`scheduler.ts:114-117`);
- the force band is `max(85, threshold + 2)` (`escalation-bands.ts:10-17`);
- a deferred history refresh is consumed only on such a pass
  (`transform.ts:1681-1690`), and the delivery on it soft-refreshes m[1], moving
  the baseline and trimming (`inject-compartments.ts:3946-3952`, then
  `trimToPreparedPrefix`).

The historian itself does not need pressure: the tail-size and commit-cluster
triggers fire at any pressure (`compartment-trigger.ts:700-750`). So a session
can keep publishing while no pass ever busts. That matches the reporter's log.

### Where the pressure comes from, and what a pre-model rejection does to it

- Pressure is provider-reported usage only. `loadContextUsage`
  (`transform-context-state.ts:84-131`) returns the live entry written by
  `message.updated`, or the persisted `last_context_percentage` /
  `last_input_tokens`.
- A request the engine rejects before any model call ends with an assistant
  message carrying zero tokens. `event-handler.ts:606-618` sets
  `hasUsageTokens = false`; with a known earlier reading the handler goes on,
  but every write of usage and of `last_response_time` is gated on
  `hasUsageTokens` (`event-handler.ts:658-660`, `704`). So nothing is updated:
  the stored pressure stays at the last **served** request.
- The transform's wire estimate is used only when usage is unknown
  (`inputTokens <= 0`) **and** the pass is already busting
  (`transform.ts:2523-2540`, `transform-context-state.ts:57`). A stale non-zero
  reading is never replaced by the estimate.
- So yes: from the first rejected request on, pressure is frozen and every pass
  defers, while the prompt grows by each new user message.
- The TTL is the only pressure-independent execute. It fires once per TTL window
  after the last usage-bearing response (an execute pass stamps the idle clock
  again). Such a pass lands already-published compartments, but pressure is
  still stale, so the force-band historian and the emergency drops do not run.
  With no compartment to land, or not enough, the request is still rejected
  (case D below).

### Overflow detection on the rejection

- Both `session.error` (`event-handler.ts:323-444`) and an assistant
  `message.updated` carrying an error (`event-handler.ts:519-604`) run
  `detectOverflow`. On a match, a primary session gets
  `recordOverflowDetected(…, "provider_overflow", …)`: `needs_emergency_recovery`
  is set, and the reported limit, when one can be parsed, is stored as the
  session's context limit.
- The next transform pass lifts pressure to 95% (`transform.ts:1500-1513`), which
  is above the force band: the pass busts, the historian force-fires, and
  emergency drops run.
- Recognised texts are the regexes in `OVERFLOW_PATTERNS`
  (`overflow-detection.ts:29-51`): Anthropic "prompt is too long", Bedrock,
  OpenAI "exceeds the context window", Gemini, xAI, Groq, "maximum context length
  is N tokens" (OpenRouter, DeepSeek, vLLM), vLLM "maximum model length",
  Copilot, llama.cpp "exceeds the available context size", LM Studio "greater
  than the context length", MiniMax, Kimi/Moonshot, a generic
  `context_length_exceeded`, "request entity too large", Ollama, Mistral, z.ai,
  Lemonade; plus a bare 413 with a context-like word (`overflow-detection.ts:265-266`).
  The limit is parsed from a narrower set (`overflow-detection.ts:65-92`).
- A text outside that list is ignored, like a rate limit. A message of the form
  "… exceeds max_context 40000" does not match any pattern (case A).

## 3. Reproduction on OpenCode 1.18.30

`packages/e2e-tests/tests/issue-538-engine-wall.test.ts`, run as
`TMPDIR=$TMPDIR/magic-context/issue-538 bun test tests/issue-538-engine-wall.test.ts`
from `packages/e2e-tests`. The host is the installed `opencode` binary, spawned
directly by the existing runner with every data, config, state and runtime
root, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR` under the throwaway root.
Each case runs `lsof -p <host pid>` at the start and the end and asserts that
every open `.db` path is under that case's data directory. The logged list
showed only `…/T/magic-context/issue-538/opencode-e2e-*/data/opencode/opencode.db`
and `…/data/cortexkit/magic-context/context.db`, each with its `-wal`/`-shm`.

The mock plays the engine: a main-agent request over the wall (request bytes/4)
gets HTTP 400 with an error body and no usage; smaller ones are served and
report their real size. The Magic Context execute threshold is 40%, cache TTL
is 5m unless stated, and turns run back to back (warm cache).

| Case | Configured window | Engine wall | Rejection text | Outcome |
| --- | --- | --- | --- | --- |
| A | 200,000 | 40,000 | `prompt has N tokens, which exceeds max_context 40000` (not recognised) | Pressure rose to 20.7% (39,713 tokens) by turn 8. Turn 9 was the first rejected request; turns 9 to 18 were all rejected. Every pass logged `percentage=20.7% inputTokens=39713 … decision=defer`, with no execute, no `overflow detected`, and `needs_emergency_recovery` = 0. The historian published a compartment at turn 17, which never landed (no busting pass). |
| D | as A, cache TTL 20s | 40,000 | as A | After a 25 s idle past the first rejection, one pass executed (turn 10, m[0] rematerialized). There was no compartment to land, pressure was still 20.7%, and the request was still rejected; the following passes deferred again. |
| B | 200,000 | 40,000 | `request (N tokens) exceeds the available context size (40000 tokens), try increasing it` (llama.cpp, recognised) | Turn 9 was rejected; `overflow detected` was logged and `detected_context_limit` = 40,000. On turn 10 the pass was bumped to 95%, executed, a compartment was published and landed (the baseline moved), and the request was served at 33,586 tokens. It then stayed under the wall with execute passes (27k to 31k tokens). |
| C | 100,000 | 100,000 | not recognised | Usage reported normally. The first execute came on turn 5 (pressure 41.4% from turn 4), the baseline moved as compartments were published, and the largest request was 80,814 tokens (88%) on turn 15, then fell. No request was rejected. |

So:

- **No pass busts** when the configured window is larger than the engine's wall
  and the rejection text is unknown. Nothing short of an idle past the TTL
  produces a busting pass, and that pass does not open the force band.
- **With usage reported normally up to a correctly configured wall** (case C),
  the pressure path works: execute passes land the published history well
  before the wall.
- **With a recognised rejection text** (case B), the existing overflow path
  recovers on the next pass, even with the window mismatch.

A 40K window cannot host case C: the historian runs on the same mock model, and
its own prompt (about 50K tokens) does not fit
(`producer_prompt_exceeds_window`), so C uses 100K. This is a limit of the test
setup, not a finding.

Not reproduced: a stored boundary that really sits before the host's loaded
window (it needs a newer host compaction marker in OpenCode 1). Claim 3 shows
the reporter's session was not in that state. The degraded branch that handles
it is covered by the claim 1 unit tests and the existing
`degraded-reanchor.test.ts` and `prefix-trim-absent-boundary.test.ts`.

## 4. The proposed patch against the invariants

The patch sets a flag whenever the trim path reports `boundary-precedes-window`
and, on the next preparation where the boundary is found, re-anchors to the
newest visible compartment on any pass, defer passes included.

- **It does not address the cause.** `boundary-precedes-window` is the normal
  verdict after the injection cut (claim 3), so the flag is set on nearly every
  pass. In the reporter's state, the re-anchor target is the boundary the pass
  already has, so it re-anchors `X -> X` (their E4). The context wall is not
  moved.
- **Invariant 2 (a defer pass replays byte-identical):** when a newer compartment
  end is visible, the patch moves the splice on a defer pass. That changes the
  tail bytes without a bust permission.
- **Invariant 3 (deferred work rides the next bust and never forces its own)**
  and **invariant 4 (one bust permission shared by every lane):** it creates a
  second, private permission for one lane (the history splice) that no other lane
  consults. That is the split-permission defect the invariant names.
- **History loss:** on a defer pass m[1] replays its cached bytes, which summarize
  history only up to the baseline boundary. The patch's splice at a newer
  compartment end (its `cutoffIndex >= 0` branch, which has no `isCacheBusting`
  check) removes the raw rows between the baseline and that end while the
  replayed m[1] does not summarize them. That is the exact loss the
  baseline-frozen trim (`inject-compartments.ts:578-604`) exists to prevent.
  This finding comes from reading the patch against the code; it was not run.

Would a defer-pass re-anchor be needed if the pressure path worked? No. With
pressure (case C) or a recognised overflow (case B), a busting pass arrives, and
that pass moves the baseline and trims through the existing path, re-anchor or
not.

## 5. Smallest correct fix

The real gap is a session where no pressure reading can arrive: the engine
rejects before any model call, and its text is not in `OVERFLOW_PATTERNS`.
Usage then never moves again.

1. **Recognise the engine's rejection as a provider-proven overflow.** Add the
   reporter's exact rejection text to `OVERFLOW_PATTERNS` (and its limit to
   `LIMIT_EXTRACTION_PATTERNS` if it names one). That is the whole fix for this
   engine. It touches no invariant: it arms `needs_emergency_recovery`, the next
   pass is lifted to 95%, and the force band is the per-pass bust permission
   every lane already shares (invariant 4). Case B shows this path working on a
   real host.
2. **A more general hardening, if unknown texts should also recover:** when an
   assistant turn ends with an error and no usage, mark the stored reading as
   unproven for the next pass, so that `transform.ts:2523` falls through to the
   wire estimate against the usable window, as it already does when usage is
   unknown. This changes only the pressure input. The decision stays in the
   scheduler and force band, so the one bust permission is untouched. It does
   need a guard: a rate-limit or auth error also has no usage, and must not turn
   into a bust unless the wire estimate itself is above the threshold.
3. **Configuration:** a window configured larger than the engine's wall is what
   keeps the pressure path silent. Setting the model's `limit.context` to the
   engine's `max_context` makes the usual execute path fire first (case C). This
   is advice for the reporter, not a code change.

Neither fix touches the re-anchor, and neither lets a defer pass change bytes.

## Still unproven

- **What the engine is and its exact rejection text** (asked for on the issue).
  If the text matches a known pattern, the cause is somewhere else. The first
  thing to check is then whether `overflow detected` appears in the reporter's
  log.
- **What window Magic Context believed** for the reporter's model. The scheduler
  lines (`transform scheduler: percentage=… inputTokens=…`) around the climb
  would show whether pressure was frozen below the threshold, as in case A.
- **Their cache TTL.** With a 5-minute TTL, an idle past it gives an execute pass
  that lands the published compartments (case D). A baseline frozen for hours
  suggests either a long or `never` TTL, or retries that always came within the
  TTL, or execute passes whose landed history was still too big to fit. The log
  can tell these apart.
- **The E2 episode** (`msg_0e12d314…`, count 1 twice) was a real degraded
  episode, with the boundary missing from the injection array, about two hours
  before E4. It had a different boundary from the one in E4. Nothing here
  explains it. The claim 1 tests show how such an episode is counted and reset.
