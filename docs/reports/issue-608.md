# Issue 608: an OpenCode 2 fork started with no Magic Context state

Report: forking a fully compacted session on OpenCode 2.0.21 (plugin 0.44.4) gave a new session id with no `context.db` rows. Its first request carried the whole raw history (659k tokens, 293% of a 225k window), and the historian restarted from message 1.

Two defects were fixed. First, nothing refused an over-window first pass. Second, OpenCode 2 forks did not inherit their parent's state.

## 1. The over-window first pass

### Why nothing intervened

- The fail-closed abort at 95% (`evaluateEmergencyFailClosed`) fires only for a provider-proven overflow (`emergencyRecoveryOrigin === "provider_overflow"`). A session that has never been served has no such measurement.
- On a session's first pass in a process, the transform clears the persisted usage, so the compartment phase sees 0% and never force-starts the historian. On an OpenCode 2 fork, `recordUsage` also stores the parent's last assistant usage, because that row was copied into the fork. The first pass resets it.
- On a busting pass, the unknown-usage wire estimate (`resolveUnknownUsageFromWireEstimate`) does feed the emergency drops. It runs after the compartment phase, though, and nothing refuses the request if the drops cannot reclaim enough. Drops only reclaim tool output, while most of a long history is user and assistant text.

Current master (6cf65d5) reproduces this on a real OpenCode 2.0.22 host. A fresh session with 130,398 tokens of raw history against a 60,000-token window was sent as is, and its retry was sent at 120,293.

### Fix (`transform.ts`, `unmanaged-over-window.ts`)

- **When the check runs.** On a session's first pass in the process, when compaction is on and the session has no compartment and no dropped tag, the transform counts the incoming history. It counts only message tokens, with no provider fit ratio. Such a session sends its raw history, so this count is the request.
- **What triggers it.** A count above 1.1× the known context limit (`UNMANAGED_OVER_WINDOW_FACTOR`) puts the pass in the emergency band, through the same synthetic-usage path the overflow-recovery latch uses. The historian is force-started and awaited, and the emergency drops run.
- **The final check.** After the pass, if the request (system prompt, tool definitions and messages) is still over the limit, the transform throws `UnmanagedOverWindowError`. The messages wrapper then replays the last good request or refuses with **MC-H06**: "This request was not sent: this session's history is larger than the model's context window, and Magic Context does not have a summary of it yet to send in its place. Send your message again once history compression has caught up, or switch to a model with a larger context window."
- **Later passes.** The session is checked again on every pass until one is served under the window. A refused session stays in the emergency band even when its incoming history falls under the margin. On OpenCode 1 the host cuts the visible window at the historian's marker, but the system prompt and roughly 30k tokens of tool definitions remain. An earlier draft let such a pass out at 67,701 tokens against the 60,000-token window. The OpenCode 1 host test caught it.
- **What is left alone.**
  - Passes with no known context limit.
  - Sessions with compartments or drops: their incoming array still holds what the pass replaces.
  - Histories within the margin, where the provider's answer decides, as before.

The earlier size guard wrongly refused every first pass, because the system prompt is unmeasured there and the estimate is untrusted. This check avoids that in three ways. It compares the unscaled message count, not the fit-scaled estimate. It applies the margin before acting. It only acts on sessions with no state.

## 2. Fork inheritance on OpenCode 2 (`v2/fork-inheritance.ts`)

OpenCode 2's `projectFork` (`packages/core/src/session/projector.ts` at v2.0.22) works as follows:
- It copies the parent's settled rows up to the boundary. Assistant rows still streaming, and running shell or compaction rows, are not copied.
- Each copy keeps the parent row's `seq`, `type`, `time_created` and body.
- Each copy gets the id `${SessionMessage.ID.fromEvent(forkEvent.id)}_${seq}`. The prefix comes from the fork event, not from the original id.
- It records `fork_session_id` and `fork_boundary` (`{type: "before" | "through", messageID}`).

**How the mapping is derived.** The mapping comes from the stored rows:
- A fork row is paired with the parent row of the same `seq`.
- A pair is accepted only when the fork id ends in `_<seq>` and both rows have the same type and creation time.
- The fork's message positions are recomputed from the fork's own rows. An uncopied row shifts later positions, so a parent position cannot be reused.
- Content ids (`<id>:p<n>`, `<id>:file<n>`, `<id>#<n>`) map through the message id.
- Tool call ids are not re-minted (the bodies are copied unchanged). A tool tag is inherited when its owning message was copied.

