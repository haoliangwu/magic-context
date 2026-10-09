# Deferred-note nudge cache safety

## Diagnosis

The requested cache-bust analyzer was run before editing:

```sh
cd packages/plugin
bun scripts/analyze-cache-busts.ts --session ses_0d265e156ffeWdDjll9oUjm6eh \
  --since 2026-10-06T21:43:39.301Z --until 2026-10-06T21:43:53.528Z \
  --show-diff --all-rows
```

It found two requests and one metered bust: message[753] changed at character
1577, adding `deferred_notes`; approximately 146,920 tokens were rewritten on
an `unaccounted_defer_pass`. The body grew from 914,590 to 919,227 bytes.

The following diagnosis references the pre-fix source at `b6ee864f`:

* **Anchor identity drift:** `transform.ts:823` captures `currentTurnId` before
  tagging. `transform-message-helpers.ts:26-31` uses the historian's
  meaningful-user predicate. `read-session-formatting.ts:35-48` removes system
  reminders, but does not remove the tag prefix subsequently added to them.
  Consequently, an untagged channel notice is skipped and an older real user
  prompt is selected; the same notice with `§25124§` is then accepted after
  tagging. `transform-postprocess-phase.ts:3271` peeks with the early identity,
  but `:3278` resolves the placement again against the later window.
* **The trigger ID was mistaken for a serve receipt:**
  `note-nudger.ts:119-135` initializes a missing trigger ID on first peek and
  unconditionally defers when the IDs match, even on a HARD rebuild. A different
  ID permits delivery without checking whether that user was already served.
  `transform-postprocess-phase.ts:3276-3287` then persists and appends it, with
  no first-serve/cache-bust fence.

A diagnosis-only SELECT through `sqlite3 -readonly` and a `?mode=ro` URI confirmed
that the old ID was a 51-character user text created at 1790966104838, while the
newest ID was a 1,508-character user text beginning with `<system-reminder>`
created at 1791322984279. Neither had `ignored` or `synthetic` set. No live-store
migration or writes were performed, and the database was not copied.

This is not evidence of a restart-specific message-order bug. The old selection
is explained by filtering the raw channel notice, and first-peek deferral is
general whenever a pending trigger lacks an ID. Persisting/reloading the trigger
does not prove that a later anchor is fresh. Cold/restarted passes therefore need
a conservative serve fence independently of the trigger's stored identity.

Pi uses the same shared nudger, but resolves its latest user once through its
splice-safe SessionEntry map (`context-handler.ts:7618` after the fix). Its old
fresh-delivery path also lacked the serve fence and bust exception. Rust does
**not** own fresh note delivery: the host runs `runRustModePostprocess`, and
`rust-mode-transform.ts:4321-4327` arms the shared trigger after new publication.
`crates/mc-store/src/lib.rs:4764-4767` documents its note anchors as TypeScript
bootstrap decisions; no native change is necessary.

## Fix and replay

* Resolve OpenCode note placement by user role and non-ignored text against the
  final wire window, including real channel notices. Use that same ID for peek
  and append. Sticky replay by ID no longer depends on whether the raw text
  happens to satisfy the historian's prose predicate.
* Observe every user presented to the note-delivery lane, even when no trigger
  is pending. A fresh nudge needs either a previously unseen live-tail user in
  a warm observer or the harness's existing shared cache-bust permission.
* A cold observer seeds its whole window as already seen. On a cold defer it
  cannot prove first serve, so it waits for a new user or a priced rebuild. The
  observer is scoped to a database handle/session and resets on session cleanup;
  it adds no schema or SQLite writes to read-only replay. Simultaneous outgoing
  streams for the same session in separate host processes were not exercised.
* OpenCode TypeScript uses `isCacheBustingPass`, Pi uses its history/work-executed
  ride, and the Rust host uses the module's `cacheBustingPass`. Trigger-ID
  deferral remains only for legacy callers without a wire window. All delivered
  text still comes from the existing persisted sticky anchors on later passes.

## Verification

Tools: Bun **1.4.2**, TypeScript **5.9.3**, Biome **2.5.1**, OpenCode **1.18.30**.

* `bun run test` in `packages/plugin`: 7,124 pass, 5 skip, 0 fail; 7,129 tests
  across 690 files. The final focused SYNAPSE/restart/Rust-host run also passed
  all four tests, including the raw-versus-tagged identity assertions.
* `bun run test` in `packages/pi-plugin`: 1,556 pass, 3 skip, 0 fail; 1,559 tests
  across 147 files. Both package runs used a throwaway HOME and no exported
  `OPENCODE_DB`; their frozen-lockfile installs changed no dependencies.
* Both package `bun run typecheck` and `bun run lint` gates passed. Biome checked
  1,240 plugin files and 236 Pi files; only pre-existing warnings/infos remain.
* `bun run build` in `packages/plugin` passed, including four v2 server tests.
* The new `packages/e2e-tests/src/repro/note-nudge-real-host.ts` passed on the real
  1.18.30 binary. Two scenarios cover HARD system-hash rebuild then defer, and a
  late trigger then an actual host restart followed by the next new user.
  The fixture freezes **raw input**, not MC output. Three consecutive captured
  message arrays in each scenario were identical in full, including provider
  cache-control annotations. On fresh-user delivery, earlier prompt payloads
  also matched; that comparison alone ignores Anthropic SDK breakpoint metadata
  because the native sender moves it when the real assistant/user tail grows.
  All raw request bodies, host logs, `result.json`, and `lsof` inventories were
  retained in the throwaway run root. PIDs 10385 and 11886 held only that root's
  `nudge.db` and `context.db` (and their WAL/SHM files).
* `bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only master HEAD`
  passed against master `4ad229feb8395644d49f68a420f9582b87f4c137` and implementation
  `acbe01edd806b0f5e9f33971e052a8fa96ccd65c`: all four pairs of defer requests
  matched in message bytes/hash, system hash, and tools hash. `lsof` proof for
  both comparison hosts also contained only throwaway databases.

An earlier parallel plugin run hit an unrelated 30-second git-log smoke-test
timeout. Its isolated 10-test file passed immediately; the final full run passed.
No native code changed, so no workspace Rust compilation was run.

## Non-vacuity

All controls used staged live files, captured a non-empty worktree diff while
mutated, then restored from the index with `git checkout -- <paths>` plus `touch`;
the restored diff was empty. No mutant was committed.

* Replacing production note wiring with master made only the selected SYNAPSE
  rebuild regression fail; the response-clock control stayed green. The Pi
  rebuild regression similarly failed while its project-identity control stayed
  green.
* Disabling the shared first-serve fence made the late-trigger regression fail
  in both OpenCode and Pi; the rebuild/replay control in each lane stayed green.
* Removing the cold-observer requirement made the actual database-reopen restart
  regression fail; the SYNAPSE rebuild/replay control stayed green.
