# OpenCode subagent memory and note tool boundary

## Mechanism and host source

Both hosts hide `ctx_memory` and `ctx_note` on real task children. Neither
implementation edits a primary agent's tool definitions or global tool registry.

- **OpenCode 1:** the plugin config hook appends these IDs to
  `experimental.primary_tools`, preserving existing entries. The host converts
  that list into **child-session** permission denies when its task tool creates
  a session. This is more precise than denying tools on agents named `general`
  or `explore`: an agent can run as both a primary and a child.
  See [v1.18.30 task.ts:139–172](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/tool/task.ts#L139-L172).
  The feature also exists in
  [v1.18.0 task.ts:129–158](https://github.com/anomalyco/opencode/blob/v1.18.0/packages/opencode/src/tool/task.ts#L129-L158).
  The provider request builder removes permission-disabled tools:
  [v1.18.30 session/llm/request.ts:208–213](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/llm/request.ts#L208-L213).
  The plugin's tool-definition hook itself cannot implement session-local
  hiding: it receives only `toolID` and editable description/parameters, with
  no session identity or removal result:
  [v1.18.30 plugin/index.ts:331–334](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/plugin/src/index.ts#L331-L334).
- **OpenCode 2:** delete only these IDs from the context hook's request-local
  `draft.tools`. The host creates fresh definition objects, gives that map to
  the hook, then builds the provider's tool list from the surviving entries:
  [v2.0.22 session/model-request.ts:238–294](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/model-request.ts#L238-L294).
  The hook dispatch is at
  [lines 411–424](https://github.com/anomalyco/opencode/blob/v2.0.22/packages/core/src/session/model-request.ts#L411-L424).
  This does not call the process-global tool editor on each request.

Both execution adapters also refuse these tool names before executing their
handler or entering a Rust module backend. This protects reduced sessions not
created by `task`, stale calls, and hosts without the primary-tools feature.
The decision is `getOrCreateSessionMeta(...).isSubagent`, exactly the shared
transform's source. That helper seeds a new OpenCode 2 row from the host's
parent link; existing served mode remains unchanged. Agent names do not grant
an exception. Hidden maintenance children retain their existing ownership
exception and explicit allow-lists; the dreamer still receives `ctx_memory`.
No Pi tool registration, hidden-agent permission list, or guidance was changed.
The real child provider requests confirm that subagent guidance mentions
neither tool, while `ctx_search`, `ctx_expand`, and `ctx_reduce` remain present.

## Before and after, real hosts

Tests use the actual host task tool (`task` in OpenCode 1, `subagent` in
OpenCode 2.0.22), a custom ordinary worker, and the mock Anthropic provider.
The worker has wildcard-allow agent permissions, so an accidental agent
allow-list cannot be responsible for the result.

| Host | Before implementation | After implementation |
| --- | --- | --- |
| OpenCode 1.18.30 | Child received both tools and returned `Saved memory [ID: 2] in PROJECT_RULES.` and `Saved session note #2.`; the regression failed. | Child's first request omits both tools. Exactly the primary's one memory and one note exist; no child write. |
| OpenCode 2.0.22 | Child received both tools; the regression failed with `Expected to not contain: "ctx_memory"`. | Child's first request omits both tools. Exactly the primary's one memory and one note exist; no child write. |

The primary actually calls both write tools before creating the task child.
The complete `JSON.stringify(request.tools)` is compared against a snapshot
captured by the **unfixed** host, and against the primary request after the
child finishes. Both comparisons pass; no schemas, descriptions, ordering, or
cache annotations were normalized away.

| Host | Primary tool-list bytes | SHA-256 of unfixed and fixed bytes |
| --- | ---: | --- |
| OpenCode 1.18.30 | 33,491 | `a2ca6825c658874860a9c8133537f8be5292aa9453117e0df265dbdcc6ac39a7` |
| OpenCode 2.0.22 | 24,189 | `03052440ebbdb4a6b68228a86ead7401559b12c7c7886d422a5b695379bf32ae` |

All host runs set `TMPDIR` to a task-owned directory under the original
`$TMPDIR/magic-context/bg_7f185b9b119b4956/`. Each test runs
`lsof -nP -p <host pid> -Fin`, checks the database inode held by that host,
and refuses any database path outside its throwaway root. For example, the
passing OpenCode 1 process 43191 used `opencode-e2e-cSOy4U/`, and the passing
OpenCode 2 process 43247 used `mc-opencode2-31YVac/`, both under that namespace.
No live store or live configuration was opened or migrated. Host fixture
stores are removed at teardown; provider snapshots and build logs are retained
in the task root's `proof/` directory, outside the repository.

## Non-vacuity controls

After staging the live implementation and confirming an empty working diff,
temporarily emptying the primary-only set (marked `NON-VACUITY BREAK`)
reproduced the original exposure on **both real hosts**. Each host test failed
alone at the memory-tool absence assertion. Removing only `ctx_note` from the
set also failed each host test alone, at the note-tool absence assertion.
The reduced-mode unit test went red under both mutations, while
`execution guard preserves definition bytes and explicit internal child access`
remained green. Each mutation produced a non-empty diff of two insertions and
one deletion in `subagent-tool-policy.ts`; restoring from the staged index
and touching the source returned the working diff to empty. No mutant was
committed. Final verification rebuilds the unmutated host bundles.

## Verification

- Bun 1.4.2: plugin suite, **6,741 passed / 4 skipped**, 651 files.
- Bun 1.4.2: Pi suite in a separate process, **1,497 passed / 3 skipped**, 138 files.
- TypeScript 5.9.3: root `bun run typecheck`, all four package checks passed.
- New policy tests and both host scenario files additionally passed strict
  TypeScript checking with the plugin's compiler conventions and path aliases.
  The full e2e package's pre-existing typecheck errors remain outside this change
  (SQLite adapter mismatches, old host API fixture signatures, missing path
  aliases, and a readonly Bun symbol assignment); no unrelated files were fixed.
- Biome 2.5.1: root `bun run lint` passed, 1,562 files checked; existing
  informational diagnostics and warnings remain unchanged.
- Manifest validator: **7 tests passed**, 167 registered test files,
  53 TypeScript-mode entries; OpenCode 1 selects 38 and OpenCode 2 selects 32.
- Plugin production build passed, including **4 OpenCode 2 loader tests**.
- Final real-host run: **5 tests passed / 113 assertions**, including both new
  write-boundary scenarios and the three existing OpenCode 2 reduced-mode tests.

An intermediate implementation moved tool-definition measurement after usage
recording, which broke the existing degraded-pass refusal test. The production
ordering was restored rather than weakening or rewriting that test; the final
full plugin suite is green.
