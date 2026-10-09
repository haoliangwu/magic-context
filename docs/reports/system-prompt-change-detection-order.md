# System-prompt change detection order on OpenCode 1

Question from note #3975: on OpenCode 1.18.32 (CI) the messages transform runs
before Magic Context learns the changed system-prompt hash. Does an AGENTS.md or
instruction-file edit therefore rewrite the provider prefix twice: once on the
request that first carries the new system text (pass N), and again when Magic
Context folds on the following request (pass N+1)? This is the double-rebuild
shape of issue 610, reached through host hook order.

**Answer: yes, on every OpenCode 1.18 release measured (1.18.30 and the newest
1.18.x, 1.18.35), in both TypeScript and Rust transform modes, for both an
AGENTS.md edit and a configured `instructions` file edit, whenever the session has
queued work for the fold to apply.** The fix in this change adopts the new system
identity on pass N, so each edit now rewrites the provider prefix once.

## Host hook order, from OpenCode source

Sources: the release tarballs of `anomalyco/opencode` tags `v1.18.30`
(commit `3104c1428ec9`), `v1.18.32` and `v1.18.35`, read in a throwaway directory.
`session/prompt.ts` and `session/instruction.ts` are byte-identical in all three.
`session/llm/request.ts` differs only by two request headers
(`x-opencode-session-id`, `x-opencode-parent-session-id`).

Per provider request, the prompt loop (`session/prompt.ts`) does:

1. line 1186-1201: creates and persists the step's assistant message;
2. line 1255: `plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })`;
3. line 1257-1263: `instruction.system()` re-reads the global AGENTS.md, the first
   project AGENTS.md/CLAUDE.md found upward, and every configured `instructions`
   file **from disk on every step** (`session/instruction.ts:110-169`, no cache),
   then `MessageV2.toModelMessagesEffect(msgs, model)` converts the messages;
4. `handle.process(...)` → `LLMRequestPrep.prepare` (`session/llm/request.ts:69-73`):
   `plugin.trigger("experimental.chat.system.transform", { sessionID, model }, { system })`.

So `messages.transform` always runs first, and the messages are already converted to
provider messages before `system.transform` runs. The system hook cannot change the
messages of its own request. The same shape is in `v1.4.0` (`prompt.ts:1501`,
`llm.ts:118`) and `v1.17.0` (`prompt.ts:1325`, `llm/request.ts:70`). The prompt-loop
order therefore did **not** change between 1.18.30 and 1.18.32. The 1.18.30-green /
1.18.32-SOFT+ split recorded in commit `b9e27738` is not explained by this order.
This report does not determine what caused that fixture's split.

The live plugin log of the TypeScript baseline run on 1.18.35 confirms the order:
the edited request's `transform scheduler: ... decision=defer` and
`transform: injected m[0]/m[1] (rematerialized=false, reason=cache_hit)` lines come
first, then `system prompt hash changed: … triggering flush`. The next request logs
`m[0] HARD fold decision: reason=system_hash`.

## Experiment

New test `packages/e2e-tests/tests/system-prompt-change-order.test.ts`, real
`opencode serve` with the Anthropic-compatible mock provider capturing every request
body. The fixture writes `AGENTS.md` v1 and `extra-instructions.md` v1 (listed in
`opencode.json` `instructions`) and then runs these turns:

* t1, t2;
* `reduce t2b`: the model calls the real `ctx_reduce` tool (`drop: "2"`). This takes
  two requests: the tool call and the reply after it;
* AGENTS.md → v2, then t3 (pass N), t4 (N+1), t5;
* `reduce t5b` (`drop: "4"`);
* `extra-instructions.md` → v2, then t6 (pass N), t7 (N+1), t8.

Replies are about 10 KB (protected tail 4,000 tokens) so the dropped replies leave
the protected tail. The queued drop is what lets a fold change request bytes. In an
earlier probe without queued work, Rust still logged `HARD reason=epoch_change` on
N+1, but the re-rendered prefix was byte-identical to N, so nothing was rewritten.
The test asserts that a drop is still queued after each edit's request (non-vacuity).

