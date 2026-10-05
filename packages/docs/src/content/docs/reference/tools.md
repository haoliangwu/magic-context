---
title: Tools
description: What Magic Context tools your agent calls mean in transcripts and how to read their output.
---

Magic Context registers tools for your agent, not for you. You will see `ctx_reduce`, `ctx_search`, and others in transcripts when the model trims context or looks something up. This page explains each tool, when the agent tends to use it, and how to read typical results.

For reduction behavior see [Context reduction](/concepts/context-reduction/). For durable facts vs session notes see [Memory](/concepts/memory/). Tool registration follows the active mode: `compaction.enabled: false` removes only `ctx_reduce`; `ctx_expand`, `ctx_note`, `ctx_search`, and `ctx_memory` keep their normal gates. With `memory.enabled: false`, `ctx_memory` is omitted while `ctx_search` still covers conversation and enabled git-commit sources. Pi's `todowrite` tool, `/todos` command, and overlay are off by default; set `todowrite.enabled: true` to opt in. The overlay defaults to on when the tool is enabled.

## ctx_reduce

**What it does.** Drops tagged conversation content you no longer need. Parts of the transcript carry `§N§` tags (for example `§12§`). The agent lists tag IDs in `drop`; removed content is gone from the model view.

**When the agent reaches for it.** After large tool outputs or old results are processed and no longer needed for the current step.

| Param | Meaning |
| --- | --- |
| `drop` | Tag IDs to drop; ranges like `"3-5"`, `"1,2,9"`. |

```text
Agent: ctx_reduce({ "drop": "4-6" })
Tool: Dropped tags: 4, 5, 6. Changes take effect on next message.
```

:::note
`ctx_reduce` is part of the normal primary-session tool surface. It is not registered when `compaction.enabled` is `false`, and an agent's tool allow-list can deny it in either harness. When it is unavailable, Magic Context also hides `§N§` prefixes and reduce nudges for that session.
:::

## ctx_expand

**What it does.** Recovers original content from stored history. `tag=N` recovers the one text part or tool call identified by a `§N§` tag or `[dropped §N§]` placeholder, including full tool input and output. `message=N` and `start`/`end` use whole-message ordinals from `<session-history>` headings or `ctx_search` hits instead. Tags count text and tool items separately: the same number is not interchangeable between these modes.

**When the agent reaches for it.** When a summary lacks exact wording, errors, values, or reasoning.

| Param | Meaning |
| --- | --- |
| `tag` | One tag number, not a message ordinal. Use alone. Numbers and copied strings such as `"12"`, `"§12§"`, `"§12"`, `"tag 12"`, and `"[dropped §12§]"` are accepted, with surrounding whitespace. |
| `start` | First message ordinal (inclusive), not a tag number. |
| `end` | Last message ordinal (inclusive), not a tag number. |
| `verbose` | With `start`/`end`: list each message separately with its ordinal `[N]` and a per-part preview (each tool call shown with its output size). |
| `message` | Full untruncated recovery of one message by its ordinal — every text part and every tool call's complete input/output. |

Range output is capped near 15K tokens; single-item and single-message recovery are untruncated. Ordinals after the last compartment are the live tail (already visible, not expandable). `ctx_expand` remains available in compaction-off mode.

```text
Agent: ctx_expand({ "start": 120, "end": 245 })
Tool: [120] U: Can we rename the handler?
[121] A: Updating command-handler.ts...
```

**Recovery modes for finer detail.** The default range view returns a condensed digest. To drill in:

- `ctx_expand({ "start": 120, "end": 245, "verbose": true })` — each message listed separately with its ordinal `[N]`, so you can find the exact message or tool call you want.
- `ctx_expand({ "message": 138 })` — the full, untruncated content of the message at that ordinal, including every tool call in a multi-tool message.
- `ctx_expand({ "tag": 138 })` — just the item tagged `§138§`, including a dropped tool output. The original is still in stored history even though the wire shows `[dropped §138§]`. A missing tag reports that no such tag exists and suggests `message=138` if the number came from a history heading or search hit. If the original was deleted (session prune/revert), it says so.

## ctx_note

**What it does.** Session notes are pending intentions: work the agent intends to return to, with findings attached. Findings without an intention are not a note.

**When the agent reaches for it.** “Revisit later” work that is not [project memory](/concepts/memory/) or an active todo. A record of how things stand (world-state, a design at a point in time) with nothing you intend to do about it — that goes stale silently; a fact worth keeping is memory, the rest is nothing. Dismiss a note when its work lands or is abandoned; a queue you never dismiss from stops being read.

