# Adversarial review: proactive strip of invalidated thinking (Fable 5.1 / Opus 5.5)

Delivery reviewed: `alfonso/task/bg_d5b603880c64669e-proactively-strip-invalidated-thinking-on-fable-` at `c1ee2fca` (merge base `7aae18ef`).
Reproduction tests live on `alfonso/keep/proactive-strip-gate-tests`. Tests marked `it.failing` reproduce a defect and turn green once it is fixed.

Verdict: **BLOCK** (two blockers, each with a small fix; the rest are pins).

## Blockers

### B1. Pi: the binding strip move busts the cache on a defer pass right after the upgrade

- **Shape.** A Pi session on this build carries `binding_mismatch:` entries, and a tool arc was dropped beside the frozen thinking. The earlier build stripped that thinking before any stage ran, so it rendered the drop as a full removal: the assistant and its tool result were gone. This build strips at the end of the pass, so the drop renderer sees thinking. It renders the arc as a marker skeleton instead: a `toolCall` with `{"dropped":"[dropped §N§]"}` arguments, plus a placeholder result. The first pass that this build serves for such a session changes the bytes at index 1, whatever kind of pass it is.
- **Reproduced across builds.** The seed ran on an extract of `7aae18ef` against a shared SQLite file. It served `ea3acadc…` on its busting pass and again on its defer pass. The next defer pass on `c1ee2fca` served `8829bb32…`, and the same bytes again after that. A defer pass on `7aae18ef` against the same seed DB served `ea3acadc…`.
- **Reproduced within this build.** `packages/pi-plugin/src/adv-proactive-strip-pi-move.test.ts` produces the same two hashes. It emulates the earlier build by feeding the handler input whose frozen thinking was already removed, which is what the start-of-pass strip handed to every stage.
- **Minimal fix.** Gate the new order per session and switch it on a busting pass. If the session has `binding_mismatch:` entries and no order marker, replay the persisted set at pass start, as the earlier build did, and do not run the proactive strip. On the first pass with the shared bust permission (`isCacheBusting || executedWorkThisPass || bustedThisPass`), add a marker such as `binding_mismatch_order:end` to the same merged-ids set (no schema change), then use the end-of-pass order from then on. A session with no `binding_mismatch:` entries gets the marker implicitly.

### B2. The open tool round is stripped on every busting pass, for every account

- On master, the open round's thinking is removed only after a binding 400, which only new accounts get. The proactive strip removes the newest assistant's thinking on any busting pass that lands mid-tool-loop, on every bound-model session. Older accounts are included: on master their mismatched block is silently dropped and the request succeeds.
- Anthropic enforces a separate rule, independent of binding: with thinking enabled, the final assistant turn must start with a thinking block, counted before the last set of `tool_use`/`tool_result` blocks. MC's own merged-reasoning strip exempts the newest assistant for the related "latest assistant thinking cannot be modified" 400 (`strip-content.ts`, `mutationExemptMessage`). The binding report argues the rule does not apply because the last message is the user `tool_result`. Nobody has checked that live: report §"Not done", "not replayed end-to-end".
- If the rule applies, every mid-loop busting pass on Fable 5.1 or Opus 5.5 fails for accounts that work today. The reactive recovery cannot fix that 400.
- **Minimal fix (either one):**
  1. Live-probe `[…, assistant(tool_use) with its thinking removed, user(tool_result)]` on Fable 5.1 and Opus 5.5 with thinking enabled, on an old account and on a new one.
  2. Until that probe is green, skip the newest assistant in `freezeThinkingInvalidatedByThisPass` and `applyPiProactiveThinkingStrip`: the `reasoningMutationExemptMessage` in TS mode, the last assistant entry in Pi. That leaves it to `drop_block` or the recovery, as on master.

## Pins (not blocking)

- **P1. A stale in-process record over-strips** (attack 1, `it.failing` "keeps thinking produced after another process's strip…").
  - This happens when another process served last, or when a pass served something this process never recorded: a TS LKG replay after a transform throw, the raw fallback, or a transient SQLITE skip. The busting pass then reports the other serve's change as new and strips thinking produced after it, which is still valid.
  - The report's "strips more, never less" is not true in general either. After an unrecorded serve, thinking generated on the raw or LKG bytes is appended beyond the record and never compared. That is an under-strip, and the recovery backstops it.
  - The record is never too new, so it cannot resurrect a strip.
  - Revert and undo only shorten the array or add new user turns, so a stale record from before a revert cannot report an earlier change.