A **rewrite** is a request whose system block differs from the previous request's,
or in which any message the previous request already sent differs. The previous
request's final user turn is excluded, and `cache_control` is stripped before
comparing. Hashes are the first 12 hex digits of SHA-256. "kept" is the number of
leading messages identical to the previous request. Bytes are the raw request body.

### Baseline (`d29d4a926d`, plugin bundle built from it)

OpenCode **1.18.35**, TypeScript transform:

| request | system | system changed | kept | MC decision | m[0]/m[1] | request bytes | rewrite |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t2 | 16,133 B | no | 1/1 | defer | cache_hit | 74,870 | no |
| t3 (AGENTS.md edit) | 16,148 B | **yes** | 7/7 | defer | cache_hit | 124,835 | **yes** (system) |
| t4 | 16,148 B | no | **1/9** | defer | **rematerialized, reason=system_hash** | 124,985 | **yes** (drop §2§) |
| t5 | 16,148 B | no | 11/11 | defer | cache_hit | 149,821 | no |
| t6 (instructions edit) | 16,169 B | **yes** | 17/17 | defer | cache_hit | 199,803 | **yes** (system) |
| t7 | 16,169 B | no | **3/19** | defer | **rematerialized, reason=system_hash** | 199,954 | **yes** (drop §4§) |

OpenCode **1.18.35**, Rust transform:

| request | system | system changed | kept | MC decision (rust pass) | request bytes | rewrite |
| --- | --- | --- | --- | --- | --- | --- |
| t2 | 16,133 B | no | 1/1 | SOFT+ none, permitted=false | 74,870 | no |
| t3 (AGENTS.md edit) | 16,148 B | **yes** | 7/7 | SOFT+ none, permitted=false | 124,835 | **yes** (system) |
| t4 | 16,148 B | no | **1/9** | **HARD epoch_change, permitted=true** | 124,991 | **yes** (drop §2§) |
| t5 | 16,148 B | no | 11/11 | SOFT+ none | 149,827 | no |
| t6 (instructions edit) | 16,169 B | **yes** | 17/17 | SOFT+ none | 199,809 | **yes** (system) |
| t7 | 16,169 B | no | **3/19** | **HARD epoch_change, permitted=true** | 199,966 | **yes** (drop §4§) |

OpenCode **1.18.30** produced the same decisions, `kept` values and request bytes as
1.18.35 in both modes (TS: t3 124,835 / t4 124,985 / t6 199,803 / t7 199,954; Rust:
124,835 / 124,991 / 199,809 / 199,966). Every baseline lane fails the test with the
same extra rewrites:

```
expect(rewrites).toEqual(...)
    "4:agents-edit t3",
+   "5:t4",
    "9:instructions-edit t6",
+   "10:t7",
```

The edited system text reaches the provider on pass N, and Magic Context rebuilds on
N+1. The provider pays two full prefix writes per edit: on N for the new system text,
and on N+1 for the fold, whose prefix no longer matches what N cached.

### After the change

On both 1.18.30 and 1.18.35, in both modes, t3 and t6 are the only rewrites. t4/t7
keep 9/9 and 19/19 messages. TS logs `cache_hit` with no `system_hash`
rematerialization; Rust logs `SOFT+ reason=none permitted=false`. Request bytes for
t4/t5/t7 are 149,670 / 174,506 / 249,324 in both modes and on both hosts. The plugin
log reads `system prompt hash changed: … adopting on the request whose messages are
already final`. Both queued drops are still pending at the end (`pending_at_end=2`).
They are not lost: they ride the next natural bust (execute threshold, idle TTL,
model change, flush), as any deferred ctx_reduce drop does.

## The change

`packages/plugin/src/hooks/magic-context/request-hook-order.ts` (new) tracks, per
session, whether this request's messages transform has already run:

* the messages transform marks the session at the start of every pass and records
  the newest assistant message id it saw (`onMessagesPassStarted` in `transform.ts`,
  before the TS/Rust split);
* a `message.updated` event for a **completed** assistant message newer than that id
  clears the mark (`hook.ts` event wrapper, before the other event handlers);
* the system hook consumes the mark after its skip checks, so a skipped
  title/summary/compaction/internal-child call cannot steal it.

The two orders differ in exactly one way, and the mark separates them:

* messages-first (OpenCode 1): messages(N), then system(N). The mark is present, so
  the system hook adopts the change;
* system-first: messages(N-1), then reply(N-1), then system(N). The reply clears the
  mark, so the system hook keeps the existing flush and the following messages
  transform folds on the same request, as before.

A late completion event for a reply the messages pass already saw does not clear the
mark. If no comparable id is available, the mark is cleared, so ambiguous cases
fall back to the old flush.

Review follow-up: the marker is session-keyed and carries no request identity. It
means "a messages pass ran since the last consumption or newer completion", not
"this request's messages pass ran". On a system-first host, a previous request
that ends without a completed-assistant event leaves the marker set, and the next
system hook reads true before its own messages transform. The unit test
"LIMITATION: without a request-correlation seam, an unfinished previous request
makes a system-first request look messages-final" pins that sequence. The helper
is therefore valid only where messages run before system for every main request
(stock OpenCode 1). OpenCode 2 and Pi deliberately do not wire it.

In `system-prompt-hash.ts`, `adoptSystemChange = idleCacheExpired ||
requestMessagesFinal` replaces `idleCacheExpired` in the two places the issue-610
idle adoption already used: no history/systemPrompt/materialization refresh flags,
and `cachedM0SystemHash` is set to the new hash. The sticky-date release
(`dateMayAdvance`) is deliberately not widened, because OpenCode 1 reports
`requestMessagesFinal` on every request. A midnight date flip stays frozen on warm
requests (unit-tested).

Rust parity reuses the existing seam. The Rust adapter already forwards
`adopted_system_prompt_hash` when `cachedM0SystemHash === systemPromptHash`
(`rust-mode-transform.ts`). The module's `can_adopt_system_identity` adopts only a
system-only identity delta; a model, prompt-surface, serializer or renderer change
still HARDs. No Rust code changed, and the module binary under test was built from
the base commit's crates.

### Trade-off

On a messages-first host, a system-prompt edit no longer gives queued Magic Context
work (pending drops, a new compartment or memory render, re-read adjuncts) a free
ride. Before, that ride was not free: it was the second rewrite. Queued work now
waits for the next natural bust. When the system change coincides with a fold Magic
Context already performs on pass N (execute, TTL, model change), both still land on
the same request. A prompt-surface preset change that leaves the system text
byte-identical would still alter the TS hash material and is now adopted on
OpenCode 1. The Rust module refuses that adoption when the render identity changed.

## Issue 610 fixes

* Unit: all 51 tests in `system-prompt-hash.test.ts` pass. Its existing idle-adopt
  cases, cold midnight adoption and drain-semantics tests are unchanged; the four
  hook-order cases are new.
* Real host, OpenCode 1.18.35, `tests/idle-ttl-restart.test.ts` with
  `MC_E2E_HOST=opencode`: TypeScript 7 pass / 0 fail. These are the usage-less switch,
  warm and expired midnight, the expired head with and without a restart, and the
  aborted idle attempt plus late system change with and without a restart. The four
  `IDLE_TTL_LONG` 240k loops were not run.
* Rust, same file: the first full run passed 6 and failed "completed replies without
  usage spend one expiry after a reporting/model switch" at its
  `scheduler=defer` assertion. Running that case alone gave 6/6 passes on the base
  bundle and 4/6 with the change. The failing plugin log ends in the middle of the
  warm request's pass, before its `rust pass: … scheduler=defer` line was flushed.
  The test's wait counted any `decision=` line since the expiry, and the expired
  HARD pass emits two such lines (`todo_permission_probe_miss decision=HARD` and its
  `rust pass` line), so the wait could finish before the warm pass's line was
  flushed. The wait now counts only the scheduler lines it asserts on. The assertions
  are unchanged. After that: 6/6 Rust and 1/1 TS passes of the case alone; the
  full Rust file then passed 7 pass / 0 fail.
