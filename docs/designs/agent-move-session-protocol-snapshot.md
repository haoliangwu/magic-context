# Agent move: session protocol (snapshot of engram's AGENT_SYNC.md)

Copied from engram `AGENT_SYNC.md` at ee1d519, lines 176-303, as pinned evidence for Magic Context's step-4 spec. engram's file is the authority; refresh this copy when it changes.

## Moving one session's transcript and Magic Context state

The rest of this document is the transaction that moves one session's agent-owned transcript and Magic Context state. It is one part of a whole-agent move: prefrontal's export, the workspace bundle and the checkout claim go through the same cut.

## What a session is, for this purpose

Two producers, both required, and nothing else:

1. **The host transcript.** The host is whatever runs the conversation: Broca (its session write-ahead log), OpenCode (rows in `opencode.db`) or Pi (a JSONL file). The transcript is the authority; MC's state is meaningless without it. Broca ships its WAL and nothing else: nothing from `run-index.db` or any other projection.
2. **Magic Context's per-session state.** In `context.db`: every table in `SESSION_SCOPED_TABLES` (magic-context `packages/plugin/src/features/magic-context/storage-session-tables.ts`). It includes tags and drop status, queued drops, compartments with their events, facts, embeddings and history versions, compression depth, recomp facts, `session_meta`, `session_replay_decisions`, the sliced last-known-good request (`lkg_slot_chunks`), session notes, the session-to-project binding, and the message history and full-text rows. In Rust mode, also in `store.db`: `mc_cache_state` and its split sections, frozen-unit chunks, pass-trace state and history, tags, the reduce-command ledger, and tag-cache generations (`crates/mc-store`). All of it references the host's message ids. `context.db` and `store.db` are **one consistency unit**: they share MC's authority generation and must be captured, shipped and restored together or not at all.

Not part of a session, and never carried with it:
- Broca's projections (`run-index.db`, `export_facts`), archive containers (`wal-archive/*.ark`), leases, warm clock, tool routes, scope registrations. Rebuilt or re-registered on the new machine.
- MC's shared state. Memories, smart notes, user memories and primers travel through the memory operation streams (see Memories); the rebuildable parts (git commit index, embeddings) are rebuilt on each machine. A session on a machine with a different memory set still works: the carried head replays until the next natural rebuild.
- Anything machine-local: `dir:` project identities (path hashes; `git:` identities are portable), absolute paths, embeddings that must be rebuilt because the receiving machine uses another embedding model (the session's own compartment chunk embeddings travel when the model matches), credentials of any kind (OpenCode's `credential` table must never be copied).

## Session identity

`sessionRef` is a 16-byte id minted by the host when the session's transcript is created, stable across machines, never derived from a path.
- Broca: the WAL's `lineage_id` (16 random bytes in the first frame, `broca-wal/src/file_wal.rs:421-427`).
- OpenCode: the session id itself (`ses_` plus a time field and 14 random base62 characters, minted at create, kept by import). It is not 16 raw bytes, so `sessionRef` is a 16-byte digest of the full id string; never strip the prefix, never re-mint on the receiver. Message (`msg_`) and part (`prt_`) ids survive import too, so MC's references stay valid. Never order by id (the time field wraps); order by `time_created`, then id.
- Pi: the header's `id` (a UUIDv7 minted at create, or a caller-supplied string), kept by a file copy. As for OpenCode, `sessionRef` is a 16-byte digest of the full id string, never a parse of it. Pi entry ids are unique only within one session, so MC's references are `(sessionId, entryId)`. A clone or fork gets a new session id.

## The transport engram already provides

