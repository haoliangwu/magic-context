# Issue 585: unread task results and recovery results reclaimed at emergency pressure

Investigation date: 2026-09-30. Report and reproduction only; **no production fix implemented**.

## Findings

1. **Reproduced on real OpenCode 1.18.30:** an orchestrator subagent dispatches a reviewer through the built-in `task` tool. At 98% pressure, the first provider request after completion contains no review. Emergency tiered reclaim drops the completed, still-unread task result. This happens with both small and large results. At 85%, both survive that first pass in this fixture.
2. **Recovery is not inherently missing for OpenCode tool parts.** `ctx_expand(message=<raw ordinal>)` executes successfully and recovers the stored `state.output` for both `task` and `read`, including a complete 46,433-character review. But at 98%, its *own new output* is reclaimed before the next model request. The agent therefore sees no recovery even though the tool executed correctly. Recovery must be tested on the provider wire, not just the stored expand result.
3. **There is also a coordinate mismatch.** `§N§` is a content tag; `ctx_expand(message=N)` interprets N as a raw-message ordinal. In the reproduction the task is tag 4 but ordinal 3. Calling `message=4` recovers the expand invocation itself, with no result yet. A read at tag 3 / ordinal 2 similarly recovers the task instead. The guidance's promise of recovery by dropped tag is false whenever the spaces diverge.
4. **Not a broken main-session historian:** the full reporter log shows seven successful main-session historian publications. The losing session is a long-running orchestrator *subagent*, deliberately excluded from historian execution. Its nested reviewers are not evidence that the root historian failed.
5. **The doctor run count is misleading on Node.** The OpenCode 1 incremental wrapper does write `historian_runs`. Diagnostics nevertheless return an empty list without querying SQLite whenever `globalThis.Bun` is absent. With seven synthetic rows in an isolated database, the actual exported diagnostics collector returns 7 successes under Bun and `[]` under Node. The reporter ran the CLI under Node 24.21.0; this is a supported mechanism for the false negative, not evidence of seven missing writer calls.
6. **0.44.3 and master have the same task/recovery behavior.** The #581 change protects user-answer metadata, not task reports or recovery outputs. The matrix below reproduces the issue with both source versions.

## Reporter evidence and limits

Sources:

- [Issue 585](https://github.com/cortexkit/magic-context/issues/585), read through the issue tool.
- [Screenshot](https://github.com/user-attachments/assets/35ba4b74-3024-4757-ab45-dad7e2df68d9), downloaded and viewed: the orchestrator calls `ctx_expand message=327`, retries the reviewer, then calls `message=329` and concludes the output was permanently wiped.
- [Full log](https://github.com/user-attachments/files/32856279/magic-context-full.txt), downloaded to the disposable evidence root. SHA-256: `42aa4009b8636778e90fb029f84538b1b987ecf110de0a9590cd7ddb18a8c36a`. It has 43,626 lines plus a trailing newline.

The successful main-session publications belong to `ses_f12b44189ffeeT1z7tK0Fuwxrd`: log lines 305, 1953, 3056, 12104, 13591, 14892 and 26114, covering raw ranges 1–32, 33–48, 49–52, 53–63, 64–68, 69–72 and 73–79. The first explicitly says:

```text
[2026-09-30T08:58:17.604Z] ... historian publish completed: compartments=1 range=1-32
```

The losing session `ses_f0e1bf95dfferQqKEYxSArHrN0` is already logged at line 14376 as `ctxReduce=false, subagent=true, subagentReduceMode=true`. It has **68 successful emergency-drop log entries**. Counting the exact near-full percentages 99.8, 99.9 and 100.0 yields **30 scheduler passes and 60 usage-event lines**, not 90 distinct passes; those are 90 near-full log records. Examples:

```text
line 37301, 12:00:21.723: emergency tiered drop: 1 tags, reclaim≈5840/9101 tokens
line 37366, 12:00:28.535: emergency tiered drop: 2 tags, reclaim≈749/4021 tokens
line 41471, 12:27:01.197: emergency tiered drop: 1 tags, reclaim≈1449/3290 tokens
```

The full log does not contain the task-result payload, a tag-to-ordinal map for 327/329, or the provider wire. It therefore cannot alone establish exactly what those two expand calls rendered. The real-host experiment establishes **two independent explanations** for the observed failed recovery: wrong coordinate and immediate reclaim of the successful recovery output. The reporter's database/wire would distinguish their contribution in this incident. Historian execution being skipped because this is a subagent is consistent with source policy; the literal reason string `historian_no_fire=subagent_session` is not present for the losing session in this downloaded log.

## Real-host experiment

Harness: [`packages/e2e-tests/src/repro/issue-585-task-result.ts`](../../packages/e2e-tests/src/repro/issue-585-task-result.ts).

- Real installed host: `/Users/ufukaltinok/.opencode/bin/opencode`, version **1.18.30** (not a simulated host; not claimed to be 1.18.33).
- Release source: tag `v0.44.3`, commit `ca195df7c6a375c15e62cd1085f9ffed391f4185`, extracted with `git archive` beneath the disposable root and bundled there.
- Master source: task base `7359cc4145288a5aa07dde415e0662e5f61e07c0`, package version 0.44.4.
- Anthropic mock endpoint on loopback only; no cloud credentials. Native compaction/prune off. Historian explicitly disabled for experimental isolation; the tested orchestrator is also a child session (`parentID` set), which independently selects the no-historian subagent policy. `subagent_depth: 3` permits its reviewer child.
- Request 1: orchestrator reads reference data. Request 2: dispatches `task` and reports scripted pressure. Request 3 is the reviewer. **Request 4 is the first orchestrator wire after task completion.** Subsequent requests call expand by task tag, task ordinal, read tag, read ordinal, then finish.
- The initial read includes assistant prose, deliberately separating tag numbering from raw-message ordinals. Task = tag 4 / ordinal 3; read = tag 3 / ordinal 2.
- Pressure is **scripted usage**, not a measured overflow: configured context is 239,000 with 8,192 output reserve, yielding the plugin's 230,808 usable catalog window. Mock input is 196,187 (85%) or 226,192 (98%). The large user reference text ensures the planner requests meaningful reclaim. This tests selection at known pressure; it does not claim to reproduce a two-hour natural climb or Vertex tokenization.
- Small review: 2,434 characters. Large review: 46,433 characters / 1,600 hash lines, about **28K measured reclaim tokens** for the task arc. It fits the host's tool-output truncation limits; both start and end sentinels survive in raw storage and ordinal recovery.

### Matrix: first wire after task completion

| Plugin | Pressure | Review | Task on wire | Older read on wire | Task/read persisted status | Drop lane |
|---|---:|---|---|---|---|---|
| master | 85% | small | yes | yes | active / active | emergency skipped: no candidates |
| master | 85% | large | yes | yes | active / active | emergency skipped: no candidates |
| master | 98% | small | **no** | **no** | dropped / dropped | emergency tiered |
| master | 98% | large | **no** | **no** | dropped / dropped | emergency tiered |
| 0.44.3 | 85% | small | yes | yes | active / active | emergency skipped: no candidates |
| 0.44.3 | 85% | large | yes | yes | active / active | emergency skipped: no candidates |
| 0.44.3 | 98% | small | **no** | **no** | dropped / dropped | emergency tiered |
| 0.44.3 | 98% | large | **no** | **no** | dropped / dropped | emergency tiered |

For master/98%/large, request 4 is 434,540 JSON bytes without either sentinel. The log says `2 tags, reclaim≈34280/78361 tokens (floor≈146891, ceiling=150025)`. Its `toolu_task` tool-result body is `[dropped §4§]`, whereas the raw OpenCode part is `state.status=completed` with the complete report. There is **no storage deletion**.

For master/85%/large, request 4 is 510,319 bytes and includes the report. The protected floor is 16,000 tokens. The newest-three minimum and tier reserve preserve the newest task despite its mass. At 98%, the same window no longer protects candidates.

### Recovery, storage versus wire

| Call | Stored result | Next wire at 85% | Next wire at 98% |
|---|---|---|---|
| `ctx_expand(message=4)` (task tag) | ordinal 4, the in-flight expand invocation; no task review | no recovered review from this call | no recovered review |
| `ctx_expand(message=3)` (task ordinal) | full task input/output: 2,722 chars small, about 46.9K chars large | review visible | **review absent** |
| `ctx_expand(message=3)` (read tag) | task again, not the read | task visible | absent |
| `ctx_expand(message=2)` (read ordinal) | original prose + read input/output, ~26.5K chars | read visible | **read absent** |

Each emergency expand pass logs another one-tag drop. `ctx_expand` is tier 3, so it is immediately reclaimable even sooner than the tier-1 task. Checking only the recovered part in `history.json` would incorrectly call this successful recovery.

An initial oversized, single-line review fixture was host-truncated into a short pointer. Those exploratory runs were **not** counted as the large-result matrix; the final multiline fixture above verifies the complete report. Attempts at an optional root/primary-session control timed out before completing the tool sequence (including one fresh-DB migration/process-probe boot timeout). They provide no selection evidence and are not in the matrix. The full reporter log establishes that the affected orchestrator is itself a subagent; that nested-subagent scenario completes reproducibly. A separate root-session pressure matrix remains unverified.

## Mechanism and source comparison

Relevant production sources (unchanged by this investigation):

- `packages/plugin/src/hooks/magic-context/emergency-drop.ts:188-193, 218-287`: at **>=95%**, bypass the pressure-episode latch, let the protected token window/newest-three minimum yield, and remove the tier-1/2 20% recency reserve. Select **tier 3 → 2 → 1, oldest first within each tier**. This is *not* largest-output-first. A newest task is reached when the older candidates do not satisfy reclaim. In the fixture both old read and newest task are selected. At <95% the window/reserve apply.
- `emergency-drop.ts:44-45`: `task` and `read` are tier 1. `ctx_expand` is not named and defaults to tier 3.
- `heuristic-cleanup.ts:118-163, 167-205`: completed live tool targets passing `canDrop()` become candidates; persist `dropped` status/mode and log emergency selection. The subsequent `heuristic cleanup: dropped ...` line is the **summary of that emergency lane**, not evidence of an additional independent routine drop.
- `tool-drop-target.ts:641-649`: master vetoes user-answer metadata. A completed task or expand result without answer metadata is droppable. Open arcs are excluded, but a just-completed arc is not treated as unread.
- `tool-reclaim.ts:21-48`: the separate age sweep checks protected membership and `canDrop()`. It is not the demonstrated lane. Routine duplicate cleanup keeps the newer duplicate; a reviewer task is not an edit supersession candidate.
- `packages/plugin/src/tools/ctx-expand/tools.ts:34-39, 59-66`: `message` means **ordinal**, without resolving content tags. The message mode runs before live-tail range clamping.
- `packages/plugin/src/tools/ctx-expand/render.ts:83-104, 181-245`: OpenCode tool output is read from `part.state.output` and rendered in full through raw history. Tool outputs are supported; this is not a missing tool-part renderer.
- `packages/plugin/src/hooks/magic-context/read-session-raw.ts:130-183`: raw ordinals count messages; multiple content/tool tags within one message do not each get a raw ordinal.
- `packages/plugin/src/agents/magic-context-prompt.ts:61-65`: dropped-tag guidance directs recovery through `ctx_expand(message=N)`, conflicting with the ordinal API.
- `event-handler.ts:315-333` and `transform.ts` subagent handling: a nonempty session `parentID` means subagent. A nested orchestrator is correctly classified this way, even when it is the "main" agent relative to its own reviewer. No host-version-specific misclassification is needed.

`git diff v0.44.3 HEAD` is empty for `emergency-drop.ts`, `ctx-expand/`, `compartment-runner-incremental.ts`, and `diagnostics-opencode.ts`. The relevant master differences are the user-answer metadata veto added for #581 in `tool-drop-target.ts` and an extra `canDrop()` check in duplicate cleanup. They do not protect a task or expansion result; the live release matrix confirms parity.

## Doctor's false zero

The relevant reader is `packages/cli/src/lib/diagnostics-opencode.ts:741-842`:

```text
contextDbPath = <resolved storage>/context.db
if DB absent: return []
if globalThis.Bun undefined: return []
otherwise import bun:sqlite
SELECT session_id, COUNT(*), success/failed/noop sums, MAX(created_at)
FROM historian_runs GROUP BY session_id ORDER BY last_run_at DESC LIMIT 10
on import/query error: return []
```

The same list value represents no rows, Node runtime, unreadable database, and missing schema. Rendering then reports "No historian runs recorded (or schema predates v24)." Failure counters and recent-session collection have similar Bun-only limitations. The issue diagnostics also show no recent sessions despite the full log's active sessions—consistent with this runtime blind spot.

**OpenCode 1 does write the table:** `compartment-runner-incremental.ts:262-304` defines `recordTelemetry`, setting harness `opencode` when no alternate executor exists; its `finally` at 1373-1389 records every attempt. `storage-historian-runs.ts:73-116` inserts the row. The hidden-completion helper need not write a second row. Recomp/Pi have their own recording paths. Insert failures are swallowed as best-effort telemetry; without the reporter's database one cannot exclude an insert error or different resolved DB, but "v1 never writes this table" is contradicted by both versions' source.

Runtime proof: bundled the **actual exported `collectDiagnostics`** module and invoked it against the same isolated DB under Node and Bun. Seven synthetic successful `historian_runs` rows (reader control, **not claimed to be real historian executions**) produce `{"historianRuns":[]}` under Node and a rollup with `total:7, success:7` under Bun. The exact query/table is therefore not the immediate explanation for a zero on Node; the pre-query runtime guard is.

`historian.opencode.variant: "low"` is valid config (`config/schema/magic-context.ts:203-222, 665-668`; `shared/model-resolution.ts:92-128`). The actual log shows the configured model succeeding. Unknown provider IDs can fail model execution and doctor catalog validation, but they are not the supported explanation here.

## Proposed fix for review — do not implement yet

### 1. Protect every newly completed, not-yet-presented result

Introduce one shared automatic-reclaim veto for **all completed results the model has not received in a provider request yet**, including task, read, ctx_expand and parallel completions. Do not use only the highest tag: one assistant step can contain several fresh results. Metadata-based answer protection remains independent and longer-lived.

A practical bounded first step is to protect completed results belonging to the newest assistant tool step for their first post-completion presentation. Select this set from host part/owner identities, not tag arithmetic or tool names. For stronger "unread" semantics persist delivery/receipt state at successful provider dispatch; a failed/retried dispatch must not consume protection. Review retries, streaming, partial completion and host adapters before choosing the lifetime. Never restore previously dropped content just because a later pass happens to consider it fresh.

**Cache constraint:** the veto must filter *new automatic selection* only on passes already authorized to mutate (force edge/absolute emergency or an independent existing bust). Defer must replay the existing frozen representation byte-for-byte: no restored results, revised placeholders, changed tool arguments, shifted guidance or new system-prefix annotation. Use stable identities for delivery bookkeeping; bookkeeping itself must not emit wire bytes. Keep full active floor accounting separate from candidate filtering, as with the existing veto for tool parts carrying user-answer metadata.

Oldest-first ordering already exists. Merely switching to "prefer older" does not repair this: the current walk exhausts older eligible outputs and still reaches the unread task. Add the veto rather than a largest-output policy or a tier promotion for task alone. Protecting expansion results is necessary even after adding tag recovery.

### 2. Make dropped-tag recovery explicit and unambiguous

Keep `message=<ordinal>` for compatibility and add a separate `tag=<N>` mode (or a dedicated content-handle tool). Resolve through the session's persisted tag → owner/part/call identity and pristine source/raw host part. Tags identify **parts/arcs**, not whole messages; a multi-tool owner must not accidentally recover the wrong sibling result. Do not silently reinterpret the existing integer: tag and ordinal spaces can collide, as the read-tag example demonstrates.

Update the guidance and placeholder hints to use the explicit mode. Tell the caller distinctly when the tag is absent, the host output is truncated, or raw history was actually deleted. A recovery tool should not rerun an effectful task. Preserve file-backed host truncation pointers when full body recovery is not possible. This is an explicit tool action, not a defer-side resurrection of old prefix bytes. Its new result must receive the proposed first-presentation veto for completed results.

### 3. Consider a historian for long-lived subagents, separately gated

The root historian cannot compact a child's local working history. The report's two-hour orchestrator exceeds the assumption that a subagent is short-lived. A size/age policy can grant **selected long-lived subagents** the normal historian before emergency pressure, without treating every short reviewer as a full primary session.

Prefer measured unsummarized-tail size plus sustained pressure/work age, not wall-clock age alone; make opt-in/threshold behavior explicit. Preserve the recent working tail and newly completed results. Prevent recursive historian children from starting historians, enforce per-session concurrency/cooldown, and account for parent/child cost separately. Publishing summaries necessarily changes historical wire bytes, so materialize them only at existing publication/bust opportunities; pending summaries must not mutate defer prefixes. This adds model cost, latency and another failure surface, and should not be used as a substitute for first-presentation protection. **Recommendation: options 1 + 2 first, with option 3 designed as an independent follow-up.**

### 4. Correct diagnostics independently

Use the shared Node-capable SQLite abstraction or a read-only Node SQLite backend for telemetry. Separate `unavailable (runtime/schema/path/error)` from `available with zero rows`. Report session classification and the reason historian is disabled in status/doctor. If inserts fail, expose telemetry-unavailable information without making compaction fail. This is observability work; it must not modify drop selection or cache prefixes.

### Required regression checks before a production change

- Real 1.18.x nested orchestrator at 85%, 95%, 98%, 100%; small/large task, parallel results, read and expand. Assert the **first provider wire**, not stored output alone.
- Emergency selects old eligible data but excludes all first-presentation results; protection releases at the intended delivery boundary. Retain question-answer, open-arc and ctx_reduce-exemplar behavior.
- Deliberately different tag/ordinal coordinates, multi-part owners, missing/pruned/truncated source, and both expansion modes.
- Defer replay byte-identical before/after a queued operation and after cache TTL/pressure transitions. New selection rides only existing bust passes; no repeated tail trickle or re-entry.
- Node and Bun diagnostics against populated, empty, absent and older-schema DBs. Successful v1 historian publication produces one telemetry attempt row.

## Artifacts, isolation and verification

Committed compact evidence: [`evidence/issue-585/observations.json`](evidence/issue-585/observations.json), containing eight successful cases, arrival tag statuses, tool-result wire excerpts, raw-result summaries, per-pass log excerpts, seven reporter publish anchors, full-log hash and database `lsof` lines. Full wires/history/logs and screenshot remain under `$TMPDIR/magic-context/issue-585/`; no large filler or reporter user content is committed.

Every spawned host receives fresh `HOME`, XDG config/data/cache/state, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB=issue-repro.db`, `MAGIC_CONTEXT_STORAGE_DIR`, log path and TMPDIR under that root. Config enables only the local mock provider. `lsof-before.txt` and `lsof-after.txt` are captured; the harness rejects database handles outside its root. The committed samples include OpenCode `issue-repro.db` and Magic Context `context.db`, all beneath the disposable root. No live OpenCode/MC databases or user configuration were opened or edited by the experiment. Child servers are stopped, but disposable roots are retained.

Reproduction (after `bun install --frozen-lockfile` in this worktree):

```sh
bun build packages/plugin/src/index.ts --outfile packages/plugin/dist/index.js \
  --target node --format esm --external @opencode-ai/plugin \
  --external onnxruntime-node --external onnxruntime-web --external sharp \
  --external bun:sqlite --external node:sqlite

bun packages/e2e-tests/src/repro/issue-585-task-result.ts \
  --opencode /absolute/path/to/opencode-1.18.x \
  --plugin "$PWD/packages/plugin/dist/index.js" \
  --out "$TMPDIR/magic-context/issue-585/new-98-large" \
  --pressure 98 --size large --subagent
```

Repeat for 85/98 and small/large using distinct roots. Release comparison uses `git archive v0.44.3` into a disposable source directory, worktree dependency symlinks, and the same entry bundler. The final harness checks arrival visibility, deliberately divergent coordinates, full ordinal task recovery and read recovery; it fails loudly on incomplete sequences or host errors.

Verification: eight successful matrix cases; final asserted 98%/large rerun passed; Node/Bun diagnostics reader control passed; scoped AFT diagnostics reported zero errors/warnings; narrow strict `tsc` of the harness/mock dependency passed. Package-wide E2E `tsc` failed on pre-existing unrelated SQLite typing, Rust harness SDK, OpenCode 2 tests and plugin dependency/type errors; none named the new harness. No runtime production code, manifests, architecture or structure documentation changed.