* The same case shows this change from another side. When the model switches, the
  base bundle's Rust log reads `HARD epoch_change` (the model is in the request),
  then `system prompt hash changed: … triggering flush` (the new model's provider
  prompt), then a second `HARD epoch_change` on the next request. With the change:
  one `HARD epoch_change`, `… adopting on the request whose messages are already
  final`, then `SOFT+`.

## Mutation proofs

1. `hook.ts`: `consumeMessagesPrepared: () => false` (the system hook never learns
   the order). The new e2e test fails on 1.18.35 in both TS and Rust with the
   baseline's extra rewrites `5:t4` / `10:t7` (TS `system_hash`, Rust
   `HARD epoch_change`).
2. `system-prompt-hash.ts`: drop `requestMessagesFinal` from `adoptSystemChange`.
   Only "adopts a warm system change when the messages transform already ran for
   the request" fails (50 pass / 1 fail).
3. `request-hook-order.ts`: clear on every completion (no id guard). Only "ignores a
   late completion event for a reply the messages pass already saw" fails
   (4 pass / 1 fail).

Each mutation was staged first, restored with `git checkout -- <path> && touch`,
and left an empty `git diff --stat`.

## Containment

Every host run used a throwaway root
`$TMPDIR/magic-context/sysprompt-order/` with `HOME`, `CFFIXED_USER_HOME`,
`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`,
`XDG_CACHE_HOME`, `OPENCODE_DB`, `MAGIC_CONTEXT_STORAGE_DIR` and `TMPDIR` under it.
The harness additionally points each `opencode serve` child at a per-fixture
`opencode-e2e-*` directory inside that root. A 5-second `lsof` sampler (12:54–13:39 local, covering the
final eight-lane matrix, the mutant lanes and the TypeScript idle-TTL run) over the
harness's processes (`opencode serve`, the `bun test` runner, the ck-mc module and
ck-subc) recorded 1,810 open-database rows. Every `.db`/`-wal`/`-shm` they held was under
`…/sysprompt-order/tmp/opencode-e2e-*/data/`
(`opencode/opencode.db`, `cortexkit/magic-context/{context,store}.db`). There were 0
rows for `~/.local/share/opencode`, `~/.local/share/cortexkit/magic-context`,
`~/.config/opencode` or `~/.config/cortexkit`. OpenCode binaries came from
`npm pack opencode-darwin-arm64@1.18.30` (tarball SHA-256 `25b722fc…74e7f8`) and
`@1.18.35` (`b626543f…0eeb3`), and were put first on `PATH`.

## Reproduce

```sh
ROOT=$TMPDIR/magic-context/<task>   # throwaway; export the isolation variables above
cd packages/e2e-tests
# baseline: point MC_E2E_PLUGIN_ENTRY at a bundle built from the base commit
PATH=$ROOT/bin/oc-1.18.35:$PATH MC_E2E_MODE=ts   bun test tests/system-prompt-change-order.test.ts
PATH=$ROOT/bin/oc-1.18.35:$PATH MC_E2E_MODE=rust bun test --timeout 1200000 tests/system-prompt-change-order.test.ts
```

`SYSTEM_ORDER_EVIDENCE=<dir>` writes the per-request table and the captured request
bodies. The suite runs only when the `opencode` executable on `PATH` matches a pinned
npm `opencode-darwin-arm64` executable: 1.18.30 `2d0c9c33…4eddc62` or 1.18.35
`8c3c351b…72c79d82`. Otherwise it skips and prints the binary and its hash. Its
expectations (drops still queued after the edited request, one rewrite per edit)
hold only on a messages-first host. A system-first host folds on the edited request
itself, which is also correct but needs different expectations.
