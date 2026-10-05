# Reduction nudges

Nudges tell the agent when its own tail has piled up droppable content, so it calls `ctx_reduce` before automatic reclaim or the force band has to. Both nudge channels read one measurement of the rendered tail, `{U, T}`, and escalate through fixed bands of the ratio `U/T`.

Paths are relative to `packages/plugin/`.

## Where the code is

- `src/hooks/magic-context/tail-hygiene-walk.ts`: the `{U, T}` measurement and its per-pass deltas.
- `src/hooks/magic-context/ctx-reduce-nudge.ts`: band arithmetic and the Channel 1 and Channel 2 decisions.
- `src/hooks/magic-context/hook-handlers.ts` (`maybeInjectChannel1Nudge`): Channel 1 delivery on OpenCode 1.
- `src/hooks/magic-context/channel2-delivery.ts`: Channel 2 lease and delivery on OpenCode 1.
- `src/features/magic-context/storage-tags.ts`: the reclaim hints shown in a nudge.
- `src/v2/hooks/channel2.ts`: Channel 2 on OpenCode 2.
- `packages/pi-plugin/src/tail-hygiene-walk-pi.ts`, `ctx-reduce-nudge-pi.ts`: the Pi mirror.
- `crates/mc-module/src/tail_hygiene.rs`: the Rust module's band classification.

## The instrument: `{U, T}`

The walk runs over the final rendered tail, after every strip and drop on the pass, so it measures what the provider will actually see.

- **`T`** is the eligible content mass of the tail: non-synthetic text, tool inputs and outputs, and file parts.
- **`U`** is the part of `T` the agent could still drop: active, tagged content outside the protected window.

Reasoning, signatures, dropped skeletons and Channel 1's own reminder text are excluded from both. The three newest `ctx_reduce` calls, which reclaim never removes, count in `T` but not in `U`. Queued drops stay in both until a busting pass applies them. Mass is in calibrated provider tokens (see [calibration.md](calibration.md)).

Cache-busting passes refresh the baseline at the last point where postprocess can still change bytes. Defer passes do not re-walk the whole tail; they add typed deltas for appended content and for parts crossing the protection boundary, or hold the baseline when a generation change makes it unreliable. Tool outputs that complete between passes add to `T` immediately (they sit inside the protected window, so they do not add to `U`). The sidebar and `/ctx-status` read the same baseline.

## Bands

| Band | Condition |
|---|---|
| quiet | `T < 60k`, or `U < 25k`, or `U/T < 0.20` |
| gentle | `U/T ≥ 0.20` |
| firm | `U/T ≥ 0.40` |
| urgent | `U/T ≥ 0.60` |
| Channel 2 | urgent, and `U/T ≥ 0.75` and `U ≥ 50k` |

Both channels only exist in sessions where `ctx_reduce` is in the tool allow-list; without it there is no baseline and nothing fires. They run for primary sessions and subagents, and not at all with compaction off.

## Channel 1: tool-output reminders

Channel 1 appends a `<system-reminder>` to the output of a tool call that has just finished (`maybeInjectChannel1Nudge`, from `tool.execute.after`). The host persists tool output as written, so the reminder replays byte-identically on every later pass without any replay machinery of its own. Outputs that already contain a reminder are skipped, and only tools with a plain string output are eligible.

A reminder states how many droppable tool outputs there are and how much they hold, and lists the oldest reclaimable tags as hints. Hints skip coordination and control-plane tools (`ask`, `board`, `work`, `task`, `todoread`, `todowrite`, `bash_status`, `bash_kill` and every `ctx_*` tool) and tags known to be under 250 tokens, and are ordered by tier (miscellaneous tools first, then edit and search, then navigation) and then by age. The agent can still drop any of them explicitly.

Firing rules (`decideChannel1`):

- **Crossing upward** into a higher band fires once with the full copy for that level.
- **Within a band**, a re-fire needs `U` to have grown by `max(25k, 0.08 × T)` since the last nudge, and at least five real user turns since the last Channel 1 emission. Re-fires use a calm one-line copy.
- **Falling** to a lower band is recorded quietly, so a later rise fires the full copy again.
- **Compliance grace.** After the agent calls `ctx_reduce`, Channel 1 stays quiet until the post-drop `U` has grown by the same `max(25k, 0.08 × T)` or the band rises above where it was before the reduce. It also stays quiet on the pass that applies queued agent drops.

The last level and the grace baseline persist in `session_meta` (`last_nudge_level` and related fields), so cadence survives restarts.

## Channel 2: the ceiling nudge

When the Channel 2 band holds, the transform records a `pending` intent in `session_meta` (`channel2_nudge_state`). Delivery happens later, from an event boundary, as a synthetic user message the agent sees at its next step. It is sent at most once per tail cycle and moves through a cross-process lease: `pending → claimed(token) → delivered`. A send failure reverts the claim to `pending`; once a send has succeeded it is never re-armed, even if confirmation fails, because re-arming would duplicate the message. A claim older than ten minutes is cleared so a crashed sender cannot hold the lease forever. The cycle resets only after a HARD fold that advances coverage or a measured collapse of `U`.

Delivery per host:

- **OpenCode 1** (`channel2-delivery.ts`): `client.session.promptAsync` with a `synthetic: true` text part, from `message.updated` events at both mid-turn tool-call boundaries and final stops. On current OpenCode the in-process client joins the live run, so the queued message is picked up at the next step rather than starting a second runner. Subagents are gated to a live run (`assistantAwaitingTools`) so a final stop cannot start a follow-up turn.
- **OpenCode 2** (`v2/hooks/channel2.ts`): `session.synthetic({ delivery: "steer" })` after the context pass; each id is recorded in plugin storage so later passes treat it as an admitted synthetic message, not a real user turn.
- **Pi and OMP** (`ctx-reduce-nudge-pi.ts`): `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })` with `display: false`. A busy run finishes its scheduled tools first and the nudge is injected before the next model call; an idle session starts a turn.

Synthetic nudges are recognised everywhere real user input matters (turn counting, unanswered-prompt checks), so they never count as the user speaking.

## Rust mode

When the Rust module runs the transform, `tail_hygiene.rs` classifies the same bands (quiet, gentle, firm, urgent, Channel 2). Channel 1 reminders are fixed before replay, so a defer pass never lands one on an output that was already served.
