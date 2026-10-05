# Subagent requests ending on an assistant turn ("does not support assistant message prefill")

Date: 2026-09-23. Host: OpenCode 1.18.32 (`opencode-ai@1.18.32`, darwin-arm64), plugin at v0.42.6 and at master `132f6593e5`.

## Symptom

Subagents on Sonnet 4.6 / Sonnet 5 abort with HTTP 400 `This model does not support assistant message
prefill. The conversation must end with a user message.` That means the request sent to Anthropic ended
with an assistant message.

## How it was reproduced

`packages/e2e-tests/src/repro/prefill-tail-repro.ts` boots a real `opencode serve` under a throwaway root
(`HOME`, `XDG_*`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` all under `$TMPDIR/magic-context/issue-512/`;
`lsof` on the serve process shows only the throwaway `issue-repro.db` files). A mock Anthropic endpoint
applies the provider's own rule: any request whose last message is not role `user` gets the 400 above.
A parent session calls the `task` tool, and the subagent then runs a 24-step `bash` tool loop. Reported
input grows with the real request size, so a small window (40k) drives it through execute, the 85% band
and ≥95%.

| run | plugin | subagent shape | subagent requests | prefill 400s |
|---|---|---|---|---|
| control-noplugin / control-nothink-text | none | any | 25 | 0 |
| v0426-* / master-* | yes | reasoning on every step (with or without text) | 25 | 0 |
| v0426-nothink / master-nothink | yes | no reasoning, tool call only | 25 | 0 |
| **v0426-nothink-text** | v0.42.6 | no reasoning, short text + tool call | 14 (aborted) | **1** |
| **master-nothink-text** | master | no reasoning, short text + tool call | 9 (aborted) | **1** |
| fixed-* (4 shapes incl. nothink-text) | fixed branch | all of the above | 25 | 0 |
| control-steps5 | none | agent with `steps: 5` | 5 (aborted) | **1** |

## Cause in Magic Context (fixed)

At ≥95% usage the emergency tiered drop does not keep the recency reserve. For a tool arc whose assistant
has no reasoning (so no skeleton is required), it *removes* the arc: both the tool call and its result.
When the newest assistant step is `text + tool`, removing its tool part leaves `assistant:text` as the
last message. OpenCode sends that as the final turn, and the request fails. Captured MC log on the failing
pass (master):

```
transform scheduler: percentage=100.0% ... decision=execute
emergency tiered drop: tiered drop: 2 tags, reclaim≈8376/8445 tokens (floor≈37423, ceiling=29814)
final-wire telemetry ... tail=[assistant:step-start+text+step-finish, assistant:step-start+text+step-finish, assistant:step-start+text+step-finish]
```

Captured request tail: `user:text`, then `assistant:text+text+…` (consecutive text-only assistants merged).
There is no tool_result after it.

Other candidates, checked:
- `ToolMutationBatch.finalize` sweep: it only removes messages with no content left, so it is not a cause
  by itself. It is the removal step the emergency drop goes through.
- The empty-content sentinel and structural-noise strip: in a subagent tool loop the last turn is tool
  results, not user text, and in every run no pass showed stripped parts turning into an empty tail.
- `preserveUserTerminatedTail` is already in v0.42.6 and wraps every session, including subagents. It only
  reorders when the input ended with a user message, so it does not cover this tool-loop tail.
- Rust module: result blocks are always replaced with a placeholder, never removed. The newest 20 arcs
  resolve to skeletons even at ≥95%, and a new selection test pins this.

The fix is in `tool-drop-target.ts` (OpenCode 1/2 TS lanes) and `shared/tag-transcript.ts` (Pi). `drop()`
now keeps a call skeleton plus placeholder whenever removal would leave the request's last message without
a tool result, and callers persist `drop_mode = truncated` so later passes serve the same bytes. The
transform wrapper also logs a line if a pass ever turns a user-terminated array into an assistant-terminated
one.

## A separate cause in OpenCode (not the plugin)

With the plugin disabled, a subagent whose agent config sets `steps` sends an assistant-terminated request
on its last allowed step. OpenCode appends its `MAX_STEPS_PROMPT` as an **assistant** message
(`packages/opencode/src/session/prompt.ts`: `...(isLastStep ? [{ role: "assistant", content: MAX_STEPS_PROMPT }] : [])`).
Captured request tail (control-steps5):

```
{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_s4_0",...}]}
{"role":"assistant","content":"CRITICAL - MAXIMUM STEPS REACHED\n\nThe maximum number of steps allowed ..."}
```

Models without prefill support reject this outright, so every subagent that reaches its `steps` limit on
Sonnet 4.6+ aborts with the same message. This should go to OpenCode: the max-steps notice needs to be a
user or system message.
