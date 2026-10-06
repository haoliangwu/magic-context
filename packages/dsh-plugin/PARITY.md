# DSH ↔ OpenCode parity

This document records the effective-behavior contract between the OpenCode
adapters (`packages/plugin/src/plugin/`, `src/hooks/magic-context/`,
`packages/plugin/src/v2/`) and the DSH adapter (`packages/dsh-plugin/`).
Differences listed as **host-imposed** cite the DSH surface that prevents the
OpenCode mechanism from being reused; differences listed as **chosen** are
adapter decisions that can be revisited.

The comparison target for the DSH side is `@deepseek-ai/dsh` 0.2.0-rc.2
(cordis 4.0.4) with `@deepseek-ai/dsh-agent-presets` 0.1.5-rc.2.

---

## Identical effective behavior

- **One core.** Both adapters are thin carriers over `@magic-context/core`; the
  executors are shared, not forked:
  - Commands. `/ctx-status` calls `executeStatus`, `/ctx-flush` calls
    `executeFlush`, `/ctx-embed` calls `formatEmbedStatusText` plus the
    project-embedding registry, `/ctx-dream` calls `runManualDream`
    (core `task-scheduler`), and `/ctx-recomp` / `/ctx-wrapup` drive the core
    recomp/wrapup orchestrators. OpenCode reaches these over its loopback RPC
    (`rpc-handlers.ts` handlers `status-detail`, `flush`, `embed`, `dream`,
    `recomp`, `wrapup` — `src/v2/hooks/commands.ts` dispatches into that
    server); DSH imports the same functions directly in
    `src/agent/commands.ts`. Different carriers, same executors: the two
    adapters cannot drift into doing different work for the same command
    name short of editing core.
  - Tools. `ctx_search`, `ctx_memory`, `ctx_memory_list`, `ctx_note`,
    `ctx_expand`, and `ctx_reduce` share the core tool constants, argument
    schemas, render modules, verification recording, and storage. The primary
    `ctx_memory` surface exposes the same action set as OpenCode's
    (`write`/`update`/`archive`/`merge`/`get`), with `list` unadvertised and
    owned by `ctx_memory_list` exactly as in
    `packages/plugin/src/tools/ctx-memory/tools.ts`.
  - Context pipeline. Tagging, budget derivation, the note nudger, and
    session-chunk reads come from core (`tagger`, `derive-budgets`,
    `note-nudger`, `read-session-chunk`). The turn-level orchestration is
    DSH-side (`coordinator`/`outbox`/`worker`) because the host carrier differs
    (below); the per-message primitives are not duplicated.
  - Maintenance. `runDshPeriodicMaintenance` mirrors core's
    `runProjectMaintenance` lanes per tick: embedding registration and
    identity maintenance, git-commit indexing (`indexCommitsForProject` +
    sweep-coordinator leases), proactive memory embedding
    (`embedUnembeddedMemoriesForProject` when the snapshot is enabled),
    compiled smart-note checks, and due-task scheduling
    (`runDueTasksForProject` → the same lease/gate/telemetry pass the OpenCode
    singleton runs). A vanished workspace directory is skipped and dropped
    from the presence map, mirroring the OpenCode sweep's dead-directory guard.
- **One store.** Both harnesses write the same
  `<data>/cortexkit/magic-context/context.db`. Session-scoped rows carry
  `harness='dsh'`; project memories and embeddings stay shared across
  harnesses. The DSH adapter must not add tables (schema v94,
  `LATEST_SUPPORTED_VERSION`).
- **Configuration semantics.** The same `magic-context.jsonc` tiers
  (`~/.config/cortexkit/` user layer, project `.cortexkit/` layer), the same
  schema, security stripping (e.g. `{env:VAR}` substitution with an
  untrusted-config fallback), and the same warnings.

## Host-imposed mechanism differences