| Param | Meaning |
| --- | --- |
| `action` | `write`, `read`, `update`, `dismiss`. |
| `content` | Text for `write` / `update`. |
| `surface_condition` | Creates a **smart note** (hidden until an external condition is true). |
| `note_ids` | Targets: exactly one id for `update`, one to fifty for `dismiss`, or one to fifty specific full bodies for `read`; ignored by `write`. |
| `filter` | For `read`: `all`, `active`, `pending`, `ready`, `dismissed`. Omitted: active session notes plus every current smart note, including pending. `active`: only active-status notes. |
| `limit` / `offset` | Page `read` results (newest first). |

**Smart notes** need Dreamer to be runnable (not `dreamer.disable: true`) and are evaluated only when the `evaluate-smart-notes` task is scheduled. Conditions must be externally checkable (GitHub, files, git, web) — not “when the user says X”.

**`@msg` anchor.** Notes tied to a message show `↳ @msg 512` on `read` so the agent can `ctx_expand` to that point.

```text
Agent: ctx_note({ "action": "write", "content": "Re-run benchmark after release",
  "surface_condition": "When the latest release tag is >= v0.23.0" })
Tool: Smart note #7 saved (pending).
```

## ctx_memory

**What it does.** Durable **project** knowledge across sessions. Active memories appear in `<project-memory>` with ids.

**When the agent reaches for it.** Rules, architecture facts, constraints, config values, naming — one fact per memory.

| Param | Meaning |
| --- | --- |
| `action` | `write`, `update`, `archive`, `merge`, `get`. |
| `content` | Text for `write`, `update`, `merge`. |
| `category` | Category for `write`. |
| `ids` | One id for `update`; one or more for `archive`; two or more for `merge`; 1–20 for `get`. |
| `reason` | Optional archive reason. |

| Action | Primary agent | Dreamer |
| --- | --- | --- |
| `write` | Yes | Yes |
| `update` | Yes | Yes |
| `archive` | Yes | Yes |
| `merge` | Yes | Yes |
| `get` | Yes | Yes |

`get` reads memories by id (own project, any status, plus shared categories of workspace neighbors). Not-visible or missing ids are reported per-id without distinguishing "foreign hidden" from "doesn't exist".

```text
Agent: ctx_memory({ "action": "write", "category": "CONSTRAINTS",
  "content": "Pi sessions are JSONL under ~/.pi/agent/sessions/" })
Tool: Memory #42 written (CONSTRAINTS).
```

Edit memories in the [dashboard](/reference/dashboard/) Mem tab; running sessions pick up changes automatically.

### ctx_memory_list

Dreamer Curate workers get a separate `ctx_memory_list` tool for bulk enumeration. It accepts the same optional `category` and `limit` filters as the former list action. Primary sessions never receive this tool in their provider-visible tool list.

## ctx_search

**What it does.** Search project recall: memories, raw messages behind compacted history, indexed git commits, parked notes, and promoted primers. Skips content already visible in `<project-memory>` and the live tail.

**When the agent reaches for it.** Familiar problems, past decisions, regressions, or “where is X implemented?”. A whole-query id list (`#7234`, `12, 34`) bypasses text search and resolves those memories directly.

| Param | Meaning |
| --- | --- |
| `query` | Search string — or a list of memory ids (`#12`, `12, 34`). |
| `limit` | Max hits (default 10). |
| `sources` | `memory`, `message`, `git_commit`, `note`, `primer` — omit or pass `[]` for all. |

| Question | Typical sources |
| --- | --- |
| When did this change? | `git_commit`, `message` |
| Did we discuss this? | `message` |
| Project rule for X? | `memory` |
| Did we leave a follow-up / parked decision? | `note` |
| Standing explanation for a recurring question? | `primer` |

```text
Agent: ctx_search({ "query": "chunk size", "sources": ["message"] })
Tool: ordinal 884: ... historianChunkTokens 12000 ...
```

Note hits carry a `@msg N` anchor when they are tied to a specific message; the agent can `ctx_expand(start=N-10, end=N)` to read the surrounding conversation. Anchors only render for the current session, so a stale anchor can't point at the wrong conversation.

:::tip
Historian **facts** in `<session-history>` are not a search source — they are already in context.
:::