The session plane carries opaque records; engram never interprets a producer's bytes. What is shipped (see `SESSION_WRITER_CONTRACT.md`):
- `session.admit {sessionRef, stream, walBytes, fromOffset}` appends one record to a labelled stream and returns `durableOffset` (the stream's locally durable end), refusing `offset_mismatch` on a gap. Streams in use: `host` (the host transcript's bytes) and `mc` (Magic Context's snapshot); this design adds `cut` (one record per move naming where each producer's stream ends, see below).
- One record, with engram's framing, must fit in **3 MiB**; larger is refused `record_too_large` before any network I/O. Producers therefore ship byte ranges in chunks, never "one whole frame" of arbitrary size.
- **Local durability is not cloud coverage.** The writer uploads in the background (debounce up to 30 s, at most 8 token updates per 16 s per session), and a record is in the cloud only once a token covering it lands. `session.admit` reports both; anything that reasons about lid close must use cloud coverage.
- Takeover verifies roster signatures and record framing only; it knows nothing of what a producer considers complete.

## Shipping: the host side

The host ships its transcript continuously, never in its commit path, through an asynchronous tailer per session (the shape Broca's store projection already uses):
- It ships only the durable range, from the last offset engram acknowledged to the current fsynced head, in chunks under the record ceiling. A torn tail is never shipped.
- It persists its acknowledged offset locally. engram slow or down means the tailer lags and catches up; a crash resumes from the acknowledged offset.
- It reads through the host's own archive-aware reader, never the live directory. Broca folds a session idle for 7 days out of `wal/` into an archive container and removes the live file; the reader returns the same bytes, so the acknowledged offset stays valid, and a session folded between two shipments does not look deleted.
- The host's own frame digests are checked by the receiving host at install, not by engram.

## Shipping: Magic Context

MC does not stream the base state. It updates rows in place, and a commit-time stream would recreate the changefeed it removed. MC ships a **session snapshot**: both stores quiesced and captured at one authority generation, emitted on the `mc` stream as N chunked records followed by a manifest record (snapshot id, total length, digest, both schema versions, the authority generation, and the exact host stream offset it covers). The importer refuses a snapshot whose halves disagree or whose manifest does not match its chunks. MC builds the exporter and importer: `copySessionStateForClone` copies a filtered subset, refuses a populated destination and skips `store.db`, and `doctor migrate-session` re-homes a session on the same machine and refuses when Rust-mode cache state exists, so neither is the cross-machine path.

The exporter works from an explicit, schema-versioned field inventory with a deny-list, not from "every session table" alone, so a future table that holds a secret is refused rather than shipped silently. Credential-sentinel tests prove the exclusions. `lkg_slot_chunks` carries the full rendered request, including the system prompt and instructions; that is intended (it is what keeps the first request prefix-identical) and the destination is a device on the same account.

**Size.** The largest live session measured about 258 MiB raw before compression (2026-10-05): 103 MiB of session rows in `context.db` and 155 MiB in `store.db`, the latter inflated by a defect MC is fixing. Most sessions are a small fraction of that. Rebuildable parts of `context.db` (chunk embeddings, the raw message index, full-text rows, about 50 MiB here) are left out and rebuilt on the receiver; nothing in `store.db` is left out without MC confirming it, because its frozen state is what keeps the cached prefix byte-identical. A snapshot this size cannot be taken at lid close, so the base snapshot ships ahead of time and each turn ships only what changed; MC estimates a pass's change at well under 1 MiB. Per-turn changes come from a per-session dirty log maintained by triggers on the session-scoped tables (table, key, operation; no content), cleared when engram acknowledges a generation. It is not designed yet: MC designs it after its current compaction-marker fix, and measures its write cost first. Until it exists, a move ships a full snapshot.

## The move: a durable transaction

A move is a recorded transaction in engram's store, keyed by a fresh `cutId`, with explicit states. Every step is idempotent, every step's result is recorded before the next starts, and recovery after a crash, a sleep or a daemon restart resumes from the recorded state. **A timeout alone never clears a move or activates a destination.**

1. **Freeze the host** (`moving`). engram calls the host's `prepare_to_move(sessionRef, cutId)` (new work on every host). For Broca, in this order:
   1. persist the session as `moving` (refuses new sends with a typed, retryable `session_moving`; survives a restart, and is cleared only by a recorded abort);
   2. stop the open run at the next step boundary and seal it Interrupted, never Cancelled; an in-flight tool call is recorded `outcome_unknown`. Queued sends and acknowledged steers stay in the WAL and travel with it, so nothing a sender was told is `pending` is dropped;
   3. append a gated **moving record** carrying `cutId` (reader floor, two-phase release), sync, and let the tailer admit through it;
   4. reply with the host stream offset of the moving record's end.
   A repeated call with the same `cutId` returns the same offset.
2. **Snapshot MC** (`mc_snapshotted`). engram calls MC's `prepare_to_move(sessionRef, cutId, hostEndOffset)`. MC lets any in-flight pass finish (the historian is waited for or cancelled; cancelling is safe and keeps the step short), checks that it has ingested exactly through that host offset, refuses otherwise, then admits the chunked snapshot and its manifest. A repeated call returns the same manifest.
3. **Record the cut** (`cut_recorded`). engram admits one record on the `cut` stream: `{cutId, hostEndOffset, mcEndOffset, hostMovingRecordDigest, mcManifestDigest}`. This is what makes the cut checkable without engram reading either payload.
4. **Publish** (`published`). engram uploads everything outstanding and lands a token covering the cut record, then confirms the head by readback and confirms that its whole closure is protected (roots attested). A visible token alone is not finalization.
5. **Seal the source** (`sealed`). Only now does the host set its permanent **moved latch**, which refuses every later open of that lineage here (`session_moved`). The latch lives outside the transcript (for Broca, a per-session sidecar beside the WAL, read on open), so the transcript stays the shared byte history on both machines; it names the `cutId` and the residence it closes, so a later move back can lift it (see Resume). The latch survives Broca's 7-day WAL fold: the fold leaves per-session sidecars in place, and the open path reads the latch even when the WAL itself is archived.
6. **Release** (`released`). engram calls `session.handoff` on this machine, which releases the lease after checking that the cloud head covers everything admitted locally.

**Recovery.** At startup and on every wake, engram reads its unfinished moves and the session's cloud lease state:
- published, and nobody else has advanced the lease term: finish steps 5 and 6;
- not published, and the lease is free or still ours: re-acquire (never forced) and continue from the recorded step;
- another device holds the lease at a later term: the session now lives elsewhere. Quarantine any local records past the cloud head, set the moved latch, and report it.
- an explicit abort (operator, or the trigger deciding not to move): clear `moving` through the host, which resumes serving. If the cut was already published, the session simply goes on: the next records are admitted after it, so the cut record is no longer the last record and the new machine's check (Resume step 2) refuses it.

**What the old machine must refuse after waking.** For a session with a move history (a moving record, an installed `cutId` or a residence term in its WAL or sidecar), Broca's open consults engram's per-session lease evidence: if engram has recorded that another device holds the session at a later term, Broca refuses `session_forked` instead of appending. A session that has never moved never asks, so the check stays off the hot path, and offline or unknown stays admitted. OpenCode and Pi have no fence yet, so they are not supported for a live move until each has one: for OpenCode, a moved flag in the session row that the producer and server honour; for Pi, an extension (Magic Context's, or a small dedicated one) that checks the agent's claim on Pi's `session_start` event and shuts Pi down with `ctx.shutdown()` when another machine holds it. Pi core needs no change.

## Lid close

**The sleep window is unmeasured.** A probe is ready (`scripts/lid-close-probe.swift`): it withholds the sleep acknowledgement and records how long the network keeps working, on battery and on power. The design does not depend on its result for correctness, only for how often a move finishes before sleep rather than on wake.

**The fold cost is the main obstacle.** The shipped handoff requires the last token to be a fold, and a fold today downloads the session's whole record closure, re-encodes it and re-uploads it (`session::state::compact`): O(session size) in both directions, every time, because a fold does not reference the previous one. That cannot happen inside a sleep window for any session of tens of MB, and every fold slab joins the session's protected set (the objects the account keeps from deletion for this device, capped at 1,024 per device and session), which also caps the largest session that can be folded at all. Before lid close can rely on a fold, folds must become incremental: reference the previous folded commit and repack only the tails since it, from the local WAL rather than a download. The alternative is to stop requiring a fold at handoff, since takeover already reads a token's folded commit plus its individual tails.

**What lid close does.** engram owns the trigger (the sleep notification and the lease). Producers must not infer it themselves: sleep is not a shutdown. engram asks prefrontal-core which sessions are live and ready (core knows turns in flight, open tool calls and running workers), then starts a move for each ready session. Bulk data is never left for the window: on battery the writer keeps cloud coverage current, MC refreshes its snapshot at turn boundaries, and folds happen while idle, so the window only has to carry the moving record, MC's last snapshot delta, the cut record and one token update per session. A session still mid-turn when the (measured) cap expires is not forced; its move stays at `moving` or earlier and is visible to the receiving machine as "not finalized". If the laptop sleeps mid-move, recovery finishes it on wake.

Only agent heads move. Workers (masons) are bound to a worktree on the home machine, so they finish or are cancelled before the head moves; workers that outlive a moved head need the cross-machine bus and come with it, not before. Broca's at-most-once rule still holds for anything cut off: `prepare_to_move` seals the run on the source before the cut, so the new machine finds an Interrupted run, never an open intent to dispatch again.

## Resume on the new machine

1. **Acquire.** A plain lease acquire, which succeeds as soon as the old machine has released. If the old machine never released (it slept before step 6), the new machine sees the move's state and either waits or uses `force_take` only with the "not finalized" state shown to the operator; `force_take` is not safe until the single-writer fence below exists.
2. **Verify the cut.** engram reads the session (`session.read`) and refuses with a visible `not_finalized` unless the last record is a cut record whose host and MC offsets equal the streams' durable ends and whose digests match the records it names. An empty session is refused the same way.
3. **Stage, don't run.** Both producers install into staging keyed by `cutId`, with no runner on the session: Broca's `session.install` (new; checks frame digests, lineage header and feature floor) and MC's importer (checks both schemas against its binary, the manifest, the authority generation pair, and that the snapshot covers exactly `hostEndOffset`). Re-running an interrupted install of the same `cutId` resumes it; a different existing state is a typed conflict, never merged and never silently replaced.
4. **Register the scope.** prefrontal-core re-registers the session's scope on this machine's daemon with the same scope epoch. It does so only after the agent's checkout claim names this machine (see The checkout claim); without the claim, resume refuses rather than start a session whose every tool call refuses `scope_not_live`.
5. **Activate.** One durable ready record per `cutId`, written only after every step above succeeded. The host opens the session only with that record present; a refused MC import therefore leaves the session not runnable rather than running without its context.

**Moving back.** Broca's `session.install` accepts an existing lineage on this machine if the local WAL equals the incoming bytes up to the cut this machine published and the moved latch names that cut; it then lifts the latch for the new residence. Anything else is quarantined, never merged. OpenCode's install does not continue the source's journal sequence, so a move back starts from a fresh snapshot.

## Gaps that block this, by owner

| Gap | Owner |
|---|---|
| The log client against `identity_log.append`/`read`, after splitting the journal into shared and machine-local streams; the bootstrap snapshot; the root-key lookup and attach flow | ENTO |
| The move confirmation names a target machine the phone isn't paired with: checked on the phone for moves started there (needs SubcFed to decode and store each paired Mac's `machine_id`), and on the target Mac for moves started there (lid close), where prefrontal reads `registry_platform` per peer from `callosum.peer_keys_read` (absent = unknown). The Mac-side check only warns, and the warning reaches the user through the next ask; it never blocks a move or feeds trust | prefrontal, CKIOS, CALLO, SUBC |
| Core's `plugin_session.register` calls `claim.read agent:<id>` before recording a residence and refuses `agent_held_elsewhere {holder, epoch}` when `held_here` is false; a refused or failed read is an error, never an admit. This closes a new session's race with the Pi fence's `null` | prefrontal |
| `agent.for_host_session {harness, session}` → `{agent_id \| null}`, read-only, admits `direct`, for the Pi fence and Magic Context to name the claim subject | prefrontal |
| Phone reads and answers across every paired member, merged by agent id; until it ships, a move to a machine other than the phone's paired Mac is refused from the phone or confirmed with the silence warning | CKIOS |
| Role claims: the checkout claim also takes a role subject (`role:connector_home`), so the old connector home stops before the new one starts by the same compare-and-swap | engram, PLEX |
| Incremental folds (or no fold required at handoff) | engram |
| The move transaction, its recovery, the `cut` stream record, and handoff's coverage check | engram |
| Re-addressing a WAL on a machine with different paths: none while repo paths are identical (if ever needed, a rename on install, same bytes and lineage, carrying the recorded routing `conversation_key` forward) | BROCA |
| Single writer across machines: the persisted `moving` state, the gated moving record (reader release first, then the writer, raising the WAL floor), the moved-latch sidecar scoped to a residence, and refusing `session_forked` from engram's lease evidence for sessions with a move history. Required before `force_take` is safe. | BROCA, engram |
| `prepare_to_move(sessionRef, cutId)`: per-session seal, `session_moving` refusals, queued sends and steers travelling, idempotent reply | BROCA |
| MC's chunked, two-store snapshot at one authority generation, with manifest, field inventory and deny-list, and the importer's checks | MC |
| MC's `prepare_to_move`: let the in-flight pass finish, wait for or cancel the historian, check ingestion through `hostEndOffset`, return an idempotent manifest per `cutId` | MC |
| MC's per-session dirty log for per-turn deltas: trigger-maintained, cleared on an acknowledged generation, write cost measured first (until it exists, a move ships a full snapshot) | MC |
| MC memory sync: origin columns, per-(account, device) operation streams, globally stable memory ids, merge-on-read with terminal precedence and a hybrid-logical-clock rule, merged rows above the session watermark, Entorhinal's project id carried beside MC's identity | MC |
| One dreamer host per project, honoured by background curation and smart-note checks | MC |
| Moving the connector home: `store.db` moves only together with `grant-revocations.jsonl`, under one cut, and the old home stops before the new one starts | PLEX |
| Callosum: `fleet_group_x25519`, `bus_seal_x25519` and `identity_log_ed25519` kinds in the hello key record (each read only by its own purpose, no fallback); the attestation nonce check at the first-connect barrier with the in-VM static key in `report_data`; checking the phone-signed member list against the roster; a `notify` op so no APNs key enters a hosted VM; phone-approved pairing for a hosted member (needs SubcFed's decoder, claustrum's `kem:` and signing keys, and the phone side) | CALLO, SUBC, CKCRED, CKIOS |
| `session.install` with staging by `cutId`, resume, conflict and move-back rules | BROCA |
| The activation record the host requires before opening a moved session | BROCA, MC, engram |
| Scope re-registration on the new machine, before the first send, resuming the session seq from the bundle (the receiving daemon accepts any owner-chosen seq) | prefrontal |
| Live-session list and per-session readiness for engram's trigger | prefrontal |
| `agent.export` and `agent.import` of the agent-owned rows (board, asks, work graph, wake rules, persona pin, session seq, session list), with new ids for a fork and wake rules imported inactive until activation | prefrontal |
| A per-table sync-class census in prefrontal-core's store, as a build gate | prefrontal |
| The path check: resolve `(project_id, root_key)` through the local Entorhinal and refuse the whole bundle on a mismatch, before any module installs | prefrontal |
| The old machine's tombstone routing to the claim holder, and the cross-machine bus for peer and room message bodies (today core keeps bodies in its own database and the bus carries only triggers) | prefrontal |
| Ask and consent-card pushes through Callosum's `notify` op when hosted, so no APNs key enters the VM (payloads are already content-free) | prefrontal, CALLO |
| Private modes in code for core and routing (state dirs 0700, files 0600, a test that fails on any group- or world-readable file); core's store uses its own crate, not commons' `open_sqlite` | prefrontal |
| Billing: Broca's receiver starts its export at the install cut; the old machine's run index outlives its astrocyte's drain | BROCA, ASTRO |
| OpenCode and Pi as producers, each with a fence (details below) | OC (and Pi's owner) |
| Tools and files are machine-local (AFT bash, worktrees). Continuing the conversation is useful only if the workspace moves too. | Alfonso, AFT |
| The measured macOS sleep window | engram (probe ready, waiting on Ufuk) |