| Difference | Imposed or chosen | Host surface and evidence |
| --- | --- | --- |
| Hook carrier | Host-imposed | OpenCode projects drafts through `experimental.chat.messages.transform` (1.x) or the `Context.session` hook domain (2.x); DSH exposes prestep/session-event seams instead. `src/agent/context-plane.ts` adapts those into the core primitives listed above. |
| Command carrier | Host-imposed | OpenCode registers `/ctx-*` with the host `CommandDomain` so every client reaches them over HTTP (`src/v2/hooks/commands.ts`); the result TEXT only reaches a connected terminal UI. DSH registers session slash commands through the agent plane (`registerCommand`), and the result renders in the session transcript for every client. Same executors; the delivery surface differs in the host's favor here (no terminal-UI-only limitation on DSH). |
| Tool surface carrier | Host-imposed | OpenCode exposes tool definitions on the provider wire and can drop one per request (`src/v2/hooks/context.ts` deletes `ctx_memory_list` from `draft.tools`). DSH has no per-request tool filter; the registration itself differs per agent (dreamer sessions get the full action enum, primary sessions get the primary enum). |
| Timer ownership | Host-imposed | The design would reuse core's process-wide `startDreamScheduleTimer` singleton, but that singleton opens the default shared-DB path (wrong for a boot-time-overridden path), drags in OpenCode-only orphan sweeps, and its module state is not fiber-owned. DSH self-builds ctx-owned intervals driving the same scheduler pass, plus the mirrored maintenance lanes above; the boot-quiet window (120 s), per-project startup jitter (1 s slot + djb2 hash), and 15-minute tick (`DEFAULT_DREAM_TICK_MS`) mirror core's constants. A `tickInFlight` set prevents overlapping ticks per project. |

## Chosen deviations

| Difference | Imposed or chosen | Notes |
| --- | --- | --- |
| `ctx_memory_list` visible to the primary agent | Chosen | OpenCode keeps the tool off the primary surface entirely (v2 deletes it from `draft.tools`; v1 registers it dreamer-only). DSH registers it but refuses at execute time ("only available to the dreamer agent"), and the primary `ctx_memory` enum omits `list` at the schema level. Effective behavior matches; the advertisement differs because DSH has no permission layer to deny through. |
| No per-agent step cap in dream tool workers | Chosen | The abort signal is the authority; see the deviations header in `src/agent/dream-worker.ts`. |
| Sidebar depth rows trimmed | Chosen | The DSH Context tab shows Compartments / Memories / Cache TTL / Dreamer counts but not the per-task `dreamerBacklog`/`Failures`/`Skipped` breakdown the OpenCode sidebar renders (`src/host/remote.ts`). |
| Label-prefix gating | Chosen | Dreamer-only surfaces gate on the agent label prefix rather than an exact session-identity match. |
| In-process presence map | Chosen | The identity→directory map is per-cordis-ctx and starts empty; identities with no observation since process start are skipped fail-open on the maintenance tick. Schedules are identity-keyed and re-seed on the next observation. |
| OpenCode-session orphan sweep stays out | Host-imposed | The core singleton's orphan sweep cleans `opencode.db` session rows; DSH has no such store. |

## Open item

`createTodowriteTool` registers a Magic-owned `todowrite` (Pi parity,
`todowriteEnabled` opt-out), but the DSH standard preset already ships a
native `todo_write` (`@deepseek-ai/dsh-tool-todo`). Both can be registered in
the same session; the interaction (which one the model calls, whether
todo-triggered nudges see native todo state) has not been reviewed. Not
exercised in the E2E pass below.

## Evidence

- **Contract mirror.** The DSH test suite (254 tests / 35 files, `bun test`
  from `packages/dsh-plugin`, commit `0df643848`) mirrors the OpenCode tests
  lane for lane: `src/agent/commands.test.ts` (six `/ctx-*` commands),
  `src/agent/tools.test.ts` (primary vs dreamer action enums, schema-level
  `list` rejection), `src/agent/dreamer.test.ts` (timer: boot quiet, jitter,
  tick-in-flight), `src/agent/embedding-bootstrap.test.ts` (git sweep,
  proactive memory-embed lane, dead-directory guard).
- **Live host.** 2026-10-06, the `mc` profile (`dsh --profile mc`, DSH
  0.2.0-rc.2, workspace `link:`ed to this package): `/ctx-status` rendered
  the full report (tags, pending queue, 5-minute cache TTL, 65% execute
  threshold, per-task dreamer backlog), `/ctx-flush` reported no pending
  operations, and `/ctx-embed` reported `Qwen3-Embedding-8B` with git commits
  at 1088/2000 embedded and the drain active. The boot-quiet-gated initial
  pass indexed 2000 commits (`git_commit_indexing.max_commits`), registered
  the embedding provider, and seeded the `retrospective` and
  `review-user-memories` schedules. The status popover reported
  `storage ok · schema v94/94`, `config present`, `preset native 3/3 stock`.
- **Not exercised live:** `/ctx-dream` (runs LLM tasks and writes real
  memories), `/ctx-recomp` and `/ctx-wrapup` (need folded history and a
  session end respectively), and the fold/historian path (the test session
  stayed at ~5% context, below the 65% execute threshold). These lanes are
  covered by the contract-mirror tests above, not by a live run.