**When and how it seeds.** On the first pass for a session with no compartments or tags, in TypeScript mode with compaction on, the OpenCode 2 context hook seeds the fork. It does this before anything on the pass can tag the session. The copy is `copySessionStateForClone`, the copier `/clone` and Pi branch inheritance already use, filtered to the boundary. It copies:
- history blocks whose two ends were copied, with their positions renumbered in the fork;
- session facts, and notes whose anchor was copied;
- tags with their status (compacted, dropped), source contents and queued operations;
- the replay decisions (stripped placeholders, stale-reduce and image strips, the reasoning ledger, trailing-blank decisions).

What it does not copy:
- Usage, pressure and cached-render columns start fresh, so the first pass renders the history head from the inherited blocks.
- Compartment events and chunk embeddings: the copier never copies them. Events are stored and never rendered, and embeddings are rebuilt on demand.

**Idempotency.** The copier takes the write lock (`BEGIN IMMEDIATE`) before checking that the destination has no compartments, tags, notes or facts, and declines if it does. The inherited rows themselves are the marker, so no schema change was needed. A second pass or host gets `has-state` or `destination-not-empty`. A fork already served (and so tagged) is never copied into.

**Fallback.** These forks are left without inherited state, and part 1 handles their first request:
- a parent with no Magic Context state;
- a parent whose session row the host deleted;
- a boundary row the parent no longer has;
- no pairable rows.

## Other hosts

- **OpenCode 1.** 1.x `Session.fork` (v1.18.32 `session/session.ts`) creates an unlinked session with fresh ascending message and part ids. `session.parent_id` is subagent parentage. No stored row links a copy to its source, so seeding would mean guessing from content, and none is done. Part 1 is the whole fix there.
  - Host test: an OpenCode 1.18.30 fork with 120,164 tokens of history against a 60,000-token window (51,808 usable).
  - With the check disabled, its first request went out at **137,598** tokens.
  - With the fix, ten attempts in a row were refused (MC-H06) before any provider request. The estimated request fell from 124,684 to 94,822 as the historian advanced on each attempt, until its per-session drain budget ran out. Nothing over the window reached the provider, and nothing was seeded.
- **Rust mode.** `transform.ts` delegates to `rust-mode-transform.ts` (line ~995) before the per-pass session-state handling (first-pass reset ~1245, model-change reset ~1202). The reporter suggested putting the fork check there. Code at that point never runs in Rust mode, so "seeding there runs before Rust delegation" does not hold. The seed lives in the OpenCode 2 context hook instead. That hook runs before both lanes, has the OpenCode 2 store reader, and runs before the history-boundary check and the store-projection rebase. It is gated to TypeScript mode, because in Rust mode the module serves its own store. The Rust-mode fork gap and over-window first pass are not fixed or verified here.
- **#263 marker hygiene** (`compaction-marker-manager.ts`) is unchanged. It repairs foreign compaction-marker rows in the OpenCode 1 message stream. OpenCode 2 TypeScript mode keeps no marker rows (its marker strategy is inert), so the two compose.

## Evidence (OpenCode 2.0.22, mock provider enforcing a 60,000-token window; `tests/opencode2/fork-inheritance.test.ts`)

| | master (6cf65d5) | fixed |
| --- | --- | --- |
| Fork's first request (parent: 12 compartments, 49 dropped tags, steady state 14,137 tokens) | 130,854 tokens, HTTP 400, retry at 120,791; the fork then had 1 compartment | 14,211 tokens; 12 compartments and 49 dropped tags inherited; one request |
| History head of the fork's first request | `<session-history></session-history>`, then raw turns | `<session-history>` with the parent's 12 block titles (`## 1-4 · History 1-4` … `## 47-48 · History 47-48`), in the parent's order |
| Fresh session (written without Magic Context) with 127,998 tokens of history | sent at 130,398 tokens, retry at 120,293 | not sent (MC-H06); the historian advances on each attempt; served at 59,614 tokens on the sixth attempt; nothing over the window ever sent |
| Small first pass of a new session | 42,966-byte request | byte-identical after replacing the session id and the throwaway root path |

`lsof -p <host pid>` during the fork test listed only `context.db` and `opencode2.db` (plus `-wal`/`-shm`) under the throwaway root.