- **P2. The digest sees changes the wire does not** (attack 5, `it.failing` "does not count a wire-invisible sentinel removal…").
  - It hashes the empty-text sentinel, which the Anthropic adapter drops before the wire. With a legacy bare-id merged decision, the defer pass serves `[thinking, text, sentinel]`. The busting pass's trailing-blank normalization removes the sentinel, and the strip then removes the assistant's valid first thinking block.
  - Separately, and pinned green: the strip works per message. A busting pass that merge-strips an assistant's later interleaved thinking (common on Opus with interleaved thinking) also removes that assistant's first block, which is still valid.
  - Changes outside `parts` that the digest cannot see: the system prompt and tool definitions (outside `messages`; whether binding covers them is unprobed), and OpenCode's per-`info.model` handling of reasoning metadata on a model switch.
  - A real OpenCode e2e run showed no drift from non-wire part fields: Fable 5.1, 23 passes covering seeding, restart, HARD, eight tool rounds, drops and four defers. The instrumented scratch build logged divergence only on the busting pass that dropped `priced-tool-0`, and none on defer passes.
- **P3. Persist-then-fail makes an LKG replay change bytes** (attack 3).
  - The proactive set is persisted inside postprocess. If the pass then throws (TS) or fails before install (Rust), the next served array is an LKG replay whose stored prefix was captured before the freeze.
  - `replayRustModeBindingMismatchStrips` now strips that prefix, so the replay differs from what the provider cached. This happens on a pass whose bust never landed, and it removes thinking that is still valid.
  - Master had the same exposure only after a binding 400.
  - Fix: persist the proactive ids after install or serve, or store the frozen-set version in the LKG slot and replay only ids present at capture.
  - Outside that window, the LKG change is sound. Busting passes drop the slot unless they capture, so a normal replay's stored prefix already carries every strip, and its raw tail holds only messages newer than any freeze.
- **P4. TS/Rust subagent parity.** TS mode's proactive-strip gate has no subagent condition (not exercised here). Rust mode returns early for subagents (`fullFeatureMode: !isSubagent`), so neither the recovery nor the proactive strip runs there. Master has the same asymmetry for the recovery.
- **P5. Pi empty assistant.** A thinking-only assistant is left with `content: []`. pi-ai `convertMessages` skips an assistant with no blocks (`if (blocks.length === 0) continue`), so the request stays valid. The adjacent user turns become consecutive.

## Attacks with no defect found

- **`finalizeDetachedCopy` (attack 4).** Every finalization step is per message, except the merged-assistant plan, which reads only earlier assistants of the same run. The new strips therefore change bytes only at or after the first changed index, and the detached copy equals the real array before it. Identity-keyed options are remapped. JSON fallback round-trips to the same digest. The only surprises found are the digest-level ones in P2.
- **Rust mode (attack 7).**
  - The strip is decided and applied last in host postprocess, after the recovery strip and trailing-blank handling, on both the strip pass and its replays.
  - `mirrorRustSyntheticTodoAnchor` is read-only.
  - `replaceMessagesInPlace` preserves the array contents, so the recorded digest matches the served array.
  - A frozen LKG replay records its replayed array. The released pass then compares module output against that record.
- **#18787 shape (attack 8).**
  - TS: the delivery's test and the control "serves the other process's bytes unchanged when the record is current".
  - Pi: the delivery's context-handler test.
  - Rust: the delivery's postprocess test.
  - Each shows the priced pass A prefix sha256 equal to the next defer pass B's.
- **Invariants on other models.** No digest and no strip. The pure replay (`--ts-only`, mock-sonnet) is IDENTICAL for four defer passes. The bound-model priced differential (Fable 5.1, HARD plus drops plus four defers) meets its expectations and is byte-identical to master in both `--neutral` and calibrated mode. The mock never emits thinking, so no strip fires in e2e.

## `--priced` on master: harness bug, not a divergence

`captureRef` hard-coded the left ref to the pre-calibration allowance (`60000`, tool ratio `1`) and the right ref to the calibrated one (`38173`, `1.551639`). `compare` also required the two HARD histories to differ. Master now carries the `anthropic/claude-fable-5-1` calibration seed (prose ratio 1.571778: 60000 / 1.571778 = 38173), so master fails its own check.

Fix on `alfonso/scratch/pure-replay-priced-calibrated` (`03c5d2f5`): expect the calibrated allowance on both slots unless `--neutral`, and require equal HARD wires. With it, `--ts-only --priced origin/master c1ee2fca` reports `PRICED_GATE hard=true tail_m0_equal=true four_defers_each=true`, `RESULT PRICED_EXPECTATIONS_MET`.
