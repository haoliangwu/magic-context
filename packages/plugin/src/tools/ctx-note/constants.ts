export const CTX_NOTE_DESCRIPTION = `Working notes for this session — reminders, follow-ups, and things to revisit later.

Use a note when something matters LATER but not in the next few steps: "revisit the retry logic after the release", "user wants the dashboard polish batched", "flaky test to investigate when touching CI". Don't use notes for active work (use todos) or durable project knowledge (use ctx_memory). Notes resurface at work boundaries and when read.

Actions:
- write: save a note (content). Add surface_condition to make it a smart note (below).
- read: list notes, newest first. Default: latest active session notes + ready smart notes; page older ones with limit/offset, or inspect other states with filter.
- update: change one note (note_ids=[N]). dismiss: retire 1–50 notes (note_ids=[...]).

Smart notes: pass surface_condition and the note stays hidden until a background checker confirms the condition — using ONLY externally verifiable signals (GitHub state via gh, files on disk, git history, web pages). It cannot see this conversation, so the condition must be checkable from outside:
✓ "When PR #42 in cortexkit/magic-context is merged"
✓ "When the latest release tag is >= v0.22.0"
✓ "When packages/plugin/src/foo.ts contains a function named bar"
✗ "When the user mentions X" / "when we revisit Y" / "after we finish this refactor" — no external signal; write a regular note instead.

Example: ctx_note(action="write", content="Re-run the perf benchmark once the boundary rework ships", surface_condition="When the latest release tag is >= v0.23.0")`;
