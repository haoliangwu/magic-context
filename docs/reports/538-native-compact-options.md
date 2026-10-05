# Issue 538 follow-up: what Magic Context serves after a native OpenCode `/compact`

Scope: OpenCode 1 (1.18.30), TypeScript mode. Facts come from one real-host run of
`packages/e2e-tests/tests/native-compaction-baseline.test.ts` (throwaway root, mock
provider, OpenCode `compaction.tail_turns: 1`) against master `122bd350`. Everything
marked *derived* comes from reading the code, not from the run.

## What happens today

Session `ses_f23d63ecbffe67D1SFeqnYWjY1`, 13 turns, then `/compact`, then two prompts.

| Rows | Ids | State after `/compact` |
| --- | --- | --- |
| turns 1-7 (ordinals 1-14) | … `msg_0dc29d4ee001rhqyW9PhnfpR9d` (turn 7 reply) | in compartments 0 and 1; rendered in m[0] |
| turns 8-12 (10 rows) | `msg_0dc29d534001E2LUHr3qCrffnx` … `msg_0dc29d8a1001XMB32smrbbWw11` | **the gap**: in no compartment, not loaded by OpenCode, not on the wire |
| turn 13 (retained tail) | `msg_0dc29da42001qsZ7hz990SgI6e`, `msg_0dc29da460014rXLSTj5wBEQlJ` | loaded; served raw |
| compaction request | `msg_0dc29dbb5001ripxHh4KqciHlX` (`tail_start_id` = turn 13 user) | loaded; served as the text "What did we do so far?" |
| host summary | `msg_0dc29dbb90017SIyftuT8l67Tj` (`summary: true`) | loaded; **stripped** from the wire |

- Stored boundary: `msg_0dc29d4ee001rhqyW9PhnfpR9d`, before the host window. The prefix trim
  reports `boundary-precedes-window` and cuts nothing, which is correct: nothing it covers is loaded.
- The host summary is stripped by `reconcileMarkerRepresentation`
  (`transform-postprocess-phase.ts`), which removes every `summary: true` row, not only Magic
  Context's own marker, and drops its tag as a stale marker. So there is no duplicated history
  today. The defect is the reverse: turns 8-12 are in no compartment and, with the summary
  stripped, nowhere on the wire. They come back only when the historian compartmentalises them
  (it reads the raw store, which still has them).
- Folds: master already folds on the first pass after `/compact`, with reason `system_hash`.
  OpenCode runs this session's system-prompt hook for the compaction request with the
  compaction agent's prompt, so the stored hash flips there and flips back on the next pass.
  That costs two HARD folds per `/compact`: one while building the compaction request, one on
  the first pass back. The transform also runs on the compaction request's messages as an
  ordinary pass of this session and persists m[0] state from it.
- OpenCode builds the compaction request from `selected.head` passed through
  `experimental.chat.messages.transform`, so the host summary already summarises Magic
  Context's m[0]/m[1] plus turns 8-12.

## The options, pass by pass

| | First pass after `/compact` | While the historian catches up | After a compartment ends inside the retained tail |
| --- | --- | --- | --- |
| **Today / B** (compartments canonical, summary stripped) | m[0] = all compartments; "What did we do so far?"; turn 13; new rows. Turns 8-12 missing. | same; the gap shrinks as the historian publishes compartments (m[1] on a busting pass) | the trim cuts through the new boundary; normal |
| **A** (host summary is the root while it covers every compartment) | m[0] with no compartment history, no boundary; host summary served; turn 13; new rows. No gap, no duplication. | compartments over turns 8-12 are covered by the summary: left out of m[1], no boundary recorded | one fold on a pass that is already busting: m[0] renders every compartment, the trim cuts the compaction pair and the summary |
| **C** (compartments canonical, gap restored from the store) | m[0] = all compartments; turns 8-12 read from the store and served raw; turn 13; new rows. Summary stripped. | the restored range shrinks as the boundary moves (on busting passes only) | normal; nothing left to restore |

## Token and cache cost

- **Today / B**: no extra tokens; two HARD folds per `/compact` (see above). The price is the
  lost turns 8-12, whose size is whatever raw tail Magic Context was serving before the
  compaction: up to the protected tail plus the unprocessed eligible rows, typically tens of
  thousands of tokens on a long session.
- **A** (*derived*): the first pass serves the host summary (one assistant message, the size
  OpenCode's summary template produces) instead of the compartment history, so m[0] shrinks by
  the history budget it used. One extra m[0] re-render later, on a pass that is already busting,
  when the historian reaches the retained tail. No bust of its own. The implementation was built
  and run on the host (branch-local patch, not committed); the part it still lacked was keeping
  the host summary instead of stripping it.
- **C** (*derived*): the gap rows are served raw until the historian covers them: the same tokens
  that were on the wire before `/compact`, so `/compact` saves nothing for those rows. The
  restored range is fixed until the boundary moves, so it replays byte-identically; it changes
  only on busting passes.

## Is C feasible?

Yes. OpenCode 2 already does it: `v2/hooks/context.ts` restores the rows between Magic Context's
baseline and the host checkpoint (`v2 restore: … to the host checkpoint`). On OpenCode 1 the rows
between the stored boundary and `tail_start_id` can be read with the historian's raw reader
(`read-session-raw.ts`, one indexed range read) and inserted after m[0]/m[1], ahead of the
retained tail, with the compaction request row dropped.

Costs and risks:
- Raw store rows must be rebuilt into the host's message shape (parts, tool states) before the
  host converts them for the provider; the raw reader returns part JSON, so the data is there,
  but tagging, drops and the tail hygiene walk then run on rows the host did not load.
- The restored range must be computed identically on every non-busting pass (bounds: stored
  boundary and `tail_start_id`, both durable).
- `/compact` then does not shrink the prompt until the historian catches up, which may surprise a
  user who ran it to free space.

The other half of C, making the historian cover the gap before the next fold, cannot close the
first pass on its own: the historian is asynchronous, and the next pass would have to wait for it.
It could shorten the gap by marking the historian due on `session.compacted`.
